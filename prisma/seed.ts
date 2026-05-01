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
import { PrismaClient, Role } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import * as bcrypt from 'bcrypt';

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SEED_PASSWORD = 'Password!23Secure';

// ─── Locations ──────────────────────────────────────────────────────────
const LOCATIONS = [
  { key: 'SM', name: 'Coastal Eats — Santa Monica', timezone: 'America/Los_Angeles', address: '1500 Ocean Ave, Santa Monica, CA' },
  { key: 'SD', name: 'Coastal Eats — San Diego',    timezone: 'America/Los_Angeles', address: '850 Harbor Dr, San Diego, CA' },
  { key: 'BK', name: 'Coastal Eats — Brooklyn',     timezone: 'America/New_York',    address: '120 Water St, Brooklyn, NY' },
  { key: 'BO', name: 'Coastal Eats — Boston',       timezone: 'America/New_York',    address: '40 Atlantic Ave, Boston, MA' },
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
  manages?: ReadonlyArray<typeof LOCATIONS[number]['key']>;
  // Employees: locations they're certified at + skills per location.
  certs?: ReadonlyArray<{
    location: typeof LOCATIONS[number]['key'];
    skills: ReadonlyArray<typeof SKILLS[number]>;
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
    email: 'testadmin@coastal.test',
    firstName: 'Test',
    lastName: 'Admin',
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
    availability: [{ days: [1, 2, 3, 4, 5], startMinute: 9 * 60, endMinute: 17 * 60 }],
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
    availability: [{ days: [3, 4, 5, 6], startMinute: 16 * 60, endMinute: 23 * 60 }], // Wed-Sat evenings
  },
  {
    email: 'david@coastal.test',
    firstName: 'David',
    lastName: 'Kim',
    role: Role.EMPLOYEE,
    desiredWeeklyHours: 35,
    preferredTimezone: 'America/Los_Angeles',
    certs: [{ location: 'SD', skills: ['Bartender', 'Line cook'] }],
    availability: [{ days: [0, 1, 2, 3, 4], startMinute: 17 * 60, endMinute: 23 * 60 + 59 }], // overnight-friendly
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
    availability: [{ days: [1, 2, 3, 4, 5], startMinute: 11 * 60, endMinute: 19 * 60 }],
  },
  {
    email: 'frank@coastal.test',
    firstName: 'Frank',
    lastName: 'Iyer',
    role: Role.EMPLOYEE,
    desiredWeeklyHours: 32,
    preferredTimezone: 'America/New_York',
    certs: [{ location: 'BK', skills: ['Line cook', 'Host'] }],
    availability: [{ days: [2, 3, 4, 5, 6], startMinute: 12 * 60, endMinute: 20 * 60 }],
  },
  {
    email: 'grace@coastal.test',
    firstName: 'Grace',
    lastName: 'Adeyemi',
    role: Role.EMPLOYEE,
    desiredWeeklyHours: 28,
    preferredTimezone: 'America/New_York',
    certs: [{ location: 'BO', skills: ['Bartender', 'Server'] }],
    availability: [{ days: [4, 5, 6], startMinute: 17 * 60, endMinute: 23 * 60 + 59 }], // Fri-Sun nights (premium-shift heavy)
  },
  {
    email: 'henry@coastal.test',
    firstName: 'Henry',
    lastName: 'Schmidt',
    role: Role.EMPLOYEE,
    desiredWeeklyHours: 36,
    preferredTimezone: 'America/New_York',
    certs: [{ location: 'BO', skills: ['Line cook', 'Host'] }],
    availability: [{ days: [1, 2, 3, 4, 5], startMinute: 8 * 60, endMinute: 16 * 60 }],
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
    const row = await prisma.skill.upsert({ where: { name }, update: {}, create: { name } });
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
          where: { certificationId_skillId: { certificationId: certRow.id, skillId } },
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

  // eslint-disable-next-line no-console
  console.log(
    `[seed] OK — locations=${LOCATIONS.length} skills=${SKILLS.length} accounts=${ACCOUNTS.length}`,
  );
  // eslint-disable-next-line no-console
  console.log(`[seed] All accounts share password: ${SEED_PASSWORD}`);
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[seed] failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

