#include "RemoteDesktopWidget.h"
#include <QVBoxLayout>
#include <QLabel>

RemoteDesktopWidget::RemoteDesktopWidget(Session* session, QWidget* parent)
    : QWidget(parent), m_session(session) {
    setStyleSheet("background: #0d0f13;");
    setupUI();
}

void RemoteDesktopWidget::setupUI() {
    QVBoxLayout* lay = new QVBoxLayout(this);
    lay->setContentsMargins(0, 0, 0, 0);
    lay->setAlignment(Qt::AlignCenter);

    QWidget* frame = new QWidget(this);
    frame->setFixedSize(680, 420);
    QString border = m_session->platform() == PlatformType::Windows ? "#2a3545" : "#1a3530";
    QString bg = m_session->platform() == PlatformType::Windows ? "#1e3045" : "#0d1f1a";
    frame->setStyleSheet(QString("background: %1; border: 0.5px solid %2; border-radius: 2px;").arg(bg, border));

    QVBoxLayout* flay = new QVBoxLayout(frame);
    flay->setContentsMargins(0, 0, 0, 0);
    flay->setSpacing(0);

    // Taskbar
    QWidget* taskbar = new QWidget(frame);
    taskbar->setFixedHeight(28);
    QString tbBg = m_session->platform() == PlatformType::Windows ? "#0b1a2c" : "#071410";
    QString tbBorder = m_session->platform() == PlatformType::Windows ? "#1a2535" : "#0f2520";
    taskbar->setStyleSheet(QString("background: %1; border-bottom: 0.5px solid %2;").arg(tbBg, tbBorder));
    QHBoxLayout* tblay = new QHBoxLayout(taskbar);
    tblay->setContentsMargins(8, 0, 8, 0);
    tblay->setSpacing(8);

    QWidget* start = new QWidget(taskbar);
    start->setFixedSize(20, 20);
    QString startBg = m_session->platform() == PlatformType::Windows ? "#1e4a8a" : "#0d3d1a";
    start->setStyleSheet(QString("background: %1; border-radius: 2px;").arg(startBg));
    tblay->addWidget(start);

    QLabel* win1 = new QLabel("File Explorer", taskbar);
    win1->setStyleSheet("font-size: 10px; color: #7eb8f7; background: #1e4070; padding: 2px 8px; border-radius: 2px;");
    tblay->addWidget(win1);

    QLabel* win2 = new QLabel("Chrome", taskbar);
    win2->setStyleSheet("font-size: 10px; color: #7a9ec5; background: #1a2d45; padding: 2px 8px; border-radius: 2px;");
    tblay->addWidget(win2);

    tblay->addStretch();

    QLabel* clock = new QLabel("10:42 AM", taskbar);
    clock->setStyleSheet("font-size: 10px; color: #5a7a9e;");
    tblay->addWidget(clock);

    flay->addWidget(taskbar);

    // Content
    QWidget* content = new QWidget(frame);
    content->setStyleSheet("background: transparent;");
    QVBoxLayout* clay = new QVBoxLayout(content);
    clay->setAlignment(Qt::AlignCenter);

    QLabel* icon = new QLabel("▣", content);
    icon->setStyleSheet(QString("font-size: 32px; color: %1;").arg(m_session->platform() == PlatformType::Windows ? "#1e3a5a" : "#1a4030"));
    clay->addWidget(icon, 0, Qt::AlignCenter);

    QLabel* txt = new QLabel("Remote desktop stream", content);
    txt->setStyleSheet(QString("font-size: 11px; color: %1; margin-top: 8px;").arg(m_session->platform() == PlatformType::Windows ? "#2a4060" : "#1a4030"));
    clay->addWidget(txt, 0, Qt::AlignCenter);

    QLabel* sub = new QLabel(m_session->platform() == PlatformType::Windows ? "UltraVNC · 1920×1080" : "TigerVNC · 1920×1080", content);
    sub->setStyleSheet(QString("font-size: 10px; color: %1; margin-top: 4px;").arg(m_session->platform() == PlatformType::Windows ? "#1e3a5a" : "#0f2a20"));
    clay->addWidget(sub, 0, Qt::AlignCenter);

    flay->addWidget(content, 1);
    lay->addWidget(frame, 0, Qt::AlignCenter);

    // Overlay
    QLabel* overlay = new QLabel(QString("● RDP Active · %1ms").arg(m_session->platform() == PlatformType::Windows ? "47" : "31"), this);
    overlay->setStyleSheet(QString("font-size: 10px; background: rgba(0,0,0,0.6); color: %1; padding: 3px 8px; border-radius: 3px;").arg(m_session->platform() == PlatformType::Windows ? "#5b9cf7" : "#f79f5b"));
    overlay->move(8, 8);
    overlay->raise();
}
