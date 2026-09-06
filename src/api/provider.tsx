/**
 * Wires the ApiClient to Clerk's session, and React Query to the app.
 *
 * The client is built once and memoised on `getToken`'s identity, not
 * rebuilt per render: the ETag cache lives on the instance, and a client
 * recreated on every render is a cache that never hits.
 */

import { useAuth } from '@clerk/clerk-expo';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createContext, use, useMemo, useRef, type ReactNode } from 'react';

import { ApiClient } from './client';
import { ApiError } from './errors';

const ApiContext = createContext<ApiClient | null>(null);

export function useApi(): ApiClient {
  const client = use(ApiContext);
  if (client === null) {
    throw new Error('useApi called outside ApiProvider');
  }
  return client;
}

/**
 * Query defaults, and the reasoning for each.
 *
 * `retry` — never retry a 4xx. A 401 retried three times is three more
 * requests that will fail identically, and it delays the sign-in prompt by
 * several seconds while the screen sits on a spinner.
 *
 * `staleTime` — 30 seconds. The app polls on foreground (§8.3); anything
 * shorter turns a tab switch into a burst of requests on a connection that
 * may be a coach's phone data.
 *
 * `refetchOnReconnect` — on. This is the whole reason the offline story
 * works: a screen opened at a ground with no signal shows its error state,
 * and fills itself in when the phone finds a bar without the user doing
 * anything.
 */
function buildQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 30 * 60_000,
        refetchOnReconnect: true,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && !error.retryable) {
            return false;
          }
          return failureCount < 2;
        },
        retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      },
      mutations: {
        // A mutation is not retried automatically. Every one of ours creates
        // or changes something, and the idempotency key that would make a
        // retry safe is not honoured server-side yet.
        retry: false,
      },
    },
  });
}

export function ApiProvider({ baseUrl, children }: { baseUrl: string; children: ReactNode }) {
  const { getToken } = useAuth();

  // `getToken` from Clerk is stable across renders in practice, but the
  // client must survive even if it is not — losing the ETag cache on a token
  // refresh would be a silent performance regression nobody would trace back.
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;

  const client = useMemo(
    () =>
      new ApiClient({
        baseUrl,
        // Clerk's default JWT TTL is 60 seconds, so this is called per
        // request. `getToken()` returns the cached token until it is close to
        // expiry and refreshes silently otherwise.
        getToken: () => getTokenRef.current(),
      }),
    [baseUrl],
  );

  const queryClient = useMemo(buildQueryClient, []);

  return (
    <ApiContext value={client}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </ApiContext>
  );
}
