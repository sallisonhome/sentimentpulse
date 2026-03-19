$frontendDir = "C:\sentimentpulse\frontend"

Start-Process -FilePath "cmd.exe" `
    -ArgumentList "/c", "npm run dev" `
    -WorkingDirectory $frontendDir `
    -RedirectStandardOutput "C:\sentimentpulse\frontend\vite.out.log" `
    -RedirectStandardError  "C:\sentimentpulse\frontend\vite.err.log" `
    -WindowStyle Hidden
