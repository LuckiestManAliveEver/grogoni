package market.grogoni.app.sms

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.ContentValues
import android.content.pm.PackageManager
import android.provider.Telephony
import androidx.core.content.ContextCompat

data class LocalSmsMessage(
    val id: Long,
    val address: String,
    val body: String,
    val date: Long,
    val type: Int,
    val read: Boolean,
)

/** Reads Android's local SMS provider only. No login, network, or agent runtime is involved. */
class LocalSmsInbox(private val context: Context) {
    fun recent(limit: Int = 100): List<LocalSmsMessage> {
        check(Telephony.Sms.getDefaultSmsPackage(context) == context.packageName) {
            "Make Grogoni the default SMS app to view messages."
        }
        check(ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED) {
            "Grant SMS access to view messages."
        }
        val messages = mutableListOf<LocalSmsMessage>()
        context.contentResolver.query(
            Telephony.Sms.CONTENT_URI,
            arrayOf("_id", "address", "body", "date", "type", "read"),
            null, null, "date desc, _id desc",
        )?.use { cursor ->
            while (messages.size < limit.coerceIn(1, 100) && cursor.moveToNext()) {
                messages += LocalSmsMessage(
                    cursor.getLong(0), cursor.getString(1).orEmpty(), cursor.getString(2).orEmpty(),
                    cursor.getLong(3), cursor.getInt(4), cursor.getInt(5) != 0,
                )
            }
        }
        return messages
    }

    fun markRead(message: LocalSmsMessage) {
        if (Telephony.Sms.getDefaultSmsPackage(context) != context.packageName) return
        context.contentResolver.update(
            ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI, message.id),
            ContentValues().apply { put(Telephony.Sms.READ, 1); put(Telephony.Sms.SEEN, 1) },
            null, null,
        )
    }
}
