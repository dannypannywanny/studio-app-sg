import { getFirestore } from 'firebase-admin/firestore';
import { initTarget } from './target';
initTarget();
const ref = getFirestore().doc('schools/sywh/checkouts/eZFBSpyHjt0CzJFffHDs');
for (let i = 0; i < 100; i++) {
  const d = (await ref.get()).data()!;
  if (d.status !== 'pending') {
    console.log('status', d.status, 'invoice', d.invoiceId ?? '-', 'paymentRef', d.paymentRef ?? '-');
    if (d.invoiceId) {
      const inv = (await getFirestore().doc(`schools/sywh/invoices/${d.invoiceId}`).get()).data()!;
      console.log('invoice', inv.number, inv.status, inv.paidCents, inv.pendingCents);
    }
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 15000));
}
console.log('still pending after 25 min');
