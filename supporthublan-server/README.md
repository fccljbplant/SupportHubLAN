# SupportHubLAN — Complete Deployment Guide

## Architecture

SupportHubLAN consists of two components:

1. **Frontend** (`supporthublan-pro.html`) — A single-file React/Tailwind web app that runs in any browser. Provides the full UI for managing Windows endpoints.

2. **Backend** (`supporthublan-server/`) — A Node.js server that runs on a Windows admin machine and performs REAL Windows administration tasks via PowerShell, backend queries, and the PSWindowsUpdate module.

```
Browser (Frontend) ←→ REST API ←→ Node.js Server (Backend) ←→ PowerShell/backend queries ←→ Remote Windows Hosts
```

## When to use Demo Mode vs Real Mode

- **Demo Mode** (default): When you open `supporthublan-pro.html` directly in a browser (no backend running). All actions are simulated — jobs are created with fake progress, host states flip based on timers, no real PowerShell is executed. Perfect for demos, evaluation, and UI testing.

- **Real Mode**: When the backend server is running and the frontend is configured to connect to it. All actions perform REAL operations on remote Windows hosts — actual backend queries queries, real update scanning/installation, real reboots, real script execution.

## Setup — Backend Server (Real Mode)

### Prerequisites

1. **Windows machine** with admin privileges (the "admin PC")
   - Windows 10/11 Pro/Enterprise or Windows Server 2016+
   - This machine must have network access to all target hosts

2. **Node.js 14+** installed
   - Download from https://nodejs.org/

3. **PowerShell 5.1+** (built into Windows 10/11/Server)

4. **PSWindowsUpdate module** (for Windows Update operations)
   ```powershell
   # Run PowerShell as Administrator
   Install-Module PSWindowsUpdate -Force -AllowClobber
   Import-Module PSWindowsUpdate
   ```

5. **network connectivity enabled on target hosts** (for remote PowerShell execution)
   ```powershell
   # On each target host, run as Administrator:
   Enable-PSRemoting -Force
   winrm quickconfig
   # Or via Group Policy for fleet-wide deployment
   ```

6. **Admin credentials** for target hosts
   - Domain admin account, OR
   - Local admin account on each target host

### Installation

1. Copy the `supporthublan-server/` folder to your admin PC (e.g., `C:\SupportHubLAN\server\`)

2. Open Command Prompt or PowerShell:
   ```cmd
   cd C:\SupportHubLAN\server
   npm install
   ```

3. Start the server:
   ```cmd
   npm start
   ```

4. The server will start on `http://localhost:3137`

### Connecting the Frontend

**Option A: Open the HTML file with backend URL configured**

Add this line BEFORE the app script in `supporthublan-pro.html`:
```html
<script>window.SUPPORTHUBLAN_API_URL = 'http://YOUR-ADMIN-PC:3137';</script>
```

Then open the HTML file in Chrome/Edge.

**Option B: Serve both from the backend**

Copy `supporthublan-pro.html` into the `supporthublan-server/public/` folder and modify the server to serve it:
```javascript
// Add to server.js:
app.use(express.static('public'));
```

Then open `http://YOUR-ADMIN-PC:3137/supporthublan-pro.html` in your browser.

### Verifying the Connection

When the frontend connects to the backend successfully:
- The status bar will show "Backend: Connected" 
- All actions will perform real operations
- Host info will come from real backend queries queries
- Update scans will use the real PSWindowsUpdate module

When the backend is NOT available:
- The app automatically falls back to Demo Mode
- All actions are simulated
- A "Demo Mode" indicator appears

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Health check — verify backend is running |
| `/api/hosts/:hostname/info` | POST | Get real system info via backend queries (OS, CPU, RAM, disk, uptime) |
| `/api/hosts/:hostname/ping` | POST | Ping a host to check if online |
| `/api/updates/scan` | POST | Scan for available Windows Updates (PSWindowsUpdate) |
| `/api/updates/download` | POST | Download updates on remote hosts |
| `/api/updates/install` | POST | Install updates on remote hosts (with optional reboot) |
| `/api/updates/history` | POST | Get update installation history |
| `/api/scripts/execute` | POST | Execute PowerShell script on remote hosts (Invoke-Command) |
| `/api/deployments/run` | POST | Copy + execute installer on remote hosts |
| `/api/deployments/copy` | POST | Copy files/folders to remote hosts |
| `/api/services/:hostname/list` | POST | List services on remote host (backend queries) |
| `/api/services/:hostname/action` | POST | Start/Stop/Restart service on remote host |
| `/api/processes/:hostname/list` | POST | List processes on remote host (backend queries) |
| `/api/processes/:hostname/kill` | POST | Kill process on remote host |
| `/api/power/action` | POST | Reboot/Shutdown remote hosts (Restart-Computer/Stop-Computer) |
| `/api/power/wol` | POST | Send Wake-on-LAN magic packets |
| `/api/power/check-pending` | POST | Check if reboot is pending on remote hosts |
| `/api/queues/execute` | POST | Execute job queue (sequential step engine) |
| `/api/credentials` | GET/POST | Store/retrieve credentials |
| `/ws` | WebSocket | Real-time job progress updates |

## Security Notes

1. **The backend server has NO authentication** — it's designed for internal network use only. Do NOT expose it to the internet without adding authentication (e.g., API keys, Windows Authentication, or a reverse proxy with auth).

2. **Credentials are stored in memory** — in production, use Windows Credential Manager or an encrypted vault (e.g., Azure Key Vault, AWS Secrets Manager).

3. **network connectivity communication is encrypted** by default when using Kerberos authentication in a domain environment. For workgroup environments, configure network connectivity with HTTPS or use IPSec.

4. **The PSWindowsUpdate module** requires the module to be installed on the admin PC (not necessarily on each target host — it can operate remotely).

## Troubleshooting

### "Access Denied" when connecting to remote hosts
- Ensure network connectivity is enabled on targets: `Enable-PSRemoting -Force`
- Ensure the admin PC is in the "Administrators" group on target hosts
- For workgroup hosts: `Set-Item WSMan:\localhost\Client\TrustedHosts -Value "*" -Force`
- Test connectivity: `Enter-PSSession -ComputerName TARGET -Credential DOMAIN\admin`

### PSWindowsUpdate not found
```powershell
Install-Module PSWindowsUpdate -Force -AllowClobber
# If execution policy blocks:
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Backend not reachable from browser
- Check Windows Firewall allows port 3137
- Try `http://localhost:3137/api/health` in browser
- Check the server console for errors

### Frontend shows "Demo Mode"
- The frontend couldn't reach the backend
- Verify `SUPPORTHUBLAN_API_URL` is set correctly
- Check that the backend is running
- Check browser console for CORS errors (the backend has CORS enabled)
