#ifndef SESSIONTABWIDGET_H
#define SESSIONTABWIDGET_H

#include <QWidget>
#include <QTabWidget>
#include <QUuid>
#include <QMap>

class SessionView;

class SessionTabWidget : public QWidget {
    Q_OBJECT
public:
    explicit SessionTabWidget(QWidget* parent = nullptr);
    void activateSession(const QUuid& profileId);

private:
    void setupUI();
    QTabWidget* m_tabs;
    QMap<QUuid, SessionView*> m_sessionViews;
};

#endif
