// Which Firebase project an admin script writes to. One guard for every script under functions/scripts.
//
// - No flag: the local emulator suite (a demo-* project), and FIRESTORE_EMULATOR_HOST must be set.
// - `--project <id>`: a real project, only if it is listed in PRODUCTION_PROJECTS and no emulator
//   variables are set (so a stray env var can't send "production" writes to the emulator, or the reverse).
//   Credentials come from `gcloud auth application-default login`.
import { initializeApp } from 'firebase-admin/app';

export const PRODUCTION_PROJECTS = ['class-app-sg'] as const;
const EMULATOR_VARS = ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'FIREBASE_STORAGE_EMULATOR_HOST'];

export interface Target {
  projectId: string;
  production: boolean;
}

export function argValue(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i > 0 ? argv[i + 1] : undefined;
}

/** Pure: decides the target from argv + env, or throws with the reason. */
export function resolveTarget(argv: readonly string[], env: NodeJS.ProcessEnv): Target {
  const flag = argValue(argv, 'project');
  if (flag === undefined) {
    const projectId = env.GCLOUD_PROJECT ?? 'demo-lessonkaki';
    if (!projectId.startsWith('demo-') || !env.FIRESTORE_EMULATOR_HOST) {
      throw new Error(
        `Refusing to run against "${projectId}" (FIRESTORE_EMULATOR_HOST=${env.FIRESTORE_EMULATOR_HOST ?? 'unset'}). ` +
          'Without --project, scripts only run against a demo-* emulator project.',
      );
    }
    return { projectId, production: false };
  }
  if (!(PRODUCTION_PROJECTS as readonly string[]).includes(flag)) {
    throw new Error(`--project ${flag} is not an allowed project (${PRODUCTION_PROJECTS.join(', ')}).`);
  }
  const set = EMULATOR_VARS.filter((v) => env[v]);
  if (set.length) throw new Error(`--project ${flag} with ${set.join(', ')} set. Unset the emulator variables first.`);
  if (env.GCLOUD_PROJECT && env.GCLOUD_PROJECT !== flag) {
    throw new Error(`--project ${flag} but GCLOUD_PROJECT=${env.GCLOUD_PROJECT}. Unset GCLOUD_PROJECT or make them match.`);
  }
  return { projectId: flag, production: true };
}

/** Resolves the target from this process, initialises the Admin SDK for it, and says where it points. */
export function initTarget(): Target {
  const target = resolveTarget(process.argv, process.env);
  if (target.production) {
    // User credentials (ADC) need a quota project; bill API quota to the target, not the ADC default.
    process.env.GOOGLE_CLOUD_QUOTA_PROJECT = target.projectId;
    process.env.GCLOUD_PROJECT = target.projectId;
    console.log(`*** PRODUCTION: ${target.projectId} ***`);
  }
  initializeApp({ projectId: target.projectId });
  return target;
}
