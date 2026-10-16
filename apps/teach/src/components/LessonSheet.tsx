// A lesson opens in a sheet from the right, over whatever page you're on. The open lesson lives in the URL
// (?lesson=<id>) so it survives a reload, works with the back button and can be shared.
import { useCallback, useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router';
import { LessonPanel } from '../pages/LessonDetail';

const PARAM = 'lesson';

/** href that opens a lesson in the sheet on the current page, keeping the page's own query (filters, view). */
export function useLessonHref() {
  const [params] = useSearchParams();
  return useCallback(
    (lessonId: string) => {
      const next = new URLSearchParams(params);
      next.set(PARAM, lessonId);
      return `?${next}`;
    },
    [params],
  );
}

/** Opens a lesson in the sheet from code (e.g. right after creating it). */
export function useOpenLesson() {
  const [, setParams] = useSearchParams();
  return useCallback(
    (lessonId: string) =>
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.set(PARAM, lessonId);
        return next;
      }),
    [setParams],
  );
}

export function LessonSheet() {
  const [params, setParams] = useSearchParams();
  const lessonId = params.get(PARAM);
  const panelRef = useRef<HTMLDivElement>(null);

  const close = useCallback(
    () =>
      setParams((p) => {
        const next = new URLSearchParams(p);
        next.delete(PARAM);
        return next;
      }),
    [setParams],
  );

  useEffect(() => {
    if (!lessonId) return;
    const back = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    document.body.classList.add('sheet-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('sheet-open');
      back?.focus?.();
    };
  }, [lessonId, close]);

  if (!lessonId) return null;
  return (
    <div className="sheet-root">
      <div className="sheet-scrim" onClick={close} aria-hidden="true" />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Lesson" tabIndex={-1} ref={panelRef}>
        <div className="sheet-bar">
          <span className="sheet-kicker">Lesson</span>
          <Link className="btn btn-sm btn-ghost" to={`/lessons/${lessonId}`}>
            Full page
          </Link>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
              <path d="M4.5 4.5l9 9m0-9-9 9" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="sheet-body">
          {/* key: a different lesson starts from a clean panel (no half-open reschedule form). */}
          <LessonPanel key={lessonId} lessonId={lessonId} variant="sheet" onClose={close} />
        </div>
      </div>
    </div>
  );
}
