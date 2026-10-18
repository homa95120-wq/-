# Передаточный промт: Campaign Threat Radar (Mindustry v8)

Обновлён 2026-10-18 после добавления скриптовой (ZIP) версии мода.
Этот файл — единственный источник истины о состоянии проекта.
Читать целиком перед любыми действиями.

---

## 1. Что это за проект

Клиентский HUD-мод для **Mindustry v8** (билды 154+), репозиторий
`github.com/homa95120-wq/-` (публичный, default branch `main`, имя репозитория —
буквально дефис). Мод считает вражеских юнитов в кампании и предупреждает, если кто-то
из них явно движется к ядрам игрока. Ничего не создаёт в мире, не меняет правила и не
отправляет пакеты — только читает состояние игры.

Одна логика, две сборки (**не включать одновременно — будет две панели**):

* **Java (основная, проверенная):**
  `src/main/java/campaignradar/CampaignThreatRadar.java` — единственный класс.
  Корневой `mod.hjson` — имя `campaign-threat-radar`, версия 1.1, `main`,
  `java: true`, `minGameVersion: 154`. `build.gradle` — Java 17, зависимость
  `compileOnly Anuken:Mindustry:v160.7` из `dependencies.jar` GitHub-релиза игры.
* **Скриптовая / ZIP (запасная, в игре ещё не запускалась):**
  `scriptmod/` — порт той же логики на Rhino-JS API игры.
  `scriptmod/mod.hjson` — имя `campaign-threat-radar-zip`, displayName
  `Campaign Threat Radar (ZIP)`, **без** `main` и **без** `java: true`
  (иначе загрузчик считает архив Java-модом и ищет в нём класс).
  `scriptmod/build.py` собирает `dist/CampaignThreatRadar.zip`
  (в корне архива ровно `mod.hjson` + `scripts/main.js`, сборка воспроизводима).
  Тесты офлайн: `node scriptmod/test-logic.js` (13 проверок чистой логики) и
  `node scriptmod/test-hud.js` (4 проверки HUD-клея на моках; Rhino-специфику
  моки не проверяют). Подробнее — `scriptmod/README.md`.
* `.github/workflows/build.yml` — сборка jar + тесты и сборка zip на каждый push/PR.
* `.github/workflows/release.yml` — по тегу `v*` собирает оба файла, гоняет тесты
  скриптового мода и прикладывает jar + zip к релизу.
* `.gitattributes` — `scriptmod/** linguist-documentation=true`. Это важно:
  внутриигровой импорт из GitHub определяет «Java-репозиторий» по языку репозитория
  из GitHub API; если JS «перевесит» Java, импорт пойдёт не за jar из релиза,
  а за архивом ветки. После каждого мержа в `main` проверять
  `gh api repos/homa95120-wq/- --jq .language` — должно быть `Java`.

## 2. Состояние на момент передачи (проверено, не гипотезы)

| Что | Статус |
|---|---|
| GitHub Release `v1.1` | **опубликован** 2026-10-18T09:00:49Z, latest |
| Ассет `CampaignThreatRadar.jar` | **4205 байт**, state `uploaded` |
| SHA-256 jar | `2b9d7e77f3d4cd1950093489353f402b9e60d17ae9df199a626e0015c8c6d000` |
| Ассет `CampaignThreatRadar.zip` | **3271 байт** (добавляется к тому же релизу v1.1) |
| SHA-256 zip | `9a55dd5f9a6444d1b1f4fd0bf6a616b957196930c259e423d2467c140c61adf9` |

Релиз: `https://github.com/homa95120-wq/-/releases/tag/v1.1`
(jar: `.../releases/download/v1.1/CampaignThreatRadar.jar`,
zip: `.../releases/download/v1.1/CampaignThreatRadar.zip`).

Проверка состояния одной командой:
`gh release view v1.1 --json tagName,assets` — сверять размеры и хэши с таблицей
(хэш файла из release view не виден, он сверяется локально после скачивания;
в описании релиза размер и SHA-256 печатает сам workflow).

### Чем публиковался релиз (важно)

`gh workflow run release.yml` из песочницы может дать
`HTTP 403: Resource not accessible by integration`. Рабочий способ — пуш тега:

```bash
git tag -f v1.1 <commit-on-main>
git push origin v1.1
```

Добавить/заменить файл в существующем релизе без пересоздания:
`gh release upload v1.1 dist/CampaignThreatRadar.zip --clobber`.

## 3. Пути игры (проверено по исходникам v160.7)

`Vars.loadSettings()`: при Steam `settings.setDataDirectory(Core.files.local("saves/"))`,
иначе данные — `OS.getAppDataDirectoryString("Mindustry")`. Далее `Vars.init()`:
`modDirectory = dataDirectory.child("mods/")`, файл лога —
`dataDirectory.child("last_log.txt")` (не `logs/latest.log` — такого пути в v8 нет).

| | Steam | Не Steam |
|---|---|---|
| Папка данных | `<папка установки игры>\saves\` | Win `%APPDATA%\Mindustry\`, Linux `~/.local/share/Mindustry/`, macOS `~/Library/Application Support/Mindustry/` |
| Моды | `...\saves\mods\` (Win обычно `...\steamapps\common\Mindustry\saves\mods\`) | `...\Mindustry\mods\` и т.д. |
| Лог | `<папка игры>\saves\last_log.txt` | рядом, `...\Mindustry\last_log.txt` |

## 4. Что уже проверено по исходникам Mindustry v160.7

* `Mods.load()`: из папки модов берутся только `*.jar`, `*.zip` и директории с
  мета-файлом в корне. Остальные файлы молча игнорируются. **Именно это случилось
  у пользователя:** в `mods` были распакованы файлы репозитория (скачанный
  `...-main.zip` GitHub — это исходники, а не мод), загрузчик их не увидел.
  Лечится установкой одного архива мода целиком, без распаковки.
* Мета не читается / нет `mod.hjson` в корне архива — мод молча пропускается,
  в логе `doesn't have a '[mod/plugin].[h]json' file, skipping` или
  `Failed to load mod file ... Skipping`.
* `LoadedMod.isJava()` = `meta.java || main != null || meta.main != null`;
  два мода с одним внутренним именем нельзя: `A mod with the name '...' is
  already imported` — поэтому у zip-версии имя `campaign-threat-radar-zip`.
* `Mods.loadScripts()`: `scripts/*.js`; файлов несколько — именно `scripts/main.js`.
* `core/assets/scripts/global.js` импортирует для скриптов `Vars`, `Groups`,
  `Events`, `ClientLoadEvent`, `Styles`, `Touchable`, `Color`, `Time`, ... и
  даёт обёртки `cons()`/`run()` для SAM-интерфейсов Arc. `main.js` использует
  `cons(...)` для `Events.on`, `hudGroup.fill` и `Groups.unit.each`.
* `UI.hudGroup` существует, видим только в игре. `Vars.state.isCampaign()`,
  `Vars.state.rules.waveTeam`, `Vars.state.teams.get(team).cores`,
  `Groups.unit`, `unit.vel` — все сигнатуры сверены с Java-версией мода.
* `Vars.minJavaModGameVersion = 154`, `minModGameVersion = 136`.
* Встроенный импорт из GitHub: **Mods → Import → Import from GitHub**, вводится
  `homa95120-wq/-`; `githubImportJavaMod()` берёт из последнего релиза первый
  ассет `*.jar` (zip-ассет при этом игнорируется, мешать не будет), а ветка
  «это Java-репозиторий» определяется по языку репозитория из GitHub API —
  см. пункт про `.gitattributes` в разделе 1.

## 5. Что осталось (задачи)

1. **Пользователь ставит один из файлов релиза v1.1 в Steam** (его случай):
   `<игра>\saves\mods\`, старые распакованные файлы оттуда удалить, полный
   перезапуск, включить **Campaign Threat Radar** (jar) *или*
   **Campaign Threat Radar (ZIP)** (zip), ещё раз перезапуск, зайти в кампанию.
   Это первая проверка zip-версии в настоящей игре — до неё она тестировалась
   только офлайн (13/13 логика, 4/4 мок-харнесс).
2. Если панели нет — диагностика строго по порядку: размер/хэш/`PK` файла →
   `last_log.txt` (`campaign-radar`, `Failed to load mod`, название мода) →
   включён ли мод и была ли кампания. Скриптовая версия при ошибке показывает
   на панели `Radar error` и пишет `[campaign-radar] ...` в лог.
3. Если zip-версия в игре заработает — отметить это здесь и в `README.md`
   (снять «в игре ещё не запускалась»). Если нет — лог `[campaign-radar]`
   покажет место; чинить в `scriptmod/scripts/main.js`, пересобирать
   `python3 scriptmod/build.py`, перевыкладывать ассет
   (`gh release upload v1.1 dist/CampaignThreatRadar.zip --clobber`) и
   обновлять хэш в README и здесь.
4. Необязательное улучшение: поле `repo: homa95120-wq/-` в корневом `mod.hjson`
   (кнопка обновления в списке модов). Меняет jar — нужен новый тег/релиз
   (например `v1.1.1`) и повторная сверка хэшей.

## 6. Чего делать НЕ нужно

* Собирать jar локально в песочнице: там нет `javac`, а
  `services.gradle.org`/`objects.githubusercontent.com` недоступны. Сборка — только CI.
* Скачивать ассеты Actions/релиза в песочницу: редиректы ведут на заблокированные
  хосты. Проверять через `gh release view` / `gh run view --log` и хэши workflow.
* Класть в `mods` что-либо, кроме одного архива мода (jar или zip) целиком.
* Включать jar и zip одновременно.

## 7. Полезные команды

```bash
gh run list --limit 5                                   # состояние CI
gh release view v1.1 --json tagName,assets              # релиз и ассеты
gh api repos/homa95120-wq/- --jq .language              # должно быть "Java"
python3 scriptmod/build.py                              # пересобрать zip
node scriptmod/test-logic.js && node scriptmod/test-hud.js
gh release upload v1.1 dist/CampaignThreatRadar.zip --clobber
git tag -f v1.2 <commit-on-main> && git push origin v1.2 -f   # новый релиз
```

Версия в обоих `mod.hjson` и тег должны совпадать (`1.1` ↔ `v1.1`).

## 8. Стиль общения

Пользователь пишет по-русски. Отвечать по-русски, давать проверяемые шаги с командами,
не выдумывать причины проблем: сначала файл (размер/хэш/`PK`), потом лог, потом код.
Честно отделять «проверено в игре» от «проверено офлайн»: zip-версия пока второе.
