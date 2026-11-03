package market.grogoni.app.auth

import android.content.Context
import market.grogoni.app.sms.GrogoniSessionStore
import market.grogoni.app.sms.NativeApiClient
import market.grogoni.app.sms.NativeApiException
import market.grogoni.app.sms.NativeApiResponse
import org.json.JSONObject

/** Uses the same server proof, MFA and single-use reset contracts as the web client. */
class NativeAuthClient(
    context: Context,
    private val session: GrogoniSessionStore = GrogoniSessionStore(context),
    private val api: NativeApiClient = NativeApiClient(session),
    private val keys: DeviceRecoveryKey = DeviceRecoveryKey(context),
) {
    fun login(phone: String, secret: String, password: Boolean): JSONObject {
        require(secret.isNotBlank()) { "Enter your ${if (password) "password" else "PIN"}." }
        val path = if (password) "/auth/login/password" else "/auth/pin/login"
        val body = if (password) JSONObject().put("type", "phone").put("identifier", phone).put("password", secret)
            else JSONObject().put("method", "phone").put("contact", phone).put("pin", secret)
        return acceptSession(api.request("POST", path, body, authenticated = false))
    }

    fun verifyMfa(transactionId: String, factor: String, code: String): JSONObject = acceptSession(
        api.request("POST", "/auth/mfa/verify", JSONObject().put("transactionId", transactionId)
            .put("factor", factor).put("code", code), authenticated = false),
    )

    fun sendEmailMfa(transactionId: String) {
        api.request("POST", "/auth/mfa/email/challenge", JSONObject().put("transactionId", transactionId), authenticated = false)
    }

    fun secureDevice(): String {
        val accountId = requireNotNull(session.accountId) { "Sign in before securing this device." }
        val phone = requireNotNull(session.accountPhone) { "A phone account is required." }
        val response = api.request("POST", "/auth/continue", JSONObject().put("devicePublicKeyJwk", keys.publicJwk(accountId)).put("deviceSecurity", true),
            allowRefresh = false)
        require(response.body.getJSONObject("account").getString("id") == accountId) { "Account changed. Sign in again." }
        keys.commit(accountId, phone, response.body.getString("deviceRecoveryCredentialId"))
        return "This device is secured for PIN and password recovery. Keep your screen lock enabled."
    }

    fun revokeDevice(phone: String) {
        val credentialId = keys.credentialId(phone)
        api.request("DELETE", "/auth/device/credentials/$credentialId", allowRefresh = false)
        keys.forget(phone)
    }

    fun recoverDevice(phone: String): JSONObject {
        val expectedAccount = keys.account(phone)
            ?: error("No recovery key for this account on this device. Use verified backup email.")
        val credentialId = keys.credentialId(phone)
        val challenge = api.request("POST", "/auth/device/recover/options", JSONObject()
            .put("credentialId", credentialId).put("identifier", phone), authenticated = false).body
        val response = try {
            api.request("POST", "/auth/device/recover", keys.assertion(phone, challenge), authenticated = false)
        } catch (error: android.security.keystore.UserNotAuthenticatedException) {
            throw IllegalStateException("Device unlock expired. Unlock with device security again.", error)
        } catch (error: android.security.keystore.KeyPermanentlyInvalidatedException) {
            keys.forget(phone)
            throw IllegalStateException("Device recovery key is no longer usable. Use verified backup email, then secure this device again.", error)
        } catch (error: NativeApiException) {
            if (error.status == 401 || error.status == 404) keys.forget(phone)
            throw error
        }
        val account = response.body.getJSONObject("account")
        require(account.getString("id") == expectedAccount && account.getString("primaryAuthDestination") == phone) {
            "Recovery proof does not match this phone account."
        }
        acceptSession(response)
        return api.request("GET", "/auth/credentials/status", allowRefresh = false).body
    }

    fun resetDeviceSecret(value: String, confirmation: String, password: Boolean, hasPin: Boolean): JSONObject {
        validateSecret(value, confirmation, password)
        val path = if (password) "/auth/password/recover/device" else if (hasPin) "/auth/pin/recover/device" else "/auth/pin/setup"
        val body = if (password) JSONObject().put("password", value).put("passwordConfirmation", confirmation)
            else JSONObject().put("pin", value).put("pinConfirmation", confirmation)
        // Never refresh and replay a mutation whose one-use recovery proof may have expired.
        return acceptSession(api.request("POST", path, body, allowRefresh = false))
    }

    fun startEmailRecovery(email: String): JSONObject {
        require(android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches()) { "Enter your verified backup email address." }
        return api.request("POST", "/auth/recovery/start", JSONObject().put("type", "email").put("identifier", email), authenticated = false).body
    }

    fun verifyEmailRecovery(transactionId: String, code: String) {
        api.request("POST", "/auth/recovery/verify", JSONObject().put("transactionId", transactionId).put("code", code), authenticated = false)
    }

    fun resetEmailPassword(transactionId: String, password: String, confirmation: String, mfaCode: String): JSONObject {
        validateSecret(password, confirmation, true)
        return acceptSession(api.request("POST", "/auth/recovery/reset-password", JSONObject()
            .put("transactionId", transactionId).put("password", password).put("passwordConfirmation", confirmation)
            .apply { if (mfaCode.isNotBlank()) put("mfaCode", mfaCode) }, authenticated = false))
    }

    private fun acceptSession(response: NativeApiResponse): JSONObject {
        if (response.body.optBoolean("mfaRequired")) return response.body
        val account = response.body.getJSONObject("account")
        require(response.cookies.isNotBlank()) { "The server did not return a session. Sign in again." }
        session.saveAuthenticatedSession(account.getString("id"), account.getString("primaryAuthDestination"), response.cookies)
        return response.body
    }

    companion object {
        fun validateSecret(value: String, confirmation: String, password: Boolean) {
            require(value == confirmation) { "${if (password) "Passwords" else "PINs"} do not match." }
            if (password) require(value.length in 10..256) { "Use a password between 10 and 256 characters." }
            else require(Regex("[0-9]{4}").matches(value)) { "Enter a 4-digit PIN." }
        }
    }
}
