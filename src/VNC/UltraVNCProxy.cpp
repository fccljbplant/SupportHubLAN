#include "UltraVNCProxy.h"
#include "../Core/Logger.h"

// NOTE: UltraVNC headers are included from ThirdParty/UltraVNC
// The actual integration requires linking against UltraVNC viewer library
// and implementing the RFB client callbacks. This is a wrapper scaffold.

UltraVNCProxy::UltraVNCProxy(QObject* parent) : VNCViewerProxy(parent) {}

UltraVNCProxy::~UltraVNCProxy() {
    disconnect();
}

bool UltraVNCProxy::connectToHost(const ConnectionProfile& profile) {
    Logger::instance()->info("UltraVNC", QString("Connecting to %1:%2").arg(profile.ipAddress()).arg(profile.port()));

    // TODO: Initialize UltraVNC ClientContext with profile settings
    // TODO: Set up RFB connection, authentication, and framebuffer callback
    // TODO: Wire chat and file transfer hooks to UltraVNC's existing engines

    // Placeholder: simulate successful connection for UI development
    m_connected = true;
    emit connected();
    return true;
}

void UltraVNCProxy::disconnect() {
    if (m_connected) {
        // TODO: Tear down UltraVNC client context
        m_connected = false;
        emit disconnected();
        Logger::instance()->info("UltraVNC", "Disconnected");
    }
}

bool UltraVNCProxy::isConnected() const {
    return m_connected;
}

void UltraVNCProxy::sendChatMessage(const QString& message) {
    if (!m_connected) return;
    // TODO: Route to UltraVNC chat engine (TextChat.cpp / DSMPlugin)
    Logger::instance()->info("UltraVNC", QString("Chat sent: %1").arg(message));
}

void UltraVNCProxy::sendFile(const QString& localPath, const QString& remotePath) {
    if (!m_connected) return;
    // TODO: Route to UltraVNC file transfer (FileTransfer.cpp)
    Logger::instance()->info("UltraVNC", QString("File send: %1 -> %2").arg(localPath, remotePath));
}

void UltraVNCProxy::receiveFile(const QString& remotePath, const QString& localPath) {
    if (!m_connected) return;
    // TODO: Route to UltraVNC file transfer
    Logger::instance()->info("UltraVNC", QString("File receive: %1 -> %2").arg(remotePath, localPath));
}
