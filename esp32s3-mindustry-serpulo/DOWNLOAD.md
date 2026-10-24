# ⬇️ Скачать «Mindustry для ESP» — ссылки

**Коротко:** готовой играбельной Mindustry для ESP32 не существует — ни официальной,
ни фанатской. Mindustry написана на Java под ПК/Android, и целиком на микроконтроллер
она не влезает. В этом репозитории лежит **свой прототип**: ESP32-S3 считает
симуляцию сектора (конвейеры, трубы, энергосеть, бой, A*), а картинку должен
рисовать ПК-клиент.

Ниже — то, что реально можно скачать и запустить сегодня.

---

## 1. Прошивка для ESP32-S3 (ESP-IDF, .bin)

Постоянная ссылка (обновляется автоматически при каждой сборке):

**⬇ [mindustry-esp32s3.bin](https://github.com/homa95120-wq/-/releases/download/esp32-mindustry-fw-latest/mindustry-esp32s3.bin)**

Страница релиза со всеми файлами:
[releases/tag/esp32-mindustry-fw-latest](https://github.com/homa95120-wq/-/releases/tag/esp32-mindustry-fw-latest)

**Что внутри:** `mindustry-esp32s3.bin` — объединённый образ (bootloader +
таблица разделов + приложение), прошивается по адресу `0x0`.
Рядом в релизе: `mindserpulo-app.bin` (только приложение, адрес `0x10000`),
`flash_args.txt`, `main.py`, этот файл.

**Что делает прошивка:** поднимает активный сектор 128×128, гоняет 30 тиков/с,
считает конвейеры, перетекание жидкости, баланс энергии, снаряды/юниты и A*,
раз в секунду печатает статистику в UART. **Экрана и управления нет** — это
headless-сервер симуляции, не игра.

### Как прошить

Вариант А — **ESP32 Studio** (проще, есть кнопка «Прошить»):

1. Скачайте ESP32 Studio: [ESP32 Studio Setup.exe](https://github.com/homa95120-wq/-/releases/download/esp32-studio-latest/ESP32.Studio.Setup.1.0.0.exe)
   или портативную версию
   [ESP32-Studio-1.0.0-portable.exe](https://github.com/homa95120-wq/-/releases/download/esp32-studio-latest/ESP32-Studio-1.0.0-portable.exe).
2. Вкладка **⚡** → выберите `mindustry-esp32s3.bin` → адрес **0x0** → **Прошить**.
3. Плата N16R8: если загрузчик не отвечает — зажать BOOT, нажать RESET, отпустить BOOT.

Вариант Б — **esptool** из консоли:

```bash
pip install esptool
esptool.py --chip esp32s3 -p COM7 -b 460800 write_flash 0x0 mindustry-esp32s3.bin
```

Linux/macOS: вместо `COM7` подставьте `/dev/ttyUSB0` или `/dev/ttyACM0`.

Вариант В — **собрать самому**:

```bash
cd esp32s3-mindustry-serpulo/esp-idf
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/ttyUSB0 flash monitor
```

Нужен ESP-IDF 5.3.x. Сборка также идёт в GitHub Actions
(`.github/workflows/esp32-mindustry-firmware.yml`).

### Что вы увидите в мониторе порта

```text
I (312) app_main: === mindserpulo: Serpulo simulation prototype (ESP32-S3) ===
I (322) app_main: free PSRAM: 8385000 bytes, free internal: 380000 bytes
I (332) app_main: sector struct: 1462328 bytes in PSRAM
I (342) sector_sim: sector initialized
I (352) app_main: path found: 26 cells
I (1352) app_main: tick=30 wave=1 active=0 conv=11 fluid=19 power=100.0/40.0 deficit=0% units=1 projs=0
```

⚠️ **Требования:** ESP32-S3 с **8 МБ PSRAM** (N16R8) и 16 МБ flash — структура
сектора ~1.4 МБ, во внутренние 512 КБ SRAM она не помещается. На плате без PSRAM
прошивка напишет ошибку и не запустится.

---

## 2. Вариант на MicroPython (запускается без компиляции)

Если не хочется собирать ESP-IDF: файл
[`micropython/main.py`](https://github.com/homa95120-wq/-/raw/main/esp32s3-mindustry-serpulo/micropython/main.py)
(в релизе он тоже есть как `main.py`).

1. Прошейте MicroPython для `ESP32_GENERIC_S3` (**SPIRAM_OCT**) —
   [micropython.org/download/ESP32_GENERIC_S3](https://micropython.org/download/ESP32_GENERIC_S3/).
2. Откройте ESP32 Studio → вставьте `main.py` → **▶ Запустить** (или Ctrl+U, чтобы
   файл стартовал при включении).
3. Плата поднимет Wi-Fi точку доступа `MindustryServer` / пароль `mind1234`,
   IP обычно `192.168.4.1`, TCP-порт `26789`.
4. Подключитесь любым TCP-клиентом (например `nc 192.168.4.1 26789`) — сервер
   шлёт состояние сектора в JSON и принимает текстовые команды:
   `build conveyor 5 5`, `spawn_unit 200 200 100 1`, `shoot 140 100 200 200`, `wave`, `ping`.

Это тоже **не игра с экраном**: плата — сервер, ПК — тонкий клиент. Готового
клиента с графикой пока нет (протокол описан в
[`docs/PROTOCOL.md`](https://github.com/homa95120-wq/-/blob/main/esp32s3-mindustry-serpulo/docs/PROTOCOL.md)).

---

## 3. Настоящая Mindustry — для ПК и Android (не для ESP)

Если нужна сама игра, а не эксперимент на микроконтроллере:

| Платформа | Где скачать |
|---|---|
| Windows / Linux / macOS | [GitHub Releases Anuken/Mindustry](https://github.com/Anuken/Mindustry/releases) — `Mindustry.jar` (нужна Java 17+) |
| Android | [Google Play](https://play.google.com/store/apps/details?id=io.anuke.mindustry) |
| Официальный сайт | [mindustrygame.github.io](https://mindustrygame.github.io/) |
| itch.io | [anuke.itch.io/mindustry](https://anuke.itch.io/mindustry) |

Оригинал распространяется под **GNU GPL v3**, актуальная версия — v160.7 (Mindustry v8).

---

## Честные ограничения

| Что | Статус |
|---|---|
| Играбельная Mindustry на ESP32 | **Нет и не планируется в полном виде** |
| Прошивка из п.1 | Работает как симуляция-сервер, проверяется в CI, на живой плате требует замеров |
| Связь с ПК-клиентом в прошивке | Пока нет (в MicroPython-версии есть TCP) |
| Графика/экран на ESP32 | Нет (архитектура headless, рисует ПК) |
| Совместимость с сохранениями/модами Mindustry | Нет |
| PSRAM | Обязательна (8 МБ, Octal), иначе прошивка не стартует |

Подробности архитектуры и дорожной карты — в
[`README.md`](https://github.com/homa95120-wq/-/blob/main/esp32s3-mindustry-serpulo/README.md)
и [`esp-idf/BUILD.md`](https://github.com/homa95120-wq/-/blob/main/esp32s3-mindustry-serpulo/esp-idf/BUILD.md).
