import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { NotificationType, Prisma } from '@prisma/client';

import { NotificationsRepository } from './notifications.repository';
import { UserRepository } from '../users/users.repository';
import { ShiftsRepository } from '../shifts/shifts.repository';
import { LocationsRepository } from '../locations/locations.repository';
import { CertificationsRepository } from '../certifications/certifications.repository';
import { MailService } from '../../mail/mail.service';
import {
  shiftAssignedEmail,
  shiftChangedEmail,
  shiftCancelledEmail,
  schedulePublishedEmail,
  swapRequestedEmail,
  swapDecisionEmail,
  dropRequestedEmail,
} from '../../mail/templates';
import { formatInZone } from '../../common/utils/time.util';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly repo: NotificationsRepository,
    private readonly users: UserRepository,
    private readonly shifts: ShiftsRepository,
    private readonly locations: LocationsRepository,
    private readonly certs: CertificationsRepository,
    private readonly mail: MailService,
    private readonly events: EventEmitter2,
  ) {}

  // ─── Public read API (used by controller) ────────────────────────────

  list(userId: string, page: number, pageSize: number, onlyUnread: boolean) {
    return this.repo.listForUser(
      userId,
      { skip: (page - 1) * pageSize, take: pageSize },
      { onlyUnread },
    );
  }

  unreadCount(userId: string) {
    return this.repo.unreadCount(userId);
  }

  markRead(userId: string, id: string) {
    return this.repo.markRead(userId, id);
  }

  markAllRead(userId: string) {
    return this.repo.markAllRead(userId);
  }

  // ─── Internal core ──────────────────────────────────────────────────

  /**
   * Persist an in-app notification and (optionally) send a paired email.
   * Honours the user's notifyInApp / notifyEmail preferences.
   */
  private async deliver(args: {
    userId: string;
    type: NotificationType;
    title: string;
    body: string;
    payload?: Prisma.InputJsonValue;
    email?: { subject: string; html: string };
  }) {
    const user = await this.users.findById(args.userId);
    if (!user || !user.isActive) return;

    if (user.notifyInApp) {
      try {
        const created = await this.repo.create({
          userId: args.userId,
          type: args.type,
          title: args.title,
          body: args.body,
          payload: args.payload,
        });
        this.events.emit('notification.created', { userId: args.userId, notification: created });
      } catch (err) {
        this.logger.error(`deliver: persist failed userId=${args.userId} err=${(err as Error).message}`);
      }
    }

    if (user.notifyEmail && args.email && user.emailVerified) {
      this.mail.sendAndForget(user.email, {
        subject: args.email.subject,
        html: args.email.html,
      });
    }
  }

  // ─── Event listeners ─────────────────────────────────────────────────

  @OnEvent('shift.assigned')
  async onShiftAssigned(payload: { shiftId: string; userId: string; locationId: string; published: boolean }) {
    if (!payload.published) return; // silent for drafts
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    const user = await this.users.findById(payload.userId);
    if (!shift || !location || !user) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    await this.deliver({
      userId: payload.userId,
      type: NotificationType.SHIFT_ASSIGNED,
      title: `New shift at ${location.name}`,
      body: `${shift.skill.name} on ${whenLocal}`,
      payload: { shiftId: shift.id, locationId: location.id },
      email: shiftAssignedEmail({
        firstName: user.firstName,
        locationName: location.name,
        skillName: shift.skill.name,
        whenLocal,
        shiftUrl: `/shifts/${shift.id}`,
      }),
    });
  }

  @OnEvent('shift.unassigned')
  async onShiftUnassigned(payload: { shiftId: string; userId: string; locationId: string }) {
    const shift = await this.shifts.findByIdIncludingDeleted(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    const user = await this.users.findById(payload.userId);
    if (!shift || !location || !user) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    await this.deliver({
      userId: payload.userId,
      type: NotificationType.SHIFT_UNASSIGNED,
      title: `Removed from shift at ${location.name}`,
      body: `${whenLocal}`,
      payload: { shiftId: shift.id },
      email: shiftCancelledEmail({
        firstName: user.firstName,
        locationName: location.name,
        whenLocal,
      }),
    });
  }

  @OnEvent('shift.updated')
  async onShiftUpdated(payload: { shiftId: string; locationId: string }) {
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    if (!shift || !location) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    for (const a of shift.assignments) {
      const user = await this.users.findById(a.userId);
      if (!user) continue;
      await this.deliver({
        userId: a.userId,
        type: NotificationType.SHIFT_CHANGED,
        title: `Shift updated at ${location.name}`,
        body: `Updated details for your shift on ${whenLocal}`,
        payload: { shiftId: shift.id },
        email: shiftChangedEmail({
          firstName: user.firstName,
          locationName: location.name,
          whenLocal,
          changeSummary: 'A manager updated this shift.',
          shiftUrl: `/shifts/${shift.id}`,
        }),
      });
    }
  }

  @OnEvent('shift.deleted')
  async onShiftDeleted(payload: { shiftId: string; locationId: string }) {
    const shift = await this.shifts.findByIdIncludingDeleted(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    if (!shift || !location) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    // We can't read assignments anymore (cascade kept). Best-effort only.
    void whenLocal;
  }

  @OnEvent('shift.published')
  async onShiftPublished(payload: { shiftId: string; locationId: string }) {
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    if (!shift || !location) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    for (const a of shift.assignments) {
      const user = await this.users.findById(a.userId);
      if (!user) continue;
      await this.deliver({
        userId: a.userId,
        type: NotificationType.SCHEDULE_PUBLISHED,
        title: `Schedule published — ${location.name}`,
        body: `Your shift on ${whenLocal} is now live`,
        payload: { shiftId: shift.id },
        email: schedulePublishedEmail({
          firstName: user.firstName,
          weekLabel: whenLocal,
          shiftCount: 1,
          scheduleUrl: `/shifts/${shift.id}`,
        }),
      });
    }
  }

  @OnEvent('swap.requested')
  async onSwapRequested(payload: { shiftId: string; fromUserId: string; toUserId: string; swapId: string }) {
    const shift = await this.shifts.findById(payload.shiftId);
    if (!shift) return;
    const location = await this.locations.findById(shift.locationId);
    const fromUser = await this.users.findById(payload.fromUserId);
    const toUser = await this.users.findById(payload.toUserId);
    if (!location || !fromUser || !toUser) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    await this.deliver({
      userId: payload.toUserId,
      type: NotificationType.SWAP_REQUESTED,
      title: `Swap request from ${fromUser.firstName} ${fromUser.lastName}`,
      body: `${shift.skill.name} at ${location.name} on ${whenLocal}`,
      payload: { swapId: payload.swapId, shiftId: shift.id },
      email: swapRequestedEmail({
        firstName: toUser.firstName,
        fromName: `${fromUser.firstName} ${fromUser.lastName}`,
        locationName: location.name,
        whenLocal,
        swapUrl: `/swaps/${payload.swapId}`,
      }),
    });
  }

  @OnEvent('swap.recipient.accepted')
  async onSwapRecipientAccepted(payload: { swapId: string; shiftId: string; locationId: string; fromUserId: string; toUserId: string }) {
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    const requester = await this.users.findById(payload.fromUserId);
    const recipient = await this.users.findById(payload.toUserId);
    if (!shift || !location || !requester || !recipient) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);

    // Notify the requester that their swap is now awaiting manager approval.
    await this.deliver({
      userId: payload.fromUserId,
      type: NotificationType.SWAP_RECIPIENT_RESPONDED,
      title: 'Swap accepted — awaiting manager approval',
      body: `${recipient.firstName} ${recipient.lastName} accepted. A manager will review it shortly.`,
      payload: { swapId: payload.swapId },
    });

    // Notify managers of the location so they can approve.
    const managers = await this.locations.listManagers(payload.locationId);
    for (const m of managers) {
      await this.deliver({
        userId: m.userId,
        type: NotificationType.SWAP_RECIPIENT_RESPONDED,
        title: 'Swap needs your approval',
        body: `${requester.firstName} ${requester.lastName} ↔ ${recipient.firstName} ${recipient.lastName} — ${location.name} on ${whenLocal}`,
        payload: { swapId: payload.swapId, shiftId: payload.shiftId },
      });
    }
  }

  @OnEvent('swap.approved')
  async onSwapApproved(payload: { swapId: string; shiftId: string; fromUserId: string; toUserId: string; locationId: string }) {
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    if (!shift || !location) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    for (const userId of [payload.fromUserId, payload.toUserId]) {
      const user = await this.users.findById(userId);
      if (!user) continue;
      await this.deliver({
        userId,
        type: NotificationType.SWAP_MANAGER_APPROVED,
        title: 'Swap approved',
        body: `${location.name} on ${whenLocal}`,
        payload: { swapId: payload.swapId, shiftId: payload.shiftId },
        email: swapDecisionEmail({
          firstName: user.firstName,
          approved: true,
          locationName: location.name,
          whenLocal,
          shiftUrl: `/shifts/${payload.shiftId}`,
        }),
      });
    }
  }

  @OnEvent('swap.recipient.rejected')
  async onSwapRecipientRejected(payload: { swapId: string; shiftId: string; fromUserId: string; toUserId: string }) {
    const shift = await this.shifts.findById(payload.shiftId);
    if (!shift) return;
    const location = await this.locations.findById(shift.locationId);
    if (!location) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    const recipient = await this.users.findById(payload.toUserId);
    await this.deliver({
      userId: payload.fromUserId,
      type: NotificationType.SWAP_RECIPIENT_RESPONDED,
      title: 'Swap request declined',
      body: `${recipient ? `${recipient.firstName} ${recipient.lastName}` : 'The recipient'} declined your swap for ${location.name} on ${whenLocal}`,
      payload: { swapId: payload.swapId, shiftId: payload.shiftId },
    });
  }

  @OnEvent('swap.cancelled')
  async onSwapCancelled(payload: { swapId: string; shiftId: string; fromUserId: string; toUserId: string; locationId: string }) {
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    if (!shift || !location) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    const requester = await this.users.findById(payload.fromUserId);
    await this.deliver({
      userId: payload.toUserId,
      type: NotificationType.SWAP_AUTO_CANCELLED,
      title: 'Swap request cancelled',
      body: `${requester ? `${requester.firstName} ${requester.lastName}` : 'The requester'} cancelled the swap for ${location.name} on ${whenLocal}`,
      payload: { swapId: payload.swapId, shiftId: payload.shiftId },
    });
  }

  @OnEvent('swap.rejected')
  async onSwapRejected(payload: { swapId: string; shiftId: string; fromUserId: string; toUserId: string; locationId: string }) {
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    if (!shift || !location) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    for (const userId of [payload.fromUserId, payload.toUserId]) {
      const user = await this.users.findById(userId);
      if (!user) continue;
      await this.deliver({
        userId,
        type: NotificationType.SWAP_MANAGER_REJECTED,
        title: 'Swap not approved',
        body: `${location.name} on ${whenLocal}`,
        payload: { swapId: payload.swapId, shiftId: payload.shiftId },
        email: swapDecisionEmail({
          firstName: user.firstName,
          approved: false,
          locationName: location.name,
          whenLocal,
          shiftUrl: `/shifts/${payload.shiftId}`,
        }),
      });
    }
  }

  @OnEvent('swap.auto.cancelled')
  async onSwapAutoCancelled(payload: {
    shiftId: string;
    cancelledSwaps: number;
    cancelledDrops: number;
    swaps?: { id: string; fromUserId: string; toUserId: string }[];
    drops?: { id: string; fromUserId: string; claimedById: string | null }[];
  }) {
    this.logger.log(
      `auto-cancelled ${payload.cancelledSwaps} swap(s) and ${payload.cancelledDrops} drop(s) on shift ${payload.shiftId} due to edit`,
    );
    const shift = await this.shifts.findById(payload.shiftId);
    const location = shift ? await this.locations.findById(shift.locationId) : null;
    const whenLocal = shift && location ? formatInZone(shift.startsAt, location.timezone) : '';
    const locationName = location?.name ?? 'this location';

    // Notify each party of every cancelled swap.
    for (const swap of payload.swaps ?? []) {
      for (const userId of [swap.fromUserId, swap.toUserId]) {
        await this.deliver({
          userId,
          type: NotificationType.SWAP_AUTO_CANCELLED,
          title: 'Swap cancelled — shift was edited',
          body: whenLocal
            ? `Your pending swap for ${locationName} on ${whenLocal} was cancelled because a manager edited the shift.`
            : 'A pending swap was cancelled because a manager edited the shift.',
          payload: { swapId: swap.id, shiftId: payload.shiftId },
        });
      }
    }

    // Notify the drop owner and (if any) the claimer.
    for (const drop of payload.drops ?? []) {
      const userIds = [drop.fromUserId, drop.claimedById].filter(
        (v): v is string => Boolean(v),
      );
      for (const userId of userIds) {
        await this.deliver({
          userId,
          type: NotificationType.SWAP_AUTO_CANCELLED,
          title: 'Drop request cancelled — shift was edited',
          body: whenLocal
            ? `Your drop request for ${locationName} on ${whenLocal} was cancelled because a manager edited the shift.`
            : 'A drop request was cancelled because a manager edited the shift.',
          payload: { dropId: drop.id, shiftId: payload.shiftId },
        });
      }
    }
  }

  @OnEvent('drop.expired')
  async onDropExpired(payload: {
    dropId: string;
    shiftId: string;
    fromUserId: string;
    locationId: string;
  }) {
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    if (!shift || !location) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    await this.deliver({
      userId: payload.fromUserId,
      type: NotificationType.DROP_EXPIRED,
      title: 'Drop request expired',
      body: `No one claimed your shift at ${location.name} on ${whenLocal}. You're still on the schedule.`,
      payload: { dropId: payload.dropId, shiftId: payload.shiftId },
    });
    // Also let managers know coverage was not found.
    const managers = await this.locations.listManagers(location.id);
    for (const m of managers) {
      await this.deliver({
        userId: m.userId,
        type: NotificationType.DROP_EXPIRED,
        title: 'Unclaimed drop expired',
        body: `${location.name} on ${whenLocal} — no one picked up the shift.`,
        payload: { dropId: payload.dropId, shiftId: payload.shiftId },
      });
    }
  }

  @OnEvent('drop.requested')
  async onDropRequested(payload: { dropId: string; shiftId: string; fromUserId: string; locationId: string }) {
    // Notify managers of this location.
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    const fromUser = await this.users.findById(payload.fromUserId);
    if (!shift || !location || !fromUser) return;
    const managers = await this.locations.listManagers(location.id);
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    for (const m of managers) {
      await this.deliver({
        userId: m.userId,
        type: NotificationType.DROP_REQUESTED,
        title: `${fromUser.firstName} ${fromUser.lastName} dropped a shift`,
        body: `${location.name} on ${whenLocal}`,
        payload: { dropId: payload.dropId, shiftId: payload.shiftId },
        email: dropRequestedEmail({
          firstName: m.user.firstName,
          fromName: `${fromUser.firstName} ${fromUser.lastName}`,
          locationName: location.name,
          whenLocal,
          reviewUrl: `/drops/${payload.dropId}`,
        }),
      });
    }
  }

  @OnEvent('drop.claimed')
  async onDropClaimed(payload: { dropId: string; shiftId: string; fromUserId: string; claimedById: string; locationId: string }) {
    // Notify managers + the original owner.
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    if (!shift || !location) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    const claimer = await this.users.findById(payload.claimedById);
    if (!claimer) return;
    const managers = await this.locations.listManagers(location.id);
    for (const m of managers) {
      await this.deliver({
        userId: m.userId,
        type: NotificationType.DROP_CLAIMED,
        title: `${claimer.firstName} ${claimer.lastName} claimed a drop`,
        body: `Awaiting your approval — ${location.name} on ${whenLocal}`,
        payload: { dropId: payload.dropId, shiftId: payload.shiftId },
      });
    }
  }

  @OnEvent('drop.rejected')
  async onDropRejected(payload: { dropId: string; shiftId: string; fromUserId: string; claimedById: string | null; locationId: string }) {
    if (!payload.claimedById) return;
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    if (!shift || !location) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    const claimer = await this.users.findById(payload.claimedById);
    if (!claimer) return;
    await this.deliver({
      userId: payload.claimedById,
      type: NotificationType.DROP_REJECTED,
      title: 'Shift claim not approved',
      body: `Your claim for ${location.name} on ${whenLocal} was not approved by the manager`,
      payload: { dropId: payload.dropId, shiftId: payload.shiftId },
    });
  }

  @OnEvent('drop.approved')
  async onDropApproved(payload: { dropId: string; shiftId: string; fromUserId: string; claimedById: string; locationId: string }) {
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    if (!shift || !location) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    for (const userId of [payload.fromUserId, payload.claimedById]) {
      const user = await this.users.findById(userId);
      if (!user) continue;
      await this.deliver({
        userId,
        type: NotificationType.DROP_APPROVED,
        title: 'Drop approved',
        body: `${location.name} on ${whenLocal}`,
        payload: { dropId: payload.dropId, shiftId: payload.shiftId },
      });
    }
  }

  /**
   * When a staff member changes their availability, notify managers of every
   * location they are actively certified to work at, since it may affect
   * upcoming/future scheduling decisions.
   */
  @OnEvent('availability.changed')
  async onAvailabilityChanged(payload: { userId: string; kind: string; recordId: string }) {
    const staff = await this.users.findById(payload.userId);
    if (!staff) return;
    const certs = await this.certs.listActiveForUser(payload.userId);
    const seenManagers = new Set<string>();
    for (const c of certs) {
      const managers = await this.locations.listManagers(c.locationId);
      for (const m of managers) {
        if (seenManagers.has(m.userId)) continue;
        seenManagers.add(m.userId);
        await this.deliver({
          userId: m.userId,
          type: NotificationType.AVAILABILITY_CHANGED,
          title: 'Staff availability changed',
          body: `${staff.firstName} ${staff.lastName} updated their availability`,
          payload: { staffUserId: staff.id, kind: payload.kind, recordId: payload.recordId },
        });
      }
    }
  }

  /**
   * Fired when a shift edit (time/skill change) leaves an existing assignee
   * in violation of one or more rules. Notifies the affected staff member and
   * every manager of the location so they can decide whether to unassign.
   */
  @OnEvent('shift.assignment.invalidated')
  async onAssignmentInvalidated(payload: {
    shiftId: string;
    userId: string;
    locationId: string;
    errors: { code: string; message: string }[];
    warnings: { code: string; message: string }[];
  }) {
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    const staff = await this.users.findById(payload.userId);
    if (!shift || !location || !staff) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    const summary =
      [...payload.errors, ...payload.warnings].map((f) => f.code).join(', ') || 'rule violation';
    const body = `${staff.firstName} ${staff.lastName} no longer satisfies ${shift.skill.name} on ${whenLocal} (${summary}). Review and reassign if needed.`;

    const managers = await this.locations.listManagers(location.id);
    for (const m of managers) {
      await this.deliver({
        userId: m.userId,
        type: NotificationType.SHIFT_CHANGED,
        title: `Edit invalidated assignee at ${location.name}`,
        body,
        payload: {
          shiftId: shift.id,
          userId: payload.userId,
          errors: payload.errors,
          warnings: payload.warnings,
        },
      });
    }
    await this.deliver({
      userId: payload.userId,
      type: NotificationType.SHIFT_CHANGED,
      title: `Your shift at ${location.name} was edited`,
      body: `Manager has updated ${shift.skill.name} on ${whenLocal}. Please review — some details may no longer match your availability or skills.`,
      payload: { shiftId: shift.id },
    });
  }

  /**
   * Sunday-night-chaos: a staff member called out of their shift. Send an
   * urgent notification to every manager of the location, with the suggested
   * replacements embedded in the payload so the UI can show one-click reassign.
   */
  @OnEvent('shift.callout')
  async onShiftCallout(payload: {
    shiftId: string;
    userId: string;
    locationId: string;
    reason: string;
    minutesUntilStart: number;
    suggestions: {
      user: { id: string; firstName: string; lastName: string; email: string; role: string };
      reasons: string[];
    }[];
  }) {
    const shift = await this.shifts.findById(payload.shiftId);
    const location = await this.locations.findById(payload.locationId);
    const staff = await this.users.findById(payload.userId);
    if (!shift || !location || !staff) return;
    const whenLocal = formatInZone(shift.startsAt, location.timezone);
    const urgent = payload.minutesUntilStart < 4 * 60;
    const managers = await this.locations.listManagers(location.id);
    for (const m of managers) {
      await this.deliver({
        userId: m.userId,
        type: NotificationType.SHIFT_CHANGED,
        title: `${urgent ? 'URGENT — ' : ''}${staff.firstName} ${staff.lastName} called out`,
        body: `${location.name} on ${whenLocal} (in ${payload.minutesUntilStart} min). Reason: ${payload.reason}`,
        payload: {
          shiftId: payload.shiftId,
          urgent,
          minutesUntilStart: payload.minutesUntilStart,
          suggestions: payload.suggestions,
        },
      });
    }
  }

  /**
   * Validator-emitted overtime warning. Notifies the affected staff member
   * and the location's managers when assignment pushes weekly hours over
   * 35h (APPROACHING) or 40h (OVER).
   */
  @OnEvent('overtime.warning')
  async onOvertimeWarning(payload: {
    userId: string;
    locationId: string;
    weeklyHours: number;
    severity: 'APPROACHING' | 'OVER';
    shiftId?: string;
  }) {
    const user = await this.users.findById(payload.userId);
    const location = await this.locations.findById(payload.locationId);
    if (!user || !location) return;
    const title =
      payload.severity === 'OVER'
        ? `Overtime: ${user.firstName} ${user.lastName} at ${payload.weeklyHours.toFixed(1)}h this week`
        : `${user.firstName} ${user.lastName} approaching 40h (${payload.weeklyHours.toFixed(1)}h)`;
    const managers = await this.locations.listManagers(location.id);
    for (const m of managers) {
      await this.deliver({
        userId: m.userId,
        type: NotificationType.OVERTIME_WARNING,
        title,
        body: `Review the schedule at ${location.name}`,
        payload: { staffUserId: user.id, locationId: location.id, shiftId: payload.shiftId, weeklyHours: payload.weeklyHours },
      });
    }
    // Also notify the staff member themselves
    await this.deliver({
      userId: user.id,
      type: NotificationType.OVERTIME_WARNING,
      title: `You're at ${payload.weeklyHours.toFixed(1)}h this week`,
      body: payload.severity === 'OVER' ? 'You are over 40h.' : 'Heads up: approaching 40h.',
      payload: { weeklyHours: payload.weeklyHours, locationId: location.id },
    });
  }
}
