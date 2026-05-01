import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditAction, Role, User } from '@prisma/client';
import { Response } from 'express';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../../database/prisma.service';
import { MailService } from '../../mail/mail.service';
import {
  emailVerificationEmail,
  emailVerifiedEmail,
  passwordChangedEmail,
  passwordResetRequestEmail,
  welcomeEmail,
} from '../../mail/templates';
import { AuditLogService } from '../audit-log/audit-log.service';
import { UserRepository } from '../users/users.repository';
import { AuthRepository } from './auth.repository';
import { JwtPayload } from './strategies/jwt.strategy';
import {
  ACCESS_COOKIE_OPTIONS,
  ACCESS_TOKEN_COOKIE,
  CLEAR_COOKIE_OPTIONS,
  REFRESH_COOKIE_OPTIONS,
  REFRESH_TOKEN_COOKIE,
} from '../../common/constants/cookie.constants';
import { generateOpaqueToken, sha256Hex } from '../../common/utils/token.util';

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000;

interface RequestContext {
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

import { PublicUser, toPublicUser } from '../../common/types/public-user.type';
export { toPublicUser };
export type { PublicUser };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly users: UserRepository,
    private readonly authRepo: AuthRepository,
    private readonly audit: AuditLogService,
    private readonly mail: MailService,
    private readonly events: EventEmitter2,
  ) {}

  // ─── Token helpers ──────────────────────────────────────────────────────

  private signAccessToken(payload: JwtPayload): string {
    return this.jwtService.sign(
      { sub: payload.sub, email: payload.email, role: payload.role },
      {
        secret: this.config.getOrThrow<string>('JWT_SECRET'),
        expiresIn: this.config.get<number>('JWT_ACCESS_TTL_SECONDS', 15 * 60),
      },
    );
  }

  private signRefreshToken(payload: JwtPayload, jti: string): string {
    return this.jwtService.sign(
      { sub: payload.sub, email: payload.email, role: payload.role, jti },
      {
        secret: this.config.getOrThrow<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.config.get<number>('JWT_REFRESH_TTL_SECONDS', 7 * 24 * 60 * 60),
      },
    );
  }

  private setAccessCookie(res: Response, accessToken: string): void {
    res.cookie(ACCESS_TOKEN_COOKIE, accessToken, ACCESS_COOKIE_OPTIONS);
  }

  private setRefreshCookie(res: Response, refreshToken: string): void {
    res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, REFRESH_COOKIE_OPTIONS);
  }

  private clearAuthCookies(res: Response): void {
    res.clearCookie(ACCESS_TOKEN_COOKIE, { ...CLEAR_COOKIE_OPTIONS, path: '/' });
    res.clearCookie(REFRESH_TOKEN_COOKIE, { ...CLEAR_COOKIE_OPTIONS, path: '/api/v1/auth/refresh' });
  }

  /** Issue + persist a fresh access/refresh pair. */
  private async issueTokens(user: User, res: Response, ctx: RequestContext): Promise<void> {
    const payload: JwtPayload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = this.signAccessToken(payload);

    const jti = randomUUID();
    const refreshToken = this.signRefreshToken(payload, jti);
    const tokenHash = sha256Hex(refreshToken);
    const ttlSeconds = this.config.get<number>('JWT_REFRESH_TTL_SECONDS', 7 * 24 * 60 * 60);
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    await this.authRepo.createRefreshToken({
      userId: user.id,
      jti,
      tokenHash,
      expiresAt,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    this.setAccessCookie(res, accessToken);
    this.setRefreshCookie(res, refreshToken);
  }

  // ─── Public flows ───────────────────────────────────────────────────────

  /**
   * Register a new EMPLOYEE. Admins/managers are created via admin tooling.
   * Does not auto-login — caller must verify email first.
   */
  async register(
    input: { email: string; password: string; firstName: string; lastName: string; phone?: string },
    ctx: RequestContext,
  ): Promise<{ id: string; email: string }> {
    const exists = await this.users.existsByEmail(input.email);
    if (exists) {
      throw new ConflictException('Unable to create account with the supplied details');
    }

    const cost = this.config.get<number>('BCRYPT_COST', 12);
    const passwordHash = await bcrypt.hash(input.password, cost);

    const user = await this.users.createOne({
      email: input.email,
      passwordHash,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      role: Role.EMPLOYEE,
    });

    const rawToken = await this.createEmailVerificationToken(user.id);
    const verifyUrl = `${this.config.getOrThrow<string>('FRONTEND_URL')}/verify-email?token=${encodeURIComponent(rawToken)}`;
    this.mail.sendAndForget(user.email, welcomeEmail({ firstName: user.firstName, verifyUrl }));

    this.audit.log({
      action: AuditAction.USER_CREATED,
      entityType: 'User',
      entityId: user.id,
      actorId: user.id,
      actorRole: user.role,
      after: this.redactUser(user),
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    this.events.emit('user.created', { userId: user.id, email: user.email });

    return { id: user.id, email: user.email };
  }

  async login(email: string, password: string, res: Response, ctx: RequestContext): Promise<{ user: PublicUser }> {
    const user = await this.users.findByEmail(email);
    if (!user || !user.isActive) {
      this.audit.log({
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        meta: { email, reason: 'unknown_or_inactive' },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) {
      this.audit.log({
        action: AuditAction.LOGIN_FAILED,
        entityType: 'User',
        entityId: user.id,
        meta: { email, reason: 'bad_password' },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    await this.issueTokens(user, res, ctx);

    this.audit.log({
      action: AuditAction.LOGIN_SUCCESS,
      entityType: 'User',
      entityId: user.id,
      actorId: user.id,
      actorRole: user.role,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    return { user: toPublicUser(user) };
  }

  /**
   * Refresh tokens with rotation + reuse detection.
   * Any sign of token replay → revoke ALL of the user's sessions.
   */
  async refresh(
    payload: { sub: string; email: string; role: Role; jti: string; refreshToken: string },
    res: Response,
    ctx: RequestContext,
  ): Promise<{ user: PublicUser }> {
    const stored = await this.authRepo.findRefreshTokenByJti(payload.jti);
    if (!stored) {
      await this.authRepo.revokeAllForUser(payload.sub);
      this.audit.log({
        action: AuditAction.TOKEN_REUSE_DETECTED,
        entityType: 'RefreshToken',
        actorId: payload.sub,
        meta: { jti: payload.jti, reason: 'unknown_jti' },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      this.clearAuthCookies(res);
      throw new UnauthorizedException('Session expired — please log in again');
    }

    const presentedHash = sha256Hex(payload.refreshToken);
    if (presentedHash !== stored.tokenHash) {
      await this.authRepo.revokeAllForUser(payload.sub);
      this.audit.log({
        action: AuditAction.TOKEN_REUSE_DETECTED,
        entityType: 'RefreshToken',
        entityId: stored.id,
        actorId: payload.sub,
        meta: { jti: payload.jti, reason: 'hash_mismatch' },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      this.clearAuthCookies(res);
      throw new UnauthorizedException('Session expired — please log in again');
    }

    if (stored.revokedAt) {
      await this.authRepo.revokeAllForUser(payload.sub);
      this.audit.log({
        action: AuditAction.TOKEN_REUSE_DETECTED,
        entityType: 'RefreshToken',
        entityId: stored.id,
        actorId: payload.sub,
        meta: { jti: payload.jti, reason: 'replay_after_revocation' },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
      this.clearAuthCookies(res);
      throw new UnauthorizedException('Session was revoked — please log in again');
    }

    if (stored.expiresAt <= new Date()) {
      await this.authRepo.revokeRefreshTokenById(stored.id);
      this.clearAuthCookies(res);
      throw new UnauthorizedException('Session expired — please log in again');
    }

    const user = await this.users.findById(payload.sub);
    if (!user || !user.isActive) {
      await this.authRepo.revokeRefreshTokenById(stored.id);
      this.clearAuthCookies(res);
      throw new UnauthorizedException('Account is unavailable');
    }

    const newJti = randomUUID();
    const newRefresh = this.signRefreshToken({ sub: user.id, email: user.email, role: user.role }, newJti);
    const newHash = sha256Hex(newRefresh);
    const ttlSeconds = this.config.get<number>('JWT_REFRESH_TTL_SECONDS', 7 * 24 * 60 * 60);
    const newExpires = new Date(Date.now() + ttlSeconds * 1000);

    await this.authRepo.rotateRefreshToken({
      oldId: stored.id,
      newRow: {
        userId: user.id,
        jti: newJti,
        tokenHash: newHash,
        expiresAt: newExpires,
        ipAddress: ctx.ipAddress ?? null,
        userAgent: ctx.userAgent ?? null,
      },
    });

    const accessToken = this.signAccessToken({ sub: user.id, email: user.email, role: user.role });
    this.setAccessCookie(res, accessToken);
    this.setRefreshCookie(res, newRefresh);

    this.audit.log({
      action: AuditAction.TOKEN_REFRESHED,
      entityType: 'RefreshToken',
      entityId: stored.id,
      actorId: user.id,
      actorRole: user.role,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });

    return { user: toPublicUser(user) };
  }

  async logout(payload: { sub: string; jti: string }, res: Response, ctx: RequestContext): Promise<void> {
    const stored = await this.authRepo.findRefreshTokenByJti(payload.jti);
    if (stored && !stored.revokedAt) {
      await this.authRepo.revokeRefreshTokenById(stored.id);
    }
    this.clearAuthCookies(res);
    this.audit.log({
      action: AuditAction.LOGOUT,
      entityType: 'User',
      entityId: payload.sub,
      actorId: payload.sub,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  // ─── Forgot/reset password ──────────────────────────────────────────────

  /** Always returns success. Never reveals whether the email exists. */
  async forgotPassword(email: string, ctx: RequestContext): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user) return;

    await this.authRepo.invalidateActivePasswordResets(user.id);

    const rawToken = generateOpaqueToken();
    const tokenHash = sha256Hex(rawToken);
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);

    await this.authRepo.createPasswordReset({
      userId: user.id,
      tokenHash,
      expiresAt,
      ipAddress: ctx.ipAddress ?? null,
    });

    const resetUrl = `${this.config.getOrThrow<string>('FRONTEND_URL')}/reset-password?token=${encodeURIComponent(rawToken)}`;
    this.mail.sendAndForget(
      user.email,
      passwordResetRequestEmail({ firstName: user.firstName, resetUrl, ipAddress: ctx.ipAddress }),
    );

    this.audit.log({
      action: AuditAction.PASSWORD_RESET_REQUESTED,
      entityType: 'User',
      entityId: user.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  async resetPassword(rawToken: string, newPassword: string, ctx: RequestContext): Promise<void> {
    const tokenHash = sha256Hex(rawToken);
    const reset = await this.authRepo.findValidPasswordReset(tokenHash, new Date());
    if (!reset) throw new BadRequestException('Invalid or expired reset token');

    const cost = this.config.get<number>('BCRYPT_COST', 12);
    const passwordHash = await bcrypt.hash(newPassword, cost);

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: reset.userId }, data: { passwordHash } });
      await tx.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } });
      await tx.refreshToken.updateMany({
        where: { userId: reset.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });

    const user = await this.users.findById(reset.userId);
    if (user) {
      this.mail.sendAndForget(user.email, passwordChangedEmail({ firstName: user.firstName, ipAddress: ctx.ipAddress }));
    }

    this.audit.log({
      action: AuditAction.PASSWORD_RESET_COMPLETED,
      entityType: 'User',
      entityId: reset.userId,
      actorId: reset.userId,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    ctx: RequestContext,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new NotFoundException('User not found');

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) throw new UnauthorizedException('Current password is incorrect');

    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw new BadRequestException('New password must differ from the current one');
    }

    const cost = this.config.get<number>('BCRYPT_COST', 12);
    const passwordHash = await bcrypt.hash(newPassword, cost);

    await this.users.updateById(userId, { passwordHash });
    await this.authRepo.revokeAllForUser(userId);

    this.mail.sendAndForget(user.email, passwordChangedEmail({ firstName: user.firstName, ipAddress: ctx.ipAddress }));

    this.audit.log({
      action: AuditAction.PASSWORD_CHANGED,
      entityType: 'User',
      entityId: userId,
      actorId: userId,
      actorRole: user.role,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  // ─── Email verification ─────────────────────────────────────────────────

  private async createEmailVerificationToken(userId: string): Promise<string> {
    const rawToken = generateOpaqueToken();
    const tokenHash = sha256Hex(rawToken);
    await this.authRepo.createEmailVerification({
      userId,
      tokenHash,
      expiresAt: new Date(Date.now() + EMAIL_VERIFY_TTL_MS),
    });
    return rawToken;
  }

  async verifyEmail(rawToken: string, ctx: RequestContext): Promise<void> {
    const tokenHash = sha256Hex(rawToken);
    const ev = await this.authRepo.findValidEmailVerification(tokenHash, new Date());
    if (!ev) throw new BadRequestException('Invalid or expired verification token');

    const user = await this.users.findByIdIncludingDeleted(ev.userId);
    if (!user) throw new BadRequestException('Invalid or expired verification token');

    if (!user.emailVerified) {
      await this.users.updateById(user.id, { emailVerified: true });
    }
    await this.authRepo.markEmailVerificationUsed(ev.id);

    this.mail.sendAndForget(user.email, emailVerifiedEmail({ firstName: user.firstName }));
    this.audit.log({
      action: AuditAction.EMAIL_VERIFIED,
      entityType: 'User',
      entityId: user.id,
      actorId: user.id,
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
  }

  /** Always returns success regardless of whether the email exists. */
  async resendVerification(email: string): Promise<void> {
    const user = await this.users.findByEmail(email);
    if (!user || user.emailVerified) return;

    const rawToken = await this.createEmailVerificationToken(user.id);
    const verifyUrl = `${this.config.getOrThrow<string>('FRONTEND_URL')}/verify-email?token=${encodeURIComponent(rawToken)}`;
    this.mail.sendAndForget(user.email, emailVerificationEmail({ firstName: user.firstName, verifyUrl }));
  }

  private redactUser(user: User): Partial<User> {
    const { passwordHash: _, ...rest } = user;
    void _;
    return rest;
  }
}
