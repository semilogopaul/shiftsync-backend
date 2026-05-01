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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import type { Request } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ok } from '../../common/types/api-response.type';
import { ShiftsService } from './shifts.service';
import {
  AssignStaffDto,
  CreateShiftDto,
  ListShiftsQueryDto,
  PublishShiftsDto,
  UpdateShiftDto,
  ValidateAssignmentDto,
} from './dto/shifts.dto';

function readContext(user: AuthenticatedUser, req: Request) {
  return {
    actorId: user.sub,
    actorRole: user.role,
    ipAddress: (req.ip ?? req.socket?.remoteAddress) || undefined,
    userAgent: req.header('user-agent') ?? undefined,
  };
}

@ApiTags('shifts')
@ApiBearerAuth()
@Controller({ path: 'shifts', version: '1' })
export class ShiftsController {
  constructor(private readonly service: ShiftsService) {}

  @Get()
  @ApiOperation({ summary: 'List shifts (scoped by role)' })
  async list(@Query() query: ListShiftsQueryDto, @CurrentUser() user: AuthenticatedUser) {
    return ok(
      await this.service.list(
        {
          locationId: query.locationId,
          userId: query.userId,
          status: query.status,
          from: query.from ? new Date(query.from) : undefined,
          to: query.to ? new Date(query.to) : undefined,
          isPremium: query.isPremium,
          page: query.page,
          pageSize: query.pageSize,
        },
        user,
      ),
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a shift by ID' })
  async getById(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(await this.service.getById(id, user));
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a shift (manager scoped)' })
  async create(
    @Body() dto: CreateShiftDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(
      await this.service.create(
        {
          locationId: dto.locationId,
          skillId: dto.skillId,
          startsAt: new Date(dto.startsAt),
          endsAt: new Date(dto.endsAt),
          headcount: dto.headcount,
          notes: dto.notes,
        },
        user,
        readContext(user, req),
      ),
    );
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Update a shift (optimistic concurrency)' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateShiftDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(
      await this.service.update(
        id,
        dto.expectedVersion,
        {
          skillId: dto.skillId,
          startsAt: dto.startsAt ? new Date(dto.startsAt) : undefined,
          endsAt: dto.endsAt ? new Date(dto.endsAt) : undefined,
          headcount: dto.headcount,
          notes: dto.notes,
        },
        user,
        readContext(user, req),
      ),
    );
  }

  @Delete(':id')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete (cancel) a shift' })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.service.remove(id, user, readContext(user, req));
  }

  @Post('publish')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Publish a list of draft shifts' })
  async publish(
    @Body() dto: PublishShiftsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.publish(dto.shiftIds, user, readContext(user, req)));
  }

  @Post(':id/unpublish')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Unpublish a published shift back to DRAFT' })
  async unpublish(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.unpublish(id, user, readContext(user, req)));
  }

  @Post(':id/callout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Call out of your own assigned shift (Sunday-night-chaos path)',
    description:
      'Removes the caller from the shift immediately, emits an urgent coverage event to managers, and returns a list of qualified replacement suggestions.',
  })
  async callout(
    @Param('id') id: string,
    @Body() body: { reason: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.selfCallout(id, user, body?.reason ?? '', readContext(user, req)));
  }

  @Get(':id/history')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Audit history for a single shift' })
  async history(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(await this.service.getHistory(id, user));
  }

  @Post(':id/validate-assignment')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Preview the validation result for an assignment' })
  async validateAssignment(
    @Param('id') id: string,
    @Body() dto: ValidateAssignmentDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(
      await this.service.validateAssignment(
        id,
        dto.userId,
        { overrideUsed: dto.overrideUsed, overrideReason: dto.overrideReason },
        user,
      ),
    );
  }

  @Post(':id/assignments')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Assign a staff member to a shift' })
  async assign(
    @Param('id') id: string,
    @Body() dto: AssignStaffDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(
      await this.service.assignStaff(
        id,
        dto.userId,
        { overrideUsed: dto.overrideUsed, overrideReason: dto.overrideReason },
        user,
        readContext(user, req),
      ),
    );
  }

  @Post(':id/assignments/preview')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What-if preview: validate an assignment without persisting',
    description:
      'Runs the full validator + alternative suggestions for a candidate (shift, user) pair. No state is changed.',
  })
  async previewAssign(
    @Param('id') id: string,
    @Body() dto: AssignStaffDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(
      await this.service.previewAssignment(id, dto.userId, user, {
        overrideUsed: dto.overrideUsed,
        overrideReason: dto.overrideReason,
      }),
    );
  }

  @Delete(':id/assignments/:userId')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unassign a staff member from a shift' })
  async unassign(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.service.unassignStaff(id, userId, user, readContext(user, req));
  }
}
