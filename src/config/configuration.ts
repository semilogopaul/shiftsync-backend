/**
 * Typed environment configuration. Validates env on app startup and throws
 * a clear error if any required variable is missing or malformed.
 */

export interface AppConfig {
  readonly NODE_ENV: 'development' | 'production' | 'test';
  readonly PORT: number;
  readonly FRONTEND_URL: string;

  readonly DATABASE_URL: string;

  readonly JWT_SECRET: string;
  readonly JWT_REFRESH_SECRET: string;
  readonly JWT_ACCESS_TTL_SECONDS: number;
  readonly JWT_REFRESH_TTL_SECONDS: number;

  readonly RESEND_API_KEY: string;
  readonly MAIL_FROM: string;

  readonly THROTTLE_TTL: number;
  readonly THROTTLE_LIMIT: number;

  readonly BCRYPT_COST: number;

  readonly SHIFT_EDIT_CUTOFF_HOURS: number;
  readonly DROP_EXPIRY_HOURS_BEFORE_SHIFT: number;
  readonly MAX_PENDING_SWAP_DROP_PER_USER: number;
}

function getString(key: string, value: string | undefined, fallback?: string): string {
  if (value && value.length > 0) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`[config] Missing required env var: ${key}`);
}

function getInt(key: string, value: string | undefined, fallback?: number): number {
  if (value === undefined || value === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`[config] Missing required numeric env var: ${key}`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`[config] Env var ${key} is not a valid number: ${value}`);
  }
  return parsed;
}

function getEnum<T extends string>(key: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if (!allowed.includes(value as T)) {
    throw new Error(`[config] Env var ${key} must be one of [${allowed.join(', ')}], got: ${value}`);
  }
  return value as T;
}

export function loadConfig(): AppConfig {
  const env = process.env;

  const config: AppConfig = {
    NODE_ENV: getEnum('NODE_ENV', env.NODE_ENV, ['development', 'production', 'test'] as const, 'development'),
    PORT: getInt('PORT', env.PORT, 3001),
    FRONTEND_URL: getString('FRONTEND_URL', env.FRONTEND_URL, 'http://localhost:3000'),

    DATABASE_URL: getString('DATABASE_URL', env.DATABASE_URL),

    JWT_SECRET: getString('JWT_SECRET', env.JWT_SECRET),
    JWT_REFRESH_SECRET: getString('JWT_REFRESH_SECRET', env.JWT_REFRESH_SECRET),
    JWT_ACCESS_TTL_SECONDS: getInt('JWT_ACCESS_TTL_SECONDS', env.JWT_ACCESS_TTL_SECONDS, 15 * 60),
    JWT_REFRESH_TTL_SECONDS: getInt('JWT_REFRESH_TTL_SECONDS', env.JWT_REFRESH_TTL_SECONDS, 7 * 24 * 60 * 60),

    RESEND_API_KEY: getString('RESEND_API_KEY', env.RESEND_API_KEY),
    MAIL_FROM: getString('MAIL_FROM', env.MAIL_FROM),

    THROTTLE_TTL: getInt('THROTTLE_TTL', env.THROTTLE_TTL, 60),
    THROTTLE_LIMIT: getInt('THROTTLE_LIMIT', env.THROTTLE_LIMIT, 100),

    BCRYPT_COST: getInt('BCRYPT_COST', env.BCRYPT_COST, 12),

    SHIFT_EDIT_CUTOFF_HOURS: getInt('SHIFT_EDIT_CUTOFF_HOURS', env.SHIFT_EDIT_CUTOFF_HOURS, 48),
    DROP_EXPIRY_HOURS_BEFORE_SHIFT: getInt('DROP_EXPIRY_HOURS_BEFORE_SHIFT', env.DROP_EXPIRY_HOURS_BEFORE_SHIFT, 24),
    MAX_PENDING_SWAP_DROP_PER_USER: getInt('MAX_PENDING_SWAP_DROP_PER_USER', env.MAX_PENDING_SWAP_DROP_PER_USER, 3),
  };

  // Strong-secrets sanity check (prod only)
  if (config.NODE_ENV === 'production') {
    if (config.JWT_SECRET.length < 32 || config.JWT_REFRESH_SECRET.length < 32) {
      throw new Error('[config] JWT secrets must be ≥32 chars in production');
    }
    if (config.JWT_SECRET === config.JWT_REFRESH_SECRET) {
      throw new Error('[config] JWT_SECRET and JWT_REFRESH_SECRET must differ');
    }
  }

  return config;
}
