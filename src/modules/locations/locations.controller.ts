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
import {
  buildPaginatedResult,
  paginationToPrismaArgs,
} from '../../common/dto/pagination.dto';
import { LocationsService } from './locations.service';
import {
  AssignManagerDto,
  CreateLocationDto,
  ListLocationsQueryDto,
  UpdateLocationDto,
} from './dto/locations.dto';

function readContext(user: AuthenticatedUser, req: Request) {
  return {
    actorId: user.sub,
    actorRole: user.role,
    ipAddress: (req.ip ?? req.socket?.remoteAddress) || undefined,
    userAgent: req.header('user-agent') ?? undefined,
  };
}

@ApiTags('locations')
@Controller({ path: 'locations', version: '1' })
@UseGuards(RolesGuard)
@Roles(Role.ADMIN, Role.MANAGER, Role.EMPLOYEE)
export class LocationsController {
  constructor(private readonly service: LocationsService) {}

  @Get()
  @Roles(Role.ADMIN, Role.MANAGER, Role.EMPLOYEE)
  @ApiOperation({
    summary: 'List locations (admins: all; managers: theirs; staff: certified)',
  })
  async list(
    @Query() query: ListLocationsQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { page, pageSize, search, isActive } = query;
    const { items, total } = await this.service.list(
      user,
      { search, isActive },
      paginationToPrismaArgs({ page, pageSize }),
    );
    return buildPaginatedResult(items, total, page, pageSize);
  }

  @Get(':id')
  @Roles(Role.ADMIN, Role.MANAGER, Role.EMPLOYEE)
  @ApiOperation({ summary: 'Get a single location' })
  async getById(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(await this.service.getById(user, id));
  }

  @Roles(Role.ADMIN)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '[Admin] Create a location' })
  async create(
    @Body() dto: CreateLocationDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.create(dto, readContext(user, req)));
  }

  @Roles(Role.ADMIN)
  @Patch(':id')
  @ApiOperation({ summary: '[Admin] Update a location' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateLocationDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.update(id, dto, readContext(user, req)));
  }

  @Roles(Role.ADMIN)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '[Admin] Soft-delete a location' })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.service.remove(id, readContext(user, req));
  }

  // ─── Managers ─────────────────────────────────────────────────────────

  @Get(':id/managers')
  @ApiOperation({ summary: 'List managers assigned to a location' })
  async listManagers(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    await this.service.assertCanReadLocation(user, id);
    return ok(await this.service.listManagers(id));
  }

  @Roles(Role.ADMIN)
  @Post(':id/managers')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '[Admin] Assign a MANAGER user to a location' })
  async assignManager(
    @Param('id') id: string,
    @Body() dto: AssignManagerDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.service.assignManager(id, dto.userId, readContext(user, req));
    return ok({ success: true });
  }

  @Roles(Role.ADMIN)
  @Delete(':id/managers/:userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '[Admin] Remove a manager from a location' })
  async removeManager(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.service.removeManager(id, userId, readContext(user, req));
  }
}
