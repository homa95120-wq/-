# Передаточный промт: Campaign Threat Radar (Mindustry v8)

Обновлён 2026-10-18: версия 1.2 с расширенной диагностикой базы и позиционированием сверху справа левее миникарты.
Этот файл — единственный источник истины о состоянии проекта.
Читать целиком перед любыми действиями.

---

## 1. Что это за проект

Клиентский тактический HUD-мод для **Mindustry v8** (билды 154+), репозиторий
`github.com/homa95120-wq/-` (публичный, default branch `main`, имя репозитория —
буквально дефис).

Мод:
1. Расположен в правом верхнем углу, левее миникарты (`top().right().marginTop(8).marginRight(offset)`).
2. Считает вражеских юнитов с разбивкой (наземные 🚜, летающие 🛸, боссы 💀).
3. Интеллектуально предупреждает о проблемах:
   - Расчет времени подлета/подхода к ядру (ETA в секундах).
   - Опасная близость к ядру (< 40 блоков).
   - Обнаружение боссов на поле боя.
   - Повреждение ядер (HP %).
   - Дефицит энергосети и угроза блэкаута.
   - Турели без патронов/снарядов.
   - Критические повреждения строений обороны.
   - Статус "Все системы стабильны", когда все чисто.
4. Помечен как `hidden: true` — чисто клиентский мод, не создает сущностей, не меняет правила, не шлет сетевые пакеты и не мешает заходить на сервера.

Две сборки (**не включать одновременно — будет две панели**):

* **Java (основная):**
  `src/main/java/campaignradar/CampaignThreatRadar.java`
  Корневой `mod.hjson` — имя `campaign-threat-radar`, версия 1.2, `main`,
  `java: true`, `hidden: true`, `minGameVersion: 154`. `build.gradle` — Java 17,
  зависимость `compileOnly Anuken:Mindustry:v160.7`.
* **Скриптовая / ZIP (Rhino JS):**
  `scriptmod/` — порт логики на Rhino-JS API игры (`hidden: true`).
  `scriptmod/mod.hjson` — имя `campaign-threat-radar-zip`, displayName
  `Campaign Threat Radar (ZIP)`.
  `scriptmod/build.py` собирает `dist/CampaignThreatRadar.zip`.
  Тесты: `node scriptmod/test-logic.js` (15 проверок) и
  `node scriptmod/test-hud.js` (4 проверки).

---

## 2. Команды для сборки и тестов

```bash
node scriptmod/test-logic.js
node scriptmod/test-hud.js
python3 scriptmod/build.py
git status
```
