package market.grogoni.app.auth

import android.app.Activity
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.widget.*
import androidx.activity.ComponentActivity
import market.grogoni.app.sms.GrogoniSessionStore
import market.grogoni.app.sms.NativeApiException
import market.grogoni.app.sms.NativePhoneNormalizer
import market.grogoni.app.sms.NativeSmsWork
import org.json.JSONObject
import java.util.concurrent.Executors

/** Native sign-in and recovery. Secrets are never persisted or included in saved instance state. */
class AccountActivity : ComponentActivity() {
    private enum class Stage { LOGIN, MFA, EMAIL_CODE, EMAIL_PASSWORD, DEVICE_RESET, ACCOUNT }
    private var stage = Stage.LOGIN
    private var transactionId = ""
    private var factors = listOf<String>()
    private var phoneValue = ""
    private var resetPassword = false
    private var hasPin = true
    private var busy = false
    private var message = "Sign in with your phone number and PIN or password."
    private lateinit var content: LinearLayout
    private lateinit var status: TextView
    private val executor = Executors.newSingleThreadExecutor()
    private val client by lazy { NativeAuthClient(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        phoneValue = GrogoniSessionStore(this).accountPhone.orEmpty()
        if (GrogoniSessionStore(this).cookieHeader != null) {
            stage = Stage.ACCOUNT
            message = "Signed in. Secure this device before you need to recover a forgotten PIN or password."
        }
        render()
    }

    private fun render() {
        content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 40, 32, 40) }
        content.addView(TextView(this).apply { text = "Grogoni account"; textSize = 26f })
        status = TextView(this).apply { text = message; setPadding(0, 24, 0, 24); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        content.addView(status)
        when (stage) {
            Stage.LOGIN -> loginForm()
            Stage.MFA -> mfaForm()
            Stage.EMAIL_CODE -> emailCodeForm()
            Stage.EMAIL_PASSWORD -> resetForm(email = true)
            Stage.DEVICE_RESET -> resetForm(email = false)
            Stage.ACCOUNT -> accountForm()
        }
        if (stage != Stage.LOGIN && stage != Stage.ACCOUNT) button("Cancel recovery or verification") {
            transactionId = ""; factors = emptyList(); stage = Stage.LOGIN
            message = "Choose how to sign in or recover your account."; render()
        }
        setContentView(ScrollView(this).apply { addView(content) })
    }

    private fun loginForm() {
        val phone = field("Phone number (+country code)", InputType.TYPE_CLASS_PHONE).apply { setText(phoneValue) }
        val password = CheckBox(this).apply { text = "Sign in with password instead of PIN" }.also(content::addView)
        val secret = secret("PIN (4 digits)", pin = true)
        password.setOnCheckedChangeListener { _, checked ->
            secret.setText("")
            secret.hint = if (checked) "Password" else "PIN (4 digits)"
            secret.inputType = if (checked) PASSWORD_INPUT else PIN_INPUT
        }
        button("Sign in") {
            val normalized = normalize(phone.text.toString()) ?: return@button
            val value = secret.text.toString(); val usePassword = password.isChecked
            runAction {
                val result = client.login(normalized, value, usePassword)
                onUi { phoneValue = normalized; loginResult(result) }
            }
        }
        text("Forgot your PIN or password? Use a recovery key previously secured on this Android app, or your verified backup email. SMS recovery is unavailable.")
        button("Recover PIN with this device") { beginDeviceRecovery(phone.text.toString(), false) }
        button("Recover password with this device") { beginDeviceRecovery(phone.text.toString(), true) }
        val email = field("Verified backup email", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS)
        button("Send email recovery code") {
            val value = email.text.toString().trim()
            runAction {
                val result = client.startEmailRecovery(value)
                onUi {
                    transactionId = result.getString("transactionId"); stage = Stage.EMAIL_CODE
                    message = result.getString("message"); render()
                }
            }
        }
        button("Create an account or manage backup email on the website") {
            startActivity(android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("https://grogoni.com")))
        }
    }

    private fun loginResult(result: JSONObject) {
        if (result.optBoolean("mfaRequired")) {
            transactionId = result.getString("transactionId")
            val array = result.getJSONArray("factors")
            factors = (0 until array.length()).map { array.getString(it) }
            stage = Stage.MFA; message = "Complete your second verification step."; render()
        } else {
            stage = Stage.ACCOUNT
            message = "Signed in. Secure this device for future PIN/password recovery, then return to SMS."
            setResult(Activity.RESULT_OK); render()
        }
    }

    private fun mfaForm() {
        val labels = factors.map { when (it) { "email" -> "Email code"; "totp" -> "Authenticator code"; else -> "Recovery code" } }
        val factor = Spinner(this).apply { adapter = ArrayAdapter(this@AccountActivity, android.R.layout.simple_spinner_dropdown_item, labels) }.also(content::addView)
        val code = field("Verification code", InputType.TYPE_CLASS_TEXT)
        if ("email" in factors) button("Send email verification code") {
            runAction { client.sendEmailMfa(transactionId); onUi { status.text = "Check your verified email for the code." } }
        }
        button("Verify and sign in") {
            val selected = factors.getOrNull(factor.selectedItemPosition) ?: return@button
            val value = code.text.toString().trim()
            runAction { val result = client.verifyMfa(transactionId, selected, value); onUi { loginResult(result) } }
        }
    }

    private fun beginDeviceRecovery(rawPhone: String, password: Boolean) {
        val normalized = normalize(rawPhone) ?: return
        runAction {
            val credentials = client.recoverDevice(normalized)
            onUi {
                phoneValue = normalized; resetPassword = password; hasPin = credentials.getBoolean("hasPin")
                stage = Stage.DEVICE_RESET
                message = "Device verified. Choose a new ${if (password) "password" else "4-digit PIN"}."; render()
            }
        }
    }

    private fun emailCodeForm() {
        val code = field("Email recovery code", InputType.TYPE_CLASS_TEXT)
        button("Verify recovery code") {
            val value = code.text.toString().trim()
            runAction {
                client.verifyEmailRecovery(transactionId, value)
                onUi { stage = Stage.EMAIL_PASSWORD; message = "Email verified. Set a new password. If you also forgot your PIN, secure this device after recovery, then reset your PIN."; render() }
            }
        }
    }

    private fun resetForm(email: Boolean) {
        val password = email || resetPassword
        val label = if (password) "password" else "4-digit PIN"
        val value = secret("New $label", pin = !password)
        val confirm = secret("Confirm $label", pin = !password)
        val mfaCode = if (email) field("Authenticator code (if enabled)", InputType.TYPE_CLASS_TEXT) else null
        button("Reset $label") {
            val newValue = value.text.toString(); val confirmation = confirm.text.toString(); val mfa = mfaCode?.text?.toString()?.trim().orEmpty()
            runAction {
                if (email) client.resetEmailPassword(transactionId, newValue, confirmation, mfa)
                else client.resetDeviceSecret(newValue, confirmation, password, hasPin)
                onUi {
                    transactionId = ""; stage = Stage.ACCOUNT; message = "Your $label was reset. You are signed in."
                    setResult(Activity.RESULT_OK); render()
                }
            }
        }
    }

    private fun accountForm() {
        val session = GrogoniSessionStore(this)
        text("Signed in as ${session.accountPhone.orEmpty()}. Recovery keys stay in this app's Android Keystore. Uninstalling or clearing app data removes access to them. Keep your screen lock enabled and a verified backup email on your account.")
        button("Secure this device for recovery") {
            runAction { val result = client.secureDevice(); onUi { status.text = result } }
        }
        button("Reset PIN using this device") { beginDeviceRecovery(session.accountPhone.orEmpty(), false) }
        button("Reset password using this device") { beginDeviceRecovery(session.accountPhone.orEmpty(), true) }
        button("Forget recovery key on this device") {
            android.app.AlertDialog.Builder(this).setMessage("Remove this device's recovery key? Use your PIN/password or verified email to sign in afterward.")
                .setNegativeButton("Cancel", null).setPositiveButton("Forget key") { _, _ ->
                    DeviceRecoveryKey(this).forget(session.accountPhone.orEmpty()); status.text = "Local recovery key removed."
                }.show()
        }
        button("Return to SMS") { setResult(Activity.RESULT_OK); finish() }
        button("Sign in to another account") {
            // Existing recovery keys remain account-scoped. Invalidate the session before changing identity.
            runAction {
                runCatching { market.grogoni.app.sms.NativeSmsApiClient(this).logout() }
                session.clear(); NativeSmsWork.cancel(this)
                onUi { stage = Stage.LOGIN; message = "Signed out. Sign in to another account."; render() }
            }
        }
    }

    private fun runAction(action: () -> Unit) {
        if (busy) return
        busy = true; setEnabled(content, false); status.text = "Please wait…"
        executor.execute {
            try { action() }
            catch (error: Exception) {
                onUi {
                    if (error is NativeApiException && error.code == "device_credential_recovery_required") {
                        stage = Stage.LOGIN; message = "Verify your device again before resetting your credentials."; render()
                    } else status.text = error.message ?: "Unable to complete this request. Try again."
                }
            } finally {
                onUi { busy = false; setEnabled(content, true) }
            }
        }
    }

    private fun normalize(value: String): String? = runCatching {
        NativePhoneNormalizer.normalize(value.trim(), GrogoniSessionStore(this).networkCountryIso)
    }.getOrElse { status.text = it.message; null }

    private fun onUi(action: () -> Unit) = runOnUiThread { if (!isFinishing && !isDestroyed) action() }
    private fun setEnabled(view: View, enabled: Boolean) {
        view.isEnabled = enabled
        if (view is android.view.ViewGroup) for (i in 0 until view.childCount) setEnabled(view.getChildAt(i), enabled)
    }
    private fun text(value: String) = content.addView(TextView(this).apply { text = value; setPadding(0, 20, 0, 20) })
    private fun field(label: String, type: Int) = EditText(this).apply {
        hint = label; contentDescription = label; inputType = type; isSaveEnabled = false
    }.also(content::addView)
    private fun secret(label: String, pin: Boolean) = field(label, if (pin) PIN_INPUT else PASSWORD_INPUT)
    private fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; setOnClickListener { if (!busy) action() } }.also(content::addView)
    override fun onDestroy() { executor.shutdown(); super.onDestroy() }
    companion object {
        private const val PASSWORD_INPUT = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        private const val PIN_INPUT = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
    }
}
