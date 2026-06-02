#ifndef REMOTEDESKTOPWIDGET_H
#define REMOTEDESKTOPWIDGET_H

#include <QWidget>
#include "../Core/Session.h"

class RemoteDesktopWidget : public QWidget {
    Q_OBJECT
public:
    explicit RemoteDesktopWidget(Session* session, QWidget* parent = nullptr);

private:
    void setupUI();
    Session* m_session;
};

#endif
