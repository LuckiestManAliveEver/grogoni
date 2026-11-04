package market.grogoni.app

import android.Manifest
import android.app.role.RoleManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Telephony
import android.webkit.*
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import market.grogoni.app.sms.DeviceMessagingAdapter
import market.grogoni.app.sms.IncomingSmsJournal
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.UUID
import java.util.concurrent.Executors

/** Hosts the same signed web build as every other platform. No second messenger UI. */
open class MainActivity : ComponentActivity() {
    lateinit var webView: WebView
        private set
    private val executor = Executors.newSingleThreadExecutor()
    private val adapter by lazy { DeviceMessagingAdapter(this) }
    private val deviceUnlock = market.grogoni.app.auth.DeviceUnlockGate(this)
    private var port: WebMessagePort? = null
    private var generation = 0
    @Volatile private var channelToken = ""
    private var pendingRole: ((Any?, String?) -> Unit)? = null
    private var webFileCallback: ValueCallback<Array<Uri>>? = null
    private val webFiles = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        webFileCallback?.onReceiveValue(uris.toTypedArray()); webFileCallback = null
    }
    private var pendingPicker: ((Any?, String?) -> Unit)? = null
    private val roleRequest = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        requestSmsPermissions()
    }
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        pendingRole?.invoke(adapter.capabilities(), null); pendingRole = null
    }
    private val picker = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val callback = pendingPicker; pendingPicker = null
        if (uri == null) callback?.invoke(JSONObject.NULL, null)
        else {
            runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            executor.execute {
                val result = runCatching { adapter.rememberAttachment(uri) }
                runOnUiThread { callback?.invoke(result.getOrNull(), result.exceptionOrNull()?.message) }
            }
        }
    }

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.setFlags(android.view.WindowManager.LayoutParams.FLAG_SECURE, android.view.WindowManager.LayoutParams.FLAG_SECURE)
        webView = WebView(this)
        webView.isSaveEnabled = false
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = true
            @Suppress("DEPRECATION")
            saveFormData = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
        }
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, parameters: FileChooserParams): Boolean {
                webFileCallback?.onReceiveValue(null); webFileCallback = callback
                val types = parameters.acceptTypes.filter { it.contains('/') }.toTypedArray()
                webFiles.launch(if (types.isEmpty()) arrayOf("*/*") else types)
                return true
            }
        }
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val uri = request.url
                if (!trusted(uri) || uri.path.orEmpty().startsWith("/api/")) return null
                if (request.method != "GET") return response(405, "Method Not Allowed", "text/plain", byteArrayOf())
                val path = uri.path.orEmpty().removePrefix("/")
                if (path.split('/').any { it == ".." || it.contains('\\') }) return response(403, "Forbidden", "text/plain", byteArrayOf())
                val packagedPath = if (path.endsWith(".gz")) "$path.bin" else path
                val asset = runCatching { assets.open("web/$packagedPath").use { it.readBytes() } }.getOrNull()
                if (asset != null && path != "index.html") return response(200, "OK", mime(path), asset)
                if (!request.isForMainFrame) return response(404, "Not Found", "text/plain", byteArrayOf())
                val html = assets.open("web/index.html").bufferedReader().use { it.readText() }
                    .replace("<head>", "<head><meta name=\"grogoni-native-channel\" content=\"$channelToken\">")
                return response(200, "OK", "text/html", html.toByteArray())
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (!request.isForMainFrame) return !trusted(request.url)
                if (trusted(request.url) && !request.url.path.orEmpty().startsWith("/api/")) return false
                if (request.url.scheme in setOf("https", "mailto", "tel", "sms", "smsto", "mms", "mmsto"))
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, request.url)) }
                return true
            }
            override fun onPageStarted(view: WebView, url: String, icon: android.graphics.Bitmap?) {
                generation++
                port?.close(); port = null
            }
            override fun onPageFinished(view: WebView, url: String) {
                if (port != null) return
                if (!trusted(Uri.parse(url)) || Uri.parse(url).path.orEmpty().startsWith("/api/")) return
                val ports = view.createWebMessageChannel()
                val activeGeneration = generation
                port = ports[0]
                ports[0].setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                    override fun onMessage(source: WebMessagePort, message: WebMessage) {
                        if (generation != activeGeneration || !trusted(Uri.parse(webView.url))) return
                        handle(message.data.orEmpty(), activeGeneration)
                    }
                })
                view.postWebMessage(WebMessage("grogoni-device:$channelToken", arrayOf(ports[1])), Uri.parse(ORIGIN))
            }
            override fun onReceivedSslError(view: WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError) { handler.cancel() }
        }
        setContentView(webView)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (webView.canGoBack()) webView.goBack() else finish() }
        })
        loadIntent(intent)
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); loadIntent(intent) }
    override fun onResume() { super.onResume(); IncomingSmsJournal.schedule(this) }
    override fun onDestroy() { deviceUnlock.close(); port?.close(); webView.destroy(); executor.shutdown(); super.onDestroy() }
    protected fun unlockDeviceKey(callback: (String?) -> Unit) { deviceUnlock.unlock(callback) }

    protected open fun initialRoute() = "/device-messages"

    private fun loadIntent(intent: Intent?) {
        channelToken = UUID.randomUUID().toString()
        val url = Uri.parse("$ORIGIN${initialRoute()}").buildUpon()
        val data = intent?.data
        if (intent?.getStringExtra("channel") == "mms") url.appendQueryParameter("channel", "mms")
        if (data?.scheme in setOf("sms", "smsto", "mms", "mmsto")) {
            val target = Uri.decode(data!!.encodedSchemeSpecificPart.substringBefore('?'))
            url.appendQueryParameter("to", target)
            val body = intent?.getStringExtra("sms_body") ?: intent?.getStringExtra(Intent.EXTRA_TEXT)
                ?: data.encodedSchemeSpecificPart.substringAfter('?', "").split('&').firstOrNull { it.startsWith("body=") }?.substringAfter('=')?.let(Uri::decode)
            if (body != null) url.appendQueryParameter("body", body)
            if (data.scheme in setOf("mms", "mmsto") || ',' in target || ';' in target) url.appendQueryParameter("channel", "mms")
        }
        webView.loadUrl(url.build().toString())
    }
    private fun handle(raw: String, activeGeneration: Int) {
        if (raw.length > 1_048_576) return
        val request = runCatching { JSONObject(raw) }.getOrNull() ?: return
        val id = request.optString("id")
        if (!id.matches(Regex("[0-9]{1,20}"))) return
        val callback: (Any?, String?) -> Unit = { value, error ->
            if (!isDestroyed && generation == activeGeneration) port?.postMessage(WebMessage(JSONObject().put("id", id)
                .apply { if (error != null) put("error", error) else put("result", value ?: JSONObject.NULL) }.toString()))
        }
        when (val method = request.optString("method")) {
            "signRecoveryChallenge" -> unlockDeviceKey { error ->
                if (error != null) callback(null, error)
                else executor.execute {
                    val result = runCatching { adapter.execute(method, request.optJSONObject("params") ?: JSONObject(), null) }
                    runOnUiThread { callback(result.getOrNull(), result.exceptionOrNull()?.message ?: if (result.isFailure) "Device signature could not be created. Unlock again or use verified backup email." else null) }
                }
            }
            "requestSmsRole" -> {
                if (pendingRole != null) { callback(null, "SMS setup is already open."); return }
                pendingRole = callback
                if (Telephony.Sms.getDefaultSmsPackage(this) == packageName) requestSmsPermissions()
                else if (Build.VERSION.SDK_INT >= 29) {
                    val manager = getSystemService(RoleManager::class.java)
                    if (!manager.isRoleAvailable(RoleManager.ROLE_SMS)) { pendingRole = null; callback(null, "This device does not support carrier messaging.") }
                    else roleRequest.launch(manager.createRequestRoleIntent(RoleManager.ROLE_SMS))
                } else roleRequest.launch(Intent(Telephony.Sms.Intents.ACTION_CHANGE_DEFAULT).putExtra(Telephony.Sms.Intents.EXTRA_PACKAGE_NAME, packageName))
            }
            "pickAttachment" -> {
                if (pendingPicker != null) { callback(null, "The attachment picker is already open."); return }
                pendingPicker = callback
                picker.launch(arrayOf("image/jpeg", "image/png", "image/gif", "video/mp4", "audio/mpeg", "audio/ogg", "audio/amr"))
            }
            else -> {
                val cookie = CookieManager.getInstance().getCookie("${BuildConfig.GROGONI_API_ORIGIN}/")
                executor.execute {
                    val result = runCatching { adapter.execute(method, request.optJSONObject("params") ?: JSONObject(), cookie) }
                    runOnUiThread { callback(result.getOrNull(), result.exceptionOrNull()?.message ?: if (result.isFailure) "Device operation failed." else null) }
                }
            }
        }
    }
    private fun requestSmsPermissions() {
        if (Telephony.Sms.getDefaultSmsPackage(this) != packageName) {
            pendingRole?.invoke(adapter.capabilities(), null); pendingRole = null; return
        }
        val needed = setOf(Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS,
            Manifest.permission.RECEIVE_MMS, Manifest.permission.RECEIVE_WAP_PUSH, Manifest.permission.READ_PHONE_STATE) +
            if (Build.VERSION.SDK_INT >= 33) setOf(Manifest.permission.POST_NOTIFICATIONS) else emptySet()
        val missing = needed - AndroidPermissionPolicy.grantedPermissions(this)
        if (missing.isEmpty()) { pendingRole?.invoke(adapter.capabilities(), null); pendingRole = null }
        else permissions.launch(missing.toTypedArray())
    }
    private fun trusted(uri: Uri): Boolean = uri.scheme == "https" && uri.host == "grogoni.com" && uri.port in setOf(-1, 443)
    private fun response(code: Int, reason: String, type: String, bytes: ByteArray) = WebResourceResponse(type, if (type.startsWith("text/") || type.contains("javascript") || type.contains("json")) "UTF-8" else null,
        code, reason, mapOf("Cache-Control" to "no-store", "X-Content-Type-Options" to "nosniff",
            "Content-Security-Policy" to "object-src 'none'; frame-src 'none'; base-uri 'self'; frame-ancestors 'none'"), ByteArrayInputStream(bytes))
    private fun mime(path: String): String = when (path.substringAfterLast('.').lowercase()) {
        "js", "mjs" -> "application/javascript"; "css" -> "text/css"; "json", "webmanifest" -> "application/json"
        "html" -> "text/html"; "svg" -> "image/svg+xml"; "png" -> "image/png"; "jpg", "jpeg" -> "image/jpeg"
        "wasm" -> "application/wasm"; "woff2" -> "font/woff2"; "ico" -> "image/x-icon"; else -> "application/octet-stream"
    }
    companion object { const val ORIGIN = "https://grogoni.com" }
}
