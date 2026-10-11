/** Money is always integer cents plus the school's currency. */
export function formatMoney(cents: number, currency = 'SGD', locale = 'en-SG'): string {
  if (!Number.isInteger(cents)) throw new Error(`formatMoney expects integer cents, got ${cents}`);
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}
