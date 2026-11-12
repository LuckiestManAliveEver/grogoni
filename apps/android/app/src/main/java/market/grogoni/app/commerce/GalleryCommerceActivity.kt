package market.grogoni.app.commerce

import market.grogoni.app.MainActivity

/** Compatibility entry point into the shared catalogue, without a second native gallery UI. */
class GalleryCommerceActivity : MainActivity() {
    override fun initialRoute() = "/catalogue"
}
