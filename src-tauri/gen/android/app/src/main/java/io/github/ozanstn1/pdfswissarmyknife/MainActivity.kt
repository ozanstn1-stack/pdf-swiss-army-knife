package io.github.ozanstn1.pdfswissarmyknife

import android.os.Bundle
import androidx.activity.enableEdgeToEdge
import java.io.File

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    installTessdata()
    super.onCreate(savedInstanceState)
  }

  /**
   * Copies the OCR language models that ship as APK assets into the app's
   * private files directory. The bundled Tesseract executable reads them from
   * the filesystem (TESSDATA_PREFIX), so they cannot stay inside the APK.
   * The copy runs once per app version and is skipped afterwards.
   */
  private fun installTessdata() {
    val target = File(filesDir, "tessdata")
    val marker = File(target, ".installed")
    val stamp = "${packageInfoVersion()}-${assetStamp()}"
    if (marker.isFile && marker.readText().trim() == stamp) return
    if (!target.isDirectory && !target.mkdirs()) return
    val entries = try {
      assets.list("tessdata")
    } catch (error: Exception) {
      null
    } ?: return
    for (name in entries) {
      val assetPath = "tessdata/$name"
      val destination = File(target, name)
      if (hasChildren(assetPath)) {
        copyDirectory(assetPath, destination)
      } else {
        copyAsset(assetPath, destination)
      }
    }
    marker.writeText(stamp)
  }

  private fun assetStamp(): String = try {
    val entries = assets.list("tessdata") ?: emptyArray()
    entries.size.toString()
  } catch (error: Exception) {
    "0"
  }

  private fun packageInfoVersion(): String = try {
    packageManager.getPackageInfo(packageName, 0).versionName ?: "0"
  } catch (error: Exception) {
    "0"
  }

  private fun hasChildren(assetPath: String): Boolean = try {
    val children = assets.list(assetPath)
    children != null && children.isNotEmpty()
  } catch (error: Exception) {
    false
  }

  private fun copyDirectory(assetPath: String, destination: File) {
    if (!destination.isDirectory && !destination.mkdirs()) return
    val children = try {
      assets.list(assetPath)
    } catch (error: Exception) {
      null
    } ?: return
    for (name in children) {
      val childAsset = "$assetPath/$name"
      val childDestination = File(destination, name)
      if (hasChildren(childAsset)) {
        copyDirectory(childAsset, childDestination)
      } else {
        copyAsset(childAsset, childDestination)
      }
    }
  }

  private fun copyAsset(assetPath: String, destination: File) {
    try {
      assets.open(assetPath).use { input ->
        destination.outputStream().use { output -> input.copyTo(output) }
      }
    } catch (error: Exception) {
      // A missing optional model must not stop the app from starting.
    }
  }
}
