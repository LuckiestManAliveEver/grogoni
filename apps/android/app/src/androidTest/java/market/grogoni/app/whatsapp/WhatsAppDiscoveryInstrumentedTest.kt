package market.grogoni.app.whatsapp

import android.Manifest
import android.content.pm.PackageManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import market.grogoni.app.MainActivity
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Emulator fixture installs the official WhatsApp APK. No account, OTP or app storage is read. */
@RunWith(AndroidJUnit4::class)
class WhatsAppDiscoveryInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    @Test fun detectsTheRealInstalledWhatsAppThroughTargetedVisibility() {
        val discovery = WhatsAppAvailability(context)
        assertTrue("Install the official WhatsApp APK in this test emulator", discovery.installed().contains("com.whatsapp"))
        assertTrue(discovery.snapshot().getBoolean("available"))
        val permissions = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions.orEmpty()
        assertFalse(permissions.contains("android.permission.QUERY_ALL_PACKAGES"))
    }
    @Test fun discoveryDoesNotAcquireContactsOrNotificationPermissions() {
        val contacts = context.checkSelfPermission(Manifest.permission.READ_CONTACTS)
        val notifications = context.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
        repeat(3) { WhatsAppAvailability(context).snapshot() }
        assertEquals(contacts, context.checkSelfPermission(Manifest.permission.READ_CONTACTS))
        assertEquals(notifications, context.checkSelfPermission("android.permission.POST_NOTIFICATIONS"))
    }
    @Test fun opensWhatsAppUsingItsOrdinaryLauncherIntent() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { assertTrue(WhatsAppAvailability(it).open()) }
        }
    }
}
