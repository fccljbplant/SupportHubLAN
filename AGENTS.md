# SupportHubLAN — Agent Configuration

## Hard Constraints

### PsTools-Only Remote Execution
- **ALL** actions on remote workstations/PCs must use **PsTools** binaries (`psexec.exe`, `psservice.exe`, `pskill.exe`, `psinfo.exe`, `pslist.exe`, `psloggedon.exe`, `psfile.exe`, `psgetsid.exe`, `pssuspend.exe`, `psshutdown.exe`)
- **No WinRM** — do NOT use PowerShell cmdlets that require WinRM/PSRP on targets: `Get-CimInstance`, `Get-WmiObject`, `Invoke-Command`, `Start-Service`, `Stop-Service`, `Restart-Service`, `Restart-Computer`, `Stop-Computer`
- The backend (`server.js`) runs on a Windows admin PC. PsTools talks to targets over SMB (port 445) / RPC (port 135) — no agent or WinRM required on targets.

### Frontend Architecture
- `supporthublan.html` is a single-file React app compiled by Babel with classic runtime
- All state lives in a single `useApp()` context
- Backend API is accessed via `window.SupportHubLANAPI`
- Host IDs from backend are prefixed with `'db-'` in frontend; stripped for API calls
