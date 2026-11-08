package market.grogoni.app.whatsapp

object WhatsAppPackagePolicy {
    private val targets = listOf("com.whatsapp", "com.whatsapp.w4b")
    fun installed(isEnabled: (String) -> Boolean): List<String> = targets.filter { name ->
        runCatching { isEnabled(name) }.getOrDefault(false)
    }
}
