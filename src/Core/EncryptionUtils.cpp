#include "EncryptionUtils.h"
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <openssl/aes.h>
#include <QDebug>

QByteArray EncryptionUtils::generateKey(const QString& password) {
    QByteArray key(32, 0);
    QByteArray pwd = password.toUtf8();
    // Simple key derivation using SHA256 of password
    EVP_MD_CTX* ctx = EVP_MD_CTX_new();
    EVP_DigestInit(ctx, EVP_sha256());
    EVP_DigestUpdate(ctx, pwd.constData(), pwd.size());
    unsigned int len = 0;
    EVP_DigestFinal(ctx, reinterpret_cast<unsigned char*>(key.data()), &len);
    EVP_MD_CTX_free(ctx);
    return key;
}

QByteArray EncryptionUtils::randomBytes(int length) {
    QByteArray bytes(length, 0);
    RAND_bytes(reinterpret_cast<unsigned char*>(bytes.data()), length);
    return bytes;
}

QString EncryptionUtils::encryptPassword(const QString& password, const QByteArray& key) {
    QByteArray iv = randomBytes(16);
    QByteArray plain = password.toUtf8();
    QByteArray cipher(plain.size() + AES_BLOCK_SIZE, 0);
    int len = 0, finalLen = 0;

    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    EVP_EncryptInit_ex(ctx, EVP_aes_256_cbc(), nullptr,
        reinterpret_cast<const unsigned char*>(key.constData()),
        reinterpret_cast<const unsigned char*>(iv.constData()));
    EVP_EncryptUpdate(ctx, reinterpret_cast<unsigned char*>(cipher.data()), &len,
        reinterpret_cast<const unsigned char*>(plain.constData()), plain.size());
    EVP_EncryptFinal_ex(ctx, reinterpret_cast<unsigned char*>(cipher.data()) + len, &finalLen);
    EVP_CIPHER_CTX_free(ctx);

    cipher.resize(len + finalLen);
    QByteArray result = iv.toBase64() + ":" + cipher.toBase64();
    return QString::fromLatin1(result);
}

QString EncryptionUtils::decryptPassword(const QString& encrypted, const QByteArray& key) {
    QByteArray data = encrypted.toLatin1();
    int sep = data.indexOf(':');
    if (sep < 0) return QString();
    QByteArray iv = QByteArray::fromBase64(data.left(sep));
    QByteArray cipher = QByteArray::fromBase64(data.mid(sep + 1));
    QByteArray plain(cipher.size() + AES_BLOCK_SIZE, 0);
    int len = 0, finalLen = 0;

    EVP_CIPHER_CTX* ctx = EVP_CIPHER_CTX_new();
    EVP_DecryptInit_ex(ctx, EVP_aes_256_cbc(), nullptr,
        reinterpret_cast<const unsigned char*>(key.constData()),
        reinterpret_cast<const unsigned char*>(iv.constData()));
    EVP_DecryptUpdate(ctx, reinterpret_cast<unsigned char*>(plain.data()), &len,
        reinterpret_cast<const unsigned char*>(cipher.constData()), cipher.size());
    EVP_DecryptFinal_ex(ctx, reinterpret_cast<unsigned char*>(plain.data()) + len, &finalLen);
    EVP_CIPHER_CTX_free(ctx);

    plain.resize(len + finalLen);
    return QString::fromUtf8(plain);
}
