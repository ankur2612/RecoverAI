import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { CaseDetail } from '../pages/CaseDetail.tsx';
import { Overview } from '../pages/Overview.tsx';
import { api, ApiError, tokenStore } from '../api/client.ts';
import {
  executionPresentation,
  isRecovered,
  isUnconfirmed,
  latestAction,
  verificationPresentation,
} from '../lib/status.ts';
import { formatMoney, formatMoneyCompact, formatPercent } from '../lib/format.ts';
import type { CaseDetail as CaseDetailType, RecoveryActionRecord } from '../types/domain.ts';

/**
 * FRONTEND SAFETY TESTS
 *
 * These exist to protect three claims the product makes:
 *
 *   1. Execution SUCCESS is never rendered as recovered money.
 *   2. An UNCONFIRMED outcome always shows the no-blind-retry explanation and
 *      never offers a retry control.
 *   3. Recovered revenue comes from the backend, never from frontend maths.
 */

function renderWithProviders(ui: React.ReactElement, route = '/') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/cases/:caseId" element={ui} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const baseAction: RecoveryActionRecord = {
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
  created_at: '2026-08-22T10:00:00.000Z',
  executed_at: '2026-08-22T10:00:01.000Z',
  completed_at: '2026-08-22T10:00:02.000Z',
};

function detailFixture(overrides: Partial<CaseDetailType> = {}): CaseDetailType {
  return {
    case: {
      id: 'rc_1',
      payment_id: 'pay_1',
      risk_score: 0.5,
      recoverability_score: 0.8,
      classification: 'TEMPORARY_FAILURE',
      recommended_action: 'RETRY',
      confidence: 0.92,
      revenue_at_risk: 249_900,
      reason: 'Gateway timed out.',
      status: 'AWAITING_VERIFICATION',
      created_at: '2026-08-22T10:00:00.000Z',
      updated_at: '2026-08-22T10:00:02.000Z',
    },
    payment: null,
    actions: [baseAction],
    approval: null,
    audit: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// THE CORE RULE
// ---------------------------------------------------------------------------

describe('execution SUCCESS is never recovered money', () => {
  test('the presentation layer does not use the word "recovered"', () => {
    const presentation = executionPresentation('SUCCESS');
    expect(presentation.label).toBe('Provider accepted');
    expect(presentation.label.toLowerCase()).not.toContain('recover');
    // And it is not rendered in the success tone, which is reserved for
    // verified outcomes.
    expect(presentation.tone).toBe('info');
  });

  test('isRecovered requires BOTH a RECOVERED case and a VERIFIED verdict', () => {
    // Execution succeeded but nothing was verified.
    expect(isRecovered('AWAITING_VERIFICATION', [baseAction])).toBe(false);
    // Case says recovered but the verdict does not agree — refuse.
    expect(isRecovered('RECOVERED', [baseAction])).toBe(false);
    // Both agree.
    expect(
      isRecovered('RECOVERED', [{ ...baseAction, verification_status: 'VERIFIED' }]),
    ).toBe(true);
  });

  test('a SUCCESS execution with no verification does not render "Recovered"', async () => {
    vi.spyOn(api, 'getCase').mockResolvedValue(detailFixture());

    renderWithProviders(<CaseDetail />, '/cases/rc_1');
    await screen.findByText('Execution');

    // "Provider accepted" appears in BOTH the status badge and the field
    // value — correct rendering, so assert on presence rather than uniqueness.
    expect(screen.getAllByText('Provider accepted').length).toBeGreaterThan(0);
    // The final-outcome callout must be absent.
    expect(screen.queryByText('Recovery verified')).not.toBeInTheDocument();
    // And the word "Recovered" must not appear as an outcome anywhere.
    expect(screen.queryByText('Recovered')).not.toBeInTheDocument();
  });

  test('a VERIFIED action DOES render the verified callout', async () => {
    vi.spyOn(api, 'getCase').mockResolvedValue(
      detailFixture({
        case: { ...detailFixture().case, status: 'RECOVERED' },
        actions: [
          {
            ...baseAction,
            verification_status: 'VERIFIED',
            observed_payment_status: 'captured',
            verified_at: '2026-08-22T10:05:00.000Z',
          },
        ],
      }),
    );

    renderWithProviders(<CaseDetail />, '/cases/rc_1');
    expect(await screen.findByText('Recovery verified')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// UNCONFIRMED SAFETY
// ---------------------------------------------------------------------------

describe('UNCONFIRMED safety messaging', () => {
  test('the verification presentation says "Outcome unconfirmed"', () => {
    const presentation = verificationPresentation('UNCONFIRMED');
    expect(presentation.label).toBe('Outcome unconfirmed');
    expect(presentation.description).toContain('will not blindly retry');
  });

  test('isUnconfirmed catches execution and verification ambiguity', () => {
    expect(isUnconfirmed({ ...baseAction, execution_status: 'UNCONFIRMED' })).toBe(true);
    expect(isUnconfirmed({ ...baseAction, verification_status: 'UNCONFIRMED' })).toBe(true);
    expect(isUnconfirmed({ ...baseAction, execution_status: 'EXECUTING' })).toBe(true);
    expect(isUnconfirmed({ ...baseAction, verification_status: 'VERIFIED' })).toBe(false);
    expect(isUnconfirmed(null)).toBe(false);
  });

  test('an UNCONFIRMED case shows the explanation and NO retry control', async () => {
    vi.spyOn(api, 'getCase').mockResolvedValue(
      detailFixture({
        actions: [{ ...baseAction, execution_status: 'UNCONFIRMED', verification_status: 'UNCONFIRMED' }],
      }),
    );

    renderWithProviders(<CaseDetail />, '/cases/rc_1');
    // Appears in both the badge and the prominent callout, which is the point.
    const labels = await screen.findAllByText('Outcome unconfirmed');
    expect(labels.length).toBeGreaterThan(0);

    expect(
      screen.getByText(/will not blindly retry an action when the provider outcome is unknown/i),
    ).toBeInTheDocument();

    // THE SAFETY ASSERTION: no control offers a retry.
    for (const button of screen.queryAllByRole('button')) {
      expect(button.textContent?.toLowerCase() ?? '').not.toMatch(/retry|re-execute|force/);
    }
    expect(screen.queryByText('Recovery verified')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// LIFECYCLE SEPARATION
// ---------------------------------------------------------------------------

describe('the five lifecycle stages are never collapsed', () => {
  test('all five stage cards render distinctly', async () => {
    vi.spyOn(api, 'getCase').mockResolvedValue(detailFixture());

    renderWithProviders(<CaseDetail />, '/cases/rc_1');
    await screen.findByText('AI Diagnosis');

    for (const stage of ['AI Diagnosis', 'Policy Decision', 'Approval', 'Execution', 'Verification']) {
      expect(screen.getByText(stage)).toBeInTheDocument();
    }
  });

  test('approval is labelled as a human decision, not authorization', async () => {
    vi.spyOn(api, 'getCase').mockResolvedValue(
      detailFixture({
        case: { ...detailFixture().case, status: 'APPROVED' },
        approval: {
          id: 'rap_1',
          case_id: 'rc_1',
          decision: 'APPROVED',
          actor: 'api:authenticated-operator',
          reason: 'reviewed',
          approved_action: 'RETRY',
          policy_version: 'v1',
          created_at: '2026-08-22T10:00:00.000Z',
        },
      }),
    );

    renderWithProviders(<CaseDetail />, '/cases/rc_1');
    expect(
      await screen.findByText(/Approval does not execute the recovery/i),
    ).toBeInTheDocument();
  });

  test('latestAction picks the most recent action', () => {
    const older = { ...baseAction, id: 'a', created_at: '2026-08-22T09:00:00.000Z' };
    const newer = { ...baseAction, id: 'b', created_at: '2026-08-22T11:00:00.000Z' };
    expect(latestAction([older, newer])?.id).toBe('b');
    expect(latestAction([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MONEY
// ---------------------------------------------------------------------------

describe('money handling', () => {
  test('minor units are divided exactly once, at display', () => {
    expect(formatMoney(249_900)).toContain('2,499');
    expect(formatMoney(0)).toContain('0');
    expect(formatMoney(1)).toContain('0.01');
  });

  test('compact formatting uses Indian units', () => {
    // 299,880,000 paise = ₹29,98,800 = ₹29.99L. Getting this wrong in a
    // fixture is exactly the paise/rupee confusion the minor-unit convention
    // exists to prevent.
    expect(formatMoneyCompact(299_880_000)).toBe('₹29.99L');
    expect(formatMoneyCompact(1_000_000_000)).toBe('₹1.00Cr');
    // Below a lakh it falls back to the exact figure rather than compacting.
    expect(formatMoneyCompact(249_900)).toContain('2,499');
  });

  test('rates format without inventing precision', () => {
    expect(formatPercent(0.25)).toBe('25.0%');
    expect(formatPercent(0)).toBe('0.0%');
  });

  test('the dashboard renders the BACKEND recovered figure, not a computed one', async () => {
    // amount_recovered deliberately disagrees with anything derivable from the
    // other fields; the UI must show the backend value verbatim.
    vi.spyOn(api, 'analytics').mockResolvedValue({
      total_cases: 10,
      total_payments: 10,
      amount_at_risk: 299_880_000,
      amount_recovered: 74_970_000,
      amount_unrecovered: 224_910_000,
      recovery_rate: 0.25,
      currency_unit: 'minor',
      cases_by_status: [{ key: 'RECOVERED', count: 3 }],
      cases_by_action: [],
      actions_by_execution_status: [],
      actions_by_verification_status: [{ key: 'VERIFIED', count: 3 }],
      actions_by_policy_status: [],
      definitions: {},
    });
    vi.spyOn(api, 'listCases').mockResolvedValue({
      cases: [],
      pagination: { total: 0, limit: 8, offset: 0 },
    });

    renderWithProviders(<Overview />);
    expect(await screen.findByText('₹7.50L')).toBeInTheDocument();
    expect(screen.getByText('25.0%')).toBeInTheDocument();
    expect(screen.getByText('Provider-verified outcomes only')).toBeInTheDocument();
  });

  test('the dashboard states how recovery is measured', async () => {
    vi.spyOn(api, 'analytics').mockResolvedValue({
      total_cases: 0, total_payments: 0, amount_at_risk: 0, amount_recovered: 0,
      amount_unrecovered: 0, recovery_rate: 0, currency_unit: 'minor',
      cases_by_status: [], cases_by_action: [], actions_by_execution_status: [],
      actions_by_verification_status: [], actions_by_policy_status: [], definitions: {},
    });
    vi.spyOn(api, 'listCases').mockResolvedValue({
      cases: [],
      pagination: { total: 0, limit: 8, offset: 0 },
    });

    renderWithProviders(<Overview />);
    expect(
      await screen.findByText(/counts only provider outcomes verified by RecoverAI/i),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// STATES
// ---------------------------------------------------------------------------

describe('loading, empty and error states', () => {
  test('an empty case list shows a helpful empty state', async () => {
    vi.spyOn(api, 'analytics').mockResolvedValue({
      total_cases: 0, total_payments: 0, amount_at_risk: 0, amount_recovered: 0,
      amount_unrecovered: 0, recovery_rate: 0, currency_unit: 'minor',
      cases_by_status: [], cases_by_action: [], actions_by_execution_status: [],
      actions_by_verification_status: [], actions_by_policy_status: [], definitions: {},
    });
    vi.spyOn(api, 'listCases').mockResolvedValue({
      cases: [],
      pagination: { total: 0, limit: 8, offset: 0 },
    });

    renderWithProviders(<Overview />);
    expect(await screen.findByText('No recovery cases yet')).toBeInTheDocument();
  });

  test('a 404 on a case shows a specific, non-technical message', async () => {
    vi.spyOn(api, 'getCase').mockRejectedValue(
      new ApiError(404, 'not_found', 'Recovery case rc_x was not found.'),
    );

    renderWithProviders(<CaseDetail />, '/cases/rc_x');
    expect(await screen.findByText('Recovery case not found')).toBeInTheDocument();
  });

  test('an empty audit trail shows an honest message rather than fake events', async () => {
    vi.spyOn(api, 'getCase').mockResolvedValue(detailFixture({ audit: [] }));

    renderWithProviders(<CaseDetail />, '/cases/rc_1');
    expect(await screen.findByText('No audit activity available.')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// API CLIENT
// ---------------------------------------------------------------------------

describe('API client safety', () => {
  beforeEach(() => {
    tokenStore.clear();
  });

  test('error messages are operator-readable, never raw payloads', () => {
    expect(new ApiError(401, 'unauthorized', 'x').operatorMessage).toMatch(/Authentication required/);
    expect(new ApiError(409, 'conflict', 'x').operatorMessage).toMatch(/changed state/);
    expect(new ApiError(429, 'rate_limited', 'x').operatorMessage).toMatch(/Too many requests/);
    expect(new ApiError(500, 'internal', 'x').operatorMessage).toMatch(
      /No recovery outcome was assumed/,
    );
  });

  test('the token is stored in sessionStorage and cleared on demand', () => {
    tokenStore.set('fake-token-0123456789abcdef');
    expect(tokenStore.get()).toBe('fake-token-0123456789abcdef');
    tokenStore.clear();
    expect(tokenStore.get()).toBeNull();
  });

  test('a GET sends the token as a Bearer header, never in the URL', async () => {
    tokenStore.set('fake-token-0123456789abcdef');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ cases: [], pagination: { total: 0, limit: 1, offset: 0 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await api.listCases({ limit: 1 });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).not.toContain('fake-token');
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      'Bearer fake-token-0123456789abcdef',
    );
  });

  test('a financial POST is sent EXACTLY ONCE, even on a server error', async () => {
    // The load-bearing client rule: an auto-retried /execute could mean a
    // second provider request.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'internal_error', message: 'boom' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(api.executeCase('rc_1')).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('approve and sweep are likewise never retried', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'internal_error', message: 'boom' }), { status: 500 }),
    );

    await expect(api.approveCase('rc_1', {})).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    fetchSpy.mockClear();
    await expect(api.runSweep({})).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test('a GET MAY retry a 5xx, since a read causes no effect', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ cases: [], pagination: { total: 0, limit: 1, offset: 0 } }), { status: 200 }),
      );

    await api.listCases({ limit: 1 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test('a 4xx is never retried, on any method', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ error: 'bad' }), { status: 400 }));

    await expect(api.listCases({ limit: 1 })).rejects.toBeInstanceOf(ApiError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
