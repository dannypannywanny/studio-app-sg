# Email alerts (owner notifications)

LessonKaki emails the studio when something happens, replacing the emails Classcard used to send:

| switch in Settings | event types | sent by (today) |
| --- | --- | --- |
| Bookings | `lesson.booked`, `series.booked` | createLesson, addAttendee, createSeries (future lessons only) |
| Cancellations | `attendee.cancelled`, `attendee.removed`, `lesson.cancelled`, `series.cancelled` | cancelAttendance, removeAttendee, cancelLesson, editLesson (cancel) |
| Payments | `payment.recorded`, `payment.succeeded` | recordPayment; **later** the HitPay webhook (M4) |
| Payment problems | `payment.failed`, `payment.abandoned` | **later**: HitPay webhook (M4), expired unpaid booking holds (M5) |

A weekly series is one email, not one per lesson. The daily `extendSeries` job sends nothing. Lessons
entered after they happened (record-keeping) don't send a booking email.

## How it works

1. The function making the change writes `schools/{s}/alerts/{alertId}` **in the same transaction**
   (`enqueueAlert` in `functions/src/alerts.ts`: a single write with no reads). If the change rolls back,
   so does the alert. Sending never happens inside the transaction, so email can't block or slow a payment.
2. The alert id comes from the change (`payment_<paymentId>`, `cancel_<lesson>_<student>_<rev>`, ...),
   so one change gives one alert doc. Retried callables return their first result without writing again.
3. The `onAlertCreated` trigger calls `deliverAlert`: it checks the school's settings, renders the email,
   and sends it with Resend using `Idempotency-Key: <schoolId>/<alertId>`. Status goes
   `pending → sent | skipped | failed`, and only `pending` alerts are ever sent.
4. Network errors, 429 and 5xx throw, so the trigger retries (`retry: true`). After 5 attempts, or on a
   permanent error (bad key, unverified domain), the alert is marked `failed` with `lastError`.
   Settings → Email alerts lists the most recent alerts and their status.

**Privacy:** alert docs hold ids, times and amounts. Names are read when the email is sent, and the email
contains only the student's name, the lesson time and the amount (no email address, phone or notes).
Resend (US) is a sub-processor and needs to be listed in the PDPA notice. Alert docs carry `expireAt`
(+90 days) for a Firestore TTL policy.

## Adding a producer later (M4 / M5)

Call `enqueueAlert(tx, school, <unique id>, event, actor, at)` inside the transaction that records the
change. The renderer already handles these:

- HitPay webhook, payment succeeded: `{ type: 'payment.succeeded', paymentId, provider: 'hitpay', invoiceId, invoiceNumber, studentId, amountCents, currency, method: 'card_hitpay', pendingCents, overpaymentCents }`, id `payment_<paymentId>`.
- HitPay webhook, failed: `{ type: 'payment.failed', provider: 'hitpay', invoiceId, invoiceNumber, studentId | null, bookingId | null, amountCents, currency, reason }`, id `payfail_<hitpayPaymentId>`.
- `releaseHolds` (M5), unpaid hold expired: `{ type: 'payment.abandoned', ..., bookingId }`, id `abandoned_<bookingId>`. With no student yet, the guest's name is read from `bookings/{id}.guest.name`.
- `publicBook` / portal booking: `{ type: 'lesson.booked', source: 'booking' | 'portal', payment: { status: 'paid' | 'unpaid', amountCents, currency, invoiceId } }`.

The webhook's actor is `role: 'system'`, so "Skip changes made by staff" doesn't hide it.

## Settings

`schools/{s}.alerts = { to: string[], events: { bookings, cancellations, payments, paymentProblems }, skipStaffActions }`.
The owner edits these in Settings → Email alerts. Until they save, every switch is on and emails go to the
school's contact email (`schools/{s}.email`; for sywh, hello@singyourwayhome.sg).

`schools/{s}.mail.from` is the verified sender, e.g. `Sing Your Way Home <notifications@singyourwayhome.sg>`.
Only the server sets it (the rules block client writes, so one school can't send as another school's
domain). Until it's set, alerts go from Resend's test sender `onboarding@resend.dev`, which only delivers
to the Resend account's own address.

## Setup still to do (each needs Daniel's go-ahead)

Nothing below has been done yet.

1. **Resend account.** Sign up at resend.com with sgvocalcoach@gmail.com, then create an API key with
   "Sending access" only. A free plan (3,000 emails/month, 100/day) is plenty.
2. **Try it with the test key** (emulator only, no deploy):

   ```bash
   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 RESEND_API_KEY=re_... pnpm --filter functions exec tsx scripts/send-test-alerts.ts --to sgvocalcoach@gmail.com
   ```

   Expected result: two emails ("Payment recorded: $300.00 from Tess Tester" and "Cancelled: Tess Tester, ...").
3. **Secret.** `firebase functions:secrets:set RESEND_API_KEY --project class-app-sg` and paste the key.
   It's stored as `RESEND_API_KEY`, not `resend-api-key`, because Firebase exposes secrets as environment
   variables. Do this **before the next functions deploy**: the deploy asks for the secret if it's missing.
4. **Domain in Resend.** Add `singyourwayhome.sg` in Resend, region `ap-northeast-1` (Tokyo, the closest
   to Singapore). Resend then shows these records to add at **SiteGround → Site Tools → Domain → DNS Zone Editor**:

   | type | host | value | priority |
   | --- | --- | --- | --- |
   | MX | `send` | `feedback-smtp.ap-northeast-1.amazonses.com` | 10 |
   | TXT | `send` | `v=spf1 include:amazonses.com ~all` | |
   | TXT | `resend._domainkey` | `p=MIGfMA0...` (the key Resend shows for this domain) | |

   These only add the `send.` subdomain (bounce handling and SPF for Resend) and a DKIM key. The root MX
   (Google Workspace), the root SPF (`v=spf1 a mx include:_spf.elasticemail.com ~all`) and DMARC
   (`v=DMARC1; p=none; aspf=r; adkim=r;`) stay as they are. Resend mail passes DMARC through the aligned DKIM key.
5. **Sender.** Once Resend shows the domain as verified, set
   `schools/sywh.mail.from = "Sing Your Way Home <notifications@singyourwayhome.sg>"` (a one-line admin
   write, or add `mail` to `functions/scripts/schools/sywh.json` and re-run setup-school).
6. **Deploy** `onAlertCreated`, the changed callables and `firestore.rules`.
7. **TTL policy** (optional, for retention):

   ```bash
   gcloud firestore fields ttls update expireAt --collection-group=alerts --enable-ttl --project=class-app-sg
   ```
