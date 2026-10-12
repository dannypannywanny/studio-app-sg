// S12 Staff and roles. Roles live in custom claims, set only by the setMemberRole function (owner only);
// members/{uid} mirrors them so this page can list them.
import { addDoc, collection, doc, query, serverTimestamp, updateDoc } from 'firebase/firestore';
import { useState, type FormEvent } from 'react';
import type { Role } from '@lessonkaki/shared';
import { call, db } from '../firebase';
import { useQuery, useTeachers } from '../hooks';
import { useSchoolId, useSession } from '../session';

interface Member {
  role: Role;
  email: string | null;
  teacherId: string | null;
  active: boolean;
}

const setMemberRole = call<
  { schoolId: string; uid?: string; email?: string; role: Role; teacherId?: string | null },
  { uid: string }
>('setMemberRole');
const resetSecondFactor = call<{ schoolId: string; uid: string }, { ok: true }>('resetSecondFactor');

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', teacher: 'Teacher', student: 'Student' };
const ROLE_HELP: Record<'admin' | 'teacher', string> = {
  admin: 'Runs the studio: students, lessons, invoices, payments. Cannot change roles or school settings.',
  teacher: 'Sees and marks their own lessons (teacher logins arrive in M6).',
};

function Invite({ onDone }: { onDone: (msg: string) => void }) {
  const schoolId = useSchoolId();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'admin' | 'teacher'>('teacher');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const clean = email.trim().toLowerCase();
      let teacherId: string | null = null;
      if (role === 'teacher') {
        const ref = await addDoc(collection(db, 'schools', schoolId, 'teachers'), {
          displayName: displayName.trim(),
          email: clean,
          subjectIds: [],
          payRateCents: null,
          active: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        teacherId = ref.id;
      }
      await setMemberRole({ schoolId, email: clean, role, teacherId });
      onDone(`${clean} added as ${ROLE_LABEL[role].toLowerCase()}. They sign in with an email link at this address.`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form className="card form-grid" onSubmit={submit}>
      <label className="field">
        <span>Email</span>
        <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="field">
        <span>Role</span>
        <select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'teacher')}>
          <option value="teacher">Teacher</option>
          <option value="admin">Admin</option>
        </select>
      </label>
      {role === 'teacher' && (
        <label className="field">
          <span>Name shown on lessons</span>
          <input required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
      )}
      <p className="muted span-all">{ROLE_HELP[role]}</p>
      <div className="form-actions">
        <button className="btn btn-primary" disabled={busy}>
          {busy ? 'Adding…' : 'Add staff member'}
        </button>
        {error && <p className="error">{error}</p>}
      </div>
    </form>
  );
}

export function Staff() {
  const schoolId = useSchoolId();
  const { role: myRole, user } = useSession();
  const isOwner = myRole === 'owner';
  const members = useQuery<Member>(`members:${schoolId}`, () => query(collection(db, 'schools', schoolId, 'members')));
  const teachers = useTeachers();
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const staff = members.data.filter((m) => m.role !== 'student').sort((a, b) => (a.email ?? '').localeCompare(b.email ?? ''));

  async function changeRole(m: Member & { id: string }, role: Role) {
    setError(null);
    try {
      let teacherId = m.teacherId;
      if (role === 'teacher' && !teacherId) {
        const ref = await addDoc(collection(db, 'schools', schoolId, 'teachers'), {
          displayName: m.email ?? 'Teacher',
          email: m.email,
          subjectIds: [],
          active: true,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        teacherId = ref.id;
      }
      await setMemberRole({ schoolId, uid: m.id, role, teacherId });
      setNotice(`${m.email} is now ${ROLE_LABEL[role].toLowerCase()}. It applies the next time they sign in.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function resetTwoStep(m: Member & { id: string }) {
    if (!window.confirm(`Reset two-step sign-in for ${m.email}? They are signed out and set it up again on their next sign-in.`)) return;
    setError(null);
    try {
      await resetSecondFactor({ schoolId, uid: m.id });
      setNotice(`Two-step sign-in reset for ${m.email}.`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const toggleTeacher = (id: string, active: boolean) =>
    updateDoc(doc(db, 'schools', schoolId, 'teachers', id), { active, updatedAt: serverTimestamp() });

  return (
    <section className="stack">
      <div className="page-head">
        <h1>Staff and roles</h1>
        {isOwner && !inviting && (
          <button className="btn btn-primary" onClick={() => setInviting(true)}>
            Add staff member
          </button>
        )}
      </div>
      {!isOwner && <p className="muted">Only the owner can add staff or change roles.</p>}
      {inviting && (
        <Invite
          onDone={(msg) => {
            setInviting(false);
            setNotice(msg);
          }}
        />
      )}
      {notice && <p className="success" role="status">{notice}</p>}
      {error && <p className="error">{error}</p>}

      <div className="card stack">
        <h2>Logins</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Role</th>
              <th>Teacher profile</th>
              {isOwner && <th>Two-step sign-in</th>}
            </tr>
          </thead>
          <tbody>
            {staff.map((m) => (
              <tr key={m.id}>
                <td>{m.email ?? m.id}</td>
                <td>
                  {isOwner && m.id !== user?.uid ? (
                    <select value={m.role} onChange={(e) => void changeRole(m, e.target.value as Role)} aria-label={`Role for ${m.email}`}>
                      {(['owner', 'admin', 'teacher'] as Role[]).map((r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    ROLE_LABEL[m.role]
                  )}
                </td>
                <td>{m.teacherId ? (teachers.byId.get(m.teacherId)?.displayName ?? '—') : '—'}</td>
                {isOwner && (
                  <td>
                    {m.id !== user?.uid && (
                      <button className="btn btn-sm btn-ghost" onClick={() => void resetTwoStep(m)}>
                        Reset (lost phone)
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card stack">
        <h2>Teachers</h2>
        <p className="muted">Everyone who can be put on a lesson. A teacher doesn't need a login yet.</p>
        <table className="table">
          <tbody>
            {teachers.data.map((t) => (
              <tr key={t.id} className={t.active === false ? 'cancelled' : ''}>
                <td>{t.displayName}</td>
                <td>{t.email ?? '—'}</td>
                <td>
                  <button className="btn btn-sm btn-ghost" onClick={() => void toggleTeacher(t.id, t.active === false)}>
                    {t.active === false ? 'Reactivate' : 'Deactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
