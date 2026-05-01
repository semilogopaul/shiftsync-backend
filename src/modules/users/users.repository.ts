import { Injectable } from '@nestjs/common';
import { Prisma, Role, User } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { id, deletedAt: null } });
  }

  async findByIdIncludingDeleted(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findFirst({ where: { email: email.toLowerCase(), deletedAt: null } });
  }

  async findByEmailAnyState(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  }

  async existsByEmail(email: string): Promise<boolean> {
    const found = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true },
    });
    return found !== null;
  }

  async createOne(data: Prisma.UserCreateInput): Promise<User> {
    return this.prisma.user.create({ data: { ...data, email: data.email.toLowerCase() } });
  }

  async updateById(id: string, data: Prisma.UserUpdateInput): Promise<User> {
    return this.prisma.user.update({ where: { id }, data });
  }

  async softDeleteById(id: string): Promise<User> {
    return this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  /** Count of upcoming shift assignments for this user. Used to block delete. */
  async countUpcomingAssignments(id: string, now: Date = new Date()): Promise<number> {
    return this.prisma.shiftAssignment.count({
      where: { userId: id, shift: { deletedAt: null, startsAt: { gt: now } } },
    });
  }

  async findManyPaginated(
    filter: { role?: Role; search?: string; isActive?: boolean },
    pagination: { skip: number; take: number },
  ): Promise<{ items: User[]; total: number }> {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(filter.role ? { role: filter.role } : {}),
      ...(typeof filter.isActive === 'boolean' ? { isActive: filter.isActive } : {}),
      ...(filter.search
        ? {
            OR: [
              { email: { contains: filter.search, mode: 'insensitive' } },
              { firstName: { contains: filter.search, mode: 'insensitive' } },
              { lastName: { contains: filter.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.user.count({ where }),
    ]);
    return { items, total };
  }

  /**
   * Light-weight directory: returns up to `take` users matching the filter,
   * scoped to those certified at `locationId` if provided. Excludes
   * deleted/inactive users. Returns minimal columns only.
   */
  async findDirectory(filter: {
    role?: Role;
    locationId?: string;
    search?: string;
    take: number;
  }): Promise<Array<Pick<User, 'id' | 'firstName' | 'lastName' | 'email' | 'role'>>> {
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      isActive: true,
      ...(filter.role ? { role: filter.role } : {}),
      ...(filter.locationId
        ? {
            certifications: {
              some: { locationId: filter.locationId, decertifiedAt: null },
            },
          }
        : {}),
      ...(filter.search
        ? {
            OR: [
              { email: { contains: filter.search, mode: 'insensitive' } },
              { firstName: { contains: filter.search, mode: 'insensitive' } },
              { lastName: { contains: filter.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    return this.prisma.user.findMany({
      where,
      orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      take: filter.take,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        role: true,
      },
    });
  }
}
