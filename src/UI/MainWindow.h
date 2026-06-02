#ifndef MAINWINDOW_H
#define MAINWINDOW_H

#include <QMainWindow>
#include <QHBoxLayout>
#include <QStackedWidget>
#include "SidebarWidget.h"
#include "DashboardWidget.h"
#include "SessionTabWidget.h"

class MainWindow : public QMainWindow {
    Q_OBJECT
public:
    explicit MainWindow(QWidget* parent = nullptr);

private slots:
    void showDashboard();
    void showSession(const QUuid& sessionId);
    void onSessionClosed(const QUuid& id);

private:
    void setupUI();
    void applyStyles();

    QWidget* m_centralWidget;
    QHBoxLayout* m_mainLayout;
    SidebarWidget* m_sidebar;
    QStackedWidget* m_stack;
    DashboardWidget* m_dashboard;
    SessionTabWidget* m_sessionTabs;
};

#endif
