// Student import: CSV reading, phone normalisation, Classcard row mapping and the dedupe plan that the
// review step shows before anything is written. Pure functions, used by the app and the migration scripts.

// ---------------------------------------------------------------------------------------------
// CSV (RFC 4180: quoted fields, "" escapes, CRLF or LF, newlines inside quotes, optional BOM)
// ---------------------------------------------------------------------------------------------

export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** First row is the header; returns one object per data row keyed by header. */
export function csvToObjects(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const [headers = [], ...data] = parseCsv(text);
  const clean = headers.map((h) => h.trim());
  return { headers: clean, rows: data.map((r) => Object.fromEntries(clean.map((h, i) => [h, (r[i] ?? '').trim()]))) };
}

// ---------------------------------------------------------------------------------------------
// Phone numbers -> E.164
// ---------------------------------------------------------------------------------------------

/**
 * '+65 9123 4567', '9123-4567', '(65) 91234567', '6591234567', '0065…' -> '+6591234567'.
 * Numbers with a + (or 00) keep their country code. Returns null when it can't be sure.
 */
export function normalisePhone(raw: string | null | undefined, defaultCountry = '65'): string | null {
  let s = (raw ?? '').trim();
  if (!s || /e\+/i.test(s)) return null; // spreadsheet scientific notation lost digits
  s = s.replace(/^00/, '+');
  const plus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (plus) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (defaultCountry === '65') {
    if (digits.length === 8 && /^[3689]/.test(digits)) return `+65${digits}`;
    if (digits.length === 10 && digits.startsWith('65') && /^[3689]/.test(digits.slice(2))) return `+${digits}`;
  }
  return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
}

export function normaliseEmail(raw: string | null | undefined): string | null {
  const e = (raw ?? '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) ? e : null;
}

// ---------------------------------------------------------------------------------------------
// Classcard export rows -> import candidates
// ---------------------------------------------------------------------------------------------

/** The columns of Classcard's student export (as of 2026-09), header text exactly as exported. */
export const CLASSCARD_STUDENT_HEADERS = [
  'First Name', 'Last Name', 'Name', 'Status', 'Email', 'Phone', 'Guardian Name', 'Guardian Phone',
  'Guardian Email', 'Created On', 'Batch', 'Student ID Prefix', 'Student ID', 'Courses', 'Curriculum',
  'School Year', 'School Name', 'Refferal Source', 'Nationality', 'Area', 'City', 'Date Of Birth', 'Age',
  'Signup Source', 'Gender', 'Last Note', 'Lesson Type', 'Location',
] as const;

export type ImportIssue =
  | 'badEmail'
  | 'badPhone'
  | 'placeholderSurname'
  | 'noLegacyId'
  | 'duplicateLegacyId'
  | 'noName';

export interface ImportCandidate {
  /** Row number in the file (1 = first data row). */
  row: number;
  legacyId: string | null;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  phoneRaw: string;
  status: 'active' | 'inactive';
  createdOn: string | null;
  referralSource: string | null;
  signupSource: string | null;
  note: string | null;
  issues: ImportIssue[];
}

const PLACEHOLDER = new Set(['', '-', '--', '.', '..', '_', '?', 'x', 'xx', 'na', 'n/a', 'nil', 'none', 'unknown', 'tbc', 'tba']);
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** '2024-03-05', '05/03/2024', '5-3-2024', '5 Mar 2024' (day first, as in Singapore) -> 'YYYY-MM-DD'. */
export function parseLooseDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const ok = (y: number, m: number, d: number) =>
    y > 1900 && y < 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return ok(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (m) return ok(+m[3]!, +m[2]!, +m[1]!);
  m = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-,]+(\d{4})/.exec(s);
  if (m && MONTHS[m[2]!.toLowerCase()]) return ok(+m[3]!, MONTHS[m[2]!.toLowerCase()]!, +m[1]!);
  return null;
}

export function mapClasscardRows(rows: Record<string, string>[]): ImportCandidate[] {
  const seenLegacy = new Set<string>();
  return rows.map((r, i) => {
    const issues: ImportIssue[] = [];
    let first = r['First Name'] ?? '';
    let last = r['Last Name'] ?? '';
    if (!first && r['Name']) {
      const parts = r['Name'].trim().split(/\s+/);
      first = parts[0] ?? '';
      last = last || parts.slice(1).join(' ');
    }
    if (PLACEHOLDER.has(last.trim().toLowerCase()) && last.trim() !== '') {
      issues.push('placeholderSurname');
      last = '';
    }
    if (!first.trim()) issues.push('noName');

    const emailRaw = r['Email'] ?? '';
    const email = normaliseEmail(emailRaw);
    if (emailRaw && !email) issues.push('badEmail');
    const phoneRaw = r['Phone'] ?? '';
    const phone = normalisePhone(phoneRaw);
    if (phoneRaw && !phone) issues.push('badPhone');

    const idPart = (r['Student ID'] ?? '').trim();
    let legacyId: string | null = idPart ? `${(r['Student ID Prefix'] ?? '').trim()}${idPart}` : null;
    if (!legacyId) issues.push('noLegacyId');
    else if (seenLegacy.has(legacyId)) {
      issues.push('duplicateLegacyId');
      legacyId = null;
    } else seenLegacy.add(legacyId);

    return {
      row: i + 1,
      legacyId,
      firstName: first.trim(),
      lastName: last.trim(),
      email,
      phone,
      phoneRaw,
      status: (r['Status'] ?? '').trim().toLowerCase() === 'active' ? 'active' : 'inactive',
      createdOn: parseLooseDate(r['Created On']),
      referralSource: r['Refferal Source'] || null,
      signupSource: r['Signup Source'] || null,
      note: r['Last Note'] || null,
      issues,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// The plan: what happens to each row (shown in the review step)
// ---------------------------------------------------------------------------------------------

export type ImportAction = 'create' | 'duplicateInFile' | 'matchesExisting' | 'skip';
export type SkipReason = 'demo' | 'noIdentity' | 'excludedEmail';

export interface ExistingStudent {
  id: string;
  email?: string | null;
  phone?: string | null;
  legacyId?: string | null;
  /** Row number in the export a wholesale import created this student from. */
  importRow?: number | null;
}

export interface PlanRow {
  candidate: ImportCandidate;
  action: ImportAction;
  /** Why it is skipped, or what it matched on. */
  reasons: (SkipReason | 'email' | 'phone' | 'legacyId' | 'importRow')[];
  /** duplicateInFile: the row it duplicates. matchesExisting: the existing student id. */
  matchOf: number | string | null;
}

const DEMO_DOMAINS = ['example.com', 'example.org', 'example.net', 'test.com', 'mailinator.com', 'classcardapp.com', 'classcard.com'];
const DEMO_WORD = /\b(test|demo|sample|dummy)\b/i;

export function isDemoRow(c: ImportCandidate): boolean {
  const domain = c.email?.split('@')[1] ?? '';
  return (
    DEMO_DOMAINS.includes(domain) ||
    domain.endsWith('.test') ||
    DEMO_WORD.test(`${c.firstName} ${c.lastName}`) ||
    (c.email !== null && DEMO_WORD.test(c.email.split('@')[0]!))
  );
}

export interface PlanOptions {
  /** e.g. the owner's own address, so their Classcard test account is left out. */
  excludeEmails?: string[];
  /**
   * Import every row exactly as exported: no demo/excluded/duplicate skipping, no matching on email or
   * phone. Only a row already imported (same export row number) is left alone, so re-runs are safe.
   */
  wholesale?: boolean;
}

export function planImport(candidates: ImportCandidate[], existing: ExistingStudent[], opts: PlanOptions = {}): PlanRow[] {
  if (opts.wholesale) {
    const done = new Map(existing.filter((s) => s.importRow != null).map((s) => [s.importRow!, s.id]));
    return candidates.map((c) =>
      done.has(c.row)
        ? { candidate: c, action: 'matchesExisting', reasons: ['importRow'], matchOf: done.get(c.row)! }
        : { candidate: c, action: 'create', reasons: [], matchOf: null },
    );
  }
  const exclude = new Set((opts.excludeEmails ?? []).map((e) => e.trim().toLowerCase()));
  const byEmail = new Map<string, string>();
  const byPhone = new Map<string, string>();
  const byLegacy = new Map<string, string>();
  for (const s of existing) {
    if (s.email) byEmail.set(s.email.toLowerCase(), s.id);
    if (s.phone) byPhone.set(s.phone, s.id);
    if (s.legacyId) byLegacy.set(s.legacyId, s.id);
  }
  const fileEmail = new Map<string, number>();
  const filePhone = new Map<string, number>();

  return candidates.map((c) => {
    if (c.email && exclude.has(c.email)) return { candidate: c, action: 'skip', reasons: ['excludedEmail'], matchOf: null };
    if (isDemoRow(c)) return { candidate: c, action: 'skip', reasons: ['demo'], matchOf: null };
    if (!c.firstName && !c.email) return { candidate: c, action: 'skip', reasons: ['noIdentity'], matchOf: null };

    const hits: { on: 'email' | 'phone' | 'legacyId'; id: string }[] = [];
    if (c.legacyId && byLegacy.has(c.legacyId)) hits.push({ on: 'legacyId', id: byLegacy.get(c.legacyId)! });
    if (c.email && byEmail.has(c.email)) hits.push({ on: 'email', id: byEmail.get(c.email)! });
    if (c.phone && byPhone.has(c.phone)) hits.push({ on: 'phone', id: byPhone.get(c.phone)! });
    if (hits.length) return { candidate: c, action: 'matchesExisting', reasons: hits.map((h) => h.on), matchOf: hits[0]!.id };

    const dupes: ('email' | 'phone')[] = [];
    let matchOf: number | null = null;
    if (c.email && fileEmail.has(c.email)) {
      dupes.push('email');
      matchOf = fileEmail.get(c.email)!;
    }
    if (c.phone && filePhone.has(c.phone)) {
      dupes.push('phone');
      matchOf ??= filePhone.get(c.phone)!;
    }
    if (dupes.length) return { candidate: c, action: 'duplicateInFile', reasons: dupes, matchOf };

    if (c.email) fileEmail.set(c.email, c.row);
    if (c.phone) filePhone.set(c.phone, c.row);
    return { candidate: c, action: 'create', reasons: [], matchOf: null };
  });
}

/** Counts per action, for the review summary and the migration report. */
export function summarisePlan(plan: PlanRow[]): Record<ImportAction, number> {
  const out: Record<ImportAction, number> = { create: 0, duplicateInFile: 0, matchesExisting: 0, skip: 0 };
  for (const p of plan) out[p.action] += 1;
  return out;
}
