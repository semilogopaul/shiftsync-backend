import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Mark a route as public — skips the global JwtAuthGuard.
 * Use on any endpoint that must be accessible without a token (login, register, health).
 *
 * @example
 * \@Public()
 * \@Post('login')
 * login() { ... }
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
