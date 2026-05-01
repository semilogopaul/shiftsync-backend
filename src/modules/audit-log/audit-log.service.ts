import { Injectable, Logger } from '@nestjs/common';
import { AuditLog } from '@prisma/client';
import { AuditLogRepository, ListFilter } from './audit-log.repository';
import { AuditLogEntry } from './types/audit-log.types';

/**
 * The single API for writing audit-log entries. Other services inject this
 * and call .log(entry). Writes are best-effort and never block or fail the
 * originating request.
 *
 * Reads are restricted: only AuditLogController (admin-only) calls them.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly repo: AuditLogRepository) {}

  /**
   * Append-only write. Fire-and-forget by design — if the audit insert fails
   * it is logged at error level but never propagates to the caller.
   */
  log(entry: AuditLogEntry): void {
    void this.repo.createOne(entry).catch((err: unknown) => {
      this.logger.error(
        `audit write failed action=${entry.action} entity=${entry.entityType} id=${entry.entityId ?? 'null'} err=${
          (err as Error).message
        }`,
      );
    });
  }

  // ── Admin reads ──

  async list(
    filter: ListFilter,
    pagination: { skip: number; take: number },
  ): Promise<{ items: AuditLog[]; total: number }> {
    return this.repo.findManyPaginated(filter, pagination);
  }

  async export(filter: ListFilter): Promise<AuditLog[]> {
    return this.repo.streamForExport(filter);
  }
}
