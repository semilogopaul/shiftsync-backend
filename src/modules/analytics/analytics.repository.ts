import { Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface PerStaffStats {
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  desiredWeeklyHours: number | null;
  totalHours: number;
  premiumHours: number;
  shiftCount: number;
}

export interface OrderedAssignment {
  shiftId: string;
  startsAt: Date;
  endsAt: Date;
}

@Injectable()
export class AnalyticsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Aggregates assigned hours and premium hours for every active EMPLOYEE
   * who is currently certified at one of `locationIds` (or any active
   * EMPLOYEE if the array is undefined/empty), within the date range
   * [start, end). Soft-deleted / cancelled shifts are excluded.
   */
  async aggregatePerStaff(
    start: Date,
    end: Date,
    locationIds?: readonly string[],
    userIds?: string[],
  ): Promise<PerStaffStats[]> {
    const scopeLocations = locationIds && locationIds.length > 0 ? locationIds : undefined;
    const users = await this.prisma.user.findMany({
      where: {
        isActive: true,
        role: Role.EMPLOYEE,
        ...(userIds && userIds.length > 0 ? { id: { in: userIds } } : {}),
        ...(scopeLocations
          ? {
              certifications: {
                some: { locationId: { in: [...scopeLocations] }, decertifiedAt: null },
              },
            }
          : {}),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        desiredWeeklyHours: true,
      },
    });

    if (users.length === 0) return [];

    const assignments = await this.prisma.shiftAssignment.findMany({
      where: {
        userId: { in: users.map((u) => u.id) },
        shift: {
          deletedAt: null,
          status: { not: 'CANCELLED' },
          startsAt: { lt: end },
          endsAt: { gt: start },
          ...(scopeLocations ? { locationId: { in: [...scopeLocations] } } : {}),
        },
      },
      include: {
        shift: { select: { startsAt: true, endsAt: true, isPremium: true } },
      },
    });
    const acc = new Map<string, { total: number; premium: number; count: number }>();
    for (const u of users) acc.set(u.id, { total: 0, premium: 0, count: 0 });

    for (const a of assignments) {
      const overlapStart = a.shift.startsAt < start ? start : a.shift.startsAt;
      const overlapEnd = a.shift.endsAt > end ? end : a.shift.endsAt;
      const hours = Math.max(0, (overlapEnd.getTime() - overlapStart.getTime()) / 3_600_000);
      const slot = acc.get(a.userId);
      if (!slot) continue;
      slot.total += hours;
      if (a.shift.isPremium) slot.premium += hours;
      slot.count += 1;
    }

    return users.map((u) => {
      const s = acc.get(u.id) ?? { total: 0, premium: 0, count: 0 };
      return {
        userId: u.id,
        firstName: u.firstName,
        lastName: u.lastName,
        email: u.email,
        desiredWeeklyHours: u.desiredWeeklyHours,
        totalHours: round2(s.total),
        premiumHours: round2(s.premium),
        shiftCount: s.count,
      };
    });
  }

  /** Ordered (chronological) assignments for one user in a window. */
  async listUserAssignmentsInRange(
    userId: string,
    start: Date,
    end: Date,
    locationIds?: readonly string[],
  ): Promise<OrderedAssignment[]> {
    const scopeLocations = locationIds && locationIds.length > 0 ? locationIds : undefined;
    const list = await this.prisma.shiftAssignment.findMany({
      where: {
        userId,
        shift: {
          deletedAt: null,
          status: { not: 'CANCELLED' },
          startsAt: { lt: end },
          endsAt: { gt: start },
          ...(scopeLocations ? { locationId: { in: [...scopeLocations] } } : {}),
        },
      },
      include: { shift: { select: { id: true, startsAt: true, endsAt: true } } },
      orderBy: { shift: { startsAt: 'asc' } },
    });
    return list.map((a) => ({
      shiftId: a.shift.id,
      startsAt: a.shift.startsAt,
      endsAt: a.shift.endsAt,
    }));
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
