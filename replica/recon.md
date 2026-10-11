# Recon map: Classcard (web, admin + student portal + public booking)

Scope: the studio-management core loop: students, calendar, attendance, packages and credits, invoices and payments, student portal, public booking. Excludes Classcard's marketing, leads/CRM depth, rentals, products/stock, files.
For: Daniel's own studio (Phoenix Ascend Pte. Ltd., Sing Your Way Home), then other schools (LessonKaki). Original UI and copy.
Date: 2026-10-07

Evidence base: Classcard's official read-only MCP connector on the user's own account (shapes only; no real records stored here), the CSV export's column headers, and CLAUDE.md. **Not yet done:** help-center read, pricing page, and a screen-by-screen click-through with the user. Screens below are therefore inferred from the data model and are marked `inferred`. Walk through them with Daniel before `/replica-design`.

## Sources

| # | source | URL / handle | notes |
| --- | --- | --- | --- |
| 1 | Classcard MCP connector (read-only, own account) | https://api.classcardapp.com/mcp/v1 | 20 list/report tools; field shapes below |
| 2 | Student CSV export | ~/Downloads/students-2026-09-23.csv (not in git) | 28 columns, headers only used here |
| 3 | Classcard help center | TODO | for settings, reminders, booking-page options |
| 4 | Daniel's own account walkthrough | TODO, with user present | to confirm screens/states |

## Core loop

A teacher teaches a scheduled lesson, marks attendance, and a prepaid package credit is used; when credits run out the student is invoiced and pays by PayNow or card, often booked through a public link.

## Screens (inferred, confirm with user)

| ID | screen | route / how to reach | purpose | key components | states seen |
| --- | --- | --- | --- | --- | --- |
| S01 | Dashboard | admin home | today's lessons, overdue invoices, at-risk attendance | stat tiles, today list | empty, filled |
| S02 | Calendar | admin | day/week view of lessons, per teacher and location | calendar grid, event chip, filters | empty, filled |
| S03 | Lesson detail | click event | time, teacher, online flag, attendees, attendance status | attendance toggle, notes | Unmarked, marked |
| S04 | Students list | admin | search, filter (active, overdue, joined date, batch) | table, search, filter chips | empty, filled |
| S05 | Student profile | admin | contact, guardian, packages/credits, invoices, attendance, notes | tabs, timeline | filled |
| S06 | Student add/edit + import | admin | create or import (CSV) | form, dedupe warning | error |
| S07 | Packages catalogue | admin | name, fee, sessions, validity, sold online flag | table, form | active, archived |
| S08 | Invoices list | admin | status, overdue filter, search by number | table | Paid, Sent, Overdue |
| S09 | Invoice detail | admin | line items, discount, payments, PDF, PayNow QR | PDF view, record-payment modal | Paid, partial, void |
| S10 | Record payment | modal | mode (Cash, PayNow, card), date, amount | form | error |
| S11 | Attendance reports | admin | per-student % over a period, at-risk list | table, period picker | empty, filled |
| S12 | Staff and roles | admin | owner, teacher, roles | table, invite | filled |
| S13 | Settings | admin | school, subjects/programs, locations, tax, reminders | forms | filled |
| S14 | Public booking page | learn.* | pick lesson type/package, time slot, details, pay | slot picker, form, payment | no slots, taken, success |
| S15 | Student portal home | learn.* | upcoming lessons, credits, invoices | cards | empty, filled |
| S16 | Student lessons | learn.* | upcoming/past, reschedule/cancel | list | empty |
| S17 | Student invoices and pay | learn.* | view invoice, PayNow QR, HitPay card | list, pay button | paid, due |
| S18 | Login | both | email-link sign-in | email form | link sent, expired |
| S19 | Teacher calendar (scoped) | teach.* | teacher sees own lessons only | calendar | filled |

## Flows

```
F01 Teacher runs a lesson and marks attendance
    S02 calendar -> S03 lesson detail -> mark present/absent (credit deducted)
    happy path clicks: 3
    edge: late cancel (credit kept or returned), make-up lesson, marking twice

F02 Admin sells a package and takes payment
    S05 student -> S07 pick package -> S09 invoice created -> S10 record payment
    happy path clicks: 5
    edge: discount, partial payment, refund (credit note), overdue

F03 New student books via public link
    S14 booking page -> pick time -> details -> pay or book trial -> S18/S15
    happy path clicks: 5
    edge: slot taken mid-booking, time zone, free trial limited to one, duplicate email

F04 Admin schedules recurring lessons
    S02 calendar -> create lesson/series -> assign student, teacher, online/location
    edge: conflicts, holidays, edit one vs all

F05 Student reschedules or cancels
    S16 -> pick new slot or cancel (policy window)
    edge: inside cutoff, credit effects

F06 Student pays an invoice
    S17 -> PayNow QR (offline, admin reconciles) or HitPay card

F07 Admin chases overdue invoices
    S08 filter overdue -> remind (email) -> S10

F08 Month-end review
    S01/S11 -> attendance %, revenue, outstanding payments
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Button | primary, secondary, ghost, danger | default, hover, focus, disabled, loading | all |
| Data table | sortable, filterable, paginated (cursor) | empty, loading, filled | S04, S08, S11 |
| Calendar grid | day, week | empty, filled, conflict | S02, S19 |
| Event chip | class, online, attendance state | unmarked, present, absent | S02 |
| Status badge | Paid, Sent, Overdue, Cancelled, Void | | S08, S09, S17 |
| Form fields | text, select, date, money, phone (SG +65) | error | many |
| Modal | confirm, form | | S10 |
| Slot picker | list of times with time zone | none, taken | S14, S16 |
| Toast | success, error | | all |
| Nav | admin sidebar, student top bar | | all |

## Inferred data model (Classcard shapes, to be remapped to `schools/{schoolId}/...`)

```
Institution  id, name
             evidence: whoami   confidence: high

Person (user_detail)  id, userId, firstName, surname, preferredName, email, phone,
             role (Owner=10, Teacher=2, others 1,7,8,9), active, joinedAt
             evidence: list_staff, list_students   confidence: high

Student      person + studentCode (prefix+number), guardian (name, phone, email),
             dob, nationality, area, city, referralSource, signupSource, gender,
             lastNote, lessonType, location, status
             evidence: list_students, CSV headers   confidence: high
             Note: CSV carries more fields (guardian, DOB, notes) than the API.

Guardian     id, name, email, linked children[]   evidence: list_guardians   confidence: medium
             (adult students: probably unused for this studio)

Subject (program)  id, name, description, courseId, image, order, active
             evidence: list_subjects   confidence: high
             e.g. one subject per teacher offering

Package      id, name, shortName, description, categoryId (1 paid, 11 trial),
             fee, taxFee, sellsOnline, validityDate, order, active
             evidence: list_packages   confidence: high
             **Session count and credit rules are NOT exposed**; it is only in the name
             ("4 Sessions"). confidence: guess

Subscription rule  per package recurring billing  evidence: list_subscriptions (empty here)  confidence: low

CalendarEvent (lesson)  id, title, start, end, allDay, location, organizerId (teacher),
             tags, isOnline, capacity, attendanceStatus (Unmarked...), classId, active
             evidence: list_calendar_events   confidence: high
             **No student link exposed.** Needed: per-event attendee list.

Booking      id, studentId, eventTitle, eventAt, eventEndsAt, organizerId,
             confirmed, invoiceId, paymentStatus
             evidence: list_bookings   confidence: high
             Booking ties a student to a lesson and to the invoice that paid for it.

Invoice      id, number, amount, amountPaid, amountPending, discount, status
             (Paid, Sent, Cancelled, Deleted, Scheduled), issueDate, dueDate, studentId
             evidence: list_invoices   confidence: high
             Line items not exposed.

Payment      id, paymentNum, amount, refundAmount, mode (Cash...), date,
             status (0 ok, 2 pending, 3 processing, 4 refunded), failed, invoiceId,
             recordedBy, transactionId, paymentGroupId
             evidence: list_payments   confidence: high

CreditNote   number, reason, status (Closed, Void)   evidence: list_credit_notes tool   confidence: medium

Location     id, name, publicName, capacity, onCalendar, isRental, isOnlineBookable
             evidence: list_locations   confidence: high

Batch (class group)  empty for this studio; skip   confidence: n/a

Attendance   per student per lesson present/absent; only aggregates exposed
             (present, absent, total, pct)  evidence: get_attendance_report  confidence: medium
```

Relationships: Institution 1-n Person; Teacher 1-n Subject offering; Subject 1-n Package; Student n-n Lesson via Booking (attendance on that join); Booking n-1 Invoice; Invoice 1-n Payment; Student 1-n Invoice; Location 1-n Lesson.

### Gaps that block the migration (resolve before architect/migration)

1. **Credit balance per student is not exposed** by any tool or the CSV. Options: derive (sessions sold in paid packages minus attended bookings), or read each balance from the Classcard UI/report manually. CLAUDE.md requires outstanding credits to match to the cent, so this needs a decided source of truth.
2. **Session count per package** is only in the package name. Define it as a field in LessonKaki.
3. **Lesson history per student is readable** via `list_bookings` (date, teacher, invoice, back to 2023; verified on one student). Still to confirm: that it includes recent and admin-scheduled lessons, not only online bookings (the tool says "online bookings").
4. **Invoice line items, PayNow/HitPay references** not visible.
5. **Present/absent per lesson** is not exposed: bookings have only a `confirmed` flag and calendar events only Marked/Unmarked. Needed for the credit ledger; may need the UI or a Classcard export.

### Where balances live in the Classcard UI (seen 2026-10-11, own account)

- Student profile > Overview > **Enrollments**: one row per package enrolment, status (Active / completed, "Hide completed" toggle). Expanding a row shows the paying **invoice number + status**, **Valid till date (days remaining)**, and **Balance N** (sessions left). So credits are **per enrolment**, not one number per student, and each enrolment has its own expiry. The ledger must be per enrolment ("credit lot"), consumed oldest-expiring first (to confirm).
- Overview also shows a separate **Invoice credit balance (SGD)**: money credit carried to the next invoice, with an Adjust button. Two balance types: session credits and money credit.
- **Attendance** tab: statuses Present / Absent / Cancelled / Removed, filterable by period (default last 30 days). Below the counts, **one row per lesson**: date, lesson title, start-end time, duration, status ("Marked Present"), **marked by whom and when**, and the **invoice (package) the credit was drawn from**. This is exactly a ledger debit: attendance -> enrolment lot -> invoice. Model it the same way.
- Credit consumption order (Daniel, confirmed): **earliest-expiring enrolment first**.
- Other tabs: Calendar, Invoices, Grades, Files, Courses (teaching material), Notes, Messages, Chats, Tasks.
- No all-students enrolment/balance report found yet. With 13 active students, reading 13 profiles is feasible for the migration.

### Credit rules (from Daniel, 2026-10-11)

- Late cancel: credit is **returned**.
- Expiry: depends on the package (1-month vs 3-month packages have different validity). Model as a per-package validity period.
- No package / no credits: booking prompts for payment, but staff usually let the booking go through anyway (student pays later by bank transfer/PayNow). So **negative balance / unpaid lessons must be allowed**, tracked as owed.

## Feature matrix

See `features.csv`. 51 rows. Must: 30, should: 13, could: 8 (7 of the could rows are marked skip).

## Out of scope (cannot or should not be cloned)

- Classcard's own logos, illustrations, fonts, copy, templates, emails.
- Its branded PDF/receipt layout (LessonKaki gets an original invoice with PayNow QR).
- Classcard marketplace/partner integrations, mobile apps (web first), push notifications.
- Leads/CRM depth, product/stock sales, rentals, batch/class groups, guardian/child accounts, school-year/curriculum fields (adult one-on-one studio). Revisit when selling to schools.

## Size

Screens 19, flows 8, entities 12. Hard parts: credit ledger correctness (deduct/restore rules, expiry), recurring lessons with edit-one-vs-all, public booking with availability and payment (HitPay + PayNow reconciliation), migration of balances to the cent, role-scoped access across two Hosting sites. Size: L (a quarter) for full parity; Phase 1 (admin core) alone is M.
