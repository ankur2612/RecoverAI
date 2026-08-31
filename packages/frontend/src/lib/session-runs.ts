import { useSyncExternalStore } from 'react';
import type { BatchRun, SweepRun } from '../types/domain.ts';

/**
 * ============================================================================
 * SESSION-ONLY RUN RESULTS
 * ============================================================================
 *
 * THE BACKEND DOES NOT PERSIST RUNS.
 *
 * There is no runs table and no sweeps table in any migration, and neither
 * POST handler writes one. `POST /api/recovery/runs` and
 * `POST /api/recovery/sweep` compute a summary in memory and return it. The
 * *effects* of a run are persisted — recovery cases, actions, and audit events
 * are rows, and the Audit Log is the durable record of them — but the run
 * SUMMARY itself exists only in the HTTP response.
 *
 * So this module holds the last response of each kind in MEMORY, for this tab,
 * for as long as it stays open.
 *
 * DELIBERATELY NOT localStorage OR sessionStorage. Writing a run summary to
 * browser storage would make it survive a reload, which is exactly the
 * impression that would be false: the operator would see a "last run" that the
 * backend has no record of and cannot reproduce. A summary that disappears on
 * reload is the honest representation of a summary the server did not keep.
 *
 * The screens that read this store must say so on the page — see
 * SESSION_ONLY_NOTICE.
 */

/** The sentence every screen showing one of these results must display. */
export const SESSION_ONLY_NOTICE =
  'This result is held in this browser tab only. The backend does not store run history, ' +
  'so reloading this page discards it. The audit log is the durable record.';

interface SessionRunState {
  batch: BatchRun | null;
  /** Whether the stored batch run was executed or previewed. */
  batchExecuted: boolean;
  /** When the client received it. Not a backend timestamp. */
  batchReceivedAt: string | null;
  sweep: SweepRun | null;
  sweepReceivedAt: string | null;
}

const EMPTY: SessionRunState = {
  batch: null,
  batchExecuted: false,
  batchReceivedAt: null,
  sweep: null,
  sweepReceivedAt: null,
};

let state: SessionRunState = EMPTY;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const sessionRuns = {
  get(): SessionRunState {
    return state;
  },
  setBatch(run: BatchRun, executed: boolean): void {
    state = { ...state, batch: run, batchExecuted: executed, batchReceivedAt: new Date().toISOString() };
    emit();
  },
  setSweep(run: SweepRun): void {
    state = { ...state, sweep: run, sweepReceivedAt: new Date().toISOString() };
    emit();
  },
  /** Exposed for tests, so one case cannot leak into the next. */
  reset(): void {
    state = EMPTY;
    emit();
  },
};

/** Subscribe a component to the in-memory run store. */
export function useSessionRuns(): SessionRunState {
  return useSyncExternalStore(subscribe, sessionRuns.get, sessionRuns.get);
}
