import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { Role } from '@prisma/client';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ok } from '../../common/types/api-response.type';
import { CertificationsService } from './certifications.service';
import {
  CertificationsListQueryDto,
  GrantCertificationDto,
  UpdateCertificationDto,
} from './dto/certifications.dto';

function readContext(user: AuthenticatedUser, req: Request) {
  return {
    actorId: user.sub,
    actorRole: user.role,
    ipAddress: (req.ip ?? req.socket?.remoteAddress) || undefined,
    userAgent: req.header('user-agent') ?? undefined,
  };
}

@ApiTags('certifications')
@Controller({ path: 'certifications', version: '1' })
export class CertificationsController {
  constructor(private readonly service: CertificationsService) {}

  @Get('user/:userId')
  @ApiOperation({ summary: 'List certifications for a user (self / admin / manager-of-location)' })
  async listForUser(
    @Param('userId') userId: string,
    @Query() query: CertificationsListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(await this.service.listForUser(user, userId, query.includeHistory ?? false));
  }

  @Get('location/:locationId')
  @ApiOperation({ summary: 'List certifications at a location (admin / manager-of-location)' })
  async listForLocation(
    @Param('locationId') locationId: string,
    @Query() query: CertificationsListQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(await this.service.listForLocation(user, locationId, query.includeHistory ?? false));
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Grant a certification (admin / manager-of-location)' })
  async grant(
    @Body() dto: GrantCertificationDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(
      await this.service.grant(
        {
          userId: dto.userId,
          locationId: dto.locationId,
          skillIds: dto.skillIds,
          expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
          notes: dto.notes,
        },
        user,
        readContext(user, req),
      ),
    );
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @Patch(':id')
  @ApiOperation({ summary: 'Update a certification (skills/expiry/notes)' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateCertificationDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(
      await this.service.update(
        id,
        {
          skillIds: dto.skillIds,
          expiresAt: dto.expiresAt === undefined ? undefined : dto.expiresAt === null ? null : new Date(dto.expiresAt),
          notes: dto.notes ?? undefined,
        },
        user,
        readContext(user, req),
      ),
    );
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @Delete(':id')
  @ApiOperation({ summary: 'Revoke (de-certify) — preserves history' })
  async revoke(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.revoke(id, user, readContext(user, req)));
  }
}
