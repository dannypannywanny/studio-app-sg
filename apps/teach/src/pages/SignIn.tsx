import { sendSignInLinkToEmail } from 'firebase/auth';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { AUTH_EMULATOR_URL, PROJECT_ID, auth, useEmulators } from '../firebase';
import { useSession } from '../session';

export const EMAIL_KEY = 'lk.emailForSignIn';

/** Dev only: the auth emulator doesn't send email, it lists the links it would have sent. */
async function latestEmulatorLink(email: string): Promise<string | null> {
  const res = await fetch(`${AUTH_EMULATOR_URL}/emulator/v1/projects/${PROJECT_ID}/oobCodes`);
  const body = (await res.json()) as { oobCodes?: { email: string; requestType: string; oobLink: string }[] };
  const mine = (body.oobCodes ?? []).filter((c) => c.email === email && c.requestType === 'EMAIL_SIGNIN');
  return mine.at(-1)?.oobLink ?? null;
}

export function SignIn() {
  const { user, ready } = useSession();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (ready && user) return <Navigate to="/students" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const clean = email.trim().toLowerCase();
      await sendSignInLinkToEmail(auth, clean, {
        url: `${window.location.origin}/finish-signin`,
        handleCodeInApp: true,
      });
      window.localStorage.setItem(EMAIL_KEY, clean);
      setEmail(clean);
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openDevLink() {
    setError(null);
    const link = await latestEmulatorLink(email);
    if (!link) return setError('No sign-in link found in the auth emulator yet.');
    // Keep the emulator's query (mode, oobCode, apiKey) but finish on this app's page.
    window.location.assign(`/finish-signin${new URL(link).search}`);
  }

  return (
    <div className="auth-card">
      <h1>Sign in</h1>
      {!sent ? (
        <form onSubmit={submit} className="stack">
          <label className="field">
            <span>Email</span>
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@school.sg"
            />
          </label>
          <button className="btn btn-primary" disabled={busy}>
            {busy ? 'Sending…' : 'Email me a sign-in link'}
          </button>
        </form>
      ) : (
        <div className="stack">
          <p>
            We sent a sign-in link to <strong>{email}</strong>. Open it on this device to finish signing in.
          </p>
          {useEmulators && (
            <button className="btn btn-primary" onClick={openDevLink}>
              Dev: open the link from the auth emulator
            </button>
          )}
          <button className="btn btn-ghost" onClick={() => setSent(false)}>
            Use a different email
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
