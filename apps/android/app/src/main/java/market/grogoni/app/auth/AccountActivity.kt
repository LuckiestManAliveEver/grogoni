package market.grogoni.app.auth

import android.widget.Toast
import market.grogoni.app.MainActivity

/** Shared account route plus the OS credential gate used by native-key integrations. */
class AccountActivity : MainActivity() {
    override fun initialRoute() = "/login"
    private fun unlockDevice(action: () -> Unit) {
        unlockDeviceKey { error ->
            if (error == null) action() else Toast.makeText(this, error, Toast.LENGTH_LONG).show()
        }
    }
}
