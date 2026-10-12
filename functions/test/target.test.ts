import { describe, expect, it } from 'vitest';
import { resolveTarget } from '../scripts/target';

const argv = (...a: string[]) => ['node', 'script.ts', ...a];

describe('script target guard', () => {
  it('defaults to the demo emulator project, and needs the emulator host', () => {
    expect(resolveTarget(argv(), { FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' })).toEqual({ projectId: 'demo-lessonkaki', production: false });
    expect(() => resolveTarget(argv(), {})).toThrow(/Refusing/);
    expect(() => resolveTarget(argv(), { GCLOUD_PROJECT: 'class-app-sg', FIRESTORE_EMULATOR_HOST: 'x' })).toThrow(/Refusing/);
  });

  it('reaches class-app-sg only with an explicit --project flag', () => {
    expect(resolveTarget(argv('--project', 'class-app-sg'), {})).toEqual({ projectId: 'class-app-sg', production: true });
  });

  it('refuses unknown projects and mixed emulator/production settings', () => {
    expect(() => resolveTarget(argv('--project', 'someone-else'), {})).toThrow(/not an allowed project/);
    expect(() => resolveTarget(argv('--project', 'class-app-sg'), { FIRESTORE_EMULATOR_HOST: 'x' })).toThrow(/Unset the emulator/);
    expect(() => resolveTarget(argv('--project', 'class-app-sg'), { FIREBASE_AUTH_EMULATOR_HOST: 'x' })).toThrow(/Unset the emulator/);
    expect(() => resolveTarget(argv('--project', 'class-app-sg'), { GCLOUD_PROJECT: 'demo-lessonkaki' })).toThrow(/GCLOUD_PROJECT/);
  });
});
