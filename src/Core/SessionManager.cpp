#include "SessionManager.h"

SessionManager* SessionManager::s_instance = nullptr;

SessionManager* SessionManager::instance() {
    if (!s_instance) s_instance = new SessionManager();
    return s_instance;
}

SessionManager::SessionManager(QObject* parent) : QObject(parent) {}

Session* SessionManager::createSession(const ConnectionProfile& profile) {
    Session* s = new Session(profile, this);
    m_sessions[s->id()] = s;
    emit sessionCreated(s);
    return s;
}

void SessionManager::closeSession(const QUuid& id) {
    if (m_sessions.contains(id)) {
        m_sessions[id]->deleteLater();
        m_sessions.remove(id);
        emit sessionClosed(id);
    }
}

Session* SessionManager::session(const QUuid& id) const {
    return m_sessions.value(id, nullptr);
}

QList<Session*> SessionManager::activeSessions() const {
    return m_sessions.values();
}
