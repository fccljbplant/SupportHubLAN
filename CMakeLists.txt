cmake_minimum_required(VERSION 3.16)
project(SupportHubLAN VERSION 1.0.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_AUTOMOC ON)
set(CMAKE_AUTORCC ON)
set(CMAKE_AUTOUIC ON)

find_package(Qt6 REQUIRED COMPONENTS Core Gui Widgets Network)
find_package(OpenSSL REQUIRED)

set(SOURCES
    src/main.cpp
    src/Core/ConnectionProfile.cpp
    src/Core/ConnectionManager.cpp
    src/Core/Session.cpp
    src/Core/SessionManager.cpp
    src/Core/SettingsManager.cpp
    src/Core/Logger.cpp
    src/Core/EncryptionUtils.cpp
    src/UI/MainWindow.cpp
    src/UI/DashboardWidget.cpp
    src/UI/SessionTabWidget.cpp
    src/UI/ConnectionCard.cpp
    src/UI/QuickConnectWidget.cpp
    src/UI/RecentSessionsWidget.cpp
    src/UI/SidebarWidget.cpp
    src/UI/SessionView.cpp
    src/UI/RemoteDesktopWidget.cpp
    src/UI/SidePanel.cpp
    src/UI/ChatWidget.cpp
    src/UI/FileTransferWidget.cpp
    src/UI/ToolbarWidget.cpp
    src/VNC/VNCViewerProxy.cpp
    src/VNC/UltraVNCProxy.cpp
    src/VNC/TigerVNCProxy.cpp
)

set(HEADERS
    src/Core/ConnectionProfile.h
    src/Core/ConnectionManager.h
    src/Core/Session.h
    src/Core/SessionManager.h
    src/Core/SettingsManager.h
    src/Core/Logger.h
    src/Core/EncryptionUtils.h
    src/UI/MainWindow.h
    src/UI/DashboardWidget.h
    src/UI/SessionTabWidget.h
    src/UI/ConnectionCard.h
    src/UI/QuickConnectWidget.h
    src/UI/RecentSessionsWidget.h
    src/UI/SidebarWidget.h
    src/UI/SessionView.h
    src/UI/RemoteDesktopWidget.h
    src/UI/SidePanel.h
    src/UI/ChatWidget.h
    src/UI/FileTransferWidget.h
    src/UI/ToolbarWidget.h
    src/VNC/VNCViewerProxy.h
    src/VNC/UltraVNCProxy.h
    src/VNC/TigerVNCProxy.h
)

qt_add_resources(RESOURCES resources/resources.qrc)

add_executable(SupportHubLAN WIN32 ${SOURCES} ${HEADERS} ${RESOURCES})

target_include_directories(SupportHubLAN PRIVATE
    ${CMAKE_SOURCE_DIR}/ThirdParty/UltraVNC
    ${CMAKE_SOURCE_DIR}/ThirdParty/TigerVNC
    src
)

target_link_libraries(SupportHubLAN PRIVATE
    Qt6::Core
    Qt6::Gui
    Qt6::Widgets
    Qt6::Network
    OpenSSL::SSL
    OpenSSL::Crypto
)
