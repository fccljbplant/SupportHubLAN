#include "Logger.h"
#include <QFile>
#include <QDir>
#include <QStandardPaths>
#include <QTextStream>

Logger* Logger::s_instance = nullptr;

Logger* Logger::instance() {
    if (!s_instance) s_instance = new Logger();
    return s_instance;
}

Logger::Logger(QObject* parent) : QObject(parent) {}

void Logger::log(const QString& level, const QString& category, const QString& message) {
    LogEntry e{ QDateTime::currentDateTime(), level, category, message };
    m_entries.append(e);
    emit newEntry(e);
    saveToDisk();
}

void Logger::info(const QString& category, const QString& message) { log("INFO", category, message); }
void Logger::warning(const QString& category, const QString& message) { log("WARN", category, message); }
void Logger::error(const QString& category, const QString& message) { log("ERROR", category, message); }

QList<LogEntry> Logger::entries() const { return m_entries; }

void Logger::saveToDisk() {
    QString path = QStandardPaths::writableLocation(QStandardPaths::AppDataLocation) + "/logs";
    QDir().mkpath(path);
    QString filename = path + "/" + QDateTime::currentDateTime().toString("yyyy-MM-dd") + ".log";
    QFile file(filename);
    if (file.open(QIODevice::WriteOnly | QIODevice::Append)) {
        QTextStream out(&file);
        for (const auto& e : m_entries) {
            out << e.timestamp.toString("yyyy-MM-dd hh:mm:ss") << " ["
                << e.level << "] [" << e.category << "] " << e.message << "
";
        }
        m_entries.clear();
    }
}
