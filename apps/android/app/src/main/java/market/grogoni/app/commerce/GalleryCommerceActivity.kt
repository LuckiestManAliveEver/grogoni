package market.grogoni.app.commerce

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import market.grogoni.app.sms.GrogoniSessionStore
import market.grogoni.app.sms.NativeSmsApiClient
import java.io.ByteArrayOutputStream
import org.json.JSONArray
import java.security.MessageDigest
import java.util.concurrent.Executors

/** Scoped document picker only; no MediaStore scan or broad storage permission request. */
class GalleryCommerceActivity : ComponentActivity() {
    private lateinit var status: TextView
    private lateinit var upload: Button
    private val executor = Executors.newSingleThreadExecutor()
    @Volatile private var cancelled = false
    private var selected = emptyList<Uri>()
    private var selectedBusiness: String? = null
    private val queuePreferences by lazy { getSharedPreferences("grogoni-gallery-queue", MODE_PRIVATE) }
    private fun saveQueue(business: String) { queuePreferences.edit().putString("queue:$business", JSONArray(selected.map { it.toString() }).toString()).commit() }
    private fun restoreQueue(business: String): List<Uri> = runCatching {
        val rows = JSONArray(queuePreferences.getString("queue:$business", "[]"))
        (0 until minOf(100, rows.length())).map { Uri.parse(rows.getString(it)) }
    }.getOrDefault(emptyList())
    private val picker = registerForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        val session = GrogoniSessionStore(this)
        val business = session.businessId ?: return@registerForActivityResult
        if (session.cookieHeader == null) return@registerForActivityResult
        selectedBusiness = business
        selected = (selected + uris).distinct().take(100)
        selected.forEach { uri -> runCatching { contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
        saveQueue(business)
        status.text = "${selected.size} selected photos. Upload creates private review jobs only."
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val session = GrogoniSessionStore(this)
        selectedBusiness = session.businessId
        if (session.cookieHeader != null && selectedBusiness != null) selected = restoreQueue(selectedBusiness!!)
        val content = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24) }
        status = TextView(this).apply { text = "${selected.size} saved photos awaiting upload. Select up to 100 product photos. Only chosen files are read. Sign in and select a business on the main screen first." }
        content.addView(status)
        content.addView(Button(this).apply { text = "Choose product photos"; setOnClickListener { picker.launch(arrayOf("image/jpeg", "image/png", "image/webp")) } })
        upload = Button(this).apply {
            text = "Upload selected photos privately"
            setOnClickListener {
                val business = session.businessId
                if (business == null || business != selectedBusiness || session.cookieHeader == null) { status.text = "Sign in and select a business first."; return@setOnClickListener }
                val batch = selected.toList()
                if (batch.isEmpty()) return@setOnClickListener
                cancelled = false; isEnabled = false
                executor.execute {
                    try {
                        val api = NativeSmsApiClient(this@GalleryCommerceActivity)
                        batch.forEachIndexed { index, uri ->
                            if (cancelled) return@forEachIndexed
                            require(session.businessId == business && session.cookieHeader != null) { "Business or session changed. Select photos again." }
                            val bytes = thumbnail(uri)
                            if (!cancelled) {
                                val fingerprint = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                                val dedupKey = "uploaded:$business:$fingerprint"
                                if (!queuePreferences.getBoolean(dedupKey, false)) {
                                    api.uploadGalleryPhoto(business, "gallery-${fingerprint.take(12)}.jpg", Base64.encodeToString(bytes, Base64.NO_WRAP))
                                    queuePreferences.edit().putBoolean(dedupKey, true).commit()
                                }
                                selected = selected.filterNot { it == uri }
                                saveQueue(business)
                                runCatching { contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
                                runOnUiThread { status.text = "${index + 1}/${batch.size} private review jobs uploaded. Open the business workspace to review and publish." }
                            }
                        }
                    } catch (error: Exception) { runOnUiThread { status.text = error.message ?: "Upload failed. Reselect the batch to retry; the server detects repeated photos." } }
                    finally { runOnUiThread { upload.isEnabled = true } }
                }
            }
        }
        content.addView(upload)
        content.addView(Button(this).apply { text = "Cancel remaining photos"; setOnClickListener { cancelled = true } })
        content.addView(Button(this).apply { text = "Discard saved selection"; setOnClickListener {
            cancelled = true
            selected.forEach { uri -> runCatching { contentResolver.releasePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
            selected = emptyList()
            selectedBusiness?.let { saveQueue(it) }
            status.text = "Saved gallery selection cleared. Uploaded review jobs remain private in the workspace."
        } })
        content.addView(Button(this).apply { text = "Open Grogoni workspace for review"; setOnClickListener { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://grogoni.com"))) } })
        setContentView(content)
    }
    private fun thumbnail(uri: Uri): ByteArray {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        contentResolver.openInputStream(uri).use { requireNotNull(it); BitmapFactory.decodeStream(it, null, bounds) }
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Unreadable photo." }
        val options = BitmapFactory.Options()
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2048) sample *= 2
        options.inSampleSize = sample
        val bitmap = contentResolver.openInputStream(uri).use { requireNotNull(it); requireNotNull(BitmapFactory.decodeStream(it, null, options)) }
        val ratio = minOf(1.0, 1024.0 / maxOf(bitmap.width, bitmap.height))
        val scaled = Bitmap.createScaledBitmap(bitmap, maxOf(1, (bitmap.width * ratio).toInt()), maxOf(1, (bitmap.height * ratio).toInt()), true)
        return try { ByteArrayOutputStream().use { output -> scaled.compress(Bitmap.CompressFormat.JPEG, 82, output); output.toByteArray() } }
        finally { if (scaled !== bitmap) scaled.recycle(); bitmap.recycle() }
    }
    override fun onDestroy() {
        cancelled = true
        executor.shutdown()
        // Persisted grants are retained only for pending user-selected photos, so interrupted batches can resume.
        super.onDestroy()
    }
}
