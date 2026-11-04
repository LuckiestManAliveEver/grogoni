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
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            assertTrue(permissions.contains(Manifest.permission.FOREGROUND_SERVICE))
        } else {
            assertFalse(permissions.contains(Manifest.permission.FOREGROUND_SERVICE))
        }
        assertTrue(permissions.contains(Manifest.permission.READ_CONTACTS))
        assertTrue(permissions.contains(Manifest.permission.READ_PHONE_STATE))
        assertTrue(permissions.contains(Manifest.permission.CALL_PHONE))
        assertTrue(permissions.contains(Manifest.permission.SEND_SMS))

        assertFalse(permissions.contains(Manifest.permission.ACCESS_BACKGROUND_LOCATION))
        assertFalse(permissions.contains("android.permission.READ_CALL_LOG"))
        assertFalse(permissions.contains("android.permission.WRITE_CALL_LOG"))

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
    @Test
    fun `restricted permissions are excluded until the SMS role is granted`() {
        val beforeRole = AndroidPermissionPolicy.requestablePermissions(false)
        val afterRole = AndroidPermissionPolicy.requestablePermissions(true)
        for (permission in setOf(
            Manifest.permission.SEND_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.RECEIVE_MMS,
            Manifest.permission.RECEIVE_WAP_PUSH,
            Manifest.permission.READ_SMS,
        )) {
            assertFalse(beforeRole.contains(permission))
            assertTrue(afterRole.contains(permission))
        }
        assertTrue(beforeRole.contains(Manifest.permission.CAMERA))
        assertTrue(beforeRole.contains(Manifest.permission.READ_CONTACTS))
    }

    @Test
    fun `permissions match API 23 28 30 33 and 34 capabilities`() {
        for (sdk in listOf(23, 28, 30, 33, 34)) {
            val permissions = AndroidPermissionPolicy.permissionSetForSdk(sdk)
            org.junit.Assert.assertEquals(sdk >= 28, Manifest.permission.FOREGROUND_SERVICE in permissions)
            org.junit.Assert.assertEquals(sdk >= 33, Manifest.permission.POST_NOTIFICATIONS in permissions)
            org.junit.Assert.assertEquals(sdk >= 34, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED in permissions)
            org.junit.Assert.assertEquals(sdk < 33, Manifest.permission.READ_EXTERNAL_STORAGE in permissions)
            org.junit.Assert.assertEquals(sdk < 29, Manifest.permission.WRITE_EXTERNAL_STORAGE in permissions)
        }
    }

}
