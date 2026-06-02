#include <QApplication>
#include "UI/MainWindow.h"
#include "Core/ConnectionManager.h"
#include "Core/SettingsManager.h"
#include "Core/Logger.h"

int main(int argc, char* argv[]) {
    QApplication app(argc, argv);
    app.setApplicationName("SupportHub LAN");
    app.setOrganizationName("SupportHub");
    app.setStyle("Fusion");

    // Initialize singletons
    SettingsManager::instance()->load();
    ConnectionManager::instance()->load();
    Logger::instance()->info("App", "SupportHub LAN started");

    MainWindow window;
    window.show();

    int result = app.exec();

    ConnectionManager::instance()->save();
    SettingsManager::instance()->save();
    Logger::instance()->info("App", "SupportHub LAN exiting");
    return result;
}
