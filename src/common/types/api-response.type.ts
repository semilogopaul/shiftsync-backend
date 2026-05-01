/**
 * Standard envelope for non-paginated success responses.
 * Used as the return type from controllers when no list is involved.
 */
export interface ApiResponse<T> {
  readonly data: T;
  readonly message?: string;
}

export function ok<T>(data: T, message?: string): ApiResponse<T> {
  return message ? { data, message } : { data };
}
