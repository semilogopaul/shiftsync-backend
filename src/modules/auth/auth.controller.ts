import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { JwtRefreshGuard } from '../../common/guards/jwt-refresh.guard';
import { ok } from '../../common/types/api-response.type';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  RegisterDto,
  ResendVerificationDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/auth.dto';
import { AuthService, toPublicUser } from './auth.service';
import { UserRepository } from '../users/users.repository';
import { RefreshPayload } from './strategies/jwt-refresh.strategy';

function readContext(req: Request): { ipAddress?: string; userAgent?: string } {
  return {
    ipAddress: (req.ip ?? req.socket?.remoteAddress) || undefined,
    userAgent: req.header('user-agent') ?? undefined,
  };
}

@ApiTags('auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UserRepository,
  ) {}

  // ── Registration ──

  @Public()
  @Post('register')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Register a new EMPLOYEE account' })
  async register(@Body() dto: RegisterDto, @Req() req: Request) {
    const result = await this.auth.register(dto, readContext(req));
    return ok(result, 'Account created. Please check your email to verify.');
  }

  // ── Login / Refresh / Logout ──

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Log in with email + password (sets HTTP-only cookies)' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { user } = await this.auth.login(dto.email, dto.password, res, readContext(req));
    return ok(user);
  }

  @Public() // public-decorated because JwtAuthGuard would reject — JwtRefreshGuard handles auth here
  @UseGuards(JwtRefreshGuard)
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Rotate access + refresh tokens using the refresh cookie' })
  async refresh(
    @CurrentUser() payload: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // The refresh strategy attaches the full RefreshPayload to req.user
    const refreshPayload = req.user as unknown as RefreshPayload;
    const { user } = await this.auth.refresh(refreshPayload, res, readContext(req));
    void payload;
    return ok(user);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log out — revokes refresh token + clears cookies' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // No JTI on access token — best effort: clear cookies + revoke refresh by jti if cookie still present
    // The refresh cookie is path-restricted, so we can't read it here. Workaround: revoke all sessions.
    // For convenience we still expose a /logout-everywhere variant via passport refresh guard.
    await this.auth.logout({ sub: user.sub, jti: '' }, res, readContext(req));
    return ok({ success: true }, 'Logged out');
  }

  @UseGuards(JwtRefreshGuard)
  @Post('logout-this-session')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log out the current session only (revokes the presented refresh token)' })
  async logoutSession(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const refreshPayload = req.user as unknown as RefreshPayload;
    await this.auth.logout({ sub: refreshPayload.sub, jti: refreshPayload.jti }, res, readContext(req));
    return ok({ success: true }, 'Session logged out');
  }

  // ── Profile ──

  @Get('me')
  @ApiOperation({ summary: 'Return the currently authenticated user' })
  async me(@CurrentUser() current: AuthenticatedUser) {
    const user = await this.users.findById(current.sub);
    if (!user) return ok(null);
    return ok(toPublicUser(user));
  }

  // ── Password reset ──

  @Public()
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: 'Request a password-reset email (always returns success)' })
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.auth.forgotPassword(dto.email, readContext(req));
    return ok({ success: true }, 'If an account exists, a reset email has been sent.');
  }

  @Public()
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: 'Reset password using a one-time token' })
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.auth.resetPassword(dto.token, dto.newPassword, readContext(req));
    return ok({ success: true }, 'Password updated. Please log in.');
  }

  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change the current user’s password' })
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    await this.auth.changePassword(user.sub, dto.currentPassword, dto.newPassword, readContext(req));
    return ok({ success: true }, 'Password updated. Please log in again.');
  }

  // ── Email verification ──

  @Public()
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify an email address using the token from the verification email' })
  async verifyEmail(@Body() dto: VerifyEmailDto, @Req() req: Request) {
    await this.auth.verifyEmail(dto.token, readContext(req));
    return ok({ success: true }, 'Email verified.');
  }

  @Public()
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @ApiOperation({ summary: 'Resend the email-verification message (always returns success)' })
  async resendVerification(@Body() dto: ResendVerificationDto) {
    await this.auth.resendVerification(dto.email);
    return ok({ success: true });
  }
}
