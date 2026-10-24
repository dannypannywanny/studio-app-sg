// A lead's page: where they are (stage), when to follow up, their trial lessons, and the way out:
// make them a student, or mark them lost with a reason.
import { collection, deleteField, doc, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { useState } from 'react';
import { formatDateTime, LEAD_STAGE_LABEL } from '@lessonkaki/shared';
import { db } from '../firebase';
import { useQuery, useTimeZone } from '../hooks';
import { useSchoolId } from '../session';
import type { Lesson, Student } from '../types';
import { isLessonCancelled } from '../types';
import { LessonForm } from './LessonForm';
import { useLessonHref } from './LessonSheet';
import { Link } from 'react-router';

export function LeadPanel({ studentId, student }: { studentId: string; student: Student }) {
  const schoolId = useSchoolId();
  const tz = useTimeZone();
  const lessonHref = useLessonHref();
  const lead = student.lead ?? { stage: 'new' as const };
  const isLead = student.status === 'lead';
  const [booking, setBooking] = useState(false);
  const [losing, setLosing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trials = useQuery<Lesson>(`trials:${studentId}`, () =>
    query(collection(db, 'schools', schoolId, 'lessons'), where('trialStudentIds', 'array-contains', studentId)),
  );
  const sorted = [...trials.data].sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis());

  async function save(update: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      await updateDoc(doc(db, 'schools', schoolId, 'students', studentId), { ...update, updatedAt: serverTimestamp() });
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const makeStudent = () =>
    save({ status: 'active', 'lead.stage': 'won', 'lead.followUpOn': null, 'lead.closedAt': serverTimestamp() });
  const markLost = async () => {
    if (await save({ 'lead.stage': 'lost', 'lead.lostReason': reason.trim() || null, 'lead.followUpOn': null, 'lead.closedAt': serverTimestamp() })) {
      setLosing(false);
      setReason('');
    }
  };
  const reopen = () => save({ 'lead.stage': sorted.length ? 'trial' : 'new', 'lead.lostReason': deleteField(), 'lead.closedAt': null });

  // A won lead is a student now: just note where they came from.
  if (!isLead) {
    return (
      <p className="muted">
        Was a lead{lead.closedAt ? `; became a student ${formatDateTime(lead.closedAt.toDate(), tz)}` : ''}.
      </p>
    );
  }

  return (
    <div className="card stack">
      <div className="page-head">
        <h2>
          Lead <span className={`badge badge-${lead.stage}`}>{LEAD_STAGE_LABEL[lead.stage]}</span>
        </h2>
        {lead.stage !== 'lost' && !booking && (
          <div className="row">
            <button className="btn" onClick={() => setBooking(true)}>
              Book trial lesson
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={() => void makeStudent()}>
              Make student
            </button>
          </div>
        )}
      </div>
      <p className="muted">
        Leads have no portal login and aren't counted as students. A trial is free unless they have a package for it.
      </p>
      {booking && <LessonForm trialFor={studentId} onDone={() => setBooking(false)} />}

      {sorted.length > 0 && (
        <ul className="plain-list">
          {sorted.map((l) => (
            <li key={l.id}>
              <Link to={lessonHref(l.id)}>Trial · {formatDateTime(l.startAt.toDate(), tz)}</Link>
              <span className="muted"> · {l.durationMin} min</span>
              {isLessonCancelled(l) && <span className="badge badge-cancelled">Cancelled</span>}
            </li>
          ))}
        </ul>
      )}

      {lead.stage === 'lost' ? (
        <div className="row">
          <span>Lost{lead.lostReason ? `: ${lead.lostReason}` : ''}</span>
          <button className="btn btn-sm" disabled={busy} onClick={() => void reopen()}>
            Reopen
          </button>
        </div>
      ) : (
        <div className="row">
          <label className="field">
            <span>Follow up on</span>
            <input
              type="date"
              value={lead.followUpOn ?? ''}
              disabled={busy}
              onChange={(e) => void save({ 'lead.followUpOn': e.target.value || null })}
            />
          </label>
          {losing ? (
            <div className="inline-confirm">
              <label className="field">
                <span>Why didn't they join? (optional)</span>
                <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Price, timing, went elsewhere…" />
              </label>
              <div className="row">
                <button className="btn btn-sm" disabled={busy} onClick={() => void markLost()}>
                  Mark as lost
                </button>
                <button className="btn btn-sm btn-ghost" onClick={() => setLosing(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button className="btn btn-sm btn-ghost" onClick={() => setLosing(true)}>
              Didn't join…
            </button>
          )}
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
