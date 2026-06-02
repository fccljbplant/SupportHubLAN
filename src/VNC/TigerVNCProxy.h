#ifndef TIGERVNCPROXY_H
#define TIGERVNCPROXY_H

#include "VNCViewerProxy.h"

// Forward declarations for TigerVNC types
class CConn;

class TigerVNCProxy : public VNCViewerProxy {
    Q_OBJECT
public:
    explicit TigerVNCProxy(QObject* parent = nullptr);
    ~TigerVNCProxy() override;

    bool connectToHost(const ConnectionProfile& profile) override;
    void disconnect() override;
    bool isConnected() const override;
    void sendChatMessage(const QString& message) override;
    void sendFile(const QString& localPath, const QString& remotePath) override;
    void receiveFile(const QString& remotePath, const QString& localPath) override;

private:
    CConn* m_conn = nullptr;
};

#endif
