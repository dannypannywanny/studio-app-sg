import { randomUUID } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { hasValidCrc, parseTlv } from '@lessonkaki/shared';
import {
  invoicePdfUrl,
  needsWideFont,
  pdfPathFor,
  pdfSafe,
  renderAndStoreInvoicePdf,
  renderInvoicePdf,
  type InvoicePdfData,
  type PdfBucket,
} from '../src/invoicePdf';
import { recordPayment } from '../src/money';
import { db, owner, sell, withInvariant, type TestSchool } from './helpers';

const school = withInvariant();
const bucket = getStorage().bucket('demo-lessonkaki.appspot.com') as unknown as PdfBucket;
const UEN = '201403121W';

async function withUen(t: TestSchool) {
  await db.doc(`schools/${t.schoolId}`).update({ uen: UEN, legalName: 'Test School Pte. Ltd.', email: 'hello@school.test' });
  return t;
}
const invoice = async (t: TestSchool, id: string) => (await db.doc(`schools/${t.schoolId}/invoices/${id}`).get()).data()!;
const pay = (t: TestSchool, invoiceId: string, amountCents: number) =>
  recordPayment(db, { schoolId: t.schoolId, invoiceId, amountCents, method: 'paynow', idempotencyKey: randomUUID() }, owner);

describe('renderInvoicePdf', () => {
  it('produces a one-page A4 PDF', async () => {
    const bytes = await renderInvoicePdf({
      school: { name: 'Test School', uen: UEN, timezone: 'Asia/Singapore' },
      student: { name: 'Chen 陈 José', email: 'a@b.test' },
      invoice: {
        number: 'INV-00001',
        currency: 'SGD',
        status: 'partial',
        issueDate: new Date('2026-10-01T02:00:00Z'),
        dueDate: new Date('2026-10-08T02:00:00Z'),
        lines: [{ desc: '4 Sessions', qty: 1, unitCents: 30000 }],
        subtotalCents: 30000,
        discountCents: 0,
        totalCents: 30000,
        paidCents: 10000,
        pendingCents: 20000,
      },
      payments: [{ paidAt: new Date('2026-10-02T04:00:00Z'), method: 'paynow', amountCents: 10000 }],
      paynow: { payload: '00020101021226370009SG.PAYNOW', reference: 'INV-00001', amountCents: 20000 },
    });
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getTitle()).toBe('Invoice INV-00001');
  });

  it('keeps Latin-1 and replaces what standard fonts cannot draw', () => {
    expect(pdfSafe('José Ñúñez')).toBe('José Ñúñez');
    expect(pdfSafe('Chen 陈')).toBe('Chen ?');
    expect(pdfSafe('“quotes” – it’s…')).toBe(`"quotes" - it's...`);
  });
});

describe('wide font (Chinese names)', () => {
  const data = (studentName: string): InvoicePdfData => ({
    school: { name: 'Test School', uen: UEN, timezone: 'Asia/Singapore' },
    student: { name: studentName, email: null },
    invoice: {
      number: 'INV-00002',
      currency: 'SGD',
      status: 'paid',
      issueDate: new Date('2026-10-01T02:00:00Z'),
      dueDate: new Date('2026-10-08T02:00:00Z'),
      lines: [{ desc: '4 Sessions', qty: 1, unitCents: 30000 }],
      subtotalCents: 30000,
      discountCents: 0,
      totalCents: 30000,
      paidCents: 30000,
      pendingCents: 0,
    },
    payments: [],
    paynow: null,
  });
  /** BaseFont names of every font in the PDF. */
  const fonts = async (bytes: Uint8Array) => {
    const doc = await PDFDocument.load(bytes);
    return doc.context
      .enumerateIndirectObjects()
      .map(([, obj]) => obj)
      .filter((obj): obj is PDFDict => obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Font'))
      .map((f) => String(f.get(PDFName.of('BaseFont'))))
      .join(' ');
  };

  it('knows which text Helvetica cannot draw', () => {
    expect(needsWideFont('José Ñúñez “quoted” – ok…')).toBe(false);
    expect(needsWideFont('Chen 陈小明')).toBe(true);
    expect(needsWideFont('林')).toBe(true);
  });

  it('embeds a small Noto Sans SC subset only when a name needs it', async () => {
    const cjk = await renderInvoicePdf(data('陈小明 Chen'));
    expect(await fonts(cjk)).toMatch(/NotoSansSC/);
    expect(await fonts(cjk)).toMatch(/Helvetica/); // everything else stays Helvetica
    expect(cjk.length).toBeLessThan(80_000); // a subset, not the 10 MB font

    const latin = await renderInvoicePdf(data('José Tan'));
    expect(await fonts(latin)).not.toMatch(/NotoSansSC/);
  });
});

describe('renderAndStoreInvoicePdf', () => {
  it('stores the PDF with a PayNow QR for what is outstanding, and re-renders only when it changes', async () => {
    const t = await withUen(await school());
    const sale = await sell(t, t.pkg30);
    expect(await renderAndStoreInvoicePdf(db, bucket, t.schoolId, sale.invoiceId)).toBe('rendered');
    const inv = await invoice(t, sale.invoiceId);
    expect(inv.pdfPath).toBe(pdfPathFor(t.schoolId, sale.invoiceId));
    expect(inv.paynow).toMatchObject({ reference: 'INV-00001', amountCents: 30000 });
    expect(hasValidCrc(inv.paynow.payload)).toBe(true);
    const fields = new Map(parseTlv(inv.paynow.payload));
    expect(fields.get('54')).toBe('300.00');
    expect(new Map(parseTlv(fields.get('26')!)).get('02')).toBe(UEN);
    expect(new Map(parseTlv(fields.get('62')!)).get('01')).toBe('INV-00001');

    const [file] = await getStorage().bucket('demo-lessonkaki.appspot.com').file(inv.pdfPath).download();
    expect(file.subarray(0, 5).toString()).toBe('%PDF-');

    expect(await renderAndStoreInvoicePdf(db, bucket, t.schoolId, sale.invoiceId)).toBe('unchanged');

    await pay(t, sale.invoiceId, 10000);
    expect(await renderAndStoreInvoicePdf(db, bucket, t.schoolId, sale.invoiceId)).toBe('rendered');
    const partial = await invoice(t, sale.invoiceId);
    expect(new Map(parseTlv(partial.paynow.payload)).get('54')).toBe('200.00');

    await pay(t, sale.invoiceId, 20000);
    await renderAndStoreInvoicePdf(db, bucket, t.schoolId, sale.invoiceId);
    expect((await invoice(t, sale.invoiceId)).paynow).toBeNull();
  });

  it('leaves out the QR when the school has no UEN', async () => {
    const t = await school();
    const sale = await sell(t, t.pkg30);
    await renderAndStoreInvoicePdf(db, bucket, t.schoolId, sale.invoiceId);
    expect((await invoice(t, sale.invoiceId)).paynow).toBeNull();
  });
});

describe('invoicePdfUrl', () => {
  it('gives staff and the invoice owner a working link, nobody else', async () => {
    const t = await withUen(await school());
    const sale = await sell(t, t.pkg30);
    const { url } = await invoicePdfUrl(db, bucket, { schoolId: t.schoolId, invoiceId: sale.invoiceId }, owner);
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');

    const me = { uid: 's1', role: 'student' as const, studentId: t.studentId };
    await expect(invoicePdfUrl(db, bucket, { schoolId: t.schoolId, invoiceId: sale.invoiceId }, me)).resolves.toBeTruthy();
    const other = { uid: 's2', role: 'student' as const, studentId: 'someoneElse' };
    await expect(invoicePdfUrl(db, bucket, { schoolId: t.schoolId, invoiceId: sale.invoiceId }, other)).rejects.toThrow(
      /your own/,
    );
    const teacher = { uid: 't1', role: 'teacher' as const, teacherId: t.teacherId };
    await expect(invoicePdfUrl(db, bucket, { schoolId: t.schoolId, invoiceId: sale.invoiceId }, teacher)).rejects.toThrow();
  });
});
