// Sales tax on invoices (GST in Singapore). schools/{id}.tax; off by default.
// Exclusive: tax is added on top of the price after discounts. Inclusive: prices already contain tax; the
// invoice shows the tax portion but the total doesn't change.

export interface TaxSettings {
  enabled: boolean;
  /** Percent, e.g. 9 for Singapore GST. */
  rate: number;
  label: string;
  /** Registration number printed on invoices (e.g. GST Reg. No.). */
  regNo: string | null;
  inclusive: boolean;
}

export const DEFAULT_TAX: TaxSettings = { enabled: false, rate: 9, label: 'GST', regNo: null, inclusive: false };

export function resolveTax(raw: unknown): TaxSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const rate = typeof r.rate === 'number' && r.rate >= 0 && r.rate <= 50 ? r.rate : DEFAULT_TAX.rate;
  return {
    enabled: r.enabled === true && rate > 0,
    rate,
    label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 20) : DEFAULT_TAX.label,
    regNo: typeof r.regNo === 'string' && r.regNo.trim() ? r.regNo.trim().slice(0, 40) : null,
    inclusive: r.inclusive === true,
  };
}

/** Tax on an amount after discounts. Returns the tax and the amount the student pays. */
export function applyTax(netCents: number, tax: Pick<TaxSettings, 'enabled' | 'rate' | 'inclusive'>): { taxCents: number; totalCents: number } {
  if (!tax.enabled || netCents <= 0) return { taxCents: 0, totalCents: netCents };
  if (tax.inclusive) return { taxCents: Math.round(netCents - netCents / (1 + tax.rate / 100)), totalCents: netCents };
  const taxCents = Math.round((netCents * tax.rate) / 100);
  return { taxCents, totalCents: netCents + taxCents };
}
