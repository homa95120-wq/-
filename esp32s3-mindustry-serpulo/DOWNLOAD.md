# Скачать и запустить — Mindustry v160.7 (Серпуло) для ПК и ESP32-S3

Проект поставляется сразу в **двух полностью совместимых версиях**, построенных вокруг единого детерминированного C++17 ядра `simcore` (`Q16.16`, `BAM10`, `Xorshift64Star`, 0 `float`/`double`):

1. **Версия для ПК** (Windows x64, Linux x64, macOS):
   - **`mindustry-serpulo-pc`** — нативный десктопный клиент (**SDL2 + OpenGL 3.3 Core**, 60 FPS / 60 TPS), работает как автономная игра на ПК со всеми **29 секторами Серпуло** и сохранениями `MSV1`, так и как экран/клиент для платы ESP32-S3.
   - **`mindustry-serpulo-web`** — кроссплатформенная ПК-студия (**C++17 HTTP + HTML5 Canvas** без внешних зависимостей), открывается в любом браузере на `http://localhost:8080` и также умеет подключаться к ESP32-S3 по протоколу `0x4D53`.
   - **`headless_runner`** — консольный бенчмарк памяти/тиков и TCP-эмулятор платы ESP32-S3 (`--serve 26789`).
2. **Версия для ESP32-S3** (`ESP32-S3-WROOM-1-N16R8`, 16 МБ Flash + 8 МБ Octal PSRAM):
   - **`mindustry-esp32s3.bin`** — готовая объединённая прошивка ESP-IDF 5.3.1 (прошивается по адресу `0x0`), запускающая авторитетный сервер симуляции Серпуло (30 Гц × 2 подшага = 60 TPS) с Wi-Fi точкой доступа `Mindustry-S3` (`192.168.4.1:26789`) и USB-UART0 (`115200`).

---

## Прямые ссылки на готовые сборки (GitHub Releases)

Все артефакты автоматически собираются в GitHub Actions и публикуются в постоянный релиз `esp32-mindustry-fw-latest`:

| Платформа | Файл | Описание |
|---|---|---|
| **Windows x64 (ПК)** | [`mindustry-serpulo-pc-win64.zip`](https://github.com/homa95120-wq/-/releases/download/esp32-mindustry-fw-latest/mindustry-serpulo-pc-win64.zip) | `mindustry-serpulo-pc.exe` + `SDL2.dll`, `mindustry-serpulo-web.exe`, `headless_runner.exe`, `web-preview/index.html` |
| **Linux x64 (ПК)** | [`mindustry-serpulo-pc-linux-x64.zip`](https://github.com/homa95120-wq/-/releases/download/esp32-mindustry-fw-latest/mindustry-serpulo-pc-linux-x64.zip) | `mindustry-serpulo-pc`, `mindustry-serpulo-web`, `headless_runner`, `web-preview/index.html` |
| **macOS (ПК)** | [`mindustry-serpulo-pc-macos.zip`](https://github.com/homa95120-wq/-/releases/download/esp32-mindustry-fw-latest/mindustry-serpulo-pc-macos.zip) | `mindustry-serpulo-pc`, `mindustry-serpulo-web`, `headless_runner`, `web-preview/index.html` |
| **ESP32-S3 (N16R8)** | [`mindustry-esp32s3.bin`](https://github.com/homa95120-wq/-/releases/download/esp32-mindustry-fw-latest/mindustry-esp32s3.bin) | Объединённый образ прошивки ESP-IDF 5.3.1 для записи по адресу `0x0` |
| **ESP32-S3 (MicroPython)** | [`main.py`](https://github.com/homa95120-wq/-/releases/download/esp32-mindustry-fw-latest/main.py) | Облегчённый скрипт для быстрого запуска в MicroPython / ESP32 Studio |

*(На ветках/PR свежие архивы также доступны во вкладке **Actions → Mindustry Serpulo (PC + ESP32-S3) → Artifacts**.)*

---

## Быстрый старт: Версия для ПК

### Вариант 1: Нативный OpenGL 3.3 клиент (`mindustry-serpulo-pc`)
```bash
# Автономная игра на ПК (60 TPS локально, сектор 0 = Ground Zero):
./mindustry-serpulo-pc

# Подключение к реальной плате ESP32-S3 по Wi-Fi (AP: Mindustry-S3, пароль: serpulo1607):
./mindustry-serpulo-pc --tcp 192.168.4.1:26789

# Подключение к плате ESP32-S3 по USB-кабелю (UART0 115200):
./mindustry-serpulo-pc --serial /dev/ttyACM0   # Windows: --serial COM5
```

**Управление в `mindustry-serpulo-pc`:**
- `WASD` / стрелки / зажатая СКМ или ПКМ + движение — перемещение камеры, колесо мыши — масштаб.
- `ЛКМ` — построить выбранный блок (или перетащить линию конвейеров/труб).
- `ПКМ` (клик без перетаскивания) — снести постройку и вернуть 50% ресурсов в ядро.
- `R` — повернуть блок (`Восток → Север → Запад → Юг`), `Tab` — переключить категорию блоков (`1..8`), `1..9` — выбрать блок в категории.
- `[` и `]` — переключить любой из **29 секторов Серпуло** (`Ground Zero` → `Planetary Terminal`).
- `N` — досрочно вызвать следующую волну врагов, `Space` — пауза (в локальном режиме).
- `F5` / `F9` — сохранить / загрузить мир в бинарный формат `serpulo_save.msv1` (с проверкой `CRC32`).

### Вариант 2: Веб-студия ПК (`mindustry-serpulo-web`)
Не требует видеодрайвера OpenGL 3.3 или установленной SDL2:
```bash
./mindustry-serpulo-web --port 8080
# Откройте в браузере http://localhost:8080
```
В верхней панели интерфейса можно в один клик переключать 29 секторов Серпуло, ускорять симуляцию (`1x / 2x / 4x`), сохранять/загружать слоты `MSV1` или подключиться к плате ESP32-S3 (`192.168.4.1:26789`).

---

## Быстрый старт: Прошивка ESP32-S3

Подключите плату **ESP32-S3 N16R8** по USB и прошейте `mindustry-esp32s3.bin` по адресу `0x0`:

```bash
pip install esptool
esptool.py --chip esp32s3 --port /dev/ttyACM0 --baud 921600 write_flash 0x0 mindustry-esp32s3.bin
```

Также можно прошить прямо через браузер (Chrome/Edge) на [espressif.github.io/esptool-js](https://espressif.github.io/esptool-js/):
1. Нажмите **Connect** и выберите COM/tty порт платы (`Baudrate: 921600`).
2. Укажите `Flash Address: 0x0` и выберите файл `mindustry-esp32s3.bin`.
3. Нажмите **Program**, затем нажмите кнопку **RST** на плате.
4. Плата поднимет Wi-Fi сеть **`Mindustry-S3`** (пароль **`serpulo1607`**) и начнёт раздавать мир на `192.168.4.1:26789` и в USB-UART0 (`115200`).
