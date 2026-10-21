package market.grogoni.app.sms

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeSmsContractTest {
    @Test
    fun `normalizes E164 and deterministic local numbers`() {
        assertEquals("+254712345678", NativePhoneNormalizer.normalize("+254 712 345 678", null))
        assertEquals(
            "+254712345678",
            NativePhoneNormalizer.normalize("0712345678", "ke") { number, country ->
                if (number == "0712345678" && country == "KE") "+254712345678" else null
            },
        )
        assertThrows(IllegalArgumentException::class.java) {
            NativePhoneNormalizer.normalize("0712345678", null) { _, _ -> null }
        }
    }

    @Test
    fun `capability requires role permissions telephony and deterministic SIM`() {
        val ready = NativeSmsCapability.evaluate(true, true, true, true, true, 1)
        assertTrue(ready.ready)
        assertNull(ready.errorCode)

        val missingRole = NativeSmsCapability.evaluate(true, false, true, true, true, 1)
        assertFalse(missingRole.ready)
        val noDefaultSim = NativeSmsCapability.evaluate(true, true, true, true, true, null)
        assertEquals("SMS_SIM_SELECTION_REQUIRED", noDefaultSim.errorCode)
        val noTelephony = NativeSmsCapability.evaluate(true, true, true, true, false, null)
        assertEquals("SMS_SIM_UNAVAILABLE", noTelephony.errorCode)
    }

    @Test
    fun `assembles multipart inbound SMS into one stable canonical event`() {
        val parts = listOf(
            MultipartSmsAssembler.Part("+254712345678", "Do you have ", 1_700_000_000_001),
            MultipartSmsAssembler.Part("+254712345678", "maize?", 1_700_000_000_002),
        )
        val assembled = requireNotNull(MultipartSmsAssembler.assemble(parts))
        assertEquals("Do you have maize?", assembled.text)
        assertEquals(1_700_000_000_001, assembled.timestampMillis)
        assertEquals(assembled.id, MultipartSmsAssembler.assemble(parts)?.id)
        assertNotEquals(assembled.id, MultipartSmsAssembler.stableId(assembled.sender, assembled.timestampMillis, "other"))
        assertNull(
            MultipartSmsAssembler.assemble(
                parts + MultipartSmsAssembler.Part("+254700000000", "wrong sender", 3),
            ),
        )
    }

    @Test
    fun `maps Android results without leaking platform constants to the backend`() {
        assertEquals(NativeSmsErrorCode.SMS_SENT, NativeSmsResultMapper.sentResult(10, 10, 20, 30))
        assertEquals(NativeSmsErrorCode.SMS_NO_SERVICE, NativeSmsResultMapper.sentResult(20, 10, 20, 30))
        assertEquals(NativeSmsErrorCode.SMS_RADIO_OFF, NativeSmsResultMapper.sentResult(30, 10, 20, 30))
        assertEquals(NativeSmsErrorCode.SMS_SEND_FAILED, NativeSmsResultMapper.sentResult(40, 10, 20, 30))
    }

    @Test
    fun `replayed execution never invokes SmsManager twice`() {
        assertEquals(CommandReplayDecision.EXECUTE, commandReplayDecision(true, "claimed"))
        assertEquals(
            CommandReplayDecision.REPORT_DELIVERY_UNKNOWN,
            commandReplayDecision(false, "execution_started"),
        )
        assertEquals(CommandReplayDecision.SKIP, commandReplayDecision(false, "sent"))
        assertEquals(CommandReplayDecision.SKIP, commandReplayDecision(false, "execution_started", false))
        // A disconnected acknowledgement has not invoked the modem and is safe to resume.
        assertEquals(CommandReplayDecision.EXECUTE, commandReplayDecision(false, "claimed"))
    }
}
