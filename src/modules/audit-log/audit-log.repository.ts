import { Injectable } from '@nestjs/common';
import { AuditAction, AuditLog, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuditLogEntry } from './types/audit-log.types';

export interface ListFilter {
  readonly action?: AuditAction;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly actorId?: string;
  readonly from?: Date;
  readonly to?: Date;
}

/**
 * Sole gateway to the AuditLog table. No other module may issue queries
 * against this table directly.
 */
@Injectable()
export class AuditLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createOne(entry: AuditLogEntry): Promise<AuditLog> {
    return this.prisma.auditLog.create({
      data: {
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId ?? null,
        actorId: entry.actorId ?? null,
        actorRole: entry.actorRole ?? null,
        before: (entry.before as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        after: (entry.after as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        meta: (entry.meta as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent ?? null,
      },
    });
  }

  async findManyPaginated(
    filter: ListFilter,
    pagination: { skip: number; take: number },
  ): Promise<{ items: AuditLog[]; total: number }> {
    const where = this.buildWhere(filter);
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
        include: { actor: { select: { id: true, email: true, firstName: true, lastName: true } } },
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items, total };
  }

  async streamForExport(filter: ListFilter): Promise<AuditLog[]> {
    return this.prisma.auditLog.findMany({
      where: this.buildWhere(filter),
      orderBy: { createdAt: 'asc' },
    });
  }

  private buildWhere(filter: ListFilter): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {};
    if (filter.action) where.action = filter.action;
    if (filter.entityType) where.entityType = filter.entityType;
    if (filter.entityId) where.entityId = filter.entityId;
    if (filter.actorId) where.actorId = filter.actorId;
    if (filter.from || filter.to) {
      where.createdAt = {};
      if (filter.from) where.createdAt.gte = filter.from;
      if (filter.to) where.createdAt.lte = filter.to;
    }
    return where;
  }
}
