// Student portal (learn site) access for one student: creates their login with student claims. Sends
// no email: the student signs in on the learn site with this email and gets Firebase's link.
import { useState } from 'react';
import { call } from '../firebase';
import { useSchool } from '../hooks';
import { useSchoolId, useSession } from '../session';

type Outcome = 'invited' | 'already' | 'notFound' | 'archived' | 'noEmail' | 'sharedEmail' | 'staffAccount' | 'linkedElsewhere';

const inviteStudents = call<{ schoolId: string; studentIds: string[] }, { results: { studentId: string; outcome: Outcome }[] }>('inviteStudents');

const MESSAGE: Record<Outcome, string> = {
  invited: 'Done. They can sign in now with this email.',
  already: 'They already have access.',
  notFound: 'Student not found.',
  archived: 'Archived students cannot sign in.',
  noEmail: 'Add an email address first.',
  sharedEmail: 'Another student has the same email. Give each student their own address, then try again.',
  staffAccount: 'This email is a staff login. Use a different address for the student.',
  linkedElsewhere: 'This email already signs in as another student. Check which student it belongs to.',
};

export function PortalAccess({ studentId, hasLogin, hasEmail }: { studentId: string; hasLogin: boolean; hasEmail: boolean }) {
  const schoolId = useSchoolId();
  const { role } = useSession();
  const school = useSchool();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const learnHost = (school.data as { hosts?: { learn?: string | null } } | null)?.hosts?.learn ?? null;

  async function give() {
    setBusy(true);
    setMessage(null);
    try {
      const { results } = await inviteStudents({ schoolId, studentIds: [studentId] });
      const outcome = results[0]?.outcome ?? 'notFound';
      setMessage({ ok: outcome === 'invited' || outcome === 'already', text: MESSAGE[outcome] });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <div className="page-head">
        <h2>Student portal</h2>
        {role === 'owner' && !hasLogin && (
          <button className="btn" onClick={give} disabled={busy || !hasEmail}>
            {busy ? 'Setting up…' : 'Give portal access'}
          </button>
        )}
      </div>
      <p className="muted">
        {hasLogin
          ? `Can sign in${learnHost ? ` at ${learnHost}` : ''} to book, cancel and see their lessons and invoices.`
          : 'No portal login yet. Giving access sends no email; tell the student to sign in with this email.'}
      </p>
      {message && <p className={message.ok ? 'success' : 'error'}>{message.text}</p>}
    </div>
  );
}
