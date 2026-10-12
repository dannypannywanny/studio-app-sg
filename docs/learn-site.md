# Learn site (student portal + booking)

`apps/learn`, served from Hosting site `class-app-sg-learn` (target `learn`), later at
learn.singyourwayhome.sg. Students sign in with an email link, see their lessons, sessions, owed
lessons and invoices (PayNow QR, PDF), book one-on-one lessons and cancel on time.

## How it works

- **Who can sign in:** only students the owner has given access (teach: Student, then Student portal,
  then Give portal access; or `functions/scripts/invite-students.ts` in bulk). That creates their Auth
  account with student claims. **No email is sent**: the student goes to the site, types their email
  and gets Firebase's sign-in link. Self sign-up stays off, so other emails are refused.
  Skipped automatically: emails shared by two students, staff logins, students with no email.
- **Booking hours:** teach, Settings, Online booking hours (one block per day and mode; closed dates).
  Stored in `schools/{s}/availability/{teacherId}`. Defaults: 45-minute lessons, starts every 30 min,
  15 min gap around other lessons, at least 12 h notice, up to 28 days ahead.
- **Booking (`bookLesson`):** re-checks the slot inside a transaction (teacher's other lessons plus the
  gap, the student's own lessons, a per-teacher-per-day lock against races). Creates an ordinary
  lesson with `source: 'portal'` and emails the owner (Bookings alert). Nothing is charged: the credit
  moves when attendance is marked; with no credit the lesson goes owed. Each student may hold 4
  upcoming portal bookings (`schools/{s}.booking.maxUpcoming`); lessons staff schedule don't count.
- **Cancelling:** the existing `cancelAttendance`; online only outside `lateCancelHours` (24 h), else
  the page says to contact the studio. A cancelled slot opens up again for others.

## Go-live checklist (each production step needs Daniel's go-ahead)

1. Daniel's (and Allie's, if bookable) weekly hours: enter them in teach Settings after the deploy, or
   add them to `functions/scripts/schools/sywh-learn.json` under `availability`.
2. Deploy: `firestore:rules`, `firestore:indexes` (new attendees index), functions
   (`getAvailability`, `bookLesson`, `inviteStudents`, and `cancelAttendance` unchanged), then
   `hosting:learn` (after `pnpm build:learn`; `apps/learn/.env.production` holds the web config).
3. `setup-learn.ts --project class-app-sg --file scripts/schools/sywh-learn.json`: host lookup and
   public profile (name, logo, contact, teacher names).
4. Auth authorised domains: add `class-app-sg-learn.web.app` (and `learn.singyourwayhome.sg` at cutover).
5. Invite the first cohort: `invite-students.ts --project class-app-sg --school sywh --since 2026-04-01`
   (dry run), review the skipped list, then `--apply`.
6. Tell students (WhatsApp/email from Daniel) to sign in at the web.app address with their email.
7. Domain cutover (later): add learn.singyourwayhome.sg as a custom domain on the learn site, swap the
   SiteGround A record, redirect the old Classcard paths (`/en/bookings` etc.) to `/`, set
   `schools/sywh.hosts.learn`, update the marketing site's booking button.
