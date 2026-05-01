import { Injectable } from '@nestjs/common';
import { ClockEvent, ClockEventType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class ClockRepository {
  constructor(private readonly prisma: PrismaService) {}

  create(data: { shiftId: string; userId: string; type: ClockEventType; occurredAt?: Date }): Promise<ClockEvent> {
    return this.prisma.clockEvent.create({
      data: {
        shiftId: data.shiftId,
        userId: data.userId,
        type: data.type,
        ...(data.occurredAt ? { occurredAt: data.occurredAt } : {}),
      },
    });
  }

  /** Latest clock event for a (shift, user) pair. */
  findLatestForAssignment(shiftId: string, userId: string): Promise<ClockEvent | null> {
    return this.prisma.clockEvent.findFirst({
      where: { shiftId, userId },
      orderBy: { occurredAt: 'desc' },
    });
  }

  /**
   * "On duty" = users whose latest clock event for a given shift is CLOCK_IN.
   * For a location (or set of locations), returns one row per (shift, user) currently clocked in.
   * If `locationIds` is undefined, queries across all locations (admin scope).
   */
  async listOnDutyForLocation(locationIds: readonly string[] | undefined): Promise<
    Array<{
      clockEventId: string;
      shiftId: string;
      userId: string;
      occurredAt: Date;
      shift: {
        id: string;
        startsAt: Date;
        endsAt: Date;
        locationId: string;
        location: { id: string; name: string; timezone: string };
      };
      user: { id: string; firstName: string; lastName: string; email: string };
    }>
  > {
    // Pull clock events for shifts in this location in the recent window (last 24h),
    // grouped by (shiftId, userId), keeping only the latest one — emit only those whose latest is CLOCK_IN.
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const events = await this.prisma.clockEvent.findMany({
      where: {
        occurredAt: { gte: since },
        ...(locationIds && locationIds.length > 0
          ? { shift: { locationId: { in: [...locationIds] } } }
          : {}),
      },
      orderBy: { occurredAt: 'desc' },
      include: {
        shift: {
          select: {
            id: true,
            startsAt: true,
            endsAt: true,
            locationId: true,
            location: { select: { id: true, name: true, timezone: true } },
          },
        },
        user: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });

    const seen = new Set<string>();
    const onDuty: typeof events = [];
    for (const ev of events) {
      const key = `${ev.shiftId}::${ev.userId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (ev.type === ClockEventType.CLOCK_IN) onDuty.push(ev);
    }
    return onDuty.map((e) => ({
      clockEventId: e.id,
      shiftId: e.shiftId,
      userId: e.userId,
      occurredAt: e.occurredAt,
      shift: e.shift,
      user: e.user,
    }));
  }

  /** Sum of worked minutes (paired CLOCK_IN→CLOCK_OUT) for a user in a date range. */
  async listEventsForUserInRange(userId: string, start: Date, end: Date): Promise<ClockEvent[]> {
    return this.prisma.clockEvent.findMany({
      where: { userId, occurredAt: { gte: start, lt: end } },
      orderBy: { occurredAt: 'asc' },
    });
  }

  // Used by audit-style queries
  countByShift(shiftId: string, type: ClockEventType): Promise<number> {
    return this.prisma.clockEvent.count({ where: { shiftId, type } });
  }

  // Re-export Prisma for typing convenience downstream
  static readonly _prismaTypeRefs: typeof Prisma | null = null;
}
