import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsString } from 'class-validator';
import { Role } from '@prisma/client';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { ok } from '../../common/types/api-response.type';
import { AnalyticsService } from './analytics.service';

class DistributionQueryDto {
  @Type(() => Date)
  @IsDate()
  start!: Date;

  @Type(() => Date)
  @IsDate()
  end!: Date;

  @IsOptional()
  @IsString()
  locationId?: string;
}

class OvertimeQueryDto {
  @Type(() => Date)
  @IsDate()
  weekContaining!: Date;

  @IsOptional()
  @IsString()
  locationId?: string;
}

@ApiTags('analytics')
@ApiBearerAuth()
@Controller({ path: 'analytics', version: '1' })
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('distribution')
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Hours/fairness distribution per staff over a date range' })
  async distribution(
    @Query() query: DistributionQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(
      await this.service.distribution(
        { sub: user.sub, role: user.role },
        { start: query.start, end: query.end, locationId: query.locationId },
      ),
    );
  }

  @Get('overtime')
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Projected overtime for the week containing a given date' })
  async overtime(
    @Query() query: OvertimeQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(
      await this.service.overtimeProjection(
        { sub: user.sub, role: user.role },
        { weekContaining: query.weekContaining, locationId: query.locationId },
      ),
    );
  }
}
