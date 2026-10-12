// Sets up a school's learn site (student portal + booking) from functions/scripts/schools/<id>-learn.json:
//   - publicSchools/{hostname} for each learn host, so the sign-in page can show the school before login
//   - schools/{id}/public/profile: name, logo, contact, and teachers' public names (students can't read teachers)
//   - schools/{id}/availability/{teacherId} for each teacher listed under "availability" (booking hours)
//
//   # emulator
//   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pnpm --filter functions exec tsx scripts/setup-learn.ts --file scripts/schools/sywh-learn.json
//   # production (needs approval; ADC from `gcloud auth application-default login`)
//   pnpm --filter functions exec tsx scripts/setup-learn.ts --project class-app-sg --file scripts/schools/sywh-learn.json
//
// Re-runnable. Availability docs are replaced as a whole for the teachers listed; others are left alone.
import { readFileSync } from 'node:fs';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { openSlots, resolveAvailability, type Availability } from '@lessonkaki/shared';
import { argValue, initTarget } from './target';

interface LearnProfile {
  schoolId: string;
  /** Hostnames the learn site is served from (no scheme), e.g. the web.app host and the custom domain. */
  hosts: string[];
  profile: { name: string; logoUrl: string | null; siteUrl: string | null; contactEmail: string | null; whatsapp: string | null };
  availability?: Record<string, Availability>;
}

async function main() {
  const target = initTarget();
  const file = argValue(process.argv, 'file');
  if (!file) throw new Error('--file is required');
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as LearnProfile;
  const db = getFirestore();
  const school = db.collection('schools').doc(cfg.schoolId);
  const schoolSnap = await school.get();
  if (!schoolSnap.exists) throw new Error(`School ${cfg.schoolId} not found in ${target.projectId}`);
  const timeZone = (schoolSnap.get('timezone') as string | undefined) ?? 'Asia/Singapore';

  const teachers = await school.collection('teachers').where('active', '==', true).get();
  const teacherNames = Object.fromEntries(
    teachers.docs.map((d) => [d.id, { name: (d.get('publicName') as string | undefined) || (d.get('displayName') as string) }]),
  );

  const ts = FieldValue.serverTimestamp();
  const batch = db.batch();
  for (const host of cfg.hosts) {
    if (!/^[a-z0-9.-]+(:\d+)?$/.test(host)) throw new Error(`Bad host "${host}" (no scheme or path)`);
    batch.set(db.collection('publicSchools').doc(host), { schoolId: cfg.schoolId, site: 'learn', updatedAt: ts });
  }
  batch.set(school.collection('public').doc('profile'), { ...cfg.profile, teachers: teacherNames, updatedAt: ts });

  for (const [teacherId, hours] of Object.entries(cfg.availability ?? {})) {
    if (!teacherNames[teacherId]) throw new Error(`Teacher ${teacherId} not found or inactive`);
    const resolved = resolveAvailability(hours);
    if (resolved.weekly.length !== (hours.weekly ?? []).length) throw new Error(`Some weekly hours for ${teacherId} are invalid`);
    batch.set(school.collection('availability').doc(teacherId), { ...hours, updatedAt: ts });
    const next = openSlots(resolved, { timeZone, now: new Date(), busy: [] }).slice(0, 3);
    console.log(`${teacherId}: ${resolved.weekly.length} weekly blocks; first open times (before lessons): ${next.map((s) => s.startAt.toISOString()).join(', ')}`);
  }
  await batch.commit();
  console.log(`Learn site set up for "${cfg.schoolId}" in ${target.projectId}: hosts ${cfg.hosts.join(', ')}; ${teachers.size} teachers in the profile.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
