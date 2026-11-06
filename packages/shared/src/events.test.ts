import { describe, expect, it } from 'vitest';
import { buildEventOptions, currentTier, laterPrice, optionSeatsLeft, seatsLeft, type EventPriceTier } from './events';
import { wallClockToUtc } from './dates';

const TZ = 'Asia/Singapore';
const tiers: EventPriceTier[] = [
  { label: 'Early bird', priceCents: 6800, until: '2026-11-14' },
  { label: 'Standard', priceCents: 8800, until: null },
];

describe('currentTier', () => {
  it('sells the early bird through the end of its last day in the event zone', () => {
    expect(currentTier(tiers, wallClockToUtc('2026-11-14', '23:59', TZ), TZ)?.tier.label).toBe('Early bird');
    expect(currentTier(tiers, wallClockToUtc('2026-11-15', '00:00', TZ), TZ)?.tier.label).toBe('Standard');
  });
  it('is null once every tier has ended', () => {
    expect(currentTier([{ label: 'Only', priceCents: 100, until: '2026-01-01' }], wallClockToUtc('2026-01-02', '00:00', TZ), TZ)).toBeNull();
  });
});

describe('laterPrice', () => {
  it('shows the full price next to a cheaper tier only', () => {
    expect(laterPrice(tiers, 0)).toBe(8800);
    expect(laterPrice(tiers, 1)).toBeNull();
  });
});

describe('seatsLeft', () => {
  it('counts down from capacity and never goes below zero', () => {
    expect(seatsLeft(20, 5)).toBe(15);
    expect(seatsLeft(2, 3)).toBe(0);
    expect(seatsLeft(null, 3)).toBeNull();
  });
});

describe('ticket options', () => {
  const sessions = [
    { key: 's1', title: 'Fundamentals', priceCents: 8800, earlyCents: 6800 },
    { key: 's2', title: 'Mando Pop', priceCents: 8800, earlyCents: 6800 },
  ];
  it('makes one option per session plus the bundle, sharing the early bird date', () => {
    const opts = buildEventOptions(sessions, { label: 'Both classes', priceCents: 14800, earlyCents: 11800 }, '2026-11-14');
    expect(opts.map((o) => [o.key, o.sessionKeys])).toEqual([['s1', ['s1']], ['s2', ['s2']], ['all', ['s1', 's2']]]);
    expect(opts[2]!.prices).toEqual([
      { label: 'Early bird', priceCents: 11800, until: '2026-11-14' },
      { label: 'Standard', priceCents: 14800, until: null },
    ]);
    expect(buildEventOptions(sessions.slice(0, 1), { label: 'x', priceCents: 1, earlyCents: null }, null)).toHaveLength(1);
  });
  it('a bundle has as many seats as its fullest session', () => {
    const caps = [{ key: 's1', capacity: 10 }, { key: 's2', capacity: null }];
    expect(optionSeatsLeft({ sessionKeys: ['s1', 's2'] }, caps, { s1: 7 })).toBe(3);
    expect(optionSeatsLeft({ sessionKeys: ['s2'] }, caps, { s1: 7 })).toBeNull();
  });
});
