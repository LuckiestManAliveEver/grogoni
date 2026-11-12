package market.grogoni.app

import android.Manifest
import android.content.ContentProviderOperation
import android.content.Context
import android.provider.ContactsContract
import market.grogoni.app.sms.DeviceMessagingAdapter
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PermissionChecklistInstrumentedTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    @Before fun freshInstallState() {
        context.getSharedPreferences("permission-checklist", Context.MODE_PRIVATE).edit().clear().commit()
    }

    private fun <T> withChecklist(block: (PermissionChecklist) -> T): T {
        var result: T? = null
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { result = block(PermissionChecklist(it)) }
        }
        @Suppress("UNCHECKED_CAST") return result as T
    }
    private fun JSONObject.status(id: String): String {
        val items = getJSONArray("items")
        return (0 until items.length()).map(items::getJSONObject).single { it.getString("id") == id }.getString("status")
    }

    @Test fun newInstallIsNotCompletedAndListsTheContractItems() {
        val snapshot = withChecklist { it.snapshot() }
        assertFalse(snapshot.getBoolean("completed"))
        val items = snapshot.getJSONArray("items")
        val ids = (0 until items.length()).map { items.getJSONObject(it).getString("id") }
        assertEquals(PermissionChecklistPolicy.groups().map { it.id }, ids)
        assertTrue("contacts" in ids)
    }

    @Test fun phonebookStatusFollowsTheRealAndroidGrant() {
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.READ_CONTACTS)
        assertEquals("granted", withChecklist { it.snapshot() }.status("contacts"))
    }

    @Test fun messengerReadsNamesFromTheRealPhonebook() {
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.READ_CONTACTS)
        instrumentation.uiAutomation.grantRuntimePermission(context.packageName, Manifest.permission.WRITE_CONTACTS)
        val name = "Grogoni Checklist ${System.nanoTime()}"
        val operations = arrayListOf(
            ContentProviderOperation.newInsert(ContactsContract.RawContacts.CONTENT_URI)
                .withValue(ContactsContract.RawContacts.ACCOUNT_TYPE, null).withValue(ContactsContract.RawContacts.ACCOUNT_NAME, null).build(),
            ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.StructuredName.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.StructuredName.DISPLAY_NAME, name).build(),
            ContentProviderOperation.newInsert(ContactsContract.Data.CONTENT_URI).withValueBackReference(ContactsContract.Data.RAW_CONTACT_ID, 0)
                .withValue(ContactsContract.Data.MIMETYPE, ContactsContract.CommonDataKinds.Phone.CONTENT_ITEM_TYPE)
                .withValue(ContactsContract.CommonDataKinds.Phone.NUMBER, "+254712345678").build(),
        )
        val raw = context.contentResolver.applyBatch(ContactsContract.AUTHORITY, operations)[0].uri!!
        try {
            val result = DeviceMessagingAdapter(context).execute("listContacts", JSONObject(), null) as JSONObject
            val contacts = result.getJSONArray("contacts")
            val match = (0 until contacts.length()).map(contacts::getJSONObject).single { it.getString("name") == name }
            assertEquals("+254712345678", match.getString("phone"))
            assertEquals("Android's saved form survives a SIM swap", "+254712345678", match.getString("normalized"))
        } finally {
            context.contentResolver.delete(raw, null, null)
        }
    }

    @Test fun pageStaysClearOfTheSystemBars() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            instrumentation.waitForIdleSync()
            scenario.onActivity { activity ->
                val view = activity.webView
                val bars = requireNotNull(ViewCompat.getRootWindowInsets(view)).getInsets(WindowInsetsCompat.Type.systemBars())
                val position = IntArray(2).also(view::getLocationOnScreen)
                val screen = activity.window.decorView.height
                assertTrue("top ${position[1]} under status bar ${bars.top}", position[1] >= bars.top)
                assertTrue("bottom under navigation bar ${bars.bottom}", position[1] + view.height <= screen - bars.bottom)
            }
        }
    }

    @Test fun completionPersistsAcrossActivities() {
        withChecklist { it.complete() }
        assertTrue(withChecklist { it.snapshot() }.getBoolean("completed"))
    }
}
