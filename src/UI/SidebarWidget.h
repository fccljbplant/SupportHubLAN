#ifndef SIDEBARWIDGET_H
#define SIDEBARWIDGET_H

#include <QWidget>
#include <QVBoxLayout>
#include <QUuid>

class SidebarWidget : public QWidget {
    Q_OBJECT
public:
    explicit SidebarWidget(QWidget* parent = nullptr);
    void setActiveItem(const QString& key);
    void refreshConnections();

signals:
    void dashboardClicked();
    void sessionsClicked();
    void historyClicked();
    void settingsClicked();
    void connectionClicked(const QUuid& id);

private:
    void setupUI();
    QVBoxLayout* m_layout;
    QWidget* m_navSection;
    QWidget* m_connSection;
    QWidget* m_footerSection;
};

#endif
