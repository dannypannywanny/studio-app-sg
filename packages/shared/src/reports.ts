// Attendance report (S11) and the at-risk list. Pure functions over rows the app has already read.

export interface AttendanceRow {
  studentId: string;
  status: string;
  lessonStartAt: Date;
}

export interface AttendanceStats {
  present: number;
  absent: number;
  lateCancelled: number;
  cancelled: number;
  /** Booked but not marked yet. */
  unmarked: number;
  /** Every booking except removals. */
  total: number;
  /** present / (present + absent + late cancel); null when none of those happened. */
  rate: number | null;
}

const empty = (): AttendanceStats => ({ present: 0, absent: 0, lateCancelled: 0, cancelled: 0, unmarked: 0, total: 0, rate: null });

export function summariseAttendance(rows: readonly AttendanceRow[]): Map<string, AttendanceStats> {
  const out = new Map<string, AttendanceStats>();
  for (const r of rows) {
    if (r.status === 'removed') continue;
    const s = out.get(r.studentId) ?? empty();
    if (r.status === 'present') s.present += 1;
    else if (r.status === 'absent') s.absent += 1;
    else if (r.status === 'lateCancelled') s.lateCancelled += 1;
    else if (r.status === 'cancelled') s.cancelled += 1;
    else if (r.status === 'booked') s.unmarked += 1;
    s.total += 1;
    out.set(r.studentId, s);
  }
  for (const s of out.values()) {
    const counted = s.present + s.absent + s.lateCancelled;
    s.rate = counted ? s.present / counted : null;
  }
  return out;
}

export const RISK_REASONS = ['absences', 'noUpcoming', 'lowCredits', 'owed', 'expiringSoon'] as const;
export type RiskReason = (typeof RISK_REASONS)[number];

export const RISK_LABEL: Record<RiskReason, string> = {
  absences: 'Missed the last 2 lessons',
  noUpcoming: 'Nothing booked',
  lowCredits: '1 or no credits left',
  owed: 'Owes lessons',
  expiringSoon: 'Credits expire within 14 days',
};

export interface RiskInput {
  now: Date;
  students: { id: string; status: string; sessionsAvailable: number; sessionsOwed: number }[];
  attendance: readonly AttendanceRow[];
  /** Number of scheduled lessons from now on, per student. */
  upcomingByStudent: ReadonlyMap<string, number>;
  /** Active lots. */
  lots: { studentId: string; remaining: number; validUntil: Date }[];
}

const EXPIRY_WINDOW_MS = 14 * 86_400_000;

/** Active students needing attention, in the order given, with why. */
export function atRiskStudents(input: RiskInput): { studentId: string; reasons: RiskReason[] }[] {
  const nowMs = input.now.getTime();
  const marked = new Map<string, AttendanceRow[]>();
  for (const r of input.attendance) {
    if (!['present', 'absent', 'lateCancelled'].includes(r.status) || r.lessonStartAt.getTime() > nowMs) continue;
    marked.set(r.studentId, [...(marked.get(r.studentId) ?? []), r]);
  }
  const out: { studentId: string; reasons: RiskReason[] }[] = [];
  for (const s of input.students) {
    if (s.status !== 'active') continue;
    const reasons = new Set<RiskReason>();
    const last2 = (marked.get(s.id) ?? [])
      .sort((a, b) => a.lessonStartAt.getTime() - b.lessonStartAt.getTime())
      .slice(-2);
    if (last2.length === 2 && last2.every((r) => r.status !== 'present')) reasons.add('absences');
    const upcoming = input.upcomingByStudent.get(s.id) ?? 0;
    if (upcoming === 0) reasons.add('noUpcoming');
    else if (s.sessionsAvailable <= 1) reasons.add('lowCredits');
    if (s.sessionsOwed > 0) reasons.add('owed');
    const expiring = input.lots.some(
      (l) => l.studentId === s.id && l.remaining > 0 && l.validUntil.getTime() > nowMs && l.validUntil.getTime() - nowMs <= EXPIRY_WINDOW_MS,
    );
    if (expiring) reasons.add('expiringSoon');
    if (reasons.size) out.push({ studentId: s.id, reasons: RISK_REASONS.filter((r) => reasons.has(r)) });
  }
  return out;
}
