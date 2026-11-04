package market.grogoni.app.sms

/** Carrier short codes are valid SMS destinations, but are never business identities. */
object SmsDestination {
    fun normalize(raw: String, countryIso: String?): String {
        val compact = raw.trim().replace(Regex("[\\s().-]"), "")
        if (compact.matches(Regex("^[0-9]{3,6}$"))) return compact
        return NativePhoneNormalizer.normalize(raw, countryIso)
    }
}
