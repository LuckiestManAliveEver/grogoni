package market.grogoni.app.sms

import android.Manifest
import android.app.role.RoleManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Telephony
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat

/**
 * Whether Grogoni is the default SMS app. On Android 10+ the role is the source of truth: on the
 * API 35 emulator Telephony.Sms.getDefaultSmsPackage returned null while the role was held and
 * every SMS permission was granted.
 */
object DefaultSmsRole {
    fun held(context: Context): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        context.getSystemService(RoleManager::class.java)?.isRoleHeld(RoleManager.ROLE_SMS) == true
    } else {
        Telephony.Sms.getDefaultSmsPackage(context) == context.packageName
    }
}

object NativeSmsCapability {
    fun inspect(context: Context): SmsCapabilityState {
        val roleManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            context.getSystemService(RoleManager::class.java)
        } else {
            null
        }
        val sendGranted = ContextCompat.checkSelfPermission(
            context, Manifest.permission.SEND_SMS,
        ) == PackageManager.PERMISSION_GRANTED
        val receiveGranted = ContextCompat.checkSelfPermission(
            context, Manifest.permission.RECEIVE_SMS,
        ) == PackageManager.PERMISSION_GRANTED
        val hasTelephony = context.packageManager.hasSystemFeature(
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                PackageManager.FEATURE_TELEPHONY_MESSAGING
            } else {
                PackageManager.FEATURE_TELEPHONY
            },
        )
        val roleAvailable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            roleManager?.isRoleAvailable(RoleManager.ROLE_SMS) == true
        } else {
            hasTelephony
        }
        val roleGranted = DefaultSmsRole.held(context)
        val subscriptionId = if (hasTelephony) {
            SmsSubscription.defaultId()
        } else {
            null
        }
        val networkCountry = context.getSystemService(TelephonyManager::class.java)
            ?.networkCountryIso?.takeIf(String::isNotBlank)
        GrogoniSessionStore(context).networkCountryIso = networkCountry
        return evaluate(
            roleAvailable = roleAvailable,
            roleGranted = roleGranted,
            sendPermissionGranted = sendGranted,
            receivePermissionGranted = receiveGranted,
            hasTelephony = hasTelephony,
            subscriptionId = subscriptionId,
        )
    }

    fun evaluate(
        roleAvailable: Boolean,
        roleGranted: Boolean,
        sendPermissionGranted: Boolean,
        receivePermissionGranted: Boolean,
        hasTelephony: Boolean,
        subscriptionId: Int?,
    ): SmsCapabilityState = SmsCapabilityState(
        roleAvailable = roleAvailable,
        roleGranted = roleGranted,
        sendPermissionGranted = sendPermissionGranted,
        receivePermissionGranted = receivePermissionGranted,
        simReady = hasTelephony && subscriptionId != null,
        subscriptionId = subscriptionId,
        errorCode = when {
            !hasTelephony -> "SMS_SIM_UNAVAILABLE"
            roleGranted && subscriptionId == null -> "SMS_SIM_SELECTION_REQUIRED"
            else -> null
        },
    )
}
