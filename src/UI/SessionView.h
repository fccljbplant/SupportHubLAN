#ifndef SESSIONVIEW_H
#define SESSIONVIEW_H

#include <QWidget>
#include <QHBoxLayout>
#include "../Core/Session.h"

class ToolbarWidget;
class RemoteDesktopWidget;
class SidePanel;

class SessionView : public QWidget {
    Q_OBJECT
public:
    explicit SessionView(Session* session, QWidget* parent = nullptr);

private:
    void setupUI();
    Session* m_session;
    ToolbarWidget* m_toolbar;
    RemoteDesktopWidget* m_remoteDesktop;
    SidePanel* m_sidePanel;
};

#endif
