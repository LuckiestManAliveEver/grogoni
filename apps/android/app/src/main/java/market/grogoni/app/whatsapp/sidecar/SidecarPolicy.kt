package market.grogoni.app.whatsapp.sidecar

import java.security.MessageDigest

/**
 * Pure decisions for the on-device WhatsApp sidecar. No Android types, so every rule here is
 * covered by JVM unit tests (SidecarPolicyTest).
 */
object SidecarPolicy {
    /** Termux's Node build targets API 24; the app itself still supports API 23. */
    const val MIN_SDK = 24
    val SUPPORTED_ABIS = listOf("arm64-v8a", "x86_64")

    sealed interface RunDecision {
        data object Run : RunDecision
        data class Refuse(val reason: String, val code: String) : RunDecision
    }

    /**
     * Runs only when the owner opted in on this phone, is still the signed-in account, and the
     * runtime exists for this device. Everything else stops the sidecar.
     */
    fun shouldRun(
        sdk: Int,
        abis: List<String>,
        runtimePresent: Boolean,
        signedInAccount: String?,
        hasSession: Boolean,
        enabledForAccount: String?,
    ): RunDecision = when {
        sdk < MIN_SDK -> RunDecision.Refuse("WhatsApp on this phone needs Android 7.0 or newer.", "sdk_unsupported")
        abis.none { it in SUPPORTED_ABIS } -> RunDecision.Refuse("This phone's processor is not supported.", "abi_unsupported")
        !runtimePresent -> RunDecision.Refuse("This app build does not include the WhatsApp worker.", "runtime_missing")
        signedInAccount == null || !hasSession -> RunDecision.Refuse("Sign in to Grogoni first.", "signed_out")
        enabledForAccount != signedInAccount -> RunDecision.Refuse("WhatsApp on this phone is off for this account.", "not_enabled")
        else -> RunDecision.Run
    }

    /** One vault directory per owner, named by a digest so the account id is not on disk. */
    fun vaultDirectoryName(accountId: String): String {
        require(accountId.isNotBlank())
        val digest = MessageDigest.getInstance("SHA-256").digest(accountId.toByteArray(Charsets.UTF_8))
        return "owner-" + digest.joinToString("") { "%02x".format(it) }.take(32)
    }

    /** The one stdin line the sidecar reads at start. Values are hex/ids/paths; escaped anyway. */
    fun configLine(token: String, keyHex: String, vaultDir: String, ownerId: String): String {
        require(token.matches(HEX64) && keyHex.matches(HEX64) && token != keyHex)
        require(vaultDir.startsWith("/"))
        require(ownerId.matches(Regex("[A-Za-z0-9_:.-]{1,128}")))
        return "{\"protocol\":1,\"token\":\"$token\",\"key\":\"$keyHex\",\"vaultDir\":${quote(vaultDir)},\"ownerId\":${quote(ownerId)}}\n"
    }

    /** The hello frame. Never logged. */
    fun helloLine(token: String): String {
        require(token.matches(HEX64))
        return "{\"type\":\"hello\",\"token\":\"$token\",\"protocol\":1}\n"
    }

    /** Parses `{"type":"ready","port":N,...}` without a JSON library; null if it is anything else. */
    fun readyPort(line: String): Int? {
        if (!Regex("\"type\"\\s*:\\s*\"ready\"").containsMatchIn(line)) return null
        val port = Regex("\"port\"\\s*:\\s*([0-9]{1,5})").find(line)?.groupValues?.get(1)?.toIntOrNull()
        return port?.takeIf { it in 1024..65535 }
    }

    fun quote(value: String): String = buildString {
        append('"')
        value.forEach { char ->
            when {
                char == '"' -> append("\\\"")
                char == '\\' -> append("\\\\")
                char < ' ' -> append("\\u%04x".format(char.code))
                else -> append(char)
            }
        }
        append('"')
    }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

    /** States in which the sidecar has nothing to keep alive. */
    private val IDLE_STATES = setOf("DISCONNECTED", "REVOKED", "AUTH_REQUIRED")

    /**
     * Battery rule: the process exists to hold linked sessions. When every known business has
     * been idle (no session, nothing pairing) for [idleLimitMs], stop it.
     */
    fun shouldStopForIdle(states: Collection<String>, idleSinceMs: Long?, nowMs: Long, idleLimitMs: Long = 10 * 60_000L): Boolean =
        states.all { it in IDLE_STATES } && idleSinceMs != null && nowMs - idleSinceMs >= idleLimitMs

    private val HEX64 = Regex("[0-9a-f]{64}")
}

/**
 * Crash-restart policy: exponential backoff with jitter, reset after a stable run, and a crash
 * loop breaker so a sidecar that cannot start does not drain the battery retrying forever.
 */
class SidecarRestartPolicy(
    private val baseDelayMs: Long = 2_000,
    private val maxDelayMs: Long = 5 * 60_000,
    private val stableRunMs: Long = 10 * 60_000,
    private val loopWindowMs: Long = 15 * 60_000,
    private val maxCrashesInWindow: Int = 6,
    private val jitter: (Long) -> Long = { bound -> (Math.random() * bound).toLong() },
) {
    sealed interface Decision {
        data class RestartAfter(val delayMs: Long, val attempt: Int) : Decision
        data class GiveUp(val crashes: Int) : Decision
        data object Stay : Decision
    }

    private val crashes = ArrayDeque<Long>()
    private var attempt = 0

    /**
     * @param exitCode the sidecar's exit status; null when it never reached ready.
     * @param requested true when the app asked it to stop (shutdown, sign-out, user stop).
     */
    @Synchronized
    fun onExit(exitCode: Int?, requested: Boolean, startedAtMs: Long, nowMs: Long): Decision {
        if (requested) {
            attempt = 0
            return Decision.Stay
        }
        if (nowMs - startedAtMs >= stableRunMs) attempt = 0
        crashes.addLast(nowMs)
        while (crashes.isNotEmpty() && nowMs - crashes.first() > loopWindowMs) crashes.removeFirst()
        if (crashes.size >= maxCrashesInWindow) return Decision.GiveUp(crashes.size)
        val exponent = attempt.coerceAtMost(20)
        val delay = (baseDelayMs shl exponent).coerceAtMost(maxDelayMs)
        attempt++
        return Decision.RestartAfter(delay + jitter((delay / 4).coerceAtLeast(1)), attempt)
    }

    @Synchronized
    fun reset() {
        crashes.clear()
        attempt = 0
    }
}

/** How the app answers one forwarded ingress event, from the Grogoni API's response. */
enum class IngressOutcome {
    /** Stored (or already stored): acknowledge so the sidecar clears its journal. */
    ACK,
    /** Transient (network, 5xx, 401 before refresh, 429): negative ack, the sidecar retries. */
    RETRY,
    /** The API says this owner no longer owns the business: erase locally. */
    DENY,
    /** The chat is no longer approved on the server: revoke it locally, then acknowledge. */
    REVOKE_CHAT;

    companion object {
        fun classify(status: Int?, code: String?): IngressOutcome = when {
            status == null -> RETRY
            status in 200..299 -> ACK
            status == 409 && code == "already_received" -> ACK
            status == 404 && code == "conversation_channel_not_found" -> REVOKE_CHAT
            status == 403 && code == "whatsapp_chat_not_approved" -> REVOKE_CHAT
            status == 403 && code == "permission_denied" -> DENY
            status == 410 -> DENY
            else -> RETRY
        }
    }
}
