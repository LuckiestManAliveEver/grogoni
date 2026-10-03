package market.grogoni.app

import android.Manifest
import android.app.role.RoleManager
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Telephony
import android.telephony.SubscriptionManager
import android.telephony.TelephonyManager
import android.text.InputType
import android.view.View
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import market.grogoni.app.sms.AndroidSmsSender
import market.grogoni.app.sms.NativePhoneNormalizer
import market.grogoni.app.sms.NativeSmsApiClient
import market.grogoni.app.sms.NativeSmsCapability
import market.grogoni.app.sms.NativeSmsCommand
import market.grogoni.app.sms.NativeSmsStore
import market.grogoni.app.sms.NativeSmsWork
import market.grogoni.app.sms.GrogoniSessionStore
import java.util.UUID

class MainActivity : ComponentActivity() {
    private lateinit var status: TextView
    private lateinit var businessSpinner: Spinner
    private lateinit var chooseBusiness: Button
    private lateinit var phone: EditText
    private lateinit var pin: EditText
    private lateinit var login: Button
    private lateinit var logout: Button
    private lateinit var enableSms: Button
    private lateinit var recipient: EditText
    private lateinit var body: EditText
    private lateinit var send: Button
    private var businesses: List<Pair<String, String>> = emptyList()

    private val roleRequest = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { requestRestrictedPermissionsAfterRole() }
    private val permissionRequest = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { refreshAndRegister() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildScreen())
        prefillSendToIntent(intent)
        refreshAndRegister()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        prefillSendToIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        renderCapability()
    }

    private fun buildScreen(): View {
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(40, 48, 40, 48)
        }
        content.addView(TextView(this).apply {
            text = "Native SMS"
            textSize = 28f
        })
        content.addView(TextView(this).apply {
            text = "Use this Android phone and its selected SIM to synchronize new business SMS with Grogoni. Your carrier may charge for every segment."
            textSize = 16f
        })
        status = TextView(this).also {
            it.setPadding(0, 28, 0, 20)
            content.addView(it)
        }
        phone = field("Grogoni phone number (+country code)").also(content::addView)
        pin = field("Grogoni PIN").also {
            it.inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            content.addView(it)
        }
        login = Button(this).apply {
            text = "Sign in to Grogoni"
            setOnClickListener { login() }
        }.also(content::addView)
        logout = Button(this).apply {
            text = "Sign out and stop Grogoni SMS sync"
            setOnClickListener { logout() }
        }.also(content::addView)
        businessSpinner = Spinner(this).also(content::addView)
        chooseBusiness = Button(this).apply {
            text = "Use selected business for incoming SMS"
            setOnClickListener { selectBusiness() }
        }.also(content::addView)
        enableSms = Button(this).apply {
            text = "Enable native SMS"
            setOnClickListener { requestSmsRole() }
        }.also(content::addView)
        content.addView(TextView(this).apply {
            text = "Compose carrier SMS"
            textSize = 20f
            setPadding(0, 36, 0, 8)
        })
        recipient = field("Recipient phone number").also(content::addView)
        body = field("Message").also {
            it.minLines = 3
            it.gravity = android.view.Gravity.TOP
            content.addView(it)
        }
        send = Button(this).apply {
            text = "Send via SIM"
            setOnClickListener { sendUserConfirmedSms() }
        }.also(content::addView)
        return ScrollView(this).apply { addView(content) }
    }

    private fun field(hint: String) = EditText(this).apply {
        this.hint = hint
        inputType = InputType.TYPE_CLASS_TEXT
    }

    private fun login() {
        val country = getSystemService(TelephonyManager::class.java)?.networkCountryIso
        val normalized = runCatching {
            NativePhoneNormalizer.normalize(phone.text.toString(), country)
        }.getOrElse {
            status.text = it.message
            return
        }
        setBusy(true)
        Thread {
            runCatching { NativeSmsApiClient(this).login(normalized, pin.text.toString()) }
                .onSuccess { loaded -> runOnUiThread {
                    businesses = loaded
                    showBusinesses()
                    status.text = if (loaded.isEmpty()) {
                        "Signed in, but this account has no business to receive SMS."
                    } else {
                        "Signed in. Choose the business that should receive new carrier SMS."
                    }
                    setBusy(false)
                } }
                .onFailure { error -> runOnUiThread {
                    status.text = error.message ?: "Grogoni sign-in failed."
                    setBusy(false)
                } }
        }.start()
    }

    private fun logout() {
        setBusy(true)
        Thread {
            runCatching { NativeSmsApiClient(this).logout() }
            GrogoniSessionStore(this).clear()
            NativeSmsWork.cancel(this)
            runOnUiThread {
                businesses = emptyList()
                showBusinesses()
                status.text = "Signed out. Remote SMS commands and Grogoni synchronization are stopped."
                setBusy(false)
            }
        }.start()
    }

    private fun showBusinesses() {
        businessSpinner.adapter = ArrayAdapter(
            this,
            android.R.layout.simple_spinner_dropdown_item,
            businesses.map { it.second },
        )
        businessSpinner.visibility = if (businesses.isEmpty()) View.GONE else View.VISIBLE
        chooseBusiness.visibility = businessSpinner.visibility
        if (businesses.size == 1) {
            GrogoniSessionStore(this).businessId = businesses.first().first
            NativeSmsWork.schedule(this)
        }
    }

    private fun selectBusiness() {
        val selected = businesses.getOrNull(businessSpinner.selectedItemPosition) ?: return
        GrogoniSessionStore(this).businessId = selected.first
        status.text = "${selected.second} will receive newly synchronized SMS."
        NativeSmsWork.schedule(this)
    }

    private fun requestSmsRole() {
        status.text = "Android will ask you to make Grogoni the default SMS handler before requesting restricted SMS permissions."
        val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getSystemService(RoleManager::class.java).createRequestRoleIntent(RoleManager.ROLE_SMS)
        } else {
            Intent(Telephony.Sms.Intents.ACTION_CHANGE_DEFAULT).putExtra(
                Telephony.Sms.Intents.EXTRA_PACKAGE_NAME,
                packageName,
            )
        }
        roleRequest.launch(intent)
    }

    private fun requestRestrictedPermissionsAfterRole() {
        if (!NativeSmsCapability.inspect(this).roleGranted) {
            renderCapability()
            return
        }
        permissionRequest.launch(
            arrayOf(
                Manifest.permission.SEND_SMS,
                Manifest.permission.RECEIVE_SMS,
                Manifest.permission.READ_SMS,
                Manifest.permission.WRITE_SMS,
            ),
        )
    }

    private fun refreshAndRegister() {
        renderCapability()
        if (GrogoniSessionStore(this).cookieHeader != null) {
            Thread {
                runCatching { NativeSmsApiClient(this).businesses() }.onSuccess { loaded ->
                    runOnUiThread {
                        businesses = loaded
                        showBusinesses()
                    }
                }
            }.start()
            NativeSmsWork.schedule(this)
        }
    }

    private fun renderCapability() {
        val state = NativeSmsCapability.inspect(this)
        status.text = when {
            !state.roleAvailable -> "Native SMS unavailable: this device has no supported SMS role."
            !state.roleGranted -> "Setup required: make Grogoni the default SMS app."
            !state.sendPermissionGranted || !state.receivePermissionGranted ->
                "Setup required: grant SMS permissions after granting the SMS role."
            !state.simReady -> "Setup required: select an Android default SMS SIM."
            GrogoniSessionStore(this).cookieHeader == null -> "SMS ready locally. Sign in to synchronize with Grogoni."
            GrogoniSessionStore(this).businessId == null -> "SMS ready. Select a Grogoni business for inbound messages."
            else -> "Native SMS ready · SIM active · synchronization enabled"
        }
        enableSms.text = if (state.ready) "Review SMS setup" else "Continue SMS setup"
        send.isEnabled = state.ready
    }

    private fun sendUserConfirmedSms() {
        val session = GrogoniSessionStore(this)
        val normalized = runCatching {
            NativePhoneNormalizer.normalize(recipient.text.toString(), session.networkCountryIso)
        }.getOrElse {
            status.text = it.message
            return
        }
        val text = body.text.toString().trim()
        if (text.isEmpty()) {
            status.text = "Enter an SMS message."
            return
        }
        val commandId = "local:${UUID.randomUUID()}"
        val store = NativeSmsStore(this)
        runCatching {
            check(store.claimCommand(commandId))
            store.markCommandExecutionStarted(commandId)
            AndroidSmsSender(this).send(
                NativeSmsCommand(
                    commandId,
                    normalized,
                    text,
                    SubscriptionManager.getDefaultSmsSubscriptionId().takeIf {
                        it != SubscriptionManager.INVALID_SUBSCRIPTION_ID
                    },
                    reportToGrogoni = false,
                ),
            )
        }.onSuccess {
            status.text = "SMS submitted to Android telephony. Delivery reporting depends on the carrier."
            body.text.clear()
        }.onFailure { status.text = it.message ?: "SMS sending failed." }
    }

    private fun prefillSendToIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SENDTO) return
        recipient.setText(intent.data?.schemeSpecificPart?.substringBefore(',').orEmpty())
        body.setText(intent.getStringExtra("sms_body") ?: intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty())
    }

    private fun setBusy(busy: Boolean) {
        login.isEnabled = !busy
        logout.isEnabled = !busy
        enableSms.isEnabled = !busy
        chooseBusiness.isEnabled = !busy
    }
}
