import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  createOrderService,
  createUserService,
  noopMetrics,
  type ApiConfig,
  type Deps,
} from "./resilientApi.ts";

const cfg: ApiConfig = {
  baseUrl: "https://api.test",
  getAuthToken: async () => "tok",
  requestTimeoutMs: 50,
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  maxPages: 3,
  userCache: { ttlMs: 60_000, maxStaleMs: 300_000, maxEntries: 2, failureCooldownMs: 5_000 },
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers });

const user = { id: "u1", name: "Ada", email: "ada@example.com" };
const order = (id: string) => ({ id, totalMinor: 1999, currency: "USD", status: "paid" });

/** Scripted fetch + fake clock. The last scripted response repeats. */
function harness(script: Array<() => Response | Promise<Response>>) {
  const clock = { t: 0 };
  const urls: string[] = [];
  const sleeps: number[] = [];
  let i = 0;
  const deps: Deps = {
    fetch: (async (url: string, init?: RequestInit) => {
      init?.signal?.throwIfAborted(); // like real fetch
      urls.push(String(url));
      return script[Math.min(i++, script.length - 1)]!();
    }) as unknown as typeof fetch,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    random: () => 1, // deterministic: full backoff, no jitter reduction
    logger: { warn() {}, error() {} },
    metrics: noopMetrics,
  };
  return { deps, clock, urls, sleeps };
}

test("user: success, then fresh cache hit makes no request", async () => {
  const h = harness([json(user)]);
  const svc = createUserService(cfg, h.deps);
  assert.deepEqual((await svc.getUser("u1")).user, user);
  const second = await svc.getUser("u1");
  assert.equal(second.stale, false);
  assert.equal(h.urls.length, 1);
});

test("user: entry expires after TTL and is refetched", async () => {
  const h = harness([json(user)]);
  const svc = createUserService(cfg, h.deps);
  await svc.getUser("u1");
  h.clock.t += 60_001;
  await svc.getUser("u1");
  assert.equal(h.urls.length, 2);
});

test("user: 404 throws not_found, is not retried and is not cached as a user", async () => {
  const h = harness([json({ message: "nope" }, 404)]);
  const svc = createUserService(cfg, h.deps);
  await assert.rejects(svc.getUser("u1"), (e: ApiError) => e.kind === "not_found");
  assert.equal(h.urls.length, 1);
  assert.equal(h.sleeps.length, 0);
});

test("user: malformed body is rejected, not cached, not retried", async () => {
  const h = harness([json({ id: 42 })]);
  const svc = createUserService(cfg, h.deps);
  await assert.rejects(svc.getUser("u1"), (e: ApiError) => e.kind === "invalid_response");
  assert.equal(h.urls.length, 1);
});

test("user: serves stale (flagged) when refresh fails transiently", async () => {
  const h = harness([json(user), json({}, 503)]);
  const svc = createUserService(cfg, h.deps);
  await svc.getUser("u1");
  h.clock.t += 61_000; // expired but within maxStaleMs
  const res = await svc.getUser("u1");
  assert.equal(res.stale, true);
  assert.deepEqual(res.user, user);
});

test("user: does not serve data older than maxStaleMs", async () => {
  const h = harness([json(user), json({}, 503)]);
  const svc = createUserService(cfg, h.deps);
  await svc.getUser("u1");
  h.clock.t += 60_000 + 300_001;
  await assert.rejects(svc.getUser("u1"), (e: ApiError) => e.kind === "server");
});

test("user: concurrent calls share one in-flight request", async () => {
  const h = harness([json(user)]);
  const svc = createUserService(cfg, h.deps);
  await Promise.all([svc.getUser("u1"), svc.getUser("u1"), svc.getUser("u1")]);
  assert.equal(h.urls.length, 1);
});

test("user: cache is bounded (LRU eviction)", async () => {
  const h = harness([json(user)]);
  const svc = createUserService(cfg, h.deps); // maxEntries = 2
  await svc.getUser("a");
  await svc.getUser("b");
  await svc.getUser("c"); // evicts "a"
  await svc.getUser("a");
  assert.equal(h.urls.length, 4);
});

test("user: id is URL-encoded", async () => {
  const h = harness([json(user)]);
  await createUserService(cfg, h.deps).getUser("a/b?x=1");
  assert.ok(h.urls[0]!.endsWith("/users/a%2Fb%3Fx%3D1"));
});

test("user: empty id is rejected before any request", async () => {
  const h = harness([json(user)]);
  await assert.rejects(createUserService(cfg, h.deps).getUser(""), RangeError);
  assert.equal(h.urls.length, 0);
});

test("orders: retries 503 then succeeds on 2nd attempt", async () => {
  const h = harness([json({}, 503), json({ items: [order("o1")] })]);
  const orders = await createOrderService(cfg, h.deps).fetchOrders("c1");
  assert.equal(orders.length, 1);
  assert.equal(h.urls.length, 2);
  assert.equal(h.sleeps.length, 1);
});

test("orders: retry exhaustion throws typed error and does NOT sleep after last attempt", async () => {
  const h = harness([json({}, 503)]);
  await assert.rejects(createOrderService(cfg, h.deps).fetchOrders("c1"), (e: ApiError) => e.kind === "server");
  assert.equal(h.urls.length, 3);
  assert.equal(h.sleeps.length, 2);
});

test("orders: backoff grows and honors Retry-After", async () => {
  const h = harness([json({}, 429, { "Retry-After": "0.9" }), json({}, 503), json({ items: [] })]);
  await createOrderService(cfg, h.deps).fetchOrders("c1");
  assert.deepEqual(h.sleeps, [900, 200]); // max(jitter=100, retryAfter=900); then 200
});

test("orders: other 4xx are not retried", async () => {
  const h = harness([json({}, 400)]);
  await assert.rejects(createOrderService(cfg, h.deps).fetchOrders("c1"), (e: ApiError) => e.kind === "client");
  assert.equal(h.urls.length, 1);
});

test("orders: 502 is treated as an error, not parsed as success", async () => {
  const h = harness([json({ items: [] }, 502)]);
  await assert.rejects(createOrderService(cfg, h.deps).fetchOrders("c1"));
});

test("orders: follows pagination and caps runaway cursors", async () => {
  const paged = harness([
    json({ items: [order("o1")], nextCursor: "p2" }),
    json({ items: [order("o2")] }),
  ]);
  assert.equal((await createOrderService(cfg, paged.deps).fetchOrders("c1")).length, 2);

  const runaway = harness([json({ items: [order("o")], nextCursor: "again" })]);
  await assert.rejects(createOrderService(cfg, runaway.deps).fetchOrders("c1"));
  assert.equal(runaway.urls.length, cfg.maxPages);
});

test("orders: timeout surfaces as a retryable 'timeout' error", async () => {
  const h = harness([]);
  h.deps.fetch = ((_url: string, init: RequestInit) =>
    new Promise((_res, rej) => {
      init.signal!.addEventListener("abort", () => rej(init.signal!.reason));
    })) as unknown as typeof fetch;
  // A real socket keeps the event loop alive; AbortSignal.timeout's timer is unref'd.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(
      createOrderService({ ...cfg, maxAttempts: 2 }, h.deps).fetchOrders("c1"),
      (e: ApiError) => e.kind === "timeout",
    );
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(h.sleeps.length, 1);
});

test("orders: caller abort is honored and not retried", async () => {
  const h = harness([json({ items: [] })]);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    createOrderService(cfg, h.deps).fetchOrders("c1", { signal: ac.signal }),
    (e: ApiError) => e.kind === "aborted",
  );
});
