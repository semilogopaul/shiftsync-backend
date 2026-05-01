import { createHash, randomBytes } from 'node:crypto';

/**
 * Generate a high-entropy URL-safe token (default 48 bytes → 64-char base64url).
 * Used for password reset, email verification, and refresh-token reuse detection.
 */
export function generateOpaqueToken(byteLength = 48): string {
  return randomBytes(byteLength).toString('base64url');
}

/** Deterministic SHA-256 hash (hex). Used to store tokens at rest. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
