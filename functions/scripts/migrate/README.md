# Migration from Classcard

Order (from CLAUDE.md): raw staging → transform → validation (counts, outstanding credits to the cent) →
2–3 week parallel run → cutover at a billing boundary → keep Classcard read-only one more month.

Student data is personal data. The export and everything these scripts write stay out of git:
`*.csv` (except `functions/test/fixtures/*.synthetic.csv`), `data/` and `migration/raw/` are gitignored.
Classcard is only ever read (the `classcard` MCP connector is read-only; never write to it).

Scripts run against the emulator (a `demo-*` project with `FIRESTORE_EMULATOR_HOST` set) unless given an
explicit `--project class-app-sg` (see `../target.ts`); production runs need a separate go-ahead.

**What actually happened (M3, 2026-10-12):** Classcard was suspended before a parallel run, attendance was
partly unmarked, and the API never exposed sessions left. So: students are imported **wholesale** (every
export row as-is), and opening balances come from a sheet the owner fills in (section 2b).

## 1. Students (CSV export)

```sh
# with emulators up (pnpm emulators) and the school seeded
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
pnpm --filter functions exec tsx scripts/migrate/import-students.ts \
  --file ~/Downloads/students-2026-09-23.csv --exclude-email you@yourstudio.sg
```

This writes `migration/raw/student-import-review.json` and prints counts only. Every row gets an
action: `create`, `duplicateInFile` (same email or E.164 phone as an earlier row), `matchesExisting`, or
`skip` (Classcard demo rows, excluded emails, rows with no name or email). Issues such as placeholder
surnames, unreadable phones and blank/duplicate Classcard ids are listed per row. Edit the file (change
an action to `skip`, or a duplicate to `create`), then:

```sh
pnpm --filter functions exec tsx scripts/migrate/import-students.ts --apply
```

The Classcard id (`Student ID Prefix` + `Student ID`) is kept as `legacyId`. Re-running is safe: rows
that now match an existing student (by legacyId, email or phone) are skipped.

The same import is in the app (Students → Import CSV) with an on-screen review.

Wholesale (every row exactly as exported, nothing skipped or merged; re-runs are safe):

```sh
pnpm --filter functions exec tsx scripts/migrate/import-students.ts --file <export.csv> --wholesale
pnpm --filter functions exec tsx scripts/migrate/import-students.ts --apply   # follows the review's mode
```

## 2. Opening balances

Classcard's API doesn't expose sessions left per enrolment, so fill `migration/raw/opening-balances.json`
(shape: `opening-balances.example.json`) from:

- the classcard MCP, read-only: `list_students`, `list_invoices`, `list_packages`, `list_payments`;
- each active student's Enrollments panel (sessions left, valid-till date, invoice), and the
  "Invoice credit balance" for money credit;
- Classcard's own totals for `expected` (students with balances, total sessions, total money credit).

```sh
pnpm --filter functions exec tsx scripts/migrate/opening-balances.ts
```

Each lot becomes a `migrate` grant on its own enrolment; money credit becomes a `migrate` moneyLedger
entry. Idempotent per lot and per student. The script exits non-zero when the totals don't match.

## 2b. Opening balances from the owner's sheet (used for M3)

`migration/raw/classcard-activity.tsv` holds Classcard invoices since May 2025 (read via the MCP). Then:

```sh
pnpm --filter functions exec tsx scripts/migrate/balances-sheet.ts --make --export <export.csv>
# fill sessionsLeft (every row, 0 if none), validUntil (YYYY-MM-DD or none), moneyCreditSGD (blank = 0)
pnpm --filter functions exec tsx scripts/migrate/balances-sheet.ts --to-json
pnpm --filter functions exec tsx scripts/migrate/opening-balances.ts            # emulator first
```

Rows are keyed by export row (`row:<n>`), so blank or shared Classcard codes work. `--to-json` refuses the
sheet if any row is blank or malformed; `expected` is the sheet's own totals, and `validateMigration`
checks the database against them.
