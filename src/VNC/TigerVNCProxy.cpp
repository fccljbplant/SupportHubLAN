#include "TigerVNCProxy.h"
#include "../Core/Logger.h"

// NOTE: TigerVNC headers are included from ThirdParty/TigerVNC
// The actual integration requires linking against TigerVNC viewer library
// (vncviewer/CConn) and implementing the RFB client callbacks.

TigerVNCProxy::TigerVNCProxy(QObject* parent) : VNCViewerProxy(parent) {}

TigerVNCProxy::~TigerVNCProxy() {
    disconnect();
}

bool TigerVNCProxy::connectToHost(const ConnectionProfile& profile) {
    Logger::instance()->info("TigerVNC", QString("Connecting to %1:%2").arg(profile.ipAddress()).arg(profile.port()));

    // TODO: Initialize TigerVNC CConn with profile settings
    // TODO: Set up RFB connection via rfb::CConnection
    // TODO: Wire framebuffer callback to render in RemoteDesktopWidget

    // Placeholder: simulate successful connection for UI development
    m_connected = true;
    emit connected();
    return true;
}

void TigerVNCProxy::disconnect() {
    if (m_connected) {
        // TODO: Tear down TigerVNC CConn
        m_connected = false;
        emit disconnected();
        Logger::instance()->info("TigerVNC", "Disconnected");
    }
}

bool TigerVNCProxy::isConnected() const {
    return m_connected;
}

void TigerVNCProxy::sendChatMessage(const QString& message) {
    if (!m_connected) return;
    // TODO: TigerVNC does not have built-in chat; may need tunneling or extension
    Logger::instance()->info("TigerVNC", QString("Chat sent: %1").arg(message));
}

void TigerVNCProxy::sendFile(const QString& localPath, const QString& remotePath) {
    if (!m_connected) return;
    // TODO: TigerVNC file transfer via TightVNC extension or external scp
    Logger::instance()->info("TigerVNC", QString("File send: %1 -> %2").arg(localPath, remotePath));
}

void TigerVNCProxy::receiveFile(const QString& remotePath, const QString& localPath) {
    if (!m_connected) return;
    // TODO: TigerVNC file transfer
    Logger::instance()->info("TigerVNC", QString("File receive: %1 -> %2").arg(remotePath, localPath));
}
