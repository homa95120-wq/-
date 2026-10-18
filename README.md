# Campaign Threat Radar

Клиентский мод-надстройка для **Mindustry v8**: показывает в углу экрана HUD-панель
с числом вражеских юнитов и предупреждением, если кто-то из них явно движется к вашим ядрам.
Мод ничего не создаёт в мире, не меняет правила и не отправляет пакеты — только читает состояние игры.

A client-only HUD mod for **Mindustry v8**: it counts enemy units and warns you when
one of them is clearly heading for one of your cores. Purely read-only.

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

Готовый jar лежит в разделе **[Releases](../../releases/latest)** — файл `CampaignThreatRadar.jar`
скачивается одним кликом и без входа в GitHub. В описании релиза указаны размер и SHA-256;
сверьте их со скачанным файлом:

- Windows: `certutil -hashfile CampaignThreatRadar.jar SHA256`
- Linux/macOS: `sha256sum CampaignThreatRadar.jar`

Если хэш или размер не совпали, скачался не jar (так бывает, когда браузер сохраняет страницу
входа или ошибки под именем `.jar`). Скачайте файл из Releases заново.

## Сборка / Building

Нужен JDK 17+ (на компьютере). В корне репозитория:

```bash
./gradlew jar
```

Готовый мод: `build/libs/CampaignThreatRadar.jar` (внутри — скомпилированные классы + `mod.hjson`).

Every push also builds the jar in GitHub Actions (tab **Actions** → latest run → artifact
`CampaignThreatRadar`). Artifacts require a GitHub login to download, so they are meant for
quick checks, not for distribution — releases are the download path for players.

### Выпуск релиза / Publishing a release

The `Release` workflow builds the jar and attaches it to a GitHub Release:

```bash
git tag v1.1
git push origin v1.1
```

Or without a terminal: **Actions → Release → Run workflow** and enter the tag (`v1.1`).
If a release with that tag already exists, its jar is replaced.

## Установка / Installing

- **Windows:** скопируйте `CampaignThreatRadar.jar` в `%APPDATA%\Mindustry\mods\`
- **Linux:** `~/.local/share/Mindustry/mods/`
- **macOS:** `~/Library/Application Support/Mindustry/mods/`

Или в игре: **Mods → Import file…** и выбрать jar. После перезапуска включите мод в списке.

### Мод не появился в списке? / Mod not in the list?

Mindustry молча пропускает jar, из которого не смогла прочитать метаданные. В логе
(Windows `%APPDATA%\Mindustry\logs\latest.log`, Linux `~/.local/share/Mindustry/logs/`,
macOS `~/Library/Application Support/Mindustry/logs/`) ищите строки:

- `doesn't have a '[mod/plugin].[h]json' file, skipping` — в корне архива нет `mod.hjson`
  (файл битый, это не jar, или внутри лишняя папка-обёртка);
- `Failed to load mod file ... Skipping` — мод упал при загрузке, ниже будет стектрейс.

Ещё две частые причины: игра не была перезапущена после копирования файла, и jar положен
в папку установки игры вместо папки данных (пути выше).

Затем запустите кампанию — в левом верхнем углу появится панель **CAMPAIGN RADAR**:
количество вражеских юнитов, сколько из них движутся к ядрам и за сколько секунд
ближайший из них доберётся. Вне кампании панель пишет, что неактивна.

## Совместимость / Compatibility

Mindustry v8: build **154** … **160.7**+ (проверено по исходникам игры/Arc билдов 154 и 160.7).

Если будущий мажорный билд игры снова поднимет планку `minJavaModGameVersion`,
просто увеличьте `minGameVersion` в `mod.hjson` (и проверьте API).
