import { SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Restrict a route to one or more roles. Type-safe via the Prisma Role enum.
 * Must be used with RolesGuard which is applied after JwtAuthGuard.
 *
 * @example
 * \@Roles(Role.ADMIN)
 * \@Get('audit-logs')
 * getAuditLogs() { ... }
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
