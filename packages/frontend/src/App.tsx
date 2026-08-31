import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell.tsx';
import { AuthGate } from './components/AuthGate.tsx';
import { Overview } from './pages/Overview.tsx';
import { Cases } from './pages/Cases.tsx';
import { CaseDetail } from './pages/CaseDetail.tsx';
import { Payments } from './pages/Payments.tsx';
import { PaymentDetail } from './pages/PaymentDetail.tsx';
import { Audit } from './pages/Audit.tsx';
import { Analytics } from './pages/Analytics.tsx';
import { Approvals } from './pages/Approvals.tsx';
import { SystemStatus } from './pages/SystemStatus.tsx';
import { Settings } from './pages/Settings.tsx';
import { Batch } from './pages/Batch.tsx';
import { BatchResults } from './pages/BatchResults.tsx';
import { Sweeper } from './pages/Sweeper.tsx';
import { ApiError } from './api/client.ts';

/**
 * Query defaults.
 *
 * Retries apply only to reads — every query here is a GET. Mutations are NOT
 * configured with retry, and the API client refuses to retry a non-GET
 * regardless, so a financial POST can never be sent twice by the client.
 *
 * A 4xx is never retried: the request itself is what the server rejected, so
 * repeating it only wastes the operator's rate-limit budget.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: false,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
    },
    mutations: { retry: false },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthGate>
          <AppShell>
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/cases" element={<Cases />} />
              <Route path="/cases/:caseId" element={<CaseDetail />} />
              <Route path="/payments" element={<Payments />} />
              <Route path="/payments/:paymentId" element={<PaymentDetail />} />
              <Route path="/analytics" element={<Analytics />} />
              <Route path="/audit" element={<Audit />} />
              <Route path="/approvals" element={<Approvals />} />
              <Route path="/batch" element={<Batch />} />
              <Route path="/batch/results" element={<BatchResults />} />
              <Route path="/sweeper" element={<Sweeper />} />
              <Route path="/status" element={<SystemStatus />} />
              <Route path="/settings" element={<Settings />} />
            </Routes>
          </AppShell>
        </AuthGate>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
