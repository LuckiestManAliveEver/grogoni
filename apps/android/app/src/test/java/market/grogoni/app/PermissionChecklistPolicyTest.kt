package market.grogoni.app

import android.Manifest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class PermissionChecklistPolicyTest {
    private val sdks = listOf(23, 28, 29, 30, 33, 34, 35)

    /** Gradle runs unit tests from apps/android/app; the contract lives at the repository root. */
    private val contract = File("../../../contracts/device-permission-checklist.json").readText()
    private fun contractIds() = Regex("\"id\"\\s*:\\s*\"([a-z_]+)\"").findAll(contract.substringAfter("\"items\"").substringBefore("\"notAsked\""))
        .map { it.groupValues[1] }.toList()
    private fun contractNotAsked() = Regex("\"(android\\.permission\\.[A-Z_]+)\"").findAll(contract.substringAfter("\"notAsked\"")).map { it.groupValues[1] }.toSet()

    @Test
    fun `checklist ids follow the shared contract in order`() {
        val contract = contractIds()
        assertEquals(listOf("sms", "contacts", "notifications", "camera", "location"), contract)
        for (sdk in sdks) {
            val ids = PermissionChecklistPolicy.groups(sdk).map { it.id }
            assertEquals("sdk $sdk", contract.filter { it in ids }, ids)
            assertEquals(sdk >= 33, "notifications" in ids)
        }
    }

    @Test
    fun `every declared permission is either asked once or listed as not asked with a reason`() {
        val notAsked = contractNotAsked()
        for (sdk in sdks) {
            val declared = AndroidPermissionPolicy.permissionSetForSdk(sdk)
            val listed = PermissionChecklistPolicy.groups(sdk).flatMap { it.permissions }
            assertEquals("sdk $sdk duplicates", listed.size, listed.toSet().size)
            assertTrue("sdk $sdk asks undeclared ${listed - declared}", declared.containsAll(listed))
            assertEquals("sdk $sdk unaccounted", emptySet<String>(), declared - listed.toSet() - notAsked)
            assertEquals("sdk $sdk asked and excluded", emptySet<String>(), listed.toSet() intersect notAsked)
        }
    }

    /** The real manifest, so a permission added there without a checklist item or a reason fails here. */
    @Test
    fun `every manifest permission is either asked by the checklist or explained in the contract`() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val declared = Regex("<uses-permission[^>]*android:name=\"([^\"]+)\"").findAll(manifest).map { it.groupValues[1] }.toSet()
        val asked = sdks.flatMap { sdk -> PermissionChecklistPolicy.groups(sdk).flatMap { it.permissions } }.toSet()
        assertEquals(emptySet<String>(), declared - asked - contractNotAsked())
        assertEquals("explained but no longer declared", emptySet<String>(), contractNotAsked() - declared)
        // The location copy promises no background tracking.
        assertFalse(Manifest.permission.ACCESS_BACKGROUND_LOCATION in declared)
    }

    @Test
    fun `only messages is required and the phonebook asks for read access only`() {
        val groups = PermissionChecklistPolicy.groups(34)
        assertEquals(listOf("sms"), groups.filter { it.required }.map { it.id })
        assertEquals(listOf(Manifest.permission.READ_CONTACTS), groups.single { it.id == "contacts" }.permissions)
    }

    @Test
    fun `restricted SMS permissions sit behind the default SMS role`() {
        val groups = PermissionChecklistPolicy.groups(34)
        val sms = groups.single { it.id == "sms" }
        assertTrue(sms.needsSmsRole)
        assertTrue(groups.filter { it.id != "sms" }.none { it.needsSmsRole })
        assertFalse("no code uses it, so it must not fail the required item", Manifest.permission.READ_PHONE_STATE in sms.permissions)
        assertFalse("android.permission.WRITE_SMS" in sms.permissions)
    }

    @Test
    fun `approximate location counts as granted`() {
        val location = PermissionChecklistPolicy.groups(34).single { it.id == "location" }
        assertTrue(location.satisfied(setOf(Manifest.permission.ACCESS_COARSE_LOCATION)))
        assertEquals(emptyList<String>(), PermissionChecklistPolicy.missing(location, setOf(Manifest.permission.ACCESS_COARSE_LOCATION)))
        assertEquals(location.permissions, PermissionChecklistPolicy.missing(location, emptySet()))
    }

    @Test
    fun `status distinguishes first ask, retry, settings-only and unsupported`() {
        fun status(available: Boolean = true, satisfied: Boolean = false, asked: Boolean = false, blocked: Boolean = false, canAskNow: Boolean = false) =
            PermissionChecklistPolicy.status(available, satisfied, asked, blocked, canAskNow)
        assertEquals(ChecklistStatus.UNAVAILABLE, status(available = false, satisfied = true))
        assertEquals(ChecklistStatus.GRANTED, status(satisfied = true, asked = true, blocked = true))
        assertEquals(ChecklistStatus.NOT_REQUESTED, status())
        // A dismissed dialog on Android 11+: asked, rationale false, not recorded as blocked.
        assertEquals(ChecklistStatus.DENIED, status(asked = true))
        assertEquals(ChecklistStatus.DENIED, status(asked = true, canAskNow = true))
        assertEquals(ChecklistStatus.BLOCKED, status(asked = true, blocked = true))
        // Reset in Settings: Android shows the rationale flag again, so the item is askable.
        assertEquals(ChecklistStatus.DENIED, status(asked = true, blocked = true, canAskNow = true))
        // Refused through an older flow and never asked here: a tap finds out, and records the block.
        assertEquals(ChecklistStatus.NOT_REQUESTED, status(asked = false))
        assertEquals(listOf("granted", "not_requested", "denied", "blocked", "unavailable"), ChecklistStatus.entries.map { it.wire })
    }

    @Test
    fun `item status keeps role and permission refusals apart`() {
        fun item(roleHeld: Boolean = true, missing: List<String> = listOf("p"), switchedOn: Boolean = true, asked: Boolean = true,
            blockedPermissions: Boolean = false, blockedRole: Boolean = false, rationale: Boolean = false) =
            PermissionChecklistPolicy.itemStatus(true, roleHeld, missing, switchedOn, asked, blockedPermissions, blockedRole, rationale)
        assertEquals(ChecklistStatus.BLOCKED, item(roleHeld = false, blockedRole = true))
        assertEquals("role refused long ago, now held", ChecklistStatus.DENIED, item(blockedRole = true))
        assertEquals(ChecklistStatus.BLOCKED, item(blockedPermissions = true))
        assertEquals("without the role, the rationale flag means nothing", ChecklistStatus.BLOCKED, item(roleHeld = false, blockedRole = true, rationale = true))
        assertEquals("held but switched off", ChecklistStatus.BLOCKED, item(missing = emptyList(), switchedOn = false))
        assertEquals(ChecklistStatus.GRANTED, item(missing = emptyList()))
        assertEquals(ChecklistStatus.UNAVAILABLE, PermissionChecklistPolicy.itemStatus(false, true, emptyList(), false, true, false, false, false))
    }

    @Test
    fun `local numbers are read in the SIM country, never the roaming network`() {
        assertEquals("KE", market.grogoni.app.sms.NativePhoneNormalizer.homeCountry("ke"))
        assertEquals(null, market.grogoni.app.sms.NativePhoneNormalizer.homeCountry(""))
        assertEquals(null, market.grogoni.app.sms.NativePhoneNormalizer.homeCountry(null))
        assertEquals(null, market.grogoni.app.sms.NativePhoneNormalizer.homeCountry("kenya"))
    }

    @Test
    fun `camera and location reach the page only on the pinned origin with the permission held`() {
        val camera = setOf(Manifest.permission.CAMERA)
        fun capture(trusted: Boolean = true, requested: Boolean = true, types: List<String> = listOf("image/*"), granted: Set<String> = camera) =
            PermissionChecklistPolicy.cameraCaptureAllowed(trusted, requested, types, granted)
        assertTrue(capture())
        assertTrue(capture(types = emptyList()))
        assertFalse("untrusted page", capture(trusted = false))
        assertFalse("no capture attribute", capture(requested = false))
        assertFalse("not an image", capture(types = listOf("application/pdf")))
        assertFalse("not granted", capture(granted = emptySet()))
        val coarse = setOf(Manifest.permission.ACCESS_COARSE_LOCATION)
        assertTrue(PermissionChecklistPolicy.geolocationAllowed(true, coarse))
        assertFalse(PermissionChecklistPolicy.geolocationAllowed(false, coarse))
        assertFalse(PermissionChecklistPolicy.geolocationAllowed(true, emptySet()))
    }

    @Test
    fun `contract version matches the host`() {
        assertEquals(PermissionChecklistPolicy.CONTRACT_VERSION, Regex("\"version\"\\s*:\\s*(\\d+)").find(contract)!!.groupValues[1].toInt())
    }

    @Test
    fun `a refusal is permanent only when Android stopped showing the dialog`() {
        val slow = 2_000L
        assertFalse("first refusal", PermissionChecklistPolicy.refusalIsPermanent(false, true, slow))
        assertFalse("dismissed first dialog on 11+", PermissionChecklistPolicy.refusalIsPermanent(false, false, slow))
        assertFalse("dismissed second dialog", PermissionChecklistPolicy.refusalIsPermanent(true, true, slow))
        assertTrue("second refusal on 11+ or don't ask again", PermissionChecklistPolicy.refusalIsPermanent(true, false, slow))
        assertTrue("no dialog shown", PermissionChecklistPolicy.refusalIsPermanent(false, false, 40))
    }

    @Test
    fun `next step asks for the role first, then only the missing SMS permissions`() {
        val sms = PermissionChecklistPolicy.groups(34).single { it.id == "sms" }
        fun next(status: ChecklistStatus, roleHeld: Boolean, refused: Boolean = false, granted: Set<String> = emptySet()) =
            PermissionChecklistPolicy.nextStep(sms, status, roleHeld, refused, granted)
        assertEquals(ChecklistStep.RequestRole, next(ChecklistStatus.NOT_REQUESTED, roleHeld = false))
        assertEquals("refused role does not loop", ChecklistStep.Skip, next(ChecklistStatus.DENIED, roleHeld = false, refused = true))
        val partly = setOf(Manifest.permission.SEND_SMS, Manifest.permission.READ_SMS, Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_PHONE_STATE)
        assertEquals(ChecklistStep.RequestPermissions(listOf(Manifest.permission.RECEIVE_MMS, Manifest.permission.RECEIVE_WAP_PUSH)),
            next(ChecklistStatus.DENIED, roleHeld = true, granted = partly))
        assertEquals("role auto-granted everything", ChecklistStep.Skip, next(ChecklistStatus.DENIED, roleHeld = true, granted = sms.permissions.toSet()))
    }

    @Test
    fun `next step skips granted, blocked and unsupported items in Allow all`() {
        val camera = PermissionChecklistPolicy.groups(34).single { it.id == "camera" }
        for (status in listOf(ChecklistStatus.GRANTED, ChecklistStatus.BLOCKED, ChecklistStatus.UNAVAILABLE))
            assertEquals(status.wire, ChecklistStep.Skip, PermissionChecklistPolicy.nextStep(camera, status, false, false, emptySet()))
        for (status in listOf(ChecklistStatus.NOT_REQUESTED, ChecklistStatus.DENIED))
            assertEquals(ChecklistStep.RequestPermissions(listOf(Manifest.permission.CAMERA)),
                PermissionChecklistPolicy.nextStep(camera, status, roleHeld = false, roleJustRefused = true, granted = emptySet()))
    }
}
