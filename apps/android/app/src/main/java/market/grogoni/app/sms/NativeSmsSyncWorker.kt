package market.grogoni.app.sms

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

class NativeSmsSyncWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    // Periodic recovery and event-triggered work use different WorkManager names, so they may
    // overlap. Serialize the claim/acknowledge/send sequence before resuming a claimed command.
    override fun doWork(): Result = synchronized(SYNC_LOCK) { sync() }

    private fun sync(): Result {
        val session = GrogoniSessionStore(applicationContext)
        if (!session.syncEnabled || session.cookieHeader == null || session.businessId == null) return Result.success()
        NativeSmsStore(applicationContext).use { store ->
            val api = NativeSmsApiClient(applicationContext)
            return try {
                if (isStopped) return Result.retry()
                api.register(NativeSmsCapability.inspect(applicationContext))
                val inbound = store.unsyncedInbound()
                inbound.forEach { message ->
                    if (isStopped || !session.syncEnabled) return Result.retry()
                    api.uploadInbound(message)
                    store.markInboundSynced(message.eventId)
                }
                val results = store.pendingResults()
                results.forEach { result ->
                    if (isStopped || !session.syncEnabled) return Result.retry()
                    api.report(result)
                    store.deletePendingResult(result)
                }
                if (isStopped) return Result.retry()
                val commands = api.fetchCommands()
                commands.forEach { command ->
                    if (isStopped || !session.syncEnabled) return Result.retry()
                    executeOnce(command, store, api)
                }
                // Continue draining a reconnect backlog without waiting for the periodic job.
                if (inbound.size == 50 || results.size == 50 || commands.size == 20 ||
                    commands.any { store.commandState(it.id) == "execution_started" } ||
                    store.unsyncedInbound(1).isNotEmpty() || store.pendingResults().isNotEmpty()
                ) Result.retry() else Result.success()
            } catch (_: Exception) {
                // Connectivity can appear available while the backend is unreachable. Keep durable
                // work scheduled with WorkManager's bounded exponential backoff until it recovers.
                Result.retry()
            }
        }
    }

    private fun executeOnce(
        command: NativeSmsCommand,
        store: NativeSmsStore,
        api: NativeSmsApiClient,
    ) {
        when (commandReplayDecision(
            store.claimCommand(command.id), store.commandState(command.id),
            store.executionTimedOut(command.id),
        )) {
            CommandReplayDecision.REPORT_DELIVERY_UNKNOWN -> {
                store.enqueueResult(
                    PendingSmsResult(
                        command.id,
                        "failed",
                        NativeSmsErrorCode.SMS_DELIVERY_UNKNOWN.name,
                        null,
                    ),
                )
                return
            }
            CommandReplayDecision.SKIP -> return
            CommandReplayDecision.EXECUTE -> Unit
        }
        api.acknowledge(command.id)
        if (isStopped || !GrogoniSessionStore(applicationContext).syncEnabled) return
        try {
            store.markCommandExecutionStarted(command.id)
            AndroidSmsSender(applicationContext).send(command)
        } catch (error: NativeSmsSendException) {
            store.markCommandTerminal(command.id, "failed", error.code)
            store.enqueueResult(PendingSmsResult(command.id, "failed", error.code.name, null))
        } catch (_: Exception) {
            store.markCommandTerminal(command.id, "failed", NativeSmsErrorCode.SMS_SEND_FAILED)
            store.enqueueResult(
                PendingSmsResult(command.id, "failed", NativeSmsErrorCode.SMS_SEND_FAILED.name, null),
            )
        }
    }

    private companion object {
        val SYNC_LOCK = Any()
    }
}
