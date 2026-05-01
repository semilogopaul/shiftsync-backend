# ShiftSync — Decisions for the deliberately-unspecified items

`review.txt` lists items that are intentionally ambiguous and asks the
implementer to document decisions. This file captures ours, with rationale.

---

## 1. De-certifying a staff member from a location

**Decision.** De-certification is a soft, time-stamped event
(`Certification.decertifiedAt`), never a hard delete.

- Past assignments and clock events at that location are **preserved as
  historical fact**. They keep showing in the audit log, in distribution
  analytics for that staff member, and in their own past-schedule view.
- **Future / not-yet-started** assignments at that location for the
  decertified user are flagged for the manager to clean up; the system does
  not auto-unassign them, because doing so silently would create coverage
  holes the manager hasn't acknowledged.
- New assignments fail validation immediately with a clear "not certified at
  <Location>" finding.

**Why.** Audit trail must remain truthful (Requirement 9). Auto-unassign is
destructive and would obscure the reason a hole appeared on the schedule.

---

## 2. How "desired hours" interacts with availability windows

**Decision.** Availability is a **hard** constraint; desired hours is a
**soft preference** used for fairness, not for blocking assignment.

- A user marked as "available 9–5 Mon–Fri" cannot be assigned outside that
  window — that's a violation finding.
- A user with `desiredWeeklyHours = 25` who's already at 28 hours **can** be
  given a 4-hour shift; the validator emits a *warning* (not an error) and
  the distribution analytic flags them as `OVER`. Managers may proceed with
  reasoning.
- Conversely, a user under their target appears as `UNDER` so managers can
  proactively top them up.

**Why.** Treating desired hours as a hard cap would make the schedule
unbuildable in busy weeks; treating it as soft data lets us drive fairness
analytics without surprising blocking errors.

---

## 3. Do 1-hour shifts count the same as 11-hour shifts toward "consecutive days"?

**Decision.** Yes. A consecutive day is "any day the user has at least one
non-cancelled assignment that overlaps that calendar day, evaluated in the
**shift's location timezone**."

- 6 calendar days in a row → warning.
- 7 calendar days in a row → manager override required with a documented
  reason (recorded in the audit log via `OVERRIDE_USED` + `overrideReason`).

**Why.** Labor law in the U.S. and the spec (Requirement 4) treat a
"day worked" as a binary, not a duration sum. Implementing it any other way
would diverge from how legal counsel and HR audit the data.

---

## 4. Shift edited after swap approval, before it occurs

**Decision.** The swap survives, but a `SHIFT_CHANGED_AFTER_SWAP`
notification is sent to both parties and the manager who approved it. The
edit re-runs the validators against the *new* shift parameters; if any
constraint now fails for the new owner, the manager sees a hard finding
when they save and must either revert the edit, reassign, or override with a
reason.

- The edit is **not** silently reverted. Managers may have a real reason to
  change times.
- The swap is **not** auto-cancelled. The new owner has already accepted
  responsibility for that slot; cancelling silently would leave a coverage
  hole.
- If the manager edits *before* swap approval, however, the swap **is**
  auto-cancelled (review.txt explicitly requires this). See `swaps.service`.

**Why.** The pre-approval and post-approval cases have different invariants:
pre-approval the assignment is still the original owner's, so editing
invalidates the swap context; post-approval the new owner is on the hook
and should be informed, not summarily kicked off.

---

## 5. A location that spans a timezone boundary

**Decision.** A `Location.timezone` is single-valued (one IANA zone) and
**that** zone is the one of record for every shift at that location.

- For a venue physically near a boundary, the corporate operator picks the
  zone that matches their POS / payroll / lease. We surface this in the
  Location form copy.
- We do **not** support per-shift timezones at a single location; that
  would defeat the rule "users see times in the *location's* timezone for
  that shift" and make consecutive-day analytics ambiguous.

**Why.** Timezone confusion is the bug class most likely to cause
mis-schedules; one zone per location is unambiguous and matches how most
multi-unit operators run their books.

---

## Other notable choices not from the ambiguities list

- **Numeric version on `Shift`** — every PATCH must include
  `expectedVersion`; mismatch → 409. This is what powers the "two managers
  assigning at once" simultaneous-assignment notification (Requirement 6,
  Scenario 4).
- **Manager analytics scope** — when a manager calls
  `/analytics/{distribution,overtime}` without `locationId`, the report is
  auto-scoped to *their* managed locations. A manager with zero locations
  gets an empty report rather than the org-wide one (no leakage).
- **`GET /users` is admin-only.** All other authenticated users use
  `GET /users/directory` for swap candidate / cert-grant pickers. The
  directory endpoint returns minimal columns only and is hard-capped at
  50 rows to discourage scraping.
- **Drop expiry** — drop requests with `expiresAt` ≤ 24h before the shift
  start are filtered out of "open drops" listings and rejected on claim
  with `DROP_EXPIRED`.
- **Notification delivery** — `notifyEmail` is currently best-effort: the
  in-app row is the source of truth and the email is a fire-and-forget
  side-effect (logged on failure). This matches the spec wording
  "in-app + email simulation."
