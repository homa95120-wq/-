# Передаточный промт: Campaign Threat Radar (Mindustry v8)

Обновлён 2026-10-18 после публикации релиза **v1.1**. Этот файл — единственный источник
истины о состоянии проекта. Читать целиком перед любыми действиями.

---

## 1. Что это за проект

Клиентский HUD-мод для **Mindustry v8** (билды 154+), репозиторий
`github.com/homa95120-wq/-` (публичный, default branch `main`, имя репозитория —
буквально дефис). Мод считает вражеских юнитов в кампании и предупреждает, если кто-то
из них явно движется к ядрам игрока. Ничего не создаёт в мире, не меняет правила и не
отправляет пакеты — только читает состояние игры.

* `src/main/java/campaignradar/CampaignThreatRadar.java` — единственный класс мода.
* `mod.hjson` — имя `campaign-threat-radar`, версия 1.1, `main`, `java: true`,
  `minGameVersion: 154`.
* `build.gradle` — Java 17, зависимость `compileOnly Anuken:Mindustry:v160.7` из
  `dependencies.jar` GitHub-релиза игры (ivy), `jar` кладёт `mod.hjson` в корень архива.
* `.github/workflows/build.yml` — сборка на каждый push/PR.
* `.github/workflows/release.yml` — сборка и публикация релиза по тегу `v*`.

## 2. Состояние на момент передачи (проверено, не гипотезы)

| Что | Статус |
|---|---|
| CI `Build Mod` на `main` (`9986fb3`) | зелёный |
| CI `Release` (run 39113633136, тег `v1.1`) | зелёный |
| GitHub Release `v1.1` | **опубликован** 2026-10-18T09:00:49Z, latest |
| Ассет `CampaignThreatRadar.jar` | **4205 байт**, state `uploaded` |
| SHA-256 | `2b9d7e77f3d4cd1950093489353f402b9e60d17ae9df199a626e0015c8c6d000` |

Релиз доступен по адресу:
`https://github.com/homa95120-wq/-/releases/download/v1.1/CampaignThreatRadar.jar`
(страница: `https://github.com/homa95120-wq/-/releases/tag/v1.1`).

Хэш воспроизводим: независимые запуски CI давали тот же файл 4205 байт и тот же SHA-256.
Размер и хэш в описании релиза генерируются самим workflow из собранного файла, поэтому
они гарантированно соответствуют ассету.

### Чем публиковался релиз (важно)

`gh workflow run release.yml` в песочнице **не работает**: токен получает
`HTTP 403: Resource not accessible by integration` на `actions/workflows/.../dispatches`.
Рабочий способ — пуш тега из локального клона:

```bash
git tag -f v1.1 <commit-on-main>
git push origin v1.1
```

Это единственная причина, по которой в репозитории появился тег. Ветку `main` при этом
не трогали.

## 3. Что уже проверено по исходникам Mindustry v160.7

* `Mods.load()`: файл, из которого не читается мета, **молча отбрасывается**; в логе
  остаются только `doesn't have a '[mod/plugin].[h]json' file, skipping` или
  `Failed to load mod file ... Skipping`.
* `UI.hudGroup` существует (`public WidgetGroup menuGroup, hudGroup`), создаётся в
  `UI.init()`, видим только в игре (`visible(() -> state.isGame())`).
* `LoadedMod.isJava()` = `meta.java || main != null || meta.main != null`.
* `Vars.minJavaModGameVersion = 154`, `minModGameVersion = 136`.
* Скриптовые моды: `mods.loadScripts()` берёт `scripts/*.js`; если файлов несколько —
  именно `scripts/main.js`. Загрузка идёт до создания UI.
* Встроенный импорт из GitHub: **Mods → Import → Import from GitHub**, вводится
  `owner/repo`; `ModsDialog.githubImportJavaMod()` дергает
  `api.github.com/repos/<repo>/releases/latest` и берёт первый ассет `*.jar`.
  Для нашего репозитория строка — `homa95120-wq/-`, ассет один, так что способ рабочий.

## 4. Что осталось

1. **Пользователь должен поставить мод из релиза и проверить его в кампании.**
   Раньше релизов не было вообще, поэтому файл в `mods` был получен из другого источника
   и почти наверняка был битым (HTML-страница или ZIP репозитория). Теперь есть настоящий
   ассет — это и есть исправление.
2. Если мод всё ещё не виден — диагностика строго по порядку:
   * размер и хэш файла в `%APPDATA%\Mindustry\mods\CampaignThreatRadar.jar`
     (`certutil -hashfile ... SHA256`), должно быть 4205 и хэш из таблицы выше;
   * первые два байта файла — `PK`;
   * строки про `mod` в `%APPDATA%\Mindustry\logs\latest.log`
     (`Select-String -Path "$env:APPDATA\Mindustry\logs\latest.log" -Pattern 'mod','CampaignThreatRadar'`);
   * мод включён в списке и игра перезапущена после установки.
3. Если мод грузится, но панели нет — проверить, что идёт именно кампания
   (`Vars.state.isCampaign()`), и посмотреть лог на стектрейс из конструктора мода.
4. Необязательное улучшение: добавить в `mod.hjson` поле `repo: homa95120-wq/-`, чтобы
   в списке модов появилась кнопка обновления из GitHub. Это меняет jar, поэтому требует
   нового тега/релиза (например `v1.1.1`) и повторной проверки хэша.

## 5. Чего делать НЕ нужно

* **Пересоздавать `scriptmod/` и `dist/CampaignThreatRadar.jar`.** Они существовали в
  прошлой сессии как обходной путь на случай, если Java-jar негде взять. Теперь есть
  релиз с Java-jar, а скриптовая версия в игре не тестировалась и дублирует логику.
  В репозиторий её не добавляли и добавлять не нужно.
* Пытаться собрать jar локально: в песочнице нет `javac` (только рантайм), а
  `services.gradle.org` и `objects.githubusercontent.com` недоступны. Сборка — только CI.
* Скачивать ассеты Actions или релиза в песочницу: редиректы ведут на
  `blob.core.windows.net` / `release-assets.githubusercontent.com`, а они заблокированы.
  Проверять ассет через API (`gh release view v1.1 --json assets`) и логи workflow.

## 6. Полезные команды

```bash
# состояние CI
gh run list --limit 5

# релиз и его ассет
gh release view v1.1 --json tagName,name,isDraft,body,assets

# пересобрать и перевыпустить (после изменения кода/версии)
git tag -f v1.2 <commit-on-main> && git push origin v1.2 -f
```

Версия в `mod.hjson` и тег должны совпадать (`1.1` ↔ `v1.1`), иначе workflow печатает
предупреждение, но релиз всё равно создаётся.

## 7. Стиль общения

Пользователь пишет по-русски. Отвечать по-русски, давать проверяемые шаги с командами,
не выдумывать причины проблем: сначала файл (размер/хэш/`PK`), потом лог, потом код.
