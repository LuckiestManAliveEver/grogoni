package market.grogoni.app.sms

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.provider.Telephony

class SmsSentResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val commandId = intent.getStringExtra("command_id") ?: return
        val index = intent.getIntExtra("segment_index", -1)
        val count = intent.getIntExtra("segment_count", 0)
        if (index < 0 || count <= 0) return
        val store = NativeSmsStore(context)
        val reportToGrogoni = intent.getBooleanExtra("report_to_grogoni", true)
        if (store.commandState(commandId) == "failed") return
        val code = NativeSmsResultMapper.sentResult(resultCode)
        val (reported, failed) = store.saveSegmentResult(commandId, "sent", index, count, code)
        if (failed) {
            store.markCommandTerminal(commandId, "failed", code)
            updateProviderMessage(context, store, commandId, Telephony.Sms.MESSAGE_TYPE_FAILED)
            if (reportToGrogoni) {
                store.enqueueResult(PendingSmsResult(commandId, "failed", code.name, null))
            }
        } else if (reported == count) {
            store.markCommandTerminal(commandId, "sent", NativeSmsErrorCode.SMS_SENT)
            updateProviderMessage(context, store, commandId, Telephony.Sms.MESSAGE_TYPE_SENT)
            if (reportToGrogoni) {
                store.enqueueResult(
                    PendingSmsResult(commandId, "sent", NativeSmsErrorCode.SMS_SENT.name, null),
                )
            }
        }
        if (reportToGrogoni) NativeSmsWork.schedule(context)
    }
}

private fun updateProviderMessage(
    context: Context,
    store: NativeSmsStore,
    commandId: String,
    messageType: Int,
) {
    val uri = store.providerMessageUri(commandId)?.let(Uri::parse) ?: return
    runCatching {
        context.contentResolver.update(
            uri,
            ContentValues().apply { put(Telephony.Sms.TYPE, messageType) },
            null,
            null,
        )
    }
}

class SmsDeliveryResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val commandId = intent.getStringExtra("command_id") ?: return
        val index = intent.getIntExtra("segment_index", -1)
        val count = intent.getIntExtra("segment_count", 0)
        if (index < 0 || count <= 0 || resultCode != Activity.RESULT_OK) return
        val store = NativeSmsStore(context)
        val reportToGrogoni = intent.getBooleanExtra("report_to_grogoni", true)
        if (store.commandState(commandId) == "failed") return
        val (reported, _) = store.saveSegmentResult(
            commandId, "delivered", index, count, NativeSmsErrorCode.SMS_DELIVERED,
        )
        if (reported == count) {
            store.markCommandTerminal(commandId, "delivered", NativeSmsErrorCode.SMS_DELIVERED)
            if (reportToGrogoni) {
                store.enqueueResult(
                    PendingSmsResult(
                        commandId, "delivered", NativeSmsErrorCode.SMS_DELIVERED.name, null,
                    ),
                )
                NativeSmsWork.schedule(context)
            }
        }
    }
}
