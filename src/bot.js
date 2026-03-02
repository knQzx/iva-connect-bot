require("dotenv").config();
const { Telegraf, Markup } = require("telegraf");
const path = require("path");
const fs = require("fs");
const Meeting = require("./meeting");
const {
  FAKE_CAMERA, USE_CAMERA, VIDEOS_DIR, DEFAULT_Y4M,
  convertToY4m, switchActiveVideo, restoreDefaultVideo,
  loadVideoMeta, saveVideoMeta, downloadFile,
  convertToWav,
} = require("./camera");
const { solvePoll } = require("./ai");

// --- Config ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const DISPLAY_NAME = process.env.DISPLAY_NAME || "Студент";
const HEADED = process.env.HEADED !== "false";
const OWNER_ID = parseInt(process.env.OWNER_ID);
const MSGS_PER_PAGE = 5;
const MAX_VIDEOS = 10;
const MAX_VIDEO_DURATION = 10;

// Poll state: checkbox selections and text mode per user
const checkboxSelections = new Map(); // key: `${sessionId}:${pollIdx}` → Set of option indices
const textPollMode = new Map(); // key: chatId → { sessionId, pollIdx }
const aiPendingAnswers = new Map(); // key: `${sessionId}:${pollIdx}` → { answer, reasoning }

if (!BOT_TOKEN) { console.error("BOT_TOKEN не задан"); process.exit(1); }
if (!OWNER_ID) { console.error("OWNER_ID не задан"); process.exit(1); }

const bot = new Telegraf(BOT_TOKEN);

// --- Middleware: только владелец ---
bot.use((ctx, next) => {
  if (ctx.from?.id !== OWNER_ID) return;
  return next();
});

// --- State ---
const sessions = new Map();
let nextSessionId = 1;
let videoMeta = loadVideoMeta();

// ============================================================
//  HELPERS
// ============================================================

function statusText(meeting) {
  const micIcon = meeting.micOn ? "🟢" : "🔴";
  const camIcon = meeting.camOn ? "🟢" : "🔴";
  const micLabel = meeting.micOn ? "включён" : "выключен";
  const camLabel = meeting.camOn ? "включена" : "выключена";

  let text = "🟢 Подключено\n\n";
  text += `🎤 Микрофон: ${micIcon} ${micLabel}\n`;
  text += `📹 Камера: ${camIcon} ${camLabel}`;

  // Активное видео
  if (videoMeta.activeId !== null) {
    const v = videoMeta.videos.find(x => x.id === videoMeta.activeId);
    if (v) text += `\n🎥 Видео: ${v.name}`;
  } else if (USE_CAMERA) {
    text += "\n🎥 Видео: стандарт";
  }

  return text;
}

function controlKeyboard(id, meeting) {
  const micLabel = meeting.micOn
    ? "🎤 🟢 Микрофон"
    : "🎤 🔴 Микрофон";
  const camLabel = meeting.camOn
    ? "📹 🟢 Камера"
    : "📹 🔴 Камера";

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(micLabel, `mic:${id}`),
      Markup.button.callback(camLabel, `cam:${id}`),
    ],
    [
      Markup.button.callback("💬 Чат", `chat:${id}:last`),
      Markup.button.callback("👥 Участники", `ppl:${id}:0`),
    ],
    [
      Markup.button.callback("📋 Опросы", `poll:${id}`),
      Markup.button.callback("🎥 Видео", `vid:${id}`),
    ],
    [
      Markup.button.callback("📸 Скриншот", `ss:${id}`),
      Markup.button.callback("🔄 Панель", `ref:${id}`),
    ],
    [
      Markup.button.callback("❌ Отключиться", `dc:${id}`),
    ],
  ]);
}

// --- Confirmation keyboards ---

function confirmMicKeyboard(id) {
  return Markup.inlineKeyboard([[
    Markup.button.callback("✅ Да, включить", `micy:${id}`),
    Markup.button.callback("❌ Отмена", `back:${id}`),
  ]]);
}

function confirmCamKeyboard(id) {
  return Markup.inlineKeyboard([[
    Markup.button.callback("✅ Да, включить", `camy:${id}`),
    Markup.button.callback("❌ Отмена", `back:${id}`),
  ]]);
}

// --- Chat ---

function formatChatPage(messages, page, totalPages) {
  if (messages.length === 0) return "💬 Чат пуст";
  let text = `💬 Чат  —  стр. ${page + 1} из ${totalPages}\n`;
  text += "─".repeat(24) + "\n";
  for (const m of messages) {
    const author = m.own ? "Вы" : (m.author || "???");
    const time = m.time ? `[${m.time}]` : "";
    text += `${time} ${author}:\n${m.text}\n\n`;
  }
  return text.trimEnd();
}

function chatKeyboard(id, page, totalPages) {
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("◀️", `chatp:${id}:${page - 1}`));
  nav.push(Markup.button.callback(`${page + 1}/${totalPages}`, "noop"));
  if (page < totalPages - 1) nav.push(Markup.button.callback("▶️", `chatp:${id}:${page + 1}`));
  return Markup.inlineKeyboard([
    nav,
    [
      Markup.button.callback("🔄 Обновить", `chat:${id}:${page}`),
      Markup.button.callback("↩️ Назад", `back:${id}`),
    ],
  ]);
}

// --- Participants ---

function formatParticipantsPage(participants, page, totalPages) {
  if (participants.length === 0) return "👥 Нет участников";
  let text = `👥 Участники  —  стр. ${page + 1} из ${totalPages}\n`;
  text += "─".repeat(24) + "\n";
  participants.forEach((p, i) => {
    const num = page * MSGS_PER_PAGE + i + 1;
    const role = p.role ? `  (${p.role})` : "";
    text += `${num}. ${p.name}${role}\n`;
  });
  return text.trimEnd();
}

function participantsKeyboard(id, page, totalPages) {
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("◀️", `pplp:${id}:${page - 1}`));
  nav.push(Markup.button.callback(`${page + 1}/${totalPages}`, "noop"));
  if (page < totalPages - 1) nav.push(Markup.button.callback("▶️", `pplp:${id}:${page + 1}`));
  return Markup.inlineKeyboard([
    nav,
    [
      Markup.button.callback("🔄 Обновить", `ppl:${id}:${page}`),
      Markup.button.callback("↩️ Назад", `back:${id}`),
    ],
  ]);
}

// --- Polls ---

function formatPollList(polls, sessionId) {
  if (polls.length === 0) return "📋 Нет опросов";
  let text = `📋 Опросы (${polls.length})\n`;
  text += "─".repeat(24) + "\n";
  polls.forEach((p, i) => {
    const icon = p.answered ? "✅" : "🟢";
    text += `${icon} ${i + 1}. ${p.title}\n`;
  });
  return text.trimEnd();
}

function pollListKeyboard(sessionId, polls) {
  const rows = [];
  // Number buttons for each poll (up to 5 per row)
  const btnRow = [];
  polls.forEach((p, i) => {
    btnRow.push(Markup.button.callback(`${i + 1}`, `polld:${sessionId}:${i}`));
    if (btnRow.length === 5) {
      rows.push([...btnRow]);
      btnRow.length = 0;
    }
  });
  if (btnRow.length > 0) rows.push([...btnRow]);

  const hasUnanswered = polls.some(p => !p.answered);
  if (hasUnanswered) {
    rows.push([Markup.button.callback("🤖 Решить всё с AI", `paia:${sessionId}`)]);
  }

  rows.push([
    Markup.button.callback("🔄", `poll:${sessionId}`),
    Markup.button.callback("↩️ Назад", `back:${sessionId}`),
  ]);
  return Markup.inlineKeyboard(rows);
}

function formatPollDetail(poll) {
  const typeLabel = poll.type === "checkbox" ? " (несколько ответов)" :
    poll.type === "text" ? " (текстовый)" : "";
  let text = `📋 Опрос${typeLabel}\n`;
  text += `❓ ${poll.title}\n\n`;

  if (poll.type === "text") {
    text += "✏️ Ответьте текстом (reply)";
  } else {
    poll.options.forEach((opt, i) => {
      const mark = poll.type === "checkbox" ? "☐" : `${i + 1}.`;
      text += `${mark} ${i + 1}. ${opt}\n`;
    });
  }

  if (poll.answered) text += "\n✅ Вы уже ответили";
  return text.trimEnd();
}

function pollDetailKeyboard(sessionId, pollIdx, poll, selectedSet) {
  const rows = [];

  if (poll.type === "radio") {
    const btnRow = [];
    poll.options.forEach((_, i) => {
      btnRow.push(Markup.button.callback(`${i + 1}`, `prad:${sessionId}:${pollIdx}:${i}`));
      if (btnRow.length === 5) {
        rows.push([...btnRow]);
        btnRow.length = 0;
      }
    });
    if (btnRow.length > 0) rows.push([...btnRow]);
  } else if (poll.type === "checkbox") {
    const btnRow = [];
    poll.options.forEach((_, i) => {
      const mark = selectedSet && selectedSet.has(i) ? "✅" : "";
      btnRow.push(Markup.button.callback(`${mark}${i + 1}`, `pchk:${sessionId}:${pollIdx}:${i}`));
      if (btnRow.length === 5) {
        rows.push([...btnRow]);
        btnRow.length = 0;
      }
    });
    if (btnRow.length > 0) rows.push([...btnRow]);
    rows.push([Markup.button.callback("✅ Отправить", `psub:${sessionId}:${pollIdx}`)]);
  } else if (poll.type === "text") {
    rows.push([Markup.button.callback("✏️ Ответить текстом", `ptxt:${sessionId}:${pollIdx}`)]);
  }

  if (!poll.answered) {
    rows.push([Markup.button.callback("🤖 Решить с AI", `pai:${sessionId}:${pollIdx}`)]);
  }

  rows.push([
    Markup.button.callback("🔄", `polld:${sessionId}:${pollIdx}`),
    Markup.button.callback("↩️ Назад", `poll:${sessionId}`),
  ]);
  return Markup.inlineKeyboard(rows);
}

async function sendNewPollNotification(chatId, sessionId, poll) {
  const typeLabel = poll.type === "checkbox" ? " (несколько ответов)" :
    poll.type === "text" ? " (текстовый)" : "";
  let text = `📋 Новый опрос!${typeLabel}\n`;
  text += `❓ ${poll.title}\n\n`;

  const rows = [];
  if (poll.type === "text") {
    text += "✏️ Ответьте текстом";
    rows.push([Markup.button.callback("✏️ Ответить", `ptxt:${sessionId}:${poll.index}`)]);
  } else {
    poll.options.forEach((opt, i) => {
      const mark = poll.type === "checkbox" ? "☐" : "";
      text += `${mark} ${i + 1}. ${opt}\n`;
    });

    if (poll.type === "radio") {
      const btnRow = [];
      poll.options.forEach((_, i) => {
        btnRow.push(Markup.button.callback(`${i + 1}`, `prad:${sessionId}:${poll.index}:${i}`));
        if (btnRow.length === 5) {
          rows.push([...btnRow]);
          btnRow.length = 0;
        }
      });
      if (btnRow.length > 0) rows.push([...btnRow]);
    } else {
      const btnRow = [];
      poll.options.forEach((_, i) => {
        btnRow.push(Markup.button.callback(`${i + 1}`, `pchk:${sessionId}:${poll.index}:${i}`));
        if (btnRow.length === 5) {
          rows.push([...btnRow]);
          btnRow.length = 0;
        }
      });
      if (btnRow.length > 0) rows.push([...btnRow]);
      rows.push([Markup.button.callback("✅ Отправить", `psub:${sessionId}:${poll.index}`)]);
    }
  }

  rows.push([Markup.button.callback("🤖 Решить с AI", `pai:${sessionId}:${poll.index}`)]);

  await bot.telegram.sendMessage(chatId, text.trimEnd(), Markup.inlineKeyboard(rows));
}

// --- Video ---

function videoText() {
  const count = videoMeta.videos.length;
  let text = `🎥 Видео (${count}/${MAX_VIDEOS})\n`;
  text += "─".repeat(24) + "\n";

  const hasDefault = USE_CAMERA || fs.existsSync(DEFAULT_Y4M);
  if (hasDefault) {
    const mark = videoMeta.activeId === null ? "✅" : "▫️";
    text += `${mark} 📌 Стандарт\n`;
  }

  videoMeta.videos.forEach((v, i) => {
    const mark = videoMeta.activeId === v.id ? "✅" : "▫️";
    const dur = v.duration ? ` (${v.duration}с)` : "";
    text += `${mark} ${i + 1}. ${v.name}${dur}\n`;
  });

  text += `\nОтправь видео (до ${MAX_VIDEO_DURATION}с) чтобы добавить.`;
  return text;
}

function videoKeyboard(sessionId) {
  const rows = [];
  const hasDefault = USE_CAMERA || fs.existsSync(DEFAULT_Y4M);

  // Кнопки выбора
  const selectRow1 = [];
  const selectRow2 = [];

  if (hasDefault) {
    const label = videoMeta.activeId === null ? "📌 ✅" : "📌";
    selectRow1.push(Markup.button.callback(label, `vdef:${sessionId}`));
  }

  videoMeta.videos.forEach((v, i) => {
    const label = videoMeta.activeId === v.id ? `${i + 1} ✅` : `${i + 1}`;
    const btn = Markup.button.callback(label, `vsel:${v.id}:${sessionId}`);
    if (selectRow1.length < 5) selectRow1.push(btn);
    else selectRow2.push(btn);
  });

  if (selectRow1.length > 0) rows.push(selectRow1);
  if (selectRow2.length > 0) rows.push(selectRow2);

  // Предпросмотр активного видео
  const activeVideo = videoMeta.activeId !== null
    ? videoMeta.videos.find(v => v.id === videoMeta.activeId)
    : null;
  if (activeVideo?.rawFilename) {
    rows.push([Markup.button.callback("👁 Предпросмотр", `vview:${sessionId}`)]);
  }

  // Нижний ряд
  const bottom = [];
  if (videoMeta.activeId !== null) {
    bottom.push(Markup.button.callback("🗑 Удалить", `vdel:${videoMeta.activeId}:${sessionId}`));
  }
  bottom.push(Markup.button.callback("🔄", `vid:${sessionId}`));
  if (sessionId > 0) {
    bottom.push(Markup.button.callback("↩️ Назад", `back:${sessionId}`));
  } else {
    bottom.push(Markup.button.callback("✖️ Закрыть", "vclose"));
  }
  rows.push(bottom);

  return Markup.inlineKeyboard(rows);
}

// --- Session lookup ---

function findSessionById(id) {
  return sessions.get(id) || null;
}

function findSessionByControlMsg(chatId, msgId) {
  for (const [id, s] of sessions) {
    if (s.chatId === chatId && s.controlMsgId === msgId) return { id, ...s };
  }
  return null;
}

function getActiveSessions(chatId) {
  const result = [];
  for (const [id, s] of sessions) {
    if (s.chatId === chatId && s.meeting.connected) result.push({ id, ...s });
  }
  return result;
}

// ============================================================
//  COMMANDS
// ============================================================

bot.start((ctx) => {
  ctx.reply(
    "👋 Привет! Я бот для IVA Connect.\n\n" +
    "🔗 Отправь ссылку — подключусь к мероприятию\n" +
    "🎬 Отправь видео (до 10с) — добавлю в камеру\n\n" +
    "/panel — панель мероприятия\n" +
    "/videos — управление видео",
    Markup.inlineKeyboard([
      [Markup.button.callback("🎥 Управление видео", "videos")],
    ])
  );
});

bot.command("panel", async (ctx) => {
  const chatId = ctx.chat.id;
  const active = getActiveSessions(chatId);

  if (active.length === 0) {
    return ctx.reply("Нет активных мероприятий.");
  }

  for (const s of active) {
    const msg = await ctx.reply(
      statusText(s.meeting),
      controlKeyboard(s.id, s.meeting)
    );

    const session = sessions.get(s.id);
    if (session) {
      // Убираем кнопки со старого сообщения
      try {
        await bot.telegram.editMessageText(
          chatId, session.controlMsgId, null,
          "📋 Панель перемещена ↓"
        );
      } catch {}
      session.controlMsgId = msg.message_id;
    }
  }
});

bot.command("videos", async (ctx) => {
  await ctx.reply(videoText(), videoKeyboard(0));
});

bot.action("videos", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  await ctx.reply(videoText(), videoKeyboard(0));
});

// ============================================================
//  LINK HANDLER
// ============================================================

bot.hears(/https?:\/\/[^\s]*iva360\.ru[^\s]*/i, async (ctx) => {
  const url = ctx.message.text.match(/https?:\/\/[^\s]*iva360\.ru[^\s]*/i)[0];
  const chatId = ctx.chat.id;
  const id = nextSessionId++;

  const statusMsg = await ctx.reply("⏳ Подключаюсь к мероприятию...");
  const controlMsgId = statusMsg.message_id;

  const hasVideos = videoMeta.videos.length > 0;
  const meeting = new Meeting(url, DISPLAY_NAME, {
    headed: HEADED,
    useFakeCamera: USE_CAMERA || hasVideos,
    onChatMessage: (msg) => {
      const prefix = msg.author || "???";
      bot.telegram.sendMessage(chatId, `💬 ${prefix}: ${msg.text}`).catch(() => {});
    },
  });

  sessions.set(id, { meeting, controlMsgId, chatId });

  try {
    await meeting.join();
    await bot.telegram.editMessageText(
      chatId, controlMsgId, null,
      statusText(meeting),
      controlKeyboard(id, meeting)
    );
  } catch (err) {
    await bot.telegram.editMessageText(
      chatId, controlMsgId, null,
      `❌ Ошибка подключения: ${err.message.substring(0, 200)}`
    ).catch(() => {});
    await meeting.disconnect();
    sessions.delete(id);
  }
});

// ============================================================
//  VIDEO UPLOAD
// ============================================================

async function handleVideoUpload(ctx) {
  const video = ctx.message.video || ctx.message.video_note;
  if (!video) return;

  if (video.duration > MAX_VIDEO_DURATION) {
    return ctx.reply(`❌ Видео слишком длинное (${video.duration}с). Максимум ${MAX_VIDEO_DURATION}с.`);
  }

  if (videoMeta.videos.length >= MAX_VIDEOS) {
    return ctx.reply(`❌ Максимум ${MAX_VIDEOS} видео. Удали одно перед добавлением.`);
  }

  const msg = await ctx.reply("⏳ Загружаю и конвертирую видео...");

  try {
    const videoId = videoMeta.nextId++;
    const rawPath = path.join(VIDEOS_DIR, `${videoId}.mp4`);
    const y4mPath = path.join(VIDEOS_DIR, `${videoId}.y4m`);

    // Скачиваем
    const fileLink = await ctx.telegram.getFileLink(video.file_id);
    downloadFile(fileLink.href, rawPath);

    // Конвертируем
    convertToY4m(rawPath, y4mPath);

    const name = `Видео ${videoId}`;
    videoMeta.videos.push({
      id: videoId, name,
      filename: `${videoId}.y4m`,
      rawFilename: `${videoId}.mp4`,
      duration: video.duration,
    });

    // Первое видео → делаем активным
    if (videoMeta.activeId === null && !USE_CAMERA) {
      videoMeta.activeId = videoId;
      switchActiveVideo(y4mPath);
    }

    saveVideoMeta(videoMeta);

    const size = (fs.statSync(y4mPath).size / 1024 / 1024).toFixed(1);
    await bot.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      `✅ ${name} добавлено (${video.duration}с, ${size}MB)`
    );

    // Предпросмотр + панель видео
    await ctx.replyWithVideo({ source: rawPath }, { caption: `🎬 ${name}` });
    await ctx.reply(videoText(), videoKeyboard(0));
  } catch (err) {
    await bot.telegram.editMessageText(
      ctx.chat.id, msg.message_id, null,
      `❌ Ошибка: ${err.message.substring(0, 200)}`
    ).catch(() => {});
  }
}

bot.on("video", handleVideoUpload);
bot.on("video_note", handleVideoUpload);

// ============================================================
//  INLINE BUTTONS — MIC / CAM
// ============================================================

bot.action(/^mic:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена. /panel"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery(); } catch {}

  if (session.meeting.micOn) {
    // Выключаем сразу
    await session.meeting.toggleMic();
    try {
      await ctx.editMessageText(statusText(session.meeting), controlKeyboard(id, session.meeting));
    } catch {}
  } else {
    // Подтверждение включения
    try {
      await ctx.editMessageText("⚠️ Включить микрофон?", confirmMicKeyboard(id));
    } catch {}
  }
});

bot.action(/^micy:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery("Включаю..."); } catch {}
  await session.meeting.toggleMic();
  try {
    await ctx.editMessageText(statusText(session.meeting), controlKeyboard(id, session.meeting));
  } catch {}
});

bot.action(/^cam:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена. /panel"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery(); } catch {}

  if (session.meeting.camOn) {
    // Выключаем сразу
    await session.meeting.toggleCam();
    try {
      await ctx.editMessageText(statusText(session.meeting), controlKeyboard(id, session.meeting));
    } catch {}
  } else {
    // Подтверждение включения
    try {
      await ctx.editMessageText("⚠️ Включить камеру?", confirmCamKeyboard(id));
    } catch {}
  }
});

bot.action(/^camy:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery("Включаю..."); } catch {}
  await session.meeting.toggleCam();
  try {
    await ctx.editMessageText(statusText(session.meeting), controlKeyboard(id, session.meeting));
  } catch {}
});

// ============================================================
//  INLINE BUTTONS — SCREENSHOT / DISCONNECT
// ============================================================

bot.action(/^ss:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery("Делаю скриншот..."); } catch {}
  try {
    const buf = await session.meeting.screenshot();
    if (buf) {
      await ctx.replyWithPhoto({ source: buf, filename: "screenshot.png" });
    } else {
      await ctx.reply("Не удалось сделать скриншот.");
    }
  } catch {}
});

bot.action(/^dc:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const session = findSessionById(id);
  if (!session) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery("Отключаюсь..."); } catch {}
  try {
    await session.meeting.disconnect();
    await ctx.editMessageText("🔴 Отключено");
  } catch {
    try { await ctx.editMessageText("🔴 Отключено"); } catch {}
  }
  sessions.delete(id);
});

// ============================================================
//  INLINE BUTTONS — REFRESH PANEL
// ============================================================

bot.action(/^ref:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена. /panel"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery(); } catch {}

  // Новое сообщение с панелью
  const msg = await ctx.reply(
    statusText(session.meeting),
    controlKeyboard(id, session.meeting)
  );

  // Старое → без кнопок
  try { await ctx.editMessageText("📋 Панель перемещена ↓"); } catch {}
  session.controlMsgId = msg.message_id;
});

// ============================================================
//  INLINE BUTTONS — CHAT
// ============================================================

bot.action(/^chat:(\d+):(.+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const pageArg = ctx.match[2];
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery(); } catch {}
  try {
    const all = await session.meeting.getChatMessages();
    const totalPages = Math.max(1, Math.ceil(all.length / MSGS_PER_PAGE));
    const page = pageArg === "last" ? totalPages - 1 : Math.min(parseInt(pageArg) || 0, totalPages - 1);
    const slice = all.slice(page * MSGS_PER_PAGE, (page + 1) * MSGS_PER_PAGE);
    await ctx.editMessageText(formatChatPage(slice, page, totalPages), chatKeyboard(id, page, totalPages));
  } catch {}
});

bot.action(/^chatp:(\d+):(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const page = parseInt(ctx.match[2]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery(); } catch {}
  try {
    const all = await session.meeting.getChatMessages();
    const totalPages = Math.max(1, Math.ceil(all.length / MSGS_PER_PAGE));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const slice = all.slice(safePage * MSGS_PER_PAGE, (safePage + 1) * MSGS_PER_PAGE);
    await ctx.editMessageText(formatChatPage(slice, safePage, totalPages), chatKeyboard(id, safePage, totalPages));
  } catch {}
});

// ============================================================
//  INLINE BUTTONS — PARTICIPANTS
// ============================================================

bot.action(/^ppl:(\d+):(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const page = parseInt(ctx.match[2]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery("Загружаю..."); } catch {}
  try {
    const all = await session.meeting.getParticipants();
    const totalPages = Math.max(1, Math.ceil(all.length / MSGS_PER_PAGE));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const slice = all.slice(safePage * MSGS_PER_PAGE, (safePage + 1) * MSGS_PER_PAGE);
    await ctx.editMessageText(formatParticipantsPage(slice, safePage, totalPages), participantsKeyboard(id, safePage, totalPages));
  } catch {}
});

bot.action(/^pplp:(\d+):(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const page = parseInt(ctx.match[2]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery(); } catch {}
  try {
    const all = await session.meeting.getParticipants();
    const totalPages = Math.max(1, Math.ceil(all.length / MSGS_PER_PAGE));
    const safePage = Math.min(Math.max(page, 0), totalPages - 1);
    const slice = all.slice(safePage * MSGS_PER_PAGE, (safePage + 1) * MSGS_PER_PAGE);
    await ctx.editMessageText(formatParticipantsPage(slice, safePage, totalPages), participantsKeyboard(id, safePage, totalPages));
  } catch {}
});

// ============================================================
//  INLINE BUTTONS — POLLS
// ============================================================

// Poll list
bot.action(/^poll:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery("Загружаю..."); } catch {}
  try {
    const polls = await session.meeting.getPolls();
    await ctx.editMessageText(formatPollList(polls, id), pollListKeyboard(id, polls));
  } catch {}
});

// Poll detail
bot.action(/^polld:(\d+):(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const pollIdx = parseInt(ctx.match[2]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery(); } catch {}
  try {
    const polls = await session.meeting.getPolls();
    if (pollIdx >= polls.length) {
      await ctx.editMessageText("Опрос не найден", Markup.inlineKeyboard([
        [Markup.button.callback("↩️ Назад", `poll:${id}`)],
      ]));
      return;
    }
    const poll = polls[pollIdx];
    const selKey = `${id}:${pollIdx}`;
    const selected = checkboxSelections.get(selKey) || new Set();
    await ctx.editMessageText(formatPollDetail(poll), pollDetailKeyboard(id, pollIdx, poll, selected));
  } catch {}
});

// Radio answer — immediate submit
bot.action(/^prad:(\d+):(\d+):(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const pollIdx = parseInt(ctx.match[2]);
  const optIdx = parseInt(ctx.match[3]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery("Отправляю ответ..."); } catch {}
  try {
    const ok = await session.meeting.answerPoll(pollIdx, [optIdx]);
    if (ok) {
      await ctx.editMessageText(`✅ Ответ отправлен (вариант ${optIdx + 1})`, Markup.inlineKeyboard([
        [Markup.button.callback("↩️ К опросам", `poll:${id}`)],
      ]));
    } else {
      await ctx.editMessageText("❌ Не удалось ответить", Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Попробовать", `polld:${id}:${pollIdx}`)],
        [Markup.button.callback("↩️ Назад", `poll:${id}`)],
      ]));
    }
  } catch {}
});

// Checkbox toggle
bot.action(/^pchk:(\d+):(\d+):(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const pollIdx = parseInt(ctx.match[2]);
  const optIdx = parseInt(ctx.match[3]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  const selKey = `${id}:${pollIdx}`;
  let selected = checkboxSelections.get(selKey);
  if (!selected) {
    selected = new Set();
    checkboxSelections.set(selKey, selected);
  }

  if (selected.has(optIdx)) {
    selected.delete(optIdx);
  } else {
    selected.add(optIdx);
  }

  try { await ctx.answerCbQuery(`Вариант ${optIdx + 1}: ${selected.has(optIdx) ? "✅" : "☐"}`); } catch {}
  try {
    const polls = await session.meeting.getPolls();
    if (pollIdx < polls.length) {
      const poll = polls[pollIdx];
      await ctx.editMessageText(formatPollDetail(poll), pollDetailKeyboard(id, pollIdx, poll, selected));
    }
  } catch {}
});

// Checkbox submit
bot.action(/^psub:(\d+):(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const pollIdx = parseInt(ctx.match[2]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  const selKey = `${id}:${pollIdx}`;
  const selected = checkboxSelections.get(selKey);
  if (!selected || selected.size === 0) {
    try { await ctx.answerCbQuery("Выберите хотя бы один вариант"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery("Отправляю ответ..."); } catch {}
  try {
    const answers = Array.from(selected).sort((a, b) => a - b);
    const ok = await session.meeting.answerPoll(pollIdx, answers);
    checkboxSelections.delete(selKey);
    if (ok) {
      await ctx.editMessageText(
        `✅ Ответ отправлен (варианты: ${answers.map(a => a + 1).join(", ")})`,
        Markup.inlineKeyboard([[Markup.button.callback("↩️ К опросам", `poll:${id}`)]])
      );
    } else {
      await ctx.editMessageText("❌ Не удалось ответить", Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Попробовать", `polld:${id}:${pollIdx}`)],
        [Markup.button.callback("↩️ Назад", `poll:${id}`)],
      ]));
    }
  } catch {}
});

// Text poll — activate text mode
bot.action(/^ptxt:(\d+):(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const pollIdx = parseInt(ctx.match[2]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  const chatId = ctx.chat.id;
  textPollMode.set(chatId, { sessionId: id, pollIdx });

  try { await ctx.answerCbQuery(); } catch {}
  try {
    await ctx.editMessageText(
      "✏️ Введите ваш ответ текстом (просто напишите сообщение):",
      Markup.inlineKeyboard([[Markup.button.callback("❌ Отмена", `polld:${id}:${pollIdx}`)]])
    );
  } catch {}
});

// ============================================================
//  INLINE BUTTONS — AI POLLS
// ============================================================

// AI solve single poll
bot.action(/^pai:(\d+):(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const pollIdx = parseInt(ctx.match[2]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery(); } catch {}

  try {
    await ctx.editMessageText("🤖 AI анализирует...");
  } catch {}

  try {
    const polls = await session.meeting.getPolls();
    if (pollIdx >= polls.length) {
      await ctx.editMessageText("Опрос не найден", Markup.inlineKeyboard([
        [Markup.button.callback("↩️ Назад", `poll:${id}`)],
      ]));
      return;
    }

    const poll = polls[pollIdx];
    const result = await solvePoll(poll);

    // Store pending answer
    const aiKey = `${id}:${pollIdx}`;
    aiPendingAnswers.set(aiKey, result);

    // Format answer display
    let answerText;
    if (poll.type === "text") {
      answerText = `✏️ Ответ: ${result.answer}`;
    } else {
      const labels = result.answer
        .map(i => `${i + 1}. ${poll.options[i] || "?"}`)
        .join(", ");
      answerText = `✅ Вариант: ${labels}`;
    }

    const text =
      `🤖 AI ответ на:\n❓ ${poll.title}\n\n` +
      `${answerText}\n` +
      `💭 Обоснование: ${result.reasoning}`;

    await ctx.editMessageText(text, Markup.inlineKeyboard([
      [
        Markup.button.callback("✅ Отправить", `paic:${id}:${pollIdx}`),
        Markup.button.callback("❌ Отмена", `paix:${id}:${pollIdx}`),
      ],
    ]));
  } catch (err) {
    await ctx.editMessageText(
      `❌ AI ошибка: ${err.message.substring(0, 200)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Попробовать", `pai:${id}:${pollIdx}`)],
        [Markup.button.callback("↩️ Назад", `polld:${id}:${pollIdx}`)],
      ])
    ).catch(() => {});
  }
});

// AI confirm — submit answer
bot.action(/^paic:(\d+):(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const pollIdx = parseInt(ctx.match[2]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  const aiKey = `${id}:${pollIdx}`;
  const pending = aiPendingAnswers.get(aiKey);
  if (!pending) {
    try { await ctx.answerCbQuery("Ответ AI не найден"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery("Отправляю..."); } catch {}

  try {
    const ok = await session.meeting.answerPoll(pollIdx, pending.answer);
    aiPendingAnswers.delete(aiKey);

    if (ok) {
      await ctx.editMessageText("✅ AI ответ отправлен", Markup.inlineKeyboard([
        [Markup.button.callback("↩️ К опросам", `poll:${id}`)],
      ]));
    } else {
      await ctx.editMessageText("❌ Не удалось отправить ответ", Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Попробовать", `pai:${id}:${pollIdx}`)],
        [Markup.button.callback("↩️ Назад", `poll:${id}`)],
      ]));
    }
  } catch {
    await ctx.editMessageText("❌ Ошибка при отправке", Markup.inlineKeyboard([
      [Markup.button.callback("↩️ Назад", `poll:${id}`)],
    ])).catch(() => {});
  }
});

// AI cancel — go back to poll detail
bot.action(/^paix:(\d+):(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const pollIdx = parseInt(ctx.match[2]);

  const aiKey = `${id}:${pollIdx}`;
  aiPendingAnswers.delete(aiKey);

  try { await ctx.answerCbQuery(); } catch {}

  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.editMessageText("Сессия не найдена"); } catch {}
    return;
  }

  try {
    const polls = await session.meeting.getPolls();
    if (pollIdx < polls.length) {
      const poll = polls[pollIdx];
      const selKey = `${id}:${pollIdx}`;
      const selected = checkboxSelections.get(selKey) || new Set();
      await ctx.editMessageText(formatPollDetail(poll), pollDetailKeyboard(id, pollIdx, poll, selected));
    } else {
      await ctx.editMessageText("Опрос не найден", Markup.inlineKeyboard([
        [Markup.button.callback("↩️ Назад", `poll:${id}`)],
      ]));
    }
  } catch {}
});

// AI solve ALL unanswered polls
bot.action(/^paia:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery(); } catch {}

  try {
    const polls = await session.meeting.getPolls();
    const unanswered = polls.filter(p => !p.answered);

    if (unanswered.length === 0) {
      await ctx.editMessageText("✅ Все опросы уже отвечены", Markup.inlineKeyboard([
        [Markup.button.callback("↩️ Назад", `poll:${id}`)],
      ]));
      return;
    }

    const total = unanswered.length;
    const results = [];

    for (let i = 0; i < unanswered.length; i++) {
      const poll = unanswered[i];

      try {
        await ctx.editMessageText(
          `🤖 AI решает опросы... (${i + 1}/${total})\n❓ ${poll.title}`
        );
      } catch {}

      try {
        const result = await solvePoll(poll);
        const ok = await session.meeting.answerPoll(poll.index, result.answer);

        if (ok) {
          let short;
          if (poll.type === "text") {
            short = result.answer.substring(0, 50);
          } else {
            short = result.answer
              .map(idx => poll.options[idx] || "?")
              .join(", ");
          }
          results.push(`✅ ${poll.title} — ${short}`);
        } else {
          results.push(`❌ ${poll.title} — не удалось отправить`);
        }
      } catch (err) {
        results.push(`❌ ${poll.title} — ${err.message.substring(0, 60)}`);
      }
    }

    const summary = `🤖 AI решил опросы (${total})\n` +
      "─".repeat(24) + "\n" +
      results.join("\n");

    await ctx.editMessageText(summary, Markup.inlineKeyboard([
      [Markup.button.callback("↩️ К опросам", `poll:${id}`)],
    ]));
  } catch (err) {
    await ctx.editMessageText(
      `❌ Ошибка: ${err.message.substring(0, 200)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback("↩️ Назад", `poll:${id}`)],
      ])
    ).catch(() => {});
  }
});

// ============================================================
//  INLINE BUTTONS — VIDEO
// ============================================================

bot.action(/^vid:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);

  // id=0 → standalone, иначе проверяем сессию
  if (id > 0) {
    const session = findSessionById(id);
    if (!session || !session.meeting.connected) {
      try { await ctx.answerCbQuery("Сессия не найдена"); } catch {}
      return;
    }
  }

  try { await ctx.answerCbQuery(); } catch {}
  try { await ctx.editMessageText(videoText(), videoKeyboard(id)); } catch {}
});

// Выбор стандартного видео
bot.action(/^vdef:(\d+)$/, async (ctx) => {
  const sessionId = parseInt(ctx.match[1]);
  const session = findSessionById(sessionId);

  try { await ctx.answerCbQuery("Переключаю..."); } catch {}

  videoMeta.activeId = null;
  restoreDefaultVideo();
  saveVideoMeta(videoMeta);

  // Перезагружаем камеру если включена
  if (session?.meeting?.connected) {
    await session.meeting.reloadCamera();
  }

  try { await ctx.editMessageText(videoText(), videoKeyboard(sessionId)); } catch {}
});

// Выбор загруженного видео
bot.action(/^vsel:(\d+):(\d+)$/, async (ctx) => {
  const videoId = parseInt(ctx.match[1]);
  const sessionId = parseInt(ctx.match[2]);
  const session = findSessionById(sessionId);

  const video = videoMeta.videos.find(v => v.id === videoId);
  if (!video) {
    try { await ctx.answerCbQuery("Видео не найдено"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery("Переключаю..."); } catch {}

  const y4mPath = path.join(VIDEOS_DIR, video.filename);
  switchActiveVideo(y4mPath);
  videoMeta.activeId = videoId;
  saveVideoMeta(videoMeta);

  // Перезагружаем камеру если включена
  if (session?.meeting?.connected) {
    await session.meeting.reloadCamera();
  }

  try { await ctx.editMessageText(videoText(), videoKeyboard(sessionId)); } catch {}
});

// Удаление видео
bot.action(/^vdel:(\d+):(\d+)$/, async (ctx) => {
  const videoId = parseInt(ctx.match[1]);
  const sessionId = parseInt(ctx.match[2]);

  try { await ctx.answerCbQuery("Удаляю..."); } catch {}

  const idx = videoMeta.videos.findIndex(v => v.id === videoId);
  if (idx === -1) return;

  const video = videoMeta.videos[idx];
  try { fs.unlinkSync(path.join(VIDEOS_DIR, video.filename)); } catch {}
  if (video.rawFilename) {
    try { fs.unlinkSync(path.join(VIDEOS_DIR, video.rawFilename)); } catch {}
  }

  videoMeta.videos.splice(idx, 1);

  if (videoMeta.activeId === videoId) {
    videoMeta.activeId = null;
    restoreDefaultVideo();
  }

  saveVideoMeta(videoMeta);

  try { await ctx.editMessageText(videoText(), videoKeyboard(sessionId)); } catch {}
});

// --- Предпросмотр видео ---

bot.action(/^vview:(\d+)$/, async (ctx) => {
  const sessionId = parseInt(ctx.match[1]);

  try { await ctx.answerCbQuery(); } catch {}

  const activeVideo = videoMeta.activeId !== null
    ? videoMeta.videos.find(v => v.id === videoMeta.activeId)
    : null;

  if (activeVideo?.rawFilename) {
    const rawPath = path.join(VIDEOS_DIR, activeVideo.rawFilename);
    if (fs.existsSync(rawPath)) {
      try {
        await ctx.replyWithVideo(
          { source: rawPath },
          { caption: `🎬 ${activeVideo.name} (${activeVideo.duration}с)` }
        );
      } catch {
        await ctx.reply("Не удалось отправить предпросмотр.");
      }
    } else {
      await ctx.reply("Исходный файл не найден.");
    }
  } else {
    await ctx.reply("Предпросмотр недоступен для этого видео.");
  }
});

// --- Закрыть standalone панель видео ---

bot.action("vclose", async (ctx) => {
  try { await ctx.answerCbQuery(); } catch {}
  try { await ctx.deleteMessage(); } catch {}
});

// ============================================================
//  INLINE BUTTONS — BACK / NOOP
// ============================================================

bot.action(/^back:(\d+)$/, async (ctx) => {
  const id = parseInt(ctx.match[1]);
  const session = findSessionById(id);
  if (!session || !session.meeting.connected) {
    try { await ctx.answerCbQuery("Сессия не найдена. /panel"); } catch {}
    return;
  }

  try { await ctx.answerCbQuery(); } catch {}
  try {
    await ctx.editMessageText(statusText(session.meeting), controlKeyboard(id, session.meeting));
  } catch {}
});

bot.action("noop", (ctx) => {
  try { ctx.answerCbQuery(); } catch {}
});

// ============================================================
//  VOICE → CONFERENCE MIC
// ============================================================

bot.on("voice", async (ctx) => {
  const chatId = ctx.chat.id;
  const voice = ctx.message.voice;
  if (!voice) return;

  // Find session: reply → specific session, otherwise single active
  const replyTo = ctx.message.reply_to_message?.message_id;
  let session = null;

  if (replyTo) {
    session = findSessionByControlMsg(chatId, replyTo);
  }

  if (!session) {
    const active = getActiveSessions(chatId);
    if (active.length === 1) {
      session = active[0];
    } else if (active.length > 1) {
      return ctx.reply("Несколько мероприятий. Ответь reply на панель нужного.");
    } else {
      return ctx.reply("Нет активных сессий.");
    }
  }

  if (!session.meeting.connected) {
    return ctx.reply("Сессия не подключена.");
  }

  const dur = voice.duration;
  const msg = await ctx.reply(`🎤 Воспроизвожу голосовое (${dur}с)...`);

  const tempOgg = path.join(VIDEOS_DIR, `voice_${Date.now()}.ogg`);
  const tempWav = path.join(VIDEOS_DIR, `voice_${Date.now()}.wav`);

  try {
    const fileLink = await ctx.telegram.getFileLink(voice.file_id);
    downloadFile(fileLink.href, tempOgg);
    convertToWav(tempOgg, tempWav);

    await session.meeting.playVoice(tempWav, dur);

    await bot.telegram.editMessageText(
      chatId, msg.message_id, null,
      "✅ Голосовое воспроизведено"
    );
  } catch (err) {
    await bot.telegram.editMessageText(
      chatId, msg.message_id, null,
      `❌ Ошибка: ${err.message.substring(0, 200)}`
    ).catch(() => {});
  } finally {
    try { fs.unlinkSync(tempOgg); } catch {}
    try { fs.unlinkSync(tempWav); } catch {}
  }
});

// ============================================================
//  TEXT → IVA CHAT
// ============================================================

bot.on("text", async (ctx) => {
  const chatId = ctx.chat.id;
  const text = ctx.message.text;

  // Ссылки обработаны hears
  if (/https?:\/\/[^\s]*iva360\.ru/i.test(text)) return;
  // Команды обработаны выше
  if (text.startsWith("/")) return;

  // Text poll mode — if active, send as poll answer
  const pollMode = textPollMode.get(chatId);
  if (pollMode) {
    textPollMode.delete(chatId);
    const session = findSessionById(pollMode.sessionId);
    if (session && session.meeting.connected) {
      try {
        const ok = await session.meeting.answerPoll(pollMode.pollIdx, text);
        if (ok) {
          await ctx.reply("✅ Ответ на опрос отправлен");
        } else {
          await ctx.reply("❌ Не удалось отправить ответ на опрос");
        }
      } catch {
        await ctx.reply("❌ Ошибка при ответе на опрос");
      }
      return;
    }
  }

  const replyTo = ctx.message.reply_to_message?.message_id;

  if (replyTo) {
    const session = findSessionByControlMsg(chatId, replyTo);
    if (session && session.meeting.connected) {
      try { await session.meeting.sendMessage(text); } catch {}
      return;
    }
  }

  const active = getActiveSessions(chatId);
  if (active.length === 1) {
    try { await active[0].meeting.sendMessage(text); } catch {}
  } else if (active.length > 1) {
    await ctx.reply("Несколько мероприятий. Ответь reply на панель нужного.");
  }
});

// ============================================================
//  ERROR HANDLER & LAUNCH
// ============================================================

bot.catch((err) => {
  // Молча игнорируем "query is too old"
  if (err.description?.includes("query is too old")) return;
  if (err.description?.includes("query ID is invalid")) return;
  console.error(`[bot] Ошибка: ${err.message}`);
});

bot.launch().then(() => {
  console.log("Бот запущен!");
  console.log(`Видео загружено: ${videoMeta.videos.length}/${MAX_VIDEOS}`);
});

process.once("SIGINT", () => {
  for (const [, s] of sessions) s.meeting.disconnect().catch(() => {});
  bot.stop("SIGINT");
});

process.once("SIGTERM", () => {
  for (const [, s] of sessions) s.meeting.disconnect().catch(() => {});
  bot.stop("SIGTERM");
});
