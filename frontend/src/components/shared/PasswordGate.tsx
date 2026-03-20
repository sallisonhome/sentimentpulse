import { useState, type FormEvent } from 'react'
import { ShieldCheck, Eye, EyeOff } from 'lucide-react'

const CORRECT_PASSWORD = 'SABER'
const SESSION_KEY = 'sp_authenticated'

export function isAuthenticated(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === 'true'
  } catch {
    return false
  }
}

function setAuthenticated(): void {
  try {
    sessionStorage.setItem(SESSION_KEY, 'true')
  } catch {
    // sessionStorage unavailable — auth will only last until component unmounts
  }
}

interface PasswordGateProps {
  children: React.ReactNode
}

export default function PasswordGate({ children }: PasswordGateProps) {
  const [authed, setAuthed] = useState(isAuthenticated)
  const [password, setPassword] = useState('')
  const [error, setError] = useState(false)
  const [showPassword, setShowPassword] = useState(false)

  if (authed) return <>{children}</>

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (password.trim().toUpperCase() === CORRECT_PASSWORD) {
      setAuthenticated()
      setAuthed(true)
      setError(false)
    } else {
      setError(true)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo area */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary">
            <ShieldCheck className="h-7 w-7 text-primary-foreground" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-bold tracking-tight text-foreground">SentimentPulse</h1>
            <p className="mt-1 text-sm text-muted-foreground">Enter the access password to continue</p>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => { setPassword(e.target.value); setError(false) }}
              placeholder="Password"
              autoFocus
              className={`
                w-full rounded-lg border px-4 py-3 pr-10 text-sm
                bg-card text-foreground placeholder:text-muted-foreground
                outline-none transition-colors
                focus:ring-2 focus:ring-ring focus:border-transparent
                ${error ? 'border-destructive ring-1 ring-destructive' : 'border-border'}
              `}
              data-testid="input-password"
            />
            <button
              type="button"
              onClick={() => setShowPassword(v => !v)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              tabIndex={-1}
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>

          {error && (
            <p className="text-sm text-destructive" data-testid="text-password-error">
              Incorrect password. Please try again.
            </p>
          )}

          <button
            type="submit"
            className="w-full rounded-lg bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            data-testid="button-submit-password"
          >
            Access Dashboard
          </button>
        </form>
      </div>
    </div>
  )
}
