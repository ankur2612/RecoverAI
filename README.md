# RecoverAI

**AI Revenue Recovery Agent** — Razorpay AI Buildathon, Track 03.

RecoverAI detects revenue at risk, diagnoses why it is at risk, selects a bounded
recovery action, validates that action against a deterministic policy engine,
executes only what policy permits, and measures what was actually recovered.

> **AI recommends. Policies authorize. APIs execute. Evidence verifies.**
>
> The LLM never calls a payment API and never decides whether money moves.

---

## Build status

This repository is built incrementally against the RecoverAI PRD. The backend
recovery pipeline — detect, diagnose, authorize, execute, verify — is complete
and tested end to end. Two real providers are implemented (Gemini, Razorpay
Test Mode). See [Known limitations](#known-limitations) for exactly what does
and does not work yet.

| Area | Status |
| --- | --- |
| Monorepo scaffold, TypeScript, strict config | Working |
| PostgreSQL schema + forward-only migrations | Working, **verified against live PostgreSQL 16.14** |
| Deterministic synthetic data generator | Working, verified reproducible |
| Config + policy loading, secret redaction | Working |
| Payment ingestion + retrieval | Working |
| Deterministic revenue-risk detection | Working |
| AI provider abstraction + MockAI | Working, deterministic |
| Structured AI diagnosis + strict validation | Working |
| Ground-truth boundary (compile + runtime + architectural) | Working |
| Recovery case persistence | Working |
| **Deterministic policy engine (authorization)** | **Working** |
| **Recovery executor + idempotency (execution)** | **Working** |
| **Outcome verification (evidence)** | **Working** |
| **Gemini AI provider** | **Working, live-verified** |
| **Razorpay Test Mode provider** | **Working, mock-tested; live lookup unproven** |
| **Batch recovery + analytics API** | **Working** |
| **Crash recovery sweeper** | **Working** |
| **Human approval workflow** | **Working** |
| **AI evaluation harness** | **Working** |
| API authentication | **Working** — shared token; enabled by default in Docker |
| Rate limiting | **Working** — in-process, per client IP |
| CI (GitHub Actions), lint (ESLint) | **Working** |
| Dashboard / frontend | **Not built yet** |

---

## Quick start

Requires **Node.js >= 20.10**. Docker is optional but is the easiest way to get
PostgreSQL.

```bash
npm install
cp .env.example .env        # defaults work as-is; no API keys required
```

### Generate a dataset (no database needed)

```bash
npm run seed -- --summary-only
```

Produces a reproducible 1,000-record dataset from seed 42 and prints its
composition. Nothing is written unless you pass `--out` or `--db`.

```
RecoverAI synthetic dataset
---------------------------
seed                 42
records              1000 (dev 699 / eval 301)
merchants            4
customers            551
revenue at risk      INR 20,16,914.65
  of which recoverable INR 17,61,304.15

by payment status
  abandoned              63
  captured               525
  failed                 412

by ground-truth classification (non-captured only)
  CHECKOUT_ABANDONMENT       63
  CUSTOMER_ACTION_REQUIRED   59
  PAYMENT_METHOD_PROBLEM     97
  REPEATED_FAILURE           31
  SUBSCRIPTION_FAILURE       48
  TEMPORARY_FAILURE          155
  UNKNOWN                    22
```

Those figures are counted from the generated data, not asserted.

### With a database

```bash
docker compose up -d db     # PostgreSQL on :5432
npm run migrate             # apply schema
npm run seed -- --db        # generate and persist
npm run dev                 # backend on :8080
curl http://localhost:8080/api/health
```

### Tests

```bash
npm test            # offline tests (no database, no credentials)
npm run typecheck
npm run build
```

### Tests against a real database

Integration tests run only when a database URL is supplied, so the suite stays
runnable on a machine with no PostgreSQL:

```bash
RECOVERAI_TEST_DATABASE_URL=postgres://user:pass@host:port/db npm test
# adds the live-database integration suites
```

---

## Dataset CLI

```
npm run seed -- [options]

  --seed=42          PRNG seed
  --count=1000       number of payment records
  --eval-split=0.3   fraction held out for evaluation
  --out=path.json    write the dataset to a file
  --db               persist into PostgreSQL
  --summary-only     print the summary and write nothing
```

Writing to the database is opt-in, so an accidental run cannot clobber data.

### Reproducibility

The same seed produces a **byte-identical** dataset on every run:

```bash
npm run seed -- --out=/tmp/a.json
npm run seed -- --out=/tmp/b.json
sha256sum /tmp/a.json /tmp/b.json   # identical
```

This holds because the generator uses a seeded mulberry32 PRNG (never
`Math.random`) and pins its reference clock (`DEFAULT_NOW`) instead of reading
wall-clock time. Both properties are covered by tests.

---

## Architecture

```
Payment events
      |
      v
Revenue risk detection          deterministic
      |
      v
AI diagnosis  (Claude | OpenAI | MockAI)     <-- recommends only
      |
      v  RecoveryRecommendation (structured JSON)
Deterministic policy engine                   <-- authorizes
      |
   +--+--------------+
   |                 |
ALLOWED          BLOCKED / REQUIRES_APPROVAL
   |                 |
   v                 v
Action executor   Audit log
   |
   v
Payment provider (RazorpayTestProvider | MockProvider)
   |
   v
Outcome  -->  Audit log  -->  Metrics
```

The AI produces a recommendation. It cannot execute, cannot reach a secret, and
cannot widen a policy limit. Every financial action passes a deterministic
check whose inputs are configuration, not model output.

### Layout

```
packages/backend/src/
├── api/          health, payments, recovery routes + request schemas
├── agents/
│   └── diagnosis/  provider interface, prompt contract, input boundary,
│                   strict output validation, providers/mock.ts
├── policies/     engine.ts, types.ts, input.ts — AUTHORIZATION
├── payments/     repository, provider.ts, providers/mock.ts, factory.ts
├── risk/         detector.ts, types.ts — deterministic detection
├── recovery/     analyze.ts, executor.ts, execute-service.ts, verifier.ts,
│                 verify-service.ts, verification-types.ts,
│                 repository.ts, action-repository.ts
├── audit/        append-only audit writes
├── analytics/    recovery metrics, evaluation harness, metrics primitives
├── datasets/     synthetic data generator
├── db/           pool, type parsers, migrations, runner
├── jobs/         batch recovery orchestration, sweeper CLI
├── config/       env loading, policy values, redaction
└── shared/       domain types, seeded RNG
```

Directories marked empty are placeholders for later phases — see
[Roadmap](#roadmap).

---

## Data model

Six entities plus a deliberately separated labels table.

| Table | Purpose |
| --- | --- |
| `merchants` | Merchant identity and currency |
| `customers` | Customer, scoped to a merchant |
| `payments` | Payment events; `amount` is BIGINT in minor units |
| `payment_ground_truth` | Synthetic labels — **evaluation only** |
| `recovery_cases` | One diagnosis of one at-risk payment |
| `recovery_actions` | One attempted action, with its idempotency key |
| `audit_events` | Append-only decision log |

Safety properties enforced by the schema itself, not by application code:

- **Money is `BIGINT` in minor units.** Paise, never rupees; never a float.
- **`idempotency_key` is `UNIQUE`.** Duplicate protection survives a race,
  because the database rejects the second insert.
- **One live case per payment.** A partial unique index over
  `('OPEN','AWAITING_APPROVAL','EXECUTING')` stops two concurrent analyses from
  producing two competing recovery attempts for the same money.
- **The audit log is append-only.** `BEFORE UPDATE` and `BEFORE DELETE`
  triggers raise, so the log is immutable from the normal application
  interface.
- **Ground truth is a separate table.** Labels are structurally unavailable to
  anything that builds an AI prompt, so they cannot leak into a diagnosis.

---

## Configuration

Every value lives in the environment; see [.env.example](.env.example).
**No business policy is hardcoded in an LLM prompt.**

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTH_ENABLED` | `false` locally, **`true` in Docker** | `true` \| `false` \| `1` \| `0` — protects every route except health |
| `RATE_LIMIT_ENABLED` | `true` | Bounds requests per client IP |
| `RATE_LIMIT_MAX` | `120` | Requests per window, per client |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Window length in milliseconds |
| `API_AUTH_TOKEN` | *(unset)* | **Required when `AUTH_ENABLED=true`**; min 16 chars. Never logged or returned |
| `AI_PROVIDER` | `mock` | `mock` \| `gemini` \| `claude` \| `openai` |
| `GEMINI_API_KEY` | *(unset)* | Required when `AI_PROVIDER=gemini` |
| `GEMINI_MODEL` | `gemini-3.7-flash` | Overridable per deployment |
| `PAYMENT_PROVIDER` | `mock` | `mock` \| `razorpay` |
| `RAZORPAY_KEY_ID` | *(unset)* | **Test Mode only** — must match `rzp_test_*` |
| `RAZORPAY_KEY_SECRET` | *(unset)* | Required when `PAYMENT_PROVIDER=razorpay` |
| `RECOVERAI_LIVE_PROVIDER_TESTS` | *(unset)* | Set to `1` to enable gated live smoke tests |
| `RAZORPAY_SMOKE_PAYMENT_ID` | *(unset)* | A Test Mode payment id; enables the read-only live lookup |
| `POLICY_MAX_RETRY_ATTEMPTS` | `3` | Retry ceiling per payment |
| `POLICY_MAX_AUTOMATED_AMOUNT` | `1000000` | Paise (INR 10,000) |
| `POLICY_MIN_RECOVERY_CONFIDENCE` | `0.75` | Below this, no auto-execution |
| `POLICY_RETRY_COOLDOWN_SECONDS` | `3600` | Minimum gap between retries |
| `POLICY_HIGH_VALUE_THRESHOLD` | `1000000` | At/above this, human approval |
| `DATASET_SEED` | `42` | Reproducibility seed |

`mock` is the default for both providers so that tests and the batch demo run
with **no API keys, no cost, and no variance between runs**.

Selecting a real provider **without its credentials fails at startup**.
RecoverAI never silently falls back to a mock: a deployment must not appear to
use a real model or payment gateway while serving deterministic stubs.

Secret values belong in `.env` only, which is gitignored. `.env.example`
documents every variable with empty placeholders.

### Secret handling

- Secrets are read from the environment server-side only, never sent to the
  frontend.
- `.env` is gitignored; only `.env.example` (with empty values) is committed.
- `redactedConfig()` reduces every secret to a presence flag before anything is
  logged or returned over HTTP. A test asserts no secret string survives
  serialisation.
- **Live Razorpay keys are refused at startup.** A `RAZORPAY_KEY_ID` not
  prefixed `rzp_test_` throws a `ConfigError`, so the system cannot be pointed
  at real money even by mistake.

---

## Synthetic dataset

Records are drawn from a catalogue of ten labelled scenarios
([`scenarios.ts`](packages/backend/src/datasets/scenarios.ts)). Choosing the
scenario first, then materialising a payment from it, means ground-truth labels
cannot silently drift out of sync with the data.

Roughly 55% of records are successful payments, with the rest spread across the
failure classes the PRD requires — including non-recoverable and permanent
failures, so a trivial "always retry" agent scores badly rather than perfectly.

The dev/eval split is **stratified by class**, so a rare scenario (for example
`high_value_failure`) is guaranteed to appear in the held-out set rather than
landing entirely in dev by chance.

---

## API

| Endpoint | Status |
| --- | --- |
| `GET /api/health` | Working |
| `POST /api/payments` | Working |
| `GET /api/payments` | Working |
| `GET /api/payments/:paymentId` | Working |
| `POST /api/recovery/analyze` | Working — **analysis + authorization** |
| `GET /api/recovery/cases` | Working |
| `POST /api/recovery/:caseId/execute` | Working — **the only endpoint that acts** |
| `POST /api/recovery/:caseId/verify` | Working — **establishes the outcome** |
| `GET /api/recovery/:caseId/actions` | Working |
| `POST /api/recovery/:caseId/approve` | Working — **records a human decision; executes nothing** |
| `POST /api/recovery/:caseId/reject` | Working — terminal for that case |
| `POST /api/recovery/runs` | Working — batch run over a population |
| `POST /api/recovery/sweep` | Working — resolves stranded actions by observation |
| `GET /api/analytics/recovery` | Working — VERIFIED-only recovered revenue |

`/api/health` returns `200` when the database is reachable and `503` when it is
not, with the failure reason included and all credentials redacted.

### POST /api/payments

Ingests one payment event in the PRD wire shape. Stores an observation only —
it runs no analysis and contacts no payment provider.

```bash
curl -X POST http://localhost:8080/api/payments   -H 'Content-Type: application/json'   -d '{
    "payment_id": "pay_demo_123",
    "order_id": "order_demo_123",
    "customer_id": "cust_456",
    "merchant_id": "merchant_001",
    "amount": 249900,
    "currency": "INR",
    "status": "failed",
    "failure_reason": "gateway_timeout",
    "created_at": "2026-08-22T10:30:00Z"
  }'
```

Validation rejects: non-integer amounts (a fractional paise means a unit bug),
non-positive amounts, unknown statuses or currencies, a `failed` payment with no
failure reason, a `captured` payment that has one, and **any unknown field** —
so a client cannot inject a `risk_score` or `classification`.

Returns `201` on success, `400` on validation failure, `409` on a duplicate id,
`422` when the merchant or customer does not exist.

### POST /api/recovery/analyze

Runs the full analysis pipeline for one payment and returns the result.

```bash
curl -X POST http://localhost:8080/api/recovery/analyze   -H 'Content-Type: application/json'   -d '{"payment_id": "pay_demo_123"}'
```

Real output from a live run against the PRD's example payment:

```json
{
  "risk": {
    "at_risk": true,
    "revenue_at_risk": 249900,
    "classification": "TEMPORARY_FAILURE",
    "recoverability": "HIGH",
    "recoverability_score": 0.8,
    "risk_score": 0.525,
    "baseline_action": "RETRY",
    "requires_human_review": false,
    "factors": ["failure_reason=gateway_timeout", "base_recoverability=0.80",
                "customer_history=none"]
  },
  "diagnosis": {
    "classification": "TEMPORARY_FAILURE",
    "confidence": 0.92,
    "reason": "Gateway timeout is a transient gateway-side fault that commonly succeeds on retry; 3 attempt(s) remain.",
    "recommended_action": "RETRY",
    "expected_recovery_probability": 0.8,
    "requires_human_approval": false,
    "provider": "mock",
    "model": "deterministic"
  },
  "recovery_case": { "status": "OPEN", "...": "..." },
  "authorized": false,
  "executed": false
}
```

`authorized: false` and `executed: false` are always present and always false in
this phase. **This endpoint analyzes. It does not authorize, execute, retry,
refund, notify anyone, or contact any payment provider.**

Re-analyzing a payment that already has a live case returns that case with
`existing_case: true` rather than creating a competing one.

---

## Authentication

**Off by default.** Set `AUTH_ENABLED=true` and `API_AUTH_TOKEN` to protect the
API. A production deployment must do both.

```bash
AUTH_ENABLED=true
API_AUTH_TOKEN=<a long random string, min 16 chars>   # keep in .env only
```

Two header forms are accepted:

```bash
curl -H "Authorization: Bearer $TOKEN" http://localhost:8080/api/recovery/cases
curl -H "x-api-key: $TOKEN"            http://localhost:8080/api/recovery/cases
```

### Authentication is not authorization

This distinction is the whole point, and the architecture enforces it:

| | Question | Owner |
| --- | --- | --- |
| **Authentication** | *May this caller reach the API?* | the `onRequest` hook |
| **Authorization** | *Is this recovery action permitted?* | the deterministic policy engine |

A valid token buys the right to **ask**. It never satisfies a retry budget,
grants a human approval, bypasses idempotency, or authorizes an action the
policy engine refused. The two layers cannot be confused because the domain
**cannot see** the auth module: architecture tests assert that the executor,
policy engine, providers, repositories, and verifier neither import it nor
reference any of its symbols, and that only `app.ts` registers it.

### Behaviour

| Situation | Result |
| --- | --- |
| `GET /api/health`, no credentials | **200/503 — always public** (readiness probes) |
| Every other route, no credentials | `401` |
| Wrong token, either header | `401` |
| Malformed `Authorization` (`Basic …`, bare token, empty `Bearer`) | `401` |
| **Both headers with different values** | `401` — ambiguous, refused |
| Both headers with the *same* value | accepted (a proxy may copy one to the other) |
| Repeated `x-api-key` header | `401` — ambiguous |
| Unknown path, no credentials | `401`, not `404` — path existence is not disclosed |

Comparison uses `crypto.timingSafeEqual`, so a wrong token cannot be recovered
one byte at a time from response timing.

Every rejection returns the **same** generic body and a
`WWW-Authenticate: Bearer` challenge. Distinguishing "malformed" from "invalid"
in the response would tell a prober whether they had the right shape. The
specific reason is logged server-side instead — **without the credential**.

### Secret handling

- `API_AUTH_TOKEN` is read only by `loadConfig()`; no route or domain module
  reads it, and a test enforces that.
- `redactedConfig()` exposes `auth.credentialPresent` — a boolean — never the
  token. `/api/health` is therefore safe to expose.
- Fastify's logger redacts `authorization` and `x-api-key` from request logs.
- A 401 never echoes the supplied credential back to the caller.
- Enabling auth without a token, or with one under 16 characters, **fails at
  startup**. RecoverAI refuses to serve an API that appears protected but
  accepts everyone.

---

## Providers

Two real integrations sit behind the existing abstractions. Neither is visible
to the policy engine, executor, verifier, or AI layer — architecture tests
enforce that vendor code stays confined to its own file.

### Gemini (AI diagnosis)

`packages/backend/src/agents/diagnosis/providers/gemini.ts`

Implements the existing `AIProvider` interface. It reuses the shared prompt
builder, system prompt, and strict validator — there is no second prompt path.

- **REST via `fetch`**, no SDK, so no vendor type reaches the domain layer.
- **One request per diagnosis.** No automatic retry.
- Key travels in the `x-goog-api-key` **header**, never a URL.
- **No deprecated Gemini 3.x sampling parameters** are sent (no `temperature`,
  `topP`, `topK`, `candidateCount`, `thinkingBudget`). `generationConfig`
  carries only `responseMimeType` and `maxOutputTokens`.
- 60s timeout. 429/5xx/timeout are classified `transient` on the thrown error.
- **Every failure throws.** A provider failure can never become an optimistic
  recommendation — `analyze` falls back to the deterministic baseline and the
  policy engine still authorizes independently.

Enable with `AI_PROVIDER=gemini` and `GEMINI_API_KEY`.

### Razorpay (recovery execution) — TEST MODE ONLY

`packages/backend/src/payments/providers/razorpay.ts`

Implements the existing `RecoveryProvider` interface. Direct HTTP; the Razorpay
SDK is not a dependency.

**Test-mode enforcement, three independent times:**

1. `loadConfig()` rejects any `RAZORPAY_KEY_ID` that is not `rzp_test_<alnum>`
2. the provider constructor rejects it again
3. `createRecoveryProvider()` refuses to fall back to the mock

A `rzp_live_*` key throws at startup. **No real money can move.**

**The API surface is exactly two endpoints** — there is no refund, transfer,
payout, or order-creation capability anywhere in the code:

| Operation | Endpoint |
| --- | --- |
| Observe state | `GET /payments/:id` |
| Capture an authorized payment | `POST /payments/:id/capture` |

**`RETRY` → Razorpay operation mapping.** Razorpay has no "retry a failed
payment" endpoint, and the provider does not invent one. It reads current state
first, then dispatches only to an operation valid for that state:

| Observed state | Operation | Outcome |
| --- | --- | --- |
| `authorized` | capture | `SUCCESS` |
| `captured` | none — already collected | `SUCCESS` |
| `failed` | **none** | `FAILED` — "no operation was performed" |
| `refunded` | none — terminal | `FAILED` |
| `created` / `pending` | none — nothing to capture | `UNKNOWN` |
| unrecognised / missing | none — fail closed | `UNKNOWN` |
| 5xx / 429 (either call) | — | `UNKNOWN` |
| 4xx on capture | — | `FAILED` |

`UNKNOWN` is never treated as `FAILED`: a transport error does not prove the
remote side did nothing, and collapsing the two could invite a double charge.

Enable with `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`.

---

## Testing

Three tiers. **Only the third makes network calls, and it is opt-in.**

### 1. Offline tests — no database, no credentials

```bash
npm test
```

Offline tests use hardcoded fake credentials and read no `.env`.

### 2. Database-backed tests

Point at a disposable PostgreSQL — never a database you care about:

```bash
RECOVERAI_TEST_DATABASE_URL=postgres://user:pass@localhost:5432/recoverai_test npm test
```

Adds the live-database integration suites. Migrations run
automatically; fixtures clean up after themselves.

### 3. Gated live provider smoke tests

**Makes real API calls.** Never runs as part of `npm test`.

```bash
# PowerShell
$env:RECOVERAI_LIVE_PROVIDER_TESTS="1"
node --experimental-strip-types --test tests/live-provider-smoke.test.ts
```

| Test | Requires | Effect |
| --- | --- | --- |
| Gemini diagnosis | `GEMINI_API_KEY` | **one** `generateContent` call, synthetic payment data only |
| Razorpay credential guards | `RAZORPAY_KEY_ID` | no network — string and constructor checks |
| Razorpay status lookup | `RAZORPAY_SMOKE_PAYMENT_ID` | **one** read-only `GET`; **skips** if unset |

The Razorpay lookup is **read-only**. It asserts the request was a `GET` and
never touched `/capture`, `/refund`, `/orders`, or `/payments/create`. Nothing
is created, captured, retried, or refunded, and no money moves.

With `RAZORPAY_SMOKE_PAYMENT_ID` unset that test reports `SKIP` rather than
guessing an id — a guessed id would either 404 or touch a payment we do not own.

---

## The deterministic policy engine

The AI produces a recommendation. **This layer decides whether it is allowed.**
Nothing the model returns can widen a limit or skip a rule — the recommendation
arrives as an ordinary input field, `proposedAction`, and is checked like any
other value.

`evaluatePolicy(input, config)` is a **pure function**: no database, no network,
no clock, no randomness, no LLM. Architectural tests enforce all of that at the
import level, and assert the engine contains no `Date.now()`, no `Math.random`,
and no `await`.

### Three invariants

1. **Fail closed.** A missing payment id, a fractional amount, a `NaN`
   confidence, or an unrecognised payment status all produce
   `authorized: false`. No code path defaults to permission.

2. **Approval is not authorization.** A rule returning `REQUIRES_APPROVAL` sets
   `requiresHumanApproval: true` and leaves `authorized: false`. "A human must
   look at this" is never silently upgraded into "go ahead".

3. **Value never overrides safety** (PRD §16). Expected recovery value is not
   an input to this layer at all — there is no field for it — so a ₹10,00,000
   opportunity is blocked exactly as readily as a ₹10 one.

### Rules

| Rule | Blocks when |
| --- | --- |
| `REQUIRED_INFORMATION_PRESENT` | id, amount, confidence, or attempts missing/invalid |
| `ACTION_SUPPORTED` | the action is not one of the six supported strategies |
| `PAYMENT_STATE_KNOWN` | the payment status is unrecognised |
| `PAYMENT_NOT_ALREADY_RECOVERED` | the payment is already recovered |
| `PAYMENT_STATE_NOT_CONFLICTING` | already captured or refunded |
| `PAYMENT_ELIGIBLE_FOR_RECOVERY` | the status cannot support a recovery action |
| `NO_DUPLICATE_ACTION` | an equivalent action already exists |
| `RETRY_LIMIT_AVAILABLE` | attempts have reached `POLICY_MAX_RETRY_ATTEMPTS` |
| `RETRY_COOLDOWN_ELAPSED` | the cooldown since the last attempt has not passed |
| `AMOUNT_WITHIN_AUTOMATED_LIMIT` | *gates on approval* above `POLICY_MAX_AUTOMATED_AMOUNT` |
| `CONFIDENCE_SUFFICIENT` | confidence is below `POLICY_MIN_RECOVERY_CONFIDENCE` |
| `HIGH_VALUE_APPROVAL` | *gates on approval* at/above `POLICY_HIGH_VALUE_THRESHOLD` |

Every rule is evaluated even after an earlier one fails, so an operator sees the
complete picture rather than only the first objection. Each decision carries a
`policy_version` (currently `v1`).

Rules that do not apply to an action are reported `NOT_APPLICABLE` rather than
passed: a reminder consumes no retry budget, so an exhausted budget must not
block the one action that could still recover the payment.

### Verified behaviour

Real output from a live run, matching the PRD's worked examples:

| Case | AI says | Policy | `authorized` | Reason |
| --- | --- | --- | --- | --- |
| ₹2,499 timeout, 0 attempts | RETRY | `ALLOWED` | `true` | — |
| ₹25,000 timeout | RETRY | `REQUIRES_APPROVAL` | `false` | `HIGH_VALUE_REQUIRES_APPROVAL` |
| attempts = 3 | RETRY | `BLOCKED` | `false` | `MAX_RETRIES_EXCEEDED` |
| confidence 0.54 | RETRY | `BLOCKED` | `false` | `INSUFFICIENT_CONFIDENCE` |
| already recovered | RETRY | `BLOCKED` | `false` | `PAYMENT_ALREADY_RECOVERED` |
| duplicate action | RETRY | `BLOCKED` | `false` | `DUPLICATE_ACTION` |
| unknown status | RETRY | `BLOCKED` | `false` | `UNKNOWN_PAYMENT_STATE` |

Note the second row: the AI still recommends RETRY, and policy still refuses to
authorize it. That is the separation working.

**Authorization is not execution.** `/api/recovery/analyze` now returns a real
computed `authorized`, but `executed` remains constantly `false` — no executor
exists, and no payment provider is imported anywhere in the codebase.

---

## The recovery executor

The first component permitted to cause an effect outside this process — and the
one with the least authority. It makes **no decisions**: it does not read the AI
recommendation, does not run the policy engine, and cannot re-authorize
anything. An architectural test asserts it never imports `evaluatePolicy`.

```
POST /api/recovery/:caseId/execute
        │
        ├─ execute-service: re-runs risk detection + policy against CURRENT
        │  state, so an analysis-time verdict can never authorize execution
        │
        └─ executor
             ├─ refuse unless policy.authorized === true      (no provider call)
             ├─ refuse if policy.requiresHumanApproval        (no provider call)
             ├─ refuse a missing idempotency key              (no provider call)
             ├─ refuse a non-executable action                (no provider call)
             ├─ CLAIM the idempotency key in PostgreSQL ◄── the race is settled here
             ├─ provider.executeAction()                      (only if claimed)
             └─ persist the verdict + audit
```

### Idempotency

The key is the **logical action**, not the HTTP request:

```
recovery:{caseId}:{actionType}:{policyVersion}
```

Submitting the same case twice produces the same key, so the second attempt
collides and never reaches the provider. A per-request random key would defeat
this entirely.

Enforcement is the database's `UNIQUE` constraint, via
`INSERT ... ON CONFLICT (idempotency_key) DO NOTHING`. This is deliberately
**not** a read-then-write check: two concurrent callers can both read "no
existing action", so only the database can arbitrate. **The provider is never
called before the insert establishes ownership.**

Verified against live PostgreSQL: **5 simultaneous execution attempts for the
same logical action produce exactly 1 provider call and 1 action row.**

### Execution states

| State | Meaning |
| --- | --- |
| `PENDING` | key claimed, provider not yet called |
| `EXECUTING` | provider request in flight |
| `SUCCESS` | provider accepted the request |
| `FAILED` | provider explicitly rejected it |
| `UNCONFIRMED` | outcome **UNKNOWN** — a safety state |
| `SKIPPED_DUPLICATE` | an equivalent action already owned the key |

**`UNCONFIRMED` is not a failure.** It means we do not know whether the action
took effect. It is never collapsed into `FAILED` and never resolved by an
automatic retry — only by verifying provider/payment state. A thrown transport
error is classified `UNKNOWN` rather than `FAILED` for the same reason: an
exception does not prove the remote side did nothing.

### Success is not recovery

`EXECUTION_SUCCEEDED` means **the provider accepted the request**. It does not
mean revenue was recovered.

`verified` is therefore hardcoded `false` throughout this phase, the payment
row is never mutated by execution, and the audit metadata says so explicitly
(`"note": "provider_accepted_request_recovery_not_verified"`). Outcome
verification is a later phase.

### Verified behaviour

Real output from a live run:

| Case | Policy | Executor | Provider calls | Action rows |
| --- | --- | --- | --- | --- |
| ₹2,499 retry | `ALLOWED` | `EXECUTION_SUCCEEDED` | 1 | 1 |
| ₹25,000 | `REQUIRES_APPROVAL` | `REFUSED` (403) | **0** | **0** |
| retries exhausted | `BLOCKED` | `REFUSED` (409) | **0** | **0** |
| duplicate submit | — | `REFUSED` | 0 (unchanged) | 1 (unchanged) |
| 5× concurrent | `ALLOWED` | 1 executes | **1** | **1** |
| provider timeout | `ALLOWED` | `EXECUTION_UNKNOWN` | 1 | 1 (`UNCONFIRMED`) |

Razorpay is **not** integrated: the SDK is not installed, no module imports it,
and requesting `PAYMENT_PROVIDER=razorpay` throws rather than silently
simulating money movement.

---

## Outcome verification

The layer that closes the loop. It enforces the distinction the whole system
rests on:

> **"Execution happened" is not "revenue was recovered."**

A provider saying *"retry accepted"* is an acknowledgement of our request. It is
not evidence about the money. Verification establishes the business outcome
independently, by observing the payment.

```
execution result ──► observe payment state ──► deterministic verifier ──► outcome
                     (a READ; never re-executes)
```

`verifyOutcome()` is a **pure function** — no database, no network, no clock, no
randomness, no LLM, no policy. Architectural tests assert it contains no
`Date.now()`, no `await`, and no import of the executor or policy engine.

### The rules

| Execution | Observed payment | Outcome |
| --- | --- | --- |
| `SUCCESS` | `SUCCEEDED` | **VERIFIED** |
| `SUCCESS` | `PENDING` | UNCONFIRMED |
| `SUCCESS` | `FAILED` | NOT_RECOVERED |
| `SUCCESS` | not observed | UNCONFIRMED |
| `UNCONFIRMED` | `SUCCEEDED` | **VERIFIED** ← the UNKNOWN resolution path |
| `UNCONFIRMED` | `PENDING` / `UNKNOWN` | UNCONFIRMED |
| `FAILED` | *(not consulted)* | NOT_RECOVERED |
| `PENDING` / `EXECUTING` / `SKIPPED_DUPLICATE` | — | UNCONFIRMED |

**A provider SUCCESS alone never yields VERIFIED.** Without a corroborating
observation the outcome stays unconfirmed. There is deliberately no
"probably recovered" status.

### Resolving UNKNOWN without retrying

An execution that timed out is `UNCONFIRMED`: we do not know whether it took
effect. Verification resolves it by **asking what the payment's state is now** —
`getPaymentStatus()` is a read with no side effects. An ambiguous execution
whose payment is observably complete *was* a recovery, established with **zero
re-executions**.

Verification answers *"what happened?"*. It never answers *"what should we do
next?"* — that belongs to the policy and recovery layers.

### Evidence, not a boolean

Every verdict carries structured evidence, so a reviewer can reconstruct why an
outcome was called recovered:

| type | source | value |
| --- | --- | --- |
| `EXECUTION_RESULT` | `PROVIDER_EXECUTION` | `SUCCESS` |
| `OBSERVED_PAYMENT_STATE` | `PROVIDER_PAYMENT_STATUS` | `SUCCEEDED` |
| `STORED_PAYMENT_STATE` | `LOCAL_PAYMENT_RECORD` | `failed` |

Evidence never contains credentials, authorization headers, or raw provider
payloads — only the specific facts the verdict rests on.

### The one path to "recovered"

`RECOVERED` is reachable from exactly one place: a `VERIFIED` verdict. An
architectural test asserts the executor never references the status, never
writes a verification verdict, and never sets `verified: true`.

The payment record is likewise only ever refreshed from verified evidence —
one guarded caller, enforced by test. Execution deliberately leaves payment
state untouched, which is why a genuinely recovered payment reads stale locally
until verification confirms it.

### Idempotency

Repeating verification is safe. A terminal verdict short-circuits before any
provider lookup, so a repeat performs **no provider I/O at all**, adds no
evidence, and writes no duplicate audit events.

`VERIFIED` and `NOT_RECOVERED` never regress — enforced in SQL, not application
code. Only `UNCONFIRMED` stays open to revision, which is exactly the path an
ambiguous execution needs.

### Verified behaviour

Real output from a live run:

| Scenario | Policy | Execution | Verification | Recovered | Case |
| --- | --- | --- | --- | --- | --- |
| ₹2,499 | `ALLOWED` | `SUCCESS` | **VERIFIED** | ✅ | `RECOVERED` |
| ₹25,000 | `REQUIRES_APPROVAL` | *refused* | *nothing to verify* | ❌ | `OPEN` |
| timeout, payment settled | `ALLOWED` | `UNCONFIRMED` | **VERIFIED** | ✅ | `RECOVERED` |
| timeout, still pending | `ALLOWED` | `UNCONFIRMED` | UNCONFIRMED | ❌ | `AWAITING_VERIFICATION` |
| provider rejected | `ALLOWED` | `FAILED` | NOT_RECOVERED | ❌ | `FAILED` |

Across that batch: **1 provider success, but 2 verified recoveries** — because
one recovery came from an execution the provider never confirmed. Counting
provider acknowledgements would have got both numbers wrong.

---

## The AI safety boundary

The single most important property in this codebase: **evaluation labels can
never reach an AI provider.** If they did, every accuracy metric would be
meaningless — the model would be graded on data it was handed.

This is enforced four ways, deliberately redundant:

1. **Structurally.** `DiagnosisInput` extends `ForbiddenEvaluationKeys`, which
   types every label-shaped key (`groundTruth`, `recoverable`, `ideal_action`,
   `split`, …) as `never`. An object literal carrying one fails to compile.

2. **At runtime.** `assertNoEvaluationData()` walks the finished input to any
   depth and throws `EvaluationDataLeakError` on a forbidden key — catching
   values that arrive as `unknown` from a database row or parsed JSON, where
   the type system cannot help.

3. **By construction.** `buildDiagnosisInput()` copies named fields only. There
   is no spread of a payment row anywhere in it, so a ground-truth column added
   to the database later cannot ride along into a prompt by accident.

4. **Architecturally.** A test walks every file under `src/agents/` and fails if
   any of them imports the database layer, a payment provider, an executor, or a
   vendor SDK — or so much as mentions the labels table. The executor does not
   exist yet; the test fails the moment someone adds one and wires it to the AI
   layer, which is exactly when it matters.

The realistic leak scenario is covered directly: a test takes a real generated
dataset record (which genuinely carries ground truth), pushes it through the
builder, and asserts that neither the resulting input nor the **rendered prompt
text** contains any label.

### What the AI cannot do

- It has no database handle, no payment provider client, and no HTTP client.
- Its interface exposes exactly one method: `diagnose()`.
- Its return type has no `executed`, `recovered`, `authorized`, or
  `transactionId` field — there is nowhere to put a claimed outcome.
- Its output passes a `.strict()` schema, so a response containing
  `payment_id`, `api_endpoint`, or `execute` is **rejected**, not ignored.
- Confidence and probability outside `[0,1]`, unknown classifications, unknown
  actions, and malformed JSON are all rejected.

### Failure is not fatal

If the provider throws or returns something the validator rejects, analysis
still completes using the deterministic assessment, and the failure is recorded
in the audit trail. The system degrades to rules rather than to nothing.

---

## Deterministic risk detection

Detection runs **before** any AI involvement and is a pure function — no clock,
no randomness, no database, no network. It gives the system a defensible
baseline that holds when the AI is unavailable or misbehaving.

Two invariants it never violates:

- **A non-retryable failure never yields RETRY.** An expired card, an invalid
  CVV, an unsupported method, or a declined card cannot succeed on retry, and
  repeated declines can trip issuer fraud controls.
- **An exhausted retry budget never yields RETRY.** Once attempts reach the
  configured ceiling the classification becomes `REPEATED_FAILURE` regardless of
  the underlying reason — a gateway timeout that has already failed three times
  is not a fresh transient blip.

Captured and refunded payments are never treated as revenue at risk, and never
trigger an AI call. Unknown failures escalate rather than guessing, per PRD §10
(`UNKNOWN_FAILURE = no automatic action`).

---

## Roadmap

Built (P0 1–5, 9 partial):

- [x] Monorepo scaffold, strict TypeScript, Docker Compose
- [x] PostgreSQL schema and forward-only migration runner (**live-verified**)
- [x] Deterministic synthetic dataset generator with stratified split
- [x] Configuration, policy loading, secret redaction
- [x] Health endpoint
- [x] Payment ingestion and retrieval
- [x] Deterministic revenue-risk detection and recoverability scoring
- [x] AI provider abstraction with deterministic MockAI
- [x] Structured diagnosis with strict schema validation
- [x] Ground-truth boundary (compile-time, runtime, architectural)
- [x] Recovery case persistence
- [x] Audit trail writes for every decision
- [x] **Deterministic policy engine** — the authorization step
- [x] **Recovery executor** — the execution step, with database-enforced
      idempotency and safe UNKNOWN handling
- [x] **Outcome verification** — evidence-based business outcome, with the
      UNKNOWN resolution path
- [x] **Gemini AI provider** — live-verified with a real `generateContent` call
- [x] **Razorpay Test Mode provider** — implemented, unit-tested, credential
      guards live-verified

- [x] **API authentication** — shared token, timing-safe, health stays public
- [x] **Batch recovery + analytics** — population-level runs, aggregate metrics
- [x] **Crash recovery sweeper** — resolves stranded actions by observation,
      never by a blind retry
- [x] **Human approval workflow** — approval satisfies policy gates only, never
      a failure rule
- [x] **Evaluation harness** — precision/recall/F1 against
      `payment_ground_truth`, ground truth never reaching the model
- [x] **CI (GitHub Actions), ESLint, rate limiting, fail-closed Docker auth**

Not built yet, in rough priority order:

- [ ] **Dashboard** — no frontend package exists
- [ ] **Per-user identity, roles, and token rotation** — authentication is a
      single shared token; see limitation 13
- [ ] **Distributed rate limiting** — the current limiter is in-process
- [ ] **Metrics/tracing export** — structured logs only, no OpenTelemetry

---

## Database verification

The schema has been applied to a real PostgreSQL 16.14 server (a disposable
cluster created with `initdb` on port 55432, isolated from any existing
database). Verified there, not merely asserted:

| Property | Result |
| --- | --- |
| All 8 tables created | Verified |
| Expected indexes present | Verified |
| Migration is idempotent (second run applies nothing) | Verified |
| BIGINT amounts round-trip as exact numbers at `MAX_SAFE_INTEGER` | Verified |
| Negative amounts rejected (`payments_amount_positive`) | Verified |
| Invalid status rejected (`payments_status_check`) | Verified |
| Duplicate `idempotency_key` rejected | Verified |
| Second live recovery case per payment rejected | Verified |
| A new case is allowed once the previous one is closed | Verified |
| `UPDATE` on `audit_events` raises `append-only` | Verified |
| `DELETE` on `audit_events` raises `append-only` | Verified |
| Orphan foreign keys rejected | Verified |

---

## Known limitations

Stated plainly, because the PRD asks for honest reporting:

1. **Gemini is the only real LLM provider.** Claude and OpenAI are named in the
   config and factory, but constructing either **throws** rather than silently
   falling back to MockAI — a misconfigured deployment fails loudly instead of
   producing plausible fake diagnoses. MockAI remains available and is the
   default; it is a transparent rule-based diagnoser, not a simulated LLM, so
   its outputs say nothing about how a real model performs.
2. **Verification is explicit, not automatic.** Nothing verifies an outcome on
   its own: `POST /api/recovery/:caseId/verify` must be called. An action can
   therefore sit `AWAITING_VERIFICATION` indefinitely. A background worker is
   the natural next step but was deliberately not built here.
3. **Observed payment state comes from whichever provider is configured.** With
   `PAYMENT_PROVIDER=mock` the observations are simulated. With
   `PAYMENT_PROVIDER=razorpay` they come from Razorpay Test Mode — real API
   responses, but never real money.
4. **Only `RETRY` is executable.** `REMINDER`, `CHECKOUT_RECOVERY`, and
   `SUBSCRIPTION_RETRY` are authorized by policy but no provider can perform
   them, so the executor refuses them as `UNSUPPORTED_ACTION` rather than
   pretending to act.
5. **The idempotency key includes the policy version.** Bumping the version
   permits one further execution of a case that already executed under the old
   rules. That is a deliberate trade-off (a different rule set is arguably a
   different logical action) but it must become an explicit decision once the
   approval flow lands.
6. **Razorpay is implemented but its live HTTP path is only partly proven.**
   The provider is fully unit-tested against an injected transport (44 tests),
   and the credential guards are live-verified. The read-only status lookup
   against the real API runs only when `RAZORPAY_SMOKE_PAYMENT_ID` is set; with
   it unset that test **skips**, so real-API response parsing and status
   normalization remain unverified in this checkout. TEST MODE is enforced in
   three independent places — a `rzp_live_*` key is rejected at startup, so no
   real money can move.
7. **Batch metrics are computable but not exposed.** The persisted state
   distinguishes executions, verified recoveries, non-recoveries, and unresolved
   outcomes, but no endpoint or dashboard aggregates them yet.
8. **No accuracy metrics are computed yet.** `payment_ground_truth` is
   populated by the seeder and structurally walled off from the AI, but nothing
   scores predictions against it. No precision/recall/F1 exists — reporting any
   would be fabrication.
9. **`recoveryProbability` in the dataset is a simulation parameter**, not a
   measured quantity. It defines what a future simulated executor will do; it is
   not evidence of real-world recoverability.
10. **The `attempt_count` on an ingested payment is client-supplied.** Until the
   executor exists there is no server-side retry ledger to reconcile it against,
   so a caller could understate prior attempts. The retry ceiling is enforced
   against the value stored.
11. **Docker is not installed in the development environment used so far**, so
   `docker compose up -d db` and the container build are still unexercised. The
   schema was verified against a locally-installed PostgreSQL 16.14 instead.
12. **`npm test` and `npm run build` may fail on Windows** if `node` is not on
   the PATH that npm hands to `cmd.exe`, even when it is available in your
   shell. Running `node --experimental-strip-types --test "tests/**/*.test.ts"`
   directly works regardless.
13. **Authentication is a single shared token — there is no user-level
    accountability.** Everyone who holds the token is indistinguishable to the
    system. Concretely:

    - **No individual operator identity.** An approval is recorded against
      `api:authenticated-operator`, which is a *service* identity, not a
      person. The audit trail can prove *that* a decision was made and when;
      it cannot prove *who* made it. The `actor` column exists so a real
      identity system can slot in without a schema change.
    - **No roles or scopes.** Any valid token can approve a ₹25,000 recovery,
      trigger a batch run, and read every analytic. There is no separation of
      duties.
    - **No rotation mechanism.** Rotating the token is an operational task:
      set a new `API_AUTH_TOKEN` and restart. There is no overlap window, so
      rotation is a brief outage for API clients.
    - **Rate limiting exists** (`RATE_LIMIT_*`) and bounds brute-force
      guessing, but it is in-process — N replicas permit N times the limit. A
      real deployment should also limit at the reverse proxy.

    `AUTH_ENABLED` defaults to `false` locally so the test suites and local
    development need no configuration; **Docker Compose defaults it to `true`
    and refuses to start without a token.** Note that authentication is not
    authorization: it controls who may call the API, never which recovery
    actions are permitted — that stays with the policy engine.

---

## Engineering principles

1. **Safety before cleverness.** The AI cannot move money. The policy engine is
   deterministic, configurable, and testable in isolation.
2. **Fail visibly.** A failed API call is recorded as `FAILED` or
   `UNCONFIRMED` — never silently retried, never reported as success.
3. **Never fabricate a number.** Every metric is computed from stored outcomes.
   Where something is not yet measured, this README says so.
4. **Money is an integer.** Minor units end to end, `BIGINT` in the database.
