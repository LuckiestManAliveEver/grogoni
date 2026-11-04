package market.grogoni.app.sms

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import market.grogoni.app.MainActivity
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class SharedMessengerUiInstrumentedTest {
    @Test fun signedBundleRendersSharedReactScreenAndReadsTheActualSmsProvider() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            val deadline = android.os.SystemClock.elapsedRealtime() + 45_000
            var text = ""
            while (android.os.SystemClock.elapsedRealtime() < deadline) {
                val latch = CountDownLatch(1)
                scenario.onActivity { activity ->
                    activity.webView.evaluateJavascript("JSON.stringify({text:document.body.innerText, native:document.getElementsByName('grogoni-native-channel').length>0})") {
                        text = it; latch.countDown()
                    }
                }
                assertTrue(latch.await(5, TimeUnit.SECONDS))
                if (text.contains("grogoni-emulator-private-sms-20261103")) break
                Thread.sleep(250)
            }
            assertTrue("Shared UI did not render: $text", text.contains("Messages"))
            assertTrue("Native channel did not return provider messages: $text", text.contains("grogoni-emulator-private-sms-20261103"))
            assertFalse(text.contains("adapter did not start"))
            scenario.onActivity { activity ->
                activity.webView.evaluateJavascript("window.__gzipAsset=null;fetch('/tesseract/lang/eng.traineddata.gz').then(r=>r.arrayBuffer()).then(b=>{const a=new Uint8Array(b);window.__gzipAsset=[a[0],a[1],a.length]}).catch(()=>window.__gzipAsset=[])", null)
            }
            var asset = "null"
            val assetDeadline = android.os.SystemClock.elapsedRealtime() + 10_000
            while (android.os.SystemClock.elapsedRealtime() < assetDeadline) {
                val latch = CountDownLatch(1)
                scenario.onActivity { activity -> activity.webView.evaluateJavascript("JSON.stringify(window.__gzipAsset)") { asset = it; latch.countDown() } }
                assertTrue(latch.await(5, TimeUnit.SECONDS))
                if (asset.contains("31,139,")) break
                Thread.sleep(100)
            }
            assertTrue("Compressed shared OCR asset must retain gzip bytes: $asset", asset.contains("31,139,"))
        }
    }
}
