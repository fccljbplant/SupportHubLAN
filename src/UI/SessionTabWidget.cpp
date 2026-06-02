#include "SessionTabWidget.h"
#include "SessionView.h"
#include "../Core/SessionManager.h"
#include "../Core/ConnectionManager.h"
#include "../Core/Logger.h"
#include <QVBoxLayout>

SessionTabWidget::SessionTabWidget(QWidget* parent) : QWidget(parent) {
    setupUI();
}

void SessionTabWidget::setupUI() {
    QVBoxLayout* lay = new QVBoxLayout(this);
    lay->setContentsMargins(0, 0, 0, 0);
    lay->setSpacing(0);

    m_tabs = new QTabWidget(this);
    m_tabs->setDocumentMode(true);
    m_tabs->setStyleSheet(R"(
        QTabWidget::pane { border: none; }
        QTabBar::tab { background: #13151a; color: #8a8f9e; padding: 8px 16px;
                       border-right: 0.5px solid #2a2d35; font-size: 12px; }
        QTabBar::tab:selected { background: #1a1d23; color: #7eb8f7; border-bottom: 2px solid #7eb8f7; }
        QTabBar::tab:hover { background: #1e2128; color: #c9cdd6; }
    )");
    lay->addWidget(m_tabs);

    connect(m_tabs, &QTabWidget::tabCloseRequested, this, [=](int idx) {
        QWidget* w = m_tabs->widget(idx);
        m_tabs->removeTab(idx);
        w->deleteLater();
    });
}

void SessionTabWidget::activateSession(const QUuid& profileId) {
    if (m_sessionViews.contains(profileId)) {
        int idx = m_tabs->indexOf(m_sessionViews[profileId]);
        m_tabs->setCurrentIndex(idx);
        return;
    }

    ConnectionProfile* p = ConnectionManager::instance()->profileById(profileId);
    if (!p) return;

    Session* session = SessionManager::instance()->createSession(*p);
    SessionView* view = new SessionView(session, this);
    m_sessionViews[session->id()] = view;

    QString dot = p->platform() == PlatformType::Windows ? "● " : "● ";
    QString color = p->platformColorHex();
    int idx = m_tabs->addTab(view, dot + p->name());
    m_tabs->setTabData(idx, session->id());
    m_tabs->setCurrentIndex(idx);

    Logger::instance()->info("Session", QString("Opened session to %1").arg(p->name()));
}
