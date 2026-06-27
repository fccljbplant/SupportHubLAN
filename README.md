# SupportHubLAN

<div align="center">

[![Live Demo](https://img.shields.io/badge/demo-GitHub%20Pages-blue)](https://fccljbplant.github.io/SupportHubLAN/supporthublan.html)
[![Backend](https://img.shields.io/badge/backend-Node.js%2018%2B-green)](#prerequisites)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)](#prerequisites)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)
[![HTML](https://img.shields.io/badge/HTML-69.2%25-orange)](https://github.com/fccljbplant/SupportHubLAN)
[![JavaScript](https://img.shields.io/badge/JavaScript-27.5%25-yellow)](https://github.com/fccljbplant/SupportHubLAN)

**Windows endpoint administration web app for LAN admins.**  
Remote fleet management via PsTools — no WMI, no WinRM, no agent required on targets.

[Live Demo](https://fccljbplant.github.io/SupportHubLAN/supporthublan.html) · [Quick Start](#quick-start) · [Features](#screens--features) · [API Reference](#api-endpoints)

</div>

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Configuration](#configuration)
- [Screens & Features](#screens--features)
- [API Endpoints](#api-endpoints)
- [File Structure](#file-structure)
- [Tech Stack](#tech-stack)
- [Known Limitations & Roadmap](#known-limitations--roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

SupportHubLAN is a self-hosted web application that gives LAN administrators full visibility and control over their Windows endpoint fleet. It wraps Sysinternals **PsTools** in a modern React UI, exposing inventory management, remote command execution, Windows Update orchestration, deployment pipelines, service/process control, and a powerful multi-step job queue — all from a browser tab.

**Key characteristics:**

- **Zero target-side footprint** — uses PsTools for remote execution over SMB/RPC; no agent, no WMI, no WinRM required on managed PCs.
- **Single-file frontend** — the entire React app ships as one self-contained HTML file (`supporthublan.html`, ~11,000 lines), compiled in-browser by Babel. Works standalone for demo or paired with the backend for full functionality.
- **Encrypted local storage** — data persists in an AES-256-GCM encrypted JSON file (`data/supporthublan-data.enc`); no external database required.
- **70 REST API endpoints** and a WebSocket channel for real-time job progress.
- **12 feature screens**, 15 settings tabs, and a flagship job queue supporting 67 step types across 9 categories.

---

## Architecture

```
Browser (React 18 + Babel) ──HTTP──▶ Node.js (Express) ──spawn──▶ PsTools ──SMB/RPC──▶ Target PCs
         ▲                                 │                          │
         │        WebSocket /ws            │     DCOM (TCP 135)       │     SMB (TCP 445)
         └─────────────────────────────────┘     WMIC / CIM           └──────────────────
```

| Layer | Component | Description |
|---|---|---|
| **Frontend** | `supporthublan.html` | Single-file React 18 app, compiled in-browser via Babel |
| **Backend** | `supporthublan-server/server.js` | Node.js + Express, 3,300+ lines, Windows-only |
| **Remote Execution** | PsTools (Sysinternals) | psexec, psinfo, pslist, pskill, psservice, psloggedon, psshutdown, psfile, psgetsid, pssuspend |
| **Storage** | `data/supporthublan-data.enc` | AES-256-GCM encrypted JSON, PBKDF2 key derivation |
| **Real-time** | WebSocket (`/ws`) | Live job progress, per-step and per-host |

---

## Quick Start

### Option 1 — Static Demo (no backend required)

Open `supporthublan.html` directly in a browser. Demo data is shown; PsTools actions are simulated.

```bash
# Clone and open
git clone https://github.com/fccljbplant/SupportHubLAN.git
cd SupportHubLAN
start supporthublan.html
```

Or visit the [live demo on GitHub Pages](https://fccljbplant.github.io/SupportHubLAN/supporthublan.html).

### Option 2 — One-click Windows Install

Run the bundled installer batch script as Administrator:

```bat
install-supporthublan.bat
```

### Option 3 — Full Backend Deployment

```bat
cd SupportHubLAN\supporthublan-server
copy .env.example .env
REM Edit .env — set DEFAULT_USERNAME, DEFAULT_PASSWORD, DEFAULT_DOMAIN, DB_PASSPHRASE
npm install
npm start
```

Open `http://localhost:8080` in a browser on the same machine or LAN.

---

## Prerequisites

| Requirement | Details |
|---|---|
| **OS** | Windows 10 / 11 or Windows Server 2016+ (server side only) |
| **Node.js** | v18 or later |
| **PsTools** | Sysinternals PsTools suite — extract to `supporthublan-server\PSTools\` |
| **Network** | TCP 445 (SMB) and TCP 135 (RPC/DCOM) open to target PCs |
| **Credentials** | Domain admin or local admin account on managed targets |

> **PsTools** can be downloaded free from [Sysinternals](https://learn.microsoft.com/en-us/sysinternals/downloads/pstools). Extract all binaries to `supporthublan-server\PSTools\`.

---

## Configuration

Copy `.env.example` to `.env` inside `supporthublan-server\` and set the following values:

```env
# Server
PORT=8080
BIND_ADDRESS=0.0.0.0
AUTO_OPEN_BROWSER=true

# PsTools
PSTOOLS_PATH=.\\PSTools\\

# Domain credentials (used for PsTools remote execution)
DEFAULT_DOMAIN=your.domain.com
DEFAULT_USERNAME=your-admin-account
DEFAULT_PASSWORD=your-password

# App admin login (leave blank to disable auth)
ADMIN_USER=
ADMIN_PASS=

# CORS (restrict to specific origins in production)
ALLOWED_ORIGINS=*

# Encrypted data store passphrase — CHANGE THIS
DB_PASSPHRASE=supporthublan-default-change-me
```

> **Security note:** Change `DB_PASSPHRASE` before first use. Plain HTTP only — do not expose this service to untrusted networks without a reverse proxy with TLS.

---

## Screens & Features

### 01 · Dashboard

Central fleet overview with real-time status indicators.

- Fleet status counters: total hosts, online, offline, running jobs, completed jobs
- Patch compliance donut chart
- Active jobs panel with pause / resume / cancel controls
- Quick actions: scan, download updates, install updates, reboot, Wake-on-LAN
- Warning banners for offline hosts, critical updates, and failed jobs
- **Refresh Fleet + Jobs** — pings all hosts by IP and syncs jobs from backend

### 02 · Inventory

Full-featured host management table supporting up to 159+ hosts.

- DataTable with a column chooser (Status, Hostname, IP, OS, User, Site, Dept, Owner, Last Seen, Actions)
- Dynamic host type tabs (Server, Workstation, Laptop, etc. — configurable in Settings)
- Add hosts via: Single entry, Paste list, CSV Import, IP Range Scan, Active Directory Import (with `managedBy` → Owner mapping), or MAC Address
- Edit host modal: hostname, IP, FQDN, MAC, OS, Site, Department, Owner, Tags, Notes
- Bulk actions: Refresh, Check Updates, Install Updates, Reboot, Deploy, Run Script, Connect, Export, Delete
- Online / offline LED indicator (live green/red dot)

### 03 · Windows Updates

- Scan, download, and install Windows updates via the PSWindowsUpdate PowerShell module
- Per-host update history
- Fleet-wide patch compliance tracking

### 04 · Deployments

- Deploy MSI, EXE, and PS1 packages to one or many hosts simultaneously
- Full deployment history log

### 05 · Scripts & Commands

- Execute PowerShell or CMD scripts on remote hosts
- Saved commands library for frequently used operations
- Multi-host execution with per-host output panels

### 06 · Services & Processes

- Per-host service list with Start / Stop / Restart actions
- Process list with Kill action
- Fleet search — locate a named service or process across all online hosts
- **Stopped Auto-Services** diagnostic report

### 07 · Remote Access

- Launch VNC, RDP, and SSH sessions directly from the browser
- Connection history and favorites
- Configurable client paths per protocol

### 08 · Power & Wake

- Actions: Reboot, Shutdown, Force Reboot, Abort Pending Reboot
- Wake-on-LAN (magic packet broadcast)
- Maintenance window scheduling

### 09 · Job Queue *(Flagship Feature)*

A multi-step automation engine that runs configurable pipelines against selected hosts.

**67 step types across 9 categories:**

| Category | Step Count | Examples |
|---|---|---|
| Windows Update | 10 | Scan, Download, Install, Check Compliance |
| Deployment | 3 | Deploy Package, Verify Install |
| Script / Command | 3 | Run PS1, Run CMD, Run Inline |
| Service | 4 | Start, Stop, Restart, Assert State |
| Power | 4 | Reboot, Shutdown, Force Reboot, Abort |
| Wait / Timing | 5 | Wait, Wait for Host Online, Delay |
| Conditional / Branch | 15 | If Online, If Service Running, If Update Available |
| **PsTools** | **19** | Hardware Scan, Apps Scan, Services Scan, PsExec, PsInfo, PsList, PsKill, … |
| Control | 7 | Loop, Break, Abort, Log Message |

**Additional capabilities:**

- **Variable substitution**: `{HOST_IP}`, `{HOST_NAME}`, `{USER}`, `{PASS}`, `{QUEUE_ID}`, `{JOB_NAME}`, `{TIMESTAMP}`
- **Credential fallback**: primary domain credential → fallback local admin on access denied
- **Live WebSocket progress**: per-step, per-host, overall %, and current host % in real time
- **History tab**: expandable per-PC logs with color-coded host result boxes
- **Running tab**: pause / resume / stop / delete with live API calls
- **Syntax validation**: catches missing commands, unsubstituted variables, and empty step configs before execution
- **HostSelector**: online/offline badges, offline hosts grayed out, optional "Include offline" toggle

### 10 · Scheduler

- Schedule any job queue for future one-time or recurring execution
- Scheduled task management list

### 11 · Reports & Logs

- Full audit trail with filters: date, host, action, user, result
- **Expandable command output** — click any log entry to view full `stdout`/`stderr`
- Patch history, deployment log, and job logs
- CSV and JSON export with column selection

### 12 · Settings *(15 tabs)*

| Tab | Configuration |
|---|---|
| General | Display name, backend URL, timezone, session timeout |
| Appearance | Dark / Light / System theme, density, font size |
| PsTools | Folder path, timeout, max concurrent jobs, connection test |
| Remote Desktop | VNC / RDP / SSH client paths and ports |
| Active Directory | Domain, DC, search base, OU, service account |
| Credentials | Domain + fallback credential vault |
| Host Metadata | Manage Sites, Departments, and Host Types |
| Inventories | Multi-inventory management |
| LAPS | Rotate and retrieve local admin passwords |
| Notifications | Email and in-app notification rules |
| Email | SMTP server configuration |
| Users & Roles | RBAC with invite modal |
| API Keys | Generate and revoke API keys for programmatic access |
| Retention | Audit log, job log, and report archive retention periods |
| Production Mode | Backend URL override and connection tester |

---

## API Endpoints

The backend exposes **70 REST endpoints** plus a WebSocket channel.

| Category | Endpoints |
|---|---|
| Health | `GET /api/health`, `GET /api/logs` |
| Inventories | `GET/POST /api/inventories`, `PUT/DELETE /api/inventories/:id` |
| Hosts | `GET/POST /api/inventories/:id/hosts`, `PUT/DELETE /api/hosts/:id` |
| Host Operations | `POST /api/hosts/:hostname/info`, `/ping`, `/hardware`, `/apps`, `/apps/uninstall`, `/eventlog` |
| Status | `POST /api/hosts/status-check`, `/batch-info`, `/detect-domain`, `/discover-ad` |
| Services | `POST /api/services/:hostname/list`, `/action` |
| Processes | `POST /api/processes/:hostname/list`, `/kill` |
| Windows Updates | `POST /api/updates/scan`, `/download`, `/install`, `/history` |
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

## File Structure

```
SupportHubLAN/
├── supporthublan.html              # Single-file React 18 frontend (~11,000 lines)
├── supporthublan-server/
│   ├── server.js                   # Express backend (3,300+ lines, 70 endpoints)
│   ├── db.js                       # Encrypted JSON data layer (AES-256-GCM)
│   ├── lib/
│   │   ├── audit.js                # Audit trail and command logging
│   │   ├── pstools.js              # PsTools child-process spawn wrapper
│   │   ├── wmic.js                 # WMIC + CIM DCOM queries
│   │   ├── powershell.js           # PsExec PowerShell runner
│   │   ├── utils.js                # Shared utilities
│   │   └── winrm.js                # WinRM (deprecated — see AGENTS.md)
│   ├── PSTools/                    # ← Place Sysinternals PsTools binaries here
│   ├── data/                       # supporthublan-data.enc (auto-created)
│   ├── .env.example                # Environment variable template
│   └── package.json
├── vendor/                         # Vendored frontend dependencies (offline-safe)
│   ├── babel.min.js
│   ├── tailwind.min.js
│   ├── react.production.min.js
│   ├── react-dom.production.min.js
│   └── lucide.min.js
├── build-installer.bat             # Builds a self-contained Windows installer
├── install-supporthublan.bat       # One-click install script
├── start-supporthublan.bat         # Launch script
├── QUEUE_WIRING_LOG.md             # Queue/jobs wiring audit trail
├── AUDIT_LOG.md                    # Code-level audit log
├── FEATURE_PLAN.md                 # Feature module tracker
├── AGENTS.md                       # AI agent configuration and rules
└── README.md
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend framework | React 18 (classic runtime, in-browser compilation) |
| JS compilation | Babel Standalone |
| CSS framework | Tailwind CSS (vendored local copy) |
| Icons | Lucide (vendored local copy) |
| Backend runtime | Node.js 18+ |
| Web framework | Express |
| Remote execution | Sysinternals PsTools (10 tools) |
| AD integration | .NET `DirectorySearcher` + `DirectoryContext` via PowerShell |
| Data storage | Encrypted JSON — AES-256-GCM + PBKDF2 |
| Real-time transport | WebSocket (`ws` package) |

All frontend dependencies are vendored locally — no CDN required, so SupportHubLAN works in air-gapped or restricted-network environments.

---

## Known Limitations & Roadmap

The following areas are partially implemented or planned for future development:

| Area | Status |
|---|---|
| **Auto-run on host-online** | Toggle exists in UI; timer and trigger logic not yet implemented |
| **Processes tab in host drawer** | Removed during cleanup; no dedicated process viewer in host panel |
| **Network scan tab in host drawer** | Not implemented; network adapter info available only in raw hardware scan output |
| **Full Audit button** | Not implemented; no combined "run all scans" action in host drawer |
| **Terminal panel** | Removed entirely; WebSocket terminal handlers and UI deleted |
| **Scheduler execution** | UI and database model exist; backend cron engine not yet wired |
| **Email notifications** | SMTP configuration UI complete; no actual email sending implemented |
| **Compliance donut** | Uses simulated data for hosts not yet pinged |
| **Job drawer Live Log** | Falls back to static placeholder when no live log data is available |
| **SQLite backend** | Planned to replace encrypted JSON for better scalability |
| **HTTPS / TLS** | Not configured; plain HTTP only — use a reverse proxy (nginx, Caddy) for TLS |

---

## Contributing

Contributions are welcome. Please open an issue before submitting a pull request for significant changes.

1. Fork the repository and create a feature branch.
2. Follow the existing code style (ES2020 JS, React hooks, Tailwind utility classes).
3. Test against a real Windows environment with PsTools installed.
4. Update `FEATURE_PLAN.md` and `AUDIT_LOG.md` if relevant.
5. Open a pull request with a clear description of the change and its rationale.

---

## License

MIT © [fccljbplant](https://github.com/fccljbplant)

See [`LICENSE`](./LICENSE) for full text.
