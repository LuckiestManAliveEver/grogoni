package market.grogoni.app.whatsapp.sidecar

import android.content.Context
import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileLock
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import market.grogoni.app.sms.NativeApiClient
import market.grogoni.app.sms.NativeApiException
import market.grogoni.app.sms.GrogoniSessionStore
import org.json.JSONObject

/** Sends one ingress event to the Grogoni API as the signed-in owner. */
fun interface IngressRelay {
    fun forward(businessId: String, message: JSONObject): IngressOutcome
}

/**
 * Posts to the owner-session device ingress route with the existing native session
 * (NativeApiClient: encrypted cookie storage, device headers, single-owner refresh). The sidecar
 * never sees that cookie.
 */
class ApiIngressRelay(private val api: NativeApiClient) : IngressRelay {
    override fun forward(businessId: String, message: JSONObject): IngressOutcome = try {
        api.request("POST", "/businesses/${encode(businessId)}/channels/whatsapp-linked/device/ingress", JSONObject().put("message", message))
        IngressOutcome.ACK
    } catch (error: NativeApiException) {
        IngressOutcome.classify(error.status, error.code)
    } catch (_: Exception) {
        IngressOutcome.classify(null, null)
    }

    companion object {
        fun encode(value: String): String = java.net.URLEncoder.encode(value, "UTF-8")
    }
}

/**
 * Owns one sidecar for the signed-in owner: Keystore-wrapped vault key, the process, the
 * loopback client, crash restarts and the battery idle rule. Thread-safe; blocking calls run on
 * its own executors, never on the main thread.
 */
class WhatsAppSidecarController(
    context: Context,
    private val relay: IngressRelay,
    private val wrapper: KeyWrapper = AndroidKeystoreWrapper(),
    private val restartPolicy: SidecarRestartPolicy = SidecarRestartPolicy(),
    private val idleLimitMs: Long = 10 * 60_000L,
    private val clock: () -> Long = System::currentTimeMillis,
    /** Outbound relay (DeviceOutbox.kt). Null runs the sidecar without pulling the outbox. */
    private val outbox: OutboxTransport? = null,
) {
    interface Listener {
        fun running(node: String) {}
        fun stopped(reason: String) {}
        fun gaveUp(crashes: Int) {}
        fun vaultReset() {}
    }

    private val app = context.applicationContext
    private val runtime = SidecarRuntime(app)
    private val lifecycle = Executors.newSingleThreadScheduledExecutor { Thread(it, "whatsapp-sidecar-lifecycle").apply { isDaemon = true } }
    private val ingressExecutor = Executors.newSingleThreadExecutor { Thread(it, "whatsapp-sidecar-ingress").apply { isDaemon = true } }
    private val states = ConcurrentHashMap<String, String>()
    private val outboxExecutor = Executors.newSingleThreadScheduledExecutor { Thread(it, "whatsapp-sidecar-outbox").apply { isDaemon = true } }
    /** The state the Grogoni API last accepted per business, so each change is reported once. */
    private val reported = ConcurrentHashMap<String, String>()
    private val pump = outbox?.let { OutboxPump(it, ClientSidecarDelivery { method, params, timeout -> call(method, params, timeout) }) }
    private val outboxLock = Any()
    private var outboxTask: ScheduledFuture<*>? = null
    private var outboxDueAt = Long.MAX_VALUE
    private var outboxErrors = 0
    @Volatile private var lastActivity: Long? = null
    @Volatile private var idleSince: Long? = null
    @Volatile private var process: SidecarProcess? = null
    @Volatile private var client: SidecarClient? = null
    @Volatile private var owner: String? = null
    @Volatile private var wanted = false
    private var lock: FileLock? = null
    private var lockFile: RandomAccessFile? = null
    private var restartTask: ScheduledFuture<*>? = null
    private var idleTask: ScheduledFuture<*>? = null
    var listener: Listener = object : Listener {}
    /** Checked every minute: false (signed out, account switched, turned off) stops the sidecar. */
    var guard: () -> Boolean = { true }

    val runtimePresent: Boolean get() = runtime.present
    val running: Boolean get() = process?.alive == true && client?.isOpen == true
    val node: String get() = client?.node.orEmpty()
    fun states(): Map<String, String> = HashMap(states)

    fun ownerDirectory(ownerId: String) = File(app.noBackupFilesDir, "whatsapp-linked/${SidecarPolicy.vaultDirectoryName(ownerId)}")

    /** Starts (or keeps) the sidecar for [ownerId]. Blocks until it is ready or fails. */
    @Synchronized
    fun start(ownerId: String) {
        wanted = true
        if (owner == ownerId && running) return
        if (owner != null && owner != ownerId) stopLocked("owner_changed")
        owner = ownerId
        restartTask?.cancel(false)
        try {
            launchLocked(ownerId)
        } catch (error: Throwable) {
            wanted = false
            owner = null
            releaseLock()
            throw error
        }
        scheduleIdleCheck()
    }

    private fun launchLocked(ownerId: String) {
        val directory = ownerDirectory(ownerId).apply { mkdirs() }
        acquireLock(directory)
        val keys = SidecarVaultKeyStore(File(directory, "vault-key.wrapped"), wrapper)
        val key = try {
            keys.loadOrCreate()
        } catch (_: VaultKeyUnavailable) {
            // The Keystore key is gone (device credential reset, restore to another phone): the
            // encrypted session cannot be opened by anyone. Start a fresh vault; the owner links again.
            File(directory, "vault").deleteRecursively()
            keys.delete()
            listener.vaultReset()
            keys.loadOrCreate()
        }
        try {
            val started = SidecarProcess.start(runtime, runtime.script(), File(directory, "vault"), File(app.cacheDir, "whatsapp-sidecar"), ownerId, key)
            process = started
            client = SidecarClient.connect(started.port, started.token, events(started))
            watch(started, ownerId)
            listener.running(client?.node.orEmpty())
        } finally {
            key.fill(0)
        }
    }

    private fun acquireLock(directory: File) {
        if (lock?.isValid == true) return
        // Same-volume guard, like worker.lock on the server: one sidecar per vault, across every
        // process of this app. The kernel releases it if this process dies.
        val file = RandomAccessFile(File(directory, "worker.lock"), "rw")
        val acquired = file.channel.tryLock()
        if (acquired == null) {
            file.close()
            throw IllegalStateException("Another WhatsApp worker owns this vault.")
        }
        lockFile = file
        lock = acquired
    }

    private fun releaseLock() {
        runCatching { lock?.release() }
        runCatching { lockFile?.close() }
        lock = null
        lockFile = null
    }

    private fun events(started: SidecarProcess) = object : SidecarEvents {
        override fun ingress(seq: Long, businessId: String, message: JSONObject) {
            ingressExecutor.execute { handleIngress(started, seq, businessId, message) }
        }

        override fun state(businessId: String, state: String) {
            states[businessId] = state
            idleSince = if (states.values.all { it in setOf("DISCONNECTED", "REVOKED", "AUTH_REQUIRED") }) idleSince ?: clock() else null
            // Report the change at once; CONNECTED also starts the pull loop.
            scheduleOutbox(0)
        }

        override fun closed() {}
    }

    private fun handleIngress(started: SidecarProcess, seq: Long, businessId: String, message: JSONObject) {
        val current = client ?: return
        if (process !== started) return
        when (relay.forward(businessId, message)) {
            IngressOutcome.ACK -> {
                current.ack(seq, true)
                // A customer just wrote: the owner's reply is likely soon, so pull quickly for a while.
                lastActivity = clock()
                scheduleOutbox(OutboxPollPolicy.ACTIVE_MS)
            }
            IngressOutcome.RETRY -> current.ack(seq, false)
            IngressOutcome.DENY -> {
                current.ack(seq, false)
                runCatching { current.call("deny", JSONObject().put("businessId", businessId)) }
            }
            IngressOutcome.REVOKE_CHAT -> {
                runCatching { current.call("revoke", JSONObject().put("businessId", businessId).put("chat", message.optString("chat"))) }
                current.ack(seq, true)
            }
        }
    }

    private fun watch(started: SidecarProcess, ownerId: String) {
        Thread({
            val code = runCatching { started.waitFor() }.getOrNull()
            onExit(started, ownerId, code)
        }, "whatsapp-sidecar-exit").apply { isDaemon = true }.start()
    }

    @Synchronized
    private fun onExit(started: SidecarProcess, ownerId: String, code: Int?) {
        if (process !== started) return
        client?.close()
        client = null
        process = null
        states.clear()
        reported.clear()
        val decision = restartPolicy.onExit(code, started.requestedStop || !wanted, started.startedAtMs, clock())
        when (decision) {
            is SidecarRestartPolicy.Decision.RestartAfter -> {
                restartTask = lifecycle.schedule({
                    synchronized(this) {
                        if (wanted && owner == ownerId && process == null) runCatching { launchLocked(ownerId) }
                            .onFailure { onLaunchFailure(ownerId) }
                    }
                }, decision.delayMs, TimeUnit.MILLISECONDS)
            }
            is SidecarRestartPolicy.Decision.GiveUp -> {
                wanted = false
                releaseLock()
                listener.gaveUp(decision.crashes)
            }
            SidecarRestartPolicy.Decision.Stay -> releaseLock()
        }
    }

    /** A restart that failed before ready counts as another crash. */
    private fun onLaunchFailure(ownerId: String) {
        val decision = restartPolicy.onExit(null, false, clock(), clock())
        if (decision is SidecarRestartPolicy.Decision.RestartAfter)
            restartTask = lifecycle.schedule({ synchronized(this) { if (wanted && owner == ownerId && process == null) runCatching { launchLocked(ownerId) }.onFailure { onLaunchFailure(ownerId) } } }, decision.delayMs, TimeUnit.MILLISECONDS)
        else if (decision is SidecarRestartPolicy.Decision.GiveUp) {
            wanted = false
            releaseLock()
            listener.gaveUp(decision.crashes)
        }
    }

    private fun scheduleIdleCheck() {
        if (idleTask != null) return
        idleTask = lifecycle.scheduleWithFixedDelay({
            if (wanted && !runCatching(guard).getOrDefault(true)) stop("signed_out")
            else if (wanted && running && SidecarPolicy.shouldStopForIdle(states.values, idleSince ?: startedIdle(), clock(), idleLimitMs)) {
                stop("idle")
            }
        }, 60, 60, TimeUnit.SECONDS)
    }

    /** With no state events yet, idleness counts from the process start. */
    private fun startedIdle(): Long? = if (states.isEmpty()) process?.startedAtMs else null

    fun call(method: String, params: JSONObject = JSONObject(), timeoutMs: Long = 30_000): JSONObject? {
        val current = client ?: throw SidecarCallException("not_running", "WhatsApp on this phone is not running.", true)
        return current.call(method, params, timeoutMs)
    }

    @Synchronized
    fun stop(reason: String = "requested") {
        wanted = false
        stopLocked(reason)
    }

    private fun stopLocked(reason: String) {
        synchronized(outboxLock) {
            outboxTask?.cancel(false)
            outboxTask = null
            outboxDueAt = Long.MAX_VALUE
        }
        reported.clear()
        restartTask?.cancel(false)
        idleTask?.cancel(false)
        idleTask = null
        val running = process
        client?.close()
        client = null
        running?.stop()
        process = null
        states.clear()
        idleSince = null
        owner = null
        releaseLock()
        restartPolicy.reset()
        listener.stopped(reason)
    }

    /** Something just happened in the app (a chat approved, the panel opened): pull now. */
    fun nudge() {
        lastActivity = clock()
        scheduleOutbox(0)
    }

    /** Runs the next outbox pass after [delayMs], unless one is already due sooner. */
    private fun scheduleOutbox(delayMs: Long) {
        if (outbox == null) return
        synchronized(outboxLock) {
            val due = clock() + delayMs
            if (outboxTask?.isDone == false && outboxDueAt <= due) return
            outboxTask?.cancel(false)
            outboxDueAt = due
            outboxTask = outboxExecutor.schedule({ outboxPass() }, delayMs, TimeUnit.MILLISECONDS)
        }
    }

    /**
     * One pass: report every state the API has not seen yet, then drain each CONNECTED business.
     * Reschedules itself by OutboxPollPolicy; stops when nothing is connected.
     */
    private fun outboxPass() {
        synchronized(outboxLock) { outboxDueAt = Long.MAX_VALUE }
        val transport = outbox ?: return
        val pump = pump ?: return
        if (!running) return
        var failed = false
        var more = false
        for ((businessId, state) in HashMap(states)) {
            if (reported[businessId] == state) continue
            try {
                transport.reportState(businessId, state)
                reported[businessId] = state
            } catch (error: OutboxApiException) {
                if (OutboxPump.classify(error) == PumpReport.Outcome.DENY) deny(businessId) else failed = true
            }
        }
        for ((businessId, state) in HashMap(states)) {
            if (state != "CONNECTED" || reported[businessId] != state) continue
            val report = pump.drain(businessId)
            when (report.outcome) {
                PumpReport.Outcome.OK -> Unit
                // The API lost our state (another host, a server session took over): report again.
                PumpReport.Outcome.NOT_HOSTING -> reported.remove(businessId).also { more = true }
                PumpReport.Outcome.DENY -> deny(businessId)
                PumpReport.Outcome.ERROR -> failed = true
            }
            if (report.delivered > 0 || report.receiptsSent > 0) lastActivity = clock()
            more = more || report.more
        }
        outboxErrors = if (failed) outboxErrors + 1 else 0
        val connected = states.values.count { it == "CONNECTED" }
        OutboxPollPolicy.delayMs(connected, clock(), lastActivity, outboxErrors, more)?.let { scheduleOutbox(it) }
    }

    private fun deny(businessId: String) {
        runCatching { call("deny", JSONObject().put("businessId", businessId)) }
        states.remove(businessId)
        reported.remove(businessId)
    }

    /** For crash-recovery tests: kills the process without asking it to stop. */
    fun killForTest() {
        process?.kill()
    }

    companion object {
        fun apiRelay(context: Context) = ApiIngressRelay(NativeApiClient(GrogoniSessionStore(context.applicationContext)))
        fun apiOutbox(context: Context) = ApiOutboxTransport(NativeApiClient(GrogoniSessionStore(context.applicationContext)))
    }
}
