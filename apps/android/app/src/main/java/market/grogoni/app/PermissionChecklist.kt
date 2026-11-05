package market.grogoni.app

import android.Manifest
import android.app.Activity
import android.app.role.RoleManager
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import market.grogoni.app.sms.DefaultSmsRole
import org.json.JSONArray
import org.json.JSONObject

/**
 * First-run device access checklist. Item ids and order follow contracts/device-permission-checklist.json;
 * the shared web UI owns the wording. Android never auto-requests: each grant follows a user tap.
 * Every item is backed by code that uses it (SMS provider, phonebook lookup, notifications,
 * WebView camera capture, WebView geolocation).
 */
data class ChecklistGroup(
    val id: String,
    val required: Boolean,
    val permissions: List<String>,
    /** Location is usable with an approximate-only grant. */
    val satisfiedByAny: Boolean = false,
    /** SMS permissions are hard-restricted until Grogoni holds the default SMS role. */
    val needsSmsRole: Boolean = false,
) {
    fun satisfied(granted: Set<String>): Boolean =
        if (satisfiedByAny) permissions.any { it in granted } else permissions.all { it in granted }
}

enum class ChecklistStatus(val wire: String) {
    GRANTED("granted"),
    NOT_REQUESTED("not_requested"),
    /** Refused or dismissed; Android will still show its dialog. */
    DENIED("denied"),
    /** Android no longer shows a dialog; only system settings can grant it. */
    BLOCKED("blocked"),
    UNAVAILABLE("unavailable"),
}

sealed interface ChecklistStep {
    data object Skip : ChecklistStep
    data object RequestRole : ChecklistStep
    data class RequestPermissions(val permissions: List<String>) : ChecklistStep
}

object PermissionChecklistPolicy {
    const val CONTRACT_VERSION = 2
    /** A refusal faster than this means Android answered without showing a dialog. */
    const val INSTANT_REFUSAL_MS = 400L

    fun groups(sdk: Int = Build.VERSION.SDK_INT): List<ChecklistGroup> = buildList {
        add(ChecklistGroup("sms", true, listOf(
            Manifest.permission.SEND_SMS,
            Manifest.permission.RECEIVE_SMS,
            Manifest.permission.READ_SMS,
            Manifest.permission.RECEIVE_MMS,
            Manifest.permission.RECEIVE_WAP_PUSH,
        ), needsSmsRole = true))
        add(ChecklistGroup("contacts", false, listOf(Manifest.permission.READ_CONTACTS)))
        // Below API 33 notifications are granted at install and there is nothing to ask.
        if (sdk >= Build.VERSION_CODES.TIRAMISU) add(ChecklistGroup("notifications", false, listOf(Manifest.permission.POST_NOTIFICATIONS)))
        add(ChecklistGroup("camera", false, listOf(Manifest.permission.CAMERA)))
        add(ChecklistGroup("location", false, listOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION), satisfiedByAny = true))
    }

    /**
     * [blockedRecorded] comes from [refusalIsPermanent] at the last refusal. [canAskNow] (Android's
     * rationale flag) overrides it. The web UI offers Settings for denied items too, because a
     * refusal Android answers slowly without a dialog cannot be told apart from a dismissal.
     */
    fun status(available: Boolean, satisfied: Boolean, asked: Boolean, blockedRecorded: Boolean, canAskNow: Boolean): ChecklistStatus = when {
        !available -> ChecklistStatus.UNAVAILABLE
        satisfied -> ChecklistStatus.GRANTED
        blockedRecorded && !canAskNow -> ChecklistStatus.BLOCKED
        asked -> ChecklistStatus.DENIED
        else -> ChecklistStatus.NOT_REQUESTED
    }

    /**
     * Android exposes no "permanently denied" flag. A refusal is permanent when the rationale flag
     * flipped from true to false (second refusal on 11+, "don't ask again" before 11) or Android
     * answered without a dialog. A dismissed first dialog on 11+ leaves both flags false and is
     * correctly not permanent.
     */
    fun refusalIsPermanent(rationaleBefore: Boolean, rationaleAfter: Boolean, elapsedMs: Long): Boolean =
        (rationaleBefore && !rationaleAfter) || elapsedMs < INSTANT_REFUSAL_MS

    /**
     * The whole decision for one item. Role refusals and permission refusals are recorded apart, so
     * a role refused long ago cannot mark the SMS permissions blocked once the role is held. A held
     * notification permission that is switched off can only be fixed in Settings.
     */
    fun itemStatus(
        available: Boolean, roleHeld: Boolean, missing: List<String>, switchedOn: Boolean, asked: Boolean,
        blockedPermissions: Boolean, blockedRole: Boolean, rationale: Boolean,
    ): ChecklistStatus {
        if (available && roleHeld && missing.isEmpty() && !switchedOn) return ChecklistStatus.BLOCKED
        return status(
            available = available,
            satisfied = roleHeld && missing.isEmpty(),
            asked = asked,
            blockedRecorded = if (roleHeld) blockedPermissions else blockedRole,
            canAskNow = roleHeld && rationale,
        )
    }

    /** <input capture> opens the camera only for the pinned origin and a held CAMERA permission. */
    fun cameraCaptureAllowed(trustedPage: Boolean, captureRequested: Boolean, acceptTypes: List<String>, granted: Set<String>): Boolean =
        trustedPage && captureRequested && Manifest.permission.CAMERA in granted &&
            (acceptTypes.isEmpty() || acceptTypes.any { it.startsWith("image/") })

    fun geolocationAllowed(trustedOrigin: Boolean, granted: Set<String>): Boolean =
        trustedOrigin && (Manifest.permission.ACCESS_COARSE_LOCATION in granted || Manifest.permission.ACCESS_FINE_LOCATION in granted)

    fun missing(group: ChecklistGroup, granted: Set<String>): List<String> =
        if (group.satisfied(granted)) emptyList() else group.permissions.filter { it !in granted }

    /** What to do next for one queued item. [roleJustRefused] stops the role dialog from looping. */
    fun nextStep(group: ChecklistGroup, status: ChecklistStatus, roleHeld: Boolean, roleJustRefused: Boolean, granted: Set<String>): ChecklistStep {
        if (status == ChecklistStatus.GRANTED || status == ChecklistStatus.BLOCKED || status == ChecklistStatus.UNAVAILABLE) return ChecklistStep.Skip
        if (group.needsSmsRole && !roleHeld) return if (roleJustRefused) ChecklistStep.Skip else ChecklistStep.RequestRole
        val missing = missing(group, granted)
        return if (missing.isEmpty()) ChecklistStep.Skip else ChecklistStep.RequestPermissions(missing)
    }
}

class PermissionChecklist(private val activity: Activity) {
    private val prefs = activity.getSharedPreferences("permission-checklist", Context.MODE_PRIVATE)

    /** Captured when a dialog opens so the result can be classified. */
    data class Request(val id: String, val rationaleBefore: Boolean, val startedAt: Long)

    val completed: Boolean get() = prefs.getBoolean("completed", false)
    fun group(id: String) = PermissionChecklistPolicy.groups().firstOrNull { it.id == id }
    fun granted() = AndroidPermissionPolicy.grantedPermissions(activity)

    // Direct role checks: NativeSmsCapability.inspect also writes session state and reads the SIM.
    fun smsRoleAvailable(): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        activity.getSystemService(RoleManager::class.java)?.isRoleAvailable(RoleManager.ROLE_SMS) == true
        else activity.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
    fun smsRoleHeld(): Boolean = DefaultSmsRole.held(activity)

    private fun rationale(permissions: List<String>) = permissions.any { ActivityCompat.shouldShowRequestPermissionRationale(activity, it) }

    /** Call just before launching; [markAsked] only once the dialog actually opened. */
    fun prepare(group: ChecklistGroup, permissions: List<String>) =
        Request(group.id, rationale(permissions), SystemClock.elapsedRealtime())
    fun markAsked(id: String) { prefs.edit().putBoolean("asked:$id", true).apply() }

    fun finishPermissions(request: Request, permissions: List<String>) {
        val group = group(request.id) ?: return
        val blocked = !group.satisfied(granted()) && PermissionChecklistPolicy.refusalIsPermanent(
            request.rationaleBefore, rationale(permissions), SystemClock.elapsedRealtime() - request.startedAt)
        prefs.edit().putBoolean("blocked:${group.id}", blocked).apply()
    }

    /** The role dialog has no rationale flag; only an instant refusal means Android stopped asking. */
    fun finishRole(request: Request) {
        val blocked = !smsRoleHeld() && SystemClock.elapsedRealtime() - request.startedAt < PermissionChecklistPolicy.INSTANT_REFUSAL_MS
        // Separate key: a refused role must not mark the SMS permissions blocked once the role is held.
        prefs.edit().putBoolean("blocked:${request.id}:role", blocked).apply()
    }

    fun status(group: ChecklistGroup): ChecklistStatus {
        val missing = PermissionChecklistPolicy.missing(group, granted())
        // A grant made in Settings never reaches finishPermissions, so clear the old refusal here.
        if (missing.isEmpty()) prefs.edit().remove("blocked:${group.id}").apply()
        if (group.needsSmsRole && smsRoleHeld()) prefs.edit().remove("blocked:${group.id}:role").apply()
        return PermissionChecklistPolicy.itemStatus(
            available = !group.needsSmsRole || smsRoleAvailable(),
            roleHeld = !group.needsSmsRole || smsRoleHeld(),
            missing = missing,
            // POST_NOTIFICATIONS can be held while the app's notifications are switched off in Settings.
            switchedOn = group.id != "notifications" || NotificationManagerCompat.from(activity).areNotificationsEnabled(),
            asked = prefs.getBoolean("asked:${group.id}", false),
            blockedPermissions = prefs.getBoolean("blocked:${group.id}", false),
            blockedRole = prefs.getBoolean("blocked:${group.id}:role", false),
            rationale = rationale(missing),
        )
    }

    fun complete(): JSONObject {
        val firstCompletion = !completed
        prefs.edit().putBoolean("completed", true).apply()
        val snapshot = snapshot()
        val items = snapshot.getJSONArray("items")
        val granted = (0 until items.length()).count { items.getJSONObject(it).getString("status") == ChecklistStatus.GRANTED.wire }
        // Trace for the onboarding outcome: how much access a new install leaves the checklist with.
        if (firstCompletion) Log.i("GrogoniPermissions", "checklist completed granted=$granted/${items.length()}")
        return snapshot
    }

    fun snapshot(): JSONObject = JSONObject()
        .put("version", PermissionChecklistPolicy.CONTRACT_VERSION)
        .put("completed", completed)
        .put("items", JSONArray(PermissionChecklistPolicy.groups().map {
            JSONObject().put("id", it.id).put("required", it.required).put("status", status(it).wire)
        }))
}

/**
 * Walks queued checklist items one Android dialog at a time and resolves the waiting web call once.
 * Android specifics sit behind [Host] so the ordering rules are unit-tested.
 */
class ChecklistRequestQueue(private val host: Host) {
    interface Host {
        fun group(id: String): ChecklistGroup?
        fun status(group: ChecklistGroup): ChecklistStatus
        fun roleHeld(): Boolean
        fun granted(): Set<String>
        /** Opens the role dialog; false when it cannot be shown. */
        fun launchRole(group: ChecklistGroup): Boolean
        /** Opens Android's permission dialog; false when it cannot be shown. */
        fun launchPermissions(group: ChecklistGroup, permissions: List<String>): Boolean
        fun snapshot(): Any
    }

    private val queue = ArrayDeque<String>()
    private var pending: ((Any?, String?) -> Unit)? = null
    private var roleRefused: String? = null
    val busy: Boolean get() = pending != null

    /** Returns an error message instead of starting when a flow is already open or an id is unknown. */
    fun start(ids: List<String>, callback: (Any?, String?) -> Unit): String? {
        if (busy) return "A permission request is already open."
        if (ids.isEmpty() || ids.any { host.group(it) == null }) return "Unknown device permission."
        pending = callback
        queue.clear(); queue.addAll(ids); roleRefused = null
        advance()
        return null
    }

    fun onRoleResult(group: String) {
        if (!host.roleHeld()) roleRefused = group
        advance()
    }

    fun onPermissionsResult() = advance()

    /** Continue stops the flow: the open dialog may finish, nothing new opens, the web call resolves. */
    fun cancel() {
        queue.clear()
        resolve()
    }

    private fun resolve() {
        val callback = pending ?: return
        pending = null
        callback(host.snapshot(), null)
    }

    private fun advance() {
        while (true) {
            val id = queue.removeFirstOrNull() ?: return resolve()
            val group = host.group(id) ?: continue
            when (val step = PermissionChecklistPolicy.nextStep(group, host.status(group), host.roleHeld(), roleRefused == id, host.granted())) {
                ChecklistStep.Skip -> continue
                // Re-queue: once the role is held, the same item asks for the SMS permissions it did not grant.
                ChecklistStep.RequestRole -> if (host.launchRole(group)) { queue.addFirst(id); return }
                is ChecklistStep.RequestPermissions -> if (host.launchPermissions(group, step.permissions)) return
            }
        }
    }
}
