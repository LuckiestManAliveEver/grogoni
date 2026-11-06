package market.grogoni.app.auth

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Saves a real Keystore chain, which tests/android-key-attestation.test.ts checks on the server. */
@RunWith(AndroidJUnit4::class)
class DeviceKeyAttestationInstrumentedTest {
    @Test fun recoveryKeysCarryAnAttestationChain() {
        val context = ApplicationProvider.getApplicationContext<Context>()
        val key = DeviceRecoveryKey(context)
        val accountId = "attestation-fixture-account"
        val jwk = key.publicJwk(accountId)
        val chain = key.attestationChain(accountId)
        assertTrue("chain has ${chain.length()} certificates", chain.length() > 1)
        File(context.filesDir, "attestation-fixture.json").writeText(
            JSONObject().put("accountId", accountId).put("publicKeyJwk", jwk).put("chain", chain).toString())
    }
}
