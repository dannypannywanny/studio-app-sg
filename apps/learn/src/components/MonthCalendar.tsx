// Month view for picking a lesson day. Days with open times are tappable; the rest are greyed out.
import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import { useState } from 'react';
import { WEEKDAYS, addDays, weekdayOf } from '@lessonkaki/shared';

const WEEK_HEAD = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthOf = (date: string) => date.slice(0, 7); // 'YYYY-MM'

function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('en-SG', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y!, m! - 1, 1)));
}

function daysInMonth(month: string): string[] {
  const [y, m] = month.split('-').map(Number);
  const count = new Date(Date.UTC(y!, m!, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => addDays(`${month}-01`, i));
}

export function MonthCalendar({
  open,
  selected,
  today,
  onSelect,
}: {
  /** Wall dates ('YYYY-MM-DD', school zone) that have open times, sorted. */
  open: string[];
  selected: string | null;
  today: string;
  onSelect: (date: string) => void;
}) {
  const months = [...new Set([monthOf(today), ...open.map(monthOf)])].sort();
  const [shown, setShown] = useState(() => monthOf(selected ?? open[0] ?? today));
  const index = Math.max(0, months.indexOf(shown));
  const month = months[index] ?? monthOf(today);
  const days = daysInMonth(month);
  const lead = WEEKDAYS.indexOf(weekdayOf(days[0]!));
  const openSet = new Set(open);

  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="icon-btn" onClick={() => setShown(months[index - 1]!)} disabled={index === 0} aria-label="Previous month">
          <CaretLeft size={20} weight="bold" />
        </button>
        <h2 className="cal-title" aria-live="polite">
          {monthTitle(month)}
        </h2>
        <button
          type="button"
          className="icon-btn"
          onClick={() => setShown(months[index + 1]!)}
          disabled={index >= months.length - 1}
          aria-label="Next month"
        >
          <CaretRight size={20} weight="bold" />
        </button>
      </div>
      <div className="cal-grid" role="grid" aria-label={monthTitle(month)}>
        {WEEK_HEAD.map((d) => (
          <span key={d} className="cal-dow" aria-hidden="true">
            {d.slice(0, 1)}
          </span>
        ))}
        {Array.from({ length: lead }, (_, i) => (
          <span key={`pad${i}`} />
        ))}
        {days.map((date) => {
          const available = openSet.has(date);
          const label = new Intl.DateTimeFormat('en-SG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));
          return (
            <button
              key={date}
              type="button"
              className={`cal-day${date === today ? ' is-today' : ''}`}
              disabled={!available}
              aria-pressed={date === selected}
              aria-label={`${label}${available ? '' : ', no times'}`}
              onClick={() => onSelect(date)}
            >
              {Number(date.slice(8))}
            </button>
          );
        })}
      </div>
    </div>
  );
}
