package market.grogoni.app

import android.Manifest
import android.os.Build
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AndroidPermissionPolicyTest {
    @Test
    fun `permission policy holds only what the app uses`() {
        val permissions = AndroidPermissionPolicy.permissionSetForSdk()

        assertTrue(permissions.contains(Manifest.permission.CAMERA))
        assertTrue(permissions.contains(Manifest.permission.ACCESS_COARSE_LOCATION))
        assertTrue(permissions.contains(Manifest.permission.ACCESS_FINE_LOCATION))
        assertTrue(permissions.contains(Manifest.permission.READ_CONTACTS))
        assertTrue(permissions.contains(Manifest.permission.READ_PHONE_STATE))
        assertTrue(permissions.contains(Manifest.permission.SEND_SMS))

        assertFalse(permissions.contains(Manifest.permission.ACCESS_BACKGROUND_LOCATION))
        assertFalse(permissions.contains("android.permission.READ_CALL_LOG"))
        assertFalse(permissions.contains("android.permission.WRITE_CALL_LOG"))
    }

    /** Declaring these without a core use is what Play review rejects. */
    @Test
    fun `unused sensitive permissions stay out on every API level`() {
        val unused = setOf(
            "android.permission.RECORD_AUDIO", "android.permission.FOREGROUND_SERVICE", "android.permission.READ_MEDIA_IMAGES",
            "android.permission.READ_MEDIA_VIDEO", "android.permission.READ_MEDIA_AUDIO",
            "android.permission.READ_MEDIA_VISUAL_USER_SELECTED", "android.permission.READ_EXTERNAL_STORAGE",
            "android.permission.WRITE_EXTERNAL_STORAGE", "android.permission.WRITE_CONTACTS", "android.permission.CALL_PHONE",
        )
        for (sdk in listOf(23, 28, 30, 33, 34, 35, 36)) {
            org.junit.Assert.assertEquals("sdk $sdk", emptySet<String>(), AndroidPermissionPolicy.permissionSetForSdk(sdk) intersect unused)
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
    fun `notifications are asked only where Android has the permission`() {
        for (sdk in listOf(23, 28, 30, 33, 34, 36)) {
            org.junit.Assert.assertEquals(sdk >= 33, Manifest.permission.POST_NOTIFICATIONS in AndroidPermissionPolicy.permissionSetForSdk(sdk))
        }
    }

}
