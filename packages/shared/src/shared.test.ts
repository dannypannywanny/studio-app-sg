import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, consumesCredit, formatMoney, resolvePolicy, wallClockToUtc } from './index';

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
