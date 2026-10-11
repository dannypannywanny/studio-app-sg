// PayNow QR payload (SGQR, EMVCo Merchant-Presented Mode), built in-house.
// The payload is a string of TLV fields (2-digit id, 2-digit length, value) ending with a CRC-16
// (CCITT-FALSE: poly 0x1021, init 0xFFFF) over everything up to and including "6304".
// Banking apps read it to pre-fill a PayNow transfer to the school's UEN with the amount and reference.
import { centsToDecimal } from './money';

/** CRC-16/CCITT-FALSE over the UTF-8 bytes, as 4 upper-case hex digits. */
export function crc16(input: string): string {
  let crc = 0xffff;
  for (const byte of new TextEncoder().encode(input)) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** One TLV field. Length counts characters (EMVCo), max 99. */
export function tlv(id: string, value: string): string {
  const len = [...value].length;
  if (!/^\d{2}$/.test(id)) throw new Error(`Bad TLV id ${id}`);
  if (len > 99) throw new Error(`TLV ${id} is too long (${len})`);
  return `${id}${String(len).padStart(2, '0')}${value}`;
}

/** Splits a TLV string into [id, value] pairs (one level). */
export function parseTlv(payload: string): [string, string][] {
  const chars = [...payload];
  const out: [string, string][] = [];
  let i = 0;
  while (i < chars.length) {
    const id = chars.slice(i, i + 2).join('');
    const len = Number(chars.slice(i + 2, i + 4).join(''));
    if (!/^\d{2}$/.test(id) || Number.isNaN(len)) throw new Error(`Bad TLV at ${i}`);
    out.push([id, chars.slice(i + 4, i + 4 + len).join('')]);
    i += 4 + len;
  }
  return out;
}

/** Appends the CRC field to a payload body. */
export function withCrc(body: string): string {
  const head = `${body}6304`;
  return head + crc16(head);
}

/** True when the trailing CRC matches the rest of the payload. */
export function hasValidCrc(payload: string): boolean {
  return payload.length > 8 && crc16(payload.slice(0, -4)) === payload.slice(-4);
}

export interface PayNowInput {
  /** The school's UEN, e.g. '202312345A'. */
  uen: string;
  amountCents: number;
  /** Shown to the payer and returned in the bank statement: the invoice number. */
  reference: string;
  /** Up to 25 characters; banking apps show it as the payee. */
  merchantName: string;
  merchantCity?: string;
  /** Let the payer change the amount (default: no). */
  editableAmount?: boolean;
  /** Last day the QR is valid, 'YYYY-MM-DD' (optional). */
  expiry?: string | null;
}

const clean = (s: string, max: number) =>
  s
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, max);

export function buildPayNowPayload(input: PayNowInput): string {
  const uen = input.uen.trim().toUpperCase();
  if (!/^[0-9A-Z]{9,10}$/.test(uen)) throw new Error(`That doesn't look like a UEN: ${input.uen}`);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new Error('Amount must be positive cents');
  const reference = clean(input.reference, 25);
  if (!reference) throw new Error('A reference is required');

  const merchantAccount =
    tlv('00', 'SG.PAYNOW') +
    tlv('01', '2') + // proxy type 2 = UEN
    tlv('02', uen) +
    tlv('03', input.editableAmount ? '1' : '0') +
    (input.expiry ? tlv('04', input.expiry.replaceAll('-', '')) : '');

  const body =
    tlv('00', '01') + // payload format indicator
    tlv('01', '12') + // point of initiation: dynamic (amount and reference fixed)
    tlv('26', merchantAccount) +
    tlv('52', '0000') + // merchant category code
    tlv('53', '702') + // SGD
    tlv('54', centsToDecimal(input.amountCents)) +
    tlv('58', 'SG') +
    tlv('59', clean(input.merchantName, 25) || 'NA') +
    tlv('60', clean(input.merchantCity ?? 'Singapore', 15) || 'Singapore') +
    tlv('62', tlv('01', reference)); // additional data: bill number

  return withCrc(body);
}
