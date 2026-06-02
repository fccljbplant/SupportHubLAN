#include "MainWindow.h"
#include "../Core/SessionManager.h"
#include "../Core/Logger.h"
#include <QApplication>
#include <QScreen>

MainWindow::MainWindow(QWidget* parent) : QMainWindow(parent) {
    setupUI();
    applyStyles();
    setWindowTitle("SupportHub LAN");
    resize(1200, 800);
    move(QGuiApplication::primaryScreen()->availableGeometry().center() - rect().center());
    Logger::instance()->info("UI", "MainWindow initialized");
}

void MainWindow::setupUI() {
    m_centralWidget = new QWidget(this);
    setCentralWidget(m_centralWidget);
    m_mainLayout = new QHBoxLayout(m_centralWidget);
    m_mainLayout->setContentsMargins(0, 0, 0, 0);
    m_mainLayout->setSpacing(0);

    m_sidebar = new SidebarWidget(this);
    m_mainLayout->addWidget(m_sidebar);

    m_stack = new QStackedWidget(this);
    m_mainLayout->addWidget(m_stack, 1);

    m_dashboard = new DashboardWidget(this);
    m_stack->addWidget(m_dashboard);

    m_sessionTabs = new SessionTabWidget(this);
    m_stack->addWidget(m_sessionTabs);

    connect(m_sidebar, &SidebarWidget::dashboardClicked, this, &MainWindow::showDashboard);
    connect(m_sidebar, &SidebarWidget::connectionClicked, this, &MainWindow::showSession);
    connect(m_dashboard, &DashboardWidget::connectRequested, this, &MainWindow::showSession);
    connect(SessionManager::instance(), &SessionManager::sessionClosed, this, &MainWindow::onSessionClosed);
}

void MainWindow::showDashboard() {
    m_stack->setCurrentWidget(m_dashboard);
    m_sidebar->setActiveItem("dashboard");
}

void MainWindow::showSession(const QUuid& sessionId) {
    m_sessionTabs->activateSession(sessionId);
    m_stack->setCurrentWidget(m_sessionTabs);
    m_sidebar->setActiveItem("sessions");
}

void MainWindow::onSessionClosed(const QUuid& id) {
    if (SessionManager::instance()->activeSessions().isEmpty())
        showDashboard();
}

void MainWindow::applyStyles() {
    setStyleSheet(R"(
        QMainWindow { background: #1a1d23; }
        QWidget { font-family: 'Segoe UI', sans-serif; font-size: 13px; color: #c9cdd6; }
        QScrollBar:vertical { background: #13151a; width: 8px; border-radius: 4px; }
        QScrollBar::handle:vertical { background: #2a2d35; border-radius: 4px; min-height: 30px; }
        QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
    )");
}
