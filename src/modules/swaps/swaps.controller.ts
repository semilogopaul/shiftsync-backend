import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
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
import { SwapsService } from './swaps.service';
import {
  CreateDropRequestDto,
  CreateSwapRequestDto,
  ManagerDecisionDto,
  RespondToSwapDto,
} from './dto/swaps.dto';

function readContext(user: AuthenticatedUser, req: Request) {
  return {
    actorId: user.sub,
    actorRole: user.role,
    ipAddress: (req.ip ?? req.socket?.remoteAddress) || undefined,
    userAgent: req.header('user-agent') ?? undefined,
  };
}

@ApiTags('swaps-and-drops')
@ApiBearerAuth()
@Controller({ path: '', version: '1' })
export class SwapsController {
  constructor(private readonly service: SwapsService) {}

  // ─── SWAPS ───────────────────────────────────────────────────────────

  @Post('swaps')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Request a swap of one of your shifts to another user' })
  async createSwap(
    @Body() dto: CreateSwapRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.createSwap(user, dto, readContext(user, req)));
  }

  @Get('swaps/me')
  @ApiOperation({ summary: 'List my swap requests (incoming + outgoing)' })
  async listMine(
    @CurrentUser() user: AuthenticatedUser,
    @Query('onlyPending') onlyPending?: string,
  ) {
    return ok(await this.service.listMySwaps(user, onlyPending === 'true'));
  }

  @Get('swaps/me/pending-count')
  @ApiOperation({
    summary: 'Counts of my pending swap/drop requests (for client-side 3-pending pre-flight)',
  })
  async myPendingCount(@CurrentUser() user: AuthenticatedUser) {
    return ok(await this.service.getMyPendingCounts(user));
  }

  @Get('shifts/:shiftId/swaps')
  @ApiOperation({ summary: 'List swap requests for a shift (managers/admins)' })
  async listForShift(
    @Param('shiftId') shiftId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return ok(await this.service.listSwapsForShift(user, shiftId));
  }

  @Post('swaps/:id/accept')
  @ApiOperation({ summary: 'Recipient accepts the swap (forwards to manager)' })
  async accept(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.recipientAccept(id, user, readContext(user, req)));
  }

  @Post('swaps/:id/reject')
  @ApiOperation({ summary: 'Recipient rejects the swap' })
  async reject(
    @Param('id') id: string,
    @Body() _dto: RespondToSwapDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.recipientReject(id, user, readContext(user, req)));
  }

  @Post('swaps/:id/cancel')
  @ApiOperation({ summary: 'Requester cancels their own pending swap' })
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.requesterCancel(id, user, readContext(user, req)));
  }

  @Post('swaps/:id/manager-approve')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Manager approves the swap (executes the assignment swap)' })
  async approve(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.managerApprove(id, user, readContext(user, req)));
  }

  @Post('swaps/:id/manager-reject')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Manager rejects the swap' })
  async managerReject(
    @Param('id') id: string,
    @Body() dto: ManagerDecisionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.managerReject(id, user, dto.reason, readContext(user, req)));
  }

  // ─── DROPS ───────────────────────────────────────────────────────────

  @Post('drops')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Drop a shift you are assigned to (open for claims)' })
  async createDrop(
    @Body() dto: CreateDropRequestDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.createDrop(user, dto, readContext(user, req)));
  }

  @Get('drops/open')
  @ApiOperation({ summary: 'List open drop requests (optionally scoped by location)' })
  async listOpen(
    @CurrentUser() user: AuthenticatedUser,
    @Query('locationId') locationId?: string,
  ) {
    return ok(await this.service.listOpenDrops(user, locationId));
  }

  @Post('drops/:id/claim')
  @ApiOperation({ summary: 'Claim an open drop (forwards to manager)' })
  async claim(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.claimDrop(id, user, readContext(user, req)));
  }

  @Post('drops/:id/cancel')
  @ApiOperation({ summary: 'Cancel your own drop request' })
  async cancelDrop(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.cancelDrop(id, user, readContext(user, req)));
  }

  @Post('drops/:id/manager-approve')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Manager approves drop reassignment' })
  async approveDrop(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.approveDrop(id, user, readContext(user, req)));
  }

  @Post('drops/:id/manager-reject')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.MANAGER)
  @ApiOperation({ summary: 'Manager rejects drop reassignment' })
  async rejectDrop(
    @Param('id') id: string,
    @Body() dto: ManagerDecisionDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return ok(await this.service.rejectDrop(id, user, dto.reason, readContext(user, req)));
  }
}
