#include "Session.h"

Session::Session(const ConnectionProfile& profile, QObject* parent)
    : QObject(parent), m_id(QUuid::createUuid()), m_profile(profile),
      m_status(SessionStatus::Connecting), m_startTime(QDateTime::currentDateTime()) {}

void Session::setStatus(SessionStatus s) {
    if (m_status != s) {
        m_status = s;
        emit statusChanged(s);
    }
}

void Session::setError(const QString& msg) {
    m_error = msg;
    setStatus(SessionStatus::Error);
}

int Session::durationSeconds() const {
    return m_startTime.secsTo(QDateTime::currentDateTime());
}
