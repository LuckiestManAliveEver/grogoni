package market.grogoni.app

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat

object AndroidPermissionPolicy {
    fun permissionSetForSdk(): Set<String> {
        val permissions = linkedSetOf<String>()

        permissions += Manifest.permission.CAMERA
        permissions += Manifest.permission.RECORD_AUDIO
        permissions += Manifest.permission.ACCESS_COARSE_LOCATION
        permissions += Manifest.permission.ACCESS_FINE_LOCATION
        // Native SMS does not need background location. Android 11+ rejects a
        // combined foreground/background location request; any future background
        // feature must request that access separately after foreground approval.
        permissions += Manifest.permission.FOREGROUND_SERVICE
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions += Manifest.permission.POST_NOTIFICATIONS
            permissions += Manifest.permission.READ_MEDIA_IMAGES
            permissions += Manifest.permission.READ_MEDIA_VIDEO
            permissions += Manifest.permission.READ_MEDIA_AUDIO
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                permissions += Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED
            }
        } else {
            permissions += Manifest.permission.READ_EXTERNAL_STORAGE
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
                permissions += Manifest.permission.WRITE_EXTERNAL_STORAGE
            }
        }
        permissions += Manifest.permission.READ_CONTACTS
        permissions += Manifest.permission.WRITE_CONTACTS
        permissions += Manifest.permission.READ_PHONE_STATE
        permissions += Manifest.permission.CALL_PHONE
        permissions += Manifest.permission.READ_CALL_LOG
        permissions += Manifest.permission.WRITE_CALL_LOG
        permissions += Manifest.permission.SEND_SMS
        permissions += Manifest.permission.RECEIVE_SMS
        permissions += Manifest.permission.READ_SMS
        // No WRITE_SMS: it is not a public SDK permission and is never granted to apps. The default
        // SMS role itself grants write access to the SMS provider.

        return permissions
    }

    fun grantedPermissions(context: Context): Set<String> = permissionSetForSdk().filter {
        ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED
    }.toSet()

    fun missingPermissions(context: Context): Set<String> = permissionSetForSdk() - grantedPermissions(context)
}
