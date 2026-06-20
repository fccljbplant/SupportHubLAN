# SupportHubLAN Backend Server

Node.js backend that serves the frontend AND the API on a single port (default 8080).

See the main [README.md](../README.md) in the repo root for complete documentation.

## Quick start

```powershell
cd supporthublan-server
npm install
copy .env.example .env   # then edit if needed
npm start
```

Server runs on http://localhost:8080 and auto-opens the browser.

## What it does

- Serves `../supporthublan.html` at `/`
- Serves `/vendor/*` static assets (React, Babel, Tailwind, Lucide)
- Exposes 30+ API endpoints under `/api/*`
- WebSocket at `/ws` for live job queue progress
- Spawns PowerShell to execute PsTools (PsExec, PsInfo, PsList, PsKill, PsService, PsLoggedOn, PsFile, PsGetSid, PsSuspend, PsShutdown)
- Calls `Get-ADComputer` for AD imports + reads `ms-Mcs-AdmPwd` for LAPS
- Calls `PSWindowsUpdate` module for Windows Updates
- Sends Wake-on-LAN UDP magic packets
- Spawns `vncviewer.exe` / `mstsc.exe` for remote desktop quick-launch

## Configuration

All settings in `.env` (see `.env.example`). Key ones:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `PSTOOLS_PATH` | `C:\PSTools\` | Where psexec.exe lives |
| `BIND_ADDRESS` | `0.0.0.0` | Network bind |
| `ADMIN_USER` / `ADMIN_PASS` | _(empty)_ | Optional Basic Auth |
| `ALLOWED_ORIGINS` | `*` | CORS |

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Backend health check + endpoint inventory |
| POST | `/api/credentials` | Store credential |
| GET | `/api/credentials` | List credentials |
| POST | `/api/hosts/discover-ad` | AD computer discovery via `Get-ADComputer` |
| POST | `/api/hosts/:hostname/info` | System info via CIM |
| POST | `/api/hosts/:hostname/ping` | Single-host ping |
| POST | `/api/scan` | Parallel ping sweep (runspace pool) |
| POST | `/api/updates/scan` | Scan for updates (PSWindowsUpdate) |
| POST | `/api/updates/download` | Download updates |
| POST | `/api/updates/install` | Install updates |
| POST | `/api/updates/history` | Update history |
| POST | `/api/scripts/execute` | Run PowerShell remotely |
| POST | `/api/services/:hostname/list` | List services |
| POST | `/api/services/:hostname/action` | Start/stop/restart service |
| POST | `/api/processes/:hostname/list` | List processes |
| POST | `/api/processes/:hostname/kill` | Kill process by PID |
| POST | `/api/power/action` | Reboot/shutdown |
| POST | `/api/power/wol` | Wake-on-LAN magic packet |
| POST | `/api/laps/retrieve` | Get LAPS password from AD |
| POST | `/api/laps/rotate` | Trigger LAPS password rotation |
| POST | `/api/deploy/package` | Copy + install MSI/EXE |
| POST | `/api/queues/execute` | Start job queue (async + WebSocket) |
| POST | `/api/pstools/execute` | Generic PsTools runner |
| POST | `/api/pstools/psinfo` | PsInfo |
| POST | `/api/pstools/pslist` | PsList |
| POST | `/api/pstools/pskill` | PsKill |
| POST | `/api/pstools/psservice` | PsService |
| POST | `/api/pstools/psloggedon` | PsLoggedOn |
| POST | `/api/pstools/psshutdown` | PsShutdown |
| POST | `/api/pstools/psfile` | PsFile |
| POST | `/api/pstools/psgetsid` | PsGetSid |
| POST | `/api/pstools/pssuspend` | PsSuspend |
| POST | `/api/remote/connect` | Launch VNC/RDP viewer |
| WS | `/ws` | Live updates (queue progress, scan results) |

## Production notes

- For multi-user auth, put behind a reverse proxy (nginx/IIS) with OIDC
- For HTTPS, terminate TLS at the reverse proxy
- For audit log compliance, forward `/api/*` access logs to a SIEM
- Credentials are stored in-memory only — restart loses them. For persistent storage, integrate Windows Credential Manager via the `wincred` npm package

## Troubleshooting

See main [README.md → Troubleshooting](../README.md#troubleshooting).
