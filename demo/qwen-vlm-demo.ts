/**
 * 千问 VLM + Tesseract.js 混合 OCR Demo
 *
 * 流程：
 * 1. VLM 识别主文字区域边界框
 * 2. Sharp 裁剪该区域
 * 3. Tesseract.js 对裁剪区域进行 OCR
 */

import OpenAI from "openai";
import { createWorker } from "tesseract.js";
import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";

const openai = new OpenAI({
  apiKey: "sk-eda437625d1c4c09a9b58cc567b9ddcc",
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
});

interface TextRegion {
  box: number[]; // [left, top, width, height]
  confidence: number;
}

function imageToBase64(imagePath: string): string {
  const absolutePath = path.resolve(imagePath);
  const imageBuffer = fs.readFileSync(absolutePath);
  const ext = path.extname(imagePath).toLowerCase().slice(1);
  const mimeType = ext === "jpg" ? "jpeg" : ext;
  return `data:image/${mimeType};base64,${imageBuffer.toString("base64")}`;
}

/**
 * Step 1: 使用 VLM 识别主文字区域
 */
async function detectTextRegion(imagePath: string): Promise<TextRegion | null> {
  console.log("\n📍 Step 1: VLM 识别主文字区域...");
  const startTime = performance.now();

  const imageBase64 = imageToBase64(imagePath);
  console.log(`   Image size: ${(imageBase64.length / 1024).toFixed(1)}KB`);

  const prompt = `分析这张截图，识别出最核心，最清晰的文字内容区域（即正文部分，排除导航栏、侧边栏、广告等）。
请务必返回该区域在图片中的像素坐标，格式为 [left, top, width, height]。

返回 JSON 格式：
{
  "content_type": "document|blog|code|other",
  "text_region": {
    "box": [left, top, width, height],
    "confidence": 0.95
  }
}

注意：
1. box 字段必须是 [左边界, 上边界, 宽度, 高度] 的数值数组。
2. 请确保坐标在图片范围内。`;

  const response = await openai.chat.completions.create({
    model: "qwen3-vl-plus",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: imageBase64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });

  const vlmTime = performance.now() - startTime;
  console.log(`   ⏱️ VLM time: ${(vlmTime / 1000).toFixed(2)}s`);

  const content = response.choices[0]?.message?.content || "";
  console.log(`   📄 VLM Response:\n${content}`);

  // 解析 JSON 响应
  try {
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/) || content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const jsonStr = jsonMatch[1] || jsonMatch[0];
      const parsed = JSON.parse(jsonStr);
      return parsed.text_region as TextRegion;
    }
  } catch (e) {
    console.log("   ⚠️ Failed to parse JSON response", e);
  }
  return null;
}

/**
 * Step 2: 裁剪图片区域
 */
async function cropRegion(imagePath: string, box: number[]): Promise<Buffer> {
  console.log("\n✂️ Step 2: 裁剪主文字区域...");

  // 获取图片实际尺寸
  const metadata = await sharp(imagePath).metadata();
  const imgWidth = metadata.width || 1920;
  const imgHeight = metadata.height || 1080;
  console.log(`   Image size: ${imgWidth}x${imgHeight}`);

  let [left, top, width, height] = box;

  // 边界检查，确保不超过图片尺寸
  left = Math.max(0, Math.min(left, imgWidth - 1));
  top = Math.max(0, Math.min(top, imgHeight - 1));
  width = Math.min(width, imgWidth - left);
  height = Math.min(height, imgHeight - top);

  console.log(`   Region: left=${left}, top=${top}, width=${width}, height=${height}`);

  const croppedBuffer = await sharp(imagePath)
    .extract({
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
    })
    .toBuffer();

  console.log(`   ✅ Cropped size: ${(croppedBuffer.length / 1024).toFixed(1)}KB`);
  return croppedBuffer;
}

/**
 * Step 3: Tesseract OCR
 */
async function performOCR(
  imageBuffer: Buffer,
  lang: string = "eng+chi_sim"
): Promise<{ text: string; confidence: number }> {
  console.log(`\n🔍 Step 3: Tesseract OCR (${lang})...`);
  const startTime = performance.now();

  const worker = await createWorker(lang, 1, {
    logger: (m) => {
      if (m.status === "recognizing text") {
        process.stdout.write(`\r   🔍 Recognizing: ${(m.progress * 100).toFixed(0)}%`);
      }
    },
  });

  try {
    const {
      data: { text, confidence },
    } = await worker.recognize(imageBuffer);
    const ocrTime = performance.now() - startTime;

    console.log(`   ⏱️ OCR time: ${(ocrTime / 1000).toFixed(2)}s`);
    console.log(`   🎯 Confidence: ${confidence.toFixed(1)}%`);

    return { text: text.trim(), confidence };
  } finally {
    await worker.terminate();
  }
}

async function main() {
  const imagePath = process.argv[2];

  if (!imagePath) {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║     千问 VLM + Tesseract.js 混合 OCR Demo                  ║
╚════════════════════════════════════════════════════════════╝

Usage:
  npx tsx demo/qwen-vlm-demo.ts <image_path> [--chi]

Options:
  --chi    Use Chinese OCR (chi_sim)
`);
    return;
  }

  const totalStart = performance.now();
  console.log("\n" + "=".repeat(60));
  console.log("🧠 VLM + Tesseract.js 混合 OCR Demo");
  console.log("=".repeat(60));
  console.log(`📁 Image: ${path.basename(imagePath)}`);

  try {
    // Step 1: VLM 识别区域
    const region = await detectTextRegion(imagePath);

    if (!region || !region.box) {
      console.log("\n❌ Failed to detect text region");
      return;
    }

    // Step 2: 裁剪区域
    const croppedBuffer = await cropRegion(imagePath, region.box);

    // Step 3: Tesseract OCR
    const result = await performOCR(croppedBuffer);

    // 输出结果
    const totalTime = performance.now() - totalStart;
    console.log("\n" + "=".repeat(60));
    console.log("📊 Final Results");
    console.log("=".repeat(60));
    console.log(`⏱️  Total time: ${(totalTime / 1000).toFixed(2)}s`);
    console.log(`🎯 OCR Confidence: ${result.confidence.toFixed(1)}%`);
    console.log(`\n📄 Recognized Text:`);
    console.log("─".repeat(40));
    console.log(result.text || "[No text detected]");
  } catch (error) {
    console.error("\n❌ Error:", error);
  }

  console.log("\n" + "=".repeat(60) + "\n");
}

main();
