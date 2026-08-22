-- =============================================================================
-- Outcome verification.
--
-- Forward-only and idempotent. Verification extends the EXISTING
-- recovery_actions row rather than introducing a parallel table: an outcome is
-- a property of the action that produced it, and splitting them would allow the
-- two to disagree about what happened.
--
-- The distinction this migration encodes:
--
--   execution_status     what the PROVIDER told us about our request
--   verification_status  what the EVIDENCE says actually happened
--
-- A provider SUCCESS with verification_status NULL is an action that was
-- accepted but whose business outcome is still unknown. That is the honest
-- default, and it is why verification_status is nullable rather than defaulted.
-- =============================================================================

ALTER TABLE recovery_actions
    ADD COLUMN IF NOT EXISTS verification_status TEXT;

ALTER TABLE recovery_actions
    ADD COLUMN IF NOT EXISTS verification_reason TEXT;

ALTER TABLE recovery_actions
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

-- The payment state actually observed at verification time. Distinct from the
-- status the provider claimed in its response: this is what we saw, not what we
-- were told.
ALTER TABLE recovery_actions
    ADD COLUMN IF NOT EXISTS observed_payment_status TEXT;

-- Structured evidence supporting the verdict, as an array of observations.
-- Stored so a reviewer can reconstruct WHY an outcome was called recovered.
-- Must never contain credentials or raw provider payloads.
ALTER TABLE recovery_actions
    ADD COLUMN IF NOT EXISTS verification_evidence JSONB NOT NULL DEFAULT '[]'::jsonb;

-- How many times verification has run. Repeated verification is safe, but the
-- count makes a stuck ambiguous action visible to an operator.
ALTER TABLE recovery_actions
    ADD COLUMN IF NOT EXISTS verification_attempts INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'recovery_actions_verification_check'
    ) THEN
        ALTER TABLE recovery_actions
            ADD CONSTRAINT recovery_actions_verification_check CHECK (
                verification_status IS NULL OR verification_status IN (
                    'VERIFIED',        -- evidence confirms the business outcome
                    'NOT_RECOVERED',   -- evidence confirms it did NOT happen
                    'UNCONFIRMED'      -- evidence is insufficient; fail closed
                )
            );
    END IF;
END $$;

ALTER TABLE recovery_actions
    DROP CONSTRAINT IF EXISTS recovery_actions_verification_attempts_check;

ALTER TABLE recovery_actions
    ADD CONSTRAINT recovery_actions_verification_attempts_check
        CHECK (verification_attempts >= 0);

-- An operations queue will constantly ask "what is still unresolved?" — every
-- unverified or ambiguous action blocks further work on its payment.
CREATE INDEX IF NOT EXISTS recovery_actions_unverified_idx
    ON recovery_actions (verification_status)
    WHERE verification_status IS NULL OR verification_status = 'UNCONFIRMED';

-- -----------------------------------------------------------------------------
-- Recovery case lifecycle.
--
-- AWAITING_VERIFICATION fills the gap between "we acted" and "we know what
-- happened". Without it, an executed-but-unverified case is indistinguishable
-- from one that was never acted on.
--
-- RECOVERED already exists and keeps its meaning: it is set ONLY by verified
-- evidence, never by a provider acknowledgement.
-- -----------------------------------------------------------------------------
ALTER TABLE recovery_cases
    DROP CONSTRAINT IF EXISTS recovery_cases_status_check;

ALTER TABLE recovery_cases
    ADD CONSTRAINT recovery_cases_status_check CHECK (
        status IN (
            'OPEN',
            'AWAITING_APPROVAL',
            'EXECUTING',
            'AWAITING_VERIFICATION',
            'RECOVERED',
            'FAILED',
            'ESCALATED',
            'CLOSED'
        )
    );

-- The partial unique index from 001 lists the statuses that count as "live".
-- AWAITING_VERIFICATION must join them: an action is outstanding on that
-- payment, so a second competing case must not be openable.
DROP INDEX IF EXISTS recovery_cases_one_open_per_payment;

CREATE UNIQUE INDEX IF NOT EXISTS recovery_cases_one_open_per_payment
    ON recovery_cases (payment_id)
    WHERE status IN ('OPEN', 'AWAITING_APPROVAL', 'EXECUTING', 'AWAITING_VERIFICATION');
