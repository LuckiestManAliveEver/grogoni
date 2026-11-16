package market.grogoni.app.whatsapp.sidecar

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * After a reboot (or an app update, which also stops the service), brings the on-phone WhatsApp
 * worker back only when the owner had turned it on and is still the signed-in account
 * (SidecarPolicy.shouldRun). Otherwise it does nothing. Both broadcasts are exemptions from
 * Android 12+'s background foreground-service start limits, and Android 15's boot-start limits do
 * not cover the remoteMessaging type.
 */
class WhatsAppSidecarBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val decision = runCatching { WhatsAppSidecar.decision(context) }.getOrNull() ?: return
        if (SidecarBootPolicy.shouldStart(intent.action, decision))
            runCatching { WhatsAppSidecarService.start(context) }
    }
}

/** Pure rule for the boot receiver; JVM-tested in SidecarPolicyTest. */
object SidecarBootPolicy {
    const val BOOT_COMPLETED = "android.intent.action.BOOT_COMPLETED"
    const val MY_PACKAGE_REPLACED = "android.intent.action.MY_PACKAGE_REPLACED"

    fun shouldStart(action: String?, decision: SidecarPolicy.RunDecision): Boolean =
        (action == BOOT_COMPLETED || action == MY_PACKAGE_REPLACED) && decision == SidecarPolicy.RunDecision.Run
}
