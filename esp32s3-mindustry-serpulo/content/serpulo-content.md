# Реестр контента Серпуло — Mindustry v160.7 (коммит 17012d61)

Все перечни извлечены из исходников оригинальной Mindustry v160.7, а не составлены по памяти.
Источники: `Items.java`, `Liquids.java`, `Blocks.java`, `UnitTypes.java`, `Planets.java`,
`SerpuloTechTree.java`, `SectorPresets.java`, `Waves.java`.

Разделение: **контент Серпуло** (техдерево планеты, пресеты секторов, волны) vs
**общий для планет контент** (предметы, жидкости, базовые блоки и механика).

---

## 1. Предметы (items)

Всего в игре v160.7: **22**. Доступно на Серпуло (список `serpuloItems`): **16**.

| # | Предмет (id) | На Серпуло | Группа |
|---|---|---:|---:|
| 1 | scrap | да | общий |
| 2 | copper | да | общий |
| 3 | lead | да | общий |
| 4 | graphite | да | общий |
| 5 | coal | да | общий |
| 6 | titanium | да | общий |
| 7 | thorium | да | общий |
| 8 | silicon | да | общий |
| 9 | plastanium | да | общий |
| 10 | phase-fabric | да | общий |
| 11 | surge-alloy | да | общий |
| 12 | spore-pod | да | общий |
| 13 | sand | да | общий |
| 14 | blast-compound | да | общий |
| 15 | pyratite | да | общий |
| 16 | metaglass | да | общий |
| 17 | beryllium | нет | только Эрекир |
| 18 | tungsten | нет | только Эрекир |
| 19 | oxide | нет | только Эрекир |
| 20 | carbide | нет | только Эрекир |
| 21 | fissile-matter | нет | только Эрекир (hidden) |
| 22 | dormant-cyst | нет | только Эрекир (hidden) |

Несерпуловые предметы (6) — часть общего контента, но не открываются на Серпуло.

---

## 2. Жидкости (liquids)

Всего: **11**. В коде не привязаны к конкретной планете — доступны везде, где есть соответствующие блоки.

| # | Жидкость (id) | Особенность |
|---|---|---|
| 1 | water | |
| 2 | slag | |
| 3 | oil | |
| 4 | cryofluid | |
| 5 | arkycite | |
| 6 | gallium | `hidden = true` |
| 7 | neoplasm | |
| 8 | ozone | газ |
| 9 | hydrogen | газ |
| 10 | nitrogen | газ |
| 11 | cyanogen | газ |

---

## 3. Блоки (blocks) — древо Серпуло

Всего блоков в игре v160.7: **427** (включая поверхности, стены, полы, декорации).
Древо Серпуло (`SerpuloTechTree`) открывает **138 блоков**, разделённых на 16 функциональных групп:

### Добыча (руда/жидкость) — 7
mechanicalDrill, pneumaticDrill, laserDrill, blastDrill, waterExtractor, oilExtractor, cultivator

### Производство/переработка — 18
graphitePress, siliconSmelter, sporePress, coalCentrifuge, multiPress, siliconCrucible, plastaniumCompressor, phaseWeaver, kiln, pulverizer, incinerator, melter, surgeSmelter, separator, disassembler, cryofluidMixer, pyratiteMixer, blastMixer

### Конвейеры и распределение предметов — 17
conveyor, junction, router, distributor, sorter, invertedSorter, overflowGate, underflowGate, unloader, itemBridge, titaniumConveyor, massDriver, phaseConveyor, payloadConveyor, payloadRouter, plastaniumConveyor, armoredConveyor

### Жидкости — 12
mechanicalPump, conduit, liquidJunction, liquidRouter, liquidContainer, liquidTank, bridgeConduit, pulseConduit, phaseConduit, platedConduit, rotaryPump, impulsePump

### Электричество — 15
combustionGenerator, powerNode, powerNodeLarge, diode, surgeTower, battery, batteryLarge, steamGenerator, thermalGenerator, differentialGenerator, thoriumReactor, impactReactor, rtgGenerator, solarPanel, largeSolarPanel

### Освещение — 1
illuminator

### Хранилища и ядра — 4
container, vault, coreFoundation, coreNucleus

### Стены и двери — 18
copperWall, copperWallLarge, scrapWall, scrapWallLarge, scrapWallHuge, scrapWallGigantic, titaniumWall, titaniumWallLarge, door, doorLarge, plastaniumWall, plastaniumWallLarge, thoriumWall, thoriumWallLarge, surgeWall, surgeWallLarge, phaseWall, phaseWallLarge

### Турели и мины — 19
duo, scatter, hail, salvo, swarmer, cyclone, spectre, ripple, fuse, arc, scorch, wave, parallax, segment, tsunami, lancer, meltdown, foreshadow, shockMine

### Ремонт — 4
mender, mendProjector, repairPoint, repairTurret

### Поля/усиление — 3
forceProjector, overdriveProjector, overdriveDome

### Заводы юнитов и рефабрикаторы — 7
groundFactory, airFactory, navalFactory, additiveReconstructor, multiplicativeReconstructor, exponentialReconstructor, tetrativeReconstructor

### Логика — 10
microProcessor, switchBlock, message, logicDisplay, largeLogicDisplay, tileLogicDisplay, memoryCell, memoryBank, logicProcessor, hyperProcessor

### Запуск сектора/межпланетный — 3
advancedLaunchPad, landingPad, interplanetaryAccelerator

---

## 4. Юниты (units) — Серпуло

Всего юнитов в игре v160.7: **63**. В древе Серпуло: **35**.

| Механоиды/бегущие | Лёгкие | Воздушные | Морские |
|---|---|---|---|
| dagger, mace, fortress, scepter, reign, nova, pulsar, quasar, vela | corvus, crawler, atrax, spiroct, arkyid, toxopid | flare, horizon, zenith, antumbra, eclipse, mono, poly, mega, quad, oct | risso, minke, bryde, sei, omura, retusa, oxynoe, cyerce, aegires, navanax |

Волны по умолчанию (`Waves.java`) используют подмножество: dagger, crawler, flare, mace, pulsar, spiroct, quasar и др. — все входят в серпуловский список.

---

## 5. Сектора Серпуло

Всего секторов планеты: **272** (сетка размера 3 → `10·3³ + 2 = 272`).
Именованных пресетов: **29**. `planetaryTerminal` — последний сектор (`isLastSector = true`).
`startSector = 170` — сектор начала кампании.

| Пресет | ID сектора | Сложность | Волна захвата | Примечание |
|---|---:|---:|---:|---|
| groundZero | 15 | 1 | 10 | всегда разблокирован, стартовые предметы |
| saltFlats | 101 | 5 | — | |
| testingGrounds | 3 | 7 | 33 | |
| frozenForest | 86 | 2 | 15 | |
| biomassFacility | 81 | 3 | 20 | |
| taintedWoods | 221 | 5 | 33 | |
| crateredBattleground | 18 | 2 | 20 | |
| ruinousShores | 213 | 3 | 30 | |
| perilousHarbor | 47 | 4 | — | |
| facility32m | 64 | 4 | 25 | |
| windsweptIslands | 246 | 4 | 30 | |
| stainedMountains | 20 | 3 | 30 | |
| extractionOutpost | 165 | 5 | — | |
| coastline | 108 | 5 | 30 | |
| weatheredChannels | 39 | 9 | 40 | |
| navalFortress | 216 | 8 | — | |
| frontier | 50 | 4 | — | |
| fungalPass | 21 | 2 | — | |
| infestedCanyons | 210 | 4 | — | |
| atolls | 1 | 7 | — | |
| sunkenPier | -1 | 8 | 50 | |
| mycelialBastion | 260 | 8 | — | |
| overgrowth | 134 | 5 | — | |
| tarFields | 23 | 5 | 40 | |
| impact0078 | 227 | 7 | 45 | |
| desolateRift | 123 | 8 | 18 | |
| nuclearComplex | 130 | 7 | 50 | |
| littoralShipyard | 204 | 9 | — | |
| planetaryTerminal | 93 | 10 | — | последний сектор |

Остальные 243 сектора — процедурные (без именованного пресета).

---

## 6. Волны

Волновые группы задаются в `Waves.java` (waveVersion = 7) с параметрами `begin`/`end` (номер волны), `unitAmount`, `unitScaling`, `max`, `spacing`, щитами и эффектами. Команды врагов на Серпуло: `Team.crux`.

Основные типы в волнах: **dagger, crawler, flare, mace, pulsar, spiroct, quasar** (и далее по сложности).

---

## 7. Технологическое древо Серпуло

Корень: `coreShard`. 202 узла: 138 блоков, 35 юнитов, 29 секторов (в том числе progres-блокиры `SectorComplete`). Полный порядок разблокировки см. в исходнике `SerpuloTechTree.java` (в репозитории оригинала).

---

## 8. Кампания Серпуло

- `allowWaves = true`, `allowSectorInvasion = true`, `allowLaunchLoadout = true`
- `waveTeam = Team.crux`, `enemyFactoryActivationDelay = 2 ч`, `launchCapacityMultiplier = 0.5`
- Захват сектора: `wave >= winWave` и 0 врагов (`Logic.checkGameState`)
- Победа на планете: прохождение `planetaryTerminal`

---

*Следующий файл: `compatibility-matrix.md` — различие полноты контента, совместимости механик и масштаба симуляции.*