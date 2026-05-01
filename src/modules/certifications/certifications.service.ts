import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Role } from '@prisma/client';

import { CertificationsRepository, CertificationWithRelations } from './certifications.repository';
import { LocationsRepository } from '../locations/locations.repository';
import { LocationsService } from '../locations/locations.service';
import { SkillsRepository } from '../skills/skills.repository';
import { UserRepository } from '../users/users.repository';
import { AuditLogService } from '../audit-log/audit-log.service';

interface RequestContext {
  readonly actorId: string;
  readonly actorRole: Role;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

@Injectable()
export class CertificationsService {
  constructor(
    private readonly repo: CertificationsRepository,
    private readonly locations: LocationsService,
    private readonly locationsRepo: LocationsRepository,
    private readonly skills: SkillsRepository,
    private readonly users: UserRepository,
    private readonly audit: AuditLogService,
  ) {}

  // ─── Read ────────────────────────────────────────────────────────────

  async listForUser(
    actor: { sub: string; role: Role },
    userId: string,
    includeHistory = false,
  ): Promise<CertificationWithRelations[]> {
    // Self can read own; admin/manager read others (manager scoping handled at the cert→location level)
    if (actor.sub !== userId && actor.role !== Role.ADMIN && actor.role !== Role.MANAGER) {
      throw new ForbiddenException('Insufficient permissions');
    }
    const target = await this.users.findById(userId);
    if (!target) throw new NotFoundException('User not found');

    const rows = await this.repo.listForUser(userId, includeHistory);
    if (actor.role === Role.MANAGER) {
      // Filter to certifications at locations this manager manages
      const filtered: CertificationWithRelations[] = [];
      for (const row of rows) {
        if (await this.locationsRepo.isManagerOf(actor.sub, row.locationId)) {
          filtered.push(row);
        }
      }
      return filtered;
    }
    return rows;
  }

  async listForLocation(
    actor: { sub: string; role: Role },
    locationId: string,
    includeHistory = false,
  ): Promise<CertificationWithRelations[]> {
    await this.locations.assertCanReadLocation(actor, locationId);
    return this.repo.listForLocation(locationId, includeHistory);
  }

  // ─── Mutations ───────────────────────────────────────────────────────

  async grant(
    input: { userId: string; locationId: string; skillIds: string[]; expiresAt?: Date; notes?: string },
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<CertificationWithRelations> {
    await this.locations.assertCanManageLocation(actor, input.locationId);

    const user = await this.users.findById(input.userId);
    if (!user) throw new NotFoundException('User not found');

    const skills = await this.skills.findManyByIds(input.skillIds);
    if (skills.length !== input.skillIds.length) {
      throw new BadRequestException('One or more skill ids are invalid');
    }

    // If a record already exists (active or revoked), surface a clear path:
    const existing = await this.repo.findByUserAndLocation(input.userId, input.locationId);
    if (existing && !existing.decertifiedAt) {
      throw new ConflictException('User already has an active certification at this location');
    }
    if (existing && existing.decertifiedAt) {
      // Reactivate + replace skill set
      const reactivated = await this.repo.recertify(existing.id);
      const updated = await this.repo.updateWithSkills(reactivated.id, {
        skillIds: input.skillIds,
        expiresAt: input.expiresAt ?? null,
        notes: input.notes ?? null,
      });
      this.audit.log({
        action: AuditAction.CERTIFICATION_GRANTED,
        entityType: 'Certification',
        entityId: updated.id,
        actorId: ctx.actorId,
        actorRole: ctx.actorRole,
        before: existing,
        after: updated,
        meta: { reactivated: true },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      return updated;
    }

    const created = await this.repo.createWithSkills({
      userId: input.userId,
      locationId: input.locationId,
      skillIds: input.skillIds,
      expiresAt: input.expiresAt,
      notes: input.notes,
    });
    this.audit.log({
      action: AuditAction.CERTIFICATION_GRANTED,
      entityType: 'Certification',
      entityId: created.id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: created,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return created;
  }

  async update(
    id: string,
    patch: { skillIds?: string[]; expiresAt?: Date | null; notes?: string | null },
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<CertificationWithRelations> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException('Certification not found');
    await this.locations.assertCanManageLocation(actor, before.locationId);

    if (patch.skillIds && patch.skillIds.length > 0) {
      const skills = await this.skills.findManyByIds(patch.skillIds);
      if (skills.length !== patch.skillIds.length) {
        throw new BadRequestException('One or more skill ids are invalid');
      }
    }

    const after = await this.repo.updateWithSkills(id, patch);
    this.audit.log({
      action: AuditAction.CERTIFICATION_UPDATED,
      entityType: 'Certification',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before,
      after,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return after;
  }

  /**
   * Revoke (de-certify) without deletion — preserves audit history.
   * Per design: never delete certifications; flag them with decertifiedAt
   * so historical assignments remain explicable.
   */
  async revoke(
    id: string,
    actor: { sub: string; role: Role },
    ctx: RequestContext,
  ): Promise<CertificationWithRelations> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException('Certification not found');
    if (before.decertifiedAt) {
      throw new ConflictException('Certification is already revoked');
    }
    await this.locations.assertCanManageLocation(actor, before.locationId);

    const after = await this.repo.decertify(id, new Date());
    this.audit.log({
      action: AuditAction.CERTIFICATION_REVOKED,
      entityType: 'Certification',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before,
      after,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return after;
  }
}
