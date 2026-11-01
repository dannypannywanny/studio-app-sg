// Student portal (learn site) access for one student: creates their login with student claims and emails
// them how to sign in (on the learn site, with this email).
import { useState } from 'react';
import { call } from '../firebase';
import { useSchool } from '../hooks';
import { useSchoolId, useSession } from '../session';

export type Outcome = 'invited' | 'already' | 'notFound' | 'archived' | 'lead' | 'noEmail' | 'sharedEmail' | 'staffAccount' | 'linkedElsewhere';

export const inviteStudents = call<{ schoolId: string; studentIds: string[]; welcome?: boolean }, { results: { studentId: string; outcome: Outcome; welcomed?: boolean }[] }>('inviteStudents');

export const MESSAGE: Record<Outcome, string> = {
  invited: 'Done. They can sign in now with this email.',
  already: 'They already have access.',
  notFound: 'Student not found.',
  archived: 'Archived students cannot sign in.',
  lead: 'Leads cannot sign in. Make them a student first.',
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
      const { results } = await inviteStudents({ schoolId, studentIds: [studentId], welcome: true });
      const outcome = results[0]?.outcome ?? 'notFound';
      const text =
        outcome === 'invited' ? (results[0]?.welcomed ? 'Done. We emailed them how to sign in.' : `${MESSAGE.invited} The welcome email could not be sent: tell them to sign in at the student site.`) : MESSAGE[outcome];
      setMessage({ ok: outcome === 'invited' || outcome === 'already', text });
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
          : 'No portal login yet. Giving access emails the student how to sign in.'}
      </p>
      {message && <p className={message.ok ? 'success' : 'error'}>{message.text}</p>}
    </div>
  );
}
