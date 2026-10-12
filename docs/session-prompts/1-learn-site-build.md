# Session 1: build learn.singyourwayhome.sg (student portal + booking), ASAP

Paste this into a new Claude Code session in the lessonly repo (start from `main`, new worktree).

---

Build and launch **learn.singyourwayhome.sg** for LessonKaki (school `sywh`, Firebase project `class-app-sg`).
Read `CLAUDE.md`, `replica/architecture.md` (§2, §3, §5, §6, §7), `docs/running-the-studio.md`,
`docs/email-alerts.md`, and the existing `apps/teach` app (copy its conventions: Vite + React 19 + react-router,
`hooks.ts` live queries, `session.tsx` claims, `styles/tokens.css`) before designing anything.

## Why / urgency
Classcard is suspended; its booking page on learn.* is dead, so students can't book. Daniel wants learn.* live
ASAP (he is working through lesson balances separately and they will be off for a while).
**First cohort: every student with a lesson since April 2026 (64 students). They must be able to book even
if their balance is wrong or zero**: booking is never blocked by credit (policy `allowOwedLessons`; the
lesson goes owed and settles when credit is added). Older students and brand-new people come later.

## What exists / what doesn't
- Exists: Firestore data model, credit engine, `cancelAttendance` (student role supported), `createLesson`,
  `addAttendee`, security rules for student reads (`myStudent`), `setMemberRole` (creates the Auth user, sets
  claims `{r,t,s}`, links `students/{id}.uid`), owner email alerts (`enqueueAlert`, Resend outbox),
  Hosting site `class-app-sg-learn` + target `learn` in `.firebaserc` (no `firebase.json` entry yet).
- Does NOT exist: `apps/learn`, student sign-in/invite flow, availability rules + `getAvailability`, a booking
  callable, student portal, HitPay. Auth self sign-up is disabled (accounts come from `setMemberRole`/server
  only). `learn.singyourwayhome.sg` is not in Auth's authorised domains and its DNS still points at Classcard.
- Students (272 in prod, ids `ccrow-<exportRow>`, plus SYWH272/273 by `legacyId`) have emails from the Classcard
  export (some shared/duplicates: check before sending anything to a shared address).

## Scope of the first launch (a thin vertical slice, ship it, then iterate)
1. **Sign-in**: email link (like teach, no password). A callable `inviteStudents` (owner-only) creates Auth users
   for chosen students and sets student claims via `setMemberRole`; ids/emails never in URLs. Students on a
   shared email need a sane rule (don't send to a shared address without owner review).
2. **Portal**: upcoming lessons (with Cancel, using the existing student cancel rules: late cancel is the studio's
   policy), sessions left, owed lessons, past lessons, invoices if any (read-only).
3. **Availability**: teacher weekly hours + exceptions as in the data model (`availability/{teacherId}`), a
   minimal owner screen in teach (or a script as a stopgap; Daniel will supply his weekly hours), and a callable
   `getAvailability` that returns open slots for 45-minute lessons (buffer/min-notice/horizon from the doc).
4. **Booking**: callable `bookLesson` (student role): validates the slot server-side in a transaction (teacher
   conflicts, slotLock per `architecture.md` §7), creates the lesson + attendee `source: 'portal'`, enqueues the
   owner alert. Credit is debited on mark as today (`debitOn: 'mark'`), nothing is charged at booking.
   Online vs in-person choice; one-on-one only for now.
5. **UI/UX**: use Daniel's **taste-skill** (Leonxlnx pack, installed at
   `~/pinkpass/.claude/worktrees/install-taste-skill-9d3d34/.agents/skills/`; read the SKILL.md files there,
   NOT `ecc:taste`). It was used for the singyourwayhome.sg redesign (see memory `sywh-website-rebuild`): match
   that look. Mobile first (students book on phones). Teach app visuals are a later pass; don't restyle teach now.
6. **Hosting**: add the `learn` target to `firebase.json`, build to `apps/learn/dist`, deploy to the learn site
   (default `*.web.app` URL first). Add `learn.singyourwayhome.sg` and the web.app host to Auth authorised domains.

Out of scope for launch: card payment (HitPay), public booking for non-students, packages purchase, group
lessons, teachers other than Daniel/Allie (keep `teacherId` plumbed).

## Hard rules
- Tests for every new function (emulator; follow `functions/test/*`), rules tests for new reads/writes, `pnpm
  lint && pnpm typecheck && pnpm test` green before each commit. Never commit student data (CLAUDE.md).
- **Ask Daniel before**: sending any email/invite to students, deploying to production (functions, rules,
  hosting), changing DNS / switching the learn.* domain from Classcard, creating Auth users in production.
  Rehearse on the emulator and show him the result first. Production writes need `--project class-app-sg`
  (see `functions/scripts/target.ts`).
- Don't break teach: `cancelAttendance`/`markAttendance`/credit engine behaviour must stay as is (tests exist).
- Pending separate item you may also do if Daniel agrees: deploy the teach app (`Lessons` page now has a
  "Past, not marked" filter; its Firestore index is already deployed).
- Commit on the worktree branch, show `git status` before each commit, then fast-forward merge into main and
  push when Daniel says so.

Finish by giving Daniel: the preview URL, a 10-line "how students sign in and book" note, the list of what
you need from him (weekly hours, which students to invite first, domain cutover go-ahead).
