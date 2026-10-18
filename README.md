# Campaign Threat Radar

Клиентский мод-надстройка для **Mindustry v8**: показывает в углу экрана HUD-панель
с числом вражеских юнитов и предупреждением, если кто-то из них явно движется к вашим ядрам.
Мод ничего не создаёт в мире, не меняет правила и не отправляет пакеты — только читает состояние игры.

A client-only HUD mod for **Mindustry v8**: it counts enemy units and warns you when
one of them is clearly heading for one of your cores. Purely read-only.

Есть две равноценные по логике сборки (ставьте и включайте **только одну**):

| Файл | Что это | Статус |
|---|---|---|
| `CampaignThreatRadar.jar` | Java-мод, та же логика на Java 17 | проверенная сборка, рекомендуется |
| `CampaignThreatRadar.zip` | скриптовая версия (`Campaign Threat Radar (ZIP)`), Java не нужна | собрана и протестирована офлайн, **в игре ещё не запускалась** |

---

## Что было сломано / What was broken

Мод был написан под старую версию игры и в новой (v8, build 154+) не работал по трём причинам:

1. **`Vars.ui.hudGroups` — такого поля в игре никогда не было.** Правильное поле —
   `Vars.ui.hudGroup` (одна группа, `WidgetGroup`). Из-за этого мод не компилировался вовсе.
2. **`mindustry.game.Events` больше не существует** — класс `Events` переехал в библиотеку Arc:
   теперь это `arc.Events`. Старый импорт не компилируется.
3. **Версия `minGameVersion: 146` слишком старая для java-мода.** Начиная с v8 игра требует,
   чтобы java-моды объявляли `minGameVersion >= 154` (`Vars.minJavaModGameVersion`), иначе мод
   помечается как несовместимый и не загружается. Также в `mod.hjson` добавлено `java: true`.

Кроме того, проект обновлён под актуальный способ сборки из официального шаблона
Java-модов Mindustry: зависимости берутся из `dependencies.jar` в GitHub-релизах игры
(вместо jitpack), а код компилируется под **Java 17** (v8 собрана на Java 17, классфайлы
старых версий с ней не линкуются).

The mod was written against an API that never existed (`ui.hudGroups`), used the removed
`mindustry.game.Events` import (it is `arc.Events` now), and declared `minGameVersion: 146`,
which v8 rejects for java mods (must be >= 154). The build now follows the official
Mindustry Java mod template (GitHub-release `dependencies.jar`, Java 17).

## Скачать / Download

Последний релиз: **[v1.1](../../releases/latest)**

- `CampaignThreatRadar.jar` — в релизе v1.1: 4205 байт,
  SHA-256 `2b9d7e77f3d4cd1950093489353f402b9e60d17ae9df199a626e0015c8c6d000`
- `CampaignThreatRadar.zip` — пока лежит в репозитории:
  [`dist/CampaignThreatRadar.zip`](../../blob/main/dist/CampaignThreatRadar.zip)
  (на странице файла кнопка **Download raw file**), 3271 байт,
  SHA-256 `9a55dd5f9a6444d1b1f4fd0bf6a616b957196930c259e423d2467c140c61adf9`.
  К релизу он приложится автоматически начиная со следующего тега
  (workflow `Release` уже прикладывает оба файла); к v1.1 его нужно
  приложить вручную через веб-интерфейс GitHub — из песочницы загрузка
  ассетов заблокирована (`uploads.github.com` недоступен, workflow
  dispatch даёт 403). Тот же файл есть артефактом `CampaignThreatRadar-zip`
  у каждого запуска **Actions → Build Mod** (нужен вход в GitHub).

Файлы скачиваются одним кликом и без входа в GitHub. В описании каждого релиза указаны
его собственные размер и SHA-256 — сверьте их со скачанным файлом:

- Windows: `certutil -hashfile CampaignThreatRadar.jar SHA256`
- Linux/macOS: `sha256sum CampaignThreatRadar.jar`

Если хэш или размер не совпали, скачался не мод (так бывает, когда браузер сохраняет страницу
входа или ошибки под именем файла). Признак настоящего архива — первые два байта `PK`
(PowerShell: `Format-Hex CampaignThreatRadar.jar | Select-Object -First 1`).
Скачайте файл из Releases заново. **Не распаковывайте его** — в `mods` кладётся сам архив.

## Сборка / Building

### Java-jar

Нужен JDK 17+ (на компьютере). В корне репозитория:

```bash
./gradlew jar
```

Готовый мод: `build/libs/CampaignThreatRadar.jar` (внутри — скомпилированные классы + `mod.hjson`).

### ZIP (скриптовая версия)

JDK не нужен, только Python 3 и, для тестов, Node:

```bash
python3 scriptmod/build.py     # -> dist/CampaignThreatRadar.zip
node scriptmod/test-logic.js   # 13 проверок чистой логики
node scriptmod/test-hud.js     # мок-харнесс HUD-клея
```

Внутри архива ровно два файла в корне: `mod.hjson` и `scripts/main.js`.
Сборка воспроизводима: повторная сборка тех же исходников даёт тот же SHA-256.
Подробности и обоснование API — в [`scriptmod/README.md`](scriptmod/README.md).

Every push also builds both files in GitHub Actions (tab **Actions** → latest run →
artifacts `CampaignThreatRadar` and `CampaignThreatRadar-zip`). Artifacts require a GitHub
login to download, so they are meant for quick checks, not for distribution —
releases are the download path for players.

### Выпуск релиза / Publishing a release

The `Release` workflow builds both files, runs the script-mod tests and attaches
jar + zip to a GitHub Release:

```bash
git tag v1.1
git push origin v1.1
```

Or without a terminal: **Actions → Release → Run workflow** and enter the tag (`v1.1`).
If a release with that tag already exists, its assets are replaced.

## Установка / Installing

1. **Из игры, самый простой (только jar).** **Mods → Import → Import from GitHub**, ввести
   `homa95120-wq/-` (имя репозитория — это буквально дефис). Игра сама возьмёт
   `CampaignThreatRadar.jar` из последнего релиза.
2. **Скачать из Releases** и в игре нажать **Mods → Import file…**, выбрать jar или zip.
3. **Скопировать вручную** один архив (не распаковывая) в папку модов и перезапустить игру:

   Куда именно — зависит от того, Steam у вас или нет. У Steam-версии данные игры лежат
   в папке установки игры (`Vars.loadSettings()`: при Steam `dataDirectory` — это
   `saves/` рядом с игрой), у обычной — в папке данных пользователя:

   - **Steam (любая ОС):** `<папка установки игры>\saves\mods\`
     (Windows обычно `...\steamapps\common\Mindustry\saves\mods\`)
   - **Windows:** `%APPDATA%\Mindustry\mods\`
   - **Linux:** `~/.local/share/Mindustry/mods/`
   - **macOS:** `~/Library/Application Support/Mindustry/mods/`

После перезапуска мод должен быть включён в списке (**Campaign Threat Radar** для jar,
**Campaign Threat Radar (ZIP)** для zip). Если ставили вручную — включите его сами и
перезапустите игру ещё раз. Не включайте обе версии одновременно: будет две панели.

Затем запустите кампанию — в левом верхнем углу появится панель **CAMPAIGN RADAR**:
количество вражеских юнитов, сколько из них движутся к ядрам и за сколько секунд
ближайший из них доберётся. Вне кампании панель пишет, что неактивна.

### Мод не появился в списке? / Mod not in the list?

Самая частая причина — в `mods` лежит не архив мода. Проверьте по порядку:

1. **Что именно лежит в папке.** Должен быть ровно один файл `CampaignThreatRadar.jar`
   (4205 байт) или `CampaignThreatRadar.zip` (3271 байт) с хэшем из раздела «Скачать».
   Загрузчик смотрит только на верхний уровень папки `mods` и берёт оттуда файлы
   `*.jar`/`*.zip` и папки с `mod.hjson` внутри; отдельные распакованные файлы
   (например содержимое скачанного с GitHub архива репозитория `...-main.zip`:
   `README.md`, `src`, `build.gradle` и т.д.) он молча игнорирует. Если у вас там
   лежат такие файлы — удалите их и положите архив мода целиком.
2. **Первые два байта — `PK`**, размер и хэш совпадают (см. выше). Не совпали —
   скачайте файл заново из Releases.
3. **Лог игры.** Файл **`last_log.txt`** в корне папки данных (Steam:
   `<папка игры>\saves\last_log.txt`; Windows: `%APPDATA%\Mindustry\last_log.txt`;
   Linux/macOS — рядом с `mods` из списка выше). Ищите строки:

   - `doesn't have a '[mod/plugin].[h]json' file, skipping` — в корне архива нет
     `mod.hjson` (файл битый, это не архив мода, или внутри лишняя папка-обёртка);
   - `Failed to load mod file ... Skipping` — мод упал при загрузке, ниже будет стектрейс;
   - `[campaign-radar] ...` — ошибка скриптовой версии, панель при этом показывает `Radar error`;
   - строк про мод нет вообще — файл не попал в ту папку модов, откуда игра читает
     (см. Steam/не-Steam выше), или игра не была полностью перезапущена.

   Быстрый поиск в Windows PowerShell (Steam):

   ```powershell
   Select-String -Path "D:\SteamLibrary\steamapps\common\Mindustry\saves\last_log.txt" -Pattern 'mod','campaign-radar'
   ```

Если в списке мод есть, но панели в кампании нет — проверьте, что мод включён и игра
перезапущена: обработчик HUD вешается при старте клиента, на лету он не появляется.

## Совместимость / Compatibility

Mindustry v8: build **154** … **160.7**+ (проверено по исходникам игры/Arc билдов 154 и 160.7).

Если будущий мажорный билд игры снова поднимет планку `minJavaModGameVersion`,
просто увеличьте `minGameVersion` в `mod.hjson` (и проверьте API).
