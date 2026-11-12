package market.grogoni.app.sms

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Telephony

class NativeSmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_DELIVER_ACTION) return
        if (!DefaultSmsRole.held(context)) return
        val sms = MultipartSmsAssembler.fromIntent(intent) ?: return
        val pending = goAsync()
        executor.execute {
            try {
                IncomingSmsJournal(context).use { journal ->
                    journal.record(sms)
                    IncomingSmsJournal.schedule(context)
                    journal.recover(context)
                }
                LocalSmsNotifications.show(context, sms.id)
                // Personal messages are never automatically forwarded to a business or agent.
            } catch (error: Exception) {
                android.util.Log.e("GrogoniSms", "Incoming SMS storage needs recovery: ${error.javaClass.simpleName}")
                runCatching { IncomingSmsJournal.schedule(context) }
                runCatching { LocalSmsNotifications.show(context, sms.id, storageFailure = true) }
            } finally { pending.finish() }
        }
    }

    companion object { private val executor = java.util.concurrent.Executors.newSingleThreadExecutor() }

}

class DefaultSmsRoleChangedReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Telephony.Sms.Intents.ACTION_DEFAULT_SMS_PACKAGE_CHANGED) {
            if (DefaultSmsRole.held(context)) IncomingSmsJournal.schedule(context)
            NativeSmsWork.schedule(context)
        }
    }
}

/** Persist carrier notifications locally; downloads require explicit user consent. */
class MmsRoleReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.WAP_PUSH_DELIVER_ACTION ||
            !DefaultSmsRole.held(context)) return
        val data = intent.getByteArrayExtra("data") ?: return
        val subscription = intent.getIntExtra("subscription", SmsSubscription.defaultId() ?: -1)
        val pending = goAsync()
        Thread {
            try {
                IncomingSmsJournal(context).use {
                    it.recordMms(data, subscription)
                    IncomingSmsJournal.schedule(context)
                    it.recover(context)
                }
                LocalSmsNotifications.show(context, "incoming-mms", mms = true)
            } catch (_: Exception) {
                runCatching { LocalSmsNotifications.show(context, "mms-storage-failed", storageFailure = true, mms = true) }
            } finally { pending.finish() }
        }.start()
    }
}
