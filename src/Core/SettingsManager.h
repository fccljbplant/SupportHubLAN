#ifndef SETTINGSMANAGER_H
#define SETTINGSMANAGER_H

#include <QObject>
#include <QVariant>

class SettingsManager : public QObject {
    Q_OBJECT
public:
    static SettingsManager* instance();

    void setValue(const QString& key, const QVariant& value);
    QVariant value(const QString& key, const QVariant& defaultValue = QVariant()) const;
    void save();
    void load();

private:
    explicit SettingsManager(QObject* parent = nullptr);
    QVariantMap m_settings;
    static SettingsManager* s_instance;
};

#endif
