import { describe, expect, it } from 'vitest';
import { csvToObjects, mapClasscardRows, normalisePhone, parseCsv, parseLooseDate, planImport } from './studentImport';

describe('CSV', () => {
  it('reads quotes, escaped quotes, commas and newlines inside quotes, CRLF and a BOM', () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n\r\nplain,,end\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
      ['plain', '', 'end'],
    ]);
  });
  it('maps rows to objects by header', () => {
    expect(csvToObjects('"First Name",Email\nAda, ada@x.sg \n').rows).toEqual([{ 'First Name': 'Ada', Email: 'ada@x.sg' }]);
  });
});

describe('phone and date normalisation', () => {
  it('turns Singapore formats into E.164', () => {
    for (const raw of ['+65 9123 4567', '9123-4567', '91234567', '(65) 9123 4567', '6591234567', '0065 91234567', '+65-9123-4567']) {
      expect(normalisePhone(raw), raw).toBe('+6591234567');
    }
    expect(normalisePhone('+44 7700 900123')).toBe('+447700900123');
    expect(normalisePhone('6.59123E+09')).toBeNull();
    expect(normalisePhone('12345')).toBeNull();
    expect(normalisePhone('')).toBeNull();
  });
  it('reads day-first dates', () => {
    expect(parseLooseDate('2024-03-05')).toBe('2024-03-05');
    expect(parseLooseDate('05/03/2024')).toBe('2024-03-05');
    expect(parseLooseDate('5 Mar 2024')).toBe('2024-03-05');
    expect(parseLooseDate('05-03-2024 10:30')).toBe('2024-03-05');
    expect(parseLooseDate('soon')).toBeNull();
  });
});

describe('planImport', () => {
  const row = (o: Record<string, string>) => ({ 'First Name': 'A', 'Last Name': 'B', Status: 'Active', ...o });

  it('creates new people once, flags duplicates in the file and matches with existing students', () => {
    const candidates = mapClasscardRows([
      row({ 'First Name': 'Ada', Email: 'Ada@Mail.sg', Phone: '9123 4567', 'Student ID Prefix': 'S', 'Student ID': '1' }),
      row({ 'First Name': 'Ada', 'Last Name': 'Again', Email: 'ada@mail.sg', 'Student ID Prefix': 'S', 'Student ID': '1' }),
      row({ 'First Name': 'Partner', Phone: '+65 9123-4567' }),
      row({ 'First Name': 'Cy', Email: 'cy@mail.sg' }),
      row({ 'First Name': 'Test', 'Last Name': 'Student', Email: 'test@school.sg' }),
      row({ 'First Name': 'Dee', 'Last Name': '-', Email: 'dee@example.com' }),
      row({ 'First Name': '', 'Last Name': '' }),
      row({ 'First Name': 'Owner', Email: 'owner@studio.sg' }),
    ]);
    expect(candidates[0]).toMatchObject({ email: 'ada@mail.sg', phone: '+6591234567', legacyId: 'S1', status: 'active' });
    expect(candidates[1]!.issues).toContain('duplicateLegacyId');
    expect(candidates[5]!.issues).toContain('placeholderSurname');
    expect(candidates[5]!.lastName).toBe('');

    const plan = planImport(candidates, [{ id: 'existing-cy', email: 'cy@mail.sg' }], { excludeEmails: ['OWNER@studio.sg'] });
    expect(plan.map((p) => [p.action, p.reasons, p.matchOf])).toEqual([
      ['create', [], null],
      ['duplicateInFile', ['email'], 1],
      ['duplicateInFile', ['phone'], 1],
      ['matchesExisting', ['email'], 'existing-cy'],
      ['skip', ['demo'], null],
      ['skip', ['demo'], null],
      ['skip', ['noIdentity'], null],
      ['skip', ['excludedEmail'], null],
    ]);
  });

  it('splits the Name column when First Name is empty', () => {
    const [c] = mapClasscardRows([{ 'First Name': '', 'Last Name': '', Name: 'Mei Ling Tan', Status: 'Inactive' }]);
    expect(c).toMatchObject({ firstName: 'Mei', lastName: 'Ling Tan', status: 'inactive' });
  });
});
