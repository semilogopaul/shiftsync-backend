import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Availability,
  AvailabilityException,
  AvailabilityExceptionType,
  AuditAction,
  Role,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AvailabilityRepository } from './availability.repository';
import { UserRepository } from '../users/users.repository';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  containedInAny,
  expandWeeklyWindow,
  isValidIanaTz,
  overlapsAny,
} from '../../common/utils/time.util';

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const formatDayName = (day: number): string => DAY_NAMES[day] ?? `day ${day}`;
const formatMinutes = (minutes: number): string => {
  const h24 = Math.floor(minutes / 60);
  const m = minutes % 60;
  const period = h24 >= 12 ? 'pm' : 'am';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return m === 0
    ? `${h12}${period}`
    : `${h12}:${String(m).padStart(2, '0')}${period}`;
};

interface RequestContext {
  readonly actorId: string;
  readonly actorRole: Role;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export interface AvailabilityCheckResult {
  readonly available: boolean;
  /** A human-friendly explanation when not available. */
  readonly reason?: string;
}

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly repo: AvailabilityRepository,
    private readonly users: UserRepository,
    private readonly audit: AuditLogService,
    private readonly events: EventEmitter2,
  ) {}

  // ─── Authorization helper ────────────────────────────────────────────

  private assertSelfOrPrivileged(
    actor: { sub: string; role: Role },
    userId: string,
  ): void {
    if (actor.sub === userId) return;
    if (actor.role === Role.ADMIN || actor.role === Role.MANAGER) return;
    throw new ForbiddenException('You can only manage your own availability');
  }

  private validateWindow(startMinute: number, endMinute: number): void {
    if (startMinute === endMinute) {
      throw new BadRequestException(
        'startMinute and endMinute cannot be equal',
      );
    }
    // endMinute < startMinute is allowed → window crosses midnight.
  }

  // ─── Recurring availability ──────────────────────────────────────────

  async listForUser(
    actor: { sub: string; role: Role },
    userId: string,
  ): Promise<Availability[]> {
    this.assertSelfOrPrivileged(actor, userId);
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    return this.repo.listForUser(userId);
  }

  async create(
    userId: string,
    input: {
      dayOfWeek: number;
      startMinute: number;
      endMinute: number;
      timezone: string;
      effectiveFrom?: Date;
      effectiveUntil?: Date;
    },
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<Availability> {
    this.assertSelfOrPrivileged(actor, userId);
    if (!isValidIanaTz(input.timezone)) {
      throw new BadRequestException('timezone is not a valid IANA timezone');
    }
    this.validateWindow(input.startMinute, input.endMinute);
    if (
      input.effectiveFrom &&
      input.effectiveUntil &&
      input.effectiveFrom > input.effectiveUntil
    ) {
      throw new BadRequestException(
        'effectiveFrom must be on or before effectiveUntil',
      );
    }
    // Reject overlapping recurring windows on the same dayOfWeek + tz, since
    // they would either contradict each other or silently merge.
    const existing = await this.repo.listForUser(userId);
    for (const w of existing) {
      if (
        w.dayOfWeek === input.dayOfWeek &&
        w.timezone === input.timezone &&
        w.startMinute < input.endMinute &&
        w.endMinute > input.startMinute
      ) {
        throw new BadRequestException(
          `You already have a ${formatDayName(w.dayOfWeek)} window from ${formatMinutes(w.startMinute)} to ${formatMinutes(w.endMinute)} that overlaps this one.`,
        );
      }
    }

    const created = await this.repo.createOne({
      userId,
      dayOfWeek: input.dayOfWeek,
      startMinute: input.startMinute,
      endMinute: input.endMinute,
      timezone: input.timezone,
      effectiveFrom: input.effectiveFrom,
      effectiveUntil: input.effectiveUntil,
    });
    this.audit.log({
      action: AuditAction.AVAILABILITY_CREATED,
      entityType: 'Availability',
      entityId: created.id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: created,
      meta: { userId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('availability.changed', {
      userId,
      kind: 'recurring.created',
      recordId: created.id,
    });
    return created;
  }

  async update(
    id: string,
    patch: {
      dayOfWeek?: number;
      startMinute?: number;
      endMinute?: number;
      timezone?: string;
      effectiveFrom?: Date | null;
      effectiveUntil?: Date | null;
    },
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<Availability> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException('Availability not found');
    this.assertSelfOrPrivileged(actor, before.userId);

    if (patch.timezone && !isValidIanaTz(patch.timezone)) {
      throw new BadRequestException('timezone is not a valid IANA timezone');
    }
    const nextStart = patch.startMinute ?? before.startMinute;
    const nextEnd = patch.endMinute ?? before.endMinute;
    this.validateWindow(nextStart, nextEnd);

    const after = await this.repo.updateById(id, {
      dayOfWeek: patch.dayOfWeek,
      startMinute: patch.startMinute,
      endMinute: patch.endMinute,
      timezone: patch.timezone,
      effectiveFrom: patch.effectiveFrom,
      effectiveUntil: patch.effectiveUntil,
    });
    this.audit.log({
      action: AuditAction.AVAILABILITY_UPDATED,
      entityType: 'Availability',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before,
      after,
      meta: { userId: before.userId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('availability.changed', {
      userId: before.userId,
      kind: 'recurring.updated',
      recordId: id,
    });
    return after;
  }

  async remove(
    id: string,
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<void> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException('Availability not found');
    this.assertSelfOrPrivileged(actor, before.userId);
    await this.repo.deleteById(id);
    this.audit.log({
      action: AuditAction.AVAILABILITY_DELETED,
      entityType: 'Availability',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before,
      meta: { userId: before.userId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('availability.changed', {
      userId: before.userId,
      kind: 'recurring.deleted',
      recordId: id,
    });
  }

  // ─── Exceptions ──────────────────────────────────────────────────────

  async listExceptionsForUser(
    actor: { sub: string; role: Role },
    userId: string,
    range?: { from?: Date; to?: Date },
  ): Promise<AvailabilityException[]> {
    this.assertSelfOrPrivileged(actor, userId);
    return this.repo.listExceptionsForUser(userId, range);
  }

  async createException(
    userId: string,
    input: {
      type: AvailabilityExceptionType;
      startsAt: Date;
      endsAt: Date;
      note?: string;
    },
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<AvailabilityException> {
    this.assertSelfOrPrivileged(actor, userId);
    if (input.endsAt <= input.startsAt) {
      throw new BadRequestException('endsAt must be after startsAt');
    }
    const created = await this.repo.createException({ ...input, userId });
    this.audit.log({
      action: AuditAction.AVAILABILITY_CREATED,
      entityType: 'AvailabilityException',
      entityId: created.id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: created,
      meta: { userId, exception: true },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('availability.changed', {
      userId,
      kind: 'exception.created',
      recordId: created.id,
      type: created.type,
      startsAt: created.startsAt,
      endsAt: created.endsAt,
    });
    return created;
  }

  async updateException(
    id: string,
    patch: {
      type?: AvailabilityExceptionType;
      startsAt?: Date;
      endsAt?: Date;
      note?: string;
    },
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<AvailabilityException> {
    const before = await this.repo.findExceptionById(id);
    if (!before) throw new NotFoundException('Exception not found');
    this.assertSelfOrPrivileged(actor, before.userId);

    const nextStart = patch.startsAt ?? before.startsAt;
    const nextEnd = patch.endsAt ?? before.endsAt;
    if (nextEnd <= nextStart) {
      throw new BadRequestException('endsAt must be after startsAt');
    }

    const after = await this.repo.updateException(id, patch);
    this.audit.log({
      action: AuditAction.AVAILABILITY_UPDATED,
      entityType: 'AvailabilityException',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before,
      after,
      meta: { userId: before.userId, exception: true },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('availability.changed', {
      userId: before.userId,
      kind: 'exception.updated',
      recordId: id,
    });
    return after;
  }

  async removeException(
    id: string,
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<void> {
    const before = await this.repo.findExceptionById(id);
    if (!before) throw new NotFoundException('Exception not found');
    this.assertSelfOrPrivileged(actor, before.userId);
    await this.repo.deleteException(id);
    this.audit.log({
      action: AuditAction.AVAILABILITY_DELETED,
      entityType: 'AvailabilityException',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before,
      meta: { userId: before.userId, exception: true },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('availability.changed', {
      userId: before.userId,
      kind: 'exception.deleted',
      recordId: id,
    });
  }

  // ─── Validator API ───────────────────────────────────────────────────

  /**
   * Returns true iff the given UTC time window [startsAt, endsAt) is fully
   * contained within the user's availability after applying recurring
   * windows + exceptions.
   *
   * Exception logic:
   *   - UNAVAILABLE exceptions overriding any availability cause failure if
   *     the requested window overlaps them.
   *   - AVAILABLE exceptions add coverage that may not exist in the recurring
   *     pattern.
   *
   * The recurring window is expanded into UTC intervals for the requested
   * dates using each window's stated tz, so DST transitions are respected.
   */
  async isUserAvailable(
    userId: string,
    startsAt: Date,
    endsAt: Date,
  ): Promise<AvailabilityCheckResult> {
    if (endsAt <= startsAt)
      return { available: false, reason: 'Invalid time window' };

    const requested = { startsAt, endsAt };

    // 1) Hard "UNAVAILABLE" exceptions trump everything.
    const exceptions = await this.repo.listExceptionsForUser(userId, {
      from: startsAt,
      to: endsAt,
    });
    const unavailableIntervals = exceptions
      .filter((e) => e.type === AvailabilityExceptionType.UNAVAILABLE)
      .map((e) => ({ startsAt: e.startsAt, endsAt: e.endsAt }));
    if (overlapsAny(requested, unavailableIntervals)) {
      return {
        available: false,
        reason:
          'User has an unavailable exception overlapping the requested time',
      };
    }

    // 2) Build the union of coverage = recurring windows ∪ AVAILABLE exceptions.
    const recurring = await this.repo.listEffectiveForUser(userId, startsAt);
    const coverage: Array<{ startsAt: Date; endsAt: Date }> = [];
    for (const a of recurring) {
      coverage.push(
        ...expandWeeklyWindow(
          {
            dayOfWeek: a.dayOfWeek,
            startMinute: a.startMinute,
            endMinute: a.endMinute,
            timezone: a.timezone,
          },
          startsAt,
          endsAt,
        ),
      );
    }
    for (const e of exceptions) {
      if (e.type === AvailabilityExceptionType.AVAILABLE) {
        coverage.push({ startsAt: e.startsAt, endsAt: e.endsAt });
      }
    }

    if (coverage.length === 0) {
      return {
        available: false,
        reason: 'User has no declared availability for this period',
      };
    }

    if (!containedInAny(requested, coverage)) {
      return {
        available: false,
        reason: 'Requested time falls outside the user’s declared availability',
      };
    }
    return { available: true };
  }
}
