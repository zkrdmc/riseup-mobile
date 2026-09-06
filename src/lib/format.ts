/**
 * Formatting.
 *
 * Every number a coach reads passes through here, for two reasons.
 *
 * ONE: units are a product decision. The pipeline stores metres and metres per
 * second because that is what the physics wants; a coach reads kilometres and
 * km/h. Doing that conversion at each call site is how one screen ends up
 * showing 10.4 and another 10 400 for the same run.
 *
 * TWO: Intl formatter construction is expensive and must not happen inside a
 * list row. These are module-level constants, created once, which matters on a
 * squad list of thirty players re-rendering on scroll.
 */

const oneDecimal = new Intl.NumberFormat('en-GB', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const whole = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

const dayMonth = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
});

const dayMonthYear = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
});

/** An em dash, not "0" and not "N/A". A missing measurement is not a zero. */
export const ABSENT = '—';

/** Metres → kilometres, one decimal. `10 412` → `10.4`. */
export function km(metres: number | null | undefined): string {
  if (metres === null || metres === undefined) {
    return ABSENT;
  }
  return oneDecimal.format(metres / 1000);
}

/** Metres per second → km/h, one decimal. The unit every coach thinks in. */
export function kmh(metresPerSecond: number | null | undefined): string {
  if (metresPerSecond === null || metresPerSecond === undefined) {
    return ABSENT;
  }
  return oneDecimal.format(metresPerSecond * 3.6);
}

export function count(n: number | null | undefined): string {
  if (n === null || n === undefined) {
    return ABSENT;
  }
  return whole.format(n);
}

export function percent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined) {
    return ABSENT;
  }
  return `${whole.format(fraction)}%`;
}

/** Minutes played. `88.4` → `88'`, the notation a team sheet uses. */
export function minutes(m: number | null | undefined): string {
  if (m === null || m === undefined) {
    return ABSENT;
  }
  return `${whole.format(m)}'`;
}

/** Seconds → `1:47:12` or `12:04`. Used for match and clip durations. */
export function duration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) {
    return ABSENT;
  }
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Bytes → `18.2 GB`. Upload sizes, free space. */
export function bytes(n: number | null | undefined): string {
  if (n === null || n === undefined) {
    return ABSENT;
  }
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? oneDecimal.format(value) : whole.format(value)} ${units[unit]}`;
}

/**
 * A date, relative for the recent past and absolute beyond it.
 *
 * "2 days ago" is easier to place than "4 Sep" for something that just
 * happened, and much harder for something from March. The switch is at a week.
 */
export function when(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) {
    return ABSENT;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return ABSENT;
  }

  const elapsedMs = Date.now() - date.getTime();
  const days = Math.floor(elapsedMs / 86_400_000);

  if (elapsedMs < 0) {
    // Clock skew between phone and server. Showing "in 3 hours" for something
    // that already happened is worse than showing the date.
    return dayMonth.format(date);
  }
  if (elapsedMs < 60_000) {
    return 'Just now';
  }
  if (elapsedMs < 3_600_000) {
    return `${Math.floor(elapsedMs / 60_000)} min ago`;
  }
  if (days === 0) {
    return `${Math.floor(elapsedMs / 3_600_000)} h ago`;
  }
  if (days === 1) {
    return 'Yesterday';
  }
  if (days < 7) {
    return `${days} days ago`;
  }

  const sameYear = date.getFullYear() === new Date().getFullYear();
  return sameYear ? dayMonth.format(date) : dayMonthYear.format(date);
}

/**
 * What to call a match.
 *
 * `label` is what somebody typed. `filename` is the upload's name, which is
 * the one string on the row never meant for a person — but it is better than
 * a UUID, and the backend deliberately keeps both (migration 009).
 */
export function matchTitle(m: { label: string | null; filename: string }): string {
  if (m.label !== null && m.label.length > 0) {
    return m.label;
  }
  // Strip the extension only. Anything cleverer — splitting on underscores,
  // title-casing — mangles names people chose deliberately.
  return m.filename.replace(/\.[^./\\]+$/, '');
}
