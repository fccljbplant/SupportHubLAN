#ifndef CONNECTIONPROFILE_H
#define CONNECTIONPROFILE_H

#include <QString>
#include <QDateTime>
#include <QUuid>

enum class PlatformType { Windows, Linux };

class ConnectionProfile {
public:
    ConnectionProfile();
    ConnectionProfile(const QString& name, const QString& ip, int port,
                      PlatformType platform = PlatformType::Windows);

    QUuid id() const { return m_id; }
    QString name() const { return m_name; }
    QString ipAddress() const { return m_ip; }
    int port() const { return m_port; }
    QString encryptedPassword() const { return m_encryptedPassword; }
    QString notes() const { return m_notes; }
    PlatformType platform() const { return m_platform; }
    bool isFavorite() const { return m_isFavorite; }
    bool isPinned() const { return m_isPinned; }
    QDateTime lastConnected() const { return m_lastConnected; }

    void setName(const QString& name) { m_name = name; }
    void setIpAddress(const QString& ip) { m_ip = ip; }
    void setPort(int port) { m_port = port; }
    void setEncryptedPassword(const QString& pwd) { m_encryptedPassword = pwd; }
    void setNotes(const QString& notes) { m_notes = notes; }
    void setPlatform(PlatformType p) { m_platform = p; }
    void setFavorite(bool fav) { m_isFavorite = fav; }
    void setPinned(bool pin) { m_isPinned = pin; }
    void setLastConnected(const QDateTime& dt) { m_lastConnected = dt; }

    QString platformString() const;
    QString platformColorHex() const;
    bool matchesSearch(const QString& query) const;

private:
    QUuid m_id;
    QString m_name;
    QString m_ip;
    int m_port;
    QString m_encryptedPassword;
    QString m_notes;
    PlatformType m_platform;
    bool m_isFavorite;
    bool m_isPinned;
    QDateTime m_lastConnected;
};

#endif
