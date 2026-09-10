/**
 * Putting the user into their club.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE BUG THIS EXISTS TO FIX
 * ══════════════════════════════════════════════════════════════════════════
 * Clerk does not activate an organisation on sign-in. Membership and ACTIVE
 * membership are different things: a user can belong to a club and still hold
 * a session with no active organisation, in which case Clerk omits `org_id`
 * from the JWT entirely.
 *
 * `clerk_auth.py` derives `club_id` from `org_id` and returns 403 from every
 * endpoint when it is missing. So without this, a correctly invited coach who
 * has accepted their invitation signs in and is told they are not in a club —
 * the membership gate firing on a legitimate member, which is worse than the
 * orphan case it was written for, because there is nothing anybody can do
 * about it.
 *
 * So: if the user has exactly one membership, activate it. That is the case
 * for essentially every coach, and it makes the club invisible plumbing rather
 * than something they have to know exists.
 *
 * ON THE EMAIL-MATCHING QUESTION. Attaching a social sign-in to an existing
 * invited member is Clerk's own "account linking" — Dashboard → User &
 * Authentication → Account linking, "automatically link accounts with the same
 * email address". It is a setting, not app code, and it works on VERIFIED
 * emails, which Apple and Google both return.
 *
 * It has one hole worth knowing about: Apple's Hide My Email returns a
 * `@privaterelay.appleid.com` address, which is a genuinely different address
 * and will not match the invitation. Those users become orphans no matter what
 * is configured, which is one more reason not to enable social sign-in for a
 * product whose accounts are provisioned by an administrator.
 */

import { useAuth, useOrganizationList } from '@clerk/expo';
import { useEffect, useRef, useState } from 'react';

export interface ClubOption {
  id: string;
  name: string;
}

export type OrganisationState =
  /** Clerk has not finished loading memberships. */
  | { status: 'loading' }
  /** An organisation is active; the token will carry `org_id`. */
  | { status: 'active' }
  /** Memberships exist and one is being activated. */
  | { status: 'activating' }
  /** More than one club, and nobody has said which. */
  | { status: 'choose'; options: ClubOption[] }
  /** Signed in and genuinely not a member of anything. */
  | { status: 'none' };

/**
 * Resolve the session's active organisation, activating it where that is
 * unambiguous.
 *
 * Returns `choose` rather than guessing when somebody belongs to two clubs.
 * Picking the first alphabetically would work invisibly and be wrong roughly
 * half the time, and the failure is silent — an analyst reading last
 * Saturday's match for a club they do not coach.
 */
export function useOrganisation(): {
  state: OrganisationState;
  activate: (organisationId: string) => void;
} {
  const { isLoaded: authLoaded, orgId } = useAuth();
  const { isLoaded: listLoaded, setActive, userMemberships } = useOrganizationList({
    userMemberships: true,
  });

  const [activating, setActivating] = useState(false);
  /** Guards the one-shot revalidate below against firing on every render. */
  const revalidated = useRef(false);
  // Guards against re-activating on every render while Clerk propagates the
  // change: `orgId` does not update synchronously after `setActive` resolves.
  const attempted = useRef<string | null>(null);

  const memberships = userMemberships?.data ?? [];

  /**
   * Has the membership list actually been fetched?
   *
   * `useOrganizationList().isLoaded` reports that the HOOK is ready, not that
   * the paginated resource behind it has arrived — `userMemberships` opts in to
   * its own fetch, and until that lands `data` is an empty array. Treating
   * "loaded and empty" as final showed "You are not in a club yet" to a member
   * of two clubs, for as long as the request took.
   *
   * That screen is the worst possible thing to show wrongly: it tells somebody
   * correctly invited that they have no access, and the suggested fix — sign
   * out and back in — makes it happen again.
   */
  const membershipsSettled =
    userMemberships !== undefined &&
    userMemberships.isLoading === false &&
    userMemberships.isFetching === false;

  const options: ClubOption[] = memberships.map((m) => ({
    id: m.organization.id,
    // A club with no name set falls back to its id rather than an empty row.
    name: m.organization.name.length > 0 ? m.organization.name : m.organization.id,
  }));

  const activate = (organisationId: string) => {
    if (setActive === undefined) {
      return;
    }
    attempted.current = organisationId;
    setActivating(true);
    void Promise.resolve(setActive({ organization: organisationId })).finally(() => {
      setActivating(false);
    });
  };

  // A membership granted while this device was signed in -- an admin adding
  // somebody from the dashboard, which is how every club is provisioned -- does
  // not reach the client on its own. Clerk caches the organisation list on the
  // session, so the app keeps reporting the state it had at sign-in and the
  // member is told they are in no club until they sign out and back in. That is
  // exactly the instruction the NoClub screen gives, and it is the wrong one.
  //
  // One revalidation per mount, not a subscription: the list changes when an
  // admin acts, which is rare, and polling it would cost a request on every
  // screen for a state that almost never moves.
  useEffect(() => {
    if (!listLoaded || revalidated.current) {
      return;
    }
    revalidated.current = true;
    void userMemberships?.revalidate?.();
  }, [listLoaded, userMemberships]);

  useEffect(() => {
    if (!authLoaded || !listLoaded || setActive === undefined) {
      return;
    }
    if (orgId !== null && orgId !== undefined) {
      return;
    }
    // Exactly one club is the overwhelmingly common case, and activating it is
    // what makes the organisation invisible plumbing rather than a concept a
    // coach has to learn.
    const only = memberships.length === 1 ? memberships[0] : undefined;
    if (only === undefined) {
      return;
    }
    if (attempted.current === only.organization.id) {
      return;
    }
    attempted.current = only.organization.id;
    setActivating(true);
    void Promise.resolve(setActive({ organization: only.organization.id })).finally(() => {
      setActivating(false);
    });
  }, [authLoaded, listLoaded, orgId, memberships, setActive]);

  if (!authLoaded || !listLoaded) {
    return { state: { status: 'loading' }, activate };
  }
  if (orgId !== null && orgId !== undefined) {
    return { state: { status: 'active' }, activate };
  }
  if (activating || (memberships.length === 1 && attempted.current !== null)) {
    return { state: { status: 'activating' }, activate };
  }
  if (memberships.length > 1) {
    return { state: { status: 'choose', options }, activate };
  }
  if (memberships.length === 1) {
    return { state: { status: 'activating' }, activate };
  }
  // Empty AND settled is a genuine orphan. Empty and still fetching is a
  // request in flight, and saying "none" there is a lie with consequences.
  if (!membershipsSettled) {
    return { state: { status: 'loading' }, activate };
  }
  return { state: { status: 'none' }, activate };
}
