import { useSyncExternalStore } from 'react';
import type { BatchRun, SweepRun } from '../types/domain.ts';

/**
 * Holds the last batch and sweep response in memory for this tab.
 *
 * The backend persists no run summaries — there is no runs or sweeps table,
 * and neither handler writes one. The *effects* of a run are rows (cases,
 * actions, audit events); the summary exists only in the HTTP response.
 *
 * DELIBERATELY NOT localStorage: surviving a reload would imply backend
 * history that does not exist. Disappearing is the honest representation.
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
