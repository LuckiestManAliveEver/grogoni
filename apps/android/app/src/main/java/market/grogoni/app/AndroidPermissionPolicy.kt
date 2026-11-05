package market.grogoni.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

object AndroidPermissionPolicy {
    fun permissionSetForSdk(sdk: Int = Build.VERSION.SDK_INT): Set<String> {
        val permissions = linkedSetOf<String>()

        // Play review checks declared permissions against real use, so this set and the manifest list
        // only what code uses. Attachments use the system picker and need no media permission.
        permissions += Manifest.permission.CAMERA
        permissions += Manifest.permission.ACCESS_COARSE_LOCATION
        permissions += Manifest.permission.ACCESS_FINE_LOCATION
        // Native SMS does not need background location. Android 11+ rejects a
        // combined foreground/background location request; any future background
        // feature must request that access separately after foreground approval.
        if (sdk >= Build.VERSION_CODES.TIRAMISU) permissions += Manifest.permission.POST_NOTIFICATIONS
        permissions += Manifest.permission.READ_CONTACTS
        permissions += Manifest.permission.READ_PHONE_STATE
        permissions += Manifest.permission.SEND_SMS
        permissions += Manifest.permission.RECEIVE_MMS
        permissions += Manifest.permission.RECEIVE_WAP_PUSH
        permissions += Manifest.permission.RECEIVE_SMS
        permissions += Manifest.permission.READ_SMS
        // No WRITE_SMS: it is not a public SDK permission and is never granted to apps. The default
        // SMS role itself grants write access to the SMS provider.

        return permissions
    }

    // SMS and call-log permissions must follow the default-handler grant, including
    // requests made through the separate device-permissions button.
    fun requestablePermissions(smsRoleGranted: Boolean): Set<String> {
        val restricted = setOf(
            Manifest.permission.SEND_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.RECEIVE_MMS,
            Manifest.permission.RECEIVE_WAP_PUSH,
            Manifest.permission.READ_SMS,
        )
        return permissionSetForSdk().filter { smsRoleGranted || it !in restricted }.toSet()
    }

    fun grantedPermissions(context: Context): Set<String> = permissionSetForSdk().filter {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }.toSet()

    fun missingPermissions(context: Context): Set<String> = permissionSetForSdk() - grantedPermissions(context)
}
