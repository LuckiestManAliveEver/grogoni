package market.grogoni.app.sms

import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.telephony.SubscriptionManager
import java.util.UUID

class RespondViaMessageService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val scheme = intent?.data?.scheme
        val recipient = intent?.data?.schemeSpecificPart?.substringBefore(',')
        val text = intent?.getStringExtra(Intent.EXTRA_TEXT)
        if (scheme in setOf("sms", "smsto") && !recipient.isNullOrBlank() && !text.isNullOrBlank()) {
            runCatching {
                val session = GrogoniSessionStore(this)
                val normalized = NativePhoneNormalizer.normalize(recipient, session.networkCountryIso)
                val commandId = "local:${UUID.randomUUID()}"
                val store = NativeSmsStore(this)
                if (store.claimCommand(commandId)) {
                    store.markCommandExecutionStarted(commandId)
                    AndroidSmsSender(this).send(
                        NativeSmsCommand(
                            commandId,
                            normalized,
                            text,
                            SubscriptionManager.getDefaultSmsSubscriptionId().takeIf {
                                it != SubscriptionManager.INVALID_SUBSCRIPTION_ID
                            },
                            reportToGrogoni = false,
                        ),
                    )
                }
            }
        }
        stopSelf(startId)
        return START_NOT_STICKY
    }
}
