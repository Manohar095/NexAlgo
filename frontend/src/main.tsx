/**
 * CogniX trading sub-app entry.
 *
 * Mounts ONLY OpenAlgoNew's `pages/Trading` (the ChartPane desk) on top of our
 * FastAPI backend. The rest of that repo's `src` rides along unchanged so the
 * page keeps compiling; nothing else is routed here.
 */
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './index.css'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Toaster } from '@/components/ui/sonner'
import Trading from '@/pages/Trading'
import { useAuthStore } from '@/stores/authStore'
import { useThemeStore } from '@/stores/themeStore'

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: true, retry: 1 } },
})

/* The page reads the account chip from the auth store. Our backend has one
   broker session, so mark that session active before the first render.
   `apiKey` rides along as the same decoration OpenAlgo gives it — the session
   cookie is the real gate — but the GTT tab (and anything that takes its key
   from the STORE rather than the page's boot fetch) refuses to query while
   it is null, so the books never load on a fresh profile. */
;(() => {
  const store = useAuthStore.getState()
  if (!store.isAuthenticated) store.login('cognix', 'flattrade')
  if (!useAuthStore.getState().apiKey) store.setApiKey('cognix-local')
})()

/* The desk opens dark, on /charts' surfaces.
   Nothing here picks a theme: this sub-app mounts the trading page alone, so
   there is no AppLayout to read one from and the store's own default is light —
   which is why the page used to paint white next to a black chart. The class is
   already on <html> (see index.html) so the first paint is dark; this seeds the
   STORE, because that is what themes the canvas — ChartPane hands `mode` to the
   terminal through `getTheme`, and the terminal re-themes on the change.

   A stored `light` wins: someone who pressed the band's toggle meant it, and a
   control that silently forgets is worse than a default that needs one click.
   Only the ABSENCE of a choice is filled in, which is the state every fresh
   profile is in. */
;(() => {
  const stored = (() => {
    try {
      return JSON.parse(localStorage.getItem('openalgo-theme') ?? 'null')?.state?.mode
    } catch {
      return null
    }
  })()
  if (stored !== 'light') useThemeStore.setState({ mode: 'dark' })
  document.documentElement.classList.toggle('dark', useThemeStore.getState().mode === 'dark')
})()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/*" element={<Trading />} />
          </Routes>
        </BrowserRouter>
        <Toaster position="bottom-right" richColors closeButton />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>
)
