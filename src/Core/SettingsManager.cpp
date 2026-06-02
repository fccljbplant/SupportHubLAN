#include "SettingsManager.h"
#include <QJsonDocument>
#include <QJsonObject>
#include <QFile>
#include <QDir>
#include <QStandardPaths>

SettingsManager* SettingsManager::s_instance = nullptr;

SettingsManager* SettingsManager::instance() {
    if (!s_instance) s_instance = new SettingsManager();
    return s_instance;
}

SettingsManager::SettingsManager(QObject* parent) : QObject(parent) { load(); }

void SettingsManager::setValue(const QString& key, const QVariant& value) {
    m_settings[key] = value;
    save();
}

QVariant SettingsManager::value(const QString& key, const QVariant& defaultValue) const {
    return m_settings.value(key, defaultValue);
}

void SettingsManager::save() {
    QString path = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    QDir().mkpath(path);
    QJsonObject obj;
    for (auto it = m_settings.begin(); it != m_settings.end(); ++it)
        obj[it.key()] = QJsonValue::fromVariant(it.value());
    QFile file(path + "/settings.json");
    if (file.open(QIODevice::WriteOnly))
        file.write(QJsonDocument(obj).toJson());
}

void SettingsManager::load() {
    QString path = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation);
    QFile file(path + "/settings.json");
    if (!file.open(QIODevice::ReadOnly)) return;
    QJsonObject obj = QJsonDocument::fromJson(file.readAll()).object();
    for (auto it = obj.begin(); it != obj.end(); ++it)
        m_settings[it.key()] = it.value().toVariant();
}
