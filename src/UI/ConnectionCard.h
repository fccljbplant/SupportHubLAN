#ifndef CONNECTIONCARD_H
#define CONNECTIONCARD_H

#include <QWidget>
#include <QUuid>
#include "../Core/ConnectionProfile.h"

class ConnectionCard : public QWidget {
    Q_OBJECT
public:
    explicit ConnectionCard(const ConnectionProfile& profile, QWidget* parent = nullptr);

signals:
    void connectClicked(const QUuid& id);

private:
    ConnectionProfile m_profile;
};

#endif
