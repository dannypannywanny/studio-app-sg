// S02 Calendar: day, week (Monday to Sunday) or month, in the school's time zone. The view and date live in
// the URL (?view=month&date=2026-10-13); each person's last view is remembered on their device.
import { collection, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { WEEKDAYS, addDays, startOfWeek, wallClockToUtc, wallDateOf, wallTimeOf, weekdayOf } from '@lessonkaki/shared';
import { DAY_LABEL, LessonForm } from '../components/LessonForm';
import { useLessonHref } from '../components/LessonSheet';
import { useRooms } from '../components/Rooms';
import { TimeOffDetail, TimeOffForm, offEndMin, offLabel, offStartMin, useTimeOff, type PlacedOff } from '../components/TimeOff';
import { db } from '../firebase';
import { studentName, useQuery, useStudents, useTeachers, useTimeZone, type WithId } from '../hooks';
import { useSchoolId, useSession } from '../session';
import type { Lesson } from '../types';

type View = 'day' | 'week' | 'month';
const VIEWS: [View, string][] = [
  ['day', 'Day'],
  ['week', 'Week'],
  ['month', 'Month'],
];
const isView = (v: string | null): v is View => v === 'day' || v === 'week' || v === 'month';
const isDate = (d: string | null): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);

const HOUR_PX = 48;
const DEFAULT_FIRST_HOUR = 8;
const DEFAULT_LAST_HOUR = 22;
const MONTH_CELL_MAX = 4;

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const monthStart = (date: string) => `${date.slice(0, 7)}-01`;
function addMonths(date: string, n: number) {
  const d = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1 + n, 1));
  return d.toISOString().slice(0, 10);
}

/** First day shown and the first day after the range, for a view around `date`. */
function rangeOf(view: View, date: string) {
  if (view === 'day') return { from: date, to: addDays(date, 1) };
  if (view === 'week') {
    const monday = startOfWeek(date);
    return { from: monday, to: addDays(monday, 7) };
  }
  const first = monthStart(date);
  const lastDay = addDays(addMonths(first, 1), -1);
  return { from: startOfWeek(first), to: addDays(startOfWeek(lastDay), 7) };
}

function titleOf(view: View, date: string, tz: string) {
  const at = (d: string) => wallClockToUtc(d, '12:00', tz);
  const f = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-SG', { timeZone: tz, ...opts });
  if (view === 'day') return f({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(at(date));
  if (view === 'month') return f({ month: 'long', year: 'numeric' }).format(at(date));
  const monday = startOfWeek(date);
  const short = f({ day: 'numeric', month: 'short' });
  return `${short.format(at(monday))} – ${short.format(at(addDays(monday, 6)))} ${f({ year: 'numeric' }).format(at(monday))}`;
}

type Placed = { l: WithId<Lesson>; date: string; time: string; startMin: number; names: string };
const stateOf = (l: Lesson) => (l.status === 'cancelled' ? 'cancelled' : l.attendanceState);

function readPref(key: string) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // Private mode or blocked storage: the view just isn't remembered.
  }
}

export function Calendar() {
  const schoolId = useSchoolId();
  const { user } = useSession();
  const tz = useTimeZone();
  const today = wallDateOf(new Date(), tz);
  const prefKey = `lk.calendarView.${user?.uid ?? 'anon'}`;
  const [params, setParams] = useSearchParams();
  const fromUrl = params.get('view');
  const saved = readPref(prefKey);
  const view: View = isView(fromUrl) ? fromUrl : isView(saved) ? saved : 'week';
  const urlDate = params.get('date');
  const date = isDate(urlDate) ? urlDate : today;
  const [teacherFilter, setTeacherFilter] = useState('');
  const [roomFilter, setRoomFilter] = useState('');
  const places = useRooms();
  const [adding, setAdding] = useState<string | null>(null);
  const [blocking, setBlocking] = useState<string | null>(null);
  const [openOff, setOpenOff] = useState<PlacedOff | null>(null);
  const allOff = useTimeOff();
  const offs = allOff.filter((o) => !teacherFilter || o.teacherId === teacherFilter);
  const students = useStudents();
  const teachers = useTeachers();
  const lessonHref = useLessonHref();

  useEffect(() => {
    try {
      localStorage.setItem(prefKey, view);
    } catch {
      // See readPref.
    }
  }, [prefKey, view]);

  const go = (next: { view?: View; date?: string }) =>
    setParams((p) => {
      const q = new URLSearchParams(p);
      q.set('view', next.view ?? view);
      q.set('date', next.date ?? date);
      return q;
    });
  const step = (dir: 1 | -1) =>
    go({ date: view === 'day' ? addDays(date, dir) : view === 'week' ? addDays(date, 7 * dir) : addMonths(monthStart(date), dir) });

  const range = rangeOf(view, date);
  const from = wallClockToUtc(range.from, '00:00', tz);
  const to = wallClockToUtc(range.to, '00:00', tz);
  const lessons = useQuery<Lesson>(`calendar:${schoolId}:${range.from}:${range.to}`, () =>
    query(
      collection(db, 'schools', schoolId, 'lessons'),
      where('startAt', '>=', Timestamp.fromDate(from)),
      where('startAt', '<', Timestamp.fromDate(to)),
      orderBy('startAt'),
    ),
  );

  const placed = useMemo<Placed[]>(
    () =>
      lessons.data
        .filter((l) => !teacherFilter || l.teacherId === teacherFilter)
        .filter((l) => !roomFilter || (!l.isOnline && l.locationId === roomFilter))
        .map((l) => {
          const start = l.startAt.toDate();
          const time = wallTimeOf(start, tz);
          const names = l.studentIds.map((id) => studentName(students.byId.get(id))).join(', ');
          return { l, date: wallDateOf(start, tz), time, startMin: minutesOf(time), names };
        }),
    [lessons.data, teacherFilter, roomFilter, tz, students.byId],
  );

  return (
    <section className="stack">
      <div className="page-head">
        <div>
          <h1>Calendar</h1>
          <p className="muted">{titleOf(view, date, tz)}</p>
        </div>
        <div className="row">
          <div className="tabs" role="group" aria-label="View">
            {VIEWS.map(([v, label]) => (
              <button key={v} className={`tab ${view === v ? 'on' : ''}`} aria-pressed={view === v} onClick={() => go({ view: v })}>
                {label}
              </button>
            ))}
          </div>
          <select value={teacherFilter} onChange={(e) => setTeacherFilter(e.target.value)} aria-label="Teacher">
            <option value="">All teachers</option>
            {teachers.data.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </select>
          {places.many && (
            <select value={roomFilter} onChange={(e) => setRoomFilter(e.target.value)} aria-label="Room">
              <option value="">All rooms</option>
              {places.rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          <div className="row">
            <button className="btn" onClick={() => step(-1)} aria-label={`Previous ${view}`}>
              ←
            </button>
            <button className="btn" onClick={() => go({ date: today })}>
              Today
            </button>
            <button className="btn" onClick={() => step(1)} aria-label={`Next ${view}`}>
              →
            </button>
          </div>
          {blocking === null && (
            <button
              className="btn"
              onClick={() => {
                setAdding(null);
                setOpenOff(null);
                setBlocking(view === 'day' ? date : today);
              }}
            >
              Block time
            </button>
          )}
          {adding === null && (
            <button
              className="btn btn-primary"
              onClick={() => {
                setBlocking(null);
                setOpenOff(null);
                setAdding(view === 'day' ? date : today);
              }}
            >
              New lesson
            </button>
          )}
        </div>
      </div>
      {adding !== null && <LessonForm key={adding} initialDate={adding} onDone={() => setAdding(null)} />}
      {blocking !== null && <TimeOffForm key={blocking} initialDate={blocking} onDone={() => setBlocking(null)} />}
      {openOff && <TimeOffDetail key={openOff.entry.id} off={openOff} onDone={() => setOpenOff(null)} />}
      {lessons.error && <p className="error">{lessons.error.message}</p>}

      {view === 'month' ? (
        <MonthGrid
          month={date.slice(0, 7)}
          from={range.from}
          to={range.to}
          today={today}
          placed={placed}
          offs={offs}
          onOff={(o) => {
            setAdding(null);
            setBlocking(null);
            setOpenOff(o);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          lessonHref={lessonHref}
          onDay={(d) => go({ view: 'day', date: d })}
        />
      ) : (
        <TimeGrid
          days={view === 'day' ? [date] : Array.from({ length: 7 }, (_, i) => addDays(range.from, i))}
          today={today}
          placed={placed}
          offs={offs}
          onOff={(o) => {
            setAdding(null);
            setBlocking(null);
            setOpenOff(o);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          lessonHref={lessonHref}
          onDay={(d) => go({ view: 'day', date: d })}
        />
      )}
      <p className="muted legend">
        <span className="cal-key state-unmarked" /> Not marked <span className="cal-key state-marked" /> Marked{' '}
        <span className="cal-key state-cancelled" /> Cancelled <span className="cal-key cal-key-off" /> Time off · ↻ weekly
      </p>
    </section>
  );
}

/** Side-by-side lanes for overlapping lessons: lane index and lane count of each lesson's overlap group. */
function lanesOf(items: Placed[]) {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin);
  const out = new Map<string, { lane: number; lanes: number }>();
  let group: Placed[] = [];
  let groupEnd = -1;
  let laneEnds: number[] = [];
  const close = () => {
    for (const p of group) out.get(p.l.id)!.lanes = laneEnds.length;
    group = [];
    laneEnds = [];
  };
  for (const p of sorted) {
    const end = p.startMin + p.l.durationMin;
    if (p.startMin >= groupEnd) close();
    let lane = laneEnds.findIndex((e) => e <= p.startMin);
    if (lane === -1) lane = laneEnds.push(end) - 1;
    else laneEnds[lane] = end;
    out.set(p.l.id, { lane, lanes: 1 });
    group.push(p);
    groupEnd = Math.max(groupEnd, end);
  }
  close();
  return out;
}

interface GridProps {
  today: string;
  placed: Placed[];
  offs: PlacedOff[];
  onOff: (o: PlacedOff) => void;
  lessonHref: (id: string) => string;
  onDay: (d: string) => void;
}

function TimeGrid({ days, today, placed, offs, onOff, lessonHref, onDay }: GridProps & { days: string[] }) {
  const places = useRooms();
  const roomName = (id: string | null | undefined) => (id ? places.byId.get(id)?.name : undefined);
  const shown = placed.filter((p) => days.includes(p.date));
  const shownOff = offs.filter((o) => days.includes(o.entry.date));
  const firstHour = Math.min(DEFAULT_FIRST_HOUR, ...shown.map((p) => Math.floor(p.startMin / 60)));
  const lastHour = Math.max(DEFAULT_LAST_HOUR, ...shown.map((p) => Math.ceil((p.startMin + p.l.durationMin) / 60)));
  const clip = (m: number) => Math.min(Math.max(m, firstHour * 60), lastHour * 60);
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const single = days.length === 1;
  const cols = { gridTemplateColumns: `60px repeat(${days.length}, minmax(112px, 1fr))` };

  return (
    <div className={`calendar card ${single ? 'cal-single' : ''}`} role="grid" aria-label={single ? 'Day calendar' : 'Week calendar'}>
      <div className="cal-head" role="row" style={cols}>
        <div className="cal-corner" />
        {days.map((d) => (
          <div key={d} role="columnheader" className={`cal-day-head ${d === today ? 'today' : ''}`}>
            {single ? (
              <span>{DAY_LABEL[weekdayOf(d)]}</span>
            ) : (
              <button className="cal-day-link" onClick={() => onDay(d)} title="Open this day">
                {DAY_LABEL[weekdayOf(d)]}
              </button>
            )}
            <span className="muted">{Number(d.slice(8))}</span>
          </div>
        ))}
      </div>
      <div className="cal-body" style={{ ...cols, height: hours.length * HOUR_PX }}>
        <div className="cal-hours">
          {hours.map((h) => (
            <div key={h} className="cal-hour" style={{ height: HOUR_PX }}>
              {String(h).padStart(2, '0')}:00
            </div>
          ))}
        </div>
        {days.map((d) => (
          <div key={d} className={`cal-col ${d === today ? 'today' : ''}`}>
            {hours.map((h) => (
              <div key={h} className="cal-slot" style={{ height: HOUR_PX }} />
            ))}
            {shownOff
              .filter((o) => o.entry.date === d)
              .map((o) => {
                const top = clip(offStartMin(o.entry));
                const bottom = clip(offEndMin(o.entry));
                if (bottom <= top) return null;
                return (
                  <button
                    key={`${o.teacherId}:${o.entry.id}`}
                    className="cal-off"
                    style={{ top: ((top - firstHour * 60) / 60) * HOUR_PX, height: ((bottom - top) / 60) * HOUR_PX - 2 }}
                    onClick={() => onOff(o)}
                    title={`Time off · ${o.teacherName} · ${offLabel(o)}${o.entry.note ? ` · ${o.entry.note}` : ''}`}
                  >
                    <strong>Time off</strong> {offLabel(o)}
                    {o.entry.note && <span className="cal-off-note"> · {o.entry.note}</span>}
                  </button>
                );
              })}
            {(() => {
              const today_ = shown.filter((p) => p.date === d);
              const lanes = lanesOf(today_);
              return today_.map(({ l, startMin, time, names }) => {
                const { lane, lanes: n } = lanes.get(l.id)!;
                return (
                <Link
                  key={l.id}
                  to={lessonHref(l.id)}
                  className={`cal-event state-${stateOf(l)}`}
                  style={{
                    top: ((startMin - firstHour * 60) / 60) * HOUR_PX,
                    height: Math.max((l.durationMin / 60) * HOUR_PX - 2, 20),
                    ...(n > 1 ? { left: `calc(${(lane / n) * 100}% + 2px)`, right: 'auto', width: `calc(${100 / n}% - 4px)` } : {}),
                  }}
                  title={`${time} · ${names}`}
                >
                  <strong>
                    {time}
                    {single && (
                      <span className="cal-event-len">
                        {' '}
                        · {l.durationMin} min · {l.isOnline ? 'online' : (roomName(l.locationId) ?? 'in person')}
                      </span>
                    )}
                  </strong>{' '}
                  {names || 'No students'}
                  {l.seriesId && <span className="cal-repeat" aria-label="weekly"> ↻</span>}
                </Link>
                );
              });
            })()}
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthGrid({ month, from, to, today, placed, offs, onOff, lessonHref, onDay }: GridProps & { month: string; from: string; to: string }) {
  const days: string[] = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  const byDay = new Map<string, Placed[]>();
  for (const p of placed) byDay.set(p.date, [...(byDay.get(p.date) ?? []), p]);

  return (
    <div className="mcal card" role="grid" aria-label="Month calendar">
      <div className="mcal-head" role="row">
        {WEEKDAYS.map((w) => (
          <div key={w} role="columnheader" className="mcal-wd">
            {DAY_LABEL[w]}
          </div>
        ))}
      </div>
      <div className="mcal-body">
        {days.map((d) => {
          const list = byDay.get(d) ?? [];
          const fits = list.length <= MONTH_CELL_MAX ? list.length : MONTH_CELL_MAX - 1;
          return (
            <div
              key={d}
              role="gridcell"
              className={`mcal-day ${d.slice(0, 7) !== month ? 'out' : ''} ${d === today ? 'today' : ''}`}
            >
              <button className="mcal-num" onClick={() => onDay(d)} title="Open this day">
                {Number(d.slice(8))}
              </button>
              {offs
                .filter((o) => o.entry.date === d)
                .map((o) => (
                  <button key={`${o.teacherId}:${o.entry.id}`} className="mcal-off" onClick={() => onOff(o)} title={o.entry.note ?? 'Time off'}>
                    Off {o.allDay ? 'all day' : offLabel(o)}
                  </button>
                ))}
              {list.slice(0, fits).map(({ l, time, names }) => (
                <Link key={l.id} to={lessonHref(l.id)} className={`mcal-ev state-${stateOf(l)}`} title={`${time} · ${names}`}>
                  <span className="mcal-time">{time}</span> <span className="mcal-who">{names || 'No students'}</span>
                </Link>
              ))}
              {list.length > fits && (
                <button className="mcal-more" onClick={() => onDay(d)}>
                  +{list.length - fits} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
