import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** Guards the /auth/refresh endpoint — reads from the refresh_token HTTP-only cookie */
@Injectable()
export class JwtRefreshGuard extends AuthGuard('jwt-refresh') {}
