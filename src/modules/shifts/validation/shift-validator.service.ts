import { Injectable } from '@nestjs/common';
import { Role, Shift, ShiftAssignment, ShiftStatus } from '@prisma/client';
import { DateTime } from 'luxon';

import { ShiftsRepository } from '../shifts.repository';
import { CertificationsRepository } from '../../certifications/certifications.repository';
import { AvailabilityService } from '../../availability/availability.service';
import { UserRepository } from '../../users/users.repository';
import { LocationsRepository } from '../../locations/locations.repository';
import {
  durationHours,
  intervalsOverlap,
  startOfLocalWeek,
} from '../../../common/utils/time.util';

/**
 * Codes used to identify validation outcomes. Errors prefixed `E_` block
 * assignment unless explicitly overridable. Warnings prefixed `W_` are
 * informational.
 */
export type ValidationCode =
  | 'E_DOUBLE_BOOK'
  | 'E_REST_10H'
  | 'E_SKILL_MISSING'
  | 'E_LOCATION_CERT'
  | 'E_AVAILABILITY'
  | 'E_DAILY_OVER_12'
  | 'E_CONSECUTIVE_7'
  | 'W_DAILY_OVER_8'
  | 'W_WEEKLY_APPROACHING_40'
  | 'W_WEEKLY_OVER_40'
  | 'W_CONSECUTIVE_6';

export interface ValidationFinding {
  code: ValidationCode;
  message: string;
  severity: 'error' | 'warning';
  /** True if a manager override + reason can bypass this finding. */
  overridable: boolean;
  data?: Record<string, unknown>;
}

/**
 * Public alternative-staff payload returned alongside a failed validation.
 * Mirrors the frontend `AlternativeStaff` shape: a full user summary plus a
 * list of human-readable reasons explaining why this candidate is suggested.
 */
export interface AlternativeSuggestion {
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    role: string;
  };
  reasons: string[];
}

export interface ValidationResult {
  ok: boolean; // ok = no non-overridden errors
  errors: ValidationFinding[];
  warnings: ValidationFinding[];
  suggestions?: AlternativeSuggestion[];
  /**
   * Numeric projections describing the user's totals if the shift were
   * assigned. Surfaced to the UI so the assign panel can render a
   * "what-if" summary without parsing finding messages.
   */
  projection?: AssignmentProjection;
}

/**
 * Projected totals if the candidate user were assigned the shift. All values
 * include the proposed shift in their counts (i.e. `projectedWeeklyHours`
 * already adds the shift's duration, `projectedConsecutiveDays` already
 * counts the shift's day).
 */
export interface AssignmentProjection {
  /** Hours the user would work on the shift's local day, including the proposed shift. */
  projectedDailyHours: number;
  /** Hours the user would work in the shift's local Sunday-start week, including the proposed shift. */
  projectedWeeklyHours: number;
  /** Longest consecutive-day streak that includes the shift's local day, including the proposed shift. */
  projectedConsecutiveDays: number;
}

/**
 * Frontend-facing assignment preview envelope. The UI consumes this exact
 * shape from `POST /shifts/:id/assignments/preview`,
 * `POST /shifts/:id/validate-assignment`, and from the `details` field of the
 * `422 E_VALIDATION` error thrown when an assignment is rejected.
 */
export interface AssignmentPreview {
  ok: boolean;
  findings: ValidationFinding[];
  alternatives: AlternativeSuggestion[];
  projection?: AssignmentProjection;
}

/** True when the finding is bypassable with a manager override + reason. */
export const isOverridableCode = (code: ValidationCode): boolean =>
  OVERRIDABLE.has(code);

/** A code is overridable only if the requirements explicitly call for it. */
const OVERRIDABLE: ReadonlySet<ValidationCode> = new Set<ValidationCode>([
  'E_CONSECUTIVE_7',
]);

@Injectable()
export class ShiftValidatorService {
  constructor(
    private readonly shifts: ShiftsRepository,
    private readonly certs: CertificationsRepository,
    private readonly availability: AvailabilityService,
    private readonly users: UserRepository,
    private readonly locations: LocationsRepository,
  ) {}

  /**
   * Validate assigning `userId` to `shift`. Pure (within the bounds of DB
   * reads). Does not write. Override is honoured when `overrideUsed=true`
   * AND `overrideReason` is non-empty AND the failing code is overridable.
   */
  async validateAssignment(
    userId: string,
    shift: Shift,
    options: { overrideUsed?: boolean; overrideReason?: string } = {},
  ): Promise<ValidationResult> {
    const errors: ValidationFinding[] = [];
    const warnings: ValidationFinding[] = [];

    const user = await this.users.findById(userId);
    if (!user || !user.isActive) {
      errors.push({
        code: 'E_LOCATION_CERT',
        message: 'User does not exist or is inactive',
        severity: 'error',
        overridable: false,
      });
      return { ok: false, errors, warnings };
    }

    const location = await this.locations.findById(shift.locationId);
    if (!location) {
      errors.push({
        code: 'E_LOCATION_CERT',
        message: 'Shift location not found',
        severity: 'error',
        overridable: false,
      });
      return { ok: false, errors, warnings };
    }
    const tz = location.timezone;

    // ── Rule: skill + location certification ─────────────────────────
    const cert = await this.certs.findActiveForUserLocation(userId, shift.locationId);
    if (!cert) {
      errors.push({
        code: 'E_LOCATION_CERT',
        message: `User is not certified to work at ${location.name}`,
        severity: 'error',
        overridable: false,
      });
    } else {
      const hasSkill = cert.skills.some((s) => s.skillId === shift.skillId);
      if (!hasSkill) {
        errors.push({
          code: 'E_SKILL_MISSING',
          message: 'User does not possess the skill required for this shift',
          severity: 'error',
          overridable: false,
        });
      }
    }

    // ── Rule: availability ───────────────────────────────────────────
    const availabilityCheck = await this.availability.isUserAvailable(
      userId,
      shift.startsAt,
      shift.endsAt,
    );
    if (!availabilityCheck.available) {
      errors.push({
        code: 'E_AVAILABILITY',
        message: availabilityCheck.reason ?? 'User is not available for this time',
        severity: 'error',
        overridable: false,
      });
    }

    // ── Rule: double-booking + 10h rest ──────────────────────────────
    // Look at conflicts in a window wide enough to cover 10h rest on either side.
    const restWindowStart = new Date(shift.startsAt.getTime() - 11 * 3600 * 1000);
    const restWindowEnd = new Date(shift.endsAt.getTime() + 11 * 3600 * 1000);
    const nearbyAssignments = await this.shifts.listAssignmentsForUserInRange(
      userId,
      restWindowStart,
      restWindowEnd,
      shift.id,
    );

    for (const a of nearbyAssignments) {
      if (intervalsOverlap(shift, a.shift)) {
        errors.push({
          code: 'E_DOUBLE_BOOK',
          message: `User is already assigned to an overlapping shift at this time`,
          severity: 'error',
          overridable: false,
          data: { conflictingShiftId: a.shift.id },
        });
        continue;
      }
      const earlierEnd = a.shift.endsAt <= shift.startsAt ? a.shift.endsAt : null;
      const laterStart = a.shift.startsAt >= shift.endsAt ? a.shift.startsAt : null;
      if (earlierEnd) {
        const gap = (shift.startsAt.getTime() - earlierEnd.getTime()) / (3600 * 1000);
        if (gap < 10) {
          errors.push({
            code: 'E_REST_10H',
            message: `Only ${gap.toFixed(1)}h rest before this shift; minimum is 10h`,
            severity: 'error',
            overridable: false,
            data: { conflictingShiftId: a.shift.id, gapHours: gap },
          });
        }
      } else if (laterStart) {
        const gap = (laterStart.getTime() - shift.endsAt.getTime()) / (3600 * 1000);
        if (gap < 10) {
          errors.push({
            code: 'E_REST_10H',
            message: `Only ${gap.toFixed(1)}h rest after this shift before next assignment; minimum is 10h`,
            severity: 'error',
            overridable: false,
            data: { conflictingShiftId: a.shift.id, gapHours: gap },
          });
        }
      }
    }

    // ── Rule: daily hours (in location-local day) ────────────────────
    const dayStartLocal = DateTime.fromJSDate(shift.startsAt, { zone: 'utc' })
      .setZone(tz)
      .startOf('day');
    const dayEndLocal = dayStartLocal.plus({ days: 1 });
    const dayShiftAssignments = await this.shifts.listAssignmentsForUserInRange(
      userId,
      dayStartLocal.toUTC().toJSDate(),
      dayEndLocal.toUTC().toJSDate(),
      shift.id,
    );
    let dailyHours = durationHours(shift.startsAt, shift.endsAt);
    for (const a of dayShiftAssignments) {
      dailyHours += durationHours(a.shift.startsAt, a.shift.endsAt);
    }
    if (dailyHours > 12) {
      errors.push({
        code: 'E_DAILY_OVER_12',
        message: `This assignment would put the user at ${dailyHours.toFixed(1)}h on this day; 12h is the hard limit`,
        severity: 'error',
        overridable: false,
        data: { dailyHours },
      });
    } else if (dailyHours > 8) {
      warnings.push({
        code: 'W_DAILY_OVER_8',
        message: `User would work ${dailyHours.toFixed(1)}h on this day (>8)`,
        severity: 'warning',
        overridable: false,
        data: { dailyHours },
      });
    }

    // ── Rule: weekly hours (Sunday-start, local tz) ──────────────────
    const weekStartUtc = startOfLocalWeek(shift.startsAt, tz);
    const weekEndUtc = new Date(weekStartUtc.getTime() + 7 * 86400 * 1000);
    const weekAssignments = await this.shifts.listAssignmentsForUserInRange(
      userId,
      weekStartUtc,
      weekEndUtc,
      shift.id,
    );
    let weeklyHours = durationHours(shift.startsAt, shift.endsAt);
    for (const a of weekAssignments) {
      weeklyHours += durationHours(a.shift.startsAt, a.shift.endsAt);
    }
    if (weeklyHours > 40) {
      warnings.push({
        code: 'W_WEEKLY_OVER_40',
        message: `User would total ${weeklyHours.toFixed(1)}h this week (over 40 — overtime)`,
        severity: 'warning',
        overridable: false,
        data: { weeklyHours },
      });
    } else if (weeklyHours >= 35) {
      warnings.push({
        code: 'W_WEEKLY_APPROACHING_40',
        message: `User would total ${weeklyHours.toFixed(1)}h this week (approaching 40)`,
        severity: 'warning',
        overridable: false,
        data: { weeklyHours },
      });
    }

    // ── Rule: consecutive days (same local week) ─────────────────────
    const consecutive = this.computeConsecutiveDays(
      [...weekAssignments.map((a) => a.shift), shift],
      tz,
      shift.startsAt,
    );
    if (consecutive >= 7) {
      errors.push({
        code: 'E_CONSECUTIVE_7',
        message: `Assigning this shift would make ${consecutive} consecutive days worked; manager override + reason required`,
        severity: 'error',
        overridable: true,
        data: { consecutiveDays: consecutive },
      });
    } else if (consecutive >= 6) {
      warnings.push({
        code: 'W_CONSECUTIVE_6',
        message: `User would work ${consecutive} consecutive days`,
        severity: 'warning',
        overridable: false,
        data: { consecutiveDays: consecutive },
      });
    }

    // ── Apply overrides ──────────────────────────────────────────────
    const remainingErrors = errors.filter((e) => {
      if (!OVERRIDABLE.has(e.code)) return true;
      const overridden =
        options.overrideUsed === true && (options.overrideReason ?? '').trim().length > 0;
      return !overridden;
    });

    return {
      ok: remainingErrors.length === 0,
      errors: remainingErrors,
      warnings,
      projection: {
        projectedDailyHours: Number(dailyHours.toFixed(2)),
        projectedWeeklyHours: Number(weeklyHours.toFixed(2)),
        projectedConsecutiveDays: consecutive,
      },
    };
  }

  /**
   * Compute the longest run of consecutive days in the local tz that
   * contains the day of `anchor`. Days are derived from each shift's
   * startsAt (a single shift counts once regardless of length per
   * documented decision).
   */
  private computeConsecutiveDays(shifts: Shift[], tz: string, anchor: Date): number {
    if (shifts.length === 0) return 0;
    const days = new Set<string>();
    for (const s of shifts) {
      const key = DateTime.fromJSDate(s.startsAt, { zone: 'utc' }).setZone(tz).toFormat('yyyy-LL-dd');
      days.add(key);
    }
    const anchorKey = DateTime.fromJSDate(anchor, { zone: 'utc' }).setZone(tz);
    // Walk backward then forward from the anchor day.
    let count = 1;
    let cursor = anchorKey.minus({ days: 1 });
    while (days.has(cursor.toFormat('yyyy-LL-dd'))) {
      count++;
      cursor = cursor.minus({ days: 1 });
    }
    cursor = anchorKey.plus({ days: 1 });
    while (days.has(cursor.toFormat('yyyy-LL-dd'))) {
      count++;
      cursor = cursor.plus({ days: 1 });
    }
    return count;
  }

  /**
   * Find up to `limit` alternative qualified+available users for the
   * given shift. "Qualified" means certified at the location with the
   * right skill. We then run a quick availability check.
   */
  async suggestAlternatives(shift: Shift, limit = 5): Promise<AlternativeSuggestion[]> {
    // Pull active EMPLOYEE candidates.
    const candidates = await this.users.findManyPaginated(
      { role: Role.EMPLOYEE, isActive: true },
      { skip: 0, take: 100 },
    );
    // Skip anyone already assigned to this shift.
    const alreadyOnShift = new Set(
      (
        await this.shifts.findById(shift.id).catch(() => null)
      )?.assignments.map((a) => a.userId) ?? [],
    );

    const suggestions: AlternativeSuggestion[] = [];
    for (const u of candidates.items) {
      if (suggestions.length >= limit) break;
      if (alreadyOnShift.has(u.id)) continue;
      const reasons: string[] = [];
      const cert = await this.certs.findActiveForUserLocation(u.id, shift.locationId);
      if (!cert) continue;
      reasons.push('certified for this location');
      if (!cert.skills.some((s) => s.skillId === shift.skillId)) continue;
      reasons.push('has the required skill');
      const av = await this.availability.isUserAvailable(u.id, shift.startsAt, shift.endsAt);
      if (!av.available) continue;
      reasons.push('available during this window');
      // Cheap conflict + 10h-rest check.
      const conflicts = await this.shifts.listAssignmentsForUserInRange(
        u.id,
        new Date(shift.startsAt.getTime() - 11 * 3600 * 1000),
        new Date(shift.endsAt.getTime() + 11 * 3600 * 1000),
        shift.id,
      );
      let blocked = false;
      for (const c of conflicts) {
        if (intervalsOverlap(shift, c.shift)) {
          blocked = true;
          break;
        }
        const earlierEnd = c.shift.endsAt <= shift.startsAt ? c.shift.endsAt : null;
        const laterStart = c.shift.startsAt >= shift.endsAt ? c.shift.startsAt : null;
        if (earlierEnd) {
          const gap = (shift.startsAt.getTime() - earlierEnd.getTime()) / (3600 * 1000);
          if (gap < 10) {
            blocked = true;
            break;
          }
        }
        if (laterStart) {
          const gap = (laterStart.getTime() - shift.endsAt.getTime()) / (3600 * 1000);
          if (gap < 10) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) continue;
      reasons.push('no conflict or rest violation');
      suggestions.push({
        user: {
          id: u.id,
          firstName: u.firstName,
          lastName: u.lastName,
          email: u.email,
          role: u.role,
        },
        reasons,
      });
    }
    return suggestions;
  }

  /**
   * Map a raw `ValidationResult` into the unified frontend-facing
   * `AssignmentPreview` envelope (flat findings list + alternatives).
   */
  toPreviewEnvelope(
    result: ValidationResult,
    alternatives: AlternativeSuggestion[] = [],
  ): AssignmentPreview {
    const findings: ValidationFinding[] = [
      ...result.errors.map((e) => ({ ...e, severity: 'error' as const })),
      ...result.warnings.map((w) => ({ ...w, severity: 'warning' as const })),
    ];
    return {
      ok: result.ok,
      findings,
      alternatives,
      projection: result.projection,
    };
  }

  /** Validate shift inputs (independent of any user). */
  validateShiftWindow(startsAt: Date, endsAt: Date): void {
    if (endsAt <= startsAt) {
      throw new Error('Shift end must be after start');
    }
    const len = durationHours(startsAt, endsAt);
    if (len > 24) {
      throw new Error('A single shift cannot exceed 24 hours');
    }
  }

  /** Used by services to detect conflicts on shift edits. */
  async findOverlappingAssignmentsForUser(
    userId: string,
    startsAt: Date,
    endsAt: Date,
    excludeShiftId?: string,
  ): Promise<ShiftAssignment[]> {
    const rows = await this.shifts.listAssignmentsForUserInRange(
      userId,
      startsAt,
      endsAt,
      excludeShiftId,
    );
    return rows.filter((a) => intervalsOverlap({ startsAt, endsAt }, a.shift));
  }

  /** Helper exposed for snapshot tests / dashboards. */
  static readonly ALL_CODES: readonly ValidationCode[] = [
    'E_DOUBLE_BOOK',
    'E_REST_10H',
    'E_SKILL_MISSING',
    'E_LOCATION_CERT',
    'E_AVAILABILITY',
    'E_DAILY_OVER_12',
    'E_CONSECUTIVE_7',
    'W_DAILY_OVER_8',
    'W_WEEKLY_APPROACHING_40',
    'W_WEEKLY_OVER_40',
    'W_CONSECUTIVE_6',
  ];
}

export { ShiftStatus };
