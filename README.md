# ShiftSync Backend

REST + WebSocket API powering ShiftSync, a multi-location staff scheduling platform for "Coastal Eats". Handles users, locations, certifications, availability, shift assignment with constraint validation, swap and drop requests, clock-in tracking, analytics, notifications, and an audit trail.

## Stack

- NestJS 11 (TypeScript, modular)
- PostgreSQL via Prisma 7 (driver adapter `@prisma/adapter-pg`)
- JWT auth in HTTP-only cookies (access + refresh, rotation + reuse detection)
- Socket.IO (`/realtime` namespace) for live schedule and on-duty updates
- Luxon for timezone arithmetic (recurring availability, DST, overnight shifts)
- bcrypt password hashing
- Resend for transactional email (best-effort, non-blocking)
- Helmet, cookie-parser, class-validator, throttler

## Project layout

```
src/
  main.ts                  bootstrap, CORS, helmet, global prefix /api/v1
  app.module.ts
  common/                  guards (JWT, refresh, roles), decorators, dto, filters
  config/                  env config schema
  database/prisma.service  PrismaClient with pg adapter
  mail/                    Resend wrapper + HTML templates
  modules/
    auth/                  login, register, refresh, password reset, email verify
    users/                 admin CRUD + /users/directory (any auth user, capped)
    locations/             read-only seeded entity, manager-location mapping
    skills/                read-only seeded entity
    certifications/        user x location x skill, soft-delete via decertifiedAt
    availability/          recurring weekly + one-off exceptions
    shifts/                CRUD + assignment with optimistic concurrency (version)
    swaps/                 swap + drop workflow (3-pending limit, 24h drop expiry)
    clock/                 clock in/out, on-duty endpoint
    analytics/             distribution + overtime + fairness reports
    notifications/         persistence, prefs (in-app + email), unread count
    audit-log/             append-only log + CSV export
    realtime/              Socket.IO gateway with JWT-cookie handshake
prisma/
  schema.prisma
  migrations/
  seed.ts                  idempotent: 4 locations, 4 skills, 11 accounts
```

## Local development

```bash
cp .env.example .env        # fill DATABASE_URL, JWT_SECRET, JWT_REFRESH_SECRET
npm ci
npx prisma migrate deploy   # or: npx prisma migrate dev
npx prisma db seed
npm run start:dev           # http://localhost:3001/api/v1
```

Swagger docs at `/api/docs` in non-production. Healthcheck at `/api/v1/health`.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string (Neon, RDS, etc.) |
| `JWT_SECRET` | yes | Long random string |
| `JWT_REFRESH_SECRET` | yes | Different long random string |
| `JWT_EXPIRES_IN` | no | Default `15m` |
| `JWT_REFRESH_EXPIRES_IN` | no | Default `7d` |
| `FRONTEND_URL` | yes | Comma-separated origins; `*.vercel.app` previews are auto-allowed |
| `NODE_ENV` | no | `production` disables Swagger |
| `PORT` | no | Default `3001`, Railway injects automatically |
| `RESEND_API_KEY` | no | If unset, email is silently skipped |
| `MAIL_FROM` | no | e.g. `ShiftSync <noreply@example.com>` |
| `THROTTLE_TTL` / `THROTTLE_LIMIT` | no | Rate-limit window in seconds and request cap |

## Deployment (Railway)

`railway.json` declares the build and deploy commands. The service expects `DATABASE_URL` plus the JWT secrets and `FRONTEND_URL` in Variables. Railway injects `PORT`. CORS allows the configured `FRONTEND_URL` plus all `*.vercel.app` preview URLs so frontend previews work without redeploying the API.

Deploy command: `npx prisma migrate deploy && node dist/src/main.js`

## Key design notes

- **Constraint validation**: every shift assignment runs through a single validator (`shifts/validators/`) that returns a list of findings (errors, warnings, hard blocks, overridable). The frontend renders these directly with explanations and alternatives.
- **Optimistic concurrency on shifts**: `Shift.version` is bumped on every write; clients send `expectedVersion` on PATCH and receive `409 Conflict` plus a realtime `assignment.conflict` event if another manager edited first.
- **Manager scoping**: managers see and act on locations they're explicitly assigned to via `LocationManager`. Analytics auto-scope to managed locations when a manager calls without a `locationId`, never falling back to org-wide data.
- **Drop expiry**: a 5-minute Cron job flips OPEN drops past their 24h-before-shift expiry to EXPIRED, emits per-row events for notifications, and writes a single audit-log entry. The flip uses a two-step `findMany` then `updateMany` (filtered on `status: OPEN`) instead of an interactive transaction, for compatibility with serverless-pooled Postgres.
- **Time handling**: shifts store UTC instants; locations store an IANA zone; recurring availability stores its own zone so DST transitions resolve correctly when projected onto a date. Overnight shifts are a single row with `endMinute <= startMinute` semantics in availability and an `endsAt > startsAt` UTC pair on `Shift`.

## Seed credentials

All seed accounts share the password: `Password!23Secure`

| Email | Role | Scoped to |
| --- | --- | --- |
| `testadmin@coastal.test` | ADMIN | All locations |
| `manager.west@coastal.test` | MANAGER | Santa Monica, San Diego |
| `manager.east@coastal.test` | MANAGER | Brooklyn, Boston |
| `alice@coastal.test` | EMPLOYEE | Santa Monica (Bartender, Server), San Diego (Bartender) |
| `bob@coastal.test` | EMPLOYEE | Santa Monica (Line cook, Host) |
| `carol@coastal.test` | EMPLOYEE | San Diego (Server, Host) |
| `david@coastal.test` | EMPLOYEE | San Diego (Bartender, Line cook) |
| `erin@coastal.test` | EMPLOYEE | Brooklyn (Bartender, Server), Boston (Server) |
| `frank@coastal.test` | EMPLOYEE | Brooklyn (Line cook, Host) |
| `grace@coastal.test` | EMPLOYEE | Boston (Bartender, Server) |
| `henry@coastal.test` | EMPLOYEE | Boston (Line cook, Host) |

## Scripts

```bash
npm run start:dev           # watch-mode dev server
npm run build               # nest build → dist/src/main.js
npm run start:prod          # node dist/src/main.js
npm run lint                # eslint --fix
npm test                    # jest
npx prisma migrate dev      # generate + apply migration
npx prisma db seed          # populate fixtures
```

See [`DECISIONS.md`](./DECISIONS.md) for the engineering rationale behind the 5 deliberately-unspecified items in the assignment brief, and `../DECISIONS.txt` at the repo root for the same content in plain text.

## Decisions on the 5 intentional ambiguities

These are the 5 deliberately-unspecified items from the assignment brief and the choice made for each, with the engineering rationale.

### 1. What happens to historical data when a staff member is de-certified from a location?

Soft delete. Certification rows are never removed; a `decertifiedAt` timestamp is set and the `CertificationSkill` join rows are preserved. Past shift assignments and audit-log entries reference the certification implicitly, so hard-deleting it would orphan history and break "who worked where, when" reporting. Future assignment validation reads `decertifiedAt IS NULL`, so re-certification just nulls the field again. The same row is reused (unique on `userId+locationId`), so re-certifying after a gap restores the original record without duplication.

### 2. How should "desired hours" interact with availability windows?

Availability is a hard constraint; desired hours is a soft preference. Availability is a labor-law and reliability concern — assigning someone outside their stated hours is wrong even if they're under target. Desired hours is a fairness signal: it drives the analytics "Over / Under" status and the fairness score, but never blocks an assignment. Managers see a warning when a staff member is well below their desired hours; they don't see a hard error.

### 3. When calculating consecutive days, does a 1-hour shift count the same as an 11-hour shift?

Binary by calendar day in the location's timezone. Any shift that touches a given local date counts that date as "worked". The labor-law rule the spec is invoking ("7th consecutive day") is a calendar-day rule, not an hours rule. Weighting duration would make a 30-min coffee shift count less than an 8-hour one, but both still legally constitute a worked day. Overnight shifts are attributed to their start date to avoid a single shift counting twice.

### 4. If a shift is edited after swap approval but before it occurs, what should happen?

The approved swap stands. The edited shift triggers a `SHIFT_CHANGED_AFTER_SWAP` notification to both swap parties and re-runs all assignment validators against the new staff member. If the edit invalidates that staff member (e.g. a skill was added they don't have), the manager sees a finding and can override or reassign. Cancelling an approved swap on every minor edit would create churn; the spec only asks for auto-cancel on PENDING swaps. Once approved, the business commitment is made, so the cleaner rule is "notify, re-validate, let the manager act if needed". Pending swaps still auto-cancel immediately on shift edit, exactly as the spec requires.

### 5. How should the system handle a location that spans a timezone boundary?

One IANA timezone per Location, stored on the row. Times are presented in that single zone for that location. A restaurant operates on a single wall clock — staff, customers, and POS all share one local time. Splitting a venue across two zones creates ambiguous shift starts and breaks DST handling. Corporate sets the zone at provisioning. If policy ever changes (e.g. a venue legally adopts a different zone), the field is editable; historical shifts retain UTC instants and render in the new zone going forward.
