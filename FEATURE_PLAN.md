# SupportHubLAN — Complete Feature Implementation Plan

This document tracks all features implemented in SupportHubLAN, organized by module. Each feature is marked with its current status and implementation notes.

## Status Legend
- ✅ DONE — Fully implemented and functional
- 🔶 PARTIAL — Implemented but needs polish or has limitations
- 🔲 PLANNED — Designed but not yet implemented

---

## Module 1: Computer Inventory

| Feature | Status | Notes |
|---|---|---|
| Manual host entry (single) | ✅ DONE | Hostname, IP, MAC, FQDN, OS, site, owner, department, tags, notes |
| Bulk paste import | ✅ DONE | Comma/tab/newline separated |
| CSV file import with column mapping | ✅ DONE | Auto-detect columns, manual mapping, preview |
| IP range/subnet scanner | ✅ DONE | CIDR + range + comma-separated; parallel ping sweep |
| Active Directory import | ✅ DONE | Get-ADComputer with OU path, search scope, filter, name attribute |
| Multi-inventory (tabs) | ✅ DONE | Encrypted JSON-backed; create/rename/delete/activate |
| Host CRUD | ✅ DONE | Add, edit, delete, bulk upsert |
| Encrypted data storage | ✅ DONE | AES-256-GCM on entire data file + per-field credential encryption |
| Per-row actions | ✅ DONE | VNC/RDP connect, remote cmd shell (PsExec), PC event log viewer |
| Right-click context menu | ✅ DONE | 15+ actions via PsTools |
| Column chooser | ✅ DONE | Show/hide columns, locked columns, All/None/Reset |
| LED status indicators | ✅ DONE | Color-coded online/patch state |
| Row coloring | ✅ DONE | 6 colors for visual grouping |
| CSV export | ✅ DONE | Full inventory or selected hosts |

## Module 2: Windows Updates

| Feature | Status | Notes |
|---|---|---|
| Scan for updates | ✅ DONE | Via PsExec + PSWindowsUpdate module on remote host |
| Download updates | ✅ DONE | Via PsExec + Get-WindowsUpdate -Download |
| Install all updates | ✅ DONE | Via PsExec + Install-WindowsUpdate -AcceptAll |
| Install by KB | ✅ DONE | KBArticleID filter |
| Update history | ✅ DONE | Via PsExec + Get-WUHistory |
| Hide/unhide updates | 🔲 PLANNED | Backend endpoint not yet implemented |
| Compliance reporting | 🔶 PARTIAL | Uses local state, not real scan results |

## Module 3: Software Deployment

| Feature | Status | Notes |
|---|---|---|
| Deploy MSI/EXE/PS1 | ✅ DONE | Copy-Item to \\host\C$\Temp + psexec execution |
| Copy files/folders | ✅ DONE | POST /api/deploy/copy via SMB Copy-Item |
| Saved package library | ✅ DONE | localStorage-backed |
| Deployment templates | ✅ DONE | 8 pre-built templates |

## Module 4: Scripts & Commands

| Feature | Status | Notes |
|---|---|---|
| Execute PowerShell on remote hosts | ✅ DONE | Via PsExec + powershell -EncodedCommand |
| Execute CMD on remote hosts | ✅ DONE | Via PsExec + cmd /c |
| Saved command library | ✅ DONE | localStorage-backed |
| Quick examples | ✅ DONE | 6 pre-built examples |
| Per-host output display | ✅ DONE | Output parsed and shown per-host |

## Module 5: Services

| Feature | Status | Notes |
|---|---|---|
| List services on remote host | ✅ DONE | Via psservice.exe \\host query |
| Start service | ✅ DONE | Via psservice.exe \\host start |
| Stop service | ✅ DONE | Via psservice.exe \\host stop |
| Restart service | ✅ DONE | Via psservice.exe (stop + start) |
| Service search/filter | ✅ DONE | Real-time filter by name/display name |
| PC list → click → services | ✅ DONE | 2-column layout, no tabs |

## Module 6: Power Management

| Feature | Status | Notes |
|---|---|---|
| Reboot | ✅ DONE | Via psshutdown.exe \\host -r |
| Shutdown | ✅ DONE | Via psshutdown.exe \\host -s |
| Wake-on-LAN | ✅ DONE | UDP magic packet broadcast |
| Check pending reboot | ✅ DONE | Via PsExec + registry check |
| Confirmation dialog | ✅ DONE | For reboot/shutdown |
| PC list → click → power options | ✅ DONE | 2-column layout, no tabs |

## Module 7: PsTools Suite (All 10 Tools)

| Tool | Status | Usage |
|---|---|---|
| PsExec | ✅ DONE | Remote command execution, remote shell |
| PsInfo | ✅ DONE | System information query |
| PsList | ✅ DONE | Process listing |
| PsKill | ✅ DONE | Process termination |
| PsService | ✅ DONE | Service management |
| PsLoggedOn | ✅ DONE | Logged-on user query |
| PsFile | ✅ DONE | Open files query |
| PsGetSid | ✅ DONE | SID resolution |
| PsSuspend | ✅ DONE | Process suspend/resume |
| PsShutdown | ✅ DONE | Remote reboot/shutdown |

## Module 8: Job Queue

| Feature | Status | Notes |
|---|---|---|
| Queue builder (step palette) | ✅ DONE | 11 step types, reorder, per-step config |
| Execute queue | ✅ DONE | POST /api/queues/execute |
| Live WebSocket progress | ✅ DONE | Per-step, per-host progress streaming |
| Save as template | ✅ DONE | Persisted to localStorage |
| Error handling modes | ✅ DONE | Stop on error / Continue on error |
| Target host selector | ✅ DONE | All/None/Online-only quick actions |

## Module 9: Remote Desktop

| Feature | Status | Notes |
|---|---|---|
| VNC launch | ✅ DONE | Auto-detects RealVNC/TightVNC/TigerVNC/UltraVNC |
| RDP launch | ✅ DONE | Via mstsc.exe |
| Protocol selection | ✅ DONE | In Settings → Remote Desktop |
| Per-row connect button | ✅ DONE | Monitor icon in inventory grid |

## Module 10: LAPS

| Feature | Status | Notes |
|---|---|---|
| Retrieve LAPS password | ✅ DONE | Via Get-ADComputer -Properties ms-Mcs-AdmPwd |
| Rotate LAPS password | ✅ DONE | Via Reset-LapsPassword (modern) or Set-ADComputer (legacy) |

## Module 11: Terminal Panel

| Feature | Status | Notes |
|---|---|---|
| Interactive PsTools command input | ✅ DONE | Type psexec, psinfo, pslist, etc. |
| Live stdout/stderr streaming | ✅ DONE | Via WebSocket |
| Command history | ✅ DONE | Up/Down arrows |
| Tab filtering (All/Current/Errors/Terminal) | ✅ DONE | |
| Resizable panel | ✅ DONE | Drag handle, 60px–40% viewport |
| Collapsible | ✅ DONE | Persists to localStorage |
| Per-row "open terminal" button | ✅ DONE | Auto-runs psexec \\host cmd |

## Module 12: Audit Log

| Feature | Status | Notes |
|---|---|---|
| Persistent audit log | ✅ DONE | Encrypted JSON storage |
| Every action logged | ✅ DONE | Timestamp, user, action, result, parameters |
| Search | ✅ DONE | Full-text search |
| Filter by result | ✅ DONE | Success/Failed/Skipped |
| Pagination | ✅ DONE | 50 per page |
| Clear all / clear by age | ✅ DONE | olderThanDays support |

## Module 13: Settings

| Tab | Status | Notes |
|---|---|---|
| General | ✅ DONE | Theme, timezone, density, backend URL, connection tester |
| Appearance | ✅ DONE | Dark/Light/System theme, density, font |
| PsTools | ✅ DONE | Path configuration, timeout |
| Remote Desktop | ✅ DONE | VNC/RDP protocol, viewer path, port |
| Active Directory | ✅ DONE | Domain, DC, OU, search scope, filter, test connection |
| Credentials | ✅ DONE | Encrypted credential store (AES-256-GCM) |
| LAPS | ✅ DONE | AD domain, service account, rotate/retrieve |
| Inventories | ✅ DONE | Multi-inventory CRUD |
| Notifications | 🔶 PARTIAL | Local state only, no backend engine |
| Email | 🔲 PLANNED | No SMTP backend |
| Users & Roles | 🔲 PLANNED | Single-user auth only |
| API Keys | 🔲 PLANNED | No API key middleware |
| Retention | 🔶 PARTIAL | Form only, no cleanup job |
| Production Mode | ✅ DONE | Backend connection status |

## Module 14: Authentication

| Feature | Status | Notes |
|---|---|---|
| Single username/password login | ✅ DONE | ADMIN_USER/ADMIN_PASS in .env |
| Session tokens | ✅ DONE | In-memory Set, 32-byte random |
| Token persistence | ✅ DONE | localStorage |
| Auth middleware | ✅ DONE | Protects all /api/* when credentials set |
| Login disabled (dev mode) | ✅ DONE | LOGIN_DISABLED flag |
| Logout | ✅ DONE | Token removal from session store |

## Module 15: Theme System

| Feature | Status | Notes |
|---|---|---|
| Dark theme | ✅ DONE | Default for dark mode users |
| Light theme | ✅ DONE | Full color support, no black-on-black |
| System theme | ✅ DONE | Follows OS preference (default) |
| Theme toggle | ✅ DONE | Header dropdown + Settings |
| Theme-aware terminal | ✅ DONE | Uses CSS variables, not hardcoded colors |

## Module 16: Backend & Storage

| Feature | Status | Notes |
|---|---|---|
| Encrypted JSON storage | ✅ DONE | AES-256-GCM, PBKDF2 key derivation |
| No native dependencies | ✅ DONE | Pure JS (express, cors, body-parser, ws only) |
| Backend serves frontend | ✅ DONE | Single port 8080 |
| WebSocket for real-time | ✅ DONE | Job progress, terminal output, scan results |
| Token-based auth | ✅ DONE | Session tokens, auth middleware |
| .env configuration | ✅ DONE | PORT, PSTOOLS_PATH, ADMIN_USER, ADMIN_PASS, etc. |
| Portable Node.js support | ✅ DONE | No system install required |

## Module 17: Installation & Distribution

| Feature | Status | Notes |
|---|---|---|
| install-supporthublan.bat | ✅ DONE | Downloads Node.js + code + PsTools + npm install |
| build-installer.bat | ✅ DONE | Builds SupportHubLAN-Setup.exe via IExpress |
| start-supporthublan.bat | ✅ DONE | Launcher script |
| Desktop shortcut | ✅ DONE | Created by installer |
| Start Menu entry | ✅ DONE | Created by installer |
| Uninstaller | ✅ DONE | Preserves data files |
