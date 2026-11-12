package market.grogoni.app.sms

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri
import android.provider.Telephony
import androidx.work.BackoffPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit
import com.example.android.mmslib.pdu.PduParser
import com.example.android.mmslib.pdu.NotificationInd

/** Encrypted write-ahead copy, independent of login, business sync and network access. */
class IncomingSmsJournal(context: Context) : SQLiteOpenHelper(context, "incoming-sms.db", null, 2) {
    private val secretBox = AndroidSecretBox()
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("create table incoming (id text primary key, sender text not null, body text not null, received_at integer not null, provider_uri text)")
        createMmsTable(db)
    }
    private fun createMmsTable(db: SQLiteDatabase) {
        db.execSQL("create table mms_notifications (id text primary key, payload text not null, subscription integer not null, provider_uri text)")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) createMmsTable(db)
    }

    fun recordMms(bytes: ByteArray, subscription: Int) {
        require(bytes.size <= MmsTransport.MAX_BYTES)
        val notification = PduParser(bytes, true).parse() as? NotificationInd ?: error("Invalid MMS notification.")
        val location = Uri.parse(String(requireNotNull(notification.contentLocation), Charsets.ISO_8859_1))
        require(location.scheme in setOf("http", "https") && !location.host.isNullOrBlank())
        val id = java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) } + ":$subscription"
        writableDatabase.insertWithOnConflict("mms_notifications", null, ContentValues().apply {
            put("id", id); put("subscription", subscription)
            put("payload", secretBox.encrypt(android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)))
        }, SQLiteDatabase.CONFLICT_IGNORE)
        check(readableDatabase.rawQuery("select 1 from mms_notifications where id = ?", arrayOf(id)).use { it.moveToFirst() })
    }

    fun record(sms: MultipartSmsAssembler.Assembled) {
        writableDatabase.insertWithOnConflict("incoming", null, ContentValues().apply {
            put("id", sms.id)
            put("sender", secretBox.encrypt(sms.sender))
            put("body", secretBox.encrypt(sms.text))
            put("received_at", sms.timestampMillis)
        }, SQLiteDatabase.CONFLICT_IGNORE)
        check(readableDatabase.rawQuery("select 1 from incoming where id = ?", arrayOf(sms.id)).use { it.moveToFirst() })
    }

    fun pending(): List<MultipartSmsAssembler.Assembled> = readableDatabase.rawQuery(
        "select sender, body, received_at, id from incoming where provider_uri is null order by received_at limit 100", null,
    ).use { cursor ->
        buildList {
            while (cursor.moveToNext()) add(MultipartSmsAssembler.Assembled(
                requireNotNull(secretBox.decrypt(cursor.getString(0))),
                requireNotNull(secretBox.decrypt(cursor.getString(1))), cursor.getLong(2), cursor.getString(3),
            ))
        }
    }

    /** Provider writes and our SQLite update cannot share a transaction. Reconcile first. */
    fun recover(context: Context, provider: IncomingSmsProvider = AndroidIncomingSmsProvider(context)): Boolean = synchronized(LOCK) {
        if (!DefaultSmsRole.held(context)) return@synchronized false
        for (sms in pending()) {
            val uri = provider.find(sms) ?: requireNotNull(provider.insert(sms)) { "Android could not store incoming SMS." }
            check(writableDatabase.update("incoming", ContentValues().apply {
                put("provider_uri", uri.toString())
                // The Android provider owns the final copy. Keep only deduplication metadata.
                put("sender", ""); put("body", "")
            },
                "id = ?", arrayOf(sms.id)) == 1)
        }
        readableDatabase.rawQuery("select id, payload, subscription from mms_notifications where provider_uri is null limit 100", null).use { cursor ->
            while (cursor.moveToNext()) {
                val bytes = android.util.Base64.decode(requireNotNull(secretBox.decrypt(cursor.getString(1))), android.util.Base64.NO_WRAP)
                val uri = MmsTransport(context).receiveNotification(bytes, cursor.getInt(2))
                check(writableDatabase.update("mms_notifications", ContentValues().apply {
                    put("provider_uri", uri.toString()); put("payload", "")
                }, "id = ?", arrayOf(cursor.getString(0))) == 1)
            }
        }
        pending().isEmpty() && readableDatabase.rawQuery("select 1 from mms_notifications where provider_uri is null limit 1", null).use { !it.moveToFirst() }
    }

    companion object {
        private val LOCK = Any()
        fun schedule(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork("incoming-sms-recovery", ExistingWorkPolicy.APPEND_OR_REPLACE,
                OneTimeWorkRequestBuilder<IncomingSmsRecoveryWorker>()
                    .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 10, TimeUnit.SECONDS).build())
        }
    }
}

interface IncomingSmsProvider {
    fun find(sms: MultipartSmsAssembler.Assembled): Uri?
    fun insert(sms: MultipartSmsAssembler.Assembled): Uri?
}

class AndroidIncomingSmsProvider(private val context: Context) : IncomingSmsProvider {
    override fun find(sms: MultipartSmsAssembler.Assembled): Uri? = context.contentResolver.query(
        Telephony.Sms.Inbox.CONTENT_URI, arrayOf("_id"), "address = ? and body = ? and date = ?",
        arrayOf(sms.sender, sms.text, sms.timestampMillis.toString()), null,
    )?.use { if (it.moveToFirst()) ContentUris.withAppendedId(Telephony.Sms.CONTENT_URI, it.getLong(0)) else null }

    override fun insert(sms: MultipartSmsAssembler.Assembled): Uri? = context.contentResolver.insert(
        Telephony.Sms.Inbox.CONTENT_URI, ContentValues().apply {
            put(Telephony.Sms.ADDRESS, sms.sender)
            put(Telephony.Sms.BODY, sms.text)
            put(Telephony.Sms.DATE, sms.timestampMillis)
            put(Telephony.Sms.READ, 0)
            put(Telephony.Sms.SEEN, 0)
            put(Telephony.Sms.TYPE, Telephony.Sms.MESSAGE_TYPE_INBOX)
        },
    )
}

class IncomingSmsRecoveryWorker(context: Context, parameters: WorkerParameters) : Worker(context, parameters) {
    override fun doWork(): Result = try {
        IncomingSmsJournal(applicationContext).use {
            if (it.recover(applicationContext)) Result.success() else Result.retry()
        }
    } catch (_: Exception) { Result.retry() }
}
