# IVA Connect Bot

Telegram-бот для автоматизации видеоконференций IVA Connect (meet.iva360.ru).
Подключается к конференции через Playwright (управляемый браузер) и предоставляет полный контроль через Telegram.

## Возможности

- Автоподключение к конференции по ссылке
- Управление микрофоном и камерой
- Чтение и отправка сообщений в чат конференции
- Просмотр списка участников
- Просмотр и ответ на опросы (радио, чекбоксы, текст)
- Загрузка видео для фейковой камеры
- Скриншоты конференции

## Требования

- Node.js >= 18
- Google Chrome / Chromium
- ffmpeg (для конвертации видео/аудио)
- На сервере без GUI: Xvfb

## Установка

```bash
git clone https://github.com/<your-username>/iva-connect-bot.git
cd iva-connect-bot
npm install
npx playwright install chromium
cp .env.example .env
# Отредактируйте .env — заполните BOT_TOKEN и OWNER_ID
```

## Настройка (.env)

| Переменная | Описание | Обязательно |
|---|---|---|
| `BOT_TOKEN` | Токен Telegram-бота (@BotFather) | Да |
| `OWNER_ID` | Telegram ID владельца (только он может управлять ботом) | Да |
| `DISPLAY_NAME` | Имя для гостевого входа в конференцию | Нет (по умолчанию: `Студент`) |
| `HEADED` | Показывать окно браузера (`true`/`false`) | Нет (по умолчанию: `true`) |
| `CAMERA_VIDEO` | Путь к видео для фейковой камеры (mp4/mov/y4m) | Нет |

Узнать свой Telegram ID можно у бота [@userinfobot](https://t.me/userinfobot).

## Запуск

```bash
npm start
```

## Использование

1. Отправьте боту ссылку на конференцию (например `https://meet.iva360.ru/#join:...`)
2. Бот подключится и покажет панель управления с кнопками:
   - **Микрофон** / **Камера** — вкл/выкл с подтверждением
   - **Чат** — просмотр сообщений с пагинацией
   - **Участники** — список участников
   - **Опросы** — просмотр и ответ на опросы (вручную или через AI)
   - **Видео** — управление видео для камеры
   - **Скриншот** — снимок текущего состояния конференции
   - **Отключиться** — выход из конференции

### Команды

- `/panel` — показать панель управления активным мероприятием
- `/videos` — управление загруженными видео

### Видео для камеры

Отправьте боту видео (до 10 файлов, до 10 секунд каждый) — они будут сконвертированы и доступны для переключения через кнопку "Видео" на панели.

### Голосовые сообщения

Отправьте голосовое сообщение — бот воспроизведёт его в конференции через микрофон.

## Развёртывание на сервере (Linux)

### Xvfb (виртуальный дисплей)

```bash
sudo apt install xvfb
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99
```

### systemd

Создайте файл `/etc/systemd/system/iva-connect-bot.service`:

```ini
[Unit]
Description=IVA Connect Bot
After=network.target

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/iva-connect-bot
Environment=DISPLAY=:99
ExecStartPre=/usr/bin/Xvfb :99 -screen 0 1280x720x24 &
ExecStart=/usr/bin/node src/bot.js
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable iva-connect-bot
sudo systemctl start iva-connect-bot
```
