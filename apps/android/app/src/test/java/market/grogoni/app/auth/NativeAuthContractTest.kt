package market.grogoni.app.auth

import java.security.KeyPairGenerator
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import org.junit.Assert.*
import org.junit.Test

class NativeAuthContractTest {
    @Test fun androidDerSignaturesConvertToFixedWidthWebCryptoFormat() {
        val pair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
        repeat(30) {
            val message = "device-proof-$it".toByteArray()
            val der = Signature.getInstance("SHA256withECDSA").run { initSign(pair.private); update(message); sign() }
            val signature = DeviceRecoveryKey.toP1363(der)
            assertEquals(64, signature.size)
            assertTrue(Signature.getInstance("SHA256withECDSAinP1363Format").run {
                initVerify(pair.public); update(message); verify(signature)
            })
        }
        assertThrows(IllegalArgumentException::class.java) { DeviceRecoveryKey.toP1363(byteArrayOf(1, 2)) }
    }

    @Test fun validatesConfirmedPinAndPasswordWithoutChangingTheServerContract() {
        NativeAuthClient.validateSecret("1234", "1234", false)
        NativeAuthClient.validateSecret("abcdefghij", "abcdefghij", true)
        for (pin in listOf("123", "12345", "abcd")) {
            assertThrows(IllegalArgumentException::class.java) { NativeAuthClient.validateSecret(pin, pin, false) }
        }
        assertThrows(IllegalArgumentException::class.java) { NativeAuthClient.validateSecret("1234", "5678", false) }
        assertThrows(IllegalArgumentException::class.java) { NativeAuthClient.validateSecret("short", "short", true) }
        assertThrows(IllegalArgumentException::class.java) { NativeAuthClient.validateSecret("x".repeat(257), "x".repeat(257), true) }
    }
}
