#!/usr/bin/env node
/*
 * Offline tests for the pure logic in scripts/main.js.
 *
 * Run:  node scriptmod/test-logic.js
 * Exit code 0 = all checks passed.
 */
"use strict";

const assert = require("node:assert/strict");
const {
    REFRESH_INTERVAL, MIN_SPEED, TOWARDS_CORE_DOT, CLOSE_DISTANCE, TILE_SIZE,
    MINIMAP_WIDTH, MINIMAP_GAP, RADAR_RANGE_TILES, DEFENSE_RING_TILES,
    MARKER_GROUND, MARKER_AIR, MARKER_WALL, MARKER_SUPPLY, MARKER_REPAIR,
    HORIZON_SECONDS, WAVE_FORECAST_MAX,
    predictArrival, forecastWaves, computeWeakPoints, computeRadar, formatRadarText, etaSeconds, legend,
    fmtAmount, fmtTime, waveWord, directionName, mapViewport, projectMap
} = require("./scripts/main.js");

const CORE = { x: 100, y: 0, health: 1000, maxHealth: 1000 };
function unit(overrides) {
    return Object.assign(
        {
            x: 0, y: 0, vx: 1, vy: 0, speed: 1, maxSpeed: 1, accel: 0.5, dps: 10, hp: 150,
            dead: false, added: true, enemy: true, flying: false, boss: false, name: "Flare"
        },
        overrides
    );
}

// A future wave as the game glue builds it from SpawnGroup.getSpawned().
function load(overrides) {
    return Object.assign(
        {
            wave: 2, count: 10, groundCount: 10, flyingCount: 0, bossCount: 0,
            groundHp: 1000, flyingHp: 0, groundDps: 100, flyingDps: 0,
            totalHp: 1000, totalDps: 100, bossHp: 0, composition: "10×Dagger"
        },
        overrides
    );
}

function defender(overrides) {
    return Object.assign(
        {
            x: 308, y: 0, dps: 100, range: 160,
            targetsGround: true, targetsAir: true, hasAmmo: true,
            health: 1000, maxHealth: 1000
        },
        overrides
    );
}

function wallLine(count, hpEach) {
    const result = [];
    for (let i = 0; i < count; i++) {
        result.push({ x: 308, y: (i - Math.floor(count / 2)) * 8, health: hpEach, maxHealth: hpEach });
    }
    return result;
}

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log("ok " + passed + " - " + name);
}

check("no enemy units: count 0, no threat, all stable", () => {
    const r = computeRadar({ units: [], cores: [CORE] });
    assert.equal(r.count, 0);
    assert.equal(r.threats, 0);
    assert.equal(r.incoming, 0);
    assert.equal(r.eta, Infinity);
    assert.equal(r.minCoreHp, 100);
    assert.equal(r.emptyTurrets, 0);
    assert.equal(r.damagedBuildings, 0);
    assert.match(formatRadarText(true, r), /Все системы стабильны/);
});

check("stationary enemy is counted but is not a direct threat", () => {
    const r = computeRadar({ units: [unit({ vx: 0, vy: 0, speed: 0 })], cores: [CORE] });
    assert.equal(r.count, 1);
    assert.equal(r.threats, 0);
    assert.ok(MIN_SPEED === 0.05);
    // A stopped unit still gets a forecast, it just needs more time.
    assert.ok(isFinite(r.eta));
    assert.ok(r.eta > 0);
});

check("enemy moving directly away from the core is not a direct threat", () => {
    const r = computeRadar({ units: [unit({ vx: -1 })], cores: [CORE] });
    assert.equal(r.count, 1);
    assert.equal(r.threats, 0);
});

check("enemy moving straight at the core: threat with a realistic ETA range", () => {
    // 600 units away (core is at x = 100), max speed 1 -> travel time plus detour factor.
    const r = computeRadar({ units: [unit({ x: -500, vx: 1, speed: 1 })], cores: [CORE] });
    assert.equal(r.threats, 1);
    assert.ok(isFinite(r.directEta));
    assert.ok(r.directEtaLow <= r.directEta && r.directEta <= r.directEtaHigh);
    // 600 * 1.3 detour / (1 * 0.82 cruise) = 951 ticks = ~15 s
    assert.ok(r.directEta > 900 && r.directEta < 1000, "eta was " + r.directEta);
    assert.match(formatRadarText(true, r), /ПРОРЫВ: 1 к ядру · ETA \d+–\d+с/);
});

check("ETA uses the real speed of the unit type, not its current velocity", () => {
    // A unit that just spawned is barely moving, but it will reach full speed soon.
    const slow = computeRadar({ units: [unit({ x: -500, vx: 0, speed: 0 })], cores: [CORE] });
    const fast = computeRadar({ units: [unit({ x: -500, vx: 1, speed: 1 })], cores: [CORE] });
    // The stopped unit needs more time (it has to finish what it is doing),
    // but it must not be off by orders of magnitude either.
    assert.ok(slow.eta > fast.eta, "stopped unit should be later: " + slow.eta + " vs " + fast.eta);
    assert.ok(slow.eta < fast.eta * 3, "stopped unit estimate is too pessimistic: " + slow.eta);
});

check("a detouring unit is predicted later than a direct one", () => {
    const direct = computeRadar({ units: [unit({ x: -500, vx: 1, speed: 1 })], cores: [CORE] });
    const detour = computeRadar({ units: [unit({ x: -500, vx: -1, speed: 1 })], cores: [CORE] });
    assert.ok(detour.eta > direct.eta);
    assert.match(formatRadarText(true, detour), /Враги в обход · ETA/);
});

check("heading threshold: cosine > 0.25 counts, below does not", () => {
    const at = (deg) => {
        const rad = (deg * Math.PI) / 180;
        return unit({ vx: Math.cos(rad), vy: Math.sin(rad), speed: 1 });
    };
    assert.equal(computeRadar({ units: [at(60)], cores: [CORE] }).threats, 1); // cos = 0.50
    assert.equal(computeRadar({ units: [at(80)], cores: [CORE] }).threats, 0); // cos = 0.17
    assert.ok(TOWARDS_CORE_DOT === 0.25);
});

check("the nearest core is used, not just any core", () => {
    const r = computeRadar({
        units: [unit({ vx: -1 })],
        cores: [CORE, { x: -10, y: 0, health: 100, maxHealth: 100 }]
    });
    assert.equal(r.threats, 1);
    assert.ok(r.directEta < 100, "eta to the close core should be tiny: " + r.directEta);
});

check("with several threats the smallest ETA wins", () => {
    const slow = unit({ x: -500, vx: 1, speed: 1, maxSpeed: 1 });
    const fast = unit({ x: -200, vx: 2, speed: 2, maxSpeed: 2 });
    const r = computeRadar({ units: [slow, fast], cores: [CORE] });
    const slowOnly = computeRadar({ units: [slow], cores: [CORE] });
    const fastOnly = computeRadar({ units: [fast], cores: [CORE] });
    assert.equal(r.count, 2);
    assert.equal(r.threats, 2);
    assert.ok(Math.abs(r.directEta - fastOnly.directEta) < 0.001);
    assert.ok(r.directEta < slowOnly.directEta);
});

check("units without a core are counted but not predicted", () => {
    const r = computeRadar({ units: [unit()], cores: [] });
    assert.equal(r.count, 1);
    assert.equal(r.threats, 0);
    assert.equal(r.eta, Infinity);
    assert.equal(r.blips.length, 1);
});

check("counts breakdown: ground, flying, boss counts and names", () => {
    const r = computeRadar({
        units: [
            unit({ flying: true, name: "Flare" }),
            unit({ flying: true, name: "Horizon" }),
            unit({ flying: false, name: "Dagger" }),
            unit({ flying: false, boss: true, name: "Reign" })
        ],
        cores: [CORE]
    });
    assert.equal(r.count, 4);
    assert.equal(r.flyingCount, 2);
    assert.equal(r.groundCount, 2);
    assert.equal(r.bossCount, 1);
    assert.deepEqual(r.bossNames, ["Reign"]);
    const text = formatRadarText(true, r);
    assert.match(text, /🚜2 🛸2/);
    assert.match(text, /БОСС: Reign/);
});

check("core damage warning triggered when core HP < 99%", () => {
    const r = computeRadar({
        units: [],
        cores: [{ x: 0, y: 0, health: 300, maxHealth: 1000 }] // 30% HP
    });
    assert.equal(r.minCoreHp, 30);
    const text = formatRadarText(true, r);
    assert.match(text, /КРИТИЧЕСКИЙ УРОН ЯДРУ: 30%!/);
});

check("power deficit and blackout diagnostics", () => {
    // Normal deficit with battery
    const r1 = computeRadar({
        units: [],
        cores: [CORE],
        power: { net: -150, batteryPercent: 50 }
    });
    assert.ok(r1.powerDeficit);
    assert.ok(!r1.blackout);
    assert.match(formatRadarText(true, r1), /ДЕФИЦИТ ЭНЕРГИИ: -150\/с \(АКБ: 50%\)/);

    // Complete blackout
    const r2 = computeRadar({
        units: [],
        cores: [CORE],
        power: { net: -50, batteryPercent: 0 }
    });
    assert.ok(r2.blackout);
    assert.match(formatRadarText(true, r2), /СЕТЬ ОБЕСТОЧЕНА: -50\/с/);
});

check("empty turrets and damaged buildings diagnostics", () => {
    const r = computeRadar({
        units: [],
        cores: [CORE],
        emptyTurrets: 2,
        damagedBuildings: 3
    });
    assert.equal(r.emptyTurrets, 2);
    assert.equal(r.damagedBuildings, 3);
    const text = formatRadarText(true, r);
    assert.match(text, /Турели без патронов: 2 шт\./);
    assert.match(text, /Повреждения базы: 3 построек/);
});

check("forecast: incoming units, their damage and the life of the core", () => {
    const r = computeRadar({
        units: [
            unit({ x: -500, vx: 1, speed: 1, dps: 20 }),
            unit({ x: -800, vx: 1, speed: 1, dps: 30 })
        ],
        cores: [CORE],
        defenseDps: 0,
        horizonSeconds: 60
    });
    assert.equal(r.incoming, 2);
    assert.equal(r.incomingDps, 50);
    // 1000 HP / 50 DPS = 20 s until the core falls
    assert.ok(Math.abs(r.coreDeath - 20) < 0.001, "coreDeath was " + r.coreDeath);
    const text = formatRadarText(true, r);
    assert.match(text, /🔮 За 60 с: 2 врага у ядра · урон ~50\/с/);
    assert.match(text, /💥 Ядро \(1000 HP\) падёт через ~20с/);
});

check("forecast: a strong defence keeps the core alive", () => {
    const r = computeRadar({
        units: [unit({ x: -500, vx: 1, speed: 1, dps: 20 })],
        cores: [CORE],
        defenseDps: 100,
        horizonSeconds: 60
    });
    assert.equal(r.incomingDps, 20);
    // The turrets deal more damage than the attackers, so the core survives.
    assert.equal(r.coreDeath, Infinity);
    const text = formatRadarText(true, r);
    assert.match(text, /🛡 Оборона ~100\/с — шанс отбить высокий/);
    assert.doesNotMatch(text, /падёт через/);
});

check("forecast: a weak defence is reported as such", () => {
    const r = computeRadar({
        units: [unit({ x: -500, vx: 1, speed: 1, dps: 200 })],
        cores: [CORE],
        defenseDps: 40
    });
    assert.match(formatRadarText(true, r), /🛡 Оборона ~40\/с — может не удержать/);
    // 1000 HP / (200 - 40) DPS = ~6 s
    assert.ok(Math.abs(r.coreDeath - 1000 / 160) < 0.001, "coreDeath was " + r.coreDeath);
});

check("the mini map gets one blip per enemy unit", () => {
    const r = computeRadar({
        units: [
            unit({ flying: true, name: "Flare" }),
            unit({ boss: true, name: "Reign" }),
            unit({ name: "Dagger" })
        ],
        cores: [CORE]
    });
    assert.equal(r.blips.length, 3);
    assert.deepEqual(r.blips.map((b) => b.kind), [1, 2, 0]);
    assert.ok(r.blips.every((b) => isFinite(b.eta)));
});

check("units are still shown on the mini map without a core", () => {
    const r = computeRadar({ units: [unit()], cores: [] });
    assert.equal(r.blips.length, 1);
    assert.equal(r.eta, Infinity);
    assert.equal(r.incoming, 0);
});

check("outside a game the panel text is the inactive message", () => {
    assert.match(formatRadarText(false, null), /Неактивен вне игры/);
});

check("ETA seconds truncate and never go below 1", () => {
    assert.equal(etaSeconds(0), 1);
    assert.equal(etaSeconds(59), 1);
    assert.equal(etaSeconds(60), 1);
    assert.equal(etaSeconds(119), 1);
    assert.equal(etaSeconds(120), 2);
});

check("bad input does not throw", () => {
    assert.doesNotThrow(() => computeRadar(null));
    assert.doesNotThrow(() => computeRadar({}));
    assert.doesNotThrow(() => computeRadar({ units: [null, {}] }));
    assert.doesNotThrow(() => predictArrival({}, 100, true));
    assert.doesNotThrow(() => formatRadarText(true, null));
});

check("layout constants keep the panel left of the vanilla minimap", () => {
    assert.ok(MINIMAP_WIDTH >= 150);
    assert.ok(MINIMAP_GAP >= 40, "the panel has to keep a clear gap");
    assert.ok(TILE_SIZE === 8);
    assert.ok(RADAR_RANGE_TILES > 0);
    assert.ok(HORIZON_SECONDS === 60);
    assert.ok(WAVE_FORECAST_MAX === 100);
    assert.ok(REFRESH_INTERVAL === 30);
    assert.ok(CLOSE_DISTANCE === 320);
    assert.match(legend(), /ядро/);
});

check("number, time and plural formatting", () => {
    assert.equal(fmtAmount(950), "950");
    assert.equal(fmtAmount(1234), "1.2k");
    assert.equal(fmtAmount(10000), "10k");
    assert.equal(fmtAmount(25400), "25k");
    assert.equal(fmtAmount(1200000), "1.2M");
    assert.equal(fmtTime(5), "0:05");
    assert.equal(fmtTime(65), "1:05");
    assert.equal(fmtTime(600), "10:00");
    assert.equal(waveWord(1), "волну");
    assert.equal(waveWord(3), "волны");
    assert.equal(waveWord(5), "волн");
    assert.equal(waveWord(11), "волн");
    assert.equal(waveWord(21), "волну");
});

check("enemy totals: remaining HP, combined DPS and nearest distance", () => {
    const r = computeRadar({
        units: [unit({ hp: 300, dps: 20 }), unit({ x: 60, hp: 500, dps: 30, flying: true })],
        cores: [CORE]
    });
    assert.equal(r.totalEnemyHp, 800);
    assert.equal(r.totalEnemyDps, 50);
    // The flying unit is 40 world units from the core = 5 tiles.
    assert.equal(r.nearestTiles, 5);
    const text = formatRadarText(true, r);
    assert.match(text, /ΣHP ~800 · урон ~50\/с/);
    assert.match(text, /ближ\. 5 бл\./);
});

check("wave status line: number, win wave and countdown", () => {
    const r = computeRadar({
        units: [], cores: [CORE],
        waves: true, wave: 8, winWave: 30, waveTimeSec: 63, waveInProgress: false
    });
    const text = formatRadarText(true, r);
    assert.match(text, /🌊 Волна 8/);
    assert.match(text, /\/30/);
    assert.match(text, /след\. через 1:03/);
});

check("wave forecast: without any defence the base falls on the next wave", () => {
    const r = computeRadar({
        units: [], cores: [CORE],
        waves: true, wave: 8,
        futureWaves: [load({ wave: 9 }), load({ wave: 10 })]
    });
    assert.ok(r.forecast.available);
    assert.equal(r.forecast.fallWave, 9);
    assert.equal(r.forecast.wavesLeft, 0);
    assert.equal(r.forecast.reason, "no-defense");
    assert.match(formatRadarText(true, r), /🏰 Прогноз: ещё ~0 волн · падёт на ~9-й — обороны нет/);
});

check("wave forecast: an overbuilt defence survives until the win wave", () => {
    const r = computeRadar({
        units: [], cores: [CORE],
        waves: true, wave: 8, winWave: 10,
        defenseDps: 5000, defenseHp: 50000, defenseMaxHp: 50000,
        futureWaves: [load({ wave: 9 }), load({ wave: 10 })]
    });
    assert.equal(r.forecast.fallWave, 0);
    assert.ok(r.forecast.cappedByWin);
    assert.match(formatRadarText(true, r), /🏰 Прогноз: дотянет до победы \(волна 10\)/);
});

check("wave forecast: attrition wears a medium defence down after a few waves", () => {
    const future = [];
    for (let w = 9; w <= 40; w++) future.push(load({ wave: w }));
    const r = computeRadar({
        units: [], cores: [CORE],
        waves: true, wave: 8,
        defenseDps: 100, defenseHp: 2000, defenseMaxHp: 2000,
        futureWaves: future
    });
    assert.equal(r.forecast.reason, "ground");
    assert.ok(r.forecast.wavesLeft >= 3 && r.forecast.wavesLeft <= 12,
        "wavesLeft was " + r.forecast.wavesLeft);
    assert.equal(r.forecast.fallWave, 9 + r.forecast.wavesLeft);
    assert.equal(r.forecast.lastSafeWave, r.forecast.fallWave - 1);
});

check("wave forecast: ground-only turrets cannot stop an air wave (no AA)", () => {
    const airWave = load({
        wave: 9, groundCount: 0, flyingCount: 10,
        groundHp: 0, flyingHp: 700, groundDps: 0, flyingDps: 80,
        totalHp: 700, totalDps: 80, composition: "10×Flare"
    });
    const r = computeRadar({
        units: [], cores: [CORE],
        waves: true, wave: 8,
        defenseGroundDps: 500, defenseAirDps: 0, defenseSharedDps: 0,
        defenseHp: 5000, defenseMaxHp: 5000,
        futureWaves: [airWave]
    });
    assert.equal(r.forecast.reason, "no-air");
    assert.equal(r.forecast.fallWave, 9);
    assert.match(formatRadarText(true, r), /нет ПВО/);
});

check("wave forecast: a boss wave is the killer and is announced in advance", () => {
    const r = computeRadar({
        units: [], cores: [CORE],
        waves: true, wave: 8,
        defenseDps: 200, defenseHp: 3000, defenseMaxHp: 3000,
        futureWaves: [
            load({ wave: 9 }),
            load({ wave: 10 }),
            load({
                wave: 11, count: 1, groundCount: 1, bossCount: 1,
                groundHp: 100000, groundDps: 2000, totalHp: 100000, totalDps: 2000,
                bossHp: 100000, composition: "1×Reign"
            })
        ]
    });
    assert.equal(r.forecast.fallWave, 11);
    assert.equal(r.forecast.reason, "boss");
    assert.equal(r.forecast.nextBossWave, 11);
    assert.equal(r.forecast.nextBossIn, 3);
    const text = formatRadarText(true, r);
    assert.match(text, /убьёт босс\/гардиан/);
    assert.match(text, /💀 Босс\/гардиан на волне 11 \(через 3 волны\)/);
});

check("next wave preview skips empty waves and shows the composition", () => {
    const empty = load({ wave: 9, count: 0, groundCount: 0, groundHp: 0, groundDps: 0, totalHp: 0, totalDps: 0, composition: "" });
    const real = load({ wave: 10, count: 12, groundCount: 9, flyingCount: 3, composition: "6×Dagger, 3×Flare" });
    const r = computeRadar({
        units: [], cores: [CORE],
        waves: true, wave: 8,
        defenseDps: 5000, defenseHp: 50000, defenseMaxHp: 50000,
        futureWaves: [empty, real]
    });
    assert.equal(r.nextWave.wave, 10);
    assert.match(formatRadarText(true, r), /🌊 Волна 10: 12 враг\. \(🚜9 🛸3\) · ΣHP ~1k · урон ~100\/с · 6×Dagger, 3×Flare/);
});

check("wave forecast: the enemies already on the map can be the last wave", () => {
    const r = computeRadar({
        units: [unit({ hp: 100000, dps: 5000 })],
        cores: [CORE],
        waves: true, wave: 8,
        futureWaves: [load({ wave: 9 })]
    });
    assert.equal(r.forecast.fallWave, 8);
    assert.equal(r.forecast.wavesLeft, 0);
    assert.match(formatRadarText(true, r), /🏰 Прогноз: эта волна может стать последней/);
});

check("wave forecast: ally units alone can hold a light wave", () => {
    const fc = forecastWaves({
        futureWaves: [load({ wave: 2, groundHp: 300, totalHp: 300, groundDps: 20, totalDps: 20 })],
        currentWave: 1, coreHealth: 1000,
        defenseHp: 0, defenseMaxHp: 0,
        groundDps: 0, airDps: 0, sharedDps: 0, allyDps: 100
    });
    assert.ok(fc.available);
    assert.equal(fc.fallWave, 0);
    assert.ok(fc.cappedByHorizon);
});

check("wave forecast stays hidden without waves or future data", () => {
    const r = computeRadar({ units: [], cores: [CORE] });
    assert.ok(!r.forecast.available);
    assert.equal(r.nextWave, null);
    assert.doesNotMatch(formatRadarText(true, r), /🏰/);
});

check("base and session statistics lines", () => {
    const r = computeRadar({
        units: [], cores: [CORE],
        buildingCount: 132, turretCount: 11,
        ownCount: 7, ownGround: 5, ownFlying: 2,
        coreItems: 12345,
        stats: { kills: 412, built: 156, destroyed: 4, unitsCreated: 38 },
        power: { net: 180, batteryPercent: 87 }
    });
    const text = formatRadarText(true, r);
    assert.match(text, /🏭 построек 132 · турелей 11 · свои юниты 7 \(🚜5 🛸2\) · ⚡\+180\/с/);
    assert.match(text, /📈 Убито 412 · построено 156 · потеряно 4 · юнитов созд\. 38 · 📦 в ядре 12k/);
});

check("battery autonomy is shown during a power deficit", () => {
    const r = computeRadar({
        units: [], cores: [CORE],
        power: { net: -150, batteryPercent: 50, batterySeconds: 95 }
    });
    assert.match(formatRadarText(true, r), /АКБ на ~1:35/);
});

check("whole-map viewport preserves aspect ratio and keeps every corner visible", () => {
    const view = mapViewport(160, 160, 3200, 1600);
    assert.equal(view.width, 152);
    assert.equal(view.height, 76);
    assert.equal(view.x, 4);
    assert.equal(view.y, 42);
    assert.deepEqual(projectMap(view, 0, 0), { x: 4, y: 42, clamped: false });
    assert.deepEqual(projectMap(view, 3200, 1600), { x: 156, y: 118, clamped: false });
    assert.deepEqual(projectMap(view, -100, 9999), { x: 4, y: 118, clamped: true });
    assert.ok(DEFENSE_RING_TILES === 26);
    assert.equal(directionName(1, 0), "В");
    assert.equal(directionName(-1, 1), "СЗ");
    assert.equal(directionName(0, -1), "Ю");
});

check("weak point: an undefended spawn approach is marked on the defence ring", () => {
    const r = computeRadar({
        units: [], cores: [CORE],
        defenders: [], walls: [],
        spawns: [{ x: 1000, y: 0 }],
        mapWidthTiles: 200, mapHeightTiles: 100,
        futureWaves: [load({ wave: 2 })]
    });
    assert.equal(r.weakPoints.length, 1);
    assert.equal(r.weakPoints[0].kind, MARKER_GROUND);
    assert.equal(r.weakPoints[0].direction, "В");
    // CORE.x = 100, plus 26 tiles * 8 = 308.
    assert.equal(r.weakPoints[0].x, 308);
    assert.equal(r.weakPoints[0].tileX, 39);
    assert.match(formatRadarText(true, r), /🧭 Усилить В \(39,2\): мало урона по земле/);
    assert.match(legend(), /усилить/);
    assert.match(legend(), /спавн/);
});

check("weak point: a covered approach with enough walls needs no marker", () => {
    const points = computeWeakPoints({
        cores: [CORE],
        defenders: [defender({ dps: 1000 })],
        walls: wallLine(8, 600),
        spawns: [{ x: 1000, y: 0 }],
        futureWaves: [load({ wave: 2 })],
        mapWidthTiles: 200, mapHeightTiles: 100
    });
    assert.deepEqual(points, []);
});

check("weak point: strong turrets without a wall line produce a wall marker", () => {
    const points = computeWeakPoints({
        cores: [CORE],
        defenders: [defender({ dps: 1000 })],
        walls: [],
        spawns: [{ x: 1000, y: 0 }],
        futureWaves: [load({ wave: 2 })],
        mapWidthTiles: 200, mapHeightTiles: 100
    });
    assert.equal(points.length, 1);
    assert.equal(points[0].kind, MARKER_WALL);
});

check("weak point: ground-only coverage against an air wave produces an AA marker", () => {
    const airLoad = load({
        groundCount: 0, flyingCount: 10,
        groundHp: 0, flyingHp: 700, groundDps: 0, flyingDps: 80,
        totalHp: 700, totalDps: 80, composition: "10×Flare"
    });
    const r = computeRadar({
        units: [], cores: [CORE],
        defenders: [defender({ dps: 500, targetsGround: true, targetsAir: false })],
        walls: wallLine(8, 600),
        spawns: [{ x: 1000, y: 0 }],
        futureWaves: [airLoad],
        mapWidthTiles: 200, mapHeightTiles: 100
    });
    assert.equal(r.weakPoints[0].kind, MARKER_AIR);
    assert.match(formatRadarText(true, r), /🧭 Усилить В \(39,2\): нет ПВО/);
});

check("weak point: an empty turret is marked at its exact position", () => {
    const points = computeWeakPoints({
        cores: [CORE],
        defenders: [defender({ x: 300, y: 8, dps: 0, hasAmmo: false })],
        walls: [],
        spawns: [{ x: 1000, y: 0 }],
        futureWaves: [load({ wave: 2 })],
        mapWidthTiles: 200, mapHeightTiles: 100
    });
    assert.equal(points[0].kind, MARKER_SUPPLY);
    assert.equal(points[0].x, 300);
    assert.equal(points[0].y, 8);
});

check("weak point: the most damaged front-line building gets a repair marker", () => {
    const damagedWall = { x: 260, y: 80, health: 40, maxHealth: 500 };
    const points = computeWeakPoints({
        cores: [CORE],
        defenders: [defender({ dps: 1000 })],
        walls: wallLine(8, 600).concat([damagedWall]),
        spawns: [{ x: 1000, y: 0 }],
        futureWaves: [load({ wave: 2 })],
        mapWidthTiles: 200, mapHeightTiles: 100
    });
    assert.equal(points.length, 1);
    assert.equal(points[0].kind, MARKER_REPAIR);
    assert.equal(points[0].x, 260);
    assert.equal(points[0].healthPct, 8);
});

console.log("\n" + passed + "/" + passed + " checks passed");
