package market.grogoni.app.sms

import java.net.URLDecoder

data class SmsComposeRequest(val recipient: String, val body: String) {
    companion object {
        fun parse(scheme: String?, encodedTarget: String, explicitBody: String?): SmsComposeRequest {
            require(scheme in setOf("sms", "smsto")) { "MMS is not supported. Use an MMS-capable app for attachments or group MMS." }
            val address = decode(encodedTarget.substringBefore('?'), preservePlus = true)
            require(',' !in address && ';' !in address) { "Group messages are not supported. Enter one SMS recipient." }
            val query = encodedTarget.substringAfter('?', "").split('&').mapNotNull {
                val parts = it.split('=', limit = 2)
                if (parts.size == 2 && decode(parts[0]) == "body") decode(parts[1]) else null
            }.firstOrNull()
            return SmsComposeRequest(address, explicitBody ?: query.orEmpty())
        }
        private fun decode(value: String, preservePlus: Boolean = false) =
            URLDecoder.decode(if (preservePlus) value.replace("+", "%2B") else value, "UTF-8")
    }
}
