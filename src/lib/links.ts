/**
 * Everywhere the app sends someone outside itself.
 *
 * In one file because both stores audit these. Apple checks that a privacy
 * policy and functioning support contact are reachable (App Review 1.5, 5.1.1);
 * Google checks the same and additionally requires an account-deletion URL that
 * works in a browser, outside the app, for its Data Safety form.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHAT MUST NOT BE HERE
 * ══════════════════════════════════════════════════════════════════════════
 * A checkout. Apple 3.1.1 and Google Play's Payments policy both require that
 * digital goods and subscriptions be sold through the platform's own billing,
 * and both read "a link that opens a Stripe page" as an attempt to route
 * around it. Reviewers look for exactly that.
 *
 * So this app sells nothing and links to nothing that sells. Quota and billing
 * are administered on the web dashboard by a club admin, and the app's only
 * involvement is telling somebody their club is near its limit. If a purchase
 * flow is ever wanted on the phone it has to be StoreKit and Play Billing, not
 * a browser link — and that is a product decision, not a plumbing one.
 */

import { Linking, Platform } from 'react-native';
import * as Application from 'expo-application';
import * as Device from 'expo-device';

const SITE = 'https://riseupai.co';

export const links = {
  privacy: `${SITE}/privacy`,
  terms: `${SITE}/terms`,
  support: `${SITE}/support`,
  /**
   * Publicly reachable account deletion.
   *
   * Google Play requires a URL that works WITHOUT the app installed and
   * without signing in to the app — it is submitted in the Data Safety form
   * and a reviewer opens it in a browser. In-app deletion alone does not
   * satisfy it, which is the one place the two stores genuinely differ here.
   *
   * Apple has no URL requirement, only the in-app path (5.1.1(v)), and this
   * app has both.
   */
  deleteAccount: `${SITE}/delete-account`,
  supportEmail: 'support@riseupai.co',
} as const;

/**
 * Open an external link.
 *
 * Returns false rather than throwing when nothing can handle it — a device
 * with no browser, or an email link on a handset with no mail account
 * configured, which is common on a shared club phone. The caller shows the
 * address instead so the information is still reachable.
 */
export async function openLink(url: string): Promise<boolean> {
  try {
    const supported = await Linking.canOpenURL(url);
    if (!supported) {
      return false;
    }
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

/* ── Reporting something broken ───────────────────────────────────────────── */

export interface Diagnostics {
  appVersion: string;
  buildVersion: string;
  platform: string;
  osVersion: string;
  deviceModel: string;
  /** Clerk org id. Identifies the club without carrying anything personal. */
  clubId: string | null;
  userId: string | null;
}

export function collectDiagnostics(clubId: string | null, userId: string | null): Diagnostics {
  return {
    appVersion: Application.nativeApplicationVersion ?? 'unknown',
    buildVersion: Application.nativeBuildVersion ?? 'unknown',
    platform: Platform.OS,
    osVersion: String(Platform.Version),
    deviceModel: Device.modelName ?? 'unknown',
    clubId,
    userId,
  };
}

/**
 * The block appended to a report.
 *
 * Deliberately small and deliberately readable. A coach is about to send this
 * to a person, and a wall of JSON invites them to delete it before sending —
 * which loses the only diagnostic information a support ticket will ever have.
 *
 * `userId` and `clubId` are opaque Clerk identifiers. No email, no name, no
 * location, no match content. Everything here is something support needs in
 * order to find the account, and nothing here is something they could not
 * already look up.
 */
export function formatDiagnostics(d: Diagnostics): string {
  return [
    '',
    '---',
    'Sent from the RiseUp app. Please leave the lines below — they say which',
    'app and phone this came from.',
    `App      ${d.appVersion} (${d.buildVersion})`,
    `Platform ${d.platform} ${d.osVersion}`,
    `Device   ${d.deviceModel}`,
    `Club     ${d.clubId ?? 'not signed in'}`,
    `User     ${d.userId ?? 'not signed in'}`,
  ].join('\n');
}

/**
 * Compose a support email with the report already in it.
 *
 * A mailto rather than a POST to the API, for one reason that matters: the
 * things most worth reporting are the ones where the API is unreachable. An
 * in-app form that submits over the network cannot report "I could not sign
 * in" or "uploads fail at this ground", which are precisely the reports
 * support needs. The mail sits in an outbox and goes when there is signal.
 *
 * A server-side endpoint is worth adding as well, later, so a report can carry
 * logs — see `docs/BACKEND-GAPS.md`.
 */
export function supportMailto(subject: string, body: string, d: Diagnostics): string {
  const full = `${body}\n${formatDiagnostics(d)}`;
  return `mailto:${links.supportEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(full)}`;
}
