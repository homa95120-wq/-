/*
 * Campaign Threat Radar (ZIP) - script version of campaignradar.CampaignThreatRadar.
 *
 * Client-only HUD tactical radar for Mindustry v8 (build 154+).
 * Shows enemy counts and threat ETAs, a responsive whole-map tactical view,
 * the two most important places to improve, urgent core/power diagnostics,
 * a concise wave forecast, and a clickable terrain-aware defence planner.
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
var MINIMAP_GAP = 40; // clear gap between the minimap and this panel, in UI units
var PANEL_WIDTH = 390; // maximum content width; responsive on narrow screens
var RADAR_SIZE = 220; // maximum side of the tactical whole-map view, in UI units
var RADAR_HEIGHT_FRACTION = 0.26; // map uses at most 26% of screen height
var PANEL_WIDTH_FRACTION = 0.38; // panel stays below 40% of screen width
var RADAR_RANGE_TILES = 120; // legacy/local fallback radius when the world size is unknown, in tiles
var DEFENSE_RING_TILES = 26; // distance from a core where an approaching wave should meet the defence
var WEAK_POINT_MAX = 3; // maximum number of "improve defence here" markers
var HORIZON_SECONDS = 60; // how far ahead the forecast looks, in seconds
var WAVE_FORECAST_MAX = 100; // how many future waves the survival forecast simulates
var DEFENSE_EFFICIENCY = 0.55; // share of the nominal turret/unit DPS that is really on target
var ENEMY_ENGAGEMENT = 0.35; // share of the nominal enemy DPS that is really firing at the base at once
var BATTLE_ATTRITION = 0.6; // average enemy DPS during a battle, as a share of the starting DPS (units die off)
var AIR_TO_CORE = 0.3; // share of air damage that bypasses the front line and hits the core directly
var REPAIR_FRACTION = 0.25; // share of the missing front-line HP repaired between two waves

var KIND_GROUND = 0; // blip kind: ground unit
var KIND_FLYING = 1; // blip kind: flying unit
var KIND_BOSS = 2; // blip kind: boss

var MARKER_GROUND = 0; // weak-point kind: not enough anti-ground damage
var MARKER_AIR = 1; // weak-point kind: not enough anti-air damage
var MARKER_WALL = 2; // weak-point kind: not enough wall HP in front of the turrets
var MARKER_SUPPLY = 3; // weak-point kind: a nearby turret has no ammo
var MARKER_REPAIR = 4; // weak-point kind: front-line buildings are badly damaged

var PLAN_WALL = 0; // blueprint marker: copper wall
var PLAN_DUO = 1; // blueprint marker: Duo turret
var PLAN_SCATTER = 2; // blueprint marker: Scatter anti-air turret
var PLAN_MENDER = 3; // blueprint marker: Mender repair turret

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

/** Compact amount: 950 -> "950", 1234 -> "1.2k", 25400 -> "25k", 1200000 -> "1.2M". */
function fmtAmount(value) {
    var v = Math.abs(value || 0);
    if (v < 1000) return "" + Math.round(value || 0);
    if (v < 10000) return ((value / 1000).toFixed(1).replace(/\.0$/, "")) + "k";
    if (v < 1000000) return Math.round(value / 1000) + "k";
    return ((value / 1000000).toFixed(1).replace(/\.0$/, "")) + "M";
}

/** Seconds as m:ss ("1:05"). */
function fmtTime(seconds) {
    var s = Math.max(0, Math.round(seconds || 0));
    var m = Math.floor(s / 60);
    var rest = s % 60;
    return m + ":" + (rest < 10 ? "0" : "") + rest;
}

/** Russian plural of "wave": волну / волны / волн. */
function waveWord(n) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "волну";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "волны";
    return "волн";
}

/** Russian plural of "враг": враг / врага / врагов. */
function foeWord(n) {
    var mod10 = n % 10;
    var mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return "враг";
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "врага";
    return "врагов";
}

/** Eight-point compass name (in Russian) for a world-space direction. */
function directionName(dx, dy) {
    if (!isFinite(dx) || !isFinite(dy) || (dx === 0 && dy === 0)) return "у ядра";
    var names = ["В", "СВ", "С", "СЗ", "З", "ЮЗ", "Ю", "ЮВ"];
    var index = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
    index = ((index % 8) + 8) % 8;
    return names[index];
}

/**
 * Selects the approach direction for a site: nearest wave spawn, otherwise
 * nearest visible enemy. The returned vector is snapped to one of eight compass
 * directions so the compact blueprint stays on whole tiles.
 */
function defenseFront(tileX, tileY, spawns, enemies) {
    var centerX = (tileX + 0.5) * TILE_SIZE;
    var centerY = (tileY + 0.5) * TILE_SIZE;
    var source = null;
    var bestDst2 = Infinity;
    var candidates = spawns && spawns.length ? spawns : (enemies || []);
    for (var i = 0; i < candidates.length; i++) {
        var point = candidates[i];
        if (!point || !isFinite(point.x) || !isFinite(point.y)) continue;
        var dx = point.x - centerX;
        var dy = point.y - centerY;
        var dst2 = dx * dx + dy * dy;
        if (dst2 < bestDst2) {
            source = point;
            bestDst2 = dst2;
        }
    }
    var vx = source ? source.x - centerX : 0;
    var vy = source ? source.y - centerY : 1;
    var index = Math.round(Math.atan2(vy, vx) / (Math.PI / 4));
    index = ((index % 8) + 8) % 8;
    var vectors = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    return {
        dx: vectors[index][0],
        dy: vectors[index][1],
        direction: directionName(vectors[index][0], vectors[index][1]),
        source: source ? (spawns && spawns.length ? "spawn" : "enemy") : "default"
    };
}

/** Returns the compact 5-by-5 defensive blueprint in tile coordinates. */
function defenseLayout(tileX, tileY, frontX, frontY) {
    frontX = frontX > 0 ? 1 : (frontX < 0 ? -1 : 0);
    frontY = frontY > 0 ? 1 : (frontY < 0 ? -1 : 0);
    if (frontX === 0 && frontY === 0) frontY = 1;
    var sideX = -frontY;
    var sideY = frontX;
    var placements = [];
    function add(kind, forward, lateral) {
        placements.push({
            kind: kind,
            x: tileX + frontX * forward + sideX * lateral,
            y: tileY + frontY * forward + sideY * lateral
        });
    }

    // Seven walls make a short front and two flanks; turrets stay behind them.
    for (var side = -2; side <= 2; side++) add(PLAN_WALL, 2, side);
    add(PLAN_WALL, 1, -2);
    add(PLAN_WALL, 1, 2);
    // Four all-round Duo turrets, two anti-air Scatters and a central Mender.
    add(PLAN_DUO, 0, -1);
    add(PLAN_DUO, 0, 1);
    add(PLAN_DUO, -1, -1);
    add(PLAN_DUO, -1, 1);
    add(PLAN_SCATTER, -2, -1);
    add(PLAN_SCATTER, -2, 1);
    add(PLAN_MENDER, -1, 0);
    return placements;
}

/**
 * Checks the blueprint against a terrain callback. Unbuildable exact spots are
 * moved at most two tiles to the nearest free cell without colliding with
 * another blueprint slot. It only describes a plan; it never places buildings.
 */
function analyzeDefensePlan(tileX, tileY, frontX, frontY, mapWidthTiles, mapHeightTiles, classifyTile) {
    var wanted = defenseLayout(tileX, tileY, frontX, frontY);
    var desired = {};
    var used = {};
    var plan = {
        centerTileX: tileX,
        centerTileY: tileY,
        frontX: frontX,
        frontY: frontY,
        direction: directionName(frontX, frontY),
        total: wanted.length,
        placements: [],
        adjusted: 0,
        occupied: 0,
        water: 0,
        outside: 0
    };
    function key(x, y) { return x + "," + y; }
    for (var d = 0; d < wanted.length; d++) desired[key(wanted[d].x, wanted[d].y)] = true;
    function classify(x, y) {
        if (mapWidthTiles > 0 && (x < 0 || x >= mapWidthTiles)) return "outside";
        if (mapHeightTiles > 0 && (y < 0 || y >= mapHeightTiles)) return "outside";
        try { return classifyTile ? (classifyTile(x, y) || null) : null; }
        catch (ignored) { return "occupied"; }
    }
    function isFree(x, y) {
        var cellKey = key(x, y);
        if (desired[cellKey] || used[cellKey]) return false;
        return classify(x, y) === null;
    }
    function nearestFree(x, y) {
        for (var distance = 1; distance <= 2; distance++) {
            for (var dx = -distance; dx <= distance; dx++) {
                var dyAbs = distance - Math.abs(dx);
                if (dyAbs === 0) {
                    if (isFree(x + dx, y)) return { x: x + dx, y: y };
                } else {
                    if (isFree(x + dx, y - dyAbs)) return { x: x + dx, y: y - dyAbs };
                    if (isFree(x + dx, y + dyAbs)) return { x: x + dx, y: y + dyAbs };
                }
            }
        }
        return null;
    }
    for (var i = 0; i < wanted.length; i++) {
        var target = wanted[i];
        var targetKey = key(target.x, target.y);
        var reason = classify(target.x, target.y);
        var destination = null;
        var adjusted = false;
        if (reason === null && !used[targetKey]) {
            destination = { x: target.x, y: target.y };
        } else {
            destination = nearestFree(target.x, target.y);
            adjusted = !!destination;
        }
        if (destination) {
            var destinationKey = key(destination.x, destination.y);
            used[destinationKey] = true;
            plan.placements.push({
                kind: target.kind,
                x: destination.x,
                y: destination.y,
                requestedX: target.x,
                requestedY: target.y,
                adjusted: adjusted
            });
            if (adjusted) plan.adjusted++;
        } else if (reason === "water") {
            plan.water++;
        } else if (reason === "outside") {
            plan.outside++;
        } else {
            plan.occupied++;
        }
    }
    return plan;
}

/** Formats the selected site's compact blueprint and its terrain fit. */
function formatDefensePlan(plan) {
    if (!plan) return "";
    var lines = [];
    lines.push("[gold]🛡 План защиты · участок " + plan.centerTileX + "," + plan.centerTileY +
        " · фронт " + plan.direction + "[]");
    lines.push("[lightgray]□ 7 медных стен[] · [orange]● 4 Duo[] · [accent]○ 2 Scatter[] · [green]✚ 1 Mender[] (" + plan.total + " мест)");
    var detail = "Местность: доступно " + plan.placements.length + "/" + plan.total;
    if (plan.adjusted > 0) detail += " · сдвинуто " + plan.adjusted;
    if (plan.occupied > 0) detail += " · занято " + plan.occupied;
    if (plan.water > 0) detail += " · вода " + plan.water;
    if (plan.outside > 0) detail += " · край карты " + plan.outside;
    detail += " · только рекомендация";
    lines.push((plan.placements.length === plan.total ? "[green]" : "[orange]") + detail + "[]");
    return lines.join("\n");
}

/** Converts a click in the tactical-map element to a tile, ignoring letterbox. */
function mapTileAt(localX, localY, elementWidth, elementHeight, mapWidth, mapHeight, mapOffsetX, mapOffsetY) {
    var view = mapViewport(elementWidth, elementHeight, mapWidth, mapHeight);
    if (!(view.scale > 0) || localX < view.x || localY < view.y ||
            localX >= view.x + view.width || localY >= view.y + view.height) return null;
    var worldX = (mapOffsetX || 0) + (localX - view.x) / view.scale;
    var worldY = (mapOffsetY || 0) + (localY - view.y) / view.scale;
    return { x: Math.floor(worldX / TILE_SIZE), y: Math.floor(worldY / TILE_SIZE) };
}

/** Markup colour of a weak-point kind; the same colour is used on the map. */
function markerColor(kind) {
    switch (kind) {
        case MARKER_AIR: return "accent";     // ПВО
        case MARKER_GROUND: return "orange";  // турель по земле
        case MARKER_WALL: return "lightgray"; // стены
        case MARKER_SUPPLY: return "yellow";  // патроны
        case MARKER_REPAIR: return "coral";   // ремонт
        default: return "white";
    }
}

/** RGBA of a weak-point kind for the tactical map. */
function markerRgba(kind) {
    switch (kind) {
        case MARKER_AIR: return [0.40, 0.70, 1.0, 1.0];
        case MARKER_GROUND: return [1.0, 0.60, 0.15, 1.0];
        case MARKER_WALL: return [0.78, 0.82, 0.85, 1.0];
        case MARKER_SUPPLY: return [1.0, 0.85, 0.20, 1.0];
        case MARKER_REPAIR: return [1.0, 0.45, 0.40, 1.0];
        default: return [1.0, 0.85, 0.20, 1.0];
    }
}

/**
 * Turns a weak point into a concrete instruction: what to build, how much of
 * it is missing and in which colour it is drawn on the map. This is the answer
 * to the only question that really matters in a defence: what do I improve?
 */
function adviceFor(wp) {
    if (!wp) return { action: "УСИЛИТЬ", color: "white", detail: "" };
    switch (wp.kind) {
        case MARKER_AIR:
            return {
                action: "ПВО",
                color: markerColor(MARKER_AIR),
                detail: wp.airDps > 0
                    ? "сейчас ~" + Math.round(wp.airDps) + "/с, нужно +" + Math.round(wp.needAir) + "/с"
                    : "нет турелей по воздуху"
            };
        case MARKER_WALL:
            return {
                action: "СТЕНЫ",
                color: markerColor(MARKER_WALL),
                detail: "сейчас " + fmtAmount(wp.wallHp) + " HP, нужно +" + fmtAmount(wp.needWall) + " HP"
            };
        case MARKER_SUPPLY:
            return {
                action: "ПАТРОНЫ",
                color: markerColor(MARKER_SUPPLY),
                detail: "турель без патронов"
            };
        case MARKER_REPAIR:
            return {
                action: "РЕМОНТ",
                color: markerColor(MARKER_REPAIR),
                detail: "постройка на " + Math.round(wp.healthPct) + "% HP"
            };
        default:
            return {
                action: "ТУРЕЛЬ",
                color: markerColor(MARKER_GROUND),
                detail: "по земле ~" + Math.round(wp.groundDps) + "/с, нужно +" + Math.round(wp.needGround) + "/с"
            };
    }
}

/**
 * Viewport for the whole-map radar. The returned rectangle preserves the map
 * aspect ratio and is centred inside the square HUD element, so every core,
 * spawn point and enemy on the map has a visible position. Coordinates are
 * relative to the HUD element; mapWidth/mapHeight are in world units.
 */
function mapViewport(elementWidth, elementHeight, mapWidth, mapHeight) {
    var w = Math.max(0, elementWidth || 0);
    var h = Math.max(0, elementHeight || 0);
    var mw = Math.max(1, mapWidth || 1);
    var mh = Math.max(1, mapHeight || 1);
    var padding = 4;
    var availW = Math.max(1, w - padding * 2);
    var availH = Math.max(1, h - padding * 2);
    var scale = Math.min(availW / mw, availH / mh);
    var viewW = mw * scale;
    var viewH = mh * scale;
    return {
        x: (w - viewW) / 2,
        y: (h - viewH) / 2,
        width: viewW,
        height: viewH,
        scale: scale,
        mapWidth: mw,
        mapHeight: mh
    };
}

/** Projects a world position into a whole-map viewport, clamped to its edges. */
function projectMap(viewport, worldX, worldY) {
    if (!viewport) return { x: 0, y: 0, clamped: true };
    var x = Math.max(0, Math.min(viewport.mapWidth, worldX || 0));
    var y = Math.max(0, Math.min(viewport.mapHeight, worldY || 0));
    return {
        x: viewport.x + x * viewport.scale,
        y: viewport.y + y * viewport.scale,
        clamped: x !== (worldX || 0) || y !== (worldY || 0)
    };
}

function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, value || 0));
}

/**
 * Finds the places where the defence should be improved.
 *
 * For every core the function looks along the real approaches (from the wave
 * spawn points; in all eight directions when no spawn point is known) and
 * evaluates a point on the expected defence ring. A sector is weak when the
 * turrets that can actually reach that point do not provide enough ground/air
 * DPS for the coming waves, when there is almost no wall HP in front of them,
 * or when a nearby turret is sitting without ammo. Badly damaged front-line
 * buildings near a core get a separate repair marker at their real position.
 *
 * opts: {cores, defenders, walls, spawns, futureWaves, currentGroundDps,
 *        currentFlyingDps, currentGroundHp, currentFlyingHp,
 *        mapWidthTiles, mapHeightTiles}
 * defenders: [{x, y, dps, range, targetsGround, targetsAir, hasAmmo, health, maxHealth}]
 * walls:     [{x, y, health, maxHealth}]
 */
function computeWeakPoints(opts) {
    opts = opts || {};
    var cores = opts.cores || [];
    var defenders = opts.defenders || [];
    var walls = opts.walls || [];
    var spawns = opts.spawns || [];
    var future = opts.futureWaves || [];
    if (!cores || cores.length === 0) return [];

    // What the next waves will mostly consist of. The current enemies count as
    // one extra sample; the strongest of the next ten waves raises the bar.
    var samples = 0;
    var sumGroundDps = 0, sumAirDps = 0;
    var maxGroundDps = 0, maxAirDps = 0;
    var seen = 0;
    for (var f = 0; f < future.length && seen < 10; f++) {
        var load = future[f];
        if (!load || !load.count) continue;
        seen++;
        maxGroundDps = Math.max(maxGroundDps, load.groundDps || 0);
        maxAirDps = Math.max(maxAirDps, load.flyingDps || 0);
        if (seen <= 5) {
            samples++;
            sumGroundDps += load.groundDps || 0;
            sumAirDps += load.flyingDps || 0;
        }
    }
    if ((opts.currentGroundDps || 0) > 0 || (opts.currentFlyingDps || 0) > 0) {
        samples++;
        sumGroundDps += opts.currentGroundDps || 0;
        sumAirDps += opts.currentFlyingDps || 0;
        maxGroundDps = Math.max(maxGroundDps, opts.currentGroundDps || 0);
        maxAirDps = Math.max(maxAirDps, opts.currentFlyingDps || 0);
    }

    var avgGroundDps = samples > 0 ? sumGroundDps / samples : 0;
    var avgAirDps = samples > 0 ? sumAirDps / samples : 0;
    var expectedGround = Math.max(avgGroundDps, maxGroundDps * 0.55);
    var expectedAir = Math.max(avgAirDps, maxAirDps * 0.55);
    var threatTotal = expectedGround + expectedAir;
    var groundNeed = threatTotal > 0 ? expectedGround / threatTotal : 1;
    var airNeed = threatTotal > 0 ? expectedAir / threatTotal : 0;
    var requiredGround = clampNumber(expectedGround * 0.65, 25, 700);
    var requiredAir = airNeed > 0.03 ? clampNumber(expectedAir * 0.65, 18, 700) : 0;
    var requiredWallHp = clampNumber(expectedGround * 5, 600, 3500);
    // Without any known wave/enemy approach, guessing all eight directions
    // would just be noise. Exact repair markers below remain useful regardless.
    var hasThreatContext = samples > 0 || (spawns && spawns.length > 0);

    var mapW = (opts.mapWidthTiles || 0) * TILE_SIZE;
    var mapH = (opts.mapHeightTiles || 0) * TILE_SIZE;
    var markers = [];

    function addMarker(marker) {
        if (!marker || !isFinite(marker.x) || !isFinite(marker.y)) return;
        markers.push(marker);
    }

    for (var c = 0; c < cores.length; c++) {
        if (!hasThreatContext) break;
        var core = cores[c];
        if (!core) continue;

        var angles = [];
        if (spawns && spawns.length > 0) {
            for (var s = 0; s < spawns.length; s++) {
                if (!spawns[s]) continue;
                var angle = Math.atan2(spawns[s].y - core.y, spawns[s].x - core.x);
                var duplicate = false;
                for (var a = 0; a < angles.length; a++) {
                    var diff = Math.abs(angle - angles[a]);
                    diff = Math.min(diff, Math.PI * 2 - diff);
                    if (diff < Math.PI / 12) duplicate = true;
                }
                if (!duplicate) angles.push(angle);
            }
        }
        if (angles.length === 0) {
            for (var d = 0; d < 8; d++) angles.push(d * Math.PI / 4);
        }

        for (var ai = 0; ai < angles.length; ai++) {
            var dirX = Math.cos(angles[ai]);
            var dirY = Math.sin(angles[ai]);
            var px = core.x + dirX * DEFENSE_RING_TILES * TILE_SIZE;
            var py = core.y + dirY * DEFENSE_RING_TILES * TILE_SIZE;
            if (mapW > 0) px = clampNumber(px, TILE_SIZE * 2, Math.max(TILE_SIZE * 2, mapW - TILE_SIZE * 2));
            if (mapH > 0) py = clampNumber(py, TILE_SIZE * 2, Math.max(TILE_SIZE * 2, mapH - TILE_SIZE * 2));

            var groundDps = 0, airDps = 0, coveringTurrets = 0;
            var emptyNear = null;
            var emptyDist = Infinity;
            var damagedHp = 0, damagedMaxHp = 0;
            for (var t = 0; t < defenders.length; t++) {
                var turret = defenders[t];
                if (!turret) continue;
                var tdx = px - turret.x;
                var tdy = py - turret.y;
                var tDist = Math.sqrt(tdx * tdx + tdy * tdy);
                var reach = Math.max(40, turret.range || 0) * 0.95;
                if (turret.hasAmmo && tDist <= reach) {
                    coveringTurrets++;
                    if (turret.targetsGround) groundDps += turret.dps || 0;
                    if (turret.targetsAir) airDps += turret.dps || 0;
                }
                if (!turret.hasAmmo && tDist < emptyDist) {
                    emptyDist = tDist;
                    emptyNear = turret;
                }
                if (tDist <= 12 * TILE_SIZE && (turret.maxHealth || 0) > 0) {
                    damagedHp += turret.health || 0;
                    damagedMaxHp += turret.maxHealth || 0;
                }
            }

            var wallHp = 0, wallCount = 0;
            for (var wi = 0; wi < walls.length; wi++) {
                var wall = walls[wi];
                if (!wall) continue;
                var wdx = px - wall.x;
                var wdy = py - wall.y;
                if (wdx * wdx + wdy * wdy <= (7 * TILE_SIZE) * (7 * TILE_SIZE)) {
                    wallHp += wall.health || 0;
                    wallCount++;
                }
            }

            var groundRatio = requiredGround > 0 ? groundDps / requiredGround : 1;
            var airRatio = requiredAir > 0 ? airDps / requiredAir : 1;
            var wallRatio = requiredWallHp > 0 ? wallHp / requiredWallHp : 1;
            var groundLack = clampNumber(1 - groundRatio, 0, 1);
            var airLack = requiredAir > 0 ? clampNumber(1 - airRatio, 0, 1) : 0;
            var wallLack = clampNumber(1 - wallRatio, 0, 1);
            var severity = groundNeed * groundLack + airNeed * airLack + groundNeed * 0.45 * wallLack;
            var maxSeverity = groundNeed + airNeed + groundNeed * 0.45;
            if (maxSeverity > 0) severity /= maxSeverity;

            var hasEmptyNear = !!emptyNear && emptyDist <= 12 * TILE_SIZE;
            if (hasEmptyNear) severity = Math.max(severity, 0.72);
            if (severity < 0.22 && !hasEmptyNear) continue;

            var kind = MARKER_GROUND;
            var markerX = px, markerY = py;
            if (hasEmptyNear && severity >= 0.35) {
                kind = MARKER_SUPPLY;
                markerX = emptyNear.x;
                markerY = emptyNear.y;
            } else if (airNeed > 0.08 && airLack > 0.35 && airLack >= groundLack) {
                kind = MARKER_AIR;
            } else if (groundLack < 0.25 && wallLack > 0.35) {
                kind = MARKER_WALL;
            }

            addMarker({
                x: markerX,
                y: markerY,
                coreX: core.x,
                coreY: core.y,
                kind: kind,
                severity: severity,
                direction: directionName(markerX - core.x, markerY - core.y),
                groundDps: groundDps,
                airDps: airDps,
                wallHp: wallHp,
                wallCount: wallCount,
                turretCount: coveringTurrets,
                // How much is missing here - the list tells the player what to build.
                needGround: Math.max(0, requiredGround - groundDps),
                needAir: requiredAir > 0 ? Math.max(0, requiredAir - airDps) : 0,
                needWall: Math.max(0, requiredWallHp - wallHp),
                healthPct: damagedMaxHp > 0 ? (damagedHp / damagedMaxHp) * 100 : 100,
                tileX: Math.round(markerX / TILE_SIZE),
                tileY: Math.round(markerY / TILE_SIZE)
            });
        }
    }

    // One explicit repair marker for the most damaged front-line building that
    // actually protects a core. Its position is exact, unlike a sector marker.
    var repairCandidate = null;
    function considerRepair(building) {
        if (!building || !(building.maxHealth > 0)) return;
        var pct = (building.health / building.maxHealth) * 100;
        if (pct > 35) return;
        var nearest = nearestCore(building.x, building.y, cores);
        if (!nearest) return;
        var dx = building.x - nearest.x;
        var dy = building.y - nearest.y;
        if (dx * dx + dy * dy > (48 * TILE_SIZE) * (48 * TILE_SIZE)) return;
        if (!repairCandidate || pct < repairCandidate.healthPct) {
            repairCandidate = {
                x: building.x,
                y: building.y,
                coreX: nearest.x,
                coreY: nearest.y,
                kind: MARKER_REPAIR,
                severity: 0.86,
                direction: directionName(dx, dy),
                groundDps: 0,
                airDps: 0,
                wallHp: 0,
                wallCount: 0,
                turretCount: 0,
                needGround: 0,
                needAir: 0,
                needWall: 0,
                healthPct: pct,
                tileX: Math.round(building.x / TILE_SIZE),
                tileY: Math.round(building.y / TILE_SIZE)
            };
        }
    }
    for (var di = 0; di < defenders.length; di++) considerRepair(defenders[di]);
    for (var wj = 0; wj < walls.length; wj++) considerRepair(walls[wj]);
    if (repairCandidate) addMarker(repairCandidate);

    markers.sort(function (a, b) { return b.severity - a.severity; });
    var result = [];
    for (var m = 0; m < markers.length && result.length < WEAK_POINT_MAX; m++) {
        var tooClose = false;
        for (var r = 0; r < result.length; r++) {
            var mdx = markers[m].x - result[r].x;
            var mdy = markers[m].y - result[r].y;
            if (mdx * mdx + mdy * mdy < (16 * TILE_SIZE) * (16 * TILE_SIZE)) tooClose = true;
        }
        if (!tooClose) result.push(markers[m]);
    }
    return result;
}

/**
 * Simulates the coming waves against the current defence and estimates how many
 * more waves the base survives.
 *
 * The model is deliberately simple and conservative:
 *  - every future wave is a "load" (total HP / DPS split into ground and air),
 *    computed by the game glue from the real spawn rules (SpawnGroup.getSpawned),
 *  - the defence kills a layer in `hp / effectiveDps` seconds; only a share of
 *    the nominal DPS ever is on target (DEFENSE_EFFICIENCY), and turrets that can
 *    hit both layers are split between them by HP share,
 *  - while a layer is being killed it deals damage to the front line (turrets +
 *    walls HP pool); air units partly bypass the front line (AIR_TO_CORE),
 *  - front-line losses reduce the turret DPS of the following waves, and a part
 *    of the damage is repaired between waves (REPAIR_FRACTION).
 *
 * opts: {futureWaves, currentLoad, currentWave, coreHealth, defenseHp,
 *        defenseMaxHp, groundDps, airDps, sharedDps, allyDps, powerFactor, winWave}
 * A load: {wave, count, groundHp, flyingHp, groundDps, flyingDps, totalHp,
 *          totalDps, bossCount, bossHp, composition}
 */
function forecastWaves(opts) {
    opts = opts || {};
    var future = opts.futureWaves || [];
    var result = {
        available: false,
        fallWave: 0,
        lastSafeWave: opts.currentWave || 0,
        wavesLeft: 0,
        reason: "",
        cappedByWin: false,
        cappedByHorizon: false,
        nextBossWave: 0,
        nextBossIn: 0,
        nextLoadRatio: 0
    };

    var hasCurrent = !!(opts.currentLoad && opts.currentLoad.count > 0);
    if ((!future || future.length === 0) && !hasCurrent) return result;
    if (!(opts.coreHealth > 0)) return result;

    result.available = true;

    for (var b = 0; b < future.length; b++) {
        if (future[b] && future[b].bossCount > 0) {
            result.nextBossWave = future[b].wave;
            result.nextBossIn = future[b].wave - (opts.currentWave || 0);
            break;
        }
    }

    var sequence = [];
    if (hasCurrent) sequence.push({ load: opts.currentLoad, future: false });
    for (var f = 0; f < future.length; f++) {
        if (future[f]) sequence.push({ load: future[f], future: true });
    }

    var poolMax = Math.max(opts.defenseMaxHp || 0, opts.defenseHp || 0);
    var initialPool = opts.defenseHp || 0;
    var pool = initialPool;
    var core = opts.coreHealth;
    var powerFactor = opts.powerFactor === undefined ? 1 : opts.powerFactor;
    var totalDefense = (opts.groundDps || 0) + (opts.airDps || 0) + (opts.sharedDps || 0) + (opts.allyDps || 0);
    var survivedFuture = 0;

    for (var s = 0; s < sequence.length; s++) {
        var load = sequence[s].load;
        var totalHp = load.totalHp || 0;
        var totalDps = load.totalDps || 0;

        if (!load.count || totalHp <= 0 || totalDps <= 0) {
            // An empty wave (or unarmed units): survived, and there is time to repair.
            pool += (poolMax - pool) * REPAIR_FRACTION;
            if (sequence[s].future) {
                survivedFuture++;
                result.lastSafeWave = load.wave;
            }
            continue;
        }

        var shareGround = totalHp > 0 ? (load.groundHp || 0) / totalHp : 0;
        var turretScale = initialPool > 0 ? Math.max(0, Math.min(1, pool / initialPool)) : 1;
        var effGround = (((opts.groundDps || 0) + (opts.sharedDps || 0) * shareGround) * turretScale +
            (opts.allyDps || 0) * shareGround) * DEFENSE_EFFICIENCY * powerFactor;
        var effAir = (((opts.airDps || 0) + (opts.sharedDps || 0) * (1 - shareGround)) * turretScale +
            (opts.allyDps || 0) * (1 - shareGround)) * DEFENSE_EFFICIENCY * powerFactor;

        var reason = "";
        if (totalDefense <= 0) {
            reason = "no-defense";
        } else if ((load.groundHp || 0) > 0 && (load.groundDps || 0) > 0 && effGround <= 0) {
            reason = "no-ground";
        } else if ((load.flyingHp || 0) > 0 && (load.flyingDps || 0) > 0 && effAir <= 0) {
            reason = "no-air";
        }

        var groundDamage = 0;
        var airDamage = 0;
        if (!reason) {
            if ((load.groundHp || 0) > 0 && effGround > 0) {
                groundDamage = (load.groundDps || 0) * ENEMY_ENGAGEMENT * BATTLE_ATTRITION * ((load.groundHp || 0) / effGround);
            }
            if ((load.flyingHp || 0) > 0 && effAir > 0) {
                airDamage = (load.flyingDps || 0) * ENEMY_ENGAGEMENT * BATTLE_ATTRITION * ((load.flyingHp || 0) / effAir);
            }
        }

        var damageTotal = groundDamage + airDamage;
        if (result.nextLoadRatio === 0 && (pool + core) > 0) {
            result.nextLoadRatio = reason ? Infinity : damageTotal / (pool + core);
        }

        if (!reason) {
            // Ground damage is soaked up by the front line first, the rest reaches the core.
            var absorbed = Math.min(pool, groundDamage);
            pool -= absorbed;
            core -= groundDamage - absorbed;
            // Air units partly fly over the front line.
            core -= airDamage * AIR_TO_CORE;
            var airRest = airDamage * (1 - AIR_TO_CORE);
            absorbed = Math.min(pool, airRest);
            pool -= absorbed;
            core -= airRest - absorbed;

            if (core <= 0) {
                if ((load.bossHp || 0) > 0 && (load.bossHp || 0) >= totalHp * 0.5) {
                    reason = "boss";
                } else {
                    reason = airDamage > groundDamage ? "air" : "ground";
                }
            }
        }

        if (reason) {
            result.fallWave = load.wave;
            result.reason = reason;
            result.wavesLeft = survivedFuture;
            return result;
        }

        if (sequence[s].future) {
            survivedFuture++;
            result.lastSafeWave = load.wave;
        }
        // Menders and repair units fix a part of the front line before the next wave.
        pool += (poolMax - pool) * REPAIR_FRACTION;
    }

    result.wavesLeft = survivedFuture;
    if ((opts.winWave || 0) > 0 && future.length > 0 && result.lastSafeWave >= opts.winWave) {
        result.cappedByWin = true;
    } else {
        result.cappedByHorizon = true;
    }
    return result;
}

/*
 * data: {
 *   units: [{x, y, vx, vy, speed, maxSpeed, accel, dps, hp, flying, boss, name}],
 *   cores: [{x, y, health, maxHealth}],
 *   emptyTurrets: int, damagedBuildings: int, turretCount: int, buildingCount: int,
 *   defenseDps: float (all turrets with ammo, counted once),
 *   defenseGroundDps / defenseAirDps / defenseSharedDps: float (by target flags),
 *   allyDps: float, ownCount / ownGround / ownFlying: int,
 *   defenseHp / defenseMaxHp: float (current / max HP of turrets + walls),
 *   defenders: [turret snapshots for weak-point markers, see computeWeakPoints],
 *   walls: [wall snapshots], spawns: [{x, y}] (wave spawn points),
 *   mapWidthTiles / mapHeightTiles: int (whole-map radar bounds),
 *   coreItems: int (-1 = unknown),
 *   stats: {kills, built, destroyed, unitsCreated} | null,
 *   waves: bool, wave: int, waveTimeSec: float (-1 = manual), waveInProgress: bool,
 *   winWave: int (0 = endless), futureWaves: [wave loads, see forecastWaves],
 *   power: {net, batteryPercent, batterySeconds} | null,
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
        defenseGroundDps: data.defenseGroundDps || 0,
        defenseAirDps: data.defenseAirDps || 0,
        defenseSharedDps: data.defenseSharedDps || 0,
        allyDps: data.allyDps || 0,
        coreDeath: Infinity,
        minCoreHp: 100,
        coreHealth: 0,
        totalEnemyHp: 0,
        totalEnemyDps: 0,
        nearestTiles: Infinity,
        turretCount: data.turretCount || 0,
        buildingCount: data.buildingCount || 0,
        ownCount: data.ownCount || 0,
        ownGround: data.ownGround || 0,
        ownFlying: data.ownFlying || 0,
        defenseHp: data.defenseHp || 0,
        defenseMaxHp: data.defenseMaxHp || 0,
        coreItems: data.coreItems === undefined ? -1 : data.coreItems,
        stats: data.stats || null,
        hasWaves: !!data.waves,
        wave: data.wave || 0,
        waveTimeSec: data.waveTimeSec === undefined ? -1 : data.waveTimeSec,
        waveInProgress: !!data.waveInProgress,
        winWave: data.winWave || 0,
        nextWave: null,
        forecast: { available: false, fallWave: 0, wavesLeft: 0 },
        mapWidthTiles: data.mapWidthTiles || 0,
        mapHeightTiles: data.mapHeightTiles || 0,
        spawns: data.spawns || [],
        weakPoints: [],
        powerNet: 0,
        battery: 100,
        batterySeconds: Infinity,
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
    // Remaining strength of the enemies already on the map (the "current wave" load).
    var curGroundHp = 0, curFlyingHp = 0, curGroundDps = 0, curFlyingDps = 0, curBossHp = 0;

    for (var i = 0; i < units.length; i++) {
        var unit = units[i];
        if (!unit) continue;
        result.count++;

        var unitHp = unit.hp !== undefined && unit.hp !== null ? unit.hp : (unit.maxHp || 0);
        var unitDps = unit.dps || 0;
        result.totalEnemyHp += unitHp;
        result.totalEnemyDps += unitDps;
        if (unit.flying) {
            result.flyingCount++;
            curFlyingHp += unitHp;
            curFlyingDps += unitDps;
        } else {
            result.groundCount++;
            curGroundHp += unitHp;
            curGroundDps += unitDps;
        }
        if (unit.boss) curBossHp += unitHp;

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
        if (dist / TILE_SIZE < result.nearestTiles) {
            result.nearestTiles = dist / TILE_SIZE;
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
        result.batterySeconds = power.batterySeconds === undefined ? Infinity : power.batterySeconds;
        result.powerDeficit = result.powerNet < -5;
        result.blackout = (result.powerDeficit && result.battery <= 1) || (result.powerNet < -30 && result.battery < 10);
    }

    // Wave survival forecast: the enemies already on the map plus every future
    // wave from the real spawn rules, simulated against the current defence.
    var splitGround = result.defenseGroundDps;
    var splitAir = result.defenseAirDps;
    var splitShared = result.defenseSharedDps;
    if (splitGround + splitAir + splitShared <= 0 && result.defenseDps > 0) {
        // No targeting split was provided: treat the total as flexible DPS.
        splitShared = result.defenseDps;
    }
    var currentLoad = null;
    if (result.count > 0) {
        currentLoad = {
            wave: result.wave || 0,
            count: result.count,
            groundHp: curGroundHp,
            flyingHp: curFlyingHp,
            groundDps: curGroundDps,
            flyingDps: curFlyingDps,
            totalHp: result.totalEnemyHp,
            totalDps: result.totalEnemyDps,
            bossCount: result.bossCount,
            bossHp: curBossHp,
            composition: ""
        };
    }
    var futureWaves = data.futureWaves || [];
    result.forecast = forecastWaves({
        futureWaves: futureWaves,
        currentLoad: currentLoad,
        currentWave: result.wave || 0,
        coreHealth: coreHealth,
        defenseHp: result.defenseHp,
        defenseMaxHp: result.defenseMaxHp,
        groundDps: splitGround,
        airDps: splitAir,
        sharedDps: splitShared,
        allyDps: result.allyDps,
        // Starved power turrets do not fire at full strength.
        powerFactor: result.blackout ? 0.45 : (result.powerDeficit ? 0.8 : 1),
        winWave: result.winWave
    });
    for (var w = 0; w < futureWaves.length; w++) {
        if (futureWaves[w] && futureWaves[w].count > 0) {
            result.nextWave = futureWaves[w];
            break;
        }
    }

    result.weakPoints = computeWeakPoints({
        cores: cores,
        defenders: data.defenders || [],
        walls: data.walls || [],
        spawns: result.spawns,
        futureWaves: futureWaves,
        currentGroundDps: curGroundDps,
        currentFlyingDps: curFlyingDps,
        currentGroundHp: curGroundHp,
        currentFlyingHp: curFlyingHp,
        mapWidthTiles: result.mapWidthTiles,
        mapHeightTiles: result.mapHeightTiles
    });

    return result;
}

function etaSeconds(etaTicks) {
    return Math.max(1, Math.floor(etaTicks / 60));
}

/** Two short legend rows so the map stays easy to read without widening the HUD. */
function legend() {
    return "[lightgray]Карта мира[]: [accent]◆[] ядро  [white]●[] игрок  [scarlet]□[] спавн\n" +
        "[lightgray]Метки[]: [scarlet]●[] земля  [orange]●[] авиация  [scarlet]◉[] босс  [yellow]✚[] улучшить\n" +
        "[lightgray]Клик по карте — выбрать участок · план не строит автоматически[]";
}

/** Short, plain-language reason for one recommended build/repair. */
function compactAdviceDetail(wp, advice) {
    if (!wp) return advice && advice.detail ? advice.detail : "";
    switch (wp.kind) {
        case MARKER_AIR:
            return wp.airDps > 0
                ? "нужно +" + fmtAmount(wp.needAir) + " урона/с по воздуху"
                : "нет защиты от авиации";
        case MARKER_WALL:
            return "нужно +" + fmtAmount(wp.needWall) + " HP стен";
        case MARKER_SUPPLY:
            return "нет патронов";
        case MARKER_REPAIR:
            return "осталось " + Math.round(wp.healthPct) + "% HP";
        default:
            return "нужно +" + fmtAmount(wp.needGround) + " урона/с";
    }
}

/**
 * Builds a compact tactical briefing: immediate danger first, then the next
 * useful action. Less actionable base/session counters are intentionally left
 * out so the larger map does not turn the HUD into a screen-sized report.
 */
function formatRadarText(inGame, result) {
    if (!inGame || !result) {
        return "[gold]РАДАР[]\n[gray]Неактивен вне игры — запустите бой, чтобы увидеть угрозы[]";
    }

    var lines = [];
    var header = "[gold]РАДАР[]";
    if (result.hasWaves && result.wave > 0) {
        header += " [lightgray]·[] [accent]Волна " + result.wave + "[]";
        if (result.winWave > 0) header += "[lightgray]/" + result.winWave + "[]";
        if (result.waveInProgress) header += " [orange]· идёт бой[]";
        if (result.waveTimeSec >= 0) header += " [lightgray]· следующая через " + fmtTime(result.waveTimeSec) + "[]";
        else if (!result.waveInProgress) header += " [lightgray]· запуск вручную[]";
    }
    lines.push(header);

    if (result.count > 0) {
        var enemyLine = "[white]Враги: " + result.count + " (земля " + result.groundCount +
            ", авиация " + result.flyingCount;
        if (result.bossCount > 0) enemyLine += ", боссы " + result.bossCount;
        lines.push(enemyLine + ")[]");

        var strengthLine = "[lightgray]Сила: HP ~" + fmtAmount(result.totalEnemyHp) +
            " · урон " + Math.round(result.totalEnemyDps) + "/с";
        if (isFinite(result.nearestTiles)) {
            strengthLine += " · ближайший " + Math.round(result.nearestTiles) + " тайлов";
        }
        lines.push(strengthLine + "[]");
    }

    // One clear line for the most relevant current engagement.
    if (result.threats > 0 && isFinite(result.directEta)) {
        var danger = "⚠️ К ядру идут " + result.threats + " · прибытие " +
            etaSeconds(result.directEtaLow) + "–" + etaSeconds(result.directEtaHigh) + " с";
        if (isFinite(result.coreDeath)) danger += " · ядро может пасть через ~" + Math.round(result.coreDeath) + " с";
        lines.push("[scarlet]" + danger + "[]");
    } else if (result.closeThreats > 0) {
        lines.push("[crimson]🚨 Враг уже у ядра[]");
    } else if (result.incoming > 0) {
        var battle = "⚔ За " + Math.floor(result.horizonSeconds || HORIZON_SECONDS) + " с: " +
            result.incoming + " " + foeWord(result.incoming) + " · урон " + Math.round(result.incomingDps) + "/с";
        if (result.defenseDps > 0) battle += " · защита " + Math.round(result.defenseDps) + "/с";
        else battle += " · защиты нет";
        if (isFinite(result.coreDeath)) battle += " · ядро через ~" + Math.round(result.coreDeath) + " с";
        else if (result.defenseDps > 0) battle += " · отбиваем";
        lines.push((isFinite(result.coreDeath) ? "[crimson]" : "[orange]") + battle + "[]");
    } else if (result.count > 0 && isFinite(result.eta)) {
        lines.push("[orange]🟠 Враг идёт в обход · прибытие " +
            etaSeconds(result.etaLow) + "–" + etaSeconds(result.etaHigh) + " с[]");
    }

    // Show the two most useful build locations. Any additional places remain
    // visible on the map, identified by the ✚ markers.
    var weakPoints = result.weakPoints || [];
    var shownWeakPoints = Math.min(2, weakPoints.length);
    for (var wpI = 0; wpI < shownWeakPoints; wpI++) {
        var wp = weakPoints[wpI];
        var advice = adviceFor(wp);
        var actionLine = wpI === 0 ? "[gold]🎯 Что улучшить:[] " : "";
        actionLine += (wp.severity >= 0.65 ? "[crimson]" : "[lightgray]") + (wpI + 1) + ")[] " +
            "[" + advice.color + "]" + advice.action + "[] [lightgray]· " + wp.direction + " " +
            wp.tileX + "," + wp.tileY + " — " + compactAdviceDetail(wp, advice);
        if (wpI === shownWeakPoints - 1 && weakPoints.length > shownWeakPoints) {
            actionLine += " · ещё " + (weakPoints.length - shownWeakPoints) + " место ✚ на карте";
        }
        lines.push(actionLine + "[]");
    }

    var fc = result.forecast;
    if (fc && fc.available) {
        var reasonText = {
            "ground": "наземка",
            "air": "авиация",
            "boss": "босс",
            "no-ground": "нет урона по земле",
            "no-air": "нет ПВО",
            "no-defense": "нет обороны"
        }[fc.reason] || "";
        if (fc.fallWave > 0) {
            if (result.wave > 0 && fc.fallWave <= result.wave) {
                lines.push("[crimson]🏰 Эта волна может быть последней" +
                    (reasonText ? " — " + reasonText : "") + "[]");
            } else if (fc.wavesLeft <= 0) {
                lines.push("[crimson]🏰 Оборона не выдержит следующую волну" +
                    (reasonText ? " · причина: " + reasonText : "") + "[]");
            } else {
                var fcColor = fc.wavesLeft <= 1 ? "[crimson]" : (fc.wavesLeft <= 4 ? "[orange]" : "[yellow]");
                lines.push(fcColor + "🏰 Оборона выдержит ~" + fc.wavesLeft + " " + waveWord(fc.wavesLeft) +
                    " · риск на ~" + fc.fallWave + "-й" + (reasonText ? ": " + reasonText : "") + "[]");
            }
        } else if (fc.cappedByWin) {
            lines.push("[green]🏰 Оборона выдержит до победы (волна " + result.winWave + ") ✅[]");
        } else if (fc.wavesLeft > 0) {
            lines.push("[green]🏰 Оборона держится ещё " + fc.wavesLeft + "+ волн[]");
        }
    }

    if (result.nextWave) {
        var nw = result.nextWave;
        var nwText = "[lightgray]Следующая волна " + nw.wave + ": " + nw.count + " " + foeWord(nw.count);
        if (nw.composition) nwText += " · " + nw.composition;
        else nwText += " · HP ~" + fmtAmount(nw.totalHp);
        lines.push(nwText + "[]");
    }
    if (fc && fc.available && fc.nextBossWave > 0 && fc.nextBossIn > 0 && fc.nextBossIn <= 10 && result.bossCount === 0 &&
            (!result.nextWave || result.nextWave.wave !== fc.nextBossWave)) {
        lines.push("[scarlet]💀 Босс на волне " + fc.nextBossWave + " · через " + fc.nextBossIn + " " +
            waveWord(fc.nextBossIn) + "[]");
    }

    // Bundle urgent base diagnostics into one readable line instead of a row
    // for every individual counter.
    var diagnostics = [];
    if (result.minCoreHp < 99) diagnostics.push("Ядро: HP " + Math.round(result.minCoreHp) + "%");
    if (result.hasPower) {
        if (result.blackout) {
            diagnostics.push("⚡ Электросеть отключена");
        } else if (result.powerDeficit) {
            var energy = "⚡ Энергия: не хватает " + Math.abs(Math.round(result.powerNet)) + "/с · батарея " +
                Math.round(result.battery) + "%";
            if (isFinite(result.batterySeconds)) energy += " (~" + fmtTime(result.batterySeconds) + ")";
            diagnostics.push(energy);
        }
    }

    var adviceKinds = weakPoints.map(function (point) { return point.kind; });
    if (result.emptyTurrets > 0 && adviceKinds.indexOf(MARKER_SUPPLY) === -1) {
        diagnostics.push("📦 Турели без патронов: " + result.emptyTurrets);
    }
    if (result.damagedBuildings >= 3 && adviceKinds.indexOf(MARKER_REPAIR) === -1) {
        diagnostics.push("🛠 Повреждено построек: " + result.damagedBuildings);
    }
    if (diagnostics.length > 0) {
        var diagnosticColor = result.blackout || result.minCoreHp <= 35 ? "[scarlet]" : "[yellow]";
        lines.push(diagnosticColor + "⚠ " + diagnostics.join(" · ") + "[]");
    }

    var hasAlerts = result.threats > 0 || result.closeThreats > 0 || result.bossCount > 0 ||
        result.incoming > 0 || result.minCoreHp < 99 || result.powerDeficit ||
        (fc && fc.fallWave > 0 && fc.wavesLeft <= 1) || weakPoints.length > 0 ||
        result.emptyTurrets > 0 || result.damagedBuildings >= 3;
    if (!hasAlerts && result.count === 0) {
        lines.push("[green]✅ Всё спокойно — угроз нет, база в порядке[]");
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
        PANEL_WIDTH: PANEL_WIDTH,
        RADAR_SIZE: RADAR_SIZE,
        RADAR_HEIGHT_FRACTION: RADAR_HEIGHT_FRACTION,
        PANEL_WIDTH_FRACTION: PANEL_WIDTH_FRACTION,
        RADAR_RANGE_TILES: RADAR_RANGE_TILES,
        DEFENSE_RING_TILES: DEFENSE_RING_TILES,
        WEAK_POINT_MAX: WEAK_POINT_MAX,
        MARKER_GROUND: MARKER_GROUND,
        MARKER_AIR: MARKER_AIR,
        MARKER_WALL: MARKER_WALL,
        MARKER_SUPPLY: MARKER_SUPPLY,
        MARKER_REPAIR: MARKER_REPAIR,
        HORIZON_SECONDS: HORIZON_SECONDS,
        WAVE_FORECAST_MAX: WAVE_FORECAST_MAX,
        DEFENSE_EFFICIENCY: DEFENSE_EFFICIENCY,
        predictArrival: predictArrival,
        forecastWaves: forecastWaves,
        computeWeakPoints: computeWeakPoints,
        computeRadar: computeRadar,
        formatRadarText: formatRadarText,
        etaSeconds: etaSeconds,
        fmtAmount: fmtAmount,
        fmtTime: fmtTime,
        waveWord: waveWord,
        foeWord: foeWord,
        adviceFor: adviceFor,
        markerColor: markerColor,
        directionName: directionName,
        PLAN_WALL: PLAN_WALL,
        PLAN_DUO: PLAN_DUO,
        PLAN_SCATTER: PLAN_SCATTER,
        PLAN_MENDER: PLAN_MENDER,
        defenseFront: defenseFront,
        defenseLayout: defenseLayout,
        analyzeDefensePlan: analyzeDefensePlan,
        formatDefensePlan: formatDefensePlan,
        mapTileAt: mapTileAt,
        mapViewport: mapViewport,
        projectMap: projectMap,
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
    var selectedTileX = -1;
    var selectedTileY = -1;

    // Everything the mini map needs to draw itself. It lives in a closure so that
    // the JavaAdapter based element can read it without any extra Java class.
    var radarState = {
        blips: [],
        cores: [],
        spawns: [],
        weakPoints: [],
        mapWidth: RADAR_RANGE_TILES * TILE_SIZE * 2,
        mapHeight: RADAR_RANGE_TILES * TILE_SIZE * 2,
        mapOffsetX: 0,
        mapOffsetY: 0,
        focusX: 0,
        focusY: 0,
        hasFocus: false,
        playerX: 0,
        playerY: 0,
        hasPlayer: false,
        threatX: 0,
        threatY: 0,
        threatCoreX: 0,
        threatCoreY: 0,
        hasThreat: false,
        selectedTileX: -1,
        selectedTileY: -1,
        defensePlan: null
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

    /** Reads only public world/tile data; no build plans are sent to the game. */
    var buildDefensePlan = function (tileX, tileY, prediction) {
        var front = defenseFront(tileX, tileY, prediction.spawns || [], prediction.blips || []);
        var width = prediction.mapWidthTiles || 0;
        var height = prediction.mapHeightTiles || 0;
        return analyzeDefensePlan(tileX, tileY, front.dx, front.dy, width, height, function (x, y) {
            if (!Vars.world || x < 0 || y < 0 || (width > 0 && x >= width) || (height > 0 && y >= height)) {
                return "outside";
            }
            var tile = null;
            try { tile = Vars.world.tile(x, y); } catch (ignored) {}
            if (!tile) return "outside";
            var floor = callSafely(tile, "floor", null);
            if (floor && callSafely(floor, "isLiquid", false)) return "water";
            var block = callSafely(tile, "block", null);
            if (!block) return null;
            try {
                var air = Packages.mindustry.content.Blocks.air;
                if (block === air || String(callSafely(block, "name", "")) === "air") return null;
            } catch (ignored) {
                if (String(callSafely(block, "name", "")) === "air") return null;
            }
            return "occupied";
        });
    };

    /**
     * Builds the loads of the coming waves from the real spawn rules.
     *
     * Mirrors WaveSpawner.spawnEnemies() in v160.7: the next spawn uses the
     * spawn index `state.wave - 1`, campaign difficulty multiplies the amount
     * (bosses are rounded down), unit HP is scaled by the rules multipliers and
     * the per-wave shield is added. Wave labels are `spawnIndex + 2`, which is
     * the number the in-game wave counter (and the game-over statistics) shows
     * while that wave is being fought, so the last needed wave is `winWave`.
     */
    var buildWaveInfo = function (enemyTeam) {
        var info = {
            waves: false,
            wave: 0,
            waveTimeSec: -1,
            waveInProgress: false,
            winWave: 0,
            futureWaves: []
        };
        try {
            var rules = Vars.state.rules;
            if (!rules) return info;
            info.waves = !!rules.waves;
            info.wave = Vars.state.wave || 0;
            info.winWave = rules.winWave || 0;
            info.waveTimeSec = rules.waveTimer ? Math.max(0, (Vars.state.wavetime || 0) / 60) : -1;
            info.waveInProgress = (Vars.state.enemies || 0) > 0;
            if (!info.waves || !rules.spawns || !rules.spawns.size || info.wave <= 0) return info;

            var spawnMult = 1, healthMult = 1, damageMult = 1, campaign = false;
            try {
                campaign = !!callSafely(Vars.state, "isCampaign", false);
                if (campaign) {
                    var planet = callSafely(Vars.state, "getPlanet", null);
                    if (planet && planet.campaignRules && planet.campaignRules.difficulty) {
                        spawnMult = planet.campaignRules.difficulty.enemySpawnMultiplier || 1;
                    }
                }
            } catch (ignored) {}
            try { healthMult = rules.unitHealth(enemyTeam) || 1; } catch (ignored) {}
            try { damageMult = rules.unitDamage(enemyTeam) || 1; } catch (ignored) {}

            var lastLabel = info.wave + WAVE_FORECAST_MAX;
            if (info.winWave > 0) lastLabel = Math.min(lastLabel, info.winWave);

            for (var label = info.wave + 1; label <= lastLabel; label++) {
                var index = label - 2;
                var load = {
                    wave: label, count: 0, groundCount: 0, flyingCount: 0, bossCount: 0,
                    totalHp: 0, totalDps: 0, groundHp: 0, flyingHp: 0,
                    groundDps: 0, flyingDps: 0, bossHp: 0, composition: ""
                };
                var compNames = [];
                var compCounts = [];

                for (var g = 0; g < rules.spawns.size; g++) {
                    var group = rules.spawns.get(g);
                    if (!group || !group.type) continue;
                    var amount = 0;
                    try { amount = group.getSpawned(index); } catch (ignored) { continue; }
                    if (!amount || amount <= 0) continue;

                    var boss = false;
                    try {
                        boss = !!(typeof StatusEffects !== "undefined" && StatusEffects.boss && group.effect === StatusEffects.boss);
                    } catch (ignored) {}
                    if (campaign && spawnMult !== 1) {
                        amount = Math.max(1, boss ? Math.floor(amount * spawnMult) : Math.round(amount * spawnMult));
                    }

                    var gtype = group.type;
                    var shield = 0;
                    try { shield = group.getShield(index) || 0; } catch (ignored) {}
                    var perHp = (gtype.health || 0) * healthMult + Math.max(0, shield);
                    var perDps = callSafely(gtype, "estimateDps", 0) * damageMult;

                    load.count += amount;
                    load.totalHp += perHp * amount;
                    load.totalDps += perDps * amount;
                    if (gtype.flying) {
                        load.flyingCount += amount;
                        load.flyingHp += perHp * amount;
                        load.flyingDps += perDps * amount;
                    } else {
                        load.groundCount += amount;
                        load.groundHp += perHp * amount;
                        load.groundDps += perDps * amount;
                    }
                    if (boss) {
                        load.bossCount += amount;
                        load.bossHp += perHp * amount;
                    }

                    var unitName = gtype.localizedName || gtype.name || "?";
                    var at = compNames.indexOf(unitName);
                    if (at === -1) {
                        compNames.push(unitName);
                        compCounts.push(amount);
                    } else {
                        compCounts[at] += amount;
                    }
                }

                // The three most numerous unit types of the wave, biggest first.
                var parts = [];
                for (var pick = 0; pick < 3 && compNames.length > 0; pick++) {
                    var bestAt = 0;
                    for (var ci = 1; ci < compNames.length; ci++) {
                        if (compCounts[ci] > compCounts[bestAt]) bestAt = ci;
                    }
                    parts.push(compCounts[bestAt] + "×" + compNames[bestAt]);
                    compNames.splice(bestAt, 1);
                    compCounts.splice(bestAt, 1);
                }
                load.composition = parts.join(", ");

                info.futureWaves.push(load);
            }
        } catch (err) {
            logError("wave forecast failed", err);
        }
        return info;
    };

    var refreshRadar = function () {
        if (!statusLabel) return;
        try {
            if (!Vars.state || !Vars.state.isGame() || !Vars.player || !Vars.player.isAdded()) {
                statusLabel.setText(formatRadarText(false, null));
                selectedTileX = -1;
                selectedTileY = -1;
                radarState.selectedTileX = -1;
                radarState.selectedTileY = -1;
                radarState.defensePlan = null;
                radarState.blips = [];
                radarState.cores = [];
                radarState.spawns = [];
                radarState.weakPoints = [];
                radarState.hasPlayer = false;
                radarState.hasFocus = false;
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
            var ownCount = 0, ownGround = 0, ownFlying = 0, allyDps = 0;
            if (typeof Groups !== "undefined" && Groups.unit) {
                Groups.unit.each(asCons(function (unit) {
                    if (!unit) return;
                    // Only real, living units are of interest.
                    if (unit.dead) return;
                    if (unit.isAdded && !unit.isAdded()) return;
                    var type = unit.type;
                    // isFlying() is true while a unit is airborne, so the type is the reliable source.
                    var flying = type ? !!type.flying : !!callSafely(unit, "isFlying", false);

                    if (unit.team === playerTeam) {
                        // Own combat units are part of the defence too.
                        ownCount++;
                        if (flying) ownFlying++; else ownGround++;
                        allyDps += type ? callSafely(type, "estimateDps", 0) : 0;
                        return;
                    }
                    if (unit.team !== enemyTeam) return;

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
                        // Remaining strength: hull HP plus whatever shield is left.
                        hp: callSafely(unit, "health", type ? type.health : 0) + Math.max(0, callSafely(unit, "shield", 0)),
                        flying: flying,
                        boss: !!callSafely(unit, "isBoss", false),
                        name: type ? (type.localizedName || type.name) : "Enemy"
                    });
                }));
            }

            // Turrets, damaged buildings, the estimated defensive DPS (split by what
            // the turrets can actually target) and the HP of the front line itself.
            var emptyTurrets = 0;
            var damagedBuildings = 0;
            var turretCount = 0;
            var buildingCount = 0;
            var defenseDps = 0;
            var defenseGroundDps = 0, defenseAirDps = 0, defenseSharedDps = 0;
            var defenseHp = 0, defenseMaxHp = 0;
            var defenders = [];
            var wallBuildings = [];
            if (teamData && teamData.buildings) {
                var bSeq = teamData.buildings;
                for (var b = 0; b < bSeq.size; b++) {
                    var bld = bSeq.get(b);
                    if (!bld || !bld.isValid || !bld.isValid()) continue;
                    buildingCount++;
                    if (bld.health < bld.maxHealth * 0.5) {
                        damagedBuildings++;
                    }
                    var hasAmmo = callSafely(bld, "hasAmmo", null);
                    var isTurret = hasAmmo !== null;
                    if (isTurret) turretCount++;

                    // The front line that soaks up wave damage: turrets and walls.
                    var isWall = false;
                    try {
                        isWall = !!(bld.block && typeof BlockGroup !== "undefined" && bld.block.group === BlockGroup.walls);
                    } catch (ignored) {}
                    if (isTurret || isWall) {
                        defenseHp += bld.health || 0;
                        defenseMaxHp += bld.maxHealth || 0;
                    }
                    if (isWall) {
                        wallBuildings.push({
                            x: bld.x, y: bld.y,
                            health: bld.health || 0,
                            maxHealth: bld.maxHealth || 0
                        });
                    }

                    if (hasAmmo === false) {
                        emptyTurrets++;
                    }

                    if (isTurret) {
                        var targetsGround = true, targetsAir = true;
                        try {
                            if (bld.block) {
                                if (bld.block.targetGround !== undefined) targetsGround = !!bld.block.targetGround;
                                if (bld.block.targetAir !== undefined) targetsAir = !!bld.block.targetAir;
                            }
                        } catch (ignored) {}

                        var turretDps = hasAmmo === true ? callSafely(bld, "estimateDps", 0) : 0;
                        if (hasAmmo === true) {
                            defenseDps += turretDps;
                            if (targetsGround && targetsAir) defenseSharedDps += turretDps;
                            else if (targetsGround) defenseGroundDps += turretDps;
                            else if (targetsAir) defenseAirDps += turretDps;
                            else defenseSharedDps += turretDps;
                        }

                        var turretRange = callSafely(bld, "range", 0);
                        if (!(turretRange > 0)) {
                            try { turretRange = bld.block && bld.block.range ? bld.block.range : 0; } catch (ignored) { turretRange = 0; }
                        }
                        defenders.push({
                            x: bld.x, y: bld.y,
                            dps: turretDps,
                            range: turretRange || 0,
                            targetsGround: targetsGround,
                            targetsAir: targetsAir,
                            hasAmmo: hasAmmo === true,
                            health: bld.health || 0,
                            maxHealth: bld.maxHealth || 0
                        });
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
                // How long the batteries can cover the current deficit.
                powerInfo.batterySeconds = powerInfo.net < 0 && batStored > 0
                    ? batStored / Math.abs(powerInfo.net) : Infinity;
            }

            // Items stored in the (main) core
            var coreItems = -1;
            if (mainCore && mainCore.items) {
                var totalItems = callSafely(mainCore.items, "total", -1);
                if (typeof totalItems === "number" && totalItems >= 0) coreItems = totalItems;
            }

            // The game's own session statistics
            var sessionStats = null;
            if (Vars.state.stats) {
                sessionStats = {
                    kills: callSafely(Vars.state.stats, "enemyUnitsDestroyed", 0) || 0,
                    built: callSafely(Vars.state.stats, "buildingsBuilt", 0) || 0,
                    destroyed: callSafely(Vars.state.stats, "buildingsDestroyed", 0) || 0,
                    unitsCreated: callSafely(Vars.state.stats, "unitsCreated", 0) || 0
                };
            }

            // Whole-map bounds and the real wave spawn points. Both are optional:
            // the drawing falls back to a bounding box around everything known.
            var mapWidthTiles = 0, mapHeightTiles = 0;
            if (typeof Vars.world !== "undefined" && Vars.world) {
                mapWidthTiles = callSafely(Vars.world, "width", 0) || 0;
                mapHeightTiles = callSafely(Vars.world, "height", 0) || 0;
            }
            var spawnPoints = [];
            try {
                var spawnSeq = (typeof Vars.spawner !== "undefined" && Vars.spawner)
                    ? callSafely(Vars.spawner, "getSpawns", null) : null;
                if (spawnSeq && spawnSeq.size !== undefined) {
                    for (var sp = 0; sp < spawnSeq.size; sp++) {
                        var spawnTile = spawnSeq.get(sp);
                        if (!spawnTile) continue;
                        spawnPoints.push({
                            x: callSafely(spawnTile, "worldx", (spawnTile.x || 0) * TILE_SIZE),
                            y: callSafely(spawnTile, "worldy", (spawnTile.y || 0) * TILE_SIZE)
                        });
                    }
                }
            } catch (ignored) {}

            var waveInfo = buildWaveInfo(enemyTeam);

            var radarData = computeRadar({
                units: units,
                cores: cores,
                emptyTurrets: emptyTurrets,
                damagedBuildings: damagedBuildings,
                turretCount: turretCount,
                buildingCount: buildingCount,
                defenseDps: defenseDps,
                defenseGroundDps: defenseGroundDps,
                defenseAirDps: defenseAirDps,
                defenseSharedDps: defenseSharedDps,
                allyDps: allyDps,
                ownCount: ownCount,
                ownGround: ownGround,
                ownFlying: ownFlying,
                defenseHp: defenseHp,
                defenseMaxHp: defenseMaxHp,
                defenders: defenders,
                walls: wallBuildings,
                spawns: spawnPoints,
                mapWidthTiles: mapWidthTiles,
                mapHeightTiles: mapHeightTiles,
                coreItems: coreItems,
                stats: sessionStats,
                waves: waveInfo.waves,
                wave: waveInfo.wave,
                waveTimeSec: waveInfo.waveTimeSec,
                waveInProgress: waveInfo.waveInProgress,
                winWave: waveInfo.winWave,
                futureWaves: waveInfo.futureWaves,
                power: powerInfo,
                horizonSeconds: HORIZON_SECONDS
            });

            var defensePlan = selectedTileX >= 0 && selectedTileY >= 0
                ? buildDefensePlan(selectedTileX, selectedTileY, radarData) : null;
            var briefing = formatRadarText(true, radarData);
            if (defensePlan) briefing += "\n" + formatDefensePlan(defensePlan);
            statusLabel.setText(briefing);
            updateRadar(radarData, cores, defensePlan);
        } catch (err) {
            logError("refresh failed", err);
            try {
                statusLabel.setText("[gold]РАДАР КАМПАНИИ[]\n[scarlet]Ошибка обновления[]\n[gray]Подробнее в last_log.txt[]");
            } catch (ignored) {}
        }
    };

    /** Feeds the whole-map mini map with the freshly computed data. */
    var updateRadar = function (prediction, cores, defensePlan) {
        radarState.selectedTileX = selectedTileX;
        radarState.selectedTileY = selectedTileY;
        radarState.defensePlan = defensePlan || null;
        radarState.blips = prediction.blips || [];
        radarState.cores = [];
        radarState.spawns = prediction.spawns || [];
        radarState.weakPoints = prediction.weakPoints || [];

        var playerUnit = null;
        try {
            // Player.unit is a protected field, the accessor is unit().
            playerUnit = callSafely(Vars.player, "unit", null);
        } catch (ignored) {}

        // The weakest core (by HP fraction) is highlighted; the map itself no
        // longer follows it, because the whole world is always visible.
        var weakest = null;
        var weakestFrac = Infinity;
        for (var ci = 0; ci < (cores ? cores.length : 0); ci++) {
            var frac = cores[ci].maxHealth > 0 ? cores[ci].health / cores[ci].maxHealth : 1;
            if (!weakest || frac < weakestFrac) {
                weakest = cores[ci];
                weakestFrac = frac;
            }
        }
        for (var c = 0; c < (cores ? cores.length : 0); c++) {
            radarState.cores.push({
                x: cores[c].x,
                y: cores[c].y,
                healthFrac: cores[c].maxHealth > 0 ? cores[c].health / cores[c].maxHealth : 1,
                weakest: cores[c] === weakest
            });
        }
        if (weakest) {
            radarState.focusX = weakest.x;
            radarState.focusY = weakest.y;
            radarState.hasFocus = true;
        } else if (playerUnit) {
            radarState.focusX = playerUnit.x;
            radarState.focusY = playerUnit.y;
            radarState.hasFocus = true;
        } else {
            radarState.hasFocus = false;
        }

        // Whole world first. If its size is unavailable (tests, unusual rules),
        // fall back to a padded bounding box around every known object so that
        // distant cores still cannot disappear from the panel.
        if (prediction.mapWidthTiles > 0 && prediction.mapHeightTiles > 0) {
            radarState.mapOffsetX = 0;
            radarState.mapOffsetY = 0;
            radarState.mapWidth = prediction.mapWidthTiles * TILE_SIZE;
            radarState.mapHeight = prediction.mapHeightTiles * TILE_SIZE;
        } else {
            var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            var includePoint = function (x, y) {
                if (!isFinite(x) || !isFinite(y)) return;
                minX = Math.min(minX, x); minY = Math.min(minY, y);
                maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
            };
            for (var ii = 0; ii < radarState.cores.length; ii++) includePoint(radarState.cores[ii].x, radarState.cores[ii].y);
            for (var bi = 0; bi < radarState.blips.length; bi++) includePoint(radarState.blips[bi].x, radarState.blips[bi].y);
            for (var si = 0; si < radarState.spawns.length; si++) includePoint(radarState.spawns[si].x, radarState.spawns[si].y);
            for (var wi2 = 0; wi2 < radarState.weakPoints.length; wi2++) includePoint(radarState.weakPoints[wi2].x, radarState.weakPoints[wi2].y);
            if (playerUnit) includePoint(playerUnit.x, playerUnit.y);
            if (!isFinite(minX)) {
                minX = -RADAR_RANGE_TILES * TILE_SIZE; minY = -RADAR_RANGE_TILES * TILE_SIZE;
                maxX = RADAR_RANGE_TILES * TILE_SIZE; maxY = RADAR_RANGE_TILES * TILE_SIZE;
            }
            var pad = 40 * TILE_SIZE;
            radarState.mapOffsetX = minX - pad;
            radarState.mapOffsetY = minY - pad;
            radarState.mapWidth = Math.max(TILE_SIZE, (maxX - minX) + pad * 2);
            radarState.mapHeight = Math.max(TILE_SIZE, (maxY - minY) + pad * 2);
        }

        if (playerUnit) {
            radarState.playerX = playerUnit.x;
            radarState.playerY = playerUnit.y;
            radarState.hasPlayer = true;
        } else {
            radarState.hasPlayer = false;
        }

        // Draw the attack line from the core this enemy is actually approaching.
        var closest = null;
        var blips = prediction.blips || [];
        for (var b = 0; b < blips.length; b++) {
            if (!closest || blips[b].eta < closest.eta) closest = blips[b];
        }
        if (closest && isFinite(closest.eta)) {
            radarState.threatX = closest.x;
            radarState.threatY = closest.y;
            var targetCore = nearestCore(closest.x, closest.y, cores || []);
            radarState.threatCoreX = targetCore ? targetCore.x : radarState.focusX;
            radarState.threatCoreY = targetCore ? targetCore.y : radarState.focusY;
            radarState.hasThreat = !!targetCore || radarState.hasFocus;
        } else {
            radarState.hasThreat = false;
        }
    };

    /** Draws the tactical whole-map view. */
    var drawRadar = function (state, element) {
        var w = element.getWidth();
        var h = element.getHeight();
        if (!(w > 0) || !(h > 0)) return;
        var symbolScale = Math.max(0.85, Math.min(1.35, Math.min(w, h) / 160));

        // The whole world always fits in this rectangle. Non-square maps are
        // letterboxed instead of stretched, so relative positions stay true.
        var view = mapViewport(w, h, state.mapWidth, state.mapHeight);
        var mapX = element.x + view.x;
        var mapY = element.y + view.y;
        var project = function (worldX, worldY) {
            var p = projectMap(view, (worldX || 0) - (state.mapOffsetX || 0), (worldY || 0) - (state.mapOffsetY || 0));
            return { x: element.x + p.x, y: element.y + p.y, clamped: p.clamped };
        };

        // Letterbox and map background.
        Draw.color(0.015, 0.025, 0.045, 0.92);
        Fill.rect(element.x, element.y, w, h);
        Draw.color(0.05, 0.08, 0.12, 0.95);
        Fill.rect(mapX, mapY, view.width, view.height);

        // Quarter grid helps compare the abstract map with the vanilla minimap.
        Draw.color(0.35, 0.5, 0.65, 0.18);
        Lines.stroke(1);
        for (var gi = 1; gi <= 3; gi++) {
            var gx = mapX + view.width * gi / 4;
            var gy = mapY + view.height * gi / 4;
            Lines.line(gx, mapY, gx, mapY + view.height);
            Lines.line(mapX, gy, mapX + view.width, gy);
        }

        // Frame of the element and the actual world boundary inside it.
        Draw.color(0.45, 0.6, 0.8, 0.55);
        Lines.stroke(1.5);
        Lines.rect(element.x, element.y, w, h);
        Draw.color(0.55, 0.75, 1, 0.8);
        Lines.stroke(1.2);
        Lines.rect(mapX, mapY, view.width, view.height);

        // The selected tile is ringed; proposed buildings use compact colour-coded markers.
        if (state.selectedTileX >= 0 && state.selectedTileY >= 0) {
            var selected = project((state.selectedTileX + 0.5) * TILE_SIZE,
                (state.selectedTileY + 0.5) * TILE_SIZE);
            Draw.color(0.9, 0.95, 1, 0.9);
            Lines.stroke(1.3);
            Lines.circle(selected.x, selected.y, 11 * symbolScale);
            Lines.line(selected.x - 4 * symbolScale, selected.y,
                selected.x + 4 * symbolScale, selected.y);
            Lines.line(selected.x, selected.y - 4 * symbolScale,
                selected.x, selected.y + 4 * symbolScale);
        }
        if (state.defensePlan) {
            for (var pi = 0; pi < state.defensePlan.placements.length; pi++) {
                var placement = state.defensePlan.placements[pi];
                var ppPlan = project((placement.x + 0.5) * TILE_SIZE, (placement.y + 0.5) * TILE_SIZE);
                if (placement.kind === PLAN_WALL) {
                    Draw.color(0.78, 0.82, 0.85, 0.95);
                    Lines.stroke(1.3);
                    Lines.rect(ppPlan.x - 2.3 * symbolScale, ppPlan.y - 2.3 * symbolScale,
                        4.6 * symbolScale, 4.6 * symbolScale);
                } else if (placement.kind === PLAN_DUO) {
                    Draw.color(1, 0.6, 0.15, 1);
                    Fill.circle(ppPlan.x, ppPlan.y, 2.3 * symbolScale);
                } else if (placement.kind === PLAN_SCATTER) {
                    Draw.color(0.4, 0.7, 1, 1);
                    Lines.stroke(1.3);
                    Lines.circle(ppPlan.x, ppPlan.y, 2.8 * symbolScale);
                } else {
                    Draw.color(0.35, 1, 0.55, 1);
                    Lines.stroke(1.3);
                    Lines.circle(ppPlan.x, ppPlan.y, 3.1 * symbolScale);
                    Lines.line(ppPlan.x - 2 * symbolScale, ppPlan.y, ppPlan.x + 2 * symbolScale, ppPlan.y);
                    Lines.line(ppPlan.x, ppPlan.y - 2 * symbolScale, ppPlan.x, ppPlan.y + 2 * symbolScale);
                }
            }
        }

        // Wave spawn points: small hollow red squares.
        for (var s = 0; s < state.spawns.length; s++) {
            var spawnP = project(state.spawns[s].x, state.spawns[s].y);
            Draw.color(1, 0.25, 0.25, 0.85);
            Lines.stroke(1.2);
            Lines.rect(spawnP.x - 3 * symbolScale, spawnP.y - 3 * symbolScale,
                6 * symbolScale, 6 * symbolScale);
        }

        // Places where the defence should be improved (also listed in the text).
        // The colour says what to build there, the red ring marks a critical spot.
        for (var m = 0; m < state.weakPoints.length; m++) {
            var marker = state.weakPoints[m];
            var mp = project(marker.x, marker.y);
            var rgba = markerRgba(marker.kind);
            if (marker.severity >= 0.65) {
                Draw.color(1, 0.25, 0.2, 0.9);
                Lines.stroke(1.2);
                Lines.circle(mp.x, mp.y, 10 * symbolScale);
            }
            Draw.color(rgba[0], rgba[1], rgba[2], rgba[3]);
            Lines.stroke(1.6);
            Lines.circle(mp.x, mp.y, 7 * symbolScale);
            Lines.line(mp.x - 4 * symbolScale, mp.y, mp.x + 4 * symbolScale, mp.y);
            Lines.line(mp.x, mp.y - 4 * symbolScale, mp.x, mp.y + 4 * symbolScale);
        }

        // The closest threat and the core it is approaching.
        if (state.hasThreat) {
            var from = project(state.threatCoreX, state.threatCoreY);
            var to = project(state.threatX, state.threatY);
            Draw.color(1, 0.4, 0.3, 0.65);
            Lines.stroke(1);
            Lines.dashLine(from.x, from.y, to.x, to.y, 12);
        }

        // Every player core in the world, with the weakest one ringed.
        for (var c = 0; c < state.cores.length; c++) {
            var core = state.cores[c];
            var cp = project(core.x, core.y);
            if (core.weakest) {
                Draw.color(core.healthFrac <= 0.35 ? [1, 0.25, 0.2, 1][0] : 1, core.healthFrac <= 0.35 ? 0.25 : 0.85, core.healthFrac <= 0.35 ? 0.2 : 0.25, 1);
                Lines.stroke(1.4);
                Lines.circle(cp.x, cp.y, 7.5 * symbolScale);
            }
            Draw.color(0.35, 0.65, 1, 1);
            Fill.rect(cp.x - 3.5 * symbolScale, cp.y - 3.5 * symbolScale,
                7 * symbolScale, 7 * symbolScale);
            Draw.color(1, 1, 1, 1);
            Fill.rect(cp.x - 1.25 * symbolScale, cp.y - 1.25 * symbolScale,
                2.5 * symbolScale, 2.5 * symbolScale);
        }

        // Enemy units. Positions outside the world rectangle (air spawns use a
        // small margin) are clamped to the map edge but never disappear.
        for (var e = 0; e < state.blips.length; e++) {
            var blip = state.blips[e];
            var bp = project(blip.x, blip.y);
            var color = blip.kind === KIND_BOSS ? [1, 0.13, 0.13, 1]
                : (blip.kind === KIND_FLYING ? [1, 0.7, 0.2, 1] : [1, 0.36, 0.3, 1]);
            Draw.color(color[0], color[1], color[2], color[3]);
            Fill.circle(bp.x, bp.y, (blip.kind === KIND_BOSS ? 3.5 : 2.1) * symbolScale);
            if (blip.kind === KIND_BOSS) {
                Draw.color(color[0], color[1], color[2], 0.55);
                Lines.stroke(1);
                Lines.circle(bp.x, bp.y, 6 * symbolScale);
            }
        }

        // The player himself, drawn last so it remains visible on a busy map.
        if (state.hasPlayer) {
            var pp = project(state.playerX, state.playerY);
            Draw.color(0, 0, 0, 0.75);
            Fill.circle(pp.x, pp.y, 3.4 * symbolScale);
            Draw.color(1, 1, 1, 1);
            Fill.circle(pp.x, pp.y, 2.5 * symbolScale);
        }
    };

    Events.on(ClientLoadEvent, asCons(function () {
        try {
            // hudGroup is only visible while a game is running.
            // Placed at top-right, but clearly to the left of the vanilla minimap.
            Vars.ui.hudGroup.fill(asCons(function (t) {
                t.top().right();
                t.touchable = Touchable.childrenOnly;

                var offset = Scl.scl(MINIMAP_WIDTH + MINIMAP_GAP);
                var panelWidth = Scl.scl(PANEL_WIDTH);
                var radarSize = Scl.scl(RADAR_SIZE);
                try {
                    if (typeof Core !== "undefined" && Core.graphics) {
                        var screenWidth = Core.graphics.getWidth();
                        var screenHeight = Core.graphics.getHeight();
                        offset = Math.min(offset, screenWidth * 0.5);
                        panelWidth = Math.min(panelWidth, screenWidth * PANEL_WIDTH_FRACTION);
                        radarSize = Math.min(radarSize, panelWidth, screenHeight * RADAR_HEIGHT_FRACTION);
                    }
                } catch (ignored) {}
                panelWidth = Math.max(1, panelWidth);
                radarSize = Math.max(1, radarSize);

                t.table(Styles.black8, asCons(function (panel) {
                    panel.margin(6);
                    panel.touchable = Touchable.childrenOnly;
                    panel.defaults().left().top();

                    statusLabel = panel.add("Сканирование...").color(Color.white).left().width(panelWidth).get();
                    try { statusLabel.setWrap(true); } catch (ignored) {}
                    panel.row();

                    radarElement = extend(Packages.arc.scene.Element, {
                        draw: function () {
                            drawRadar(radarState, radarElement);
                        }
                    });
                    try {
                        radarElement.touchable = Touchable.enabled;
                        radarElement.addListener(extend(Packages.arc.scene.event.ClickListener, {
                            clicked: function (event, x, y) {
                                var tile = mapTileAt(x, y, radarElement.getWidth(), radarElement.getHeight(),
                                    radarState.mapWidth, radarState.mapHeight,
                                    radarState.mapOffsetX, radarState.mapOffsetY);
                                if (!tile) return;
                                if (tile.x === selectedTileX && tile.y === selectedTileY) {
                                    selectedTileX = -1;
                                    selectedTileY = -1;
                                } else {
                                    selectedTileX = tile.x;
                                    selectedTileY = tile.y;
                                }
                                refreshRadar();
                            }
                        }));
                    } catch (err) {
                        logError("map selection unavailable", err);
                    }
                    panel.add(radarElement).size(radarSize, radarSize);
                    panel.row();

                    var mapKey = panel.add(legend()).color(Color.lightGray).left().width(panelWidth).get();
                    try { mapKey.setWrap(true); } catch (ignored) {}
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
