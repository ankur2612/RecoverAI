import { describe, expect, test, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Approvals } from '../pages/Approvals.tsx';
import { SystemStatus } from '../pages/SystemStatus.tsx';
import { Settings } from '../pages/Settings.tsx';
import { api, ApiError } from '../api/client.ts';
import type { CaseListResponse, HealthResponse, RecoveryCase } from '../types/domain.ts';

/**
 * STAGE 3 SCREENS — Approvals, System Status, Settings.
 *
 * The properties under test: these screens are READ ONLY (no mutation
 * control), they never render a credential value, and they never overstate
 * what a configuration flag means.
 */

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function caseFixture(overrides: Partial<RecoveryCase> = {}): RecoveryCase {
  return {
    id: 'rc_1',
    payment_id: 'pay_00421',
    risk_score: 0.18,
    recoverability_score: 0,
    classification: 'UNKNOWN',
    recommended_action: 'ESCALATE',
    confidence: 0,
    revenue_at_risk: 367_800,
    reason: 'Classified UNKNOWN with NONE recoverability; baseline action ESCALATE.',
    status: 'AWAITING_APPROVAL',
    created_at: '2026-08-30T20:41:34.920Z',
    updated_at: '2026-08-30T20:41:34.920Z',
    ...overrides,
  };
}

function caseList(count: number, total: number, status: RecoveryCase['status']): CaseListResponse {
  return {
    cases: Array.from({ length: count }, (_, i) =>
      caseFixture({ id: `rc_${i}`, payment_id: `pay_${String(i).padStart(5, '0')}`, status }),
    ),
    pagination: { total, limit: 50, offset: 0 },
  };
}

function healthFixture(overrides: Partial<HealthResponse['config']> = {}): HealthResponse {
  return {
    status: 'ok',
    service: 'recoverai-backend',
    version: '0.1.0',
    timestamp: '2026-08-30T20:41:34.920Z',
    database: { reachable: true },
    config: {
      nodeEnv: 'development',
      port: 8080,
      logLevel: 'info',
      databaseConfigured: true,
      simulated: true,
      ai: { provider: 'mock', credentialPresent: true },
      payments: { provider: 'mock', credentialPresent: true, mode: 'test' },
      auth: { enabled: false, credentialPresent: false },
      rateLimit: { enabled: true, max: 120, windowMs: 60_000 },
      policy: {
        maxRetryAttempts: 3,
        maxAutomatedAmount: 1_000_000,
        minRecoveryConfidence: 0.75,
        retryCooldownSeconds: 3600,
        highValueThreshold: 1_000_000,
        recoveryWindowHours: 72,
        maxRemindersPerPayment: 2,
      },
      dataset: {
        seed: 42,
        recordCount: 1000,
        evalSplit: 0.3,
        avgTransactionValue: 250_000,
        customerRepeatRate: 0.45,
      },
      ...overrides,
    },
  };
}

/** Every credential shape that must never appear in a rendered DOM. */
const FORBIDDEN = [
  'rzp_test_',
  'rzp_live_',
  'AIza',
  'sk-',
  'API_AUTH_TOKEN',
  'RAZORPAY_KEY_SECRET',
  'GEMINI_API_KEY',
  'DATABASE_URL',
  'postgres://',
  'password',
];

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// APPROVALS
// ---------------------------------------------------------------------------

describe('Approvals — read-only queue', () => {
  const mockAll = (awaiting: number, approved: number, rejected: number) =>
    vi.spyOn(api, 'listCases').mockImplementation(async (params = {}) => {
      if (params.status === 'AWAITING_APPROVAL')
        return caseList(Math.min(awaiting, 50), awaiting, 'AWAITING_APPROVAL');
      if (params.status === 'APPROVED')
        return caseList(Math.min(approved, 50), approved, 'APPROVED');
      return caseList(Math.min(rejected, 50), rejected, 'REJECTED');
    });

  test('the queue count comes from pagination.total, not the page length', async () => {
    // 50 rows returned, 27 in the dataset would be wrong; here 50 of 120.
    mockAll(120, 0, 0);

    const { container } = wrap(<Approvals />);
    await waitFor(() => expect(container.textContent).toContain('Awaiting Approval'));

    expect(container.textContent).toContain('Awaiting Approval120');
    expect(container.textContent).not.toContain('Awaiting Approval50');
  });

  test('a FAILED decided query renders "—", never a fabricated 0', async () => {
    /*
     * Regression: the Decided card fell back to 0 when the approved/rejected
     * queries errored, which is a factual claim about the record and is
     * indistinguishable from a genuinely empty queue.
     */
    vi.spyOn(api, 'listCases').mockImplementation(async (params = {}) => {
      if (params.status === 'AWAITING_APPROVAL') return caseList(5, 5, 'AWAITING_APPROVAL');
      throw new ApiError(500, 'server_error', 'boom');
    });

    const { container } = wrap(<Approvals />);
    await waitFor(() => expect(container.textContent).toContain('Decided'));

    expect(container.textContent).toContain('Count unavailable');
    expect(container.textContent).not.toContain('Decided0');
  });

  test('NO approve or reject control is rendered', async () => {
    // Stage 3 is visibility only. A decision is a financial act and must not
    // be one click away without its confirmation flow.
    mockAll(5, 0, 0);

    const { container } = wrap(<Approvals />);
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBeGreaterThan(0));

    // Buttons AND links: a decision control could just as easily be an anchor,
    // and an earlier version of this test missed exactly that.
    const controls = [
      ...screen.queryAllByRole('button'),
      ...screen.queryAllByRole('link'),
    ];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      const label = (control.textContent ?? '').toLowerCase();
      expect(label).not.toMatch(/approve|reject|decline|execute|force|retry/);
    }

    // And no form could submit a decision.
    expect(container.querySelectorAll('form')).toHaveLength(0);
  });

  test('states that approval is not authorization', async () => {
    mockAll(3, 0, 0);
    const { container } = wrap(<Approvals />);
    await waitFor(() => expect(container.textContent).toContain('Approval is not authorization'));
    expect(container.textContent).toContain(
      'Approval does not execute the recovery',
    );
  });

  test('empty approved and rejected sections are honest, not fabricated', async () => {
    // Live data really is 0/0 — the screen must say so rather than invent rows.
    mockAll(27, 0, 0);

    const { container } = wrap(<Approvals />);
    await waitFor(() =>
      expect(screen.getByText('No approvals recorded yet.')).toBeInTheDocument(),
    );
    expect(screen.getByText('No rejections recorded yet.')).toBeInTheDocument();
    expect(container.textContent).toContain('Decided');
  });

  test('an empty queue reads as caught up, not as an error', async () => {
    mockAll(0, 0, 0);
    wrap(<Approvals />);
    await waitFor(() => expect(screen.getByText("You're all caught up.")).toBeInTheDocument());
  });

  test('a loading queue shows no misleading zero', async () => {
    vi.spyOn(api, 'listCases').mockImplementation(
      () => new Promise(() => {}) as Promise<CaseListResponse>,
    );
    const { container } = wrap(<Approvals />);
    expect(container.textContent).not.toContain('Awaiting Approval0');
  });

  test('an error renders an error state, not a crash', async () => {
    vi.spyOn(api, 'listCases').mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
    wrap(<Approvals />);
    await waitFor(() =>
      expect(screen.getByText('Could not load the approval queue')).toBeInTheDocument(),
    );
  });

  test('money renders from minor units exactly once', async () => {
    // 367800 paise = ₹3,678.00 — never ₹36.78.
    mockAll(1, 0, 0);
    const { container } = wrap(<Approvals />);
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(1));
    expect(container.textContent).toContain('3,678');
    expect(container.textContent).not.toContain('36.78');
  });

  test('renders no credential-shaped text', async () => {
    mockAll(3, 0, 0);
    const { container } = wrap(<Approvals />);
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(3));
    for (const forbidden of FORBIDDEN) {
      expect(container.innerHTML.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

// ---------------------------------------------------------------------------
// SYSTEM STATUS
// ---------------------------------------------------------------------------

describe('System Status', () => {
  test('the simulation banner names WHICH provider is simulated', async () => {
    // A real payment provider with a mock AI is still simulated, so the banner
    // must not claim "no real provider is configured".
    vi.spyOn(api, 'health').mockResolvedValue(
      healthFixture({
        simulated: true,
        payments: { provider: 'razorpay', credentialPresent: true, mode: 'test' },
        ai: { provider: 'mock', credentialPresent: true },
      }),
    );

    const { container } = wrap(<SystemStatus />);
    await waitFor(() => expect(container.textContent).toContain('Simulation mode'));

    expect(container.textContent).toContain('one or more providers are simulated');
    expect(container.textContent).toContain('deterministic rule-based provider');
    // The payment provider is real, so no claim may be made about money.
    expect(container.textContent).not.toContain('no money has moved');
    expect(container.textContent).not.toContain('no real provider is configured');
  });

  test('a mocked payment provider states that no money moved', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(healthFixture({ simulated: true }));

    const { container } = wrap(<SystemStatus />);
    await waitFor(() => expect(container.textContent).toContain('Simulation mode'));

    expect(container.textContent).toContain('no money has moved');
  });

  test('no banner appears when both providers are real', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(
      healthFixture({
        simulated: false,
        payments: { provider: 'razorpay', credentialPresent: true, mode: 'test' },
        ai: { provider: 'gemini', model: 'gemini-3.7-flash', credentialPresent: true },
      }),
    );

    const { container } = wrap(<SystemStatus />);
    await waitFor(() => expect(container.textContent).toContain('Operational'));

    expect(container.textContent).not.toContain('Simulation mode');
  });

  test('renders service, database, auth and provider posture', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(healthFixture());

    const { container } = wrap(<SystemStatus />);
    await waitFor(() => expect(container.textContent).toContain('Operational'));

    for (const section of ['Service', 'Database', 'Security posture', 'Providers']) {
      expect(screen.getByText(section)).toBeInTheDocument();
    }
    expect(container.textContent).toContain('Reachable');
    expect(container.textContent).toContain('TEST MODE');
  });

  test('credential presence is shown as a FLAG, never a value', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(healthFixture());
    const { container } = wrap(<SystemStatus />);
    await waitFor(() => expect(container.textContent).toContain('Providers'));

    // The flag is rendered…
    expect(container.textContent).toContain('Configured');
    // …and the page says explicitly that it is only a flag.
    expect(container.textContent).toContain('Presence flag only');
    for (const forbidden of FORBIDDEN) {
      expect(container.innerHTML.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test('a configured credential is NOT claimed to be operational', async () => {
    // The overstatement worth guarding: a present key proves configuration,
    // not that the third party was reached.
    vi.spyOn(api, 'health').mockResolvedValue(healthFixture());
    const { container } = wrap(<SystemStatus />);
    await waitFor(() => expect(container.textContent).toContain('AI credential'));
    expect(container.textContent).toContain(
      'Configured does not mean the provider has been contacted',
    );
  });

  test('disabled authentication is flagged as attention, with an explanation', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(
      healthFixture({ auth: { enabled: false, credentialPresent: false } }),
    );
    const { container } = wrap(<SystemStatus />);
    await waitFor(() => expect(container.textContent).toContain('API authentication'));
    expect(container.textContent).toContain('Every route is publicly reachable');
  });

  test('an unreachable database renders the danger state', async () => {
    vi.spyOn(api, 'health').mockResolvedValue({
      ...healthFixture(),
      status: 'degraded',
      database: { reachable: false, error: 'connection refused' },
    });
    const { container } = wrap(<SystemStatus />);
    await waitFor(() => expect(container.textContent).toContain('Unreachable'));
    expect(container.textContent).toContain('Degraded');
  });

  test('an unreachable API renders an error state, not a crash', async () => {
    vi.spyOn(api, 'health').mockRejectedValue(new ApiError(0, 'network_error', 'down'));
    wrap(<SystemStatus />);
    await waitFor(() =>
      expect(screen.getByText('Cannot reach the RecoverAI API')).toBeInTheDocument(),
    );
  });

  test('status is never communicated by colour alone', async () => {
    // Every badge carries an icon plus a text label.
    vi.spyOn(api, 'health').mockResolvedValue(healthFixture());
    const { container } = wrap(<SystemStatus />);
    await waitFor(() => expect(container.textContent).toContain('Reachable'));
    // Text labels are present for each posture row.
    for (const label of ['Operational', 'Reachable', 'Disabled', 'Enabled']) {
      expect(container.textContent).toContain(label);
    }
  });

  test('a missing ai.model is handled rather than rendering undefined', async () => {
    // The live mock provider omits `model` from the JSON entirely.
    vi.spyOn(api, 'health').mockResolvedValue(healthFixture());
    const { container } = wrap(<SystemStatus />);
    await waitFor(() => expect(container.textContent).toContain('AI provider'));
    expect(container.textContent).toContain('No model is reported');
    expect(container.textContent).not.toContain('undefined');
  });
});

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------

describe('Settings — read-only', () => {
  test('is labelled read-only', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(healthFixture());
    wrap(<Settings />);
    await waitFor(() =>
      expect(screen.getByText('Read-only configuration')).toBeInTheDocument(),
    );
  });

  test('renders NO editable control and NO save button', async () => {
    // A disabled form or a dead Save button would imply a capability the
    // system does not have.
    vi.spyOn(api, 'health').mockResolvedValue(healthFixture());
    const { container } = wrap(<Settings />);
    await waitFor(() => expect(container.textContent).toContain('Recovery policy'));

    expect(container.querySelectorAll('input')).toHaveLength(0);
    expect(container.querySelectorAll('select')).toHaveLength(0);
    expect(container.querySelectorAll('textarea')).toHaveLength(0);
    for (const button of screen.queryAllByRole('button')) {
      expect((button.textContent ?? '').toLowerCase()).not.toMatch(/save|apply|update|edit/);
    }
  });

  test('renders the real policy thresholds from the API', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(healthFixture());
    const { container } = wrap(<Settings />);
    await waitFor(() => expect(container.textContent).toContain('Recovery policy'));

    expect(container.textContent).toContain('Maximum retry attempts');
    expect(container.textContent).toContain('3');
    // 1,000,000 paise = ₹10,000.00 — divided exactly once.
    expect(container.textContent).toContain('10,000');
    expect(container.textContent).toContain('75%');
    expect(container.textContent).toContain('1h');
    expect(container.textContent).toContain('72h');
  });

  test('money is converted from minor units exactly once', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(healthFixture());
    const { container } = wrap(<Settings />);
    await waitFor(() => expect(container.textContent).toContain('Automated amount limit'));
    // ₹10,000.00, not ₹100.00 (double division) or ₹10,00,000 (none).
    expect(container.textContent).toContain('10,000');
    expect(container.textContent).not.toContain('₹100.00');
  });

  test('renders no credential-shaped text', async () => {
    vi.spyOn(api, 'health').mockResolvedValue(healthFixture());
    const { container } = wrap(<Settings />);
    await waitFor(() => expect(container.textContent).toContain('Providers'));
    for (const forbidden of FORBIDDEN) {
      expect(container.innerHTML.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  test('an error renders an error state', async () => {
    vi.spyOn(api, 'health').mockRejectedValue(new ApiError(500, 'internal_error', 'boom'));
    wrap(<Settings />);
    await waitFor(() =>
      expect(screen.getByText('Could not load configuration')).toBeInTheDocument(),
    );
  });

  test('states that the AI can never authorize or execute', async () => {
    // The product's core claim, restated where an operator reads config.
    vi.spyOn(api, 'health').mockResolvedValue(healthFixture());
    const { container } = wrap(<Settings />);
    await waitFor(() => expect(container.textContent).toContain('AI provider'));
    expect(container.textContent).toContain('it can never authorize or execute');
  });
});
