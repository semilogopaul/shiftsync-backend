import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, Location, Role } from '@prisma/client';

import { LocationsRepository } from './locations.repository';
import { UserRepository } from '../users/users.repository';
import { AuditLogService } from '../audit-log/audit-log.service';
import { isValidIanaTz } from '../../common/utils/time.util';
import { toPublicUser } from '../../common/types/public-user.type';

interface RequestContext {
  readonly actorId: string;
  readonly actorRole: Role;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

@Injectable()
export class LocationsService {
  constructor(
    private readonly repo: LocationsRepository,
    private readonly users: UserRepository,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Returns true if the actor is allowed to read a given location:
   * - ADMIN: always
   * - MANAGER: only when assigned via LocationManager
   * - EMPLOYEE: never via this method (employees access via shift/cert flows)
   */
  async assertCanReadLocation(actor: { sub: string; role: Role }, locationId: string): Promise<void> {
    if (actor.role === Role.ADMIN) return;
    if (actor.role === Role.MANAGER) {
      const ok = await this.repo.isManagerOf(actor.sub, locationId);
      if (!ok) throw new ForbiddenException('You are not a manager of this location');
      return;
    }
    throw new ForbiddenException('Insufficient permissions');
  }

  async assertCanManageLocation(actor: { sub: string; role: Role }, locationId: string): Promise<void> {
    if (actor.role === Role.ADMIN) return;
    if (actor.role === Role.MANAGER) {
      const ok = await this.repo.isManagerOf(actor.sub, locationId);
      if (!ok) throw new ForbiddenException('You are not a manager of this location');
      return;
    }
    throw new ForbiddenException('Insufficient permissions');
  }

  /** List the locations a manager is assigned to. Used to auto-scope reports. */
  async listManagedLocationIds(userId: string): Promise<string[]> {
    return this.repo.listManagedLocationIds(userId);
  }

  async list(
    actor: { sub: string; role: Role },
    filter: { search?: string; isActive?: boolean },
    pagination: { skip: number; take: number },
  ) {
    const scoped = {
      ...filter,
      // MANAGER → restrict to their assigned locations.
      managedByUserId: actor.role === Role.MANAGER ? actor.sub : undefined,
    };
    return this.repo.findManyPaginated(scoped, pagination);
  }

  async getById(actor: { sub: string; role: Role }, id: string): Promise<Location> {
    const location = await this.repo.findById(id);
    if (!location) throw new NotFoundException('Location not found');
    await this.assertCanReadLocation(actor, id);
    return location;
  }

  async create(
    input: { name: string; timezone: string; address?: string },
    ctx: RequestContext,
  ): Promise<Location> {
    if (!isValidIanaTz(input.timezone)) {
      throw new BadRequestException('timezone is not a valid IANA timezone');
    }
    const existing = await this.repo.findByName(input.name);
    if (existing) throw new ConflictException('A location with that name already exists');

    const created = await this.repo.createOne({
      name: input.name,
      timezone: input.timezone,
      address: input.address,
    });

    this.audit.log({
      action: AuditAction.LOCATION_CREATED,
      entityType: 'Location',
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
    patch: { name?: string; timezone?: string; address?: string; isActive?: boolean },
    ctx: RequestContext,
  ): Promise<Location> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException('Location not found');

    if (patch.timezone && !isValidIanaTz(patch.timezone)) {
      throw new BadRequestException('timezone is not a valid IANA timezone');
    }
    if (patch.name && patch.name !== before.name) {
      const collision = await this.repo.findByName(patch.name);
      if (collision && collision.id !== id) {
        throw new ConflictException('A location with that name already exists');
      }
    }

    const after = await this.repo.updateById(id, {
      name: patch.name,
      timezone: patch.timezone,
      address: patch.address,
      isActive: patch.isActive,
    });

    this.audit.log({
      action: AuditAction.LOCATION_UPDATED,
      entityType: 'Location',
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

  async remove(id: string, ctx: RequestContext): Promise<void> {
    const before = await this.repo.findById(id);
    if (!before) throw new NotFoundException('Location not found');

    const upcoming = await this.repo.countUpcomingShifts(id);
    if (upcoming > 0) {
      throw new ConflictException(
        `Cannot delete location: ${upcoming} upcoming shift(s) still scheduled. Cancel or reassign them first.`,
      );
    }

    const after = await this.repo.softDeleteById(id);
    this.audit.log({
      action: AuditAction.LOCATION_DELETED,
      entityType: 'Location',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before,
      after,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  // ─── Manager assignments ──────────────────────────────────────────────

  async listManagers(id: string) {
    const exists = await this.repo.findById(id);
    if (!exists) throw new NotFoundException('Location not found');
    const rows = await this.repo.listManagers(id);
    return rows.map((r) => ({
      assignmentId: r.id,
      assignedAt: r.createdAt,
      user: toPublicUser(r.user),
    }));
  }

  async assignManager(locationId: string, userId: string, ctx: RequestContext): Promise<void> {
    const location = await this.repo.findById(locationId);
    if (!location) throw new NotFoundException('Location not found');

    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    if (user.role !== Role.MANAGER) {
      throw new BadRequestException('Only users with MANAGER role can be assigned as managers');
    }

    const already = await this.repo.isManagerOf(userId, locationId);
    if (already) throw new ConflictException('User is already a manager of this location');

    await this.repo.assignManager(userId, locationId);
    this.audit.log({
      action: AuditAction.LOCATION_MANAGER_ASSIGNED,
      entityType: 'Location',
      entityId: locationId,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      meta: { userId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  async removeManager(locationId: string, userId: string, ctx: RequestContext): Promise<void> {
    const location = await this.repo.findById(locationId);
    if (!location) throw new NotFoundException('Location not found');

    const isManager = await this.repo.isManagerOf(userId, locationId);
    if (!isManager) throw new NotFoundException('User is not a manager of this location');

    await this.repo.removeManager(userId, locationId);
    this.audit.log({
      action: AuditAction.LOCATION_MANAGER_REMOVED,
      entityType: 'Location',
      entityId: locationId,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      meta: { userId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }
}
