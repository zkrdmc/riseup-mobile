/**
 * Which fixture reminders to schedule, and when.
 *
 * PURE. No expo-notifications, no fetch, no clock of its own — `now` is passed
 * in. That is not a style preference: every other module in `src/capture`
 * learned the same lesson, and the smoke suite can only cover a scheduler that
 * does not need a device.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS IS A LOCAL NOTIFICATION AND NOT A PUSH
 * ══════════════════════════════════════════════════════════════════════════
 * A fixture's kickoff is a time the club WROTE DOWN IN ADVANCE. The phone
 * already has it, so it can schedule its own reminder, and that is strictly
 * better than a server push for this one category:
 *
 *   - It needs no signal at the moment it fires. A reminder is most valuable
 *     at a ground, which is exactly where coverage is worst.
 *   - It needs no server clock. There is no scheduler in the backend — no
 *     Celery beat, no cron — so a pushed reminder would need one built, and a
 *     missed cron is a missed notification nobody can see.
 *   - It needs no push credential and no delivery guarantee.
 *
 * Analysis-ready is the opposite case — an unpredictable server-side event
 * only the server knows about — and that one IS a push. The split is by the
 * nature of the event, not by convenience.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHAT IT WILL NOT DO
 * ══════════════════════════════════════════════════════════════════════════
 * Invent a time. A fixture with no `kickoffTime` is a row the club has not
 * finished filling in; `core/access_windows.py` already refuses to grant it a
 * window for the same reason, and this refuses to guess one. A reminder at the
 * wrong hour is worse than no reminder, because the operator stops trusting
 * the next one.
 */

/** A fixture as the team-index document carries it. */
export interface Fixture {
  id?: string;
  /** `YYYY-MM-DD`, the club's local day. */
  date?: string;
  /** `HH:MM`, 24-hour, local. Absent means the club has not said when. */
  kickoffTime?: string;
  opponent?: string;
  home?: boolean;
}

export interface PlannedReminder {
  /** Stable across reschedules, so an unchanged fixture is not re-notified. */
  key: string;
  /** When the notification fires. */
  fireAt: Date;
  title: string;
  body: string;
  /** Rides in the notification payload; `routeFor` sends it to Capture. */
  data: { category: 'fixture_reminder'; fixtureId: string };
}

/**
 * How long before kickoff to fire.
 *
 * Ninety minutes: long enough to travel and set a rig up — `capture.tsx` tells
 * an operator a first survey at a new ground takes about twenty minutes — and
 * short enough that it is still obviously about today.
 */
export const LEAD_MINUTES = 90;

/**
 * The furthest ahead to schedule.
 *
 * iOS caps an app at 64 pending local notifications, so scheduling a whole
 * season would silently drop the far end and, worse, drop whichever ones the
 * OS chose. A fortnight is well inside the cap for any real fixture list, and
 * the app reschedules on every launch — so the window rolls forward long
 * before the edge of it matters.
 */
export const HORIZON_DAYS = 14;

/** iOS's documented ceiling on pending local notifications. */
export const MAX_PENDING = 60;

function parseKickoff(fixture: Fixture): Date | null {
  const date = (fixture.date ?? '').trim();
  const time = (fixture.kickoffTime ?? '').trim();
  if (date === '' || time === '') {
    return null;
  }
  // `YYYY-MM-DD` and `HH:MM`, validated rather than trusted: this document is
  // user-entered and a half-typed row must not become an Invalid Date that
  // schedules at the epoch.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(time)) {
    return null;
  }
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  if (hh > 23 || mm > 59) {
    return null;
  }
  // Local time on purpose. The club entered a wall-clock kickoff for the
  // ground they are travelling to, and the phone is in that timezone.
  const at = new Date(y, m - 1, d, hh, mm, 0, 0);
  return Number.isNaN(at.getTime()) ? null : at;
}

function label(fixture: Fixture): string {
  const opponent = (fixture.opponent ?? '').trim();
  if (opponent === '') {
    return 'Kick-off soon';
  }
  return fixture.home === true ? `${opponent} (H)` : `${opponent} (A)`;
}

function timeOfDay(at: Date): string {
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * Turn a fixture list into the reminders that should be pending right now.
 *
 * Sorted by fire time and capped, so that if a club does enter a season's
 * worth, the ones that survive the cap are the SOONEST — which is the opposite
 * of what the OS would have chosen for us.
 */
export function planReminders(
  fixtures: readonly Fixture[],
  now: Date,
  options: { leadMinutes?: number; horizonDays?: number; max?: number } = {},
): PlannedReminder[] {
  const lead = options.leadMinutes ?? LEAD_MINUTES;
  const horizon = options.horizonDays ?? HORIZON_DAYS;
  const max = options.max ?? MAX_PENDING;

  const horizonEnd = new Date(now.getTime() + horizon * 24 * 60 * 60 * 1000);
  const planned: PlannedReminder[] = [];

  fixtures.forEach((fixture, index) => {
    const kickoff = parseKickoff(fixture);
    if (kickoff === null) {
      return;
    }
    if (kickoff > horizonEnd) {
      return;
    }

    const fireAt = new Date(kickoff.getTime() - lead * 60 * 1000);
    // A reminder whose moment has passed is dropped rather than fired late.
    // Firing "kick-off in 90 minutes" after kick-off is the kind of wrongness
    // that teaches somebody to ignore the channel.
    if (fireAt <= now) {
      return;
    }

    // The fixture's own id where it has one, so an edited opponent name does
    // not orphan the pending notification. Falling back to date+time+index
    // keeps it stable for a document that has never been saved with ids.
    const fixtureId = (fixture.id ?? '').trim() !== ''
      ? (fixture.id as string)
      : `${fixture.date ?? ''}T${fixture.kickoffTime ?? ''}#${index}`;

    planned.push({
      key: `fixture:${fixtureId}`,
      fireAt,
      title: label(fixture),
      body: `Kick-off at ${timeOfDay(kickoff)}. Time to set up.`,
      data: { category: 'fixture_reminder', fixtureId },
    });
  });

  planned.sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime());
  return planned.slice(0, max);
}

/**
 * What to cancel and what to add, given what is already pending.
 *
 * RESCHEDULING IS A DIFF, NOT A WIPE. Cancelling everything and re-adding
 * would work and is what most apps do; it also means a fixture that has not
 * changed gets a new pending notification on every single launch, and any bug
 * in the add path silently leaves a club with no reminders at all. Comparing
 * first means an unchanged fixture is left alone.
 */
export function reconcile(
  planned: readonly PlannedReminder[],
  pending: readonly { key: string; fireAt: Date }[],
): { cancel: string[]; add: PlannedReminder[] } {
  const plannedByKey = new Map(planned.map((p) => [p.key, p]));
  const pendingByKey = new Map(pending.map((p) => [p.key, p]));

  const cancel: string[] = [];
  pendingByKey.forEach((existing, key) => {
    const want = plannedByKey.get(key);
    // Gone from the plan, or moved. A kickoff edited by ten minutes must
    // re-fire at the new time rather than keep the old one.
    if (want === undefined || want.fireAt.getTime() !== existing.fireAt.getTime()) {
      cancel.push(key);
    }
  });

  const add = planned.filter((p) => {
    const existing = pendingByKey.get(p.key);
    return existing === undefined
      || existing.fireAt.getTime() !== p.fireAt.getTime();
  });

  return { cancel, add };
}
