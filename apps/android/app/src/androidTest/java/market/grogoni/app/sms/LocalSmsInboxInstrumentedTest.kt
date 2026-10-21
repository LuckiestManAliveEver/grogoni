package market.grogoni.app.sms

import android.Manifest
import android.content.ContentUris
import android.content.ContentValues
import android.content.pm.PackageManager
import android.provider.Telephony
import androidx.core.content.ContextCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LocalSmsInboxInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    @Test
    fun localOnlyPreferencePersistsAcrossStoreInstances() {
        val session = GrogoniSessionStore(context)
        val previous = session.syncEnabled
        try {
            session.syncEnabled = false
            assertFalse(GrogoniSessionStore(context).syncEnabled)
            // This does not clear or replace credentials on the test device.
            session.syncEnabled = true
            assertTrue(GrogoniSessionStore(context).syncEnabled)
        } finally {
            session.syncEnabled = previous
        }
    }

    /** Run on a dedicated emulator/device with the default SMS role and READ_SMS granted. */
    @Test
    fun localInboxReadsAndMarksSmsWithoutBackendSync() {
        assumeTrue(Telephony.Sms.getDefaultSmsPackage(context) == context.packageName)
        assumeTrue(ContextCompat.checkSelfPermission(context, Manifest.permission.READ_SMS) == PackageManager.PERMISSION_GRANTED)
        val session = GrogoniSessionStore(context)
        val previous = session.syncEnabled
        val uri = requireNotNull(context.contentResolver.insert(
            Telephony.Sms.Inbox.CONTENT_URI,
            ContentValues().apply {
                put(Telephony.Sms.ADDRESS, "+254712345678")
                put(Telephony.Sms.BODY, "Local inbox test")
                put(Telephony.Sms.DATE, System.currentTimeMillis())
                put(Telephony.Sms.READ, 0)
                put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_INBOX)
            },
        ))
        try {
            session.syncEnabled = false
            val inbox = LocalSmsInbox(context)
            val id = ContentUris.parseId(uri)
            val message = inbox.recent().single { it.id == id }
            assertEquals("Local inbox test", message.body)
            assertFalse(message.read)
            inbox.markRead(message)
            assertTrue(inbox.recent().single { it.id == id }.read)
        } finally {
            context.contentResolver.delete(uri, null, null)
            session.syncEnabled = previous
        }
    }
}
