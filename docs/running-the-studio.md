# Running the studio on LessonKaki

Classcard was suspended on 2026-10-12, mid-migration, so there was no parallel run: LessonKaki at
https://teach.singyourwayhome.sg is the system of record from cutover. This page replaces the planned
"parallel-run kit". Student data never goes in this repo; balances live in the app.

## Cutover (once)

1. Fill `migration/raw/balances-sheet.csv` (sessions left today for every row, 0 if none or expired;
   valid-until; money credit). Expired packages are not carried over: students text to extend.
2. `balances-sheet.ts --to-json`, then the opening balances go to production (separate approval):
   lots, money credit, and the 6 unpaid Classcard invoices (S$1,450) as open `CC-…` invoices.
3. The script checks totals against the sheet and reconciles every student. Expect 0 problems.
4. Add the students who joined after the 23 Sep export (Students → New), then their balances.
5. Create the packages you still sell (Packages), so new sales get the right sessions and validity.

## Every teaching day

- [ ] Open Calendar: today's lessons are there with the right students.
- [ ] After each lesson, mark attendance (Present / Absent / Late cancel). Credits move only when marked.
- [ ] Payment received (PayNow, bank, cash)? Invoices → the invoice → Record payment, same day.
- [ ] New student or package sale? Students → New, then Sell package (creates the invoice + PayNow QR).

## Every week

- [ ] Dashboard: lessons left unmarked, overdue invoices, students running low or owing lessons.
- [ ] Invoices → Overdue: chase, or record the payment if it already came in.
- [ ] Reports → Attendance: spot anyone missing lessons.

## Common jobs

- **A student whose package expired asks for more time:** Student → Adjust credits → add the sessions,
  reason "Extension of expired package (date)". These manual credits don't expire.
- **Lost authenticator (staff):** owner opens Staff → Reset (lost phone). They set it up again at
  next sign-in. The owner's own reset goes through Claude/the Admin SDK.
- **Wrong attendance mark:** change it on the lesson; the ledger reverses and re-applies the credit.
- **Wrong invoice:** void it (with a reason) and issue a new one. Paid amounts can't be voided away.

## What to watch in the first 2–3 weeks

- Nightly `reconcileLedger` finds a mismatch (it writes to the audit log): tell Claude straight away.
- A student's sessions-left looks wrong: compare with the balances sheet you filled, then fix with
  Adjust credits and a reason (never by editing data).
- Sign-in emails landing in spam (sender is `noreply@class-app-sg.firebaseapp.com`). A custom sender
  domain needs DNS records at SiteGround; ask if it becomes a problem.
- Firebase budget alert emails (S$20/month; expected under S$1).
- Invoice PDFs: Chinese names render; check the first few real ones anyway.
- The public booking page (learn.singyourwayhome.sg) still points at Classcard, which is suspended:
  bookings there may fail. Public booking in LessonKaki is milestone M5.
