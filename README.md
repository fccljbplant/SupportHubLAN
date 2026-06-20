# SupportHubLAN

**Windows Endpoint Administration Console** — A web-based IT management tool for LAN administrators.

## Features

- **Host Inventory** — Manage all Windows endpoints with real-time status, tags, groups, and per-host details
- **Windows Updates** — Scan, download, install, hide/unhide, and uninstall updates across the fleet
- **PsTools Integration** — Full PsTools suite (PsExec, PsInfo, PsList, PsKill, PsService, PsLoggedOn, PsShutdown, PsFile, PsGetSid, PsSuspend)
- **Remote Desktop** — VNC Viewer and RDP quick-connect from the host grid
- **Software Deployment** — Push MSI/EXE/PS1/BAT packages to remote hosts
- **Script Execution** — Run PowerShell/CMD/VBS scripts on remote hosts with output logging
- **Services & Processes** — View, start, stop, restart services; list and kill processes
- **Power Management** — Reboot, shutdown, Wake-on-LAN, availability monitoring
- **Job Queue** — Visual multi-step automation builder with 40+ step types including PsTools
- **Scheduler** — One-time, daily, weekly, monthly, and Patch Tuesday triggers
- **Audit Trail** — Every action logged with user, timestamp, targets, and parameters
- **Reports** — Patch history, deployment logs, compliance reports with CSV/JSON export
- **Encrypted Grid Files** — AES-256 encrypted .bps file export/import (like BatchPatch)
- **IP Scanner** — Ping sweep IP ranges and subnets to discover hosts
- **CSV Import Wizard** — Upload CSV with column mapping for bulk host import
- **Dark/Light Theme** — Toggle with `t` key
- **Keyboard Shortcuts** — Press `?` for full shortcut list
- **localStorage Persistence** — All state survives page refresh

## Architecture

```
Browser (Frontend) ←→ REST API ←→ Node.js Backend ←→ PsTools ←→ Remote Windows Hosts
```

- **Frontend**: Single-file HTML with React 18, Tailwind CSS, Lucide icons (via CDN)
- **Backend**: Node.js server that executes PsTools commands on remote Windows hosts
- **No WMI or PowerShell Remoting** — Uses PsTools exclusively

## Quick Start (Demo Mode)

1. Open `supporthublan.html` in Chrome or Edge
2. The app runs in Demo Mode with simulated actions — no backend needed

## Production Setup

### Prerequisites
- Windows admin PC with Node.js 14+
- PsTools downloaded from Microsoft Sysinternals
- Network access to target hosts
- Admin credentials for remote hosts

### Backend Server

```bash
cd supporthublan-server
npm install
npm start
```

Server starts on `http://localhost:3137`

### Connect Frontend to Backend

Add this line before the app script in `supporthublan.html`:
```html
<script>window.SUPPORTHUBLAN_API_URL = 'http://YOUR-ADMIN-PC:3137';</script>
```

Or configure in: Settings → Execution Adapters → Backend Server URL

## Files

| File | Description |
|---|---|
| `supporthublan.html` | Frontend — single-file React app (7,400+ lines) |
| `supporthublan-server/server.js` | Backend — Node.js server with 32 API endpoints |
| `supporthublan-server/package.json` | Backend dependencies |
| `supporthublan-server/README.md` | Detailed deployment guide |
| `supporthublan-server/api-client.js` | Standalone API client module |
| `FEATURE_PLAN.md` | Complete feature plan (317 features, all implemented) |

## License

Proprietary — All rights reserved.
