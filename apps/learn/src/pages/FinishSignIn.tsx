import { isSignInWithEmailLink, signInWithEmailLink } from 'firebase/auth';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { resolveActionLink } from '@lessonkaki/shared';
import { AuthShell } from '../components/AuthShell';
import { auth } from '../firebase';
import { EMAIL_KEY } from './SignIn';

const stored = () => {
  try {
    return window.localStorage.getItem(EMAIL_KEY) ?? '';
  } catch {
    return '';
  }
};
const forget = () => {
  try {
    window.localStorage.removeItem(EMAIL_KEY);
  } catch {
    // nothing stored
  }
};

function signInError(code: string | undefined): string {
  switch (code) {
    // Self sign-up is off: only emails the studio has invited can sign in.
    case 'auth/admin-restricted-operation':
      return "This email isn't set up for the student portal yet. Ask the studio to add you, then try again.";
    case 'auth/invalid-email':
      return "That email doesn't match the one the link was sent to.";
    case 'auth/invalid-action-code':
    case 'auth/expired-action-code':
      return 'This link has expired or was already used.';
    default:
      return 'Something went wrong signing you in.';
  }
}

export function FinishSignIn() {
  const navigate = useNavigate();
  const { apiKey = '', authDomain = '' } = auth.app.options;
  const link = resolveActionLink(window.location.href, apiKey, authDomain);
  const href = link.kind === 'signIn' ? link.href : window.location.href;
  const valid = link.kind === 'signIn' && isSignInWithEmailLink(auth, href);
  const [email, setEmail] = useState(stored);
  const [needEmail, setNeedEmail] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false); // the link's code works once; StrictMode runs effects twice in dev

  async function finish(withEmail: string) {
    setBusy(true);
    setError(null);
    try {
      await signInWithEmailLink(auth, withEmail, href);
      forget();
      navigate('/', { replace: true });
    } catch (err) {
      setError(signInError((err as { code?: string }).code));
      setBusy(false);
    }
  }

  useEffect(() => {
    if (link.kind === 'firebase') return window.location.replace(link.href);
    if (!valid || started.current) return;
    started.current = true;
    if (email) void finish(email);
    else setNeedEmail(true); // opened on a different device or browser
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (link.kind === 'firebase') return <div className="boot" aria-busy="true" />;

  if (!valid) {
    return (
      <AuthShell>
        <h1>That link didn't work</h1>
        <p className="lede">It may have expired or already been used. Links work once, for an hour.</p>
        <Link className="btn btn-block" to="/sign-in">
          Get a new link
        </Link>
      </AuthShell>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void finish(email.trim().toLowerCase());
  }

  return (
    <AuthShell>
      <h1>{needEmail ? 'Confirm your email' : 'Signing you in'}</h1>
      {needEmail ? (
        <form onSubmit={submit} className="form">
          <p className="lede">You opened the link on a different device. Type the email you asked for it with.</p>
          <label className="field">
            <span className="field-label">Email</span>
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button className="btn btn-block" disabled={busy}>
            {busy ? 'Signing in' : 'Continue'}
          </button>
        </form>
      ) : (
        !error && <div className="skeleton-line" aria-busy="true" />
      )}
      {error && (
        <div className="form-error" role="alert">
          <p>{error}</p>
          <Link to="/sign-in">Get a new link</Link>
        </div>
      )}
    </AuthShell>
  );
}
