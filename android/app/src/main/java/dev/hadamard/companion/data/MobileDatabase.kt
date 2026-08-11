package dev.hadamard.companion.data

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import dev.hadamard.companion.model.AgentCheckpoint
import dev.hadamard.companion.model.MessageRole
import dev.hadamard.companion.model.SessionMessage
import dev.hadamard.companion.model.SessionOrigin
import dev.hadamard.companion.model.SessionRecord

class MobileDatabase(context: Context) : SQLiteOpenHelper(context, DATABASE_NAME, null, VERSION) {
  override fun onCreate(database: SQLiteDatabase) {
    database.execSQL(
      """CREATE TABLE sessions(
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        read_only INTEGER NOT NULL,
        origin_device_id TEXT,
        origin_session_id TEXT,
        origin_revision INTEGER
      )""",
    )
    database.execSQL(
      """CREATE TABLE messages(
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_call_id TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY(session_id, sequence),
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )""",
    )
    database.execSQL(
      """CREATE TABLE checkpoints(
        session_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        next_iteration INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )""",
    )
    database.execSQL("CREATE INDEX messages_by_session ON messages(session_id, sequence)")
  }

  override fun onConfigure(database: SQLiteDatabase) {
    database.setForeignKeyConstraintsEnabled(true)
    database.enableWriteAheadLogging()
  }

  override fun onUpgrade(database: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit

  fun upsertSession(session: SessionRecord) {
    writableDatabase.insertWithOnConflict(
      "sessions",
      null,
      ContentValues().apply {
        put("id", session.id)
        put("title", session.title)
        put("created_at", session.createdAt)
        put("updated_at", session.updatedAt)
        put("revision", session.revision)
        put("read_only", if (session.readOnly) 1 else 0)
        put("origin_device_id", session.origin?.deviceId)
        put("origin_session_id", session.origin?.sessionId)
        put("origin_revision", session.origin?.revision)
      },
      SQLiteDatabase.CONFLICT_REPLACE,
    )
  }

  fun nextSequence(sessionId: String): Long = readableDatabase.rawQuery(
    "SELECT COALESCE(MAX(sequence), -1) + 1 FROM messages WHERE session_id = ?",
    arrayOf(sessionId),
  ).use { cursor ->
    check(cursor.moveToFirst())
    cursor.getLong(0)
  }

  fun session(sessionId: String): SessionRecord? = listSessions().firstOrNull { it.id == sessionId }

  fun copySession(sourceSessionId: String, target: SessionRecord) {
    val source = session(sourceSessionId) ?: error("Source session does not exist")
    require(source.readOnly && source.origin != null) { "Only a remote cache can be copied into a local session" }
    require(!target.readOnly && target.origin == source.origin) { "Local copy must preserve origin metadata" }
    writableDatabase.beginTransaction()
    try {
      upsertSession(target)
      messages(sourceSessionId).forEach { message ->
        writableDatabase.insertOrThrow(
          "messages",
          null,
          messageValues(message.copy(sessionId = target.id)),
        )
      }
      writableDatabase.setTransactionSuccessful()
    } finally {
      writableDatabase.endTransaction()
    }
  }

  fun listSessions(): List<SessionRecord> = readableDatabase.query(
    "sessions",
    null,
    null,
    null,
    null,
    null,
    "updated_at DESC",
  ).use { cursor ->
    buildList {
      while (cursor.moveToNext()) {
        val originDevice = cursor.stringOrNull("origin_device_id")
        add(
          SessionRecord(
            id = cursor.getString(cursor.getColumnIndexOrThrow("id")),
            title = cursor.getString(cursor.getColumnIndexOrThrow("title")),
            createdAt = cursor.getLong(cursor.getColumnIndexOrThrow("created_at")),
            updatedAt = cursor.getLong(cursor.getColumnIndexOrThrow("updated_at")),
            revision = cursor.getLong(cursor.getColumnIndexOrThrow("revision")),
            readOnly = cursor.getInt(cursor.getColumnIndexOrThrow("read_only")) == 1,
            origin = originDevice?.let {
              SessionOrigin(
                deviceId = it,
                sessionId = cursor.getString(cursor.getColumnIndexOrThrow("origin_session_id")),
                revision = cursor.getLong(cursor.getColumnIndexOrThrow("origin_revision")),
              )
            },
          ),
        )
      }
    }
  }

  fun appendMessage(message: SessionMessage) {
    check(!isReadOnly(message.sessionId)) { "Remote cache is read-only; copy the session before editing" }
    writableDatabase.beginTransaction()
    try {
      writableDatabase.insertOrThrow("messages", null, messageValues(message))
      writableDatabase.execSQL(
        "UPDATE sessions SET revision = revision + 1, updated_at = ? WHERE id = ?",
        arrayOf(message.createdAt, message.sessionId),
      )
      writableDatabase.setTransactionSuccessful()
    } finally {
      writableDatabase.endTransaction()
    }
  }

  fun importMessages(session: SessionRecord, messages: List<SessionMessage>) {
    require(session.readOnly || session.origin != null) { "Imported session must preserve its origin" }
    writableDatabase.beginTransaction()
    try {
      upsertSession(session)
      messages.forEach {
        writableDatabase.insertWithOnConflict(
          "messages",
          null,
          messageValues(it),
          SQLiteDatabase.CONFLICT_IGNORE,
        )
      }
      writableDatabase.setTransactionSuccessful()
    } finally {
      writableDatabase.endTransaction()
    }
  }

  fun messages(sessionId: String, afterSequence: Long = -1): List<SessionMessage> =
    readableDatabase.query(
      "messages",
      null,
      "session_id = ? AND sequence > ?",
      arrayOf(sessionId, afterSequence.toString()),
      null,
      null,
      "sequence ASC",
    ).use { cursor ->
      buildList {
        while (cursor.moveToNext()) {
          add(
            SessionMessage(
              sessionId = sessionId,
              sequence = cursor.getLong(cursor.getColumnIndexOrThrow("sequence")),
              role = MessageRole.valueOf(cursor.getString(cursor.getColumnIndexOrThrow("role"))),
              content = cursor.getString(cursor.getColumnIndexOrThrow("content")),
              toolCallId = cursor.stringOrNull("tool_call_id"),
              createdAt = cursor.getLong(cursor.getColumnIndexOrThrow("created_at")),
            ),
          )
        }
      }
    }

  fun saveCheckpoint(checkpoint: AgentCheckpoint) {
    writableDatabase.insertWithOnConflict(
      "checkpoints",
      null,
      ContentValues().apply {
        put("session_id", checkpoint.sessionId)
        put("generation", checkpoint.generation)
        put("next_iteration", checkpoint.nextIteration)
        put("state_json", checkpoint.stateJson)
        put("updated_at", checkpoint.updatedAt)
      },
      SQLiteDatabase.CONFLICT_REPLACE,
    )
  }

  fun checkpoint(sessionId: String): AgentCheckpoint? = readableDatabase.query(
    "checkpoints",
    null,
    "session_id = ?",
    arrayOf(sessionId),
    null,
    null,
    null,
  ).use { cursor ->
    if (!cursor.moveToFirst()) return@use null
    AgentCheckpoint(
      sessionId = sessionId,
      generation = cursor.getLong(cursor.getColumnIndexOrThrow("generation")),
      nextIteration = cursor.getInt(cursor.getColumnIndexOrThrow("next_iteration")),
      stateJson = cursor.getString(cursor.getColumnIndexOrThrow("state_json")),
      updatedAt = cursor.getLong(cursor.getColumnIndexOrThrow("updated_at")),
    )
  }

  fun clearCheckpoint(sessionId: String) {
    writableDatabase.delete("checkpoints", "session_id = ?", arrayOf(sessionId))
  }

  private fun isReadOnly(sessionId: String): Boolean = readableDatabase.rawQuery(
    "SELECT read_only FROM sessions WHERE id = ?",
    arrayOf(sessionId),
  ).use { cursor -> cursor.moveToFirst() && cursor.getInt(0) == 1 }

  private fun messageValues(message: SessionMessage) = ContentValues().apply {
    put("session_id", message.sessionId)
    put("sequence", message.sequence)
    put("role", message.role.name)
    put("content", message.content)
    put("tool_call_id", message.toolCallId)
    put("created_at", message.createdAt)
  }

  private fun android.database.Cursor.stringOrNull(column: String): String? {
    val index = getColumnIndexOrThrow(column)
    return if (isNull(index)) null else getString(index)
  }

  companion object {
    private const val DATABASE_NAME = "hadamard-mobile.db"
    private const val VERSION = 1
  }
}
