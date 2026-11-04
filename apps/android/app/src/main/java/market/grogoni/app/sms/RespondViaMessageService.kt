package market.grogoni.app.sms

import android.app.Service
import android.content.Intent
import android.os.IBinder
import java.util.UUID

class RespondViaMessageService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        runCatching {
            val data = intent?.data ?: return@runCatching
            val request = SmsComposeRequest.parse(data.scheme, data.encodedSchemeSpecificPart.orEmpty(),
                intent.getStringExtra(Intent.EXTRA_TEXT))
            if (request.recipient.isBlank() || request.body.isBlank()) return@runCatching
            val session = GrogoniSessionStore(this)
            val normalized = SmsDestination.normalize(request.recipient, session.networkCountryIso)
            val commandId = "local:${UUID.randomUUID()}"
            NativeSmsStore(this).use { store ->
                if (store.claimCommand(commandId)) {
                    store.markCommandExecutionStarted(commandId)
                    AndroidSmsSender(this).send(NativeSmsCommand(
                        commandId, normalized, request.body,
                        SmsSubscription.defaultId(),
                        reportToGrogoni = false,
                    ))
                }
            }
        }
        stopSelf(startId)
        return START_NOT_STICKY
    }
}
