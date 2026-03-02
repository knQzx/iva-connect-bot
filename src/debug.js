const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const MEETING_URL = process.env.MEETING_URL;
const DISPLAY_NAME = process.env.DISPLAY_NAME || "Студент";
const DIR = path.join(__dirname, "..", "screenshots");
fs.mkdirSync(DIR, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const page = await (await browser.newContext({
    permissions: ["camera", "microphone"],
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
  })).newPage();
  page.setDefaultTimeout(15000);

  // 1. Открываем
  await page.goto(MEETING_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  // 2. Вводим имя
  try {
    await page.locator("input").first().fill(DISPLAY_NAME);
    console.log("Имя введено");
  } catch {}

  // 3. Войти
  try {
    await page.locator('button:has-text("Войти")').first().click({ force: true });
    console.log("Войти 1");
  } catch {}
  await page.waitForTimeout(5000);

  // 4. Проверка оборудования
  try {
    if (await page.locator('text="Проверка оборудования"').first().isVisible({ timeout: 3000 })) {
      await page.locator('button:has-text("Войти")').first().click({ force: true });
      console.log("Войти 2");
    }
  } catch {}

  // 5. Ждём дольше — тулбар может рендериться позже
  console.log("Ждём 15 сек чтобы всё загрузилось...");
  await page.waitForTimeout(15000);

  // 6. Двигаем мышь к низу экрана чтобы тулбар появился
  console.log("Двигаем мышь вниз...");
  await page.mouse.move(640, 700);
  await page.waitForTimeout(2000);
  await page.mouse.move(640, 710);
  await page.waitForTimeout(1000);

  await page.screenshot({ path: path.join(DIR, "debug-final.png") });
  console.log("Скриншот с тулбаром: debug-final.png");

  // 7. Дамп ВСЕХ элементов
  console.log("\n=== ВСЕ КНОПКИ ===");
  const btns = await page.locator("button").evaluateAll((els) =>
    els.map((e, i) => {
      const r = e.getBoundingClientRect();
      return {
        i,
        text: e.textContent?.trim().substring(0, 40),
        ariaLabel: e.getAttribute("aria-label"),
        title: e.getAttribute("title"),
        cls: e.className?.substring(0, 80),
        w: Math.round(r.width),
        h: Math.round(r.height),
        x: Math.round(r.x),
        y: Math.round(r.y),
        display: getComputedStyle(e).display,
        opacity: getComputedStyle(e).opacity,
      };
    })
  );
  btns.forEach(b => {
    if (b.w > 0 && b.h > 0) {
      console.log(`  [${b.i}] ${b.w}x${b.h} @(${b.x},${b.y}) label="${b.ariaLabel}" title="${b.title}" text="${b.text}" cls="${b.cls}" display=${b.display} opacity=${b.opacity}`);
    }
  });

  // Все кастомные Angular компоненты
  console.log("\n=== CUSTOM ELEMENTS ===");
  const customs = await page.evaluate(() => {
    const all = document.querySelectorAll("*");
    const set = new Set();
    all.forEach(e => { if (e.tagName.includes("-")) set.add(e.tagName.toLowerCase()); });
    return [...set].sort();
  });
  customs.forEach(c => console.log(`  ${c}`));

  // HTML
  const html = await page.content();
  fs.writeFileSync(path.join(DIR, "debug.html"), html);
  console.log("\nHTML -> screenshots/debug.html");

  await browser.close();
  process.exit(0);
})();
