# Hadamard Android Companion

The Android companion is a separate, capability-limited Hadamard runtime. It does not embed a shell, Termux, the desktop workspace, or desktop credentials.

## Runtime boundaries

- **This Phone** owns its provider configuration, encrypted credentials, sessions, artifacts, and workspace.
- **Paired Computer** uses Device Link v2 over certificate-pinned WSS. Remote sessions are cached read-only and must be explicitly copied before phone-side editing.
- The local Agent is a bounded ReAct loop over typed native tools. Every mutating or sensitive tool call passes through the mobile permission broker.
- The workspace is app-private by default. A user may grant exactly one document tree through Android's Storage Access Framework; arbitrary absolute paths are never accepted.
- Markdown, PDF/OCR, web reading, and simple page authoring have explicit input, page, pixel, memory, redirect, and output limits.
- Page preview disables JavaScript, file/content URL access, and native bridges, and serves generated content from an isolated HTTPS-like origin with a strict CSP.
- Local document tools and cached sessions work offline. Model reasoning requires the phone's configured endpoint. A paired computer must be reachable for remote actions.

## Build and verify

Use JDK 17 and an Android SDK with API 34:

```powershell
./gradlew.bat :app:testDebugUnitTest
./gradlew.bat :app:connectedDebugAndroidTest
./gradlew.bat :app:assembleDebug :app:assembleRelease
```

Instrumentation tests are intended to run on an API 34 device or emulator. They cover credential corruption, certificate pin changes, revoked SAF access, hostile PDF/HTML inputs, OCR limits, WebView isolation, UI recreation and navigation, offline network policy, and large append-only transcripts.

## Package layout

- `agent/`: provider adapter and bounded mobile Agent loop
- `capability/`: typed tools and permission broker contracts
- `data/`: sessions, checkpoints, and bounded artifact storage
- `devicelink/`: identity, signed pairing, LAN discovery, pinned WSS, and remote cache
- `document/`: Markdown, PDF, and on-device OCR tools
- `workspace/`: app-private and SAF-backed workspace ports
- `web/`: bounded HTTPS fetching and isolated page preview
- `background/`: visible, cancellable long-running work
- `ui/`: Compose screens and state orchestration

The desktop Hadamard SDK remains under `src/`; the bridge runtime under `src/parity/` is not a dependency of this app.
