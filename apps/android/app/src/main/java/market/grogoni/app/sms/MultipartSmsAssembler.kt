package market.grogoni.app.sms

import android.provider.Telephony
import android.content.Intent
import java.security.MessageDigest
import java.time.Instant

object MultipartSmsAssembler {
    data class Assembled(val sender: String, val text: String, val timestampMillis: Long, val id: String)
    data class Part(val sender: String?, val body: String?, val timestampMillis: Long)

    fun fromIntent(intent: Intent): Assembled? {
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent).map {
            Part(it.originatingAddress, it.messageBody, it.timestampMillis)
        }
        return assemble(parts)
    }

    fun assemble(parts: List<Part>): Assembled? {
        if (parts.isEmpty()) return null
        val sender = parts.first().sender?.trim().orEmpty()
        if (sender.isEmpty() || parts.any { it.sender?.trim() != sender }) return null
        val timestamp = parts.minOf { it.timestampMillis }
        val body = parts.joinToString(separator = "") { it.body.orEmpty() }
        if (body.isBlank()) return null
        return Assembled(sender, body, timestamp, stableId(sender, timestamp, body))
    }

    fun stableId(sender: String, timestampMillis: Long, body: String): String {
        val bytes = MessageDigest.getInstance("SHA-256")
            .digest("native_sms:v1:$sender:$timestampMillis:$body".toByteArray())
        return bytes.joinToString("") { "%02x".format(it) }
    }

    fun occurredAt(timestampMillis: Long): String = Instant.ofEpochMilli(timestampMillis).toString()
}
