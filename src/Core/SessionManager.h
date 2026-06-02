#ifndef SESSIONMANAGER_H
#define SESSIONMANAGER_H

#include <QObject>
#include <QMap>
#include <QUuid>
#include "Session.h"

class SessionManager : public QObject {
    Q_OBJECT
public:
    static SessionManager* instance();

    Session* createSession(const ConnectionProfile& profile);
    void closeSession(const QUuid& id);
    Session* session(const QUuid& id) const;
    QList<Session*> activeSessions() const;

signals:
    void sessionCreated(Session* session);
    void sessionClosed(const QUuid& id);

private:
    explicit SessionManager(QObject* parent = nullptr);
    QMap<QUuid, Session*> m_sessions;
    static SessionManager* s_instance;
};

#endif
