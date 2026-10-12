import {
  getMultiFactorResolver,
  multiFactor,
  TotpMultiFactorGenerator,
  type MultiFactorError,
  type MultiFactorResolver,
  type TotpSecret,
  type User,
} from 'firebase/auth';
import QRCode from 'qrcode';
import { useEffect, useState, type FormEvent } from 'react';
import { auth } from '../firebase';

// Staff (owner, admin, teacher) sign in with an email link plus a code from an authenticator app (TOTP).
// Rules and functions refuse staff tokens without the second factor; this file is the client half.

function CodeField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span>6-digit code</span>
      <input
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6}"
        maxLength={6}
        required
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))}
      />
    </label>
  );
}

const message = (err: unknown) => {
  const code = (err as { code?: string }).code;
  if (code === 'auth/invalid-verification-code') return 'That code did not match. Check the time on your phone and try the newest code.';
  if (code === 'auth/requires-recent-login') return 'For safety, sign in again before setting this up.';
  return (err as Error).message;
};

/** Shown to staff who have no second factor yet: enrol an authenticator app, then carry on. */
export function TwoStepSetup({ user }: { user: User }) {
  const enrolled = multiFactor(user).enrolledFactors.length > 0;
  const [secret, setSecret] = useState<TotpSecret | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (enrolled) return;
    let cancelled = false;
    (async () => {
      try {
        const s = await TotpMultiFactorGenerator.generateSecret(await multiFactor(user).getSession());
        // The issuer is the host (e.g. teach.yourschool.sg) so each school's entry is recognisable.
        const url = s.generateQrCodeUrl(user.email ?? user.uid, window.location.hostname);
        const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 220 });
        if (!cancelled) {
          setSecret(s);
          setQr(dataUrl);
        }
      } catch (err) {
        if (!cancelled) setError(message(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, enrolled]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!secret) return;
    setBusy(true);
    setError(null);
    try {
      await multiFactor(user).enroll(TotpMultiFactorGenerator.assertionForEnrollment(secret, code), 'Authenticator app');
      // Enrolment proves the factor; a fresh token carries it, and the session picks it up.
      const token = await user.getIdTokenResult(true);
      if (!token.signInSecondFactor) await auth.signOut();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  if (enrolled) {
    return (
      <div className="auth-card stack">
        <h1>Sign in again</h1>
        <p>Two-step sign-in is set up for {user.email}. Sign in again and enter the code from your authenticator app.</p>
        <button className="btn btn-primary" onClick={() => auth.signOut()}>
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="auth-card stack">
      <h1>Set up two-step sign-in</h1>
      <p>
        Staff accounts can see student records and money, so they need a second step: a code from an authenticator app
        (Google Authenticator, Microsoft Authenticator, 1Password and similar).
      </p>
      <ol className="stack">
        <li>Open your authenticator app and add an account by scanning this code.</li>
        {qr ? <img src={qr} width={220} height={220} alt="QR code to add this account to an authenticator app" /> : !error && <p>Preparing…</p>}
        {secret && (
          <li>
            Can't scan? Enter this key instead: <code className="secret-key">{secret.secretKey}</code>
          </li>
        )}
        <li>Type the 6-digit code the app shows.</li>
      </ol>
      <form onSubmit={submit} className="stack">
        <CodeField value={code} onChange={setCode} />
        <button className="btn btn-primary" disabled={busy || !secret || code.length !== 6}>
          {busy ? 'Checking…' : 'Turn on two-step sign-in'}
        </button>
      </form>
      <p className="muted">Keep the authenticator app backed up. If you lose it, the school owner can reset it.</p>
      {error && <p className="error">{error}</p>}
      <button className="btn btn-ghost" onClick={() => auth.signOut()}>
        Sign out
      </button>
    </div>
  );
}

/** The resolver for a sign-in that needs the second factor, if `err` is that error. */
export function secondFactorResolver(err: unknown): MultiFactorResolver | null {
  if ((err as { code?: string }).code !== 'auth/multi-factor-auth-required') return null;
  return getMultiFactorResolver(auth, err as MultiFactorError);
}

/** Second step of sign-in: the code from the authenticator app. */
export function SecondFactorPrompt({ resolver, onDone }: { resolver: MultiFactorResolver; onDone: () => void }) {
  const hint = resolver.hints.find((h) => h.factorId === TotpMultiFactorGenerator.FACTOR_ID);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!hint) return;
    setBusy(true);
    setError(null);
    try {
      await resolver.resolveSignIn(TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code));
      onDone();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }

  if (!hint) return <p className="error">This account's second step isn't an authenticator app. Ask the school owner to reset it.</p>;

  return (
    <form onSubmit={submit} className="stack">
      <p>Enter the code from your authenticator app{hint.displayName ? ` (${hint.displayName})` : ''}.</p>
      <CodeField value={code} onChange={setCode} />
      <button className="btn btn-primary" disabled={busy || code.length !== 6}>
        {busy ? 'Checking…' : 'Sign in'}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
