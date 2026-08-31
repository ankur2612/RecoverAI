-- =============================================================================
-- Human approval decisions.
--
-- Forward-only and idempotent, like every migration before it.
--
-- WHY A TABLE RATHER THAN A COLUMN ON recovery_cases
--
-- An approval is an EVENT with an actor, a decision, a reason, and a moment.
-- Flattening it onto the case would lose the actor and reason, and a second
-- decision would overwrite the first — destroying exactly the history an
-- auditor needs when asking "who authorised a ₹25,000 recovery, and why?".
--
-- WHAT THIS TABLE IS NOT
--
-- It is NOT an authorization record. A row here means "a human reviewed this
-- case and said yes"; it never means the action may execute. The deterministic
-- policy engine still re-evaluates every rule against CURRENT state at
-- execution time, and every failure rule (retry ceiling, cooldown, duplicate
-- action, already-recovered) can still deny an approved case.
-- =============================================================================

CREATE TABLE IF NOT EXISTS recovery_approvals (
    id                TEXT PRIMARY KEY,
    recovery_case_id  TEXT        NOT NULL REFERENCES recovery_cases (id) ON DELETE CASCADE,
    decision          TEXT        NOT NULL,
    -- Who decided. With a shared API token this is a service identity rather
    -- than a person; the column exists so a later identity system needs no
    -- schema change.
    actor             TEXT        NOT NULL,
    -- Free text from the operator. Never a credential: the API layer bounds
    -- its length and the audit writer never copies headers into it.
    reason            TEXT,
    -- The action the case recommended AT DECISION TIME. Recorded so an
    -- approval cannot silently apply to a different action if the case is
    -- later re-analysed into a new recommendation.
    approved_action   TEXT        NOT NULL,
    -- Policy version in force when the human decided, for the same reason
    -- recovery_actions records it: so an auditor can tell which rule set the
    -- decision was made under.
    policy_version    TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT recovery_approvals_decision_check CHECK (
        decision IN ('APPROVED', 'REJECTED')
    ),
    CONSTRAINT recovery_approvals_action_check CHECK (
        approved_action IN (
            'RETRY', 'REMINDER', 'CHECKOUT_RECOVERY',
            'SUBSCRIPTION_RETRY', 'ESCALATE', 'NO_ACTION'
        )
    )
);

-- ONE decision per case, enforced by the database rather than by application
-- discipline. This is what makes approve/reject idempotent under concurrency:
-- two simultaneous approvals both attempt the insert and exactly one wins,
-- the same pattern recovery_actions uses for the idempotency key.
--
-- A case therefore cannot be approved and then rejected, or decided twice.
-- Reversing a decision requires a fresh case, which is the honest lifecycle:
-- the original recommendation and its decision stay intact for audit.
CREATE UNIQUE INDEX IF NOT EXISTS recovery_approvals_one_per_case_idx
    ON recovery_approvals (recovery_case_id);

-- Operators list pending and recent decisions constantly.
CREATE INDEX IF NOT EXISTS recovery_approvals_decision_idx
    ON recovery_approvals (decision, created_at DESC);

-- APPROVED is a HUMAN decision state, deliberately distinct from the policy
-- vocabulary: it means "a person said yes", never "policy authorised this".
-- REJECTED is terminal for the case.
--
-- Rebuilt rather than altered because Postgres has no ADD VALUE for a CHECK
-- constraint; the DROP/ADD pair is idempotent on re-run.
ALTER TABLE recovery_cases
    DROP CONSTRAINT IF EXISTS recovery_cases_status_check;

ALTER TABLE recovery_cases
    ADD CONSTRAINT recovery_cases_status_check CHECK (
        status IN (
            'OPEN',
            'AWAITING_APPROVAL',
            'APPROVED',
            'REJECTED',
            'EXECUTING',
            'AWAITING_VERIFICATION',
            'RECOVERED',
            'FAILED',
            'ESCALATED',
            'CLOSED'
        )
    );

-- An APPROVED case is still live work: it must block a second live case for
-- the same payment, exactly as OPEN and AWAITING_APPROVAL do. REJECTED is
-- terminal and deliberately absent, so a rejected case does not prevent a
-- fresh analysis later.
DROP INDEX IF EXISTS recovery_cases_one_open_per_payment;

CREATE UNIQUE INDEX IF NOT EXISTS recovery_cases_one_open_per_payment
    ON recovery_cases (payment_id)
    WHERE status IN ('OPEN', 'AWAITING_APPROVAL', 'APPROVED', 'EXECUTING', 'AWAITING_VERIFICATION');
