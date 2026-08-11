package dev.hadamard.companion.document

import android.content.Context
import android.graphics.Bitmap
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import dev.hadamard.companion.capability.MobilePermission
import dev.hadamard.companion.capability.MobileTool
import dev.hadamard.companion.capability.MobileToolContext
import dev.hadamard.companion.capability.MobileToolDefinition
import dev.hadamard.companion.workspace.WorkspacePort
import org.json.JSONObject
import java.io.File
import java.util.UUID

class PdfTools(
  private val context: Context,
  private val workspace: WorkspacePort,
  private val ocrService: OcrService,
) {
  fun all(): List<MobileTool> = listOf(
    pdfTool("PdfReadText", MobilePermission.READ_WORKSPACE) { args ->
      val bytes = readPdf(args.getString("documentId"))
      PDFBoxResourceLoader.init(context)
      PDDocument.load(bytes).use { document ->
        require(document.numberOfPages <= MAX_PAGES) { "PDF exceeds the mobile page limit" }
        val stripper = com.tom_roush.pdfbox.text.PDFTextStripper().apply {
          startPage = 1
          endPage = minOf(document.numberOfPages, args.optInt("maxPages", MAX_PAGES).coerceIn(1, MAX_PAGES))
        }
        JSONObject().put("text", stripper.getText(document).take(MAX_TEXT_CHARS)).toString()
      }
    },
    pdfTool("PdfRenderPage", MobilePermission.READ_WORKSPACE) { args ->
      withRenderer(readPdf(args.getString("documentId"))) { renderer ->
        require(renderer.pageCount <= MAX_PAGES) { "PDF exceeds the mobile page limit" }
        val pageIndex = args.optInt("page", 0)
        require(pageIndex in 0 until renderer.pageCount) { "PDF page is out of range" }
        renderer.openPage(pageIndex).use { page ->
          val scale = minOf(2f, MAX_RENDER_WIDTH.toFloat() / page.width.coerceAtLeast(1))
          val width = (page.width * scale).toInt().coerceAtLeast(1)
          val height = (page.height * scale).toInt().coerceAtLeast(1)
          ocrService.enforceBitmapLimit(width, height)
          JSONObject().put("width", width).put("height", height).put("page", pageIndex).toString()
        }
      }
    },
    pdfTool("PdfOcr", MobilePermission.OCR) { args ->
      val requestedPages = args.optInt("maxPages", 4).coerceIn(1, MAX_OCR_PAGES)
      withRenderer(readPdf(args.getString("documentId"))) { renderer ->
        require(renderer.pageCount <= MAX_PAGES) { "PDF exceeds the mobile page limit" }
        val output = StringBuilder()
        repeat(minOf(renderer.pageCount, requestedPages)) { pageIndex ->
          renderer.openPage(pageIndex).use { page ->
            val scale = minOf(1.5f, MAX_RENDER_WIDTH.toFloat() / page.width.coerceAtLeast(1))
            val width = (page.width * scale).toInt().coerceAtLeast(1)
            val height = (page.height * scale).toInt().coerceAtLeast(1)
            ocrService.enforceBitmapLimit(width, height)
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            try {
              page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
              output.append("\n\n--- Page ${pageIndex + 1} ---\n").append(ocrService.recognize(bitmap))
            } finally {
              bitmap.recycle()
            }
          }
        }
        JSONObject().put("text", output.toString().take(MAX_TEXT_CHARS)).toString()
      }
    },
    pdfTool("ImageOcr", MobilePermission.OCR) { args ->
      val bytes = workspace.read(args.getString("documentId"), OcrService.MAX_IMAGE_BYTES)
      JSONObject().put("text", ocrService.recognize(bytes).take(MAX_TEXT_CHARS)).toString()
    },
  )

  private fun readPdf(documentId: String) = workspace.read(documentId, MAX_PDF_BYTES)

  private inline fun <T> withRenderer(bytes: ByteArray, block: (PdfRenderer) -> T): T {
    val temporary = File(context.cacheDir, "pdf-${UUID.randomUUID()}.pdf")
    temporary.outputStream().use { it.write(bytes) }
    return try {
      ParcelFileDescriptor.open(temporary, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
        PdfRenderer(descriptor).use(block)
      }
    } finally {
      temporary.delete()
    }
  }

  private fun pdfTool(
    name: String,
    permission: MobilePermission,
    block: suspend (JSONObject) -> String,
  ) = object : MobileTool {
    override val definition = MobileToolDefinition(
      name,
      "$name with mobile PDF/image page, pixel, memory, and output limits.",
      "{\"type\":\"object\",\"required\":[\"documentId\"]}",
      permission,
    )
    override suspend fun execute(argumentsJson: String, context: MobileToolContext) = block(JSONObject(argumentsJson))
  }

  companion object {
    const val MAX_PDF_BYTES = 32 * 1_048_576
    const val MAX_PAGES = 80
    const val MAX_OCR_PAGES = 12
    const val MAX_RENDER_WIDTH = 2048
    const val MAX_TEXT_CHARS = 500_000
  }
}
