package market.grogoni.app.sms

import android.content.Context
import market.grogoni.app.BuildConfig
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class NativeSmsApiClient(private val context: Context) {
    private val session = GrogoniSessionStore(context)

    fun login(phoneE164: String, pin: String): List<Pair<String, String>> {
        val response = request(
            "POST",
            "/auth/pin/login",
            JSONObject().put("method", "phone").put("contact", phoneE164).put("pin", pin),
            authenticated = false,
        )
        val cookies = response.cookies
        require(cookies.isNotEmpty()) { "The server did not return an Android session." }
        session.saveCookie(cookies)
        return businesses()
    }

    fun businesses(): List<Pair<String, String>> {
        val result = request("GET", "/v1/devices/native-sms/businesses")
        val businesses = result.body.getJSONArray("businesses")
        return (0 until businesses.length()).map { index ->
            businesses.getJSONObject(index).let { it.getString("id") to it.getString("name") }
        }
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

    private fun request(
        method: String,
        path: String,
        body: JSONObject? = null,
        authenticated: Boolean = true,
        allowRefresh: Boolean = true,
    ): ApiResponse {
        val connection = (URL("${BuildConfig.GROGONI_API_ORIGIN}$path").openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("Accept", "application/json")
            setRequestProperty("X-Grogoni-Device-Id", session.deviceId)
            setRequestProperty("X-Grogoni-Device-Name", android.os.Build.MODEL.take(120))
            setRequestProperty("X-Grogoni-Platform", "android")
            setRequestProperty("X-Grogoni-Client", "android-native")
            if (authenticated) {
                setRequestProperty("Cookie", requireNotNull(session.cookieHeader) { "Sign in to Grogoni first." })
            }
            if (body != null) {
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                outputStream.use { it.write(body.toString().toByteArray()) }
            }
        }
        val status = connection.responseCode
        if (status == 401 && authenticated && allowRefresh && refreshSession()) {
            connection.disconnect()
            return request(method, path, body, authenticated = true, allowRefresh = false)
        }
        val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
            ?.bufferedReader()?.use { it.readText() }.orEmpty()
        val responseBody = if (text.isBlank()) JSONObject() else JSONObject(text)
        val cookies = collectCookies(connection)
        connection.disconnect()
        if (status !in 200..299) {
            throw IllegalStateException(responseBody.optString("message", "Grogoni request failed ($status)."))
        }
        return ApiResponse(responseBody, cookies)
    }

    @Synchronized
    private fun refreshSession(): Boolean = runCatching {
        val currentCookie = requireNotNull(session.cookieHeader)
        val connection = (URL("${BuildConfig.GROGONI_API_ORIGIN}/auth/session/refresh").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("Cookie", currentCookie)
            setRequestProperty("X-Grogoni-Device-Id", session.deviceId)
            setRequestProperty("X-Grogoni-Device-Name", android.os.Build.MODEL.take(120))
            setRequestProperty("X-Grogoni-Platform", "android")
            setRequestProperty("X-Grogoni-Client", "android-native")
        }
        val success = connection.responseCode in 200..299
        if (success) session.saveCookie(mergeCookies(currentCookie, collectCookies(connection)))
        connection.disconnect()
        success
    }.getOrDefault(false)

    private fun collectCookies(connection: HttpURLConnection): String = connection.headerFields
        .filterKeys { it?.equals("Set-Cookie", ignoreCase = true) == true }
        .values.flatten()
        .mapNotNull { it.substringBefore(';').takeIf(String::isNotBlank) }
        .joinToString("; ")

    private fun mergeCookies(current: String, replacement: String): String {
        val cookies = linkedMapOf<String, String>()
        (current.split(';') + replacement.split(';')).forEach { part ->
            val pieces = part.trim().split('=', limit = 2)
            if (pieces.size == 2 && pieces[1].isNotBlank()) cookies[pieces[0]] = pieces[1]
        }
        return cookies.entries.joinToString("; ") { "${it.key}=${it.value}" }
    }

    private data class ApiResponse(val body: JSONObject, val cookies: String)
}
