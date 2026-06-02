#include "ConnectionManager.h"
#include "EncryptionUtils.h"
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonArray>
#include <QFile>
#include <QDir>
#include <QStandardPaths>
#include <QDebug>

ConnectionManager* ConnectionManager::s_instance = nullptr;

ConnectionManager* ConnectionManager::instance() {
    if (!s_instance) s_instance = new ConnectionManager();
    return s_instance;
}

ConnectionManager::ConnectionManager(QObject* parent) : QObject(parent) {}

void ConnectionManager::load() {
    QString path = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    QDir().mkpath(path);
    QFile file(path + "/connections.json");
    if (!file.open(QIODevice::ReadOnly)) return;
    QJsonArray arr = QJsonDocument::fromJson(file.readAll()).array();
    m_profiles.clear();
    for (const auto& v : arr) {
        QJsonObject o = v.toObject();
        ConnectionProfile p;
        p.setName(o["name"].toString());
        p.setIpAddress(o["ip"].toString());
        p.setPort(o["port"].toInt(5900));
        p.setEncryptedPassword(o["password"].toString());
        p.setNotes(o["notes"].toString());
        p.setPlatform(o["platform"].toString() == "linux" ? PlatformType::Linux : PlatformType::Windows);
        p.setFavorite(o["favorite"].toBool(false));
        p.setPinned(o["pinned"].toBool(false));
        m_profiles.append(p);
    }
}

void ConnectionManager::save() {
    QString path = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    QDir().mkpath(path);
    QJsonArray arr;
    for (const auto& p : m_profiles) {
        QJsonObject o;
        o["name"] = p.name();
        o["ip"] = p.ipAddress();
        o["port"] = p.port();
        o["password"] = p.encryptedPassword();
        o["notes"] = p.notes();
        o["platform"] = p.platform() == PlatformType::Linux ? "linux" : "windows";
        o["favorite"] = p.isFavorite();
        o["pinned"] = p.isPinned();
        arr.append(o);
    }
    QFile file(path + "/connections.json");
    if (file.open(QIODevice::WriteOnly)) {
        file.write(QJsonDocument(arr).toJson());
    }
}

QList<ConnectionProfile> ConnectionManager::allProfiles() const { return m_profiles; }

QList<ConnectionProfile> ConnectionManager::favorites() const {
    QList<ConnectionProfile> res;
    for (const auto& p : m_profiles) if (p.isFavorite()) res.append(p);
    return res;
}

QList<ConnectionProfile> ConnectionManager::recent() const {
    QList<ConnectionProfile> res = m_profiles;
    std::sort(res.begin(), res.end(), [](const ConnectionProfile& a, const ConnectionProfile& b) {
        return a.lastConnected() > b.lastConnected();
    });
    return res;
}

QList<ConnectionProfile> ConnectionManager::search(const QString& query) const {
    QList<ConnectionProfile> res;
    for (const auto& p : m_profiles) if (p.matchesSearch(query)) res.append(p);
    return res;
}

void ConnectionManager::addProfile(const ConnectionProfile& profile) {
    m_profiles.append(profile);
    save();
    emit profilesChanged();
}

void ConnectionManager::updateProfile(const ConnectionProfile& profile) {
    for (auto& p : m_profiles) {
        if (p.id() == profile.id()) { p = profile; break; }
    }
    save();
    emit profilesChanged();
}

void ConnectionManager::removeProfile(const QUuid& id) {
    m_profiles.removeIf([&](const ConnectionProfile& p) { return p.id() == id; });
    save();
    emit profilesChanged();
}

ConnectionProfile* ConnectionManager::profileById(const QUuid& id) {
    for (auto& p : m_profiles) if (p.id() == id) return &p;
    return nullptr;
}

void ConnectionManager::setMasterPassword(const QString& password) {
    m_key = EncryptionUtils::generateKey(password);
    m_hasKey = true;
}

bool ConnectionManager::hasMasterPassword() const { return m_hasKey; }

QString ConnectionManager::decryptStoredPassword(const QString& encrypted) const {
    if (!m_hasKey) return QString();
    return EncryptionUtils::decryptPassword(encrypted, m_key);
}

QString ConnectionManager::encryptPasswordForStorage(const QString& plain) const {
    if (!m_hasKey) return QString();
    return EncryptionUtils::encryptPassword(plain, m_key);
}
