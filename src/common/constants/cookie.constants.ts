/** Name of the HTTP-only access-token cookie */
export const ACCESS_TOKEN_COOKIE = 'access_token' as const;

/** Name of the HTTP-only refresh-token cookie */
export const REFRESH_TOKEN_COOKIE = 'refresh_token' as const;

/**
 * Shared cookie options for both tokens.
 * - httpOnly: JS cannot read the cookie
 * - secure: only sent over HTTPS (enforced in production)
 * - sameSite: 'lax' allows same-site navigations; use 'strict' if no cross-origin needs
 */
export const BASE_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
} as const;

/** Access token cookie — short-lived, available on all API routes */
export const ACCESS_COOKIE_OPTIONS = {
  ...BASE_COOKIE_OPTIONS,
  maxAge: 15 * 60 * 1000, // 15 minutes in ms
} as const;

/** Refresh token cookie — long-lived, restricted to the refresh endpoint */
export const REFRESH_COOKIE_OPTIONS = {
  ...BASE_COOKIE_OPTIONS,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
  path: '/api/v1/auth/refresh', // only sent to the refresh endpoint
} as const;

/** Clear both cookies on logout */
export const CLEAR_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
} as const;
