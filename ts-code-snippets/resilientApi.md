## Code Review Checklist

Since the two snippets share the same shape (async fetch wrapper with resilience logic), one checklist covers both. I’ve noted where specific items apply to each snippet.

### 1\. Correctness of HTTP handling

-   [ ]  **Is `res.ok` checked?** `fetch` doesn’t throw on 4xx/5xx. Snippet 1 never checks status at all, so a 404 body gets parsed and *cached as a valid user*. Snippet 2 only checks for exactly `500`, missing 502/503/504/429 and ignoring 4xx entirely.
-   [ ]  **Is the response validated before use?** `res.json()` is implicitly `any`, so the `Order[]` / `User` annotations are unchecked assertions. Look for runtime validation (zod, etc.) or at least a shape check.
-   [ ]  **Can `res.json()` itself fail** (empty body, HTML error page)? Is that handled distinctly from network failure?
-   [ ]  **Is the ID/parameter URL-encoded?** `id` and `customerId` are interpolated raw into the URL (path injection, e.g. `../` or `?`). Use `encodeURIComponent`.

### 2\. Error handling

-   [ ]  **Are errors swallowed?** Snippet 1 returns `{} as User` on failure, which lies to the type system and pushes the crash to some distant caller. A function promising `Promise<User>` should throw, not return a fake object.
-   [ ]  **Is the original error preserved?** Snippet 2’s final `throw new Error("failed to fetch orders")` discards the last error. Look for `cause`, or a custom error type.
-   [ ]  **Does the `try` block wrap too much?** In both, the catch covers fetch, parsing, and cache writes together, so unrelated failures get treated as network errors.
-   [ ]  **Is `catch (err)` used?** `err` is unused in both. Is it logged or inspected?
-   [ ]  **Can callers distinguish failure types** (not found vs. server down vs. bad data)?

### 3\. Retry logic (Snippet 2, and the “fallback” in Snippet 1)

-   [ ]  **Does it retry non-retryable errors?** 4xx (other than 408/429) shouldn’t be retried. Here they aren’t thrown, but a thrown parse error *is* retried pointlessly.
-   [ ]  **Backoff:** fixed 1s sleep, no exponential growth and no **jitter** (thundering herd risk).
-   [ ]  **Does it sleep after the final attempt?** Yes in Snippet 2, wasting 1s before throwing.
-   [ ]  **Is `Retry-After` respected** for 429/503?
-   [ ]  **Idempotency:** safe here because these are GETs, but worth confirming the pattern isn’t copied to POSTs.
-   [ ]  **Are constants sensible and configurable?** `MAX_RETRIES`, delay.

### 4\. Timeouts and cancellation

-   [ ]  **Is there a timeout?** Neither uses `AbortController` / `AbortSignal.timeout()`. A hung connection blocks forever, and in Snippet 2 retries never trigger because the first attempt never fails.
-   [ ]  **Can the caller cancel?** Is a signal accepted as a parameter?

### 5\. Caching (Snippet 1)

-   [ ]  **TTL value:** `TTL_MS = 60` is 60 *milliseconds*, almost certainly a bug (intended 60 seconds = `60_000`). Check units and naming.
-   [ ]  **Unbounded growth:** the `Map` never evicts expired entries or caps size, so it’s a memory leak under many distinct IDs. Look for LRU/max size/sweeping.
-   [ ]  **Cache stampede / duplicate in-flight requests:** concurrent calls for the same ID each hit the API. Consider caching the in-flight Promise.
-   [ ]  **Stale-on-error behavior:** serving expired data when the fetch fails is a reasonable pattern, but is it intentional, bounded (max staleness), and signaled to the caller or logged?
-   [ ]  **Poisoned cache:** bad data (error bodies, `{}`) must never be written to the cache. Validate *before* `cache.set`.
-   [ ]  **Module-level shared state:** is a process-global cache acceptable? (Multi-tenant leakage, testing isolation, multi-instance consistency.)
-   [ ]  **Should failures be negatively cached** briefly to avoid hammering a down service?

### 6\. Type safety

-   [ ]  **`as User` casts** and implicit `any` from `res.json()`.
-   [ ]  **Is `status: string` too loose** in `Order`? Consider a union type.
-   [ ]  **`total: number`:** money as floating point? Currency/units unspecified.
-   [ ]  **Are types exported/shared** or duplicated?

### 7\. Observability

-   [ ]  **`console.log` for errors** instead of `console.error` or a real logger.
-   [ ]  **Log messages lack context:** no ID, status code, URL, or the error itself. Snippet 1’s “fetch failed” is nearly useless.
-   [ ]  **PII:** `User` contains email and name. Make sure nothing logs it.
-   [ ]  **Metrics:** retry counts, cache hit rate, fallback usage.

### 8\. Security and config

-   [ ]  **Hardcoded base URL** (`https://api.example.com`). Should be config/env.
-   [ ]  **No auth headers**: is the endpoint really unauthenticated? Authorization checks on whose data is returned (Snippet 2 takes an arbitrary `customerId`).
-   [ ]  **Cached user data and access control:** can one caller read another’s cached entry?

### 9\. API design and maintainability

-   [ ]  **Do the signatures match behavior?** Return type promises a real value; behavior sometimes returns junk.
-   [ ]  **Magic numbers** and naming (`TTL_MS`, `sleep`).
-   [ ]  **Pagination:** does the orders endpoint return all results or a page? Snippet 2 assumes everything fits in one response.
-   [ ]  **Testability:** hard-wired `fetch`, `Date.now()`, and global cache make it difficult to test. Look for injectable dependencies or fake timers.
-   [ ]  **Tests:** are there cases for success, 4xx, 5xx, network error, timeout, retry exhaustion, cache hit/expiry/stale fallback?