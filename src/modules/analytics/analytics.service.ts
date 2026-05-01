import { BadRequestException, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { AnalyticsRepository, PerStaffStats } from './analytics.repository';
import { LocationsService } from '../locations/locations.service';

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly repo: AnalyticsRepository,
    private readonly locations: LocationsService,
  ) {}

  /**
   * Distribution report: hours assigned per staff member across [start, end).
   * Includes per-staff fairness metrics (premium share, deviation from desired hours).
   * Only managers/admins can request this; manager scope is enforced via location id.
   */
  async distribution(
    actor: { sub: string; role: Role },
    args: { start: Date; end: Date; locationId?: string },
  ) {
    if (args.start >= args.end) throw new BadRequestException('Invalid date range');
    const scopeIds = await this.resolveLocationScope(actor, args.locationId);

    const rows = await this.repo.aggregatePerStaff(args.start, args.end, scopeIds);
    return this.scoreFairness(rows, args.start, args.end);
  }

  /**
   * Computes:
   *   - totalHours per user
   *   - premium share per user (premiumHours / totalHours)
   *   - org-wide premium-share mean
   *   - per-user fairness score (1 - |userPremiumShare - mean| capped at 1, then 0..100)
   *   - over/under-scheduled flag vs desiredWeeklyHours scaled by range weeks
   */
  private scoreFairness(rows: PerStaffStats[], start: Date, end: Date) {
    const weeks = Math.max(1, (end.getTime() - start.getTime()) / (7 * 24 * 3_600_000));
    const totalPremium = rows.reduce((s, r) => s + r.premiumHours, 0);
    const totalHours = rows.reduce((s, r) => s + r.totalHours, 0);
    const orgPremiumShare = totalHours > 0 ? totalPremium / totalHours : 0;

    const enriched = rows.map((r) => {
      const userPremiumShare = r.totalHours > 0 ? r.premiumHours / r.totalHours : 0;
      const deviation = Math.abs(userPremiumShare - orgPremiumShare);
      const fairnessScore = Math.round(Math.max(0, 1 - deviation) * 100);
      const desiredOverWindow = r.desiredWeeklyHours != null ? r.desiredWeeklyHours * weeks : null;
      const variance = desiredOverWindow != null ? r.totalHours - desiredOverWindow : null;
      let scheduleStatus: 'UNDER' | 'ON_TARGET' | 'OVER' | 'UNKNOWN' = 'UNKNOWN';
      if (variance != null && desiredOverWindow != null) {
        // ±10% tolerance band
        const tol = Math.max(2, desiredOverWindow * 0.1);
        if (variance < -tol) scheduleStatus = 'UNDER';
        else if (variance > tol) scheduleStatus = 'OVER';
        else scheduleStatus = 'ON_TARGET';
      }
      return {
        ...r,
        userPremiumShare: round4(userPremiumShare),
        fairnessScore,
        desiredHoursForWindow: desiredOverWindow != null ? round2(desiredOverWindow) : null,
        scheduleVariance: variance != null ? round2(variance) : null,
        scheduleStatus,
      };
    });

    return {
      window: { start, end, weeks: round2(weeks) },
      org: {
        totalHours: round2(totalHours),
        totalPremiumHours: round2(totalPremium),
        premiumShare: round4(orgPremiumShare),
        staffCount: rows.length,
      },
      staff: enriched.sort((a, b) => b.totalHours - a.totalHours),
    };
  }
  /**
   * Weekly overtime projection. For each EMPLOYEE in scope, computes total
   * scheduled hours for the week containing `weekContaining`, flags users at
   * 35h+ (approaching) and 40h+ (overtime), and lists the specific shift
   * assignments that pushed them past the 40h threshold (in chronological
   * order — the first assignment whose cumulative total exceeds 40h is the
   * "tipping" shift).
   */
  async overtimeProjection(
    actor: { sub: string; role: Role },
    args: { weekContaining: Date; locationId?: string },
  ) {
    const scopeIds = await this.resolveLocationScope(actor, args.locationId);
    // Sunday-start week (matches validator)
    const start = new Date(args.weekContaining);
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay());
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);

    const rows = await this.repo.aggregatePerStaff(start, end, scopeIds);

    // For users at/over 35h, fetch the shift assignments in order to identify
    // the assignment that crosses 40h.
    const flagged = rows.filter((r) => r.totalHours >= 35);
    const details = await Promise.all(
      flagged.map((r) => this.tippingAssignment(r.userId, start, end, scopeIds)),
    );
    const detailsByUser = new Map(details.filter((d) => d).map((d) => [d!.userId, d!]));

    return {
      window: { start, end },
      staff: rows
        .map((r) => ({
          ...r,
          status:
            r.totalHours >= 40
              ? ('OVERTIME' as const)
              : r.totalHours >= 35
              ? ('APPROACHING' as const)
              : ('OK' as const),
          tippingAssignment: detailsByUser.get(r.userId)?.tipping ?? null,
        }))
        .sort((a, b) => b.totalHours - a.totalHours),
    };
  }

  private async tippingAssignment(
    userId: string,
    start: Date,
    end: Date,
    locationIds?: readonly string[],
  ): Promise<{ userId: string; tipping: { shiftId: string; startsAt: Date; endsAt: Date; cumulativeHours: number } | null } | null> {
    const list = await this.repo.listUserAssignmentsInRange(userId, start, end, locationIds);

    let cum = 0;
    for (const a of list) {
      const oStart = a.startsAt < start ? start : a.startsAt;
      const oEnd = a.endsAt > end ? end : a.endsAt;
      const hrs = Math.max(0, (oEnd.getTime() - oStart.getTime()) / 3_600_000);
      cum += hrs;
      if (cum > 40) {
        return {
          userId,
          tipping: {
            shiftId: a.shiftId,
            startsAt: a.startsAt,
            endsAt: a.endsAt,
            cumulativeHours: round2(cum),
          },
        };
      }
    }
    return { userId, tipping: null };
  }

  /**
   * Resolves the location scope for a report request:
   *  • ADMIN: if locationId is provided, scoped to it; else org-wide (undefined).
   *  • MANAGER: if locationId is provided, must be one they manage (403 if not);
   *    if omitted, auto-scopes to all locations they manage. Returns an empty
   *    array (which will produce an empty report) if the manager has no
   *    locations assigned — this prevents leakage of org-wide data.
   *  • Other roles: ForbiddenException is raised by the controller's role guard
   *    before reaching this code.
   */
  private async resolveLocationScope(
    actor: { sub: string; role: Role },
    locationId: string | undefined,
  ): Promise<readonly string[] | undefined> {
    if (actor.role === Role.ADMIN) {
      return locationId ? [locationId] : undefined;
    }
    if (actor.role === Role.MANAGER) {
      if (locationId) {
        await this.locations.assertCanManageLocation(actor, locationId);
        return [locationId];
      }
      const managed = await this.locations.listManagedLocationIds(actor.sub);
      // Empty array intentionally produces an empty report rather than org-wide.
      return managed;
    }
    return undefined;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
