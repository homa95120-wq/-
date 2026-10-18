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

Последний релиз: **[v1.1 — CampaignThreatRadar.jar](../../releases/latest)** (4205 байт,
SHA-256 `2b9d7e77f3d4cd1950093489353f402b9e60d17ae9df199a626e0015c8c6d000`).
Файл скачивается одним кликом и без входа в GitHub. В описании каждого релиза указаны
его собственные размер и SHA-256 — сверьте их со скачанным файлом:

- Windows: `certutil -hashfile CampaignThreatRadar.jar SHA256`
- Linux/macOS: `sha256sum CampaignThreatRadar.jar`

Если хэш или размер не совпали, скачался не jar (так бывает, когда браузер сохраняет страницу
входа или ошибки под именем `.jar`). Признак настоящего jar — первые два байта `PK`
(PowerShell: `Format-Hex CampaignThreatRadar.jar | Select-Object -First 1`).
Скачайте файл из Releases заново.

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

Три способа, любой из них даёт один и тот же файл:

1. **Из игры, самый простой.** **Mods → Import → Import from GitHub**, ввести
   `homa95120-wq/-` (имя репозитория — это буквально дефис). Игра сама возьмёт
   `CampaignThreatRadar.jar` из последнего релиза, перезапустится и включит мод.
2. **Скачать из Releases** и в игре нажать **Mods → Import file…**, выбрать jar.
3. **Скопировать вручную** в папку модов и перезапустить игру:
   - **Windows:** `%APPDATA%\Mindustry\mods\`
   - **Linux:** `~/.local/share/Mindustry/mods/`
   - **macOS:** `~/Library/Application Support/Mindustry/mods/`

После перезапуска мод должен быть включён в списке (стрелка/галочка слева от названия).
Если ставили вручную — включите его сами и перезапустите игру ещё раз.

### Мод не появился в списке? / Mod not in the list?

Сначала проверьте сам файл — это самая частая причина. В `mods` должен лежать ровно
4205 байт с хэшем из раздела «Скачать». Если размер другой (особенно 0, несколько КБ
или десятки КБ) — в папку попал не jar: недокачанная загрузка, HTML-страница GitHub
или ZIP репозитория. Удалите файл и поставьте мод способом 1 или 2 из раздела «Установка».

Mindustry молча пропускает jar, из которого не смогла прочитать метаданные. В логе
(Windows `%APPDATA%\Mindustry\logs\latest.log`, Linux `~/.local/share/Mindustry/logs/`,
macOS `~/Library/Application Support/Mindustry/logs/`) ищите строки:

- `doesn't have a '[mod/plugin].[h]json' file, skipping` — в корне архива нет `mod.hjson`
  (файл битый, это не jar, или внутри лишняя папка-обёртка);
- `Failed to load mod file ... Skipping` — мод упал при загрузке, ниже будет стектрейс;
- строк с названием мода вообще нет — файл не попал в папку модов (игра не перезапущена,
  или jar положен в папку установки игры вместо папки данных — пути выше).

Быстрая проверка лога в Windows PowerShell:

```powershell
Select-String -Path "$env:APPDATA\Mindustry\logs\latest.log" -Pattern 'mod','CampaignThreatRadar'
```

Если в списке мод есть, но панели в кампании нет — проверьте, что мод включён и игра
перезапущена: обработчик HUD вешается при старте клиента, на лету он не появляется.

Затем запустите кампанию — в левом верхнем углу появится панель **CAMPAIGN RADAR**:
количество вражеских юнитов, сколько из них движутся к ядрам и за сколько секунд
ближайший из них доберётся. Вне кампании панель пишет, что неактивна.

## Совместимость / Compatibility

Mindustry v8: build **154** … **160.7**+ (проверено по исходникам игры/Arc билдов 154 и 160.7).

Если будущий мажорный билд игры снова поднимет планку `minJavaModGameVersion`,
просто увеличьте `minGameVersion` в `mod.hjson` (и проверьте API).
