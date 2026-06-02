# SupportHub LAN

Professional cross-platform remote support viewer for LAN environments.
Built on top of UltraVNC (Windows) and TigerVNC (Linux) with a modern Qt6 UI.

## Features

- Remote Desktop Access (UltraVNC / TigerVNC engine)
- Multi-Session Tab Management
- Saved Connections with AES-encrypted passwords
- Favorites & Recent Sessions
- Per-Session Chat & File Transfer (presentation layer over VNC engines)
- Dark modern UI matching support workflow

## Prerequisites

- Windows 10/11
- Qt 6.5+ (MSVC 2019/2022)
- CMake 3.16+
- OpenSSL 3.x
- Visual Studio 2022 (Community or higher)

## Build Instructions

```bash
# 1. Clone with submodules (UltraVNC / TigerVNC source)
git clone --recursive https://github.com/fccljbplant/SupportHubLAN.git
cd SupportHubLAN

# 2. Place UltraVNC source in ThirdParty/UltraVNC
# 3. Place TigerVNC source in ThirdParty/TigerVNC

# 4. Configure
cmake -B build -S . -DCMAKE_PREFIX_PATH="C:/Qt/6.6.2/msvc2019_64"

# 5. Build
cmake --build build --config Release

# 6. Run
./build/Release/SupportHubLAN.exe
```

## Project Structure

```
SupportHubLAN/
├── CMakeLists.txt
├── src/
│   ├── Core/          # Data models, JSON persistence, encryption, logging
│   ├── UI/            # Qt Widgets (Dashboard, SessionView, Chat, Files)
│   └── VNC/           # Proxies wrapping UltraVNC / TigerVNC viewers
├── ThirdParty/
│   ├── UltraVNC/      # Upstream UltraVNC viewer source
│   └── TigerVNC/      # Upstream TigerVNC viewer source
└── resources/         # Icons, stylesheets, fonts
```

## Upstream-First Policy

SupportHub does not modify RFB protocol handling, frame buffer processing, or
authentication logic. All remote desktop engine code remains in the upstream
projects. SupportHub only provides the UX, session management, and branding layer.

## License

SupportHub UI layer: MIT License
UltraVNC / TigerVNC: Respective upstream licenses (GPLv2)
