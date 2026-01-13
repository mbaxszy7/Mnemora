/**
 * Enhanced Local OCR Demo (100% Offline)
 *
 * 方案：Tesseract.js + Sharp 预处理
 * 支持：Mac ARM/Intel, Windows ARM/x64
 * 语言：中英文混合
 */

import { createWorker } from "tesseract.js";
import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";

interface OCRResult {
  success: boolean;
  text: string;
  duration: number;
  confidence: number;
  preprocessTime: number;
  recognizeTime: number;
}

/**
 * 图像预处理 - 提升 OCR 识别率的关键
 */
async function preprocessImage(inputPath: string): Promise<Buffer> {
  const startTime = performance.now();

  const result = await sharp(inputPath)
    .greyscale() // 转灰度
    .normalize() // 归一化对比度
    .sharpen({ sigma: 1 }) // 轻度锐化
    .linear(1.2, -20) // 提高对比度
    .toBuffer();

  console.log(`   🎨 Pre-processing: ${(performance.now() - startTime).toFixed(0)}ms`);
  return result;
}

/**
 * 执行 OCR
 */
async function performOCR(imagePath: string, lang: string = "eng"): Promise<OCRResult> {
  const totalStart = performance.now();

  // 1. 预处理图像
  console.log("   📷 Processing image...");
  const preprocessStart = performance.now();
  const processedBuffer = await preprocessImage(imagePath);
  const preprocessTime = performance.now() - preprocessStart;

  // 2. 初始化 Worker
  console.log(`   ⏳ Loading Tesseract (lang: ${lang})...`);
  const worker = await createWorker(lang, 1, {
    logger: (m) => {
      if (m.status === "recognizing text") {
        process.stdout.write(`\r   🔍 Recognizing: ${(m.progress * 100).toFixed(0)}%`);
      }
    },
  });

  try {
    // 3. 识别
    const recognizeStart = performance.now();
    const {
      data: { text, confidence },
    } = await worker.recognize(processedBuffer);
    const recognizeTime = performance.now() - recognizeStart;

    console.log(""); // 换行

    return {
      success: true,
      text: text.trim(),
      confidence,
      duration: performance.now() - totalStart,
      preprocessTime,
      recognizeTime,
    };
  } finally {
    await worker.terminate();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const imagePath = args.find((a) => !a.startsWith("--"));

  // 解析语言参数
  let lang = "eng"; // 默认英文
  const langArg = args.find((a) => a.startsWith("--lang="));
  if (langArg) {
    lang = langArg.split("=")[1];
  } else if (args.includes("--chi")) {
    lang = "chi_sim";
  } else if (args.includes("--both")) {
    lang = "eng+chi_sim";
  }

  if (!imagePath) {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║           Enhanced Local OCR Demo (100% Offline)           ║
╚════════════════════════════════════════════════════════════╝

Usage:
  npx tsx demo/ocr-demo.ts <image_path> [options]

Options:
  --lang=<code>   Specify language (e.g., eng, chi_sim, eng+chi_sim)
  --chi           Use Simplified Chinese
  --both          Use both English and Chinese
  --export        Export result to JSON

Examples:
  npx tsx demo/ocr-demo.ts image.png              # English only
  npx tsx demo/ocr-demo.ts image.png --chi        # Chinese only
  npx tsx demo/ocr-demo.ts image.png --both       # Both languages
`);
    return;
  }

  console.log("\n" + "=".repeat(60));
  console.log("✨ Enhanced Local OCR Demo (100% Offline)");
  console.log("=".repeat(60));
  console.log(`📁 Image: ${path.basename(imagePath)}`);
  console.log(`🌐 Language: ${lang}`);
  console.log("-".repeat(60));

  try {
    const result = await performOCR(imagePath, lang);

    console.log(`\n✅ Success!`);
    console.log(`   ⏱️  Total: ${(result.duration / 1000).toFixed(2)}s`);
    console.log(`   🎯 Confidence: ${result.confidence.toFixed(1)}%`);
    console.log(
      `   📊 Preprocess: ${result.preprocessTime.toFixed(0)}ms | Recognize: ${(result.recognizeTime / 1000).toFixed(2)}s`
    );

    console.log(`\n📄 Recognized Text:`);
    console.log("─".repeat(40));
    const preview =
      result.text.length > 2000 ? result.text.substring(0, 2000) + "..." : result.text;
    console.log(preview || "[No text detected]");

    // 导出
    if (args.includes("--export")) {
      const outPath = imagePath.replace(/\.[^.]+$/, "_ocr.json");
      fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
      console.log(`\n💾 Exported to: ${outPath}`);
    }
  } catch (err) {
    console.log(`\n❌ Failed: ${err}`);
  }

  console.log("=".repeat(60) + "\n");
}

main().catch(console.error);
