/**
 * The language preference, and how it stays in step with the dashboard.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHERE IT LIVES
 * ══════════════════════════════════════════════════════════════════════════
 * Clerk user metadata — `unsafeMetadata.language`. The app and the dashboard
 * authenticate the same Clerk user, so writing it on one makes it visible to
 * the other with no endpoint, no migration, and no schema change. Changing the
 * language on the phone changes it on the dashboard and the reverse, which is
 * the whole ask.
 *
 * "Unsafe" is Clerk's name for client-writable, not for dangerous. It is the
 * correct bucket for a preference with no security consequence;
 * `publicMetadata` is backend-only and would need an endpoint that does not
 * exist. If a language preference ever gains consequences — billing locale,
 * say — it belongs on the backend instead, and `docs/BACKEND-GAPS.md` records
 * that.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  LOCAL IS THE SOURCE OF TRUTH FOR RENDERING. THE ACCOUNT IS THE SYNC.
 * ══════════════════════════════════════════════════════════════════════════
 * PRD §3: the app is used where there is no signal. A preference that reads
 * from the network renders English at a ground to somebody who chose Arabic in
 * the car park, and a preference that WRITES to the network fails silently
 * when they change it there.
 *
 * So a change is written to local storage first and applied immediately, then
 * pushed to Clerk. If the push fails the choice still took effect and is
 * retried on the next launch. On launch, a remote value that differs from the
 * local one wins — that is what makes a change on the dashboard arrive — but
 * only after the local one has already rendered.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ARABIC RESTARTS THE APP, AND THAT IS NOT NEGOTIABLE
 * ══════════════════════════════════════════════════════════════════════════
 * `I18nManager.forceRTL` is read once at startup. Flipping it mid-session
 * leaves half the layout mirrored and half not — margins swap, flex direction
 * does not, and the result looks like a rendering bug rather than a language
 * change. So switching into or out of Arabic sets the flag, persists the
 * choice, and reloads. `shouldRestart` on the result tells the UI to say so
 * before it happens.
 */

import { useUser } from '@clerk/clerk-expo';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Localization from 'expo-localization';
import * as Updates from 'expo-updates';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AppState, I18nManager } from 'react-native';

import {
  DEFAULT_LOCALE,
  isLocale,
  isRtlLocale,
  matchDeviceLocale,
  setActiveLocale,
  translate,
  type Locale,
} from './i18n';

const STORAGE_KEY = 'riseup.language.v1';
/** The key the dashboard must read and write for this to be shared. */
export const CLERK_METADATA_KEY = 'language';

interface I18nContextValue {
  locale: Locale;
  /** Screens use this so a change re-renders them. */
  t: (key: string, vars?: Record<string, string | number>) => string;
  /** True while the first read from storage is in flight. */
  loading: boolean;
  /**
   * Change the language.
   *
   * Resolves `{ restarted }` — false when the direction did not change and the
   * new language is already showing, true when the app is about to reload.
   */
  setLocale: (locale: Locale) => Promise<{ restarted: boolean }>;
  /** True when the last sync to the account failed and is pending a retry. */
  syncPending: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function useI18n(): I18nContextValue {
  const ctx = use(I18nContext);
  if (ctx === null) {
    throw new Error('useI18n called outside I18nProvider');
  }
  return ctx;
}

async function readStored(): Promise<Locale | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return raw !== null && isLocale(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const { user, isLoaded: userLoaded } = useUser();
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [loading, setLoading] = useState(true);
  const [syncPending, setSyncPending] = useState(false);

  // First paint: stored choice, else whatever the phone is set to. Following
  // the device is the right default — somebody whose phone is in French did
  // not choose English, they simply have not been asked yet.
  //
  // `expo-localization` IS A NATIVE MODULE and throws when the running binary
  // predates its installation, which is every dev client built before it was
  // added. That failure has to be contained here, and `loading` has to be
  // cleared whatever happens: the sync effect below is gated on it, so an
  // unhandled rejection would leave `loading` true forever and silently kill
  // dashboard-to-app sync while the picker carried on working. The app would
  // look entirely fine and be half broken.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await readStored();
        let resolved = stored;
        if (resolved === null) {
          try {
            resolved = matchDeviceLocale(
              Localization.getLocales().map((l) => l.languageTag),
            );
          } catch {
            // No native module. English until the user picks, which is the
            // same outcome as a device set to a language we do not carry.
            resolved = DEFAULT_LOCALE;
          }
        }
        if (!cancelled) {
          setActiveLocale(resolved);
          setLocaleState(resolved);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The account is the sync channel. A value set on the dashboard arrives here
  // on the next launch — after local has already rendered, so nothing waits on
  // the network.
  useEffect(() => {
    if (!userLoaded || user === null || user === undefined || loading) {
      return;
    }
    const remote = user.unsafeMetadata?.[CLERK_METADATA_KEY];
    if (typeof remote !== 'string' || !isLocale(remote) || remote === locale) {
      return;
    }
    // Remote differs. Adopt it, and persist so the next cold start is instant.
    void AsyncStorage.setItem(STORAGE_KEY, remote).catch(() => {});
    setActiveLocale(remote);
    setLocaleState(remote);

    // A direction change arriving from the dashboard still needs the restart;
    // it is not a special case just because the user did not tap it here.
    if (isRtlLocale(remote) !== I18nManager.isRTL) {
      I18nManager.allowRTL(isRtlLocale(remote));
      I18nManager.forceRTL(isRtlLocale(remote));
      void Updates.reloadAsync().catch(() => {});
    }
  }, [userLoaded, user, loading, locale]);

  // A change made on the dashboard while the app is open would otherwise wait
  // for the next cold start. Clerk caches the user object, so it has to be
  // asked to refetch — and the moment to do that is when the app comes back to
  // the foreground, which is exactly when somebody has just switched over from
  // the dashboard on another device.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        // Failure is silent on purpose: this runs on every foreground, and a
        // ground with no signal must not produce an error for a preference.
        void user?.reload().catch(() => {});
      }
    });
    return () => {
      sub.remove();
    };
  }, [user]);

  const setLocale = useCallback(
    async (next: Locale): Promise<{ restarted: boolean }> => {
      // Local first, and applied immediately. Everything after this point can
      // fail without the user's choice being lost.
      await AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
      setActiveLocale(next);
      setLocaleState(next);

      // Push to the account. A failure is remembered, not surfaced as an
      // error — the language changed, which is what was asked for.
      setSyncPending(false);
      try {
        await user?.update({
          unsafeMetadata: { ...(user.unsafeMetadata ?? {}), [CLERK_METADATA_KEY]: next },
        });
      } catch {
        setSyncPending(true);
      }

      const needsRtl = isRtlLocale(next);
      if (needsRtl !== I18nManager.isRTL) {
        I18nManager.allowRTL(needsRtl);
        I18nManager.forceRTL(needsRtl);
        // Reload rather than restart the process: it re-runs the JS with the
        // new direction and keeps everything already written to storage.
        await Updates.reloadAsync();
        return { restarted: true };
      }
      return { restarted: false };
    },
    [user],
  );

  // `locale` is in the dependency list so every consumer re-renders on a
  // change. Without it the lookup would return new strings that nothing asked
  // React to draw.
  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      t: (key, vars) => translate(key, vars),
      loading,
      setLocale,
      syncPending,
    }),
    [locale, loading, setLocale, syncPending],
  );

  return <I18nContext value={value}>{children}</I18nContext>;
}
