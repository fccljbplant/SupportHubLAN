#ifndef CONNECTIONMANAGER_H
#define CONNECTIONMANAGER_H

#include <QObject>
#include <QList>
#include <QJsonArray>
#include "ConnectionProfile.h"

class ConnectionManager : public QObject {
    Q_OBJECT
public:
    static ConnectionManager* instance();

    void load();
    void save();

    QList<ConnectionProfile> allProfiles() const;
    QList<ConnectionProfile> favorites() const;
    QList<ConnectionProfile> recent() const;
    QList<ConnectionProfile> search(const QString& query) const;

    void addProfile(const ConnectionProfile& profile);
    void updateProfile(const ConnectionProfile& profile);
    void removeProfile(const QUuid& id);
    ConnectionProfile* profileById(const QUuid& id);

    void setMasterPassword(const QString& password);
    bool hasMasterPassword() const;
    QString decryptStoredPassword(const QString& encrypted) const;
    QString encryptPasswordForStorage(const QString& plain) const;

signals:
    void profilesChanged();

private:
    explicit ConnectionManager(QObject* parent = nullptr);
    QList<ConnectionProfile> m_profiles;
    QByteArray m_key;
    bool m_hasKey = false;
    static ConnectionManager* s_instance;
};

#endif
