/**
 * ShiftSync — Prisma seed
 *
 * Idempotent. Provisions the fixed-by-spec data:
 *   • The 4 Coastal Eats locations across 2 timezones (review.txt)
 *   • The example skills mentioned in review.txt
 *   • The accounts listed in TEST_CASES.md (admin + 2 employees)
 *
 * Run with `npx prisma db seed` (wired via package.json `prisma.seed`).
 */
import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const LOCATIONS: ReadonlyArray<{ name: string; timezone: string; address?: string }> = [
  {
    name: 'Coastal Eats — Santa Monica',
    timezone: 'America/Los_Angeles',
    address: '1500 Ocean Ave, Santa Monica, CA',
  },
  {
    name: 'Coastal Eats — San Diego',
    timezone: 'America/Los_Angeles',
    address: '850 Harbor Dr, San Diego, CA',
  },
  {
    name: 'Coastal Eats — Brooklyn',
    timezone: 'America/New_York',
    address: '120 Water St, Brooklyn, NY',
  },
  {
    name: 'Coastal Eats — Boston',
    timezone: 'America/New_York',
    address: '40 Atlantic Ave, Boston, MA',
  },
];

const SKILLS: ReadonlyArray<string> = ['Bartender', 'Line cook', 'Server', 'Host'];

const ACCOUNTS: ReadonlyArray<{
  email: string;
  firstName: string;
  lastName: string;
  role: Role;
}> = [
  { email: 'testadmin@coastal.test', firstName: 'Test', lastName: 'Admin', role: Role.ADMIN },
  { email: 'alice@coastal.test', firstName: 'Alice', lastName: 'Nguyen', role: Role.EMPLOYEE },
  { email: 'bob@coastal.test', firstName: 'Bob', lastName: 'Martinez', role: Role.EMPLOYEE },
];

const SEED_PASSWORD = 'Password!23Secure';

async function main() {
  // Locations — keyed by unique name so re-running won't duplicate.
  for (const loc of LOCATIONS) {
    await prisma.location.upsert({
      where: { name: loc.name },
      update: { timezone: loc.timezone, address: loc.address ?? null, isActive: true },
      create: { name: loc.name, timezone: loc.timezone, address: loc.address ?? null },
    });
  }

  // Skills — keyed by unique name.
  for (const name of SKILLS) {
    await prisma.skill.upsert({
      where: { name },
      update: {},
      create: { name },
    });
  }

  // Accounts — keyed by unique email. Hash once and reuse.
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);
  for (const acc of ACCOUNTS) {
    await prisma.user.upsert({
      where: { email: acc.email },
      update: {
        firstName: acc.firstName,
        lastName: acc.lastName,
        role: acc.role,
        emailVerified: true,
        isActive: true,
      },
      create: {
        email: acc.email,
        passwordHash,
        firstName: acc.firstName,
        lastName: acc.lastName,
        role: acc.role,
        emailVerified: true,
        isActive: true,
      },
    });
  }

  // eslint-disable-next-line no-console
  console.log(
    `[seed] Locations=${LOCATIONS.length} Skills=${SKILLS.length} Accounts=${ACCOUNTS.length}`,
  );
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
