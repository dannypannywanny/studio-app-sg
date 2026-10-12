import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { Layout } from './Layout';
import { auth } from './firebase';
import { useProfile, useSiteSchoolId } from './hooks';
import { Book } from './pages/Book';
import { FinishSignIn } from './pages/FinishSignIn';
import { Home } from './pages/Home';
import { InvoiceDetail } from './pages/InvoiceDetail';
import { Payments } from './pages/Payments';
import { SignIn } from './pages/SignIn';
import { SessionProvider, useSession } from './session';
import { AuthShell } from './components/AuthShell';

function NotAStudent() {
  const { user } = useSession();
  return (
    <AuthShell schoolId={null}>
      <h1>No student access yet</h1>
      <p className="lede">
        {user?.email} isn't linked to a student at this school. If you take lessons here, ask the studio to add this email.
      </p>
      <button className="btn btn-quiet" onClick={() => auth.signOut()}>
        Sign out
      </button>
    </AuthShell>
  );
}

function RequireStudent({ children }: { children: ReactNode }) {
  const { ready, user, studentId } = useSession();
  const location = useLocation();
  if (!ready) return <div className="boot" aria-busy="true" />;
  if (!user) return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  if (!studentId) return <NotAStudent />;
  return children;
}

/** Sets the tab title to the school's name once it's known. */
function Title() {
  const site = useSiteSchoolId();
  const name = useProfile(site.schoolId).data?.name;
  useEffect(() => {
    if (name) document.title = name;
  }, [name]);
  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Title />
        <Routes>
          <Route path="/sign-in" element={<SignIn />} />
          <Route path="/finish-signin" element={<FinishSignIn />} />
          <Route
            element={
              <RequireStudent>
                <Layout />
              </RequireStudent>
            }
          >
            <Route index element={<Home />} />
            <Route path="book" element={<Book />} />
            <Route path="payments" element={<Payments />} />
            <Route path="payments/:invoiceId" element={<InvoiceDetail />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </SessionProvider>
    </BrowserRouter>
  );
}
