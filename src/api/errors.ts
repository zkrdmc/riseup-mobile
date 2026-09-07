/**
 * API errors.
 *
 * PRD §8.3 asks that every error carry "a stable machine code plus a human
 * string the app can show directly". The backend does not do that yet — it
 * returns FastAPI's `{"detail": "..."}`, where the detail is sometimes a
 * sentence a coach could read ("Job 'abc' not found.") and sometimes a
 * validation array.
 *
 * So this module does two things:
 *   1. Defines the envelope the backend should move to, and parses it when it
 *      appears. That work is not wasted — a client that already understands
 *      the shape means the backend change ships without a matching app
 *      release, which matters because app releases go through review.
 *   2. Falls back to mapping HTTP status onto a code and a written sentence,
 *      so no screen ever has to render `detail` raw or, worse, a job id.
 *
 * The rule from §6 applies here as much as to notifications: never surface a
 * failure without something the user can do about it.
 */

/** The envelope the backend should return. Parsed when present. */
export interface ApiErrorBody {
  /** Stable, greppable, never shown as the headline. e.g. `match_not_found`. */
  code: string;
  /** A sentence the app can show directly. Names a cause, not a job id. */
  message: string;
  /** Optional structured context — field errors, retry-after, quota numbers. */
  detail?: unknown;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: unknown;
  /** True when retrying the identical request could plausibly succeed. */
  readonly retryable: boolean;

  constructor(args: {
    code: string;
    message: string;
    status: number;
    detail?: unknown;
    retryable: boolean;
  }) {
    super(args.message);
    this.name = 'ApiError';
    this.code = args.code;
    this.status = args.status;
    this.detail = args.detail;
    this.retryable = args.retryable;
  }
}

/** Raised when the device has no usable connection. Not a server failure. */
export class OfflineError extends ApiError {
  constructor() {
    super({
      code: 'offline',
      message: 'No connection. This will retry when you are back online.',
      status: 0,
      retryable: true,
    });
    this.name = 'OfflineError';
  }
}

/**
 * Status → (code, sentence). The fallback when the response is not in the
 * envelope shape.
 *
 * These sentences are written for a coach standing on a touchline, which is
 * the whole reason they live in one place: a 402 rendered as "Payment Required"
 * by whichever screen hit it first is how an app teaches people to distrust it.
 */
const byStatus: Record<number, { code: string; message: string; retryable: boolean }> = {
  400: {
    code: 'bad_request',
    message: 'The app sent something the server could not read. Please report this.',
    retryable: false,
  },
  401: {
    code: 'unauthenticated',
    message: 'Your session has expired. Sign in again to continue.',
    retryable: false,
  },
  403: {
    code: 'forbidden',
    message: 'Your account does not have access to this. Ask a club admin.',
    retryable: false,
  },
  404: {
    code: 'not_found',
    message: 'This is no longer here. It may have been deleted.',
    retryable: false,
  },
  409: {
    code: 'conflict',
    message: 'Another upload is already running for your club. It has to finish first.',
    retryable: true,
  },
  413: {
    code: 'too_large',
    message: 'That file is too large for this upload path.',
    retryable: false,
  },
  429: {
    code: 'rate_limited',
    message: 'Too many requests. Waiting a moment before trying again.',
    retryable: true,
  },
  500: {
    code: 'server_error',
    message: 'Something went wrong on our side. It has been logged.',
    retryable: true,
  },
  502: { code: 'bad_gateway', message: 'The server is unreachable right now.', retryable: true },
  503: { code: 'unavailable', message: 'The server is unavailable right now.', retryable: true },
  504: { code: 'timeout', message: 'The server took too long to answer.', retryable: true },
};

function looksLikeEnvelope(body: unknown): body is ApiErrorBody {
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof (body as ApiErrorBody).code === 'string' &&
    typeof (body as ApiErrorBody).message === 'string'
  );
}

/**
 * Build an ApiError from a failed response.
 *
 * `body` is whatever came back — already parsed if it was JSON, otherwise the
 * raw text, otherwise undefined. Parsing failures are not an error path here:
 * a gateway returning an HTML error page is a normal thing to survive.
 */
export function toApiError(status: number, body: unknown): ApiError {
  if (looksLikeEnvelope(body)) {
    const fallback = byStatus[status];
    return new ApiError({
      code: body.code,
      message: body.message,
      status,
      detail: body.detail,
      retryable: fallback?.retryable ?? status >= 500,
    });
  }

  const mapped = byStatus[status] ?? {
    code: `http_${status}`,
    message: 'Something went wrong.',
    retryable: status >= 500,
  };

  // FastAPI's `{"detail": "..."}`. Keep it as structured context for support,
  // but do not promote it to the message: it is written for a developer.
  const detail =
    typeof body === 'object' && body !== null && 'detail' in body
      ? (body as { detail: unknown }).detail
      : body;

  return new ApiError({ ...mapped, status, detail });
}

/**
 * Signed in, but not a member of any club.
 *
 * A distinct condition from a normal 403, and the app has to treat it as one.
 * `clerk_auth.py` derives club_id from the token's org_id and returns 403 on
 * EVERY endpoint when it is absent, so an account in this state can sign in
 * and then finds the whole app broken — no matches, no uploads, no settings.
 *
 * It happens more often than it sounds: an invitation that was never accepted,
 * a member removed from the organisation, an account created on the dashboard
 * but never added to a club, or a social sign-in whose email did not match an
 * existing invitation and so minted a brand-new user.
 *
 * DETECTED ON THE MESSAGE, WHICH IS FRAGILE and is why gap 7 asks for a stable
 * machine code. The string is matched loosely — any 403 mentioning an
 * organisation — so a rewording of the sentence does not silently turn this
 * back into a generic permission error.
 */
export function isNoClubError(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 403) {
    return false;
  }
  if (e.code === 'no_organisation' || e.code === 'no_organization') {
    return true;
  }
  const detail = typeof e.detail === 'string' ? e.detail.toLowerCase() : '';
  return detail.includes('organisation') || detail.includes('organization');
}

/** True when the caller should surface a "sign in again" flow rather than a retry. */
export function isAuthError(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 401 || e.status === 403);
}
