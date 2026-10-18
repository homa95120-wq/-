# Script (ZIP) version

Same radar as the Java mod, written against the JavaScript/Rhino API
that Mindustry v8 exposes to script mods. It exists for one reason: the
finished product is a plain `.zip` that can be built anywhere (no JDK,
no Gradle) and dropped into the `mods` folder as-is. The whole-map HUD is
clickable: it previews a terrain-checked compact defence plan without placing
blocks or changing the world.

| File | Purpose |
|---|---|
| `mod.hjson` | Meta for the script mod. Internal name `campaign-threat-radar-zip`, `hidden: true`, **no** `main` and **no** `java: true` - with either of those the loader would treat the archive as a Java mod and fail to find the class. |
| `scripts/main.js` | The mod. Pure logic + diagnostic radar algorithm + larger whole-map tactical view with weak-defence markers and a click-selected defence blueprint (`extend(Packages.arc.scene.Element, ...)`) + a concise, prioritized action list + responsive HUD registration left of the minimap. The plan follows the nearest spawn, checks water/occupied/border tiles and never places buildings. |
| `build.py` | Builds `../dist/CampaignThreatRadar.zip` (exactly `mod.hjson` + `scripts/main.js` in the archive root, reproducible bytes). |
| `test-logic.js` | 52 offline checks of the pure logic (`node scriptmod/test-logic.js`), including plan geometry, terrain adjustment and map click projection. |
| `test-hud.js` | 10-check mock harness for the HUD glue: fires `ClientLoadEvent` against fake game globals, simulates a map click and verifies the terrain-aware plan. Catches typos in the glue, not Rhino-specific behaviour. |

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
- The whole-map view uses `Vars.world.width()/height()` (tiles, 8 world
  units each) and preserves the aspect ratio; wave directions and spawn
  markers come from `Vars.spawner.getSpawns()` (`Seq<Tile>`,
  `Tile.worldx()/worldy()`). Weak-sector coverage uses `TurretBuild.range()`
  plus the block's `targetGround`/`targetAir` flags, so a turret only counts
  where it can actually shoot. Every marker also carries the *missing*
  amount (`needGround`, `needAir`, `needWall`), which is what the panel
  prints as "нужно +N/с" / "нужно +N HP".
- A click on a non-letterboxed map cell selects a site; a second click clears it.
  The 14-cell template contains 7 copper walls, 4 Duo, 2 Scatter and 1 Mender.
  It is oriented toward the nearest spawn (or visible enemy), skips water and
  occupied cells, and shifts a blocked cell by at most two tiles when possible.
  It is a client-side recommendation only; no construction packet is sent.
- `extend()`/JavaAdapter does not work on iOS, so the script build is not
  marked as iOS compatible.
