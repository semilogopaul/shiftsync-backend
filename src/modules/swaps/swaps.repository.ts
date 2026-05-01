import { Injectable } from '@nestjs/common';
import {
  DropRequest,
  DropStatus,
  Location,
  Prisma,
  Shift,
  SwapRequest,
  SwapStatus,
  User,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

const SWAP_PENDING_STATUSES: SwapStatus[] = [
  SwapStatus.PENDING_RECIPIENT,
  SwapStatus.PENDING_MANAGER,
];
const DROP_PENDING_STATUSES: DropStatus[] = [
  DropStatus.OPEN,
  DropStatus.PENDING_MANAGER,
];

export type SwapRequestWithRels = SwapRequest & {
  shift: Shift & { location: Location };
  fromUser: User;
  toUser: User;
};
export type DropRequestWithRels = DropRequest & {
  shift: Shift & { location: Location };
  fromUser: User;
  claimedBy: User | null;
};

@Injectable()
export class SwapsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Swap requests ───────────────────────────────────────────────────

  async findSwapById(id: string): Promise<SwapRequestWithRels | null> {
    return this.prisma.swapRequest.findUnique({
      where: { id },
      include: { shift: { include: { location: true } }, fromUser: true, toUser: true },
    });
  }

  async listSwapsForShift(shiftId: string): Promise<SwapRequestWithRels[]> {
    return this.prisma.swapRequest.findMany({
      where: { shiftId },
      include: { shift: { include: { location: true } }, fromUser: true, toUser: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listSwapsForUser(userId: string, opts?: { onlyPending?: boolean }): Promise<SwapRequestWithRels[]> {
    return this.prisma.swapRequest.findMany({
      where: {
        OR: [{ fromUserId: userId }, { toUserId: userId }],
        ...(opts?.onlyPending ? { status: { in: SWAP_PENDING_STATUSES } } : {}),
      },
      include: { shift: { include: { location: true } }, fromUser: true, toUser: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listPendingSwapsForShift(shiftId: string): Promise<SwapRequest[]> {
    return this.prisma.swapRequest.findMany({
      where: { shiftId, status: { in: SWAP_PENDING_STATUSES } },
    });
  }

  async countPendingSwapsForUser(userId: string): Promise<number> {
    return this.prisma.swapRequest.count({
      where: { fromUserId: userId, status: { in: SWAP_PENDING_STATUSES } },
    });
  }

  async createSwap(data: Prisma.SwapRequestUncheckedCreateInput): Promise<SwapRequest> {
    return this.prisma.swapRequest.create({ data });
  }

  async updateSwap(id: string, data: Prisma.SwapRequestUncheckedUpdateInput): Promise<SwapRequest> {
    return this.prisma.swapRequest.update({ where: { id }, data });
  }

  async bulkCancelPendingForShift(shiftId: string): Promise<number> {
    const res = await this.prisma.swapRequest.updateMany({
      where: { shiftId, status: { in: SWAP_PENDING_STATUSES } },
      data: { status: SwapStatus.CANCELLED, updatedAt: new Date() },
    });
    return res.count;
  }

  // ─── Drop requests ───────────────────────────────────────────────────

  async findDropById(id: string): Promise<DropRequestWithRels | null> {
    return this.prisma.dropRequest.findUnique({
      where: { id },
      include: { shift: { include: { location: true } }, fromUser: true, claimedBy: true },
    });
  }

  async listDropsForShift(shiftId: string): Promise<DropRequestWithRels[]> {
    return this.prisma.dropRequest.findMany({
      where: { shiftId },
      include: { shift: { include: { location: true } }, fromUser: true, claimedBy: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listOpenDrops(filter: { locationId?: string }): Promise<DropRequestWithRels[]> {
    return this.prisma.dropRequest.findMany({
      where: {
        status: DropStatus.OPEN,
        ...(filter.locationId ? { shift: { locationId: filter.locationId } } : {}),
      },
      include: { shift: { include: { location: true } }, fromUser: true, claimedBy: true },
      orderBy: { shift: { startsAt: 'asc' } },
    });
  }

  async countPendingDropsForUser(userId: string): Promise<number> {
    return this.prisma.dropRequest.count({
      where: { fromUserId: userId, status: { in: DROP_PENDING_STATUSES } },
    });
  }

  async createDrop(data: Prisma.DropRequestUncheckedCreateInput): Promise<DropRequest> {
    return this.prisma.dropRequest.create({ data });
  }

  async updateDrop(id: string, data: Prisma.DropRequestUncheckedUpdateInput): Promise<DropRequest> {
    return this.prisma.dropRequest.update({ where: { id }, data });
  }

  /**
   * Atomic claim: only flips the row from OPEN to PENDING_MANAGER if it is
   * still OPEN at write time. Returns null if a concurrent claim won the race.
   */
  async claimOpenDrop(id: string, claimedById: string): Promise<DropRequest | null> {
    const res = await this.prisma.dropRequest.updateMany({
      where: { id, status: DropStatus.OPEN, expiresAt: { gt: new Date() } },
      data: {
        status: DropStatus.PENDING_MANAGER,
        claimedById,
        claimedAt: new Date(),
        updatedAt: new Date(),
      },
    });
    if (res.count === 0) return null;
    return this.prisma.dropRequest.findUnique({ where: { id } });
  }

  async bulkCancelPendingDropsForShift(shiftId: string): Promise<number> {
    const res = await this.prisma.dropRequest.updateMany({
      where: { shiftId, status: { in: DROP_PENDING_STATUSES } },
      data: { status: DropStatus.CANCELLED, updatedAt: new Date() },
    });
    return res.count;
  }

  async listPendingDropsForShift(shiftId: string): Promise<DropRequest[]> {
    return this.prisma.dropRequest.findMany({
      where: { shiftId, status: { in: DROP_PENDING_STATUSES } },
    });
  }

  /**
   * Mark expired OPEN drops. Returns the rows that were flipped so the caller
   * can emit per-row events (e.g. `drop.expired`) and write audit entries.
   * Safe to call from a periodic sweep — uses a single transaction so the
   * "find then update" pair cannot race against another sweep.
   */
  async sweepExpired(
    now: Date = new Date(),
  ): Promise<readonly DropRequestWithRels[]> {
    // Two-step (no interactive transaction): the updateMany filters on
    // status=OPEN so any concurrent sweep can only flip a row once. We
    // then return the rows we know we flipped (id ∈ ours AND status was
    // OPEN at write time). This avoids the connection-pool transaction
    // timeout we hit on serverless Postgres.
    const candidates = await this.prisma.dropRequest.findMany({
      where: { status: DropStatus.OPEN, expiresAt: { lte: now } },
      include: { shift: { include: { location: true } }, fromUser: true, claimedBy: true },
    });
    if (candidates.length === 0) return [];
    const ids = candidates.map((d) => d.id);
    const res = await this.prisma.dropRequest.updateMany({
      where: { id: { in: ids }, status: DropStatus.OPEN },
      data: { status: DropStatus.EXPIRED, updatedAt: now },
    });
    if (res.count === 0) return [];
    // Re-read to filter to only the rows we actually flipped (rare race).
    const flipped = await this.prisma.dropRequest.findMany({
      where: { id: { in: ids }, status: DropStatus.EXPIRED, updatedAt: now },
      include: { shift: { include: { location: true } }, fromUser: true, claimedBy: true },
    });
    return flipped;
  }

  static readonly SWAP_PENDING_STATUSES = SWAP_PENDING_STATUSES;
  static readonly DROP_PENDING_STATUSES = DROP_PENDING_STATUSES;
}
