import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Role } from '@prisma/client';

/**
 * The shape of `req.user` after JwtStrategy.validate() resolves.
 * This must match exactly what JwtStrategy returns.
 */
export interface AuthenticatedUser {
  readonly sub: string;
  readonly email: string;
  readonly role: Role;
}

/**
 * Extract the authenticated user from the request.
 *
 * @example
 *   @Get('me')
 *   me(@CurrentUser() user: AuthenticatedUser) { ... }
 *
 * Optionally pass a property name to extract a single field:
 *   me(@CurrentUser('sub') userId: string) { ... }
 */
export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext): AuthenticatedUser | string => {
    const request = ctx.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
    return data ? request.user[data] : request.user;
  },
);
