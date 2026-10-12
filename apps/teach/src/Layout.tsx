import { useEffect } from 'react';
import { NavLink, Outlet } from 'react-router';
import { brandingCssVars, googleFontsHref, safeHttpsUrl, type Branding } from '@lessonkaki/shared';
import { auth } from './firebase';
import { useSchool } from './hooks';
import { useSession } from './session';

/** Applies a school's branding over the tokens.css defaults (and removes it again on change). */
function useBranding(branding: Branding | null | undefined) {
  useEffect(() => {
    const root = document.documentElement;
    const vars = brandingCssVars(branding);
    if (vars['--brand-logo']) Object.assign(vars, { '--brand-logo-bg': 'transparent', '--brand-logo-width': '44px', '--brand-logo-height': '44px' });
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
    const href = googleFontsHref(branding);
    let link = document.getElementById('brand-fonts') as HTMLLinkElement | null;
    if (href) {
      if (!link) {
        link = Object.assign(document.createElement('link'), { id: 'brand-fonts', rel: 'stylesheet' });
        document.head.appendChild(link);
      }
      link.href = href;
    }
    return () => {
      for (const k of Object.keys(vars)) root.style.removeProperty(k);
      link?.remove();
    };
  }, [JSON.stringify(branding ?? null)]); // eslint-disable-line react-hooks/exhaustive-deps
}

export function Layout() {
  const { user, role } = useSession();
  const school = useSchool().data;
  useBranding(school?.branding as Branding | undefined);
  const siteUrl = safeHttpsUrl((school?.branding as Branding | undefined)?.siteUrl);
  const isStaff = role === 'owner' || role === 'admin';

  return (
    <div className="shell">
      <header className="topbar">
        {/* Brand slot: the school's logo (branding.logoPath, or --brand-logo in tokens.css) sits here. */}
        <div className="brand">
          {siteUrl ? (
            <a className="brand-logo" href={siteUrl} target="_blank" rel="noopener" aria-label={`${school?.name} website`} />
          ) : (
            <span className="brand-logo" aria-hidden="true" />
          )}
          <span className="brand-name">{school?.name ?? 'LessonKaki'}</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end>
            Today
          </NavLink>
          <NavLink to="/calendar">Calendar</NavLink>
          <NavLink to="/students">Students</NavLink>
          <NavLink to="/lessons">Lessons</NavLink>
          <NavLink to="/invoices">Invoices</NavLink>
          <NavLink to="/packages">Packages</NavLink>
          <NavLink to="/reports">Attendance</NavLink>
          {isStaff && <NavLink to="/staff">Staff</NavLink>}
          {isStaff && <NavLink to="/settings">Settings</NavLink>}
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
