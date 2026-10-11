# LessonKaki — studio management SaaS (folder name `lessonly` is legacy)

Replacement for Classcard (currently ~US$60/mo), built first for Daniel's own vocal
studio (Phoenix Ascend Pte. Ltd., Singapore), then sold to other schools.

## Decisions made
- **Product name: LessonKaki** (chosen 2026-09-23; "Lessonly" was Seismic's trademark,
  "ClassKaki" belongs to a SG company, CLASS KAKI PTE. LTD.). lessonkaki.com/.sg
  were unregistered on 2026-09-23 but **Daniel isn't buying domains yet**. Do a full
  IPOS search (classes 9 & 42) before selling. Tagline idea: "Less admin. More teaching."
  Keep code, folder and Firebase project ID brand-neutral (e.g. `studio-app-sg`).
- **Deployment target: `learn.singyourwayhome.sg`** (Daniel's studio site). DNS lives at
  SiteGround (ns1/ns2.siteground.net). The subdomain currently has an A record pointing
  to Classcard (served through Cloudflare) and redirects `/` → `/en/bookings`, so it's
  mainly the public booking page. Cutover = swap that record for Firebase Hosting's
  custom-domain records. Before switching: redirect old Classcard paths
  (`/en/bookings` etc.) so existing links keep working. During the parallel run, test on
  the default `*.web.app` URL or a spare subdomain. No new domain costs for now.
- **Two front doors, one backend:**
  - `teach.singyourwayhome.sg` — staff app (owner / admin / teacher). New subdomain, so
    it can go live immediately alongside Classcard; this is where the parallel run happens.
  - `learn.singyourwayhome.sg` — students: login/portal + public booking. Switched over
    from Classcard only once booking works.
  - One repo, shared code, one Firebase project with **two Hosting sites**. Both
    domains must be added to Firebase Auth's authorized domains.
  - The subdomain is not a security boundary. Access is enforced by role claims +
    Firestore rules + Cloud Functions. Staff accounts should use MFA.
  - Don't hardcode these hostnames; store them in per-school config (future schools
    get their own domains).
- **Multi-school from day one.** All data scoped under `schools/{schoolId}/...`;
  per-user role per school (owner / admin / teacher / student) via custom claims.
  Daniel's studio is school #1. Don't build self-serve signup or SaaS billing until
  the studio has run on it for 2–3 months.
- **Firebase, dedicated new project** (not Daniel's shared project):
  Firestore in `asia-southeast1` (Singapore — PDPA), Firebase Auth email-link
  sign-in, Cloud Functions for all money logic, Hosting, scheduled functions for
  reminders. Needs Blaze plan — set a budget alert.
- **Credits = append-only ledger.** Every change is a ledger entry; the balance is
  updated in the same Cloud Function transaction. Clients never write balances.
- **Payments:** each school uses its own gateway. Daniel's uses HitPay (cards) +
  PayNow QR on invoices (most students pay offline via PayNow). Per-school
  keys in Secret Manager, never Firestore. SaaS subscription billing later via Stripe.
- **PDPA:** the platform is a data intermediary for each school. Daniel is a
  certified DPO — "PDPA-compliant by design" is a selling point.
- Keep UI and copy original; don't copy Classcard's screens.

## Requirements (from how Daniel uses Classcard)
Students are adults and log in themselves. Core: calendar/scheduling, attendance,
packages & credits, invoicing, student portal, **public booking page**
(~100 of 270 students came via one-on-one, online, or package booking links).
Currently one teacher (Daniel), part-time teachers coming → `teacherId` on every
lesson from day one.

## Phases
1. Admin core — students, calendar, attendance, packages + credit ledger, invoices (PDF + PayNow QR)
2. Student portal — email-link login, upcoming lessons, credits, invoices, HitPay card payment
3. Public booking — availability rules, trial / package booking with payment
4. Teachers — scoped logins, own calendar, pay tracking

## Migration from Classcard
- Classcard MCP connector is registered (user scope) as `classcard`
  (https://api.classcardapp.com/mcp/v1, OAuth). Use it to read students, packages,
  credits, invoices, attendance. **Read-only — never write to Classcard.**
- CSV export at ~/Downloads/students-2026-09-23.csv: 270 students, only 13 Active.
  Known issues: duplicate people (4 shared emails, 1 shared phone), Classcard
  demo/test rows + Daniel's own test account, placeholder surnames, mixed phone
  formats, blank/duplicate old student IDs. Generate new IDs; keep the Classcard ID
  as `legacyId`.
- Plan: raw staging → transform script → validation (counts, total outstanding
  credits match to the cent) → 2–3 week parallel run → cutover at a billing
  boundary → keep Classcard read-only 1 more month.
- Student data is personal data: never commit exports or real records to git.

## Next steps
1. Inventory the Classcard MCP tools; confirm balances, packages, invoices and
   attendance are exposed, and what the fields look like.
2. Design the Firestore data model + security rules around that.
3. Firebase project created: **`class-app-sg`** (project number 53869856078; CLI logged
   in as sgvocalcoach@gmail.com). As of 2026-09-23 Firestore is NOT created yet: create
   the (default) database in `asia-southeast1` (location is permanent), upgrade to Blaze
   plus a budget alert, then scaffold phase 1 with two Hosting sites (teach / learn).
