// Discount codes: schools/{schoolId}/discountCodes/{CODE}, the doc id being the upper-cased code.
//
// A code takes a percentage or an amount off a package, optionally only for chosen packages, until
// an optional last day, and for an optional number of uses. Staff manage them through saveDiscountCode
// (clients never write the doc, so usedCount can't be edited by hand); students try one on the buy
// page through previewDiscountCode; the code is checked again, and counted, inside the sale itself.
import { applyTax, resolveTax, wallClockToUtc } from '@lessonkaki/shared';
import { type Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { audit, notFound, now, schoolRef, type Actor } from './db';

export type Discount = { kind: 'percent' | 'amount'; value: number };

export interface SaveDiscountCodeInput {
  schoolId: string;
  code: string;
  kind: 'percent' | 'amount';
  /** Percent (1-100) or cents. */
  value: number;
  /** Empty = every package. */
  packageIds: string[];
  /** Last day it works, a wall date in the school's zone (inclusive); null = no end. */
  validUntil: string | null;
  /** Total redemptions allowed; null = unlimited. */
  maxUses: number | null;
  active: boolean;
}

export const normaliseCode = (raw: string): string => raw.trim().toUpperCase();

export function validCodeFormat(code: string): boolean {
  return /^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code);
}

/** Cents off `subtotalCents` for a discount. Same rounding as the staff sell dialog. */
export function discountCentsFor(subtotalCents: number, d: Discount): number {
  const raw = d.kind === 'percent' ? Math.round((subtotalCents * Math.min(d.value, 100)) / 100) : Math.round(d.value);
  return Math.min(subtotalCents, Math.max(0, raw));
}

/**
 * Throws a plain-language HttpsError unless this code (its doc data, or undefined when missing) can be
 * used on `packageId` at `at`. The message is deliberately the same for unknown and switched-off codes.
 */
export function assertCodeUsable(
  data: FirebaseFirestore.DocumentData | undefined,
  packageId: string,
  timeZone: string,
  at: Date,
): Discount {
  if (!data || data.active === false) throw new HttpsError('failed-precondition', 'That discount code is not valid');
  const until = data.validUntil as string | null | undefined;
  if (until && wallClockToUtc(until, '00:00', timeZone).getTime() + 86_400_000 <= at.getTime()) {
    throw new HttpsError('failed-precondition', 'That discount code has expired');
  }
  const ids = (data.packageIds as string[] | undefined) ?? [];
  if (ids.length && !ids.includes(packageId)) {
    throw new HttpsError('failed-precondition', 'That discount code does not apply to this package');
  }
  const max = data.maxUses as number | null | undefined;
  if (typeof max === 'number' && ((data.usedCount as number | undefined) ?? 0) >= max) {
    throw new HttpsError('failed-precondition', 'That discount code has been fully used');
  }
  return { kind: data.kind as Discount['kind'], value: data.value as number };
}

export async function saveDiscountCode(db: Firestore, input: SaveDiscountCodeInput, actor: Actor): Promise<{ code: string }> {
  const code = normaliseCode(input.code);
  if (!validCodeFormat(code)) throw new HttpsError('invalid-argument', 'Use 2-40 letters, numbers, dashes or underscores');
  if (input.kind === 'percent' && !(input.value >= 1 && input.value <= 100)) {
    throw new HttpsError('invalid-argument', 'A percentage must be between 1 and 100');
  }
  if (input.kind === 'amount' && !(Number.isInteger(input.value) && input.value >= 1)) {
    throw new HttpsError('invalid-argument', 'Enter an amount off');
  }
  const school = schoolRef(db, input.schoolId);
  const ref = school.collection('discountCodes').doc(code);
  const packageIds = [...new Set(input.packageIds)];
  await db.runTransaction(async (tx) => {
    const [existing, ...pkgs] = await tx.getAll(ref, ...packageIds.map((p) => school.collection('packages').doc(p)));
    if (pkgs.some((p) => !p.exists)) notFound('Package');
    const data = {
      code,
      kind: input.kind,
      value: input.value,
      packageIds,
      validUntil: input.validUntil,
      maxUses: input.maxUses,
      active: input.active,
      updatedAt: now(),
    };
    if (existing!.exists) tx.update(ref, data);
    else tx.create(ref, { ...data, usedCount: 0, createdBy: actor.uid, createdAt: now() });
    audit(tx, school, actor, existing!.exists ? 'updateDiscountCode' : 'createDiscountCode', `discountCodes/${code}`, { code });
  });
  return { code };
}

export interface PreviewResult {
  code: string;
  discount: Discount;
  subtotalCents: number;
  discountCents: number;
  /** What the student pays: after the discount and the school's tax. */
  totalCents: number;
}

/** What a code would do to a package's price, without using it. */
export async function previewDiscountCode(
  db: Firestore,
  input: { schoolId: string; packageId: string; code: string },
  at: Date = new Date(),
): Promise<PreviewResult> {
  const school = schoolRef(db, input.schoolId);
  const code = normaliseCode(input.code);
  if (!validCodeFormat(code)) throw new HttpsError('failed-precondition', 'That discount code is not valid');
  const [schoolSnap, pkgSnap, codeSnap] = await db.getAll(school, school.collection('packages').doc(input.packageId), school.collection('discountCodes').doc(code));
  if (!schoolSnap!.exists) notFound('School');
  if (!pkgSnap!.exists) notFound('Package');
  const timeZone = (schoolSnap!.get('timezone') as string | undefined) ?? 'Asia/Singapore';
  const discount = assertCodeUsable(codeSnap!.data(), input.packageId, timeZone, at);
  const subtotalCents = pkgSnap!.get('priceCents') as number;
  const discountCents = discountCentsFor(subtotalCents, discount);
  const { totalCents } = applyTax(subtotalCents - discountCents, resolveTax(schoolSnap!.get('tax')));
  return { code, discount, subtotalCents, discountCents, totalCents };
}
