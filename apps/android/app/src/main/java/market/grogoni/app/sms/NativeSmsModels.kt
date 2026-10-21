package market.grogoni.app.sms

data class LocalInboundSms(
    val eventId: String,
    val businessId: String,
    val externalMessageId: String,
    val senderE164: String,
    val text: String,
    val occurredAt: String,
)

data class NativeSmsCommand(
    val id: String,
    val recipient: String,
    val text: String,
    val subscriptionId: Int?,
    val reportToGrogoni: Boolean = true,
)

data class PendingSmsResult(
    val commandId: String,
    val status: String,
    val resultCode: String,
    val carrierReference: String?,
    val revision: String = java.util.UUID.randomUUID().toString(),
)

data class SmsCapabilityState(
    val roleAvailable: Boolean,
    val roleGranted: Boolean,
    val sendPermissionGranted: Boolean,
    val receivePermissionGranted: Boolean,
    val simReady: Boolean,
    val subscriptionId: Int?,
    val errorCode: String? = null,
) {
    val ready: Boolean
        get() = roleAvailable && roleGranted && sendPermissionGranted &&
            receivePermissionGranted && simReady && errorCode == null
}

enum class NativeSmsErrorCode {
    SMS_SENT,
    SMS_DELIVERED,
    SMS_DEVICE_UNAVAILABLE,
    SMS_NO_SERVICE,
    SMS_RADIO_OFF,
    SMS_SIM_UNAVAILABLE,
    SMS_SIM_SELECTION_REQUIRED,
    SMS_PERMISSION_REQUIRED,
    SMS_ROLE_REQUIRED,
    SMS_SEND_FAILED,
    SMS_DELIVERY_UNKNOWN,
}

object NativeSmsResultMapper {
    fun sentResult(
        resultCode: Int,
        successCode: Int = android.app.Activity.RESULT_OK,
        noServiceCode: Int = android.telephony.SmsManager.RESULT_ERROR_NO_SERVICE,
        radioOffCode: Int = android.telephony.SmsManager.RESULT_ERROR_RADIO_OFF,
    ): NativeSmsErrorCode = when (resultCode) {
        successCode -> NativeSmsErrorCode.SMS_SENT
        noServiceCode -> NativeSmsErrorCode.SMS_NO_SERVICE
        radioOffCode -> NativeSmsErrorCode.SMS_RADIO_OFF
        else -> NativeSmsErrorCode.SMS_SEND_FAILED
    }
}

enum class CommandReplayDecision { EXECUTE, REPORT_DELIVERY_UNKNOWN, SKIP }

fun commandReplayDecision(
    claimed: Boolean,
    priorState: String?,
    executionTimedOut: Boolean = true,
): CommandReplayDecision = when {
    claimed || priorState == "claimed" -> CommandReplayDecision.EXECUTE
    priorState == "execution_started" && executionTimedOut -> CommandReplayDecision.REPORT_DELIVERY_UNKNOWN
    else -> CommandReplayDecision.SKIP
}
