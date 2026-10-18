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
    MINIMAP_WIDTH, MINIMAP_GAP, PANEL_WIDTH, RADAR_SIZE, RADAR_HEIGHT_FRACTION, PANEL_WIDTH_FRACTION,
    RADAR_RANGE_TILES, DEFENSE_RING_TILES,
    MARKER_GROUND, MARKER_AIR, MARKER_WALL, MARKER_SUPPLY, MARKER_REPAIR,
    HORIZON_SECONDS, WAVE_FORECAST_MAX,
    predictArrival, forecastWaves, computeWeakPoints, computeRadar, formatRadarText, etaSeconds, legend,
    fmtAmount, fmtTime, waveWord, foeWord, adviceFor, directionName,
    PLAN_WALL, PLAN_DUO, PLAN_SCATTER, PLAN_MENDER,
    defenseFront, defenseLayout, analyzeDefensePlan, formatDefensePlan, mapTileAt,
    mapViewport, projectMap
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
    assert.match(formatRadarText(true, r), /Всё спокойно/);
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
    assert.match(formatRadarText(true, r), /К ядру идут 1 · прибытие \d+–\d+ с/);
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
    assert.match(formatRadarText(true, detour), /⚔ За 60 с:/);
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
    assert.match(text, /земля 2, авиация 2/);
    assert.match(text, /боссы 1/);
});

check("core damage warning triggered when core HP < 99%", () => {
    const r = computeRadar({
        units: [],
        cores: [{ x: 0, y: 0, health: 300, maxHealth: 1000 }] // 30% HP
    });
    assert.equal(r.minCoreHp, 30);
    const text = formatRadarText(true, r);
    assert.match(text, /Ядро: HP 30%/);
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
    assert.match(formatRadarText(true, r1), /Энергия: не хватает 150\/с · батарея 50%/);

    // Complete blackout
    const r2 = computeRadar({
        units: [],
        cores: [CORE],
        power: { net: -50, batteryPercent: 0 }
    });
    assert.ok(r2.blackout);
    assert.match(formatRadarText(true, r2), /⚡ Электросеть отключена/);
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
    assert.match(text, /Турели без патронов: 2/);
    assert.match(text, /Повреждено построек: 3/);
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
    assert.match(text, /К ядру идут 2/);
    assert.match(text, /ядро может пасть через ~20 с/);
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
    assert.match(text, /К ядру идут 1/);
    assert.doesNotMatch(text, /ядро может пасть через ~/);
});

check("forecast: a weak defence is reported as such", () => {
    const r = computeRadar({
        units: [unit({ x: -500, vx: 1, speed: 1, dps: 200 })],
        cores: [CORE],
        defenseDps: 40
    });
    assert.match(formatRadarText(true, r), /К ядру идут 1/);
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

check("responsive layout enlarges the map without letting the panel fill the screen", () => {
    assert.ok(MINIMAP_WIDTH >= 150);
    assert.equal(MINIMAP_GAP, 40);
    assert.equal(PANEL_WIDTH, 390);
    assert.equal(RADAR_SIZE, 220);
    assert.ok(PANEL_WIDTH_FRACTION < 0.5, "the panel must stay under half the screen width");
    assert.ok(RADAR_HEIGHT_FRACTION <= 0.30, "the map must stay compact on short screens");
    assert.ok(TILE_SIZE === 8);
    assert.ok(RADAR_RANGE_TILES > 0);
    assert.ok(HORIZON_SECONDS === 60);
    assert.ok(WAVE_FORECAST_MAX === 100);
    assert.ok(REFRESH_INTERVAL === 30);
    assert.ok(CLOSE_DISTANCE === 320);
    assert.match(legend(), /Карта мира/);
    assert.match(legend(), /улучшить/);
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
    assert.match(text, /Сила: HP ~800 · урон 50\/с/);
    assert.match(text, /ближайший 5 тайлов/);
});

check("wave status line: number, win wave and countdown", () => {
    const r = computeRadar({
        units: [], cores: [CORE],
        waves: true, wave: 8, winWave: 30, waveTimeSec: 63, waveInProgress: false
    });
    const text = formatRadarText(true, r);
    assert.match(text, /Волна 8/);
    assert.match(text, /\/30/);
    assert.match(text, /следующая через 1:03/);
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
    assert.match(formatRadarText(true, r), /🏰 Оборона не выдержит следующую волну · причина: нет обороны/);
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
    assert.match(formatRadarText(true, r), /🏰 Оборона выдержит до победы \(волна 10\)/);
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
    assert.match(text, /риск на ~11-й: босс/);
    assert.match(text, /💀 Босс на волне 11 · через 3 волны/);
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
    assert.match(formatRadarText(true, r), /Следующая волна 10: 12 врагов · 6×Dagger, 3×Flare/);
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
    assert.match(formatRadarText(true, r), /🏰 Эта волна может быть последней/);
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

check("non-actionable base and session counters stay out of the compact panel", () => {
    const r = computeRadar({
        units: [], cores: [CORE],
        buildingCount: 132, turretCount: 11,
        ownCount: 7, ownGround: 5, ownFlying: 2,
        coreItems: 12345,
        stats: { kills: 412, built: 156, destroyed: 4, unitsCreated: 38 },
        power: { net: 180, batteryPercent: 87 }
    });
    const text = formatRadarText(true, r);
    assert.doesNotMatch(text, /турелей 11|🤖7|📦12k/);
    // The session and base counters are noise in a tactical panel and are not shown.
    assert.doesNotMatch(text, /Убито|построено 156/);
});

check("battery autonomy is shown during a power deficit", () => {
    const r = computeRadar({
        units: [], cores: [CORE],
        power: { net: -150, batteryPercent: 50, batterySeconds: 95 }
    });
    assert.match(formatRadarText(true, r), /\(~1:35\)/);
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

check("the compact defense blueprint has seven walls, four Duo, two Scatter and one Mender", () => {
    const expected = { [PLAN_WALL]: 7, [PLAN_DUO]: 4, [PLAN_SCATTER]: 2, [PLAN_MENDER]: 1 };
    for (const vector of [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]]) {
        const layout = defenseLayout(40, 40, vector[0], vector[1]);
        assert.equal(layout.length, 14);
        assert.equal(new Set(layout.map((p) => p.x + "," + p.y)).size, 14, "overlapping cells for " + vector);
        const counts = layout.reduce((out, p) => { out[p.kind] = (out[p.kind] || 0) + 1; return out; }, {});
        assert.deepEqual(counts, expected);
    }
});

check("a site's front follows the nearest spawn, then the nearest visible enemy", () => {
    const spawnFront = defenseFront(20, 20, [{ x: 164, y: 600 }], [{ x: 164, y: 20 }]);
    assert.equal(spawnFront.direction, "С");
    assert.equal(spawnFront.source, "spawn");
    const enemyFront = defenseFront(20, 20, [], [{ x: 164, y: 20 }, { x: 600, y: 164 }]);
    assert.equal(enemyFront.direction, "Ю");
    assert.equal(enemyFront.source, "enemy");
    assert.equal(defenseFront(20, 20, [], []).direction, "С");
});

check("terrain analysis shifts blocked/wet blueprint cells and reports sites that cannot fit", () => {
    const layout = defenseLayout(50, 50, 1, 0);
    const blocked = new Set([layout[0].x + "," + layout[0].y]);
    const wet = new Set([layout[1].x + "," + layout[1].y]);
    const plan = analyzeDefensePlan(50, 50, 1, 0, 100, 100, (x, y) => {
        if (blocked.has(x + "," + y)) return "occupied";
        if (wet.has(x + "," + y)) return "water";
        return null;
    });
    assert.equal(plan.total, 14);
    assert.equal(plan.placements.length, 14);
    assert.equal(plan.adjusted, 2);
    assert.equal(plan.occupied, 0);
    assert.equal(plan.water, 0);
    assert.equal(new Set(plan.placements.map((p) => p.x + "," + p.y)).size, 14);
    assert.match(formatDefensePlan(plan), /доступно 14\/14 · сдвинуто 2/);
    assert.match(formatDefensePlan(plan), /только рекомендация/);

    const packed = analyzeDefensePlan(50, 50, 1, 0, 100, 100, () => "occupied");
    assert.equal(packed.placements.length, 0);
    assert.equal(packed.occupied, 14);
    assert.match(formatDefensePlan(packed), /доступно 0\/14 · занято 14/);

    const edge = analyzeDefensePlan(0, 0, -1, 0, 20, 20, () => null);
    assert.ok(edge.outside > 0, "edge-of-map cells were not counted");
    assert.ok(edge.placements.every((p) => p.x >= 0 && p.y >= 0 && p.x < 20 && p.y < 20));
});

check("map clicks invert the aspect-preserving projection and ignore letterbox margins", () => {
    const width = 2400, height = 1600;
    const view = mapViewport(220, 220, width, height);
    const localX = view.x + 1204 * view.scale;
    const localY = view.y + 804 * view.scale;
    assert.deepEqual(mapTileAt(localX, localY, 220, 220, width, height, 0, 0), { x: 150, y: 100 });
    assert.equal(mapTileAt(view.x - 1, localY, 220, 220, width, height, 0, 0), null);
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
    assert.match(formatRadarText(true, r), /Что улучшить:.*ТУРЕЛЬ.*В 39,2 — нужно \+65 урона\/с/);
    assert.match(legend(), /улучшить/);
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
    assert.match(formatRadarText(true, r), /ПВО\[\] \[lightgray\]· В 39,2 — нет защиты от авиации/);
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

check("the advice list says what to build and how much is missing", () => {
    const r = computeRadar({
        units: [], cores: [CORE],
        defenders: [], walls: [],
        spawns: [{ x: 1000, y: 0 }],
        mapWidthTiles: 200, mapHeightTiles: 100,
        futureWaves: [load({ wave: 2 })]
    });
    const text = formatRadarText(true, r);
    assert.match(text, /🎯 Что улучшить:/);
    // The place (direction + tile) and the missing amount are both there.
    assert.match(text, /ТУРЕЛЬ\[\] \[lightgray\]· В 39,2 — нужно \+65 урона\/с/);
    assert.ok(r.weakPoints[0].needGround > 0, "the marker does not know what is missing");
});

check("the advice list names the anti-air gap and the wall gap", () => {
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
    assert.match(formatRadarText(true, r), /ПВО\[\] \[lightgray\]· В 39,2 — нет защиты от авиации/);
    assert.ok(r.weakPoints[0].needAir > 0, "the air deficit is unknown");

    const walled = computeRadar({
        units: [], cores: [CORE],
        defenders: [defender({ dps: 1000 })],
        walls: [],
        spawns: [{ x: 1000, y: 0 }],
        futureWaves: [load({ wave: 2 })],
        mapWidthTiles: 200, mapHeightTiles: 100
    });
    assert.match(formatRadarText(true, walled), /СТЕНЫ\[\] \[lightgray\]· В 39,2 — нужно \+600 HP стен/);
});

check("a busy game still fits into a short panel", () => {
    const r = computeRadar({
        units: [
            unit({ x: -500, vx: 1, speed: 1, dps: 200, hp: 3000 }),
            unit({ x: 900, vx: -1, speed: 1, dps: 60, flying: true })
        ],
        cores: [CORE],
        defenseDps: 40,
        emptyTurrets: 2,
        damagedBuildings: 4,
        turretCount: 6,
        ownCount: 3,
        coreItems: 3500,
        waves: true, wave: 8, winWave: 30, waveTimeSec: 75,
        futureWaves: [load({ wave: 9, count: 20, groundCount: 12, flyingCount: 8, totalHp: 5000, totalDps: 400 })],
        spawns: [{ x: 1000, y: 0 }],
        mapWidthTiles: 200, mapHeightTiles: 100,
        power: { net: -150, batteryPercent: 50 }
    });
    const lines = formatRadarText(true, r).split("\n");
    assert.ok(lines.length <= 10, "the panel has " + lines.length + " lines:\n" + lines.join("\n"));
});

check("plural of the enemy word", () => {
    assert.equal(foeWord(1), "враг");
    assert.equal(foeWord(2), "врага");
    assert.equal(foeWord(5), "врагов");
    assert.equal(foeWord(11), "врагов");
    assert.equal(foeWord(21), "враг");
});

// ---------------------------------------------------------------- autopilot (pure logic)
// Same scenarios as src/test/java/campaignradar/AutopilotLogicCheck.java.
{
    const ap = require("./scripts/main.js");
    const okGuard = (o) => Object.assign({ inGame: true, campaign: true, planet: "serpulo", difficulty: "normal" }, o);

    check("autopilot guard: only a local Normal Serpulo campaign", () => {
        assert.equal(ap.autopilotGuardReason(okGuard()), null);
        assert.match(ap.autopilotGuardReason(okGuard({ netActive: true })), /сетевая/);
        assert.match(ap.autopilotGuardReason(okGuard({ planet: "erekir" })), /Serpulo/);
        assert.match(ap.autopilotGuardReason(okGuard({ difficulty: "hard" })), /Normal/);
        assert.match(ap.autopilotGuardReason(okGuard({ campaign: false })), /кампания/);
        assert.match(ap.autopilotGuardReason({}), /игры/);
        assert.notEqual(ap.autopilotGuardReason(okGuard({ canBuild: false })), null);
    });

    check("autopilot state machine", () => {
        const t = ap.autopilotTransition;
        assert.equal(t(ap.AP_OFF, ap.AP_CMD_START), ap.AP_RUNNING);
        assert.equal(t(ap.AP_RUNNING, ap.AP_CMD_PAUSE), ap.AP_PAUSED);
        assert.equal(t(ap.AP_PAUSED, ap.AP_CMD_START), ap.AP_RUNNING);
        assert.equal(t(ap.AP_OFF, ap.AP_CMD_PAUSE), ap.AP_OFF);
        assert.equal(t(ap.AP_NEEDS_HELP, ap.AP_CMD_STOP), ap.AP_OFF);
        assert.equal(t(ap.AP_RUNNING, ap.AP_CMD_FAIL), ap.AP_NEEDS_HELP);
        assert.equal(t(ap.AP_OFF, ap.AP_CMD_FAIL), ap.AP_OFF);
        assert.equal(t(ap.AP_RUNNING, ap.AP_CMD_CAPTURED), ap.AP_COMPLETE);
    });

    check("autopilot goal: survival sectors only in stage 1", () => {
        assert.equal(ap.autopilotGoalProblem({ waves: true, winWave: 15 }), null);
        assert.match(ap.autopilotGoalProblem({ waves: true, winWave: 15, attackMode: true }), /базу/);
        assert.match(ap.autopilotGoalProblem({ waves: true, winWave: 0 }), /волны победы/);
        assert.equal(ap.autopilotGoalProblem({ captured: true }), null);
    });

    const calm = (o) => ap.autopilotObservation(Object.assign({
        waves: true, waveSending: true, waveTimer: true, wave: 3, winWave: 15, waveTimeSec: 90, minePossible: true
    }, o));

    check("autopilot decide: priority order", () => {
        const d = (o) => ap.autopilotDecide(calm(o)).action;
        assert.equal(d({ captured: true }), ap.AP_DONE);
        assert.equal(d({ playerAlive: false }), ap.AP_WAIT);
        assert.equal(d({ buildQueue: 3, rearmTargets: 1 }), ap.AP_WAIT);
        assert.equal(d({ buildQueue: 3, rearmInProgress: true }), ap.AP_REARM);
        assert.equal(d({ rearmTargets: 1, defenseSlots: 4 }), ap.AP_REARM);
        assert.equal(d({ defenseSlots: 4, rebuildSlots: 2 }), ap.AP_DEFEND);
        assert.equal(d({ rebuildSlots: 2, drillPossible: true }), ap.AP_REBUILD);
        assert.equal(d({ drillPossible: true }), ap.AP_DRILL);
        assert.equal(d({ drillPossible: true, drills: ap.AP_MAX_DRILLS }), ap.AP_MINE);
        assert.equal(d({ minePossible: false }), ap.AP_WAIT);
    });

    check("autopilot waves: manual and timed calls follow the forecast", () => {
        const p = (o) => ap.autopilotWaveCallProblem(calm(o));
        const manual = { waveTimer: false, waveTimeSec: -1, forecastAvailable: true };
        assert.equal(p(Object.assign({ forecastFallWave: 0 }, manual)), null);
        assert.equal(ap.autopilotDecide(calm(Object.assign({ forecastFallWave: 0 }, manual))).action, ap.AP_CALL_WAVE);
        assert.notEqual(p(Object.assign({ forecastFallWave: 4 }, manual)), null);
        assert.equal(p(Object.assign({ forecastFallWave: 5 }, manual)), null);
        assert.match(p(Object.assign({ forecastFallWave: 5, enemies: 2 }, manual)), /бой/);
        assert.notEqual(p({ forecastAvailable: true, forecastFallWave: 6 }), null);
        assert.equal(p({ forecastAvailable: true, forecastFallWave: 7 }), null);
        assert.match(p({ forecastAvailable: true, forecastFallWave: 7, waveTimeSec: 10 }), /скоро/);
        assert.notEqual(p({ forecastAvailable: false }), null);
        assert.match(p({ wave: 15 }), /захвата/);
        assert.match(p({ waveTimer: false, coreHealthFrac: 0.5 }), /ядро/);
        assert.match(p({ waveTimer: false, secondsSinceWaveCall: 5 }), /пауза/);
    });

    check("autopilot watchdog: stalls and repeated failures", () => {
        const w = new ap.AutopilotWatchdog();
        assert.equal(w.stalled(true, 10, 0), false);
        assert.equal(w.stalled(true, 10, ap.AP_STALL_SECONDS - 1), false);
        assert.equal(w.stalled(true, 10, ap.AP_STALL_SECONDS + 1), true);
        assert.equal(w.stalled(true, 11, ap.AP_STALL_SECONDS + 2), false);
        assert.equal(w.stalled(false, 11, 500), false);
        let tripped = false;
        for (let i = 0; i < ap.AP_MAX_FAILURES; i++) tripped = w.fail("x");
        assert.equal(tripped, true);
        w.success();
        assert.equal(w.fail("x"), false);
    });

    check("autopilot economy: ranking, hand-mining and size offsets", () => {
        assert.deepEqual(ap.autopilotRankItems(["copper", "lead", "sand", "coal"], [500, 100, 0, 0], [true, true, true, false]), [2, 1, 0]);
        assert.ok(ap.autopilotIsMineWorthy("copper") && !ap.autopilotIsMineWorthy("sand"));
        assert.equal(ap.autopilotSizeOffset(2), 0);
        assert.equal(ap.autopilotSizeOffset(3), -1);
    });

    // 12x6 window, core at x 0..2, y 1..3; copper ore 2x2 at x 8..9, y 2..3.
    const W = 12, H = 6;
    const grid = () => {
        const cells = new Array(W * H).fill(ap.AP_CELL_FREE);
        const ore = new Array(W * H).fill(-1);
        for (let y = 1; y <= 3; y++) for (let x = 0; x <= 2; x++) cells[y * W + x] = ap.AP_CELL_CORE;
        for (let y = 2; y <= 3; y++) for (let x = 8; x <= 9; x++) ore[y * W + x] = 0;
        return { cells, ore };
    };

    check("autopilot drill: ore patch, shortest straight conveyor into the core", () => {
        const { cells, ore } = grid();
        const site = ap.autopilotFindDrillSite(W, H, cells, ore, 0, 2, ap.AP_MAX_CONVEYOR_PATH);
        assert.deepEqual([site.x, site.y, site.ore, site.pathLength], [8, 2, 4, 5]);
        const xs = [], rots = [];
        for (let s = 0; s < site.pathLength; s++) { xs.push(site.path[s * 3]); rots.push(site.path[s * 3 + 2]); }
        assert.deepEqual(xs, [7, 6, 5, 4, 3]);
        assert.ok(rots.every((r) => r === 2));
        assert.equal(ap.autopilotFindDrillSite(W, H, cells, ore, 1, 2, ap.AP_MAX_CONVEYOR_PATH), null);
        assert.equal(ap.autopilotFindDrillSite(W, H, cells, ore, 0, 2, 3), null);
    });

    check("autopilot drill: obstacles, adjacency to the core and mixed ore", () => {
        const { cells, ore } = grid();
        const blocked = cells.slice();
        for (let y = 0; y < H; y++) blocked[y * W + 5] = ap.AP_CELL_BLOCKED;
        assert.equal(ap.autopilotFindDrillSite(W, H, blocked, ore, 0, 2, ap.AP_MAX_CONVEYOR_PATH), null);
        blocked[5] = ap.AP_CELL_FREE;
        const around = ap.autopilotFindDrillSite(W, H, blocked, ore, 0, 2, ap.AP_MAX_CONVEYOR_PATH);
        assert.ok(around && around.pathLength > 5);
        for (let s = 0; s < around.pathLength; s++) {
            const x = around.path[s * 3], y = around.path[s * 3 + 1], r = around.path[s * 3 + 2];
            assert.equal(blocked[y * W + x], ap.AP_CELL_FREE);
            assert.ok(!(x >= 8 && x <= 9 && y >= 2 && y <= 3));
            if (s + 1 < around.pathLength) {
                const nx = x + (r === 0 ? 1 : r === 2 ? -1 : 0), ny = y + (r === 1 ? 1 : r === 3 ? -1 : 0);
                assert.deepEqual([nx, ny], [around.path[(s + 1) * 3], around.path[(s + 1) * 3 + 1]]);
            }
        }
        const adjacent = new Array(W * H).fill(-1);
        for (let y = 1; y <= 2; y++) for (let x = 3; x <= 4; x++) adjacent[y * W + x] = 0;
        const touching = ap.autopilotFindDrillSite(W, H, cells, adjacent, 0, 2, ap.AP_MAX_CONVEYOR_PATH);
        assert.equal(touching.pathLength, 0);
        assert.equal(touching.path.length, 0);
        const mixed = ore.slice();
        mixed[2 * W + 8] = 1;
        mixed[3 * W + 8] = 1;
        assert.equal(ap.autopilotFindDrillSite(W, H, cells, mixed, 0, 2, ap.AP_MAX_CONVEYOR_PATH), null);
        assert.equal(ap.autopilotNearestOreCell(W, H, cells, ore, 0, 1, 2, 10), 2 * W + 8);
        assert.equal(ap.autopilotNearestOreCell(W, H, cells, ore, 0, 1, 2, 5), -1);
    });

    check("autopilot defence order and status text", () => {
        const kinds = [PLAN_WALL, PLAN_DUO, PLAN_SCATTER, PLAN_MENDER, PLAN_DUO];
        assert.deepEqual(ap.autopilotDefenseOrder(MARKER_GROUND, kinds), [1, 4, 0, 2]);
        assert.equal(ap.autopilotDefenseOrder(MARKER_AIR, kinds)[0], 2);
        assert.equal(ap.autopilotDefenseOrder(MARKER_WALL, kinds)[0], 0);
        assert.deepEqual(ap.autopilotDefenseOrder(MARKER_SUPPLY, kinds), []);
        assert.match(ap.autopilotFormatStatus(ap.AP_OFF, "", ""), /ВЫКЛ/);
        assert.match(ap.autopilotFormatStatus(ap.AP_RUNNING, "", "ставлю бур"), /ставлю бур/);
        assert.match(ap.autopilotFormatStatus(ap.AP_NEEDS_HELP, "нет ядра", "x"), /нет ядра/);
    });
}

console.log("\n" + passed + "/" + passed + " checks passed");
