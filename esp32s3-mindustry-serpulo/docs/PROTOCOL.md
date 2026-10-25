# Бинарный протокол `0x4D53` ("MS") — ПК ↔ ESP32-S3

Единый бинарный протокол обмена между авторитарным сервером симуляции (`server-esp` на **ESP32-S3 N16R8** либо `headless_runner --serve` на ПК) и графическим клиентом (`client-pc`).

Поддерживаемые транспорты:
1. **Wi-Fi TCP:** точка доступа ESP32-S3 `Mindustry-S3` (пароль `serpulo123`), адрес `192.168.4.1`, порт `26789` (`TCP_NODELAY`).
2. **USB-CDC / UART:** последовательный порт `115200` / `921600` бод (`COMx` на Windows, `/dev/ttyACM0` или `/dev/ttyUSB0` на Linux/macOS).

---

## 1. Формат кадра

Все поля передаются в **little-endian**. Кадр имеет 7-байтный заголовок, полезную нагрузку `len` байт и 2-байтную контрольную сумму `CRC16-CCITT`:

```text
+-----------+----------+---------+---------+----------------+-----------+
| magic (2) | type (1) | seq (2) | len (2) | payload (len)  | crc16 (2) |
+-----------+----------+---------+---------+----------------+-----------+
  0x53 0x4D    uint8     uint16    uint16    0..16384 bytes    uint16
  (u16=0x4D53)
```

- `magic`: `uint16_t = 0x4D53` (байты `0x53`, `0x4D` в little-endian).
- `type`: тип сообщения (`ProtoMsgType`).
- `seq`: монотонный счётчик кадров отправителя.
- `len`: длина `payload` в байтах (`<= 16384`).
- `crc16`: **CRC-16/CCITT-FALSE** (`poly = 0x1021`, `init = 0xFFFF`, без финального XOR) по 7 байтам заголовка + `len` байтам `payload`.

---

## 2. Типы сообщений (`ProtoMsgType`)

| Код | Имя | Направление | Назначение |
|---:|---|---|---|
| `0x01` | `HELLO` | оба | Рукопожатие: версия протокола (`1`), размер карты (`W`, `H`), частота тиков сервера (`30` Гц), активный `sector_id` |
| `0x02` | `MAP_STATIC` | сервер → клиент | Чанк статической карты (`y_start`, `rows`, массивы `floor`, `ore`, `wall` по `rows * W` байт) |
| `0x03` | `SNAPSHOT_FULL` | сервер → клиент | Полный слепок динамического мира: `tick`, `wave`, `win_wave`, `countdown`, `flags`, ресурсы ядра `core_items[16]`, баланс энергии, активные здания, юниты и снаряды |
| `0x04` | `SNAPSHOT_DELTA` | сервер → клиент | Облегчённый тик-слепок динамических сущностей для удержания потока `<= 60 КБ/с` на 30 Гц |
| `0x05` | `INPUT_CMD` | клиент → сервер | Команда игрока (`PlaceBlock`, `RemoveBlock`, `TriggerWave`, `SetPaused`, `SelectSector`, `SetSandbox`, `ConfigureBlock`) |
| `0x06` | `PING` | клиент → сервер | Запрос измерения RTT (`client_time_us: uint64`) |
| `0x07` | `PONG` | сервер → клиент | Ответ RTT (`client_time_us: uint64`, `server_tick: uint32`, `last_tick_us: uint32`) |

---

## 3. Команда ввода `INPUT_CMD` (`0x05`, 12 байт payload)

```text
offset 0: cmd_type   (uint8)   1=Place, 2=Remove, 3=TriggerWave, 4=SetPaused, 5=SelectSector, 6=SetSandbox, 7=ConfigBlock
offset 1: rotation   (uint8)   0=Right, 1=Up, 2=Left, 3=Down
offset 2: team       (uint8)   0=Sharded (игрок), 1=Crux (враг)
offset 3: arg8       (uint8)   доп. параметр (item_id для сортировщика / 0..1 для паузы)
offset 4: x          (int16)   тайл X
offset 6: y          (int16)   тайл Y
offset 8: param16    (uint16)  block_id или sector_preset_id
offset 10: reserved  (uint16)  0
```

---

## 4. Бюджет пропускной способности

При 200 активных зданиях, 40 юнитах и 60 снарядах кадр `SNAPSHOT_DELTA`/`SNAPSHOT_FULL` занимает **~2.1–3.8 КБ**, что на частоте `15–30 Гц` даёт поток **32–58 КБ/с** — укладывается как в Wi-Fi TCP, так и в нативный USB-CDC ESP32-S3.
