# Script (ZIP) version

Same radar as the Java mod, written against the JavaScript/Rhino API
that Mindustry v8 exposes to script mods. It exists for one reason: the
finished product is a plain `.zip` that can be built anywhere (no JDK,
no Gradle) and dropped into the `mods` folder as-is.

| File | Purpose |
|---|---|
| `mod.hjson` | Meta for the script mod. Internal name `campaign-threat-radar-zip`, `hidden: true`, **no** `main` and **no** `java: true` - with either of those the loader would treat the archive as a Java mod and fail to find the class. |
| `scripts/main.js` | The mod. Pure logic + diagnostic radar algorithm + tactical mini map (`extend(Packages.arc.scene.Element, ...)`) + HUD registration at top-right (left of the minimap). |
| `build.py` | Builds `../dist/CampaignThreatRadar.zip` (exactly `mod.hjson` + `scripts/main.js` in the archive root, reproducible bytes). |
| `test-logic.js` | 22 offline checks of the pure logic (`node scriptmod/test-logic.js`). |
| `test-hud.js` | Mock harness for the HUD glue: fires `ClientLoadEvent` against fake game globals (`node scriptmod/test-hud.js`). Catches typos in the glue, not Rhino-specific behaviour. |

Build and test:

```bash
python3 scriptmod/build.py
node scriptmod/test-logic.js
node scriptmod/test-hud.js
```

Verified against the game sources (v160.7), not guessed:

- `Mods.load()` accepts `*.jar`, `*.zip` and directories with a meta
  file in the mods folder; anything else lying there is ignored.
- `Mods.loadScripts()` runs `scripts/main.js` of every enabled mod.
- `core/assets/scripts/global.js` imports `Vars`, `Groups`, `Events`,
  `ClientLoadEvent`, `Styles`, `Touchable`, `Scl`, `Draw`, `Fill`, `Lines`,
  `Mathf`, ... for every script and provides the `cons()` SAM wrapper and the
  `extend()` helper (Rhino `JavaAdapter`) used for the mini map element.
- A script mod must not set `main`/`java` (`LoadedMod.isJava()`), and
  its internal name must differ from the Java mod's, or the second one
  is refused with "A mod with the name ... is already imported".
- `hidden: true` makes the mod purely client-side: it is not required
  on multiplayer servers, so joining any server is seamless.
- `extend()`/JavaAdapter does not work on iOS, so the script build is not
  marked as iOS compatible.
