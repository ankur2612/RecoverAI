import { describe, expect, test, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Payments } from '../pages/Payments.tsx';
import { PaymentDetail } from '../pages/PaymentDetail.tsx';
import { Audit } from '../pages/Audit.tsx';
import { Analytics } from '../pages/Analytics.tsx';
import { api, ApiError } from '../api/client.ts';
import type {
  AuditEvent,
  AuditListResponse,
  CaseDetail,
  Payment,
  PaymentListResponse,
  RecoveryAnalytics,
} from '../types/domain.ts';

/**
 * STAGE 2 SCREENS — Payments, Payment Detail, Audit Log, Analytics.
 *
 * The properties under test are the ones that would mislead an operator about
 * money or state if they broke: counts, the SUCCESS/RECOVERED distinction,
 * credential safety, and honest empty states.
 */

function wrap(ui: React.ReactElement, route = '/') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/payments/:paymentId" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function paymentFixture(overrides: Partial<Payment> = {}): Payment {
  return {
    payment_id: 'pay_00001',
    order_id: 'ord_00001',
    customer_id: 'cust_00001',
    merchant_id: 'merchant_001',
    amount: 249_900,
    currency: 'INR',
    status: 'failed',
    failure_reason: 'gateway_timeout',
    attempt_count: 1,
    is_subscription: false,
    created_at: '2026-08-30T10:00:00.000Z',
    updated_at: '2026-08-30T10:00:00.000Z',
    ...overrides,
  };
}

function paymentList(count: number, total: number): PaymentListResponse {
  return {
    payments: Array.from({ length: count }, (_, i) =>
      paymentFixture({ payment_id: `pay_${String(i).padStart(5, '0')}` }),
    ),
    pagination: { total, limit: 25, offset: 0 },
  };
}

function auditEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 'ae_1',
    payment_id: 'pay_00001',
    case_id: 'rc_1',
    event_type: 'EXECUTION_SUCCEEDED',
    actor: 'recoverai-executor',
    decision: 'SUCCESS',
    metadata: { action: 'RETRY', provider: 'mock' },
    created_at: '2026-08-30T10:00:00.000Z',
    ...overrides,
  };
}

function auditList(count: number, total: number): AuditListResponse {
  return {
    events: Array.from({ length: count }, (_, i) => auditEvent({ id: `ae_${i}` })),
    pagination: { total, limit: 25, offset: 0 },
  };
}

function analyticsFixture(): RecoveryAnalytics {
  return {
    total_cases: 231,
    total_payments: 220,
    amount_at_risk: 88_857_011,
    amount_recovered: 27_084_160,
    amount_unrecovered: 61_772_851,
    recovery_rate: 0.3048,
    currency_unit: 'minor',
    cases_by_status: [{ key: 'RECOVERED', count: 98 }, { key: 'OPEN', count: 58 }],
    cases_by_action: [{ key: 'RETRY', count: 120 }],
    actions_by_execution_status: [{ key: 'SUCCESS', count: 98 }],
    actions_by_verification_status: [{ key: 'VERIFIED', count: 98 }],
    actions_by_policy_status: [{ key: 'ALLOWED', count: 120 }],
    definitions: {},
  };
}

function caseDetailFixture(overrides: Partial<CaseDetail> = {}): CaseDetail {
  return {
    case: {
      id: 'rc_1',
      payment_id: 'pay_00001',
      risk_score: 0.5,
      recoverability_score: 0.8,
      classification: 'TEMPORARY_FAILURE',
      recommended_action: 'RETRY',
      confidence: 0.92,
      revenue_at_risk: 249_900,
      reason: 'Gateway timed out.',
      status: 'AWAITING_VERIFICATION',
      created_at: '2026-08-30T10:00:00.000Z',
      updated_at: '2026-08-30T10:00:00.000Z',
    },
    payment: paymentFixture(),
    actions: [
      {
        id: 'ract_1',
        recovery_case_id: 'rc_1',
        action_type: 'RETRY',
        policy_status: 'ALLOWED',
        policy_version: 'v1',
        execution_status: 'SUCCESS',
        amount: 249_900,
        idempotency_key: 'recovery:rc_1:RETRY:v1',
        provider: 'mock',
        provider_reference: 'ref_1',
        error_message: null,
        verification_status: null,
        verification_reason: null,
        verified_at: null,
        observed_payment_status: null,
        verification_attempts: 0,
        created_at: '2026-08-30T10:00:00.000Z',
        executed_at: '2026-08-30T10:00:01.000Z',
        completed_at: '2026-08-30T10:00:02.000Z',
      },
    ],
    approval: null,
    audit: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// PAYMENTS
// ---------------------------------------------------------------------------

describe('Payments — counts come from pagination.total', () => {
  test('shows the dataset total, not the page length', async () => {
    vi.spyOn(api, 'listPayments').mockResolvedValue(paymentList(25, 1000));

    const { container } = wrap(<Payments />);
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(25));

    expect(screen.getByText('1,000 payments')).toBeInTheDocument();
    expect(screen.queryByText('25 payments')).not.toBeInTheDocument();
  });

  test('a single payment is singular', async () => {
    vi.spyOn(api, 'listPayments').mockResolvedValue(paymentList(1, 1));
    wrap(<Payments />);
    await waitFor(() => expect(screen.getByText('1 payment')).toBeInTheDocument());
  });

  test('loading shows no count', async () => {
    vi.spyOn(api, 'listPayments').mockImplementation(
      () => new Promise(() => {}) as Promise<PaymentListResponse>,
    );
    wrap(<Payments />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('0 payments')).not.toBeInTheDocument();
  });

  test('an error shows NO misleading count', async () => {
    vi.spyOn(api, 'listPayments').mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
    wrap(<Payments />);
    await waitFor(() => expect(screen.getByText('Count unavailable')).toBeInTheDocument());
    expect(screen.queryByText('0 payments')).not.toBeInTheDocument();
    expect(screen.getByText('Could not load payments')).toBeInTheDocument();
  });

  test('an empty result shows an empty state', async () => {
    vi.spyOn(api, 'listPayments').mockResolvedValue(paymentList(0, 0));
    wrap(<Payments />);
    await waitFor(() =>
      expect(screen.getByText('No payments match these filters')).toBeInTheDocument(),
    );
  });

  test('money is divided exactly once', async () => {
    // 249900 paise must render as ₹2,499.00 — never ₹24.99 (double division).
    vi.spyOn(api, 'listPayments').mockResolvedValue(paymentList(1, 1));
    const { container } = wrap(<Payments />);
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(1));
    expect(container.textContent).toContain('2,499');
    expect(container.textContent).not.toContain('24.99');
  });
});

// ---------------------------------------------------------------------------
// PAYMENT DETAIL
// ---------------------------------------------------------------------------

describe('Payment Detail — honest recovery linkage', () => {
  test('a payment with NO case says so explicitly', async () => {
    vi.spyOn(api, 'getPayment').mockResolvedValue({ payment: paymentFixture() });
    // Audit returns events but none carries a case id.
    vi.spyOn(api, 'listAudit').mockResolvedValue({
      events: [auditEvent({ case_id: null, event_type: 'PAYMENT_INGESTED' })],
      pagination: { total: 1, limit: 200, offset: 0 },
    });
    const getCase = vi.spyOn(api, 'getCase');

    wrap(<PaymentDetail />, '/payments/pay_00001');
    await waitFor(() =>
      expect(screen.getByText('No recovery case exists for this payment.')).toBeInTheDocument(),
    );
    // No case was invented, and none was fetched.
    expect(getCase).not.toHaveBeenCalled();
  });

  test('a payment WITH a case links to it via the audit trail', async () => {
    vi.spyOn(api, 'getPayment').mockResolvedValue({ payment: paymentFixture() });
    vi.spyOn(api, 'listAudit').mockResolvedValue(auditList(1, 1));
    const getCase = vi.spyOn(api, 'getCase').mockResolvedValue(caseDetailFixture());

    const { container } = wrap(<PaymentDetail />, '/payments/pay_00001');
    await waitFor(() => expect(getCase).toHaveBeenCalledWith('rc_1', expect.anything()));
    // The badge label lives inside a span; assert on rendered text rather than
    // an exact-node match.
    await waitFor(() => expect(container.textContent).toContain('Provider accepted'));
  });

  test('execution SUCCESS is NEVER shown as recovered', async () => {
    // The core financial rule, on this screen too.
    vi.spyOn(api, 'getPayment').mockResolvedValue({ payment: paymentFixture() });
    vi.spyOn(api, 'listAudit').mockResolvedValue(auditList(1, 1));
    vi.spyOn(api, 'getCase').mockResolvedValue(caseDetailFixture());

    const { container } = wrap(<PaymentDetail />, '/payments/pay_00001');
    await waitFor(() => expect(container.textContent).toContain('Provider accepted'));

    expect(container.textContent).not.toContain('Recovery verified');
    expect(screen.queryByText('Recovered')).not.toBeInTheDocument();
  });

  test('a VERIFIED case DOES show the verified callout', async () => {
    vi.spyOn(api, 'getPayment').mockResolvedValue({ payment: paymentFixture() });
    vi.spyOn(api, 'listAudit').mockResolvedValue(auditList(1, 1));
    const detail = caseDetailFixture();
    vi.spyOn(api, 'getCase').mockResolvedValue({
      ...detail,
      case: { ...detail.case, status: 'RECOVERED' },
      actions: [{ ...detail.actions[0]!, verification_status: 'VERIFIED' }],
    });

    wrap(<PaymentDetail />, '/payments/pay_00001');
    await waitFor(() => expect(screen.getByText('Recovery verified')).toBeInTheDocument());
  });

  test('an UNCONFIRMED outcome shows the no-blind-retry rule and no retry button', async () => {
    vi.spyOn(api, 'getPayment').mockResolvedValue({ payment: paymentFixture() });
    vi.spyOn(api, 'listAudit').mockResolvedValue(auditList(1, 1));
    const detail = caseDetailFixture();
    vi.spyOn(api, 'getCase').mockResolvedValue({
      ...detail,
      actions: [{ ...detail.actions[0]!, verification_status: 'UNCONFIRMED' }],
    });

    wrap(<PaymentDetail />, '/payments/pay_00001');
    // Appears in both the status badge and the prominent callout, which is
    // the intent — assert presence, not uniqueness.
    await waitFor(() =>
      expect(screen.getAllByText('Outcome unconfirmed').length).toBeGreaterThan(0),
    );

    expect(screen.getByText(/will not blindly retry/i)).toBeInTheDocument();
    for (const button of screen.queryAllByRole('button')) {
      expect((button.textContent ?? '').toLowerCase()).not.toMatch(/retry|force|re-execute/);
    }
  });

  test('a 404 renders a specific message, not a crash', async () => {
    vi.spyOn(api, 'getPayment').mockRejectedValue(
      new ApiError(404, 'not_found', 'Payment not found.'),
    );
    vi.spyOn(api, 'listAudit').mockResolvedValue(auditList(0, 0));

    wrap(<PaymentDetail />, '/payments/pay_absent');
    await waitFor(() => expect(screen.getByText('Payment not found')).toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// AUDIT LOG
// ---------------------------------------------------------------------------

describe('Audit Log', () => {
  test('uses pagination.total, not the page length', async () => {
    vi.spyOn(api, 'listAudit').mockResolvedValue(auditList(25, 5718));

    const { container } = wrap(<Audit />);
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(25));

    expect(screen.getByText('5,718 events')).toBeInTheDocument();
    expect(screen.queryByText('25 events')).not.toBeInTheDocument();
  });

  test('an error shows no misleading count', async () => {
    vi.spyOn(api, 'listAudit').mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
    wrap(<Audit />);
    await waitFor(() => expect(screen.getByText('Count unavailable')).toBeInTheDocument());
    expect(screen.queryByText('0 events')).not.toBeInTheDocument();
  });

  test('an empty log is honest about what is absent', async () => {
    vi.spyOn(api, 'listAudit').mockResolvedValue(auditList(0, 0));
    wrap(<Audit />);
    await waitFor(() =>
      expect(screen.getByText('No audit activity available.')).toBeInTheDocument(),
    );
  });

  test('credential-shaped metadata keys are NEVER rendered', async () => {
    // Defence in depth: the backend already scrubs, but a display layer that
    // blindly prints whatever it is handed is one bug away from a leak.
    vi.spyOn(api, 'listAudit').mockResolvedValue({
      events: [
        auditEvent({
          metadata: {
            action: 'RETRY',
            api_key: 'rzp_test_SHOULDNEVERAPPEAR',
            authorization: 'Bearer shouldneverappear',
            token: 'tok_shouldneverappear',
            DATABASE_URL: 'postgres://user:pass@host/db',
            password: 'hunter2',
          },
        }),
      ],
      pagination: { total: 1, limit: 25, offset: 0 },
    });

    const { container } = wrap(<Audit />);
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(1));

    for (const forbidden of [
      'rzp_test_SHOULDNEVERAPPEAR',
      'Bearer shouldneverappear',
      'tok_shouldneverappear',
      'postgres://',
      'hunter2',
    ]) {
      expect(container.innerHTML).not.toContain(forbidden);
    }
    // The safe key is still shown, so the filter is not simply hiding everything.
    expect(container.textContent).toContain('RETRY');
  });

  test('a 401 renders the auth message', async () => {
    vi.spyOn(api, 'listAudit').mockRejectedValue(new ApiError(401, 'unauthorized', 'x'));
    wrap(<Audit />);
    await waitFor(() =>
      expect(screen.getByText(/Authentication required/i)).toBeInTheDocument(),
    );
  });

  test('a 429 renders the rate-limit message', async () => {
    vi.spyOn(api, 'listAudit').mockRejectedValue(new ApiError(429, 'rate_limited', 'x'));
    wrap(<Audit />);
    await waitFor(() => expect(screen.getByText(/Too many requests/i)).toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// ANALYTICS
// ---------------------------------------------------------------------------

describe('Analytics', () => {
  test('renders the BACKEND recovered figure, never a computed one', async () => {
    vi.spyOn(api, 'analytics').mockResolvedValue(analyticsFixture());

    const { container } = wrap(<Analytics />);
    await waitFor(() => expect(container.textContent).toContain('Verified Recovered'));

    // 27,084,160 paise = ₹2,70,841.60 = ₹2.71L
    expect(screen.getByText('₹2.71L')).toBeInTheDocument();
    expect(screen.getByText('30.5%')).toBeInTheDocument();
    expect(screen.getByText('Provider-verified outcomes only')).toBeInTheDocument();
  });

  test('states that only VERIFIED counts as recovered', async () => {
    vi.spyOn(api, 'analytics').mockResolvedValue(analyticsFixture());
    const { container } = wrap(<Analytics />);
    await waitFor(() => expect(container.textContent).toContain('How recovery is measured'));
    // Emphasis spans split the sentence across nodes, so match the assembled
    // text rather than a single element.
    expect(container.textContent).toContain(
      'Recovered revenue counts only provider outcomes verified by RecoverAI',
    );
    expect(container.textContent).toContain('do not contribute to the figure above');
  });

  test('the execution distribution does NOT call SUCCESS recovered', async () => {
    vi.spyOn(api, 'analytics').mockResolvedValue(analyticsFixture());
    const { container } = wrap(<Analytics />);
    await waitFor(() => expect(container.textContent).toContain('Execution outcomes'));

    // The section explains the distinction rather than implying recovery.
    expect(
      screen.getByText(/not whether money moved/i),
    ).toBeInTheDocument();
  });

  test('NO fabricated time series is drawn', async () => {
    // The backend stores aggregates only. Inventing a trend would be the
    // single most misleading thing this page could do.
    vi.spyOn(api, 'analytics').mockResolvedValue(analyticsFixture());
    wrap(<Analytics />);
    await waitFor(() =>
      expect(screen.getByText('Time-series data is not available.')).toBeInTheDocument(),
    );
  });

  test('an error state renders instead of crashing', async () => {
    vi.spyOn(api, 'analytics').mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
    wrap(<Analytics />);
    await waitFor(() =>
      expect(screen.getByText('Could not load recovery analytics')).toBeInTheDocument(),
    );
  });

  test('a 409 renders the stale-state message', async () => {
    vi.spyOn(api, 'analytics').mockRejectedValue(new ApiError(409, 'conflict', 'x'));
    wrap(<Analytics />);
    await waitFor(() => expect(screen.getByText(/changed state/i)).toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// SECRET SAFETY, ACROSS ALL STAGE 2 SCREENS
// ---------------------------------------------------------------------------

describe('no Stage 2 screen leaks a credential', () => {
  const FORBIDDEN = [
    'rzp_test_',
    'rzp_live_',
    'AIza',
    'API_AUTH_TOKEN',
    'RAZORPAY_KEY_SECRET',
    'DATABASE_URL',
    'postgres://',
  ];

  test('Payments, Audit and Analytics render no credential-shaped text', async () => {
    vi.spyOn(api, 'listPayments').mockResolvedValue(paymentList(3, 3));
    vi.spyOn(api, 'listAudit').mockResolvedValue(auditList(3, 3));
    vi.spyOn(api, 'analytics').mockResolvedValue(analyticsFixture());

    for (const ui of [<Payments key="p" />, <Audit key="a" />, <Analytics key="n" />]) {
      const { container, unmount } = wrap(ui);
      await waitFor(() => expect(container.textContent?.length ?? 0).toBeGreaterThan(50));
      for (const forbidden of FORBIDDEN) {
        expect(container.innerHTML).not.toContain(forbidden);
      }
      unmount();
    }
  });
});
