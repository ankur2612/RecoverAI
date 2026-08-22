-- =============================================================================
-- RecoverAI — initial schema (PRD section 24)
--
-- Money: every amount column is BIGINT in the smallest currency unit (paise).
-- Never store money as NUMERIC/FLOAT here; the application layer assumes ints.
-- =============================================================================

CREATE TABLE IF NOT EXISTS merchants (
    id          TEXT PRIMARY KEY,
    name        TEXT        NOT NULL,
    currency    TEXT        NOT NULL DEFAULT 'INR',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT merchants_currency_check CHECK (currency IN ('INR'))
);

CREATE TABLE IF NOT EXISTS customers (
    id          TEXT PRIMARY KEY,
    merchant_id TEXT        NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
    name        TEXT        NOT NULL,
    email       TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customers_merchant_idx ON customers (merchant_id);

CREATE TABLE IF NOT EXISTS payments (
    id              TEXT PRIMARY KEY,
    merchant_id     TEXT        NOT NULL REFERENCES merchants (id) ON DELETE CASCADE,
    customer_id     TEXT        NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
    order_id        TEXT        NOT NULL,
    amount          BIGINT      NOT NULL,
    currency        TEXT        NOT NULL DEFAULT 'INR',
    status          TEXT        NOT NULL,
    failure_reason  TEXT,
    attempt_count   INTEGER     NOT NULL DEFAULT 0,
    is_subscription BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT payments_amount_positive CHECK (amount > 0),
    CONSTRAINT payments_attempts_sane CHECK (attempt_count >= 0),
    CONSTRAINT payments_status_check CHECK (
        status IN ('created', 'authorized', 'captured', 'failed', 'refunded', 'abandoned')
    )
);

CREATE INDEX IF NOT EXISTS payments_merchant_idx ON payments (merchant_id);
CREATE INDEX IF NOT EXISTS payments_customer_idx ON payments (customer_id);
CREATE INDEX IF NOT EXISTS payments_status_idx ON payments (status);
CREATE INDEX IF NOT EXISTS payments_created_idx ON payments (created_at DESC);

-- -----------------------------------------------------------------------------
-- Ground-truth labels for synthetic records.
--
-- Deliberately a SEPARATE table from payments: these labels must never be
-- joined into the payload sent to an AI provider, and keeping them out of the
-- payments row makes accidental leakage far less likely. Only the evaluation
-- harness reads this table.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payment_ground_truth (
    payment_id          TEXT PRIMARY KEY REFERENCES payments (id) ON DELETE CASCADE,
    classification      TEXT             NOT NULL,
    recoverable         BOOLEAN          NOT NULL,
    recovery_probability DOUBLE PRECISION NOT NULL,
    ideal_action        TEXT             NOT NULL,
    split               TEXT             NOT NULL,
    CONSTRAINT ground_truth_split_check CHECK (split IN ('dev', 'eval')),
    CONSTRAINT ground_truth_probability_range CHECK (
        recovery_probability >= 0 AND recovery_probability <= 1
    )
);

CREATE INDEX IF NOT EXISTS ground_truth_split_idx ON payment_ground_truth (split);

CREATE TABLE IF NOT EXISTS recovery_cases (
    id                   TEXT PRIMARY KEY,
    payment_id           TEXT             NOT NULL REFERENCES payments (id) ON DELETE CASCADE,
    risk_score           DOUBLE PRECISION NOT NULL,
    recoverability_score DOUBLE PRECISION NOT NULL,
    classification       TEXT             NOT NULL,
    recommended_action   TEXT             NOT NULL,
    confidence           DOUBLE PRECISION NOT NULL,
    revenue_at_risk      BIGINT           NOT NULL,
    reason               TEXT             NOT NULL,
    status               TEXT             NOT NULL,
    created_at           TIMESTAMPTZ      NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ      NOT NULL DEFAULT now(),
    CONSTRAINT recovery_cases_confidence_range CHECK (confidence >= 0 AND confidence <= 1),
    CONSTRAINT recovery_cases_scores_range CHECK (
        risk_score >= 0 AND risk_score <= 1
        AND recoverability_score >= 0 AND recoverability_score <= 1
    ),
    CONSTRAINT recovery_cases_action_check CHECK (
        recommended_action IN (
            'RETRY', 'REMINDER', 'CHECKOUT_RECOVERY',
            'SUBSCRIPTION_RETRY', 'ESCALATE', 'NO_ACTION'
        )
    ),
    CONSTRAINT recovery_cases_status_check CHECK (
        status IN (
            'OPEN', 'AWAITING_APPROVAL', 'EXECUTING',
            'RECOVERED', 'FAILED', 'ESCALATED', 'CLOSED'
        )
    )
);

-- One open case per payment at a time: prevents two concurrent analyses from
-- producing two competing recovery attempts for the same money.
CREATE UNIQUE INDEX IF NOT EXISTS recovery_cases_one_open_per_payment
    ON recovery_cases (payment_id)
    WHERE status IN ('OPEN', 'AWAITING_APPROVAL', 'EXECUTING');

CREATE INDEX IF NOT EXISTS recovery_cases_status_idx ON recovery_cases (status);

CREATE TABLE IF NOT EXISTS recovery_actions (
    id                TEXT PRIMARY KEY,
    recovery_case_id  TEXT        NOT NULL REFERENCES recovery_cases (id) ON DELETE CASCADE,
    action_type       TEXT        NOT NULL,
    policy_status     TEXT        NOT NULL,
    policy_reason     TEXT,
    execution_status  TEXT        NOT NULL DEFAULT 'PENDING',
    amount            BIGINT      NOT NULL,
    -- The idempotency key is the duplicate-execution guard (PRD section 13).
    -- UNIQUE at the database level so a race cannot produce two live actions.
    idempotency_key   TEXT        NOT NULL UNIQUE,
    provider_reference TEXT,
    error_message     TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    executed_at       TIMESTAMPTZ,
    CONSTRAINT recovery_actions_amount_sane CHECK (amount >= 0),
    CONSTRAINT recovery_actions_type_check CHECK (
        action_type IN (
            'RETRY', 'REMINDER', 'CHECKOUT_RECOVERY',
            'SUBSCRIPTION_RETRY', 'ESCALATE', 'NO_ACTION'
        )
    ),
    CONSTRAINT recovery_actions_policy_check CHECK (
        policy_status IN ('ALLOWED', 'BLOCKED', 'REQUIRES_APPROVAL')
    ),
    CONSTRAINT recovery_actions_execution_check CHECK (
        execution_status IN ('PENDING', 'SUCCESS', 'FAILED', 'UNCONFIRMED', 'SKIPPED_DUPLICATE')
    )
);

CREATE INDEX IF NOT EXISTS recovery_actions_case_idx ON recovery_actions (recovery_case_id);
CREATE INDEX IF NOT EXISTS recovery_actions_execution_idx ON recovery_actions (execution_status);

-- -----------------------------------------------------------------------------
-- Audit trail (PRD section 15).
--
-- Append-only by construction: the application role is granted INSERT and
-- SELECT only, and triggers reject UPDATE/DELETE outright. This is what makes
-- the log immutable from the normal application interface.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
    id          TEXT PRIMARY KEY,
    payment_id  TEXT,
    case_id     TEXT,
    event_type  TEXT        NOT NULL,
    actor       TEXT        NOT NULL,
    decision    TEXT,
    metadata    JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_payment_idx ON audit_events (payment_id);
CREATE INDEX IF NOT EXISTS audit_events_case_idx ON audit_events (case_id);
CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events (created_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_type_idx ON audit_events (event_type);

CREATE OR REPLACE FUNCTION reject_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only; % is not permitted', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update
    BEFORE UPDATE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

DROP TRIGGER IF EXISTS audit_events_no_delete ON audit_events;
CREATE TRIGGER audit_events_no_delete
    BEFORE DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
