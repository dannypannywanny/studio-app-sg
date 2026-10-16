// Invoice PDFs: rendered with pdf-lib (no headless browser) and stored in Cloud Storage. When money is
// still owed and the school has a UEN, the PDF carries a PayNow QR for the outstanding amount with the
// invoice number as reference. The same payload is saved on the invoice so the app can show the QR.
//
// Re-rendered on every invoice write whose printable content changed (hash of the inputs), so writing
// the PDF fields back onto the invoice doesn't loop.
//
// Text is Helvetica (a standard PDF font, nothing embedded). Strings Helvetica can't draw, such as
// Chinese names, use Noto Sans SC (OFL, functions/assets/fonts), embedded only when the invoice needs it,
// cut down by HarfBuzz to the characters the invoice uses (see fontSubset.ts).
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { createSubsetter, type Subsetter } from './fontSubset';
import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { buildPayNowPayload, formatDate, formatMoney } from '@lessonkaki/shared';
import { notFound, now, schoolRef, type Actor } from './db';

/** The bits of a Storage bucket we use (firebase-admin's Bucket fits). */
export interface PdfBucket {
  name: string;
  file(path: string): {
    save(data: Buffer, opts: { contentType: string; resumable: boolean; metadata?: Record<string, unknown> }): Promise<unknown>;
    getSignedUrl(cfg: { action: 'read'; expires: number }): Promise<[string]>;
    getMetadata(): Promise<[{ metadata?: Record<string, string> }, ...unknown[]]>;
  };
}

export const pdfPathFor = (schoolId: string, invoiceId: string) => `schools/${schoolId}/invoices/${invoiceId}.pdf`;

const storageEmulator = () => process.env.FIREBASE_STORAGE_EMULATOR_HOST ?? process.env.STORAGE_EMULATOR_HOST ?? null;

export interface InvoicePdfData {
  school: { name: string; legalName?: string | null; uen?: string | null; email?: string | null; address?: string | null; timezone: string; logoUrl?: string | null };
  student: { name: string; email?: string | null; code?: string | null };
  invoice: {
    number: string;
    currency: string;
    status: string;
    issueDate: Date;
    dueDate: Date;
    lines: { desc: string; qty: number; unitCents: number }[];
    subtotalCents: number;
    discountCents: number;
    creditedCents?: number;
    totalCents: number;
    paidCents: number;
    pendingCents: number;
    voidReason?: string | null;
  };
  payments: { paidAt: Date; method: string; amountCents: number }[];
  paynow: { payload: string; reference: string; amountCents: number } | null;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** Standard PDF fonts only encode WinAnsi; anything else (e.g. CJK names) needs the wide font. */
const PUNCTUATION: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...' };

/** The character as Helvetica can draw it (accents stripped if need be), or null if it can't. */
function toWinAnsi(ch: string): string | null {
  const mapped = PUNCTUATION[ch] ?? ch;
  const c = mapped.codePointAt(0)!;
  if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) return mapped;
  return ch.normalize('NFKD').replace(/[^\x20-\x7e]/g, '') || null;
}

export function pdfSafe(text: string): string {
  return [...text.normalize('NFC')].map((ch) => toWinAnsi(ch) ?? '?').join('');
}

/** True when Helvetica can't draw some of the text, even after pdfSafe's substitutions. */
export function needsWideFont(text: string): boolean {
  return [...text.normalize('NFC')].some((ch) => toWinAnsi(ch) === null);
}

// Resolved from the functions folder: the deploy root in Cloud Functions, and the cwd under `pnpm test`.
export const WIDE_FONT_PATH = resolve(process.cwd(), 'assets/fonts/NotoSansSC-Regular.ttf');
let wideSubsetter: Subsetter | null | undefined; // the 10 MB font is loaded once per instance

function loadWideSubsetter(): Subsetter | null {
  if (wideSubsetter === undefined) {
    try {
      wideSubsetter = createSubsetter(readFileSync(WIDE_FONT_PATH));
    } catch (err) {
      // Still render (names fall back to '?') rather than leave the invoice without a PDF.
      console.warn(`invoicePdf: wide font unavailable (${WIDE_FONT_PATH}): ${(err as Error).message}`);
      wideSubsetter = null;
    }
  }
  return wideSubsetter;
}

/**
 * Embeds the wide font cut down to the characters in `text`, with a drawable-text mapper for it
 * (characters the font lacks become '?'). pdf-lib embeds the already-small font whole.
 */
async function embedWideFont(doc: PDFDocument, text: string): Promise<{ font: PDFFont; safe: (s: string) => string } | null> {
  const subsetter = loadWideSubsetter();
  if (!subsetter) return null;
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(subsetter.subset(text), { subset: false });
  const has = new Set(font.getCharacterSet());
  const safe = (s: string) => [...s.normalize('NFC')].map((ch) => (has.has(ch.codePointAt(0)!) ? ch : '?')).join('');
  return { font, safe };
}

const METHOD: Record<string, string> = { paynow: 'PayNow', bank: 'Bank transfer', cash: 'Cash', card_hitpay: 'Card' };

// Palette: the studio's site language (ink, warm greys, one tan accent). Kept neutral enough for any school.
const INK = rgb(0.086, 0.086, 0.086);
const MUTED = rgb(0.333, 0.333, 0.353);
const LINE = rgb(0.855, 0.855, 0.835);
const SURFACE = rgb(0.957, 0.957, 0.949);
const ACCENT = rgb(0.788, 0.678, 0.573); // tan
const ACCENT_SOFT = rgb(0.902, 0.863, 0.812);
const OK = rgb(0.18, 0.35, 0.17);
const OK_SOFT = rgb(0.89, 0.92, 0.875);
const BAD = rgb(0.64, 0.21, 0.11);
const BAD_SOFT = rgb(0.96, 0.886, 0.84);

export interface PdfAssets {
  /** The school's logo as PNG or JPEG bytes (branding.logoPdfUrl), drawn top left. */
  logo?: Uint8Array | null;
}

export async function renderInvoicePdf(d: InvoicePdfData, assets: PdfAssets = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const paid = d.invoice.status === 'paid';
  const voided = d.invoice.status === 'void';
  const kind = paid ? 'Receipt' : 'Invoice';
  doc.setTitle(`${kind} ${d.invoice.number}`);
  doc.setAuthor(pdfSafe(d.school.name));
  doc.setCreator('LessonKaki');
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = page.getWidth();
  const H = page.getHeight();
  const M = 48;
  const money = (c: number) => pdfSafe(formatMoney(c, d.invoice.currency));
  const date = (x: Date) => pdfSafe(formatDate(x, d.school.timezone));

  const everything = JSON.stringify(d); // every string the PDF can print (JSON keeps non-ASCII as is)
  const wide = needsWideFont(everything) ? await embedWideFont(doc, everything) : null;
  // Each string picks its font: Helvetica when it can draw it, else the wide font (no bold weight).
  const pick = (s: string, f: PDFFont): [string, PDFFont] =>
    wide && needsWideFont(s) ? [wide.safe(s), wide.font] : [pdfSafe(s), f];
  const width = (s: string, size: number, f: PDFFont = font) => {
    const [str, use] = pick(s, f);
    return use.widthOfTextAtSize(str, size);
  };
  const text = (s: string, x: number, y: number, size = 10, f: PDFFont = font, color = INK) => {
    const [str, use] = pick(s, f);
    page.drawText(str, { x, y, size, font: use, color });
  };
  const right = (s: string, xr: number, y: number, size = 10, f: PDFFont = font, color = INK) =>
    text(s, xr - width(s, size, f), y, size, f, color);
  /** Splits text into lines that fit `max` points. */
  const wrap = (s: string, max: number, size = 10, f: PDFFont = font): string[] => {
    const out: string[] = [];
    let line = '';
    for (const word of s.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (width(next, size, f) <= max || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
    return out.length ? out : [''];
  };
  const rule = (y: number, x1 = M, x2 = W - M, color = LINE, thickness = 0.75) =>
    page.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness, color });
  /** A small rounded-looking label: text on a soft block. */
  const pill = (label: string, xr: number, y: number, fill: ReturnType<typeof rgb>, color: ReturnType<typeof rgb>) => {
    const size = 9;
    const w = width(label, size, bold) + 16;
    page.drawRectangle({ x: xr - w, y: y - 5, width: w, height: 18, color: fill });
    text(label, xr - w + 8, y, size, bold, color);
  };

  // Accent band across the top.
  page.drawRectangle({ x: 0, y: H - 8, width: W, height: 8, color: ACCENT });

  // Header: logo (or name) left, document type and status right.
  let y = H - 56;
  let logoDrawn = false;
  if (assets.logo) {
    try {
      const isPng = assets.logo[0] === 0x89 && assets.logo[1] === 0x50;
      const img = isPng ? await doc.embedPng(assets.logo) : await doc.embedJpg(assets.logo);
      const h = 44;
      const w = Math.min(160, (img.width / img.height) * h);
      page.drawImage(img, { x: M, y: y - h + 14, width: w, height: (w / img.width) * img.height });
      logoDrawn = true;
    } catch {
      // A bad image never blocks the invoice.
    }
  }
  if (!logoDrawn) text(d.school.name, M, y, 16, bold);
  right(kind, W - M, y - 2, 26, bold);
  if (paid) pill('PAID', W - M, y - 30, OK_SOFT, OK);
  else if (voided) pill('VOID', W - M, y - 30, BAD_SOFT, BAD);

  // Key facts in one row.
  y = H - 140;
  const lastPayment = d.payments.at(-1);
  const facts: [string, string][] = [
    [paid ? 'Invoice no.' : 'Invoice no.', d.invoice.number],
    ['Issued', date(d.invoice.issueDate)],
    paid && lastPayment ? ['Paid on', date(lastPayment.paidAt)] : ['Due', date(d.invoice.dueDate)],
    paid ? ['Amount paid', money(d.invoice.paidCents)] : voided ? ['Status', 'Cancelled'] : ['Amount due', money(d.invoice.pendingCents)],
  ];
  const colW = (W - 2 * M) / facts.length;
  facts.forEach(([label, value], i) => {
    const x = M + i * colW;
    text(label.toUpperCase(), x, y, 7.5, bold, MUTED);
    text(value, x, y - 16, i === facts.length - 1 ? 13 : 11, bold, i === facts.length - 1 && !paid && !voided ? INK : INK);
  });
  rule(y - 32);

  // Parties: billed to (left), from (right).
  y -= 60;
  const half = M + (W - 2 * M) / 2 + 12;
  text('BILLED TO', M, y, 7.5, bold, ACCENT);
  text('FROM', half, y, 7.5, bold, ACCENT);
  let ly = y - 16;
  text(d.student.name + (d.student.code ? ` (${d.student.code})` : ''), M, ly, 11, bold);
  ly -= 14;
  if (d.student.email) {
    text(d.student.email, M, ly, 9, font, MUTED);
    ly -= 12;
  }
  let ry = y - 16;
  text(d.school.name, half, ry, 11, bold);
  ry -= 14;
  const fromLines = [
    d.school.legalName && d.school.legalName !== d.school.name ? d.school.legalName : null,
    d.school.uen ? `UEN ${d.school.uen}` : null,
    ...(d.school.address ? wrap(d.school.address, W - M - half, 9) : []),
    d.school.email,
  ].filter(Boolean) as string[];
  for (const l of fromLines) {
    text(l, half, ry, 9, font, MUTED);
    ry -= 12;
  }

  // Items.
  y = Math.min(ly, ry) - 26;
  const cols = { desc: M + 10, qty: W - M - 200, unit: W - M - 100, amount: W - M - 10 };
  page.drawRectangle({ x: M, y: y - 8, width: W - 2 * M, height: 24, color: SURFACE });
  text('DESCRIPTION', cols.desc, y, 7.5, bold, MUTED);
  right('QTY', cols.qty, y, 7.5, bold, MUTED);
  right('UNIT PRICE', cols.unit, y, 7.5, bold, MUTED);
  right('AMOUNT', cols.amount, y, 7.5, bold, MUTED);
  y -= 30;
  for (const l of d.invoice.lines) {
    const lines = wrap(l.desc, cols.qty - cols.desc - 40, 10);
    lines.forEach((ln, i) => text(ln, cols.desc, y - i * 13, 10, bold));
    right(String(l.qty), cols.qty, y);
    right(money(l.unitCents), cols.unit, y);
    right(money(l.qty * l.unitCents), cols.amount, y, 10, bold);
    y -= lines.length * 13 + 10;
    rule(y + 4);
    y -= 8;
  }

  // Totals, right-aligned, with the bottom line highlighted.
  const tx = W - M - 230;
  const rows: [string, string][] = [['Subtotal', money(d.invoice.subtotalCents)]];
  if (d.invoice.discountCents) rows.push(['Discount', `-${money(d.invoice.discountCents)}`]);
  if (d.invoice.creditedCents) rows.push(['Credit note', `-${money(d.invoice.creditedCents)}`]);
  rows.push(['Total', money(d.invoice.totalCents)]);
  if (d.invoice.paidCents) rows.push(['Paid', `-${money(d.invoice.paidCents)}`]);
  y -= 6;
  for (const [label, value] of rows) {
    text(label, tx + 10, y, 10, label === 'Total' ? bold : font, label === 'Total' ? INK : MUTED);
    right(value, cols.amount, y, 10, label === 'Total' ? bold : font);
    y -= 17;
  }
  if (!voided) {
    y -= 12; // clear the last row before the highlighted bar
    const due = d.invoice.pendingCents;
    const fill = due > 0 ? INK : ACCENT_SOFT;
    const color = due > 0 ? rgb(0.96, 0.96, 0.95) : INK;
    page.drawRectangle({ x: tx, y: y - 10, width: W - M - tx, height: 28, color: fill });
    text('Balance due', tx + 10, y, 11, bold, color);
    right(money(due), cols.amount, y, 12, bold, color);
    y -= 28;
  }

  // Payments received.
  if (d.payments.length) {
    y -= 24;
    text('PAYMENTS RECEIVED', M, y, 7.5, bold, ACCENT);
    y -= 16;
    for (const p of d.payments) {
      text(`${date(p.paidAt)}   ${METHOD[p.method] ?? p.method}`, M, y, 9.5);
      right(money(p.amountCents), cols.amount, y, 9.5);
      y -= 15;
    }
  }

  // PayNow panel.
  if (d.paynow) {
    const size = 128;
    const panelH = size + 28;
    const top = y - 26;
    page.drawRectangle({ x: M, y: top - panelH, width: W - 2 * M, height: panelH, color: SURFACE });
    const x0 = M + 14;
    const y0 = top - 14 - size;
    const qr = QRCode.create(d.paynow.payload, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const cell = size / (n + 8); // 4-module quiet zone each side
    page.drawRectangle({ x: x0, y: y0, width: size, height: size, color: rgb(1, 1, 1) });
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.modules.get(r, c)) continue;
        page.drawRectangle({ x: x0 + (c + 4) * cell, y: y0 + size - (r + 5) * cell, width: cell, height: cell, color: rgb(0, 0, 0) });
      }
    }
    const px = x0 + size + 22;
    text('Pay with PayNow', px, top - 34, 14, bold);
    text('Scan with your banking app. The amount and reference fill in for you.', px, top - 52, 9, font, MUTED);
    const kv: [string, string][] = [['Amount', money(d.paynow.amountCents)], ['Reference', d.paynow.reference]];
    if (d.school.uen) kv.push(['PayNow UEN', d.school.uen]);
    kv.forEach(([k, v], i) => {
      text(k, px, top - 76 - i * 16, 9.5, font, MUTED);
      text(v, px + 78, top - 76 - i * 16, 9.5, bold);
    });
  }

  if (voided) {
    if (d.invoice.voidReason) text(`Cancelled: ${d.invoice.voidReason}`, M, y - 26, 9.5, font, BAD);
  }

  // Footer.
  rule(64, M, W - M, LINE);
  text(paid ? 'Thank you for your payment.' : 'Thank you for learning with us.', M, 46, 9, bold);
  const contact = [d.school.legalName ?? d.school.name, d.school.uen ? `UEN ${d.school.uen}` : null, d.school.email].filter(Boolean).join('  |  ');
  right(contact, W - M, 46, 8, font, MUTED);
  return doc.save();
}

/** Fetches the school's PDF logo (https PNG/JPEG), cached per instance. Never throws. */
const logoCache = new Map<string, Uint8Array | null>();
export async function fetchLogo(url: string | null | undefined, fetchFn: typeof fetch = fetch): Promise<Uint8Array | null> {
  if (!url || !/^https:\/\//.test(url)) return null;
  if (logoCache.has(url)) return logoCache.get(url)!;
  let bytes: Uint8Array | null = null;
  try {
    const res = await fetchFn(url, { signal: AbortSignal.timeout(4000) });
    const buf = new Uint8Array(await res.arrayBuffer());
    const png = buf[0] === 0x89 && buf[1] === 0x50;
    const jpg = buf[0] === 0xff && buf[1] === 0xd8;
    if (res.ok && (png || jpg) && buf.length < 2_000_000) bytes = buf;
  } catch {
    bytes = null;
  }
  logoCache.set(url, bytes);
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// Storage + the invoice doc
// ---------------------------------------------------------------------------------------------

/** Reads everything printable about an invoice. */
export async function loadInvoicePdfData(db: Firestore, schoolId: string, invoiceId: string): Promise<InvoicePdfData> {
  const school = schoolRef(db, schoolId);
  const invSnap = await school.collection('invoices').doc(invoiceId).get();
  if (!invSnap.exists) notFound('Invoice');
  const inv = invSnap.data()!;
  const [schoolSnap, studentSnap, paymentsSnap] = await Promise.all([
    school.get(),
    school.collection('students').doc(inv.studentId as string).get(),
    school.collection('payments').where('invoiceId', '==', invoiceId).get(),
  ]);
  const s = schoolSnap.data() ?? {};
  const st = studentSnap.data() ?? {};
  const timezone = (s.timezone as string | undefined) ?? 'Asia/Singapore';
  const pending = inv.pendingCents as number;
  const open = inv.status === 'sent' || inv.status === 'partial';
  let paynow: InvoicePdfData['paynow'] = null;
  if (open && pending > 0 && s.uen) {
    paynow = {
      reference: inv.number as string,
      amountCents: pending,
      payload: buildPayNowPayload({
        uen: s.uen as string,
        amountCents: pending,
        reference: inv.number as string,
        merchantName: (s.paynowName as string | undefined) ?? (s.legalName as string | undefined) ?? (s.name as string),
      }),
    };
  }
  return {
    school: {
      name: (s.name as string | undefined) ?? 'School',
      legalName: (s.legalName as string | undefined) ?? null,
      uen: (s.uen as string | undefined) ?? null,
      email: (s.email as string | undefined) ?? null,
      address: (s.address as string | undefined) ?? null,
      timezone,
      logoUrl: ((s.branding as { logoPdfUrl?: string } | undefined)?.logoPdfUrl as string | undefined) ?? null,
    },
    student: {
      name: [st.preferredName || st.firstName, st.lastName].filter(Boolean).join(' ') || 'Student',
      email: (st.email as string | undefined) || null,
      code: (st.studentCode as string | undefined) || null,
    },
    invoice: {
      number: inv.number,
      currency: (inv.currency as string | undefined) ?? 'SGD',
      status: inv.status,
      issueDate: (inv.issueDate as Timestamp).toDate(),
      dueDate: (inv.dueDate as Timestamp).toDate(),
      lines: inv.lines,
      subtotalCents: inv.subtotalCents ?? inv.totalCents,
      discountCents: inv.discountCents ?? 0,
      creditedCents: inv.creditedCents ?? 0,
      totalCents: inv.totalCents,
      paidCents: inv.paidCents ?? 0,
      pendingCents: pending,
      voidReason: inv.voidReason ?? null,
    },
    payments: paymentsSnap.docs
      .map((p) => ({
        paidAt: (p.get('paidAt') as Timestamp).toDate(),
        method: p.get('method') as string,
        amountCents: p.get('amountCents') as number,
      }))
      .sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime()),
    paynow,
  };
}

/** A stable fingerprint of the printable content. */
export function pdfHash(d: InvoicePdfData): string {
  return createHash('sha256').update(JSON.stringify(d)).digest('hex').slice(0, 32);
}

export type RenderOutcome = 'rendered' | 'unchanged';

/** Renders the PDF if its content changed, saves it to Storage and records it on the invoice. */
export async function renderAndStoreInvoicePdf(
  db: Firestore,
  bucket: PdfBucket,
  schoolId: string,
  invoiceId: string,
): Promise<RenderOutcome> {
  const data = await loadInvoicePdfData(db, schoolId, invoiceId);
  const hash = pdfHash(data);
  const ref = schoolRef(db, schoolId).collection('invoices').doc(invoiceId);
  if ((await ref.get()).get('pdfHash') === hash) return 'unchanged';
  const bytes = await renderInvoicePdf(data, { logo: await fetchLogo(data.school.logoUrl) });
  const path = pdfPathFor(schoolId, invoiceId);
  // Emulator only: a download token stands in for signed URLs, which need real credentials.
  const metadata = storageEmulator() ? { metadata: { firebaseStorageDownloadTokens: randomUUID() } } : undefined;
  await bucket.file(path).save(Buffer.from(bytes), { contentType: 'application/pdf', resumable: false, metadata });
  await ref.update({ pdfPath: path, pdfHash: hash, pdfAt: now(), paynow: data.paynow });
  return 'rendered';
}

/** A short-lived link to the PDF for staff, or for the student the invoice belongs to. */
export async function invoicePdfUrl(
  db: Firestore,
  bucket: PdfBucket,
  input: { schoolId: string; invoiceId: string },
  actor: Actor,
): Promise<{ url: string; expiresAt: string }> {
  const invSnap = await schoolRef(db, input.schoolId).collection('invoices').doc(input.invoiceId).get();
  if (!invSnap.exists) notFound('Invoice');
  const staff = actor.role === 'owner' || actor.role === 'admin' || actor.role === 'system';
  if (!staff && !(actor.role === 'student' && actor.studentId === invSnap.get('studentId'))) {
    throw new HttpsError('permission-denied', 'You can only open your own invoices');
  }
  // Make sure the stored PDF is current (the trigger may not have run yet).
  await renderAndStoreInvoicePdf(db, bucket, input.schoolId, input.invoiceId);
  const path = pdfPathFor(input.schoolId, input.invoiceId);
  const expires = Date.now() + 15 * 60_000;
  const emulator = storageEmulator();
  if (emulator) {
    const [meta] = await bucket.file(path).getMetadata();
    const token = meta.metadata?.firebaseStorageDownloadTokens;
    const url = `http://${emulator}/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
    return { url, expiresAt: new Date(expires).toISOString() };
  }
  const [url] = await bucket.file(path).getSignedUrl({ action: 'read', expires });
  return { url, expiresAt: new Date(expires).toISOString() };
}
