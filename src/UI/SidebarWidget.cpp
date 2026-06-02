#include "SidebarWidget.h"
#include "../Core/ConnectionManager.h"
#include <QVBoxLayout>
#include <QLabel>
#include <QPushButton>
#include <QFrame>

SidebarWidget::SidebarWidget(QWidget* parent) : QWidget(parent) {
    setFixedWidth(220);
    setStyleSheet("background: #13151a; border-right: 0.5px solid #2a2d35;");
    setupUI();
    refreshConnections();
}

void SidebarWidget::setupUI() {
    m_layout = new QVBoxLayout(this);
    m_layout->setContentsMargins(0, 0, 0, 0);
    m_layout->setSpacing(0);

    // Navigation
    m_navSection = new QWidget(this);
    QVBoxLayout* navLay = new QVBoxLayout(m_navSection);
    navLay->setContentsMargins(0, 10, 0, 0);
    navLay->setSpacing(2);

    auto makeNav = [&](const QString& icon, const QString& text, const QString& key) -> QPushButton* {
        QPushButton* btn = new QPushButton(icon + "  " + text, m_navSection);
        btn->setProperty("key", key);
        btn->setFlat(true);
        btn->setStyleSheet(R"(
            QPushButton { text-align: left; padding: 6px 14px; border: none; color: #8a8f9e; font-size: 13px; }
            QPushButton:hover { background: #1e2128; color: #c9cdd6; }
            QPushButton[active='true'] { background: #1e2128; color: #7eb8f7; }
        )");
        navLay->addWidget(btn);
        return btn;
    };

    auto dash = makeNav("☰", "Dashboard", "dashboard");
    auto sess = makeNav("▣", "Sessions", "sessions");
    auto hist = makeNav("▶", "History", "history");
    auto sett = makeNav("⚙", "Settings", "settings");

    connect(dash, &QPushButton::clicked, this, &SidebarWidget::dashboardClicked);
    connect(sess, &QPushButton::clicked, this, &SidebarWidget::sessionsClicked);
    connect(hist, &QPushButton::clicked, this, &SidebarWidget::historyClicked);
    connect(sett, &QPushButton::clicked, this, &SidebarWidget::settingsClicked);

    m_layout->addWidget(m_navSection);

    // Divider
    QFrame* div = new QFrame(this);
    div->setFrameShape(QFrame::HLine);
    div->setStyleSheet("color: #2a2d35;");
    m_layout->addWidget(div);

    // Saved connections
    m_connSection = new QWidget(this);
    QVBoxLayout* connLay = new QVBoxLayout(m_connSection);
    connLay->setContentsMargins(0, 10, 0, 0);
    connLay->setSpacing(2);

    QLabel* connHeader = new QLabel("SAVED CONNECTIONS", m_connSection);
    connHeader->setStyleSheet("font-size: 10px; font-weight: 500; color: #555a68; letter-spacing: 0.08em; padding: 0 14px 6px;");
    connLay->addWidget(connHeader);
    m_layout->addWidget(m_connSection, 1);

    // Footer
    m_footerSection = new QWidget(this);
    QVBoxLayout* footLay = new QVBoxLayout(m_footerSection);
    footLay->setContentsMargins(0, 0, 0, 10);
    footLay->setSpacing(2);

    QLabel* user = new QLabel("☺  Tech: admin", m_footerSection);
    user->setStyleSheet("padding: 6px 14px; color: #8a8f9e; font-size: 12px;");
    footLay->addWidget(user);

    QLabel* lock = new QLabel("✔  Profiles encrypted", m_footerSection);
    lock->setStyleSheet("padding: 6px 14px; color: #8a8f9e; font-size: 12px;");
    footLay->addWidget(lock);

    m_layout->addWidget(m_footerSection);
}

void SidebarWidget::setActiveItem(const QString& key) {
    for (QPushButton* btn : findChildren<QPushButton*>()) {
        btn->setProperty("active", btn->property("key").toString() == key);
        btn->style()->unpolish(btn);
        btn->style()->polish(btn);
    }
}

void SidebarWidget::refreshConnections() {
    // Re-populate connection list (simplified)
}
