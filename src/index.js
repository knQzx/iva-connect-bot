const { chromium } = require("playwright");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const readline = require("readline");
require("dotenv").config();

const MEETING_URL = process.env.MEETING_URL;
const DISPLAY_NAME = process.env.DISPLAY_NAME || "Студент";
const MAX_DURATION = parseInt(process.env.MAX_DURATION || "0", 10);
const HEADED = process.env.HEADED !== "false";
const CAMERA_VIDEO = process.env.CAMERA_VIDEO || "";
const FAKE_CAMERA = path.join(__dirname, "..", "fake-camera.y4m");
const DIR = path.join(__dirname, "..", "screenshots");

if (!MEETING_URL) { console.error("MEETING_URL не задан."); process.exit(1); }
fs.mkdirSync(DIR, { recursive: true });

// Конвертация видео в y4m если нужно
function prepareFakeCamera() {
  if (!CAMERA_VIDEO) return false;

  const src = path.join(__dirname, "..", CAMERA_VIDEO);
  if (!fs.existsSync(src)) {
    console.error(`Файл ${src} не найден.`);
    return false;
  }

  // Если .y4m — используем как есть
  if (src.endsWith(".y4m")) return true;

  // Конвертируем mp4/mov/etc → y4m
  const srcStat = fs.statSync(src);
  const y4mExists = fs.existsSync(FAKE_CAMERA);
  const y4mStat = y4mExists ? fs.statSync(FAKE_CAMERA) : null;

  // Перегенерируем если исходник новее
  if (!y4mExists || srcStat.mtimeMs > y4mStat.mtimeMs) {
    console.log(`[cam] Конвертируем ${CAMERA_VIDEO} → fake-camera.y4m ...`);
    try {
      execSync(
        `ffmpeg -y -i "${src}" -pix_fmt yuv420p -vf "scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2" "${FAKE_CAMERA}"`,
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

  return true;
}

const USE_CAMERA = prepareFakeCamera();

let sc = 0;
async function ss(page, name) {
  sc++;
  const f = path.join(DIR, `${String(sc).padStart(2, "0")}-${name}.png`);
  try { await page.screenshot({ path: f }); } catch {}
}

async function showToolbar(page) {
  await page.mouse.move(640, 680);
  await page.waitForTimeout(500);
}

async function openChat(page) {
  await showToolbar(page);
  await page.waitForTimeout(500);

  // Кнопка чата — class содержит "layout-left-margin_16" и "iva-icon-button"
  const chatBtn = page.locator("button.iva-icon-button.layout-left-margin_16").first();
  if (await chatBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await chatBtn.click();
  } else {
    // Fallback — последняя iva-icon-button
    const all = page.locator("button.iva-icon-button");
    const count = await all.count();
    if (count > 0) await all.nth(count - 1).click();
  }
  await page.waitForTimeout(2000);
}

// --- Чтение сообщений чата ---
function parseMessages(raw) {
  // raw — массив { author, text, time, own }
  return raw.map(m => ({ ...m, key: `${m.author}|${m.text}|${m.time}` }));
}

async function readChatMessages(page) {
  return page.evaluate(() => {
    const msgs = [];
    const wrappers = document.querySelectorAll("div.message-bubble__wrapper");
    wrappers.forEach(w => {
      const bubble = w.querySelector("div.message-bubble");
      if (!bubble) return;
      const own = bubble.classList.contains("own");
      // Автор — первый текстовый элемент перед текста сообщения
      // Структура: message-bubble > [author-block] + message-text + bottom-info
      const authorEl = bubble.querySelector(".message-bubble__author, .message-bubble__name");
      const textEl = bubble.querySelector(".message-text");
      const timeEl = bubble.querySelector(".message-bubble__date");

      // Если нет авторского блока, берём текст из полного bubble
      let author = authorEl?.textContent?.trim() || "";
      let text = "";
      let time = timeEl?.textContent?.trim() || "";

      if (textEl) {
        // Текст сообщения без даты
        const clone = textEl.cloneNode(true);
        const dateInText = clone.querySelector(".message-bubble__bottom-info-wrapper");
        if (dateInText) dateInText.remove();
        text = clone.textContent?.trim() || "";
      }

      if (!text && !author) {
        // Fallback — парсим из полного текста
        const full = bubble.textContent?.trim() || "";
        // Формат: "Автор текст сообщения ЧЧ:ММ"
        const timeMatch = full.match(/(\d{2}:\d{2})$/);
        if (timeMatch) {
          time = timeMatch[1];
          text = full.substring(0, full.length - time.length).trim();
        } else {
          text = full;
        }
      }

      msgs.push({ author, text, time, own });
    });
    return msgs;
  });
}

async function main() {
  console.log(`=== IVA Connect Bot ===`);
  console.log(`URL: ${MEETING_URL}`);
  console.log(`Имя: ${DISPLAY_NAME}\n`);

  const launchArgs = [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
  ];
  if (USE_CAMERA) {
    launchArgs.push(`--use-file-for-fake-video-capture=${FAKE_CAMERA}`);
    console.log("[cam] Фейковая камера включена.");
  }

  const browser = await chromium.launch({
    headless: !HEADED,
    args: launchArgs,
  });
  const page = await (await browser.newContext({
    permissions: ["camera", "microphone"],
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
  })).newPage();
  page.setDefaultTimeout(15000);

  // --- 1. Открываем ---
  console.log("[1] Открываем...");
  await page.goto(MEETING_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  // --- 2. Войти (если есть кнопка) ---
  console.log("[2] Войти...");
  try { await page.locator('button:has-text("Войти")').first().click({ force: true, timeout: 5000 }); } catch {}
  await page.waitForTimeout(5000);

  // --- 4. Проверка оборудования ---
  try {
    if (await page.locator('text="Проверка оборудования"').first().isVisible({ timeout: 3000 })) {
      console.log("[4] Проверка оборудования...");

      // Включаем камеру — shared-video-controller (class="off")
      try {
        const camToggle = page.locator("shared-video-controller").first();
        if (await camToggle.isVisible({ timeout: 3000 })) {
          await camToggle.click();
          console.log("[4] Камера включена!");
          await page.waitForTimeout(2000);
        }
      } catch {}

      await page.locator('button:has-text("Войти")').first().click({ force: true, timeout: 5000 });
      await page.waitForTimeout(8000);
    }
  } catch {}

  console.log("[*] В конференции!");
  await page.waitForTimeout(5000);

  // --- 5. Камера вкл ---
  await showToolbar(page);
  await page.waitForTimeout(1000);

  // Тулбар: [0]=reaction, [1]=mic, [2]=cam, [3]=share, [4]=more, [5]=hangup
  try {
    const camBtn = page.locator("button.iva-round-button").nth(2);
    if (await camBtn.isVisible({ timeout: 3000 })) {
      const camOff = await camBtn.evaluate(el => el.classList.contains("not-painted"));
      if (camOff) {
        await camBtn.click();
        console.log("[5] Камера включена!");
      } else {
        console.log("[5] Камера уже включена.");
      }
    }
  } catch {}

  // --- 6. Открываем чат ---
  console.log("[6] Открываем чат...");
  await openChat(page);
  await ss(page, "chat-opened");

  // --- 7. Мониторинг чата ---
  let seenKeys = new Set();

  // Считываем уже существующие сообщения
  const initial = await readChatMessages(page);
  initial.forEach(m => {
    const key = `${m.author}|${m.text}|${m.time}`;
    seenKeys.add(key);
  });
  if (initial.length > 0) {
    console.log(`\n--- Существующие сообщения (${initial.length}) ---`);
    initial.forEach(m => {
      const prefix = m.own ? "(вы)" : (m.author || "???");
      console.log(`  [${m.time}] ${prefix}: ${m.text}`);
    });
    console.log("--- конец ---\n");
  }

  // Polling новых сообщений каждые 3 сек
  const chatPollInterval = setInterval(async () => {
    try {
      const msgs = await readChatMessages(page);
      for (const m of msgs) {
        const key = `${m.author}|${m.text}|${m.time}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          const prefix = m.own ? "\x1b[90m(вы)\x1b[0m" : `\x1b[36m${m.author || "???"}\x1b[0m`;
          // Очищаем текущую строку ввода, печатаем сообщение, восстанавливаем промпт
          process.stdout.write(`\r\x1b[K[${m.time}] ${prefix}: ${m.text}\n`);
          rl.prompt(true);
        }
      }
    } catch {}
  }, 3000);

  // --- Интерактивный режим ---
  console.log("=== Команды ===");
  console.log("  <текст> — отправить в чат");
  console.log("  ss      — скриншот");
  console.log("  mute    — микрофон вкл/выкл");
  console.log("  cam     — камера вкл/выкл");
  console.log("  quit    — выход\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "чат> " });
  rl.prompt();

  rl.on("line", async (line) => {
    const cmd = line.trim();
    if (!cmd) { rl.prompt(); return; }

    try {
      if (cmd === "quit" || cmd === "exit") {
        clearInterval(chatPollInterval);
        rl.close(); await browser.close(); process.exit(0);
      }

      if (cmd === "ss") {
        await showToolbar(page);
        await ss(page, "manual");
        console.log("Скриншот сохранён.");
        rl.prompt(); return;
      }

      if (cmd === "mute") {
        await showToolbar(page);
        await page.waitForTimeout(300);
        const micBtn = page.locator("button.iva-round-button").nth(1);
        if (await micBtn.isVisible({ timeout: 2000 })) {
          await micBtn.click();
          console.log("Микрофон переключён!");
        }
        rl.prompt(); return;
      }

      if (cmd === "cam") {
        await showToolbar(page);
        await page.waitForTimeout(300);
        const camBtn = page.locator("button.iva-round-button").nth(2);
        if (await camBtn.isVisible({ timeout: 2000 })) {
          await camBtn.click();
          console.log("Камера переключена!");
        }
        rl.prompt(); return;
      }

      // Отправка в чат
      await sendChat(page, cmd);
    } catch (e) {
      console.log(`Ошибка: ${e.message.substring(0, 100)}`);
    }
    rl.prompt();
  });

  if (MAX_DURATION > 0) {
    setTimeout(async () => {
      clearInterval(chatPollInterval);
      console.log("\nТаймаут!"); rl.close(); await browser.close(); process.exit(0);
    }, MAX_DURATION * 60 * 1000);
  }

  process.on("SIGINT", async () => {
    clearInterval(chatPollInterval);
    console.log("\nВыход..."); rl.close(); await browser.close(); process.exit(0);
  });
}

async function sendChat(page, text) {
  // Поле "Написать сообщение..."
  const inputSelectors = [
    'input[placeholder*="Написать" i]',
    'input[placeholder*="сообщение" i]',
    "textarea",
    '[contenteditable="true"]',
  ];

  let chatInput = null;
  for (const sel of inputSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1000 })) { chatInput = el; break; }
    } catch {}
  }

  if (!chatInput) {
    // Чат мог закрыться — откроем заново
    await openChat(page);
    for (const sel of inputSelectors) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1500 })) { chatInput = el; break; }
      } catch {}
    }
  }

  if (chatInput) {
    await chatInput.click();
    await chatInput.fill(text);
    await chatInput.press("Enter");
    console.log(`Отправлено: ${text}`);
  } else {
    console.log("Поле чата не найдено. Попробуйте 'ss'.");
  }
}

main().catch((err) => { console.error("Ошибка:", err.message); process.exit(1); });
