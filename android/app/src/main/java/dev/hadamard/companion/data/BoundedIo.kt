package dev.hadamard.companion.data

import java.io.ByteArrayOutputStream
import java.io.InputStream

fun InputStream.readWithOverflowByte(maxBytes: Int): ByteArray {
  require(maxBytes >= 0 && maxBytes < Int.MAX_VALUE) { "Invalid read limit" }
  val output = ByteArrayOutputStream(minOf(maxBytes + 1, BUFFER_SIZE))
  val buffer = ByteArray(BUFFER_SIZE)
  var remaining = maxBytes + 1
  while (remaining > 0) {
    val count = read(buffer, 0, minOf(buffer.size, remaining))
    if (count < 0) break
    if (count == 0) continue
    output.write(buffer, 0, count)
    remaining -= count
  }
  return output.toByteArray()
}

private const val BUFFER_SIZE = 8 * 1024
