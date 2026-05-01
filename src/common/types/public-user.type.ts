import { Role, User } from '@prisma/client';

export interface PublicUser {
  readonly id: string;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string | null;
  readonly role: Role;
  readonly emailVerified: boolean;
  readonly isActive: boolean;
  readonly preferredTimezone: string | null;
  readonly desiredWeeklyHours: number | null;
  readonly notifyInApp: boolean;
  readonly notifyEmail: boolean;
  readonly createdAt: Date;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    phone: user.phone,
    role: user.role,
    emailVerified: user.emailVerified,
    isActive: user.isActive,
    preferredTimezone: user.preferredTimezone,
    desiredWeeklyHours: user.desiredWeeklyHours,
    notifyInApp: user.notifyInApp,
    notifyEmail: user.notifyEmail,
    createdAt: user.createdAt,
  };
}
