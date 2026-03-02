const { chromium } = require("playwright");
const fs = require("fs");
const { FAKE_CAMERA, FAKE_MIC, USE_CAMERA } = require("./camera");

class Meeting {
  constructor(url, displayName, options = {}) {
    this.url = url;
    this.displayName = displayName || "Студент";
    this.headed = options.headed !== undefined ? options.headed : true;
    this.onChatMessage = options.onChatMessage || null;

    this.useFakeCamera = options.useFakeCamera !== undefined ? options.useFakeCamera : USE_CAMERA;

    this.browser = null;
    this.page = null;
    this.connected = false;
    this.micOn = false;
    this.camOn = false;
    this._pollInterval = null;
    this._seenKeys = new Set();
  }

  async join() {
    const launchArgs = [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--no-sandbox",
      "--disable-gpu",
      "--enable-webrtc-hide-local-ips-with-mdns=false",
    ];
    if (this.useFakeCamera) {
      launchArgs.push(`--use-file-for-fake-video-capture=${FAKE_CAMERA}`);
    }
    launchArgs.push(`--use-file-for-fake-audio-capture=${FAKE_MIC}`);

    this.browser = await chromium.launch({
      channel: "chrome",
      headless: !this.headed,
      args: launchArgs,
    });

    const context = await this.browser.newContext({
      permissions: ["camera", "microphone"],
      ignoreHTTPSErrors: true,
      viewport: { width: 1280, height: 720 },
      locale: "ru-RU",
    });
    this.page = await context.newPage();
    this.page.setDefaultTimeout(15000);

    // Intercept RTCPeerConnection via Proxy (preserves class extends)
    await this.page.addInitScript(() => {
      window.__rtcPCs = [];
      const _RTC = RTCPeerConnection;
      RTCPeerConnection = new Proxy(_RTC, {
        construct(target, args, newTarget) {
          const pc = Reflect.construct(target, args, newTarget);
          window.__rtcPCs.push(pc);
          console.log("[WebRTC] PC created");
          pc.addEventListener("iceconnectionstatechange", () => {
            console.log("[WebRTC] ICE:", pc.iceConnectionState);
          });
          pc.addEventListener("connectionstatechange", () => {
            console.log("[WebRTC] conn:", pc.connectionState);
          });
          return pc;
        },
      });
    });

    // 1. Открываем
    await this.page.goto(this.url, { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(4000);

    // 2. Ввод имени — ищем поле ввода имени и заполняем
    try {
      const nameSelectors = [
        'input[formcontrolname="name"]',
        'input[placeholder*="имя" i]',
        'input[placeholder*="name" i]',
        'input[type="text"]',
      ];
      let nameInput = null;
      for (const sel of nameSelectors) {
        const el = this.page.locator(sel).first();
        if (await el.isVisible({ timeout: 1500 }).catch(() => false)) {
          nameInput = el;
          break;
        }
      }
      if (nameInput) {
        await nameInput.click();
        await nameInput.fill(this.displayName);
        await this.page.waitForTimeout(500);
      }
    } catch {}

    // 3. Войти / Join — кликаем первую кнопку (страница имени)
    try {
      const joinBtn = this.page.locator('button:has-text("Войти"), button:has-text("Join")').first();
      await joinBtn.click({ force: true, timeout: 5000 });
    } catch {}
    await this.page.waitForTimeout(5000);

    // 4. Войти / Join — кликаем ещё раз (экран проверки оборудования)
    try {
      const joinBtn2 = this.page.locator('button:has-text("Войти"), button:has-text("Join")').first();
      await joinBtn2.click({ force: true, timeout: 5000 });
    } catch {}
    await this.page.waitForTimeout(8000);

    this.connected = true;
    this.micOn = false;
    this.camOn = false;

    await this.page.waitForTimeout(5000);

    // Открываем чат (не критично если не откроется)
    try {
      await this._openChat();

      // Считываем уже существующие сообщения
      const initial = await this._readChatMessages();
      for (const m of initial) {
        this._seenKeys.add(`${m.author}|${m.text}|${m.time}`);
      }
    } catch {}

    // Запускаем polling
    this._startPolling();
  }

  async disconnect() {
    this._stopPolling();
    this.connected = false;
    if (this.browser) {
      try { await this.browser.close(); } catch {}
      this.browser = null;
      this.page = null;
    }
  }

  async toggleMic() {
    if (!this.page) return;
    await this._showToolbar();
    await this.page.waitForTimeout(300);
    const clicked = await this.page.evaluate(() => {
      const btn = document.querySelector('button[e2e-id^="conference-control__audio"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (clicked) this.micOn = !this.micOn;
  }

  async toggleCam() {
    if (!this.page) return;
    await this._showToolbar();
    await this.page.waitForTimeout(300);
    const clicked = await this.page.evaluate(() => {
      const btn = document.querySelector('button[e2e-id^="conference-control__video"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (clicked) this.camOn = !this.camOn;
  }

  async sendMessage(text) {
    if (!this.page) return;

    const inputSelectors = [
      'input[placeholder*="Написать" i]',
      'input[placeholder*="сообщение" i]',
      "textarea",
      '[contenteditable="true"]',
    ];

    let chatInput = null;
    for (const sel of inputSelectors) {
      try {
        const el = this.page.locator(sel).first();
        if (await el.isVisible({ timeout: 1000 })) { chatInput = el; break; }
      } catch {}
    }

    if (!chatInput) {
      await this._openChat();
      for (const sel of inputSelectors) {
        try {
          const el = this.page.locator(sel).first();
          if (await el.isVisible({ timeout: 1500 })) { chatInput = el; break; }
        } catch {}
      }
    }

    if (chatInput) {
      await chatInput.click();
      await chatInput.fill(text);
      await chatInput.press("Enter");
    }
  }

  async screenshot() {
    if (!this.page) return null;
    try {
      return await this.page.screenshot({ type: "png" });
    } catch {
      return null;
    }
  }

  async getChatMessages() {
    return this._readChatMessages();
  }

  async reloadCamera() {
    if (!this.page || !this.camOn) return;
    // Выключаем и включаем камеру, чтобы браузер перечитал файл
    await this.toggleCam();
    await this.page.waitForTimeout(1000);
    await this.toggleCam();
  }

  async playVoice(wavPath, durationSec) {
    if (!this.page) return;

    const b64 = fs.readFileSync(wavPath).toString("base64");

    if (!this.micOn) await this.toggleMic();

    await this.page.evaluate(async ({ audioB64, dur }) => {
      // Decode base64 → ArrayBuffer
      const bin = atob(audioB64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

      const ctx = new AudioContext({ sampleRate: 48000 });
      const audioBuf = await ctx.decodeAudioData(bytes.buffer);

      const src = ctx.createBufferSource();
      src.buffer = audioBuf;
      const dest = ctx.createMediaStreamDestination();
      src.connect(dest);

      const playTrack = dest.stream.getAudioTracks()[0];

      // Replace audio tracks on all peer connections
      const saved = [];
      for (const pc of (window.__rtcPCs || [])) {
        try {
          for (const sender of pc.getSenders()) {
            if (sender.track?.kind === "audio") {
              saved.push({ sender, orig: sender.track });
              await sender.replaceTrack(playTrack);
            }
          }
        } catch {}
      }

      src.start();
      await new Promise(r => setTimeout(r, dur * 1000 + 300));

      // Restore original tracks
      for (const { sender, orig } of saved) {
        try { await sender.replaceTrack(orig); } catch {}
      }

      src.stop();
      playTrack.stop();
      await ctx.close();
    }, { audioB64: b64, dur: durationSec });

    await this.toggleMic();
  }

  async getParticipants() {
    if (!this.page) return [];
    await this._openParticipants();
    await this.page.waitForTimeout(1500);

    const participants = await this.page.evaluate(() => {
      const result = [];
      // Each participant row has div[e2e-id="participant-name"] with the name text
      const nameEls = document.querySelectorAll('[e2e-id="participant-name"]');
      nameEls.forEach(el => {
        const name = el.textContent?.trim() || "";
        if (name && name.length > 0 && name.length < 100) {
          result.push({ name, role: "" });
        }
      });
      return result;
    });

    await this._closeParticipants();
    return participants;
  }

  // --- Private ---

  async _showToolbar() {
    if (!this.page) return;
    // Trigger toolbar by moving mouse to bottom center
    await this.page.mouse.move(640, 680);
    await this.page.waitForTimeout(500);
  }

  async _clickByE2E(selector) {
    return this.page.evaluate((sel) => {
      const btn = document.querySelector(sel);
      if (btn) { btn.click(); return true; }
      return false;
    }, selector);
  }

  async _openChat() {
    if (!this.page) return;
    await this._showToolbar();
    await this.page.waitForTimeout(500);
    const ok = await this._clickByE2E('button[e2e-id="toggle-chat-btn"]');
    await this.page.waitForTimeout(2000);
  }

  async _openParticipants() {
    if (!this.page) return;
    await this._showToolbar();
    await this._clickByE2E('button[e2e-id="toggle-participants-list-btn"]');
    await this.page.waitForTimeout(1500);
  }

  async _closeParticipants() {
    if (!this.page) return;
    const closed = await this._clickByE2E('button[e2e-id="participants-list-close-btn"]');
    if (!closed) {
      await this._clickByE2E('button[e2e-id="toggle-participants-list-btn"]');
    }
    await this.page.waitForTimeout(500);
  }

  async _readChatMessages() {
    if (!this.page) return [];
    try {
      return await this.page.evaluate(() => {
        const msgs = [];
        const wrappers = document.querySelectorAll("div.message-bubble__wrapper");
        wrappers.forEach(w => {
          const bubble = w.querySelector("div.message-bubble");
          if (!bubble) return;
          const own = bubble.classList.contains("own");
          const authorEl = bubble.querySelector(".message-bubble__author, .message-bubble__name");
          const textEl = bubble.querySelector(".message-text");
          const timeEl = bubble.querySelector(".message-bubble__date");

          let author = authorEl?.textContent?.trim() || "";
          let text = "";
          let time = timeEl?.textContent?.trim() || "";

          if (textEl) {
            const clone = textEl.cloneNode(true);
            const dateInText = clone.querySelector(".message-bubble__bottom-info-wrapper");
            if (dateInText) dateInText.remove();
            text = clone.textContent?.trim() || "";
          }

          if (!text && !author) {
            const full = bubble.textContent?.trim() || "";
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
    } catch {
      return [];
    }
  }

  // --- Polls ---

  async _openPolls() {
    if (!this.page) return;
    await this._showToolbar();
    await this._clickByE2E('button[e2e-id="conference-tab__polls"]');
    await this.page.waitForTimeout(1500);
  }

  async _closePolls() {
    if (!this.page) return;
    await this._clickByE2E('button[e2e-id="conference-tab__polls"]');
    await this.page.waitForTimeout(500);
  }

  async getPolls() {
    if (!this.page) return [];
    await this._openPolls();
    await this.page.waitForTimeout(1500);

    const polls = await this.page.evaluate(() => {
      const result = [];
      const cards = document.querySelectorAll("mcu-inquiry-container");

      cards.forEach((card, index) => {
        const titleEl = card.querySelector(".question-body");
        const title = titleEl?.textContent?.trim() || `Опрос ${index + 1}`;

        const statusEl = card.querySelector(".flat-badge");
        const status = statusEl?.textContent?.trim() || "";

        // Detect type by answer component
        const hasSingle = !!card.querySelector("mcu-single-choice-answer");
        const hasMultiple = !!card.querySelector("mcu-multiple-choice-answer");
        const hasText = !!card.querySelector("mcu-text-answer");

        let type = "radio";
        if (hasMultiple) type = "checkbox";
        else if (hasText && !hasSingle) type = "text";

        // Extract options
        const options = [];
        const answerEls = card.querySelectorAll(".answer");
        answerEls.forEach(el => {
          const text = el.textContent?.trim();
          if (text && text.length > 0 && text.length < 200) {
            options.push(text);
          }
        });

        // Check if already answered (submit button hidden or "passed-message" visible)
        const answered = !!card.querySelector(".passed-message")
          || !card.querySelector('button:not([disabled])');

        result.push({ index, title, status, type, options, answered });
      });

      return result;
    });

    await this._closePolls();
    return polls;
  }

  async answerPoll(pollIndex, answers) {
    if (!this.page) return false;
    await this._openPolls();
    await this.page.waitForTimeout(1500);

    try {
      const cards = this.page.locator("mcu-inquiry-container");
      const count = await cards.count();
      if (pollIndex >= count) {
        await this._closePolls();
        return false;
      }

      const card = cards.nth(pollIndex);

      if (typeof answers === "string") {
        // Text answer — mcu-text-answer contains a textarea or input
        const input = card.locator("mcu-text-answer textarea, mcu-text-answer input").first();
        if (await input.isVisible({ timeout: 2000 }).catch(() => false)) {
          await input.click();
          await input.fill(answers);
        }
      } else if (Array.isArray(answers)) {
        // Radio: click iva-radio-button by index
        const radioEls = card.locator("iva-radio-button");
        const radioCount = await radioEls.count();

        if (radioCount > 0) {
          for (const idx of answers) {
            if (idx < radioCount) {
              await radioEls.nth(idx).click();
              await this.page.waitForTimeout(300);
            }
          }
        } else {
          // Checkbox: click iva-checkbox by index
          const checkEls = card.locator("iva-checkbox");
          for (const idx of answers) {
            const chk = checkEls.nth(idx);
            if (await chk.isVisible({ timeout: 1000 }).catch(() => false)) {
              await chk.click();
              await this.page.waitForTimeout(300);
            }
          }
        }
      }

      // Click submit button "Ответить"
      await this.page.waitForTimeout(500);
      const submitBtn = card.locator('button:has-text("Ответить")').first();
      if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await submitBtn.click();
        await this.page.waitForTimeout(1000);
      }

      await this._closePolls();
      return true;
    } catch {
      await this._closePolls();
      return false;
    }
  }

  // --- Polling ---

  _startPolling() {
    this._pollInterval = setInterval(async () => {
      if (!this.connected || !this.page) return;

      // Chat polling only — polls are fetched on-demand via getPolls()
      try {
        const msgs = await this._readChatMessages();
        for (const m of msgs) {
          const key = `${m.author}|${m.text}|${m.time}`;
          if (!this._seenKeys.has(key) && !m.own) {
            this._seenKeys.add(key);
            if (this.onChatMessage) {
              this.onChatMessage(m);
            }
          }
        }
      } catch {}
    }, 3000);
  }

  _stopPolling() {
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
  }
}

module.exports = Meeting;
