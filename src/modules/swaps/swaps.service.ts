import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  AuditAction,
  DropStatus,
  Role,
  SwapStatus,
} from '@prisma/client';

import { SwapsRepository } from './swaps.repository';
import { ShiftsRepository } from '../shifts/shifts.repository';
import { ShiftValidatorService } from '../shifts/validation/shift-validator.service';
import { LocationsService } from '../locations/locations.service';
import { AuditLogService } from '../audit-log/audit-log.service';

interface RequestContext {
  readonly actorId: string;
  readonly actorRole: Role;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

const MAX_PENDING_PER_USER = 3;
const DROP_EXPIRY_HOURS_BEFORE_SHIFT = 24;

@Injectable()
export class SwapsService {
  constructor(
    private readonly repo: SwapsRepository,
    private readonly shifts: ShiftsRepository,
    private readonly validator: ShiftValidatorService,
    private readonly locations: LocationsService,
    private readonly audit: AuditLogService,
    private readonly events: EventEmitter2,
  ) {}

  // ─── Helpers ─────────────────────────────────────────────────────────

  private async assertNotOverPendingCap(userId: string): Promise<void> {
    const [swaps, drops] = await Promise.all([
      this.repo.countPendingSwapsForUser(userId),
      this.repo.countPendingDropsForUser(userId),
    ]);
    if (swaps + drops >= MAX_PENDING_PER_USER) {
      throw new BadRequestException(
        `You already have ${swaps + drops} pending swap/drop requests (max ${MAX_PENDING_PER_USER})`,
      );
    }
  }

  // ─── SWAP REQUEST ────────────────────────────────────────────────────

  async createSwap(
    actor: { sub: string; role: Role },
    input: { shiftId: string; toUserId: string; reason?: string },
    ctx: RequestContext,
  ) {
    if (input.toUserId === actor.sub) {
      throw new BadRequestException('You cannot swap with yourself');
    }
    const shift = await this.shifts.findById(input.shiftId);
    if (!shift) throw new NotFoundException('Shift not found');

    const myAssignment = await this.shifts.findAssignment(input.shiftId, actor.sub);
    if (!myAssignment) {
      throw new ForbiddenException('You are not assigned to this shift');
    }
    await this.assertNotOverPendingCap(actor.sub);

    const created = await this.repo.createSwap({
      shiftId: input.shiftId,
      fromUserId: actor.sub,
      toUserId: input.toUserId,
      status: SwapStatus.PENDING_RECIPIENT,
      reason: input.reason,
    });
    this.audit.log({
      action: AuditAction.SWAP_REQUESTED,
      entityType: 'SwapRequest',
      entityId: created.id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: created,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('swap.requested', {
      swapId: created.id,
      shiftId: shift.id,
      fromUserId: actor.sub,
      toUserId: input.toUserId,
      locationId: shift.locationId,
    });
    return created;
  }

  async recipientAccept(id: string, actor: { sub: string; role: Role }, ctx: RequestContext) {
    const swap = await this.repo.findSwapById(id);
    if (!swap) throw new NotFoundException('Swap not found');
    if (swap.toUserId !== actor.sub) throw new ForbiddenException('Not your swap');
    if (swap.status !== SwapStatus.PENDING_RECIPIENT) {
      throw new ConflictException(`Swap is not awaiting recipient (status=${swap.status})`);
    }

    // Pre-validate the recipient against the shift before forwarding to manager.
    const validation = await this.validator.validateAssignment(actor.sub, swap.shift);
    if (!validation.ok) {
      // Auto-reject with rationale if recipient cannot legally take the shift.
      const rejected = await this.repo.updateSwap(id, {
        status: SwapStatus.REJECTED_BY_RECIPIENT,
        recipientRespondedAt: new Date(),
        reason: 'Validation failed for recipient',
      });
      this.audit.log({
        action: AuditAction.SWAP_RECIPIENT_REJECTED,
        entityType: 'SwapRequest',
        entityId: id,
        actorId: ctx.actorId,
        actorRole: ctx.actorRole,
        after: rejected,
        meta: { reason: 'auto-reject; validation failed', validation },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      throw new BadRequestException({
        message: 'Cannot accept: you do not meet the shift requirements',
        validation,
      });
    }

    const updated = await this.repo.updateSwap(id, {
      status: SwapStatus.PENDING_MANAGER,
      recipientRespondedAt: new Date(),
    });
    this.audit.log({
      action: AuditAction.SWAP_RECIPIENT_ACCEPTED,
      entityType: 'SwapRequest',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: updated,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('swap.recipient.accepted', {
      swapId: id,
      shiftId: swap.shiftId,
      fromUserId: swap.fromUserId,
      toUserId: swap.toUserId,
      locationId: swap.shift.locationId,
    });
    return updated;
  }

  async recipientReject(id: string, actor: { sub: string; role: Role }, ctx: RequestContext) {
    const swap = await this.repo.findSwapById(id);
    if (!swap) throw new NotFoundException('Swap not found');
    if (swap.toUserId !== actor.sub) throw new ForbiddenException('Not your swap');
    if (swap.status !== SwapStatus.PENDING_RECIPIENT) {
      throw new ConflictException(`Swap is not awaiting recipient (status=${swap.status})`);
    }
    const updated = await this.repo.updateSwap(id, {
      status: SwapStatus.REJECTED_BY_RECIPIENT,
      recipientRespondedAt: new Date(),
    });
    this.audit.log({
      action: AuditAction.SWAP_RECIPIENT_REJECTED,
      entityType: 'SwapRequest',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: updated,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('swap.recipient.rejected', {
      swapId: id,
      shiftId: swap.shiftId,
      fromUserId: swap.fromUserId,
      toUserId: swap.toUserId,
    });
    return updated;
  }

  async requesterCancel(id: string, actor: { sub: string; role: Role }, ctx: RequestContext) {
    const swap = await this.repo.findSwapById(id);
    if (!swap) throw new NotFoundException('Swap not found');
    if (swap.fromUserId !== actor.sub) throw new ForbiddenException('Not your swap');
    if (
      swap.status !== SwapStatus.PENDING_RECIPIENT &&
      swap.status !== SwapStatus.PENDING_MANAGER
    ) {
      throw new ConflictException('Cannot cancel: swap is not pending');
    }
    const updated = await this.repo.updateSwap(id, { status: SwapStatus.CANCELLED });
    this.audit.log({
      action: AuditAction.SWAP_CANCELLED,
      entityType: 'SwapRequest',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: updated,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('swap.cancelled', { swapId: id, shiftId: swap.shiftId, fromUserId: swap.fromUserId, toUserId: swap.toUserId, locationId: swap.shift.locationId });
    return updated;
  }

  async managerApprove(id: string, actor: { sub: string; role: Role }, ctx: RequestContext) {
    const swap = await this.repo.findSwapById(id);
    if (!swap) throw new NotFoundException('Swap not found');
    await this.locations.assertCanManageLocation(actor, swap.shift.locationId);
    if (swap.status !== SwapStatus.PENDING_MANAGER) {
      throw new ConflictException('Swap is not awaiting manager approval');
    }

    // Re-validate recipient at decision time (state may have changed).
    const validation = await this.validator.validateAssignment(swap.toUserId, swap.shift);
    if (!validation.ok) {
      throw new BadRequestException({
        message: 'Recipient no longer satisfies the shift requirements',
        validation,
      });
    }

    // Perform the swap atomically: delete fromUser assignment, create toUser assignment.
    const updated = await this.repo.updateSwap(id, {
      status: SwapStatus.APPROVED,
      managerDecisionAt: new Date(),
      decidedById: actor.sub,
    });
    await this.shifts.deleteAssignment(swap.shiftId, swap.fromUserId);
    await this.shifts.createAssignment({
      shiftId: swap.shiftId,
      userId: swap.toUserId,
      assignedById: actor.sub,
    });

    this.audit.log({
      action: AuditAction.SWAP_APPROVED,
      entityType: 'SwapRequest',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: updated,
      meta: { shiftId: swap.shiftId, fromUserId: swap.fromUserId, toUserId: swap.toUserId },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('swap.approved', {
      swapId: id,
      shiftId: swap.shiftId,
      fromUserId: swap.fromUserId,
      toUserId: swap.toUserId,
      locationId: swap.shift.locationId,
    });
    return updated;
  }

  async managerReject(
    id: string,
    actor: { sub: string; role: Role },
    reason: string | undefined,
    ctx: RequestContext,
  ) {
    const swap = await this.repo.findSwapById(id);
    if (!swap) throw new NotFoundException('Swap not found');
    await this.locations.assertCanManageLocation(actor, swap.shift.locationId);
    if (swap.status !== SwapStatus.PENDING_MANAGER) {
      throw new ConflictException('Swap is not awaiting manager approval');
    }
    const updated = await this.repo.updateSwap(id, {
      status: SwapStatus.REJECTED_BY_MANAGER,
      managerDecisionAt: new Date(),
      decidedById: actor.sub,
      reason,
    });
    this.audit.log({
      action: AuditAction.SWAP_REJECTED,
      entityType: 'SwapRequest',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: updated,
      meta: { reason },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('swap.rejected', { swapId: id, shiftId: swap.shiftId, fromUserId: swap.fromUserId, toUserId: swap.toUserId, locationId: swap.shift.locationId });
    return updated;
  }

  async listMySwaps(actor: { sub: string; role: Role }, onlyPending = false) {
    return this.repo.listSwapsForUser(actor.sub, { onlyPending });
  }

  /**
   * Counts of the actor's currently-pending swap and drop requests, plus the
   * configured per-user cap. Used by the UI to pre-flight the 3-pending limit
   * (disable the "Request swap" / "Drop shift" buttons when at cap) without
   * requiring users to discover the limit by failing.
   */
  async getMyPendingCounts(actor: { sub: string; role: Role }): Promise<{
    pendingSwaps: number;
    pendingDrops: number;
    total: number;
    limit: number;
  }> {
    const [pendingSwaps, pendingDrops] = await Promise.all([
      this.repo.countPendingSwapsForUser(actor.sub),
      this.repo.countPendingDropsForUser(actor.sub),
    ]);
    return {
      pendingSwaps,
      pendingDrops,
      total: pendingSwaps + pendingDrops,
      limit: MAX_PENDING_PER_USER,
    };
  }

  async listSwapsForShift(actor: { sub: string; role: Role }, shiftId: string) {
    const shift = await this.shifts.findById(shiftId);
    if (!shift) throw new NotFoundException('Shift not found');
    await this.locations.assertCanReadLocation(actor, shift.locationId);
    return this.repo.listSwapsForShift(shiftId);
  }

  // ─── DROP REQUEST ────────────────────────────────────────────────────

  async createDrop(
    actor: { sub: string; role: Role },
    input: { shiftId: string; reason?: string },
    ctx: RequestContext,
  ) {
    const shift = await this.shifts.findById(input.shiftId);
    if (!shift) throw new NotFoundException('Shift not found');
    const myAssignment = await this.shifts.findAssignment(input.shiftId, actor.sub);
    if (!myAssignment) throw new ForbiddenException('You are not assigned to this shift');

    const expiresAt = new Date(
      shift.startsAt.getTime() - DROP_EXPIRY_HOURS_BEFORE_SHIFT * 3600 * 1000,
    );
    if (expiresAt <= new Date()) {
      throw new BadRequestException(
        `Cannot create drop: shift is within ${DROP_EXPIRY_HOURS_BEFORE_SHIFT}h`,
      );
    }
    await this.assertNotOverPendingCap(actor.sub);

    const created = await this.repo.createDrop({
      shiftId: input.shiftId,
      fromUserId: actor.sub,
      status: DropStatus.OPEN,
      expiresAt,
      reason: input.reason,
    });
    this.audit.log({
      action: AuditAction.DROP_REQUESTED,
      entityType: 'DropRequest',
      entityId: created.id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: created,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('drop.requested', {
      dropId: created.id,
      shiftId: shift.id,
      fromUserId: actor.sub,
      locationId: shift.locationId,
    });
    return created;
  }

  async claimDrop(id: string, actor: { sub: string; role: Role }, ctx: RequestContext) {
    const drop = await this.repo.findDropById(id);
    if (!drop) throw new NotFoundException('Drop not found');
    if (drop.status !== DropStatus.OPEN) {
      throw new ConflictException(`Drop is not open (status=${drop.status})`);
    }
    if (drop.expiresAt <= new Date()) {
      throw new ConflictException('Drop has expired');
    }
    if (drop.fromUserId === actor.sub) {
      throw new BadRequestException('You cannot claim your own drop');
    }

    const validation = await this.validator.validateAssignment(actor.sub, drop.shift);
    if (!validation.ok) {
      throw new BadRequestException({
        message: 'You do not satisfy the shift requirements',
        validation,
      });
    }

    const updated = await this.repo.claimOpenDrop(id, actor.sub);
    if (!updated) {
      throw new ConflictException('Drop is no longer available (already claimed or expired)');
    }
    this.audit.log({
      action: AuditAction.DROP_CLAIMED,
      entityType: 'DropRequest',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: updated,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('drop.claimed', {
      dropId: id,
      shiftId: drop.shiftId,
      fromUserId: drop.fromUserId,
      claimedById: actor.sub,
      locationId: drop.shift.locationId,
    });
    return updated;
  }

  async approveDrop(id: string, actor: { sub: string; role: Role }, ctx: RequestContext) {
    const drop = await this.repo.findDropById(id);
    if (!drop) throw new NotFoundException('Drop not found');
    await this.locations.assertCanManageLocation(actor, drop.shift.locationId);
    if (drop.status !== DropStatus.PENDING_MANAGER || !drop.claimedById) {
      throw new ConflictException('Drop is not awaiting manager approval');
    }

    const validation = await this.validator.validateAssignment(drop.claimedById, drop.shift);
    if (!validation.ok) {
      throw new BadRequestException({
        message: 'Claimer no longer satisfies the shift requirements',
        validation,
      });
    }

    const updated = await this.repo.updateDrop(id, {
      status: DropStatus.APPROVED,
      managerDecisionAt: new Date(),
      decidedById: actor.sub,
    });
    await this.shifts.deleteAssignment(drop.shiftId, drop.fromUserId);
    await this.shifts.createAssignment({
      shiftId: drop.shiftId,
      userId: drop.claimedById,
      assignedById: actor.sub,
    });

    this.audit.log({
      action: AuditAction.DROP_APPROVED,
      entityType: 'DropRequest',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: updated,
      meta: {
        shiftId: drop.shiftId,
        fromUserId: drop.fromUserId,
        claimedById: drop.claimedById,
      },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('drop.approved', {
      dropId: id,
      shiftId: drop.shiftId,
      fromUserId: drop.fromUserId,
      claimedById: drop.claimedById,
      locationId: drop.shift.locationId,
    });
    return updated;
  }

  async rejectDrop(
    id: string,
    actor: { sub: string; role: Role },
    reason: string | undefined,
    ctx: RequestContext,
  ) {
    const drop = await this.repo.findDropById(id);
    if (!drop) throw new NotFoundException('Drop not found');
    await this.locations.assertCanManageLocation(actor, drop.shift.locationId);
    if (drop.status !== DropStatus.PENDING_MANAGER) {
      throw new ConflictException('Drop is not awaiting manager approval');
    }
    // Reset back to OPEN to allow other claims, but revoke the claimer.
    const updated = await this.repo.updateDrop(id, {
      status: DropStatus.REJECTED_BY_MANAGER,
      managerDecisionAt: new Date(),
      decidedById: actor.sub,
      reason,
    });
    this.audit.log({
      action: AuditAction.DROP_REJECTED,
      entityType: 'DropRequest',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: updated,
      meta: { reason },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('drop.rejected', { dropId: id, shiftId: drop.shiftId, fromUserId: drop.fromUserId, claimedById: drop.claimedById ?? null, locationId: drop.shift.locationId });
    return updated;
  }

  async cancelDrop(id: string, actor: { sub: string; role: Role }, ctx: RequestContext) {
    const drop = await this.repo.findDropById(id);
    if (!drop) throw new NotFoundException('Drop not found');
    if (drop.fromUserId !== actor.sub) throw new ForbiddenException('Not your drop');
    if (drop.status !== DropStatus.OPEN && drop.status !== DropStatus.PENDING_MANAGER) {
      throw new ConflictException('Cannot cancel: drop is not pending');
    }
    const updated = await this.repo.updateDrop(id, { status: DropStatus.CANCELLED });
    this.audit.log({
      action: AuditAction.DROP_REJECTED, // closest existing audit code (no DROP_CANCELLED)
      entityType: 'DropRequest',
      entityId: id,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole,
      after: updated,
      meta: { cancelledByOwner: true },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    this.events.emit('drop.cancelled', { dropId: id, shiftId: drop.shiftId, fromUserId: drop.fromUserId, claimedById: drop.claimedById ?? null, locationId: drop.shift.locationId });
    return updated;
  }

  async listOpenDrops(actor: { sub: string; role: Role }, locationId?: string) {
    return this.repo.listOpenDrops({ locationId });
  }

  /** Sweep + flip expired OPEN drops to EXPIRED. Idempotent. */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweepExpired(): Promise<number> {
    const expired = await this.repo.sweepExpired();
    if (expired.length === 0) return 0;
    for (const drop of expired) {
      this.events.emit('drop.expired', {
        dropId: drop.id,
        shiftId: drop.shiftId,
        fromUserId: drop.fromUserId,
        locationId: drop.shift.locationId,
      });
    }
    this.audit.log({
      action: AuditAction.DROP_EXPIRED,
      entityType: 'DropRequest',
      meta: { sweptCount: expired.length, ids: expired.map((d) => d.id) },
    });
    return expired.length;
  }

  // ─── Event listener: auto-cancel pending swaps when a shift is edited ───

  @OnEvent('shift.edited.cancelPendingSwaps')
  async onShiftEdited(payload: { shiftId: string }) {
    // Capture the parties of pending requests BEFORE cancellation so we can
    // notify them (the bulk update only returns a count).
    const pendingSwaps = await this.repo.listPendingSwapsForShift(payload.shiftId);
    const pendingDrops = await this.repo.listPendingDropsForShift(payload.shiftId);

    const cancelled = await this.repo.bulkCancelPendingForShift(payload.shiftId);
    const cancelledDrops = await this.repo.bulkCancelPendingDropsForShift(payload.shiftId);
    if (cancelled > 0 || cancelledDrops > 0) {
      this.events.emit('swap.auto.cancelled', {
        shiftId: payload.shiftId,
        cancelledSwaps: cancelled,
        cancelledDrops,
        swaps: pendingSwaps.map((s) => ({
          id: s.id,
          fromUserId: s.fromUserId,
          toUserId: s.toUserId,
        })),
        drops: pendingDrops.map((d) => ({
          id: d.id,
          fromUserId: d.fromUserId,
          claimedById: d.claimedById,
        })),
      });
    }
  }
}
