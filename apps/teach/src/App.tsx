import type { ReactNode } from 'react';
import { roleNeedsMfa } from '@lessonkaki/shared';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { Layout } from './Layout';
import { Calendar } from './pages/Calendar';
import { Dashboard } from './pages/Dashboard';
import { ImportStudents } from './pages/ImportStudents';
import { Leads } from './pages/Leads';
import { Packages } from './pages/Packages';
import { Reports } from './pages/ReportsHome';
import { MyPay } from './pages/MyPay';
import { Settings } from './pages/Settings';
import { Staff } from './pages/Staff';
import { InvoiceDetail } from './pages/InvoiceDetail';
import { Invoices } from './pages/Invoices';
import { FinishSignIn } from './pages/FinishSignIn';
import { TwoStepSetup } from './pages/TwoStep';
import { LessonDetail } from './pages/LessonDetail';
import { Lessons } from './pages/Lessons';
import { SignIn } from './pages/SignIn';
import { StudentDetail } from './pages/StudentDetail';
import { Students } from './pages/Students';
import { SessionProvider, useSession } from './session';
import { auth } from './firebase';

function RequireStaff({ children }: { children: ReactNode }) {
  const { ready, user, schoolId, role, secondFactor } = useSession();
  const location = useLocation();
  if (!ready) return <p className="page-status">Loading…</p>;
  if (!user) return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  if (!schoolId) {
    return (
      <div className="auth-card">
        <h1>No staff access</h1>
        <p>
          {user.email} isn't on the staff of any school yet. Ask the school owner to add you, then sign in again.
        </p>
        <button className="btn" onClick={() => auth.signOut()}>
          Sign out
        </button>
      </div>
    );
  }
  // Rules and functions refuse staff without a second factor, so set it up before loading anything.
  if (role && roleNeedsMfa(role) && !secondFactor) return <TwoStepSetup user={user} />;
  // Teacher logins: their own day, calendar, lessons and pay only.
  if (role === 'teacher' && !/^\/($|calendar|lessons\/|my-pay)/.test(location.pathname)) return <Navigate to="/" replace />;
  return children;
}

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/finish-signin" element={<FinishSignIn />} />
          <Route
            element={
              <RequireStaff>
                <Layout />
              </RequireStaff>
            }
          >
            <Route index element={<Dashboard />} />
            <Route path="my-pay" element={<MyPay />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="students" element={<Students />} />
            <Route path="students/import" element={<ImportStudents />} />
            <Route path="students/:studentId" element={<StudentDetail />} />
            <Route path="leads" element={<Leads />} />
            <Route path="lessons" element={<Lessons />} />
            <Route path="lessons/:lessonId" element={<LessonDetail />} />
            <Route path="invoices" element={<Invoices />} />
            <Route path="invoices/:invoiceId" element={<InvoiceDetail />} />
            <Route path="packages" element={<Packages />} />
            <Route path="reports" element={<Reports />} />
            <Route path="staff" element={<Staff />} />
            <Route path="settings" element={<Settings />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
