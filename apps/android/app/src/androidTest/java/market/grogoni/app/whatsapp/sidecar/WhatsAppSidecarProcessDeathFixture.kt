package market.grogoni.app.whatsapp.sidecar

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import market.grogoni.app.sms.GrogoniSessionStore
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Manual process-death check (docs/architecture/whatsapp-linked-devices.md, Android sidecar).
 * Skipped unless an argument asks for it, because it deliberately leaves the service running:
 *
 *   adb shell am instrument -w -e sidecarFixture start -e class \
 *     market.grogoni.app.whatsapp.sidecar.WhatsAppSidecarProcessDeathFixture \
 *     market.grogoni.app.test/androidx.test.runner.AndroidJUnitRunner
 *   adb shell ps -A -o PID,PPID,NAME | grep -E 'grogoni'    # app + libgrogoni_node.so child
 *   adb shell run-as market.grogoni.app kill -9 <app pid>  # node exits on stdin EOF
 *   # Android restarts the START_STICKY service, which spawns a new sidecar.
 *   ... -e sidecarFixture clean ...                       # stops it and removes the test session
 */
@RunWith(AndroidJUnit4::class)
class WhatsAppSidecarProcessDeathFixture {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val mode = InstrumentationRegistry.getArguments().getString("sidecarFixture")
    private val account = "acct_process_death_fixture"

    @Test fun startAndLeaveRunning() {
        assumeTrue(mode == "start")
        GrogoniSessionStore(context).saveAuthenticatedSession(account, "254700000000", "grogoni_session=fixture")
        WhatsAppSidecar.setEnabled(context, account)
        WhatsAppSidecarService.start(context)
        val deadline = System.currentTimeMillis() + 90_000
        while (!WhatsAppSidecar.controller(context).running) {
            check(System.currentTimeMillis() < deadline) { "sidecar did not start" }
            Thread.sleep(100)
        }
    }

    @Test fun clean() {
        assumeTrue(mode == "clean")
        WhatsAppSidecarService.stop(context)
        WhatsAppSidecar.controller(context).stop()
        WhatsAppSidecar.setEnabled(context, null)
        WhatsAppSidecar.controller(context).ownerDirectory(account).deleteRecursively()
        GrogoniSessionStore(context).clear()
    }
}
