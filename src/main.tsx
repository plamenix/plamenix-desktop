import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@plamenix/ui';
import { App } from '@/App';
import '@/styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

const container = document.getElementById('root');
if (!container) throw new Error('root element missing');

createRoot(container).render(
  <StrictMode>
    {/* Outside the query provider so a failure in the provider's own
        tree is caught too. Without a boundary, any uncaught render
        error unmounts the whole root — a white page with no
        explanation and every open tab's state gone. */}
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
