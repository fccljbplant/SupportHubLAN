# SupportHubLAN

> Windows endpoint administration web app for LAN admins. Uses **PsTools** for remote execution — no WMI, no WinRM, no agent required on targets.

[![Live Demo](https://img.shields.io/badge/demo-GitHub%20Pages-blue)](https://fccljbplant.github.io/SupportHubLAN/supporthublan.html)
[![Backend](https://img.shields.io/badge/backend-Node.js%2018%2B-green)](#deployment)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)](#prerequisites)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)

---

## Architecture

```
Browser (React 18 + Babel) ──HTTP──▶ Node.js (Express) ──spawn──▶ PsTools ──SMB/RPC──▶ Target PCs
                  ▲                         │                         │
                  │      WebSocket /ws      │     DCOM (135)          │     SMB (445)
                  └─────────────────────────┘     WMIC / CIM          └───────────────
```

- **Frontend**: Single-file React 18 app (`supporthublan.html`, ~11,000 lines) compiled in-browser by Babel
- **Backend**: Node.js Express server (`server.js`) on a Windows admin PC
- **Storage**: Encrypted JSON file (`data/supporthublan-data.enc`) — AES-256-GCM, PBKDF2 key derivation
- **No external DB needed** — zero native dependencies, pure Node.js

---

## Quick Start (3 Ways)

### 1. Static Demo (no backend)
Open `supporthublan.html` in a browser. Shows demo data. No real PsTools actions.

### 2. Local HTML
```bash
git clone https://github.com/fccljbplant/SupportHubLAN.git
cd SupportHubLAN
start supporthublan.html
```

### 3. Full Deployment
```bash
cd SupportHubLAN\supporthublan-server
copy .env.example .env
# Edit .env — set DEFAULT_USERNAME, DEFAULT_PASSWORD, DEFAULT_DOMAIN
npm install
npm start
```
Open `http://localhost:8080`.

---

## Prerequisites

- **Server**: Windows 10/11 or Windows Server with Node.js 18+
- **PsTools**: Extract to `supporthublan-server\PSTools\` (psexec.exe, psinfo.exe, etc.)
- **Network**: TCP 445 (SMB), TCP 135 (RPC/DCOM) to target PCs
- **Credentials**: Domain admin or local admin account on targets

---

## Screens & Features

### 01 — Dashboard
- Fleet status overview (total/online/offline/running jobs/completed jobs)
- Patch compliance donut chart
- Active jobs panel with pause/resume/cancel
- Quick actions (scan, download, install updates, reboot, WoL)
- Warning banners for offline hosts, critical updates, failed jobs
- **Refresh Fleet + Jobs** button — pings all hosts by IP, pulls jobs from backend

### 02 — Inventory (159 hosts supported)
- DataTable with column chooser (default: Status · Hostname · IP · OS · User · Site · Dept · Owner · Last Seen · Actions)
- Dynamic host type tabs (Server, Workstation, Laptop, etc. — managed in Settings)
- Add hosts: Single, Paste, CSV Import, IP Range Scan, **AD Import** (with `managedBy` → Owner), MAC Address
- Edit host modal: hostname, IP, FQDN, MAC, OS, Site, Department, Owner, Tags, Notes
- Bulk actions: Refresh, Check/Install Updates, Reboot, Deploy, Run Script, Connect, Export, Delete
- Online/offline LED indicator (green/red dot)

### 03 — Windows Updates
- Scan, Download, Install updates via PSWindowsUpdate module
- Update history per host
- Compliance tracking

### 04 — Deployments
- Deploy MSI/EXE/PS1 packages to selected hosts
- Deployment history

### 05 — Scripts & Commands
- Run PowerShell/CMD scripts on remote hosts
- Saved commands library
- Multi-host execution with per-host output

### 06 — Services & Processes
- Per-host service list with Start/Stop/Restart actions
- Process list with Kill action
- Fleet search — find service/process across all online hosts
- Stopped Auto-Services diagnostic report

### 07 — Remote Access
- Launch VNC/RDP/SSH sessions
- Connection history and favorites
- Configurable client paths

### 08 — Power & Wake
- Reboot, Shutdown, Force Reboot, Abort Reboot
- Wake-on-LAN (magic packet)
- Maintenance windows

### 09 — Job Queue (Flagship)
- **67 step types** across 9 categories:
  - Windows Update (10 steps)
  - Deployment (3 steps)
  - Script / Command (3 steps)
  - Service (4 steps)
  - Power (4 steps)
  - Wait / Timing (5 steps)
  - Conditional / Branch (15 steps)
  - **PsTools (19 steps)** — includes Hardware Scan, Apps Scan, Services Scan
  - Control (7 steps)
- Multi-step sequential execution on selected hosts
- **Variable substitution**: `{HOST_IP}`, `{HOST_NAME}`, `{USER}`, `{PASS}`, `{QUEUE_ID}`, `{JOB_NAME}`, `{TIMESTAMP}`
- **Credential rules**: primary domain cred → fallback local admin on access denied
- **Live WebSocket progress**: per-step, per-host, overall %, current host %
- **History tab**: expandable per-PC logs with color-coded host boxes
- **Running tab**: pause/resume/stop/delete with real API calls
- **Syntax validation**: checks for missing commands, unsubstituted variables, empty configs
- **HostSelector**: online/offline badges, offline hosts grayed out, "Include offline" toggle

### 10 — Scheduler
- Schedule queues for future execution
- Scheduled tasks list

### 11 — Reports & Logs
- Full audit trail with filters (date, host, action, user, result)
- **Expandable full command output** — click to see complete stdout/stderr
- Patch history, deployment log, job logs
- CSV/JSON export with column selection

### 12 — Settings (15 tabs)
- **General**: Display name, backend URL, timezone, session timeout
- **Appearance**: Dark/Light/System theme, density, font size
- **PsTools**: Folder path, timeout, max concurrent jobs, test connection
- **Remote Desktop**: VNC/RDP/SSH client paths and ports
- **Active Directory**: Domain, DC, search base, OU, service account
- **Credentials**: Domain + Fallback credential vault
- **Host Metadata**: Manage Sites, Departments, Host Types (add/remove)
- **Inventories**: Multi-inventory management
- **LAPS**: Rotate/retrieve local admin passwords
- **Notifications**: Email/in-app rules
- **Email**: SMTP configuration
- **Users & Roles**: RBAC with invite modal
- **API Keys**: Generate/revoke for programmatic access
- **Retention**: Audit log, job log, report archive retention
- **Production Mode**: Backend URL, connection tester

---

## API Endpoints (70 total)

| Category | Endpoints |
|----------|-----------|
| Health | `GET /api/health`, `GET /api/logs` |
| Inventories | `GET/POST /api/inventories`, `PUT/DELETE /api/inventories/:id` |
| Hosts | `GET/POST /api/inventories/:id/hosts`, `PUT/DELETE /api/hosts/:id` |
| Host Ops | `POST /api/hosts/:hostname/info`, `/ping`, `/hardware`, `/apps`, `/apps/uninstall`, `/eventlog` |
| Status | `POST /api/hosts/status-check`, `/batch-info`, `/detect-domain`, `/discover-ad` |
| Services | `POST /api/services/:hostname/list`, `/action` |
| Processes | `POST /api/processes/:hostname/list`, `/kill` |
| Updates | `POST /api/updates/scan`, `/download`, `/install`, `/history` |
| Scripts | `POST /api/scripts/execute` |
| Deploy | `POST /api/deploy/package` |
| Power | `POST /api/power/action`, `/wol` |
| Jobs | `GET /api/jobs`, `GET/DELETE /api/jobs/:id`, `POST .../cancel`, `/pause`, `/resume`, `/rerun-failed` |
| Queue | `POST /api/queues/execute` |
| PsTools | `POST /api/pstools/psinfo`, `/pslist`, `/pskill`, `/psservice`, `/psloggedon`, `/psshutdown`, `/psfile`, `/psgetsid`, `/pssuspend`, `/execute` |
| LAPS | `POST /api/laps/retrieve`, `/rotate` |
| Credentials | `GET/POST /api/credentials`, `GET/DELETE /api/credentials/:id` |
| Settings | `GET/POST /api/settings`, `/log-retention`, `/domain-credentials`, `/fallback-credentials` |
| Audit | `GET /api/audit`, `/host/:hostname`, `/search`, `POST /api/audit`, `/clear`, `/cleanup` |
| Remote | `POST /api/remote/connect` |
| DNS | `POST /api/dns/resolve`, `/bulk-resolve` |
| WebSocket | `WS /ws` — queue progress, scan results |

---

## Configuration (.env)

```ini
PORT=8080
PSTOOLS_PATH=.\\PSTools\\
BIND_ADDRESS=0.0.0.0
DEFAULT_DOMAIN=your.domain.com
DEFAULT_USERNAME=your-username
DEFAULT_PASSWORD=your-password
ADMIN_USER=
ADMIN_PASS=
ALLOWED_ORIGINS=*
AUTO_OPEN_BROWSER=true
DB_PASSPHRASE=supporthublan-default-change-me
```

---

## Not Yet Wired / Incomplete

| Area | Detail |
|------|--------|
| **Auto-run on come online** | Toggle exists but timer not implemented — needs host online detection + 5-min delay queue trigger |
| **Processes tab in host drawer** | Was removed during cleanup — no dedicated process viewer in host panel |
| **Network scan tab in host drawer** | Not implemented — network adapter info only in hardware scan raw output |
| **Full Audit button** | Not implemented — no combined "run all scans" in host drawer |
| **Terminal panel** | Removed entirely — WebSocket terminal handlers deleted, UI removed |
| **Scheduler execution** | UI exists but backend cron/scheduler not implemented |
| **Email notifications** | SMTP config UI exists but no actual email sending implemented |
| **Hardware scan raw outputs** | `rawOutputs` saved but debug panel hidden by default |
| **Job drawer Live Log** | Falls back to static placeholder when no real log data available |
| **Compliance donut** | Uses hardcoded simulation data for non-pinged hosts |
| **Server-side SQLite** | Planned but not yet implemented — currently encrypted JSON file |
| **HTTPS** | Not configured — plain HTTP only |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend framework | React 18 (classic runtime, single-file) |
| Compilation | Babel standalone (in-browser) |
| CSS | Tailwind CSS (local vendor copy) |
| Icons | Lucide (local vendor copy) |
| Backend | Node.js + Express |
| Remote execution | Sysinternals PsTools suite (10 tools) |
| Storage | Encrypted JSON (AES-256-GCM + PBKDF2) |
| Real-time | WebSocket (ws) |
| AD integration | .NET DirectorySearcher + DirectoryContext |

---

## File Structure

```
SupportHubLAN/
├── supporthublan.html          # Single-file React app
├── supporthublan-server/
│   ├── server.js               # Express backend (3,300+ lines)
│   ├── db.js                   # Encrypted JSON data layer
│   ├── lib/
│   │   ├── audit.js            # Audit + command logging
│   │   ├── pstools.js          # PsTools spawn wrapper
│   │   ├── wmic.js             # WMIC + CIM DCOM queries
│   │   ├── powershell.js       # PsExec PowerShell runner
│   │   ├── utils.js            # Shared utilities
│   │   └── winrm.js            # WinRM (deprecated per AGENTS.md)
│   ├── PSTools/                # PsTools binaries
│   ├── data/                   # supporthublan-data.enc
│   └── package.json
├── vendor/                     # Local vendor copies
│   ├── babel.min.js
│   ├── tailwind.min.js
│   ├── react.production.min.js
│   ├── react-dom.production.min.js
│   └── lucide.min.js
├── QUEUE_WIRING_LOG.md         # Queue/jobs wiring audit
├── AUDIT_LOG.md                # Code audit log
├── FEATURE_PLAN.md             # Feature module tracker
├── AGENTS.md                   # Agent configuration rules
└── README.md                   # This file
```

---

## License

MIT
