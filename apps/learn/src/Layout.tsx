import { CalendarPlus, House, Receipt, SignOut } from '@phosphor-icons/react';
import { NavLink, Outlet } from 'react-router';
import { auth } from './firebase';
import { logoSrc, useProfile } from './hooks';
import { useStudentIds } from './session';

const TABS = [
  { to: '/', label: 'Home', icon: House, end: true },
  { to: '/book', label: 'Book', icon: CalendarPlus, end: false },
  { to: '/payments', label: 'Payments', icon: Receipt, end: false },
] as const;

export function Layout() {
  const { schoolId } = useStudentIds();
  const profile = useProfile(schoolId);
  const logo = logoSrc(profile.data);
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="wrap topbar-inner">
          <NavLink to="/" className="brand" aria-label={`${profile.data?.name ?? 'Student portal'} home`}>
            {logo ? <img src={logo} alt="" height={38} /> : <span className="brand-name">{profile.data?.name}</span>}
          </NavLink>
          <nav className="topnav" aria-label="Main">
            {TABS.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end}>
                {t.label}
              </NavLink>
            ))}
          </nav>
          <button className="icon-btn" onClick={() => auth.signOut()} aria-label="Sign out" title="Sign out">
            <SignOut size={20} weight="bold" />
          </button>
        </div>
      </header>
      <main id="main" className="wrap page">
        <Outlet />
      </main>
      <nav className="tabbar" aria-label="Main">
        {TABS.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end}>
            {({ isActive }) => (
              <>
                <Icon size={24} weight={isActive ? 'fill' : 'regular'} aria-hidden="true" />
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
