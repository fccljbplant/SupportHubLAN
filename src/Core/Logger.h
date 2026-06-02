#ifndef LOGGER_H
#define LOGGER_H

#include <QObject>
#include <QDateTime>
#include <QString>
#include <QList>

struct LogEntry {
    QDateTime timestamp;
    QString level;
    QString category;
    QString message;
};

class Logger : public QObject {
    Q_OBJECT
public:
    static Logger* instance();
    void log(const QString& level, const QString& category, const QString& message);
    void info(const QString& category, const QString& message);
    void warning(const QString& category, const QString& message);
    void error(const QString& category, const QString& message);
    QList<LogEntry> entries() const;
    void saveToDisk();

signals:
    void newEntry(const LogEntry& entry);

private:
    explicit Logger(QObject* parent = nullptr);
    QList<LogEntry> m_entries;
    static Logger* s_instance;
};

#endif
