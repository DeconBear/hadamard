package dev.hadamard.companion.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

private val LightColorScheme = lightColorScheme(
  primary = Color(0xFF3D5A80),
  onPrimary = Color(0xFFFFFFFF),
  primaryContainer = Color(0xFFDCE6F2),
  onPrimaryContainer = Color(0xFF1E3252),
  secondary = Color(0xFF6C7A89),
  background = Color(0xFFF7F8FA),
  onBackground = Color(0xFF182230),
  surface = Color(0xFFFFFFFF),
  onSurfaceVariant = Color(0xFF5B6672),
  tertiaryContainer = Color(0xFFFBEED3),
  onTertiaryContainer = Color(0xFF4A3208),
  errorContainer = Color(0xFFF8DEDC),
  onErrorContainer = Color(0xFF5C1F1A),
  outline = Color(0xFFC9D2DC),
)

private val DarkColorScheme = darkColorScheme(
  primary = Color(0xFFA6C0E0),
  onPrimary = Color(0xFF10233E),
  primaryContainer = Color(0xFF2E4260),
  onPrimaryContainer = Color(0xFFDCE6F2),
  background = Color(0xFF10151C),
  onBackground = Color(0xFFE2E8F0),
  surface = Color(0xFF1A212B),
  onSurfaceVariant = Color(0xFF9AA6B2),
  tertiaryContainer = Color(0xFF4A3A17),
  onTertiaryContainer = Color(0xFFF5D998),
  errorContainer = Color(0xFF5A2E2A),
  onErrorContainer = Color(0xFFF5CFC9),
  outline = Color(0xFF3A4654),
)

@Immutable
data class ExtendedColors(
  val hero: Color,
  val onHero: Color,
  val heroBadge: Color,
  val onHeroBadge: Color,
)

private val LightExtendedColors = ExtendedColors(
  hero = Color(0xFF22304A),
  onHero = Color(0xFFF2F6FC),
  heroBadge = Color(0xFF34507A),
  onHeroBadge = Color(0xFFFFFFFF),
)

private val DarkExtendedColors = ExtendedColors(
  hero = Color(0xFF263A5C),
  onHero = Color(0xFFEAF1FA),
  heroBadge = Color(0xFF3D5A80),
  onHeroBadge = Color(0xFFFFFFFF),
)

val LocalExtendedColors = staticCompositionLocalOf { LightExtendedColors }

@Composable
fun HadamardTheme(content: @Composable () -> Unit) {
  val dark = isSystemInDarkTheme()
  CompositionLocalProvider(LocalExtendedColors provides if (dark) DarkExtendedColors else LightExtendedColors) {
    MaterialTheme(
      colorScheme = if (dark) DarkColorScheme else LightColorScheme,
      content = content,
    )
  }
}
