package market.grogoni.app.sms

import android.content.Context
import org.json.JSONObject

class NativeSmsApiClient(private val context: Context) {
    private val session = GrogoniSessionStore(context)

    private val accountId = session.accountId
    private val api = NativeApiClient(session)

    fun businesses(): List<Pair<String, String>> {
        val result = request("GET", "/v1/devices/native-sms/businesses")
        val businesses = result.body.getJSONArray("businesses")
        return (0 until businesses.length()).map { index ->
            businesses.getJSONObject(index).let { it.getString("id") to it.getString("name") }
        }
    }

    fun uploadGalleryPhoto(businessId: String, fileName: String, contentBase64: String): JSONObject {
        require(businessId == session.businessId) { "Select the business before uploading." }
        return request("POST", "/businesses/$businessId/product-captures", JSONObject()
            .put("fileName", fileName).put("contentType", "image/jpeg").put("contentBase64", contentBase64)).body
    }

    fun logout() {
        request("POST", "/auth/logout", JSONObject())
    }

    fun register(state: SmsCapabilityState, preferred: Boolean = false) {
        request(
            "PUT",
            "/v1/devices/native-sms",
            JSONObject()
                .put("roleAvailable", state.roleAvailable)
                .put("roleGranted", state.roleGranted)
                .put("sendPermissionGranted", state.sendPermissionGranted)
                .put("receivePermissionGranted", state.receivePermissionGranted)
                .put("simReady", state.simReady)
                .put("subscriptionId", state.subscriptionId ?: JSONObject.NULL)
                .put("preferred", preferred)
                .put("lastErrorCode", state.errorCode ?: JSONObject.NULL),
        )
    }

    fun uploadInbound(message: LocalInboundSms) {
        request(
            "POST",
            "/v1/devices/native-sms/messages",
            JSONObject()
                .put("businessId", message.businessId)
                .put("externalMessageId", message.externalMessageId)
                .put("sender", message.senderE164)
                .put("text", message.text)
                .put("occurredAt", message.occurredAt),
        )
    }

    fun fetchCommands(): List<NativeSmsCommand> {
        val body = request("GET", "/v1/devices/native-sms/commands?limit=20").body
        val commands = body.getJSONArray("commands")
        val subscription = body.getJSONObject("device").optInt("subscriptionId", -1)
            .takeIf { it >= 0 }
        return (0 until commands.length()).map { index ->
            commands.getJSONObject(index).let {
                NativeSmsCommand(it.getString("id"), it.getString("recipient"), it.getString("text"), subscription)
            }
        }
    }

    fun acknowledge(commandId: String) {
        request("POST", "/v1/devices/native-sms/commands/$commandId/acknowledge", JSONObject())
    }

    fun report(result: PendingSmsResult) {
        request(
            "POST",
            "/v1/devices/native-sms/commands/${result.commandId}/result",
            JSONObject()
                .put("status", result.status)
                .put("resultCode", result.resultCode)
                .put("carrierReference", result.carrierReference ?: JSONObject.NULL),
        )
    }

    private fun request(method: String, path: String, body: JSONObject? = null): NativeApiResponse {
        check(session.accountId == accountId) { "Account changed. Retry from the current account." }
        return api.request(method, path, body)
    }
}
