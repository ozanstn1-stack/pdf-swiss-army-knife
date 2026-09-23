# Android build

The Android app is the same code base as the desktop app:

* the entire processing core (`pdfcore`) compiles unchanged for Android,
* all screens, tools, settings and the optional AI assistant are identical,
* pdfium and Tesseract ship **inside the APK**, so every operation works offline.

The only differences are in how the operating system lets an app touch files
(see [File handling](#file-handling)).

---

## Requirements

| Tool | Version | Notes |
| --- | --- | --- |
| JDK | 17 or newer | `JAVA_HOME` must point at it |
| Android SDK | platform 36, build-tools 36 | `ANDROID_HOME` / `ANDROID_SDK_ROOT` |
| Android NDK | 27.x (e.g. `27.3.13750724`) | `sdkmanager "ndk;27.3.13750724"` |
| Rust | 1.82+ with the Android targets | `rustup target add aarch64-linux-android armv7-linux-androideabi x86_64-linux-android` |

The Gradle project lives in `src-tauri/gen/android` and is part of the
repository (only build outputs are ignored), so no `tauri android init` is
needed after a clone.

## Build

```powershell
npm install
npm run android:engines      # pdfium + Tesseract CLI + language models (once)
npm run android:build        # release APK for arm64-v8a
npm run android:build:all    # release APKs for arm64-v8a + armeabi-v7a
```

The APKs land in `release-artifacts/`. Extra switches:

```powershell
powershell -File scripts/build-android.ps1 -Abi x86_64 -Debug    # emulator build
powershell -File scripts/build-android.ps1 -SkipFrontend         # reuse dist/
powershell -File scripts/build-android.ps1 -AndroidHome D:\Sdk -NdkHome D:\Sdk\ndk\27.3.13750724
```

Install on a device or emulator:

```powershell
adb install -r release-artifacts\pdf-swiss-army-knife-arm64-v8a-app-arm64-release.apk
```

> **Why not `tauri android build`?** The Tauri CLI prepares `jniLibs` with
> file symlinks, which Windows only allows in Developer Mode. The build script
> compiles the Rust library with cargo and copies it, so plain Windows
> machines and CI produce the same APK. `tauri android dev` still works for
> interactive development.

## What ships in the APK

| Component | Where | Purpose |
| --- | --- | --- |
| `libpdf_sak_lib.so` | `lib/<abi>/` | the Rust application (frontend embedded via `tauri/custom-protocol`) |
| `libpdfium.so` | `lib/<abi>/` | page rendering, text extraction, search (bblanchon/pdfium-binaries) |
| `libtesseract.so` | `lib/<abi>/` | Tesseract 4.1.0 CLI, executed from the app's native library directory |
| `tessdata/*` | `assets/` | 8 OCR languages + OSD, copied to the app's private files directory on first launch |

`npm run android:engines` downloads these into `src-tauri/resources/engines-android`
(native libraries) and `src-tauri/resources/android-assets/tessdata` (models);
both directories are ignored by git, exactly like the desktop engines.

The APK is self-contained: no network permission is used for anything except
the optional AI assistant (which needs `INTERNET`).

## File handling

Android does not give apps file paths for documents the user picks, and it
does not let apps open private files in other applications. The app bridges
this without changing any tool:

| Desktop | Android |
| --- | --- |
| `dialog.open()` returns a path | Storage Access Framework picker → the file is copied into the app cache and the tools receive a normal path |
| "Browse" chooses the output path | "Save as…" picks a destination (SAF); the finished file is copied there |
| Output is written next to the input | Output is written to the app Documents folder and then copied to `Downloads/PDF Swiss Army Knife/` (or the picked destination) |
| "Open folder" | "Share" opens the system share sheet for the result |

Nothing is uploaded anywhere: the copies live in the app's private storage and
the public Downloads folder.

## Engine notes

* **pdfium** is loaded from the app's native library directory with
  `Pdfium::bind_to_library`; the packaged build is the same Chromium revision
  as the Windows build (155.0.8057.0).
* **Tesseract** is the official CLI built for Android (statically linked,
  Apache-2.0). It is packaged as `libtesseract.so` because executables may only
  be started from the native library directory on Android 10+.
* **qpdf** is not bundled (it is only used for desktop-side diagnostics); the
  security features are implemented in Rust (`lopdf`, AES-256 R6).
* OCR quality is identical to the desktop build: same `tessdata_fast` models,
  same preprocessing pipeline, same output modes (searchable PDF, text,
  Markdown).

## CI

`.github/workflows/android.yml` builds the APKs on every version tag (and on
manual dispatch) on an Ubuntu runner with the Android SDK/NDK, and attaches
them to the GitHub release.
