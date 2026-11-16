package market.grogoni.app.whatsapp.sidecar

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import java.util.concurrent.Executors
import market.grogoni.app.MainActivity
import market.grogoni.app.R
import market.grogoni.app.sms.GrogoniSessionStore

/** Process-wide handle shared by the service and the WebView bridge. */
object WhatsAppSidecar {
    @Volatile private var instance: WhatsAppSidecarController? = null

    fun controller(context: Context): WhatsAppSidecarController = instance ?: synchronized(this) {
        instance ?: WhatsAppSidecarController(
            context.applicationContext,
            WhatsAppSidecarController.apiRelay(context),
            outbox = WhatsAppSidecarController.apiOutbox(context),
        ).also {
            instance = it
            it.guard = { decision(context) == SidecarPolicy.RunDecision.Run }
        }
    }

    private fun preferences(context: Context) = context.applicationContext.getSharedPreferences("grogoni-whatsapp-sidecar", Context.MODE_PRIVATE)

    /** The account that turned the on-phone worker on. Off for every other account. */
    fun enabledAccount(context: Context): String? = preferences(context).getString("enabled_account", null)

    fun setEnabled(context: Context, accountId: String?) {
        check(preferences(context).edit().apply { if (accountId == null) remove("enabled_account") else putString("enabled_account", accountId) }.commit())
    }

    fun decision(context: Context): SidecarPolicy.RunDecision {
        val session = GrogoniSessionStore(context.applicationContext)
        return SidecarPolicy.shouldRun(
            sdk = Build.VERSION.SDK_INT,
            abis = Build.SUPPORTED_ABIS.toList(),
            runtimePresent = controller(context).runtimePresent,
            signedInAccount = session.accountId,
            hasSession = session.cookieHeader != null,
            enabledForAccount = enabledAccount(context),
        )
    }
}

/**
 * Foreground service that keeps the owner's linked WhatsApp session on this phone. Visible
 * notification with a Stop action; START_STICKY so Android brings it back after the app process
 * is killed; the controller restarts a crashed sidecar with backoff and stops it when idle.
 */
class WhatsAppSidecarService : Service() {
    private val worker = Executors.newSingleThreadExecutor { Thread(it, "whatsapp-sidecar-service").apply { isDaemon = true } }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        if (Build.VERSION.SDK_INT >= 26) {
            getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "WhatsApp on this phone", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while Grogoni keeps your linked WhatsApp running on this phone."
                    setShowBadge(false)
                },
            )
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val controller = WhatsAppSidecar.controller(this)
        if (intent?.action == ACTION_STOP) {
            worker.execute { controller.stop("user") }
            WhatsAppSidecar.setEnabled(this, null)
            stopForegroundCompat()
            stopSelf()
            return START_NOT_STICKY
        }
        if (!enterForeground("Starting WhatsApp on this phone")) {
            stopSelf()
            return START_NOT_STICKY
        }
        when (val decision = WhatsAppSidecar.decision(this)) {
            is SidecarPolicy.RunDecision.Refuse -> {
                worker.execute { controller.stop(decision.code) }
                stopForegroundCompat()
                stopSelf()
                return START_NOT_STICKY
            }
            SidecarPolicy.RunDecision.Run -> Unit
        }
        val account = GrogoniSessionStore(this).accountId!!
        controller.listener = object : WhatsAppSidecarController.Listener {
            override fun running(node: String) = notifyText("WhatsApp is linked through this phone")
            override fun gaveUp(crashes: Int) {
                notifyText("WhatsApp on this phone stopped after repeated failures. Open Grogoni to retry.")
                stopForegroundCompat(keepNotification = true)
                stopSelf()
            }
            override fun stopped(reason: String) {
                if (reason == "idle" || reason == "signed_out") {
                    stopForegroundCompat()
                    stopSelf()
                }
            }
            override fun vaultReset() = notifyText("This phone's WhatsApp link must be set up again.")
        }
        worker.execute {
            runCatching { controller.start(account) }.onFailure {
                notifyText("WhatsApp on this phone could not start. It will retry.")
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        worker.shutdown()
        super.onDestroy()
    }

    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 1, Intent(this, WhatsAppSidecarService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        return builder
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Grogoni")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(Notification.Action.Builder(null, "Stop", stop).build())
            .build()
    }

    private fun notifyText(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    private fun enterForeground(text: String): Boolean = try {
        if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, notification(text), ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        else startForeground(NOTIFICATION_ID, notification(text))
        true
    } catch (_: Exception) {
        // Android 12+ refuses some background starts (ForegroundServiceStartNotAllowedException).
        // The service stops; the next app launch starts it again.
        false
    }

    private fun stopForegroundCompat(keepNotification: Boolean = false) {
        if (Build.VERSION.SDK_INT >= 24) stopForeground(if (keepNotification) STOP_FOREGROUND_DETACH else STOP_FOREGROUND_REMOVE)
        else @Suppress("DEPRECATION") stopForeground(!keepNotification)
    }

    companion object {
        const val ACTION_STOP = "market.grogoni.app.whatsapp.sidecar.STOP"
        private const val CHANNEL = "whatsapp-sidecar"
        private const val NOTIFICATION_ID = 4107

        fun start(context: Context) {
            val intent = Intent(context, WhatsAppSidecarService::class.java)
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, WhatsAppSidecarService::class.java).setAction(ACTION_STOP))
        }

        /** From a foreground activity: bring the worker back if the owner left it on. */
        fun resumeIfEnabled(context: Context) {
            if (WhatsAppSidecar.decision(context) == SidecarPolicy.RunDecision.Run && !WhatsAppSidecar.controller(context).running)
                runCatching { start(context) }
        }
    }
}
