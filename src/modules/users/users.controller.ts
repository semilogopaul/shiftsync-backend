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
import { buildPaginatedResult, paginationToPrismaArgs } from '../../common/dto/pagination.dto';
import { UsersService } from './users.service';
import {
  AdminCreateUserDto,
  AdminSetActiveDto,
  AdminUpdateUserRoleDto,
  DirectoryQueryDto,
  ListUsersQueryDto,
  UpdateDesiredHoursDto,
  UpdateNotificationPrefsDto,
  UpdateProfileDto,
} from './dto/users.dto';

function readContext(user: AuthenticatedUser, req: Request) {
  return {
    actorId: user.sub,
    actorRole: user.role,
    ipAddress: (req.ip ?? req.socket?.remoteAddress) || undefined,
    userAgent: req.header('user-agent') ?? undefined,
  };
}

@ApiTags('users')
@Controller({ path: 'users', version: '1' })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // ─── Self-service ────────────────────────────────────────────────────

  @Get('me')
  @ApiOperation({ summary: 'Get the current user’s profile' })
  async getMe(@CurrentUser() user: AuthenticatedUser) {
    return ok(await this.users.getProfile(user.sub));
  }

  @Patch('me')
  @ApiOperation({ summary: 'Update the current user’s profile' })
  async updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
    @Req() req: Request,
  ) {
    return ok(await this.users.updateProfile(user.sub, dto, readContext(user, req)));
  }

  @Patch('me/notifications')
  @ApiOperation({ summary: 'Update notification preferences' })
  async updateMyNotifications(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateNotificationPrefsDto,
    @Req() req: Request,
  ) {
    return ok(await this.users.updateNotificationPrefs(user.sub, dto, readContext(user, req)));
  }

  @Patch('me/desired-hours')
  @ApiOperation({ summary: 'Update desired weekly working hours' })
  async updateMyDesiredHours(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateDesiredHoursDto,
    @Req() req: Request,
  ) {
    return ok(
      await this.users.updateDesiredHours(user.sub, dto.desiredWeeklyHours, readContext(user, req)),
    );
  }

  // ─── Admin ────────────────────────────────────────────────────────────

  @Get('directory')
  @ApiOperation({
    summary:
      'Light-weight directory of active users. Available to any authenticated user; ' +
      'returns minimal columns and is hard-capped at 50 rows. Use `locationId` to find ' +
      'staff certified at a specific location (e.g., swap recipient candidates).',
  })
  async directory(@Query() query: DirectoryQueryDto) {
    return ok(await this.users.directory(query));
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Get()
  @ApiOperation({ summary: '[Admin] List users (paginated, filterable)' })
  async list(@Query() query: ListUsersQueryDto) {
    const { page, pageSize, role, search, isActive } = query;
    const { items, total } = await this.users.list(
      { role, search, isActive },
      paginationToPrismaArgs({ page, pageSize }),
    );
    return buildPaginatedResult(items, total, page, pageSize);
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @Get(':id')
  @ApiOperation({ summary: '[Admin/Manager] Fetch a user by id' })
  async getById(@Param('id') id: string) {
    return ok(await this.users.getById(id));
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '[Admin] Create a user with any role (pre-verified)' })
  async create(
    @Body() dto: AdminCreateUserDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.users.adminCreate(dto, readContext(actor, req)));
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Patch(':id/role')
  @ApiOperation({ summary: '[Admin] Change a user’s role' })
  async changeRole(
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserRoleDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.users.adminChangeRole(id, dto.role, readContext(actor, req)));
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Patch(':id/active')
  @ApiOperation({ summary: '[Admin] Activate or deactivate a user' })
  async setActive(
    @Param('id') id: string,
    @Body() dto: AdminSetActiveDto,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.users.adminSetActive(id, dto.isActive, readContext(actor, req)));
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '[Admin] Soft-delete a user' })
  async softDelete(
    @Param('id') id: string,
    @CurrentUser() actor: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.users.adminSoftDelete(id, readContext(actor, req));
  }
}
