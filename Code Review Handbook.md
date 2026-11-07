# **Code Review Handbook**
Run the quick pass on any code; each "no" points to a section ID where the smell, failing scenario, fix and tradeoff are written out.

## **How to use this handbook**

Do one pass top-down, then drill only where the quick pass said "no" or "not sure." Three rules keep every comment actionable.

1. **Rule 0: name the input and the outcome.** "Needs more validation" is the failure mode. Write the failing input and what comes out (NaN gives \[\[\]\]), not a vague worry.
2. **Tag every finding.** Severity: **must fix** (correctness), **should fix** (contract, design), **nit** (taste). Kind: **bug fix** or **contract change**. A contract change is fine if you say it out loud and state its consequences.
3. **Every tradeoff gets a "when it wins."** "It depends" alone isn't a review comment.

### **Entry format**

Every deep-dive row has a stable ID (N1, E3) and five parts:

* **Smell:** what you notice in the code.
* **Failing scenario:** a concrete input or sequence that breaks it.
* **Fix:** the smallest change that removes the failure.
* **Tradeoff:** what the fix costs, and when the alternative wins.
* **Src:** drilled if it came from a real exercise, seed if it is a starting entry written up front. Promote seed to drilled when an exercise confirms it, and edit freely.

### **Review order**

1. Read for intent: what is this promising?
2. Trace the happy path.
3. Attack every parameter's boundaries (the input matrix below).
4. Check the contract: failure policy, types, return values.
5. Check what it touches: state, concurrency, I/O, other systems.
6. Triage by severity, then write the verdict first (Appendix A).

## **Quick pass**

Run the input matrix on every parameter, then answer 17 yes/no questions, one per section. Any "no" or "not sure" sends you to that section.

### **Input matrix**

For each parameter, write one line per input: what goes in, what comes out, what it should do. Standard inputs: NaN, \-1, 0, Infinity, 1.5, empty (\[\], "", null, undefined), huge (2\*\*53, a million items). Worked rows:

| Parameter | Input | Output | Should do |
| :---- | :---- | :---- | :---- |
| chunkSize | NaN | \[\[\]\] | Throw RangeError |
| chunkSize | 1.5 | Uneven chunks | Throw RangeError |
| percent | 0 | Treated as missing, price 50 returns 45 | Return 50 |
| page (1-indexed) | \-1 | \[2,3\] for pageSize 2 | Throw RangeError |
| amount | \-100 | Withdraw adds 100 | Reject |

### **Yes/no questions**

| Q  | Family | Question | If no, go to |
| :---- | :---- | :---- | :---- |
| Q1 | Values | Is every numeric input checked for NaN, ±Infinity, fractions, sign and zero, and is money in integer minor units? | N |
| Q2 | Values | Are text encoding, time zones and the clock handled explicitly? | V |
| Q3 | Contracts and design | Is the failure policy (throw, default, clamp, empty) deliberate and consistent, and is every default honest? | C |
| Q4 | Contracts and design | Do the types tell the truth at runtime, not just at compile time? | T |
| Q5 | Contracts and design | Does each unit have one reason to change, with seams to test it? | A |
| Q6 | State and flow | Can callers reach or mutate internal state? | S |
| Q7 | State and flow | Can concurrent operations interleave, read stale data or poison a queue? | E |
| Q8 | State and flow | If step 2 of 2 fails, is anything lost or left half-done? | F |
| Q9 | State and flow | Does every external call have a timeout, bounded retries and cleanup? | R |
| Q10 | System | Are writes transactional, idempotent and backed by constraints? | B |
| Q11 | System | Can this deploy and roll back without breaking callers that are still running? | M |
| Q12 | System | Is untrusted input validated at the boundary, with no secrets or PII leaking? | X |
| Q13 | System | Could you diagnose a production failure from the logs, metrics and traces? | O |
| Q14 | System | Is the cost known at the expected input size? | P |
| Q15 | System | Are config defaults, dependencies and PR scope clean? | H |
| Q16 | Proof | Do tests assert the error type and every invalid input class? | Q |
| Q17 | Proof | Do the docs state what throws, the edge behavior and the guarantees? | D |

## **Values**

Values is where most bugs from the drills came from: inputs that look valid to a naive check but aren't.

### **N: Numeric and input validation**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| N1 | Only size \<= 0 is checked | NaN \<= 0 is false, so chunkArray(\[1,2,3\], NaN) returns \[\[\]\] with no error | Reject unless Number.isSafeInteger(n) and n \> 0 | Strict. Flooring (lodash style) is lenient but hides bad inputs | drilled |
| N2 | Fractions and Infinity accepted by accident | chunkSize 2.5 gives uneven chunks (slice truncates); Infinity silently returns one chunk | Same isSafeInteger guard | Infinity as an "unbounded" sentinel is fine if documented and tested | drilled |
| N3 | Sign and zero unchecked after isSafeInteger | withdraw(-100) passes the balance check and adds 100; deposit(-100) withdraws with no check | Require amount \> 0; validate initialBalance \>= 0 the same way | Zero-amount no-ops can be legitimate for idempotent retries; decide and document | drilled |
| N4 | Falsy check used as "missing" | if (\!percent) percent \= 10 makes applyDiscount(50, 0\) return 45, not 50 | Default parameter percent \= 10, or an explicit \=== undefined check | Default params only fire on undefined, so null and NaN still need their own validation | drilled |
| N5 | Money held in floats | 19.99 \* 15 / 100 is a float; sums drift over many operations | Integer minor units (cents) with one defined rounding rule (half-up or banker's) | Conversion at the edges; not every currency has 2 decimals | drilled |
| N6 | Rate or percent not range-checked | applyDiscount(50, \-10) raises the price; 150 gives a negative price; NaN propagates silently | Require a finite value in 0..100 | Negative rates may be legitimate surcharges, but then the function needs a different name | drilled |
| N7 | Negative values reach slice | 1-indexed paginate(\[1,2,3,4,5\], \-1, 2\) returns \[2,3\]; page 0 returns \[\]; pageSize \-2 returns \[1,2,3\] | Validate page \>= 1 and pageSize \>= 1 as integers before slicing | Clamping to page 1 is friendlier for user-facing paging; throw for internal callers | drilled |
| N8 | Arithmetic with no overflow check | balance \+= amount past Number.MAX\_SAFE\_INTEGER silently loses precision | Check Number.isSafeInteger(result), or use BigInt for ledgers | BigInt breaks JSON and mixed arithmetic | seed |
| N9 | Off-by-one in a slice or loop bound | The original paginate returned \[3\] for page 1 of size 2: the slice end was wrong and an element was dropped | Derive start and end from one formula (start \= (page \- 1\) \* pageSize, end \= start \+ pageSize); test the first, last and one-past-last pages | None; costs three test cases | drilled |

### **V: Text, time, locale**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| V1 | new Date() called inside logic | An "expired" check flakes in tests and depends on the wall clock | Inject a clock (now: () \=\> Date) | One more parameter; worth it wherever time changes behavior | seed |
| V2 | Local time stored or compared | A daily job runs twice or skips across a DST change; the server zone differs from your laptop | Store UTC (ISO 8601 or epoch), convert at the edge; never add 24\*60\*60\*1000 for "one day" | Calendar semantics (birthdays, billing dates) need a date plus zone, not an instant | seed |
| V3 | Date mutability and 0-indexed months | d.setDate(...) mutates the caller's date; new Date(2026, 1, 1\) is February | Copy before mutating; prefer ISO strings, or Temporal where supported | Temporal may need a polyfill; check your runtime | seed |
| V4 | Strings treated as ASCII | "é" has different lengths in composed and decomposed forms; an emoji counts as 2 units; visually equal strings fail \=== | normalize("NFC") at the boundary; Intl.Segmenter for user-visible counts | Normalizing changes stored text; don't silently normalize IDs or passwords | seed |
| V5 | Locale leaks into logic | toLowerCase() on Turkish I; default sort() is code-unit order; decimal commas break parsing | Pass an explicit locale to Intl, and use invariant formats for machine-readable data | A pinned locale is predictable but may not match what the user expects in the UI | seed |

## **Contracts and design**

A function's signature, errors and structure are a promise to its callers. These sections check that the promise is honest and survivable.

### **C: Contract and API design**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| C1 | Inconsistent failure policy | A bad size throws, but a null array silently returns \[\], so a failed fetch looks like "no work to do" | Pick one policy; fail fast on both and let the types guard the array | Fail-fast needs try/catch at the boundary; leniency belongs only at the system edge | drilled |
| C2 | Bad input silently clamped or defaulted | chunkSize 0 clamped to 1 turns one batch of 100 into 100 API calls | Reject; if you must substitute, document it and log it | Clamp fits numeric knobs with a sane range or ceiling; default fits truly optional parameters | drilled |
| C3 | A fake value stands in for "nothing" | average(\[\]) returns 0, but 0 is not the average of nothing, and the caller computes with it | Throw, return undefined so the type forces handling, or return NaN | Throwing is loud; undefined pushes handling to callers; NaN propagates silently | drilled |
| C4 | Contract change disguised as a bug fix | paginate moved to 1-indexed; callers passing 0-indexed pages now get the wrong page | Tag it "contract change," state the assumption out loud, list the affected callers | Keep 0-indexed internally and convert at the edge, or version the function | drilled |
| C5 | Return type changed to fix a bug | getBalance became Promise\<number\> to be queue-consistent; every caller must change | Call it out as an API change in the review and migrate callers | Keep a synchronous snapshot read for callers that don't need consistency | drilled |
| C6 | Weak error type and message | new Error("Chunk size must be greater than 0") has no received value, and instanceof RangeError fails | RangeError (or a specific class) with the received value; document with @throws | Many specific classes add surface area; reserve them for domain errors | drilled |
| C7 | Out-of-range request has no defined result | paginate past the last page returns \[\], indistinguishable from "no data" | Decide: empty result or error, and document it | Empty suits UI paging; an error suits batch jobs | drilled |
| C8 | A parameter name hides its meaning at the call site | chunkArray(items, 3): size of what? An amount could be dollars or cents | Name by meaning and unit: chunkSize, pageSize, amountCents | Longer names; worth it at every call site | drilled |

### **T: Types**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| T1 | Non-null assertion \! | this.accounts.get(id)\! returns undefined; the caller crashes later with a confusing error | Check and throw a descriptive error where the lookup happens | \! is acceptable only where the invariant is proven on the same line | drilled |
| T2 | readonly trusted as protection | readonly Transaction\[\] is erased at compile time, so a JS caller or a cast can mutate internals | Return a copy and freeze the entries (Object.freeze) | Freezing costs allocation; deep copies scale with size | drilled |
| T3 | Input typed mutable but never mutated | chunkArray(array: T\[\]) rejects as const and frozen arrays without casts | Accept readonly T\[\] | None meaningful; the return type can stay mutable | drilled |
| T4 | Guard unreachable under the type system | if (\!array) when array: T\[\] under strict | Remove it for typed callers; validate at the untyped boundary instead | Keep it only where untyped JS or parsed JSON can reach the function | drilled |
| T5 | Cast at a trust boundary | JSON.parse(body) as Order passes a missing field through and fails far from the cause | Parse with a runtime schema (such as zod) at the boundary | A schema adds a dependency and some cost; worth it for anything untrusted | seed |
| T6 | A return type or generic that doesn't tell the truth | A lookup typed to return T can return undefined at runtime; a generic parameter used nowhere constrains nothing | Return a union with undefined, or throw; drop decorative generics | A union forces every caller to handle absence, which is the point | seed |

### **A: Design (SOLID)**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| A1 | One class validates, persists and formats (SRP) | A change to the output format forces edits next to billing logic, and every change risks the other | Split along real reasons to change; keep orchestration thin | Over-splitting makes tiny classes and indirection | seed |
| A2 | A growing switch on type (OCP) | Adding a payment method means editing the core function and retesting all branches | A strategy or lookup table where new variants register themselves | A switch is fine for 2 or 3 stable cases; abstracting before the second variant is guesswork | seed |
| A3 | A subclass narrows the base's behavior (LSP) | ReadOnlyAccount extends BankAccount whose withdraw throws breaks every caller written against the base | Prefer composition or a narrower interface | Inheritance saves code but costs substitutability; composition costs delegation boilerplate | seed |
| A4 | Fat interface (ISP) | A consumer that only needs getBalance must stub 12 methods in its tests | Small role interfaces such as BalanceReader | More types to name; group them by consumer need | seed |
| A5 | Collaborators created inside the logic (DIP) | transferTo can't be tested without real accounts, a database and a clock | Inject dependencies through constructors or parameters | Wiring complexity; use one composition root and skip a DI framework until you need it | seed |

## **State and flow**

These sections cover what goes wrong when state is shared, operations overlap, or a multi-step operation stops halfway. Concurrency (E) is a different concern from numeric input (N): check it separately.

### **S: State and encapsulation**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| S1 | A getter returns the live internal array | getHistory() returns this.history; a caller pushes to it or clears it and corrupts the audit trail | Return a copy | A copy per call is O(n); fine unless it sits in a hot loop | drilled |
| S2 | A copy that is only shallow | Copying the array still shares mutable Transaction objects; a caller edits tx.amount | Object.freeze entries when created, or deep copy | Object.freeze is shallow too; nested objects need deep freeze or immutable data | drilled |
| S3 | Elements shared by reference | chunkArray returns new arrays, but mutating an element object changes the source data | Document "shallow"; clone only if callers mutate | Deep cloning costs time and can break identity and class instances | drilled |
| S4 | The function mutates its input | items.sort() or splice on a parameter reorders the caller's array | Copy first (\[...items\].sort(), toSorted), or document the mutation | The copy costs O(n) memory | seed |
| S5 | Sparse arrays and holes | slice preserves holes, so \[1,,3\] yields chunks with holes that forEach skips | Normalize at the boundary, or document and test it | Rare; matters when arrays come from new Array(n) or untrusted input | drilled |

### **E: Concurrency and async**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| E1 | A read bypasses the queue | getBalance() returns immediately while a deposit is pending, so the answer is stale (call it stale or racy, not non-deterministic) | Queue reads with writes and return Promise\<number\> | An API change (see C5); a sync snapshot may be enough for dashboards | drilled |
| E2 | A failed task poisons the queue | tail \= result with no catch: one rejection makes every later task skip and reject with the same error, so one failure bricks the account | tail \= result.catch(() \=\> {}) and still return result so the caller sees the error | Log the swallowed error on the tail so it isn't invisible | drilled |
| E3 | Callers fire operations without awaiting | Two concurrent withdrawals both pass the balance check unless every mutating method enters the queue | Funnel every mutating method through one enqueue | A single choke point limits throughput; that is also the point | drilled |
| E4 | Check-then-act across an await | The balance is checked before the await and mutated after; safe only because the queue serializes everything | Keep check and mutation in one serialized unit; test that no new method bypasses the queue | A queue per account serializes that account's throughput only | seed |
| E5 | Not every read needs the queue | getHistory is a synchronous copy of completed work, appended only on completion, so it is already consistent | Leave it synchronous; document that it reflects completed operations | Making it async adds API cost with no consistency gain | drilled |
| E6 | Two-resource operations without lock ordering | Concurrent A to B and B to A transfers deadlock once real locks exist | Acquire locks in a global order (for example by id), or use one transaction | Needs a stable total order; a database transaction delegates this | seed |
| E7 | An in-process queue guards a multi-process system | Two server instances both pass the check and double-spend | Database transactions, row locks or unique constraints | Distributed locks add latency and new failure modes | seed |

### **F: Failure and recovery**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| F1 | A multi-step operation is not atomic | transferTo debits, then target.deposit throws: money is destroyed, and between the awaits it sits in neither account | Compensating refund on failure; ideally one coordinated unit (lock both accounts or use a transaction) | Compensation exposes intermediate states; transactions need shared storage | drilled |
| F2 | The compensation can fail too | The refund deposit throws after the original failure | Surface both errors (AggregateError), alert, and keep an audit record | Real money needs a reconciliation process; an in-memory fix can't be complete | drilled |
| F3 | Preconditions checked after step 1 | transferTo(this, 50\) or a bad amount reaches the withdraw; with locking, a self-transfer deadlocks on its own lock | Validate everything up front: same account, amount, target | Cheap; no real downside | drilled |
| F4 | Rejected operations vanish from the audit trail | An invalid amount throws before record(), but the spec says every attempted operation is recorded | Record domain rejections; decide whether malformed input counts as "attempted" | Recording untrusted junk can bloat history; cap or sample it | seed |
| F5 | A built-in throws on empty input | reduce with no initial value throws on \[\] | Pass an initial value or guard first | An initial value hides the empty case; decide it deliberately (see C3) | drilled |
| F6 | Exceptions swallowed or flattened | catch (e) { return false } hides the cause, so callers see "nothing happened" | Catch only what you can handle, log with context, rethrow the rest | Returning false is fine for expected outcomes (insufficient funds), not for exceptions | seed |

### **R: Resources and reliability**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| R1 | No timeout on an external call | A slow dependency makes every request hang and the queue backs up | Explicit timeouts on every network and database call, shorter than the caller's | Too short causes false failures; base it on p99 plus margin | seed |
| R2 | Naive or unbounded retries | Immediate retries during an outage multiply load; a retried non-idempotent POST charges twice | Bounded retries with exponential backoff and jitter; retry only idempotent calls or use idempotency keys | Retries add latency and can mask flapping; cap the total time budget | seed |
| R3 | No cancellation | A user abandons a request but the server keeps working; long jobs can't be stopped | Pass AbortSignal (or a context) through the calls | Plumbing through every layer; start with the longest-running calls | seed |
| R4 | Leaked resources on error paths | Timers, listeners, connections or file handles are opened and never closed when an exception skips the cleanup | try/finally or using; clear timers; use pooled connections | Pools need sizing; leaks appear as slow memory growth, not errors | seed |
| R5 | No backpressure | A producer fires 100k tasks at a rate-limited API: memory grows and 429s cascade | Bounded concurrency (a limited queue or p-limit) and lazy generators (see P) | Throughput is capped by the limit; tune it with real numbers | seed |
| R6 | Unbounded in-memory growth | The history array grows forever in a long-lived process until it runs out of memory | Cap or rotate it, spill to storage, bound caches with TTL and size | Dropping history loses audit data; persist before you evict | seed |

## **System**

These sections cover what happens once the code leaves your editor: its data, its rollout, its attackers, its operators and its bill. Only X1, P1 to P5, H1, H2 and H6 come from exercises so far; the rest are seed entries to confirm or rewrite.

### **B: Data and persistence**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| B1 | A multi-step write without a transaction | The order row is inserted, the order-items insert fails, and an orphan order remains | Wrap both writes in one transaction | Long transactions hold locks; keep them short and make no network calls inside | seed |
| B2 | A non-idempotent write that can be retried | A client retries a timed-out POST /payments and the customer is charged twice | Idempotency key with a unique constraint; return the original result on replay | Keys need storage and an expiry policy | seed |
| B3 | Check-then-insert race | if (\!exists(email)) insert(email): two concurrent requests both pass and create duplicates | A unique constraint plus handling of the violation, or an upsert | The app-level check gives a friendly error; the constraint is the guarantee | seed |
| B4 | N+1 queries | Listing 100 orders issues 101 queries: fine in dev, slow at 10k rows | Eager load, join, or batch with WHERE id IN (...); assert query counts in tests | Joins can over-fetch or duplicate rows; batching adds a round trip | seed |
| B5 | Missing index or unbounded query | WHERE customer\_id \= ? on 50M rows scans the table and returns everything | Index the filter and sort columns; paginate with a keyset and a LIMIT | Indexes slow writes and use space; confirm with EXPLAIN | seed |
| B6 | Wrong isolation assumption | Read balance, then write balance under READ COMMITTED: a lost update | Atomic UPDATE balance \= balance \- ?, SELECT ... FOR UPDATE, or a version column | Row locks reduce concurrency; optimistic retries add complexity | seed |

### **M: Migrations and rollout**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| M1 | A breaking schema change in one step | Renaming or dropping a column while old app instances still run causes errors mid-deploy | Expand/contract: add the new column, dual-write, backfill, switch reads, drop later | Takes several deploys; required for zero downtime | seed |
| M2 | No rollback path | The deploy migrated data, and rolling back the code now hits a schema it doesn't understand | Keep each migration compatible with the previous release; write the rollback or roll-forward plan first | Destructive migrations can't be reversed; take a backup and plan to roll forward | seed |
| M3 | A backfill as one giant statement | One UPDATE over 50M rows locks the table and lags the replicas | Batches with throttling, a resumable cursor, off-peak runs | Slower to finish; needs progress tracking | seed |
| M4 | New behavior ships without a flag | A bug in new logic hits 100% of users at once | Feature flag with a percentage rollout and a kill switch | Flags are debt; track them and delete them after rollout | seed |
| M5 | A breaking API change | Renaming a response field breaks mobile clients still on an old version | Additive changes only; version the API; deprecate with telemetry before removal | Supporting versions costs maintenance; set a sunset policy | seed |

### **X: Security and untrusted input**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| X1 | A duplicate ID overwrites existing state | Bank.open('mary1') called twice replaces the account, destroying its balance and history | Check for the ID and throw; make creation explicit | An idempotent create is legitimate, but it must not reset state | drilled |
| X2 | Untrusted input built into a command | "... WHERE name \= '" \+ input \+ "'" allows SQL injection; same for shell and templates | Parameterized queries; never string-build commands; allowlist the input shape | ORMs can still expose raw fragments; review every raw query | seed |
| X3 | Authorization checked on the route, not the object | GET /accounts/:id lets user A read user B's account by changing the ID | Check ownership or permission for the specific resource, server-side, every time | Per-object checks cost queries; centralize them in one policy layer | seed |
| X4 | Secrets or PII in code and logs | An API key is committed; logger.info(req.body) writes card numbers and tokens | Secret manager or env injection; log IDs, not payloads; redact known fields | Redaction needs an allowlist to stay safe; rotate leaked secrets immediately | seed |
| X5 | The server fetches a user-supplied URL | fetch(req.query.url) reaches an internal metadata endpoint (SSRF) | Allowlist hosts, block private ranges, resolve then connect, disable redirects | Allowlists need upkeep; egress controls help as a second layer | seed |
| X6 | Unsafe parsing or an unreviewed dependency | Merging parsed JSON into an object allows \_\_proto\_\_ pollution; a new package arrives with no review | Schema-validate input; use safe loaders; pin and audit dependencies | Audits slow adding libraries; automate with a lockfile and a scanner | seed |

### **O: Observability**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| O1 | Unstructured log lines | console.log("failed " \+ err) can't be searched by account or request | Structured (JSON) logs with request ID, account ID, operation and outcome | More verbose; sample high-volume debug logs | seed |
| O2 | No correlation across services | One request fans out to four services and their logs can't be linked | Propagate a correlation or trace ID (OpenTelemetry context) everywhere | One missing hop breaks the chain | seed |
| O3 | Errors logged without context | catch (e) { log(e.message) } drops the stack, the cause and the inputs | Log the stack, cause, operation and key identifiers; no secrets | Careful with PII; log IDs, not payloads | seed |
| O4 | Logs only, no metrics | Nobody can see error rate or latency percentiles; outages are reported by users | Rate, errors and duration per operation; alert on SLO burn | High-cardinality labels (user IDs) explode cost; keep labels bounded | seed |
| O5 | Alerts on causes, not symptoms | A page for CPU at 80% at 3am while a 5% error rate goes unnoticed | Alert on user-visible symptoms, link a runbook, delete alerts nobody acts on | Fewer alerts risk missing slow burns; review alert history regularly | seed |
| O6 | Silent fallbacks | A retry, cache miss or clamped default kicks in with no trace, so the system "works" while degraded | Count and log every fallback and retry as a metric | Extra instrumentation; ties to C2 | seed |

### **P: Performance and scale**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| P1 | A hand-rolled loop where a built-in exists | Manual index math to copy chunks instead of slice | Prefer built-ins and measure before hand-optimizing | In an interview, ask whether built-ins are allowed | drilled |
| P2 | An eager array for a huge input | Chunking 100k+ rows builds every chunk before the first insert and memory spikes | A generator variant (function\*), with the array version built on top | Single-pass iteration and a less obvious return type | drilled |
| P3 | A check inside the loop | Validation runs per iteration instead of once per call | Validate once per call | None; one isSafeInteger is negligible next to slice allocation | drilled |
| P4 | Needless intermediate allocations | Array.from({length}) with a mapper allocates an extra array and runs slower | A plain loop with slice | The declarative style can read better; measure first | drilled |
| P5 | Optimizing against an imagined constraint | Streaming is built for an input that is 50 items | Ask about input size and growth; state assumptions before coding | A clarifying question is cheaper than rework | drilled |
| P6 | Complexity never stated | An includes call inside a loop is O(n squared): fine for 50 items, a stall at 100k | State time and space complexity in the review; use a Set or Map for membership | A Set costs memory and build time; measure at realistic sizes | seed |

### **H: Config and change hygiene**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| H1 | A library swap changes edge-case behavior | Replacing your own chunkArray with lodash \_.chunk turns thrown errors into \[\] for size below 1 | Compare the library's contract to what callers expect; add characterization tests first | Own helper: about 8 lines, no dependency. Library: battle-tested, different semantics | drilled |
| H2 | A config default hides misconfiguration | BATCH\_SIZE is missing and silently falls back to 10; production runs the wrong size for months | Validate config at startup, fail fast, log the resolved values | Defaults are fine when explicit, documented and logged: strict inside, tolerant at the edge | drilled |
| H3 | Secrets in config files or repos | A .env is committed, or a key ships in the client bundle | Secret manager or env injection; scan commits; rotate on leak | Overlaps X4: keep config rules here and leak impact there | seed |
| H4 | A PR mixes concerns | A refactor, a behavior change and a dependency bump land together; no one can tell what changed behavior | Split mechanical changes from behavior changes; one concern per PR | More PRs and review overhead; stack them | seed |
| H5 | A dependency added casually | A two-line helper pulls in a transitive tree and a supply-chain risk | Prefer stdlib or your own helper for trivial code; check maintenance, license and size | Owning the code means owning its bugs; use libraries for hard problems (crypto, dates) | seed |
| H6 | Dead code and leftover edits | A stray results; statement; commented-out blocks | Delete it; run no-unused-expressions in CI | None | drilled |

## **Proof**

Tests and docs are how the fixes above stay fixed. Use the input matrix as the source of test cases.

### **Q: Tests**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| Q1 | The test only asserts "it throws" | expect(() \=\> f()).toThrow() passes for any error, including the wrong type | Assert the type and a message fragment: toThrow(RangeError) and /chunkSize/ | Messages change; assert a fragment, not the full text | drilled |
| Q2 | The error in the code, the test and the docs disagree | Code throws Error, the test expects RangeError, the docs say @throws RangeError | Align all three so the test fails for the right reason | None | drilled |
| Q3 | Invalid input classes not enumerated | Tests cover 0 but not NaN, 1.5, Infinity or negatives | it.each over every invalid class from the input matrix | A longer table, trivially cheap | drilled |
| Q4 | Boundary and remainder cases missing | Only the happy path is tested | Empty, exact multiple, remainder, size above length, size 1, size equal to length | None | drilled |
| Q5 | Mutation and reference identity untested | A refactor starts sorting the caller's array or cloning elements and nothing fails | Test with a frozen input; assert chunks are new arrays and elements are the same references (toBe) | Identity tests lock in "shallow"; change them deliberately | drilled |
| Q6 | Concurrency untested | A race passes by luck because tests run one call at a time | Fire N operations without awaiting; assert the final balance, history order, and that a failure doesn't block later calls | Timing-based tests flake; use deterministic fakes for delays | seed |
| Q7 | Multi-step failure paths untested | transferTo is never run with a failing deposit | Inject a failing target and assert conservation: the sum of balances is unchanged | Needs a seam to inject the failure (see A5) | seed |

### **D: Docs**

| ID | Smell | Failing scenario | Fix | Tradeoff | Src |
| :---- | :---- | :---- | :---- | :---- | :---- |
| D1 | What throws is undocumented | Callers don't know to catch RangeError | @throws {RangeError} with the condition | Docs rot; keep them next to the code | drilled |
| D2 | Edge-case behavior undocumented | Callers don't know the last chunk may be shorter or that empty input returns \[\] | One line per edge case | None | drilled |
| D3 | Copy semantics unstated | A caller assumes a deep copy and mutates the elements | State "shallow: elements are not cloned" | None | drilled |
| D4 | Units and indexing left implicit | Is amount in cents? Is page 1-indexed? | State units, indexing and ranges in the docs, and in names such as amountCents | Longer names; worth it | drilled |
| D5 | Concurrency guarantees unstated | Callers don't know whether reads reflect pending writes, or whether cross-account operations are atomic | Document what is ordered (per account) and what is not (across accounts) | Stating a guarantee commits you to keeping it | seed |

## **Appendices**

Process, interview habits, design notes, the worked-examples table and the drill log live here. Add a row to D and E after every exercise.

### **A. 📝Process and feedback template**

Verdict first, then findings in severity tiers, then the fix, the tradeoffs and the tests.

Verdict: approve / approve with changes / block, plus a one-line reason

Must fix      correctness bugs, each with the failing input
Should fix    contract, design, types
Nits          naming, style

Suggested revision (code)

Tradeoffs     decision / options / cost of each / when each wins

Tests I'd want

* **Name the failing input** for every bug (NaN gives \[\[\]\]), not "validation is weak."
* **Separate "wrong" from "I'd do it differently."** Tier them so taste doesn't block a merge.
* **Tie every finding to a scenario** (withdraw(-50) on a balance of 100 leaves 150). It makes severity obvious and gets comments acted on.
* **Check what the code doesn't say:** error paths, null handling, scale.

### **B. Interview: clarify, then say it out loud**

Clarifying questions to ask before coding:

* ☐ What are the input size and its growth: tens, thousands, millions?
* ☐ One-shot or streaming? Sync or async? Is backpressure needed?
* ☐ Are built-ins and libraries allowed?
* ☐ Who calls this: trusted internal code or untrusted input?
* ☐ What should invalid input do: throw, return empty, use a default?
* ☐ Indexing, units and ordering: 0 or 1-indexed, cents or dollars?

Phrases that make assumptions explicit:

* "I'm assuming 1-indexed pages; the consequence is that page 0 is invalid."
* "That's a contract change, not a bug fix: callers passing X now get Y."
* "For NaN this returns \[\[\]\]; it should throw RangeError."
* "I'm throwing instead of clamping because a silent substitute hides a caller bug."
* "I'll write the simple eager version; at millions of rows I'd switch to a generator."

### **C. Design notes**

**Strict inside, tolerant at the edge.** Modern practice favors strict, testable, observable behavior over friendly implicit defaults, because a lenient default makes a bug surface far from its cause and makes behavior depend on hidden rules. The rule is not "strict everywhere": at a system boundary (user input, config, third-party payloads) being liberal in what you accept is legitimate, but parse and normalize once, visibly, then pass strict typed values inward. Any leniency should be explicit, documented and observable. Python culture is looser than TypeScript culture here, so treat "strict" as a trend, not a universal.

**Four ways to handle bad input.**

| Policy | What it does | Fits | Hazard |
| :---- | :---- | :---- | :---- |
| Throw | Rejects the call | Value should never be invalid; internal utilities | Needs a try/catch where input comes from users or config |
| Clamp | Pulls the value to the nearest valid one, so the result depends on how far off it was | Numeric knobs with a sane range or a ceiling (page size, concurrency) | chunkSize 0 clamped to 1 quietly makes 100 calls instead of 1 |
| Default | Replaces missing or invalid input with one fixed fallback | Truly optional parameters | JS default params only fire on undefined, not 0, NaN or null |
| Return empty | Skips the work and returns an empty result | "Nothing to do" is a valid answer | A batch job that silently processes nothing |

**Performance in reviews and interviews.** State assumptions and ask about input size first. Prefer built-ins such as slice: they are generally faster and clearer than hand-rolled loops, and you should measure before hand-optimizing. Validate once per call, never per iteration. A generator is a scope question, not a style one: it depends on input size, whether the consumer is sync or async, and whether it needs backpressure.

### **D. Worked examples**

| Exercise | Issue | Failing scenario | Section |
| :---- | :---- | :---- | :---- |
| chunkArray | Stray results; and a redundant empty check | A no-op statement and a guard the loop already covers | H6 |
| chunkArray | size \<= 0 misses NaN, fractions, Infinity | NaN gives \[\[\]\]; 2.5 gives uneven chunks | N1, N2 |
| chunkArray | Bad size throws, null array returns \[\] | A failed fetch looks like "no work to do" | C1 |
| chunkArray | Plain Error, no received value | toThrow(RangeError) fails against it | C6, Q2 |
| chunkArray | Input typed mutable | as const arrays need casts | T3 |
| chunkArray | No @throws, no edge-case docs | Callers don't know what throws or how the last chunk behaves | D1, D2, D3 |
| Bank | Bank.get returns undefined behind \! | The caller crashes later with a confusing error | T1 |
| Bank | getBalance not queued | A pending deposit isn't reflected in the returned balance | E1 |
| Bank | getHistory returns the live array | A caller clears or edits the audit trail | S1, S2, T2 |
| Bank | Amount check accepts negatives and zero | withdraw(-100) adds 100 | N3 |
| Bank | A failed task poisons the queue | One rejected operation bricks the account | E2 |
| Bank | transferTo not atomic | A failed deposit after the debit destroys money | F1, F2, F3 |
| Bank | Bank.open overwrites an existing ID | Balance and history are destroyed | X1 |
| paginate | Wrong slice end | Page 1 of size 2 returned \[3\] instead of \[1,2\] | N9 |
| paginate | 1-indexed change, then page 0 and \-1 | \-1 returns \[2,3\], plausible and wrong | C4, N7 |
| applyDiscount | Falsy check treats 0 as missing | applyDiscount(50, 0\) returns 45 | N4 |
| applyDiscount | Money in floats, percent unchecked | \-10 raises the price; 150 goes negative | N5, N6 |
| average | reduce without an initial value | average(\[\]) crashes | F5 |
| average | A fake 0 for empty input | The caller computes with a number that isn't an average | C3 |

### **E. Drill log**

| Exercise | Caught | Missed | Added |
| :---- | :---- | :---- | :---- |
| chunkArray review (reviewed by Claude) | n/a | n/a | N1, N2, C1, C6, T3, T4, S3, S5, P1 to P5, D1 to D3, Q1 to Q5 |
| Bank module (6 planted issues) | 4 of 6: get returns undefined, getBalance not queued, getHistory leaks, amount validation | Failed task poisons the queue (E2); transferTo not atomic (F1) | E1 to E3, E5, F1 to F3, X1, S1, S2, T1, T2, N3 |
| paginate, applyDiscount, average | All 3 core bugs, but described only as "needs more validation" | The 1-indexed contract change and its 0 and \-1 inputs; the fake 0; the input matrix homework | N4 to N7, N9, C3, C4, C7, F5, Rule 0, the input matrix |

