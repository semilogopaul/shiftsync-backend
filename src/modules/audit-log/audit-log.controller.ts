import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Role } from '@prisma/client';
import { stringify } from 'csv-stringify';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AuditAction } from '@prisma/client';
import { AuditLogService } from './audit-log.service';
import { AuditLogQueryDto, AuditLogExportDto } from './dto/audit-log-query.dto';
import { paginationToPrismaArgs, buildPaginatedResult } from '../../common/dto/pagination.dto';

@ApiTags('audit-log')
@Controller({ path: 'audit-logs', version: '1' })
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AuditLogController {
  constructor(private readonly service: AuditLogService) {}

  @Get()
  @ApiOperation({ summary: 'List audit log entries (admin only)' })
  @ApiResponse({ status: 200, description: 'Paginated audit log entries' })
  async list(@Query() query: AuditLogQueryDto) {
    const { page, pageSize, ...rest } = query;
    const filter = {
      action: rest.action,
      entityType: rest.entityType,
      entityId: rest.entityId,
      actorId: rest.actorId,
      from: rest.from ? new Date(rest.from) : undefined,
      to: rest.to ? new Date(rest.to) : undefined,
    };
    const { items, total } = await this.service.list(filter, paginationToPrismaArgs({ page, pageSize }));
    return buildPaginatedResult(items, total, page, pageSize);
  }

  @Get('export')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Export audit log entries as CSV (admin only)' })
  async export(
    @Query() query: AuditLogExportDto,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const filter = {
      action: query.action,
      entityType: query.entityType,
      entityId: query.entityId,
      actorId: query.actorId,
      from: new Date(query.from),
      to: new Date(query.to),
    };
    const rows = await this.service.export(filter);

    // Self-audit the export
    this.service.log({
      action: AuditAction.AUDIT_EXPORTED,
      entityType: 'AuditLog',
      actorId: user.sub,
      actorRole: user.role,
      meta: { from: filter.from.toISOString(), to: filter.to.toISOString(), count: rows.length },
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${query.from}-${query.to}.csv"`);

    const csv = await new Promise<Buffer>((resolve, reject) => {
      stringify(
        rows.map((r) => ({
          id: r.id,
          createdAt: r.createdAt.toISOString(),
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId ?? '',
          actorId: r.actorId ?? '',
          actorRole: r.actorRole ?? '',
          ipAddress: r.ipAddress ?? '',
          userAgent: r.userAgent ?? '',
          before: r.before ? JSON.stringify(r.before) : '',
          after: r.after ? JSON.stringify(r.after) : '',
          meta: r.meta ? JSON.stringify(r.meta) : '',
        })),
        { header: true },
        (err, output) => {
          if (err) reject(err);
          else resolve(Buffer.from(output ?? ''));
        },
      );
    });

    return new StreamableFile(csv);
  }
}
