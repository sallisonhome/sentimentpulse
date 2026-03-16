import axios from 'axios'

/**
 * Axios instance pre-configured for the SentimentPulse backend.
 * In dev, Vite proxies /api → http://localhost:8000/api (see vite.config.ts).
 * In production, set VITE_API_URL env var or configure a reverse proxy.
 */
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL ?? '/api',
  headers: { 'Content-Type': 'application/json' },
  timeout: 30_000,
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
