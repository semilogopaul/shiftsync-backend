import { AuditAction, Role } from '@prisma/client';

/**
 * Internal-only payload for writing an audit entry. Constructed by the
 * originating service and passed as the single argument to AuditLogService.log().
 */
export interface AuditLogEntry {
  readonly action: AuditAction;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly actorId?: string | null;
  readonly actorRole?: Role | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly meta?: Record<string, unknown>;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}
