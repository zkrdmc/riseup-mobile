/**
 * Loading a native-backed module that the running binary might not contain.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE FAILURE THIS EXISTS TO STOP
 * ══════════════════════════════════════════════════════════════════════════
 * A development client is a compiled binary. The JavaScript it runs is served
 * fresh from Metro, so JS added today runs on a binary built last month — but
 * a NATIVE module added today is not in that binary, and asking for it throws:
 *
 *     Uncaught Error: Cannot find native module 'ExpoLocalization'
 *
 * That alone would be survivable. What makes it fatal is WHERE it throws. A
 * static `import` is hoisted and evaluated before any statement in the
 * importing module runs, so the throw happens during module initialisation —
 * and because expo-router imports every route file to build its route tree,
 * one missing native module in one leaf screen takes down the entire
 * application before the first frame. A try/catch inside a function, or inside
 * an effect, never gets the chance to run.
 *
 * This happened for real: `expo-localization` was added for the language
 * preference, and the app stopped booting on every dev client built before it.
 * The guard in `i18n/store.tsx` was correct and useless, because it sat inside
 * a `useEffect` that was never reached.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY require() AND NOT import()
 * ══════════════════════════════════════════════════════════════════════════
 * `require` is evaluated where it is written, so it can be wrapped. Dynamic
 * `import()` returns a promise and would make every caller async for no
 * benefit — the module is either in the binary or it is not, and that is known
 * synchronously.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THIS IS NOT A SUBSTITUTE FOR REBUILDING
 * ══════════════════════════════════════════════════════════════════════════
 * A module that is absent does not work. The point is that the feature it
 * backs degrades — a language falls back to English, an import button explains
 * itself — instead of the app failing to start. `missingNativeModules()` is
 * what a screen uses to say plainly that a rebuild is needed, rather than
 * leaving somebody to guess why a button does nothing.
 */

/** Modules asked for that were not in the binary. Reported, not swallowed. */
const missing = new Set<string>();

/**
 * Require a native-backed module, or null if this binary does not have it.
 *
 * The `loader` is a thunk rather than a module name so the bundler can still
 * see a static `require` and include the module in the bundle — passing a
 * variable would defeat Metro's dependency graph and the module would be
 * missing from every build, not just old ones.
 */
export function optionalNative<T>(name: string, loader: () => T): T | null {
  try {
    const mod = loader();
    // A module can resolve and still have no native side, in which case its
    // methods throw on first use rather than at import. Callers guard their
    // own calls; this only promises the import did not blow up.
    return mod ?? null;
  } catch {
    missing.add(name);
    return null;
  }
}

/**
 * Which native modules this binary is missing.
 *
 * Only populated once something has tried to load them, which is deliberate:
 * a list of every module the app could theoretically want would be noise. This
 * is the list of things actually reached for and not found.
 */
export function missingNativeModules(): string[] {
  return [...missing].sort();
}

/**
 * One sentence for a screen to show when a feature is unavailable for this
 * reason, rather than appearing broken.
 */
export function rebuildHint(feature: string): string {
  const absent = missingNativeModules();
  const which = absent.length > 0 ? ` (${absent.join(', ')})` : '';
  return (
    `${feature} needs part of the app that this build does not include${which}. ` +
    `Install the latest development build and it will work.`
  );
}
