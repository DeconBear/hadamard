plugins {
  id("com.android.application")
  id("org.jetbrains.kotlin.android")
}

android {
  namespace = "dev.hadamard.companion"
  compileSdk = 34

  defaultConfig {
    applicationId = "dev.hadamard.companion"
    minSdk = 26
    targetSdk = 34
    versionCode = 1
    versionName = "0.1.0"
    testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    vectorDrawables.useSupportLibrary = true
  }

  buildTypes {
    release {
      isMinifyEnabled = true
      proguardFiles(
        getDefaultProguardFile("proguard-android-optimize.txt"),
        "proguard-rules.pro",
      )
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions.jvmTarget = "17"

  buildFeatures {
    compose = true
    buildConfig = true
  }
  composeOptions.kotlinCompilerExtensionVersion = "1.5.14"
  packaging.resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"

  testOptions {
    unitTests.isIncludeAndroidResources = true
  }
}

dependencies {
  val composeBom = platform("androidx.compose:compose-bom:2024.06.00")
  implementation(composeBom)
  androidTestImplementation(composeBom)

  implementation("androidx.core:core-ktx:1.13.1")
  implementation("androidx.activity:activity-compose:1.9.1")
  implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.4")
  implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.4")
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.ui:ui-tooling-preview")
  implementation("androidx.compose.material3:material3")
  implementation("androidx.work:work-runtime-ktx:2.9.1")
  implementation("androidx.webkit:webkit:1.11.0")
  implementation("androidx.documentfile:documentfile:1.0.1")
  implementation("org.jetbrains.kotlinx:kotlinx-coroutines-play-services:1.8.1")
  implementation("com.squareup.okhttp3:okhttp:4.12.0")
  implementation("com.google.mlkit:text-recognition:16.0.1")
  implementation("com.tom-roush:pdfbox-android:2.0.27.0")
  implementation("com.journeyapps:zxing-android-embedded:4.3.0")
  implementation("net.i2p.crypto:eddsa:0.3.0")

  testImplementation("junit:junit:4.13.2")
  testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
  testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
  testImplementation("org.json:json:20240303")

  androidTestImplementation("androidx.test.ext:junit:1.2.1")
  androidTestImplementation("androidx.test:runner:1.6.1")
  androidTestImplementation("androidx.test:rules:1.6.1")
  androidTestImplementation("androidx.test.espresso:espresso-core:3.6.1")
  androidTestImplementation("androidx.compose.ui:ui-test-junit4")
  debugImplementation("androidx.compose.ui:ui-tooling")
  debugImplementation("androidx.compose.ui:ui-test-manifest")
}
