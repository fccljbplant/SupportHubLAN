#ifndef ULTRAVNCPROXY_H
#define ULTRAVNCPROXY_H

#include "VNCViewerProxy.h"

// Forward declarations for UltraVNC types (defined in upstream headers)
class ClientContext;

class UltraVNCProxy : public VNCViewerProxy {
    Q_OBJECT
public:
    explicit UltraVNCProxy(QObject* parent = nullptr);
    ~UltraVNCProxy() override;

    bool connectToHost(const ConnectionProfile& profile) override;
    void disconnect() override;
    bool isConnected() const override;
    void sendChatMessage(const QString& message) override;
    void sendFile(const QString& localPath, const QString& remotePath) override;
    void receiveFile(const QString& remotePath, const QString& localPath) override;

private:
    ClientContext* m_client = nullptr;
    void* m_upstreamHandle = nullptr; // Opaque handle to UltraVNC viewer instance
};

#endif
