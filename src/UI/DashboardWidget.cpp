#include "DashboardWidget.h"
#include "ConnectionCard.h"
#include "QuickConnectWidget.h"
#include "RecentSessionsWidget.h"
#include "../Core/ConnectionManager.h"
#include <QVBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QScrollArea>
#include <QGridLayout>

DashboardWidget::DashboardWidget(QWidget* parent) : QWidget(parent) {
    setStyleSheet("background: #1a1d23;");
    setupUI();
    refreshFavorites();
    refreshRecent();
}

void DashboardWidget::setupUI() {
    QScrollArea* scroll = new QScrollArea(this);
    scroll->setWidgetResizable(true);
    scroll->setFrameShape(QFrame::NoFrame);
    scroll->setStyleSheet("background: #1a1d23;");

    QWidget* container = new QWidget(scroll);
    m_layout = new QVBoxLayout(container);
    m_layout->setContentsMargins(24, 24, 24, 24);
    m_layout->setSpacing(20);

    // Hero
    QLabel* heroTitle = new QLabel("Remote Support Dashboard", container);
    heroTitle->setStyleSheet("font-size: 18px; font-weight: 500; color: #e2e5ec; margin-bottom: 4px;");
    m_layout->addWidget(heroTitle);

    QLabel* heroSub = new QLabel("Cross-platform support for Windows and Linux systems on your local network", container);
    heroSub->setStyleSheet("font-size: 12px; color: #555a68; margin-bottom: 20px;");
    m_layout->addWidget(heroSub);

    // Search
    QLineEdit* search = new QLineEdit(container);
    search->setPlaceholderText("Search saved connections by name or IP...");
    search->setStyleSheet(R"(
        QLineEdit { background: #13151a; border: 0.5px solid #2a2d35; border-radius: 6px;
                  padding: 8px 12px; color: #c9cdd6; font-size: 13px; }
        QLineEdit:focus { border-color: #7eb8f7; }
    )");
    m_layout->addWidget(search);

    // Favorites
    QLabel* favLabel = new QLabel("FAVORITES", container);
    favLabel->setStyleSheet("font-size: 11px; font-weight: 500; color: #555a68; letter-spacing: 0.06em; margin-bottom: 10px;");
    m_layout->addWidget(favLabel);

    m_favoritesGrid = new QWidget(container);
    QGridLayout* grid = new QGridLayout(m_favoritesGrid);
    grid->setContentsMargins(0, 0, 0, 0);
    grid->setSpacing(8);
    m_layout->addWidget(m_favoritesGrid);

    // Quick Connect
    QuickConnectWidget* qc = new QuickConnectWidget(container);
    m_layout->addWidget(qc);
    connect(qc, &QuickConnectWidget::connectClicked, this, [&](const QString& ip, int port, PlatformType plat) {
        ConnectionProfile p("Quick Connect", ip, port, plat);
        ConnectionManager::instance()->addProfile(p);
        emit connectRequested(p.id());
    });

    // Recent
    QLabel* recLabel = new QLabel("RECENT SESSIONS", container);
    recLabel->setStyleSheet("font-size: 11px; font-weight: 500; color: #555a68; letter-spacing: 0.06em; margin-bottom: 10px;");
    m_layout->addWidget(recLabel);

    m_recentList = new RecentSessionsWidget(container);
    m_layout->addWidget(m_recentList);

    m_layout->addStretch(1);
    scroll->setWidget(container);

    QVBoxLayout* mainLay = new QVBoxLayout(this);
    mainLay->setContentsMargins(0, 0, 0, 0);
    mainLay->addWidget(scroll);
}

void DashboardWidget::refreshFavorites() {
    // Populate favorites grid with ConnectionCards
    QGridLayout* grid = qobject_cast<QGridLayout*>(m_favoritesGrid->layout());
    if (!grid) return;
    while (grid->count()) { delete grid->takeAt(0)->widget(); }
    int col = 0;
    for (const auto& p : ConnectionManager::instance()->favorites()) {
        ConnectionCard* card = new ConnectionCard(p, m_favoritesGrid);
        connect(card, &ConnectionCard::connectClicked, this, &DashboardWidget::connectRequested);
        grid->addWidget(card, 0, col++);
    }
}

void DashboardWidget::refreshRecent() {
    // RecentSessionsWidget auto-refreshes
}
