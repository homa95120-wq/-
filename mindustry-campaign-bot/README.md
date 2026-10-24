# Serpulo Campaign Bot (`v1.0`)

Отдельный самостоятельный мод для **Mindustry v8** (build 154+ / `v160.7`), который **сам проходит кампанию Serpulo от Ground Zero до Planetary Launch Terminal** по честным игровым правилам — без читов, спавна ресурсов или обхода механик игры.

Мод помечен как `hidden: true` (чисто клиентский, не ломает совместимость с серверами) и жёстко блокирует работу в любой сетевой игре (`Vars.net.active()`).

---

## 📦 Готовые сборки (ставьте только один вариант)

1. **`release/SerpuloCampaignBot.zip`** — готовый скриптовый мод (`Serpulo Campaign Bot (ZIP)`), уже собран и проверен локально, **не требует Java / JDK**.
2. **`SerpuloCampaignBot.jar`** — скомпилированная Java 17 версия (`Serpulo Campaign Bot`), автоматически собирается и проверяется в GitHub Actions ([`.github/workflows/build-mindustry-campaign-bot.yml`](../.github/workflows/build-mindustry-campaign-bot.yml)).

> Не включайте `.jar` и `.zip` версию одновременно, чтобы не дублировать панель управления. Мод использует собственные имена (`serpulo-campaign-bot` / `serpulo-campaign-bot-zip`) и располагается в **верхнем левом углу** под ванильным блоком волн, поэтому может работать параллельно с `CampaignThreatRadar` или полностью отдельно от него.

---

## 🚀 Установка и запуск

1. Откройте **Mindustry v8** → **Моды (Mods)** → **Импортировать файл (Import file…)** и выберите `SerpuloCampaignBot.zip` (или `SerpuloCampaignBot.jar`), либо скопируйте файл в папку модов:
   - **Steam (Windows):** `<папка Mindustry>\saves\mods\`
   - **Windows:** `%APPDATA%\Mindustry\mods\`
   - **Linux:** `~/.local/share/Mindustry/mods/`
   - **macOS:** `~/Library/Application Support/Mindustry/mods/`
2. Перезапустите игру и убедитесь, что мод включён.
3. Откройте **Кампания → Карта планеты Serpulo** (или зайдите в любой сектор Serpulo) и нажмите **`▶ Кампания`**:
   - На **карте планеты** панель появляется сверху по центру.
   - **Внутри сектора** сворачиваемая панель (`▾`) находится слева сверху с кнопками **`▶ Кампания`**, **`⏸ Пауза`**, **`■ Стоп`**.

---

## 🤖 Как бот честно проходит кампанию Serpulo

### 1. Директор науки и карты планеты (`ResearchAndPlanetDirector`)
- Строит полный транзитивный граф целей до **`Planetary Launch Terminal`** и **`Interplanetary Accelerator`** (включая `parent`, `SectorComplete`, `OnSector`, `Research` и `Produce`).
- Честно изучает узлы `TechTree`, списывая реальные накопленные ресурсы со складов незамороженных баз Serpulo (`sector.removeItem`) с сохранением неприкосновенного строительного резерва активного сектора, обновляет `finishedRequirements`, сохраняет прогресс (`node.save()`) и вызывает `Vars.control.checkAutoUnlocks()`.
- Выбирает следующий сектор по приоритету:
  1. **Отражение вторжения** на уже захваченную сюжетную базу (`isAttacked()`).
  2. **Открытые сюжетные сектора (`SectorPreset`) на критическом пути к финалу** (от простых к сложным).
  3. **Накопление дефицитных ресурсов** для следующего техно-узла или стоимости ядра вылета.
- Запускается между секторами по правилам ванильного `PlanetDialog` / `LaunchLoadoutDialog`: находит допустимую базу-донора через `planet.generator.findLaunchCandidate`, списывает стоимость ядра (`Loadouts.basicShard` / `basicFoundation` / `basicNucleus`) и стартовый груз через `from.removeItems(...)`, сохраняет текущий сектор и выполняет `Vars.control.playSector(...)`.

### 2. Автопилот внутри сектора (`SectorAutopilot`)
- **Экономика и логистика:** BFS-поиск жил руды и прокладка конвейеров (обычных и титановых) в ядро и пристыкованные хранилища (`Container` / `Vault`), буры всех уровней (`mechanicalDrill` → `pneumaticDrill` → `laserDrill` → `blastDrill` для тория), ручная добыча юнитом игрока на старте.
- **Апгрейд базы:** автоматическое улучшение `Core: Shard → Core: Foundation → Core: Nucleus` на месте и пристройка `Container` / `Vault` вплотную к ядру.
- **Энергосеть:** `Combustion Generator` (у угольных буров или у ядра), `Steam Generator + Water Extractor`, `Thermal Generator` на горячих породах, `RTG Generator`, солнечные панели и автоматическая протяжка/линковка `PowerNode` / `PowerNodeLarge` между изолированными энергографами (`Call.tileConfig`).
- **Промышленность вокруг ядра:** компактные ячейки `[Unloader + Crafter (+ жидкостный блок)]` для производства графита, кремния, метастекла, спор (`Cultivator`), масла (`Spore Press`), пластаниума, криожидкости, пиратита, взрывчатой смеси, фазовой ткани и кинетического сплава (`Surge Alloy`), а также насосы на воде и нефти для естественного открытия жидкостей (`Produce`).
- **Многоуровневая оборона и снабжение:** ориентированные к точкам спавна и базам врага укрепрайоны (стены от медных до кинетических, турели ПВО и наземного огня от `Duo`/`Scatter` до `Lancer`/`Salvo`/`Swarmer`, `Mender`/`Mend Projector`), доставка лучших доступных боеприпасов из ядра и расчёт выживаемости перед досрочным вызовом волны (`Vars.logic.skipWave()`).
- **Производство армии и RTS-штурм вражеских баз:** постройка цепочек `Air / Ground / Naval Factory` + `Additive Reconstructor (T2)` + `Multiplicative Reconstructor (T3)`, автоматическое распределение `Mono` (добыча), `Poly` (стройка/восстановление) и `Mega` (ремонт), сбор ударного кулака на рубеже и штурм вражеских турелей и ядер в attack-секторах через `Call.commandUnits` + `UnitStance`.
- **Защита от зависаний и сохранений:** состояние автокампании сохраняется в `Core.settings` (`scb-campaign-autopilot-enabled`), зависшие планы строительства помечаются в чёрный список клеток `Watchdog`-таймером, а при серии поражений на одном секторе бот безопасно переходит в режим `НУЖНА ПОМОЩЬ`, не сливая ресурсы.

---

## 🛠 Локальная проверка и сборка

```bash
# Проверка всех алгоритмов и симуляция сектора + полной кампании Serpulo (Node.js)
node mindustry-campaign-bot/test-logic.js
node mindustry-campaign-bot/test-campaign-sim.js

# Пересборка воспроизводимого архива SerpuloCampaignBot.zip (Python 3)
python3 mindustry-campaign-bot/build.py

# Сборка Java 17 версии SerpuloCampaignBot.jar (при установленном JDK 17)
./gradlew -p mindustry-campaign-bot jar
```
