// Events (workshops, masterclasses) sold as tickets on the learn site. Shared by the staff app, the
// learn site and the ticket checkout, so the price a buyer sees is the price they are charged.
import { wallDateOf } from './rrule';

/** One price step. Early bird first, with `until` set; the last tier usually has no end. */
export interface EventPriceTier {
  label: string;
  priceCents: number;
  /** Last day this price applies (inclusive, wall date in the event's zone). null = no end. */
  until: string | null;
}

/** Most tickets one order may buy when the event doesn't say. */
export const DEFAULT_MAX_PER_ORDER = 4;
/** How long an unpaid checkout keeps its seats. */
export const EVENT_HOLD_MIN = 30;

/**
 * The tier on sale at `at`: the first whose `until` hasn't passed. Tiers are tried in order, so put the
 * early bird first. null = sales have ended (every tier has a past `until`).
 */
export function currentTier(tiers: readonly EventPriceTier[], at: Date, timeZone: string): { tier: EventPriceTier; index: number } | null {
  const today = wallDateOf(at, timeZone);
  const index = tiers.findIndex((t) => t.until === null || t.until >= today);
  return index < 0 ? null : { tier: tiers[index]!, index };
}

/** The highest later price, shown struck through next to an early bird ("S$68, usually S$88"). */
export function laterPrice(tiers: readonly EventPriceTier[], index: number): number | null {
  const later = tiers.slice(index + 1).map((t) => t.priceCents);
  const max = later.length ? Math.max(...later) : null;
  return max !== null && max > tiers[index]!.priceCents ? max : null;
}

/** Seats left from the public counter; null = no cap. */
export function seatsLeft(capacity: number | null | undefined, soldQty: number | null | undefined): number | null {
  return typeof capacity === 'number' ? Math.max(0, capacity - (soldQty ?? 0)) : null;
}
