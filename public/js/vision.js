// 📷 Computer vision on a photo of the injury / scene.
//
// 1. Online: the photo is sent to the server, where Claude's vision model
//    describes visible findings (bleeding, burns, bite marks, deformity,
//    pesticide bottle, etc.) and suggests the emergency type.
// 2. Offline / no AI key: an on-device pixel analysis estimates how much of
//    the image is fresh blood (bright red) or burnt / blistered skin.
//    It is deliberately conservative and clearly labelled as a heuristic.

/** Downscale a File to a JPEG data URL (keeps uploads small on 2G/3G). */
export function fileToDataUrl(file, maxSide = 1024) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max ? d / max : 0, max];
}

/** On-device heuristic analysis. Returns { findings[], suspectedType, bloodPct, burnPct }. */
export function analyseOnDevice(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const size = 160;
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, size, size);
      const { data } = ctx.getImageData(0, 0, size, size);
      let blood = 0, charred = 0, blister = 0, skin = 0;
      const n = size * size;
      for (let i = 0; i < data.length; i += 4) {
        const [h, s, v] = rgbToHsv(data[i], data[i + 1], data[i + 2]);
        const isRedHue = h < 12 || h > 345;
        if (isRedHue && s > 0.6 && v > 0.25 && v < 0.85) blood++;           // deep saturated red
        if (v < 0.18 && s < 0.5) charred++;                                    // black/charred
        if ((h < 20 || h > 340) && s > 0.25 && s < 0.6 && v > 0.6) blister++; // pink/raw skin
        if (h >= 10 && h <= 40 && s > 0.2 && s < 0.65 && v > 0.35) skin++;     // skin tones
      }
      const pct = (x) => Math.round((x / n) * 1000) / 10;
      const bloodPct = pct(blood);
      const burnPct = pct(Math.min(charred, blister) * 2);
      const findings = [];
      let suspectedType = null;
      if (bloodPct > 12) { findings.push(`Large area of bright red (${bloodPct}% of image) – possible heavy bleeding`); suspectedType = 'bleeding'; }
      else if (bloodPct > 4) findings.push(`Some red areas (${bloodPct}% of image) – possible bleeding`);
      if (burnPct > 6 && pct(skin) > 10) { findings.push('Charred and raw/pink skin patches – possible burn'); suspectedType = suspectedType || 'burns'; }
      if (!findings.length) findings.push('No obvious bleeding or burn detected on-device');
      resolve({ engine: 'heuristic', findings, suspectedType, bloodPct, burnPct });
    };
    img.onerror = () => resolve({ engine: 'heuristic', findings: [], suspectedType: null });
    img.src = dataUrl;
  });
}

/** Analyse a photo: Claude vision via the server if available, else on-device. */
export async function analysePhoto(dataUrl, lang) {
  try {
    const res = await fetch('/api/vision', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl, lang }),
    });
    if (res.ok) {
      const out = await res.json();
      if (out.ai) {
        return {
          engine: 'claude-vision',
          findings: out.visible_findings || [],
          suspectedType: out.suspected_type !== 'general' ? out.suspected_type : null,
          severity: out.severity,
          description: out.description,
        };
      }
    }
  } catch { /* offline – fall through */ }
  const local = await analyseOnDevice(dataUrl);
  return { ...local, description: local.findings.join('; ') };
}
