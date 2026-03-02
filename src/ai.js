const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

/**
 * Решает опрос с помощью Gemini API.
 * @param {{ title: string, type: "radio"|"checkbox"|"text", options: string[] }} poll
 * @returns {Promise<{ answer: number[]|string, reasoning: string }>}
 */
async function solvePoll(poll) {
  if (!GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY не задан");
  }

  let prompt;

  if (poll.type === "text") {
    prompt =
      `Ты — помощник для прохождения тестов. Ответь на вопрос.\n\n` +
      `Вопрос: ${poll.title}\n\n` +
      `Формат ответа (строго):\n` +
      `ОТВЕТ: <твой текстовый ответ>\n` +
      `ОБОСНОВАНИЕ: <краткое обоснование>`;
  } else {
    const optionsList = poll.options
      .map((opt, i) => `${i + 1}. ${opt}`)
      .join("\n");

    const typeHint =
      poll.type === "checkbox"
        ? "Может быть НЕСКОЛЬКО правильных ответов. Укажи все правильные номера через запятую."
        : "Только ОДИН правильный ответ. Укажи один номер.";

    prompt =
      `Ты — помощник для прохождения тестов. Выбери правильный ответ.\n\n` +
      `Вопрос: ${poll.title}\n\n` +
      `Варианты:\n${optionsList}\n\n` +
      `${typeHint}\n\n` +
      `Формат ответа (строго):\n` +
      `ОТВЕТ: <номер(а) через запятую>\n` +
      `ОБОСНОВАНИЕ: <краткое обоснование>`;
  }

  const res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2 },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gemini API ${res.status}: ${body.substring(0, 200)}`);
  }

  const data = await res.json();
  const text =
    data.candidates?.[0]?.content?.parts?.[0]?.text || "";

  if (!text) {
    throw new Error("Gemini вернул пустой ответ");
  }

  return parseResponse(text, poll.type);
}

function parseResponse(text, type) {
  const answerMatch = text.match(/ОТВЕТ:\s*(.+)/i);
  const reasonMatch = text.match(/ОБОСНОВАНИЕ:\s*(.+)/i);

  const reasoning = reasonMatch ? reasonMatch[1].trim() : "";

  if (!answerMatch) {
    throw new Error("Не удалось разобрать ответ AI");
  }

  const rawAnswer = answerMatch[1].trim();

  if (type === "text") {
    return { answer: rawAnswer, reasoning };
  }

  // radio / checkbox → массив 0-based индексов
  const nums = rawAnswer.match(/\d+/g);
  if (!nums || nums.length === 0) {
    throw new Error("AI не указал номер ответа");
  }

  const indices = nums.map((n) => parseInt(n) - 1); // 1-based → 0-based
  return { answer: indices, reasoning };
}

module.exports = { solvePoll };
