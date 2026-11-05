package market.grogoni.app.sms

import android.content.Context
import android.net.Uri
import android.provider.Telephony
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.example.android.mmslib.pdu.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MmsInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test fun mmsNotificationIsDurableIdempotentAndNeverAutoDownloads() {
        assertTrue(DefaultSmsRole.held(context))
        val id = "emulator-${java.util.UUID.randomUUID()}"
        val sender = "+15551234567".toByteArray()
        val out = java.io.ByteArrayOutputStream()
        fun octets(vararg values: Int) { values.forEach { out.write(it) } }
        octets(0x8c, 0x82, 0x8d, 0x92, 0x98)
        out.write(id.toByteArray()); octets(0)
        octets(0x89, sender.size + 2, 0x80); out.write(sender); octets(0)
        octets(0x8a, 0x80, 0x8e, 2, 1, 0, 0x88, 4, 0x81, 2, 0x0e, 0x10, 0x83)
        out.write("https://mmsc.example.invalid/$id".toByteArray()); octets(0)
        val bytes = out.toByteArray()
        val subscription = requireNotNull(SmsSubscription.defaultId())
        val transport = MmsTransport(context)
        var row: Uri? = null
        try {
            IncomingSmsJournal(context).use {
                it.recordMms(bytes, subscription)
                it.recordMms(bytes, subscription)
                assertTrue(it.recover(context))
            }
            row = transport.receiveNotification(bytes, subscription)
            assertEquals(row, transport.receiveNotification(bytes, subscription))
            context.contentResolver.query(row, arrayOf("m_type", "sub_id"), null, null, null)!!.use {
                assertTrue(it.moveToFirst()); assertEquals(130, it.getInt(0)); assertEquals(subscription, it.getInt(1))
            }
            val addresses = Uri.parse("content://mms/${row.lastPathSegment}/addr")
            context.contentResolver.delete(addresses, null, null)
            transport.receiveNotification(bytes, subscription) // Resume an interrupted sender write.
            context.contentResolver.query(addresses, arrayOf("address"), null, null, null)!!.use {
                assertEquals(1, it.count)
            }
            context.contentResolver.query(Uri.parse("content://mms/${row.lastPathSegment}/part"), arrayOf("_id"), null, null, null)!!.use {
                assertEquals(0, it.count) // No download was started.
            }
        } finally { row?.let { context.contentResolver.delete(it, null, null) } }
    }

    @Test fun groupMmsCodecPersistsTextAndImageInRealProvider() {
        assertTrue(DefaultSmsRole.held(context))
        val transport = MmsTransport(context)
        val bytes = transport.compose(listOf("+15551234567", "+15557654321"), "Hello 世界", null)
        val sent = PduParser(bytes, true).parse() as SendReq
        assertEquals(2, sent.to.size)
        assertEquals("Hello 世界", String(sent.body.getPart(0).data, Charsets.UTF_8))
        val picture = byteArrayOf(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)
        sent.body.addPart(PduPart().apply {
            contentType = "image/gif".toByteArray(); data = picture
            contentLocation = "test.gif".toByteArray(); contentId = "picture".toByteArray()
        })
        val row = transport.persist(sent, Telephony.Mms.MESSAGE_BOX_OUTBOX)
        try {
            context.contentResolver.query(Uri.parse("content://mms/${row.lastPathSegment}/part"), arrayOf("_id", "ct", "text"), null, null, "seq asc")!!.use {
                assertEquals(2, it.count)
                assertTrue(it.moveToFirst()); assertEquals("Hello 世界", it.getString(2))
                assertTrue(it.moveToNext()); assertEquals("image/gif", it.getString(1))
                context.contentResolver.openInputStream(Uri.parse("content://mms/part/${it.getLong(0)}"))!!.use { stream ->
                    assertArrayEquals(picture, stream.readBytes())
                }
            }
            context.contentResolver.query(Uri.parse("content://mms/${row.lastPathSegment}/addr"), arrayOf("address", "type"), "type = 151", null, null)!!.use {
                assertEquals(2, it.count)
            }
        } finally { context.contentResolver.delete(row, null, null) }
    }

    @Test fun rejectUnsafeAndOversizedMmsBeforeCarrierInvocation() {
        val transport = MmsTransport(context)
        assertThrows(IllegalArgumentException::class.java) { transport.compose(listOf("+15551234567"), "x".repeat(MmsTransport.MAX_BYTES + 1), null) }
        assertThrows(IllegalArgumentException::class.java) { transport.compose(listOf("123;456"), "text", null) }
        assertThrows(IllegalArgumentException::class.java) { transport.compose(listOf("+15551234567"), "text", Uri.parse("file:///etc/passwd")) }
        assertThrows(IllegalArgumentException::class.java) { transport.compose(emptyList(), "text", null) }
    }

    @Test fun downloadedPduCanBeRecoveredAndStoredWithoutCarrierNetwork() {
        assertTrue(DefaultSmsRole.held(context))
        val transport = MmsTransport(context)
        val bytes = transport.compose(listOf("+15551234567"), "Downloaded MMS fixture", null)
        // M-Retrieve.conf shares the multimedia body/header encoding with M-Send.req.
        assertEquals(0x8c, bytes[0].toInt() and 255)
        bytes[1] = PduHeaders.MESSAGE_TYPE_RETRIEVE_CONF.toByte()
        val received = PduParser(bytes, true).parse() as RetrieveConf
        val row = transport.persist(received, Telephony.Mms.MESSAGE_BOX_INBOX)
        try {
            context.contentResolver.query(row, arrayOf("m_type", "msg_box"), null, null, null)!!.use {
                assertTrue(it.moveToFirst()); assertEquals(132, it.getInt(0)); assertEquals(1, it.getInt(1))
            }
        } finally { context.contentResolver.delete(row, null, null) }
    }
}
