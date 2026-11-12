package market.grogoni.app.whatsapp

import org.junit.Assert.assertEquals
import org.junit.Test

class WhatsAppPackagePolicyTest {
    @Test fun missingOrDisabledPackagesAreUnavailable() {
        assertEquals(emptyList<String>(), WhatsAppPackagePolicy.installed { false })
        assertEquals(emptyList<String>(), WhatsAppPackagePolicy.installed { throw IllegalArgumentException("missing") })
    }
    @Test fun businessAndPersonalInstallationsAreDiscoveredIndependently() {
        assertEquals(listOf("com.whatsapp.w4b"), WhatsAppPackagePolicy.installed { it == "com.whatsapp.w4b" })
        assertEquals(listOf("com.whatsapp", "com.whatsapp.w4b"), WhatsAppPackagePolicy.installed { true })
    }
    @Test fun oneMissingPackageDoesNotHideAnotherInstallation() {
        assertEquals(listOf("com.whatsapp.w4b"), WhatsAppPackagePolicy.installed {
            if (it == "com.whatsapp") throw IllegalArgumentException("not visible")
            true
        })
    }
}
