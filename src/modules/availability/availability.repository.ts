import { Injectable } from '@nestjs/common';
import {
  Availability,
  AvailabilityException,
  AvailabilityExceptionType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AvailabilityRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ─── Recurring weekly windows ────────────────────────────────────────

  async findById(id: string): Promise<Availability | null> {
    return this.prisma.availability.findUnique({ where: { id } });
  }

  async listForUser(userId: string): Promise<Availability[]> {
    return this.prisma.availability.findMany({
      where: { userId },
      orderBy: [{ dayOfWeek: 'asc' }, { startMinute: 'asc' }],
    });
  }

  /**
   * Returns all recurring availability records for a user that overlap
   * an effective range. Used by validators when checking shifts.
   */
  async listEffectiveForUser(userId: string, when: Date): Promise<Availability[]> {
    return this.prisma.availability.findMany({
      where: {
        userId,
        AND: [
          { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: when } }] },
          { OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: when } }] },
        ],
      },
    });
  }

  async createOne(data: Prisma.AvailabilityUncheckedCreateInput): Promise<Availability> {
    return this.prisma.availability.create({ data });
  }

  async updateById(id: string, data: Prisma.AvailabilityUpdateInput): Promise<Availability> {
    return this.prisma.availability.update({ where: { id }, data });
  }

  async deleteById(id: string): Promise<void> {
    await this.prisma.availability.delete({ where: { id } });
  }

  // ─── Exceptions (one-off) ────────────────────────────────────────────

  async findExceptionById(id: string): Promise<AvailabilityException | null> {
    return this.prisma.availabilityException.findUnique({ where: { id } });
  }

  async listExceptionsForUser(
    userId: string,
    range?: { from?: Date; to?: Date },
  ): Promise<AvailabilityException[]> {
    return this.prisma.availabilityException.findMany({
      where: {
        userId,
        ...(range?.from ? { endsAt: { gte: range.from } } : {}),
        ...(range?.to ? { startsAt: { lte: range.to } } : {}),
      },
      orderBy: { startsAt: 'asc' },
    });
  }

  async createException(data: {
    userId: string;
    type: AvailabilityExceptionType;
    startsAt: Date;
    endsAt: Date;
    note?: string;
  }): Promise<AvailabilityException> {
    return this.prisma.availabilityException.create({ data });
  }

  async updateException(
    id: string,
    data: Prisma.AvailabilityExceptionUpdateInput,
  ): Promise<AvailabilityException> {
    return this.prisma.availabilityException.update({ where: { id }, data });
  }

  async deleteException(id: string): Promise<void> {
    await this.prisma.availabilityException.delete({ where: { id } });
  }
}
