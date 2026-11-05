package market.grogoni.app

import android.Manifest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ChecklistRequestQueueTest {
    private val groups = PermissionChecklistPolicy.groups(34)

    /** Simulates Android: the test decides what each dialog does. */
    private class FakeHost(groups: List<ChecklistGroup>) : ChecklistRequestQueue.Host {
        val byId = groups.associateBy { it.id }
        val statuses = mutableMapOf<String, ChecklistStatus>()
        val grantedSet = mutableSetOf<String>()
        var roleHeldNow = false
        var launchFails = false
        val launches = mutableListOf<String>()
        override fun group(id: String) = byId[id]
        override fun status(group: ChecklistGroup) = statuses[group.id]
            ?: if (group.satisfied(grantedSet) && (!group.needsSmsRole || roleHeldNow)) ChecklistStatus.GRANTED else ChecklistStatus.NOT_REQUESTED
        override fun roleHeld() = roleHeldNow
        override fun granted() = grantedSet.toSet()
        override fun snapshot(): Any = "snapshot"
        override fun launchRole(group: ChecklistGroup): Boolean { if (launchFails) return false; launches += "role:${group.id}"; return true }
        override fun launchPermissions(group: ChecklistGroup, permissions: List<String>): Boolean {
            if (launchFails) return false; launches += "perms:${group.id}:${permissions.joinToString(",") { it.substringAfterLast('.') }}"; return true
        }
    }

    private class Result { var value: Any? = null; var error: String? = null; var calls = 0 }
    private fun callback(result: Result): (Any?, String?) -> Unit = { value, error -> result.value = value; result.error = error; result.calls++ }

    @Test fun `allow all asks the role, then the SMS permissions the role did not grant, then each item in order`() {
        val host = FakeHost(groups); val queue = ChecklistRequestQueue(host); val result = Result()
        assertNull(queue.start(groups.map { it.id }, callback(result)))
        assertEquals(listOf("role:sms"), host.launches)
        // The role auto-grants most SMS permissions; RECEIVE_WAP_PUSH is still missing.
        host.roleHeldNow = true
        host.grantedSet += groups.single { it.id == "sms" }.permissions - Manifest.permission.RECEIVE_WAP_PUSH
        queue.onRoleResult("sms")
        assertEquals("perms:sms:RECEIVE_WAP_PUSH", host.launches.last())
        for (next in listOf("contacts", "notifications", "camera", "location")) {
            queue.onPermissionsResult()
            assertTrue(host.launches.last().startsWith("perms:$next:"))
        }
        assertEquals(0, result.calls)
        queue.onPermissionsResult()
        assertEquals(1, result.calls); assertEquals("snapshot", result.value); assertFalse(queue.busy)
    }

    @Test fun `a refused role is not asked again and its permissions are skipped`() {
        val host = FakeHost(groups); val queue = ChecklistRequestQueue(host); val result = Result()
        queue.start(listOf("sms", "contacts"), callback(result))
        queue.onRoleResult("sms")
        assertEquals(listOf("role:sms", "perms:contacts:READ_CONTACTS"), host.launches)
        queue.onPermissionsResult()
        assertEquals(1, result.calls)
    }

    @Test fun `granted, blocked and unsupported items open no dialog`() {
        val host = FakeHost(groups); val queue = ChecklistRequestQueue(host); val result = Result()
        host.statuses += mapOf("sms" to ChecklistStatus.UNAVAILABLE, "contacts" to ChecklistStatus.BLOCKED, "camera" to ChecklistStatus.GRANTED)
        queue.start(listOf("sms", "contacts", "camera"), callback(result))
        assertEquals(emptyList<String>(), host.launches)
        assertEquals(1, result.calls)
    }

    @Test fun `a second request while one is open is refused without disturbing the first`() {
        val host = FakeHost(groups); val queue = ChecklistRequestQueue(host); val first = Result(); val second = Result()
        queue.start(listOf("camera"), callback(first))
        assertEquals("A permission request is already open.", queue.start(listOf("contacts"), callback(second)))
        assertEquals(0, second.calls)
        queue.onPermissionsResult()
        assertEquals(1, first.calls)
        assertEquals(listOf("perms:camera:CAMERA"), host.launches)
    }

    @Test fun `unknown or empty ids are refused`() {
        val queue = ChecklistRequestQueue(FakeHost(groups)); val result = Result()
        assertEquals("Unknown device permission.", queue.start(listOf("teleport"), callback(result)))
        assertEquals("Unknown device permission.", queue.start(emptyList(), callback(result)))
        assertFalse(queue.busy)
    }

    @Test fun `continue cancels Allow all so the open dialog finishes, nothing new opens and the call resolves once`() {
        val host = FakeHost(groups); val queue = ChecklistRequestQueue(host); val result = Result()
        queue.start(listOf("contacts", "camera", "location"), callback(result))
        queue.cancel()
        assertEquals(1, result.calls); assertFalse(queue.busy)
        queue.onPermissionsResult() // the dialog that was already open closes later
        assertEquals(listOf("perms:contacts:READ_CONTACTS"), host.launches)
        assertEquals(1, result.calls)
    }

    @Test fun `a dialog that cannot open is skipped instead of hanging the call`() {
        val host = FakeHost(groups).apply { launchFails = true }; val queue = ChecklistRequestQueue(host); val result = Result()
        queue.start(listOf("sms", "camera"), callback(result))
        assertEquals(1, result.calls); assertFalse(queue.busy)
    }

    @Test fun `a result arriving after activity recreation is harmless`() {
        val queue = ChecklistRequestQueue(FakeHost(groups))
        queue.onPermissionsResult(); queue.onRoleResult("sms")
        assertFalse(queue.busy)
    }
}
