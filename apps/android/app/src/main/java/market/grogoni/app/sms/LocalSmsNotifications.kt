package market.grogoni.app.sms

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import market.grogoni.app.MainActivity

object LocalSmsNotifications {
    fun show(context: Context, messageId: String, unsupportedMms: Boolean = false, storageFailure: Boolean = false, mms: Boolean = false) {
        if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(
            context, Manifest.permission.POST_NOTIFICATIONS,
        ) != PackageManager.PERMISSION_GRANTED) return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel("carrier-sms", "SMS messages", NotificationManager.IMPORTANCE_HIGH),
            )
        }
        val open = PendingIntent.getActivity(
            context, if (mms) 1 else 0, Intent(context, MainActivity::class.java).apply { if (mms) putExtra("channel", "mms") },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        // Keep sender and message content off the lock screen and out of notification history.
        manager.notify(messageId.hashCode(), NotificationCompat.Builder(context, "carrier-sms")
            .setSmallIcon(android.R.drawable.sym_action_chat)
            .setContentTitle(if (storageFailure) "Message storage needs attention" else if (unsupportedMms) "MMS could not be downloaded" else if (mms) "MMS update" else "New SMS")
            .setContentText(if (storageFailure) "A message needs attention. Open Grogoni to review storage, network and SIM settings." else if (unsupportedMms) "Choose an MMS-capable default app to receive multimedia messages." else if (mms) "Open the MMS inbox to download or review your message." else "Open Grogoni to read and reply.")
            .setContentIntent(open)
            .setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .build())
    }
}
