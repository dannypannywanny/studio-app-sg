/** Money is always integer cents plus the school's currency. */
export function formatMoney(cents: number, currency = 'SGD', locale = 'en-SG'): string {
  if (!Number.isInteger(cents)) throw new Error(`formatMoney expects integer cents, got ${cents}`);
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

/** Parses what staff type into an amount field ('120', '120.5', '$1,200.50') into integer cents, or null. */
export function parseMoney(text: string): number | null {
  const clean = text.trim().replace(/^S?\$/i, '').replaceAll(',', '');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  const [whole, frac = ''] = clean.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/** Cents as a plain decimal string for inputs and payloads: 12050 -> '120.50'. */
export function centsToDecimal(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`Expected non-negative integer cents, got ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

/** An invoice is overdue when money is still owed and its due date has passed. */
export function isOverdue(invoice: { status: string; dueDate: { toMillis(): number } }, now: Date = new Date()): boolean {
  return (invoice.status === 'sent' || invoice.status === 'partial') && invoice.dueDate.toMillis() < now.getTime();
}
