import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { getFirestore } from 'firebase-admin/firestore';
import { initTarget } from './target';
import { parseKeyRing } from '../src/checkout';
initTarget();
const db = getFirestore();
const salt = parseKeyRing(execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret', 'HITPAY_KEYS', '--project', 'class-app-sg'], { encoding: 'utf8' })).sywh!.salt;
let doc;
for (let i = 0; i < 80; i++) {
  try {
    const q = await db.collection('schools/sywh/webhookRejects').orderBy('at', 'desc').limit(1).get();
    if (!q.empty) { doc = q.docs[0]!.data(); break; }
  } catch { /* blip */ }
  await new Promise((r) => setTimeout(r, 15000));
}
if (!doc) { console.log('no rejected message stored yet'); process.exit(0); }
const raw: string = doc.raw; const sig: string = String(doc.signature ?? '');
const h = (key: string, data: string, enc: 'hex' | 'base64') => createHmac('sha256', key).update(data).digest(enc);
const parsed = JSON.parse(raw);
const flat = Object.keys(parsed).filter((k) => k !== 'hmac').sort().map((k) => `${k}${typeof parsed[k] === 'object' ? JSON.stringify(parsed[k]) : parsed[k]}`).join('');
const variants: Record<string, string> = {
  'hex(raw)': h(salt, raw, 'hex'),
  'base64(raw)': h(salt, raw, 'base64'),
  'hex(raw, trimmed salt)': h(salt.trim(), raw, 'hex'),
  'hex(JSON.stringify(parsed))': h(salt, JSON.stringify(parsed), 'hex'),
  'hex(legacy sorted k+v)': h(salt, flat, 'hex'),
};
console.log('signature length', sig.length, 'looks', /^[0-9a-f]+$/i.test(sig) ? 'hex' : 'other', '| body length', raw.length, '| salt length', salt.length);
console.log('payload keys', Object.keys(parsed).join(','), '| status', parsed.status, '| ref', parsed.reference_number);
for (const [name, v] of Object.entries(variants)) console.log(name, v.toLowerCase() === sig.toLowerCase() ? 'MATCH' : 'no');
