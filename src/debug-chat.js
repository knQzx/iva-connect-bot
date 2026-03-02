const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const MEETING_URL = process.env.MEETING_URL;
const DISPLAY_NAME = process.env.DISPLAY_NAME || "Студент";
const DIR = path.join(__dirname, "..", "screenshots");

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

  // Заходим
  await page.goto(MEETING_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  try { await page.locator("input").first().fill(DISPLAY_NAME); } catch {}
  try { await page.locator('button:has-text("Войти")').first().click({ force: true }); } catch {}
  await page.waitForTimeout(5000);
  try {
    if (await page.locator('text="Проверка оборудования"').first().isVisible({ timeout: 3000 }))
      await page.locator('button:has-text("Войти")').first().click({ force: true });
  } catch {}

  console.log("Ждём конференцию...");
  await page.waitForTimeout(10000);

  // Открываем чат
  await page.mouse.move(640, 680);
  await page.waitForTimeout(500);
  const chatBtn = page.locator("button.iva-icon-button.layout-left-margin_16").first();
  if (await chatBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await chatBtn.click();
  } else {
    const allIconBtns = page.locator("button.iva-icon-button");
    const count = await allIconBtns.count();
    await allIconBtns.nth(count - 1).click();
  }
  await page.waitForTimeout(3000);

  // Отправим тестовое сообщение
  try {
    const input = page.locator('input[placeholder*="сообщение" i], input[placeholder*="Написать" i], textarea').first();
    await input.fill("тест 123");
    await input.press("Enter");
    console.log("Отправили тестовое сообщение");
  } catch (e) {
    console.log("Не удалось отправить:", e.message.substring(0, 100));
  }
  await page.waitForTimeout(2000);

  // Скриншот чата с сообщением
  await page.screenshot({ path: path.join(DIR, "chat-with-msg.png") });

  // Дампим HTML правой панели чата
  const chatHtml = await page.evaluate(() => {
    // Ищем панель чата
    const panels = document.querySelectorAll('[class*="chat"], [class*="panel"], [class*="sidebar"]');
    let html = "";
    panels.forEach(p => { html += `<!-- panel class="${p.className}" -->\n${p.outerHTML}\n\n`; });
    return html || document.body.innerHTML;
  });
  fs.writeFileSync(path.join(DIR, "chat-panel.html"), chatHtml);
  console.log("Chat HTML saved");

  // Дампим структуру сообщений
  console.log("\n=== ЭЛЕМЕНТЫ ЧАТА ===");
  const chatElements = await page.evaluate(() => {
    const result = [];
    // Ищем всё что может быть сообщениями
    const candidates = document.querySelectorAll('[class*="message"], [class*="msg"], [class*="chat-item"], [class*="chat-message"]');
    candidates.forEach((el, i) => {
      result.push({
        i,
        tag: el.tagName.toLowerCase(),
        cls: el.className?.substring(0, 80),
        text: el.textContent?.trim().substring(0, 100),
        children: el.children.length,
      });
    });
    return result;
  });
  chatElements.forEach(e => console.log(`  [${e.i}] <${e.tag}> cls="${e.cls}" text="${e.text}" children=${e.children}`));

  // Полный HTML страницы тоже
  fs.writeFileSync(path.join(DIR, "full-page.html"), await page.content());

  await browser.close();
  process.exit(0);
})();
