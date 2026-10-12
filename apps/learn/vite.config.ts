import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// Same rule as teach: a production build needs the web app config from apps/learn/.env.production
// (gitignored; keys in .env.example). Fail early rather than ship a bundle with `undefined` config.
const REQUIRED = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_AUTH_DOMAIN', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID'];

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
  if (command === 'build' && env.VITE_USE_EMULATORS !== 'true') {
    const missing = REQUIRED.filter((key) => !env[key]);
    if (missing.length) {
      throw new Error(`Missing ${missing.join(', ')} for mode "${mode}". Copy apps/learn/.env.example to .env.${mode}.`);
    }
  }
  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@lessonkaki/shared': fileURLToPath(new URL('../../packages/shared/src/index.ts', import.meta.url)),
      },
    },
    server: { port: 5174, strictPort: true },
  };
});
