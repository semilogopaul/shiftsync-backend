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
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ok } from '../../common/types/api-response.type';
import { AvailabilityService } from './availability.service';
import {
  CreateAvailabilityDto,
  CreateAvailabilityExceptionDto,
  ListExceptionsQueryDto,
  UpdateAvailabilityDto,
  UpdateAvailabilityExceptionDto,
} from './dto/availability.dto';

function readContext(user: AuthenticatedUser, req: Request) {
  return {
    actorId: user.sub,
    actorRole: user.role,
    ipAddress: (req.ip ?? req.socket?.remoteAddress) || undefined,
    userAgent: req.header('user-agent') ?? undefined,
  };
}

@ApiTags('availability')
@Controller({ path: 'availability', version: '1' })
export class AvailabilityController {
  constructor(private readonly service: AvailabilityService) {}

  // ─── Recurring ──────────────────────────────────────────────────────

  @Get('user/:userId')
  @ApiOperation({ summary: 'List a user’s recurring availability' })
  async listForUser(
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(await this.service.listForUser(user, userId));
  }

  @Post('user/:userId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a recurring availability window for a user' })
  async create(
    @Param('userId') userId: string,
    @Body() dto: CreateAvailabilityDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(
      await this.service.create(
        userId,
        {
          dayOfWeek: dto.dayOfWeek,
          startMinute: dto.startMinute,
          endMinute: dto.endMinute,
          timezone: dto.timezone,
          effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : undefined,
          effectiveUntil: dto.effectiveUntil ? new Date(dto.effectiveUntil) : undefined,
        },
        user,
        readContext(user, req),
      ),
    );
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update a recurring availability window' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateAvailabilityDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(
      await this.service.update(
        id,
        {
          dayOfWeek: dto.dayOfWeek,
          startMinute: dto.startMinute,
          endMinute: dto.endMinute,
          timezone: dto.timezone,
          effectiveFrom: dto.effectiveFrom === undefined ? undefined : new Date(dto.effectiveFrom),
          effectiveUntil: dto.effectiveUntil === undefined ? undefined : new Date(dto.effectiveUntil),
        },
        user,
        readContext(user, req),
      ),
    );
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a recurring availability window' })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.service.remove(id, user, readContext(user, req));
  }

  // ─── Exceptions ─────────────────────────────────────────────────────

  @Get('user/:userId/exceptions')
  @ApiOperation({ summary: 'List a user’s availability exceptions in a date range' })
  async listExceptions(
    @Param('userId') userId: string,
    @Query() query: ListExceptionsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(
      await this.service.listExceptionsForUser(user, userId, {
        from: query.from ? new Date(query.from) : undefined,
        to: query.to ? new Date(query.to) : undefined,
      }),
    );
  }

  @Post('user/:userId/exceptions')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a one-off availability exception' })
  async createException(
    @Param('userId') userId: string,
    @Body() dto: CreateAvailabilityExceptionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(
      await this.service.createException(
        userId,
        {
          type: dto.type,
          startsAt: new Date(dto.startsAt),
          endsAt: new Date(dto.endsAt),
          note: dto.note,
        },
        user,
        readContext(user, req),
      ),
    );
  }

  @Patch('exceptions/:id')
  @ApiOperation({ summary: 'Update an availability exception' })
  async updateException(
    @Param('id') id: string,
    @Body() dto: UpdateAvailabilityExceptionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(
      await this.service.updateException(
        id,
        {
          type: dto.type,
          startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
          endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
          note: dto.note,
        },
        user,
        readContext(user, req),
      ),
    );
  }

  @Delete('exceptions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an availability exception' })
  async removeException(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.service.removeException(id, user, readContext(user, req));
  }
}
