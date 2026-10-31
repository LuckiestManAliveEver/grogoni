package market.grogoni.app.sms

import android.os.Build
import market.grogoni.app.BuildConfig
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class NativeApiException(val status: Int, val code: String, message: String) : Exception(message)
data class NativeApiResponse(val status: Int, val body: JSONObject, val cookies: String = "")

fun interface NativeApiTransport {
    fun execute(method: String, path: String, body: JSONObject?, cookie: String?): NativeApiResponse
}

/** Shared transport for SMS, authentication and recovery. Never follows credential-bearing redirects. */
class NativeApiClient(
    private val session: GrogoniSessionStore,
    private val transport: NativeApiTransport = HttpNativeApiTransport(session),
) {
    fun request(
        method: String,
        path: String,
        body: JSONObject? = null,
        authenticated: Boolean = true,
        allowRefresh: Boolean = true,
    ): NativeApiResponse {
        val account = session.accountId
        val cookie = if (authenticated) requireNotNull(session.cookieHeader) { "Sign in to Grogoni first." } else null
        var result = transport.execute(method, path, body, cookie)
        if (result.status == 401 && authenticated && allowRefresh) {
            synchronized(SESSION_LOCK) {
                if (session.accountId == account && session.cookieHeader == cookie) {
                    val refreshed = transport.execute("POST", "/auth/session/refresh", JSONObject(), cookie)
                    if (refreshed.status in 200..299 && refreshed.cookies.isNotBlank()) {
                        session.saveCookie(mergeCookies(cookie.orEmpty(), refreshed.cookies))
                    }
                }
            }
            val replacement = session.cookieHeader
            if (session.accountId == account && replacement != null && replacement != cookie) {
                result = transport.execute(method, path, body, replacement)
            }
        }
        if (result.status !in 200..299) throw NativeApiException(
            result.status,
            result.body.optString("code", "request_failed"),
            result.body.optString("message", "Grogoni request failed (${result.status})."),
        )
        return result
    }

    companion object {
        private val SESSION_LOCK = Any()
        fun mergeCookies(current: String, replacement: String): String {
            val cookies = linkedMapOf<String, String>()
            (current.split(';') + replacement.split(';')).forEach { part ->
                val pieces = part.trim().split('=', limit = 2)
                if (pieces.size == 2) {
                    if (pieces[1].isBlank()) cookies.remove(pieces[0]) else cookies[pieces[0]] = pieces[1]
                }
            }
            return cookies.entries.joinToString("; ") { "${it.key}=${it.value}" }
        }
    }
}

class HttpNativeApiTransport(
    private val session: GrogoniSessionStore,
    private val origin: String = BuildConfig.GROGONI_API_ORIGIN,
) : NativeApiTransport {
    override fun execute(method: String, path: String, body: JSONObject?, cookie: String?): NativeApiResponse {
        require(origin.startsWith("https://")) { "Grogoni requires a secure HTTPS connection." }
        val connection = URL("$origin$path").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 15_000
            connection.readTimeout = 20_000
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("X-Grogoni-Device-Id", session.deviceId)
            connection.setRequestProperty("X-Grogoni-Device-Name", Build.MODEL.take(120))
            connection.setRequestProperty("X-Grogoni-Platform", "android")
            connection.setRequestProperty("X-Grogoni-Client", "android-native")
            cookie?.let { connection.setRequestProperty("Cookie", it) }
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val parsed = runCatching { if (text.isBlank()) JSONObject() else JSONObject(text) }.getOrElse {
                throw NativeApiException(status, "invalid_server_response", "Grogoni returned an unexpected response. Try again later.")
            }
            val cookies = connection.headerFields
                .filterKeys { it?.equals("Set-Cookie", ignoreCase = true) == true }
                .values.flatten().mapNotNull { it.substringBefore(';').takeIf(String::isNotBlank) }
                .joinToString("; ")
            return NativeApiResponse(status, parsed, cookies)
        } finally {
            connection.disconnect()
        }
    }
}
