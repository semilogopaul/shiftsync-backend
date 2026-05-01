/**
 * ShiftSync — Prisma seed
 *
 * Idempotent. Provisions:
 *   • 4 Coastal Eats locations across 2 timezones (review.txt §Business Context)
 *   • 4 example skills mentioned in review.txt
 *   • 1 admin, 2 managers (each scoped to 2 locations), 8 employees
 *   • Manager <-> Location assignments
 *   • Per-employee certifications + skills (some employees cross-certified)
 *   • Recurring weekly availability windows (Mon-Fri, with one weekend warrior)
 *
 * Re-running is safe: every upsert is keyed on a natural unique constraint.
 *
 * Run: `npx prisma db seed`
 */
import 'dotenv/config';
import {
  PrismaClient,
  Role,
  ShiftStatus,
  SwapStatus,
  DropStatus,
  ClockEventType,
  NotificationType,
} from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';
import { DateTime } from 'luxon';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SEED_PASSWORD = 'Password!23Secure';

// ─── Locations ──────────────────────────────────────────────────────────
const LOCATIONS = [
  {
    key: 'SM',
    name: 'Coastal Eats — Santa Monica',
    timezone: 'America/Los_Angeles',
    address: '1500 Ocean Ave, Santa Monica, CA',
  },
  {
    key: 'SD',
    name: 'Coastal Eats — San Diego',
    timezone: 'America/Los_Angeles',
    address: '850 Harbor Dr, San Diego, CA',
  },
  {
    key: 'BK',
    name: 'Coastal Eats — Brooklyn',
    timezone: 'America/New_York',
    address: '120 Water St, Brooklyn, NY',
  },
  {
    key: 'BO',
    name: 'Coastal Eats — Boston',
    timezone: 'America/New_York',
    address: '40 Atlantic Ave, Boston, MA',
  },
] as const;

// ─── Skills ─────────────────────────────────────────────────────────────
const SKILLS = ['Bartender', 'Line cook', 'Server', 'Host'] as const;

// ─── Accounts ───────────────────────────────────────────────────────────
type Acct = {
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
  desiredWeeklyHours?: number;
  preferredTimezone?: string;
  // Managers: locations they run.
  manages?: ReadonlyArray<(typeof LOCATIONS)[number]['key']>;
  // Employees: locations they're certified at + skills per location.
  certs?: ReadonlyArray<{
    location: (typeof LOCATIONS)[number]['key'];
    skills: ReadonlyArray<(typeof SKILLS)[number]>;
  }>;
  // Employees: recurring weekly availability (in their preferred tz).
  availability?: ReadonlyArray<{
    days: ReadonlyArray<number>; // 0=Sun..6=Sat
    startMinute: number;
    endMinute: number;
  }>;
};

const ACCOUNTS: ReadonlyArray<Acct> = [
  // Admin
  {
    email: 'admin@coastal.test',
    firstName: 'Jordan',
    lastName: 'Blake',
    role: Role.ADMIN,
    preferredTimezone: 'America/Los_Angeles',
  },

  // Managers
  {
    email: 'manager.west@coastal.test',
    firstName: 'Maya',
    lastName: 'Reyes',
    role: Role.MANAGER,
    manages: ['SM', 'SD'],
    preferredTimezone: 'America/Los_Angeles',
  },
  {
    email: 'manager.east@coastal.test',
    firstName: 'Daniel',
    lastName: "O'Brien",
    role: Role.MANAGER,
    manages: ['BK', 'BO'],
    preferredTimezone: 'America/New_York',
  },

  // Employees (8) — covering all 4 locations with some cross-certified.
  {
    email: 'alice@coastal.test',
    firstName: 'Alice',
    lastName: 'Nguyen',
    role: Role.EMPLOYEE,
    desiredWeeklyHours: 32,
    preferredTimezone: 'America/Los_Angeles',
    certs: [
      { location: 'SM', skills: ['Bartender', 'Server'] },
      { location: 'SD', skills: ['Bartender'] }, // cross-location (Pacific)
    ],
    availability: [
      { days: [1, 2, 3, 4, 5], startMinute: 9 * 60, endMinute: 17 * 60 },
    ],
  },
  {
    email: 'bob@coastal.test',
    firstName: 'Bob',
    lastName: 'Martinez',
    role: Role.EMPLOYEE,
    desiredWeeklyHours: 40,
    preferredTimezone: 'America/Los_Angeles',
    certs: [{ location: 'SM', skills: ['Line cook', 'Host'] }],
    availability: [
      { days: [1, 2, 3, 4, 5], startMinute: 8 * 60, endMinute: 16 * 60 },
      { days: [6], startMinute: 16 * 60, endMinute: 23 * 60 + 59 }, // Sat evening
    ],
  },
  {
    email: 'carol@coastal.test',
    firstName: 'Carol',
    lastName: 'Patel',
    role: Role.EMPLOYEE,
    desiredWeeklyHours: 24,
    preferredTimezone: 'America/Los_Angeles',
    certs: [{ location: 'SD', skills: ['Server', 'Host'] }],
    availability: [
      { days: [3, 4, 5, 6], startMinute: 16 * 60, endMinute: 23 * 60 },
    ], // Wed-Sat evenings
  },
  {
    email: 'david@coastal.test',
    firstName: 'David',
    lastName: 'Kim',
    role: Role.EMPLOYEE,
    desiredWeeklyHours: 35,
    preferredTimezone: 'America/Los_Angeles',
    certs: [{ location: 'SD', skills: ['Bartender', 'Line cook'] }],
    availability: [
      { days: [0, 1, 2, 3, 4], startMinute: 17 * 60, endMinute: 23 * 60 + 59 },
    ], // overnight-friendly
  },
  {
    email: 'erin@coastal.test',
    firstName: 'Erin',
    lastName: 'Walsh',
    role: Role.EMPLOYEE,
    desiredWeeklyHours: 40,
    preferredTimezone: 'America/New_York',
    certs: [
      { location: 'BK', skills: ['Bartender', 'Server'] },
      { location: 'BO', skills: ['Server'] }, // cross-location (Eastern)
    ],
    availability: [
      { days: [1, 2, 3, 4, 5], startMinute: 11 * 60, endMinute: 19 * 60 },
    ],
  },
  {
    email: 'frank@coastal.test',
    firstName: 'Frank',
    lastName: 'Iyer',
    role: Role.EMPLOYEE,
    desiredWeeklyHours: 32,
    preferredTimezone: 'America/New_York',
    certs: [{ location: 'BK', skills: ['Line cook', 'Host'] }],
    availability: [
      { days: [2, 3, 4, 5, 6], startMinute: 12 * 60, endMinute: 20 * 60 },
    ],
  },
  {
    email: 'grace@coastal.test',
    firstName: 'Grace',
    lastName: 'Adeyemi',
    role: Role.EMPLOYEE,
    desiredWeeklyHours: 28,
    preferredTimezone: 'America/New_York',
    certs: [{ location: 'BO', skills: ['Bartender', 'Server'] }],
    availability: [
      { days: [4, 5, 6], startMinute: 17 * 60, endMinute: 23 * 60 + 59 },
    ], // Fri-Sun nights (premium-shift heavy)
  },
  {
    email: 'henry@coastal.test',
    firstName: 'Henry',
    lastName: 'Schmidt',
    role: Role.EMPLOYEE,
    desiredWeeklyHours: 36,
    preferredTimezone: 'America/New_York',
    certs: [{ location: 'BO', skills: ['Line cook', 'Host'] }],
    availability: [
      { days: [1, 2, 3, 4, 5], startMinute: 8 * 60, endMinute: 16 * 60 },
    ],
  },
];

async function main() {
  // 1) Locations
  const locByKey = new Map<string, string>();
  for (const loc of LOCATIONS) {
    const row = await prisma.location.upsert({
      where: { name: loc.name },
      update: { timezone: loc.timezone, address: loc.address, isActive: true },
      create: { name: loc.name, timezone: loc.timezone, address: loc.address },
    });
    locByKey.set(loc.key, row.id);
  }

  // 2) Skills
  const skillByName = new Map<string, string>();
  for (const name of SKILLS) {
    const row = await prisma.skill.upsert({
      where: { name },
      update: {},
      create: { name },
    });
    skillByName.set(name, row.id);
  }

  // 3) Accounts (shared password hash)
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
  const userByEmail = new Map<string, string>();
  for (const acc of ACCOUNTS) {
    const row = await prisma.user.upsert({
      where: { email: acc.email },
      update: {
        firstName: acc.firstName,
        lastName: acc.lastName,
        role: acc.role,
        emailVerified: true,
        isActive: true,
        desiredWeeklyHours: acc.desiredWeeklyHours ?? null,
        preferredTimezone: acc.preferredTimezone ?? null,
      },
      create: {
        email: acc.email,
        passwordHash,
        firstName: acc.firstName,
        lastName: acc.lastName,
        role: acc.role,
        emailVerified: true,
        isActive: true,
        desiredWeeklyHours: acc.desiredWeeklyHours ?? null,
        preferredTimezone: acc.preferredTimezone ?? null,
      },
    });
    userByEmail.set(acc.email, row.id);
  }

  // 4) Manager <-> Location assignments
  for (const acc of ACCOUNTS) {
    if (acc.role !== Role.MANAGER || !acc.manages) continue;
    const userId = userByEmail.get(acc.email)!;
    for (const locKey of acc.manages) {
      const locationId = locByKey.get(locKey)!;
      await prisma.locationManager.upsert({
        where: { userId_locationId: { userId, locationId } },
        update: {},
        create: { userId, locationId },
      });
    }
  }

  // 5) Certifications + skill links
  for (const acc of ACCOUNTS) {
    if (!acc.certs) continue;
    const userId = userByEmail.get(acc.email)!;
    for (const cert of acc.certs) {
      const locationId = locByKey.get(cert.location)!;
      const certRow = await prisma.certification.upsert({
        where: { userId_locationId: { userId, locationId } },
        update: { decertifiedAt: null },
        create: { userId, locationId },
      });
      for (const skillName of cert.skills) {
        const skillId = skillByName.get(skillName)!;
        await prisma.certificationSkill.upsert({
          where: {
            certificationId_skillId: { certificationId: certRow.id, skillId },
          },
          update: {},
          create: { certificationId: certRow.id, skillId },
        });
      }
    }
  }

  // 6) Recurring availability — wipe & re-create per user (idempotent without
  //    a natural unique key on Availability).
  for (const acc of ACCOUNTS) {
    if (!acc.availability) continue;
    const userId = userByEmail.get(acc.email)!;
    const tz = acc.preferredTimezone ?? 'UTC';
    await prisma.availability.deleteMany({ where: { userId } });
    for (const win of acc.availability) {
      for (const day of win.days) {
        await prisma.availability.create({
          data: {
            userId,
            dayOfWeek: day,
            startMinute: win.startMinute,
            endMinute: win.endMinute,
            timezone: tz,
          },
        });
      }
    }
  }

  console.log(
    `[seed] OK — locations=${LOCATIONS.length} skills=${SKILLS.length} accounts=${ACCOUNTS.length}`,
  );

  console.log(`[seed] All accounts share password: ${SEED_PASSWORD}`);

  await seedAppData({ locByKey, skillByName, userByEmail });
}

// ─── App data ────────────────────────────────────────────────────────────────
// Generates 5 weeks of shifts (3 past, current week, next week), assignments,
// clock events for completed shifts, one pending swap, one open drop, and
// seeded notifications. Safe to re-run — deletes all shifts/notifications first.

async function seedAppData({
  locByKey,
  skillByName,
  userByEmail,
}: {
  locByKey: Map<string, string>;
  skillByName: Map<string, string>;
  userByEmail: Map<string, string>;
}) {
  // Clear app data. Delete clockEvents first (no cascade on Shift), then shift cascades the rest.
  await prisma.notification.deleteMany({});
  await prisma.clockEvent.deleteMany({});
  await prisma.shift.deleteMany({});

  const mgrWestId = userByEmail.get('manager.west@coastal.test')!;
  const mgrEastId = userByEmail.get('manager.east@coastal.test')!;

  const alice = userByEmail.get('alice@coastal.test')!;
  const bob = userByEmail.get('bob@coastal.test')!;
  const carol = userByEmail.get('carol@coastal.test')!;
  const david = userByEmail.get('david@coastal.test')!;
  const erin = userByEmail.get('erin@coastal.test')!;
  const frank = userByEmail.get('frank@coastal.test')!;
  const grace = userByEmail.get('grace@coastal.test')!;
  const henry = userByEmail.get('henry@coastal.test')!;

  const SM = locByKey.get('SM')!;
  const SD = locByKey.get('SD')!;
  const BK = locByKey.get('BK')!;
  const BO = locByKey.get('BO')!;

  const bartender = skillByName.get('Bartender')!;
  const lineCook = skillByName.get('Line cook')!;
  const server = skillByName.get('Server')!;
  const host = skillByName.get('Host')!;

  // "now" is Thu May 1, 2026 at 7 pm ET / 4 pm PT — evening shifts are underway.
  const NOW = new Date('2026-05-01T23:00:00Z');

  // Monday of the current week: Apr 28, 2026.
  const BASE_MONDAY = DateTime.fromISO('2026-04-28', { zone: 'UTC' });

  /** ISO date string (YYYY-MM-DD) for weekOffset × 7 + dayOffset (0=Mon). */
  function isoDate(weekOffset: number, dayOffset: number): string {
    return BASE_MONDAY.plus({
      weeks: weekOffset,
      days: dayOffset,
    }).toISODate()!;
  }

  /** UTC Date for a local time (startH) in a given IANA timezone on a date string. */
  function localToUTC(date: string, tz: string, hour: number): Date {
    return DateTime.fromISO(`${date}T${String(hour).padStart(2, '0')}:00:00`, {
      zone: tz,
    })
      .toUTC()
      .toJSDate();
  }

  type ShiftSpec = {
    locationId: string;
    tz: string;
    skillId: string;
    startH: number;
    durationH: number;
    isPremium: boolean;
    createdById: string;
    assignee: string | undefined;
    weekOffset: number;
    dayOffset: number; // 0=Mon..6=Sun
  };

  const specs: ShiftSpec[] = [];

  /** Adds shift specs for every combination of weekOffsets × dayOffsets. */
  function add(
    locationId: string,
    tz: string,
    createdById: string,
    skillId: string,
    startH: number,
    durationH: number,
    dayOffsets: number[],
    assignee: string | undefined,
    weekOffsets: number[],
    premiumDays: number[] = [],
  ) {
    for (const wo of weekOffsets) {
      for (const d of dayOffsets) {
        specs.push({
          locationId,
          tz,
          skillId,
          startH,
          durationH,
          isPremium: premiumDays.includes(d),
          createdById,
          assignee,
          weekOffset: wo,
          dayOffset: d,
        });
      }
    }
  }

  const ALL_WEEKS = [-3, -2, -1, 0, 1];
  const PT = 'America/Los_Angeles';
  const ET = 'America/New_York';

  // ─── Santa Monica (Pacific, Maya) ────────────────────────────────────────
  // Mon-Fri morning: Bob (Line cook)
  add(SM, PT, mgrWestId, lineCook, 8, 8, [0, 1, 2, 3, 4], bob, ALL_WEEKS);
  // Mon-Fri evening: Alice (Bartender). Friday is premium.
  add(
    SM,
    PT,
    mgrWestId,
    bartender,
    16,
    8,
    [0, 1, 2, 3, 4],
    alice,
    ALL_WEEKS,
    [4],
  );
  // Sat: Bob does Host evening (premium); unassigned Bartender slot (coverage gap for demo)
  add(SM, PT, mgrWestId, host, 16, 8, [5], bob, ALL_WEEKS, [5]);
  add(SM, PT, mgrWestId, bartender, 16, 8, [5], undefined, ALL_WEEKS, [5]);

  // ─── San Diego (Pacific, Maya) ────────────────────────────────────────────
  // Mon-Thu evening: David (Bartender). David's availability is Sun-Thu.
  add(SD, PT, mgrWestId, bartender, 16, 8, [0, 1, 2, 3], david, ALL_WEEKS);
  // Wed-Sat evening: Carol (Server). Fri/Sat are premium.
  add(SD, PT, mgrWestId, server, 16, 8, [2, 3, 4, 5], carol, ALL_WEEKS, [4, 5]);

  // ─── Brooklyn (Eastern, Daniel) ──────────────────────────────────────────
  // Mon-Fri evening: Erin (Bartender). Friday premium.
  add(
    BK,
    ET,
    mgrEastId,
    bartender,
    16,
    8,
    [0, 1, 2, 3, 4],
    erin,
    ALL_WEEKS,
    [4],
  );
  // Wed-Sun noon: Frank (Line cook). Fri/Sat premium.
  add(
    BK,
    ET,
    mgrEastId,
    lineCook,
    12,
    8,
    [2, 3, 4, 5, 6],
    frank,
    ALL_WEEKS,
    [4, 5],
  );

  // ─── Boston (Eastern, Daniel) ────────────────────────────────────────────
  // Mon-Fri morning: Henry (Line cook)
  add(BO, ET, mgrEastId, lineCook, 8, 8, [0, 1, 2, 3, 4], henry, ALL_WEEKS);
  // Fri-Sun evening: Grace (Bartender). Fri/Sat premium. Duration 8h (ends 1 am next day)
  add(BO, ET, mgrEastId, bartender, 17, 8, [4, 5, 6], grace, ALL_WEEKS, [4, 5]);
  // Mon-Thu evening: unassigned Server slot (visible coverage gap on schedule)
  add(BO, ET, mgrEastId, server, 16, 8, [0, 1, 2, 3], undefined, ALL_WEEKS);

  // ─── Create shifts + assignments + clock events ──────────────────────────
  let shiftCount = 0;
  let clockCount = 0;

  // Track shift ids for swap/drop anchoring
  let carolFriMay2ShiftId: string | undefined;
  let bobSatMay3ShiftId: string | undefined;

  for (const s of specs) {
    const date = isoDate(s.weekOffset, s.dayOffset);
    const startsAt = localToUTC(date, s.tz, s.startH);
    const endsAt = new Date(startsAt.getTime() + s.durationH * 3_600_000);

    const isCompleted = endsAt <= NOW;
    const isOngoing = startsAt <= NOW && endsAt > NOW;
    const isDraft = s.weekOffset === 1;

    const shift = await prisma.shift.create({
      data: {
        locationId: s.locationId,
        skillId: s.skillId,
        startsAt,
        endsAt,
        headcount: 1,
        isPremium: s.isPremium,
        status: isDraft ? ShiftStatus.DRAFT : ShiftStatus.PUBLISHED,
        publishedAt: isDraft
          ? null
          : new Date(startsAt.getTime() - 7 * 24 * 3_600_000),
        createdById: s.createdById,
        version: 0,
      },
    });
    shiftCount++;

    if (s.assignee) {
      await prisma.shiftAssignment.create({
        data: {
          shiftId: shift.id,
          userId: s.assignee,
          assignedById: s.createdById,
        },
      });

      if (isCompleted) {
        await prisma.clockEvent.createMany({
          data: [
            {
              shiftId: shift.id,
              userId: s.assignee,
              type: ClockEventType.CLOCK_IN,
              occurredAt: new Date(startsAt.getTime() + 2 * 60_000),
            },
            {
              shiftId: shift.id,
              userId: s.assignee,
              type: ClockEventType.CLOCK_OUT,
              occurredAt: new Date(endsAt.getTime() - 5 * 60_000),
            },
          ],
        });
        clockCount += 2;
      } else if (isOngoing) {
        await prisma.clockEvent.create({
          data: {
            shiftId: shift.id,
            userId: s.assignee,
            type: ClockEventType.CLOCK_IN,
            occurredAt: new Date(startsAt.getTime() + 3 * 60_000),
          },
        });
        clockCount++;
      }
    }

    // Anchor references for swap/drop
    if (date === '2026-05-02' && s.locationId === SD && s.assignee === carol)
      carolFriMay2ShiftId = shift.id;
    if (date === '2026-05-03' && s.locationId === SM && s.assignee === bob)
      bobSatMay3ShiftId = shift.id;
  }

  // ─── Pending swap: Carol wants to swap her SD Fri May 2 shift with David ─
  // (David is Bartender at SD; shift is Server — manager will see a finding on approval.
  //  Good demo of the validation layer.)
  if (carolFriMay2ShiftId) {
    await prisma.swapRequest.create({
      data: {
        shiftId: carolFriMay2ShiftId,
        fromUserId: carol,
        toUserId: david,
        status: SwapStatus.PENDING_RECIPIENT,
        reason: 'Family event — need someone to cover my Fri evening slot.',
      },
    });
  }

  // ─── Open drop: Bob drops his SM Sat May 3 Host shift ───────────────────
  if (bobSatMay3ShiftId) {
    const satStart = localToUTC('2026-05-03', PT, 16);
    await prisma.dropRequest.create({
      data: {
        shiftId: bobSatMay3ShiftId,
        fromUserId: bob,
        status: DropStatus.OPEN,
        expiresAt: new Date(satStart.getTime() - 24 * 3_600_000), // 24h before shift
        reason: 'Personal commitment, looking for coverage.',
      },
    });
  }

  // ─── Notifications ───────────────────────────────────────────────────────
  const notifs = [
    {
      userId: mgrWestId,
      type: NotificationType.SWAP_REQUESTED,
      title: 'Swap request needs approval',
      body: 'Carol Patel has requested to swap her Fri May 2 shift at San Diego. Pending recipient acceptance.',
    },
    {
      userId: mgrWestId,
      type: NotificationType.DROP_REQUESTED,
      title: 'Shift dropped — coverage needed',
      body: 'Bob Martinez dropped his Sat May 3 Host shift at Santa Monica. It is now open for claims.',
    },
    {
      userId: mgrEastId,
      type: NotificationType.OVERTIME_WARNING,
      title: 'Overtime alert — Erin Walsh',
      body: 'Erin Walsh is projected to reach 40 hours this week across Brooklyn and Boston assignments.',
    },
    {
      userId: david,
      type: NotificationType.SWAP_REQUESTED,
      title: 'Swap request from Carol Patel',
      body: 'Carol Patel wants to swap her Fri May 2 SD Server shift with you. Please respond.',
    },
    {
      userId: carol,
      type: NotificationType.SHIFT_ASSIGNED,
      title: 'New shift assigned',
      body: 'You have been assigned a Server shift at San Diego on Fri May 2, 4:00 PM PT.',
    },
    {
      userId: alice,
      type: NotificationType.SCHEDULE_PUBLISHED,
      title: 'Schedule published — week of May 5',
      body: 'Your schedule for next week has been published. You are assigned Mon–Fri evenings at Santa Monica.',
    },
    {
      userId: henry,
      type: NotificationType.SHIFT_ASSIGNED,
      title: 'New shift assigned',
      body: 'You have been assigned a Line cook shift at Boston on Mon May 5, 8:00 AM ET.',
    },
    {
      userId: grace,
      type: NotificationType.SCHEDULE_PUBLISHED,
      title: 'Schedule published — week of May 5',
      body: 'You are assigned Friday, Saturday, and Sunday evenings at Boston next week.',
    },
  ];

  for (const n of notifs) {
    await prisma.notification.create({ data: n });
  }

  console.log(
    `[seed-app] shifts=${shiftCount} clockEvents=${clockCount} swap=1 drop=1 notifications=${notifs.length}`,
  );
}

main()
  .catch((err) => {
    console.error('[seed] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
