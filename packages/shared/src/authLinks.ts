// Email action links. Auth's email action URL points at the app's /finish-signin page, so sign-in links
// skip Firebase's hosted handler. Links can arrive without `apiKey`, which the Firebase SDK needs to
// recognise them, and other emails (e.g. "a second factor was added", with a revert link) use the same
// URL, so they are sent on to Firebase's own handler.

// The shared package has no DOM/Node lib; URL exists in browsers and Node, so declare what's used.
declare const URL: new (href: string) => {
  searchParams: { get(name: string): string | null; set(name: string, value: string): void };
  search: string;
  toString(): string;
};

export type ActionLink =
  | { kind: 'signIn'; href: string }
  | { kind: 'firebase'; href: string }
  | { kind: 'none' };

/** Classifies the current URL and fills in what the Firebase SDK expects. Pure; no side effects. */
export function resolveActionLink(href: string, apiKey: string, authDomain: string): ActionLink {
  const url = new URL(href);
  const mode = url.searchParams.get('mode');
  if (!mode || !url.searchParams.get('oobCode')) return { kind: 'none' };
  if (!url.searchParams.get('apiKey')) url.searchParams.set('apiKey', apiKey);
  if (mode === 'signIn') return { kind: 'signIn', href: url.toString() };
  return { kind: 'firebase', href: `https://${authDomain}/__/auth/action${url.search}` };
}
