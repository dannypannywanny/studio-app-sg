import { ArrowRight, CalendarBlank, CheckCircle, MapPin, VideoCamera } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { wallDateOf, type LessonMode } from '@lessonkaki/shared';
import { call, errorMessage } from '../firebase';
import { dayLabel, longDayLabel, otherZone, timeLabel, timeRange, zoneName } from '../format';
import { useProfile, useStudent } from '../hooks';
import { downloadIcs } from '../ics';
import { useStudentIds } from '../session';
import type { AvailabilityResult, BookLessonInput } from '../types';

const getAvailability = call<{ schoolId: string }, AvailabilityResult>('getAvailability');
const bookLesson = call<BookLessonInput, { lessonId: string; existing: boolean }>('bookLesson');

type Slot = AvailabilityResult['slots'][number];

interface Booked {
  lessonId: string;
  start: Date;
  end: Date;
  mode: LessonMode;
  teacher: string;
}

const MODE_LABEL: Record<LessonMode, string> = { inPerson: 'In person', online: 'Online' };

function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Book() {
  const { schoolId } = useStudentIds();
  const profile = useProfile(schoolId);
  const student = useStudent();
  const [data, setData] = useState<AvailabilityResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [teacherId, setTeacherId] = useState<string | null>(null);
  const [mode, setMode] = useState<LessonMode | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [booked, setBooked] = useState<Booked | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setData(await getAvailability({ schoolId }));
    } catch (err) {
      setLoadError(errorMessage(err));
    }
  }, [schoolId]);

  useEffect(() => {
    void load();
  }, [load]);

  const tz = data?.timeZone ?? 'Asia/Singapore';
  const teacher = data?.teachers.find((t) => t.teacherId === teacherId) ?? data?.teachers[0] ?? null;
  const modes = (['inPerson', 'online'] as const).filter((m) => teacher?.[m]);
  const activeMode: LessonMode | null = mode && modes.includes(mode as never) ? mode : (modes[0] ?? null);

  const slots = useMemo(
    () => (data && teacher && activeMode ? data.slots.filter((s) => s.teacherId === teacher.teacherId && s[activeMode]) : []),
    [data, teacher, activeMode],
  );
  const days = useMemo(() => {
    const byDay = new Map<string, Slot[]>();
    for (const s of slots) {
      const key = wallDateOf(new Date(s.startAt), tz);
      byDay.set(key, [...(byDay.get(key) ?? []), s]);
    }
    return byDay;
  }, [slots, tz]);
  const activeDay = day && days.has(day) ? day : ([...days.keys()][0] ?? null);
  const times = activeDay ? (days.get(activeDay) ?? []) : [];

  async function confirm() {
    if (!slot || !teacher || !activeMode) return;
    setBusy(true);
    setError(null);
    try {
      const res = await bookLesson({ schoolId, teacherId: teacher.teacherId, startAt: slot.startAt, mode: activeMode });
      const start = new Date(slot.startAt);
      setBooked({ lessonId: res.lessonId, start, end: new Date(start.getTime() + teacher.lessonMin * 60_000), mode: activeMode, teacher: teacher.name });
      setSlot(null);
      void load();
    } catch (err) {
      setError(errorMessage(err));
      setSlot(null);
      void load(); // the time may have just gone; show what's open now
    } finally {
      setBusy(false);
    }
  }

  if (booked) {
    return (
      <div className="done">
        <CheckCircle className="done-mark" size={56} weight="fill" aria-hidden="true" />
        <h1>You're booked</h1>
        <p className="done-when">
          {longDayLabel(booked.start, tz)}
          <br />
          {timeRange(booked.start, booked.end, tz)}
        </p>
        <p className="meta">
          {MODE_LABEL[booked.mode]} with {booked.teacher}. The studio has been told.
        </p>
        <div className="done-actions">
          <button
            className="btn btn-quiet"
            onClick={() =>
              downloadIcs({
                uid: `${booked.lessonId}@lessonkaki`,
                start: booked.start,
                end: booked.end,
                title: `${profile.data?.name ?? 'Lesson'} with ${booked.teacher}`,
                location: booked.mode === 'online' ? 'Online' : null,
              })
            }
          >
            <CalendarBlank size={18} weight="bold" aria-hidden="true" />
            Add to calendar
          </button>
          <Link className="btn" to="/">
            Done
          </Link>
        </div>
        <button className="link-btn light" onClick={() => setBooked(null)}>
          Book another lesson
        </button>
      </div>
    );
  }

  const header = (
    <header className="page-head">
      <h1>Book a lesson</h1>
      {teacher && (
        <p className="lede">
          {teacher.lessonMin} minutes, one-on-one{data && data.teachers.length === 1 ? ` with ${teacher.name}` : ''}.
        </p>
      )}
    </header>
  );

  if (loadError) {
    return (
      <div className="stack-lg">
        {header}
        <div className="notice notice-warn" role="alert">
          <p>{loadError}</p>
          <button className="btn btn-sm btn-quiet" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="stack-lg" aria-busy="true" aria-label="Loading times">
        {header}
        <div className="skeleton skeleton-strip" />
        <div className="skeleton skeleton-grid" />
      </div>
    );
  }

  const full = data.upcoming?.max != null && data.upcoming.booked >= data.upcoming.max;
  const sessionsLeft = student.data?.summary?.sessionsAvailable ?? 0;
  const abroad = otherZone(tz);
  const contact = profile.data?.contactEmail;

  return (
    <div className="stack-lg book">
      {header}

      {error && (
        <div className="notice notice-warn" role="alert">
          {error}
        </div>
      )}

      {!teacher ? (
        <article className="empty">
          <h2>Online booking isn't open yet</h2>
          <p>{contact ? <>Email <a href={`mailto:${contact}`}>{contact}</a> to book a lesson.</> : 'Please contact the studio to book.'}</p>
        </article>
      ) : full ? (
        <article className="empty">
          <h2>You have {data.upcoming!.booked} lessons booked</h2>
          <p>
            That's the most you can book here at once. Once one has passed you can book the next
            {contact ? <>, or email <a href={`mailto:${contact}`}>{contact}</a> to book more now</> : ''}.
          </p>
          <Link className="btn btn-quiet" to="/">
            See your lessons
          </Link>
        </article>
      ) : (
        <>
          <div className="choices">
            {data.teachers.length > 1 && (
              <Segmented
                label="Teacher"
                options={data.teachers.map((t) => ({ value: t.teacherId, label: t.name }))}
                value={teacher.teacherId}
                onChange={(v) => {
                  setTeacherId(v);
                  setSlot(null);
                }}
              />
            )}
            {modes.length > 1 && activeMode && (
              <Segmented
                label="Where"
                options={modes.map((m) => ({ value: m, label: MODE_LABEL[m] }))}
                value={activeMode}
                onChange={(v) => {
                  setMode(v);
                  setSlot(null);
                }}
              />
            )}
            {modes.length === 1 && activeMode && (
              <p className="mode">
                {activeMode === 'online' ? <VideoCamera size={16} weight="bold" aria-hidden="true" /> : <MapPin size={16} weight="bold" aria-hidden="true" />}
                {MODE_LABEL[activeMode]} lessons
              </p>
            )}
          </div>

          {days.size === 0 ? (
            <article className="empty">
              <h2>No open times right now</h2>
              <p>
                Everything in the next few weeks is taken
                {modes.length > 1 ? `. Try ${activeMode === 'online' ? 'in person' : 'online'}` : ''}
                {contact ? <>, or email <a href={`mailto:${contact}`}>{contact}</a></> : ''}.
              </p>
            </article>
          ) : (
            <>
              <section aria-label="Day">
                <div className="daystrip" role="radiogroup" aria-label="Day">
                  {[...days.entries()].map(([key, list]) => {
                    const d = new Date(list[0]!.startAt);
                    const parts = new Intl.DateTimeFormat('en-SG', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(d);
                    const part = (t: string) => parts.find((p) => p.type === t)?.value;
                    return (
                      <button
                        key={key}
                        type="button"
                        role="radio"
                        aria-checked={key === activeDay}
                        aria-label={`${dayLabel(d, tz)}, ${list.length} ${list.length === 1 ? 'time' : 'times'}`}
                        onClick={() => {
                          setDay(key);
                          setSlot(null);
                        }}
                      >
                        <span className="ds-week">{part('weekday')}</span>
                        <span className="ds-day">{part('day')}</span>
                        <span className="ds-month">{part('month')}</span>
                      </button>
                    );
                  })}
                </div>
              </section>

              <section aria-label="Time">
                <h2 className="times-head">{activeDay && longDayLabel(new Date(times[0]!.startAt), tz)}</h2>
                <div className="times" role="radiogroup" aria-label="Start time">
                  {times.map((s) => (
                    <button
                      key={s.startAt}
                      type="button"
                      role="radio"
                      aria-checked={slot?.startAt === s.startAt}
                      onClick={() => {
                        setError(null);
                        setSlot(s);
                      }}
                    >
                      {timeLabel(new Date(s.startAt), tz)}
                    </button>
                  ))}
                </div>
                {abroad && <p className="meta">Times are in {zoneName(tz)}.</p>}
              </section>
            </>
          )}
        </>
      )}

      {slot && teacher && activeMode && (
        <div className="confirm-bar" role="region" aria-label="Confirm booking">
          <div className="wrap confirm-bar-inner">
            <div>
              <p className="cb-when">
                {dayLabel(new Date(slot.startAt), tz)}, {timeRange(new Date(slot.startAt), new Date(Date.parse(slot.startAt) + teacher.lessonMin * 60_000), tz)}
              </p>
              <p className="cb-meta">
                {MODE_LABEL[activeMode]} with {teacher.name}
                {sessionsLeft > 0 ? '. Uses 1 session once the lesson is marked.' : '. No sessions left? Book anyway, the studio will invoice you.'}
              </p>
            </div>
            <button className="btn" onClick={confirm} disabled={busy}>
              {busy ? 'Booking' : 'Confirm'}
              {!busy && <ArrowRight size={18} weight="bold" aria-hidden="true" />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
