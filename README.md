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

## Сборка / Building

Нужен JDK 17+ (на компьютере). В корне репозитория:

```bash
./gradlew jar
```

Готовый мод: `build/libs/CampaignThreatRadar.jar` (внутри — скомпилированные классы + `mod.hjson`).

Alternatively, every push builds the jar automatically via GitHub Actions
(see the **Actions** tab → latest run → artifact `CampaignThreatRadar`).

## Установка / Installing

- **Windows:** скопируйте `CampaignThreatRadar.jar` в `%APPDATA%\Mindustry\mods\`
- **Linux:** `~/.local/share/Mindustry/mods/`
- **macOS:** `~/Library/Application Support/Mindustry/mods/`

Или в игре: **Mods → Import file…** и выбрать jar. После перезапуска включите мод в списке.

Затем запустите кампанию — в левом верхнем углу появится панель **CAMPAIGN RADAR**:
количество вражеских юнитов, сколько из них движутся к ядрам и за сколько секунд
ближайший из них доберётся. Вне кампании панель пишет, что неактивна.

## Совместимость / Compatibility

Mindustry v8: build **154** … **160.7**+ (проверено по исходникам игры/Arc билдов 154 и 160.7).

Если будущий мажорный билд игры снова поднимет планку `minJavaModGameVersion`,
просто увеличьте `minGameVersion` в `mod.hjson` (и проверьте API).
