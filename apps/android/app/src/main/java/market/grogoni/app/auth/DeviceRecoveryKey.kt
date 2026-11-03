package market.grogoni.app.auth

import android.app.KeyguardManager
import android.os.Build
import android.security.keystore.KeyInfo
import java.security.KeyFactory
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.MessageDigest
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec

/** One non-exportable P-256 private key per account, isolated from cookies and PINs. */
class DeviceRecoveryKey(private val context: Context) {
    private val preferences = context.getSharedPreferences("grogoni-device-recovery", Context.MODE_PRIVATE)
    private val keyStore get() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun alias(accountId: String) = "grogoni-recovery-v2-" + MessageDigest.getInstance("SHA-256")
        .digest(accountId.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

    fun publicJwk(accountId: String): JSONObject {
        check(context.getSystemService(KeyguardManager::class.java).isDeviceSecure) {
            "Set a device screen lock before enabling device recovery."
        }
        val alias = alias(accountId)
        if (!keyStore.containsAlias(alias)) {
            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").apply {
                val builder = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setUserAuthenticationRequired(true)
                if (Build.VERSION.SDK_INT >= 30) {
                    builder.setUserAuthenticationParameters(30,
                        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL)
                } else {
                    @Suppress("DEPRECATION")
                    builder.setUserAuthenticationValidityDurationSeconds(30)
                }
                initialize(builder.build())
            }.generateKeyPair()
        }
        val publicKey = keyStore.getCertificate(alias).publicKey as ECPublicKey
        return JSONObject().put("kty", "EC").put("crv", "P-256")
            .put("x", encode(coordinate(publicKey.w.affineX)))
            .put("y", encode(coordinate(publicKey.w.affineY)))
    }

    fun commit(accountId: String, phone: String, credentialId: String) {
        check(keyStore.containsAlias(alias(accountId))) { "Recovery key unavailable. Sign in again to secure this device." }
        check(preferences.edit().putString("account:$phone", accountId)
            .putString("credential:$accountId", credentialId).commit()) { "Could not save device recovery details." }
    }

    fun hasCredential(phone: String): Boolean = account(phone)?.let { accountId ->
        preferences.contains("credential:$accountId") && keyStore.containsAlias(alias(accountId))
    } == true

    fun account(phone: String): String? = preferences.getString("account:$phone", null)

    fun forget(phone: String) {
        val accountId = account(phone) ?: return
        keyStore.deleteEntry(alias(accountId))
        preferences.edit().remove("account:$phone").remove("credential:$accountId").commit()
    }

    fun credentialId(phone: String): String {
        check(hasCredential(phone)) { "Device recovery is not set up. Sign in with your PIN/password or verified backup email, then secure this device." }
        return requireNotNull(preferences.getString("credential:${account(phone)}", null))
    }

    fun assertion(phone: String, challenge: JSONObject): JSONObject {
        val accountId = requireNotNull(account(phone)) { "No recovery key for this account on this device. Use verified backup email." }
        val credentialId = credentialId(phone)
        val privateKey = keyStore.getKey(alias(accountId), null)
            as? java.security.PrivateKey ?: error("Recovery key unavailable. Use verified backup email.")
        val info = KeyFactory.getInstance(privateKey.algorithm, "AndroidKeyStore")
            .getKeySpec(privateKey, KeyInfo::class.java)
        check(info.isUserAuthenticationRequired) { "Secure this device again before using device recovery." }
        val issuedAt = challenge.getLong("issuedAt")
        val nonce = challenge.getString("nonce")
        val payload = "grogoni-device-recovery:v1:$credentialId:$issuedAt:$nonce"
        val der = Signature.getInstance("SHA256withECDSA").run {
            initSign(privateKey); update(payload.toByteArray(Charsets.UTF_8)); sign()
        }
        return JSONObject().put("challengeId", challenge.getString("challengeId"))
            .put("credentialId", credentialId).put("issuedAt", issuedAt)
            .put("nonce", nonce).put("signature", encode(toP1363(der)))
    }

    companion object {
        private fun encode(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        private fun coordinate(value: BigInteger): ByteArray = value.toByteArray().let { bytes ->
            bytes.takeLast(32).toByteArray().let { ByteArray(32 - it.size) + it }
        }

        /** Android emits ASN.1 DER; the backend/WebCrypto contract expects fixed-width r || s. */
        fun toP1363(der: ByteArray): ByteArray {
            require(der.size in 8..72 && der[0].toInt() == 0x30 && der[1].toInt() == der.size - 2)
            var offset = 2
            fun integer(): ByteArray {
                require(offset + 2 <= der.size && der[offset++].toInt() == 2)
                val length = der[offset++].toInt() and 0xff
                require(length in 1..33 && offset + length <= der.size)
                val raw = der.copyOfRange(offset, offset + length); offset += length
                require(raw[0].toInt() >= 0)
                val bytes = if (raw.size > 1 && raw[0] == 0.toByte()) raw.drop(1).toByteArray() else raw
                require(bytes.size <= 32)
                return ByteArray(32 - bytes.size) + bytes
            }
            val result = integer() + integer()
            require(offset == der.size)
            return result
        }
    }
}
