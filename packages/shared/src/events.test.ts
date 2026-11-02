import { describe, expect, it } from 'vitest';
import { currentTier, laterPrice, seatsLeft, type EventPriceTier } from './events';
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
