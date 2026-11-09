/**
 * Reference implementation: getUser (cached) + fetchOrders (retrying),
 * rewritten to satisfy every item in the code-review checklist.
 *
 * Checklist section numbers are referenced as [§N] in comments.
 * Zero runtime dependencies; swap the hand-rolled parsers for zod if you have it.
 */

// ───────────────────────── Types [§6] ─────────────────────────

export type User = { id: string; name: string; email: string };

export const ORDER_STATUSES = ["pending", "paid", "shipped", "cancelled", "refunded"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number]; // union, not `string`

export type Order = {
  id: string;
  /** Integer minor units (cents) to avoid float money bugs. */
  totalMinor: number;
  /** ISO 4217 code, e.g. "USD". Units are never implicit. */
  currency: string;
  status: OrderStatus;
};

export type UserResult = { user: User; stale: boolean };

// ───────────────────────── Config [§8] ─────────────────────────

export interface ApiConfig {
  baseUrl: string; // from env, never hardcoded
  getAuthToken: () => Promise<string>; // auth is explicit
  requestTimeoutMs: number;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxPages: number;
  userCache: { ttlMs: number; maxStaleMs: number; maxEntries: number; failureCooldownMs: number };
}

export function loadConfigFromEnv(
  getAuthToken: () => Promise<string>,
  env: Record<string, string | undefined> = process.env,
): ApiConfig {
  const baseUrl = env.API_BASE_URL;
  if (!baseUrl) throw new Error("API_BASE_URL is required");
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    getAuthToken,
    requestTimeoutMs: 5_000,
    maxAttempts: 3,
    baseDelayMs: 200,
    maxDelayMs: 5_000,
    maxPages: 50,
    userCache: {
      ttlMs: 60_000, // 60 SECONDS (the original had 60 ms) [§5]
      maxStaleMs: 5 * 60_000, // bounded staleness for stale-on-error
      maxEntries: 1_000, // bounded size [§5]
      failureCooldownMs: 5_000, // brief negative caching [§5]
    },
  };
}

// ───────────────────────── Observability [§7] ─────────────────────────

/** Never pass emails/names in ctx. IDs, status codes and error kinds only. */
export interface Logger {
  warn(msg: string, ctx?: Record<string, unknown>): void;
  error(msg: string, ctx?: Record<string, unknown>): void;
}
export interface Metrics {
  increment(name: string, tags?: Record<string, string | number>): void;
}

export const consoleLogger: Logger = {
  warn: (msg, ctx) => console.warn(JSON.stringify({ level: "warn", msg, ...ctx })),
  error: (msg, ctx) => console.error(JSON.stringify({ level: "error", msg, ...ctx })),
};
export const noopMetrics: Metrics = { increment() {} };

// ───────────────────────── Errors [§2] ─────────────────────────

export type ApiErrorKind =
  | "not_found"
  | "unauthorized"
  | "rate_limited"
  | "server"
  | "client"
  | "network"
  | "timeout"
  | "invalid_response"
  | "aborted";

const RETRYABLE: ReadonlySet<ApiErrorKind> = new Set(["rate_limited", "server", "network", "timeout"]);

/** Callers can branch on `kind`; the original error is kept in `cause`. */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    kind: ApiErrorKind,
    status?: number,
    options?: { cause?: unknown; retryAfterMs?: number },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = options?.retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

const toApiError = (err: unknown): ApiError =>
  err instanceof ApiError ? err : new ApiError("Unexpected error", "network", undefined, { cause: err });

// ───────────────────────── Injectable deps [§9 testability] ─────────────────────────

export interface Deps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
  logger: Logger;
  metrics: Metrics;
}

export const defaultSleep: Deps["sleep"] = (ms, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new ApiError("Aborted", "aborted"));
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ApiError("Aborted", "aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export const defaultDeps: Deps = {
  fetch: (...args) => fetch(...args),
  now: () => Date.now(),
  sleep: defaultSleep,
  random: Math.random,
  logger: consoleLogger,
  metrics: noopMetrics,
};

// ───────────────────────── Runtime validation [§1, §6] ─────────────────────────

type Parser<T> = (raw: unknown) => T;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const parseUser: Parser<User> = (raw) => {
  if (!isRecord(raw)) throw new TypeError("user: expected object");
  const { id, name, email } = raw;
  if (typeof id !== "string" || !id) throw new TypeError("user.id invalid");
  if (typeof name !== "string") throw new TypeError("user.name invalid");
  if (typeof email !== "string" || !email.includes("@")) throw new TypeError("user.email invalid");
  return { id, name, email };
};

const parseOrder: Parser<Order> = (raw) => {
  if (!isRecord(raw)) throw new TypeError("order: expected object");
  const { id, totalMinor, currency, status } = raw;
  if (typeof id !== "string" || !id) throw new TypeError("order.id invalid");
  if (!Number.isSafeInteger(totalMinor)) throw new TypeError("order.totalMinor must be an integer");
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) throw new TypeError("order.currency invalid");
  if (!ORDER_STATUSES.includes(status as OrderStatus)) throw new TypeError("order.status invalid");
  return { id, totalMinor: totalMinor as number, currency, status: status as OrderStatus };
};

type OrderPage = { items: Order[]; nextCursor?: string };

const parseOrderPage: Parser<OrderPage> = (raw) => {
  if (!isRecord(raw) || !Array.isArray(raw.items)) throw new TypeError("orders page: expected { items: [] }");
  const nextCursor = raw.nextCursor;
  if (nextCursor !== undefined && nextCursor !== null && typeof nextCursor !== "string") {
    throw new TypeError("orders page: nextCursor invalid");
  }
  return { items: raw.items.map(parseOrder), nextCursor: nextCursor ?? undefined };
};

// ───────────────────────── HTTP core [§1, §3, §4] ─────────────────────────

const parseRetryAfter = (header: string | null, now: number): number | undefined => {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
};

function errorFromStatus(res: Response, now: number): ApiError {
  const { status } = res;
  const msg = `HTTP ${status}`;
  if (status === 404) return new ApiError(msg, "not_found", status);
  if (status === 401 || status === 403) return new ApiError(msg, "unauthorized", status);
  if (status === 408) return new ApiError(msg, "timeout", status);
  if (status === 429 || status === 503) {
    return new ApiError(msg, status === 429 ? "rate_limited" : "server", status, {
      retryAfterMs: parseRetryAfter(res.headers.get("Retry-After"), now),
    });
  }
  if (status >= 500) return new ApiError(msg, "server", status);
  return new ApiError(msg, "client", status); // other 4xx: never retried
}

export function createHttp(cfg: ApiConfig, deps: Deps) {
  const backoffMs = (attempt: number, retryAfterMs?: number): number => {
    const exp = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * 2 ** (attempt - 1));
    const jittered = deps.random() * exp; // full jitter avoids thundering herd
    return Math.min(cfg.maxDelayMs, Math.max(jittered, retryAfterMs ?? 0)); // honor Retry-After
  };

  async function attemptOnce<T>(path: string, parse: Parser<T>, callerSignal?: AbortSignal): Promise<T> {
    let token: string;
    try {
      token = await cfg.getAuthToken();
    } catch (cause) {
      throw new ApiError("Could not obtain auth token", "unauthorized", undefined, { cause });
    }

    const timeoutSignal = AbortSignal.timeout(cfg.requestTimeoutMs); // [§4]
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    // Narrow try blocks [§2]: each failure mode is classified separately.
    let res: Response;
    try {
      res = await deps.fetch(`${cfg.baseUrl}${path}`, {
        signal,
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      });
    } catch (cause) {
      if (callerSignal?.aborted) throw new ApiError("Aborted by caller", "aborted", undefined, { cause });
      if (timeoutSignal.aborted) throw new ApiError("Request timed out", "timeout", undefined, { cause });
      throw new ApiError("Network error", "network", undefined, { cause });
    }

    if (!res.ok) throw errorFromStatus(res, deps.now()); // [§1] check res.ok, not just 500

    let body: unknown;
    try {
      body = await res.json();
    } catch (cause) {
      throw new ApiError("Response was not valid JSON", "invalid_response", res.status, { cause });
    }
    try {
      return parse(body); // validate BEFORE anything can cache it
    } catch (cause) {
      throw new ApiError("Response failed validation", "invalid_response", res.status, { cause });
    }
  }

  async function getJson<T>(path: string, parse: Parser<T>, signal?: AbortSignal): Promise<T> {
    let lastError!: ApiError;
    for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
      try {
        return await attemptOnce(path, parse, signal);
      } catch (err) {
        lastError = toApiError(err);
        deps.logger.warn("api request failed", {
          path: path.split("?")[0], // no query strings / PII in logs
          attempt,
          maxAttempts: cfg.maxAttempts,
          kind: lastError.kind,
          status: lastError.status,
        });
        // Only retry transient failures; never sleep after the final attempt.
        if (!lastError.retryable || attempt === cfg.maxAttempts) break;
        deps.metrics.increment("api.retry", { kind: lastError.kind });
        await deps.sleep(backoffMs(attempt, lastError.retryAfterMs), signal);
      }
    }
    throw lastError; // typed, with the original error preserved in `cause`
  }

  return { getJson };
}

// ───────────────────────── Bounded TTL/LRU cache [§5] ─────────────────────────

class TtlCache<V> {
  private map = new Map<string, { value: V; expiresAt: number }>();
  private o: { maxEntries: number; maxStaleMs: number; now: () => number };

  constructor(o: { maxEntries: number; maxStaleMs: number; now: () => number }) {
    this.o = o;
  }

  get(key: string): { value: V; fresh: boolean } | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    const now = this.o.now();
    if (now >= entry.expiresAt + this.o.maxStaleMs) {
      this.map.delete(key); // too stale to ever serve
      return undefined;
    }
    this.map.delete(key); // LRU touch
    this.map.set(key, entry);
    return { value: entry.value, fresh: now < entry.expiresAt };
  }

  set(key: string, value: V, ttlMs: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: this.o.now() + ttlMs });
    while (this.map.size > this.o.maxEntries) {
      this.map.delete(this.map.keys().next().value as string); // evict least recently used
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }
}

// Lets one caller stop waiting without cancelling a request other callers share.
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new ApiError("Aborted by caller", "aborted"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function assertId(name: string, value: string): void {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new RangeError(`${name} must be a non-empty string up to 128 chars`);
  }
}

// ───────────────────────── Snippet 1: getUser [§5] ─────────────────────────

/**
 * Cache is per-service-instance (not module-global), so create one per
 * tenant/auth context to prevent cross-user leakage, and make tests isolated.
 */
export function createUserService(cfg: ApiConfig, deps: Deps = defaultDeps) {
  const http = createHttp(cfg, deps);
  const c = cfg.userCache;
  const cache = new TtlCache<User>({ maxEntries: c.maxEntries, maxStaleMs: c.maxStaleMs, now: deps.now });
  const failures = new TtlCache<ApiError>({ maxEntries: c.maxEntries, maxStaleMs: 0, now: deps.now });
  const inFlight = new Map<string, Promise<User>>();

  function load(id: string): Promise<User> {
    let p = inFlight.get(id);
    if (!p) {
      p = http
        .getJson(`/users/${encodeURIComponent(id)}`, parseUser) // [§1] encode
        .then((user) => {
          cache.set(id, user, c.ttlMs); // only validated data is ever cached
          failures.delete(id);
          return user;
        })
        .finally(() => inFlight.delete(id));
      inFlight.set(id, p); // concurrent callers share one request
    }
    return p;
  }

  async function getUser(id: string, opts: { signal?: AbortSignal } = {}): Promise<UserResult> {
    assertId("id", id);
    opts.signal?.throwIfAborted();

    const cached = cache.get(id);
    if (cached?.fresh) {
      deps.metrics.increment("user_cache.hit");
      return { user: cached.value, stale: false };
    }
    deps.metrics.increment("user_cache.miss");

    // Short failure cooldown so a down service isn't hammered.
    const recentFailure = failures.get(id);
    if (recentFailure?.fresh) {
      if (cached) return { user: cached.value, stale: true };
      throw recentFailure.value;
    }

    try {
      const user = await abortable(load(id), opts.signal);
      return { user, stale: false };
    } catch (err) {
      const apiErr = toApiError(err);
      if (apiErr.kind === "aborted") throw apiErr;

      if (apiErr.kind === "not_found") {
        cache.delete(id); // the user is gone; don't serve a stale copy
        failures.set(id, apiErr, c.failureCooldownMs);
        throw apiErr;
      }

      // Stale-on-error: only for transient failures, only within maxStaleMs,
      // and always signalled to the caller + logged + counted.
      if (cached && apiErr.retryable) {
        deps.logger.warn("serving stale user", { userId: id, kind: apiErr.kind });
        deps.metrics.increment("user_cache.stale_served");
        failures.set(id, apiErr, c.failureCooldownMs);
        return { user: cached.value, stale: true };
      }

      if (apiErr.retryable) failures.set(id, apiErr, c.failureCooldownMs);
      throw apiErr; // never return a fake `{} as User`
    }
  }

  return { getUser };
}

// ───────────────────────── Snippet 2: fetchOrders [§3, §9] ─────────────────────────

export function createOrderService(cfg: ApiConfig, deps: Deps = defaultDeps) {
  const http = createHttp(cfg, deps);

  /**
   * Follows pagination with a hard page cap. Authorization is enforced
   * server-side via the bearer token; the client never assumes it may read
   * an arbitrary customerId.
   */
  async function fetchOrders(
    customerId: string,
    opts: { signal?: AbortSignal; pageSize?: number } = {},
  ): Promise<Order[]> {
    assertId("customerId", customerId);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 100, 1), 500);
    const all: Order[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < cfg.maxPages; page++) {
      const qs = new URLSearchParams({ limit: String(pageSize) });
      if (cursor) qs.set("cursor", cursor);
      const result = await http.getJson(
        `/customers/${encodeURIComponent(customerId)}/orders?${qs}`,
        parseOrderPage,
        opts.signal,
      );
      all.push(...result.items);
      if (!result.nextCursor) return all;
      cursor = result.nextCursor;
    }
    throw new ApiError(`Orders exceeded ${cfg.maxPages} pages`, "invalid_response");
  }

  return { fetchOrders };
}
