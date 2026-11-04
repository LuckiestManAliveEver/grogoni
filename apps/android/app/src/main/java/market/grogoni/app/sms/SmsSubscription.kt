package market.grogoni.app.sms

import android.telephony.SmsManager

object SmsSubscription {
    // SmsManager exposes this on API 22; SubscriptionManager's equivalent needs API 24.
    // Neither an invalid ID nor the "ask every time" sentinel is a deterministic SIM.
    fun defaultId(): Int? = SmsManager.getDefaultSmsSubscriptionId().takeIf { it >= 0 && it != Int.MAX_VALUE }
}
