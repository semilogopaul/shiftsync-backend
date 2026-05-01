import { Global, Module } from '@nestjs/common';
import { AuditLogController } from './audit-log.controller';
import { AuditLogService } from './audit-log.service';
import { AuditLogRepository } from './audit-log.repository';

/**
 * Audit logging is a cross-cutting concern: every feature service that
 * performs writes injects AuditLogService. The module is @Global so we
 * don't need to re-import it in every feature module.
 */
@Global()
@Module({
  controllers: [AuditLogController],
  providers: [AuditLogService, AuditLogRepository],
  exports: [AuditLogService],
})
export class AuditLogModule {}
