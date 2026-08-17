package dev.hadamard.companion

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.espresso.Espresso.pressBack
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class MobileUiInstrumentedTest {
  @get:Rule
  val compose = createAndroidComposeRule<MainActivity>()

  @Test
  fun homeExposesIndependentPhoneAndComputerEntrypointsAfterRecreation() {
    compose.onNodeWithText("This Phone").assertIsDisplayed()
    compose.onNodeWithText("Paired Computer").assertIsDisplayed()
    compose.activityRule.scenario.recreate()
    compose.onNodeWithTag("home-screen").assertIsDisplayed()
    compose.onNodeWithText("This Phone").assertIsDisplayed()
  }

  @Test
  fun phoneAndSettingsKeepOfflineAndCredentialSemanticsVisible() {
    compose.onNodeWithTag("open-phone-action").performClick()
    compose.onNodeWithTag("phone-screen").assertIsDisplayed()
    compose.activityRule.scenario.recreate()
    compose.onNodeWithTag("transcript").assertIsDisplayed()
    pressBack()
    compose.onNodeWithTag("home-screen").assertIsDisplayed()
    compose.onNodeWithTag("home-screen").performScrollToNode(hasTestTag("open-settings"))
    compose.onNodeWithTag("open-settings").performClick()
    compose.onNodeWithText("Configure the provider manually, or import one from the desktop app by scanning its QR code.").assertIsDisplayed()
    compose.onNodeWithTag("scan-provider-qr").assertIsDisplayed()
    compose.onNodeWithTag("select-saf-workspace").assertIsDisplayed()
    compose.onNodeWithText("The Agent can access only the selected document tree. Absolute paths and ungranted folders remain unavailable.").assertIsDisplayed()
  }

  @Test
  fun transfersExposeInboxConfirmationAndVisibleAudioControls() {
    compose.onNodeWithTag("open-transfers-action").performClick()
    compose.onNodeWithTag("transfers-screen").assertIsDisplayed()
    compose.onNodeWithText("Downloads remain app-private until you explicitly commit them to the selected workspace.").assertIsDisplayed()
    compose.onNodeWithText("Enable system audio").assertIsDisplayed()
    compose.onNodeWithTag("system-audio-flag").assertIsDisplayed()
    pressBack()
    compose.onNodeWithTag("open-phone-action").performClick()
    compose.onNodeWithTag("voice-note-controls").assertIsDisplayed()
    compose.onNodeWithTag("record-voice-note").assertIsDisplayed()
  }
}
