# Передаточный промт: Campaign Threat Radar (Mindustry v8)

Обновлён 2026-10-18: версия 1.3 — добавлена мини-карта с врагами, переработаны
предсказания (реалистичный ETA + прогноз атаки), панель сдвинута ещё левее.
Этот файл — единственный источник истины о состоянии проекта.
Читать целиком перед любыми действиями.

---

## 1. Что это за проект

Клиентский тактический HUD-мод для **Mindustry v8** (билды 154+), репозиторий
`github.com/homa95120-wq/-` (публичный, default branch `main`, имя репозитория —
буквально дефис).

Мод:

1. Расположен в правом верхнем углу, левее миникарты. Отступ считается от
   реальной ширины ванильной миникарты: `Scl.scl(MINIMAP_WIDTH + MINIMAP_GAP)`,
   где `MINIMAP_WIDTH = 150`, `MINIMAP_GAP = 70` (в UI units).
2. Показывает **мини-карту с врагами** (`campaignradar.RadarMap`, отдельный
   `arc.scene.Element`): синие квадраты — ядра, белая точка — игрок, красные
   точки — наземные враги, оранжевые — авиация, кольцо — босс, стрелки на краю —
   враги за пределами радиуса (120 блоков), пунктир — направление на ближайшую
   угрозу. Радар центрируется на самом слабом ядре.
3. Считает вражеских юнитов с разбивкой (наземные 🚜, летающие 🛸, боссы 💀).
4. Предсказания (переработаны в 1.3):
   - ETA по **реальной скорости типа юнита** (`unit.type.speed`), а не по
     мгновенной скорости; учитываются разгон, обход препятствий (×1.3 для
     наземных), потери на разворот и на текущую цель.
   - Показывается **диапазон** ETA (low/high), а не одно число.
   - **Прогноз**: сколько врагов и с каким суммарным DPS подойдут за 60 с,
     через сколько ляжет ядро, хватит ли обороны (сравнение DPS турелей и врага).
5. Диагностика базы: HP ядер, дефицит энергии и блэкаут, турели без патронов,
   повреждённые постройки, статус «Все системы стабильны».
6. Помечен как `hidden: true` — чисто клиентский мод, не создаёт сущностей, не
   меняет правила, не шлёт сетевые пакеты и не мешает заходить на сервера.

Две сборки (**не включать одновременно — будет две панели**):

* **Java (основная):**
  `src/main/java/campaignradar/CampaignThreatRadar.java` (логика + HUD) и
  `src/main/java/campaignradar/RadarMap.java` (мини-карта).
  Корневой `mod.hjson` — имя `campaign-threat-radar`, версия 1.3, `main`,
  `java: true`, `hidden: true`, `minGameVersion: 154`. `build.gradle` — Java 17,
  зависимость `compileOnly Anuken:Mindustry:v160.7`.
* **Скриптовая / ZIP (Rhino JS):**
  `scriptmod/` — порт логики на Rhino-JS API игры (`hidden: true`). Мини-карта
  сделана через `extend(Packages.arc.scene.Element, {...})` (JavaAdapter).
  `scriptmod/mod.hjson` — имя `campaign-threat-radar-zip`, displayName
  `Campaign Threat Radar (ZIP)`, версия 1.3.
  `scriptmod/build.py` собирает `dist/CampaignThreatRadar.zip`.
  Тесты: `node scriptmod/test-logic.js` (22 проверки) и
  `node scriptmod/test-hud.js` (7 проверок).

---

## 2. Полезные детали API Mindustry v160.7

Проверено по исходникам (тег `v160.7`), а не по памяти:

* `unit.type.speed` — скорость в **world units за тик** (1 тайл = 8 units,
  `Vars.tilesize = 8`); `unit.vel.len()` — та же единица.
* `unit.isFlying()` в v160.7 означает «сейчас в воздухе» (по `elevation`), для
  классификации нужно `unit.type.flying`.
* `UnitType.estimateDps()` — грубая оценка DPS юнита (сумма `Weapon.dps()`).
* `TurretBuild.hasAmmo()` и `TurretBuild.estimateDps()` — DPS конкретной турели.
* `PowerGraph.getPowerBalance()/getBatteryStored()/getBatteryCapacity()`.
* `TeamData.cores` — `Seq<CoreBuild>`, `TeamData.buildings` — `Seq<Building>`.
* `Vars.player.unit()` — контролируемый юнит (может быть `null`). Поле `Player.unit`
  **protected**, обращаться к нему из мода нельзя — только через метод `unit()`
  (иначе сборка в CI падает с «unit has protected access in Player»).
* Ванильная миникарта: `mindustry.ui.Minimap` шириной `Scl.scl(140)` + отступ 5.

---

## 3. Команды для сборки и тестов

```bash
node scriptmod/test-logic.js
node scriptmod/test-hud.js
python3 scriptmod/build.py
git status
```

Локально в песочнице нет JDK, поэтому jar собирается только в CI
(`.github/workflows/build.yml`). Перед коммитом обязательно прогонять
`node scriptmod/test-logic.js` и `node scriptmod/test-hud.js`.
