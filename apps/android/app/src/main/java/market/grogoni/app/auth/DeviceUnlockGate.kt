package market.grogoni.app.auth

import android.app.Activity
import android.app.KeyguardManager
import android.hardware.biometrics.BiometricManager.Authenticators
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

/** The platform owns device unlock UI. Account enrollment/recovery workflows stay shared. */
class DeviceUnlockGate(private val activity: ComponentActivity) {
    private var pending: ((String?) -> Unit)? = null
    private var cancellation: CancellationSignal? = null
    private var fallingBack = false
    private val credential = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        finish(if (it.resultCode == Activity.RESULT_OK) null else "Device unlock cancelled. Use verified backup email if needed.")
    }
    fun unlock(callback: (String?) -> Unit) {
        if (pending != null) { callback("Device unlock is already open."); return }
        val keyguard = activity.getSystemService(KeyguardManager::class.java)
        if (!keyguard.isDeviceSecure) { callback("Set a device screen lock before using device recovery. Use verified backup email if needed."); return }
        pending = callback
        fun screenLock() {
            fallingBack = true
            @Suppress("DEPRECATION")
            val intent = keyguard.createConfirmDeviceCredentialIntent("Recover Grogoni account", "Unlock your registered recovery key")
            if (intent == null) finish("Device screen lock is unavailable. Use verified backup email.") else credential.launch(intent)
        }
        if (Build.VERSION.SDK_INT < 28) { screenLock(); return }
        val signal = CancellationSignal().also { cancellation = it }
        val builder = BiometricPrompt.Builder(activity).setTitle("Unlock with device security")
            .setSubtitle("Use your registered Grogoni recovery key")
        if (Build.VERSION.SDK_INT >= 30) builder.setAllowedAuthenticators(Authenticators.BIOMETRIC_STRONG or Authenticators.DEVICE_CREDENTIAL)
        else builder.setNegativeButton("Use screen lock", activity.mainExecutor) { _, _ -> screenLock() }
        builder.build().authenticate(signal, activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) { finish(null) }
            override fun onAuthenticationError(code: Int, message: CharSequence) {
                if (fallingBack) return
                if (Build.VERSION.SDK_INT < 30 && code != BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED && code != BiometricPrompt.BIOMETRIC_ERROR_CANCELED) screenLock()
                else finish("Device unlock cancelled or unavailable. Try again or use verified backup email.")
            }
        })
    }
    private fun finish(error: String?) {
        val callback = pending; pending = null; cancellation = null; fallingBack = false
        callback?.invoke(error)
    }
    fun close() { cancellation?.cancel(); finish("Device unlock cancelled.") }
}
