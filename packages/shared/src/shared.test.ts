import { describe, expect, it } from 'vitest';
import {
  DEFAULT_POLICY,
  addDays,
  consumesCredit,
  centsToDecimal,
  formatMoney,
  isOverdue,
  parseMoney,
  formatRrule,
  parseRrule,
  resolvePolicy,
  startOfWeek,
  wallClockToUtc,
  wallDateOf,
  weekdayOf,
  weeklyOccurrences,
} from './index';
import { buildPayNowPayload, crc16, hasValidCrc, parseTlv, withCrc } from './paynow';
import { atRiskStudents, summariseAttendance } from './reports';
import { brandingCssVars, googleFontsHref } from './branding';

describe('consumesCredit', () => {
  it('present always uses a credit, booked never does', () => {
    expect(consumesCredit('present', DEFAULT_POLICY)).toBe(true);
    expect(consumesCredit('booked', DEFAULT_POLICY)).toBe(false);
  });
  it('absent follows absentConsumesCredit', () => {
    expect(consumesCredit('absent', DEFAULT_POLICY)).toBe(true);
    expect(consumesCredit('absent', { ...DEFAULT_POLICY, absentConsumesCredit: false })).toBe(false);
  });
  it('late cancel follows lateCancelReturnsCredit', () => {
    expect(consumesCredit('lateCancelled', DEFAULT_POLICY)).toBe(false);
    expect(consumesCredit('lateCancelled', { ...DEFAULT_POLICY, lateCancelReturnsCredit: false })).toBe(true);
  });
  it('resolvePolicy fills missing fields from the defaults', () => {
    expect(resolvePolicy({ absentConsumesCredit: false })).toEqual({ ...DEFAULT_POLICY, absentConsumesCredit: false });
    expect(resolvePolicy(undefined)).toEqual(DEFAULT_POLICY);
  });
});

describe('formatMoney', () => {
  it('formats integer cents', () => {
    expect(formatMoney(30000)).toBe('$300.00');
    expect(formatMoney(5)).toBe('$0.05');
  });
  it('rejects fractional cents', () => {
    expect(() => formatMoney(10.5)).toThrow();
  });
});

describe('wallClockToUtc', () => {
  it('converts Singapore wall clock to UTC', () => {
    expect(wallClockToUtc('2026-10-12', '19:30', 'Asia/Singapore').toISOString()).toBe('2026-10-12T11:30:00.000Z');
    expect(wallClockToUtc('2026-10-12', '03:00', 'Asia/Singapore').toISOString()).toBe('2026-10-11T19:00:00.000Z');
  });
});

describe('rrule-lite', () => {
  it('round-trips weekly rules and orders days', () => {
    expect(formatRrule({ byDay: ['WE', 'MO'] })).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    expect(formatRrule({ byDay: ['FR'], until: '2026-12-31' })).toBe('FREQ=WEEKLY;BYDAY=FR;UNTIL=20261231');
    expect(parseRrule('FREQ=WEEKLY;BYDAY=WE,MO;UNTIL=20261231')).toEqual({ byDay: ['MO', 'WE'], until: '2026-12-31' });
    expect(() => parseRrule('FREQ=DAILY')).toThrow();
    expect(() => parseRrule('FREQ=WEEKLY;BYDAY=XX')).toThrow();
  });

  it('does wall-date arithmetic', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(weekdayOf('2026-10-14')).toBe('WE');
    expect(startOfWeek('2026-10-18')).toBe('2026-10-12');
    expect(wallDateOf(new Date('2026-10-11T17:00:00Z'), 'Asia/Singapore')).toBe('2026-10-12');
  });

  it('lists occurrences in the window, at the wall-clock time, skipping exdates and after until', () => {
    const occ = weeklyOccurrences({
      startDate: '2026-10-14',
      time: '19:00',
      timeZone: 'Asia/Singapore',
      rule: { byDay: ['MO', 'WE'], until: '2026-10-28' },
      from: '2026-10-01',
      to: '2026-12-01',
      exdates: ['2026-10-19'],
    });
    expect(occ.map((o) => o.date)).toEqual(['2026-10-14', '2026-10-21', '2026-10-26', '2026-10-28']);
    expect(occ[0]!.startAt.toISOString()).toBe('2026-10-14T11:00:00.000Z');
  });

  it('keeps local time across a DST change', () => {
    const occ = weeklyOccurrences({
      startDate: '2026-10-21',
      time: '18:00',
      timeZone: 'Europe/London',
      rule: { byDay: ['WE'] },
      from: '2026-10-21',
      to: '2026-11-05',
    });
    expect(occ.map((o) => o.startAt.toISOString())).toEqual([
      '2026-10-21T17:00:00.000Z',
      '2026-10-28T18:00:00.000Z',
      '2026-11-04T18:00:00.000Z',
    ]);
  });
});

describe('money input', () => {
  it('parses typed amounts into cents', () => {
    expect(parseMoney('120')).toBe(12000);
    expect(parseMoney('120.5')).toBe(12050);
    expect(parseMoney(' $1,200.05 ')).toBe(120005);
    expect(parseMoney('S$80')).toBe(8000);
    expect(parseMoney('1.234')).toBeNull();
    expect(parseMoney('-5')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });
  it('formats cents as a decimal string', () => {
    expect(centsToDecimal(12050)).toBe('120.50');
    expect(centsToDecimal(5)).toBe('0.05');
    expect(() => centsToDecimal(-1)).toThrow();
  });
  it('knows when an invoice is overdue', () => {
    const due = { toMillis: () => Date.parse('2026-10-01T00:00:00Z') };
    const at = new Date('2026-10-02T00:00:00Z');
    expect(isOverdue({ status: 'sent', dueDate: due }, at)).toBe(true);
    expect(isOverdue({ status: 'partial', dueDate: due }, at)).toBe(true);
    expect(isOverdue({ status: 'paid', dueDate: due }, at)).toBe(false);
    expect(isOverdue({ status: 'sent', dueDate: due }, new Date('2026-09-30T00:00:00Z'))).toBe(false);
  });
});

describe('PayNow / EMVCo payload', () => {
  it('CRC-16/CCITT-FALSE matches the standard check value', () => {
    expect(crc16('123456789')).toBe('29B1');
  });

  it('reproduces the EMVCo MPM specification sample, CRC A13A', () => {
    // The sample payload from the EMV QRCPS Merchant-Presented Mode spec (includes multi-byte characters).
    const body =
      '00020101021229300012D156000000000510A93FO3230Q31280012D15600000001030812345678520441115802CN' +
      '5914BEST TRANSPORT6007BEIJING64200002ZH0104最佳运输0202北京540523.7253031565502016233030412340603***' +
      '0708A60086670902ME91320016A011223344998877070812345678';
    const payload = withCrc(body);
    expect(payload.slice(-8)).toBe('6304A13A');
    expect(hasValidCrc(payload)).toBe(true);
    const fields = new Map(parseTlv(payload));
    expect(fields.get('59')).toBe('BEST TRANSPORT');
    expect(new Map(parseTlv(fields.get('64')!)).get('01')).toBe('最佳运输');
  });

  it('builds a PayNow payload to a UEN with amount and invoice number', () => {
    const payload = buildPayNowPayload({
      uen: '201403121w',
      amountCents: 12050,
      reference: 'INV-00042',
      merchantName: 'Sing Your Way Home',
    });
    const body =
      '000201' + '010212' +
      '2637' + '0009SG.PAYNOW' + '01012' + '0210201403121W' + '03010' +
      '52040000' + '5303702' + '5406120.50' + '5802SG' + '5918Sing Your Way Home' + '6009Singapore' +
      '6213' + '0109INV-00042' + '6304';
    expect(payload).toBe(body + crc16(body));
    expect(hasValidCrc(payload)).toBe(true);
    const fields = new Map(parseTlv(payload));
    expect(new Map(parseTlv(fields.get('26')!))).toEqual(
      new Map([['00', 'SG.PAYNOW'], ['01', '2'], ['02', '201403121W'], ['03', '0']]),
    );
  });

  it('adds an expiry, trims long names, and rejects bad input', () => {
    const p = buildPayNowPayload({
      uen: '201403121W',
      amountCents: 100,
      reference: 'INV-1',
      merchantName: 'A very long studio name that goes on',
      expiry: '2026-12-31',
    });
    const fields = new Map(parseTlv(p));
    expect(new Map(parseTlv(fields.get('26')!)).get('04')).toBe('20261231');
    expect(fields.get('59')).toHaveLength(25);
    expect(() => buildPayNowPayload({ uen: 'nope', amountCents: 100, reference: 'x', merchantName: 'x' })).toThrow(/UEN/);
    expect(() => buildPayNowPayload({ uen: '201403121W', amountCents: 0, reference: 'x', merchantName: 'x' })).toThrow();
  });
});

describe('attendance reports', () => {
  const d = (iso: string) => new Date(iso);
  const rows = [
    { studentId: 'a', status: 'present', lessonStartAt: d('2026-10-01T11:00:00Z') },
    { studentId: 'a', status: 'absent', lessonStartAt: d('2026-10-08T11:00:00Z') },
    { studentId: 'a', status: 'lateCancelled', lessonStartAt: d('2026-10-15T11:00:00Z') },
    { studentId: 'a', status: 'booked', lessonStartAt: d('2026-10-22T11:00:00Z') },
    { studentId: 'b', status: 'present', lessonStartAt: d('2026-10-02T11:00:00Z') },
    { studentId: 'b', status: 'cancelled', lessonStartAt: d('2026-10-09T11:00:00Z') },
    { studentId: 'b', status: 'removed', lessonStartAt: d('2026-10-10T11:00:00Z') },
  ] as const;

  it('counts statuses per student; rate = present / (present + absent + late cancel)', () => {
    const s = summariseAttendance([...rows]);
    expect(s.get('a')).toMatchObject({ present: 1, absent: 1, lateCancelled: 1, cancelled: 0, unmarked: 1, rate: 1 / 3 });
    expect(s.get('b')).toMatchObject({ present: 1, cancelled: 1, rate: 1 });
    expect(s.get('b')!.total).toBe(2); // removed doesn't count
  });

  it('flags students at risk, with reasons', () => {
    const now = d('2026-10-20T00:00:00Z');
    const risk = atRiskStudents({
      now,
      students: [
        { id: 'a', status: 'active', sessionsAvailable: 3, sessionsOwed: 0 },
        { id: 'b', status: 'active', sessionsAvailable: 1, sessionsOwed: 0 },
        { id: 'c', status: 'active', sessionsAvailable: 4, sessionsOwed: 2 },
        { id: 'd', status: 'inactive', sessionsAvailable: 0, sessionsOwed: 0 },
      ],
      attendance: [...rows],
      upcomingByStudent: new Map([['a', 1], ['b', 2], ['c', 1]]),
      lots: [{ studentId: 'c', remaining: 4, validUntil: d('2026-10-30T00:00:00Z') }],
    });
    expect(risk.map((r) => [r.studentId, r.reasons])).toEqual([
      ['a', ['absences']],
      ['b', ['lowCredits']],
      ['c', ['owed', 'expiringSoon']],
    ]);
  });

  it('flags active students with nothing booked', () => {
    const risk = atRiskStudents({
      now: d('2026-10-20T00:00:00Z'),
      students: [{ id: 'z', status: 'active', sessionsAvailable: 4, sessionsOwed: 0 }],
      attendance: [],
      upcomingByStudent: new Map(),
      lots: [],
    });
    expect(risk).toEqual([{ studentId: 'z', reasons: ['noUpcoming'] }]);
  });
});

describe('branding', () => {
  it('maps school branding to CSS variables, ignoring anything unsafe', () => {
    const vars = brandingCssVars({
      colors: { primary: '#6300E2', primaryHover: '#8E43F0', text: '#150E1F', muted: 'red; background: url(x)' },
      fonts: { display: 'Playfair Display', body: 'Roboto' },
      logoUrl: 'https://example.test/logo.png',
      buttonRadius: 28,
    });
    expect(vars['--brand-primary']).toBe('#6300E2');
    expect(vars['--brand-primary-hover']).toBe('#8E43F0');
    expect(vars['--color-text']).toBe('#150E1F');
    expect(vars['--color-muted']).toBeUndefined();
    expect(vars['--font-display']).toBe(`'Playfair Display', Georgia, serif`);
    expect(vars['--brand-logo']).toBe(`url("https://example.test/logo.png")`);
    expect(vars['--radius-button']).toBe('28px');
    expect(brandingCssVars({ logoUrl: 'javascript:alert(1)' })['--brand-logo']).toBeUndefined();
    expect(brandingCssVars({ fonts: { body: 'Evil"; }' } })['--font-body']).toBeUndefined();
    expect(brandingCssVars(null)).toEqual({});
  });

  it('builds one Google Fonts link for the families', () => {
    expect(googleFontsHref({ fonts: { display: 'Playfair Display', body: 'Roboto' } })).toBe(
      'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700&family=Roboto:wght@400;500;700&display=swap',
    );
    expect(googleFontsHref({})).toBeNull();
  });
});
