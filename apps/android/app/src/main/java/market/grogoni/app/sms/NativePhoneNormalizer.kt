package market.grogoni.app.sms

import android.telephony.PhoneNumberUtils

object NativePhoneNormalizer {
    private val e164 = Regex("^\\+[1-9]\\d{6,14}$")

    /**
     * Phonebook numbers saved in local form belong to the SIM's country. The network country is
     * never used: roaming would read a saved 0712... as a number in the visited country.
     */
    fun homeCountry(simCountryIso: String?): String? =
        simCountryIso?.trim()?.uppercase()?.takeIf { it.matches(Regex("[A-Z]{2}")) }

    fun normalize(
        raw: String,
        networkCountryIso: String?,
        formatter: (String, String) -> String? = PhoneNumberUtils::formatNumberToE164,
    ): String {
        val compact = raw.trim().replace(Regex("[\\s().-]"), "")
        if (e164.matches(compact)) return compact
        val country = networkCountryIso?.trim()?.uppercase().orEmpty()
        require(country.matches(Regex("^[A-Z]{2}$"))) {
            "A deterministic network country is required for a local SMS address."
        }
        val formatted = formatter(compact, country)
        require(formatted != null && e164.matches(formatted)) { "The SMS address is invalid." }
        return formatted
    }
}
