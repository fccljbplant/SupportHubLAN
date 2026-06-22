# SupportHubLAN

> Windows endpoint administration web app for LAN admins — built as an open-source alternative to BatchPatch Pro.
> Uses **PsTools** for remote execution. No WMI, no PowerShell Remoting required on targets.

[![Live Demo](https://img.shields.io/badge/demo-GitHub%20Pages-blue)](https://fccljbplant.github.io/SupportHubLAN/supporthublan.html)
[![Backend](https://img.shields.io/badge/backend-Node.js%2018%2B-green)](#deployment)
[![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)](#prerequisites)
[![License](https://img.shields.io/badge/license-MIT-blue)](#license)

---

## Table of Contents
1. [What is SupportHubLAN?](#what-is-supporthublan)
2. [Quick Start (3 ways)](#quick-start-3-ways)
3. [How it works (Architecture)](#how-it-works-architecture)
4. [Deployment — Full setup on a Windows admin PC](#deployment--full-setup-on-a-windows-admin-pc)
5. [Can I use this over the internet?](#can-i-use-this-over-the-internet)
6. [Configuration reference (.env)](#configuration-reference-env)
7. [All settings explained](#all-settings-explained)
8. [Feature matrix — what's real vs demo](#feature-matrix--whats-real-vs-demo)
9. [Prerequisites checklist](#prerequisites-checklist)
10. [Troubleshooting](#troubleshooting)
11. [Security notes](#security-notes)
12. [Roadmap](#roadmap)
13. [License](#license)

---

## What is SupportHubLAN?

SupportHubLAN is a browser-based console for managing a fleet of Windows PCs on a LAN. You run a small Node.js backend on a Windows admin workstation (the "admin PC"); the backend talks to target PCs over SMB/RPC using Sysinternals **PsTools**. You point your browser at the backend and manage everything from there.

**What it does:**
- **Multi-inventory management** — create multiple named inventories (each = a tab above the grid); hosts, credentials, audit logs stored in **SQLite with AES-256-GCM encryption** for credential fields
- **Inventory population** — manual entry, CSV import with column mapping, IP/subnet scanner with parallel ping sweep, Active Directory import via `Get-ADComputer`
- **PsTools suite** — PsExec (remote shell), PsInfo, PsList, PsKill, PsService, PsLoggedOn, PsFile, PsGetSid, PsSuspend, PsShutdown — all 10 tools wired to real backend endpoints
- **Per-row inventory actions** — each host row has 3 compact action buttons: VNC/RDP connect (Monitor icon), remote command shell (TerminalSquare icon — runs `psexec \\host cmd`), PC event log viewer (FileText icon)
- **Remote desktop** — VNC (RealVNC/TightVNC/TigerVNC/UltraVNC auto-detected) or RDP (`mstsc.exe`) — configurable in Settings → Remote Desktop
- **Windows Updates** — scan, download, install via `PSWindowsUpdate` module; update history; WSUS settings
- **Software deployment** — MSI/EXE/PS1 installer deployment to selected hosts (`Copy-Item` + `Invoke-Command`); saved package library
- **Scripts & Commands** — saved PowerShell/CMD script library with quick-run; per-host execution via `Invoke-Command`
- **Services & Processes** — list/start/stop/restart services; list/kill processes on remote hosts
- **Power management** — reboot, shutdown, Wake-on-LAN (UDP magic packet)
- **Job Queue** — multi-step task sequences with 50+ step types, live WebSocket progress streaming
- **Scheduler** — schedule recurring jobs (daily/weekly/monthly)
- **Reports & Logs** — patch compliance, deployment history, audit trail
- **Audit log** — persistent in SQLite, every action logged with timestamp/user/result
- **LAPS** — retrieve and rotate Local Administrator Password Solution passwords (`ms-Mcs-AdmPwd` attribute)
- **Encrypted grid files** — export/import host grid as `.bps` files (AES-256-GCM via Web Crypto, password-protected)
- **VSCode-style terminal panel** — collapsible, resizable bottom panel with 4 tabs (All/Current/Errors/Terminal); type PsTools commands directly; live streams job progress + audit events
- **Multi-user features** — user accounts, roles (Admin/Operator/Read-Only/Remote Only), MFA, API keys
- **Notifications** — event-based alerts (job failed, host offline, etc.) with email/SMTP integration
- **Themes** — Dark/Light/System with working toggle (applyTheme modifies DOM, persists to localStorage, follows OS preference in System mode)

**What it does NOT do (by design):**
- It does not require PowerShell Remoting (WinRM) enabled on target hosts (uses PsTools/SMB instead)
- It does not require WMI RPC bindings beyond what PsTools already needs
- It does not install a persistent agent on target hosts (agentless)
- It does not work over the raw internet (see [Can I use this over the internet?](#can-i-use-this-over-the-internet))

---

## Quick Start (3 ways)

### Way 1 — Static demo (no install, just look at the UI)
Open the hosted demo in your browser:
> https://fccljbplant.github.io/SupportHubLAN/supporthublan.html

The UI is fully explorable. The status bar will say **DEMO MODE** — every action will be honestly rejected with a toast explaining that the backend is not connected. No fake "success" messages.

### Way 2 — Clone + open the HTML file locally
```powershell
git clone https://github.com/fccljbplant/SupportHubLAN.git
cd SupportHubLAN
start supporthublan.html
```
Same as Way 1 — DEMO MODE. Useful for evaluating the UI on a machine with no internet.

### Way 3 — Full deployment (real actions on real hosts)
See [Deployment](#deployment--full-setup-on-a-windows-admin-pc) below. ~15 minutes to set up.

---

## How it works (Architecture)

```
┌──────────────────────────────────────────────────────────────────┐
│ Your browser                                                       │
│  • supporthublan.html (React UI)                                   │
│  • Talks to backend via fetch() + WebSocket                        │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │ HTTP (port 8080) + WS /ws
                                  │ Same machine (or VPN)
┌─────────────────────────────────▼──────────────────────────────────┐
│ Windows Admin PC (the "backend")                                    │
│  • Node.js server (server.js) — single process, single port 8080   │
│  • Serves the frontend at /                                        │
│  • API at /api/*                                                    │
│  • Spawns PowerShell → PsTools                                      │
│  • Talks to AD via Get-ADComputer                                   │
└─────────────────────────────────┬──────────────────────────────────┘
                                  │ SMB (445), RPC (135), NetBIOS (137-138)
                                  │ Standard Windows admin ports
                  ┌───────────────┼───────────────┐
                  ▼               ▼               ▼
            ┌──────────┐    ┌──────────┐    ┌──────────┐
            │  PC-01   │    │  PC-02   │    │  PC-NN   │
            │ (target) │    │ (target) │    │ (target) │
            └──────────┘    └──────────┘    └──────────┘
```

**Key design decisions:**

| Decision | Why |
|---|---|
| Backend serves the frontend (single port 8080) | One firewall rule, no CORS issues, one URL to remember |
| All vendor JS bundled locally (`/vendor/`) | LAN deployments often have no internet — CDN would break the app |
| PsTools is the only remote-execution mechanism | No need to enable WinRM/PSRP on targets; PsExec uses SMB/admin$ |
| Backend is Windows-only | PsTools binaries are Windows-only — this is a hard constraint |
| `.bps` grid files use AES-256-GCM in the browser | No backend round-trip for save/open; password never leaves the browser |
| WebSocket at `/ws` for queue progress | Long-running jobs need live updates without polling |
| `Math.random()` demo fallbacks were removed | Honest "DEMO MODE" empty states instead of fake "online" hosts |
| Audit log writes moved into `.then()` callbacks | The audit log is now trustworthy as a compliance record |

### How can a browser HTML file execute server-side commands?

A browser is sandboxed — JavaScript in an HTML page **cannot** directly spawn processes or run PowerShell. SupportHubLAN uses the standard web app security model:

```
1. User clicks a button in the HTML (e.g. "PsInfo on PC-01")
       ↓
2. JavaScript in the browser calls:
       fetch('http://admin-pc:8080/api/pstools/psinfo', {
         method: 'POST',
         body: JSON.stringify({ hostname: 'PC-01' })
       })
       ↓
3. The Node.js backend (server.js) receives the HTTP POST.
   The browser DID NOT execute anything — it just sent an HTTP request.
       ↓
4. The backend (running on the admin PC, NOT in the browser) calls:
       spawn('powershell.exe', ['-Command', 'psinfo.exe \\PC-01 -accepteula'])
   This runs ON THE BACKEND MACHINE — using Node's child_process module.
       ↓
5. PsExec.exe on the backend talks to PC-01 over SMB (port 445)
   and RPC (port 135) — the same way an admin would run it manually.
       ↓
6. Output flows back:
   PC-01 → PsExec → PowerShell → Node.js → HTTP response → browser displays it
```

**The security boundary is at the backend, not the browser.** Anyone who can reach `http://your-admin-pc:8080` can trigger PsExec on any host the admin PC can reach. To secure this:

1. **Bind to localhost only** — set `BIND_ADDRESS=127.0.0.1` in `.env` (default is `0.0.0.0` for LAN convenience)
2. **Enable Basic Auth** — set `ADMIN_USER` and `ADMIN_PASS` in `.env`
3. **Never expose port 8080 to the internet** — use a VPN (Tailscale/WireGuard) for remote access
4. **Run the backend as a low-privilege service account** that is local admin only on target hosts (not Domain Admin)
5. **Audit log** — every API call is logged to SQLite with timestamp, action, parameters, and result

This is the same architecture used by every web-based RMM tool (Action1, NinjaRMM, ManageEngine, BatchPatch's web UI). The browser is just a UI; the security boundary is the backend's HTTP listener.

---

## Deployment — Full setup on a Windows admin PC

### Prerequisites

| Item | Why | Where to get it |
|---|---|---|
| Windows 10/11 Pro/Enterprise or Server 2019+ | PsTools is Windows-only | — |
| Node.js 18 LTS or newer | Run the backend | https://nodejs.org/ |
| PsTools suite | Remote execution (PsExec, PsInfo, etc.) | https://learn.microsoft.com/sysinternals/downloads/pstools |
| Network access to targets | TCP 445 (SMB), TCP 135 (RPC), UDP 137-138 (NetBIOS) | LAN firewall rules |
| Local admin on target hosts | PsExec requires admin$ share access | AD group membership |

**Optional modules** (only if you want those features):

| Module | For | Install |
|---|---|---|
| `PSWindowsUpdate` | Windows Updates scan/install | `Install-Module PSWindowsUpdate -Force -AllowClobber` |
| `ActiveDirectory` (RSAT) | AD import + LAPS | `Add-WindowsCapability -Online -Name Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0` |
| LAPS PowerShell module | LAPS rotation (legacy) | `Install-Module AdmPwd.PS -Force` (modern LAPS is built into Win 11 22H2+) |
| VNC viewer (any one) | VNC quick-launch | RealVNC / TightVNC / TigerVNC / UltraVNC |

### Step-by-step install

```powershell
# 1. Clone the repo
cd C:\
git clone https://github.com/fccljbplant/SupportHubLAN.git
cd SupportHubLAN

# 2. Install backend dependencies
cd supporthublan-server
npm install

# 3. Create your .env (optional — defaults work for localhost)
copy .env.example .env
notepad .env   # edit values if needed

# 4. Download PsTools (if you don't already have it)
#    Extract to C:\PSTools\ — make sure psexec.exe is there
#    Or: set PSTOOLS_PATH in .env to wherever you extracted it

# 5. Start the server
npm start
```

The server will start on **http://localhost:8080** and (on Windows) auto-open your browser.

You should see the status bar say **LIVE — Backend v1.2.0**. If it says **DEMO MODE**, click it to re-check, or check the server console for errors.

### One-click installer (Windows)

For non-technical admins, use the bundled installer:

```powershell
# Right-click install.bat → Run as administrator
.\install.bat
```

This will:
1. Check for Node.js (install if missing via winget)
2. Clone the repo to `C:\SupportHubLAN`
3. Run `npm install`
4. Create a desktop shortcut that runs `npm start`
5. Open the browser

After install, just double-click the desktop shortcut to launch.

### Run as a Windows service (auto-start on boot)

```powershell
# Install node-windows
cd C:\SupportHubLAN\supporthublan-server
npm install node-windows --save

# Create a service wrapper (one-time)
# Then:
node install-service.js
```

Or simpler — use Task Scheduler:
- Action: `node.exe`
- Arguments: `C:\SupportHubLAN\supporthublan-server\server.js`
- Trigger: At system startup
- Run as: a service account that is local admin on all target hosts

---

## Can I use this over the internet?

**Short answer: No, not directly. Use a VPN.**

### Why direct internet access doesn't work

SupportHubLAN relies on PsTools, which uses Windows SMB (port 445), RPC (port 135), and NetBIOS (UDP 137-138) to talk to target PCs. These ports are:

1. **Blocked by every consumer ISP** — both yours and the target's. Microsoft themselves block outbound 445 on Azure.
2. **Dangerous to expose** — SMB was the vector for WannaCry, EternalBlue, and countless ransomware outbreaks. Exposing 445 to the internet is one of the worst security decisions you can make.
3. **Not routable across NAT** without port forwarding, which would still hit #1 and #2.

### What DOES work for remote access

#### Option A — Site-to-site VPN (recommended)

Connect the admin PC and the target network via VPN. After that, SupportHubLAN works exactly as if everyone is on the same LAN.

- **Tailscale** (easiest, free for personal use) — https://tailscale.com/
- **WireGuard** (self-hosted, free) — https://www.wireguard.com/
- **OpenVPN** — https://openvpn.net/
- **Windows Always On VPN** (built-in, enterprise-grade)

After VPN is up:
1. Set `BIND_ADDRESS=0.0.0.0` in `.env` (already the default)
2. Optionally set `ADMIN_USER` and `ADMIN_PASS` for browser Basic Auth
3. From a remote admin's browser, navigate to `http://<admin-pc-vpn-ip>:8080`
4. The PsExec traffic goes from the admin PC, over the VPN tunnel, to the targets — never touching the public internet in clear-text

#### Option B — Cloud-hosted UI + on-prem relay agent (future roadmap)

This is how modern RMM tools (Action1, NinjaRMM, ManageEngine) work. The architecture would be:

```
Cloud UI (any browser)  ←→  Cloud relay (WebSocket)  ←→  On-prem agent (Windows service)  ←→  PsExec  ←→  Targets
```

**Status:** Not implemented in v1.2. Tracked in [Roadmap](#roadmap).

If you want this feature, please open an issue on GitHub describing your use case (number of remote sites, target OS versions, deployment constraints).

### What about RDP/VNC over the internet?

The VNC/RDP quick-launch button runs `vncviewer.exe` or `mstsc.exe` **on the admin PC**, connecting to the target's IP. For this to work over the internet:

- **RDP (port 3389)**: Should NOT be exposed to the internet. Use an RD Gateway server or VPN.
- **VNC (port 5900)**: Same — tunnel over SSH or VPN.

SupportHubLAN will not configure this for you — it just launches the viewer. You are responsible for the network path.

---

## Configuration reference (.env)

All settings live in `supporthublan-server/.env`. Copy `.env.example` to `.env` and edit.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | TCP port the backend listens on |
| `PSTOOLS_PATH` | `C:\\PSTools\\` | Folder containing `psexec.exe`, `psinfo.exe`, etc. Must have trailing backslash. |
| `BIND_ADDRESS` | `0.0.0.0` | Network interface to bind. Use `127.0.0.1` to restrict to localhost only. |
| `ADMIN_USER` | _(empty)_ | Optional Basic Auth username. If both ADMIN_USER and ADMIN_PASS are set, all `/api/*` calls require auth. |
| `ADMIN_PASS` | _(empty)_ | Optional Basic Auth password. Leave both blank to disable auth. |
| `ALLOWED_ORIGINS` | `*` | Comma-separated list of allowed CORS origins. Use specific origins like `https://admin.yourcorp.com` in production. |
| `AUTO_OPEN_BROWSER` | `true` | On Windows, auto-open the default browser to `http://localhost:PORT` on startup. |

### Example .env for typical LAN deployment

```ini
PORT=8080
PSTOOLS_PATH=C:\\PSTools\\
BIND_ADDRESS=0.0.0.0
ADMIN_USER=
ADMIN_PASS=
ALLOWED_ORIGINS=*
AUTO_OPEN_BROWSER=true
```

### Example .env for VPN-based remote access

```ini
PORT=8080
PSTOOLS_PATH=C:\\PSTools\\
BIND_ADDRESS=0.0.0.0
ADMIN_USER=lanadmin
ADMIN_PASS=use-a-long-random-password-here
ALLOWED_ORIGINS=https://admin.yourcorp.com,http://10.0.0.5:8080
AUTO_OPEN_BROWSER=false
```

---

## All settings explained

### Backend settings (`.env`)
See [Configuration reference](#configuration-reference-env) above.

### Frontend settings (in-app, persisted to localStorage)

Open the app → gear icon (top right) → **Settings**. Settings has 15 tabs:

| Tab | Purpose |
|---|---|
| **General** | App display name, timezone, density, session timeout, backend URL, theme & appearance (Dark/Light/System + accent colors), backend connection tester |
| **Appearance** | Theme mode (Dark/Light/System), table density, sidebar default, font size, keyboard shortcut tip |
| **PsTools** | PsTools folder path (override per-session), default timeout, suite documentation |
| **Remote Desktop** | Protocol selector (VNC / RDP), VNC viewer path override, default port (5900/3389), auto-detection of installed viewers (RealVNC/TightVNC/TigerVNC/UltraVNC) |
| **Active Directory** | Default domain, domain controller, search base (OU), search scope, name attribute, default filter, service account, auto-import on startup, "Test AD Connection" button |
| **Credentials** | Encrypted credential store (AES-256-GCM via SQLite) — domain creds, service accounts, local admin accounts |
| **LAPS** | AD domain, service account, password complexity/length/age/expiration, "Rotate Passwords Now" + "Retrieve Passwords" buttons (real backend calls) |
| **Inventories** | Multi-inventory management — create/rename/delete/activate inventories. Each inventory = one tab in Computer Inventory |
| **Notifications** | Event-based notifications (job failed, host offline, critical update pending, etc.) with frequency + recipients |
| **Email** | SMTP server config for email notifications |
| **Users & Roles** | User management — invite users, assign roles (Admin/Operator/Read-Only/Remote Only), MFA toggle |
| **Grid Protection** | Default encryption for `.bps` grid files (AES-256 whole-file / per-field / none), encryption key source (auto/password/custom), backup key export |
| **API Keys** | Generate/revoke API keys for programmatic access to the backend |
| **Retention** | Audit log retention (days), job log retention, report archive retention, automatic cleanup schedule |
| **Production Mode** | Connect frontend to a real backend server — configuration, status, switch from demo to production |

### Per-host settings (in inventory grid)

| Field | Purpose |
|---|---|
| Hostname | DNS name or NetBIOS name (required) |
| IP address | Used for VNC/RDP and ping |
| MAC address | Used for Wake-on-LAN |
| Site | Free-text label for grouping |
| Owner | Free-text label |
| Tags | Comma-separated tags for filtering |
| Notes | Free-text |

---

## Feature matrix — what's real vs demo

| Feature | Status | Notes |
|---|---|---|
| UI rendering, themes, keyboard shortcuts | ✅ Always works | Pure client-side |
| Settings persistence | ✅ Always works | localStorage |
| CSV import wizard | ✅ Always works | Browser-side parser |
| Encrypted `.bps` grid file export/import | ✅ Always works | AES-256-GCM via Web Crypto |
| Job Queue builder (UI) | ✅ Always works | Drag-and-drop step palette |
| Backend health detection | ✅ Always works | Polls `/api/health` |
| **PsExec remote shell** | ✅ Real | `POST /api/pstools/execute` |
| **PsInfo system info** | ✅ Real | `POST /api/pstools/psinfo` |
| **PsList running processes** | ✅ Real | `POST /api/pstools/pslist` |
| **PsKill process** | ✅ Real | `POST /api/pstools/pskill` |
| **PsService query/start/stop** | ✅ Real | `POST /api/pstools/psservice` |
| **PsLoggedOn users** | ✅ Real | `POST /api/pstools/psloggedon` |
| **PsFile open files** | ✅ Real | `POST /api/pstools/psfile` |
| **PsGetSid SID lookup** | ✅ Real | `POST /api/pstools/psgetsid` |
| **PsSuspend process** | ✅ Real | `POST /api/pstools/pssuspend` |
| **PsShutdown / Reboot** | ✅ Real | `POST /api/pstools/psshutdown` |
| **VNC viewer launch** | ✅ Real | `POST /api/remote/connect` → `spawn(vncviewer.exe)` |
| **RDP launch (mstsc)** | ✅ Real | `POST /api/remote/connect` → `spawn(mstsc.exe)` |
| **IP/subnet scanner** | ✅ Real | `POST /api/scan` → parallel `Test-Connection` runspace pool |
| **Active Directory import** | ✅ Real | `POST /api/hosts/discover-ad` → `Get-ADComputer` |
| **LAPS password retrieval** | ✅ Real | `POST /api/laps/retrieve` → reads `ms-Mcs-AdmPwd` |
| **LAPS password rotation** | ✅ Real | `POST /api/laps/rotate` → `Reset-LapsPassword` (modern) or `Set-ADComputer` (legacy) |
| **Windows Updates scan** | ✅ Real | `POST /api/updates/scan` → `PSWindowsUpdate` |
| **Windows Updates install** | ✅ Real | `POST /api/updates/install` → `Install-WindowsUpdate` |
| **Services list** | ✅ Real | `POST /api/services/:host/list` → `Get-CimInstance Win32_Service` |
| **Processes list** | ✅ Real | `POST /api/processes/:host/list` → `Get-CimInstance Win32_Process` |
| **Power actions (reboot/shutdown)** | ✅ Real | `POST /api/power/action` → `Restart-Computer` / `Stop-Computer` |
| **Wake-on-LAN** | ✅ Real | `POST /api/power/wol` → UDP magic packet broadcast |
| **Job Queue execution** | ✅ Real | `POST /api/queues/execute` → async with WebSocket progress |
| **Software deployment** | ✅ Real | `POST /api/deploy/package` → `Copy-Item` + `Invoke-Command` |
| **Script execution** | ✅ Real | `POST /api/scripts/execute` → `Invoke-Command` |
| **Audit log** | ✅ Honest | Entries written AFTER action resolves, with real `success`/`failed`/`skipped` |
| **Demo mode fallback** | ✅ Honest | DEMO MODE banner in status bar; action buttons show toast "backend not connected" — no fake success |

---

## Prerequisites checklist

Before you start, make sure:

- [ ] You have a Windows admin PC (Windows 10/11/Server 2019+)
- [ ] Node.js 18+ is installed (`node --version` should show v18 or higher)
- [ ] PsTools is extracted to `C:\PSTools\` (or you've set `PSTOOLS_PATH` in `.env`)
- [ ] The admin PC can ping target hosts (`ping pc-01.yourdomain.local`)
- [ ] The admin PC can access `\\pc-01\c$` in File Explorer (proves SMB/admin$ works)
- [ ] Your user account is a member of `Administrators` on the target hosts (or Domain Admins)
- [ ] (Optional) PSWindowsUpdate module installed on admin PC: `Install-Module PSWindowsUpdate -Force`
- [ ] (Optional) RSAT ActiveDirectory module installed: `Add-WindowsCapability -Online -Name Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0`
- [ ] (Optional) A VNC viewer installed if you want one-click VNC (RealVNC/TightVNC/TigerVNC/UltraVNC)
- [ ] (Optional) LAPS deployed in your AD if you want LAPS features
- [ ] Port 8080 is open in Windows Firewall on the admin PC (only needed if other admins will browse to it)

---

## Installing Required PowerShell Modules

### ActiveDirectory module (for AD Import feature)

The AD Import feature requires the RSAT ActiveDirectory PowerShell module on the **server machine** (the PC running SupportHubLAN). Install it as Administrator:

**Windows 10/11:**
```powershell
Add-WindowsCapability -Online -Name "Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0"
```

**Windows Server 2019/2022:**
```powershell
Install-WindowsFeature RSAT-AD-PowerShell
```

Verify installation:
```powershell
Get-Module -ListAvailable ActiveDirectory
```

After installation, restart the SupportHubLAN server.

### PSWindowsUpdate module (for Windows Updates feature)

The Windows Updates feature requires the PSWindowsUpdate module on each **target PC** (the PCs you want to scan/patch). Install it as Administrator on each target:

```powershell
Install-Module PSWindowsUpdate -Force -AllowClobber
```

For offline targets, download the module from PowerShell Gallery and copy it to:
```
C:\Program Files\WindowsPowerShell\Modules\PSWindowsUpdate\
```

---

## Troubleshooting

### Status bar says "DEMO MODE" instead of "LIVE"

1. Verify the backend is running (`npm start` should show the banner in the console)
2. Verify `http://localhost:8080/api/health` returns JSON in your browser
3. Click the DEMO MODE badge in the status bar — it will re-check the connection
4. If you're accessing from another machine, verify `BIND_ADDRESS=0.0.0.0` in `.env` and that Windows Firewall allows port 8080

### "Access denied" when running PsExec

You're not a local admin on the target. Fix:
```powershell
# On the target PC (or via GPO):
net localgroup Administrators YOURDOMAIN\lanadmin /add
```

Or use the `credential` parameter in the API call (set `username`/`password` in the API call body — the backend will construct a `PSCredential`).

### "Network path not found" / "The network path was not found"

SMB (port 445) is blocked. Fix:
```powershell
# On the target PC:
netsh advfirewall firewall set rule group="File and Printer Sharing" new enable=Yes
Enable-PSRemoting -SkipNetworkProfileCheck  # Also opens related ports
```

Or check that the target's `Server` service is running:
```powershell
Get-Service LanmanServer
Start-Service LanmanServer
```

### PsTools path not detected

The backend checks `C:\PSTools\psexec.exe` by default. If PsTools is elsewhere:
1. Edit `.env` → set `PSTOOLS_PATH=D:\\Tools\\PSTools\\` (with trailing backslash)
2. Restart the backend
3. Click the LIVE badge in the status bar — it will show whether `pstoolsInstalled` is true

### AD import returns 0 computers

1. Make sure RSAT ActiveDirectory is installed on the admin PC:
   ```powershell
   Get-Module -ListAvailable ActiveDirectory
   ```
   If empty: `Add-WindowsCapability -Online -Name Rsat.ActiveDirectory.DS-LDS.Tools~~~~0.0.1.0`
2. Make sure you're logged in as a domain user (not local account)
3. Try the equivalent PowerShell manually:
   ```powershell
   Get-ADComputer -Filter * -SearchBase "OU=Computers,DC=yourdomain,DC=local" | Measure-Object
   ```
   If that returns 0, the issue is your AD permissions, not SupportHubLAN.

### LAPS retrieval fails with "ms-Mcs-AdmPwd is empty"

The computer object doesn't have the LAPS attribute set. Either:
- LAPS isn't deployed on that host (run `gpupdate /force` after GPO applies)
- Your account doesn't have permission to read the password (delegate `Read ms-Mcs-AdmPwd` to your admin group)

### VNC button does nothing

1. Check the status bar — if it says DEMO MODE, no viewer will launch
2. In Settings → Remote Desktop, verify the VNC viewer path
3. The backend checks these paths in order: RealVNC, TightVNC, TigerVNC, UltraVNC. Install one if none are present
4. If using RDP instead, make sure `mstsc.exe` is on PATH (it should be — it's built into Windows)

### WebSocket not receiving queue progress

1. Make sure the URL is using the correct protocol (ws:// vs wss://)
2. Check browser console for WebSocket errors
3. The backend logs WebSocket connections — verify a connection was established when the page loaded
4. If you're behind a reverse proxy, make sure it upgrades WebSocket connections (nginx: `proxy_set_header Upgrade $http_upgrade;`)

### Browser shows "Babel is not defined"

The vendor files in `/vendor/` are missing. Either:
- You cloned the repo but `/vendor/` is empty — re-clone with `git clone --depth 1 https://github.com/fccljbplant/SupportHubLAN.git`
- Or the backend isn't serving `/vendor/*` — verify `vendor/` folder is one level above `supporthublan-server/` (i.e. at the repo root)

The HTML has CDN fallbacks that will load from unpkg.com if the local vendor files are missing — but this requires internet access.

---

## Security notes

### What's encrypted
- `.bps` grid files: AES-256-GCM with PBKDF2 key derivation (100,000 iterations, SHA-256). The password never leaves your browser.
- Credentials stored in the backend's `credentialStore`: **in-memory only**, lost on restart. For production, replace `credentialStore` with Windows Credential Manager (see `wincred` npm package).

### What's NOT encrypted
- HTTP traffic between browser and backend (use HTTPS via reverse proxy if you need TLS)
- WebSocket traffic (same as above)
- Logs in the backend console (may contain command output — secure your server room / event log access)

### Authentication
- By default, **no authentication** — anyone who can reach port 8080 can use SupportHubLAN
- For LAN-only deployments behind a firewall, this is often acceptable
- For VPN-based remote access, **always** set `ADMIN_USER` and `ADMIN_PASS` in `.env`
- For production with multiple users, put SupportHubLAN behind a reverse proxy (nginx/IIS) with proper auth (OIDC, SAML, etc.)

### Audit log integrity
- Audit log entries are written in the browser's localStorage
- The audit log is **not tamper-proof** — a user with browser dev tools can delete entries
- For compliance scenarios, configure your reverse proxy to log all `/api/*` calls to a central syslog/SIEM

### LAPS password handling
- Retrieved LAPS passwords are displayed in the Job Queue output panel
- They are also written to the audit log (in `parameters` and `output` fields)
- Treat both as sensitive — clear the audit log when done, and restrict access to the SupportHubLAN backend

---

## Roadmap

### Done in v1.2
- ✅ Real PsTools execution (all 10 tools wired to backend endpoints)
- ✅ Real AD import + LAPS retrieve/rotate
- ✅ Real network scanner (parallel ping sweep via runspace pool)
- ✅ Real Job Queue with WebSocket live progress
- ✅ Honest DEMO MODE (no fake success toasts; honest "backend not connected" warnings)
- ✅ Bundled vendor deps for offline LAN use (`/vendor/`)
- ✅ Backend serves frontend (single port 8080)

### Done in v1.3
- ✅ SQLite backend with AES-256-GCM encrypted credentials (`db.js`)
- ✅ Multi-inventory management (each inventory = a tab above the grid)
- ✅ VSCode-style bottom terminal panel with live logs + PsTools command input
- ✅ Settings restructured (General → Appearance → PsTools → Remote Desktop → AD → Credentials → LAPS → Inventories → Notifications → Email → Users → Grid Protection → API Keys → Retention → Production Mode)
- ✅ Working theme toggle (Dark/Light/System — applyTheme modifies DOM, persists, follows OS)
- ✅ Backend WebSocket supports `terminal-run` — spawn PsExec/ping/powershell, stream stdout/stderr

### Done in v1.4
- ✅ Resizable terminal panel (drag handle, default 3 lines / 80px, persists height)
- ✅ Removed accent color from theme (per user request)
- ✅ IP Scan button in toolbar opens scanner directly (skips method picker)
- ✅ DeployPackageModal — install MSI/EXE/PS1 on selected hosts, saved package library
- ✅ Fixed executePowerAction — was passing wrong shape to backend, now per-host iteration
- ✅ RunCommandModal — run PowerShell/CMD on selected hosts, saved command library
- ✅ Updates toolbar Install button wired to real `/api/updates/install`

### Done in v1.4.1
- ✅ PC Log button per inventory row (FileText icon) → opens PCLogModal
- ✅ New `/api/hosts/:hostname/eventlog` endpoint (Get-WinEvent, last 7 days, severity filter)
- ✅ Improved column chooser — pill-button format with On/Off/Locked badges, All/None/Reset quick actions

### Done in v1.4.2
- ✅ Inline right drawer (flexbox sibling, not position:fixed) — terminal no longer extends underneath
- ✅ Cmd button per inventory row (TerminalSquare icon) — opens terminal, auto-runs `psexec \\host cmd`
- ✅ Security architecture documented in README (browser sandbox vs backend execution)

### Done in v1.4.3 (current)
- ✅ Restored sidebar items that were wrongly removed (Deployments, Scripts, Services, Scheduler, Reports)
- ✅ Restored Settings tabs (Appearance, Notifications, Email, Users & Roles, API Keys, Production Mode)
- ✅ Appearance tab now uses working applyTheme (Dark/Light/System buttons)
- ✅ README audited and rewritten to reflect actual feature set

### Planned for v1.5
- 🔲 HTTPS with auto self-signed cert generation (for VPN-based remote access)
- 🔲 Multi-user auth via OIDC (Authelia/Authentik integration)
- 🔲 Host grouping (folders/tags in sidebar)
- 🔲 Saved filter views
- 🔲 Export audit log to CSV/SIEM
- 🔲 SQLite hosts ↔ React state sync (currently uses localStorage in DEMO mode)

### Planned for v2.0 (cloud relay mode)
- 🔲 Optional cloud-hosted UI at `app.supporthublan.io`
- 🔲 On-prem relay agent (Windows service) that phones home via WebSocket
- 🔲 No inbound ports needed on the LAN
- 🔲 Agent executes PsTools locally — same security model, but works for distributed sites without VPN
- 🔲 This is a significant architectural addition — no ETA yet

### Help wanted
If you'd like to contribute, open issues at https://github.com/fccljbplant/SupportHubLAN/issues. Particularly needed:
- Testing on Windows Server 2022/2025
- Testing with large AD forests (1000+ computer objects)
- Localization (i18n) — currently English-only
- Dark/light theme polish

---

## License

MIT License. See [LICENSE](LICENSE).

PsTools is licensed separately by Microsoft Sysinternals — see https://learn.microsoft.com/sysinternals/license
