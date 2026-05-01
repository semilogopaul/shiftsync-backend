import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, Prisma, Role, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';

import { UserRepository } from './users.repository';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PublicUser, toPublicUser } from '../../common/types/public-user.type';
import { isValidIanaTz } from '../../common/utils/time.util';

interface RequestContext {
  readonly actorId: string;
  readonly actorRole: Role;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly users: UserRepository,
    private readonly audit: AuditLogService,
    private readonly config: ConfigService,
  ) {}

  // ─── Self-service ──────────────────────────────────────────────────────

  async getProfile(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    return toPublicUser(user);
  }

  async updateProfile(
    userId: string,
    patch: { firstName?: string; lastName?: string; phone?: string; preferredTimezone?: string },
    ctx: RequestContext,
  ): Promise<PublicUser> {
    const before = await this.users.findById(userId);
    if (!before) throw new NotFoundException('User not found');

    if (patch.preferredTimezone && !isValidIanaTz(patch.preferredTimezone)) {
      throw new BadRequestException('preferredTimezone is not a valid IANA timezone');
    }

    const data: Prisma.UserUpdateInput = {};
    if (patch.firstName !== undefined) data.firstName = patch.firstName;
    if (patch.lastName !== undefined) data.lastName = patch.lastName;
    if (patch.phone !== undefined) data.phone = patch.phone;
    if (patch.preferredTimezone !== undefined) data.preferredTimezone = patch.preferredTimezone;

    const after = await this.users.updateById(userId, data);
    this.audit.log({
      action: AuditAction.USER_UPDATED,
      entityType: 'User',
      entityId: userId,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before: redact(before),
      after: redact(after),
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return toPublicUser(after);
  }

  async updateNotificationPrefs(
    userId: string,
    patch: { notifyInApp?: boolean; notifyEmail?: boolean },
    ctx: RequestContext,
  ): Promise<PublicUser> {
    const before = await this.users.findById(userId);
    if (!before) throw new NotFoundException('User not found');

    const data: Prisma.UserUpdateInput = {};
    if (patch.notifyInApp !== undefined) data.notifyInApp = patch.notifyInApp;
    if (patch.notifyEmail !== undefined) data.notifyEmail = patch.notifyEmail;

    const after = await this.users.updateById(userId, data);
    this.audit.log({
      action: AuditAction.USER_UPDATED,
      entityType: 'User',
      entityId: userId,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before: { notifyInApp: before.notifyInApp, notifyEmail: before.notifyEmail },
      after: { notifyInApp: after.notifyInApp, notifyEmail: after.notifyEmail },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return toPublicUser(after);
  }

  async updateDesiredHours(
    userId: string,
    desiredWeeklyHours: number,
    ctx: RequestContext,
  ): Promise<PublicUser> {
    const before = await this.users.findById(userId);
    if (!before) throw new NotFoundException('User not found');

    const after = await this.users.updateById(userId, { desiredWeeklyHours });
    this.audit.log({
      action: AuditAction.USER_UPDATED,
      entityType: 'User',
      entityId: userId,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before: { desiredWeeklyHours: before.desiredWeeklyHours },
      after: { desiredWeeklyHours: after.desiredWeeklyHours },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return toPublicUser(after);
  }

  // ─── Admin ─────────────────────────────────────────────────────────────

  async list(
    filter: { role?: Role; search?: string; isActive?: boolean },
    pagination: { skip: number; take: number },
  ): Promise<{ items: PublicUser[]; total: number }> {
    const { items, total } = await this.users.findManyPaginated(filter, pagination);
    return { items: items.map(toPublicUser), total };
  }

  /**
   * Light-weight directory available to any authenticated user. Returns
   * minimal user info (id, name, email, role) — never password/auth fields.
   * If `locationId` is provided, scopes to users currently certified there.
   * Hard-capped at 50 results to discourage data scraping; callers should pass
   * a `search` term for larger orgs.
   */
  async directory(filter: {
    role?: Role;
    locationId?: string;
    search?: string;
  }): Promise<Array<{ id: string; firstName: string; lastName: string; email: string; role: Role }>> {
    return this.users.findDirectory({ ...filter, take: 50 });
  }

  async getById(userId: string): Promise<PublicUser> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    return toPublicUser(user);
  }

  async adminCreate(
    input: {
      email: string;
      password: string;
      firstName: string;
      lastName: string;
      phone?: string;
      role: Role;
    },
    ctx: RequestContext,
  ): Promise<PublicUser> {
    if (await this.users.existsByEmail(input.email)) {
      throw new ConflictException('A user with that email already exists');
    }
    const cost = this.config.get<number>('BCRYPT_COST', 12);
    const passwordHash = await bcrypt.hash(input.password, cost);
    const created = await this.users.createOne({
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      role: input.role,
      // Admin-created accounts are pre-verified — their email was vetted by the admin.
      emailVerified: true,
    });
    this.audit.log({
      action: AuditAction.USER_CREATED,
      entityType: 'User',
      entityId: created.id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: redact(created),
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return toPublicUser(created);
  }

  async adminChangeRole(userId: string, newRole: Role, ctx: RequestContext): Promise<PublicUser> {
    if (userId === ctx.actorId) {
      throw new ForbiddenException('You cannot change your own role');
    }
    const before = await this.users.findById(userId);
    if (!before) throw new NotFoundException('User not found');
    if (before.role === newRole) return toPublicUser(before);

    const after = await this.users.updateById(userId, { role: newRole });
    this.audit.log({
      action: AuditAction.USER_ROLE_CHANGED,
      entityType: 'User',
      entityId: userId,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before: { role: before.role },
      after: { role: after.role },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return toPublicUser(after);
  }

  async adminSetActive(userId: string, isActive: boolean, ctx: RequestContext): Promise<PublicUser> {
    if (userId === ctx.actorId && !isActive) {
      throw new ForbiddenException('You cannot deactivate your own account');
    }
    const before = await this.users.findById(userId);
    if (!before) throw new NotFoundException('User not found');
    if (before.isActive === isActive) return toPublicUser(before);

    const after = await this.users.updateById(userId, { isActive });
    this.audit.log({
      action: isActive ? AuditAction.USER_ACTIVATED : AuditAction.USER_DEACTIVATED,
      entityType: 'User',
      entityId: userId,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before: { isActive: before.isActive },
      after: { isActive: after.isActive },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    return toPublicUser(after);
  }

  async adminSoftDelete(userId: string, ctx: RequestContext): Promise<void> {
    if (userId === ctx.actorId) {
      throw new ForbiddenException('You cannot delete your own account');
    }
    const before = await this.users.findById(userId);
    if (!before) throw new NotFoundException('User not found');

    const upcoming = await this.users.countUpcomingAssignments(userId);
    if (upcoming > 0) {
      throw new ConflictException(
        `Cannot delete user: ${upcoming} upcoming shift assignment(s). Unassign them first.`,
      );
    }

    const after = await this.users.softDeleteById(userId);
    this.audit.log({
      action: AuditAction.USER_DELETED,
      entityType: 'User',
      entityId: userId,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      before: redact(before),
      after: redact(after),
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }
}

function redact(user: User): Partial<User> {
  const { passwordHash: _ph, ...rest } = user;
  void _ph;
  return rest;
}
