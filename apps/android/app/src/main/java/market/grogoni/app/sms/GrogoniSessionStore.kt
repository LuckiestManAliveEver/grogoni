package market.grogoni.app.sms

import android.content.Context
import java.util.UUID
import android.webkit.CookieManager
import market.grogoni.app.BuildConfig

class GrogoniSessionStore(context: Context) {
    private val preferences = context.getSharedPreferences("grogoni-native-sms", Context.MODE_PRIVATE)
    private val secretBox = AndroidSecretBox()

    val deviceId: String
        get() = preferences.getString("device_id", null) ?: UUID.randomUUID().toString().also {
            preferences.edit().putString("device_id", it).apply()
        }

    val cookieHeader: String?
        get() = preferences.getString("auth_cookie", null)?.let(secretBox::decrypt)

    val accountId: String?
        get() = preferences.getString("account_id", null)

    val accountPhone: String?
        get() = preferences.getString("account_phone", null)

    fun saveAuthenticatedSession(accountId: String, phone: String, cookie: String) {
        val editor = preferences.edit()
        editor.remove("web_session_linked")
        // A newly authenticated account must never inherit another account's selected business.
        if (this.accountId != accountId) editor.remove("business_id").remove("sync_opt_in_v2")
        editor.putString("account_id", accountId).putString("account_phone", phone)
            .putString("auth_cookie", secretBox.encrypt(cookie)).commit()
    }

    var businessId: String?
        get() = preferences.getString("business_id", null)
        set(value) = preferences.edit().putString("business_id", value).apply()

    var syncEnabled: Boolean
        // Previous releases opted in implicitly. Require fresh, account-specific consent.
        get() = preferences.getBoolean("sync_opt_in_v2", false)
        set(value) { check(preferences.edit().putBoolean("sync_opt_in_v2", value).commit()) }

    var networkCountryIso: String?
        get() = preferences.getString("network_country", null)
        set(value) = preferences.edit().putString("network_country", value).apply()

    var webSessionLinked: Boolean
        get() = preferences.getBoolean("web_session_linked", false)
        set(value) { check(preferences.edit().putBoolean("web_session_linked", value).commit()) }

    fun readLinkedWebCookie() {
        if (!webSessionLinked) return
        val current = CookieManager.getInstance().getCookie("${BuildConfig.GROGONI_API_ORIGIN}/")
        if (current.isNullOrBlank()) clear()
        else if (current != cookieHeader) saveCookie(current)
    }

    fun saveCookie(cookieHeader: String) {
        preferences.edit().putString("auth_cookie", secretBox.encrypt(cookieHeader)).apply()
    }

    fun clear() {
        preferences.edit().remove("auth_cookie").remove("business_id").remove("account_id").remove("account_phone").remove("sync_opt_in_v2").remove("web_session_linked").commit()
    }

}
