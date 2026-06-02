#ifndef FILETRANSFERWIDGET_H
#define FILETRANSFERWIDGET_H

#include <QWidget>
#include <QVBoxLayout>
#include "../Core/Session.h"

class FileTransferWidget : public QWidget {
    Q_OBJECT
public:
    explicit FileTransferWidget(Session* session, QWidget* parent = nullptr);

private:
    void setupUI();
    void addFileItem(const QString& name, const QString& size, int progress, bool done);

    Session* m_session;
    QVBoxLayout* m_listLayout;
};

#endif
