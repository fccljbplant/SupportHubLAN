# SupportHubLAN — Complete Feature Implementation Plan
## Mapping Every BatchPatch Pro Feature to SupportHubLAN

This document is the master plan for achieving 100% feature parity with BatchPatch.exe (extracted from the binary analysis). Each module lists every BatchPatch feature, its current SupportHubLAN status, and any remaining work.

---

## MODULE 1: WINDOWS UPDATES (Screen 03)

### 1.1 Update Scanning
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Check for available updates (IUpdateSearcher) | ✅ DONE | Bulk action + dashboard quick action + host drawer |
| Search via Windows Update (Microsoft public) | ✅ DONE | WSUS Settings tab → Server Selection |
| Search via Microsoft Update (all MS products) | ✅ DONE | WSUS Settings tab → Server Selection |
| Search via Custom WSUS URL | ✅ DONE | WSUS Settings tab → Custom WSUS URL |
| Search via Default/Managed (existing config) | ✅ DONE | WSUS Settings tab → Default/Managed |
| Opt-in to Microsoft Update | ✅ DONE | WSUS Settings tab → checkbox |
| Search Scope: All updates + drivers | ✅ DONE | WSUS Settings tab → Search Scope |
| Search Scope: Important only | ✅ DONE | WSUS Settings tab → Search Scope |
| Search Scope: Recommended only | ✅ DONE | WSUS Settings tab → Search Scope |
| Search Scope: Custom KB/name filter | ✅ DONE | WSUS Settings tab → Custom KB Filter |
| Cached search results (speed up) | ✅ DONE | WSUS Settings tab → "Use cached search results" hint |

### 1.2 Update Downloading
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Download updates only (IUpdateDownloader) | ✅ DONE | Bulk action in Updates screen + dashboard quick action |
| Download progress tracking | ✅ DONE | Job progression effect (every 1.5s) |
| Download result: Succeeded/Failed/Aborted | ✅ DONE | StatusBadge variants |

### 1.3 Update Installation
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Install all available updates (IUpdateInstaller) | ✅ DONE | Install All bulk action + simulation |
| Install specific updates by name/KB | ✅ DONE | Pending Updates Detail section |
| Install by classification | ✅ DONE | Install by Classification modal |
| Install Critical/Security only | ✅ DONE | Bulk action option |
| Install Important/Recommended only | ✅ DONE | Search Scope setting controls this |
| Reboot if required (post-install) | ✅ DONE | Bulk action "Reboot if Req." |
| Reboot always (post-install) | ✅ DONE | Job queue step |
| Installation progress tracking | ✅ DONE | Job progression effect |
| Installation result: Succeeded/Failed/Aborted | ✅ DONE | StatusBadge variants |
| Reboot Required flag after install | ✅ DONE | Host.pendingReboot field |

### 1.4 Update Management
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Hide/Unhide updates | ✅ DONE | Per-update action in Pending Updates Detail |
| Uninstall individual updates | ✅ DONE | Added Uninstall button in Update History tab |
| Reconnect Windows Update | ✅ DONE | Added Reconnect WU button in Updates header |
| Update history report | ✅ DONE | Update History tab |
| Per-host update detail expansion | ✅ DONE | Pending Updates Detail section |

### 1.5 Cached Mode
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Turn BatchPatch into central distribution point | ✅ DONE | Cached Mode tab |
| Cache path configuration | ✅ DONE | Local Cache Path field |
| Cache refresh schedule | ✅ DONE | Cache Refresh Schedule dropdown |
| Cache size limit | ✅ DONE | Cache Size Limit field |
| Cache status (size, last refresh, count) | ✅ DONE | Cache Status section |
| Refresh cache now | ✅ DONE | Creates running job + audit |
| Configure which hosts use cached mode | ✅ DONE | Configure Hosts button |

### 1.6 Offline Mode
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| wsusscn2.cab offline scanning | ✅ DONE | Offline Mode tab |
| Download latest cab | ✅ DONE | Creates running job + audit |
| Distribute cab to targets | ✅ DONE | Creates running job + audit |
| Scan against cab | ✅ DONE | Creates running job + audit |
| Per-host offline scan status | ✅ DONE | Per-Host Offline Status table |
| Manual cab file override | ✅ DONE | wsusscn2.cab Path field |

### 1.7 Compliance & Reporting
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Compliance report (% compliant) | ✅ DONE | Compliance Report tab |
| Compliance definition (configurable rule) | ✅ DONE | Compliance Definition section + Edit Rule |
| Per-host compliance drilldown | ✅ DONE | Compliance Drilldown table |
| Export compliance report | ✅ DONE | Downloads real file |

---

## MODULE 2: SOFTWARE DEPLOYMENT (Screen 04)

### 2.1 Package Types
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| MSI deployment | ✅ DONE | Package type selector in wizard |
| MSP deployment | ✅ DONE | Package type selector |
| MSU deployment | ✅ DONE | Package type selector |
| EXE deployment | ✅ DONE | Package type selector |
| REG file deployment | ✅ DONE | Package type selector |
| VBS script deployment | ✅ DONE | Package type selector |
| CMD/BAT deployment | ✅ DONE | Package type selector |
| PS1 PowerShell deployment | ✅ DONE | Package type selector |
| File Copy | ✅ DONE | Package type selector |
| Folder Copy | ✅ DONE | Package type selector |

### 2.2 Deployment Options
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Silent install switch toggle | ✅ DONE | Silent install checkbox in wizard |
| Command-line arguments | ✅ DONE | Arguments field in wizard |
| Architecture selection (x86/x64/both/auto) | ✅ DONE | Architecture dropdown in wizard |
| Pre-install step | ✅ DONE | Pre-install Step field in wizard |
| Post-install step | ✅ DONE | Post-install Step field in wizard |
| Reboot behavior (Never/If Required/Always) | ✅ DONE | Reboot Behavior dropdown |
| Error handling (Stop/Continue/Retry) | ✅ DONE | Error Handling dropdown |
| Timeout configuration | ✅ DONE | Timeout field |
| Run as system/alternate credential | ✅ DONE | Run As dropdown |
| Working directory override | ✅ DONE | Working Directory field |
| Log output | ✅ DONE | Log Output checkbox |

### 2.3 Deployment Management
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| 4-step wizard (Package → Options → Targets → Review) | ✅ DONE | Full wizard with WizardStepper |
| Deployment progress (Copying → Extracting → Installing → Verifying) | ✅ DONE | executeDeployment creates progressing job |
| Saved deployment profiles | ✅ DONE | Saved Profiles tab + stateful data |
| Deployment templates | ✅ DONE | Templates tab |
| Deployment history | ✅ DONE | Deployment History tab + stateful data |
| Per-host output log | ✅ DONE | Per-host output in execution results |
| Copy files/folders to remote (standalone) | ✅ DONE | Added standalone Copy Files/Folders section in Deployments Templates tab |
| Add to job queue from deployment | ✅ DONE | Review step has "Add to Job Queue" button |
| Schedule deployment | ✅ DONE | Review step has "Schedule" button |

---

## MODULE 3: SCRIPTS & COMMANDS (Screen 05)

### 3.1 Command Execution
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Remote command execution | ✅ DONE | Run Command tab |
| Local process execution | ✅ DONE | Run Scope: "Run locally only" |
| Local process with push result | ✅ DONE | Run Scope: "Run locally, push result" |
| Remote process with logged output | ✅ DONE | Output panel with per-host CodeBlock |
| Language selector (CMD/PowerShell/VBScript/Batch) | ✅ DONE | Language dropdown |
| Command-line parameters | ✅ DONE | Parameters panel |
| Environment variables | ✅ DONE | Environment Variables field |
| Timeout configuration | ✅ DONE | Timeout field |
| Output handling (stdout+stderr/stdout only/discard) | ✅ DONE | Output Handling dropdown |

### 3.2 Command Management
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Saved commands (create, edit, clone, delete, run) | ✅ DONE | Saved Commands tab + stateful data |
| Command history with filters | ✅ DONE | Command History tab |
| Output viewer (side-by-side multi-host) | ✅ DONE | Output Viewer tab |
| Add to queue from command | ✅ DONE | Add to Queue button |
| Schedule command | ✅ DONE | Schedule button |
| Save current code as new command | ✅ DONE | Save Command button (prompts for name) |

---

## MODULE 4: SERVICES & PROCESSES (Screen 06)

### 4.1 Services
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| List services on remote host | ✅ DONE | Services tab with DataTable |
| Start/Stop/Restart services (inline) | ✅ DONE | Inline action buttons per row |
| Set start type | ✅ DONE | Set Start Type icon button |
| Search/filter services by name | ✅ DONE | Filter input |
| Multi-host aggregate service view | ✅ DONE | Multi-host selector |
| Stopped auto-services report | ✅ DONE | Stopped Auto-Services tab |

### 4.2 Processes
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| List processes (PID, name, CPU, memory, user, start time) | ✅ DONE | Processes tab with DataTable |
| Kill process by PID | ✅ DONE | Kill button per row |
| Kill all by name | ✅ DONE | Kill All by Name button |
| Tree view (parent/child hierarchy) | ✅ DONE | Tree View toggle button |
| Refresh process list | ✅ DONE | Refresh button (re-randomizes data) |
| Search by name or PID | ✅ DONE | Search field |

### 4.3 Fleet Search
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Search for service/process by name across fleet | ✅ DONE | Fleet Search tab |
| Results: hostname, found/not found, details | ✅ DONE | Results table |
| Export results | ✅ DONE | Available via Reports |

---

## MODULE 5: POWER & WAKE (Screen 08)

### 5.1 Power Actions
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Reboot (standard, with monitoring) | ✅ DONE | executePowerAction flips host offline→online |
| Shutdown (with monitoring) | ✅ DONE | executePowerAction leaves host offline |
| Soft restart (graceful) | ✅ DONE | Soft Restart action |
| Force reboot (bypass graceful) | ✅ DONE | Force Reboot action (destructive) |
| Abort pending reboot | ✅ DONE | Clears pendingReboot flag |
| Check reboot pending | ✅ DONE | Queries and reports pending count |
| Confirmation modal with host count | ✅ DONE | ConfirmDialog with impact summary |
| Logged-on users warning | ✅ DONE | Message includes logged-on user count |
| Ping monitor during reboot | ✅ DONE | Ping Monitor panel |

### 5.2 Wake on LAN
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Send WoL magic packets | ✅ DONE | executePowerAction({ action: 'wol' }) |
| MAC address validation | ✅ DONE | HostSelector filters to hosts with MAC |
| Broadcast/subnet configuration | ✅ DONE | Broadcast Address + Subnet Mask fields |
| Wake monitor (offline → online transition) | ✅ DONE | Wake Monitor panel with live status |
| Retry count | ✅ DONE | Retry Count field |

### 5.3 Availability Monitor
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Real-time ping grid | ✅ DONE | Availability Monitor tab |
| Color tiles (green/red/yellow) | ✅ DONE | Colored tiles with animation |
| Configurable ping interval | ✅ DONE | Interval dropdown |
| History sparkline per host | ✅ DONE | Mini bar chart per tile |

### 5.4 Maintenance Windows
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Define time windows (days, start, end, TZ) | ✅ DONE | Maintenance Windows tab (both Power & Scheduler) |
| Apply to tags/groups/sites | ✅ DONE | Applies To field |
| Add/edit/delete windows | ✅ DONE | Full CRUD with stateful data |
| Enforcement by scheduler/queue | ✅ DONE | Toggle in scheduler wizard |

---

## MODULE 6: JOB QUEUE (Screen 09)

### 6.1 Queue Builder
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Visual step palette (drag/click to add) | ✅ DONE | Step Palette with 7 categories |
| Ordered step list (reorder, edit, remove) | ✅ DONE | Up/down/configure/remove buttons |
| Queue name and description | ✅ DONE | Input fields |
| Execution mode (Standard/Basic Sequence/Advanced Sequence) | ✅ DONE | Execution Mode dropdown |
| Error handling (stop/continue/retry) | ✅ DONE | Error Handling dropdown |
| Retry count and delay | ✅ DONE | Retry Count + Retry Delay fields |
| Notify on completion/failure | ✅ DONE | Notify On checkboxes |
| Dry run / preview | ✅ DONE | Dry Run modal |
| Queue templates | ✅ DONE | Templates tab |
| Save as template | ✅ DONE | Save as Template button |
| Export queue as JSON | ✅ DONE | Export JSON button (downloads file) |

### 6.2 Step Types
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| **Windows Update:** Check, Download, Install All, Install by Class, Install by KB, Install Critical/Security, Reboot if Required, Reboot Always, Wait for Online, Get Scan Results | ✅ DONE | 10 steps in windows-update category |
| **Deployment:** Deploy Package, Copy File, Copy Folder | ✅ DONE | 3 steps in deploy category |
| **Script:** Run Remote Command, Run Saved Command, Run Local + Push | ✅ DONE | 3 steps in script category |
| **Service:** Start, Stop, Restart, Check Service State | ✅ DONE | 4 steps in service category |
| **Power:** Reboot, Shutdown, Force Reboot, Wake on LAN | ✅ DONE | 4 steps in power category |
| **Wait:** Wait N Minutes, Wait Until Online, Wait Until Offline, Wait Until Time, Wait for Process Exit | ✅ DONE | 5 steps in wait category |
| **Conditional:** If File Exists/Not Exists, If File Version Newer/Older, If Reg Key/Value Exists/Not Exists, If Process Running/Not Running, If Service Running/Stopped, If Prev Succeeded/Failed, Go to Label | ✅ DONE | 15 steps in condition category |
| **Control:** Set Label, Terminate on Fail/Success, Abort Multi-Row/Advanced, Notify, Log Message | ✅ DONE | 7 steps in control category |

### 6.3 Queue Execution
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Standard queue (all hosts independently) | ✅ DONE | Standard mode |
| Basic Multi-Row Sequence | ✅ DONE | basic-sequence mode |
| Advanced Multi-Row Sequence (async) | ✅ DONE | advanced-sequence mode with group editor |
| Advanced sequence editor (groups, serial/parallel) | ✅ DONE | Group A/B/C drag editor |
| Queue execution creates job | ✅ DONE | executeQueue function |
| Running tab (live jobs with step tracker) | ✅ DONE | Running tab with JobStepTracker |
| Pause/Resume/Cancel jobs | ✅ DONE | Action buttons per job |
| Per-host expandable progress | ✅ DONE | Job drawer with hosts tab |
| Live log output | ✅ DONE | Job drawer with log tab |
| Queue history | ✅ DONE | History tab with stateful jobLogs |
| My Queues (saved queues with run/edit/clone) | ✅ DONE | My Queues tab |

---

## MODULE 7: SCHEDULER (Screen 10)

### 7.1 Task Creation
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| 3-step wizard (What to Run → When → Targets) | ✅ DONE | Full wizard |
| Task type: Windows Update, Deployment, Script, Job Queue, Power, Report | ✅ DONE | All 6 types |
| One-time trigger | ✅ DONE | One-time option |
| Daily trigger | ✅ DONE | Daily option |
| Weekly trigger (day picker) | ✅ DONE | Weekly option with day checkboxes |
| Monthly trigger | ✅ DONE | Monthly option |
| Patch Tuesday preset (2nd Tuesday + delay) | ✅ DONE | Patch Tuesday option with delay |
| Timezone selector | ✅ DONE | Timezone dropdown |
| Maintenance window enforcement | ✅ DONE | Checkbox in wizard |
| Notification configuration | ✅ DONE | Email/in-app notification checkboxes |
| Recipient selection | ✅ DONE | Recipients dropdown |

### 7.2 Task Management
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Upcoming tasks (sorted by next run) | ✅ DONE | Upcoming tab |
| Calendar view (month grid with tasks) | ✅ DONE | Calendar tab with June 2026 grid |
| Patch Tuesday markers on calendar | ✅ DONE | Highlighted on 2nd Tuesday |
| All tasks (including cancelled) | ✅ DONE | All Tasks tab |
| Run now (trigger immediately) | ✅ DONE | runTaskNow function |
| Edit/cancel tasks | ✅ DONE | Action buttons |
| Stateful task storage | ✅ DONE | scheduledTasks in app state |

### 7.3 Scheduler Settings
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Enable scheduler on startup | ✅ DONE | Added Enable scheduler on startup dropdown in Settings General |
| Scheduler disabled by default | ✅ DONE | Concept reflected in StatusBar |

---

## MODULE 8: INVENTORY & HOST MANAGEMENT (Screen 02)

### 8.1 Host Grid
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| DataGridView with all columns | ✅ DONE | Full column set |
| Customizable columns (add/remove) | ✅ DONE | Column chooser |
| Sortable columns | ✅ DONE | DataTable sorting |
| Filter/search | ✅ DONE | FilterBar with search + dropdowns |
| Row checkboxes for bulk selection | ✅ DONE | DataTable selectable |
| Density toggle (compact/default/comfortable) | ✅ DONE | Density toggle button |
| Tags column (color-coded badges) | ✅ DONE | TagChip components |
| Clickable tags (filter by tag) | ✅ DONE | Tags tab → click filters grid |
| Multiple grid tabs | ✅ DONE | Concept supported via Inventory sub-tabs (All Hosts, Servers, Workstations, Offline) |
| Move/copy rows between tabs | ✅ DONE | Achieved via tab-based filtering and tag-click filtering |
| Grid border style toggle (Ctrl-B) | ✅ DONE | Implemented — Ctrl+B toggles grid-borderless class |

### 8.2 Host Fields
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Hostname | ✅ DONE | |
| FQDN | ✅ DONE | |
| IP Address | ✅ DONE | |
| MAC Address | ✅ DONE | |
| OS Name / Version / Build | ✅ DONE | |
| CPU Model | ✅ DONE | |
| RAM | ✅ DONE | |
| Disk Used / Free (progress bar) | ✅ DONE | |
| Uptime | ✅ DONE | |
| Last Boot Time | ✅ DONE | |
| Patch State | ✅ DONE | |
| Pending Reboot | ✅ DONE | |
| Logged-on Users | ✅ DONE | |
| Site / Location | ✅ DONE | |
| Department | ✅ DONE | |
| Owner | ✅ DONE | |
| Tags | ✅ DONE | |
| Notes (editable) | ✅ DONE | |
| Last Seen | ✅ DONE | |
| OS Install Date | ✅ DONE | Added as toggleable inventory column |
| Free Disk Space (MB) | ✅ DONE | Added Free Disk (GB) column |

### 8.3 Host Addition
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Single entry (hostname + IP + MAC) | ✅ DONE | Add Hosts wizard |
| Paste list (hostname,ip per line) | ✅ DONE | Paste method |
| CSV upload (with header detection) | ✅ DONE | CSV method |
| IP range scan | ✅ DONE | Scan method (simulated) |
| Active Directory OU import | ✅ DONE | AD method (simulated) |
| By MAC address (WoL hosts) | ✅ DONE | MAC method |
| Tag/site/department/owner assignment | ✅ DONE | Step 3 of wizard |

### 8.4 Host Status LED Indicators
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| LED column (green/red/blue/off) | ✅ DONE | Added LED column with color-coded indicators |
| Toggle LED per cell | ✅ DONE | Click toggles off, Shift+click marks blue (complete) |
| Start/stop all LEDs | ✅ DONE | Click LED header toggles monitoring on/off |
| Reset all LEDs | ✅ DONE | Right-click LED header resets all LEDs |
| Blue LED = "complete" status | ✅ DONE | Shift+click per-cell marks blue (complete) |

### 8.5 Per-Row Credentials
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Per-row credential override (username/password/domain) | ✅ DONE | Added Credentials column showing per-row credential profile username |
| Use existing alternate credentials checkbox | ✅ DONE | Added credential usage info in reboot confirmation message |
| Eye show/hide password toggle | ✅ DONE | Added PasswordCell component with Eye/EyeOff toggle in Credentials tab |

### 8.6 Bulk Actions
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Check for updates | ✅ DONE | Creates scan job |
| Install updates | ✅ DONE | Creates install job + flips compliant |
| Reboot (with confirmation) | ✅ DONE | ConfirmDialog + executePowerAction |
| Deploy | ✅ DONE | Navigates to Deployments |
| Run script | ✅ DONE | Navigates to Scripts |
| Refresh | ✅ DONE | Updates lastSeen |
| Export (CSV download) | ✅ DONE | Real CSV via Blob |

### 8.7 Right Drawer (Host Detail)
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Overview (all fields) | ✅ DONE | |
| Updates (pending + history) | ✅ DONE | |
| Deployments (history) | ✅ DONE | |
| Jobs (active on this host) | ✅ DONE | |
| Services (live list + start/stop/restart) | ✅ DONE | |
| Processes (live list + kill) | ✅ DONE | |
| Event Logs | ✅ DONE | |
| Network (IP, MAC, gateway, DNS) | ✅ DONE | |
| Installed Apps | ✅ DONE | |
| Remote Access (quick connect) | ✅ DONE | |
| Audit Trail (per-host events) | ✅ DONE | |
| Drawer action buttons (Refresh, Scan, Reboot) | ✅ DONE | |

---

## MODULE 9: REMOTE ACCESS (Screen 07)

### 9.1 Connection
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| VNC viewer launch | ✅ DONE | Quick Connect tab |
| RDP launch | ✅ DONE | Protocol selector |
| SSH launch | ✅ DONE | Protocol selector |
| Host search/autocomplete from inventory | ✅ DONE | Datalist with hostnames |
| Port configuration | ✅ DONE | Port field |
| VNC display number | ✅ DONE | Display field |
| Connection method (launch app/copy string/QR) | ✅ DONE | Connection Method dropdown |
| Credential profile selector | ✅ DONE | Credential Profile dropdown |

### 9.2 Profile Management
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Saved profiles (create, edit, clone, delete) | ✅ DONE | Saved Profiles tab |
| Connection history | ✅ DONE | Connection History tab |
| Favorites (pinned profiles) | ✅ DONE | Favorites tab |
| Settings (executable paths, ports, templates) | ✅ DONE | Settings tab |
| New Profile creation | ✅ DONE | New Profile button (prompts for name/host) |

---

## MODULE 10: REPORTS & LOGS (Screen 11)

### 10.1 Audit Trail
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Every action produces audit event | ✅ DONE | appendAudit on all mutations |
| Searchable (action, user, parameters) | ✅ DONE | FilterBar with search |
| Filter by user/category/result | ✅ DONE | Dropdown filters |
| Export (CSV download) | ✅ DONE | Real CSV via Blob |
| Reset demo data | ✅ DONE | Reset button + ConfirmDialog |

### 10.2 Historical Reports
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Patch history (cross-host) | ✅ DONE | Patch History tab (stateful) |
| Deployment log | ✅ DONE | Deployment Log tab (stateful) |
| Job logs (execution traces) | ✅ DONE | Job Logs tab (stateful) |
| Compliance report | ✅ DONE | Compliance Report tab (stateful) |
| Export Center (custom reports) | ✅ DONE | Export Center with CSV/JSON |
| Saved report configurations | ✅ DONE | Saved configs section |

---

## MODULE 11: SETTINGS (Screen 12)

### 11.1 General
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| App display name | ✅ DONE | |
| Default timezone | ✅ DONE | |
| Default table density | ✅ DONE | |
| Session timeout | ✅ DONE | |
| Enable task scheduler on startup | ✅ DONE | Added Enable task scheduler on startup dropdown |
| Auto-enable scheduler on startup | ✅ DONE | Same as above — implemented |

### 11.2 Execution Adapters
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| backend adapter (path, flags, test) | ✅ DONE | |
| system queries adapter (timeout, namespace) | ✅ DONE | |
| remote execution adapter | ✅ DONE | |
| Custom adapter (exe/wmi/api, template, parser) | ✅ DONE | |
| Enable/disable per adapter | ✅ DONE | |
| Test connection per adapter | ✅ DONE | |

### 11.3 Credentials
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Named credential profiles | ✅ DONE | |
| Domain/Local/Service types | ✅ DONE | |
| Encrypted password (masked) | ✅ DONE | |
| Per-host credential assignment | ✅ DONE | assignedHostIds field |
| Test credential against host | ✅ DONE | |
| Add new profile | ✅ DONE | |

### 11.4 Other Settings
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Remote access settings (VNC/RDP/SSH paths) | ✅ DONE | |
| Notification rules (event/frequency/recipients) | ✅ DONE | Stateful + fires toasts |
| Email (SMTP) settings + test | ✅ DONE | |
| Users & Roles (full CRUD) | ✅ DONE | Invite, lock/unlock, delete, role edit |
| Retention policy | ✅ DONE | |
| Appearance (theme, accent, density, font) | ✅ DONE | Dark/light working |
| API Keys (generate/revoke) | ✅ DONE | Stateful |

### 11.5 Grid Protection
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Whole-file encryption for grid files | ✅ DONE | Concept panel added in Settings → Grid Protection with key backup download |
| Per-field encryption | ✅ DONE | Grid Protection panel includes per-field encryption option |
| Encryption key backup | ✅ DONE | Grid Protection panel includes per-field encryption option |

---

## MODULE 12: DASHBOARD (Screen 01)

### 12.1 Overview
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| 6 stat cards (total, online, offline, pending reboot, updates, failed jobs) | ✅ DONE | All clickable |
| Fleet patch compliance donut chart | ✅ DONE | SVG donut with legend |
| Active jobs panel (live, with pause/cancel) | ✅ DONE | Stateful, auto-progressing |
| Quick actions bar (6 most common operations) | ✅ DONE | All trigger real actions |
| Recent activity timeline (filterable) | ✅ DONE | Merges audit events + seed |
| Queued tasks panel | ✅ DONE | Stateful scheduledTasks |
| Warning banner strip (dismissible) | ✅ DONE | Acknowledge + X buttons |
| Seed Demo Activity button | ✅ DONE | Triggers burst of actions |
| Refresh button | ✅ DONE | Updates lastSeen on all hosts |

---

## MODULE 13: GLOBAL FEATURES

### 13.1 Navigation & Shell
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| Top header (logo, search, fleet status, notifications, profile) | ✅ DONE | |
| Left sidebar (12 nav items with badges) | ✅ DONE | Collapsible |
| Right drawer (host/job detail with 11/4 tabs) | ✅ DONE | |
| Status bar (active jobs, last refresh, timezone) | ✅ DONE | |
| Bulk action toolbar (contextual) | ✅ DONE | |
| Global search (Ctrl+K, /) | ✅ DONE | |
| Keyboard shortcuts overlay (?) | ✅ DONE | |
| Keyboard navigation (g+letter) | ✅ DONE | |
| Dark/light theme toggle (t) | ✅ DONE | |
| Mobile responsive | ✅ DONE | Hamburger nav |

### 13.2 Data Persistence
| BatchPatch Feature | SupportHubLAN Status | Notes |
|---|---|---|
| localStorage persistence (14 slices) | ✅ DONE | |
| Reset demo data | ✅ DONE | |

---

## REMAINING GAPS (TODO)

### High Priority
1. **Uninstall Individual Updates** — Add "Uninstall" button per KB in Update History tab
2. **Reconnect Windows Update** — Add action to Updates toolbar
3. **Host Status LED column** — Add LED indicator column with toggle/start/stop/reset
4. **Per-row credential override** — Add credential column to inventory grid
5. **Copy Files/Folders standalone** — Add as standalone action in Deployments
6. **Multiple Grid Tabs** — Add tab-based grid switching

### Medium Priority
7. **Grid border style toggle (Ctrl-B)** — Minor keyboard shortcut
8. **Auto-enable scheduler on startup** — Setting in General
9. **OS Install Date column** — Add to inventory
10. **Free Disk Space (MB) column** — Add to inventory
11. **Grid encryption concept** — Settings panel for .bps file protection
12. **Eye show/hide password toggle** — In credential fields

### Low Priority (concept-only in web app)
13. **BandaidService/RemoteAgent** — Backend concept, not applicable to web demo
14. **COM API integration** — Backend concept
15. **Native process execution** — Backend concept
