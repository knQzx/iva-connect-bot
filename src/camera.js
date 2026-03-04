const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const FAKE_CAMERA = path.join(__dirname, "..", "fake-camera.y4m");
const FAKE_MIC = path.join(__dirname, "..", "fake-mic.wav");
const VIDEOS_DIR = path.join(__dirname, "..", "videos");
const DEFAULT_Y4M = path.join(VIDEOS_DIR, "default.y4m");

fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// --- Audio helpers ---

function generateSilenceWav(filePath) {
  // 48kHz, 16-bit, mono, 1 second of silence
  const sampleRate = 48000;
  const bitsPerSample = 16;
  const numChannels = 1;
  const numSamples = sampleRate; // 1 second
  const dataSize = numSamples * numChannels * (bitsPerSample / 8);
  const headerSize = 44;
  const buf = Buffer.alloc(headerSize + dataSize, 0);

  buf.write("RIFF", 0);
  buf.writeUInt32LE(headerSize + dataSize - 8, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20);  // PCM
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * numChannels * (bitsPerSample / 8), 28);
  buf.writeUInt16LE(numChannels * (bitsPerSample / 8), 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  // samples are already zeroed

  fs.writeFileSync(filePath, buf);
}

function convertToWav(srcPath, dstPath) {
  execFileSync(
    "ffmpeg",
    ["-y", "-i", srcPath, "-ar", "48000", "-ac", "1", dstPath],
    { stdio: "pipe", timeout: 60000 }
  );
}

function switchActiveMic(wavPath) {
  fs.copyFileSync(wavPath, FAKE_MIC);
}

function restoreSilentMic() {
  generateSilenceWav(FAKE_MIC);
}

// Generate initial silence file if it doesn't exist
if (!fs.existsSync(FAKE_MIC)) {
  generateSilenceWav(FAKE_MIC);
}

function prepareFakeCamera() {
  const CAMERA_VIDEO = process.env.CAMERA_VIDEO || "";
  if (!CAMERA_VIDEO) return false;

  const projectRoot = path.resolve(__dirname, "..");
  const src = path.resolve(projectRoot, CAMERA_VIDEO);
  if (!src.startsWith(projectRoot + path.sep)) {
    console.error(`[cam] Путь ${CAMERA_VIDEO} выходит за пределы проекта.`);
    return false;
  }
  if (!fs.existsSync(src)) {
    console.error(`[cam] Файл ${src} не найден.`);
    return false;
  }

  if (src.endsWith(".y4m")) return true;

  const srcStat = fs.statSync(src);
  const y4mExists = fs.existsSync(FAKE_CAMERA);
  const y4mStat = y4mExists ? fs.statSync(FAKE_CAMERA) : null;

  if (!y4mExists || srcStat.mtimeMs > y4mStat.mtimeMs) {
    console.log(`[cam] Конвертируем ${CAMERA_VIDEO} → fake-camera.y4m ...`);
    try {
      execFileSync(
        "ffmpeg",
        ["-y", "-i", src, "-pix_fmt", "yuv420p", "-vf",
         "scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2",
         FAKE_CAMERA],
        { stdio: "pipe" }
      );
      const size = (fs.statSync(FAKE_CAMERA).size / 1024 / 1024).toFixed(1);
      console.log(`[cam] Готово (${size} MB)`);
    } catch (e) {
      console.error(`[cam] Ошибка ffmpeg: ${e.stderr?.toString().split("\n").pop()}`);
      return false;
    }
  } else {
    console.log("[cam] fake-camera.y4m уже актуален.");
  }

  // Бэкап оригинала для возможности вернуться
  if (!fs.existsSync(DEFAULT_Y4M)) {
    fs.copyFileSync(FAKE_CAMERA, DEFAULT_Y4M);
    console.log("[cam] Оригинал сохранён в videos/default.y4m");
  }

  return true;
}

function convertToY4m(srcPath, dstPath) {
  execFileSync(
    "ffmpeg",
    ["-y", "-i", srcPath, "-pix_fmt", "yuv420p", "-vf",
     "scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2",
     dstPath],
    { stdio: "pipe", timeout: 120000 }
  );
}

function switchActiveVideo(y4mPath) {
  fs.copyFileSync(y4mPath, FAKE_CAMERA);
}

function restoreDefaultVideo() {
  if (fs.existsSync(DEFAULT_Y4M)) {
    fs.copyFileSync(DEFAULT_Y4M, FAKE_CAMERA);
    return true;
  }
  return false;
}

function loadVideoMeta() {
  const metaPath = path.join(VIDEOS_DIR, "meta.json");
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return { videos: [], activeId: null, nextId: 1 };
  }
}

function saveVideoMeta(meta) {
  const metaPath = path.join(VIDEOS_DIR, "meta.json");
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

function downloadFile(url, destPath) {
  execFileSync("curl", ["-sL", "-o", destPath, url], { timeout: 60000 });
}

const USE_CAMERA = prepareFakeCamera();

module.exports = {
  FAKE_CAMERA,
  FAKE_MIC,
  USE_CAMERA,
  VIDEOS_DIR,
  DEFAULT_Y4M,
  convertToY4m,
  switchActiveVideo,
  restoreDefaultVideo,
  loadVideoMeta,
  saveVideoMeta,
  downloadFile,
  convertToWav,
  switchActiveMic,
  restoreSilentMic,
};
