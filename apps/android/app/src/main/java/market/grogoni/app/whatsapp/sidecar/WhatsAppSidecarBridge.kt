package market.grogoni.app.whatsapp.sidecar

import android.content.Context
import market.grogoni.app.sms.GrogoniSessionStore
import market.grogoni.app.sms.NativeApiClient
import org.json.JSONObject

/**
 * WebView bridge methods for the on-phone WhatsApp worker. The page never sees the loopback
 * port or token: it calls these named methods through MainActivity's pinned-origin message
 * port, and the app talks to the sidecar. Runs on MainActivity's background executor.
 */
class WhatsAppSidecarBridge(private val context: Context) {
    private val controller get() = WhatsAppSidecar.controller(context)
    private val session get() = GrogoniSessionStore(context)

    fun execute(method: String, params: JSONObject): Any = when (method) {
        "whatsappLocalStatus" -> status(params.optString("businessId").takeIf(String::isNotBlank)).also {
            // The owner is looking at the panel: a good moment to pull.
            if (controller.running) controller.nudge()
        }
        "whatsappLocalEnable" -> {
            val account = requireNotNull(session.accountId) { "Sign in to Grogoni first." }
            if (params.optBoolean("enabled")) {
                WhatsAppSidecar.setEnabled(context, account)
                val decision = WhatsAppSidecar.decision(context)
                if (decision is SidecarPolicy.RunDecision.Refuse) {
                    WhatsAppSidecar.setEnabled(context, null)
                    throw IllegalStateException(decision.reason)
                }
                WhatsAppSidecarService.start(context)
            } else {
                WhatsAppSidecarService.stop(context)
                WhatsAppSidecar.setEnabled(context, null)
            }
            status(null)
        }
        "whatsappLocalConnect" -> call("connect", params, "businessId", "phone")
        "whatsappLocalGroups" -> call("groups", params, "businessId")
        "whatsappLocalSend" -> call("send", params, "businessId", "conversationId", "chat", "text", "idempotencyKey")
        "whatsappLocalDisconnect" -> call("disconnect", params, "businessId")
        "whatsappLocalApprove" -> {
            // The Grogoni API creates the conversation as the owner first; the sidecar only
            // accepts the chat after that succeeds, so ingress always has somewhere to land.
            val businessId = params.getString("businessId")
            val chat = params.getString("chat")
            val created = NativeApiClient(session).request(
                "POST",
                "/businesses/${ApiIngressRelay.encode(businessId)}/channels/whatsapp-linked/device/scopes",
                JSONObject().put("chat", chat).put("approved", true),
            ).body
            val approved = controller.call("approve", JSONObject().put("businessId", businessId).put("chat", chat)
                .put("conversationId", created.getString("conversationId"))) ?: JSONObject()
            // Replies may already wait for this chat: pull now rather than at the next idle tick.
            controller.nudge()
            approved
        }
        "whatsappLocalRevoke" -> {
            val businessId = params.getString("businessId")
            val chat = params.getString("chat")
            val result = controller.call("revoke", JSONObject().put("businessId", businessId).put("chat", chat)) ?: JSONObject()
            NativeApiClient(session).request(
                "POST",
                "/businesses/${ApiIngressRelay.encode(businessId)}/channels/whatsapp-linked/device/scopes",
                JSONObject().put("chat", chat).put("approved", false),
            )
            result
        }
        else -> throw IllegalArgumentException("Unknown WhatsApp device method.")
    }

    private fun call(method: String, params: JSONObject, vararg keys: String): Any {
        val forwarded = JSONObject()
        keys.forEach { key -> if (params.has(key)) forwarded.put(key, params.get(key)) }
        return controller.call(method, forwarded, timeoutMs = if (method == "connect") 90_000 else 30_000) ?: JSONObject()
    }

    private fun status(businessId: String?): JSONObject {
        val decision = WhatsAppSidecar.decision(context)
        val result = JSONObject()
            .put("available", controller.runtimePresent)
            .put("enabled", WhatsAppSidecar.enabledAccount(context) != null && WhatsAppSidecar.enabledAccount(context) == session.accountId)
            .put("running", controller.running)
            .put("node", controller.node)
            .put("blockedReason", (decision as? SidecarPolicy.RunDecision.Refuse)?.code ?: JSONObject.NULL)
        if (businessId != null && controller.running)
            result.put("connection", runCatching { controller.call("status", JSONObject().put("businessId", businessId)) }.getOrNull() ?: JSONObject.NULL)
        return result
    }

    companion object {
        val METHODS = setOf(
            "whatsappLocalStatus", "whatsappLocalEnable", "whatsappLocalConnect", "whatsappLocalGroups",
            "whatsappLocalSend", "whatsappLocalDisconnect", "whatsappLocalApprove", "whatsappLocalRevoke",
        )
    }
}
