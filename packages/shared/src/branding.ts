// Per-school theme. tokens.css holds the defaults; a school's `branding` overrides some of them at
// runtime as CSS variables. Values are validated here because they come from the database.

export interface Branding {
  colors?: Partial<Record<'primary' | 'primaryHover' | 'onPrimary' | 'accent' | 'text' | 'muted' | 'background' | 'surface', string>> | null;
  fonts?: { display?: string | null; body?: string | null } | null;
  /** https URL of the logo image. */
  logoUrl?: string | null;
  /** Button corner radius in px (e.g. 28 for pill buttons). */
  buttonRadius?: number | null;
  /** The school's own website: the logo links back to it. */
  siteUrl?: string | null;
}

const COLOR_VARS: Record<keyof NonNullable<Branding['colors']>, string> = {
  primary: '--brand-primary',
  primaryHover: '--brand-primary-hover',
  onPrimary: '--brand-on-primary',
  accent: '--brand-accent',
  text: '--color-text',
  muted: '--color-muted',
  background: '--color-bg',
  surface: '--color-surface',
};

const HEX = /^#[0-9a-fA-F]{6}$/;
const FONT = /^[A-Za-z0-9 ]{1,40}$/;
const SERIF = new Set(['Playfair Display', 'Merriweather', 'Lora', 'Georgia', 'Cormorant Garamond']);

const fontStack = (name: string) => `'${name}', ${SERIF.has(name) ? 'Georgia, serif' : 'system-ui, sans-serif'}`;

/** https URLs only, with no characters that could break out of a CSS url("..."). */
export function safeHttpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  return /^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~%!$&*+,;=:@\/-]*)?(\?[A-Za-z0-9._~%!$&*+,;=:@\/?-]*)?$/.test(url)
    ? url
    : null;
}

export function brandingCssVars(b: Branding | null | undefined): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!b) return vars;
  for (const [key, cssVar] of Object.entries(COLOR_VARS)) {
    const v = b.colors?.[key as keyof typeof COLOR_VARS];
    if (v && HEX.test(v)) vars[cssVar] = v;
  }
  if (b.fonts?.display && FONT.test(b.fonts.display)) vars['--font-display'] = fontStack(b.fonts.display);
  if (b.fonts?.body && FONT.test(b.fonts.body)) vars['--font-body'] = fontStack(b.fonts.body);
  const logo = safeHttpsUrl(b.logoUrl);
  if (logo) vars['--brand-logo'] = `url("${logo}")`;
  if (typeof b.buttonRadius === 'number' && b.buttonRadius >= 0 && b.buttonRadius <= 40) {
    vars['--radius-button'] = `${Math.round(b.buttonRadius)}px`;
  }
  return vars;
}

/** A Google Fonts stylesheet URL for the school's fonts, or null when it uses the defaults. */
export function googleFontsHref(b: Branding | null | undefined): string | null {
  const families: string[] = [];
  if (b?.fonts?.display && FONT.test(b.fonts.display)) families.push(`family=${b.fonts.display.replaceAll(' ', '+')}:wght@400;600;700`);
  if (b?.fonts?.body && FONT.test(b.fonts.body)) families.push(`family=${b.fonts.body.replaceAll(' ', '+')}:wght@400;500;700`);
  return families.length ? `https://fonts.googleapis.com/css2?${families.join('&')}&display=swap` : null;
}
