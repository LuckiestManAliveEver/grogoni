package market.grogoni.app.whatsapp

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Targeted package visibility only; no account number, contacts, notification or storage access. */
class WhatsAppAvailability(private val context: Context) {
    fun installed(): List<String> = WhatsAppPackagePolicy.installed { name ->
        context.packageManager.getApplicationInfo(name, 0).enabled
    }
    fun snapshot(): JSONObject {
        val found = installed()
        return JSONObject().put("available", found.isNotEmpty()).put("packages", JSONArray(found))
    }
    // WhatsApp exposes a launcher intent. No supported Linked Devices deep link is assumed.
    fun open(): Boolean = installed().any { name ->
        val intent = context.packageManager.getLaunchIntentForPackage(name) ?: return@any false
        runCatching { context.startActivity(intent); true }.getOrDefault(false)
    }
}
