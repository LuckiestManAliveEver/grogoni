package market.grogoni.app.sms

import android.content.Context
import androidx.work.Worker
import androidx.work.WorkerParameters

class NativeSmsSyncWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result {
        val session = GrogoniSessionStore(applicationContext)
        if (session.cookieHeader == null || session.businessId == null) return Result.success()
        val store = NativeSmsStore(applicationContext)
        val api = NativeSmsApiClient(applicationContext)
        return try {
            api.register(NativeSmsCapability.inspect(applicationContext))
            store.unsyncedInbound().forEach { message ->
                api.uploadInbound(message)
                store.markInboundSynced(message.eventId)
            }
            store.pendingResults().forEach { result ->
                api.report(result)
                store.deletePendingResult(result.commandId)
            }
            api.fetchCommands().forEach { command -> executeOnce(command, store, api) }
            Result.success()
        } catch (_: Exception) {
            if (runAttemptCount < MAX_IMMEDIATE_ATTEMPTS) Result.retry() else Result.failure()
        }
    }

    private fun executeOnce(
        command: NativeSmsCommand,
        store: NativeSmsStore,
        api: NativeSmsApiClient,
    ) {
        when (commandReplayDecision(store.claimCommand(command.id), store.commandState(command.id))) {
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
        const val MAX_IMMEDIATE_ATTEMPTS = 5
    }
}
