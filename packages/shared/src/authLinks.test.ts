import { describe, expect, it } from 'vitest';
import { resolveActionLink } from './authLinks';

const APP = 'https://teach.example.test/finish-signin';
// No URL type in this package's lib; a tiny query reader is enough for the assertions.
const q = (href: string) => ({
  get: (name: string) => {
    const m = href.match(new RegExp(`[?&]${name}=([^&]*)`));
    return m ? decodeURIComponent(m[1]!) : null;
  },
});

describe('resolveActionLink', () => {
  it('adds the apiKey to a sign-in link that lacks it', () => {
    const r = resolveActionLink(`${APP}?mode=signIn&oobCode=abc&continueUrl=x&lang=en`, 'KEY', 'p.firebaseapp.com');
    expect(r.kind).toBe('signIn');
    if (r.kind !== 'signIn') return;
    expect(q(r.href).get('apiKey')).toBe('KEY');
    expect(q(r.href).get('oobCode')).toBe('abc');
  });

  it('keeps an apiKey that is already there', () => {
    const r = resolveActionLink(`${APP}?apiKey=THEIRS&mode=signIn&oobCode=abc`, 'KEY', 'p.firebaseapp.com');
    expect(r.kind === 'signIn' && q(r.href).get('apiKey')).toBe('THEIRS');
  });

  it("sends other email actions to Firebase's handler", () => {
    const r = resolveActionLink(`${APP}?mode=revertSecondFactorAddition&oobCode=abc`, 'KEY', 'p.firebaseapp.com');
    expect(r.kind).toBe('firebase');
    if (r.kind !== 'firebase') return;
    expect(r.href.startsWith('https://p.firebaseapp.com/__/auth/action?')).toBe(true);
    expect(q(r.href).get('mode')).toBe('revertSecondFactorAddition');
    expect(q(r.href).get('apiKey')).toBe('KEY');
  });

  it('ignores pages without an action', () => {
    expect(resolveActionLink(APP, 'KEY', 'p.firebaseapp.com').kind).toBe('none');
    expect(resolveActionLink(`${APP}?mode=signIn`, 'KEY', 'p.firebaseapp.com').kind).toBe('none');
  });
});
