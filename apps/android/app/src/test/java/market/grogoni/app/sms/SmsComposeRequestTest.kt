package market.grogoni.app.sms

import org.junit.Assert.*
import org.junit.Test

class SmsComposeRequestTest {
    @Test fun handlesEncodedPhoneBodyAndExplicitTextWithoutIncludingQueryInRecipient() {
        assertEquals(SmsComposeRequest("+15551234567", "Hello world!"),
            SmsComposeRequest.parse("sms", "%2B15551234567?body=Hello%20world%21", null))
        assertEquals(SmsComposeRequest("+15551234567", "explicit"),
            SmsComposeRequest.parse("smsto", "+15551234567?body=ignored", "explicit"))
    }
    @Test fun refusesMmsAndGroupsRatherThanSilentlySendingSmsToTheFirstPerson() {
        for (scheme in listOf("mms", "mmsto")) {
            assertThrows(IllegalArgumentException::class.java) { SmsComposeRequest.parse(scheme, "+15551234567", "text") }
        }
        for (target in listOf("123,456", "123%3B456")) {
            assertThrows(IllegalArgumentException::class.java) { SmsComposeRequest.parse("sms", target, "text") }
        }
    }
}
