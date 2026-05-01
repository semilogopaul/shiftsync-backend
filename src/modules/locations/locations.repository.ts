import { Injectable } from '@nestjs/common';
import { Location, LocationManager, Prisma, User } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class LocationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Location | null> {
    return this.prisma.location.findFirst({ where: { id, deletedAt: null } });
  }

  async findByName(name: string): Promise<Location | null> {
    return this.prisma.location.findFirst({ where: { name, deletedAt: null } });
  }

  async createOne(data: Prisma.LocationCreateInput): Promise<Location> {
    return this.prisma.location.create({ data });
  }

  async updateById(id: string, data: Prisma.LocationUpdateInput): Promise<Location> {
    return this.prisma.location.update({ where: { id }, data });
  }

  async softDeleteById(id: string): Promise<Location> {
    return this.prisma.location.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  /** Count of upcoming non-deleted shifts at this location. Used to block delete. */
  async countUpcomingShifts(id: string, now: Date = new Date()): Promise<number> {
    return this.prisma.shift.count({
      where: { locationId: id, deletedAt: null, startsAt: { gt: now } },
    });
  }

  async findManyPaginated(
    filter: { search?: string; isActive?: boolean; managedByUserId?: string },
    pagination: { skip: number; take: number },
  ): Promise<{ items: Location[]; total: number }> {
    const where: Prisma.LocationWhereInput = {
      deletedAt: null,
      ...(typeof filter.isActive === 'boolean' ? { isActive: filter.isActive } : {}),
      ...(filter.search
        ? {
            OR: [
              { name: { contains: filter.search, mode: 'insensitive' } },
              { address: { contains: filter.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(filter.managedByUserId
        ? { managers: { some: { userId: filter.managedByUserId } } }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.location.findMany({
        where,
        orderBy: { name: 'asc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.location.count({ where }),
    ]);
    return { items, total };
  }

  // ─── Manager assignments ──────────────────────────────────────────────

  async isManagerOf(userId: string, locationId: string): Promise<boolean> {
    const found = await this.prisma.locationManager.findUnique({
      where: { userId_locationId: { userId, locationId } },
      select: { id: true },
    });
    return found !== null;
  }

  /** Returns the set of location ids a user currently manages. */
  async listManagedLocationIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.locationManager.findMany({
      where: { userId, location: { deletedAt: null } },
      select: { locationId: true },
    });
    return rows.map((r) => r.locationId);
  }

  async listManagers(locationId: string): Promise<Array<LocationManager & { user: User }>> {
    return this.prisma.locationManager.findMany({
      where: { locationId },
      include: { user: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async assignManager(userId: string, locationId: string): Promise<LocationManager> {
    return this.prisma.locationManager.upsert({
      where: { userId_locationId: { userId, locationId } },
      create: { userId, locationId },
      update: {},
    });
  }

  async removeManager(userId: string, locationId: string): Promise<void> {
    await this.prisma.locationManager.deleteMany({
      where: { userId, locationId },
    });
  }
}
