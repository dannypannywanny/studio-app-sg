/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'true' to use the local emulators outside `vite dev` (e.g. `vite preview`). */
  readonly VITE_USE_EMULATORS?: string;
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_EMULATOR_AUTH_PORT?: string;
  readonly VITE_EMULATOR_FIRESTORE_PORT?: string;
  readonly VITE_EMULATOR_FUNCTIONS_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
