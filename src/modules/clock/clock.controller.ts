import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,

  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { ok } from '../../common/types/api-response.type';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { ClockService } from './clock.service';

class ClockBodyDto {
  @IsOptional()
  @IsString()
  userId?: string;
}

@ApiTags('clock')
@ApiBearerAuth()
@Controller({ path: '', version: '1' })
export class ClockController {
  constructor(private readonly service: ClockService) {}

  @Post('shifts/:id/clock-in')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Clock in to a shift' })
  async clockIn(
    @Param('id') shiftId: string,
    @Body() body: ClockBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(await this.service.clockIn({ sub: user.sub, role: user.role }, shiftId, body.userId));
  }

  @Post('shifts/:id/clock-out')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Clock out of a shift' })
  async clockOut(
    @Param('id') shiftId: string,
    @Body() body: ClockBodyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(await this.service.clockOut({ sub: user.sub, role: user.role }, shiftId, body.userId));
  }

  @Get('on-duty')
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'List staff currently clocked in (optionally scoped by location)' })
  async onDuty(
    @Query('locationId') locationId: string | undefined,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(
      await this.service.listOnDuty(
        { sub: user.sub, role: user.role },
        locationId && locationId.length > 0 ? locationId : undefined,
      ),
    );
  }
}
