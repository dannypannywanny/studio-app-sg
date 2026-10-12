// Bulk student import (CSV, migration). The app shows planImport's result for review first; this
// function re-plans against the students that exist *now*, so a stale review or a retry can't create
// duplicates, then creates only the rows that are still new. The Classcard id is kept as legacyId.
import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { planImport, type ExistingStudent, type ImportAction, type ImportCandidate } from '@lessonkaki/shared';
import { now, schoolRef, type Actor } from './db';

export interface ImportStudentsInput {
  schoolId: string;
  rows: ImportCandidate[];
  excludeEmails?: string[];
}

export interface ImportStudentsResult {
  batchId: string;
  created: number;
  skipped: { row: number; action: ImportAction; reasons: string[] }[];
}

export const MAX_IMPORT_ROWS = 2000;

export async function importStudents(db: Firestore, input: ImportStudentsInput, actor: Actor): Promise<ImportStudentsResult> {
  if (!(actor.role === 'owner' || actor.role === 'admin' || actor.role === 'system')) {
    throw new HttpsError('permission-denied', 'Only an owner or admin can import students');
  }
  if (input.rows.length > MAX_IMPORT_ROWS) throw new HttpsError('invalid-argument', `At most ${MAX_IMPORT_ROWS} rows per import`);
  const school = schoolRef(db, input.schoolId);
  if (!(await school.get()).exists) throw new HttpsError('not-found', 'School not found');

  const existing: ExistingStudent[] = (await school.collection('students').get()).docs.map((d) => ({
    id: d.id,
    email: d.get('email') ?? null,
    phone: d.get('phone') ?? null,
    legacyId: d.get('legacyId') ?? null,
  }));
  const plan = planImport(input.rows, existing, { excludeEmails: input.excludeEmails });
  const toCreate = plan.filter((p) => p.action === 'create').map((p) => p.candidate);
  const batchId = randomUUID();

  for (let i = 0; i < toCreate.length; i += 200) {
    const batch = db.batch();
    for (const c of toCreate.slice(i, i + 200)) {
      const ref = school.collection('students').doc();
      batch.create(ref, {
        firstName: c.firstName,
        lastName: c.lastName,
        preferredName: null,
        email: c.email,
        phone: c.phone,
        status: c.status,
        studentCode: c.legacyId,
        legacyId: c.legacyId,
        createdOn: c.createdOn,
        referralSource: c.referralSource,
        signupSource: c.signupSource,
        consent: null,
        summary: { sessionsAvailable: 0, sessionsOwed: 0, outstandingCents: 0, moneyCreditCents: 0 },
        importBatchId: batchId,
        createdAt: now(),
        updatedAt: now(),
      });
      // Staff notes are kept off the student doc (students may read their own doc later).
      if (c.note) batch.create(ref.collection('private').doc('notes'), { text: c.note, updatedAt: now() });
    }
    await batch.commit();
  }

  const skipped = plan
    .filter((p) => p.action !== 'create')
    .map((p) => ({ row: p.candidate.row, action: p.action, reasons: p.reasons.map(String) }));
  await school.collection('auditLog').add({
    actorUid: actor.uid,
    action: 'importStudents',
    target: 'students',
    detail: { batchId, created: toCreate.length, skipped: skipped.length },
    at: now(),
  });
  return { batchId, created: toCreate.length, skipped };
}
