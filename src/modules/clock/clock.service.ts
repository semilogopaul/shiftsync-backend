import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClockEventType, Role } from '@prisma/client';

import { ClockRepository } from './clock.repository';
import { ShiftsRepository } from '../shifts/shifts.repository';
import { LocationsService } from '../locations/locations.service';
import { AuditLogService } from '../../modules/audit-log/audit-log.service';
import { AuditAction } from '@prisma/client';

const CLOCK_IN_GRACE_MINUTES_BEFORE = 15;
const CLOCK_IN_LATE_MINUTES_AFTER = 60;

@Injectable()
export class ClockService {
  constructor(
    private readonly repo: ClockRepository,
    private readonly shifts: ShiftsRepository,
    private readonly locations: LocationsService,
    private readonly events: EventEmitter2,
    private readonly audit: AuditLogService,
  ) {}

  /** Staff or self-clock. Managers/admins may also clock-in on a user's behalf. */
  async clockIn(actor: { sub: string; role: Role }, shiftId: string, targetUserId?: string) {
    const shift = await this.shifts.findById(shiftId);
    if (!shift) throw new NotFoundException('Shift not found');
    if (!shift.publishedAt) throw new BadRequestException('Cannot clock into an unpublished shift');

    const userId = targetUserId ?? actor.sub;
    if (userId !== actor.sub) {
      // Non-self → must be manager/admin for this location
      await this.locations.assertCanManageLocation(actor, shift.locationId);
    }

    const isAssigned = shift.assignments.some((a) => a.userId === userId);
    if (!isAssigned) throw new ForbiddenException('User is not assigned to this shift');

    const last = await this.repo.findLatestForAssignment(shiftId, userId);
    if (last && last.type === ClockEventType.CLOCK_IN) {
      throw new BadRequestException('User is already clocked in');
    }

    const now = new Date();
    const earliest = new Date(shift.startsAt.getTime() - CLOCK_IN_GRACE_MINUTES_BEFORE * 60_000);
    if (now < earliest) {
      throw new BadRequestException('Too early to clock in for this shift');
    }
    const latestAllowed = new Date(shift.startsAt.getTime() + CLOCK_IN_LATE_MINUTES_AFTER * 60_000);
    const isLate = now > latestAllowed;

    const event = await this.repo.create({
      shiftId,
      userId,
      type: ClockEventType.CLOCK_IN,
      occurredAt: now,
    });

    this.audit.log({
      action: AuditAction.CLOCK_IN,
      entityType: 'ClockEvent',
      entityId: event.id,
      actorId: actor.sub,
      actorRole: actor.role,
      meta: { shiftId, userId, late: isLate },
    });

    this.events.emit('clock.in', { userId, shiftId, locationId: shift.locationId, occurredAt: now });
    return { event, late: isLate };
  }

  async clockOut(actor: { sub: string; role: Role }, shiftId: string, targetUserId?: string) {
    const shift = await this.shifts.findById(shiftId);
    if (!shift) throw new NotFoundException('Shift not found');

    const userId = targetUserId ?? actor.sub;
    if (userId !== actor.sub) {
      await this.locations.assertCanManageLocation(actor, shift.locationId);
    }

    const last = await this.repo.findLatestForAssignment(shiftId, userId);
    if (!last || last.type !== ClockEventType.CLOCK_IN) {
      throw new BadRequestException('User is not currently clocked in');
    }

    const now = new Date();
    const event = await this.repo.create({
      shiftId,
      userId,
      type: ClockEventType.CLOCK_OUT,
      occurredAt: now,
    });

    this.audit.log({
      action: AuditAction.CLOCK_OUT,
      entityType: 'ClockEvent',
      entityId: event.id,
      actorId: actor.sub,
      actorRole: actor.role,
      meta: { shiftId, userId, durationMs: now.getTime() - last.occurredAt.getTime() },
    });

    this.events.emit('clock.out', { userId, shiftId, locationId: shift.locationId, occurredAt: now });
    return { event };
  }

  /**
   * Live "on duty" listing. Manager/Admin only.
   *  • Admin without locationId → all locations.
   *  • Admin with locationId → that location.
   *  • Manager without locationId → auto-scoped to all managed locations.
   *  • Manager with locationId → must manage it; otherwise 403.
   */
  async listOnDuty(actor: { sub: string; role: Role }, locationId: string | undefined) {
    if (locationId) {
      await this.locations.assertCanManageLocation(actor, locationId);
      return this.repo.listOnDutyForLocation([locationId]);
    }
    if (actor.role === Role.ADMIN) {
      return this.repo.listOnDutyForLocation(undefined);
    }
    // Manager without explicit locationId — scope to managed locations.
    const ids = await this.locations.listManagedLocationIds(actor.sub);
    return this.repo.listOnDutyForLocation(ids);
  }
}
