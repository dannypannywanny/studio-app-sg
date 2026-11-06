// Events (workshops, masterclasses) sold as tickets on the learn site. Shared by the staff app, the
// learn site and the ticket checkout, so the price a buyer sees is the price they are charged.
//
// An event is one page with one or more sessions (e.g. two masterclasses on the same afternoon). Buyers
// pick a ticket option: one session, or a bundle of several at a lower price. Seats are per session.
import { wallDateOf } from './rrule';

/** One price step. Early bird first, with `until` set; the last tier usually has no end. */
export interface EventPriceTier {
  label: string;
  priceCents: number;
  /** Last day this price applies (inclusive, wall date in the event's zone). null = no end. */
  until: string | null;
}

/** What a buyer can pick: the sessions it admits to, and its prices. */
export interface EventOption {
  key: string;
  label: string;
  sessionKeys: string[];
  prices: EventPriceTier[];
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

/** Seats left in one session from the public counter; null = no cap. */
export function seatsLeft(capacity: number | null | undefined, sold: number | null | undefined): number | null {
  return typeof capacity === 'number' ? Math.max(0, capacity - (sold ?? 0)) : null;
}

/** Seats left for an option: the fullest of its sessions decides. null = no cap on any of them. */
export function optionSeatsLeft(
  option: Pick<EventOption, 'sessionKeys'>,
  sessions: readonly { key: string; capacity?: number | null }[],
  soldBySession: Record<string, number> | null | undefined,
): number | null {
  const lefts = option.sessionKeys
    .map((k) => sessions.find((s) => s.key === k))
    .map((s) => (s ? seatsLeft(s.capacity, soldBySession?.[s.key]) : null))
    .filter((n): n is number => n !== null);
  return lefts.length ? Math.min(...lefts) : null;
}

/**
 * Ticket options from per-session prices and an optional all-sessions bundle: one option per session,
 * then the bundle (key 'all') when a bundle price is set. Every option shares the early bird end date.
 */
export function buildEventOptions(
  sessions: readonly { key: string; title: string; priceCents: number; earlyCents: number | null }[],
  bundle: { label: string; priceCents: number; earlyCents: number | null } | null,
  earlyUntil: string | null,
): EventOption[] {
  const tiers = (price: number, early: number | null): EventPriceTier[] =>
    early !== null && earlyUntil
      ? [
          { label: 'Early bird', priceCents: early, until: earlyUntil },
          { label: 'Standard', priceCents: price, until: null },
        ]
      : [{ label: 'Ticket', priceCents: price, until: null }];
  const options: EventOption[] = sessions.map((s) => ({ key: s.key, label: s.title, sessionKeys: [s.key], prices: tiers(s.priceCents, s.earlyCents) }));
  if (bundle && sessions.length > 1) {
    options.push({ key: 'all', label: bundle.label, sessionKeys: sessions.map((s) => s.key), prices: tiers(bundle.priceCents, bundle.earlyCents) });
  }
  return options;
}
