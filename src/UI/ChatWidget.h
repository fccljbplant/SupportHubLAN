#ifndef CHATWIDGET_H
#define CHATWIDGET_H

#include <QWidget>
#include <QVBoxLayout>
#include "../Core/Session.h"

class ChatWidget : public QWidget {
    Q_OBJECT
public:
    explicit ChatWidget(Session* session, QWidget* parent = nullptr);

private:
    void setupUI();
    void addMessage(bool fromTech, const QString& sender, const QString& text);

    Session* m_session;
    QVBoxLayout* m_msgLayout;
    QWidget* m_msgContainer;
};

#endif
