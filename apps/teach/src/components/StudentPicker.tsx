// Type-to-search student picker (a combobox). Replaces long chip lists and selects once a school has dozens of students.
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { studentName, useStudents, type WithId } from '../hooks';
import type { Student } from '../types';

const MAX_RESULTS = 8;

const haystack = (s: Student) => `${studentName(s)} ${s.firstName} ${s.email ?? ''} ${s.phone ?? ''}`.toLowerCase();

/** Search box with a result list. Calls onPick with the chosen student; `exclude` hides ids already chosen. */
export function StudentSearch({
  onPick,
  exclude = [],
  placeholder = 'Search students by name, email or phone',
  disabled,
  label = 'Find a student',
}: {
  onPick: (id: string) => void;
  exclude?: readonly string[];
  placeholder?: string;
  disabled?: boolean;
  label?: string;
}) {
  const students = useStudents();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const results = useMemo(() => {
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const skip = new Set(exclude);
    return students.data
      .filter((s) => s.status === 'active' && !skip.has(s.id))
      .filter((s) => terms.every((t) => haystack(s).includes(t)))
      .sort((a, b) => studentName(a).localeCompare(studentName(b)))
      .slice(0, MAX_RESULTS);
  }, [students.data, q, exclude]);

  function pick(s: WithId<Student>) {
    onPick(s.id);
    setQ('');
    setActive(0);
    inputRef.current?.focus();
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (open && results[active]) {
        e.preventDefault();
        pick(results[active]);
      }
    } else if (e.key === 'Escape' && open) {
      // Close just the list; a second Escape reaches the sheet and closes it.
      e.stopPropagation();
      setOpen(false);
    }
  }

  const showList = open && !disabled;
  return (
    <div className="picker">
      <input
        ref={inputRef}
        className="search picker-input"
        type="search"
        role="combobox"
        aria-label={label}
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={showList && results[active] ? `${listId}-${results[active].id}` : undefined}
        autoComplete="off"
        placeholder={placeholder}
        disabled={disabled}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKey}
      />
      {showList && (
        <ul className="picker-list" id={listId} role="listbox">
          {results.map((s, i) => (
            <li
              key={s.id}
              id={`${listId}-${s.id}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : ''}
              // mousedown, not click: it runs before the input's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(s);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="picker-name">{studentName(s)}</span>
              <span className="picker-meta">{s.email || s.phone}</span>
            </li>
          ))}
          {results.length === 0 && <li className="picker-empty">{q ? 'No active student matches.' : 'No more students.'}</li>}
        </ul>
      )}
    </div>
  );
}

/** Several students: chosen ones as removable chips above the search box. */
export function StudentMultiPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
  const students = useStudents();
  return (
    <div className="stack picker-multi">
      {value.length > 0 && (
        <div className="chips">
          {value.map((id) => (
            <span key={id} className="chip on">
              {studentName(students.byId.get(id))}
              <button
                type="button"
                className="chip-x"
                aria-label={`Remove ${studentName(students.byId.get(id))}`}
                onClick={() => onChange(value.filter((x) => x !== id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <StudentSearch exclude={value} onPick={(id) => onChange([...value, id])} />
    </div>
  );
}
