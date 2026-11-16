package market.grogoni.app.whatsapp.sidecar

import android.app.NotificationManager
import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.Socket
import market.grogoni.app.sms.GrogoniSessionStore
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs the packaged Node runtime and sidecar on the device (x86_64 emulator in CI-less local
 * runs). No WhatsApp account, pairing or network request to WhatsApp is involved.
 */
@RunWith(AndroidJUnit4::class)
class WhatsAppSidecarInstrumentedTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val runtime = SidecarRuntime(context)
    private val root = File(context.noBackupFilesDir, "whatsapp-sidecar-test")
    private val started = mutableListOf<SidecarProcess>()
    private val wrapper = AndroidKeystoreWrapper("grogoni-whatsapp-sidecar-test-v1")

    private val quiet = object : SidecarEvents {
        override fun ingress(seq: Long, businessId: String, message: JSONObject) {}
        override fun state(businessId: String, state: String) {}
        override fun closed() {}
    }

    @After fun cleanUp() {
        started.forEach { it.stop(2_000) }
        root.deleteRecursively()
        runCatching { wrapper.deleteKey() }
    }

    private fun launch(key: ByteArray, owner: String = "acct_instrumented"): SidecarProcess =
        SidecarProcess.start(runtime, runtime.script(), File(root, "vault"), File(root, "tmp"), owner, key).also { started += it }

    private fun keystoreKey(): ByteArray = SidecarVaultKeyStore(File(root, "vault-key.wrapped"), wrapper).loadOrCreate()

    @Test fun packagedRuntimeIsInstalledExecutableForThisAbi() {
        assertTrue("debug builds package the Node runtime", runtime.present)
        assertTrue(runtime.node.canExecute())
        assertTrue(runtime.node.absolutePath.startsWith(context.applicationInfo.nativeLibraryDir))
        val script = runtime.script()
        assertEquals(script.name.removeSuffix(".mjs"), SidecarRuntime.sha256(script.inputStream()))
    }

    @Test fun keystoreWrappedVaultKeyRoundTripsAndNeverLandsOnDiskInPlaintext() {
        val first = keystoreKey()
        assertEquals(32, first.size)
        assertArrayEquals(first, SidecarVaultKeyStore(File(root, "vault-key.wrapped"), wrapper).loadOrCreate())
        val stored = File(root, "vault-key.wrapped").readBytes()
        assertFalse(stored.toList().windowed(32).any { it.toByteArray().contentEquals(first) })
        // A deleted Keystore key makes the wrapped file unusable: reported, not silently replaced.
        wrapper.deleteKey()
        try {
            SidecarVaultKeyStore(File(root, "vault-key.wrapped"), wrapper).loadOrCreate()
            fail("a wrapped key without its Keystore key must be reported")
        } catch (_: VaultKeyUnavailable) {
        }
    }

    @Test fun sidecarStartsAndCompletesTheLoopbackTokenHandshake() {
        val process = launch(keystoreKey())
        val client = SidecarClient.connect(process.port, process.token, quiet)
        try {
            assertTrue(client.node, client.node.startsWith("v24."))
            val probe = client.call("probe", timeoutMs = 60_000)!!
            assertEquals("android", probe.getString("platform"))
            assertTrue("Baileys, libsignal and the WASM bridge load", probe.getBoolean("protocolLoaded"))
            assertTrue("device keys generate offline", probe.getBoolean("keyGeneration"))
            val status = client.call("status", JSONObject().put("businessId", "biz_instrumented"))!!
            assertEquals("DISCONNECTED", status.getString("state"))
            assertNull(status.opt("pairingCode").takeUnless { it == JSONObject.NULL })
        } finally {
            client.close()
        }
    }

    @Test fun loopbackRefusesAWrongTokenAndASilentClient() {
        val process = launch(keystoreKey())
        Socket(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), process.port).use { socket ->
            socket.soTimeout = 5_000
            socket.getOutputStream().write(SidecarPolicy.helloLine(SidecarProcess.newSecretHex()).toByteArray())
            val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
            assertEquals("unauthorized", JSONObject(reader.readLine()).getString("code"))
            assertNull("the sidecar closes the connection", reader.readLine())
        }
        Socket(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), process.port).use { socket ->
            socket.soTimeout = 5_000
            val reader = BufferedReader(InputStreamReader(socket.getInputStream()))
            assertEquals("hello_timeout", JSONObject(reader.readLine()).getString("code"))
        }
        // The legitimate client still works after the refused attempts.
        SidecarClient.connect(process.port, process.token, quiet).use { client ->
            assertEquals("DISCONNECTED", client.call("status", JSONObject().put("businessId", "biz_instrumented"))!!.getString("state"))
        }
    }

    @Test fun vaultRoundTripsWithTheKeystoreKeyAcrossProcessesAndRefusesOtherKeys() {
        val canary = "canary-" + SidecarProcess.newSecretHex().take(16)
        val first = launch(keystoreKey())
        SidecarClient.connect(first.port, first.token, quiet).use { it.call("vaultCheck", JSONObject().put("write", canary)) }
        first.stop()
        assertEquals("a closed stdin pipe ends the sidecar cleanly", 0, first.waitFor())
        val files = File(root, "vault").listFiles().orEmpty()
        assertTrue(files.isNotEmpty())
        assertTrue(files.none { String(it.readBytes(), Charsets.ISO_8859_1).contains(canary) })
        assertEquals("vault directory is 0700", 0, android.system.Os.stat(File(root, "vault").absolutePath).st_mode and "077".toInt(8))
        files.forEach { assertEquals("vault files are 0600", 0, android.system.Os.stat(it.absolutePath).st_mode and "077".toInt(8)) }

        val second = launch(keystoreKey())
        SidecarClient.connect(second.port, second.token, quiet).use {
            assertEquals(canary, it.call("vaultCheck")!!.getString("value"))
        }
        second.stop()

        val stranger = launch(SidecarProcess.newSecretHex().chunked(2).map { it.toInt(16).toByte() }.toByteArray())
        SidecarClient.connect(stranger.port, stranger.token, quiet).use {
            try {
                it.call("vaultCheck")
                fail("another key must not decrypt the vault")
            } catch (_: SidecarCallException) {
            }
        }
    }

    @Test fun controllerRestartsACrashedSidecarAndStopsCleanly() {
        val controller = WhatsAppSidecarController(
            context,
            relay = { _, _ -> IngressOutcome.RETRY },
            wrapper = wrapper,
            restartPolicy = SidecarRestartPolicy(baseDelayMs = 500, jitter = { 0 }),
        )
        val owner = "acct_restart_test"
        try {
            controller.start(owner)
            assertTrue(controller.running)
            controller.killForTest()
            waitUntil(10_000) { !controller.running }
            waitUntil(90_000) { controller.running }
            assertEquals("DISCONNECTED", controller.call("status", JSONObject().put("businessId", "biz_r"))!!.getString("state"))
            controller.stop()
            assertFalse(controller.running)
        } finally {
            controller.stop()
            controller.ownerDirectory(owner).deleteRecursively()
        }
    }

    @Test fun foregroundServiceRunsWithAVisibleNotificationAndStops() {
        val session = GrogoniSessionStore(context)
        val previous = Triple(session.accountId, session.accountPhone, session.cookieHeader)
        val account = "acct_service_test"
        session.saveAuthenticatedSession(account, "254700000000", "grogoni_session=instrumented-test")
        WhatsAppSidecar.setEnabled(context, account)
        if (android.os.Build.VERSION.SDK_INT >= 33)
            InstrumentationRegistry.getInstrumentation().uiAutomation.grantRuntimePermission(context.packageName, "android.permission.POST_NOTIFICATIONS")
        try {
            assertEquals(SidecarPolicy.RunDecision.Run, WhatsAppSidecar.decision(context))
            WhatsAppSidecarService.start(context)
            waitUntil(90_000) { WhatsAppSidecar.controller(context).running }
            val notifications = context.getSystemService(NotificationManager::class.java).activeNotifications
            assertTrue("the worker is never invisible", notifications.any { it.id == 4107 && it.isOngoing })
            context.startService(Intent(context, WhatsAppSidecarService::class.java).setAction(WhatsAppSidecarService.ACTION_STOP))
            waitUntil(15_000) { !WhatsAppSidecar.controller(context).running }
            assertNull("stopping turns it off for this account", WhatsAppSidecar.enabledAccount(context))
            assertNotEquals(SidecarPolicy.RunDecision.Run, WhatsAppSidecar.decision(context))
        } finally {
            WhatsAppSidecar.controller(context).stop()
            WhatsAppSidecar.setEnabled(context, null)
            WhatsAppSidecar.controller(context).ownerDirectory(account).deleteRecursively()
            session.clear()
            if (previous.first != null && previous.third != null)
                session.saveAuthenticatedSession(previous.first!!, previous.second.orEmpty(), previous.third!!)
        }
    }

    private fun waitUntil(timeoutMs: Long, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition()) {
            if (System.currentTimeMillis() > deadline) fail("condition not met within $timeoutMs ms")
            Thread.sleep(100)
        }
    }
}
