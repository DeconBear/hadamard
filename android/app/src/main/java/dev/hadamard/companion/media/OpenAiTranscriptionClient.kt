package dev.hadamard.companion.media

import dev.hadamard.companion.model.ProviderConfiguration
import dev.hadamard.companion.security.CredentialVault
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.File
import java.io.IOException
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

fun interface VoiceTranscriptionPort {
  suspend fun transcribe(file: File): String
}

class OpenAiTranscriptionClient(
  private val configuration: ProviderConfiguration,
  private val vault: CredentialVault,
  private val client: OkHttpClient = OkHttpClient(),
  private val transcriptionModel: String = "whisper-1",
) : VoiceTranscriptionPort {
  override suspend fun transcribe(file: File): String {
    require(file.isFile && file.length() in 1..MAX_AUDIO_BYTES) { "Voice note is missing or too large" }
    val credential = vault.get(configuration.apiKeyAlias)
      ?: error("Provider credential is not configured on this phone")
    val body = MultipartBody.Builder().setType(MultipartBody.FORM)
      .addFormDataPart("model", transcriptionModel)
      .addFormDataPart("file", file.name, file.asRequestBody("audio/mp4".toMediaType()))
      .addFormDataPart("response_format", "json")
      .build()
    val request = Request.Builder()
      .url(transcriptionUrl(configuration.endpoint))
      .header("Authorization", "Bearer $credential")
      .post(body)
      .build()
    val payload = execute(request)
    val root = JSONObject(payload)
    root.optJSONObject("error")?.let { error(it.optString("message", "Transcription failed")) }
    return root.getString("text").trim().take(MAX_TRANSCRIPT_CHARS)
  }

  private suspend fun execute(request: Request): String = suspendCancellableCoroutine { continuation ->
    val call = client.newCall(request)
    continuation.invokeOnCancellation { call.cancel() }
    call.enqueue(object : Callback {
      override fun onFailure(call: Call, e: IOException) {
        if (continuation.isActive) continuation.resumeWithException(e)
      }

      override fun onResponse(call: Call, response: Response) {
        response.use {
          val text = it.body?.string().orEmpty()
          if (!continuation.isActive) return
          if (!it.isSuccessful) continuation.resumeWithException(
            IOException("Transcription returned HTTP ${it.code}: ${text.take(500)}"),
          ) else continuation.resume(text)
        }
      }
    })
  }

  private fun transcriptionUrl(endpoint: String): String {
    val base = endpoint.trimEnd('/').removeSuffix("/chat/completions")
    return "$base/audio/transcriptions"
  }

  companion object {
    private const val MAX_AUDIO_BYTES = 32L * 1_048_576
    private const val MAX_TRANSCRIPT_CHARS = 500_000
  }
}
