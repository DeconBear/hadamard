package dev.hadamard.companion.media

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.os.Build
import androidx.annotation.RequiresApi
import java.io.File
import java.io.FileOutputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

enum class AudioCaptureKind { VOICE_NOTE, LIVE_MICROPHONE, SYSTEM_PLAYBACK }
enum class AudioCaptureStatus { IDLE, RECORDING, STOPPING }

data class AudioCaptureState(
  val kind: AudioCaptureKind? = null,
  val status: AudioCaptureStatus = AudioCaptureStatus.IDLE,
  val startedAt: Long? = null,
  val visibleLabel: String = "Microphone is off",
)

class VoiceNoteRecorder(context: Context) {
  private val appContext = context.applicationContext
  private val directory = File(context.filesDir, "voice-notes").apply { mkdirs() }
  private var recorder: MediaRecorder? = null
  private var output: File? = null

  var state: AudioCaptureState = AudioCaptureState()
    private set

  @Synchronized
  fun start(): AudioCaptureState {
    check(recorder == null) { "A voice note is already recording" }
    val target = File(directory, "voice-${UUID.randomUUID()}.m4a")
    val next = if (Build.VERSION.SDK_INT >= 31) MediaRecorder(appContext) else @Suppress("DEPRECATION") MediaRecorder()
    next.setAudioSource(MediaRecorder.AudioSource.MIC)
    next.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
    next.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
    next.setAudioEncodingBitRate(96_000)
    next.setAudioSamplingRate(44_100)
    next.setOutputFile(target.absolutePath)
    next.prepare()
    next.start()
    recorder = next
    output = target
    state = AudioCaptureState(
      AudioCaptureKind.VOICE_NOTE,
      AudioCaptureStatus.RECORDING,
      System.currentTimeMillis(),
      "Recording microphone · tap Stop to finish",
    )
    return state
  }

  @Synchronized
  fun stop(): File {
    val active = recorder ?: error("No voice note is recording")
    state = state.copy(status = AudioCaptureStatus.STOPPING, visibleLabel = "Stopping microphone")
    try {
      active.stop()
    } finally {
      active.release()
      recorder = null
    }
    val result = checkNotNull(output)
    output = null
    state = AudioCaptureState()
    require(result.isFile && result.length() > 0) { "Voice note contains no audio" }
    return result
  }

  @Synchronized
  fun cancel() {
    recorder?.runCatching { stop() }
    recorder?.release()
    recorder = null
    output?.delete()
    output = null
    state = AudioCaptureState()
  }
}

/** Emits PCM frames for a WebRTC/media adapter; it never receives an Agent tool call directly. */
class LiveMicrophoneSource {
  private var capture: PcmCapture? = null

  @SuppressLint("MissingPermission")
  fun start(onFrame: (ByteArray) -> Unit) {
    check(capture == null) { "Live microphone is already active" }
    val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING).coerceAtLeast(FRAME_BYTES * 2)
    val record = AudioRecord(
      MediaRecorder.AudioSource.VOICE_COMMUNICATION,
      SAMPLE_RATE,
      CHANNEL,
      ENCODING,
      minimum,
    )
    check(record.state == AudioRecord.STATE_INITIALIZED) { "Microphone capture is unavailable" }
    capture = PcmCapture(record, minimum, onFrame).also(PcmCapture::start)
  }

  fun stop() {
    capture?.stop()
    capture = null
  }

  companion object {
    private const val SAMPLE_RATE = 48_000
    private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
    private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
    private const val FRAME_BYTES = 960 * 2
  }
}

class SystemAudioFeatureFlag(context: Context) {
  private val preferences = context.getSharedPreferences("hadamard_audio_features", Context.MODE_PRIVATE)
  fun enabled(): Boolean = preferences.getBoolean(KEY, false)
  fun setEnabled(value: Boolean) = preferences.edit().putBoolean(KEY, value).apply()

  companion object { private const val KEY = "system_playback_capture" }
}

/** Android 10+ playback capture. The caller must first obtain a visible MediaProjection grant. */
class SystemPlaybackCapture(
  private val featureFlag: SystemAudioFeatureFlag,
) {
  private var capture: PcmCapture? = null

  @SuppressLint("MissingPermission")
  fun start(projection: MediaProjection, onFrame: (ByteArray) -> Unit) {
    if (Build.VERSION.SDK_INT < 29) error("System playback capture requires Android 10 or newer")
    require(featureFlag.enabled()) { "System audio capture is disabled in settings" }
    check(capture == null) { "System audio capture is already active" }
    startApi29(projection, onFrame)
  }

  @RequiresApi(29)
  @SuppressLint("MissingPermission")
  private fun startApi29(projection: MediaProjection, onFrame: (ByteArray) -> Unit) {
    val format = AudioFormat.Builder()
      .setSampleRate(48_000)
      .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
      .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
      .build()
    val policy = AudioPlaybackCaptureConfiguration.Builder(projection)
      .addMatchingUsage(AudioAttributes.USAGE_MEDIA)
      .addMatchingUsage(AudioAttributes.USAGE_GAME)
      .build()
    val minimum = AudioRecord.getMinBufferSize(48_000, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
      .coerceAtLeast(8192)
    val record = AudioRecord.Builder()
      .setAudioFormat(format)
      .setAudioPlaybackCaptureConfig(policy)
      .setBufferSizeInBytes(minimum)
      .build()
    check(record.state == AudioRecord.STATE_INITIALIZED) { "Playback capture is unavailable or blocked by the source app" }
    capture = PcmCapture(record, minimum, onFrame).also(PcmCapture::start)
  }

  fun stop() {
    capture?.stop()
    capture = null
  }
}

class PcmFileSink(private val file: File) {
  private val output = FileOutputStream(file)
  @Synchronized fun accept(frame: ByteArray) = output.write(frame)
  @Synchronized fun close(): File { output.close(); return file }
}

private class PcmCapture(
  private val record: AudioRecord,
  private val bufferSize: Int,
  private val onFrame: (ByteArray) -> Unit,
) {
  private val active = AtomicBoolean(false)
  private var thread: Thread? = null

  fun start() {
    active.set(true)
    record.startRecording()
    thread = Thread({
      val buffer = ByteArray(bufferSize)
      while (active.get()) {
        val count = record.read(buffer, 0, buffer.size)
        if (count > 0) onFrame(buffer.copyOf(count))
      }
    }, "hadamard-audio-capture").apply { start() }
  }

  fun stop() {
    active.set(false)
    runCatching { record.stop() }
    thread?.join(1500)
    record.release()
    thread = null
  }
}
