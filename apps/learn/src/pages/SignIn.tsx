import { ArrowRight, EnvelopeSimple } from '@phosphor-icons/react';
import { sendSignInLinkToEmail } from 'firebase/auth';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router';
import { AuthShell } from '../components/AuthShell';
import { AUTH_EMULATOR_URL, PROJECT_ID, auth, useEmulators } from '../firebase';
import { useSession } from '../session';

export const EMAIL_KEY = 'lk.learn.emailForSignIn';

/** Dev only: the auth emulator doesn't send email, it lists the links it would have sent. */
async function latestEmulatorLink(email: string): Promise<string | null> {
  const res = await fetch(`${AUTH_EMULATOR_URL}/emulator/v1/projects/${PROJECT_ID}/oobCodes`);
  const body = (await res.json()) as { oobCodes?: { email: string; requestType: string; oobLink: string }[] };
  const mine = (body.oobCodes ?? []).filter((c) => c.email === email && c.requestType === 'EMAIL_SIGNIN');
  return mine.at(-1)?.oobLink ?? null;
}

function remember(email: string) {
  try {
    window.localStorage.setItem(EMAIL_KEY, email);
  } catch {
    // Private mode: the finish page asks for the email again.
  }
}

export function SignIn() {
  const { user, ready } = useSession();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (ready && user) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const clean = email.trim().toLowerCase();
      await sendSignInLinkToEmail(auth, clean, { url: `${window.location.origin}/finish-signin`, handleCodeInApp: true });
      remember(clean);
      setEmail(clean);
      setSent(true);
    } catch (err) {
      const code = (err as { code?: string }).code;
      setError(
        code === 'auth/invalid-email'
          ? 'That email address looks incomplete.'
          : code === 'auth/too-many-requests' || code === 'auth/quota-exceeded'
            ? 'Too many tries. Please wait a few minutes and try again.'
            : 'We could not send the link. Check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function openDevLink() {
    setError(null);
    const link = await latestEmulatorLink(email);
    if (!link) return setError('No sign-in link found in the auth emulator yet.');
    window.location.assign(`/finish-signin${new URL(link).search}`);
  }

  if (sent) {
    return (
      <AuthShell>
        <div className="sent-mark" aria-hidden="true">
          <EnvelopeSimple size={28} weight="bold" />
        </div>
        <h1>Check your inbox</h1>
        <p className="lede">
          We sent a sign-in link to <strong>{email}</strong>. Open it on this phone or computer to continue. It can take a minute,
          and sometimes lands in spam.
        </p>
        {useEmulators && (
          <button className="btn" onClick={openDevLink}>
            Dev: open the emulator link
          </button>
        )}
        <button className="btn btn-quiet" onClick={() => setSent(false)}>
          Use a different email
        </button>
        {error && <p className="form-error" role="alert">{error}</p>}
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1>Your lessons, in one place</h1>
      <p className="lede">Book, check and cancel lessons, and see your sessions and invoices.</p>
      <form onSubmit={submit} className="form">
        <label className="field">
          <span className="field-label">Email</span>
          <input
            type="email"
            required
            autoComplete="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <span className="field-help">Use the email you gave the studio. No password needed.</span>
        </label>
        <button className="btn btn-block" disabled={busy}>
          {busy ? 'Sending' : 'Email me a sign-in link'}
          {!busy && <ArrowRight size={18} weight="bold" aria-hidden="true" />}
        </button>
        {error && <p className="form-error" role="alert">{error}</p>}
      </form>
    </AuthShell>
  );
}
