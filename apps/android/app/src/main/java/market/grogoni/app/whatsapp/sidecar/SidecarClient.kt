package market.grogoni.app.whatsapp.sidecar

import java.io.BufferedReader
import java.io.Closeable
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

class SidecarCallException(val code: String, message: String, val retryable: Boolean) : Exception(message)

interface SidecarEvents {
    /** The app must answer with [SidecarClient.ack] once the Grogoni API stored (or refused) it. */
    fun ingress(seq: Long, businessId: String, message: JSONObject)
    fun state(businessId: String, state: String)
    fun closed()
}

/**
 * The app's side of the loopback protocol (see sidecar/protocol.ts). Connects only to
 * 127.0.0.1, presents the per-start token first, and refuses to continue unless the sidecar
 * answers `welcome`. One client per sidecar process.
 */
class SidecarClient private constructor(
    private val socket: Socket,
    private val events: SidecarEvents,
) : Closeable {
    private val writer = OutputStreamWriter(socket.getOutputStream(), Charsets.UTF_8)
    private val ids = AtomicLong()
    private val pending = ConcurrentHashMap<Long, Pending>()
    @Volatile var node: String = ""
        private set

    private class Pending {
        val latch = CountDownLatch(1)
        @Volatile var frame: JSONObject? = null
    }

    private fun write(frame: String) = synchronized(writer) {
        writer.write(frame)
        writer.flush()
    }

    fun call(method: String, params: JSONObject = JSONObject(), timeoutMs: Long = 30_000): JSONObject? {
        val id = ids.incrementAndGet()
        val waiter = Pending()
        pending[id] = waiter
        try {
            write(JSONObject().put("type", "request").put("id", id).put("method", method).put("params", params).toString() + "\n")
            if (!waiter.latch.await(timeoutMs, TimeUnit.MILLISECONDS))
                throw SidecarCallException("timeout", "The WhatsApp worker did not answer.", true)
            val frame = waiter.frame ?: throw SidecarCallException("closed", "The WhatsApp worker stopped.", true)
            if (frame.optBoolean("ok")) return frame.optJSONObject("result")
            val error = frame.optJSONObject("error") ?: JSONObject()
            throw SidecarCallException(error.optString("code", "request_failed"), error.optString("message", "Request failed."), error.optBoolean("retryable"))
        } finally {
            pending.remove(id)
        }
    }

    fun ack(seq: Long, ok: Boolean) {
        runCatching { write(JSONObject().put("type", "ack").put("seq", seq).put("ok", ok).toString() + "\n") }
    }

    val isOpen: Boolean get() = !socket.isClosed

    override fun close() {
        runCatching { socket.close() }
    }

    private fun readLoop(reader: BufferedReader) {
        try {
            while (true) {
                val line = reader.readLine() ?: break
                if (line.length > MAX_FRAME) break
                val frame = runCatching { JSONObject(line) }.getOrNull() ?: break
                when (frame.optString("type")) {
                    "response" -> pending[frame.optLong("id")]?.let { it.frame = frame; it.latch.countDown() }
                    "state" -> events.state(frame.optString("businessId"), frame.optString("state"))
                    "ingress" -> {
                        val message = frame.optJSONObject("message")
                        if (message == null) ack(frame.optLong("seq"), false)
                        else events.ingress(frame.optLong("seq"), frame.optString("businessId"), message)
                    }
                }
            }
        } catch (_: Exception) {
        } finally {
            close()
            pending.values.forEach { it.latch.countDown() }
            events.closed()
        }
    }

    companion object {
        private const val MAX_FRAME = 256 * 1024

        fun connect(port: Int, token: String, events: SidecarEvents, timeoutMs: Int = 5_000): SidecarClient {
            val socket = Socket()
            try {
                socket.tcpNoDelay = true
                socket.connect(InetSocketAddress(InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)), port), timeoutMs)
                socket.soTimeout = timeoutMs
                val reader = BufferedReader(InputStreamReader(socket.getInputStream(), Charsets.UTF_8))
                socket.getOutputStream().apply {
                    write(SidecarPolicy.helloLine(token).toByteArray(Charsets.UTF_8))
                    flush()
                }
                val welcome = reader.readLine()?.let { runCatching { JSONObject(it) }.getOrNull() }
                if (welcome?.optString("type") != "welcome" || welcome.optInt("protocol") != 1)
                    throw SidecarCallException("handshake_failed", "The WhatsApp worker refused the connection.", false)
                socket.soTimeout = 0
                val client = SidecarClient(socket, events)
                client.node = welcome.optString("node")
                Thread({ client.readLoop(reader) }, "whatsapp-sidecar-client").apply { isDaemon = true }.start()
                return client
            } catch (error: Throwable) {
                runCatching { socket.close() }
                throw error
            }
        }
    }
}
