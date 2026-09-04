# RecoverAI

## AI-Assisted Payment Recovery Platform

When a payment fails, the revenue behind it is not always lost — but recovering it
means knowing *why* it failed, *what* to do next, and *whether* that action is safe
to take. RecoverAI diagnoses failed and abandoned payments, recommends a recovery
action for each one, and routes anything risky to a human before it runs.

The important part is the division of labour:

> **AI recommends. Policy authorizes. Humans approve. Evidence verifies.**
>
> The AI never calls a payment API and never decides whether money moves.

Built for the Razorpay AI Buildathon (Track 03).

---

## 🧪 Demo Mode

The public demonstration environment uses **simulated payments and mock providers**.

- No real Razorpay account is connected.
- No real customer data is used.
- No real payments are processed and no money is moved.
- The AI provider is a deterministic mock, so the demo costs nothing to run.

Every screen is populated by the same recovery pipeline the real system uses — the
data flowing through it is synthetic, but the diagnosis, policy checks, approvals,
and audit trail are genuinely produced, not hardcoded.

---

## ✨ What You Can Explore

- 📊 **Overview** — recovery performance and what currently needs attention
- 💳 **Payments** — every payment and its current status
- 🔄 **Recovery Cases** — diagnosed failures, with the recommendation for each
- ✅ **Approvals** — the human-in-the-loop queue for high-value actions
- 📈 **Analytics** — recovery rates and revenue at risk versus recovered
- 📜 **Audit Log** — every decision the system made, newest first

---

## 🔄 How RecoverAI Works

```text
Payment Issue
     ↓
AI Diagnosis          what went wrong, and what should be tried
     ↓
Policy Check          deterministic limits: retries, amounts, confidence
     ↓
Human Approval        required for high-value or low-confidence actions
     ↓
Recovery Action       executed only if policy allowed it
     ↓
Outcome Verification  confirmed against the provider before counting as recovered
```

Each stage can only narrow what the previous one proposed. A recommendation is not
an authorization, and an authorization is not an outcome.

---

## 🛡️ Safety

- The AI **recommends only**. It cannot authorize an action, widen a limit, or move money.
- A **deterministic policy engine** enforces retry limits, amount ceilings, and a
  minimum confidence threshold. It is ordinary code, not a model.
- **High-value actions require human approval** before anything executes.
- An action counts as *recovered* only when **verified against the provider** —
  never merely because a request was accepted.
- Every decision is written to an **audit trail**.

---

## 🛠️ Technology

| Layer | Stack |
| --- | --- |
| Frontend | React, TypeScript, Vite, Tailwind CSS, TanStack Query |
| Backend | Node.js 22, TypeScript, Fastify, Zod |
| Database | PostgreSQL |
| Deployment | Render (backend + database), Vercel (frontend) |

Structured as an npm workspaces monorepo:

```text
packages/
├── backend/    Fastify API, recovery pipeline, policy engine
└── frontend/   React operations console
```

---

## ▶️ Run Locally

Requires **Node.js 22** and Docker (for the local PostgreSQL).

```bash
npm install
```

Start the database and apply migrations:

```bash
npm run db:up
npm run migrate
```

Load demo data:

```bash
npm run seed -- --db
```

Run the backend and frontend in separate terminals:

```bash
npm run dev
```

```bash
npm run dev:frontend
```

### Checks

```bash
npm run typecheck
```

```bash
npm run build
```

```bash
npm test
```

Configuration is read from environment variables; see [`.env.example`](.env.example)
for the full list with safe placeholder values.

---

## 📚 Engineering Documentation

The detailed design notes — the policy engine, the executor's idempotency model,
outcome verification, the AI safety boundary, the data model, and the full API
reference — live in [`docs/ENGINEERING.md`](docs/ENGINEERING.md).

---

## 📌 Project Status

**Hackathon demo / active development.**

The public deployment is a demonstration environment running on simulated data.
Connecting a real payment account is not part of the current scope.
