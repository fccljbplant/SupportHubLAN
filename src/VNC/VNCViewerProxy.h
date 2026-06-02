#ifndef VNCVIEWERPROXY_H
#define VNCVIEWERPROXY_H

#include <QObject>
#include <QString>
#include "../Core/ConnectionProfile.h"

class VNCViewerProxy : public QObject {
    Q_OBJECT
public:
    explicit VNCViewerProxy(QObject* parent = nullptr);
    virtual ~VNCViewerProxy() = default;

    virtual bool connectToHost(const ConnectionProfile& profile) = 0;
    virtual void disconnect() = 0;
    virtual bool isConnected() const = 0;
    virtual void sendChatMessage(const QString& message) = 0;
    virtual void sendFile(const QString& localPath, const QString& remotePath) = 0;
    virtual void receiveFile(const QString& remotePath, const QString& localPath) = 0;

signals:
    void connected();
    void disconnected();
    void connectionError(const QString& error);
    void frameBufferUpdated(const QImage& frame);
    void chatMessageReceived(const QString& sender, const QString& message);
    void fileTransferProgress(const QString& filename, int percent);
    void fileTransferComplete(const QString& filename, bool success);

protected:
    bool m_connected = false;
};

#endif
