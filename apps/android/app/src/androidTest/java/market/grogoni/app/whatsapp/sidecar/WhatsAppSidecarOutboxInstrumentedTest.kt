package market.grogoni.app.whatsapp.sidecar

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import market.grogoni.app.sms.GrogoniSessionStore
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The outbound relay and the boot receiver on the device, against the packaged sidecar. No
 * WhatsApp account: a send to an unlinked business must come back `failed`, never `sent`, and
 * read receipts for it must send nothing.
 */
@RunWith(AndroidJUnit4::class)
class WhatsAppSidecarOutboxInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val wrapper = AndroidKeystoreWrapper("grogoni-whatsapp-sidecar-outbox-test-v1")

    @Test fun packagedSidecarAnswersOutboxFramesWithoutSendingAnything() {
        val reported = mutableListOf<Pair<String, String>>()
        val acks = mutableListOf<DeliveryResult>()
        val transport = object : OutboxTransport {
            override fun reportState(businessId: String, state: String) { reported += businessId to state }
            override fun pull(businessId: String) = OutboxPull(emptyList(), emptyList(), false)
            override fun ack(businessId: String, results: List<DeliveryResult>) { acks += results }
        }
        val controller = WhatsAppSidecarController(context, relay = { _, _ -> IngressOutcome.RETRY }, wrapper = wrapper, outbox = transport)
        val owner = "acct_outbox_test"
        try {
            controller.start(owner)
            val delivery = ClientSidecarDelivery { method, params, timeout -> controller.call(method, params, timeout) }
            val send = OutboxSend("send:m1", "claim-0001", "254711000001@s.whatsapp.net", "conv_1", "reply-1", "Karibu", OutboxQuote("3EB0Q1", null, false, "Hello?"))
            val result = delivery.deliver("biz_outbox", send)
            assertEquals("failed", result.outcome)
            assertEquals("CHANNEL_UNAVAILABLE", result.code)
            assertEquals(false, result.retryable)
            assertEquals("claim-0001", result.claimId)
            assertEquals(0, delivery.markRead("biz_outbox", OutboxReceipts("254711000001@s.whatsapp.net", listOf(OutboxReceiptKey("3EB0R1", "254711000001@s.whatsapp.net")))))
            // A real org.json round trip of the route payloads.
            val pulled = OutboxJson.pull(JSONObject("""{"sends":[{"id":"send:m2","claimId":"claim-0002","chat":"254711000002@s.whatsapp.net","conversationId":"c","idempotencyKey":"k","text":"Hi","quotedMessage":{"id":"Q","sender":null,"fromMe":true,"text":"t"}},{"id":"bad"}],"receipts":[{"chat":"x@s.whatsapp.net","keys":[{"id":"R","sender":"x@s.whatsapp.net"},{"id":""}]}],"more":true}"""))
            assertEquals(1, pulled.sends.size)
            assertNull(pulled.sends[0].quoted!!.sender)
            assertTrue(pulled.sends[0].quoted!!.fromMe)
            assertEquals(1, pulled.receipts.single().keys.size)
            assertTrue(pulled.more)
            val wire = OutboxJson.results(listOf(result)).getJSONObject(0)
            assertEquals("failed", wire.getString("outcome"))
            assertFalse(wire.has("deliveredId"))
            assertTrue(acks.isEmpty())
        } finally {
            controller.stop()
            controller.ownerDirectory(owner).deleteRecursively()
            runCatching { wrapper.deleteKey() }
        }
    }

    @Test fun bootStartsTheWorkerOnlyForTheEnabledSignedInOwner() {
        val session = GrogoniSessionStore(context)
        val previous = Triple(session.accountId, session.accountPhone, session.cookieHeader)
        val account = "acct_boot_test"
        if (android.os.Build.VERSION.SDK_INT >= 33)
            InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(context.packageName, "android.permission.POST_NOTIFICATIONS")
        val receiver = WhatsAppSidecarBootReceiver()
        val boot = Intent(SidecarBootPolicy.BOOT_COMPLETED)
        try {
            session.saveAuthenticatedSession(account, "254700000000", "grogoni_session=instrumented-boot")
            WhatsAppSidecar.setEnabled(context, null)
            receiver.onReceive(context, boot)
            Thread.sleep(3_000)
            assertFalse("off for this account: nothing starts", WhatsAppSidecar.controller(context).running)

            WhatsAppSidecar.setEnabled(context, account)
            session.clear()
            receiver.onReceive(context, boot)
            Thread.sleep(3_000)
            assertFalse("signed out: nothing starts", WhatsAppSidecar.controller(context).running)

            session.saveAuthenticatedSession(account, "254700000000", "grogoni_session=instrumented-boot")
            receiver.onReceive(context, Intent("android.intent.action.LOCKED_BOOT_COMPLETED"))
            Thread.sleep(3_000)
            assertFalse("other broadcasts are ignored", WhatsAppSidecar.controller(context).running)

            receiver.onReceive(context, boot)
            waitUntil(90_000) { WhatsAppSidecar.controller(context).running }
        } finally {
            WhatsAppSidecar.controller(context).stop()
            context.startService(Intent(context, WhatsAppSidecarService::class.java).setAction(WhatsAppSidecarService.ACTION_STOP))
            Thread.sleep(1_000)
            WhatsAppSidecar.setEnabled(context, null)
            WhatsAppSidecar.controller(context).ownerDirectory(account).deleteRecursively()
            session.clear()
            if (previous.first != null && previous.third != null)
                session.saveAuthenticatedSession(previous.first!!, previous.second.orEmpty(), previous.third!!)
        }
    }

    private fun waitUntil(timeoutMs: Long, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition()) {
            if (System.currentTimeMillis() > deadline) fail("condition not met within $timeoutMs ms")
            Thread.sleep(100)
        }
    }
}
