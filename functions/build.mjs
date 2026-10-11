// Bundles the functions into lib/index.js. @lessonkaki/shared is inlined from source (path alias, not a
// workspace dependency), so `firebase deploy` can still `npm install` this folder on its own.
// firebase-admin and firebase-functions stay external: they are installed from package.json at deploy.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

await build({
  entryPoints: [here('./src/index.ts')],
  outfile: here('./lib/index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['firebase-admin', 'firebase-admin/*', 'firebase-functions', 'firebase-functions/*'],
  alias: { '@lessonkaki/shared': here('../packages/shared/src/index.ts') },
  logLevel: 'info',
});
