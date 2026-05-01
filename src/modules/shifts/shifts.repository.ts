import { Injectable } from '@nestjs/common';
import {
  Location,
  Prisma,
  Shift,
  ShiftAssignment,
  ShiftStatus,
  Skill,
  User,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export type ShiftWithAssignments = Shift & {
  assignments: (ShiftAssignment & { user: User })[];
  skill: Skill;
  location: Location;
};

export interface ListShiftsFilter {
  locationId?: string;
  startsAfter?: Date;
  startsBefore?: Date;
  status?: ShiftStatus;
  userId?: string; // shifts the user is assigned to
  isPremium?: boolean;
  skip?: number;
  take?: number;
}

@Injectable()
export class ShiftsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<ShiftWithAssignments | null> {
    return this.prisma.shift.findFirst({
      where: { id, deletedAt: null },
      include: {
        assignments: { include: { user: true } },
        skill: true,
        location: true,
      },
    });
  }

  /** Includes soft-deleted, used for audit lookups. */
  async findByIdIncludingDeleted(id: string): Promise<Shift | null> {
    return this.prisma.shift.findUnique({ where: { id } });
  }

  async list(filter: ListShiftsFilter): Promise<{ items: ShiftWithAssignments[]; total: number }> {
    const where: Prisma.ShiftWhereInput = {
      deletedAt: null,
      ...(filter.locationId ? { locationId: filter.locationId } : {}),
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.startsAfter ? { startsAt: { gte: filter.startsAfter } } : {}),
      ...(filter.startsBefore
        ? { startsAt: { ...(filter.startsAfter ? { gte: filter.startsAfter } : {}), lte: filter.startsBefore } }
        : {}),
      ...(filter.userId ? { assignments: { some: { userId: filter.userId } } } : {}),
      ...(typeof filter.isPremium === 'boolean' ? { isPremium: filter.isPremium } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.shift.findMany({
        where,
        include: { assignments: { include: { user: true } }, skill: true, location: true },
        orderBy: { startsAt: 'asc' },
        skip: filter.skip,
        take: filter.take,
      }),
      this.prisma.shift.count({ where }),
    ]);
    return { items, total };
  }

  async create(data: Prisma.ShiftUncheckedCreateInput): Promise<ShiftWithAssignments> {
    const created = await this.prisma.shift.create({
      data,
      include: { assignments: { include: { user: true } }, skill: true, location: true },
    });
    return created;
  }

  /**
   * Optimistic-concurrency update: matches the row only when `version`
   * equals the caller's expected value, and bumps it. If no row matches,
   * `count` will be 0 and the caller can retry/reject with 409.
   */
  async updateWithVersion(
    id: string,
    expectedVersion: number,
    data: Prisma.ShiftUncheckedUpdateInput,
  ): Promise<{ updated: boolean }> {
    const result = await this.prisma.shift.updateMany({
      where: { id, version: expectedVersion, deletedAt: null },
      data: { ...data, version: { increment: 1 } },
    });
    return { updated: result.count > 0 };
  }

  async softDelete(id: string): Promise<void> {
    await this.prisma.shift.update({
      where: { id },
      data: { deletedAt: new Date(), status: ShiftStatus.CANCELLED },
    });
  }

  // ─── Assignments ─────────────────────────────────────────────────────

  async listAssignmentsForUserInRange(
    userId: string,
    rangeStart: Date,
    rangeEnd: Date,
    excludeShiftId?: string,
  ): Promise<(ShiftAssignment & { shift: Shift })[]> {
    return this.prisma.shiftAssignment.findMany({
      where: {
        userId,
        ...(excludeShiftId ? { shiftId: { not: excludeShiftId } } : {}),
        shift: {
          deletedAt: null,
          status: { not: ShiftStatus.CANCELLED },
          startsAt: { lt: rangeEnd },
          endsAt: { gt: rangeStart },
        },
      },
      include: { shift: true },
      orderBy: { shift: { startsAt: 'asc' } },
    });
  }

  async listAssignmentsForUserOnDate(
    userId: string,
    dayStartUtc: Date,
    dayEndUtc: Date,
  ): Promise<(ShiftAssignment & { shift: Shift })[]> {
    return this.listAssignmentsForUserInRange(userId, dayStartUtc, dayEndUtc);
  }

  async findAssignment(shiftId: string, userId: string): Promise<ShiftAssignment | null> {
    return this.prisma.shiftAssignment.findUnique({
      where: { shiftId_userId: { shiftId, userId } },
    });
  }

  async createAssignment(data: {
    shiftId: string;
    userId: string;
    assignedById: string;
    overrideUsed?: boolean;
    overrideReason?: string;
  }): Promise<ShiftAssignment> {
    return this.prisma.shiftAssignment.create({ data });
  }

  /**
   * Atomic guard against the "two managers assign the same seat" race.
   *
   * Wraps the count + create in a single serializable transaction so two
   * concurrent assigns for the same `shiftId` cannot both succeed when the
   * shift is at its headcount cap. Postgres will fail one transaction with
   * a serialization error (P2034) which the service maps to a 409.
   *
   * Also relies on the existing `(shiftId, userId)` unique index to prevent
   * the "same user assigned twice" race at the DB level (P2002).
   */
  async createAssignmentAtomic(data: {
    shiftId: string;
    userId: string;
    headcount: number;
    assignedById: string;
    overrideUsed?: boolean;
    overrideReason?: string;
  }): Promise<{ assignment: ShiftAssignment; conflict: false } | { conflict: true }> {
    return this.prisma.$transaction(
      async (tx) => {
        const taken = await tx.shiftAssignment.count({ where: { shiftId: data.shiftId } });
        if (taken >= data.headcount) {
          return { conflict: true } as const;
        }
        const assignment = await tx.shiftAssignment.create({
          data: {
            shiftId: data.shiftId,
            userId: data.userId,
            assignedById: data.assignedById,
            overrideUsed: data.overrideUsed ?? false,
            overrideReason: data.overrideReason,
          },
        });
        return { assignment, conflict: false } as const;
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async deleteAssignment(shiftId: string, userId: string): Promise<void> {
    await this.prisma.shiftAssignment.delete({
      where: { shiftId_userId: { shiftId, userId } },
    });
  }

  async countActiveAssignmentsForShift(shiftId: string): Promise<number> {
    return this.prisma.shiftAssignment.count({ where: { shiftId } });
  }
}
