import { CalendarBlank, MapPin, VideoCamera } from '@phosphor-icons/react';
import { useState } from 'react';
import type { CreditPolicy } from '@lessonkaki/shared';
import { call, errorMessage } from '../firebase';
import { dayLabel, relativeDay, timeLabel, timeRange } from '../format';
import type { MyLesson } from '../hooks';
import { downloadIcs } from '../ics';
import type { Profile } from '../types';

const cancelAttendance = call<{ schoolId: string; lessonId: string; studentId: string }, { status: string; late: boolean }>('cancelAttendance');

const HOUR_MS = 3_600_000;

export interface LessonContext {
  schoolId: string;
  studentId: string;
  timeZone: string;
  policy: CreditPolicy;
  profile: Profile | null;
}

const teacherName = (ctx: LessonContext, teacherId: string) => ctx.profile?.teachers?.[teacherId]?.name ?? null;

function Mode({ item, ctx }: { item: MyLesson; ctx: LessonContext }) {
  const teacher = teacherName(ctx, item.lesson.teacherId);
  const Icon = item.lesson.isOnline ? VideoCamera : MapPin;
  return (
    <span className="mode">
      <Icon size={16} weight="bold" aria-hidden="true" />
      {item.lesson.isOnline ? 'Online' : 'In person'}
      {teacher && <> with {teacher}</>}
    </span>
  );
}

/** Cancel, with a confirm step; inside the late window it says to contact the studio instead. */
function CancelControl({ item, ctx, tone }: { item: MyLesson; ctx: LessonContext; tone: 'light' | 'dark' }) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [error, setError] = useState<string | null>(null);
  const start = item.lesson.startAt.toDate();
  const late = start.getTime() - Date.now() < ctx.policy.lateCancelHours * HOUR_MS;

  if (late) {
    const email = ctx.profile?.contactEmail;
    return (
      <p className={`cancel-note ${tone}`}>
        {ctx.policy.lateCancelHours > 0 ? `Less than ${ctx.policy.lateCancelHours} hours to go.` : 'This lesson has started.'} To cancel,{' '}
        {email ? <a href={`mailto:${email}?subject=${encodeURIComponent(`Cancel my lesson on ${dayLabel(start, ctx.timeZone)}`)}`}>contact the studio</a> : 'contact the studio'}.
      </p>
    );
  }

  async function confirm() {
    setStep('busy');
    setError(null);
    try {
      await cancelAttendance({ schoolId: ctx.schoolId, lessonId: item.lesson.id, studentId: ctx.studentId });
      // The live query drops the lesson from the list; nothing else to do.
    } catch (err) {
      setError(errorMessage(err));
      setStep('confirm');
    }
  }

  if (step === 'idle') {
    return (
      <button className={`link-btn ${tone}`} onClick={() => setStep('confirm')}>
        Cancel lesson
      </button>
    );
  }
  return (
    <div className={`confirm ${tone}`} role="group" aria-label="Confirm cancel">
      <p>
        Cancel {dayLabel(start, ctx.timeZone)}, {timeLabel(start, ctx.timeZone)}? No session is used.
      </p>
      <div className="confirm-actions">
        <button className="btn btn-sm btn-quiet" onClick={() => setStep('idle')} disabled={step === 'busy'}>
          Keep it
        </button>
        <button className="btn btn-sm btn-danger" onClick={confirm} disabled={step === 'busy'}>
          {step === 'busy' ? 'Cancelling' : 'Yes, cancel'}
        </button>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}

function addToCalendar(item: MyLesson, ctx: LessonContext) {
  const teacher = teacherName(ctx, item.lesson.teacherId);
  downloadIcs({
    uid: `${item.lesson.id}@lessonkaki`,
    start: item.lesson.startAt.toDate(),
    end: item.lesson.endAt.toDate(),
    title: `${ctx.profile?.name ?? 'Lesson'}${teacher ? ` with ${teacher}` : ''}`,
    location: item.lesson.isOnline ? (item.lesson.meetingUrl ?? 'Online') : null,
  });
}

/** The next lesson, as the page's lead card. */
export function NextLesson({ item, ctx }: { item: MyLesson; ctx: LessonContext }) {
  const start = item.lesson.startAt.toDate();
  const end = item.lesson.endAt.toDate();
  return (
    <article className="next">
      <p className="next-label">Next lesson</p>
      <h2 className="next-day">{relativeDay(start, ctx.timeZone)}</h2>
      <p className="next-time">
        {relativeDay(start, ctx.timeZone) !== dayLabel(start, ctx.timeZone) && <>{dayLabel(start, ctx.timeZone)}, </>}
        {timeRange(start, end, ctx.timeZone)}
      </p>
      <Mode item={item} ctx={ctx} />
      {item.lesson.isOnline && item.lesson.meetingUrl && /^https:\/\//.test(item.lesson.meetingUrl) && (
        <a className="btn btn-sm next-join" href={item.lesson.meetingUrl} target="_blank" rel="noreferrer">
          Join online lesson
        </a>
      )}
      <div className="next-actions">
        <button className="btn btn-sm btn-on-dark" onClick={() => addToCalendar(item, ctx)}>
          <CalendarBlank size={18} weight="bold" aria-hidden="true" />
          Add to calendar
        </button>
        <CancelControl item={item} ctx={ctx} tone="dark" />
      </div>
    </article>
  );
}

/** A later upcoming lesson. */
export function UpcomingRow({ item, ctx }: { item: MyLesson; ctx: LessonContext }) {
  const start = item.lesson.startAt.toDate();
  const day = new Intl.DateTimeFormat('en-SG', { timeZone: ctx.timeZone, day: 'numeric' }).format(start);
  const month = new Intl.DateTimeFormat('en-SG', { timeZone: ctx.timeZone, month: 'short' }).format(start);
  return (
    <li className="row">
      <div className="datebox" aria-hidden="true">
        <span className="datebox-day">{day}</span>
        <span className="datebox-month">{month}</span>
      </div>
      <div className="row-main">
        <p className="row-title">
          {relativeDay(start, ctx.timeZone)}, {timeRange(start, item.lesson.endAt.toDate(), ctx.timeZone)}
        </p>
        <Mode item={item} ctx={ctx} />
        <div className="row-actions">
          <button className="link-btn light" onClick={() => addToCalendar(item, ctx)}>
            Add to calendar
          </button>
          <CancelControl item={item} ctx={ctx} tone="light" />
        </div>
      </div>
    </li>
  );
}

const PAST_LABEL: Record<string, { text: string; tone: 'ok' | 'muted' | 'warn' }> = {
  present: { text: 'Attended', tone: 'ok' },
  absent: { text: 'Missed', tone: 'warn' },
  cancelled: { text: 'Cancelled', tone: 'muted' },
  lateCancelled: { text: 'Late cancel', tone: 'warn' },
  booked: { text: 'Not marked yet', tone: 'muted' },
};

/** A past (or cancelled) lesson in the history list. */
export function HistoryRow({ item, ctx }: { item: MyLesson; ctx: LessonContext }) {
  const start = item.lesson.startAt.toDate();
  const label =
    item.lesson.status === 'cancelled'
      ? { text: 'Cancelled by studio', tone: 'muted' as const }
      : (PAST_LABEL[item.attendee?.status ?? 'booked'] ?? PAST_LABEL.booked!);
  return (
    <li className="hist">
      <span className="hist-when">
        {dayLabel(start, ctx.timeZone)} <span className="hist-time">{timeLabel(start, ctx.timeZone)}</span>
      </span>
      <span className="hist-tags">
        {item.attendee?.owed && <span className="tag tag-warn">To pay</span>}
        <span className={`tag tag-${label.tone}`}>{label.text}</span>
      </span>
    </li>
  );
}
