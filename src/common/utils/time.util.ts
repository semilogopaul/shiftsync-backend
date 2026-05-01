import { DateTime, IANAZone, Interval } from 'luxon';

/**
 * Timezone-aware utilities. ALL date math must go through this module —
 * NEVER use raw `Date.toLocaleString()` or naive arithmetic.
 *
 * Convention:
 *   • All times are stored as UTC `Date` in DB.
 *   • All times displayed are projected into the location's tz.
 *   • Recurring availability windows are stored as (dayOfWeek, startMinute,
 *     endMinute, tz). They are projected onto a real date to handle DST.
 */

export const UTC = 'UTC';

export function isValidIanaTz(tz: string): boolean {
  return IANAZone.isValidZone(tz);
}

export function toUtc(date: Date | string): Date {
  return DateTime.fromJSDate(typeof date === 'string' ? new Date(date) : date, { zone: UTC }).toJSDate();
}

/** Convert a UTC `Date` into a Luxon DateTime in the given IANA tz. */
export function inZone(utc: Date, tz: string): DateTime {
  return DateTime.fromJSDate(utc, { zone: UTC }).setZone(tz);
}

/** True if two [start,end) intervals overlap (touching endpoints don't count). */
export function intervalsOverlap(a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

export function makeInterval(startsAt: Date, endsAt: Date): Interval {
  return Interval.fromDateTimes(
    DateTime.fromJSDate(startsAt, { zone: UTC }),
    DateTime.fromJSDate(endsAt, { zone: UTC }),
  );
}

/** Shift duration in hours (handles overnight shifts naturally). */
export function durationHours(startsAt: Date, endsAt: Date): number {
  return (endsAt.getTime() - startsAt.getTime()) / (1000 * 60 * 60);
}

/** Gap in hours between two non-overlapping shifts (later.startsAt - earlier.endsAt). */
export function gapHours(a: { startsAt: Date; endsAt: Date }, b: { startsAt: Date; endsAt: Date }): number {
  const earlier = a.endsAt <= b.startsAt ? a : b;
  const later = earlier === a ? b : a;
  return (later.startsAt.getTime() - earlier.endsAt.getTime()) / (1000 * 60 * 60);
}

/**
 * Project a recurring weekly window (dayOfWeek/startMinute/endMinute in tz)
 * onto a UTC interval covering [windowStart, windowEnd]. Returns concrete
 * UTC intervals each instance of the window covers within the search range.
 *
 * Handles overnight (endMinute <= startMinute) and DST automatically because
 * luxon does the local-time → UTC conversion using the actual zone rules
 * for that calendar date.
 */
export function expandWeeklyWindow(
  weekly: { dayOfWeek: number; startMinute: number; endMinute: number; timezone: string },
  windowStart: Date,
  windowEnd: Date,
): Array<{ startsAt: Date; endsAt: Date }> {
  const tz = weekly.timezone;
  if (!isValidIanaTz(tz)) return [];

  // Luxon weekday: 1=Mon..7=Sun. We use 0=Sun..6=Sat. Convert.
  const targetLuxonWeekday = weekly.dayOfWeek === 0 ? 7 : weekly.dayOfWeek;

  const overnight = weekly.endMinute <= weekly.startMinute;

  // Walk day-by-day in the location's tz so DST is honoured per-day.
  const startLocal = DateTime.fromJSDate(windowStart, { zone: UTC }).setZone(tz).startOf('day');
  const endLocal = DateTime.fromJSDate(windowEnd, { zone: UTC }).setZone(tz).endOf('day');

  const out: Array<{ startsAt: Date; endsAt: Date }> = [];
  let cursor = startLocal;
  while (cursor <= endLocal) {
    if (cursor.weekday === targetLuxonWeekday) {
      const start = cursor.plus({ minutes: weekly.startMinute });
      const end = overnight
        ? cursor.plus({ days: 1, minutes: weekly.endMinute })
        : cursor.plus({ minutes: weekly.endMinute });
      const startsAtUtc = start.toUTC().toJSDate();
      const endsAtUtc = end.toUTC().toJSDate();
      // Clip to search window
      if (endsAtUtc > windowStart && startsAtUtc < windowEnd) {
        out.push({ startsAt: startsAtUtc, endsAt: endsAtUtc });
      }
    }
    cursor = cursor.plus({ days: 1 });
  }
  return out;
}

/** True if [child] is fully contained within any of [parents]. */
export function containedInAny(
  child: { startsAt: Date; endsAt: Date },
  parents: Array<{ startsAt: Date; endsAt: Date }>,
): boolean {
  return parents.some((p) => p.startsAt <= child.startsAt && p.endsAt >= child.endsAt);
}

/** True if [child] overlaps with any of [intervals]. */
export function overlapsAny(
  child: { startsAt: Date; endsAt: Date },
  intervals: Array<{ startsAt: Date; endsAt: Date }>,
): boolean {
  return intervals.some((i) => intervalsOverlap(child, i));
}

/** Local week start (configurable; we use Sunday as week-start, US convention). */
export function startOfLocalWeek(utc: Date, tz: string): Date {
  // Luxon weeks start Monday. We shift by 1 to get Sun-start weeks.
  const local = DateTime.fromJSDate(utc, { zone: UTC }).setZone(tz);
  const sunday = local.startOf('week').minus({ days: 1 });
  return sunday.toUTC().toJSDate();
}

/** Returns the local calendar date (yyyy-MM-dd) of a UTC instant in the given tz. */
export function localDateKey(utc: Date, tz: string): string {
  return DateTime.fromJSDate(utc, { zone: UTC }).setZone(tz).toFormat('yyyy-LL-dd');
}

/** Convenience: format a UTC Date as ISO with offset for the location's tz. */
export function formatInZone(utc: Date, tz: string, format = "yyyy-LL-dd HH:mm ZZZZ"): string {
  return DateTime.fromJSDate(utc, { zone: UTC }).setZone(tz).toFormat(format);
}

/** True if a shift's start/end qualifies as "premium" (Fri or Sat evening, local). */
export function isPremiumShift(startsAt: Date, locationTz: string): boolean {
  const local = DateTime.fromJSDate(startsAt, { zone: UTC }).setZone(locationTz);
  // Luxon: 5=Fri, 6=Sat. Evening = local hour >= 17.
  const isFriOrSat = local.weekday === 5 || local.weekday === 6;
  return isFriOrSat && local.hour >= 17;
}
