package market.grogoni.app.sms

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeSmsStoreInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()
    private lateinit var store: NativeSmsStore

    @Before
    fun setUp() {
        context.deleteDatabase("grogoni-native-sms.db")
        store = NativeSmsStore(context)
    }

    @After
    fun tearDown() {
        store.close()
        context.deleteDatabase("grogoni-native-sms.db")
    }

    @Test
    fun offlineInboundQueueAndCommandClaimsAreDurableAndIdempotent() {
        val inbound = LocalInboundSms(
            "event-1",
            "business-1",
            "sms-1",
            "+254712345678",
            "Offline message",
            "2026-08-13T14:00:00Z",
        )
        assertTrue(store.enqueueInbound(inbound))
        assertFalse(store.enqueueInbound(inbound))
        assertEquals(listOf(inbound), store.unsyncedInbound())
        store.markInboundSynced(inbound.eventId)
        assertTrue(store.unsyncedInbound().isEmpty())

        assertTrue(store.claimCommand("command-1"))
        assertFalse(store.claimCommand("command-1"))
        store.markCommandExecutionStarted("command-1")
        assertEquals("execution_started", store.commandState("command-1"))
    }
}
