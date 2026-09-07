/* ── FILE: src/i18n/i18n.ts ────────────────────────────────────────────── */
/* ─────────────────────────────────────────────────────────────────────────────
   Locale handling.

   The DICTIONARY FORMAT is the website's: `riseup-website/src/lib/i18n.ts`
   uses a flat `Dict` of dotted, namespaced keys with `{placeholder}`
   interpolation, and this matches it exactly — same keys where a string exists
   on both, same braces — so the two can be reconciled by a script rather than
   by eye, and so a string never interpolates differently on two platforms.

   THE LOOKUP IS A LIBRARY, and here the app deliberately parts company with the
   site. The website hand-rolls an eight-line `translate()` and argues,
   correctly for itself, that a dictionary and a lookup are the whole feature.
   That argument holds for English and French. It breaks on Arabic.

   Arabic has SIX plural categories — zero, one, two, few, many, other — where
   English has two and French effectively has two. "2 matches" and "11 matches"
   and "100 matches" take three different noun forms, and no amount of care in a
   hand-written lookup gets that right. i18n-js ships the CLDR machinery for it
   and lets the rule be registered per locale, which is the reliability the
   hand-rolled version cannot offer at any length.

   So: the library does the lookup, and it is configured to speak the website's
   format rather than its own.

   ── WHERE THIS DIFFERS FROM THE WEB, AND WHY ──────────────────────────────
   The web takes its locale from the URL, correctly: a shared link must render
   the same language for everyone, and a crawler needs a stable address per
   language. An app has no URL and no crawler. Its constraint is that the
   choice must survive being offline at a ground, so local storage is the
   source of truth and the account is the sync channel. See `store.ts`.
   ───────────────────────────────────────────────────────────────────────────── */

import { I18n } from 'i18n-js';

import { ar, en, fr } from './dictionaries';

export const LOCALES = ['en', 'fr', 'ar'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(v: string): v is Locale {
  return (LOCALES as readonly string[]).includes(v);
}

export interface LanguageOption {
  code: Locale;
  /** In the language itself. A list written in English is useless to somebody
   *  who cannot read English, which is the entire point of the list. */
  endonym: string;
  rtl: boolean;
  /** BCP 47, for `Intl` formatters and the `Accept-Language` header. */
  tag: string;
}

export const LANGUAGES: readonly LanguageOption[] = [
  { code: 'en', endonym: 'English', rtl: false, tag: 'en' },
  { code: 'fr', endonym: 'Français', rtl: false, tag: 'fr' },
  { code: 'ar', endonym: 'العربية', rtl: true, tag: 'ar' },
];

export function languageOption(code: Locale): LanguageOption {
  return LANGUAGES.find((l) => l.code === code) ?? (LANGUAGES[0] as LanguageOption);
}

export function isRtlLocale(code: Locale): boolean {
  return languageOption(code).rtl;
}

/**
 * The best match for the device's languages.
 *
 * Matched on the language subtag alone: `fr-MA`, `fr-FR` and `fr` all mean
 * French for the purpose of choosing strings. Region matters for date and
 * number formatting, which `Intl` takes from the full tag, and not for this.
 */
export function matchDeviceLocale(deviceLocales: readonly string[]): Locale {
  for (const locale of deviceLocales) {
    const subtag = locale.split('-')[0]?.toLowerCase();
    if (subtag !== undefined && isLocale(subtag)) {
      return subtag;
    }
  }
  return DEFAULT_LOCALE;
}

export type Dict = Record<string, string>;

export const i18n = new I18n({ en, fr, ar });

/**
 * Match the website's `{placeholder}` syntax.
 *
 * i18n-js defaults to `%{placeholder}`. Left alone, a dictionary written for
 * one platform renders literal braces on the other — the exact failure that
 * sharing a format is meant to prevent, and one that only shows up on the
 * strings that happen to interpolate.
 */
i18n.placeholder = /\{(\w+)\}/g;

/** Requested locale, then English, then the key. Same chain as the website. */
i18n.defaultLocale = DEFAULT_LOCALE;
i18n.enableFallback = true;
i18n.locale = DEFAULT_LOCALE;

/**
 * Arabic plural categories, per CLDR.
 *
 * The reason this file uses a library at all. English and French need one
 * branch; Arabic needs six, and the boundaries are not intuitive — 11 to 99
 * ending in 11-99 is "many", 3 to 10 is "few", and 0 has a form of its own.
 * Written out once here rather than approximated at each call site.
 */
i18n.pluralization.register('ar', (_i18n, count) => {
  if (count === 0) {
    return ['zero'];
  }
  if (count === 1) {
    return ['one'];
  }
  if (count === 2) {
    return ['two'];
  }
  const mod100 = count % 100;
  if (mod100 >= 3 && mod100 <= 10) {
    return ['few'];
  }
  if (mod100 >= 11 && mod100 <= 99) {
    return ['many'];
  }
  return ['other'];
});

/** Point the lookup at a locale. Called by the store, not by screens. */
export function setActiveLocale(locale: Locale): void {
  i18n.locale = locale;
}

/**
 * Look up a string.
 *
 * Screens call the `t` from `useI18n()` rather than this, so a language change
 * re-renders them. This exists for the handful of places outside React —
 * notification payloads, and anything formatting a string for a support email.
 */
export function translate(
  key: string,
  vars?: Record<string, string | number>,
): string {
  return i18n.t(key, vars);
}

/**
 * Keys present in English and missing from another locale.
 *
 * The job the website's `npm run i18n:extract` does, as a function so the
 * smoke suite can assert the gap rather than a person remembering to look.
 */
export function missingKeys(locale: Locale): string[] {
  const source = { en, fr, ar }[locale];
  return Object.keys(en).filter((k) => source[k] === undefined);
}

export function keyCount(locale: Locale): number {
  return Object.keys({ en, fr, ar }[locale]).length;
}
