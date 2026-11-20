package market.grogoni.app.sms

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeSmsDeliveryPolicyTest {
    private val ok = -1 // android.app.Activity.RESULT_OK

    @Test
    fun `only a successful delivery report counts`() {
        assertTrue(NativeSmsDeliveryPolicy.reportCounts(ok, okCode = ok))
        // A failed or generic-failure delivery PDU never yields delivered.
        assertFalse(NativeSmsDeliveryPolicy.reportCounts(0, okCode = ok))
        assertFalse(NativeSmsDeliveryPolicy.reportCounts(1, okCode = ok))
    }

    @Test
    fun `a failed command is never upgraded by a late delivery report`() {
        assertFalse(NativeSmsDeliveryPolicy.reportApplies("failed"))
        assertTrue(NativeSmsDeliveryPolicy.reportApplies("sent"))
        assertTrue(NativeSmsDeliveryPolicy.reportApplies(null))
    }

    @Test
    fun `delivered needs a report for every segment`() {
        assertFalse(NativeSmsDeliveryPolicy.commandDelivered(0, 3))
        assertFalse(NativeSmsDeliveryPolicy.commandDelivered(2, 3))
        assertTrue(NativeSmsDeliveryPolicy.commandDelivered(3, 3))
        assertTrue(NativeSmsDeliveryPolicy.commandDelivered(1, 1))
        assertFalse(NativeSmsDeliveryPolicy.commandDelivered(0, 0))
    }
}
