import { describe, expect, test, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { Cases } from '../pages/Cases.tsx';
import { Overview } from '../pages/Overview.tsx';
import { api, ApiError } from '../api/client.ts';
import type { CaseListResponse, RecoveryAnalytics, RecoveryCase } from '../types/domain.ts';

/**
 * ============================================================================
 * COUNT-CONSISTENCY REGRESSION TESTS
 * ============================================================================
 *
 * These lock down two real bugs found by rendering against the live database:
 *
 *   BUG 1  Overview showed "Awaiting Approval: 0" while the Recovery Health
 *          bar on the same screen showed 23, and the case table listed real
 *          AWAITING_APPROVAL rows.
 *
 *   BUG 2  The Cases screen showed "0 cases" beside a full table of 185.
 *
 * ROOT CAUSE (shared): the frontend response type declared pagination fields
 * FLAT (`{ cases, total, limit, offset }`) while the backend nests them
 * (`{ cases, pagination: { total, limit, offset } }`). `data.total` was
 * therefore `undefined`, and `?? 0` turned that silently into a zero.
 *
 * The mocks below deliberately use the REAL nested envelope. If the type or a
 * call site ever reverts to the flat shape, `pagination.total` becomes
 * undefined again and these tests fail.
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
    payment_id: 'pay_00001',
    risk_score: 0.5,
    recoverability_score: 0.8,
    classification: 'TEMPORARY_FAILURE',
    recommended_action: 'RETRY',
    confidence: 0.92,
    revenue_at_risk: 249_900,
    reason: 'Gateway timed out.',
    status: 'OPEN',
    created_at: '2026-08-30T10:00:00.000Z',
    updated_at: '2026-08-30T10:00:00.000Z',
    ...overrides,
  };
}

/** A list response in the REAL backend envelope. */
function listResponse(count: number, total: number, status?: RecoveryCase['status']): CaseListResponse {
  return {
    cases: Array.from({ length: count }, (_, i) =>
      caseFixture({
        id: `rc_${i}`,
        payment_id: `pay_${String(i).padStart(5, '0')}`,
        ...(status === undefined ? {} : { status }),
      }),
    ),
    pagination: { total, limit: 25, offset: 0 },
  };
}

function analyticsFixture(awaitingCount: number): RecoveryAnalytics {
  return {
    total_cases: 231,
    total_payments: 220,
    amount_at_risk: 88_857_011,
    amount_recovered: 27_084_160,
    amount_unrecovered: 61_772_851,
    recovery_rate: 0.3048,
    currency_unit: 'minor',
    cases_by_status: [
      { key: 'AWAITING_APPROVAL', count: awaitingCount },
      { key: 'OPEN', count: 58 },
      { key: 'RECOVERED', count: 98 },
    ],
    cases_by_action: [],
    actions_by_execution_status: [],
    actions_by_verification_status: [{ key: 'VERIFIED', count: 98 }],
    actions_by_policy_status: [],
    definitions: {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// BUG 1
// ---------------------------------------------------------------------------

describe('BUG 1 — Overview approval count must not contradict the rest of the page', () => {
  test('the hero card shows the API total, not 0', async () => {
    vi.spyOn(api, 'analytics').mockResolvedValue(analyticsFixture(27));
    vi.spyOn(api, 'listCases').mockImplementation(async (params = {}) =>
      params.status === 'AWAITING_APPROVAL' ? listResponse(1, 27, 'AWAITING_APPROVAL') : listResponse(8, 231),
    );

    const { container } = wrap(<Overview />);
    const hero = () => container.querySelector('section[aria-label="Key metrics"]');
    await waitFor(() => expect(hero()?.textContent ?? '').toMatch(/Awaiting Approval/));

    const text = hero()?.textContent ?? '';
    // The exact regression: this read "Awaiting Approval0" before the fix.
    expect(text).toContain('Awaiting Approval27');
    expect(text).not.toContain('Awaiting Approval0');
  });

  test('the hero count AGREES with the recovery-health distribution', async () => {
    // The visible contradiction users reported: two numbers for one fact on
    // one screen. Both are asserted together so they cannot drift apart.
    vi.spyOn(api, 'analytics').mockResolvedValue(analyticsFixture(27));
    vi.spyOn(api, 'listCases').mockImplementation(async (params = {}) =>
      params.status === 'AWAITING_APPROVAL' ? listResponse(1, 27, 'AWAITING_APPROVAL') : listResponse(8, 231),
    );

    const { container } = wrap(<Overview />);
    await waitFor(() =>
      expect(container.querySelector('section[aria-label="Key metrics"]')?.textContent ?? '').toMatch(
        /Awaiting Approval/,
      ),
    );

    const hero = container.querySelector('section[aria-label="Key metrics"]')?.textContent ?? '';
    // The distribution list renders the same figure from analytics.
    const health = [...container.querySelectorAll('dd')].map((d) => d.textContent);

    expect(hero).toContain('Awaiting Approval27');
    expect(health).toContain('27');
  });

  test('zero awaiting approval renders honestly as 0', async () => {
    // The fix must not overcorrect: a real zero is still a zero.
    vi.spyOn(api, 'analytics').mockResolvedValue(analyticsFixture(0));
    vi.spyOn(api, 'listCases').mockImplementation(async (params = {}) =>
      params.status === 'AWAITING_APPROVAL' ? listResponse(0, 0) : listResponse(3, 3),
    );

    const { container } = wrap(<Overview />);
    const hero = () => container.querySelector('section[aria-label="Key metrics"]');
    await waitFor(() => expect(hero()?.textContent ?? '').toMatch(/Awaiting Approval/));

    expect(hero()?.textContent).toContain('Awaiting Approval0');
    expect(hero()?.textContent).toContain('Nothing waiting');
  });

  test('while the approval query is in flight, NO zero is shown', async () => {
    // Live rendering showed a confident "0" flash before the count resolved,
    // briefly contradicting the recovery-health distribution on the same
    // screen. A pending count must read as pending, not as zero.
    vi.spyOn(api, 'analytics').mockResolvedValue(analyticsFixture(27));
    vi.spyOn(api, 'listCases').mockImplementation(async (params = {}) => {
      if (params.status === 'AWAITING_APPROVAL') {
        // Never resolves: simulates the slower of the two queries.
        return new Promise(() => {}) as Promise<CaseListResponse>;
      }
      return listResponse(8, 231);
    });

    const { container } = wrap(<Overview />);
    const hero = () => container.querySelector('section[aria-label="Key metrics"]');
    await waitFor(() => expect(hero()?.textContent ?? '').toMatch(/Awaiting Approval/));

    expect(hero()?.textContent).not.toContain('Awaiting Approval0');
    expect(hero()?.textContent).toContain('Checking…');
  });

  test('the count comes from pagination.total, NOT the page length', async () => {
    // 1 row returned, 27 in the dataset. Reading cases.length would show 1.
    vi.spyOn(api, 'analytics').mockResolvedValue(analyticsFixture(27));
    vi.spyOn(api, 'listCases').mockImplementation(async (params = {}) =>
      params.status === 'AWAITING_APPROVAL' ? listResponse(1, 27, 'AWAITING_APPROVAL') : listResponse(8, 231),
    );

    const { container } = wrap(<Overview />);
    const hero = () => container.querySelector('section[aria-label="Key metrics"]');
    await waitFor(() => expect(hero()?.textContent ?? '').toMatch(/Awaiting Approval/));

    expect(hero()?.textContent).toContain('Awaiting Approval27');
    expect(hero()?.textContent).not.toContain('Awaiting Approval1');
  });
});

// ---------------------------------------------------------------------------
// BUG 2
// ---------------------------------------------------------------------------

describe('BUG 2 — the Cases count must match the API total', () => {
  test('all statuses: shows the dataset total, not the page size', async () => {
    // The exact regression: 25 rows rendered while the label read "0 cases".
    vi.spyOn(api, 'listCases').mockResolvedValue(listResponse(25, 231));

    const { container } = wrap(<Cases />);
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(25));

    expect(screen.getByText('231 cases')).toBeInTheDocument();
    expect(screen.queryByText('0 cases')).not.toBeInTheDocument();
    // And explicitly not the rendered page length.
    expect(screen.queryByText('25 cases')).not.toBeInTheDocument();
  });

  test('a status filter shows that filtered total', async () => {
    vi.spyOn(api, 'listCases').mockResolvedValue(listResponse(5, 27, 'AWAITING_APPROVAL'));

    const { container } = wrap(<Cases />);
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(5));

    expect(screen.getByText('27 cases')).toBeInTheDocument();
  });

  test('an empty result shows "0 cases" WITH the empty state', async () => {
    vi.spyOn(api, 'listCases').mockResolvedValue(listResponse(0, 0));

    wrap(<Cases />);
    await waitFor(() => expect(screen.getByText('0 cases')).toBeInTheDocument());

    // A genuine zero, paired with a helpful message rather than a bare table.
    expect(screen.getByText('No recovery cases yet')).toBeInTheDocument();
  });

  test('exactly one case is singular, not "1 cases"', async () => {
    vi.spyOn(api, 'listCases').mockResolvedValue(listResponse(1, 1));

    wrap(<Cases />);
    await waitFor(() => expect(screen.getByText('1 case')).toBeInTheDocument());
  });

  test('while loading, no count is shown', async () => {
    // A count of 0 during load would flash a wrong number before the real one.
    vi.spyOn(api, 'listCases').mockImplementation(
      () => new Promise(() => {}) as Promise<CaseListResponse>,
    );

    wrap(<Cases />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    expect(screen.queryByText('0 cases')).not.toBeInTheDocument();
  });

  test('on error, NO misleading count is shown', async () => {
    // "0 cases" beside an error would assert something the UI cannot know.
    vi.spyOn(api, 'listCases').mockRejectedValue(
      new ApiError(500, 'internal_error', 'boom'),
    );

    wrap(<Cases />);
    await waitFor(() => expect(screen.getByText('Count unavailable')).toBeInTheDocument());

    expect(screen.queryByText('0 cases')).not.toBeInTheDocument();
    expect(screen.getByText('Could not load recovery cases')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The shared root cause
// ---------------------------------------------------------------------------

describe('the pagination envelope is read as the API actually returns it', () => {
  test('a FLAT envelope (the old wrong shape) does not silently render 0', async () => {
    // Simulates the pre-fix backend contract mismatch. Whatever the UI does
    // here, it must NOT print a confident, wrong "0 cases" beside real rows.
    vi.spyOn(api, 'listCases').mockResolvedValue({
      cases: [caseFixture()],
      // @ts-expect-error deliberately the old flat shape, to prove the guard
      total: 185,
      limit: 25,
      offset: 0,
    });

    const { container } = wrap(<Cases />);
    await waitFor(() => expect(container.querySelectorAll('tbody tr').length).toBe(1));

    // With rows on screen, a "0 cases" label is the exact reported bug.
    const label = [...container.querySelectorAll('p')].find((p) =>
      /cases?$|unavailable/.test(p.textContent ?? ''),
    )?.textContent;
    expect(label).not.toBe('0 cases');
  });
});
