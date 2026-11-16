package market.grogoni.app.whatsapp.sidecar

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypts and decrypts small secrets with a key that never leaves the wrapper. */
interface KeyWrapper {
    fun wrap(plaintext: ByteArray): ByteArray
    fun unwrap(wrapped: ByteArray): ByteArray
}

/**
 * AES-256-GCM key in Android Keystore (hardware-backed where the device has it). The key is
 * non-exportable: the app can ask Keystore to encrypt or decrypt, but cannot read the key.
 * The output is `iv(12) || ciphertext+tag`.
 */
class AndroidKeystoreWrapper(private val alias: String = ALIAS) : KeyWrapper {
    override fun wrap(plaintext: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        check(iv.size == IV_BYTES)
        return iv + cipher.doFinal(plaintext)
    }

    override fun unwrap(wrapped: ByteArray): ByteArray {
        require(wrapped.size > IV_BYTES + 16) { "Wrapped key is truncated." }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, existingKey() ?: throw VaultKeyUnavailable("Keystore key is missing."),
            GCMParameterSpec(128, wrapped.copyOfRange(0, IV_BYTES)))
        return cipher.doFinal(wrapped, IV_BYTES, wrapped.size - IV_BYTES)
    }

    private fun existingKey(): SecretKey? = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        .getKey(alias, null) as? SecretKey

    private fun key(): SecretKey = synchronized(LOCK) {
        existingKey() ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .setKeySize(256)
                    .setRandomizedEncryptionRequired(true)
                    .build(),
            )
            generateKey()
        }
    }

    fun deleteKey() = synchronized(LOCK) {
        KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.deleteEntry(alias)
    }

    companion object {
        const val ALIAS = "grogoni-whatsapp-sidecar-vault-v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private val LOCK = Any()
    }
}

class VaultKeyUnavailable(message: String, cause: Throwable? = null) : Exception(message, cause)

/**
 * The sidecar vault's 32-byte data key, stored only in wrapped form:
 * `GWK1 || wrapper output`. The plaintext key exists in this process's memory while the sidecar
 * starts, and in the sidecar's memory; it is passed over the stdin pipe and never written out.
 */
class SidecarVaultKeyStore(
    private val file: File,
    private val wrapper: KeyWrapper,
    private val random: SecureRandom = SecureRandom(),
) {
    /** Returns the data key, creating it on first use. Throws [VaultKeyUnavailable] if it is unreadable. */
    @Synchronized
    fun loadOrCreate(): ByteArray {
        if (file.isFile) {
            val bytes = file.readBytes()
            if (bytes.size < MAGIC.size || !bytes.copyOfRange(0, MAGIC.size).contentEquals(MAGIC))
                throw VaultKeyUnavailable("Wrapped vault key has an unknown format.")
            val key = try {
                wrapper.unwrap(bytes.copyOfRange(MAGIC.size, bytes.size))
            } catch (error: VaultKeyUnavailable) {
                throw error
            } catch (error: Exception) {
                throw VaultKeyUnavailable("Wrapped vault key cannot be decrypted.", error)
            }
            if (key.size != KEY_BYTES) throw VaultKeyUnavailable("Vault key has the wrong length.")
            return key
        }
        val key = ByteArray(KEY_BYTES).also(random::nextBytes)
        val wrapped = MAGIC + wrapper.wrap(key)
        file.parentFile?.mkdirs()
        val temporary = File(file.parentFile, "${file.name}.${System.nanoTime()}.tmp")
        try {
            FileOutputStream(temporary).use { out ->
                out.write(wrapped)
                out.fd.sync()
            }
            check(temporary.renameTo(file)) { "Cannot store the wrapped vault key." }
        } finally {
            temporary.delete()
        }
        return key
    }

    /** Drops the wrapped key. Only for an unrecoverable key: the vault it protected is lost too. */
    @Synchronized
    fun delete() {
        file.delete()
    }

    companion object {
        const val KEY_BYTES = 32
        private val MAGIC = "GWK1".toByteArray(Charsets.US_ASCII)
    }
}
