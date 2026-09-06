/**
 * Analyst vs Operator.
 *
 * PRD §2 asks the home screen to be role-aware: an Operator opens directly
 * into capture, an Analyst into the match list, and somebody who is both
 * switches without being asked every time.
 *
 * THE PROBLEM: this role does not exist anywhere yet. Clerk carries
 * `org:admin | org:analyst | org:viewer`, which are dashboard PERMISSIONS —
 * who may delete a match, who may only read. They are orthogonal to the
 * question this app asks, which is "are you here to film or to look". A kit
 * man who films every week and never opens the dashboard would be `org:viewer`
 * and must land on capture; a head coach is `org:admin` and must not.
 *
 * Deriving one from the other would be wrong in both directions, so this
 * module keeps them separate and stores the app role on the device:
 *
 *   - It is a per-DEVICE fact, and that is the honest reading. The club phone
 *     bolted to a tripod is an Operator device; the coach's own phone is an
 *     Analyst device. The same person using both wants different homes.
 *   - It needs no backend change to ship v0.1.
 *   - It works offline, which the Clerk claim would not: a role read from a
 *     token cannot be refreshed at a ground with no signal (§3).
 *
 * WHEN THIS SHOULD MOVE. If PRD open question 1 resolves toward a shared club
 * device with a pairing code, the role becomes a property of the device
 * registration and belongs on the server. Until that is decided, a local
 * preference is the smaller commitment — and the one that is cheaper to undo.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useState } from 'react';

export type AppRole = 'analyst' | 'operator';

const STORAGE_KEY = 'riseup.appRole';

/**
 * Analyst, until somebody says otherwise.
 *
 * The failure modes are not symmetric. An Analyst dropped into capture sees a
 * screen full of rig setup they will never use and has to go find the match
 * list. An Operator dropped into the match list sees a familiar list and taps
 * one tab. Defaulting to the second costs less.
 */
const DEFAULT_ROLE: AppRole = 'analyst';

function isAppRole(value: string | null): value is AppRole {
  return value === 'analyst' || value === 'operator';
}

export function useAppRole() {
  const [role, setRoleState] = useState<AppRole>(DEFAULT_ROLE);
  /**
   * Distinct from `role === DEFAULT_ROLE`. Routing on a default that has not
   * been read yet would flash the match list at an Operator on every cold
   * start, which is exactly the "make them choose every time" feeling §2 asks
   * us to avoid — just expressed as a flicker instead of a prompt.
   */
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => {
        if (cancelled) {
          return;
        }
        if (isAppRole(stored)) {
          setRoleState(stored);
        }
      })
      .catch(() => {
        // An unreadable preference is not worth blocking a launch over.
      })
      .finally(() => {
        if (!cancelled) {
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setRole = useCallback((next: AppRole) => {
    setRoleState(next);
    void AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {
      // The switch still applies for this launch; it just will not persist.
    });
  }, []);

  return { role, setRole, loaded };
}

/** Where the app opens. §2: role-aware, and not a question asked every time. */
export function homeRouteFor(role: AppRole): '/capture' | '/' {
  return role === 'operator' ? '/capture' : '/';
}
