import { NavLink, Outlet } from 'react-router';
import { safeHttpsUrl, type Branding } from '@lessonkaki/shared';
import { LessonSheet } from './components/LessonSheet';
import { auth } from './firebase';
import { useSchool } from './hooks';
import { useSession } from './session';

// The staff app keeps LessonKaki's own design (tokens.css). A school's branding supplies its logo and name only.
export function Layout() {
  const { user, role } = useSession();
  const school = useSchool().data;
  const branding = school?.branding as Branding | undefined;
  const logo = safeHttpsUrl(branding?.logoUrl);
  const siteUrl = safeHttpsUrl(branding?.siteUrl);
  const isStaff = role === 'owner' || role === 'admin';
  const name = school?.name ?? 'LessonKaki';
  const brand = (
    <>
      {logo && <img className="brand-logo" src={logo} alt="" />}
      <span className="brand-name">{name}</span>
    </>
  );

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        {siteUrl ? (
          <a className="brand" href={siteUrl} target="_blank" rel="noopener" aria-label={`${name} website`}>
            {brand}
          </a>
        ) : (
          <span className="brand">{brand}</span>
        )}
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>
            Today
          </NavLink>
          <NavLink to="/calendar">Calendar</NavLink>
          <NavLink to="/students">Students</NavLink>
          <NavLink to="/lessons">Lessons</NavLink>
          <NavLink to="/invoices">Invoices</NavLink>
          <NavLink to="/packages">Packages</NavLink>
          <NavLink to="/reports">Reports</NavLink>
          {isStaff && <NavLink to="/staff">Staff</NavLink>}
          {isStaff && <NavLink to="/settings">Settings</NavLink>}
        </nav>
        <div className="account">
          <span className="account-who">
            <span className="account-email">{user?.email}</span>
            <span className="account-role">{role}</span>
          </span>
          <button className="btn btn-sm" onClick={() => auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <main id="main" className="content">
        <Outlet />
      </main>
      <LessonSheet />
    </div>
  );
}
