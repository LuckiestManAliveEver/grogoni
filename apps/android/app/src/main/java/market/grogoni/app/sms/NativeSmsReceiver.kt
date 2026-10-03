package market.grogoni.app.sms

import android.content.BroadcastReceiver
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class NativeSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_DELIVER_ACTION) return
        val sms = MultipartSmsAssembler.fromIntent(intent) ?: return
        persistForDefaultSmsRole(context, sms)
        val session = GrogoniSessionStore(context)
        val businessId = session.businessId ?: return
        val sender = runCatching {
            NativePhoneNormalizer.normalize(sms.sender, session.networkCountryIso)
        }.getOrNull() ?: return
        val event = LocalInboundSms(
            eventId = "${session.deviceId}:${sms.id}",
            businessId = businessId,
            externalMessageId = sms.id,
            senderE164 = sender,
            text = sms.text,
            occurredAt = MultipartSmsAssembler.occurredAt(sms.timestampMillis),
        )
        if (NativeSmsStore(context).enqueueInbound(event)) NativeSmsWork.schedule(context)
    }

    private fun persistForDefaultSmsRole(context: Context, sms: MultipartSmsAssembler.Assembled) {
        val values = ContentValues().apply {
            put(Telephony.Sms.ADDRESS, sms.sender)
            put(Telephony.Sms.BODY, sms.text)
            put(Telephony.Sms.DATE, sms.timestampMillis)
            put(Telephony.Sms.READ, 0)
            put(Telephony.Sms.SEEN, 0)
            put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_INBOX)
        }
        runCatching { context.contentResolver.insert(Telephony.Sms.Inbox.CONTENT_URI, values) }
    }
}

class DefaultSmsRoleChangedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Telephony.Sms.Intents.ACTION_DEFAULT_SMS_PACKAGE_CHANGED) {
            NativeSmsWork.schedule(context)
        }
    }
}

/** MMS is outside this feature. The receiver is declared only to satisfy Android SMS-role shape. */
class MmsRoleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = Unit
}
