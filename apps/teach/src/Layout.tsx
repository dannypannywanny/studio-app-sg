import { NavLink, Outlet } from 'react-router';
import { auth } from './firebase';
import { useSchool } from './hooks';
import { useSession } from './session';

export function Layout() {
  const { user, role } = useSession();
  const school = useSchool().data;

  return (
    <div className="shell">
      <header className="topbar">
        {/* Brand slot: the school's logo (branding.logoPath, or --brand-logo in tokens.css) sits here. */}
        <div className="brand">
          <span className="brand-logo" aria-hidden="true" />
          <span className="brand-name">{school?.name ?? 'LessonKaki'}</span>
        </div>
        <nav className="nav">
          <NavLink to="/calendar">Calendar</NavLink>
          <NavLink to="/students">Students</NavLink>
          <NavLink to="/lessons">Lessons</NavLink>
          <NavLink to="/invoices">Invoices</NavLink>
        </nav>
        <div className="account">
          <span className="muted">
            {user?.email} · {role}
          </span>
          <button className="btn btn-ghost" onClick={() => auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
