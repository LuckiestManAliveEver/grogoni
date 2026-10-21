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
        assertFalse(store.executionTimedOut("command-1"))
        assertTrue(store.executionTimedOut("command-1", System.currentTimeMillis() + 120_001L))
    }

    @Test
    fun acknowledgingSentDoesNotDeleteANewerDeliveryCallback() {
        val sent = PendingSmsResult("command-1", "sent", "SMS_SENT", null)
        store.enqueueResult(sent)
        val uploading = store.pendingResults().single()
        val delivered = PendingSmsResult("command-1", "delivered", "SMS_DELIVERED", null)
        store.enqueueResult(delivered)
        store.deletePendingResult(uploading)
        assertEquals(listOf(delivered), store.pendingResults())
        store.deletePendingResult(delivered)
        assertTrue(store.pendingResults().isEmpty())
    }

    @Test
    fun reconnectBacklogSurvivesReopeningAndDrainsAcrossBatches() {
        repeat(65) { index ->
            store.enqueueInbound(
                LocalInboundSms(
                    "event-$index", "business-1", "sms-$index", "+254712345678",
                    "Queued $index", "2026-10-21T14:00:00Z",
                ),
            )
        }
        store.claimCommand("interrupted-ack")
        store.close()
        store = NativeSmsStore(context)
        assertEquals(
            CommandReplayDecision.EXECUTE,
            commandReplayDecision(store.claimCommand("interrupted-ack"), store.commandState("interrupted-ack")),
        )
        val firstBatch = store.unsyncedInbound()
        assertEquals(50, firstBatch.size)
        firstBatch.forEach { store.markInboundSynced(it.eventId) }
        val secondBatch = store.unsyncedInbound()
        assertEquals(15, secondBatch.size)
        secondBatch.forEach { store.markInboundSynced(it.eventId) }
        assertTrue(store.unsyncedInbound().isEmpty())
    }

    @Test
    fun upgradingPendingResultsPreservesUnreportedReceipts() {
        store.close()
        context.openOrCreateDatabase("grogoni-native-sms.db", 0, null).use { db ->
            db.execSQL("create table pending_results (command_id text primary key, status text not null, result_code text not null, carrier_reference text)")
            db.execSQL("insert into pending_results values ('old-command', 'sent', 'SMS_SENT', null)")
            db.version = 3
        }
        store = NativeSmsStore(context)
        val receipt = store.pendingResults().single()
        assertEquals("old-command", receipt.commandId)
        store.deletePendingResult(receipt)
        assertTrue(store.pendingResults().isEmpty())
    }
}
