package dev.hadamard.companion.devicelink

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import java.net.InetAddress

data class DiscoveredComputer(
  val deviceId: String,
  val name: String,
  val host: String,
  val port: Int,
  val certificateFingerprint: String,
)

class NsdDeviceDiscovery(private val context: Context) {
  private val manager = context.getSystemService(NsdManager::class.java)

  fun discover(): Flow<DiscoveredComputer> = callbackFlow {
    val listener = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(serviceType: String) = Unit
      override fun onDiscoveryStopped(serviceType: String) = Unit
      override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
        close(IllegalStateException("NSD discovery failed: $errorCode"))
      }
      override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
      override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit
      override fun onServiceFound(serviceInfo: NsdServiceInfo) {
        if (serviceInfo.serviceType != SERVICE_TYPE) return
        resolve(serviceInfo) { resolved -> resolved.toComputer()?.let { trySend(it) } }
      }
    }
    manager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
    awaitClose { runCatching { manager.stopServiceDiscovery(listener) } }
  }

  private fun resolve(serviceInfo: NsdServiceInfo, onResolved: (NsdServiceInfo) -> Unit) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      lateinit var callback: NsdManager.ServiceInfoCallback
      callback = object : NsdManager.ServiceInfoCallback {
        override fun onServiceUpdated(serviceInfo: NsdServiceInfo) {
          onResolved(serviceInfo)
          runCatching { manager.unregisterServiceInfoCallback(callback) }
        }

        override fun onServiceLost() = Unit
        override fun onServiceInfoCallbackRegistrationFailed(errorCode: Int) = Unit
        override fun onServiceInfoCallbackUnregistered() = Unit
      }
      manager.registerServiceInfoCallback(serviceInfo, context.mainExecutor, callback)
    } else {
      @Suppress("DEPRECATION")
      manager.resolveService(serviceInfo, object : NsdManager.ResolveListener {
        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) = Unit
        override fun onServiceResolved(resolved: NsdServiceInfo) = onResolved(resolved)
      })
    }
  }

  private fun NsdServiceInfo.toComputer(): DiscoveredComputer? {
    val attributes = attributes.mapValues { String(it.value, Charsets.UTF_8) }
    if (attributes["pv"] != "2") return null
    val id = attributes["id"] ?: return null
    val fingerprint = attributes["fp"]?.lowercase()?.replace(":", "") ?: return null
    if (!fingerprint.matches(Regex("[a-f0-9]{64}"))) return null
    val resolvedHost = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      hostAddresses.firstOrNull()
    } else {
      @Suppress("DEPRECATION")
      host
    } ?: return null
    if (!isPrivate(resolvedHost)) return null
    return DiscoveredComputer(
      deviceId = id,
      name = attributes["name"]?.let { java.net.URLDecoder.decode(it, Charsets.UTF_8.name()) } ?: serviceName,
      host = resolvedHost.hostAddress ?: return null,
      port = port,
      certificateFingerprint = fingerprint,
    )
  }

  private fun isPrivate(address: InetAddress) =
    address.isLoopbackAddress || address.isLinkLocalAddress || address.isSiteLocalAddress

  companion object {
    const val SERVICE_TYPE = "_hadamard._tcp."
  }
}
