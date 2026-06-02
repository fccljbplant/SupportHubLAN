#ifndef ENCRYPTIONUTILS_H
#define ENCRYPTIONUTILS_H

#include <QString>
#include <QByteArray>

class EncryptionUtils {
public:
    static QByteArray generateKey(const QString& password);
    static QString encryptPassword(const QString& password, const QByteArray& key);
    static QString decryptPassword(const QString& encrypted, const QByteArray& key);
    static QByteArray randomBytes(int length);
};

#endif
