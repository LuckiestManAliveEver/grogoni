package market.grogoni.app.whatsapp.sidecar

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceOutboxTest {
    private fun send(id: String) = OutboxSend("send:$id", "claim-$id", "254711000001@s.whatsapp.net", "conv", "key-$id", "text $id")

    private class FakeTransport(val pulls: ArrayDeque<Any>) : OutboxTransport {
        val acks = mutableListOf<List<DeliveryResult>>()
        var ackError: Exception? = null
        override fun reportState(businessId: String, state: String) {}
        override fun pull(businessId: String): OutboxPull = when (val next = pulls.removeFirstOrNull() ?: OutboxPull(emptyList(), emptyList(), false)) {
            is OutboxPull -> next
            is Exception -> throw next
            else -> error("bad fixture")
        }
        override fun ack(businessId: String, results: List<DeliveryResult>) {
            ackError?.let { throw it }
            acks += results
        }
    }

    private class FakeSidecar(val answer: (OutboxSend) -> DeliveryResult?) : SidecarDelivery {
        val delivered = mutableListOf<String>()
        val receipts = mutableListOf<OutboxReceipts>()
        override fun deliver(businessId: String, send: OutboxSend): DeliveryResult {
            delivered += send.id
            return answer(send) ?: throw IllegalStateException("timeout")
        }
        override fun markRead(businessId: String, receipts: OutboxReceipts): Int {
            this.receipts += receipts
            return receipts.keys.size
        }
    }

    @Test fun deliversAcknowledgesAndFollowsMore() {
        val transport = FakeTransport(ArrayDeque(listOf(
            OutboxPull(listOf(send("a")), listOf(OutboxReceipts("c@s.whatsapp.net", listOf(OutboxReceiptKey("R1", "c@s.whatsapp.net")))), more = true),
            OutboxPull(listOf(send("b")), emptyList(), more = false),
        )))
        val sidecar = FakeSidecar { DeliveryResult(it.id, it.claimId, "sent", deliveredId = "WA-${it.id}") }
        val report = OutboxPump(transport, sidecar).drain("biz")
        assertEquals(PumpReport.Outcome.OK, report.outcome)
        assertEquals(2, report.delivered)
        assertEquals(1, report.receiptsSent)
        assertFalse(report.more)
        assertEquals(listOf("send:a", "send:b"), transport.acks.flatten().map { it.id })
        assertEquals("claim-a", transport.acks[0][0].claimId)
    }

    @Test fun neverAcknowledgesASendTheSidecarDidNotAnswer() {
        // The claim must time out and come back to this phone, whose journal decides.
        val transport = FakeTransport(ArrayDeque(listOf(OutboxPull(listOf(send("a"), send("b")), emptyList(), false))))
        val sidecar = FakeSidecar { if (it.id == "send:a") null else DeliveryResult(it.id, it.claimId, "uncertain", code = "WHATSAPP_DELIVERY_UNCERTAIN") }
        val report = OutboxPump(transport, sidecar).drain("biz")
        assertEquals(1, report.unanswered)
        assertEquals(listOf("send:b"), transport.acks.flatten().map { it.id })
        assertEquals("uncertain", transport.acks.flatten().single().outcome)
    }

    @Test fun classifiesServerAnswers() {
        fun outcome(status: Int?, code: String?) =
            OutboxPump(FakeTransport(ArrayDeque(listOf(OutboxApiException(status, code, "x")))), FakeSidecar { null }).drain("biz").outcome
        assertEquals(PumpReport.Outcome.NOT_HOSTING, outcome(409, "whatsapp_device_not_hosting"))
        assertEquals(PumpReport.Outcome.DENY, outcome(403, "permission_denied"))
        assertEquals(PumpReport.Outcome.DENY, outcome(410, "gone"))
        assertEquals(PumpReport.Outcome.ERROR, outcome(503, "unavailable"))
        assertEquals(PumpReport.Outcome.ERROR, outcome(null, null))
        assertEquals(PumpReport.Outcome.ERROR, outcome(429, "rate_limited"))
    }

    @Test fun aFailedAckIsAnErrorAndStopsTheRound() {
        val transport = FakeTransport(ArrayDeque(listOf(OutboxPull(listOf(send("a")), emptyList(), true))))
        transport.ackError = OutboxApiException(503, "down", "x")
        val sidecar = FakeSidecar { DeliveryResult(it.id, it.claimId, "sent", deliveredId = "WA") }
        val report = OutboxPump(transport, sidecar).drain("biz")
        assertEquals(PumpReport.Outcome.ERROR, report.outcome)
        assertEquals(listOf("send:a"), sidecar.delivered)
    }

    @Test fun pollsOnlyWhileConnectedFastAfterActivityAndBacksOff() {
        val now = 1_000_000L
        assertNull(OutboxPollPolicy.delayMs(0, now, now, 0, false))
        assertEquals(0L, OutboxPollPolicy.delayMs(1, now, null, 0, true))
        assertEquals(OutboxPollPolicy.ACTIVE_MS, OutboxPollPolicy.delayMs(1, now, now - 60_000, 0, false))
        assertEquals(OutboxPollPolicy.IDLE_MS, OutboxPollPolicy.delayMs(1, now, now - OutboxPollPolicy.ACTIVE_WINDOW_MS, 0, false))
        assertEquals(OutboxPollPolicy.IDLE_MS, OutboxPollPolicy.delayMs(1, now, null, 1, true))
        assertEquals(60_000L, OutboxPollPolicy.delayMs(1, now, null, 2, false))
        assertEquals(OutboxPollPolicy.MAX_BACKOFF_MS, OutboxPollPolicy.delayMs(1, now, null, 30, false))
        // A day of idle polling: the budget the battery notes in the architecture doc rely on.
        assertEquals(2_880L, 24 * 60 * 60_000L / OutboxPollPolicy.IDLE_MS)
    }

    @Test fun bootStartsOnlyAnEnabledSignedInOwnersWorker() {
        val run = SidecarPolicy.RunDecision.Run
        val off = SidecarPolicy.RunDecision.Refuse("off", "not_enabled")
        val signedOut = SidecarPolicy.RunDecision.Refuse("Sign in", "signed_out")
        assertTrue(SidecarBootPolicy.shouldStart(SidecarBootPolicy.BOOT_COMPLETED, run))
        assertTrue(SidecarBootPolicy.shouldStart(SidecarBootPolicy.MY_PACKAGE_REPLACED, run))
        assertFalse(SidecarBootPolicy.shouldStart(SidecarBootPolicy.BOOT_COMPLETED, off))
        assertFalse(SidecarBootPolicy.shouldStart(SidecarBootPolicy.BOOT_COMPLETED, signedOut))
        assertFalse(SidecarBootPolicy.shouldStart("android.intent.action.LOCKED_BOOT_COMPLETED", run))
        assertFalse(SidecarBootPolicy.shouldStart(null, run))
    }
}
