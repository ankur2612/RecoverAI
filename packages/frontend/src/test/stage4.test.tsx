import { describe, expect, test, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { Batch } from '../pages/Batch.tsx';
import { BatchResults } from '../pages/BatchResults.tsx';
import { Sweeper } from '../pages/Sweeper.tsx';
import { api, ApiError, NON_RETRYABLE_METHODS } from '../api/client.ts';
import { sessionRuns } from '../lib/session-runs.ts';
import type { BatchItem, BatchRun, SweepItem, SweepRun } from '../types/domain.ts';

/**
 * ============================================================================
 * STAGE 4 — BATCH RECOVERY, BATCH RESULTS, SWEEPER
 * ============================================================================
 *
 * These screens are the only ones in the product that can cause a real
 * provider request across a whole population, so the properties under test are
 * the safety ones:
 *
 *   - preview is the default, and sends execute:false EXPLICITLY (the backend
 *     treats an OMITTED execute as true, so omission would be unsafe)
 *   - execute:true requires arming AND confirming
 *   - a POST is never retried automatically
 *   - a batch result is session-only and never faked after a reload
 *   - SUCCESS/acceptance never renders as "Recovered"
 *   - the sweeper offers no force-retry of any kind
 */

function wrap(ui: React.ReactElement, initialPath = '/') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/batch/results" element={<BatchResults />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Fixtures — shaped exactly like the backend serialisers in analytics.ts
// ---------------------------------------------------------------------------

function batchItem(overrides: Partial<BatchItem> = {}): BatchItem {
  return {
    payment_id: 'pay_00001',
    case_id: 'rc_abc',
    status: 'NOT_AUTHORIZED',
    action: 'RETRY',
    policy_decision: 'REQUIRES_APPROVAL',
    refusal_reason: null,
    verification_status: null,
    amount_at_risk: 250_000,
    amount_recovered: 0,
    message: 'Dry run: authorized but not executed.',
    ...overrides,
  };
}

function batchRun(overrides: Partial<BatchRun> = {}): BatchRun {
  return {
    run_id: 'run_11111111-2222-3333-4444-555555555555',
    started_at: '2026-08-31T10:00:00.000Z',
    finished_at: '2026-08-31T10:00:04.500Z',
    total_eligible: 3,
    analyzed: 3,
    authorized: 1,
    rejected: 2,
    executed: 1,
    verified: 1,
    recovered: 1,
    failed: 0,
    skipped_duplicate: 0,
    amount_at_risk: 750_000,
    amount_recovered: 250_000,
    items: [batchItem()],
    ...overrides,
  };
}

function sweepItem(overrides: Partial<SweepItem> = {}): SweepItem {
  return {
    action_id: 'ra_1',
    payment_id: 'pay_00042',
    case_id: 'rc_xyz',
    stranded_in: 'EXECUTING',
    outcome: 'STILL_UNCONFIRMED',
    observed_state: 'PENDING',
    execution_status: 'UNCONFIRMED',
    verification_status: null,
    message: 'The provider could not confirm the outcome.',
    ...overrides,
  };
}

function sweepRun(overrides: Partial<SweepRun> = {}): SweepRun {
  return {
    started_at: '2026-08-31T10:05:00.000Z',
    finished_at: '2026-08-31T10:05:01.000Z',
    found: 1,
    resolved_success: 0,
    resolved_failed: 0,
    still_unconfirmed: 1,
    already_resolved: 0,
    failed: 0,
    items: [sweepItem()],
    ...overrides,
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
  'DATABASE_URL',
  'postgres://',
];

beforeEach(() => {
  // Session state must not leak between cases — a stale run would make an
  // "empty session" assertion pass for the wrong reason.
  sessionRuns.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
  /*
   * Unmount BEFORE resetting the store. The store is a useSyncExternalStore
   * source, so resetting it while a component is still subscribed schedules a
   * React update outside act() — a test-isolation problem, not a product one,
   * but it makes real warnings harder to notice.
   */
  cleanup();
  sessionRuns.reset();
});

// ---------------------------------------------------------------------------
// BATCH RECOVERY — preview default and execute gating
// ---------------------------------------------------------------------------

describe('Batch Recovery — preview is the safe default', () => {
  test('the primary action is Preview, and Execute is disabled until armed', async () => {
    wrap(<Batch />);

    expect(screen.getByRole('button', { name: /preview recovery run/i })).toBeEnabled();
    // Execute exists but cannot be pressed without the operator arming it.
    expect(screen.getByRole('button', { name: /execute recovery run/i })).toBeDisabled();
  });

  test('Preview sends execute:false EXPLICITLY, never an omitted field', async () => {
    /*
     * The load-bearing assertion of this file. The backend resolves
     * `options.execute ?? true`, so an OMITTED execute means EXECUTE. A
     * preview that merely leaves the field out would run for real.
     */
    const spy = vi.spyOn(api, 'runBatch').mockResolvedValue(batchRun());

    wrap(<Batch />);
    await userEvent.click(screen.getByRole('button', { name: /preview recovery run/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const body = spy.mock.calls[0]![0];
    expect(body).toHaveProperty('execute', false);
    // Not merely falsy — the key must be present on the wire.
    expect(Object.hasOwn(body, 'execute')).toBe(true);
  });

  test('only fields in the backend schema are sent', async () => {
    const spy = vi.spyOn(api, 'runBatch').mockResolvedValue(batchRun());

    wrap(<Batch />);
    await userEvent.click(screen.getByRole('button', { name: /preview recovery run/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // batchRunRequestSchema is .strict(): an extra key is a 400, not a warning.
    const allowed = ['merchant_id', 'statuses', 'limit', 'execute'];
    for (const key of Object.keys(spy.mock.calls[0]![0])) {
      expect(allowed).toContain(key);
    }
  });

  test('a blank merchant is omitted rather than sent as an empty string', async () => {
    const spy = vi.spyOn(api, 'runBatch').mockResolvedValue(batchRun());

    wrap(<Batch />);
    await userEvent.click(screen.getByRole('button', { name: /preview recovery run/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // identifier() would reject "", so the field must not appear at all.
    expect(Object.hasOwn(spy.mock.calls[0]![0], 'merchant_id')).toBe(false);
  });

  test('the screen states that preview does not contact the provider', async () => {
    const { container } = wrap(<Batch />);
    expect(container.textContent).toContain('execute: false');
    expect(container.textContent?.toLowerCase()).toContain('never contacted');
  });

  test('the screen does NOT claim a preview changes nothing', async () => {
    /*
     * A preview still runs analyzePayment, which writes recovery cases and
     * audit events. Claiming it is read-only would be false reassurance.
     */
    const { container } = wrap(<Batch />);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/changes nothing|read-?only run|no database writes/i);
    expect(text).toMatch(/creates a recovery case|not read-only/i);
  });
});

describe('Batch Recovery — execute requires explicit confirmation', () => {
  test('arming alone does not execute; a confirmation dialog is required', async () => {
    const spy = vi.spyOn(api, 'runBatch').mockResolvedValue(batchRun());

    wrap(<Batch />);
    await userEvent.click(screen.getByRole('checkbox', { name: /intend to execute/i }));
    await userEvent.click(screen.getByRole('button', { name: /execute recovery run/i }));

    // The dialog is open and NOTHING has been sent yet.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  test('confirming sends execute:true', async () => {
    const spy = vi.spyOn(api, 'runBatch').mockResolvedValue(batchRun());

    wrap(<Batch />);
    await userEvent.click(screen.getByRole('checkbox', { name: /intend to execute/i }));
    await userEvent.click(screen.getByRole('button', { name: /execute recovery run/i }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /yes, execute now/i }),
    );

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]![0]).toHaveProperty('execute', true);
  });

  test('cancelling the confirmation sends nothing', async () => {
    const spy = vi.spyOn(api, 'runBatch').mockResolvedValue(batchRun());

    wrap(<Batch />);
    await userEvent.click(screen.getByRole('checkbox', { name: /intend to execute/i }));
    await userEvent.click(screen.getByRole('button', { name: /execute recovery run/i }));
    await userEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: /^cancel$/i }),
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  test('the confirmation states the real consequence, not a vague prompt', async () => {
    wrap(<Batch />);
    await userEvent.click(screen.getByRole('checkbox', { name: /intend to execute/i }));
    await userEvent.click(screen.getByRole('button', { name: /execute recovery run/i }));

    const dialog = screen.getByRole('dialog');
    expect(dialog.textContent).toContain('execute: true');
    expect(dialog.textContent?.toLowerCase()).toContain('payment provider');
  });
});

describe('Batch Recovery — confirmation dialog accessibility', () => {
  /*
   * The dialog gates the only bulk-execution path in the product, so a
   * keyboard or screen-reader operator must be able to use it as reliably as
   * a mouse user — including getting OUT of it without confirming.
   */
  const openDialog = async () => {
    wrap(<Batch />);
    await userEvent.click(screen.getByRole('checkbox', { name: /intend to execute/i }));
    const trigger = screen.getByRole('button', { name: /execute recovery run/i });
    await userEvent.click(trigger);
    return { trigger, dialog: screen.getByRole('dialog') };
  };

  test('it is labelled and described for assistive technology', async () => {
    const { dialog } = await openDialog();

    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName('Execute real recovery actions?');
    expect(dialog).toHaveAccessibleDescription(/execute: true/);
  });

  test('focus moves into the dialog, onto Cancel rather than Confirm', async () => {
    const { dialog } = await openDialog();

    expect(dialog.contains(document.activeElement)).toBe(true);
    /*
     * Deliberately Cancel: an operator who opens this and hits Enter
     * reflexively must not thereby authorize a population-wide execution.
     */
    expect(document.activeElement).toHaveTextContent(/^Cancel$/);
  });

  test('Tab cannot escape the dialog', async () => {
    const { dialog } = await openDialog();

    // More presses than there are focusable elements, so a leak would show.
    for (let i = 0; i < 8; i += 1) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  test('Shift+Tab cannot escape the dialog either', async () => {
    const { dialog } = await openDialog();

    for (let i = 0; i < 8; i += 1) {
      await userEvent.tab({ shift: true });
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  });

  test('Escape closes the dialog and sends nothing', async () => {
    const spy = vi.spyOn(api, 'runBatch').mockResolvedValue(batchRun());
    await openDialog();

    await userEvent.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // Escape is a cancel, never a confirm.
    expect(spy).not.toHaveBeenCalled();
  });

  test('closing restores focus to the triggering control', async () => {
    const { trigger } = await openDialog();

    await userEvent.keyboard('{Escape}');

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('focus is restored after cancelling with the mouse too', async () => {
    const { trigger, dialog } = await openDialog();

    await userEvent.click(within(dialog).getByRole('button', { name: /^cancel$/i }));

    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  test('the confirm button is reachable by keyboard and executes only when pressed', async () => {
    const spy = vi.spyOn(api, 'runBatch').mockResolvedValue(batchRun());
    const { dialog } = await openDialog();

    const confirm = within(dialog).getByRole('button', { name: /yes, execute now/i });
    confirm.focus();
    expect(spy).not.toHaveBeenCalled();

    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0]![0]).toHaveProperty('execute', true);
  });
});

describe('Batch Recovery — duplicate submission and retry', () => {
  test('both buttons are disabled while a run is in flight', async () => {
    // A promise that never settles, so the pending state is observable.
    vi.spyOn(api, 'runBatch').mockImplementation(() => new Promise<BatchRun>(() => {}));

    wrap(<Batch />);
    await userEvent.click(screen.getByRole('button', { name: /preview recovery run/i }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /running preview/i })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: /execute recovery run/i })).toBeDisabled();
  });

  test('clicking preview twice while pending sends exactly one request', async () => {
    const spy = vi
      .spyOn(api, 'runBatch')
      .mockImplementation(() => new Promise<BatchRun>(() => {}));

    wrap(<Batch />);
    const button = screen.getByRole('button', { name: /preview recovery run/i });
    await userEvent.click(button);
    await userEvent.click(button);
    await userEvent.click(button);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('a failed run is NOT retried automatically', async () => {
    const spy = vi
      .spyOn(api, 'runBatch')
      .mockRejectedValue(new ApiError(500, 'server_error', 'boom'));

    wrap(<Batch />);
    await userEvent.click(screen.getByRole('button', { name: /preview recovery run/i }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    // Give any retry timer a chance to fire before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('POST is on the client-level non-retryable list', () => {
    // The rule this whole screen depends on, asserted at its source.
    expect(NON_RETRYABLE_METHODS).toContain('POST');
  });

  test('the error is shown and no success is implied', async () => {
    vi.spyOn(api, 'runBatch').mockRejectedValue(
      new ApiError(429, 'rate_limited', 'too many'),
    );

    wrap(<Batch />);
    await userEvent.click(screen.getByRole('button', { name: /preview recovery run/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Too many requests');
    expect(alert.textContent?.toLowerCase()).toContain('no outcome is assumed');
  });

  test('a 400 renders the validation issues the backend supplied', async () => {
    vi.spyOn(api, 'runBatch').mockRejectedValue(
      new ApiError(400, 'validation_error', 'bad', [
        { field: 'limit', message: 'limit must be 1000 or fewer' },
      ]),
    );

    wrap(<Batch />);
    await userEvent.click(screen.getByRole('button', { name: /preview recovery run/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('limit must be 1000 or fewer');
  });

  test('a 401 renders as an authentication error', async () => {
    vi.spyOn(api, 'runBatch').mockRejectedValue(new ApiError(401, 'unauthorized', 'nope'));

    wrap(<Batch />);
    await userEvent.click(screen.getByRole('button', { name: /preview recovery run/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Authentication required');
  });

  test('a network error renders without crashing', async () => {
    vi.spyOn(api, 'runBatch').mockRejectedValue(
      new ApiError(0, 'network_error', 'Could not reach the RecoverAI API.'),
    );

    wrap(<Batch />);
    await userEvent.click(screen.getByRole('button', { name: /preview recovery run/i }));

    expect((await screen.findByRole('alert')).textContent).toContain('Could not reach');
  });
});

// ---------------------------------------------------------------------------
// BATCH RESULTS — session-only, and honest about it
// ---------------------------------------------------------------------------

describe('Batch Results — session-only, never fabricated', () => {
  test('with no run in this session it shows an honest empty state', () => {
    const { container } = wrap(<BatchResults />);

    expect(container.textContent).toContain('No batch result is available in this session.');
    // It must SAY why, not merely show nothing.
    expect(container.textContent?.toLowerCase()).toContain('does not');
  });

  test('the empty state fabricates no counts, ids, or amounts', () => {
    const { container } = wrap(<BatchResults />);
    const text = container.textContent ?? '';

    expect(text).not.toMatch(/run_/);
    expect(text).not.toMatch(/₹/);
    expect(text).not.toMatch(/Total eligible/);
  });

  test('a real API response renders its own fields', async () => {
    sessionRuns.setBatch(batchRun(), true);
    const { container } = wrap(<BatchResults />);

    expect(container.textContent).toContain('run_11111111');
    expect(container.textContent).toContain('Total eligible');
    // Counts come from the response, not from items.length.
    expect(container.textContent).toContain('Analyzed');
  });

  test('counts come from the API, not from the items array length', () => {
    // 3 analyzed but only 1 item returned: the page must show 3.
    sessionRuns.setBatch(batchRun({ analyzed: 3, items: [batchItem()] }), true);
    const { container } = wrap(<BatchResults />);

    const text = container.textContent ?? '';
    expect(text).toContain('Analyzed3');
    expect(text).not.toContain('Analyzed1');
  });

  test('the result is labelled as session-only and not stored', () => {
    sessionRuns.setBatch(batchRun(), true);
    const { container } = wrap(<BatchResults />);

    expect(container.textContent).toContain('Current session result');
    expect(container.textContent?.toLowerCase()).toContain('does not store run history');
  });

  test('a fresh mount after a reset shows the empty state, not the old run', () => {
    // Simulates a reload: in-memory state is gone, and nothing restores it.
    sessionRuns.setBatch(batchRun(), true);
    sessionRuns.reset();

    const { container } = wrap(<BatchResults />);
    expect(container.textContent).toContain('No batch result is available in this session.');
    expect(container.textContent).not.toContain('run_11111111');
  });

  test('nothing is written to localStorage or sessionStorage', async () => {
    const local = vi.spyOn(Storage.prototype, 'setItem');

    sessionRuns.setBatch(batchRun(), true);
    wrap(<BatchResults />);

    // A persisted run summary would survive a reload and imply backend
    // history that does not exist.
    const persistedRun = local.mock.calls.some(
      ([, value]) => typeof value === 'string' && value.includes('run_11111111'),
    );
    expect(persistedRun).toBe(false);
  });

  test('preview mode is labelled Preview, not Executed', () => {
    sessionRuns.setBatch(batchRun(), false);
    const { container } = wrap(<BatchResults />);

    /*
     * Scoped to the run-mode block deliberately: "Executed" is also a
     * legitimate COUNT LABEL in the counts grid, so a whole-page scan would
     * assert the wrong thing. The claim under test is that the MODE badge
     * says Preview.
     */
    const modeBlock = screen.getByText('Run mode').closest('div')!;
    expect(modeBlock.textContent).toContain('Preview');
    expect(modeBlock.textContent).not.toContain('Executed');
    // And the mode line states the provider was not contacted.
    expect(container.textContent).toContain('The provider was never contacted');
  });

  test('an executed run is labelled Executed, not Preview', () => {
    // The mirror of the case above: the badge must track the real mode.
    sessionRuns.setBatch(batchRun(), true);
    wrap(<BatchResults />);

    const modeBlock = screen.getByText('Run mode').closest('div')!;
    expect(modeBlock.textContent).toContain('Executed');
    expect(modeBlock.textContent).not.toContain('Preview');
  });
});

describe('Batch Results — financial semantics', () => {
  test('an accepted-but-unverified execution NEVER renders as Recovered', () => {
    sessionRuns.setBatch(
      batchRun({
        recovered: 0,
        amount_recovered: 0,
        items: [
          batchItem({
            status: 'EXECUTED_UNVERIFIED',
            verification_status: null,
            amount_recovered: 0,
            message: 'The provider accepted the request.',
          }),
        ],
      }),
      true,
    );
    const { container } = wrap(<BatchResults />);

    // The row must read "Provider accepted".
    expect(container.textContent).toContain('Provider accepted');
    // "Recovered" survives as a COUNT LABEL, so scope the check to the row.
    const row = screen.getByRole('row', { name: /pay_00001/ });
    expect(row.textContent).toContain('Provider accepted');
    expect(row.textContent).not.toContain('Recovered');
  });

  test('only a backend RECOVERED status renders the word Recovered on a row', () => {
    sessionRuns.setBatch(
      batchRun({
        items: [
          batchItem({
            payment_id: 'pay_win',
            status: 'RECOVERED',
            verification_status: 'VERIFIED',
            amount_recovered: 250_000,
          }),
        ],
      }),
      true,
    );
    wrap(<BatchResults />);

    const row = screen.getByRole('row', { name: /pay_win/ });
    expect(row.textContent).toContain('Recovered');
    expect(row.textContent).toContain('VERIFIED');
  });

  test('minor units are divided exactly once', () => {
    sessionRuns.setBatch(
      batchRun({
        amount_at_risk: 750_000,
        amount_recovered: 250_000,
        items: [batchItem({ amount_at_risk: 250_000, amount_recovered: 0 })],
      }),
      true,
    );
    const { container } = wrap(<BatchResults />);
    const text = container.textContent ?? '';

    // 750000 paise = ₹7,500. Not ₹75 (divided twice) and not ₹7,50,000 (raw).
    expect(text).toContain('7,500');
    expect(text).toContain('2,500');
    expect(text).not.toContain('7,50,000');
    expect(text).not.toContain('75.00');
  });

  test('a zero recovered amount renders as a dash, not ₹0.00 recovered revenue', () => {
    sessionRuns.setBatch(
      batchRun({ items: [batchItem({ amount_recovered: 0 })] }),
      true,
    );
    const row = (wrap(<BatchResults />), screen.getByRole('row', { name: /pay_00001/ }));
    expect(row.textContent).toContain('—');
  });

  test('the verified-recovered metric explains that acceptance does not count', () => {
    sessionRuns.setBatch(batchRun(), true);
    const { container } = wrap(<BatchResults />);
    expect(container.textContent).toContain('VERIFIED');
  });
});

describe('Batch Results — large runs', () => {
  const bigRun = (n: number) =>
    batchRun({
      total_eligible: n,
      analyzed: n,
      items: Array.from({ length: n }, (_, i) =>
        batchItem({ payment_id: `pay_${String(i).padStart(5, '0')}`, case_id: `rc_${i}` }),
      ),
    });

  test('rows are revealed progressively rather than all at once', () => {
    // The API ceiling is 1,000 items; rendering every row costs ~15k DOM nodes.
    sessionRuns.setBatch(bigRun(250), true);
    const { container } = wrap(<BatchResults />);

    expect(container.querySelectorAll('tbody tr').length).toBe(100);
    expect(container.textContent).toContain('Showing 100 of 250 rows');
  });

  test('Show more reveals the next batch without losing any row', async () => {
    sessionRuns.setBatch(bigRun(250), true);
    const { container } = wrap(<BatchResults />);

    await userEvent.click(screen.getByRole('button', { name: /show more/i }));
    expect(container.querySelectorAll('tbody tr').length).toBe(200);

    await userEvent.click(screen.getByRole('button', { name: /show more/i }));
    // Every row the run reported is reachable; nothing is silently dropped.
    expect(container.querySelectorAll('tbody tr').length).toBe(250);
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });

  test('the counts stay the API totals regardless of how many rows are shown', () => {
    sessionRuns.setBatch(bigRun(250), true);
    const { container } = wrap(<BatchResults />);

    // 250 analyzed even though only 100 rows are on screen.
    expect(container.textContent).toContain('Analyzed250');
    expect(container.textContent).toContain('Payments (250)');
  });

  test('a small run shows every row with no Show more control', () => {
    sessionRuns.setBatch(bigRun(12), true);
    const { container } = wrap(<BatchResults />);

    expect(container.querySelectorAll('tbody tr').length).toBe(12);
    expect(screen.queryByRole('button', { name: /show more/i })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// SWEEPER
// ---------------------------------------------------------------------------

describe('Sweeper — request and safeguards', () => {
  test('the correct request body is sent', async () => {
    const spy = vi.spyOn(api, 'runSweep').mockResolvedValue(sweepRun());

    wrap(<Sweeper />);
    await userEvent.click(screen.getByRole('button', { name: /^run sweep$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    const body = spy.mock.calls[0]![0]!;
    expect(body).toEqual({ min_age_seconds: 120, limit: 100 });
  });

  test('only fields in sweepRequestSchema are sent', async () => {
    const spy = vi.spyOn(api, 'runSweep').mockResolvedValue(sweepRun());

    wrap(<Sweeper />);
    await userEvent.click(screen.getByRole('button', { name: /^run sweep$/i }));

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // .strict() on the backend: an extra key is a 400.
    for (const key of Object.keys(spy.mock.calls[0]![0]!)) {
      expect(['min_age_seconds', 'limit']).toContain(key);
    }
  });

  test('NO force-retry, re-execute, or override control exists', async () => {
    sessionRuns.setSweep(sweepRun());
    const { container } = wrap(<Sweeper />);

    /*
     * Scans buttons AND links: a control added as an anchor would otherwise
     * slip past a button-only scan. (This is the gap that survived a mutation
     * in the Stage 3 suite, fixed there and pre-empted here.)
     */
    const controls = [
      ...container.querySelectorAll('button'),
      ...container.querySelectorAll('a'),
      ...container.querySelectorAll('[role="button"]'),
    ];
    const forbidden = /force|re-?execute|retry (all|everything)|re-?send|re-?run action|override/i;
    for (const control of controls) {
      expect(control.textContent ?? '').not.toMatch(forbidden);
    }
  });

  test('the screen displays the no-blind-retry rule prominently', () => {
    const { container } = wrap(<Sweeper />);
    expect(container.textContent).toContain('No blind retry');
    expect(container.textContent).toContain('will not blindly retry');
  });

  test('the sweep button is disabled while a sweep is in flight', async () => {
    vi.spyOn(api, 'runSweep').mockImplementation(() => new Promise<SweepRun>(() => {}));

    wrap(<Sweeper />);
    await userEvent.click(screen.getByRole('button', { name: /^run sweep$/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /sweeping/i })).toBeDisabled());
  });

  test('clicking sweep repeatedly while pending sends exactly one request', async () => {
    const spy = vi.spyOn(api, 'runSweep').mockImplementation(() => new Promise<SweepRun>(() => {}));

    wrap(<Sweeper />);
    const button = screen.getByRole('button', { name: /^run sweep$/i });
    await userEvent.click(button);
    await userEvent.click(button);

    expect(spy).toHaveBeenCalledTimes(1);
  });

  test('a failed sweep is not retried automatically and shows the error', async () => {
    const spy = vi
      .spyOn(api, 'runSweep')
      .mockRejectedValue(new ApiError(500, 'server_error', 'boom'));

    wrap(<Sweeper />);
    await userEvent.click(screen.getByRole('button', { name: /^run sweep$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The sweep failed');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('Sweeper — results', () => {
  test('with no sweep in this session it shows an honest empty state', () => {
    const { container } = wrap(<Sweeper />);
    expect(container.textContent).toContain('No sweep result is available in this session.');
    expect(container.textContent).not.toContain('Found');
  });

  test('results render from the real response shape', () => {
    sessionRuns.setSweep(sweepRun());
    const { container } = wrap(<Sweeper />);

    expect(container.textContent).toContain('Found1');
    expect(container.textContent).toContain('Still unconfirmed1');
    expect(container.textContent).toContain('pay_00042');
    expect(container.textContent).toContain('EXECUTING');
  });

  test('results are labelled session-only', () => {
    sessionRuns.setSweep(sweepRun());
    const { container } = wrap(<Sweeper />);
    expect(container.textContent).toContain('Current session result');
  });

  test('a resolved-success item says Provider succeeded, never Recovered', () => {
    sessionRuns.setSweep(
      sweepRun({
        resolved_success: 1,
        still_unconfirmed: 0,
        items: [
          sweepItem({
            outcome: 'RESOLVED_SUCCESS',
            observed_state: 'SUCCEEDED',
            execution_status: 'SUCCESS',
            verification_status: null,
          }),
        ],
      }),
    );
    wrap(<Sweeper />);

    const row = screen.getByRole('row', { name: /pay_00042/ });
    expect(row.textContent).toContain('Provider succeeded');
    // A provider observation is not a recovery verdict.
    expect(row.textContent).not.toContain('Recovered');
  });

  test('an empty item list is stated plainly as the healthy result', () => {
    sessionRuns.setSweep(sweepRun({ found: 0, still_unconfirmed: 0, items: [] }));
    const { container } = wrap(<Sweeper />);
    expect(container.textContent).toContain('No stranded actions were found.');
  });

  test('a fresh mount after a reset shows no sweep result', () => {
    sessionRuns.setSweep(sweepRun());
    sessionRuns.reset();

    const { container } = wrap(<Sweeper />);
    expect(container.textContent).toContain('No sweep result is available in this session.');
    expect(container.textContent).not.toContain('pay_00042');
  });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

describe('Stage 4 — no credential reaches the DOM', () => {
  test('none of the three screens renders a credential-shaped string', () => {
    sessionRuns.setBatch(batchRun(), true);
    sessionRuns.setSweep(sweepRun());

    for (const ui of [<Batch />, <BatchResults />, <Sweeper />]) {
      const { container, unmount } = wrap(ui);
      for (const forbidden of FORBIDDEN) {
        expect(container.textContent ?? '').not.toContain(forbidden);
      }
      unmount();
    }
  });
});
