#include "ChatWidget.h"
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QLabel>
#include <QTextEdit>
#include <QPushButton>
#include <QScrollArea>

ChatWidget::ChatWidget(Session* session, QWidget* parent)
    : QWidget(parent), m_session(session) {
    setupUI();
}

void ChatWidget::setupUI() {
    QVBoxLayout* mainLay = new QVBoxLayout(this);
    mainLay->setContentsMargins(0, 0, 0, 0);
    mainLay->setSpacing(0);

    // Messages area
    QScrollArea* scroll = new QScrollArea(this);
    scroll->setWidgetResizable(true);
    scroll->setFrameShape(QFrame::NoFrame);
    scroll->setStyleSheet("background: #13151a;");

    m_msgContainer = new QWidget(scroll);
    m_msgLayout = new QVBoxLayout(m_msgContainer);
    m_msgLayout->setContentsMargins(10, 10, 10, 10);
    m_msgLayout->setSpacing(8);
    m_msgLayout->addStretch(1);
    scroll->setWidget(m_msgContainer);
    mainLay->addWidget(scroll, 1);

    // Input
    QWidget* inputArea = new QWidget(this);
    inputArea->setStyleSheet("border-top: 0.5px solid #2a2d35;");
    QHBoxLayout* ilay = new QHBoxLayout(inputArea);
    ilay->setContentsMargins(8, 8, 8, 8);
    ilay->setSpacing(6);

    QTextEdit* input = new QTextEdit(inputArea);
    input->setPlaceholderText("Type a message...");
    input->setFixedHeight(50);
    input->setStyleSheet(R"(
        QTextEdit { background: #1a1d23; border: 0.5px solid #2a2d35; border-radius: 4px;
                    padding: 5px 8px; color: #c9cdd6; font-size: 12px; }
    )");
    ilay->addWidget(input, 1);

    QPushButton* send = new QPushButton("→", inputArea);
    send->setFixedSize(32, 32);
    send->setStyleSheet(R"(
        QPushButton { background: #1e3a5f; border: 0.5px solid #5b9cf7; color: #7eb8f7; border-radius: 4px; font-size: 14px; }
    )");
    ilay->addWidget(send);
    mainLay->addWidget(inputArea);

    // Demo messages
    addMessage(true, "admin (you)", "Hi! I'm connected. Can you describe the issue you're seeing?");
    addMessage(false, "User · " + m_session->displayName(), "The printer keeps showing offline even though it's on.");
    addMessage(true, "admin (you)", "I can see the screen. Let me check the print spooler service.");
    addMessage(false, "User · " + m_session->displayName(), "Ok, thank you!");

    connect(send, &QPushButton::clicked, this, [=]() {
        if (!input->toPlainText().isEmpty()) {
            addMessage(true, "admin (you)", input->toPlainText());
            input->clear();
        }
    });
}

void ChatWidget::addMessage(bool fromTech, const QString& sender, const QString& text) {
    QWidget* msg = new QWidget(m_msgContainer);
    QVBoxLayout* mlay = new QVBoxLayout(msg);
    mlay->setContentsMargins(0, 0, 0, 0);
    mlay->setSpacing(2);

    QLabel* sLabel = new QLabel(sender);
    sLabel->setStyleSheet(QString("font-size: 10px; color: %1;").arg(fromTech ? "#5b9cf7" : "#555"));
    if (!fromTech) sLabel->setAlignment(Qt::AlignRight);
    mlay->addWidget(sLabel);

    QLabel* bubble = new QLabel(text);
    bubble->setWordWrap(true);
    bubble->setStyleSheet(QString(R"(
        QLabel { padding: 7px 10px; border-radius: 8px; font-size: 12px; line-height: 1.5;
               background: %1; color: %2; }
    )").arg(fromTech ? "#1e3a5f" : "#1e2128", fromTech ? "#9ec8f7" : "#c9cdd6"));
    if (!fromTech) bubble->setAlignment(Qt::AlignRight);
    mlay->addWidget(bubble);

    mlay->setAlignment(fromTech ? Qt::AlignLeft : Qt::AlignRight);
    m_msgLayout->insertWidget(m_msgLayout->count() - 1, msg);
}
