import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLASSCARD_STUDENT_HEADERS, csvToObjects, mapClasscardRows, planImport, summarisePlan } from '@lessonkaki/shared';
import { importStudents } from '../src/importStudents';
import { applyOpeningBalances, checkOpeningBalances, validateMigration, type OpeningBalances } from '../src/migrate';
import { db, ledger, owner, summary, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();
const fixture = readFileSync(new URL('./fixtures/students.synthetic.csv', import.meta.url), 'utf8');
const EXCLUDE = ['owner@lessonkaki.test'];

async function studentsOf(t: TestSchool) {
  const snap = await db.collection(`schools/${t.schoolId}/students`).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, any> & { id: string });
}

describe('student CSV import', () => {
  it('the synthetic fixture has exactly the Classcard export columns', () => {
    expect(csvToObjects(fixture).headers).toEqual([...CLASSCARD_STUDENT_HEADERS]);
  });

  it('plans the fixture: dedupes by email and E.164 phone, skips demo and excluded rows', () => {
    const plan = planImport(mapClasscardRows(csvToObjects(fixture).rows), [], { excludeEmails: EXCLUDE });
    expect(summarisePlan(plan)).toEqual({ create: 8, duplicateInFile: 2, matchesExisting: 0, skip: 2 });
    const byName = (n: string) => plan.find((p) => `${p.candidate.firstName} ${p.candidate.lastName}`.trim() === n)!;
    expect(byName('Bravo Example').action).toBe('create');
    expect(byName('Echo Partner')).toMatchObject({ action: 'duplicateInFile', reasons: ['phone'], matchOf: 4 });
    expect(byName('Charlie').candidate).toMatchObject({ phone: '+6590000003', issues: ['placeholderSurname'] });
    expect(byName('Foxtrot').candidate.issues).toEqual(['placeholderSurname', 'duplicateLegacyId']);
    expect(byName('Golf Example').candidate).toMatchObject({ phone: null, issues: ['badPhone'] });
    expect(byName('India Example').candidate.legacyId).toBe('SY010');
  });

  it('creates the reviewed rows with legacyId, and never duplicates on a second run', async () => {
    const t = await school();
    const before = (await studentsOf(t)).length;
    const plan = planImport(mapClasscardRows(csvToObjects(fixture).rows), [], { excludeEmails: EXCLUDE });
    const chosen = plan.filter((p) => p.action === 'create').map((p) => p.candidate);

    const res = await importStudents(db, { schoolId: t.schoolId, rows: chosen, excludeEmails: EXCLUDE }, owner);
    expect(res.created).toBe(8);
    const all = await studentsOf(t);
    expect(all.length - before).toBe(8);
    const alpha = all.find((s) => s.legacyId === 'SY001')!;
    expect(alpha).toMatchObject({
      firstName: 'Alpha',
      email: 'alpha.testa@example-mail.sg',
      phone: '+6590000001',
      status: 'active',
      createdOn: '2025-01-05',
      summary: { sessionsAvailable: 0, sessionsOwed: 0, outstandingCents: 0, moneyCreditCents: 0 },
    });
    const note = await db.doc(`schools/${t.schoolId}/students/${alpha.id}/private/notes`).get();
    expect(note.get('text')).toMatch(/breath support/);
    expect(alpha.notes).toBeUndefined(); // staff notes live in private/, not on the student doc

    // Same rows again (e.g. a retried or stale review): everything now matches an existing student.
    const again = await importStudents(db, { schoolId: t.schoolId, rows: chosen, excludeEmails: EXCLUDE }, owner);
    expect(again.created).toBe(0);
    expect(again.skipped.every((s) => s.action === 'matchesExisting')).toBe(true);
    expect((await studentsOf(t)).length - before).toBe(8);
  });
});

describe('opening balances (migration)', () => {
  it('writes migrate lots and money credit once, and validates the totals to the cent', async () => {
    const t = await school();
    await db.doc(`schools/${t.schoolId}/students/${t.studentId}`).update({ legacyId: 'SY001' });
    const balances: OpeningBalances = {
      source: 'synthetic test',
      lots: [
        { legacyLotId: 'L1', legacyStudentId: 'SY001', packageName: '4 Sessions', sessionsRemaining: 3, validUntil: '2099-12-31', legacyInvoiceNumber: 'CC-1' },
        { legacyLotId: 'L2', legacyStudentId: 'SY001', packageName: '10 Sessions', sessionsRemaining: 7, validUntil: null, legacyInvoiceNumber: null },
      ],
      moneyCredits: [{ legacyStudentId: 'SY001', cents: 4550 }],
      expected: { students: 1, sessions: 10, moneyCreditCents: 4550 },
    };
    const res = await applyOpeningBalances(db, t.schoolId, balances, owner);
    expect(res).toEqual({ lotsCreated: 2, moneyCreditsCreated: 1, unknownStudents: [] });
    expect(await summary(t)).toEqual({ sessionsAvailable: 10, sessionsOwed: 0 });
    expect((await ledger(t)).filter((e) => e.type === 'migrate').map((e) => e.delta).sort()).toEqual([3, 7]);

    expect(await applyOpeningBalances(db, t.schoolId, balances, owner)).toEqual({ lotsCreated: 0, moneyCreditsCreated: 0, unknownStudents: [] });
    expect(await validateMigration(db, t.schoolId, balances.expected)).toEqual({
      ok: true,
      actual: { students: 1, sessions: 10, moneyCreditCents: 4550 },
      diffs: [],
    });
    expect(
      (await validateMigration(db, t.schoolId, { ...balances.expected, moneyCreditCents: 4500 })).diffs,
    ).toEqual(['moneyCreditCents: expected 4500, found 4550']);
  });

  it('reports lots for students it cannot find instead of guessing', async () => {
    const t = await school();
    const res = await applyOpeningBalances(
      db,
      t.schoolId,
      {
        source: 'synthetic',
        lots: [{ legacyLotId: 'X', legacyStudentId: 'NOPE', packageName: 'P', sessionsRemaining: 1, validUntil: null, legacyInvoiceNumber: null }],
        moneyCredits: [],
        expected: { students: 0, sessions: 0, moneyCreditCents: 0 },
      },
      owner,
    );
    expect(res.unknownStudents).toEqual(['NOPE']);
    expect(res.lotsCreated).toBe(0);
  });
});

describe('wholesale student import', () => {
  const rows = () => mapClasscardRows(csvToObjects(fixture).rows);

  it('plans every row as create: no demo, excluded or duplicate skipping', () => {
    const plan = planImport(rows(), [], { excludeEmails: EXCLUDE, wholesale: true });
    expect(summarisePlan(plan)).toEqual({ create: rows().length, duplicateInFile: 0, matchesExisting: 0, skip: 0 });
  });

  it('creates every row once, by export row, keeping the raw phone; a re-run creates nothing', async () => {
    const t = await school();
    const before = (await studentsOf(t)).length;
    const all = rows();
    const res = await importStudents(db, { schoolId: t.schoolId, rows: all, wholesale: true }, owner);
    expect(res.created).toBe(all.length);
    const created = (await studentsOf(t)).filter((s) => typeof s.importRow === 'number');
    expect(created.length).toBe(all.length);
    expect((await studentsOf(t)).length - before).toBe(all.length);
    for (const s of created) expect(s.id).toBe(`ccrow-${s.importRow}`);
    const golf = created.find((s) => s.firstName === 'Golf')!;
    expect(golf).toMatchObject({ phone: null }); // unreadable phone: normalised value empty...
    expect(golf.phoneRaw).toBeTruthy(); // ...but the exported text is kept

    const again = await importStudents(db, { schoolId: t.schoolId, rows: all, wholesale: true }, owner);
    expect(again.created).toBe(0);
    expect(again.skipped.every((s) => s.action === 'matchesExisting' && s.reasons.includes('importRow'))).toBe(true);
  });
});

describe('opening balances for wholesale-imported students', () => {
  it('finds students by export row (blank code) or by code, and refuses a code two students share', async () => {
    const t = await school();
    const all = mapClasscardRows(csvToObjects(fixture).rows);
    await importStudents(db, { schoolId: t.schoolId, rows: all, wholesale: true }, owner);
    const noCode = all.find((c) => c.issues.includes('duplicateLegacyId'))!; // its reused code is blanked
    expect(noCode.legacyId).toBeNull();
    const plain = all.find((c) => c.legacyId === 'SY001')!;
    const lot = (id: string, who: string, n: number) => ({
      legacyLotId: id, legacyStudentId: who, packageName: 'Migrated', sessionsRemaining: n, validUntil: null, legacyInvoiceNumber: null,
    });
    const res = await applyOpeningBalances(
      db,
      t.schoolId,
      { source: 'test', lots: [lot('W1', `row:${noCode.row}`, 2), lot('W2', 'SY001', 3)], moneyCredits: [], expected: { students: 2, sessions: 5, moneyCreditCents: 0 } },
      owner,
    );
    expect(res).toMatchObject({ lotsCreated: 2, unknownStudents: [] });
    expect((await summary(t, `ccrow-${noCode.row}`)).sessionsAvailable).toBe(2);
    expect((await summary(t, `ccrow-${plain.row}`)).sessionsAvailable).toBe(3);

    // A second student carrying SY002 makes that code ambiguous: refused, nothing granted.
    await db.doc(`schools/${t.schoolId}/students/dup-sy002`).set({ firstName: 'Dup', legacyId: 'SY002', summary: { sessionsAvailable: 0, sessionsOwed: 0 } });
    const again = await applyOpeningBalances(
      db,
      t.schoolId,
      { source: 'test', lots: [lot('W3', 'SY002', 1)], moneyCredits: [], expected: { students: 2, sessions: 5, moneyCreditCents: 0 } },
      owner,
    );
    expect(again).toMatchObject({ lotsCreated: 0, unknownStudents: ['SY002'] });
    await db.doc(`schools/${t.schoolId}/students/dup-sy002`).delete(); // keep the ledger invariant check clean
  });
});

describe('checkOpeningBalances', () => {
  const ok: OpeningBalances = {
    source: 'test',
    lots: [{ legacyLotId: 'L1', legacyStudentId: 'S1', packageName: '4 Sessions', sessionsRemaining: 3, validUntil: '2026-12-31', legacyInvoiceNumber: null }],
    moneyCredits: [{ legacyStudentId: 'S1', cents: 0 }],
    expected: { students: 1, sessions: 3, moneyCreditCents: 0 },
  };

  it('accepts a complete file (0 sessions and 0 cents are allowed)', () => {
    expect(checkOpeningBalances(ok)).toEqual([]);
    expect(checkOpeningBalances({ ...ok, lots: [{ ...ok.lots[0]!, sessionsRemaining: 0, validUntil: null }] })).toEqual([]);
  });

  it('refuses blanks, bad dates, duplicates and fractions instead of skipping them', () => {
    const bad = {
      ...ok,
      lots: [
        { ...ok.lots[0]!, sessionsRemaining: null as unknown as number },
        { ...ok.lots[0]!, validUntil: '31/12/2026' },
        { ...ok.lots[0]!, legacyLotId: 'L2', validUntil: 'TODO' },
      ],
      moneyCredits: [{ legacyStudentId: 'S1', cents: 12.5 }],
      expected: { students: 1, sessions: -1, moneyCreditCents: 0 },
    };
    const problems = checkOpeningBalances(bad);
    expect(problems.join('\n')).toMatch(/lots\[0\].*sessionsRemaining/);
    expect(problems.join('\n')).toMatch(/lots\[1\].*used twice/);
    expect(problems.join('\n')).toMatch(/lots\[1\].*validUntil/);
    expect(problems.join('\n')).toMatch(/lots\[2\].*validUntil/);
    expect(problems.join('\n')).toMatch(/moneyCredits\[0\].*cents/);
    expect(problems.join('\n')).toMatch(/expected.sessions/);
  });

  it('applyOpeningBalances refuses a file with problems and writes nothing', async () => {
    await expect(
      applyOpeningBalances(db, 'no-such-school', { ...ok, lots: [{ ...ok.lots[0]!, sessionsRemaining: NaN }] }, owner),
    ).rejects.toThrow(/problems/);
  });
});
