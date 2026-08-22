-- =============================================================================
-- Execution state for the recovery executor.
--
-- Forward-only: this file adds to 001 rather than editing it. The existing
-- execution_status vocabulary already covers most of what the executor needs
-- (PENDING, SUCCESS, FAILED, UNCONFIRMED, SKIPPED_DUPLICATE); this migration
-- adds the in-flight state and the policy provenance columns.
-- =============================================================================

-- EXECUTING marks the window between claiming the idempotency key and hearing
-- back from the provider. A row stuck in EXECUTING after a crash is exactly as
-- ambiguous as UNCONFIRMED and must be resolved by state verification, never by
-- a blind retry.
ALTER TABLE recovery_actions
    DROP CONSTRAINT IF EXISTS recovery_actions_execution_check;

ALTER TABLE recovery_actions
    ADD CONSTRAINT recovery_actions_execution_check CHECK (
        execution_status IN (
            'PENDING',
            'EXECUTING',
            'SUCCESS',
            'FAILED',
            'UNCONFIRMED',
            'SKIPPED_DUPLICATE'
        )
    );

-- Provenance of the authorization that permitted this action. Recorded so an
-- auditor can tell which rule set allowed a given execution, and so a future
-- approval flow can detect that a decision was made under an older policy.
ALTER TABLE recovery_actions
    ADD COLUMN IF NOT EXISTS policy_version TEXT;

-- Which provider performed the action ('mock', later 'razorpay'). Without this
-- a stored SUCCESS is ambiguous about whether real money moved.
ALTER TABLE recovery_actions
    ADD COLUMN IF NOT EXISTS provider TEXT;

-- When the provider result was recorded, distinct from executed_at (when the
-- request was sent). The gap between them is the ambiguity window.
ALTER TABLE recovery_actions
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Actions needing human attention are queried constantly by an ops dashboard;
-- UNCONFIRMED especially, because each one blocks further action on a payment.
CREATE INDEX IF NOT EXISTS recovery_actions_unresolved_idx
    ON recovery_actions (execution_status)
    WHERE execution_status IN ('PENDING', 'EXECUTING', 'UNCONFIRMED');
