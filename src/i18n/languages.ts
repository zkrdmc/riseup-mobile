/**
 * The languages RiseUp speaks.
 *
 * Chosen for where the product is used rather than for coverage. Moroccan
 * clubs work in French and Arabic; English is what the app was written in and
 * what the dashboard currently shows, so it stays as the fallback and as a
 * language in its own right.
 *
 * DARIJA IS DELIBERATELY ABSENT. It is what people actually speak, and it has
 * no settled written form — the same word appears in Arabic script, in Latin
 * script, and in Arabizi with digits, depending on who is typing. A UI in one
 * of those is unreadable to somebody expecting another, and nobody reads
 * Darija in a menu. Modern Standard Arabic is what is read.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  ARABIC IS RIGHT-TO-LEFT, AND IN REACT NATIVE THAT IS NOT A STYLE CHANGE
 * ══════════════════════════════════════════════════════════════════════════
 * `I18nManager.forceRTL` takes effect only after the app restarts. There is no
 * live flip: the layout engine reads the direction once at startup, and
 * changing it mid-session leaves half the screen mirrored and half not. So
 * switching to or from Arabic has to restart the app, and the UI has to say so
 * before it happens rather than appearing to crash.
 */

export type LanguageCode = 'en' | 'fr' | 'ar';

export interface Language {
  code: LanguageCode;
  /** In the language itself. A list of languages written in English is useless
   *  to somebody who cannot read English — which is the whole point. */
  endonym: string;
  /** For the settings row, in the language currently shown. */
  englishName: string;
  rtl: boolean;
  /** BCP 47, for Intl formatters and for the `Accept-Language` header. */
  tag: string;
}

export const LANGUAGES: readonly Language[] = [
  { code: 'en', endonym: 'English', englishName: 'English', rtl: false, tag: 'en' },
  { code: 'fr', endonym: 'Français', englishName: 'French', rtl: false, tag: 'fr' },
  { code: 'ar', endonym: 'العربية', englishName: 'Arabic', rtl: true, tag: 'ar' },
];

/**
 * English, and it is the fallback for every missing string.
 *
 * A missing translation must render the English rather than the key. A screen
 * showing `settings.deleteAccount` is broken; a screen showing "Delete my
 * account" in the wrong language is merely untranslated, and an operator can
 * still act on it.
 */
export const DEFAULT_LANGUAGE: LanguageCode = 'en';

export function languageByCode(code: string): Language | null {
  return LANGUAGES.find((l) => l.code === code) ?? null;
}

export function isRtl(code: LanguageCode): boolean {
  return languageByCode(code)?.rtl ?? false;
}

/**
 * The best match for a device locale.
 *
 * Matches on the language subtag only: `fr-MA`, `fr-FR` and `fr` all mean
 * French here. Region matters for date and number formatting — which `Intl`
 * handles from the full tag — and not for which strings to show.
 */
export function matchDeviceLocale(locales: readonly string[]): LanguageCode {
  for (const locale of locales) {
    const subtag = locale.split('-')[0]?.toLowerCase();
    const match = LANGUAGES.find((l) => l.code === subtag);
    if (match !== undefined) {
      return match.code;
    }
  }
  return DEFAULT_LANGUAGE;
}
