package market.grogoni.app.whatsapp.sidecar

import market.grogoni.app.sms.NativeApiClient
import market.grogoni.app.sms.NativeApiException
import org.json.JSONArray
import org.json.JSONObject

/*
 * Outbound relay for a WhatsApp session hosted on this phone (docs/architecture/
 * whatsapp-linked-devices.md, "Device outbox"). Production runs on Supabase Edge, which cannot
 * hold a socket, so replies typed in the Grogoni inbox, assistant replies and delegated results
 * wait in a durable outbox on the server. This phone pulls them with the owner's own session,
 * sends them through the sidecar and acknowledges each one.
 *
 * The pump and the poll policy use plain Kotlin types, so the JVM unit tests cover every rule.
 * The JSON adapters at the bottom are thin and run on the device.
 */

data class OutboxQuote(val id: String, val sender: String?, val fromMe: Boolean, val text: String)

data class OutboxSend(
    val id: String,
    val claimId: String,
    val chat: String,
    val conversationId: String,
    val idempotencyKey: String,
    val text: String,
    val quoted: OutboxQuote? = null,
)

data class OutboxReceiptKey(val id: String, val sender: String)

data class OutboxReceipts(val chat: String, val keys: List<OutboxReceiptKey>)

data class OutboxPull(val sends: List<OutboxSend>, val receipts: List<OutboxReceipts>, val more: Boolean)

/** One send's outcome, as the server's ack route takes it. */
data class DeliveryResult(
    val id: String,
    val claimId: String,
    val outcome: String,
    val deliveredId: String? = null,
    val code: String? = null,
    val retryable: Boolean? = null,
)

class OutboxApiException(val status: Int?, val code: String?, message: String) : Exception(message)

/** The owner-session device routes (device-worker-routes.ts). */
interface OutboxTransport {
    fun reportState(businessId: String, state: String)
    fun pull(businessId: String): OutboxPull
    fun ack(businessId: String, results: List<DeliveryResult>)
}

/** The sidecar's `deliver` and `markRead` methods. A thrown exception means "no answer". */
interface SidecarDelivery {
    fun deliver(businessId: String, send: OutboxSend): DeliveryResult
    fun markRead(businessId: String, receipts: OutboxReceipts): Int
}

/** What one drain of one business did. */
data class PumpReport(
    val delivered: Int = 0,
    val unanswered: Int = 0,
    val receiptsSent: Int = 0,
    val more: Boolean = false,
    val outcome: Outcome = Outcome.OK,
) {
    enum class Outcome {
        OK,
        /** The server does not see this phone as the host yet: report the state, then pull again. */
        NOT_HOSTING,
        /** The owner no longer owns the business: log out and erase locally. */
        DENY,
        /** Network, 5xx, 429 or an unexpected answer: back off. */
        ERROR,
    }
}

/**
 * Pulls, delivers and acknowledges. The rule that keeps an uncertain delivery from being resent:
 * a send the sidecar did not answer (timeout, crash, not running) is **not** acknowledged. Its
 * claim times out on the server and comes back to this phone only, under the same idempotency
 * key, where the sidecar's encrypted journal returns the stored result or `uncertain`.
 */
class OutboxPump(private val transport: OutboxTransport, private val sidecar: SidecarDelivery) {
    fun drain(businessId: String, maxRounds: Int = 5): PumpReport {
        var report = PumpReport()
        repeat(maxRounds) {
            val pulled = try {
                transport.pull(businessId)
            } catch (error: OutboxApiException) {
                return report.copy(outcome = classify(error))
            } catch (_: Exception) {
                return report.copy(outcome = PumpReport.Outcome.ERROR)
            }
            val results = mutableListOf<DeliveryResult>()
            var unanswered = 0
            for (send in pulled.sends) {
                val result = runCatching { sidecar.deliver(businessId, send) }.getOrNull()
                if (result == null) unanswered++ else results += result
            }
            var receipts = 0
            for (batch in pulled.receipts) receipts += runCatching { sidecar.markRead(businessId, batch) }.getOrDefault(0)
            if (results.isNotEmpty()) {
                try {
                    transport.ack(businessId, results)
                } catch (error: OutboxApiException) {
                    // The claims stay; a re-offer to this phone is answered from the journal.
                    return report.plus(results.size, unanswered, receipts, pulled.more).copy(outcome = classify(error))
                } catch (_: Exception) {
                    return report.plus(results.size, unanswered, receipts, pulled.more).copy(outcome = PumpReport.Outcome.ERROR)
                }
            }
            report = report.plus(results.size, unanswered, receipts, pulled.more)
            if (!pulled.more) return report
        }
        return report
    }

    private fun PumpReport.plus(delivered: Int, unanswered: Int, receipts: Int, more: Boolean) =
        copy(delivered = this.delivered + delivered, unanswered = this.unanswered + unanswered, receiptsSent = receiptsSent + receipts, more = more)

    companion object {
        fun classify(error: OutboxApiException): PumpReport.Outcome = when {
            error.status == 409 && error.code == "whatsapp_device_not_hosting" -> PumpReport.Outcome.NOT_HOSTING
            error.status == 403 && error.code == "permission_denied" -> PumpReport.Outcome.DENY
            error.status == 410 -> PumpReport.Outcome.DENY
            else -> PumpReport.Outcome.ERROR
        }
    }
}

/**
 * Battery rule for the pull loop. There is no push channel to the phone (no FCM in this app), and
 * Edge cannot hold a long poll, so the phone asks. Only while the sidecar runs, only for
 * businesses whose session is CONNECTED, and quickly only right after activity (a customer just
 * wrote, or something was just sent), when an owner reply is most likely.
 */
object OutboxPollPolicy {
    /** Right after activity: a reply typed in the inbox reaches WhatsApp within about this long. */
    const val ACTIVE_MS = 5_000L
    const val ACTIVE_WINDOW_MS = 2 * 60_000L
    /** Otherwise. Keeps the server's 10-minute "phone offline" threshold far away. */
    const val IDLE_MS = 30_000L
    const val MAX_BACKOFF_MS = 5 * 60_000L

    /** Milliseconds until the next pull, or null when nothing is connected (no polling at all). */
    fun delayMs(connected: Int, nowMs: Long, lastActivityMs: Long?, errors: Int, more: Boolean): Long? = when {
        connected <= 0 -> null
        more && errors == 0 -> 0L
        errors > 0 -> (IDLE_MS shl (errors - 1).coerceAtMost(8)).coerceAtMost(MAX_BACKOFF_MS)
        lastActivityMs != null && nowMs - lastActivityMs < ACTIVE_WINDOW_MS -> ACTIVE_MS
        else -> IDLE_MS
    }
}

/** HTTP adapter over the owner's native session. */
class ApiOutboxTransport(private val api: NativeApiClient) : OutboxTransport {
    private fun path(businessId: String, suffix: String) =
        "/businesses/${ApiIngressRelay.encode(businessId)}/channels/whatsapp-linked/device/$suffix"

    private fun <T> call(block: () -> T): T = try {
        block()
    } catch (error: NativeApiException) {
        throw OutboxApiException(error.status, error.code, error.message ?: "Request failed.")
    } catch (error: OutboxApiException) {
        throw error
    } catch (error: Exception) {
        throw OutboxApiException(null, null, error.message ?: "Network error.")
    }

    override fun reportState(businessId: String, state: String) {
        call { api.request("POST", path(businessId, "state"), JSONObject().put("state", state)) }
    }

    override fun pull(businessId: String): OutboxPull = call {
        OutboxJson.pull(api.request("POST", path(businessId, "outbox/pull"), JSONObject()).body)
    }

    override fun ack(businessId: String, results: List<DeliveryResult>) {
        call { api.request("POST", path(businessId, "outbox/ack"), JSONObject().put("results", OutboxJson.results(results))) }
    }
}

/** The sidecar side, over the controller's loopback client. */
class ClientSidecarDelivery(private val call: (String, JSONObject, Long) -> JSONObject?) : SidecarDelivery {
    override fun deliver(businessId: String, send: OutboxSend): DeliveryResult {
        val params = JSONObject()
            .put("businessId", businessId)
            .put("chat", send.chat)
            .put("conversationId", send.conversationId)
            .put("idempotencyKey", send.idempotencyKey)
            .put("text", send.text)
        send.quoted?.let {
            params.put("quotedMessage", JSONObject().put("id", it.id).put("sender", it.sender ?: JSONObject.NULL).put("fromMe", it.fromMe).put("text", it.text))
        }
        val result = call("deliver", params, 45_000) ?: throw IllegalStateException("No answer.")
        return DeliveryResult(
            id = send.id,
            claimId = send.claimId,
            outcome = result.getString("outcome"),
            deliveredId = result.optString("deliveredId").takeIf(String::isNotBlank),
            code = result.optString("code").takeIf(String::isNotBlank),
            retryable = if (result.has("retryable")) result.getBoolean("retryable") else null,
        )
    }

    override fun markRead(businessId: String, receipts: OutboxReceipts): Int {
        val keys = JSONArray()
        receipts.keys.forEach { keys.put(JSONObject().put("id", it.id).put("sender", it.sender)) }
        val result = call("markRead", JSONObject().put("businessId", businessId).put("chat", receipts.chat).put("keys", keys), 30_000)
        return result?.optInt("sent") ?: 0
    }
}

/** JSON mapping for the device routes. Unknown or malformed items are skipped, never guessed. */
object OutboxJson {
    fun pull(body: JSONObject): OutboxPull {
        val sends = mutableListOf<OutboxSend>()
        body.optJSONArray("sends")?.let { array ->
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                val quote = item.optJSONObject("quotedMessage")?.let {
                    OutboxQuote(it.getString("id"), if (it.isNull("sender")) null else it.optString("sender"), it.optBoolean("fromMe"), it.optString("text"))
                }
                sends += runCatching {
                    OutboxSend(item.getString("id"), item.getString("claimId"), item.getString("chat"), item.getString("conversationId"), item.getString("idempotencyKey"), item.getString("text"), quote)
                }.getOrNull() ?: continue
            }
        }
        val receipts = mutableListOf<OutboxReceipts>()
        body.optJSONArray("receipts")?.let { array ->
            for (index in 0 until array.length()) {
                val item = array.optJSONObject(index) ?: continue
                val keys = item.optJSONArray("keys") ?: continue
                val parsed = (0 until keys.length()).mapNotNull { keys.optJSONObject(it) }
                    .map { OutboxReceiptKey(it.optString("id"), it.optString("sender")) }
                    .filter { it.id.isNotBlank() && it.sender.isNotBlank() }
                if (parsed.isNotEmpty()) receipts += OutboxReceipts(item.optString("chat"), parsed)
            }
        }
        return OutboxPull(sends, receipts, body.optBoolean("more"))
    }

    fun results(results: List<DeliveryResult>): JSONArray {
        val array = JSONArray()
        results.forEach { result ->
            val item = JSONObject().put("id", result.id).put("claimId", result.claimId).put("outcome", result.outcome)
            result.deliveredId?.let { item.put("deliveredId", it) }
            result.code?.let { item.put("code", it) }
            result.retryable?.let { item.put("retryable", it) }
            array.put(item)
        }
        return array
    }
}
