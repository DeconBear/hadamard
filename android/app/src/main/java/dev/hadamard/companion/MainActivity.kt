package dev.hadamard.companion

import android.os.Bundle
import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import dev.hadamard.companion.ui.HadamardMobileApp
import dev.hadamard.companion.ui.HadamardViewModel

class MainActivity : ComponentActivity() {
  private val viewModel by viewModels<HadamardViewModel>()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContent { HadamardMobileApp(viewModel) }
  }

  override fun onResume() {
    super.onResume()
    viewModel.enforceAudioPermission(
      checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED,
    )
  }
}
