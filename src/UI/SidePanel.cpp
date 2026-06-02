#include "SidePanel.h"
#include "ChatWidget.h"
#include "FileTransferWidget.h"
#include <QVBoxLayout>
#include <QHBoxLayout>
#include <QPushButton>

SidePanel::SidePanel(Session* session, QWidget* parent)
    : QWidget(parent), m_session(session) {
    setFixedWidth(240);
    setStyleSheet("background: #13151a; border-left: 0.5px solid #2a2d35;");
    setupUI();
}

void SidePanel::setupUI() {
    QVBoxLayout* lay = new QVBoxLayout(this);
    lay->setContentsMargins(0, 0, 0, 0);
    lay->setSpacing(0);

    // Tabs
    QWidget* tabs = new QWidget(this);
    tabs->setFixedHeight(36);
    tabs->setStyleSheet("border-bottom: 0.5px solid #2a2d35;");
    QHBoxLayout* tlay = new QHBoxLayout(tabs);
    tlay->setContentsMargins(0, 0, 0, 0);
    tlay->setSpacing(0);

    QPushButton* chatBtn = new QPushButton("☺ Chat", tabs);
    chatBtn->setCheckable(true);
    chatBtn->setChecked(true);
    chatBtn->setStyleSheet(R"(
        QPushButton { color: #555; font-size: 12px; border: none; border-bottom: 2px solid transparent; padding: 8px; }
        QPushButton:hover { color: #8a8f9e; }
        QPushButton:checked { color: #7eb8f7; border-bottom-color: #7eb8f7; }
    )");
    tlay->addWidget(chatBtn);

    QPushButton* fileBtn = new QPushButton("↔ Files", tabs);
    fileBtn->setCheckable(true);
    fileBtn->setStyleSheet(R"(
        QPushButton { color: #555; font-size: 12px; border: none; border-bottom: 2px solid transparent; padding: 8px; }
        QPushButton:hover { color: #8a8f9e; }
        QPushButton:checked { color: #7eb8f7; border-bottom-color: #7eb8f7; }
    )");
    tlay->addWidget(fileBtn);

    lay->addWidget(tabs);

    // Stack
    m_stack = new QStackedWidget(this);
    m_chat = new ChatWidget(m_session, m_stack);
    m_files = new FileTransferWidget(m_session, m_stack);
    m_stack->addWidget(m_chat);
    m_stack->addWidget(m_files);
    lay->addWidget(m_stack, 1);

    connect(chatBtn, &QPushButton::clicked, this, [=]() { fileBtn->setChecked(false); m_stack->setCurrentIndex(0); });
    connect(fileBtn, &QPushButton::clicked, this, [=]() { chatBtn->setChecked(false); m_stack->setCurrentIndex(1); });
}

void SidePanel::showChat() { m_stack->setCurrentIndex(0); }
void SidePanel::showFiles() { m_stack->setCurrentIndex(1); }
