package market.grogoni.app.whatsapp.sidecar

import java.io.File
import java.nio.file.Files
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class SidecarPolicyTest {
    private val token = "ab".repeat(32)
    private val key = "cd".repeat(32)

    private fun run(
        sdk: Int = 35,
        abis: List<String> = listOf("arm64-v8a"),
        runtime: Boolean = true,
        account: String? = "acct_1",
        session: Boolean = true,
        enabled: String? = "acct_1",
    ) = SidecarPolicy.shouldRun(sdk, abis, runtime, account, session, enabled)

    @Test fun runsOnlyForTheOptedInSignedInOwnerOnASupportedDevice() {
        assertEquals(SidecarPolicy.RunDecision.Run, run())
        assertEquals(SidecarPolicy.RunDecision.Run, run(abis = listOf("x86_64")))
        assertEquals("sdk_unsupported", (run(sdk = 23) as SidecarPolicy.RunDecision.Refuse).code)
        assertEquals("abi_unsupported", (run(abis = listOf("armeabi-v7a", "x86")) as SidecarPolicy.RunDecision.Refuse).code)
        assertEquals("runtime_missing", (run(runtime = false) as SidecarPolicy.RunDecision.Refuse).code)
        assertEquals("signed_out", (run(account = null) as SidecarPolicy.RunDecision.Refuse).code)
        assertEquals("signed_out", (run(session = false) as SidecarPolicy.RunDecision.Refuse).code)
        assertEquals("not_enabled", (run(enabled = null) as SidecarPolicy.RunDecision.Refuse).code)
        // Turning it on for one account never runs it for the next account signed in on the phone.
        assertEquals("not_enabled", (run(account = "acct_2") as SidecarPolicy.RunDecision.Refuse).code)
    }

    @Test fun vaultDirectoryIsPerOwnerAndHidesTheAccountId() {
        val first = SidecarPolicy.vaultDirectoryName("acct_1")
        assertEquals(first, SidecarPolicy.vaultDirectoryName("acct_1"))
        assertNotEquals(first, SidecarPolicy.vaultDirectoryName("acct_2"))
        assertFalse(first.contains("acct"))
        assertTrue(first.matches(Regex("owner-[0-9a-f]{32}")))
    }

    @Test fun configLineCarriesTheKeyOnlyInItsOwnFieldAndEscapesPaths() {
        val line = SidecarPolicy.configLine(token, key, "/data/user/0/app/no_backup/w\"x", "acct_1")
        assertTrue(line.endsWith("}\n"))
        assertEquals(1, line.count { it == '\n' })
        assertTrue(line.contains("\"key\":\"$key\""))
        assertTrue(line.contains("w\\\"x"))
        for (bad in listOf(
            { SidecarPolicy.configLine(token, token, "/v", "a") },
            { SidecarPolicy.configLine("AB".repeat(32), key, "/v", "a") },
            { SidecarPolicy.configLine(token, key, "relative", "a") },
            { SidecarPolicy.configLine(token, key, "/v", "a\"b") },
        )) try {
            bad()
            fail("unsafe configuration must be refused")
        } catch (_: IllegalArgumentException) {
        }
    }

    @Test fun readyLineIsTheOnlyAcceptedStartSignal() {
        assertEquals(40757, SidecarPolicy.readyPort("""{"type":"ready","port":40757,"node":"v24.22.2","protocol":1}"""))
        assertNull(SidecarPolicy.readyPort("""{"type":"welcome","port":40757}"""))
        assertNull(SidecarPolicy.readyPort("""{"type":"ready","port":80}"""))
        assertNull(SidecarPolicy.readyPort("sidecar_start_failed"))
        assertEquals("{\"type\":\"hello\",\"token\":\"$token\",\"protocol\":1}\n", SidecarPolicy.helloLine(token))
    }

    @Test fun idleSidecarStopsAfterTenMinutesWithNothingLinked() {
        val limit = 10 * 60_000L
        assertTrue(SidecarPolicy.shouldStopForIdle(listOf("DISCONNECTED", "AUTH_REQUIRED"), 0, limit))
        assertFalse(SidecarPolicy.shouldStopForIdle(listOf("DISCONNECTED"), 0, limit - 1))
        assertFalse(SidecarPolicy.shouldStopForIdle(listOf("CONNECTED", "DISCONNECTED"), 0, limit * 3))
        assertFalse(SidecarPolicy.shouldStopForIdle(listOf("PAIRING"), 0, limit * 3))
        assertFalse(SidecarPolicy.shouldStopForIdle(listOf("RECONNECTING"), 0, limit * 3))
        assertFalse(SidecarPolicy.shouldStopForIdle(listOf("DISCONNECTED"), null, limit * 3))
        assertTrue(SidecarPolicy.shouldStopForIdle(emptyList(), 0, limit))
    }
}

class SidecarRestartPolicyTest {
    private fun policy() = SidecarRestartPolicy(jitter = { 0 })

    @Test fun backsOffExponentiallyWithACap() {
        val restart = policy()
        val delays = (0 until 5).map { (restart.onExit(1, false, it * 1_000L, it * 1_000L + 10) as SidecarRestartPolicy.Decision.RestartAfter).delayMs }
        assertEquals(listOf(2_000L, 4_000L, 8_000L, 16_000L, 32_000L), delays)
        val capped = SidecarRestartPolicy(jitter = { 0 }, maxCrashesInWindow = 100)
        var last = 0L
        repeat(20) { last = (capped.onExit(1, false, 0, 1) as SidecarRestartPolicy.Decision.RestartAfter).delayMs }
        assertEquals(5 * 60_000L, last)
    }

    @Test fun requestedStopsNeverRestart() {
        assertEquals(SidecarRestartPolicy.Decision.Stay, policy().onExit(0, true, 0, 10))
        assertEquals(SidecarRestartPolicy.Decision.Stay, policy().onExit(137, true, 0, 10))
    }

    @Test fun aCrashLoopGivesUpInsteadOfDrainingTheBattery() {
        val restart = policy()
        var now = 0L
        repeat(5) {
            assertTrue(restart.onExit(70, false, now, now + 100) is SidecarRestartPolicy.Decision.RestartAfter)
            now += 60_000
        }
        assertEquals(SidecarRestartPolicy.Decision.GiveUp(6), restart.onExit(70, false, now, now + 100))
    }

    @Test fun aStableRunResetsTheBackoff() {
        val restart = policy()
        restart.onExit(1, false, 0, 10)
        restart.onExit(1, false, 10, 20)
        val afterStable = restart.onExit(1, false, 100, 100 + 11 * 60_000L) as SidecarRestartPolicy.Decision.RestartAfter
        assertEquals(2_000L, afterStable.delayMs)
    }

    @Test fun jitterIsBoundedToAQuarterOfTheDelay() {
        val restart = SidecarRestartPolicy(jitter = { bound -> bound })
        val decision = restart.onExit(1, false, 0, 1) as SidecarRestartPolicy.Decision.RestartAfter
        assertEquals(2_500L, decision.delayMs)
    }
}

class IngressOutcomeTest {
    @Test fun storedOrDuplicateEventsAreAcknowledged() {
        assertEquals(IngressOutcome.ACK, IngressOutcome.classify(200, null))
        assertEquals(IngressOutcome.ACK, IngressOutcome.classify(409, "already_received"))
    }

    @Test fun transientFailuresKeepTheEventJournaled() {
        for (status in listOf(null, 401, 429, 500, 502, 503)) assertEquals(IngressOutcome.RETRY, IngressOutcome.classify(status, "x"))
        assertEquals(IngressOutcome.RETRY, IngressOutcome.classify(404, "not_found"))
        assertEquals(IngressOutcome.RETRY, IngressOutcome.classify(403, "something_else"))
    }

    @Test fun lostOwnershipErasesAndUnapprovedChatsAreRevoked() {
        assertEquals(IngressOutcome.DENY, IngressOutcome.classify(403, "permission_denied"))
        assertEquals(IngressOutcome.DENY, IngressOutcome.classify(410, "business_quarantined"))
        assertEquals(IngressOutcome.REVOKE_CHAT, IngressOutcome.classify(404, "conversation_channel_not_found"))
        assertEquals(IngressOutcome.REVOKE_CHAT, IngressOutcome.classify(403, "whatsapp_chat_not_approved"))
    }
}

class SidecarVaultKeyStoreTest {
    /** XOR stand-in for Keystore: enough to prove the file never holds the plaintext key. */
    private class FakeWrapper(private val mask: Byte = 0x5a, var broken: Boolean = false) : KeyWrapper {
        override fun wrap(plaintext: ByteArray) = byteArrayOf(1) + plaintext.map { (it.toInt() xor mask.toInt()).toByte() }
        override fun unwrap(wrapped: ByteArray): ByteArray {
            if (broken || wrapped[0] != 1.toByte()) throw IllegalStateException("bad tag")
            return wrapped.drop(1).map { (it.toInt() xor mask.toInt()).toByte() }.toByteArray()
        }
    }

    private fun tempFile(): File = File(Files.createTempDirectory("vault-key").toFile(), "owner/vault-key.wrapped")

    @Test fun createsOnceAndReloadsTheSameKey() {
        val file = tempFile()
        val store = SidecarVaultKeyStore(file, FakeWrapper())
        val key = store.loadOrCreate()
        assertEquals(32, key.size)
        assertArrayEquals(key, SidecarVaultKeyStore(file, FakeWrapper()).loadOrCreate())
        val stored = file.readBytes()
        assertTrue(String(stored.copyOfRange(0, 4), Charsets.US_ASCII) == "GWK1")
        assertFalse("plaintext key must not be on disk", stored.toList().windowed(32).any { it.toByteArray().contentEquals(key) })
        assertTrue(file.parentFile!!.listFiles()!!.none { it.name.endsWith(".tmp") })
    }

    @Test fun anUnreadableKeyFailsLoudlyInsteadOfSilentlyRegenerating() {
        val file = tempFile()
        val key = SidecarVaultKeyStore(file, FakeWrapper()).loadOrCreate()
        try {
            SidecarVaultKeyStore(file, FakeWrapper(broken = true)).loadOrCreate()
            fail("a key that cannot be unwrapped must not be replaced quietly")
        } catch (_: VaultKeyUnavailable) {
        }
        assertArrayEquals(key, SidecarVaultKeyStore(file, FakeWrapper()).loadOrCreate())
        file.writeBytes("XXXX".toByteArray())
        try {
            SidecarVaultKeyStore(file, FakeWrapper()).loadOrCreate()
            fail("unknown format must be refused")
        } catch (_: VaultKeyUnavailable) {
        }
    }

    @Test fun deleteAllowsAFreshKey() {
        val file = tempFile()
        val store = SidecarVaultKeyStore(file, FakeWrapper())
        val first = store.loadOrCreate()
        store.delete()
        assertFalse(first.contentEquals(store.loadOrCreate()))
    }
}
