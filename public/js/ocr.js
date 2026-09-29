// 🪪 OCR – read an Ayushman Bharat / ABHA card, prescription or discharge
// summary with Tesseract.js (runs fully in the browser; the image never
// leaves the phone), then extract patient details with shared/ocr-parse.js.

import { parseHealthDocument } from '/shared/ocr-parse.js';

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
let loading = null;
let worker = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = TESSERACT_URL;
      s.onload = () => resolve(window.Tesseract);
      s.onerror = () => { loading = null; reject(new Error('Could not load OCR engine (offline?)')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

/**
 * @param {string|File} image data URL or File
 * @param {(p:number)=>void} [onProgress] 0..1
 * @returns {Promise<{text:string, fields:object}>}
 */
export async function scanHealthDocument(image, onProgress) {
  const Tesseract = await loadTesseract();
  if (!worker) {
    // English + Hindi, since Ayushman cards and prescriptions mix both.
    worker = await Tesseract.createWorker(['eng', 'hin'], 1, {
      logger: (m) => { if (m.status === 'recognizing text') onProgress?.(m.progress); },
    });
  }
  const { data } = await worker.recognize(image);
  return { text: data.text, fields: parseHealthDocument(data.text) };
}
