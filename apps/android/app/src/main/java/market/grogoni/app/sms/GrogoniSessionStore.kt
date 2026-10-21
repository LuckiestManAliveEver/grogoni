package market.grogoni.app.sms

import android.content.Context
import java.util.UUID

class GrogoniSessionStore(context: Context) {
    private val preferences = context.getSharedPreferences("grogoni-native-sms", Context.MODE_PRIVATE)
    private val secretBox = AndroidSecretBox()

    val deviceId: String
        get() = preferences.getString("device_id", null) ?: UUID.randomUUID().toString().also {
            preferences.edit().putString("device_id", it).apply()
        }

    val cookieHeader: String?
        get() = preferences.getString("auth_cookie", null)?.let(secretBox::decrypt)

    var businessId: String?
        get() = preferences.getString("business_id", null)
        set(value) = preferences.edit().putString("business_id", value).apply()

    var syncEnabled: Boolean
        get() = preferences.getBoolean("sync_enabled", true)
        set(value) = preferences.edit().putBoolean("sync_enabled", value).apply()

    var networkCountryIso: String?
        get() = preferences.getString("network_country", null)
        set(value) = preferences.edit().putString("network_country", value).apply()

    fun saveCookie(cookieHeader: String) {
        preferences.edit().putString("auth_cookie", secretBox.encrypt(cookieHeader)).apply()
    }

    fun clear() {
        preferences.edit().remove("auth_cookie").remove("business_id").apply()
    }

}
