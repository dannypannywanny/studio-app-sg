# singyourwayhome.sg brand tokens (for LessonKaki school #1 theme)

Source: read from the live site's CSS by the website/SEO thread, 2026-10-11. Site is WordPress (Astra + Elementor) on SiteGround, managed by an agency; nobody here edits it.

Use these as **school #1's theme** (per-school config), not hardcoded app defaults.

## Colours
| token | hex | use |
| --- | --- | --- |
| primary | #6300E2 | buttons, links, active states |
| primary-hover | #8E43F0 | hover / accent |
| text | #150E1F | body/headings |
| text-muted | #584D66 | secondary text |
| surface-alt | #F3F1F6 | light section background |
| surface | #FFFFFF | cards, page |
| grey | #4B4F58 | borders/icons (darker) |
| off-white | #F6F7F8 | subtle backgrounds |
| cream | #F8F3EF | header/footer accent |
| periwinkle | #8693E1 | header/footer accent |

Ignore Elementor stock colours (#6EC1E4, #61CE70...) — unused defaults.

## Type
- Headings: Playfair Display (serif). Body: Roboto. (Google Fonts.)

## Buttons
- Pill: border-radius 28px, padding 15px 30px, bg #6300E2, white text, hover #8E43F0.

## Logo
- **Current (confirmed by Daniel 2026-10-11):** https://singyourwayhome.sg/wp-content/uploads/2025/09/SYWH-Logo-Transparent-BG.png (1.4 MB transparent PNG — make a small optimised copy). The older DLMS logo in the site header is outdated; don't use it.

## Site nav (for cross-links)
About /about-2/, Vocal Lessons /vocal-lessons/, Programs /programs/, Blog /blog/, Contact /contact-2/, button "Book a lesson" -> https://learn.singyourwayhome.sg/bookings (Classcard today, 302 -> /en/bookings).
- At cutover: LessonKaki must serve or 301 `/bookings` and `/en/bookings` on learn.* so the site's button and old links keep working.
- Daniel/agency to add a "Student login" nav link -> learn.singyourwayhome.sg.
- Apps should link back to the main site (logo -> https://singyourwayhome.sg).
