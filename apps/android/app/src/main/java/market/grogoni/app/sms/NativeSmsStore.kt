package market.grogoni.app.sms

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

class NativeSmsStore(context: Context) : SQLiteOpenHelper(context, "grogoni-native-sms.db", null, 3) {
    private val secretBox = AndroidSecretBox()

    override fun onConfigure(db: SQLiteDatabase) {
        super.onConfigure(db)
        db.setForeignKeyConstraintsEnabled(true)
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            create table inbound_events (
              event_id text primary key,
              business_id text not null,
              external_message_id text not null,
              sender_e164 text not null,
              body text not null,
              occurred_at text not null,
              synced integer not null default 0
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            create table executed_commands (
              command_id text primary key,
              state text not null,
              result_code text,
              local_message_uri text,
              updated_at integer not null
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            create table pending_results (
              command_id text primary key,
              status text not null,
              result_code text not null,
              carrier_reference text
            )
            """.trimIndent(),
        )
        db.execSQL(
            """
            create table segment_results (
              command_id text not null,
              kind text not null,
              segment_index integer not null,
              segment_count integer not null,
              result_code text not null,
              primary key (command_id, kind, segment_index)
            )
            """.trimIndent(),
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) encryptLegacySmsFields(db)
        if (oldVersion < 3) db.execSQL("alter table executed_commands add column local_message_uri text")
    }

    fun enqueueInbound(event: LocalInboundSms): Boolean {
        val values = ContentValues().apply {
            put("event_id", event.eventId)
            put("business_id", event.businessId)
            put("external_message_id", event.externalMessageId)
            put("sender_e164", secretBox.encrypt(event.senderE164))
            put("body", secretBox.encrypt(event.text))
            put("occurred_at", event.occurredAt)
            put("synced", 0)
        }
        return writableDatabase.insertWithOnConflict(
            "inbound_events", null, values, SQLiteDatabase.CONFLICT_IGNORE,
        ) != -1L
    }

    fun unsyncedInbound(limit: Int = 50): List<LocalInboundSms> {
        val records = mutableListOf<LocalInboundSms>()
        readableDatabase.query(
            "inbound_events",
            arrayOf(
                "event_id", "business_id", "external_message_id", "sender_e164", "body",
                "occurred_at",
            ),
            "synced = 0",
            null,
            null,
            null,
            "occurred_at asc",
            limit.coerceIn(1, 50).toString(),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                records += LocalInboundSms(
                    cursor.getString(0), cursor.getString(1), cursor.getString(2),
                    requireNotNull(secretBox.decrypt(cursor.getString(3))) { "Unreadable SMS sender." },
                    requireNotNull(secretBox.decrypt(cursor.getString(4))) { "Unreadable SMS body." },
                    cursor.getString(5),
                )
            }
        }
        return records
    }

    fun markInboundSynced(eventId: String) {
        writableDatabase.update(
            "inbound_events",
            ContentValues().apply { put("synced", 1) },
            "event_id = ?",
            arrayOf(eventId),
        )
    }

    /**
     * Claims a command before SmsManager is invoked. A process death after this transaction is an
     * uncertain carrier state, so replay reports DELIVERY_UNKNOWN instead of charging twice.
     */
    fun claimCommand(commandId: String): Boolean {
        val values = ContentValues().apply {
            put("command_id", commandId)
            put("state", "claimed")
            put("updated_at", System.currentTimeMillis())
        }
        return writableDatabase.insertWithOnConflict(
            "executed_commands", null, values, SQLiteDatabase.CONFLICT_IGNORE,
        ) != -1L
    }

    fun commandState(commandId: String): String? = readableDatabase.query(
        "executed_commands",
        arrayOf("state"),
        "command_id = ?",
        arrayOf(commandId),
        null,
        null,
        null,
        "1",
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }

    fun markCommandExecutionStarted(commandId: String) {
        writableDatabase.update(
            "executed_commands",
            ContentValues().apply {
                put("state", "execution_started")
                put("updated_at", System.currentTimeMillis())
            },
            "command_id = ? and state = 'claimed'",
            arrayOf(commandId),
        )
    }

    fun saveProviderMessageUri(commandId: String, uri: String) {
        writableDatabase.update(
            "executed_commands",
            ContentValues().apply { put("local_message_uri", uri) },
            "command_id = ?",
            arrayOf(commandId),
        )
    }

    fun providerMessageUri(commandId: String): String? = readableDatabase.query(
        "executed_commands",
        arrayOf("local_message_uri"),
        "command_id = ?",
        arrayOf(commandId),
        null,
        null,
        null,
        "1",
    ).use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null }

    fun saveSegmentResult(
        commandId: String,
        kind: String,
        segmentIndex: Int,
        segmentCount: Int,
        code: NativeSmsErrorCode,
    ): Pair<Int, Boolean> {
        val values = ContentValues().apply {
            put("command_id", commandId)
            put("kind", kind)
            put("segment_index", segmentIndex)
            put("segment_count", segmentCount)
            put("result_code", code.name)
        }
        writableDatabase.insertWithOnConflict(
            "segment_results", null, values, SQLiteDatabase.CONFLICT_REPLACE,
        )
        return readableDatabase.rawQuery(
            "select count(*), max(case when result_code not in ('SMS_SENT', 'SMS_DELIVERED') then 1 else 0 end) from segment_results where command_id = ? and kind = ?",
            arrayOf(commandId, kind),
        ).use { cursor ->
            cursor.moveToFirst()
            cursor.getInt(0) to (cursor.getInt(1) == 1)
        }
    }

    fun markCommandTerminal(commandId: String, state: String, code: NativeSmsErrorCode) {
        writableDatabase.update(
            "executed_commands",
            ContentValues().apply {
                put("state", state)
                put("result_code", code.name)
                put("updated_at", System.currentTimeMillis())
            },
            "command_id = ?",
            arrayOf(commandId),
        )
    }

    fun enqueueResult(result: PendingSmsResult) {
        writableDatabase.insertWithOnConflict(
            "pending_results",
            null,
            ContentValues().apply {
                put("command_id", result.commandId)
                put("status", result.status)
                put("result_code", result.resultCode)
                put(
                    "carrier_reference",
                    result.carrierReference?.let(secretBox::encrypt),
                )
            },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    fun pendingResults(): List<PendingSmsResult> {
        val results = mutableListOf<PendingSmsResult>()
        readableDatabase.query(
            "pending_results", null, null, null, null, null, "rowid asc", "50",
        ).use { cursor ->
            while (cursor.moveToNext()) {
                results += PendingSmsResult(
                    cursor.getString(cursor.getColumnIndexOrThrow("command_id")),
                    cursor.getString(cursor.getColumnIndexOrThrow("status")),
                    cursor.getString(cursor.getColumnIndexOrThrow("result_code")),
                    cursor.getString(cursor.getColumnIndexOrThrow("carrier_reference"))
                        ?.let(secretBox::decrypt),
                )
            }
        }
        return results
    }

    fun deletePendingResult(commandId: String) {
        writableDatabase.delete("pending_results", "command_id = ?", arrayOf(commandId))
    }

    private fun encryptLegacySmsFields(db: SQLiteDatabase) {
        db.query(
            "inbound_events",
            arrayOf("event_id", "sender_e164", "body"),
            null,
            null,
            null,
            null,
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val sender = cursor.getString(1)
                val body = cursor.getString(2)
                if (!secretBox.isEncrypted(sender) || !secretBox.isEncrypted(body)) {
                    db.update(
                        "inbound_events",
                        ContentValues().apply {
                            put("sender_e164", secretBox.encrypt(sender))
                            put("body", secretBox.encrypt(body))
                        },
                        "event_id = ?",
                        arrayOf(cursor.getString(0)),
                    )
                }
            }
        }
        db.query(
            "pending_results",
            arrayOf("command_id", "carrier_reference"),
            "carrier_reference is not null",
            null,
            null,
            null,
            null,
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val reference = cursor.getString(1)
                if (!secretBox.isEncrypted(reference)) {
                    db.update(
                        "pending_results",
                        ContentValues().apply {
                            put("carrier_reference", secretBox.encrypt(reference))
                        },
                        "command_id = ?",
                        arrayOf(cursor.getString(0)),
                    )
                }
            }
        }
    }
}
