/*
 * Campaign Threat Radar (ZIP) - script version of campaignradar.CampaignThreatRadar.
 *
 * Client-only HUD tactical radar for Mindustry v8 (build 154+).
 * Shows enemy unit counts (ground/flying/bosses), a small tactical mini map with
 * every enemy unit around your core, predicted approach ETA to cores, core health,
 * power deficit, turret ammo alerts, defense diagnostics and a short forecast of
 * what is going to happen in the next minutes.
 *
 * Positioned at top-right, to the left of the vanilla minimap.
 * Uses `hidden: true` so it never affects multiplayer server compatibility.
 */

// ---------------------------------------------------------------- constants

var REFRESH_INTERVAL = 30; // ticks, ~0.5 s at 60 fps
var MIN_SPEED = 0.05; // world units per tick; slower units are ignored for ETA
var TOWARDS_CORE_DOT = 0.25; // velocity/direction cosine above which a unit counts as heading to a core
var CLOSE_DISTANCE = 320; // 40 tiles (8 units per tile)
var TILE_SIZE = 8; // world units per tile
var MINIMAP_WIDTH = 150; // width of the vanilla minimap in UI units
var MINIMAP_GAP = 70; // gap between the vanilla minimap and this panel, in UI units
var RADAR_SIZE = 160; // side of the tactical mini map, in UI units
var RADAR_RANGE_TILES = 120; // radius of the tactical mini map, in tiles
var HORIZON_SECONDS = 60; // how far ahead the forecast looks, in seconds

var KIND_GROUND = 0; // blip kind: ground unit
var KIND_FLYING = 1; // blip kind: flying unit
var KIND_BOSS = 2; // blip kind: boss

// ---------------------------------------------------------------- logic

/** Nearest core to a unit, or null when the player has no core. */
function nearestCore(x, y, cores) {
    var best = null;
    var bestDst2 = Infinity;
    if (!cores) return null;
    for (var i = 0; i < cores.length; i++) {
        var core = cores[i];
        if (!core) continue;
        var dx = core.x - x;
        var dy = core.y - y;
        var dst2 = dx * dx + dy * dy;
        if (dst2 < bestDst2) {
            bestDst2 = dst2;
            best = core;
        }
    }
    return best;
}

/**
 * Estimates when a unit reaches the core.
 *
 * The estimate is deliberately pessimistic: ground units have to walk around
 * obstacles, units lose time to turns and to the fire of the turrets, and a unit
 * that is currently shooting something has to finish that first.
 */
function predictArrival(unit, dist, direct) {
    var maxSpeed = unit.maxSpeed > 0 ? unit.maxSpeed : Math.max(unit.speed, 0.05);
    // Average speed a unit really keeps: turns, terrain and incoming fire cost time.
    var cruise = maxSpeed * (unit.flying ? 0.95 : 0.82);
    // Ground units walk around obstacles, flyers go straight.
    var path = dist * (unit.flying ? 1.05 : 1.3);

    var accel = Math.max(0.02, maxSpeed * Math.max(unit.accel || 0.5, 0.1));
    var ramp = unit.speed < cruise ? Math.min(60, (cruise - unit.speed) / accel) : 0;

    // A unit that barely moves is either accelerating, blocked or shooting something.
    var engaged = unit.speed < cruise * 0.35;

    var effective = cruise;
    var delay = 0;
    if (!direct) {
        // It has to turn around and take a detour before it reaches the core.
        effective = cruise * 0.75;
        delay = 120;
    }
    if (engaged) {
        // It has to finish the current action before it moves again.
        effective = Math.max(cruise * 0.6, 0.05);
        delay += 180;
    }

    var eta = path / Math.max(effective, 0.01) + ramp + delay;
    return {
        eta: eta,
        low: eta * (engaged ? 0.5 : (direct ? 0.8 : 0.7)),
        high: eta * (engaged ? 2 : (direct ? 1.3 : 1.5)),
        direct: direct,
        engaged: engaged
    };
}

/*
 * data: {
 *   units: [{x, y, vx, vy, speed, maxSpeed, accel, dps, flying, boss, name}],
 *   cores: [{x, y, health, maxHealth}],
 *   emptyTurrets: int, damagedBuildings: int, defenseDps: float,
 *   power: {net, batteryPercent} | null,
 *   horizonSeconds: number
 * }
 */
function computeRadar(data) {
    if (!data) data = {};
    var units = data.units || [];
    var cores = data.cores || [];
    var power = data.power || null;
    var horizonSeconds = data.horizonSeconds || HORIZON_SECONDS;
    var horizon = horizonSeconds * 60;

    var result = {
        count: 0,
        groundCount: 0,
        flyingCount: 0,
        bossCount: 0,
        bossNames: [],
        threats: 0,
        closeThreats: 0,
        incoming: 0,
        emptyTurrets: data.emptyTurrets || 0,
        damagedBuildings: data.damagedBuildings || 0,
        eta: Infinity,
        etaLow: Infinity,
        etaHigh: Infinity,
        directEta: Infinity,
        directEtaLow: Infinity,
        directEtaHigh: Infinity,
        etaDirect: false,
        incomingDps: 0,
        defenseDps: data.defenseDps || 0,
        coreDeath: Infinity,
        minCoreHp: 100,
        coreHealth: 0,
        powerNet: 0,
        battery: 100,
        hasPower: false,
        powerDeficit: false,
        blackout: false,
        horizonSeconds: horizonSeconds,
        blips: []
    };

    // Weakest core: the point the attack is most likely to break through.
    var minCoreHp = 100;
    var coreHealth = 0;
    var hasCore = false;
    for (var c = 0; c < cores.length; c++) {
        var cor = cores[c];
        if (!cor) continue;
        var pct = cor.maxHealth > 0 ? (cor.health / cor.maxHealth) * 100 : 100;
        if (!hasCore || pct < minCoreHp) {
            minCoreHp = pct;
            coreHealth = cor.health;
            hasCore = true;
        }
    }
    result.minCoreHp = minCoreHp;
    result.coreHealth = coreHealth;

    var closest = Infinity;
    var closestArrival = null;
    var closestDirect = null;

    for (var i = 0; i < units.length; i++) {
        var unit = units[i];
        if (!unit) continue;
        result.count++;

        if (unit.flying) {
            result.flyingCount++;
        } else {
            result.groundCount++;
        }

        if (unit.boss) {
            result.bossCount++;
            var name = unit.name || "Boss";
            if (result.bossNames.indexOf(name) === -1) {
                result.bossNames.push(name);
            }
        }

        var core = nearestCore(unit.x, unit.y, cores);

        // Every enemy unit is drawn on the mini map, even when the player has no core.
        var blip = {
            x: unit.x,
            y: unit.y,
            eta: Infinity,
            kind: unit.boss ? KIND_BOSS : (unit.flying ? KIND_FLYING : KIND_GROUND)
        };
        result.blips.push(blip);
        if (!core) continue;

        var dx = core.x - unit.x;
        var dy = core.y - unit.y;
        var dist = Math.sqrt(dx * dx + dy * dy);

        if (dist <= CLOSE_DISTANCE) {
            result.closeThreats++;
        }

        var speed = unit.speed || 0;
        var towards = speed > MIN_SPEED ? ((unit.vx || 0) * dx + (unit.vy || 0) * dy) / (speed * dist + 0.001) : 0;
        var direct = towards > TOWARDS_CORE_DOT;
        if (direct) {
            result.threats++;
        }

        var arrival = predictArrival(unit, dist, direct);
        blip.eta = arrival.eta;
        if (arrival.eta < closest) {
            closest = arrival.eta;
            closestArrival = arrival;
        }
        if (direct && arrival.eta < result.directEta) {
            result.directEta = arrival.eta;
            closestDirect = arrival;
        }

        if (arrival.eta <= horizon) {
            result.incoming++;
            result.incomingDps += unit.dps || 0;
        }
    }

    if (closestArrival) {
        result.eta = closestArrival.eta;
        result.etaLow = closestArrival.low;
        result.etaHigh = closestArrival.high;
        result.etaDirect = closestArrival.direct;
    }
    if (closestDirect) {
        result.directEtaLow = closestDirect.low;
        result.directEtaHigh = closestDirect.high;
    }

    // How long the weakest core survives if the attack keeps coming.
    // The turrets shoot back, so only the difference matters.
    var netDps = result.incomingDps - result.defenseDps;
    if (netDps > 0 && coreHealth > 0) {
        result.coreDeath = coreHealth / netDps;
    }

    if (power) {
        result.hasPower = true;
        result.powerNet = power.net || 0;
        result.battery = power.batteryPercent === undefined ? 100 : power.batteryPercent;
        result.powerDeficit = result.powerNet < -5;
        result.blackout = (result.powerDeficit && result.battery <= 1) || (result.powerNet < -30 && result.battery < 10);
    }

    return result;
}

function etaSeconds(etaTicks) {
    return Math.max(1, Math.floor(etaTicks / 60));
}

/** Legend shown under the tactical mini map. */
function legend() {
    return "[lightgray]◆[accent] ядро  [lightgray]●[scarlet] враг  [lightgray]●[orange] авиация  [lightgray]◉[scarlet] босс[]";
}

function formatRadarText(inGame, result) {
    if (!inGame || !result) {
        return "[gold]РАДАР КАМПАНИИ[]\n[gray]Неактивен вне игры[]";
    }

    var lines = [];
    lines.push("[gold]РАДАР КАМПАНИИ[] [lightgray]v1.3[]");

    // Enemy counts & composition
    var countText = "[white]Враги:[accent] " + result.count + "[]";
    if (result.count > 0) {
        countText += " [lightgray](🚜" + result.groundCount + " 🛸" + result.flyingCount + ")[]";
        if (result.bossCount > 0) {
            countText += " [scarlet]💀" + result.bossCount + "[]";
        }
    }
    lines.push(countText);

    // Threat and time to contact
    if (result.threats > 0 && isFinite(result.directEta)) {
        lines.push("[scarlet]⚠️ ПРОРЫВ: " + result.threats + " к ядру · ETA " +
            etaSeconds(result.directEtaLow) + "–" + etaSeconds(result.directEtaHigh) + "с[]");
    } else if (result.closeThreats > 0) {
        lines.push("[crimson]🚨 Враг рядом с ядром![]");
    } else if (result.count > 0 && isFinite(result.eta)) {
        lines.push("[orange]🟠 Враги в обход · ETA " +
            etaSeconds(result.etaLow) + "–" + etaSeconds(result.etaHigh) + "с[]");
    } else if (result.count === 0) {
        lines.push("[lightgray]Вражеских юнитов нет[]");
    }

    // Forecast: what is going to happen in the next minutes
    if (result.incoming > 0) {
        lines.push("[lightgray]🔮 За " + Math.floor(result.horizonSeconds || HORIZON_SECONDS) + " с: " + result.incoming +
            " врага у ядра · урон ~" + Math.round(result.incomingDps) + "/с[]");
    }
    if (isFinite(result.coreDeath)) {
        lines.push("[crimson]💥 Ядро (" + Math.round(result.coreHealth) + " HP) падёт через ~" +
            Math.round(result.coreDeath) + "с[]");
    }
    if (result.defenseDps > 0) {
        var holds = result.incomingDps <= 0 || result.defenseDps >= result.incomingDps;
        lines.push((holds ? "[green]🛡 Оборона ~" : "[orange]🛡 Оборона ~") + Math.round(result.defenseDps) + "/с — " +
            (holds ? "шанс отбить высокий" : "может не удержать") + "[]");
    }

    // Boss warning
    if (result.bossCount > 0 && result.bossNames && result.bossNames.length > 0) {
        lines.push("[scarlet]💀 БОСС: " + result.bossNames.join(", ") + "[]");
    }

    // Core status
    if (result.minCoreHp < 99) {
        var hp = Math.round(result.minCoreHp);
        if (hp <= 35) {
            lines.push("[crimson]🚨 КРИТИЧЕСКИЙ УРОН ЯДРУ: " + hp + "%![]");
        } else {
            lines.push("[coral]⚠️ ЯДРО ПОВРЕЖДЕНО: " + hp + "%[]");
        }
    }

    // Power deficit / blackout
    if (result.hasPower) {
        if (result.blackout) {
            lines.push("[scarlet]⚡ СЕТЬ ОБЕСТОЧЕНА: " + Math.round(result.powerNet) + "/с[]");
        } else if (result.powerDeficit) {
            lines.push("[coral]⚡ ДЕФИЦИТ ЭНЕРГИИ: " + Math.round(result.powerNet) + "/с (АКБ: " +
                Math.round(result.battery) + "%)[]");
        }
    }

    // Empty turrets
    if (result.emptyTurrets > 0) {
        lines.push("[yellow]📦 Турели без патронов: " + result.emptyTurrets + " шт.[]");
    }

    // Damaged defenses
    if (result.damagedBuildings >= 3) {
        lines.push("[yellow]🛠️ Повреждения базы: " + result.damagedBuildings + " построек[]");
    }

    // Safe status when no issues
    var hasAlerts = (result.threats > 0) || (result.closeThreats > 0) || (result.bossCount > 0) ||
                    (result.incoming > 0) ||
                    (result.minCoreHp < 99) ||
                    (result.powerDeficit) ||
                    (result.emptyTurrets > 0) || (result.damagedBuildings >= 3);

    if (!hasAlerts && result.count === 0) {
        lines.push("[green]✅ Все системы стабильны[]");
    }

    return lines.join("\n");
}

// Exported only for the offline test harness; `module` is undefined in Rhino.
if (typeof module !== "undefined" && module && module.exports) {
    module.exports = {
        REFRESH_INTERVAL: REFRESH_INTERVAL,
        MIN_SPEED: MIN_SPEED,
        TOWARDS_CORE_DOT: TOWARDS_CORE_DOT,
        CLOSE_DISTANCE: CLOSE_DISTANCE,
        TILE_SIZE: TILE_SIZE,
        MINIMAP_WIDTH: MINIMAP_WIDTH,
        MINIMAP_GAP: MINIMAP_GAP,
        RADAR_SIZE: RADAR_SIZE,
        RADAR_RANGE_TILES: RADAR_RANGE_TILES,
        HORIZON_SECONDS: HORIZON_SECONDS,
        predictArrival: predictArrival,
        computeRadar: computeRadar,
        formatRadarText: formatRadarText,
        etaSeconds: etaSeconds,
        legend: legend
    };
}

// ---------------------------------------------------------------- game glue

// Only register anything when the game globals really exist. In Node
// (tests) and on a headless server this whole block is skipped.
if (typeof Vars !== "undefined" && typeof Events !== "undefined" && typeof ClientLoadEvent !== "undefined" && !Vars.headless) {

    var asCons = typeof cons !== "undefined" ? cons : function (f) { return f; };

    var statusLabel = null;
    var radarElement = null;
    var nextRefresh = 0;

    // Everything the mini map needs to draw itself. It lives in a closure so that
    // the JavaAdapter based element can read it without any extra Java class.
    var radarState = {
        blips: [],
        cores: [],
        centerX: 0,
        centerY: 0,
        range: RADAR_RANGE_TILES * TILE_SIZE,
        playerX: 0,
        playerY: 0,
        hasPlayer: false,
        threatX: 0,
        threatY: 0,
        hasThreat: false
    };

    var logError = function (where, err) {
        try {
            Log.err("[campaign-radar] " + where + ": " + err);
        } catch (ignored) {}
    };

    /** Calls a method (or reads a field) of a Java object without ever throwing. */
    var callSafely = function (object, name, fallback) {
        try {
            if (!object) return fallback;
            var method = object[name];
            if (method === undefined || method === null) return fallback;
            if (typeof method === "function") return method.call(object);
            return method;
        } catch (err) {
            return fallback;
        }
    };

    var refreshRadar = function () {
        if (!statusLabel) return;
        try {
            if (!Vars.state || !Vars.state.isGame() || !Vars.player || !Vars.player.isAdded()) {
                statusLabel.setText(formatRadarText(false, null));
                radarState.blips = [];
                radarState.cores = [];
                radarState.hasPlayer = false;
                radarState.hasThreat = false;
                return;
            }

            var enemyTeam = Vars.state.rules.waveTeam || Team.crux;
            var playerTeam = Vars.player.team();
            var teamData = Vars.state.teams ? Vars.state.teams.get(playerTeam) : null;

            var cores = [];
            var mainCore = null;
            if (teamData && teamData.cores) {
                var coreSeq = teamData.cores;
                for (var i = 0; i < coreSeq.size; i++) {
                    var core = coreSeq.get(i);
                    if (core && core.isValid && core.isValid()) {
                        if (!mainCore) mainCore = core;
                        cores.push({
                            x: core.x,
                            y: core.y,
                            health: core.health,
                            maxHealth: core.maxHealth
                        });
                    }
                }
            }

            var units = [];
            if (typeof Groups !== "undefined" && Groups.unit) {
                Groups.unit.each(asCons(function (unit) {
                    if (!unit) return;
                    // Only real, living enemies are of interest.
                    if (unit.dead) return;
                    if (unit.isAdded && !unit.isAdded()) return;
                    if (unit.team !== enemyTeam) return;
                    var type = unit.type;
                    var vel = unit.vel;
                    var speed = vel ? callSafely(vel, "len", 0) : 0;
                    units.push({
                        x: unit.x,
                        y: unit.y,
                        vx: vel ? vel.x : 0,
                        vy: vel ? vel.y : 0,
                        speed: speed,
                        maxSpeed: type ? type.speed : 0,
                        accel: type ? type.accel : 0.5,
                        dps: type ? callSafely(type, "estimateDps", 0) : 0,
                        // isFlying() is true while a unit is airborne, so the type is the reliable source.
                        flying: type ? !!type.flying : !!callSafely(unit, "isFlying", false),
                        boss: !!callSafely(unit, "isBoss", false),
                        name: type ? (type.localizedName || type.name) : "Enemy"
                    });
                }));
            }

            // Turrets, damaged buildings and the estimated defensive DPS
            var emptyTurrets = 0;
            var damagedBuildings = 0;
            var defenseDps = 0;
            if (teamData && teamData.buildings) {
                var bSeq = teamData.buildings;
                for (var b = 0; b < bSeq.size; b++) {
                    var bld = bSeq.get(b);
                    if (!bld || !bld.isValid || !bld.isValid()) continue;
                    if (bld.health < bld.maxHealth * 0.5) {
                        damagedBuildings++;
                    }
                    var hasAmmo = callSafely(bld, "hasAmmo", null);
                    if (hasAmmo === false) {
                        emptyTurrets++;
                    }else if (hasAmmo === true) {
                        defenseDps += callSafely(bld, "estimateDps", 0);
                    }
                }
            }

            // Power network diagnostics
            var powerInfo = null;
            if (mainCore && mainCore.power && mainCore.power.graph) {
                var graph = mainCore.power.graph;
                powerInfo = {
                    net: callSafely(graph, "getPowerBalance", 0) * 60,
                    batteryPercent: 100
                };
                var batStored = callSafely(graph, "getBatteryStored", 0);
                var batCap = callSafely(graph, "getBatteryCapacity", 0);
                if (batCap > 0) {
                    powerInfo.batteryPercent = (batStored / batCap) * 100;
                }
            }

            var radarData = computeRadar({
                units: units,
                cores: cores,
                emptyTurrets: emptyTurrets,
                damagedBuildings: damagedBuildings,
                defenseDps: defenseDps,
                power: powerInfo,
                horizonSeconds: HORIZON_SECONDS
            });

            statusLabel.setText(formatRadarText(true, radarData));
            updateRadar(radarData, cores);
        } catch (err) {
            logError("refresh failed", err);
            try {
                statusLabel.setText("[gold]РАДАР КАМПАНИИ[]\n[scarlet]Ошибка обновления[]\n[gray]Подробнее в last_log.txt[]");
            } catch (ignored) {}
        }
    };

    /** Feeds the mini map with the freshly computed data. */
    var updateRadar = function (prediction, cores) {
        radarState.blips = prediction.blips || [];
        radarState.cores = [];

        var playerUnit = null;
        try {
            // Player.unit is a protected field, the accessor is unit().
            playerUnit = callSafely(Vars.player, "unit", null);
        } catch (ignored) {}

        var centerX = 0, centerY = 0;
        if (cores && cores.length > 0) {
            // The radar follows the weakest core: that is where the attack will land.
            var weakest = cores[0];
            for (var i = 0; i < cores.length; i++) {
                if (cores[i].health < weakest.health) weakest = cores[i];
            }
            centerX = weakest.x;
            centerY = weakest.y;
        }else if (playerUnit){
            centerX = playerUnit.x;
            centerY = playerUnit.y;
        }
        radarState.centerX = centerX;
        radarState.centerY = centerY;
        radarState.range = RADAR_RANGE_TILES * TILE_SIZE;

        for (var c = 0; c < (cores ? cores.length : 0); c++) {
            radarState.cores.push({ x: cores[c].x, y: cores[c].y });
        }

        if (playerUnit) {
            radarState.playerX = playerUnit.x;
            radarState.playerY = playerUnit.y;
            radarState.hasPlayer = true;
        } else {
            radarState.hasPlayer = false;
        }

        // Point at the closest threat so the direction of the attack is obvious.
        var closest = null;
        var blips = prediction.blips || [];
        for (var b = 0; b < blips.length; b++) {
            if (!closest || blips[b].eta < closest.eta) closest = blips[b];
        }
        if (closest && isFinite(closest.eta)) {
            radarState.threatX = closest.x;
            radarState.threatY = closest.y;
            radarState.hasThreat = true;
        } else {
            radarState.hasThreat = false;
        }
    };

    /** Draws the tactical mini map. */
    var drawRadar = function (state, element) {
        var w = element.getWidth();
        var h = element.getHeight();
        if (!(w > 0) || !(h > 0)) return;

        var cx = element.x + w / 2;
        var cy = element.y + h / 2;
        var radius = Math.min(w, h) / 2 - 4;
        var scale = radius / Math.max(state.range, 1);

        // background
        Draw.color(0.04, 0.06, 0.1, 0.85);
        Fill.rect(element.x, element.y, w, h);

        // range rings and crosshair
        Draw.color(0.35, 0.5, 0.65, 0.25);
        Lines.stroke(1);
        for (var i = 1; i <= 3; i++) {
            Lines.circle(cx, cy, radius * i / 3);
        }
        Lines.line(cx, element.y, cx, element.y + h);
        Lines.line(element.x, cy, element.x + w, cy);

        // frame
        Draw.color(0.45, 0.6, 0.8, 0.55);
        Lines.stroke(1.5);
        Lines.rect(element.x, element.y, w, h);

        // direction of the closest threat
        if (state.hasThreat) {
            var tx = cx + (state.threatX - state.centerX) * scale;
            var ty = cy + (state.threatY - state.centerY) * scale;
            var dx = tx - cx;
            var dy = ty - cy;
            var len = Mathf.dst(dx, dy);
            if (len > radius - 2) {
                var angle = Mathf.atan2(dy, dx);
                tx = cx + Mathf.cos(angle) * (radius - 2);
                ty = cy + Mathf.sin(angle) * (radius - 2);
            }
            Draw.color(1, 0.4, 0.3, 0.6);
            Lines.stroke(1);
            Lines.dashLine(cx, cy, tx, ty, 12);
        }

        // player cores
        for (var c = 0; c < state.cores.length; c++) {
            var core = state.cores[c];
            var coreX = cx + (core.x - state.centerX) * scale;
            var coreY = cy + (core.y - state.centerY) * scale;
            Draw.color(0.35, 0.65, 1, 1);
            Fill.rect(coreX - 3, coreY - 3, 6, 6);
        }

        // the player himself
        if (state.hasPlayer) {
            var playerX = cx + (state.playerX - state.centerX) * scale;
            var playerY = cy + (state.playerY - state.centerY) * scale;
            Draw.color(1, 1, 1, 1);
            Fill.circle(playerX, playerY, 2.5);
        }

        // enemy units
        for (var e = 0; e < state.blips.length; e++) {
            var blip = state.blips[e];
            var bx = (blip.x - state.centerX) * scale;
            var by = (blip.y - state.centerY) * scale;
            var dist = Mathf.dst(bx, by);
            var color = blip.kind === KIND_BOSS ? [1, 0.13, 0.13, 1]
                : (blip.kind === KIND_FLYING ? [1, 0.7, 0.2, 1] : [1, 0.36, 0.3, 1]);

            if (dist > radius - 3) {
                // Outside of the radar: only the direction is shown.
                var angle = Mathf.atan2(by, bx);
                var px = cx + Mathf.cos(angle) * (radius - 4);
                var py = cy + Mathf.sin(angle) * (radius - 4);
                var cos = Mathf.cos(angle);
                var sin = Mathf.sin(angle);
                Draw.color(color[0], color[1], color[2], 0.55);
                Fill.tri(px + cos * 5, py + sin * 5,
                    px - cos * 3 + sin * 3, py - sin * 3 - cos * 3,
                    px - cos * 3 - sin * 3, py - sin * 3 + cos * 3);
            } else {
                var px = cx + bx;
                var py = cy + by;
                Draw.color(color[0], color[1], color[2], 1);
                Fill.circle(px, py, blip.kind === KIND_BOSS ? 3.5 : 2);
                if (blip.kind === KIND_BOSS) {
                    Draw.color(color[0], color[1], color[2], 0.5);
                    Lines.stroke(1);
                    Lines.circle(px, py, 6);
                }
            }
        }
    };

    Events.on(ClientLoadEvent, asCons(function () {
        try {
            // hudGroup is only visible while a game is running.
            // Placed at top-right, but clearly to the left of the vanilla minimap.
            Vars.ui.hudGroup.fill(asCons(function (t) {
                t.top().right();
                t.touchable = Touchable.disabled;

                var offset = Scl.scl(MINIMAP_WIDTH + MINIMAP_GAP);
                try {
                    if (typeof Core !== "undefined" && Core.graphics) {
                        offset = Math.min(offset, Core.graphics.getWidth() * 0.5);
                    }
                } catch (ignored) {}

                t.table(Styles.black8, asCons(function (panel) {
                    panel.margin(6);
                    panel.defaults().left().top();

                    statusLabel = panel.add("Сканирование...").color(Color.white).left().growX().get();
                    panel.row();

                    radarElement = extend(Packages.arc.scene.Element, {
                        draw: function () {
                            drawRadar(radarState, radarElement);
                        }
                    });
                    try {
                        radarElement.touchable = Touchable.disabled;
                    } catch (ignored) {}
                    panel.add(radarElement).size(Scl.scl(RADAR_SIZE), Scl.scl(RADAR_SIZE));
                    panel.row();

                    panel.add(legend()).color(Color.lightGray).left().growX().get();
                })).marginTop(Scl.scl(6)).marginRight(offset);

                t.update(function () {
                    if (Time.time >= nextRefresh) {
                        nextRefresh = Time.time + REFRESH_INTERVAL;
                        refreshRadar();
                    }
                });
                refreshRadar();
            }));
        } catch (err) {
            logError("failed to install HUD", err);
        }
    }));
}
