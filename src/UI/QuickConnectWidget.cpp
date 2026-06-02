#include "QuickConnectWidget.h"
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QComboBox>
#include <QPushButton>

QuickConnectWidget::QuickConnectWidget(QWidget* parent) : QWidget(parent) {
    setStyleSheet(R"(
        QWidget { background: #13151a; border: 0.5px solid #2a2d35; border-radius: 6px; }
        QLineEdit { background: #1a1d23; border: 0.5px solid #2a2d35; border-radius: 4px;
                    padding: 5px 10px; color: #c9cdd6; font-size: 12px; }
        QLineEdit:focus { border-color: #7eb8f7; }
        QComboBox { background: #1a1d23; border: 0.5px solid #2a2d35; border-radius: 4px;
                    padding: 5px 10px; color: #c9cdd6; font-size: 12px; }
        QPushButton { border-radius: 4px; padding: 6px 16px; font-size: 12px; cursor: pointer; }
    )");
    setupUI();
}

void QuickConnectWidget::setupUI() {
    QVBoxLayout* lay = new QVBoxLayout(this);
    lay->setContentsMargins(16, 16, 16, 16);
    lay->setSpacing(10);

    // Row 1: Host
    QHBoxLayout* row1 = new QHBoxLayout();
    QLabel* lbl1 = new QLabel("Host / IP");
    lbl1->setStyleSheet("font-size: 11px; color: #555a68; width: 60px;");
    row1->addWidget(lbl1);
    QLineEdit* host = new QLineEdit();
    host->setPlaceholderText("10.0.0.x or hostname");
    row1->addWidget(host);
    lay->addLayout(row1);

    // Row 2: Port + Platform
    QHBoxLayout* row2 = new QHBoxLayout();
    QLabel* lbl2 = new QLabel("Port");
    lbl2->setStyleSheet("font-size: 11px; color: #555a68; width: 60px;");
    row2->addWidget(lbl2);
    QLineEdit* port = new QLineEdit();
    port->setPlaceholderText("5900");
    port->setMaximumWidth(100);
    row2->addWidget(port);
    QLabel* lbl3 = new QLabel("Platform");
    lbl3->setStyleSheet("font-size: 11px; color: #555a68; margin-left: 16px;");
    row2->addWidget(lbl3);
    QComboBox* plat = new QComboBox();
    plat->addItems({"Windows (VNC)", "Linux (VNC)"});
    plat->setFixedWidth(120);
    row2->addWidget(plat);
    row2->addStretch();
    lay->addLayout(row2);

    // Buttons
    QHBoxLayout* btnLay = new QHBoxLayout();
    QPushButton* conn = new QPushButton("▶ Connect");
    conn->setStyleSheet("background: #1e3a5f; border: 0.5px solid #5b9cf7; color: #7eb8f7;");
    QPushButton* save = new QPushButton("Save Profile");
    save->setStyleSheet("background: none; border: 0.5px solid #2a2d35; color: #8a8f9e;");
    btnLay->addWidget(conn);
    btnLay->addWidget(save);
    btnLay->addStretch();
    lay->addLayout(btnLay);

    connect(conn, &QPushButton::clicked, this, [=]() {
        emit connectClicked(host->text(), port->text().toInt(),
            plat->currentIndex() == 0 ? PlatformType::Windows : PlatformType::Linux);
    });
}
