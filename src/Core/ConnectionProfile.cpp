#include "ConnectionProfile.h"

ConnectionProfile::ConnectionProfile()
    : m_id(QUuid::createUuid()), m_port(5900),
      m_platform(PlatformType::Windows), m_isFavorite(false), m_isPinned(false) {}

ConnectionProfile::ConnectionProfile(const QString& name, const QString& ip, int port, PlatformType platform)
    : m_id(QUuid::createUuid()), m_name(name), m_ip(ip), m_port(port),
      m_platform(platform), m_isFavorite(false), m_isPinned(false) {}

QString ConnectionProfile::platformString() const {
    return m_platform == PlatformType::Windows ? QStringLiteral("Windows") : QStringLiteral("Linux");
}

QString ConnectionProfile::platformColorHex() const {
    return m_platform == PlatformType::Windows ? QStringLiteral("#5b9cf7") : QStringLiteral("#f79f5b");
}

bool ConnectionProfile::matchesSearch(const QString& query) const {
    const QString q = query.toLower();
    return m_name.toLower().contains(q) || m_ip.toLower().contains(q) || m_notes.toLower().contains(q);
}
