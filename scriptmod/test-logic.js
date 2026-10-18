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
    MINIMAP_WIDTH, MINIMAP_GAP, RADAR_RANGE_TILES, HORIZON_SECONDS,
    predictArrival, computeRadar, formatRadarText, etaSeconds, legend
} = require("./scripts/main.js");

const CORE = { x: 100, y: 0, health: 1000, maxHealth: 1000 };
function unit(overrides) {
    return Object.assign(
        {
            x: 0, y: 0, vx: 1, vy: 0, speed: 1, maxSpeed: 1, accel: 0.5, dps: 10,
            dead: false, added: true, enemy: true, flying: false, boss: false, name: "Flare"
        },
        overrides
    );
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
    assert.ok(REFRESH_INTERVAL === 30);
    assert.ok(CLOSE_DISTANCE === 320);
    assert.match(legend(), /ядро/);
});

console.log("\n" + passed + "/" + passed + " checks passed");
