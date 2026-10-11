import type { ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { Layout } from './Layout';
import { Calendar } from './pages/Calendar';
import { InvoiceDetail } from './pages/InvoiceDetail';
import { Invoices } from './pages/Invoices';
import { FinishSignIn } from './pages/FinishSignIn';
import { LessonDetail } from './pages/LessonDetail';
import { Lessons } from './pages/Lessons';
import { SignIn } from './pages/SignIn';
import { StudentDetail } from './pages/StudentDetail';
import { Students } from './pages/Students';
import { SessionProvider, useSession } from './session';
import { auth } from './firebase';

function RequireStaff({ children }: { children: ReactNode }) {
  const { ready, user, schoolId } = useSession();
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
            <Route index element={<Navigate to="/calendar" replace />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="students" element={<Students />} />
            <Route path="students/:studentId" element={<StudentDetail />} />
            <Route path="lessons" element={<Lessons />} />
            <Route path="lessons/:lessonId" element={<LessonDetail />} />
            <Route path="invoices" element={<Invoices />} />
            <Route path="invoices/:invoiceId" element={<InvoiceDetail />} />
            <Route path="*" element={<Navigate to="/students" replace />} />
          </Route>
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
