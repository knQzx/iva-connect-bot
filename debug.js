const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const MEETING_URL = process.env.MEETING_URL
  || "https://meet.iva360.ru/v2/join?token=t0ec92be2-28e3-45d3-a989-fad9527df471";
const DISPLAY_NAME = process.env.DISPLAY_NAME || "Студент";
const DIR = path.join(__dirname, "screenshots");
fs.mkdirSync(DIR, { recursive: true });

async function ss(page, name) {
  const f = path.join(DIR, `${name}.png`);
  await page.screenshot({ path: f });
  console.log(`  📸 ${name}.png`);
}

(async () => {
  console.log("=== DEBUG v2 — Verify selectors ===");
  console.log(`URL: ${MEETING_URL}`);
  console.log(`Name: ${DISPLAY_NAME}\n`);

  const browser = await chromium.launch({
    headless: false,
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  });
  const page = await (await browser.newContext({
    permissions: ["camera", "microphone"],
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 720 },
  })).newPage();
  page.setDefaultTimeout(15000);

  try {
    // === Join conference (same as meeting.js) ===
    console.log("[1] Opening URL...");
    await page.goto(MEETING_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(4000);

    console.log("[2] Filling name...");
    try {
      const nameInput = page.locator('input[placeholder*="имя" i]').first();
      if (await nameInput.isVisible({ timeout: 1500 }).catch(() => false)) {
        await nameInput.click();
        await nameInput.fill(DISPLAY_NAME);
      }
    } catch {}

    console.log("[3] Clicking Войти...");
    try {
      await page.locator('button:has-text("Войти")').first().click({ force: true, timeout: 5000 });
    } catch {}
    await page.waitForTimeout(5000);

    console.log("[4] Equipment check...");
    try {
      if (await page.locator('text="Проверка оборудования"').first().isVisible({ timeout: 3000 })) {
        await page.locator('button:has-text("Войти")').first().click({ force: true, timeout: 5000 });
        await page.waitForTimeout(8000);
      }
    } catch {}

    console.log("[5] Waiting for conference...");
    await page.waitForTimeout(5000);
    await ss(page, "v2-01-joined");

    // === Test: Show toolbar ===
    console.log("\n[6] Showing toolbar...");
    await page.mouse.move(640, 680);
    await page.waitForTimeout(1000);

    // === Test: Mic toggle via e2e-id ===
    console.log("\n[7] Testing MIC (e2e-id^=conference-control__audio)...");
    const micBtn = page.locator('button[e2e-id^="conference-control__audio"]').first();
    const micVisible = await micBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`  Mic button visible: ${micVisible}`);
    if (micVisible) {
      const micE2e = await micBtn.getAttribute("e2e-id");
      console.log(`  Mic e2e-id: ${micE2e}`);
      await micBtn.click();
      await page.waitForTimeout(1000);
      await ss(page, "v2-02-mic-on");
      const micE2eAfter = await page.locator('button[e2e-id^="conference-control__audio"]').first().getAttribute("e2e-id");
      console.log(`  Mic e2e-id after click: ${micE2eAfter}`);
      // Turn off
      await page.mouse.move(640, 680);
      await page.waitForTimeout(500);
      await page.locator('button[e2e-id^="conference-control__audio"]').first().click();
      await page.waitForTimeout(500);
    }

    // === Test: Cam toggle via e2e-id ===
    console.log("\n[8] Testing CAM (e2e-id^=conference-control__video)...");
    await page.mouse.move(640, 680);
    await page.waitForTimeout(500);
    const camBtn = page.locator('button[e2e-id^="conference-control__video"]').first();
    const camVisible = await camBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`  Cam button visible: ${camVisible}`);
    if (camVisible) {
      const camE2e = await camBtn.getAttribute("e2e-id");
      console.log(`  Cam e2e-id: ${camE2e}`);
      await camBtn.click();
      await page.waitForTimeout(1000);
      await ss(page, "v2-03-cam-on");
      const camE2eAfter = await page.locator('button[e2e-id^="conference-control__video"]').first().getAttribute("e2e-id");
      console.log(`  Cam e2e-id after click: ${camE2eAfter}`);
      // Turn off
      await page.mouse.move(640, 680);
      await page.waitForTimeout(500);
      await page.locator('button[e2e-id^="conference-control__video"]').first().click();
      await page.waitForTimeout(500);
    }

    // === Test: Chat via e2e-id ===
    console.log("\n[9] Testing CHAT (e2e-id=toggle-chat-btn)...");
    await page.mouse.move(640, 680);
    await page.waitForTimeout(500);
    const chatBtn = page.locator('button[e2e-id="toggle-chat-btn"]').first();
    const chatVisible = await chatBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`  Chat button visible: ${chatVisible}`);
    if (chatVisible) {
      await chatBtn.click();
      await page.waitForTimeout(2000);
      await ss(page, "v2-04-chat");
      // Check chat input
      const chatInput = page.locator('input[placeholder*="Написать" i], input[placeholder*="сообщение" i]').first();
      const inputVisible = await chatInput.isVisible({ timeout: 2000 }).catch(() => false);
      console.log(`  Chat input visible: ${inputVisible}`);
      // Close chat
      await page.mouse.move(640, 680);
      await page.waitForTimeout(500);
      await chatBtn.click();
      await page.waitForTimeout(1000);
    }

    // === Test: Participants via e2e-id ===
    console.log("\n[10] Testing PARTICIPANTS (e2e-id=toggle-participants-list-btn)...");
    const partBtn = page.locator('button[e2e-id="toggle-participants-list-btn"]').first();
    const partVisible = await partBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`  Participants button visible: ${partVisible}`);
    if (partVisible) {
      await partBtn.click();
      await page.waitForTimeout(2000);
      await ss(page, "v2-05-participants");

      // Test participant-name selector
      const names = await page.evaluate(() => {
        const els = document.querySelectorAll('[e2e-id="participant-name"]');
        return Array.from(els).map(el => el.textContent?.trim());
      });
      console.log(`  Participants found: ${names.length}`);
      names.forEach((n, i) => console.log(`    ${i + 1}. ${n}`));

      // Close
      const closeBtn = page.locator('button[e2e-id="participants-list-close-btn"]').first();
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click();
        console.log("  Closed via participants-list-close-btn");
      } else {
        await partBtn.click();
        console.log("  Closed via toggle button");
      }
      await page.waitForTimeout(1000);
    }

    // === Test: Polls via e2e-id ===
    console.log("\n[11] Testing POLLS (e2e-id=conference-tab__polls)...");
    const pollBtn = page.locator('button[e2e-id="conference-tab__polls"]').first();
    const pollVisible = await pollBtn.isVisible({ timeout: 2000 }).catch(() => false);
    console.log(`  Polls button visible: ${pollVisible}`);
    if (pollVisible) {
      await pollBtn.click();
      await page.waitForTimeout(2000);
      await ss(page, "v2-06-polls");

      // Test mcu-inquiry-container selector
      const polls = await page.evaluate(() => {
        const result = [];
        const cards = document.querySelectorAll("mcu-inquiry-container");
        cards.forEach((card, index) => {
          const title = card.querySelector(".question-body")?.textContent?.trim() || "";
          const status = card.querySelector(".flat-badge")?.textContent?.trim() || "";
          const hasSingle = !!card.querySelector("mcu-single-choice-answer");
          const hasMultiple = !!card.querySelector("mcu-multiple-choice-answer");
          const hasText = !!card.querySelector("mcu-text-answer");
          let type = "radio";
          if (hasMultiple) type = "checkbox";
          else if (hasText && !hasSingle) type = "text";

          const options = [];
          card.querySelectorAll(".answer").forEach(el => {
            const text = el.textContent?.trim();
            if (text) options.push(text);
          });

          result.push({ index, title, status, type, options });
        });
        return result;
      });

      console.log(`  Polls found: ${polls.length}`);
      polls.forEach(p => {
        console.log(`    ${p.index + 1}. [${p.status}] "${p.title}" (${p.type}) options: [${p.options.join(", ")}]`);
      });

      // Close polls
      await pollBtn.click();
      await page.waitForTimeout(500);
    }

    console.log("\n=== ALL TESTS COMPLETE ===");

  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    await ss(page, "v2-error").catch(() => {});
  } finally {
    await browser.close();
    process.exit(0);
  }
})();
