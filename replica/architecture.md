# Architecture: LessonKaki

From `replica/recon.md` + `features.csv`. Stack decisions come from CLAUDE.md; this file turns them into a data model, rules, API and build order.
Date: 2026-10-11

## 1. Stack

| layer | choice | why |
| --- | --- | --- |
| web apps | Vite + React + TypeScript, two entry apps `apps/teach` and `apps/learn` sharing `packages/shared` | static SPAs fit Firebase Hosting; one codebase, two front doors |
| styling | Tailwind, tokens from `/replica-design` | fast, themeable per school |
| repo | pnpm workspaces: `apps/teach`, `apps/learn`, `packages/shared` (types, money, dates, rules helpers), `functions/` | shared types between client and functions |
| database | Firestore (default) in `asia-southeast1` | decided; PDPA, data in Singapore |
| auth | Firebase Auth email-link; TOTP MFA for staff | decided; adult students log in themselves |
| server logic | Cloud Functions v2 (Node 22, TS) in `asia-southeast1` | all money and credit writes; clients never write balances |
| files | Cloud Storage `asia-southeast1` (invoice PDFs, student files) | signed URLs, rules per school |
| PDF | `pdf-lib` in a function | no headless browser, cheap cold starts |
| PayNow | SGQR (EMVCo) payload built in a function with the school's UEN, amount and invoice number as reference | most students pay offline via PayNow |
| cards | HitPay payment requests + webhook; key in Secret Manager `hitpay-api-key-{schoolId}` | decided, per-school gateway |
| email | Resend (transactional), sending from the school's domain | simple API; list it as a sub-processor in the PDPA notice (US) |
| jobs | Cloud Scheduler-backed scheduled functions | reminders, expiry, overdue |
| hosting | Firebase Hosting, two sites: `teach` and `learn` on project `class-app-sg` | decided |
| tests | Vitest + Firebase Emulator Suite (rules + functions); Playwright for flows | ledger and rules must be tested against the emulator |

One database, one functions codebase, no microservices.

## 2. Tenancy, roles and claims

- Every school document lives under `schools/{schoolId}`. School #1: `sywh` (Sing Your Way Home).
- Custom claims (set only by the `setMemberRole` function), kept small (1000-byte limit):

```json
{ "r": { "sywh": "owner" }, "t": { "sywh": "<teacherId>" }, "s": { "sywh": "<studentId>" } }
```

  `r` = role per school (`owner | admin | teacher | student`), `t` = linked teacher doc, `s` = linked student doc. Rules read claims only, no `get()` for authorisation on hot paths.
- `members/{uid}` mirrors the claim so the owner can see and change roles; the function writes both.
- Hostnames, branding, gateway choice, UEN, timezone live in `schools/{schoolId}` config, never in code.

## 3. Data model (Firestore)

Conventions: ids are Firestore auto-ids unless stated; every doc has `createdAt`, `updatedAt` (server timestamps); times are `Timestamp` (UTC) and displayed in the school's timezone (`Asia/Singapore`, no DST); money is **integer cents** plus `currency` on the school; status fields are string enums validated in functions and rules. `legacyId` holds the Classcard id on migrated docs.

```
schools/{schoolId}
  name, legalName, uen, timezone, currency ('SGD'),
  hosts { teach, learn }, branding { logoPath, colors },
  gateways { hitpay: { enabled, mode: 'live'|'sandbox' } },        // keys in Secret Manager
  policy { lateCancelHours, lateCancelReturnsCredit: true,
           absentConsumesCredit: true, allowOwedLessons: true,
           debitOn: 'mark' }                                        // Classcard debits when attendance is marked
  pdpa { dpoName, dpoEmail, noticeVersion }
  alerts { to[], events { bookings, cancellations, payments, paymentProblems }, skipStaffActions }   // owner email alerts
  mail { from }                                                     // verified sender, server-set only

schools/{s}/members/{uid}            role, teacherId?, studentId?, active, mfaEnrolled
schools/{s}/teachers/{teacherId}     uid?, displayName, email, subjectIds[], payRateCents?, active
schools/{s}/subjects/{id}            name, teacherIds[], defaultDurationMin, active
schools/{s}/locations/{id}           name, publicName, address, isOnline, active

schools/{s}/students/{studentId}
  uid?, firstName, lastName, preferredName, email (lowercased), phone (E.164),
  status ('active'|'inactive'|'archived'), studentCode, legacyId?,
  notes (staff only), referralSource, signupSource,
  consent { pdpaNoticeVersion, acceptedAt, marketing: bool },
  summary { sessionsAvailable, sessionsOwed, moneyCreditCents,     // function-maintained, read-only to clients
            nextLessonAt, outstandingCents }

schools/{s}/packages/{id}
  name, subjectId, kind ('paid'|'trial'|'single'), sessions (int), priceCents,
  validityDays (e.g. 30 / 90, null = no expiry), sellsOnline, oncePerStudent (trial), active, legacyId?

schools/{s}/enrolments/{id}            // a "credit lot": one package purchase
  studentId, packageId, packageName, invoiceId?, sessionsTotal,
  sessionsUsed, sessionsRemaining,     // function-maintained
  validFrom, validUntil?, status ('active'|'completed'|'expired'|'void'), legacyId?

schools/{s}/ledger/{entryId}           // append-only, never updated or deleted
  studentId, enrolmentId? (null = owed), type:
    'grant'    +N  package sold / trial granted
    'debit'    -1  lesson marked present/absent (or owed)
    'restore'  +1  late cancel / unmark / lesson cancelled
    'settle'   moves an owed debit onto a newly bought lot
    'expire'   -N  lot passed validUntil
    'adjust'   ±N  manual, reason required (owner/admin)
    'migrate'  +N  opening balance from Classcard
  delta (int), lessonId?, attendeeKey?, reversesEntryId?, reason?,
  actorUid, idempotencyKey (unique per action), createdAt

schools/{s}/moneyLedger/{entryId}      // SGD credit carried to next invoice; append-only
  studentId, deltaCents, type ('overpayment'|'creditNote'|'appliedToInvoice'|'adjust'|'migrate'),
  invoiceId?, creditNoteId?, actorUid, idempotencyKey, createdAt

schools/{s}/series/{id}                // recurring template
  teacherId, subjectId, locationId?, isOnline, studentIds[], startAt, durationMin,
  rrule ('FREQ=WEEKLY;BYDAY=WE'), until?, exdates[], active

schools/{s}/lessons/{lessonId}
  teacherId, subjectId, locationId?, isOnline, meetingUrl?,
  startAt, endAt, seriesId?, isException (edited single occurrence),
  status ('scheduled'|'cancelled'), capacity (1 for one-on-one),
  studentIds[]                         // denormalised for array-contains queries + rules
  attendanceState ('unmarked'|'partial'|'marked')

schools/{s}/lessons/{lessonId}/attendees/{studentId}
  status ('booked'|'present'|'absent'|'cancelled'|'lateCancelled'|'removed'),
  enrolmentId?, ledgerEntryId?, owed (bool), source ('admin'|'booking'|'portal'),
  markedBy?, markedAt?

schools/{s}/availability/{teacherId}
  weekly [{ day: 1..7, start: '10:00', end: '18:00', locationId?, online }],
  exceptions [{ date, closed | ranges }], bufferMin, minNoticeHours, horizonDays

schools/{s}/slotLocks/{teacherId_yyyyMMddTHHmm}   // created in the booking transaction; prevents double booking
  lessonId, expiresAt? (for unpaid holds)

schools/{s}/bookings/{id}              // public booking requests (pre-account)
  packageId, teacherId, startAt, guest { name, email, phone }, studentId?,
  status ('held'|'confirmed'|'expired'|'cancelled'), paymentIntent { provider, ref, status },
  invoiceId?, lessonId?, createdAt

schools/{s}/invoices/{id}
  number (string, sequential per school), studentId, lines [{ desc, qty, unitCents, packageId?, enrolmentId? }],
  subtotalCents, discountCents, moneyCreditAppliedCents, totalCents, paidCents, pendingCents,
  status ('draft'|'sent'|'partial'|'paid'|'void'), issueDate, dueDate,
  paynow { payload, reference }, hitpay { requestId?, url? }, pdfPath?, legacyId?

schools/{s}/payments/{id}
  invoiceId, studentId, amountCents, method ('paynow'|'bank'|'cash'|'card_hitpay'),
  gatewayRef?, status ('succeeded'|'pending'|'refunded'|'failed'), refundCents,
  paidAt, recordedBy, idempotencyKey

schools/{s}/creditNotes/{id}           number, invoiceId, studentId, amountCents, reason, status ('issued'|'void')
schools/{s}/counters/{name}            invoice, creditNote: { next } (transaction-incremented)
schools/{s}/auditLog/{id}              actorUid, action, target, before?, after?, at  (staff-visible, function-written)
schools/{s}/alerts/{alertId}           owner email outbox: type, category, data (ids, times, amounts), status ('pending'|'sent'|'skipped'|'failed'),
                                       attempts, providerId?, lastError?, expireAt (TTL)  -- docs/email-alerts.md
schools/{s}/public/profile             public booking page data: school name, bookable packages, teacher public names
publicSchools/{hostname}               { schoolId, site: 'teach'|'learn' }  // host -> school lookup
```

Relationships: school 1-n everything; student 1-n enrolments (lots) 1-n ledger debits; lesson 1-n attendees (student); attendee 1-1 debit; invoice 1-n payments; invoice 1-n enrolments (package lines); teacher 1-n lessons, 1 availability.

### Indexes (initial `firestore.indexes.json`)

- `lessons`: (teacherId, startAt), (studentIds array-contains, startAt), (status, startAt)
- `enrolments`: (studentId, status, validUntil)  -> pick earliest-expiring active lot
- `ledger`: (studentId, createdAt desc), (enrolmentId, createdAt)
- `invoices`: (studentId, issueDate desc), (status, dueDate)
- `payments`: (invoiceId, paidAt), (paidAt)
- `bookings`: (status, createdAt)

## 4. The credit engine (the core)

All in one function module, `functions/src/credits.ts`, every operation in a Firestore transaction.

**Debit on mark** (`markAttendance`, status present|absent):
1. Read attendee; if it already has `ledgerEntryId`, no-op (idempotent).
2. Query student's lots: `status == active`, `sessionsRemaining > 0`, `validUntil >= lesson.startAt` (or null), order by `validUntil` asc (nulls last), then `validFrom`. **Earliest-expiring first** (confirmed by Daniel).
3. Found: write ledger `debit -1` with `enrolmentId`, decrement lot, set lot `completed` at 0.
   None: write ledger `debit -1` with `enrolmentId: null`, attendee `owed: true`, `summary.sessionsOwed += 1`. Booking is never blocked (Daniel: lessons go ahead, payment later).
4. Update attendee, lesson `attendanceState`, student `summary`.

**Restore** (late cancel, unmark, lesson cancelled): ledger `restore +1` with `reversesEntryId`, back onto the same lot (even if expired? -> back onto the lot; if it has expired, the restore is immediately followed by `expire`; policy flag later). Late cancel returns credit (Daniel).

**Grant** (package sold): on invoice creation with a package line, create the lot + `grant +N` (lot usable immediately; `requirePaidBeforeUse` policy flag off for this studio). Then **settle**: oldest owed debits are moved onto the new lot (`settle` entries), so "owed" lessons are paid down automatically.

**Expire**: daily job, lots past `validUntil` with remaining > 0 -> `expire -N`, status `expired`.

**Invariant** (tested): for every lot, `sessionsTotal - sessionsRemaining == -sum(ledger deltas for lot excluding grant)`; for every student, `summary.sessionsAvailable == sum(active lots remaining)` and `sessionsOwed == count(owed debits not settled or restored)`. A nightly `reconcileLedger` job checks it and writes discrepancies to `auditLog`.

## 5. Security rules (summary; draft in `replica/firestore.rules`)

- Default deny.
- Staff (owner/admin) of a school: read everything in it; write non-money docs (students' contact fields, subjects, locations, packages, availability, series/lessons scheduling fields).
- Teacher: read own `teachers` doc, lessons where `teacherId == t[schoolId]`, students who appear in their lessons (via function-provided roster, not raw student docs at first), write own availability.
- Student: read own student doc (minus staff `notes` -> stored in `students/{id}/private/notes` instead), own enrolments, own ledger, own invoices/payments, lessons where `studentIds` contains own id.
- **No client writes** to: `ledger`, `moneyLedger`, `enrolments`, `invoices`, `payments`, `creditNotes`, `counters`, `auditLog`, `members`, attendee status, any `summary` field.
- Public: `schools/{s}/public/*` and `publicSchools/*` readable by anyone.

## 6. API (Cloud Functions)

Callable functions check the caller's claim for the school in the request, validate input with zod, run in a transaction, and write `auditLog`.

| function | does | who | flow |
| --- | --- | --- | --- |
| `setMemberRole` | invite/assign role, set claims, mirror `members` | owner | setup |
| `createLesson` / `createSeries` | single or recurring; expands next 12 weeks; checks teacher conflicts | owner, admin | F04 |
| `editLesson` (`scope: one|following|all`) | reschedule/cancel with series handling; restores credits on cancel | owner, admin | F04 |
| `addAttendee` / `removeAttendee` | put a student on a lesson | owner, admin | F01 |
| `markAttendance` | present/absent -> debit; unmark -> restore | owner, admin, teacher (own lessons) | F01 |
| `cancelAttendance` | student or staff cancels; late vs on-time per policy; restore | staff; student (own, before cutoff) | F05 |
| `sellPackage` | invoice + lot + grant + settle owed | owner, admin | F02 |
| `createInvoice` / `sendInvoice` / `voidInvoice` | manual invoices, numbering, PDF, PayNow payload, email | owner, admin | F02, F07 |
| `recordPayment` | offline payment (PayNow/bank/cash), partial allowed, overpayment -> money credit | owner, admin | F02, F06 |
| `issueCreditNote` / `refundPayment` | credit note, money ledger, HitPay refund | owner | F02 |
| `adjustCredits` | manual ± with reason | owner, admin | support |
| `createPaymentLink` | HitPay payment request for an invoice | student (own), staff | F06 |
| `getAvailability` (HTTP, public) | open slots for teacher + package over a range | anyone | F03 |
| `publicBook` (HTTP, public, App Check + rate limit) | hold slot (slotLock), create booking, student, lesson; trial once per email; returns payment link or confirmation | anyone | F03 |
| `exportStudentData` / `deleteStudent` | PDPA access/erasure (financial records retained, personal fields anonymised) | owner | compliance |

Webhooks in: `hitpayWebhook` (HTTP; verifies HMAC with the school's salt from Secret Manager; idempotent on HitPay payment id; marks payment, invoice, confirms booking).

Triggers: `onInvoiceWrite` -> render PDF to Storage; `onUserCreate` -> link auth user to student by verified email.

Scheduled (Asia/Singapore):
| job | schedule | does |
| --- | --- | --- |
| `sendLessonReminders` | hourly | email 24h before lessons |
| `expireLots` | daily 00:15 | expire lots |
| `releaseHolds` | every 10 min | expire unpaid booking holds and their slot locks |
| `extendSeries` | daily | keep 12 weeks of lessons materialised |
| `markOverdue` | daily 08:00 | flag overdue invoices, optional reminder email |
| `reconcileLedger` | nightly | invariant check |

Only official APIs with the school's own keys (HitPay, Resend). Never Classcard's private endpoints; migration uses the read-only Classcard MCP + UI reads by Daniel.

## 7. The parts that bite

- **Time zones:** store UTC, school tz `Asia/Singapore` (no DST); booking page shows the guest's zone for online students and confirms it.
- **Idempotency:** every money/credit call carries an `idempotencyKey`; ledger writes check it; HitPay webhooks retry.
- **Races:** double booking prevented by `slotLocks/{teacherId_start}` created in the booking transaction (create fails if exists); credit debits in transactions; invoice numbers from a transaction counter.
- **Recurring lessons:** materialise 12 weeks ahead; edits to "this and following" split the series; attendance on past lessons is never rewritten by a series edit.
- **Firestore query limits:** "earliest valid lot" needs `validUntil` non-null for ordering; store far-future date for no-expiry lots.
- **Claims propagation:** client must refresh its ID token after `setMemberRole`.
- **Email deliverability:** SPF/DKIM for the school's sending domain (SiteGround DNS); Firebase email-link uses the school's custom action URL on `learn.`/`teach.`.
- **Public endpoints:** App Check + per-IP rate limit on `publicBook` and `getAvailability`; no PII in URLs.
- **Multi-tenancy:** every function takes `schoolId` and checks the claim for that school; rules tests cover cross-school reads.
- **PDPA:** consent version on student; access/erasure functions; retention: financial records kept (accounting requirement), personal fields anonymised; data stays in `asia-southeast1` except email via Resend (disclose). Staff MFA.
- **Migration to the cent:** opening balances as `migrate` grants per active lot (from Classcard Enrollments: remaining, valid till, invoice); money credit as `moneyLedger migrate`; validation compares per-student totals against Classcard.

## 8. Build order

**M0 Setup:** create Firestore (default) in `asia-southeast1`, Blaze + budget alert, two Hosting sites, Auth email-link + authorised domains, emulator suite, repo scaffold, CI (lint, typecheck, rules + functions tests).

**M1 Vertical slice (ugly, end to end):** owner signs in on `teach` -> creates a student -> sells a 4-session package (invoice + lot) -> schedules a lesson -> marks present -> sees balance 3 and the ledger entry. Screens S18, S04, S05, S07, S02, S03. Collections: schools, members, students, packages, enrolments, ledger, invoices, lessons, attendees. Functions: setMemberRole, sellPackage, createLesson, addAttendee, markAttendance.

**M2 Admin core must-haves (Phase 1):** recurring lessons + edit scopes, late cancel/restore, owed lessons + settle, invoice PDF + PayNow QR, record payment / partial / money credit, overdue list, attendance report, dashboard, CSV import with dedupe + migration scripts. S01–S13.

**M3 Parallel run:** migrate the 13 active students' lots and money credit, validate to the cent, run beside Classcard 2–3 weeks on `teach.singyourwayhome.sg`.

**M4 Student portal (Phase 2):** learn site, email-link login, upcoming lessons, credits, invoices, PayNow + HitPay pay, cancel within policy. S14–S18.

**M5 Public booking (Phase 3):** availability rules, getAvailability, publicBook with holds and payment, trial once per person, reminder emails; old Classcard paths redirected; `learn.` cutover.

**M6 Teachers (Phase 4):** scoped teacher logins, own calendar, mark own lessons, pay tracking.

**M7 Should/could:** credit notes/refunds, revenue reports, reschedule from portal, then fixes from `/replica-entrepreneur`.
