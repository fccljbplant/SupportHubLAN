#ifndef SIDEPANEL_H
#define SIDEPANEL_H

#include <QWidget>
#include <QStackedWidget>
#include "../Core/Session.h"

class ChatWidget;
class FileTransferWidget;

class SidePanel : public QWidget {
    Q_OBJECT
public:
    explicit SidePanel(Session* session, QWidget* parent = nullptr);
    void showChat();
    void showFiles();

private:
    void setupUI();
    Session* m_session;
    QStackedWidget* m_stack;
    ChatWidget* m_chat;
    FileTransferWidget* m_files;
};

#endif
