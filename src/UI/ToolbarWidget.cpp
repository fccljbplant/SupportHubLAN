#include "ToolbarWidget.h"
#include "../Core/SessionManager.h"
#include "../Core/Logger.h"
#include <QHBoxLayout>
#include <QPushButton>
#include <QLabel>
#include <QFrame>

ToolbarWidget::ToolbarWidget(Session* session, QWidget* parent)
    : QWidget(parent), m_session(session) {
    setFixedHeight(36);
    setStyleSheet("background: #13151a; border-bottom: 0.5px solid #2a2d35;");
    setupUI();
}

void ToolbarWidget::setupUI() {
    QHBoxLayout* lay = new QHBoxLayout(this);
    lay->setContentsMargins(10, 0, 10, 0);
    lay->setSpacing(4);

    auto makeBtn = [&](const QString& text, const QString& color = "#8a8f9e") -> QPushButton* {
        QPushButton* btn = new QPushButton(text, this);
        btn->setFlat(true);
        btn->setStyleSheet(QString(R"(
            QPushButton { color: %1; font-size: 12px; padding: 4px 10px; border-radius: 4px; border: none; }
            QPushButton:hover { background: #1e2128; color: #c9cdd6; }
            QPushButton:checked { background: #1e2128; color: #7eb8f7; }
        )").arg(color));
        return btn;
    };

    QPushButton* fs = makeBtn("□ Fullscreen");
    lay->addWidget(fs);
    connect(fs, &QPushButton::clicked, this, &ToolbarWidget::fullscreenRequested);

    QFrame* sep1 = new QFrame(this);
    sep1->setFrameShape(QFrame::VLine);
    sep1->setStyleSheet("color: #2a2d35;");
    lay->addWidget(sep1);

    QPushButton* chat = makeBtn("☺ Chat");
    chat->setCheckable(true);
    chat->setChecked(true);
    lay->addWidget(chat);
    connect(chat, &QPushButton::toggled, this, &ToolbarWidget::chatToggled);

    QPushButton* files = makeBtn("↔ Files");
    files->setCheckable(true);
    lay->addWidget(files);
    connect(files, &QPushButton::toggled, this, &ToolbarWidget::filesToggled);

    QFrame* sep2 = new QFrame(this);
    sep2->setFrameShape(QFrame::VLine);
    sep2->setStyleSheet("color: #2a2d35;");
    lay->addWidget(sep2);

    QPushButton* keys = makeBtn("⌨ Send Keys");
    lay->addWidget(keys);

    QPushButton* ss = makeBtn("■ Screenshot");
    lay->addWidget(ss);

    lay->addStretch();

    QString statusColor = m_session->platform() == PlatformType::Windows ? "#5b9cf7" : "#f79f5b";
    QLabel* status = new QLabel(QString("● %1 · %2 · %3")
        .arg(m_session->displayName())
        .arg(m_session->ipAddress())
        .arg(m_session->platform() == PlatformType::Windows ? "Windows" : "Linux"), this);
    status->setStyleSheet(QString("font-size: 11px; color: #555;"));
    lay->addWidget(status);

    QFrame* sep3 = new QFrame(this);
    sep3->setFrameShape(QFrame::VLine);
    sep3->setStyleSheet("color: #2a2d35;");
    lay->addWidget(sep3);

    QPushButton* disc = makeBtn("▶ Disconnect", "#e05555");
    lay->addWidget(disc);
    connect(disc, &QPushButton::clicked, this, [=]() {
        SessionManager::instance()->closeSession(m_session->id());
        emit disconnectRequested();
    });
}
