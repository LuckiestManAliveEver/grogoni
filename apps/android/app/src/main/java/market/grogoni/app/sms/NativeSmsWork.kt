package market.grogoni.app.sms

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

object NativeSmsWork {
    fun schedule(context: Context) {
        val constraints = connectedConstraints()
        val request = OneTimeWorkRequestBuilder<NativeSmsSyncWorker>()
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
            .build()
        val workManager = WorkManager.getInstance(context)
        workManager.enqueueUniqueWork(
            "native-sms-sync",
            ExistingWorkPolicy.KEEP,
            request,
        )
        workManager.enqueueUniquePeriodicWork(
            "native-sms-periodic-sync",
            ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<NativeSmsSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build(),
        )
    }

    fun cancel(context: Context) {
        WorkManager.getInstance(context).run {
            cancelUniqueWork("native-sms-sync")
            cancelUniqueWork("native-sms-periodic-sync")
        }
    }

    private fun connectedConstraints(): Constraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()
}
