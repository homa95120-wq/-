# ESP32 Studio

IDE в стиле Visual Studio Code для программирования ESP32 / ESP32-S3 на MicroPython —
**прямо в браузере, без установки**. Плата подключается по USB через Web Serial.

![layout](https://img.shields.io/badge/UI-VS%20Code%20Dark%2B-0078d4) ![mpy](https://img.shields.io/badge/MicroPython-ESP32%20%7C%20S3%20%7C%20C3-blue)

## Что умеет

| | |
|---|---|
| **Редактор Monaco** | тот же движок, что в VS Code: подсветка, автодополнение MicroPython (`machine`, `Pin`, `network`…), сниппеты, миникарта, мультикурсор |
| **▶ Запуск (F5)** | выполняет открытый файл на плате, вывод в терминал |
| **⬆ Загрузка (Ctrl+U)** | записывает файл на флеш платы; `main.py` стартует при включении |
| **Файлы на плате** | просмотр, открытие, редактирование, удаление, копирование в проект |
| **Терминал REPL** | полноценный xterm: Ctrl+C, Ctrl+D, автодополнение Tab и т.д. |
| **⚡ Прошивка** | заливает MicroPython `.bin` через esptool-js, автоопределение чипа и адреса (0x0 для S3/C3, 0x1000 для ESP32) |
| **Проект в браузере** | файлы хранятся в localStorage, переживают перезагрузку |
| **Примеры** | мигание, RGB-светодиод S3, Wi-Fi сканер, веб-сервер, кнопка, АЦП/ШИМ, I2C-сканер |
| **Палитра команд** | Ctrl+Shift+P, как в VS Code; меню, контекстные меню, статус-бар |

## Запуск

```bash
cd esp32-web-ide
npm install
npm run dev        # http://localhost:5173
```

Сборка статики: `npm run build` → папка `dist/`, можно положить на любой хостинг с HTTPS
(Web Serial работает только по HTTPS или на localhost). В репозитории есть workflow для GitHub Pages.

**Браузер:** Chrome, Edge, Opera (десктоп или Android). Firefox и Safari Web Serial не поддерживают.

## Первый запуск с платой

1. Подключи ESP32 по USB. На Windows может понадобиться драйвер CP210x / CH340
   (ESP32-S3 через встроенный USB — драйвер не нужен).
2. Если на плате ещё нет MicroPython: вкладка **⚡** → выбери `.bin` с
   [micropython.org](https://micropython.org/download/?port=esp32) (для S3 — `ESP32_GENERIC_S3`) → **Прошить**.
   Если плата не входит в режим загрузки — зажми BOOT, нажми RESET, отпусти BOOT.
3. Нажми **⚡ Подключить**, выбери порт.
4. Открой `main.py`, F5 — программа запустится. Ctrl+U — записать на плату навсегда.

## Горячие клавиши

| Клавиши | Действие |
|---|---|
| F5 / Shift+F5 | Запустить / остановить |
| Ctrl+U | Загрузить файл на плату |
| Ctrl+Shift+C | Подключить / отключить |
| Ctrl+Shift+R | Мягкий сброс платы |
| Ctrl+N / Ctrl+O | Новый файл / открыть с компьютера |
| Ctrl+Shift+P, F1 | Палитра команд |
| Ctrl+B / Ctrl+J | Боковая / нижняя панель |

## Как устроено

```
src/
  main.js      UI: вкладки, проводник, палитра, меню, настройки
  device.js    Web Serial + протокол raw REPL MicroPython (exec, run, файлы)
  flasher.js   прошивка через esptool-js
  examples.js  примеры кода
  style.css    тема VS Code Dark+
```

Файлы передаются на плату через raw REPL в base64 кусками по 768 байт — работает на любой
прошивке MicroPython без WebREPL и дополнительных модулей.
