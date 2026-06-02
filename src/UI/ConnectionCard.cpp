#include "ConnectionCard.h"
#include <QVBoxLayout>
#include <QLabel>
#include <QPushButton>
#include <QMouseEvent>

ConnectionCard::ConnectionCard(const ConnectionProfile& profile, QWidget* parent)
    : QWidget(parent), m_profile(profile) {
    setFixedSize(180, 90);
    setCursor(Qt::PointingHandCursor);

    QString borderColor = profile.platformColorHex();
    setStyleSheet(QString(R"(
        QWidget { background: #13151a; border: 0.5px solid #2a2d35; border-radius: 6px;
                 border-left: 2px solid %1; }
        QWidget:hover { border-color: #3a4050; background: #1c1f27; }
    )").arg(borderColor));

    QVBoxLayout* lay = new QVBoxLayout(this);
    lay->setContentsMargins(12, 10, 12, 10);
    lay->setSpacing(4);

    QLabel* name = new QLabel(profile.name());
    name->setStyleSheet("font-size: 13px; font-weight: 500; color: #c9cdd6;");
    lay->addWidget(name);

    QLabel* ip = new QLabel(QString("%1 : %2").arg(profile.ipAddress()).arg(profile.port()));
    ip->setStyleSheet("font-size: 11px; color: #555;");
    lay->addWidget(ip);

    QWidget* footer = new QWidget(this);
    QHBoxLayout* flay = new QHBoxLayout(footer);
    flay->setContentsMargins(0, 0, 0, 0);

    QLabel* tag = new QLabel(profile.platformString());
    tag->setStyleSheet(QString("font-size: 10px; padding: 2px 7px; border-radius: 10px; background: %1; color: %2;")
        .arg(profile.platform() == PlatformType::Windows ? "#1a2540" : "#2a1e0a")
        .arg(borderColor));
    flay->addWidget(tag);
    flay->addStretch();

    QLabel* conn = new QLabel("▶ Connect");
    conn->setStyleSheet("font-size: 11px; color: #555;");
    flay->addWidget(conn);

    lay->addWidget(footer);
}

void ConnectionCard::mousePressEvent(QMouseEvent* event) {
    if (event->button() == Qt::LeftButton)
        emit connectClicked(m_profile.id());
    QWidget::mousePressEvent(event);
}
