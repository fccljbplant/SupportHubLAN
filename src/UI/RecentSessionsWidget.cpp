#include "RecentSessionsWidget.h"
#include <QVBoxLayout>
#include <QLabel>
#include <QHBoxLayout>

RecentSessionsWidget::RecentSessionsWidget(QWidget* parent) : QWidget(parent) {
    setupUI();
}

void RecentSessionsWidget::setupUI() {
    m_layout = new QVBoxLayout(this);
    m_layout->setContentsMargins(0, 0, 0, 0);
    m_layout->setSpacing(4);

    // Demo entries
    QStringList entries = {
        "DESKTOP-7F2A — 10.0.0.12|Windows · Active session open|Live",
        "ubuntu-srv-01 — 10.0.0.20|Linux · Active session open|Live",
        "HR-LAPTOP-02 — 10.0.1.8|Windows · Ended normally|2h ago",
        "RECEPTION-01 — 10.0.0.31|Windows · Ended normally|Yesterday"
    };

    for (const QString& entry : entries) {
        QStringList parts = entry.split("|");
        QWidget* item = new QWidget(this);
        item->setStyleSheet(R"(
            QWidget { background: #13151a; border: 0.5px solid #2a2d35; border-radius: 6px; }
            QWidget:hover { border-color: #3a4050; }
        )");
        QHBoxLayout* hlay = new QHBoxLayout(item);
        hlay->setContentsMargins(10, 8, 10, 8);
        hlay->setSpacing(10);

        QLabel* dot = new QLabel("■");
        dot->setStyleSheet("color: " + (parts[1].startsWith("Windows") ? "#5b9cf7;" : "#f79f5b;") + " font-size: 10px;");
        hlay->addWidget(dot);

        QWidget* info = new QWidget(item);
        QVBoxLayout* vlay = new QVBoxLayout(info);
        vlay->setContentsMargins(0, 0, 0, 0);
        vlay->setSpacing(2);
        QLabel* name = new QLabel(parts[0]);
        name->setStyleSheet("font-size: 12px; color: #c9cdd6;");
        vlay->addWidget(name);
        QLabel* meta = new QLabel(parts[1]);
        meta->setStyleSheet("font-size: 11px; color: #555;");
        vlay->addWidget(meta);
        hlay->addWidget(info, 1);

        QLabel* time = new QLabel(parts[2]);
        time->setStyleSheet(parts[2] == "Live" ? "font-size: 11px; color: #28c840;" : "font-size: 11px; color: #555;");
        hlay->addWidget(time);

        m_layout->addWidget(item);
    }
}
