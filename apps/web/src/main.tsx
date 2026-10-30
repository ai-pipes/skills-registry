// Must stay first: turns Zod JIT off before @skills/contracts creates its schemas (CSP has no unsafe-eval).
import '@/zod-config.ts';
import { CSPProvider } from '@base-ui/react/csp-provider';
import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createQueryClient } from '@/api/queryClient.ts';
import { App } from '@/app/App.tsx';
import { Toaster } from '@/components/Toaster.tsx';
import '@/styles/global.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing in index.html');

// Set the theme before the first paint (no light flash); useSystemTheme keeps it in sync.
document.documentElement.classList.toggle(
  'dark',
  window.matchMedia('(prefers-color-scheme: dark)').matches,
);

const queryClient = createQueryClient();

createRoot(root).render(
  <StrictMode>
    {/* CSP `style-src 'self'` blocks inline <style>; Base UI's rules live in global.css. */}
    <CSPProvider disableStyleElements>
      <QueryClientProvider client={queryClient}>
        <App />
        <Toaster />
      </QueryClientProvider>
    </CSPProvider>
  </StrictMode>,
);
