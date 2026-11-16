package market.grogoni.app.whatsapp.sidecar

import android.content.Context
import android.os.Build
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean
import org.json.JSONObject

/**
 * Locates the packaged runtime and script. The Node executable ships as
 * `lib/<abi>/libgrogoni_node.so` so Android installs it into the read-only, executable
 * nativeLibraryDir (apps may not execute files they write themselves). The bundled script is
 * copied from assets to no-backup storage, verified against its manifest digest.
 */
class SidecarRuntime(private val context: Context) {
    val nativeLibraryDir: File get() = File(context.applicationInfo.nativeLibraryDir)
    val node: File get() = File(nativeLibraryDir, NODE)
    val present: Boolean get() = node.isFile && assetExists(SCRIPT_ASSET)

    private fun assetExists(path: String) = runCatching { context.assets.open(path).close() }.isSuccess

    /** Copies the script out of the APK once per bundle digest and returns its path. */
    fun script(): File {
        val manifest = context.assets.open(MANIFEST_ASSET).use { JSONObject(it.readBytes().decodeToString()) }
        val expected = manifest.getString("sha256")
        require(expected.matches(Regex("[0-9a-f]{64}"))) { "Invalid sidecar manifest." }
        val directory = File(context.noBackupFilesDir, "whatsapp-sidecar/script")
        val target = File(directory, "$expected.mjs")
        if (target.isFile && sha256(target.inputStream()) == expected) return target
        directory.mkdirs()
        directory.listFiles()?.forEach { it.delete() }
        val temporary = File(directory, "$expected.tmp")
        context.assets.open(SCRIPT_ASSET).use { input -> temporary.outputStream().use { input.copyTo(it) } }
        check(sha256(temporary.inputStream()) == expected) { "The packaged WhatsApp worker failed verification." }
        check(temporary.renameTo(target))
        target.setReadOnly()
        return target
    }

    companion object {
        const val NODE = "libgrogoni_node.so"
        const val SCRIPT_ASSET = "whatsapp-sidecar/sidecar.mjs"
        const val MANIFEST_ASSET = "whatsapp-sidecar/manifest.json"

        fun sha256(input: InputStream): String = input.use {
            val digest = MessageDigest.getInstance("SHA-256")
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = it.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
            SidecarPolicy.hex(digest.digest())
        }
    }
}

/**
 * One running sidecar process. The app keeps the process's stdin open for its lifetime; when
 * the app dies the pipe closes and the sidecar exits on its own.
 */
class SidecarProcess private constructor(
    private val process: Process,
    private val stdin: OutputStream,
    val port: Int,
    val token: String,
    val startedAtMs: Long,
    private val stderrTail: StringBuffer,
) {
    private val stopping = AtomicBoolean(false)
    val requestedStop: Boolean get() = stopping.get()
    val alive: Boolean get() = process.alive()

    /** Diagnostic codes the sidecar wrote to stderr (never message content). */
    fun diagnostics(): String = stderrTail.toString()

    fun waitFor(): Int = process.waitFor()

    /** Asks for a graceful stop (stdin EOF), then kills after [graceMs]. */
    fun stop(graceMs: Long = 5_000) {
        stopping.set(true)
        runCatching { stdin.close() }
        if (!process.waitFor(graceMs)) process.kill()
    }

    /** Hard kill without telling the sidecar first: used to test crash recovery. */
    fun kill() {
        process.kill()
    }

    companion object {
        private val random = SecureRandom()

        fun newSecretHex(): String = SidecarPolicy.hex(ByteArray(32).also(random::nextBytes))

        /**
         * Spawns the sidecar and waits for its ready line.
         * @param key the vault data key; zeroed by the caller after this returns.
         */
        fun start(
            runtime: SidecarRuntime,
            script: File,
            vaultDir: File,
            tempDir: File,
            ownerId: String,
            key: ByteArray,
            readyTimeoutMs: Long = 60_000,
            maxHeapMb: Int = 160,
        ): SidecarProcess {
            require(key.size == SidecarVaultKeyStore.KEY_BYTES)
            vaultDir.parentFile?.mkdirs()
            tempDir.mkdirs()
            val token = newSecretHex()
            val builder = ProcessBuilder(
                runtime.node.absolutePath,
                "--use-bundled-ca",
                "--max-old-space-size=$maxHeapMb",
                script.absolutePath,
            ).directory(tempDir).redirectErrorStream(false)
            builder.environment().apply {
                clear()
                put("LD_LIBRARY_PATH", runtime.nativeLibraryDir.absolutePath)
                put("TMPDIR", tempDir.absolutePath)
                put("HOME", tempDir.absolutePath)
                put("NODE_ENV", "production")
                put("ANDROID_ROOT", System.getenv("ANDROID_ROOT") ?: "/system")
                put("ANDROID_DATA", System.getenv("ANDROID_DATA") ?: "/data")
            }
            val process = builder.start()
            val stderrTail = StringBuffer()
            Thread({ drainBounded(process.errorStream, stderrTail) }, "whatsapp-sidecar-stderr").apply { isDaemon = true }.start()
            val startedAt = System.currentTimeMillis()
            try {
                val keyHex = SidecarPolicy.hex(key)
                process.outputStream.write(SidecarPolicy.configLine(token, keyHex, vaultDir.absolutePath, ownerId).toByteArray())
                process.outputStream.flush()
                val port = readReady(process, readyTimeoutMs)
                    ?: throw IllegalStateException("The WhatsApp worker did not start: ${stderrTail.toString().take(200)}")
                return SidecarProcess(process, process.outputStream, port, token, startedAt, stderrTail)
            } catch (error: Throwable) {
                process.kill()
                throw error
            }
        }

        private fun readReady(process: Process, timeoutMs: Long): Int? {
            var port: Int? = null
            val reader = Thread({
                val line = StringBuilder()
                val input = process.inputStream
                while (line.length < 4096) {
                    val byte = input.read()
                    if (byte < 0 || byte == '\n'.code) break
                    line.append(byte.toChar())
                }
                port = SidecarPolicy.readyPort(line.toString())
                // Nothing else is expected on stdout; keep draining so the pipe never fills.
                runCatching {
                    val sink = ByteArray(4096)
                    while (input.read(sink) >= 0) Unit
                }
            }, "whatsapp-sidecar-stdout").apply { isDaemon = true }
            reader.start()
            val deadline = System.currentTimeMillis() + timeoutMs
            while (port == null && process.alive() && System.currentTimeMillis() < deadline) Thread.sleep(25)
            return port
        }

        private fun drainBounded(input: InputStream, tail: StringBuffer) = runCatching {
            input.bufferedReader().forEachLine { line ->
                // Only `sidecar_<code>` diagnostics are kept; anything else is discarded unread.
                if (line.startsWith("sidecar_")) {
                    tail.append(line.take(200)).append('\n')
                    if (tail.length > 4096) tail.delete(0, tail.length - 4096)
                }
            }
        }

        val deviceAbis: List<String> get() = Build.SUPPORTED_ABIS.toList()
    }
}

/** java.lang.Process helpers that also work below API 26 (the app's minSdk is 23). */
internal fun Process.alive(): Boolean = try {
    exitValue()
    false
} catch (_: IllegalThreadStateException) {
    true
}

internal fun Process.waitFor(timeoutMs: Long): Boolean {
    val deadline = System.currentTimeMillis() + timeoutMs
    while (alive()) {
        if (System.currentTimeMillis() >= deadline) return false
        Thread.sleep(20)
    }
    return true
}

/** SIGKILL where the platform offers it; SIGTERM (which the sidecar honours) before API 26. */
internal fun Process.kill() {
    if (Build.VERSION.SDK_INT >= 26) destroyForcibly() else destroy()
}
