#include "SessionView.h"
#include "ToolbarWidget.h"
#include "RemoteDesktopWidget.h"
#include "SidePanel.h"
#include <QVBoxLayout>
#include <QHBoxLayout>

SessionView::SessionView(Session* session, QWidget* parent)
    : QWidget(parent), m_session(session) {
    setupUI();
}

void SessionView::setupUI() {
    QVBoxLayout* mainLay = new QVBoxLayout(this);
    mainLay->setContentsMargins(0, 0, 0, 0);
    mainLay->setSpacing(0);

    m_toolbar = new ToolbarWidget(m_session, this);
    mainLay->addWidget(m_toolbar);

    QHBoxLayout* bodyLay = new QHBoxLayout();
    bodyLay->setContentsMargins(0, 0, 0, 0);
    bodyLay->setSpacing(0);

    m_remoteDesktop = new RemoteDesktopWidget(m_session, this);
    bodyLay->addWidget(m_remoteDesktop, 1);

    m_sidePanel = new SidePanel(m_session, this);
    bodyLay->addWidget(m_sidePanel);

    mainLay->addLayout(bodyLay, 1);
}
