#ifndef DASHBOARDWIDGET_H
#define DASHBOARDWIDGET_H

#include <QWidget>
#include <QVBoxLayout>
#include <QUuid>

class DashboardWidget : public QWidget {
    Q_OBJECT
public:
    explicit DashboardWidget(QWidget* parent = nullptr);

signals:
    void connectRequested(const QUuid& profileId);

private:
    void setupUI();
    void refreshFavorites();
    void refreshRecent();

    QVBoxLayout* m_layout;
    QWidget* m_favoritesGrid;
    QWidget* m_recentList;
};

#endif
