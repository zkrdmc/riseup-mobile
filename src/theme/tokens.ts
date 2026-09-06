/* ─────────────────────────────────────────────────────────────────────────────
   RiseUp Mobile — Design Tokens

   This is the phone's half of the system defined in
   `riseup-frontend/src/styles/tokens.css` v3.0. Same surface ramp, same
   hairline grammar, same reserved accent, same three faces. A coach who uses
   the dashboard on Monday and the app on Saturday should not feel they have
   moved products.

   WHAT IS COPIED VERBATIM
   -----------------------
   Sections 1–8 of the web tokens: surfaces, rules, the five-step ink ramp,
   the reserved `signal` accent, role colours, confidence bands, pitch
   colours, team identity. These are product decisions, not platform ones,
   and a divergence here is a bug.

   WHAT DELIBERATELY DIVERGES, AND WHY
   -----------------------------------
   1. THE TYPE SCALE IS LARGER. The web product bases at 13px because it is a
      terminal on a 27" monitor at 60cm. A phone is held at 30cm by someone
      standing on a touchline in the dark, and the web scale's own rationale
      — that sub-10px text fails WCAG 1.4.4 in practice — argues for going up
      here, not down. Body is 15px, the floor is 12px, and the mono labels
      that carry the instrument voice sit at 12px rather than 11px.

   2. RADII ARE NOT AS TIGHT. 2–4px reads engineered on a dense desktop table.
      At phone scale and phone pixel density it reads like an unstyled input.
      Cards go to 8px; the tight steps survive for pills and inline chips.

   3. SPACING KEEPS THE 4px BASE but the screen padding is 20px, not 16px.
      A phone has no sidebar to give the content an edge, so the margin is
      the only thing separating data from the bezel.

   4. THERE IS NO LIGHT MODE, for the same reason the dashboard has none: a
      pitch visualisation and a video frame both live on near-black, and the
      app is used outdoors at night more often than at noon.

   Raw hex appears in this file and nowhere else. Same rule as the web.
   ───────────────────────────────────────────────────────────────────────── */

/* ── 1. Surface ramp ────────────────────────────────────────────────────── */
export const surface = {
  /** Page canvas, tab bar, headers */
  bg0: '#0b0c0d',
  /** Panels, cards, drop zones */
  bg1: '#101113',
  /** Pressed, inputs, tabs */
  bg2: '#16171a',
  /** Active, selected, sheet base */
  bg3: '#1d1e22',
} as const;

/* ── 2. Rules and borders ───────────────────────────────────────────────── */
export const line = {
  /** The hairline that carries structure. Quieter than `border` on purpose. */
  rule: '#1c1d21',
  /** Outlines something you can interact with */
  border: '#26272b',
  borderHi: '#3a3b42',
  borderStrong: '#4a4b53',
} as const;

/* ── 3. Text — five solid steps, no alpha ───────────────────────────────── */
export const ink = {
  /** Values, headings, active rows */
  1: '#ededf0',
  /** Body copy, inactive rows */
  2: '#a2a3ab',
  /** Supporting detail */
  3: '#83848c',
  /** Labels, timestamps, placeholder */
  mute: '#6e6f78',
  /** Disabled, watermarks, empty state */
  subtle: '#4a4b52',
} as const;

/* ── 4. The accent. Reserved. ───────────────────────────────────────────────
   Use `signal` when the colour MEANS something: live, running, ready,
   connected, confident, measured. If it is decorating rather than reporting,
   it should be ink.

   At most one signal element per screen. On this platform the legitimate
   spends are: a job's live status dot, the confidence band on a metric, the
   record button, and the "framing OK" verdict. Everything else is ink.
   ───────────────────────────────────────────────────────────────────────── */
export const signal = {
  base: '#35c98d',
  hi: '#57dba6',
  /** Borders, rings, inactive track */
  dim: '#1c6647',
  /** Tinted fill behind signal content */
  bg: '#0d211a',
} as const;

/* ── 5. Role colours — meaning only, never decoration ───────────────────── */
export const role = {
  orange: { bg: '#241609', border: '#452614', fg: '#e08a4c', hi: '#ec9f68' },
  amber: { bg: '#1e1709', border: '#392b12', fg: '#c9a35c', hi: '#dcb96a' },
  red: { bg: '#200f11', border: '#3c1c20', fg: '#e0716f', hi: '#ec9694' },
  blue: { bg: '#0c1626', border: '#182a48', fg: '#6ba3e8', hi: '#93bef0' },
} as const;

/** Text on top of a filled accent surface. The primary button is a bone fill
 *  on near-black, not a mint fill — that is the reservation working. */
export const onAccent = '#0b0c0d';

/* ── 6. Confidence bands ────────────────────────────────────────────────────
   The universal vocabulary for "how much do we trust this number". Every
   rating, homography confidence and data-quality indicator uses these.
   Do not invent new colours for trust signals.
   ───────────────────────────────────────────────────────────────────────── */
export const confidence = {
  green: { fg: signal.base, bg: signal.bg, border: signal.dim },
  amber: { fg: role.amber.fg, bg: role.amber.bg, border: role.amber.border },
  red: { fg: role.red.fg, bg: role.red.bg, border: role.red.border },
} as const;

/* ── 7. Pitch visualisation ─────────────────────────────────────────────────
   The pitch sits BELOW the page canvas so the markings read as inset rather
   than printed on a card. Shared by the heatmap thumbnail and, later, the
   framing-assistant coverage overlay.
   ───────────────────────────────────────────────────────────────────────── */
export const pitch = {
  bg: '#070809',
  lineDim: '#1c1d21',
  line: '#2f3036',
  zone: 'rgba(255, 255, 255, 0.025)',
} as const;

/** Home/away in scorelines and rosters. An encoding, not decoration. */
export const team = {
  home: '#35c98d',
  away: '#6ba3e8',
} as const;

/* ── 8. Typography ──────────────────────────────────────────────────────────
   Three faces, three jobs, no italics anywhere.

   Archivo 600 — display. A grotesque drawn for signage and tabular setting.
   DM Sans     — body and UI.
   DM Mono     — the structural voice: labels, metrics, IDs, timestamps,
                 jersey numbers, minutes-remaining. This is what makes the app
                 read as an instrument rather than a dashboard, and it is why
                 the accent is not needed for that job.
   ───────────────────────────────────────────────────────────────────────── */
export const font = {
  display: 'Archivo_600SemiBold',
  sans: 'DMSans_400Regular',
  sansMedium: 'DMSans_500Medium',
  mono: 'DMMono_400Regular',
  monoMedium: 'DMMono_500Medium',
} as const;

/* ── 9. Type scale — one step up from the web product ───────────────────── */
export const type = {
  /** 12px — FLOOR. Mono labels, pills, metadata. Nothing goes below this. */
  micro: 12,
  /** 13px — secondary data, captions */
  sm: 13,
  /** 15px — primary UI text, list rows */
  ui: 15,
  /** 17px — emphasised rows, sheet titles */
  lg: 17,
  /** 20px — section headings */
  xl: 20,

  displaySm: 24,
  display: 30,
  displayLg: 34,

  /** A scoreline, a single dominant figure. Deliberately off the UI scale. */
  hero: 44,
  heroLg: 52,
} as const;

/** Grotesques need negative tracking at display sizes to close up. */
export const tracking = {
  display: -0.6,
  /** Uppercase mono labels. Tracking is what makes them read as instrument
   *  labels rather than shrunken body text. */
  label: 1.1,
} as const;

export const leading = {
  tight: 1.2,
  snug: 1.4,
  normal: 1.5,
  loose: 1.75,
} as const;

/* ── 10. Spacing — 4px base ─────────────────────────────────────────────── */
export const space = {
  half: 2,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
  7: 48,
  8: 64,
} as const;

/** The horizontal gutter every screen uses. See divergence note 3. */
export const screenPadding = 20;

/** iOS HIG and Material both land here, and the Operator is wearing gloves. */
export const minTouchTarget = 44;

/* ── 11. Radius ─────────────────────────────────────────────────────────── */
export const radius = {
  sm: 3,
  md: 6,
  lg: 8,
  xl: 14,
  full: 9999,
} as const;

/* ── 12. Elevation ──────────────────────────────────────────────────────────
   Shadows are for things that genuinely float — sheets, toasts, the record
   HUD. Panels do not float; they are divided by rules.
   ───────────────────────────────────────────────────────────────────────── */
export const scrim = 'rgba(0, 0, 0, 0.72)';

export const shadow = {
  pop: {
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  float: {
    shadowColor: '#000',
    shadowOpacity: 0.6,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
} as const;

/* ── 13. Motion ─────────────────────────────────────────────────────────────
   Faster and shorter than a template would use. A long ease on a state change
   reads as decoration; the restrained version is a change you barely register.
   ───────────────────────────────────────────────────────────────────────── */
export const duration = {
  fast: 90,
  base: 150,
  slow: 240,
} as const;

export const theme = {
  surface,
  line,
  ink,
  signal,
  role,
  onAccent,
  confidence,
  pitch,
  team,
  font,
  type,
  tracking,
  leading,
  space,
  screenPadding,
  minTouchTarget,
  radius,
  scrim,
  shadow,
  duration,
} as const;

export type Theme = typeof theme;
