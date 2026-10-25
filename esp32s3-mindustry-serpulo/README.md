# Mindustry v160.7 (Серпуло) — Единая детерминированная версия для ПК и ESP32-S3

> **Референсная база**: `Anuken/Mindustry` v8, тег `v160.7` (`17012d61d9e4c3cbd9820d87e81c24495486ac53`), лицензия **GNU GPL v3.0**.
> **Быстрые ссылки на готовые бинарники для Windows, Linux, macOS и ESP32-S3**: см. **[DOWNLOAD.md](DOWNLOAD.md)**.

Этот проект реализует механику планеты **Серпуло (Serpulo)** из Mindustry v160.7 на языке **C++17** вокруг единого побитово-детерминированного ядра симуляции **`simcore`**, которое одинаково компилируется и исполняется как **на ПК** (Windows / Linux / macOS), так и **на микроконтроллере ESP32-S3** (`ESP32-S3-WROOM-1-N16R8`, ESP-IDF 5.3.1).

---

## Две редакции в одном репозитории

| Редакция | Целевые артефакты | Режимы работы |
|---|---|---|
| **1. Версия для ПК** (`CMakeLists.txt`) | • `mindustry-serpulo-pc` (**SDL2 + OpenGL 3.3 Core**)<br>• `mindustry-serpulo-web` (**HTTP + HTML5 Canvas Studio**)<br>• `headless_runner` (бенчмарк и TCP-эмулятор платы)<br>• `simcore_test` (автотесты `ctest`) | **Path A (Автономная игра на ПК)**: локальная симуляция `simcore` на 60 TPS, все 29 секторов Серпуло, сохранения `MSV1`.<br>**Path B (Экран для ESP32-S3)**: подключение к плате по Wi-Fi TCP (`192.168.4.1:26789`) или USB-UART0 (`115200`) через бинарный протокол `0x4D53`. |
| **2. Версия для ESP32-S3** (`esp-idf/`) | • `mindustry-esp32s3.bin` (объединённый образ `0x0`)<br>• компонент `server-esp` + прошивка `app_main.cpp` | Авторитетный сервер мира на плате **ESP32-S3 N16R8** (30 Гц × 2 подшага = 60 TPS): размещает `SimHotState` во внутренней SRAM, карту `128×128` в Octal PSRAM, проходит `Golden Selftest` при загрузке, поднимает Wi-Fi AP `Mindustry-S3` (`:26789`) и UART0-канал `0x4D53`. |

---

## Архитектура и строгие инварианты детерминизма (`simcore`)

```text
content/data/*.json ──► tools/codegen/gen_content.py (Fraction/Decimal, 0 float)
                                │
                                ▼
              simcore/include/simcore/generated/*_table.hpp (constexpr .rodata = 10.59 КБ)
                                │
        ┌───────────────────────┴────────────────────────┐
        ▼                                                ▼
   Хост-сборка ПК (CMake)                        Прошивка ESP32-S3 (ESP-IDF 5.3.1)
  • mindustry-serpulo-pc (SDL2 + GL 3.3)        • server-esp (Wi-Fi AP :26789 + UART0)
  • mindustry-serpulo-web (0.0.0.0:8080)        • SimHotState   -> SRAM (55.90 КБ)
  • headless_runner / simcore_test              • SimMapStorage -> Octal PSRAM (144.00 КБ)
        │                                                │
        └──────────◄══ Бинарный протокол 0x4D53 ══►──────┘
                    (CRC16-CCITT, LE, FULL / DELTA / CMD)
```

1. **Ни единого `float` / `double` в `simcore/`**: вся математика координат, скоростей, урона, жидкостей и энергобаланса работает на фиксированной точке **`Q16.16`** (`int32_t` с промежуточным `int64_t`), углы — в **`BAM10`** (`0..1023`) по `constexpr` таблице синусов в `.rodata`. Статический CI-гейт `tools/check_no_float.py` блокирует любые вещественные типы, кучу (`new`/`malloc`/`std::vector`) и ОС-заголовки внутри `simcore/`.
2. **Фиксированный порядок обхода и ГПСЧ**: один экземпляр `Xorshift64Star` на мир, обход зданий (`0..1023`), юнитов (`0..255`, через детерминированную пространственную сетку `16×16` в SRAM) и снарядов (`0..511`) строго в порядке возрастания `id`.
3. **Каноническое хеширование мира**: `sim_state_hash_fnv1a64()` и `sim_state_crc32()` сериализуют поля в явном little-endian порядке байт, давая побитово идентичный хеш на x86_64, ARM64 и Xtensa LX7:
   - Пустая карта `128×128` (`tick 0`): `FNV-1a 64 = 0x80F18980BF80ADBE`, `CRC32 = 0x5F00343E`
   - Golden-сценарий M0 (`tick 60`): `FNV-1a 64 = 0xCF13DADCA7610D89`, `CRC32 = 0x635F4F00`
   - Golden-сценарий M0 (`tick 600`): `FNV-1a 64 = 0x4979BCAF8D29E303`, `CRC32 = 0x818A445E`

---

## Фактические замеры памяти и производительности

Замеры получены утилитой `headless_runner` на предельном стресс-сценарии (**1 021 здание + 256 юнитов + 512 снарядов одновременно на карте `128×128`**):

| Метрика | Фактическое значение | Бюджет ESP32-S3 N16R8 |
|---|---|---|
| `sizeof(SimHotState)` (внутренняя **SRAM**) | **57 240 байт (55.90 КБ)** | `< 260 КБ` SRAM (с запасом под Wi-Fi/LWIP) |
| `sizeof(SimMapStorage)` (**Octal PSRAM**) | **147 460 байт (144.00 КБ)** | `8 192 КБ` Octal PSRAM |
| Таблицы контента и LUT (**Flash `.rodata`**) | **10 848 байт (10.59 КБ)** | `16 384 КБ` QIO Flash |
| Время 1 тика на стресс-сцене (хост `x86_64 -O3`) | **`p50 = 92.09 мкс`, `p95 = 347.74 мкс`, `p99 = 495.51 мкс`** | `< 16 666 мкс` при 60 TPS |
| Время 1 тика на обычной базе (*Ground Zero*) | **`~8–15 мкс`** (хост) / **`< 1.5 мс`** (ESP32-S3 @ 240 МГц) | `33 333 мкс` на 2 подшага (30 Гц) |

---

## Реестры контента Mindustry v160.7 (Серпуло)

Все таблицы генерируются скриптом `tools/codegen/gen_content.py` через точные рациональные дроби `fractions.Fraction` из JSON-описаний в `content/data/`:

- **22 предмета (`ItemId 0..21`)**: все 16 предметов Серпуло (`scrap`, `copper`, `lead`, `graphite`, `coal`, `titanium`, `thorium`, `silicon`, `plastanium`, `phase-fabric`, `surge-alloy`, `spore-pod`, `sand`, `blast-compound`, `pyratite`, `metaglass`) + 6 предметов Эрекира для сквозной совместимости индексов v160.7.
- **11 жидкостей (`LiquidId 0..10`)**: `water`, `slag`, `oil`, `cryofluid`, `neoplasm`, `arkycite`, `gallium`, `ozone`, `hydrogen`, `nitrogen`, `cyanogen` с точными параметрами теплоёмкости, вязкости и горючести.
- **53 блока Серпуло (`BlockId 0..52` в 8 категориях)**:
  1. *Ядра и хранилища*: `core-shard`, `core-foundation`, `core-nucleus`, `container`, `vault`.
  2. *Добыча*: `mechanical-drill`, `pneumatic-drill`, `laser-drill`, `airblast-drill`, `water-extractor`.
  3. *Логистика предметов*: `conveyor`, `titanium-conveyor`, `plastanium-conveyor`, `armored-conveyor`, `junction`, `item-bridge`, `router`, `distributor`, `overflow-gate`, `underflow-gate`, `sorter`.
  4. *Жидкости*: `mechanical-pump`, `rotary-pump`, `conduit`, `pulse-conduit`, `plated-conduit`, `liquid-router`, `liquid-junction`, `liquid-container`, `liquid-tank`.
  5. *Энергетика*: `power-node`, `power-node-large`, `battery`, `battery-large`, `combustion-generator`, `thermal-generator`, `steam-generator`, `differential-generator`, `rtg-generator`, `solar-panel`, `thorium-reactor`.
  6. *Фабрики (крафт)*: `graphite-press`, `multi-press`, `silicon-smelter`, `kiln`, `plastanium-compressor`, `phase-weaver`, `surge-smelter`, `cryofluid-mixer`, `pyratite-mixer`, `blast-mixer`, `pulverizer`, `melter`.
  7. *Оборона (стены)*: `copper-wall`, `copper-wall-large`, `titanium-wall`, `titanium-wall-large`, `plastanium-wall`, `thorium-wall`, `surge-wall`.
  8. *Турели и заводы юнитов*: `duo`, `scatter`, `scorch`, `hail`, `wave`, `lancer`, `arc`, `salvo`, `fuse`, `ripple`, `cyclone`, `spectre`, `meltdown`, `ground-factory`, `air-factory`.
- **8 типов юнитов Серпуло**: `dagger`, `mace`, `crawler`, `atrax`, `flare`, `horizon`, `zenith`, `mono` (наземный поиск пути по BFS flow-field от точки спавна к ядру, воздушный полёт, добыча руды дронами `mono`).
- **Все 29 именованных секторов Серпуло** (`content/data/sectors.json` из `SectorPresets.java` v160.7): от сектора 15 (*Ground Zero / Отправная точка*) до сектора 93 (*Planetary Terminal / Планетарный терминал*) с детерминированной процедурной генерацией ландшафта, рудных жил и волн.

---

## Сборка из исходников

### 1. Сборка версии для ПК (Linux / macOS / Windows)

Требования: C++17 компилятор (`GCC 11+`, `Clang 14+` или `MSVC 2022`), `CMake 3.16+`, `Python 3.8+` и опционально `SDL2` для нативного OpenGL 3.3 клиента `mindustry-serpulo-pc` (веб-клиент `mindustry-serpulo-web` и `headless_runner` собираются вообще без внешних библиотек).

```bash
# На Ubuntu/Debian (для нативного OpenGL клиента):
sudo apt-get install -y build-essential cmake libsdl2-dev python3

# На macOS:
brew install cmake sdl2

# Конфигурация и сборка:
cmake -S esp32s3-mindustry-serpulo -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j

# Статическая проверка отсутствия float/heap в simcore и прогон автотестов:
python3 esp32s3-mindustry-serpulo/tools/check_no_float.py
ctest --test-dir build --output-on-failure

# Запуск:
./build/mindustry-serpulo-pc          # Нативный десктопный клиент (SDL2 + OpenGL 3.3)
./build/mindustry-serpulo-web         # Веб-студия ПК на http://0.0.0.0:8080
./build/headless_runner               # Golden selftest + 1000-тиковый стресс-бенчмарк
```

### 2. Сборка прошивки для ESP32-S3 (ESP-IDF 5.3.1+)

Подробная инструкция находится в **[esp-idf/BUILD.md](esp-idf/BUILD.md)**:

```bash
cd esp32s3-mindustry-serpulo/esp-idf
idf.py set-target esp32s3
idf.py build
idf.py -p /dev/ttyACM0 flash monitor
```

---

## Структура каталога `esp32s3-mindustry-serpulo/`

- `CMakeLists.txt` — корневая CMake-сборка версии для ПК (`mindustry-serpulo-pc`, `mindustry-serpulo-web`, `headless_runner`, `simcore_test`).
- `simcore/` — общее детерминированное ядро симуляции (`Q16.16`, `BAM10`, `Xorshift64Star`, `FNV-1a 64`/`CRC32`, формат сохранений `MSV1`, кодек протокола `0x4D53`).
- `client-pc/` — нативный десктопный клиент для ПК на **SDL2 + OpenGL 3.3 Core** и клиентский транспорт `net_client` (TCP + Serial `115200`).
- `web-preview/` — самодостаточный C++17 HTTP-сервер (`server_web.cpp`) и интерактивный HTML5 Canvas-клиент (`index.html`) для игры в браузере и подключения к ESP32-S3.
- `server-esp/` — ESP-IDF компонент транспорта `0x4D53` (Wi-Fi SoftAP `Mindustry-S3` TCP `:26789` + неблокирующий UART0).
- `esp-idf/` — проект прошивки ESP-IDF 5.3.x для `ESP32-S3-WROOM-1-N16R8` (`sdkconfig.defaults`, `main/app_main.cpp`).
- `content/data/` — канонические JSON-реестры предметов, жидкостей, блоков, юнитов и 29 секторов Серпуло (`v160.7`).
- `tools/` — кодогенератор `codegen/gen_content.py`, статический анализатор `check_no_float.py` и `headless_runner.cpp`.
- `tests/` — модульные, детерминистские (100-кратный прогон), протокольные и `MSV1` тесты (`simcore_test.cpp`).
- `docs/` — спецификация бинарного протокола [`PROTOCOL.md`](docs/PROTOCOL.md) и архитектурные решения [`ADR/`](docs/ADR/).
- `LICENSE` — полный текст лицензии **GNU GPL v3.0**.
