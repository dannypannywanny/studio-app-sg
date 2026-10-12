import type { ReactNode } from 'react';
import { logoSrc, useProfile, useSiteSchoolId } from '../hooks';

/** The signed-out frame: the school's logo over a single card. */
export function AuthShell({ children, schoolId: given, showNotice = false }: { children: ReactNode; schoolId?: string | null; showNotice?: boolean }) {
  const site = useSiteSchoolId();
  const profile = useProfile(given ?? site.schoolId);
  const logo = logoSrc(profile.data);
  return (
    <main className="auth">
      <div className="auth-brand">
        {logo ? <img src={logo} alt={profile.data?.name ?? ''} height={56} /> : <span className="auth-name">{profile.data?.name ?? 'Student portal'}</span>}
      </div>
      {showNotice && profile.data?.signInNotice && (
        <p className="auth-notice" role="note">
          {profile.data.signInNotice}
        </p>
      )}
      <section className="auth-card">{children}</section>
      {profile.data?.contactEmail && (
        <p className="auth-foot">
          Trouble signing in? Email <a href={`mailto:${profile.data.contactEmail}`}>{profile.data.contactEmail}</a>
        </p>
      )}
    </main>
  );
}
