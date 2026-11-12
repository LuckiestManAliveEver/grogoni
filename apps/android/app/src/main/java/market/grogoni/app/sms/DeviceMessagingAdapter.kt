package market.grogoni.app.sms

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.provider.Telephony
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** OS capabilities only. The messenger interface and user workflow live in apps/web. */
class DeviceMessagingAdapter(private val context: Context) {
    fun capabilities(): JSONObject {
        val state = NativeSmsCapability.inspect(context)
        val session = GrogoniSessionStore(context)
        val permissions = market.grogoni.app.AndroidPermissionPolicy.grantedPermissions(context)
        val inboxReady = setOf(android.Manifest.permission.READ_SMS, android.Manifest.permission.RECEIVE_MMS,
            android.Manifest.permission.RECEIVE_WAP_PUSH).all { it in permissions }
        return JSONObject().put("available", state.roleAvailable).put("roleGranted", state.roleGranted)
            .put("ready", state.ready && inboxReady).put("subscriptionId", state.subscriptionId ?: JSONObject.NULL)
            .put("syncEnabled", session.syncEnabled).put("businessId", session.businessId ?: JSONObject.NULL)
            .put("accountId", session.accountId ?: JSONObject.NULL).put("errorCode", state.errorCode ?: JSONObject.NULL)
    }

    fun execute(method: String, params: JSONObject, webCookie: String?): Any = when (method) {
        "deviceSecurity" -> JSONObject().put("screenLock", context.getSystemService(android.app.KeyguardManager::class.java).isDeviceSecure)
        "prepareRecoveryKey" -> {
            val account = verifiedWebAccount(webCookie)
            market.grogoni.app.auth.DeviceRecoveryKey(context).let { key ->
                val id = account.getString("id")
                JSONObject().put("accountId", id).put("publicKeyJwk", key.publicJwk(id))
                    .put("attestationChain", key.attestationChain(id))
            }
        }
        "commitRecoveryKey" -> {
            val account = verifiedWebAccount(webCookie)
            val id = params.getString("credentialId"); require(id.isNotBlank() && id.length <= 256)
            market.grogoni.app.auth.DeviceRecoveryKey(context).commit(account.getString("id"), account.getString("primaryAuthDestination"), id)
            JSONObject()
        }
        "recoveryCredential" -> {
            val phone = params.getString("identifier")
            val keys = market.grogoni.app.auth.DeviceRecoveryKey(context)
            JSONObject().put("accountId", keys.account(phone)).put("credentialId", keys.credentialId(phone))
        }
        "signRecoveryChallenge" -> market.grogoni.app.auth.DeviceRecoveryKey(context).assertion(params.getString("identifier"), params.getJSONObject("challenge"))
        "capabilities" -> capabilities()
        "listContacts" -> listContacts()
        "listSms" -> {
            requireRole()
            val pending = IncomingSmsJournal(context).use { journal ->
                runCatching { journal.recover(context) }
                journal.pending()
            }
            val cursor = params.optJSONObject("before")?.let { LocalSmsMessage(it.getLong("id"), "", "", it.getLong("date"), 0, false) }
            val messages = LocalSmsInbox(context).page(before = cursor, query = params.optString("query", ""), address = params.optString("address").takeIf { it.isNotBlank() && it != "null" })
            JSONObject().put("messages", JSONArray(messages.map(::smsJson)))
                .put("hasMore", messages.size == 100)
                .put("pending", JSONArray(pending.map { JSONObject().put("sender", it.sender).put("text", it.text) }))
        }
        "markRead" -> {
            requireRole(); LocalSmsInbox(context).markRead(readSms(params.getLong("id"))); JSONObject()
        }
        "deleteSms" -> {
            requireRole(); val id = validId(params.getLong("id"))
            context.contentResolver.delete(ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI, id), null, null); JSONObject()
        }
        "sendSms" -> {
            requireRole()
            val recipients = params.getJSONArray("recipients")
            require(recipients.length() == 1) { "SMS requires one recipient. Choose MMS for groups." }
            val text = params.getString("text"); require(text.isNotBlank() && text.length <= 30_000)
            val session = GrogoniSessionStore(context)
            val recipient = SmsDestination.normalize(recipients.getString(0), session.networkCountryIso)
            val id = "local:${UUID.fromString(params.getString("id"))}"
            NativeSmsStore(context).use { store ->
                if (store.claimCommand(id)) {
                    store.markCommandExecutionStarted(id)
                    AndroidSmsSender(context).send(NativeSmsCommand(id, recipient, text, params.getInt("subscriptionId"), reportToGrogoni = false))
                }
                JSONObject().put("status", store.commandState(id))
            }
        }
        "listMms" -> listMms(params.optJSONObject("before"))
        "readMms" -> readMms(validId(params.getLong("id")))
        "deleteMms" -> {
            requireRole(); context.contentResolver.delete(ContentUris.withAppendedId(Telephony.Mms.CONTENT_URI, validId(params.getLong("id"))), null, null); JSONObject()
        }
        "sendMms" -> {
            requireRole()
            val recipients = params.getJSONArray("recipients")
            val text = params.getString("text"); require(text.length <= MmsTransport.MAX_BYTES)
            val attachment = params.optString("attachmentId").takeIf { it.isNotBlank() && it != "null" }?.let(::attachmentUri)
            MmsTransport(context).send((0 until recipients.length()).map { recipients.getString(it) }, text, attachment, params.getInt("subscriptionId"))
            JSONObject().put("status", "submitted")
        }
        "downloadMms" -> {
            requireRole(); MmsTransport(context).download(ContentUris.withAppendedId(Telephony.Mms.CONTENT_URI, validId(params.getLong("id"))), params.getInt("subscriptionId")); JSONObject()
        }
        "openAttachment" -> {
            requireRole(); openAttachment(params.getString("id")); JSONObject()
        }
        "recover" -> {
            requireRole(); IncomingSmsJournal.schedule(context)
            IncomingSmsJournal(context).use { it.recover(context) }; MmsTransport(context).recoverCompletedTransfers(); JSONObject()
        }
        "connectWebSession" -> {
            val cookie = requireNotNull(webCookie) { "Sign in through Grogoni first." }
            val session = GrogoniSessionStore(context)
            // Verify identity at the backend; never accept account IDs supplied by JavaScript.
            val result = HttpNativeApiTransport(session).execute("GET", "/auth/session", null, cookie)
            check(result.status == 200) { "Sign in through Grogoni before connecting this device." }
            val account = result.body.getJSONObject("account")
            session.saveAuthenticatedSession(account.getString("id"), account.optString("primaryAuthDestination", ""), cookie)
            session.webSessionLinked = true
            JSONObject().put("businesses", JSONArray(NativeSmsApiClient(context).businesses().map { JSONObject().put("id", it.first).put("name", it.second) }))
        }
        "chooseBusiness" -> {
            val id = params.getString("id")
            check(NativeSmsApiClient(context).businesses().any { it.first == id }) { "Business is not available to this account." }
            GrogoniSessionStore(context).businessId = id; capabilities()
        }
        "setBusinessFeatures" -> {
            val enabled = params.getBoolean("enabled")
            val session = GrogoniSessionStore(context)
            if (enabled) check(session.accountId != null && session.businessId != null && session.cookieHeader != null) { "Connect your account and select a business first." }
            session.syncEnabled = enabled
            if (enabled) NativeSmsWork.schedule(context) else NativeSmsWork.cancel(context)
            capabilities()
        }
        "shareSms" -> {
            val session = GrogoniSessionStore(context)
            check(session.syncEnabled && session.accountId != null && session.cookieHeader != null) { "Enable business sharing explicitly first." }
            val business = requireNotNull(session.businessId)
            val message = readSms(params.getLong("id"))
            check(message.type == Telephony.Sms.MESSAGE_TYPE_INBOX) { "Only received messages can be shared as inquiries." }
            val sender = NativePhoneNormalizer.normalize(message.address, session.networkCountryIso)
            val id = "manual:${message.id}"
            NativeSmsStore(context).use { it.enqueueInbound(LocalInboundSms("${session.deviceId}:$business:$id", business, id, sender, message.body, MultipartSmsAssembler.occurredAt(message.date))) }
            NativeSmsWork.schedule(context); JSONObject()
        }
        "disconnect" -> { GrogoniSessionStore(context).clear(); NativeSmsWork.cancel(context); capabilities() }
        else -> throw IllegalArgumentException("Unsupported device operation.")
    }

    private fun verifiedWebAccount(cookie: String?): JSONObject {
        val result = HttpNativeApiTransport(GrogoniSessionStore(context)).execute("GET", "/auth/session", null, requireNotNull(cookie) { "Sign in first." })
        check(result.status == 200) { "Sign in before securing this device." }
        return result.body.getJSONObject("account")
    }

    fun rememberAttachment(uri: Uri): JSONObject {
        require(uri.scheme == "content")
        val type = requireNotNull(context.contentResolver.getType(uri))
        require(type in MmsTransport.allowedTypes && type != "application/smil") { "Unsupported attachment type." }
        val id = UUID.randomUUID().toString()
        check(context.getSharedPreferences("device-attachments", Context.MODE_PRIVATE).edit().putString(id, uri.toString()).commit())
        val name = context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        } ?: "Attachment"
        return JSONObject().put("id", id).put("name", name).put("type", type)
    }
    private fun attachmentUri(id: String): Uri {
        if (id.startsWith("mms:")) { requireRole(); return Uri.parse("content://mms/part/${validId(id.removePrefix("mms:").toLong())}") }
        UUID.fromString(id)
        return Uri.parse(requireNotNull(context.getSharedPreferences("device-attachments", Context.MODE_PRIVATE).getString(id, null)) { "Select the attachment again." })
    }
    /** Phonebook names and numbers for display and recipient suggestions. Read only; nothing leaves the phone. */
    private fun listContacts(): JSONObject {
        check(androidx.core.content.ContextCompat.checkSelfPermission(context, android.Manifest.permission.READ_CONTACTS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED) { "Allow Phonebook access first." }
        val contacts = JSONArray()
        context.contentResolver.query(android.provider.ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            arrayOf(android.provider.ContactsContract.Contacts.DISPLAY_NAME_PRIMARY, android.provider.ContactsContract.CommonDataKinds.Phone.NUMBER,
                android.provider.ContactsContract.CommonDataKinds.Phone.NORMALIZED_NUMBER),
            null, null, "${android.provider.ContactsContract.Contacts.DISPLAY_NAME_PRIMARY} COLLATE NOCASE ASC")?.use {
            while (contacts.length() < MAX_CONTACTS && it.moveToNext()) {
                val name = it.getString(0)?.trim().orEmpty(); val number = it.getString(1)?.trim().orEmpty()
                // NORMALIZED_NUMBER was fixed when the contact was saved, so a later SIM swap cannot re-read it.
                if (name.isNotEmpty() && number.isNotEmpty()) contacts.put(JSONObject().put("name", name).put("phone", number)
                    .put("normalized", it.getString(2) ?: JSONObject.NULL))
            }
        }
        // The SIM that sends: on dual SIM the default subscription may be a different country.
        val telephony = context.getSystemService(android.telephony.TelephonyManager::class.java)?.let { manager ->
            val subscription = SmsSubscription.defaultId()
            if (subscription != null && android.os.Build.VERSION.SDK_INT >= 24) manager.createForSubscriptionId(subscription) else manager
        }
        val country = NativePhoneNormalizer.homeCountry(telephony?.simCountryIso)
        return JSONObject().put("contacts", contacts).put("country", country ?: JSONObject.NULL)
    }
    private fun requireRole() { check(DefaultSmsRole.held(context)) { "Make Grogoni the default SMS app first." } }
    private fun validId(id: Long) = id.also { require(it > 0) { "Invalid message ID." } }
    private fun smsJson(message: LocalSmsMessage) = JSONObject().put("id", message.id).put("address", message.address).put("body", message.body)
        .put("date", message.date).put("type", message.type).put("read", message.read)
    private fun readSms(id: Long): LocalSmsMessage {
        requireRole()
        return context.contentResolver.query(ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI, validId(id)), arrayOf("_id", "address", "body", "date", "type", "read"), null, null, null)!!.use {
            check(it.moveToFirst()) { "Message no longer exists." }
            LocalSmsMessage(it.getLong(0), it.getString(1).orEmpty(), it.getString(2).orEmpty(), it.getLong(3), it.getInt(4), it.getInt(5) != 0)
        }
    }
    private fun addresses(id: Long): JSONArray = context.contentResolver.query(Uri.parse("content://mms/$id/addr"), arrayOf("address"), null, null, null)!!.use { cursor ->
        val values = mutableListOf<String>()
        while (cursor.moveToNext()) cursor.getString(0)?.takeIf { it != "insert-address-token" }?.let(values::add)
        JSONArray(values.distinct())
    }
    private fun mmsJson(cursor: android.database.Cursor) = JSONObject().put("id", cursor.getLong(0)).put("date", cursor.getLong(1) * 1000)
        .put("type", cursor.getInt(2)).put("box", cursor.getInt(3)).put("subscriptionId", cursor.getInt(4)).put("addresses", addresses(cursor.getLong(0)))
    private fun listMms(before: JSONObject?): JSONObject {
        requireRole(); MmsTransport(context).recoverCompletedTransfers()
        val messages = JSONArray()
        context.contentResolver.query(Telephony.Mms.CONTENT_URI, arrayOf("_id", "date", "m_type", "msg_box", "sub_id"),
            if (before == null) null else "date < ? or (date = ? and _id < ?)",
            before?.let { arrayOf((it.getLong("date") / 1000).toString(), (it.getLong("date") / 1000).toString(), validId(it.getLong("id")).toString()) }, "date desc, _id desc")!!.use {
            while (messages.length() < 100 && it.moveToNext()) messages.put(mmsJson(it))
        }
        return JSONObject().put("messages", messages).put("hasMore", messages.length() == 100)
    }
    private fun readMms(id: Long): JSONObject {
        requireRole()
        val uri = ContentUris.withAppendedId(Telephony.Mms.CONTENT_URI, id)
        val message = context.contentResolver.query(uri, arrayOf("_id", "date", "m_type", "msg_box", "sub_id"), null, null, null)!!.use {
            check(it.moveToFirst()) { "Message no longer exists." }; mmsJson(it)
        }
        val text = StringBuilder(); val attachments = JSONArray()
        context.contentResolver.query(Uri.parse("content://mms/$id/part"), arrayOf("_id", "ct", "text"), null, null, "seq asc")!!.use {
            while (it.moveToNext()) {
                val type = it.getString(1)
                if (type == "text/plain") text.append(it.getString(2).orEmpty()).append('\n')
                else if (type != "application/smil") attachments.put(JSONObject().put("id", "mms:${it.getLong(0)}").put("name", "Attachment").put("type", type))
            }
        }
        context.contentResolver.update(uri, ContentValues().apply { put("read", 1); put("seen", 1) }, null, null)
        return message.put("body", text.toString()).put("attachments", attachments)
    }
    private fun openAttachment(id: String) {
        val uri = attachmentUri(id)
        val type = requireNotNull(context.contentResolver.getType(uri))
        require(type in MmsTransport.allowedTypes && type != "application/smil")
        val file = File(context.cacheDir, "mms-view").apply { mkdirs() }.resolve(UUID.randomUUID().toString())
        context.contentResolver.openInputStream(uri)!!.use { input -> file.outputStream().use { output ->
            val buffer = ByteArray(8192); var total = 0
            while (true) { val size = input.read(buffer); if (size < 0) break; total += size; require(total <= MmsTransport.MAX_BYTES); output.write(buffer, 0, size) }
        } }
        val shared = FileProvider.getUriForFile(context, "${context.packageName}.mms-files", file)
        context.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(shared, type).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    private companion object { const val MAX_CONTACTS = 5_000 }
}
