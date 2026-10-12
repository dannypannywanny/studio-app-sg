# Session 2: settle lessons from March 2026 and earlier (replay review, month by month)

Paste into a new Claude Code session in the lessonly repo (any worktree; it needs the raw data below).

---

Continue the LessonKaki **lessons replay reconciliation** for school `sywh` (Firebase `class-app-sg`).
Read `CLAUDE.md`, `functions/scripts/migrate/README.md` (§3), `functions/src/replay.ts` and your memory notes
`lessonkaki-lessons-replay`, `lessonkaki-m3-progress`.

## State (2026-10-13)
- Classcard history was replayed into production (261 lots, 1,027 lessons; lessons Classcard marked present are
  marked present; ~80 past ones Classcard never marked stayed *booked* for Daniel to mark; expired packages
  not carried over). Daniel has no Classcard access any more: he reconciles from memory and WhatsApp.
- **Done: April 2026 to October 2026** (sheets applied with `apply-review.ts`; `reopen-pending.ts` keeps
  sessions for lessons still to be marked). **Left: May 2025 to March 2026** (about 800 replayed lessons, ~60
  past ones unmarked, plus owed lessons and ~45 packages Classcard data couldn't size).
- Daniel said: he can't recall dates, so give him months in small pieces; never ask him to answer lists from
  memory. Pre-Classcard students used his old (Calendly-era, lower price) packages, so sizes of old packages
  are unknown and fine to leave flagged. Lessons with no student in Classcard (time off / cancelled sessions
  whose name was removed) are intentionally left out.

## Data (gitignored, personal: never commit, never print names/emails in chat output; counts only)
Raw files live in the previous session's worktree:
`/Users/danielleetaehyung/Projects/lessonly/.claude/worktrees/lessonkaki-lessons-replay-f7880b/migration/raw/`
(copy `replay-plan.json`, `replay-state.json`, `replay-months.xlsx`, `replay-reconcile.xlsx`, `open-invoices.json`
into your worktree's `migration/raw/`). If that worktree is gone, regenerate with
`functions/scripts/migrate/replay-lessons.ts --plan` (needs the other raw TSVs; ask Daniel / re-pull with the
read-only classcard MCP if so, OAuth may need `/mcp`).
Python helpers (need `openpyxl`; use a throwaway venv): `functions/scripts/migrate/py/months_sheet.py`
(builds the month tabs), `reconcile_sheet.py` (balances/packages/owed/attendance sheet) and
`review_actions.py` (annotated sheet to actions JSON). NOTE: `replay-state.json` was dumped from an emulator
rehearsal (student ids/names correct, lesson ids `cc-<eventId>` identical to production, balances are not):
for statuses, **export a fresh read-only snapshot from production** before building sheets, so lessons already
marked/cancelled don't show as pending.

## Do
1. Read-only production export; build per-month sheets for May 2025 to March 2026 showing only what still needs
   a decision (past, booked/unmarked lessons; owed lessons with the reason; students whose balance looks wrong).
2. Hand Daniel one or two months at a time (attach the xlsx). He answers in the "Happened? (Y/N)" column:
   `Y`, `CANCELLATION BY ME`, `CANCELLATION BY STUDENT`. Apply with `review_actions.py` then
   `apply-review.ts --file ... --project class-app-sg` (dry run first, show counts), then
   `reopen-pending.ts --project class-app-sg`, then `reconcileLedger` must report 0 problems.
3. For students whose balance he disputes: use the `adjustCredits` flow (reason required) or correct a package
   size (a package's size is NOT changed by re-running the replay; adjust by hand and say so).
4. Packages Classcard couldn't size (`replay-review.md`, "Packages to confirm" tab): ask only for the few that
   change a balance by more than 1 session.
5. Keep `docs/running-the-studio.md` honest about what is still approximate.

## Rules
Production writes only with `--project class-app-sg` and only on instruction from Daniel in the chat (his
annotated sheet counts as instruction for the rows he answered). No emails to students from this session.
Commit script/test changes on a branch, show `git status` first, fast-forward main, push when Daniel says so.
