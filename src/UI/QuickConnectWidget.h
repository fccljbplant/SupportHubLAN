#ifndef QUICKCONNECTWIDGET_H
#define QUICKCONNECTWIDGET_H

#include <QWidget>
#include "../Core/ConnectionProfile.h"

class QuickConnectWidget : public QWidget {
    Q_OBJECT
public:
    explicit QuickConnectWidget(QWidget* parent = nullptr);

signals:
    void connectClicked(const QString& ip, int port, PlatformType platform);
    void saveClicked(const QString& ip, int port, PlatformType platform);

private:
    void setupUI();
};

#endif
