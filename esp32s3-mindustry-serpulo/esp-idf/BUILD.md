# Сборка и прошивка ESP32-S3 (ESP-IDF 5.3.x)

Проект `esp-idf/` собирает авторитетный детерминированный сервер симуляции **Mindustry v160.7 (Серпуло)** на базе общего ядра `simcore` (`Q16.16`, `BAM10`, `Xorshift64Star`, без `float`/`double` и без динамической кучи в `sim_step()`).

## Целевая плата

- **Модуль**: `ESP32-S3-WROOM-1-N16R8` (или любая dev-плата ESP32-S3 с **16 МБ QIO Flash** и **8 МБ Octal PSRAM**)
- **Распределение памяти**:
  - `SimHotState` (`57 240 B` / `55.90 КБ`) → внутренняя быстрая **SRAM** (`MALLOC_CAP_INTERNAL`)
  - `SimMapStorage` (`147 460 B` / `144.00 КБ`) → внешняя **Octal PSRAM** (`MALLOC_CAP_SPIRAM`, с автоматическим fallback в SRAM на платах без PSRAM)
  - Контент-таблицы Серпуло (`10 848 B` / `10.59 КБ`) → `constexpr` `.rodata` в XIP Flash

## Сборка из исходников (ESP-IDF v5.3.1+)

```bash
cd esp32s3-mindustry-serpulo/esp-idf
idf.py set-target esp32s3
idf.py build
```

Прошивка и открытие UART-монитора:

```bash
idf.py -p /dev/ttyACM0 flash monitor
# На Windows: idf.py -p COM5 flash monitor
```

## Прошивка готового объединённого `.bin` без установки ESP-IDF

Готовый файл `mindustry-esp32s3.bin` из GitHub Releases прошивается одной командой по смещению `0x0`:

```bash
pip install esptool
esptool.py --chip esp32s3 --port /dev/ttyACM0 --baud 921600 write_flash 0x0 mindustry-esp32s3.bin
```

## Подключение ПК-клиента к плате ESP32-S3

После старта прошивка выполняет самопроверку детерминизма (`Determinism Golden Selftest: PASS`), генерирует стартовый сектор 15 (*Ground Zero / Отправная точка*) и поднимает два канала бинарного протокола `0x4D53`:

1. **Wi-Fi SoftAP + TCP (`26789`)**:
   - Подключите ПК к точке доступа **`Mindustry-S3`** (пароль: **`serpulo1607`**)
   - Запустите ПК-клиент:
     ```bash
     ./mindustry-serpulo-pc --tcp 192.168.4.1:26789
     # или веб-студию ПК:
     ./mindustry-serpulo-web --esp-tcp 192.168.4.1:26789
     ```
2. **USB-UART0 (`115200 8N1`)**:
   - Пока ПК-клиент не подключён по Serial, плата раз в секунду выводит человекочитаемую телеметрию (`tick`, `wave`, `bld`, `unit`, `proj`, `sim_us p50/max`).
   - При подключении клиента с `HELLO (0x01)` лог автоматически замолкает, уступая линию бинарному протоколу `0x4D53`:
     ```bash
     ./mindustry-serpulo-pc --serial /dev/ttyACM0
     # на Windows:
     mindustry-serpulo-pc.exe --serial COM5
     ```
