import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

// In dev everything talks to the local emulators (project demo-lessonkaki). Nothing reaches production.
export const useEmulators = import.meta.env.DEV || import.meta.env.VITE_USE_EMULATORS === 'true';

const config = useEmulators
  ? { apiKey: 'demo-key', authDomain: 'demo-lessonkaki.firebaseapp.com', projectId: 'demo-lessonkaki', appId: 'demo-app' }
  : {
      apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
      appId: import.meta.env.VITE_FIREBASE_APP_ID,
    };

const env = import.meta.env;
const port = (value: string | undefined, fallback: number) => Number(value ?? fallback);
const PORTS = {
  auth: port(env.VITE_EMULATOR_AUTH_PORT, 9099),
  firestore: port(env.VITE_EMULATOR_FIRESTORE_PORT, 8080),
  functions: port(env.VITE_EMULATOR_FUNCTIONS_PORT, 5001),
};

export const PROJECT_ID = config.projectId as string;
export const AUTH_EMULATOR_URL = `http://127.0.0.1:${PORTS.auth}`;

export const app = initializeApp(config);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app, 'asia-southeast1');

if (useEmulators) {
  connectAuthEmulator(auth, AUTH_EMULATOR_URL, { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', PORTS.firestore);
  connectFunctionsEmulator(functions, '127.0.0.1', PORTS.functions);
}

/** A typed callable: `await call<In, Out>('bookLesson')(input)`. */
export function call<In, Out>(name: string) {
  const fn = httpsCallable<In, Out>(functions, name);
  return async (data: In): Promise<Out> => (await fn(data)).data;
}

/** The message from a callable's HttpsError, without the SDK's prefixes. */
export function errorMessage(err: unknown): string {
  const e = err as { code?: string; message?: string };
  if (e?.code === 'functions/unavailable' || e?.code === 'unavailable') return 'No connection. Check your internet and try again.';
  return e?.message?.replace(/^Firebase: /, '').replace(/ \(.+\)\.?$/, '') || 'Something went wrong. Please try again.';
}
