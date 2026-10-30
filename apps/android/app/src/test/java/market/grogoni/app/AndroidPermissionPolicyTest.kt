package market.grogoni.app

import android.Manifest
import android.os.Build
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidPermissionPolicyTest {
    @Test
    fun `permission policy includes the full native mobile API set exposed to Android apps`() {
        val permissions = AndroidPermissionPolicy.permissionSetForSdk()

        assertTrue(permissions.contains(Manifest.permission.CAMERA))
        assertTrue(permissions.contains(Manifest.permission.RECORD_AUDIO))
        assertTrue(permissions.contains(Manifest.permission.ACCESS_COARSE_LOCATION))
        assertTrue(permissions.contains(Manifest.permission.ACCESS_FINE_LOCATION))
        assertTrue(permissions.contains(Manifest.permission.FOREGROUND_SERVICE))
        assertTrue(permissions.contains(Manifest.permission.READ_CONTACTS))
        assertTrue(permissions.contains(Manifest.permission.READ_PHONE_STATE))
        assertTrue(permissions.contains(Manifest.permission.CALL_PHONE))
        assertTrue(permissions.contains(Manifest.permission.SEND_SMS))

        assertFalse(permissions.contains(Manifest.permission.ACCESS_BACKGROUND_LOCATION))

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            assertTrue(permissions.contains(Manifest.permission.POST_NOTIFICATIONS))
            assertTrue(permissions.contains(Manifest.permission.READ_MEDIA_IMAGES))
            assertTrue(permissions.contains(Manifest.permission.READ_MEDIA_VIDEO))
            assertTrue(permissions.contains(Manifest.permission.READ_MEDIA_AUDIO))
        } else {
            assertTrue(permissions.contains(Manifest.permission.READ_EXTERNAL_STORAGE))
        }
    }

    @Test
    fun `permission policy requests only permissions an app can be granted`() {
        val permissions = AndroidPermissionPolicy.permissionSetForSdk()

        // WRITE_SMS is hidden from the public SDK and never granted to apps; requesting it kept
        // "Grant native device permissions" enabled forever and broke compilation.
        assertFalse(permissions.contains("android.permission.WRITE_SMS"))
        assertTrue(permissions.contains(Manifest.permission.READ_SMS))
        assertTrue(permissions.contains(Manifest.permission.RECEIVE_SMS))
    }
}
