// Invoice PDFs: rendered with pdf-lib (no headless browser) and stored in Cloud Storage. When money is
// still owed and the school has a UEN, the PDF carries a PayNow QR for the outstanding amount with the
// invoice number as reference. The same payload is saved on the invoice so the app can show the QR.
//
// Re-rendered on every invoice write whose printable content changed (hash of the inputs), so writing
// the PDF fields back onto the invoice doesn't loop.
import { createHash, randomUUID } from 'node:crypto';
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
  school: { name: string; legalName?: string | null; uen?: string | null; email?: string | null; address?: string | null; timezone: string };
  student: { name: string; email?: string | null };
  invoice: {
    number: string;
    currency: string;
    status: string;
    issueDate: Date;
    dueDate: Date;
    lines: { desc: string; qty: number; unitCents: number }[];
    subtotalCents: number;
    discountCents: number;
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

/** Standard PDF fonts only encode WinAnsi; anything else (e.g. CJK names) becomes '?'. */
const PUNCTUATION: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...' };

export function pdfSafe(text: string): string {
  return [...text.normalize('NFC')]
    .map((ch) => PUNCTUATION[ch] ?? ch)
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff)) return ch;
      const base = ch.normalize('NFKD').replace(/[^\x20-\x7e]/g, '');
      return base || '?';
    })
    .join('');
}

const METHOD: Record<string, string> = { paynow: 'PayNow', bank: 'Bank transfer', cash: 'Cash', card_hitpay: 'Card' };
const INK = rgb(0.08, 0.06, 0.12);
const MUTED = rgb(0.4, 0.38, 0.45);
const LINE = rgb(0.85, 0.85, 0.88);

export async function renderInvoicePdf(d: InvoicePdfData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Invoice ${d.invoice.number}`);
  doc.setAuthor(pdfSafe(d.school.name));
  doc.setCreator('LessonKaki');
  const page = doc.addPage([595.28, 841.89]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = page.getWidth();
  const M = 48;
  const money = (c: number) => pdfSafe(formatMoney(c, d.invoice.currency));
  const date = (x: Date) => pdfSafe(formatDate(x, d.school.timezone));

  const text = (p: PDFPage, s: string, x: number, y: number, size = 10, f: PDFFont = font, color = INK) =>
    p.drawText(pdfSafe(s), { x, y, size, font: f, color });
  const right = (p: PDFPage, s: string, xr: number, y: number, size = 10, f: PDFFont = font, color = INK) =>
    text(p, s, xr - f.widthOfTextAtSize(pdfSafe(s), size), y, size, f, color);

  // Header: school on the left, invoice facts on the right.
  let y = 790;
  text(page, d.school.name, M, y, 18, bold);
  const schoolLines = [
    d.school.legalName,
    d.school.uen ? `UEN ${d.school.uen}` : null,
    d.school.address,
    d.school.email,
  ].filter(Boolean) as string[];
  schoolLines.forEach((l, i) => text(page, l, M, y - 18 - i * 13, 9, font, MUTED));
  right(page, 'INVOICE', W - M, y, 18, bold);
  right(page, d.invoice.number, W - M, y - 18, 11, bold);
  right(page, `Issued ${date(d.invoice.issueDate)}`, W - M, y - 32, 9, font, MUTED);
  right(page, `Due ${date(d.invoice.dueDate)}`, W - M, y - 45, 9, font, MUTED);

  y = 690;
  text(page, 'BILL TO', M, y, 8, bold, MUTED);
  text(page, d.student.name, M, y - 14, 11, bold);
  if (d.student.email) text(page, d.student.email, M, y - 28, 9, font, MUTED);

  const stamp = d.invoice.status === 'paid' ? 'PAID' : d.invoice.status === 'void' ? 'VOID' : null;
  if (stamp) {
    const color = stamp === 'PAID' ? rgb(0.08, 0.5, 0.24) : rgb(0.73, 0.11, 0.11);
    right(page, stamp, W - M, y - 14, 22, bold, color);
    if (stamp === 'VOID' && d.invoice.voidReason) right(page, d.invoice.voidReason, W - M, y - 30, 9, font, MUTED);
  }

  // Lines
  y = 620;
  const cols = { qty: W - M - 190, unit: W - M - 90, amount: W - M };
  text(page, 'Description', M, y, 9, bold, MUTED);
  right(page, 'Qty', cols.qty, y, 9, bold, MUTED);
  right(page, 'Unit price', cols.unit, y, 9, bold, MUTED);
  right(page, 'Amount', cols.amount, y, 9, bold, MUTED);
  page.drawLine({ start: { x: M, y: y - 6 }, end: { x: W - M, y: y - 6 }, thickness: 0.7, color: LINE });
  y -= 22;
  for (const l of d.invoice.lines) {
    text(page, l.desc.slice(0, 70), M, y);
    right(page, String(l.qty), cols.qty, y);
    right(page, money(l.unitCents), cols.unit, y);
    right(page, money(l.qty * l.unitCents), cols.amount, y);
    y -= 18;
  }
  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: W - M, y: y + 6 }, thickness: 0.7, color: LINE });

  // Totals
  y -= 12;
  const totals: [string, string, boolean][] = [['Subtotal', money(d.invoice.subtotalCents), false]];
  if (d.invoice.discountCents) totals.push(['Discount', `-${money(d.invoice.discountCents)}`, false]);
  totals.push(['Total', money(d.invoice.totalCents), true]);
  if (d.invoice.paidCents) totals.push(['Paid', `-${money(d.invoice.paidCents)}`, false]);
  if (d.invoice.status !== 'void') totals.push(['Balance due', money(d.invoice.pendingCents), true]);
  for (const [label, value, strong] of totals) {
    right(page, label, cols.unit, y, 10, strong ? bold : font, strong ? INK : MUTED);
    right(page, value, cols.amount, y, 10, strong ? bold : font);
    y -= 16;
  }

  // Payments received
  if (d.payments.length) {
    y -= 14;
    text(page, 'PAYMENTS RECEIVED', M, y, 8, bold, MUTED);
    y -= 14;
    for (const p of d.payments) {
      text(page, `${date(p.paidAt)} · ${METHOD[p.method] ?? p.method}`, M, y, 9);
      right(page, money(p.amountCents), cols.amount, y, 9);
      y -= 13;
    }
  }

  // PayNow
  if (d.paynow) {
    const size = 132;
    const top = y - 30;
    const qr = QRCode.create(d.paynow.payload, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const cell = size / (n + 8); // 4-module quiet zone each side
    const x0 = M;
    const y0 = top - size;
    page.drawRectangle({ x: x0, y: y0, width: size, height: size, color: rgb(1, 1, 1), borderColor: LINE, borderWidth: 0.7 });
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.modules.get(r, c)) continue;
        page.drawRectangle({
          x: x0 + (c + 4) * cell,
          y: y0 + size - (r + 5) * cell,
          width: cell,
          height: cell,
          color: rgb(0, 0, 0),
        });
      }
    }
    const tx = x0 + size + 20;
    text(page, 'Pay by PayNow', tx, top - 16, 13, bold);
    text(page, 'Scan with your banking app. The amount and reference fill in for you.', tx, top - 34, 9, font, MUTED);
    text(page, `Amount: ${money(d.paynow.amountCents)}`, tx, top - 54, 10);
    text(page, `Reference: ${d.paynow.reference}`, tx, top - 68, 10);
    if (d.school.uen) text(page, `PayNow UEN: ${d.school.uen}`, tx, top - 82, 10);
  }

  // Footer
  text(page, `Thank you.${d.school.email ? ` Questions? ${d.school.email}` : ''}`, M, 40, 8, font, MUTED);
  return doc.save();
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
    },
    student: {
      name: [st.preferredName || st.firstName, st.lastName].filter(Boolean).join(' ') || 'Student',
      email: (st.email as string | undefined) || null,
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
  const bytes = await renderInvoicePdf(data);
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
