#ifndef SESSION_H
#define SESSION_H

#include <QObject>
#include <QDateTime>
#include <QUuid>
#include <QString>
#include "ConnectionProfile.h"

enum class SessionStatus { Connecting, Connected, Disconnected, Error };

class Session : public QObject {
    Q_OBJECT
public:
    explicit Session(const ConnectionProfile& profile, QObject* parent = nullptr);

    QUuid id() const { return m_id; }
    QString displayName() const { return m_profile.name(); }
    QString ipAddress() const { return m_profile.ipAddress(); }
    int port() const { return m_profile.port(); }
    PlatformType platform() const { return m_profile.platform(); }
    SessionStatus status() const { return m_status; }
    QDateTime startTime() const { return m_startTime; }
    int durationSeconds() const;
    ConnectionProfile profile() const { return m_profile; }

    void setStatus(SessionStatus s);
    void setError(const QString& msg);
    QString errorString() const { return m_error; }

signals:
    void statusChanged(SessionStatus status);
    void durationUpdated(int seconds);

private:
    QUuid m_id;
    ConnectionProfile m_profile;
    SessionStatus m_status;
    QDateTime m_startTime;
    QString m_error;
};

#endif
