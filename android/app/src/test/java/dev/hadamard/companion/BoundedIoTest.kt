package dev.hadamard.companion

import dev.hadamard.companion.data.readWithOverflowByte
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.ByteArrayInputStream

class BoundedIoTest {
  @Test
  fun readsSmallInputAndOnlyOneOverflowByte() {
    assertArrayEquals(byteArrayOf(1, 2), ByteArrayInputStream(byteArrayOf(1, 2)).readWithOverflowByte(8))
    assertEquals(4, ByteArrayInputStream(ByteArray(20)).readWithOverflowByte(3).size)
  }
}
