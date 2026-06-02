#ifndef RECENTSESSIONSWIDGET_H
#define RECENTSESSIONSWIDGET_H

#include <QWidget>
#include <QVBoxLayout>

class RecentSessionsWidget : public QWidget {
    Q_OBJECT
public:
    explicit RecentSessionsWidget(QWidget* parent = nullptr);

private:
    void setupUI();
    QVBoxLayout* m_layout;
};

#endif
