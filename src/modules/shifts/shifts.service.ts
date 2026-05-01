import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  Role,
  ShiftStatus,
  AuditLog,
} from '@prisma/client';

import { ShiftsRepository, ShiftWithAssignments } from './shifts.repository';
import {
  ShiftValidatorService,
  ValidationResult,
  AssignmentPreview,
} from './validation/shift-validator.service';
import { LocationsService } from '../locations/locations.service';
import { LocationsRepository } from '../locations/locations.repository';
import { AuditLogService } from '../audit-log/audit-log.service';
import { buildPaginatedResult, PaginatedResult } from '../../common/dto/pagination.dto';
import { durationHours, isPremiumShift } from '../../common/utils/time.util';

interface RequestContext {
  readonly actorId: string;
  readonly actorRole: Role;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

interface ListFilter {
  locationId?: string;
  userId?: string;
  status?: ShiftStatus;
  from?: Date;
  to?: Date;
  isPremium?: boolean;
  page: number;
  pageSize: number;
}

@Injectable()
export class ShiftsService {
  constructor(
    private readonly repo: ShiftsRepository,
    private readonly validator: ShiftValidatorService,
    private readonly locations: LocationsService,
    private readonly locationsRepo: LocationsRepository,
    private readonly audit: AuditLogService,
    private readonly events: EventEmitter2,
    private readonly config: ConfigService,
  ) {}

  // ─── Read ────────────────────────────────────────────────────────────

  async getById(
    id: string,
    actor: { sub: string; role: Role },
  ): Promise<ShiftWithAssignments> {
    const shift = await this.repo.findById(id);
    if (!shift) throw new NotFoundException('Shift not found');
    await this.locations.assertCanReadLocation(actor, shift.locationId);
    return shift;
  }

  async list(
    filter: ListFilter,
    actor: { sub: string; role: Role },
  ): Promise<PaginatedResult<ShiftWithAssignments>> {
    // For employees, scope to themselves unless they pass userId=self.
    // For managers, scope to locations they manage unless they pass a location they manage.
    if (actor.role === Role.EMPLOYEE) {
      filter = { ...filter, userId: actor.sub };
    } else if (actor.role === Role.MANAGER && filter.locationId) {
      const allowed = await this.locationsRepo.isManagerOf(actor.sub, filter.locationId);
      if (!allowed) throw new ForbiddenException('You do not manage this location');
    }

    const { items, total } = await this.repo.list({
      locationId: filter.locationId,
      userId: filter.userId,
      status: filter.status,
      startsAfter: filter.from,
      startsBefore: filter.to,
      isPremium: filter.isPremium,
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
    });

    // For managers without location filter, post-filter to managed locations.
    let finalItems = items;
    if (actor.role === Role.MANAGER && !filter.locationId) {
      const managed = new Set<string>();
      for (const s of items) {
        if (managed.has(s.locationId)) continue;
        if (await this.locationsRepo.isManagerOf(actor.sub, s.locationId)) {
          managed.add(s.locationId);
        }
      }
      finalItems = items.filter((s) => managed.has(s.locationId));
    }

    return buildPaginatedResult(finalItems, total, filter.page, filter.pageSize);
  }

  // ─── Create ──────────────────────────────────────────────────────────

  async create(
    input: {
      locationId: string;
      skillId: string;
      startsAt: Date;
      endsAt: Date;
      headcount: number;
      notes?: string;
    },
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<ShiftWithAssignments> {
    await this.locations.assertCanManageLocation(actor, input.locationId);
    this.validateWindow(input.startsAt, input.endsAt);
    if (actor.role !== Role.ADMIN && input.startsAt.getTime() < Date.now()) {
      throw new BadRequestException('Cannot create a shift that starts in the past');
    }

    const location = await this.locationsRepo.findById(input.locationId);
    if (!location) throw new NotFoundException('Location not found');

    const created = await this.repo.create({
      locationId: input.locationId,
      skillId: input.skillId,
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      headcount: input.headcount,
      isPremium: isPremiumShift(input.startsAt, location.timezone),
      status: ShiftStatus.DRAFT,
      notes: input.notes,
      createdById: actor.sub,
    });

    this.audit.log({
      action: AuditAction.SHIFT_CREATED,
      entityType: 'Shift',
      entityId: created.id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: created,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('shift.created', { shiftId: created.id, locationId: created.locationId });
    return created;
  }

  // ─── Update (optimistic concurrency) ─────────────────────────────────

  async update(
    id: string,
    expectedVersion: number,
    patch: {
      skillId?: string;
      startsAt?: Date;
      endsAt?: Date;
      headcount?: number;
      notes?: string;
    },
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<ShiftWithAssignments> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException('Shift not found');
    await this.locations.assertCanManageLocation(actor, before.locationId);

    const nextStart = patch.startsAt ?? before.startsAt;
    const nextEnd = patch.endsAt ?? before.endsAt;
    this.validateWindow(nextStart, nextEnd);

    if (patch.headcount && patch.headcount < before.assignments.length) {
      throw new BadRequestException(
        `Cannot reduce headcount below current assignment count (${before.assignments.length})`,
      );
    }

    // Enforce cutoff for edits to already-published shifts. Default 48h before
    // shift start. Overridable via SHIFT_EDIT_CUTOFF_HOURS env, or by elevating
    // to ADMIN role (managers cannot bypass).
    if (before.status === ShiftStatus.PUBLISHED) {
      const cutoffHours = Number(this.config.get<string>('SHIFT_EDIT_CUTOFF_HOURS') ?? '48');
      const cutoff = new Date(before.startsAt.getTime() - cutoffHours * 3_600_000);
      if (new Date() > cutoff && actor.role !== Role.ADMIN) {
        throw new ForbiddenException(
          `Cannot edit a published shift within ${cutoffHours}h of its start time. Contact an admin if changes are required.`,
        );
      }
    }

    // If shift already published, edits beyond a configurable cutoff are
    // restricted: we still allow them but caller should be aware. For now
    // we simply re-publish-stamp by leaving status alone.
    const location = await this.locationsRepo.findById(before.locationId);
    const tz = location?.timezone ?? 'UTC';

    const result = await this.repo.updateWithVersion(id, expectedVersion, {
      skillId: patch.skillId,
      startsAt: patch.startsAt,
      endsAt: patch.endsAt,
      headcount: patch.headcount,
      notes: patch.notes,
      isPremium: isPremiumShift(nextStart, tz),
    });
    if (!result.updated) {
      throw new ConflictException('Shift was modified by someone else; please refresh and retry');
    }

    const after = await this.repo.findById(id);
    this.audit.log({
      action: AuditAction.SHIFT_UPDATED,
      entityType: 'Shift',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before,
      after,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('shift.updated', { shiftId: id, locationId: before.locationId });
    // Per spec: when a shift is edited, any pending swap on it should be auto-cancelled.
    this.events.emit('shift.edited.cancelPendingSwaps', { shiftId: id });

    // If the time or required skill changed, existing assignees may now be
    // invalid (availability mismatch, 10h-rest violation, missing skill, etc.).
    // Re-validate each one and surface warnings — do NOT auto-unassign, as
    // silently dropping people from their schedule is a worse footgun than a
    // visible warning. Managers can act on the audit + notification.
    const timeOrSkillChanged =
      patch.startsAt !== undefined || patch.endsAt !== undefined || patch.skillId !== undefined;
    if (timeOrSkillChanged && after) {
      for (const a of after.assignments) {
        const v = await this.validator.validateAssignment(a.userId, after, {});
        if (!v.ok || v.warnings.length > 0) {
          this.audit.log({
            action: AuditAction.SHIFT_UPDATED,
            entityType: 'ShiftAssignment',
            entityId: a.id,
            actorId: ctx.actorId,
            actorRole: ctx.actorRole,
            meta: {
              shiftId: id,
              userId: a.userId,
              postEditValidation: { errors: v.errors, warnings: v.warnings },
            },
            ipAddress: ctx.ipAddress,
            userAgent: ctx.userAgent,
          });
          this.events.emit('shift.assignment.invalidated', {
            shiftId: id,
            userId: a.userId,
            locationId: before.locationId,
            errors: v.errors,
            warnings: v.warnings,
          });
        }
      }
    }
    return after!;
  }

  async remove(id: string, actor: { sub: string; role: Role }, ctx: RequestContext): Promise<void> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException('Shift not found');
    await this.locations.assertCanManageLocation(actor, before.locationId);
    await this.repo.softDelete(id);
    this.audit.log({
      action: AuditAction.SHIFT_DELETED,
      entityType: 'Shift',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('shift.deleted', { shiftId: id, locationId: before.locationId });
  }

  // ─── Publish ─────────────────────────────────────────────────────────

  async publish(
    shiftIds: string[],
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<{ publishedIds: string[] }> {
    const published: string[] = [];
    for (const id of shiftIds) {
      const before = await this.repo.findById(id);
      if (!before) continue;
      await this.locations.assertCanManageLocation(actor, before.locationId);
      if (before.status === ShiftStatus.PUBLISHED) continue;

      const result = await this.repo.updateWithVersion(id, before.version, {
        status: ShiftStatus.PUBLISHED,
        publishedAt: new Date(),
      });
      if (!result.updated) {
        throw new ConflictException(`Shift ${id} changed during publish`);
      }
      published.push(id);
      this.audit.log({
        action: AuditAction.SHIFT_PUBLISHED,
        entityType: 'Shift',
        entityId: id,
        actorId: ctx.actorId,
        actorRole: ctx.actorRole,
        before,
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      this.events.emit('shift.published', { shiftId: id, locationId: before.locationId });
    }
    return { publishedIds: published };
  }

  /**
   * Reverts a published shift to DRAFT. Subject to the same cutoff window as
   * editing — managers cannot unpublish within 48h of start; admins may.
   */
  async unpublish(
    id: string,
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<ShiftWithAssignments> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException('Shift not found');
    await this.locations.assertCanManageLocation(actor, before.locationId);
    if (before.status !== ShiftStatus.PUBLISHED) {
      throw new BadRequestException('Shift is not currently published');
    }
    const cutoffHours = Number(this.config.get<string>('SHIFT_EDIT_CUTOFF_HOURS') ?? '48');
    const cutoff = new Date(before.startsAt.getTime() - cutoffHours * 3_600_000);
    if (new Date() > cutoff && actor.role !== Role.ADMIN) {
      throw new ForbiddenException(
        `Cannot unpublish within ${cutoffHours}h of shift start.`,
      );
    }
    const result = await this.repo.updateWithVersion(id, before.version, {
      status: ShiftStatus.DRAFT,
      publishedAt: null,
    });
    if (!result.updated) throw new ConflictException('Shift changed during unpublish');
    const after = await this.repo.findById(id);
    this.audit.log({
      action: AuditAction.SHIFT_UPDATED,
      entityType: 'Shift',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before,
      after,
      meta: { unpublished: true },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('shift.updated', { shiftId: id, locationId: before.locationId });
    return after!;
  }

  // ─── Validate (preview, no write) ────────────────────────────────────

  async validateAssignment(
    shiftId: string,
    userId: string,
    options: { overrideUsed?: boolean; overrideReason?: string },
    actor: { sub: string; role: Role },
  ): Promise<AssignmentPreview> {
    const shift = await this.repo.findById(shiftId);
    if (!shift) throw new NotFoundException('Shift not found');
    await this.locations.assertCanManageLocation(actor, shift.locationId);

    const result = await this.validator.validateAssignment(userId, shift, options);
    const alternatives = result.ok ? [] : await this.validator.suggestAlternatives(shift, 5);
    return this.validator.toPreviewEnvelope(result, alternatives);
  }

  // ─── Assign / Unassign ───────────────────────────────────────────────

  /**
   * Read-only "what-if" preview: runs the full validator against a candidate
   * (shift, user) pair without persisting anything. Used by the UI to show
   * the consequences of an assignment before the manager confirms.
   */
  async previewAssignment(
    shiftId: string,
    userId: string,
    actor: { sub: string; role: Role },
    options?: { overrideUsed?: boolean; overrideReason?: string },
  ): Promise<AssignmentPreview> {
    const shift = await this.repo.findById(shiftId);
    if (!shift) throw new NotFoundException('Shift not found');
    await this.locations.assertCanManageLocation(actor, shift.locationId);
    const validation = await this.validator.validateAssignment(userId, shift, options ?? {});
    const alternatives = validation.ok
      ? []
      : await this.validator.suggestAlternatives(shift, 5);
    return this.validator.toPreviewEnvelope(validation, alternatives);
  }

  async assignStaff(
    shiftId: string,
    userId: string,
    options: { overrideUsed?: boolean; overrideReason?: string },
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<{ assignmentId: string; validation: ValidationResult }> {
    const shift = await this.repo.findById(shiftId);
    if (!shift) throw new NotFoundException('Shift not found');
    await this.locations.assertCanManageLocation(actor, shift.locationId);

    if (shift.assignments.length >= shift.headcount) {
      throw new BadRequestException('Shift is already fully staffed');
    }
    const existing = await this.repo.findAssignment(shiftId, userId);
    if (existing) throw new ConflictException('User is already assigned to this shift');

    const validation = await this.validator.validateAssignment(userId, shift, options);
    if (!validation.ok) {
      const alternatives = await this.validator.suggestAlternatives(shift, 5);
      const preview = this.validator.toPreviewEnvelope(validation, alternatives);
      // 422: the request was understood, but the proposed assignment violates
      // one or more business rules. The frontend reads `details` to render the
      // findings list + suggested alternatives in the assign panel.
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'E_VALIDATION',
        message:
          validation.errors[0]?.message ??
          'This assignment violates one or more scheduling rules.',
        details: preview,
      });
    }
    if (options.overrideUsed && (options.overrideReason ?? '').trim().length === 0) {
      throw new BadRequestException('overrideReason is required when overrideUsed=true');
    }
    if (options.overrideUsed && (options.overrideReason ?? '').trim().length < 10) {
      throw new BadRequestException(
        'overrideReason must be at least 10 characters describing the business justification',
      );
    }

    const result = await this.repo.createAssignmentAtomic({
      shiftId,
      userId,
      headcount: shift.headcount,
      assignedById: actor.sub,
      overrideUsed: options.overrideUsed ?? false,
      overrideReason: options.overrideReason,
    }).catch((err: unknown) => {
      // P2002 = unique violation (user already assigned by another request).
      // P2034 = serialization failure under concurrent load.
      const code = (err as { code?: string })?.code;
      if (code === 'P2002' || code === 'P2034') {
        return { conflict: true } as const;
      }
      throw err;
    });

    if (result.conflict) {
      this.events.emit('assignment.conflict', {
        shiftId,
        userId,
        locationId: shift.locationId,
        reason: 'concurrent_assignment',
      });
      throw new ConflictException({
        statusCode: 409,
        code: 'E_ASSIGNMENT_CONFLICT',
        message:
          'Another manager just updated this shift. Reload and try again.',
      });
    }
    const assignment = result.assignment;

    this.audit.log({
      action: AuditAction.SHIFT_ASSIGNED,
      entityType: 'ShiftAssignment',
      entityId: assignment.id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: assignment,
      meta: { shiftId, userId, warnings: validation.warnings },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    if (options.overrideUsed) {
      this.audit.log({
        action: AuditAction.SHIFT_OVERRIDE_USED,
        entityType: 'ShiftAssignment',
        entityId: assignment.id,
        actorId: ctx.actorId,
        actorRole: ctx.actorRole,
        meta: { reason: options.overrideReason, shiftId, userId },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
    }
    this.events.emit('shift.assigned', {
      shiftId,
      userId,
      locationId: shift.locationId,
      published: shift.status === ShiftStatus.PUBLISHED,
    });
    // Surface overtime warnings as notifications for managers + staff.
    const overWarn = validation.warnings.find(
      (w) => w.code === 'W_WEEKLY_OVER_40' || w.code === 'W_WEEKLY_APPROACHING_40',
    );
    if (overWarn) {
      const weeklyHours = (overWarn.data as { weeklyHours?: number } | undefined)?.weeklyHours ?? 0;
      this.events.emit('overtime.warning', {
        userId,
        locationId: shift.locationId,
        shiftId,
        weeklyHours,
        severity: overWarn.code === 'W_WEEKLY_OVER_40' ? 'OVER' : 'APPROACHING',
      });
    }
    return { assignmentId: assignment.id, validation };
  }

  async unassignStaff(
    shiftId: string,
    userId: string,
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<void> {
    const shift = await this.repo.findById(shiftId);
    if (!shift) throw new NotFoundException('Shift not found');
    await this.locations.assertCanManageLocation(actor, shift.locationId);

    const existing = await this.repo.findAssignment(shiftId, userId);
    if (!existing) throw new NotFoundException('Assignment not found');

    await this.repo.deleteAssignment(shiftId, userId);
    this.audit.log({
      action: AuditAction.SHIFT_UNASSIGNED,
      entityType: 'ShiftAssignment',
      entityId: existing.id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before: existing,
      meta: { shiftId, userId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('shift.unassigned', {
      shiftId,
      userId,
      locationId: shift.locationId,
    });
  }

  /**
   * Sunday-night-chaos path: a staff member calls out of their own published
   * shift. Removes the assignment immediately (no manager approval needed —
   * a body in a seat is more important than process), emits an urgent
   * coverage event with suggestions, and records the reason on the audit log.
   */
  async selfCallout(
    shiftId: string,
    actor: { sub: string; role: Role },
    reason: string,
    ctx: RequestContext,
  ): Promise<{
    suggestions: import('./validation/shift-validator.service').AlternativeSuggestion[];
  }> {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('A reason of at least 3 characters is required');
    }
    const shift = await this.repo.findById(shiftId);
    if (!shift) throw new NotFoundException('Shift not found');
    const existing = await this.repo.findAssignment(shiftId, actor.sub);
    if (!existing) throw new ForbiddenException('You are not assigned to this shift');

    await this.repo.deleteAssignment(shiftId, actor.sub);
    this.audit.log({
      action: AuditAction.SHIFT_UNASSIGNED,
      entityType: 'ShiftAssignment',
      entityId: existing.id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before: existing,
      meta: { shiftId, userId: actor.sub, callout: true, reason: reason.trim() },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    const suggestions = await this.validator.suggestAlternatives(shift, 5);
    this.events.emit('shift.unassigned', { shiftId, userId: actor.sub, locationId: shift.locationId });
    this.events.emit('shift.callout', {
      shiftId,
      userId: actor.sub,
      locationId: shift.locationId,
      reason: reason.trim(),
      minutesUntilStart: Math.max(0, Math.floor((shift.startsAt.getTime() - Date.now()) / 60_000)),
      suggestions,
    });
    return { suggestions };
  }

  /**
   * Audit history of a single shift — visible to admins and managers of the
   * owning location. Implemented over the AuditLog table by entityType filter.
   */
  async getHistory(
    shiftId: string,
    actor: { sub: string; role: Role },
  ): Promise<AuditLog[]> {
    const shift = await this.repo.findByIdIncludingDeleted(shiftId);
    if (!shift) throw new NotFoundException('Shift not found');
    if (actor.role !== Role.ADMIN) {
      await this.locations.assertCanManageLocation(actor, shift.locationId);
    }
    const { items } = await this.audit.list(
      { entityType: 'Shift', entityId: shiftId },
      { skip: 0, take: 200 },
    );
    const { items: assignmentItems } = await this.audit.list(
      { entityType: 'ShiftAssignment' },
      { skip: 0, take: 500 },
    );
    // Filter assignment-level audit rows down to those whose meta.shiftId matches.
    const related = assignmentItems.filter((a) => {
      const meta = (a.meta as { shiftId?: string } | null) ?? null;
      return meta?.shiftId === shiftId;
    });
    return [...items, ...related].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  private validateWindow(startsAt: Date, endsAt: Date): void {
    if (endsAt <= startsAt) {
      throw new BadRequestException('endsAt must be after startsAt');
    }
    const len = durationHours(startsAt, endsAt);
    if (len > 24) {
      throw new BadRequestException('A single shift cannot exceed 24 hours');
    }
  }
}
