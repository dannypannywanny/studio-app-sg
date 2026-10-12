import { isSignInWithEmailLink, signInWithEmailLink, type MultiFactorResolver } from 'firebase/auth';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { resolveActionLink } from '@lessonkaki/shared';
import { auth } from '../firebase';
import { EMAIL_KEY } from './SignIn';
import { SecondFactorPrompt, secondFactorResolver } from './TwoStep';

export function FinishSignIn() {
  const navigate = useNavigate();
  // Auth's email action URL is this page: fill in the apiKey if the link lacks it, and hand other
  // email actions (e.g. reverting a second factor) to Firebase's own handler.
  const { apiKey = '', authDomain = '' } = auth.app.options;
  const link = resolveActionLink(window.location.href, apiKey, authDomain);
  const href = link.kind === 'signIn' ? link.href : window.location.href;
  const valid = link.kind === 'signIn' && isSignInWithEmailLink(auth, href);
  const [email, setEmail] = useState(() => window.localStorage.getItem(EMAIL_KEY) ?? '');
  const [needEmail, setNeedEmail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolver, setResolver] = useState<MultiFactorResolver | null>(null);
  const started = useRef(false); // the link's code works once; StrictMode runs effects twice in dev

  async function finish(withEmail: string) {
    try {
      await signInWithEmailLink(auth, withEmail, href);
      window.localStorage.removeItem(EMAIL_KEY);
      navigate('/', { replace: true });
    } catch (err) {
      // Staff with two-step sign-in: the link was good, now the authenticator code.
      const mfa = secondFactorResolver(err);
      if (mfa) {
        window.localStorage.removeItem(EMAIL_KEY);
        return setResolver(mfa);
      }
      setError((err as Error).message);
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

  if (link.kind === 'firebase') return <p className="page-status">Opening…</p>;

  if (!valid) {
    return (
      <div className="auth-card">
        <h1>That link didn't work</h1>
        <p>It may have expired or already been used.</p>
        <Link className="btn btn-primary" to="/sign-in">
          Get a new link
        </Link>
      </div>
    );
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void finish(email.trim().toLowerCase());
  }

  if (resolver) {
    return (
      <div className="auth-card">
        <h1>Two-step sign-in</h1>
        <SecondFactorPrompt resolver={resolver} onDone={() => navigate('/', { replace: true })} />
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h1>Signing you in…</h1>
      {needEmail && (
        <form onSubmit={submit} className="stack">
          <p>Confirm the email address you asked for the link with.</p>
          <label className="field">
            <span>Email</span>
            <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button className="btn btn-primary">Continue</button>
        </form>
      )}
      {error && (
        <p className="error">
          {error} <Link to="/sign-in">Get a new link</Link>
        </p>
      )}
    </div>
  );
}
