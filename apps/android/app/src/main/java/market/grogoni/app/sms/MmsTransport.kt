package market.grogoni.app.sms

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Telephony
import android.telephony.SmsManager
import androidx.core.content.FileProvider
import com.example.android.mmslib.pdu.*
import java.io.File
import java.util.UUID

/** Android handles the carrier APN and HTTP transport. Message content stays on this device. */
class MmsTransport(private val context: Context) {
    companion object {
        const val MAX_BYTES = 300 * 1024
        private val LOCK = Any()
        val allowedTypes = setOf("image/jpeg", "image/png", "image/gif", "video/mp4", "audio/mpeg", "audio/ogg", "audio/amr", "text/plain", "application/smil")
    }

    private fun manager(subscription: Int): SmsManager {
        check(Telephony.Sms.getDefaultSmsPackage(context) == context.packageName) { "Make Grogoni the default SMS app first." }
        check(SmsSubscription.defaultId() == subscription) { "The selected SIM changed. Review the SMS SIM before retrying." }
        @Suppress("DEPRECATION")
        return SmsManager.getSmsManagerForSubscriptionId(subscription)
    }

    fun compose(recipients: List<String>, text: String, attachment: Uri?): ByteArray {
        require(recipients.isNotEmpty() && recipients.size <= 20) { "Enter between 1 and 20 MMS recipients." }
        val request = SendReq()
        request.to = recipients.map { EncodedStringValue(NativePhoneNormalizer.normalize(it, GrogoniSessionStore(context).networkCountryIso)) }.toTypedArray()
        request.date = System.currentTimeMillis() / 1000
        request.contentType = "application/vnd.wap.multipart.related".toByteArray()
        val body = PduBody()
        if (text.isNotBlank()) body.addPart(part("text/plain", text.toByteArray(Charsets.UTF_8), "text.txt"))
        if (attachment != null) {
            require(attachment.scheme == "content") { "Select an attachment through Android's document picker." }
            val type = context.contentResolver.getType(attachment) ?: error("Unknown attachment type.")
            require(type in allowedTypes && type != "application/smil") { "Unsupported MMS attachment type." }
            val bytes = context.contentResolver.openInputStream(attachment)!!.use { it.readBytesBounded() }
            body.addPart(part(type, bytes, "attachment"))
        }
        require(body.partsNum > 0) { "Enter text or select an attachment." }
        request.body = body
        return requireNotNull(PduComposer(context, request).make()).also {
            require(it.size <= MAX_BYTES) { "MMS exceeds 300 KiB. Choose a smaller attachment." }
        }
    }

    private fun part(type: String, bytes: ByteArray, name: String) = PduPart().apply {
        contentType = type.toByteArray(); data = bytes
        contentLocation = name.toByteArray(); contentId = name.toByteArray()
        if (type == "text/plain") charset = CharacterSets.UTF_8
    }

    fun send(recipients: List<String>, text: String, attachment: Uri?, subscription: Int) {
        val smsManager = manager(subscription)
        val bytes = compose(recipients, text, attachment)
        val pdu = requireNotNull(PduParser(bytes, true).parse()) as SendReq
        val row = persist(pdu, Telephony.Mms.MESSAGE_BOX_OUTBOX)
        val file = transferFile(UUID.randomUUID().toString()).apply { writeBytes(bytes) }
        saveTransfer(file, row, false)
        try {
            smsManager.sendMultimediaMessage(context, fileUri(file), null, null, callback(file, row, false))
        } catch (error: Exception) {
            setBox(row, Telephony.Mms.MESSAGE_BOX_DRAFTS)
            file.delete()
            forgetTransfer(file)
            throw error
        }
    }

    /** Persist the notification before offering a download; no automatic roaming/data charge. */
    fun receiveNotification(bytes: ByteArray, subscription: Int): Uri = synchronized(LOCK) {
        require(bytes.size <= MAX_BYTES)
        val pdu = PduParser(bytes, true).parse() as? NotificationInd ?: error("Invalid MMS notification.")
        val location = String(requireNotNull(pdu.contentLocation), Charsets.ISO_8859_1)
        val url = Uri.parse(location)
        require(url.scheme in setOf("http", "https") && !url.host.isNullOrBlank()) { "Invalid carrier MMS location." }
        val transaction = String(requireNotNull(pdu.transactionId), Charsets.ISO_8859_1)
        context.contentResolver.query(Telephony.Mms.CONTENT_URI, arrayOf("_id"), "tr_id = ? and ct_l = ?", arrayOf(transaction, location), null)?.use {
            if (it.moveToFirst()) {
                val existing = ContentUris.withAppendedId(Telephony.Mms.CONTENT_URI, it.getLong(0))
                ensureNotificationSender(existing, pdu)
                return@synchronized existing
            }
        }
        val row = requireNotNull(context.contentResolver.insert(Telephony.Mms.Inbox.CONTENT_URI, ContentValues().apply {
            put("m_type", PduHeaders.MESSAGE_TYPE_NOTIFICATION_IND)
            put("v", pdu.mmsVersion); put("tr_id", transaction); put("ct_l", location)
            put("date", System.currentTimeMillis() / 1000); put("read", 0); put("seen", 0)
            put("sub_id", subscription); put("m_size", pdu.messageSize)
        }))
        ensureNotificationSender(row, pdu)
        row
    }

    private fun ensureNotificationSender(row: Uri, pdu: NotificationInd) {
        val sender = pdu.from?.string ?: return
        val found = context.contentResolver.query(Uri.parse("content://mms/${ContentUris.parseId(row)}/addr"),
            arrayOf("address"), "address = ? and type = ?", arrayOf(sender, PduHeaders.FROM.toString()), null)
            ?.use { it.moveToFirst() } ?: false
        if (!found) saveAddress(row, sender, PduHeaders.FROM)
    }

    fun download(row: Uri, subscription: Int) {
        val smsManager = manager(subscription)
        val location = context.contentResolver.query(row, arrayOf("ct_l", "m_type", "sub_id"), null, null, null)!!.use {
            check(it.moveToFirst() && it.getInt(1) == PduHeaders.MESSAGE_TYPE_NOTIFICATION_IND)
            check(it.getInt(2) == subscription) { "Download using the SIM that received this MMS." }
            it.getString(0)
        }
        val file = transferFile("download-${ContentUris.parseId(row)}").apply { writeBytes(byteArrayOf()) }
        saveTransfer(file, row, true)
        smsManager.downloadMultimediaMessage(context, location, fileUri(file), null, callback(file, row, true))
    }

    fun complete(file: File, row: Uri, download: Boolean, success: Boolean) = synchronized(LOCK) {
        if (!success) {
            if (!download) setBox(row, Telephony.Mms.MESSAGE_BOX_DRAFTS)
            file.delete()
            forgetTransfer(file)
            return@synchronized
        }
        if (download) {
            val bytes = file.inputStream().use { it.readBytesBounded() }
            val pdu = PduParser(bytes, true).parse() as? RetrieveConf ?: error("Invalid downloaded MMS.")
            persist(pdu, Telephony.Mms.MESSAGE_BOX_INBOX, row)
        } else setBox(row, Telephony.Mms.MESSAGE_BOX_SENT)
        file.delete()
        forgetTransfer(file)
    }

    private val transfers get() = context.getSharedPreferences("mms-transfers", Context.MODE_PRIVATE)
    private fun saveTransfer(file: File, row: Uri, download: Boolean) {
        check(transfers.edit().putString(file.name, "${if (download) "download" else "send"}|$row|pending").commit())
    }
    private fun forgetTransfer(file: File) { check(transfers.edit().remove(file.name).commit()) }
    fun markReady(file: File) {
        val entry = transfers.getString(file.name, null) ?: error("Unknown MMS transfer.")
        check(transfers.edit().putString(file.name, entry.substringBeforeLast('|') + "|ready").commit())
    }
    /** A callback that survived carrier transport but failed local storage can be retried offline. */
    fun recoverCompletedTransfers() {
        for ((name, value) in transfers.all) {
            if (!name.matches(Regex("[a-zA-Z0-9-]+\\.pdu"))) continue
            val fields = (value as? String)?.split('|') ?: continue
            if (fields.size == 3 && fields[2] == "ready")
                complete(transferFile(name.removeSuffix(".pdu")), Uri.parse(fields[1]), fields[0] == "download", true)
        }
    }

    /** Reuse a pending notification row; publish its final type only after all parts are stored. */
    fun persist(pdu: MultimediaMessagePdu, box: Int, existing: Uri? = null): Uri = synchronized(LOCK) {
        val body = requireNotNull(pdu.body)
        require(body.partsNum in 1..30)
        var size = 0
        for (index in 0 until body.partsNum) {
            val part = body.getPart(index)
            val type = String(part.contentType, Charsets.ISO_8859_1).lowercase()
            require(type in allowedTypes) { "Unsupported MMS content type." }
            size += part.data?.size ?: 0
            require(size <= MAX_BYTES) { "MMS exceeds local size limit." }
        }
        val row = existing ?: requireNotNull(context.contentResolver.insert(Telephony.Mms.CONTENT_URI, ContentValues().apply {
            put("msg_box", Telephony.Mms.MESSAGE_BOX_DRAFTS); put("m_type", PduHeaders.MESSAGE_TYPE_NOTIFICATION_IND)
            put("date", System.currentTimeMillis() / 1000); put("read", if (box == Telephony.Mms.MESSAGE_BOX_INBOX) 0 else 1)
            put("sub_id", SmsSubscription.defaultId())
        }))
        val id = ContentUris.parseId(row)
        val partsUri = Uri.parse("content://mms/$id/part")
        val addressUri = Uri.parse("content://mms/$id/addr")
        try {
            context.contentResolver.delete(partsUri, null, null)
            context.contentResolver.delete(addressUri, null, null)
            pdu.from?.string?.let { saveAddress(row, it, PduHeaders.FROM) }
            pdu.to?.forEach { saveAddress(row, it.string, PduHeaders.TO) }
            if (pdu is RetrieveConf) pdu.cc?.forEach { saveAddress(row, it.string, PduHeaders.CC) }
            for (index in 0 until body.partsNum) {
                val part = body.getPart(index)
                val type = String(part.contentType, Charsets.ISO_8859_1).lowercase()
                val bytes = part.data ?: byteArrayOf()
                val uri = requireNotNull(context.contentResolver.insert(partsUri, ContentValues().apply {
                    put("ct", type); put("seq", index); put("chset", part.charset)
                    put("cl", "part-$index"); put("cid", "<part-$index>")
                    if (type == "text/plain" || type == "application/smil")
                        put("text", EncodedStringValue(part.charset.takeIf { it != 0 } ?: CharacterSets.UTF_8, bytes).string)
                }))
                if (type != "text/plain" && type != "application/smil")
                    requireNotNull(context.contentResolver.openOutputStream(uri)).use { it.write(bytes) }
            }
            check(context.contentResolver.update(row, ContentValues().apply {
                put("msg_box", box); put("m_type", pdu.messageType); put("v", pdu.mmsVersion)
                put("ct_t", "application/vnd.wap.multipart.related"); put("m_size", size)
                put("sub", pdu.subject?.string); put("sub_cs", CharacterSets.UTF_8)
            }, null, null) == 1)
            row
        } catch (error: Exception) {
            if (existing == null) context.contentResolver.delete(row, null, null)
            throw error
        }
    }

    private fun saveAddress(row: Uri, address: String, type: Int) {
        requireNotNull(context.contentResolver.insert(Uri.parse("content://mms/${ContentUris.parseId(row)}/addr"),
            ContentValues().apply { put("address", address); put("type", type); put("charset", CharacterSets.UTF_8) }))
    }
    private fun setBox(row: Uri, box: Int) {
        context.contentResolver.update(row, ContentValues().apply { put("msg_box", box) }, null, null)
    }
    private fun transferFile(id: String): File = File(context.filesDir, "mms-transfer").apply { mkdirs() }.resolve("$id.pdu")
    private fun fileUri(file: File): Uri = FileProvider.getUriForFile(context, "${context.packageName}.mms-files", file)
    private fun callback(file: File, row: Uri, download: Boolean): PendingIntent = PendingIntent.getBroadcast(context, 0,
        Intent(context, MmsResultReceiver::class.java).apply {
            data = row.buildUpon().appendQueryParameter("transfer", file.name).build()
            putExtra("file", file.name); putExtra("row", row.toString()); putExtra("download", download)
        }, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
}

private fun java.io.InputStream.readBytesBounded(): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (true) {
        val count = read(buffer)
        if (count < 0) break
        require(out.size() + count <= MmsTransport.MAX_BYTES) { "MMS exceeds 300 KiB." }
        out.write(buffer, 0, count)
    }
    return out.toByteArray()
}

class MmsResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val name = intent.getStringExtra("file") ?: return
        if (!name.matches(Regex("[a-zA-Z0-9-]+\\.pdu"))) return
        val row = Uri.parse(intent.getStringExtra("row") ?: return)
        if (row.scheme != "content" || row.authority != "mms") return
        val download = intent.getBooleanExtra("download", false)
        val response = intent.getByteArrayExtra(SmsManager.EXTRA_MMS_DATA)
        val accepted = download || response == null || runCatching {
            response.size <= MmsTransport.MAX_BYTES &&
                (PduParser(response, true).parse() as? SendConf)?.responseStatus == PduHeaders.RESPONSE_STATUS_OK
        }.getOrDefault(false)
        val success = resultCode == Activity.RESULT_OK && accepted
        val pending = goAsync()
        Thread {
            try {
                val transport = MmsTransport(context)
                val file = File(context.filesDir, "mms-transfer/$name")
                if (success) transport.markReady(file)
                transport.complete(file, row, download, success)
                LocalSmsNotifications.show(context, row.toString(), mms = true, storageFailure = !success)
            } catch (_: Exception) {
                // Keep the PDU file for explicit local recovery instead of discarding content.
                runCatching { LocalSmsNotifications.show(context, row.toString(), mms = true, storageFailure = true) }
            } finally { pending.finish() }
        }.start()
    }
}
