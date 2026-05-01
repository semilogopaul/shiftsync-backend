import { Injectable } from '@nestjs/common';
import { Prisma, RefreshToken, PasswordReset, EmailVerification } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ── Refresh tokens ──

  async createRefreshToken(input: {
    userId: string;
    jti: string;
    tokenHash: string;
    expiresAt: Date;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<RefreshToken> {
    return this.prisma.refreshToken.create({ data: input });
  }

  async findRefreshTokenByJti(jti: string): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findUnique({ where: { jti } });
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.prisma.refreshToken.findUnique({ where: { tokenHash } });
  }

  /**
   * Atomically rotate a refresh token: revoke the old, persist the new,
   * and link them. Returns the new RefreshToken row.
   */
  async rotateRefreshToken(input: {
    oldId: string;
    newRow: {
      userId: string;
      jti: string;
      tokenHash: string;
      expiresAt: Date;
      ipAddress?: string | null;
      userAgent?: string | null;
    };
  }): Promise<RefreshToken> {
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.refreshToken.create({ data: input.newRow });
      await tx.refreshToken.update({
        where: { id: input.oldId },
        data: { revokedAt: new Date(), replacedById: created.id },
      });
      return created;
    });
  }

  async revokeRefreshTokenById(id: string): Promise<void> {
    await this.prisma.refreshToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  /** Reuse-detection nuclear option: revoke every active refresh token for the user. */
  async revokeAllForUser(userId: string): Promise<Prisma.BatchPayload> {
    return this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  // ── Password resets ──

  async createPasswordReset(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    ipAddress?: string | null;
  }): Promise<PasswordReset> {
    return this.prisma.passwordReset.create({ data: input });
  }

  async findValidPasswordReset(tokenHash: string, now: Date): Promise<PasswordReset | null> {
    return this.prisma.passwordReset.findFirst({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
    });
  }

  async markPasswordResetUsed(id: string): Promise<void> {
    await this.prisma.passwordReset.update({ where: { id }, data: { usedAt: new Date() } });
  }

  async invalidateActivePasswordResets(userId: string): Promise<void> {
    await this.prisma.passwordReset.updateMany({
      where: { userId, usedAt: null },
      data: { usedAt: new Date() },
    });
  }

  // ── Email verifications ──

  async createEmailVerification(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<EmailVerification> {
    return this.prisma.emailVerification.create({ data: input });
  }

  async findValidEmailVerification(tokenHash: string, now: Date): Promise<EmailVerification | null> {
    return this.prisma.emailVerification.findFirst({
      where: { tokenHash, usedAt: null, expiresAt: { gt: now } },
    });
  }

  async markEmailVerificationUsed(id: string): Promise<void> {
    await this.prisma.emailVerification.update({ where: { id }, data: { usedAt: new Date() } });
  }
}
