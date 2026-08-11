package dev.hadamard.companion.document

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.tasks.await

class OcrService {
  private val recognizer by lazy { TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS) }

  suspend fun recognize(bitmap: Bitmap): String {
    enforceBitmapLimit(bitmap.width, bitmap.height)
    return recognizer.process(InputImage.fromBitmap(bitmap, 0)).await().text
  }

  suspend fun recognize(bytes: ByteArray): String {
    require(bytes.size <= MAX_IMAGE_BYTES) { "Image exceeds the OCR file limit" }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    enforceBitmapLimit(bounds.outWidth, bounds.outHeight)
    val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
      ?: error("Image could not be decoded")
    return try {
      recognize(bitmap)
    } finally {
      bitmap.recycle()
    }
  }

  fun enforceBitmapLimit(width: Int, height: Int) {
    require(width > 0 && height > 0) { "Image dimensions are invalid" }
    val pixels = width.toLong() * height.toLong()
    require(pixels <= MAX_PIXELS) { "Image exceeds the OCR pixel limit" }
    require(pixels * 4 <= MAX_BITMAP_BYTES) { "Image exceeds the OCR memory limit" }
  }

  companion object {
    const val MAX_IMAGE_BYTES = 16 * 1_048_576
    const val MAX_PIXELS = 12_000_000L
    const val MAX_BITMAP_BYTES = 48L * 1_048_576
  }
}
