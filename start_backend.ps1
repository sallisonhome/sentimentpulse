$backendDir = "C:\sentimentpulse\backend"
$python    = "C:\sentimentpulse\backend\.venv\Scripts\python.exe"

Start-Process -FilePath $python `
    -ArgumentList "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000" `
    -WorkingDirectory $backendDir `
    -RedirectStandardOutput "C:\sentimentpulse\backend\uvicorn.out.log" `
    -RedirectStandardError  "C:\sentimentpulse\backend\uvicorn.err.log" `
    -WindowStyle Hidden
