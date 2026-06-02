#ifndef TOOLBARWIDGET_H
#define TOOLBARWIDGET_H

#include <QWidget>
#include "../Core/Session.h"

class ToolbarWidget : public QWidget {
    Q_OBJECT
public:
    explicit ToolbarWidget(Session* session, QWidget* parent = nullptr);

signals:
    void fullscreenRequested();
    void chatToggled(bool visible);
    void filesToggled(bool visible);
    void disconnectRequested();

private:
    void setupUI();
    Session* m_session;
};

#endif
