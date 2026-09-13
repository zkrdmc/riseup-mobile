/**
 * A promise that cannot hang forever.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THIS KEEPS BEING NEEDED
 * ══════════════════════════════════════════════════════════════════════════
 * Twice now, a Clerk call has simply never settled, and both times the symptom
 * was the same shape: something spins and nothing ever happens.
 *
 *   - `getToken()` was awaited before the request's own abort timer existed,
 *     so a token that never arrived hung EVERY api call in the app at once,
 *     with `status=pending fetchStatus=fetching error=none` forever.
 *
 *   - `signIn.create()` never settled, so the Continue button on the sign-in
 *     screen went busy and stayed busy. `setBusy(false)` was in a `finally`,
 *     which is correct and useless: a `finally` cannot run for an `await` that
 *     does not return.
 *
 * A hang is the worst failure available. It is indistinguishable from slow, so
 * nobody reports it as broken until they have waited long enough to be angry,
 * and it produces no error, no log line and nothing to act on.
 *
 * So: every call that leaves this process and can block a person gets a
 * budget. The budget is not a retry policy or a guess at latency — it is the
 * promise that the UI will always resolve into something a person can respond
 * to, even when the thing it is waiting on never answers.
 *
 * Pure and dependency-free, so the smoke suite compiles it.
 */

/**
 * Distinguishable from a network error on purpose.
 *
 * "The server said no" and "the server said nothing" need different copy: the
 * first is usually about the request, the second is always about reaching it.
 */
export class TimeoutError extends Error {
  readonly what: string;
  readonly budgetMs: number;

  constructor(what: string, budgetMs: number) {
    super(`${what} did not answer within ${Math.round(budgetMs / 1000)}s.`);
    this.name = 'TimeoutError';
    this.what = what;
    this.budgetMs = budgetMs;
  }
}

export function isTimeoutError(e: unknown): e is TimeoutError {
  // Structural, not `instanceof`: a bundle can contain two copies of a module
  // and `instanceof` quietly stops matching across them. The same reason
  // `clerkMessage` identifies ClerkError structurally.
  return (
    typeof e === 'object'
    && e !== null
    && (e as { name?: unknown }).name === 'TimeoutError'
  );
}

/**
 * Resolve with `work`, or reject once the budget is spent.
 *
 * REJECTS RATHER THAN RESOLVING A SENTINEL. A caller that must keep going with
 * a missing value can catch; a caller that must not proceed cannot accidentally
 * treat "no answer" as an answer. `tokenWithin` in the API client makes the
 * opposite choice deliberately, because a request with no token is still a
 * meaningful request that earns a real 401.
 *
 * The timer is always cleared, including on the happy path, so a long-lived
 * screen does not accumulate pending timers.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  budgetMs: number,
  what: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new TimeoutError(what, budgetMs));
        }, budgetMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/**
 * How long a person will wait for a button before deciding it is broken.
 *
 * Fifteen seconds is past the point where anybody is still hopeful, and well
 * past a healthy round trip to Clerk — which is under two. It is deliberately
 * longer than the API client's token budget: this one is user-initiated, so a
 * false timeout costs a retry the person has to perform.
 */
export const INTERACTIVE_BUDGET_MS = 15_000;
