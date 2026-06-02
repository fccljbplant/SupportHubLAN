#include "FileTransferWidget.h"
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QPushButton>
#include <QProgressBar>

FileTransferWidget::FileTransferWidget(Session* session, QWidget* parent)
    : QWidget(parent), m_session(session) {
    setupUI();
}

void FileTransferWidget::setupUI() {
    QVBoxLayout* mainLay = new QVBoxLayout(this);
    mainLay->setContentsMargins(0, 0, 0, 0);
    mainLay->setSpacing(0);

    // File list
    QWidget* list = new QWidget(this);
    list->setStyleSheet("background: #13151a;");
    m_listLayout = new QVBoxLayout(list);
    m_listLayout->setContentsMargins(10, 10, 10, 10);
    m_listLayout->setSpacing(6);

    QLabel* header = new QLabel("Session transfer log");
    header->setStyleSheet("font-size: 11px; color: #555; padding: 4px 0 8px;");
    m_listLayout->addWidget(header);

    addFileItem("PrinterDriver_v3.2.zip", "4.2 MB", 65, false);
    addFileItem("support-notes.txt", "2 KB · Sent", 100, true);
    addFileItem("error-log-export.csv", "88 KB · Received", 100, true);

    m_listLayout->addStretch(1);
    mainLay->addWidget(list, 1);

    // Actions
    QWidget* actions = new QWidget(this);
    actions->setStyleSheet("border-top: 0.5px solid #2a2d35;");
    QHBoxLayout* alay = new QHBoxLayout(actions);
    alay->setContentsMargins(8, 8, 8, 8);
    alay->setSpacing(6);

    QPushButton* send = new QPushButton("↑ Send File", actions);
    send->setStyleSheet(R"(
        QPushButton { background: #1a1d23; border: 0.5px solid #2a2d35; color: #8a8f9e;
                      border-radius: 4px; padding: 6px; font-size: 11px; }
        QPushButton:hover { background: #1e2128; color: #c9cdd6; }
    )");
    alay->addWidget(send);

    QPushButton* recv = new QPushButton("↓ Receive", actions);
    recv->setStyleSheet(R"(
        QPushButton { background: #1a1d23; border: 0.5px solid #2a2d35; color: #8a8f9e;
                      border-radius: 4px; padding: 6px; font-size: 11px; }
        QPushButton:hover { background: #1e2128; color: #c9cdd6; }
    )");
    alay->addWidget(recv);

    mainLay->addWidget(actions);
}

void FileTransferWidget::addFileItem(const QString& name, const QString& size, int progress, bool done) {
    QWidget* item = new QWidget(this);
    item->setStyleSheet("background: #1a1d23; border: 0.5px solid #2a2d35; border-radius: 4px;");
    QHBoxLayout* hlay = new QHBoxLayout(item);
    hlay->setContentsMargins(8, 8, 8, 8);
    hlay->setSpacing(8);

    QLabel* icon = new QLabel("■");
    icon->setStyleSheet("font-size: 16px; color: #7eb8f7;");
    hlay->addWidget(icon);

    QWidget* info = new QWidget(item);
    QVBoxLayout* vlay = new QVBoxLayout(info);
    vlay->setContentsMargins(0, 0, 0, 0);
    vlay->setSpacing(2);

    QLabel* nLabel = new QLabel(name);
    nLabel->setStyleSheet("font-size: 11px; color: #c9cdd6;");
    vlay->addWidget(nLabel);

    QLabel* sLabel = new QLabel(size);
    sLabel->setStyleSheet("font-size: 10px; color: #555;");
    vlay->addWidget(sLabel);

    if (!done) {
        QProgressBar* bar = new QProgressBar(info);
        bar->setValue(progress);
        bar->setTextVisible(false);
        bar->setFixedHeight(3);
        bar->setStyleSheet(R"(
            QProgressBar { background: #2a2d35; border-radius: 2px; }
            QProgressBar::chunk { background: #f79f5b; border-radius: 2px; }
        )");
        vlay->addWidget(bar);
    }

    hlay->addWidget(info, 1);

    QLabel* status = new QLabel(done ? "✓" : QString("%1%").arg(progress));
    status->setStyleSheet(QString("font-size: 10px; color: %1;").arg(done ? "#28c840" : "#f79f5b"));
    hlay->addWidget(status);

    m_listLayout->addWidget(item);
}
