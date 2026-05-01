import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { Request } from 'express';
import { REFRESH_TOKEN_COOKIE } from '../../../common/constants/cookie.constants';
import { JwtPayload } from './jwt.strategy';

const refreshCookieExtractor = (req: Request): string | null => {
  return req?.cookies?.[REFRESH_TOKEN_COOKIE] ?? null;
};

export interface RefreshPayload extends JwtPayload {
  /** Unique JWT id — used to look up the persisted RefreshToken row */
  jti: string;
  /** Raw refresh token — used to verify against the stored sha256 hash */
  refreshToken: string;
}

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([refreshCookieExtractor]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_REFRESH_SECRET'),
      passReqToCallback: true,
    });
  }

  validate(req: Request, payload: JwtPayload & { jti?: string }): RefreshPayload {
    const refreshToken = (req.cookies?.[REFRESH_TOKEN_COOKIE] as string) ?? '';
    return {
      sub: payload.sub,
      email: payload.email,
      role: payload.role,
      jti: payload.jti ?? '',
      refreshToken,
    };
  }
}
