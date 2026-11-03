package market.grogoni.app.auth

import android.app.KeyguardManager
import android.security.keystore.KeyInfo
import java.security.KeyFactory
import java.security.KeyStore
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assume.assumeTrue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import android.view.accessibility.AccessibilityNodeInfo
import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import market.grogoni.app.sms.*
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.Assert.*
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeAuthInstrumentedTest {
    private val context = ApplicationProvider.getApplicationContext<Context>()
    private val session = GrogoniSessionStore(context)
    private val keys = DeviceRecoveryKey(context)
    private val phone = "+15550001111"
    private val account = "native-recovery-test"
    private var requests = mutableListOf<String>()
    private var handler: (String, JSONObject?, String?) -> NativeApiResponse = { _, _, _ -> error("Unexpected request") }
    private val transport = NativeApiTransport { _, path, body, cookie -> requests.add(path); handler(path, body, cookie) }
    private val api = NativeApiClient(session, transport)
    private val client = NativeAuthClient(context, session, api, keys)
    private fun authenticated(cookies: String = "grogoni_session=test; grogoni_refresh=refresh") = NativeApiResponse(200,
        JSONObject().put("account", JSONObject().put("id", account).put("primaryAuthDestination", phone)), cookies)

    @Before fun before() { session.clear(); keys.forget(phone); requests.clear() }
    @After fun after() { session.clear(); keys.forget(phone) }

    @Test fun passwordLoginAndMfaOnlyStoreCookiesAfterFullVerification() {
        handler = { path, body, cookie ->
            assertNull(cookie)
            when (path) {
                "/auth/login/password" -> {
                    assertEquals(phone, body!!.getString("identifier"))
                    assertEquals("test password", body.getString("password"))
                    NativeApiResponse(202, JSONObject().put("mfaRequired", true).put("transactionId", "mfa")
                        .put("factors", org.json.JSONArray(listOf("email", "totp"))))
                }
                "/auth/mfa/email/challenge" -> NativeApiResponse(200, JSONObject())
                "/auth/mfa/verify" -> { assertEquals("email", body!!.getString("factor")); authenticated() }
                else -> error(path)
            }
        }
        assertTrue(client.login(phone, "test password", true).getBoolean("mfaRequired"))
        assertNull(session.cookieHeader)
        client.sendEmailMfa("mfa")
        client.verifyMfa("mfa", "email", "123456")
        assertEquals(account, session.accountId)
        assertEquals(phone, session.accountPhone)
        assertTrue(session.cookieHeader!!.contains("grogoni_refresh="))
    }

    @Test fun deviceEnrollmentRecoveryAndSingleUsePinResetUseTheActualKeystore() {
        assumeTrue("Requires a screen-lock configured test emulator", context.getSystemService(KeyguardManager::class.java).isDeviceSecure)
        session.saveAuthenticatedSession(account, phone, "grogoni_session=initial")
        handler = { path, body, cookie ->
            when (path) {
                "/auth/continue" -> {
                    assertNotNull(cookie)
                    val jwk = body!!.getJSONObject("devicePublicKeyJwk")
                    assertEquals("P-256", jwk.getString("crv"))
                    assertFalse(jwk.has("d"))
                    NativeApiResponse(200, authenticated().body.put("deviceRecoveryCredentialId", "credential-test"))
                }
                "/auth/device/recover/options" -> {
                    assertNull(cookie)
                    assertEquals(phone, body!!.getString("identifier"))
                    NativeApiResponse(200, challenge())
                }
                "/auth/device/recover" -> {
                    assertNull(cookie)
                    assertEquals("credential-test", body!!.getString("credentialId"))
                    assertEquals(64, android.util.Base64.decode(body.getString("signature"), android.util.Base64.URL_SAFE).size)
                    authenticated("grogoni_session=recovered; grogoni_refresh=new-refresh")
                }
                "/auth/credentials/status" -> NativeApiResponse(200, JSONObject().put("hasPin", true))
                "/auth/pin/recover/device" -> {
                    assertEquals("1234", body!!.getString("pin"))
                    authenticated("grogoni_session=reset; grogoni_refresh=reset-refresh")
                }
                else -> error(path)
            }
        }
        client.secureDevice()
        assertTrue(keys.hasCredential(phone))
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val keyAlias = keyStore.aliases().toList().first { it.startsWith("grogoni-recovery-v2-") }
        val privateKey = keyStore.getKey(keyAlias, null) as java.security.PrivateKey
        val info = KeyFactory.getInstance(privateKey.algorithm, "AndroidKeyStore").getKeySpec(privateKey, KeyInfo::class.java)
        assertTrue(info.isUserAuthenticationRequired)
        assertNull(privateKey.encoded)
        unlockWithScreenLock()
        session.clear()
        assertTrue(client.recoverDevice(phone).getBoolean("hasPin"))
        client.resetDeviceSecret("1234", "1234", false, true)
        handler = { _, _, _ -> NativeApiResponse(401, JSONObject().put("code", "device_credential_recovery_required").put("message", "Verify again")) }
        val count = requests.size
        assertThrows(NativeApiException::class.java) { client.resetDeviceSecret("5678", "5678", false, true) }
        assertEquals(count + 1, requests.size) // no automatic refresh or reset replay
        assertFalse(requests.contains("/auth/session/refresh"))
    }

    @Test fun verifiedEmailPasswordRecoveryRotatesTheSessionAndSupportsTotp() {
        handler = { path, body, cookie ->
            assertNull(cookie)
            when (path) {
                "/auth/recovery/start" -> {
                    assertEquals("email", body!!.getString("type"))
                    NativeApiResponse(200, JSONObject().put("transactionId", "email-recovery"))
                }
                "/auth/recovery/verify" -> { assertEquals("123456", body!!.getString("code")); NativeApiResponse(200, JSONObject()) }
                "/auth/recovery/reset-password" -> {
                    assertEquals("654321", body!!.getString("mfaCode"))
                    authenticated()
                }
                else -> error(path)
            }
        }
        client.startEmailRecovery("backup@example.test")
        client.verifyEmailRecovery("email-recovery", "123456")
        client.resetEmailPassword("email-recovery", "replacement password", "replacement password", "654321")
        assertEquals(account, session.accountId)
        assertEquals(listOf("/auth/recovery/start", "/auth/recovery/verify", "/auth/recovery/reset-password"), requests)
    }

    @Test fun expiredDeviceProofIsClearedAndCrossAccountResponsesAreRejected() {
        assumeTrue(context.getSystemService(KeyguardManager::class.java).isDeviceSecure)
        session.saveAuthenticatedSession(account, phone, "grogoni_session=test")
        handler = { _, _, _ -> NativeApiResponse(200, authenticated().body.put("deviceRecoveryCredentialId", "credential-test")) }
        client.secureDevice()
        session.clear()
        unlockWithScreenLock()
        handler = { path, _, _ -> if (path.endsWith("/options")) NativeApiResponse(200, challenge()) else NativeApiResponse(200, JSONObject().put("account", JSONObject().put("id", "other-account").put("primaryAuthDestination", phone)), "grogoni_session=other") }
        assertThrows(IllegalArgumentException::class.java) { client.recoverDevice(phone) }
        assertNull(session.cookieHeader)
        handler = { path, _, _ -> if (path.endsWith("/options")) NativeApiResponse(200, challenge()) else NativeApiResponse(401, JSONObject().put("message", "Device revoked")) }
        assertThrows(NativeApiException::class.java) { client.recoverDevice(phone) }
        assertFalse(keys.hasCredential(phone))
    }

    @Test fun refusesRecoveryEnrollmentWithoutADeviceScreenLock() {
        assumeTrue(!context.getSystemService(KeyguardManager::class.java).isDeviceSecure)
        session.saveAuthenticatedSession(account, phone, "grogoni_session=test")
        assertThrows(IllegalStateException::class.java) { client.secureDevice() }
        assertTrue(requests.isEmpty())
    }

    @Test fun unregisteredDeviceCannotStartRecoveryOrSendNetworkRequests() {
        assertThrows(IllegalStateException::class.java) { client.recoverDevice(phone) }
        assertTrue(requests.isEmpty())
    }

    private fun challenge() = JSONObject().put("challengeId", "test-server-challenge")
        .put("issuedAt", System.currentTimeMillis()).put("nonce", "server-issued-nonce-for-test-00001")

    /** Exercises the actual system credential prompt; opt in only on a disposable test emulator. */
    private fun unlockWithScreenLock() {
        val pin = InstrumentationRegistry.getArguments().getString("deviceSecurityTestPin")
        assumeTrue("Pass deviceSecurityTestPin for interactive device authentication tests", !pin.isNullOrBlank())
        val completed = CountDownLatch(1)
        ActivityScenario.launch(AccountActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val unlock = AccountActivity::class.java.getDeclaredMethod("unlockDevice", kotlin.jvm.functions.Function0::class.java)
                unlock.isAccessible = true
                unlock.invoke(activity, { completed.countDown(); Unit })
            }
            val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
            val deadline = System.currentTimeMillis() + 10_000
            fun editable(node: AccessibilityNodeInfo?): Boolean {
                if (node == null) return false
                if (node.className?.toString()?.contains("EditText") == true) return true
                return (0 until node.childCount).any { editable(node.getChild(it)) }
            }
            while (!editable(automation.rootInActiveWindow) && System.currentTimeMillis() < deadline) {
                automation.rootInActiveWindow?.findAccessibilityNodeInfosByText("Use PIN")?.firstOrNull()
                    ?.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                Thread.sleep(100)
            }
            automation.executeShellCommand("input text $pin").use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes() }
            automation.executeShellCommand("input keyevent 66").use { android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes() }
            assertTrue("System screen-lock authentication must complete", completed.await(15, TimeUnit.SECONDS))
        }
    }

    @Test fun sessionRefreshMergesCookiesButNeverRetriesAsAnotherAccount() {
        session.saveAuthenticatedSession(account, phone, "grogoni_session=old; grogoni_refresh=keep")
        var attempts = 0
        handler = { path, _, cookie ->
            when (path) {
                "/auth/session/refresh" -> NativeApiResponse(200, JSONObject(), "grogoni_session=new")
                "/test" -> {
                    attempts++
                    if (attempts == 1) NativeApiResponse(401, JSONObject()) else {
                        assertTrue(cookie!!.contains("grogoni_refresh=keep")); NativeApiResponse(200, JSONObject())
                    }
                }
                else -> error(path)
            }
        }
        api.request("GET", "/test")
        assertEquals(2, attempts)
        requests.clear()
        handler = { _, _, _ ->
            session.saveAuthenticatedSession("other", "+15550002222", "grogoni_session=other")
            NativeApiResponse(401, JSONObject())
        }
        assertThrows(NativeApiException::class.java) { api.request("GET", "/test") }
        assertEquals(listOf("/test"), requests)
    }
    @Test fun nativeAccountScreenProtectsSecretsAndProvidesMissingKeyRecoveryGuidance() {
        androidx.test.core.app.ActivityScenario.launch(AccountActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                assertTrue(activity.window.attributes.flags and android.view.WindowManager.LayoutParams.FLAG_SECURE != 0)
                fun descendants(view: android.view.View): List<android.view.View> = listOf(view) +
                    if (view is android.view.ViewGroup) (0 until view.childCount).flatMap { descendants(view.getChildAt(it)) } else emptyList()
                val views = descendants(activity.window.decorView)
                val phoneInput = views.filterIsInstance<android.widget.EditText>().first { it.hint.toString().startsWith("Phone number") }
                phoneInput.setText(phone)
                val secret = views.filterIsInstance<android.widget.EditText>().first { it.hint.toString().startsWith("PIN") }
                assertFalse(secret.isSaveEnabled)
                secret.setText("1234")
                views.filterIsInstance<android.widget.CheckBox>().single().performClick()
                assertEquals("", secret.text.toString())
                views.filterIsInstance<android.widget.Button>().first { it.text.toString() == "Recover PIN with this device" }.performClick()
            }
            var guidanceVisible = false
            repeat(30) {
                androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().waitForIdleSync()
                scenario.onActivity { activity ->
                    fun contains(view: android.view.View): Boolean =
                        (view is android.widget.TextView && view.text.toString().contains("Device recovery is not set up") && view.text.toString().contains("verified backup email")) ||
                        (view is android.view.ViewGroup && (0 until view.childCount).any { contains(view.getChildAt(it)) })
                    guidanceVisible = contains(activity.window.decorView)
                }
                if (!guidanceVisible) Thread.sleep(100)
            }
            assertTrue("Missing recovery key must offer verified-email fallback", guidanceVisible)
        }
    }

}
