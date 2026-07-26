import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/queryClient'
import { AppProvider } from './contexts/AppContext'
import { ThemeProvider } from './contexts/ThemeContext'
import App from './App'
import './index.css'

// Keep BASENAME in sync with vite.config.ts `base` and the Nginx
// `/sentiment/` location. BrowserRouter now lives here (was in App.tsx)
// so that AppProvider — which uses useSearchParams() to sync the
// selected game with the URL — renders inside the Router context.
const BASENAME = '/sentiment'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter basename={BASENAME}>
          <AppProvider>
            <App />
          </AppProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
)
