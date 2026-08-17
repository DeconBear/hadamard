package dev.hadamard.companion.ui

import android.app.Application
import android.content.Context
import android.content.res.Configuration
import java.util.Locale

/**
 * Manual locale override (no appcompat). "" means follow the system locale;
 * otherwise a BCP-47 tag such as "en" or "zh-CN" is applied everywhere.
 */
object AppLocale {
  private const val PREFERENCES = "hadamard_ui_prefs"
  private const val KEY_LANGUAGE_TAG = "language_tag"

  private var cachedStringsTag: String? = null
  private var cachedStringsContext: Context? = null

  fun currentTag(context: Context): String =
    context.applicationContext
      .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .getString(KEY_LANGUAGE_TAG, "") ?: ""

  fun setTag(context: Context, tag: String) {
    context.applicationContext
      .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
      .edit().putString(KEY_LANGUAGE_TAG, tag).apply()
  }

  fun wrap(base: Context): Context {
    val tag = currentTag(base)
    if (tag.isBlank()) return base
    val locale = Locale.forLanguageTag(tag)
    Locale.setDefault(locale)
    val configuration = Configuration(base.resources.configuration)
    configuration.setLocale(locale)
    configuration.setLayoutDirection(locale)
    return base.createConfigurationContext(configuration)
  }

  /** Localized context for non-UI code (e.g. ViewModel status strings); recreated lazily per tag change. */
  @Synchronized
  fun strings(app: Application): Context {
    val tag = currentTag(app)
    val cached = cachedStringsContext
    if (cached != null && cachedStringsTag == tag) return cached
    val context = if (tag.isBlank()) app else wrap(app)
    cachedStringsTag = tag
    cachedStringsContext = context
    return context
  }
}
