import Tesseract from "tesseract.js";

let worker = null;

async function getWorker() {
  if (!worker) {
    worker = await Tesseract.createWorker("eng");
  }
  return worker;
}

/**
 * Run OCR on a local image file.
 * @param {string} imagePath  path to image file (PNG/JPEG)
 * @returns {Promise<string>}  extracted text
 */
export async function extractText(imagePath) {
  const w = await getWorker();
  const { data } = await w.recognize(imagePath);
  return data.text.trim();
}

/**
 * Terminate the Tesseract worker.
 */
export async function terminateOCR() {
  if (worker) {
    await worker.terminate();
    worker = null;
  }
}
