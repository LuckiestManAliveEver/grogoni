package market.grogoni.app.sms

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.Telephony
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class MessengerReadinessInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test fun emulatedSmsBroadcastIsStoredLocallyWithoutBackendCopy() {
        assertEquals(context.packageName, Telephony.Sms.getDefaultSmsPackage(context))
        val text = "grogoni-emulator-private-sms-20261103"
        if (androidx.test.platform.app.InstrumentationRegistry.getArguments().getString("stage") == "prepare") {
            contentResolver().delete(Telephony.Sms.CONTENT_URI, "body = ?", arrayOf(text))
            GrogoniSessionStore(context).apply {
                saveAuthenticatedSession("emulator-privacy-account", "+15551234567", "emulator-only=invalid")
                businessId = "emulator-privacy-business"
                syncEnabled = true
            }
            return
        }
        val message = LocalSmsInbox(context).page(query = text).single()
        assertEquals(text, message.body)
        assertEquals(Telephony.Sms.MESSAGE_TYPE_INBOX, message.type)
        NativeSmsStore(context).use { store ->
            assertTrue(store.unsyncedInbound().none { it.text == text })
        }
    }

    private fun contentResolver() = context.contentResolver

    @Test fun freshAndLegacySessionsRequireExplicitSyncConsent() {
        val preferences = context.getSharedPreferences("grogoni-native-sms", Context.MODE_PRIVATE)
        GrogoniSessionStore(context).clear()
        preferences.edit().putBoolean("sync_enabled", true).commit()
        assertFalse(GrogoniSessionStore(context).syncEnabled)
        GrogoniSessionStore(context).syncEnabled = true
        assertTrue(GrogoniSessionStore(context).syncEnabled)
        GrogoniSessionStore(context).clear()
        assertFalse(GrogoniSessionStore(context).syncEnabled)
    }

    @Test fun carrierShortCodesAreLocalDestinationsOnly() {
        assertEquals("12345", SmsDestination.normalize("12345", null))
        assertEquals("+15551234567", SmsDestination.normalize("+1 (555) 123-4567", null))
        for (invalid in listOf("*123#", "12,345", "123;456", "BankName", "12")) {
            assertThrows(IllegalArgumentException::class.java) { SmsDestination.normalize(invalid, null) }
        }
        assertThrows(IllegalArgumentException::class.java) { NativePhoneNormalizer.normalize("12345", "US") }
    }

    @Test fun adapterNeverSwitchesAwayFromTheSimConfirmedByTheSharedInterface() {
        val current = requireNotNull(SmsSubscription.defaultId())
        val adapter = DeviceMessagingAdapter(context)
        val text = "sim-selection-${UUID.randomUUID()}"
        val params = org.json.JSONObject().put("id", UUID.randomUUID().toString())
            .put("recipients", org.json.JSONArray(listOf("+15551234567"))).put("text", text)
            .put("subscriptionId", current + 1)
        val error = assertThrows(NativeSmsSendException::class.java) { adapter.execute("sendSms", params, null) }
        assertEquals(NativeSmsErrorCode.SMS_SIM_SELECTION_REQUIRED, error.code)
        assertTrue(LocalSmsInbox(context).page(query = text).isEmpty())
        assertThrows(IllegalStateException::class.java) { adapter.execute("sendMms", params, null) }
    }

    @Test fun virtualModemSendUpdatesProviderFromCarrierCallbackWithoutBackendResult() {
        assertEquals(context.packageName, Telephony.Sms.getDefaultSmsPackage(context))
        val id = "local:emulator-${UUID.randomUUID()}"
        val subscription = requireNotNull(SmsSubscription.defaultId())
        var uri: Uri? = null
        NativeSmsStore(context).use { store ->
            try {
                assertTrue(store.claimCommand(id))
                store.markCommandExecutionStarted(id)
                AndroidSmsSender(context).send(NativeSmsCommand(id, "+15551234567", "Virtual modem callback test", subscription, reportToGrogoni = false))
                uri = Uri.parse(requireNotNull(store.providerMessageUri(id)))
                val deadline = android.os.SystemClock.elapsedRealtime() + 30_000
                while (store.commandState(id) == "execution_started" && android.os.SystemClock.elapsedRealtime() < deadline) Thread.sleep(100)
                assertTrue("Virtual modem must report a sent state", store.commandState(id) in setOf("sent", "delivered"))
                context.contentResolver.query(uri!!, arrayOf("type"), null, null, null)!!.use {
                    assertTrue(it.moveToFirst()); assertEquals(Telephony.Sms.MESSAGE_TYPE_SENT, it.getInt(0))
                }
                assertTrue(store.pendingResults().none { it.commandId == id })
            } finally { uri?.let { context.contentResolver.delete(it, null, null) } }
        }
    }

    @Test fun failedProviderWriteSurvivesReopenAndDuplicateRecovery() {
        assertEquals("Dedicated emulator must hold SMS role", context.packageName, Telephony.Sms.getDefaultSmsPackage(context))
        val sms = message("durable-${UUID.randomUUID()}")
        IncomingSmsJournal(context).use { journal ->
            journal.record(sms)
            val error = assertThrows(IllegalArgumentException::class.java) {
                journal.recover(context, object : IncomingSmsProvider {
                    override fun find(sms: MultipartSmsAssembler.Assembled): Uri? = null
                    override fun insert(sms: MultipartSmsAssembler.Assembled): Uri? = null
                })
            }
            assertEquals("Android could not store incoming SMS.", error.message)
            assertTrue(journal.pending().any { it.id == sms.id })
        }
        val provider = AndroidIncomingSmsProvider(context)
        try {
            IncomingSmsJournal(context).use { journal ->
                journal.recover(context)
                assertFalse(journal.pending().any { it.id == sms.id })
                journal.record(sms)
                journal.recover(context)
            }
            assertNotNull(provider.find(sms))
            context.contentResolver.query(Telephony.Sms.Inbox.CONTENT_URI, arrayOf("_id"), "body = ?", arrayOf(sms.text), null)!!.use {
                assertEquals(1, it.count)
            }
        } finally { provider.find(sms)?.let { context.contentResolver.delete(it, null, null) } }
    }

    @Test fun crashAfterProviderInsertReconcilesWithoutDuplicate() {
        assertEquals(context.packageName, Telephony.Sms.getDefaultSmsPackage(context))
        val sms = message("reconcile-${UUID.randomUUID()}")
        val provider = AndroidIncomingSmsProvider(context)
        val uri = requireNotNull(provider.insert(sms))
        try {
            IncomingSmsJournal(context).use { journal ->
                journal.record(sms)
                assertTrue(journal.recover(context))
                assertEquals(uri.lastPathSegment, provider.find(sms)?.lastPathSegment)
            }
        } finally { context.contentResolver.delete(uri, null, null) }
    }

    @Test fun paginationAndSearchReachMessagesBeyondFirstHundredWithoutSkippingTies() {
        assertEquals(context.packageName, Telephony.Sms.getDefaultSmsPackage(context))
        val tag = "history-${UUID.randomUUID()}"
        val provider = AndroidIncomingSmsProvider(context)
        val uris = mutableListOf<Uri>()
        try {
            repeat(125) { uris += requireNotNull(provider.insert(message("$tag-$it"))) }
            val inbox = LocalSmsInbox(context)
            val first = inbox.page(query = tag)
            val second = inbox.page(before = first.last(), query = tag)
            assertEquals(100, first.size)
            assertEquals(25, second.size)
            assertEquals(125, (first + second).map { it.id }.toSet().size)
            assertTrue(inbox.page(before = second.last(), query = tag).isEmpty())
            assertEquals(1, inbox.page(query = "$tag-124").size)
        } finally { uris.forEach { context.contentResolver.delete(it, null, null) } }
    }

    private fun message(body: String): MultipartSmsAssembler.Assembled {
        val sender = "+15551234567"
        val timestamp = 1_800_000_000_000L // Same timestamp exercises the ID tie-breaker.
        return MultipartSmsAssembler.Assembled(sender, body, timestamp, MultipartSmsAssembler.stableId(sender, timestamp, body))
    }
}
