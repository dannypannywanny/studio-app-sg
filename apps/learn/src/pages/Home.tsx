import { ArrowRight } from '@phosphor-icons/react';
import { useMemo } from 'react';
import { Link } from 'react-router';
import { formatMoney } from '@lessonkaki/shared';
import { HistoryRow, NextLesson, UpcomingRow, type LessonContext } from '../components/LessonCard';
import { dayLabel, otherZone, zoneName } from '../format';
import { firstName, useEnrolments, useInvoices, useMyLessons, useProfile, useSchool, useStudent } from '../hooks';
import { useStudentIds } from '../session';

const HISTORY_SHOWN = 8;

function Skeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-hero" />
      <div className="skeleton skeleton-row" />
      <div className="skeleton skeleton-row" />
    </div>
  );
}

export function Home() {
  const { schoolId, studentId } = useStudentIds();
  const school = useSchool();
  const student = useStudent();
  const profile = useProfile(schoolId);
  const lessons = useMyLessons();
  const enrolments = useEnrolments();
  const invoices = useInvoices();
  const tz = school.timeZone;

  const { upcoming, history } = useMemo(() => {
    const now = Date.now();
    const upcoming = lessons.data.filter(
      (l) => l.lesson.status === 'scheduled' && l.lesson.endAt.toMillis() > now && l.attendee?.status === 'booked',
    );
    const history = lessons.data
      .filter((l) => l.lesson.startAt.toMillis() <= now && l.attendee?.status !== 'removed')
      .reverse()
      .slice(0, HISTORY_SHOWN);
    return { upcoming, history };
  }, [lessons.data]);

  if (school.loading || student.loading || lessons.loading) return <Skeleton />;
  if (lessons.error) {
    return (
      <div className="notice notice-warn" role="alert">
        We couldn't load your lessons. Refresh the page to try again.
      </div>
    );
  }

  const ctx: LessonContext = { schoolId, studentId, timeZone: tz, policy: school.policy, profile: profile.data };
  const summary = student.data?.summary ?? {};
  const sessionsLeft = summary.sessionsAvailable ?? 0;
  const owed = summary.sessionsOwed ?? 0;
  const unpaid = invoices.data.filter((i) => i.status === 'sent' || i.status === 'partial');
  const unpaidCents = unpaid.reduce((n, i) => n + i.pendingCents, 0);
  const [next, ...later] = upcoming;
  const abroad = otherZone(tz);
  const name = firstName(student.data);

  return (
    <div className="stack-lg">
      <header className="page-head">
        <h1>{name ? `Hi ${name}` : 'Your lessons'}</h1>
        {abroad && <p className="meta">Times are in {zoneName(tz)}.</p>}
      </header>

      {next ? (
        <NextLesson item={next} ctx={ctx} />
      ) : (
        <article className="empty">
          <h2>No lessons booked</h2>
          <p>Pick a time that suits you. It takes under a minute.</p>
          <Link className="btn" to="/book">
            Book a lesson
            <ArrowRight size={18} weight="bold" aria-hidden="true" />
          </Link>
        </article>
      )}

      <section aria-label="Your balance" className="balance">
        <div className="figure">
          <span className="figure-value">{sessionsLeft}</span>
          <span className="figure-label">{sessionsLeft === 1 ? 'session left' : 'sessions left'}</span>
        </div>
        {owed > 0 && (
          <div className="figure figure-warn">
            <span className="figure-value">{owed}</span>
            <span className="figure-label">{owed === 1 ? 'lesson to pay for' : 'lessons to pay for'}</span>
          </div>
        )}
        {unpaidCents > 0 && (
          <Link to="/payments" className="figure figure-link">
            <span className="figure-value">{formatMoney(unpaidCents, school.currency)}</span>
            <span className="figure-label">unpaid</span>
          </Link>
        )}
      </section>
      {owed > 0 && (
        <p className="meta">
          Lessons to pay for were taken with no sessions left. Your next package covers them automatically.
        </p>
      )}

      {next && (
        <section className="section">
          <div className="section-head">
            <h2>Coming up</h2>
            <Link className="text-link" to="/book">
              Book another
            </Link>
          </div>
          {later.length ? (
            <ul className="rows">
              {later.map((item) => (
                <UpcomingRow key={item.lesson.id} item={item} ctx={ctx} />
              ))}
            </ul>
          ) : (
            <p className="meta">Nothing else booked yet.</p>
          )}
        </section>
      )}

      {enrolments.data.length > 0 && (
        <section className="section">
          <h2>Your packages</h2>
          <ul className="packages">
            {enrolments.data.map((e) => (
              <li key={e.id}>
                <span className="pkg-name">{e.packageName}</span>
                <span className="pkg-left">
                  {e.sessionsRemaining} of {e.sessionsTotal} left
                </span>
                <span className="pkg-until">
                  {e.validUntil.toDate().getUTCFullYear() >= 9999 ? 'No expiry' : `Use by ${dayLabel(e.validUntil.toDate(), tz)}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {history.length > 0 && (
        <section className="section">
          <h2>Recent lessons</h2>
          <ul className="hist-list">
            {history.map((item) => (
              <HistoryRow key={item.lesson.id} item={item} ctx={ctx} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
