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
import { SkillsService } from './skills.service';
import { CreateSkillDto, ListSkillsQueryDto, UpdateSkillDto } from './dto/skills.dto';

function readContext(user: AuthenticatedUser, req: Request) {
  return {
    actorId: user.sub,
    actorRole: user.role,
    ipAddress: (req.ip ?? req.socket?.remoteAddress) || undefined,
    userAgent: req.header('user-agent') ?? undefined,
  };
}

@ApiTags('skills')
@Controller({ path: 'skills', version: '1' })
export class SkillsController {
  constructor(private readonly service: SkillsService) {}

  @Get()
  @ApiOperation({ summary: 'List skills (any authenticated user)' })
  async list(@Query() query: ListSkillsQueryDto) {
    const { page, pageSize, search } = query;
    const { items, total } = await this.service.list({ search }, paginationToPrismaArgs({ page, pageSize }));
    return buildPaginatedResult(items, total, page, pageSize);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get a skill (any authenticated user)' })
  async getById(@Param('id') id: string) {
    return ok(await this.service.getById(id));
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: '[Admin] Create a skill' })
  async create(@Body() dto: CreateSkillDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return ok(await this.service.create(dto.name, readContext(user, req)));
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Patch(':id')
  @ApiOperation({ summary: '[Admin] Rename a skill' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateSkillDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.update(id, dto.name, readContext(user, req)));
  }

  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '[Admin] Delete a skill' })
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    await this.service.remove(id, readContext(user, req));
  }
}
