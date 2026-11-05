package market.grogoni.app

import android.Manifest
import android.app.role.RoleManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.GeolocationPermissions
import android.provider.Telephony
import android.webkit.*
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.ActivityResultLauncher
import androidx.core.view.WindowInsetsCompat
import androidx.activity.result.contract.ActivityResultContracts
import market.grogoni.app.sms.DefaultSmsRole
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
    private val checklist by lazy { PermissionChecklist(this) }
    private var checklistRequest: PermissionChecklist.Request? = null
    private var checklistAsked: List<String> = emptyList()
    private val checklistQueue: ChecklistRequestQueue by lazy { ChecklistRequestQueue(object : ChecklistRequestQueue.Host {
        override fun group(id: String) = checklist.group(id)
        override fun status(group: ChecklistGroup) = checklist.status(group)
        override fun roleHeld() = checklist.smsRoleHeld()
        override fun granted() = checklist.granted()
        override fun snapshot(): Any = checklist.snapshot()
        override fun launchRole(group: ChecklistGroup): Boolean {
            val intent = smsRoleIntent() ?: return false
            val request = checklist.prepare(group, emptyList())
            if (runCatching { checklistRole.launch(intent) }.isFailure) return false
            checklist.markAsked(group.id); checklistRequest = request; return true
        }
        override fun launchPermissions(group: ChecklistGroup, permissions: List<String>): Boolean {
            val request = checklist.prepare(group, permissions)
            if (runCatching { checklistPermissions.launch(permissions.toTypedArray()) }.isFailure) return false
            checklist.markAsked(group.id); checklistRequest = request; checklistAsked = permissions; return true
        }
    }) }
    private val checklistRole: ActivityResultLauncher<Intent> = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        val request = checklistRequest; checklistRequest = null
        if (request != null) { checklist.finishRole(request); checklistQueue.onRoleResult(request.id) }
        else checklistQueue.onPermissionsResult()
    }
    private val checklistPermissions: ActivityResultLauncher<Array<String>> = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        checklistRequest?.let { checklist.finishPermissions(it, checklistAsked) }
        checklistRequest = null; checklistQueue.onPermissionsResult()
    }
    private var pendingCapture: Pair<ValueCallback<Array<Uri>>, Uri>? = null
    private val capture = registerForActivityResult(ActivityResultContracts.TakePicture()) { saved ->
        val (callback, uri) = pendingCapture ?: return@registerForActivityResult
        pendingCapture = null
        callback.onReceiveValue(if (saved) arrayOf(uri) else null)
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
                webFileCallback?.onReceiveValue(null); webFileCallback = null
                pendingCapture?.first?.onReceiveValue(null); pendingCapture = null
                val types = parameters.acceptTypes.filter { it.contains('/') }.toTypedArray()
                // <input capture> for photos opens the camera when the checklist's Camera item is allowed.
                // Android rejects ACTION_IMAGE_CAPTURE from an app that declares CAMERA without holding it.
                if (PermissionChecklistPolicy.cameraCaptureAllowed(trusted(Uri.parse(view.url.orEmpty())), parameters.isCaptureEnabled,
                        types.toList(), AndroidPermissionPolicy.grantedPermissions(this@MainActivity))) {
                    val file = java.io.File(cacheDir, "web-capture").apply { mkdirs() }.resolve("${UUID.randomUUID()}.jpg")
                    val uri = androidx.core.content.FileProvider.getUriForFile(this@MainActivity, "$packageName.mms-files", file)
                    if (runCatching { capture.launch(uri) }.isSuccess) { pendingCapture = callback to uri; return true }
                }
                webFileCallback = callback
                webFiles.launch(if (types.isEmpty()) arrayOf("*/*") else types)
                return true
            }
            // In-app location features (shop location) reach Android location only for the pinned origin.
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                val allowed = PermissionChecklistPolicy.geolocationAllowed(trusted(Uri.parse(origin)), AndroidPermissionPolicy.grantedPermissions(this@MainActivity))
                callback.invoke(origin, allowed, false)
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
                        // A destroyed WebView reports a null URL; late messages during teardown must not crash.
                        val current = webView.url ?: return
                        if (isDestroyed || generation != activeGeneration || !trusted(Uri.parse(current))) return
                        handle(message.data.orEmpty(), activeGeneration)
                    }
                })
                view.postWebMessage(WebMessage("grogoni-device:$channelToken", arrayOf(ports[1])), Uri.parse(ORIGIN))
            }
            override fun onReceivedSslError(view: WebView, handler: android.webkit.SslErrorHandler, error: android.net.http.SslError) { handler.cancel() }
        }
        // Android 15 draws edge to edge for target SDK 35 and the WebView reports no safe area, so the
        // host keeps the page clear of the status bar, navigation bar, cutout and keyboard.
        val root = android.widget.FrameLayout(this).apply { addView(webView) }
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        setContentView(root)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() { if (webView.canGoBack()) webView.goBack() else finish() }
        })
        loadIntent(intent)
        // Camera captures are handed to the page once; a day later they are no longer needed.
        executor.execute {
            val cutoff = System.currentTimeMillis() - 24 * 60 * 60 * 1000L
            java.io.File(cacheDir, "web-capture").listFiles()?.filter { it.lastModified() < cutoff }?.forEach { it.delete() }
        }
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); loadIntent(intent) }
    // Pausing the WebView lets the page see visibility changes (the checklist re-reads grants on return from Settings).
    override fun onResume() { super.onResume(); webView.onResume(); IncomingSmsJournal.schedule(this) }
    override fun onPause() { webView.onPause(); super.onPause() }
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
                if (pendingRole != null || checklistQueue.busy) { callback(null, "SMS setup is already open."); return }
                pendingRole = callback
                if (DefaultSmsRole.held(this)) requestSmsPermissions()
                else {
                    val intent = smsRoleIntent()
                    if (intent == null) { pendingRole = null; callback(null, "This device does not support carrier messaging.") }
                    else roleRequest.launch(intent)
                }
            }
            "permissionChecklist" -> callback(checklist.snapshot(), null)
            "completePermissionChecklist" -> {
                checklistQueue.cancel()
                callback(checklist.complete(), null)
            }
            "requestPermissionGroup", "requestAllPermissions" -> {
                if (pendingRole != null) { callback(null, "A permission request is already open."); return }
                val ids = if (method == "requestAllPermissions") PermissionChecklistPolicy.groups().map { it.id }
                    else listOf(request.optJSONObject("params")?.optString("id").orEmpty())
                checklistQueue.start(ids, callback)?.let { error -> callback(null, error) }
            }
            "openPermissionSettings" -> {
                val group = checklist.group(request.optJSONObject("params")?.optString("id").orEmpty())
                if (group == null) { callback(null, "Unknown device permission."); return }
                val appDetails = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
                val intent = when {
                    group.needsSmsRole && !checklist.smsRoleHeld() ->
                        if (Build.VERSION.SDK_INT >= 24) Intent(Settings.ACTION_MANAGE_DEFAULT_APPS_SETTINGS) else smsRoleIntent() ?: appDetails
                    group.id == "notifications" && Build.VERSION.SDK_INT >= 26 ->
                        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    else -> appDetails
                }
                runCatching { startActivity(intent) }.recoverCatching { startActivity(appDetails) }
                    .onSuccess { callback(checklist.snapshot(), null) }
                    .onFailure { callback(null, "Android settings could not be opened.") }
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
    private fun smsRoleIntent(): Intent? = if (Build.VERSION.SDK_INT >= 29) {
        val manager = getSystemService(RoleManager::class.java)
        if (manager.isRoleAvailable(RoleManager.ROLE_SMS)) manager.createRequestRoleIntent(RoleManager.ROLE_SMS) else null
    } else Intent(Telephony.Sms.Intents.ACTION_CHANGE_DEFAULT).putExtra(Telephony.Sms.Intents.EXTRA_PACKAGE_NAME, packageName)
    private fun requestSmsPermissions() {
        if (!DefaultSmsRole.held(this)) {
            pendingRole?.invoke(adapter.capabilities(), null); pendingRole = null; return
        }
        val needed = setOf(Manifest.permission.SEND_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS,
            Manifest.permission.RECEIVE_MMS, Manifest.permission.RECEIVE_WAP_PUSH) +
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
