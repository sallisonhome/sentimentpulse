import axios from 'axios'

/**
 * Axios instance pre-configured for the SentimentPulse backend.
 * In dev, Vite proxies /api → http://localhost:8000/api (see vite.config.ts).
 * In production, set VITE_API_URL env var or configure a reverse proxy.
 */
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? '/api',
  headers: { 'Content-Type': 'application/json' },
  // 90-second timeout (raised from 30s on 2026-07-13).
  //
  // The on-demand window-summary refresh (Past 1d / Past 7d buttons on the
  // Summary page) triggers 3 serial Sonar Pro LLM calls (exec + recs + bold-
  // ideas). Each call takes 5-15s under normal load, and the total can push
  // 30-45s on cold cache. The prior 30s ceiling produced
  //   "Failed to generate 1 day summary: timeout of 30000ms exceeded"
  // even though the backend was still working and the second click succeeded
  // because partial LLM output had cached.
  //
  // 90s is well below nginx's 120s proxy_read_timeout (nginx/sentimentpulse.conf)
  // and the Sonar client's 180s per-call ceiling (services/sonar_client.py),
  // so it doesn't create a new race with anything downstream.
  timeout: 90_000,
})

// Surface HTTP error messages cleanly to React Query
api.interceptors.response.use(
  res => res,
  err => {
    const message =
      err.response?.data?.detail ??
      err.response?.data?.message ??
      err.message ??
      'Unknown error'
    return Promise.reject(new Error(message))
  },
)
