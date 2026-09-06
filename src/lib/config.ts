/**
 * Runtime configuration.
 *
 * Read from `EXPO_PUBLIC_*` environment variables, which Metro inlines at
 * build time. Nothing secret goes here — a Clerk publishable key and an API
 * host are both public by design, and anything that is not public has no
 * business on a device at all (§11).
 *
 * Missing config fails LOUDLY at startup rather than producing a sign-in
 * screen that silently does nothing. An app that boots to a dead button is
 * harder to diagnose than one that refuses to boot and says which variable is
 * absent.
 */

function required(name: string, value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in, then restart Metro ` +
        `with --clear (EXPO_PUBLIC_* values are inlined at build time and survive a reload).`,
    );
  }
  return value;
}

export const config = {
  /** e.g. https://api.riseupai.co, or http://192.168.1.x:8000 in development. */
  apiUrl: required('EXPO_PUBLIC_API_URL', process.env.EXPO_PUBLIC_API_URL),
  clerkPublishableKey: required(
    'EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY',
    process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY,
  ),
} as const;
