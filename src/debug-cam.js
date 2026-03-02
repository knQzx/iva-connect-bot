const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const MEETING_URL = process.env.MEETING_URL;
const DISPLAY_NAME = process.env.DISPLAY_NAME || "Студент";
const FAKE_CAMERA = path.join(__dirname, "..", "fake-camera.y4m");
const DIR = path.join(__dirname, "..", "screenshots");

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${FAKE_CAMERA}`,
    ],
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

  // Проверка оборудования
  const hasEq = await page.locator('text="Проверка оборудования"').first().isVisible({ timeout: 5000 }).catch(() => false);
  console.log(`Проверка оборудования видна: ${hasEq}`);

  await page.screenshot({ path: path.join(DIR, "cam-eq.png") });

  if (hasEq) {
    // Дампим ВСЕ кнопки на странице проверки оборудования
    console.log("\n=== Кнопки на странице оборудования ===");
    const btns = await page.locator("button").evaluateAll((els) =>
      els.map((e, i) => {
        const r = e.getBoundingClientRect();
        const svgIcon = e.querySelector("svg-icon");
        return {
          i,
          w: Math.round(r.width),
          h: Math.round(r.height),
          x: Math.round(r.x),
          y: Math.round(r.y),
          cls: e.className?.substring(0, 80),
          text: e.textContent?.trim().substring(0, 40),
          svgIcon: svgIcon?.getAttribute("icon") || "",
          disabled: e.disabled,
        };
      })
    );
    btns.filter(b => b.w > 0).forEach(b => {
      console.log(`  [${b.i}] ${b.w}x${b.h} @(${b.x},${b.y}) cls="${b.cls}" text="${b.text}" svg="${b.svgIcon}" disabled=${b.disabled}`);
    });

    // Ищем конкретно кнопки в зоне превью камеры (по y-координатам)
    console.log("\n=== SVG-icons ===");
    const svgIcons = await page.locator("svg-icon").evaluateAll((els) =>
      els.map(e => ({
        icon: e.getAttribute("icon"),
        cls: e.className?.substring(0, 60),
        parent: e.parentElement?.tagName,
        parentCls: e.parentElement?.className?.substring(0, 60),
        x: Math.round(e.getBoundingClientRect().x),
        y: Math.round(e.getBoundingClientRect().y),
      }))
    );
    svgIcons.forEach((s, i) => {
      console.log(`  [${i}] icon="${s.icon}" cls="${s.cls}" parent=${s.parent} parentCls="${s.parentCls}" @(${s.x},${s.y})`);
    });

    // Кликаем по кнопке камеры (iva-round-button с иконкой камеры/видео)
    console.log("\n=== Пытаемся включить камеру ===");

    // Найдём кнопку с иконкой камеры
    const camIcons = svgIcons.filter(s =>
      s.icon && (s.icon.includes("cam") || s.icon.includes("video") || s.icon.includes("screen"))
    );
    console.log("Иконки камеры:", camIcons);

    // Попробуем кликнуть все round-button
    const roundBtns = btns.filter(b => b.cls?.includes("iva-round-button") && b.w > 0);
    console.log(`\niva-round-button: ${roundBtns.length}`);
    roundBtns.forEach(b => console.log(`  [${b.i}] @(${b.x},${b.y}) svg="${b.svgIcon}"`));

    // Кликаем по кнопке камеры (обычно второй round-button в диалоге)
    for (const b of roundBtns) {
      if (b.svgIcon.includes("cam") || b.svgIcon.includes("video")) {
        console.log(`\nКликаем кнопку камеры [${b.i}]`);
        await page.locator("button").nth(b.i).click();
        await page.waitForTimeout(2000);
        break;
      }
    }

    await page.screenshot({ path: path.join(DIR, "cam-after-toggle.png") });

    // Жмём Войти
    await page.locator('button:has-text("Войти")').first().click({ force: true });
    await page.waitForTimeout(8000);
  }

  // В конференции — проверяем камеру
  await page.mouse.move(640, 680);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(DIR, "cam-in-conf.png") });

  console.log("\n=== Кнопки в конференции ===");
  const confBtns = await page.locator("button").evaluateAll((els) =>
    els.map((e, i) => {
      const r = e.getBoundingClientRect();
      const svgIcon = e.querySelector("svg-icon");
      return {
        i,
        w: Math.round(r.width),
        h: Math.round(r.height),
        x: Math.round(r.x),
        y: Math.round(r.y),
        cls: e.className?.substring(0, 60),
        svgIcon: svgIcon?.getAttribute("icon") || "",
      };
    })
  );
  confBtns.filter(b => b.w > 0 && b.y > 600).forEach(b => {
    console.log(`  [${b.i}] ${b.w}x${b.h} @(${b.x},${b.y}) svg="${b.svgIcon}" cls="${b.cls}"`);
  });

  await browser.close();
  process.exit(0);
})();
