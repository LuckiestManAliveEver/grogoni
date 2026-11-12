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
        return page(limit)
    }

    fun page(limit: Int = 100, before: LocalSmsMessage? = null, query: String = "", address: String? = null): List<LocalSmsMessage> {
        check(DefaultSmsRole.held(context)) {
            "Make Grogoni the default SMS app to view messages."
        }
        check(ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED) {
            "Grant SMS access to view messages."
        }
        val messages = mutableListOf<LocalSmsMessage>()
        val clauses = mutableListOf<String>()
        val args = mutableListOf<String>()
        if (before != null) {
            clauses += "(date < ? or (date = ? and _id < ?))"
            args += listOf(before.date.toString(), before.date.toString(), before.id.toString())
        }
        if (address != null) { clauses += "address = ?"; args += address }
        if (query.isNotBlank()) {
            clauses += "(instr(lower(coalesce(address, '')), lower(?)) > 0 or instr(lower(coalesce(body, '')), lower(?)) > 0)"
            args += listOf(query, query)
        }
        context.contentResolver.query(
            Telephony.Sms.CONTENT_URI,
            arrayOf("_id", "address", "body", "date", "type", "read"),
            clauses.takeIf { it.isNotEmpty() }?.joinToString(" and "), args.toTypedArray(), "date desc, _id desc",
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
        if (!DefaultSmsRole.held(context)) return
        context.contentResolver.update(
            ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI, message.id),
            ContentValues().apply { put(Telephony.Sms.READ, 1); put(Telephony.Sms.SEEN, 1) },
            null, null,
        )
    }
}
