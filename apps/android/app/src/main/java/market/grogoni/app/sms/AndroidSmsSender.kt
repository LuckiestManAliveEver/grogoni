package market.grogoni.app.sms

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.telephony.SmsManager
import android.provider.Telephony
import androidx.core.content.ContextCompat

class NativeSmsSendException(val code: NativeSmsErrorCode) : Exception(code.name)

class AndroidSmsSender(private val context: Context) {
    fun send(command: NativeSmsCommand) {
        try {
            sendChecked(command)
        } catch (error: Exception) {
            NativeSmsStore(context).use { store ->
                val code = (error as? NativeSmsSendException)?.code ?: NativeSmsErrorCode.SMS_SEND_FAILED
                store.markCommandTerminal(command.id, "failed", code)
                store.providerMessageUri(command.id)?.let { uri ->
                    runCatching { context.contentResolver.update(
                        android.net.Uri.parse(uri),
                        ContentValues().apply { put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_FAILED) }, null, null,
                    ) }
                }
            }
            throw error
        }
    }

    @Suppress("DEPRECATION")
    private fun sendChecked(command: NativeSmsCommand) {
        if (Telephony.Sms.getDefaultSmsPackage(context) != context.packageName) {
            throw NativeSmsSendException(NativeSmsErrorCode.SMS_ROLE_REQUIRED)
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            throw NativeSmsSendException(NativeSmsErrorCode.SMS_PERMISSION_REQUIRED)
        }
        val currentSubscription = SmsSubscription.defaultId() ?: throw NativeSmsSendException(NativeSmsErrorCode.SMS_SIM_SELECTION_REQUIRED)
        if (command.subscriptionId != null && command.subscriptionId != currentSubscription) {
            throw NativeSmsSendException(NativeSmsErrorCode.SMS_SIM_SELECTION_REQUIRED)
        }
        val manager = SmsManager.getSmsManagerForSubscriptionId(currentSubscription)
        val parts = manager.divideMessage(command.text)
        if (parts.isEmpty()) throw NativeSmsSendException(NativeSmsErrorCode.SMS_SEND_FAILED)
        persistOutbox(command)
        val sent = ArrayList<PendingIntent>(parts.size)
        val delivered = ArrayList<PendingIntent>(parts.size)
        parts.indices.forEach { index ->
            sent += callback(
                SmsSentResultReceiver::class.java,
                "market.grogoni.app.SMS_SENT",
                command.id,
                index,
                parts.size,
                command.reportToGrogoni,
            )
            delivered += callback(
                SmsDeliveryResultReceiver::class.java,
                "market.grogoni.app.SMS_DELIVERED",
                command.id,
                index,
                parts.size,
                command.reportToGrogoni,
            )
        }
        manager.sendMultipartTextMessage(command.recipient, null, parts, sent, delivered)
    }

    private fun persistOutbox(command: NativeSmsCommand) {
        val uri = context.contentResolver.insert(
            Telephony.Sms.Outbox.CONTENT_URI,
            ContentValues().apply {
                put(Telephony.Sms.ADDRESS, command.recipient)
                put(Telephony.Sms.BODY, command.text)
                put(Telephony.Sms.DATE, System.currentTimeMillis())
                put(Telephony.Sms.READ, 1)
                put(Telephony.Sms.SEEN, 1)
                put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_OUTBOX)
            },
        ) ?: throw NativeSmsSendException(NativeSmsErrorCode.SMS_SEND_FAILED)
        NativeSmsStore(context).use { it.saveProviderMessageUri(command.id, uri.toString()) }
    }

    private fun callback(
        receiver: Class<*>,
        action: String,
        commandId: String,
        index: Int,
        count: Int,
        reportToGrogoni: Boolean,
    ): PendingIntent {
        val intent = Intent(context, receiver).apply {
            this.action = action
            data = android.net.Uri.Builder().scheme("grogoni-sms").authority("result")
                .appendPath(action).appendPath(commandId).appendPath(index.toString()).build()
            putExtra("command_id", commandId)
            putExtra("segment_index", index)
            putExtra("segment_count", count)
            putExtra("report_to_grogoni", reportToGrogoni)
        }
        return PendingIntent.getBroadcast(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }
}
