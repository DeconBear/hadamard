package dev.hadamard.companion

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.hadamard.companion.agent.MobileAgentLoop
import dev.hadamard.companion.agent.ModelProvider
import dev.hadamard.companion.agent.ProviderMessage
import dev.hadamard.companion.capability.MobileCapabilityRegistry
import dev.hadamard.companion.capability.MobilePermissionBroker
import dev.hadamard.companion.data.MobileDatabase
import dev.hadamard.companion.model.AgentToolCall
import dev.hadamard.companion.model.AgentTurn
import dev.hadamard.companion.model.MessageRole
import dev.hadamard.companion.model.SessionMessage
import dev.hadamard.companion.model.SessionOrigin
import dev.hadamard.companion.model.SessionRecord
import dev.hadamard.companion.workspace.AppPrivateWorkspace
import dev.hadamard.companion.workspace.WorkspaceTools
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class MobileRuntimeInstrumentedTest {
  private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

  @Test
  fun localAgentPairsEveryToolCallAndClearsCheckpointOnCompletion() = runBlocking {
    val database = MobileDatabase(context)
    val session = localSession()
    database.upsertSession(session)
    var turn = 0
    val provider = ModelProvider { _: List<ProviderMessage>, _ ->
      if (turn++ == 0) AgentTurn(
        "",
        listOf(
          AgentToolCall(
            "call-1",
            "WorkspaceCreate",
            "{\"displayName\":\"agent-${session.id}.md\",\"mediaType\":\"text/markdown\",\"content\":\"# Mobile\"}",
          ),
        ),
      ) else AgentTurn("Created the document.", emptyList())
    }
    val registry = MobileCapabilityRegistry(
      WorkspaceTools(AppPrivateWorkspace(context)).all(),
      MobilePermissionBroker { _, _, _ -> true },
    )
    val result = MobileAgentLoop(database, provider, registry).run(session.id, "Create a note")

    assertEquals(1, result.toolCalls)
    val messages = database.messages(session.id)
    assertEquals(listOf(MessageRole.USER, MessageRole.ASSISTANT, MessageRole.TOOL, MessageRole.ASSISTANT), messages.map { it.role })
    assertEquals("call-1", messages.first { it.role == MessageRole.TOOL }.toolCallId)
    assertNull(database.checkpoint(session.id))
  }

  @Test
  fun largeTranscriptCompactsProviderWindowWithoutRewritingDatabase() = runBlocking {
    val database = MobileDatabase(context)
    val session = localSession()
    database.upsertSession(session)
    repeat(140) { index ->
      database.appendMessage(
        SessionMessage(session.id, index.toLong(), MessageRole.USER, "message-$index", null, System.currentTimeMillis()),
      )
    }
    var received = emptyList<ProviderMessage>()
    val provider = ModelProvider { messages, _ -> received = messages; AgentTurn("done", emptyList()) }
    val registry = MobileCapabilityRegistry(emptyList(), MobilePermissionBroker { _, _, _ -> true })
    MobileAgentLoop(database, provider, registry).run(session.id, "final")

    assertTrue(received.size <= 65)
    assertEquals("system", received.first().role)
    assertEquals(142, database.messages(session.id).size)
  }

  @Test
  fun remoteCacheIsReadOnlyUntilExplicitIndependentCopy() {
    val database = MobileDatabase(context)
    val origin = SessionOrigin("device-remote", "source", 7)
    val cache = localSession().copy(readOnly = true, origin = origin)
    database.importMessages(
      cache,
      listOf(SessionMessage(cache.id, 1, MessageRole.USER, "remote", null, System.currentTimeMillis())),
    )
    assertThrows(IllegalStateException::class.java) {
      database.appendMessage(SessionMessage(cache.id, 2, MessageRole.USER, "write", null, System.currentTimeMillis()))
    }
    val target = localSession().copy(origin = origin)
    database.copySession(cache.id, target)
    assertFalse(database.session(target.id)!!.readOnly)
    assertEquals(origin, database.session(target.id)!!.origin)
  }

  private fun localSession(): SessionRecord {
    val now = System.currentTimeMillis()
    return SessionRecord(UUID.randomUUID().toString(), "test", now, now, 0)
  }
}
