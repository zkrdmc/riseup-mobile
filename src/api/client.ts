/**
 * The HTTP client.
 *
 * One place where every request to riseup-backend is shaped, so the four
 * cross-cutting requirements in PRD §8.3 are structural rather than something
 * each call site has to remember.
 *
 *   IDEMPOTENCY KEYS on every mutating request. A phone on club Wi-Fi retries;
 *   without a key, a retried `POST /videos/upload-url` mints a second job and
 *   the club is billed twice for one match. The backend does not honour the
 *   header yet — see `docs/BACKEND-GAPS.md` — but the client sending it from
 *   day one means the server-side change needs no app release, and app
 *   releases go through review.
 *
 *   ETAGS on reads. The app polls on foreground. A match summary that has not
 *   changed should cost a 304 and no body. Same argument: `If-None-Match` is
 *   sent now, the 304 branch is implemented now, and the backend can start
 *   returning ETags whenever it likes.
 *
 *   TIMEOUTS. `fetch` has none. A request against a captive portal at a
 *   municipal ground hangs until the OS gives up, which on Android can be
 *   minutes, and the screen spins the whole time.
 *
 *   ERROR SHAPE. Every failure leaves here as an ApiError with a code and a
 *   sentence. No screen ever sees a raw status or a `detail` string.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: retry. React Query owns retry policy,
 * and a client that also retried would multiply the two.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

import { ApiError, OfflineError, toApiError } from './errors';

/** Cache of the last successful body per URL, keyed alongside its ETag. */
interface CacheEntry {
  etag: string;
  body: unknown;
}

const ETAG_PREFIX = 'riseup.etag.';
const DEFAULT_TIMEOUT_MS = 15_000;

export interface ApiClientOptions {
  baseUrl: string;
  /**
   * Returns a fresh Clerk JWT, or null when signed out.
   *
   * Clerk's tokens have a 60-second TTL by default, so this MUST be called per
   * request rather than captured once. Caching the string is the bug that
   * makes the app work for a minute after launch and 401 forever after.
   */
  getToken: () => Promise<string | null>;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Sent as query string. Undefined values are dropped, not sent as "undefined". */
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  /**
   * Reuse a caller-supplied idempotency key. Pass this when retrying a
   * mutation ACROSS app launches — a new key on a retry defeats the purpose.
   */
  idempotencyKey?: string;
  /** Opt out of the ETag path for a read that must be fresh. */
  noCache?: boolean;
  signal?: AbortSignal;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly getToken: () => Promise<string | null>;
  /** Hydrated lazily from AsyncStorage; write-through on every 200. */
  private readonly etags = new Map<string, CacheEntry>();

  constructor({ baseUrl, getToken }: ApiClientOptions) {
    // A trailing slash here produces `//api/v1/me`, which some proxies 404 and
    // others silently redirect — losing the Authorization header on the way.
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.getToken = getToken;
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const {
      method = 'GET',
      body,
      query,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      idempotencyKey,
      noCache = false,
      signal,
    } = options;

    const url = this.buildUrl(path, query);
    const isRead = method === 'GET';
    const cacheKey = isRead && !noCache ? url : null;

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };

    const token = await this.getToken();
    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    // Every mutation, not just the ones we currently expect to retry. A key on
    // some POSTs and not others is a rule nobody can apply consistently later.
    if (!isRead) {
      headers['Idempotency-Key'] = idempotencyKey ?? Crypto.randomUUID();
    }

    let cached: CacheEntry | null = null;
    if (cacheKey !== null) {
      cached = await this.readCache(cacheKey);
      if (cached !== null) {
        headers['If-None-Match'] = cached.etag;
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (signal !== undefined) {
      signal.addEventListener('abort', () => controller.abort(), { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (cause) {
      // A TypeError from fetch is the platform's way of saying "no network".
      // An AbortError is our own timeout. Both are the same thing to a caller
      // standing at a ground with no signal: not the server's fault, retryable.
      throw new OfflineError(this.hostLabel());
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 304 && cached !== null) {
      return cached.body as T;
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const payload = await this.parseBody(response);

    if (!response.ok) {
      throw toApiError(response.status, payload);
    }

    if (cacheKey !== null) {
      const etag = response.headers.get('etag');
      if (etag !== null) {
        await this.writeCache(cacheKey, { etag, body: payload });
      }
    }

    return payload as T;
  }

  /** Host and port of `baseUrl`, for an error that says what it could not reach. */
  private hostLabel(): string {
    const withoutScheme = this.baseUrl.replace(/^https?:\/\//, '');
    return withoutScheme.split('/')[0] ?? this.baseUrl;
  }

  get<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(path, { ...options, method: 'GET' });
  }

  post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method'>): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  patch<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method'>): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  delete<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  /**
   * Multipart upload straight to the API — the `direct` path.
   *
   * Separate from `request` because it must NOT set Content-Type: the runtime
   * has to write the multipart boundary itself, and a hand-set header produces
   * a body the server cannot parse with an error that does not mention headers.
   */
  async upload<T>(
    path: string,
    file: { uri: string; name: string; type: string },
    options: { fieldName?: string; timeoutMs?: number; idempotencyKey?: string } = {},
  ): Promise<T> {
    const { fieldName = 'file', timeoutMs = 600_000, idempotencyKey } = options;

    const form = new FormData();
    // React Native accepts this shape for a local file URI; the DOM type does
    // not describe it, hence the cast.
    form.append(fieldName, { uri: file.uri, name: file.name, type: file.type } as unknown as Blob);

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Idempotency-Key': idempotencyKey ?? Crypto.randomUUID(),
    };
    const token = await this.getToken();
    if (token !== null) {
      headers.Authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.buildUrl(path), {
        method: 'POST',
        headers,
        body: form,
        signal: controller.signal,
      });
    } catch {
      throw new OfflineError(this.hostLabel());
    } finally {
      clearTimeout(timer);
    }

    const payload = await this.parseBody(response);
    if (!response.ok) {
      throw toApiError(response.status, payload);
    }
    return payload as T;
  }

  /** Clear every cached body. Call on sign-out — the cache is tenant-scoped data. */
  async clearCache(): Promise<void> {
    this.etags.clear();
    const keys = await AsyncStorage.getAllKeys();
    const ours = keys.filter((k) => k.startsWith(ETAG_PREFIX));
    if (ours.length > 0) {
      await AsyncStorage.multiRemove(ours);
    }
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const url = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (query === undefined) {
      return url;
    }
    const parts: string[] = [];
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) {
        continue;
      }
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    }
    return parts.length === 0 ? url : `${url}?${parts.join('&')}`;
  }

  private async parseBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      // An HTML error page from a proxy, or a captive portal's login form.
      return text;
    }
  }

  private async readCache(key: string): Promise<CacheEntry | null> {
    const inMemory = this.etags.get(key);
    if (inMemory !== undefined) {
      return inMemory;
    }
    try {
      const raw = await AsyncStorage.getItem(ETAG_PREFIX + key);
      if (raw === null) {
        return null;
      }
      const entry = JSON.parse(raw) as CacheEntry;
      this.etags.set(key, entry);
      return entry;
    } catch {
      // A corrupt cache entry must never break a request. Treat it as a miss.
      return null;
    }
  }

  private async writeCache(key: string, entry: CacheEntry): Promise<void> {
    this.etags.set(key, entry);
    try {
      await AsyncStorage.setItem(ETAG_PREFIX + key, JSON.stringify(entry));
    } catch {
      // Storage full, or the entry is larger than the platform allows. The
      // request already succeeded; losing the cache is not worth failing it.
    }
  }
}

export { ApiError, OfflineError };
