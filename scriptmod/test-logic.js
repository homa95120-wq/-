#!/usr/bin/env node
/*
 * Offline tests for the pure logic in scripts/main.js.
 *
 * Run:  node scriptmod/test-logic.js
 * Exit code 0 = all checks passed.
 */
"use strict";

const assert = require("node:assert/strict");
const { REFRESH_INTERVAL, MIN_SPEED, TOWARDS_CORE_DOT, CLOSE_DISTANCE, computeRadar, formatRadarText, etaSeconds } =
    require("./scripts/main.js");

const CORE = { x: 100, y: 0, health: 1000, maxHealth: 1000 };
function unit(overrides) {
    return Object.assign(
        { x: 0, y: 0, vx: 1, vy: 0, speed: 1, dead: false, added: true, enemy: true, flying: false, boss: false, name: "Flare" },
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
    assert.deepEqual(r, {
        count: 0,
        groundCount: 0,
        flyingCount: 0,
        bossCount: 0,
        bossNames: [],
        threats: 0,
        closeThreats: 0,
        closestEtaTicks: null,
        closestDistTiles: null,
        minCoreHpPercent: 100,
        powerStatus: null,
        emptyTurrets: 0,
        damagedBuildings: 0
    });
    assert.match(formatRadarText(true, r), /Все системы стабильны/);
});

check("stationary enemy is counted but is not an ETA threat", () => {
    const r = computeRadar({ units: [unit({ vx: 0, vy: 0, speed: 0 })], cores: [CORE] });
    assert.equal(r.count, 1);
    assert.equal(r.threats, 0);
    assert.equal(r.closestEtaTicks, null);
    assert.ok(MIN_SPEED === 0.05);
});

check("enemy moving directly away from the core is not a threat", () => {
    const r = computeRadar({ units: [unit({ vx: -1 })], cores: [CORE] });
    assert.equal(r.count, 1);
    assert.equal(r.threats, 0);
});

check("enemy moving straight at the core: threat with ETA = dist / speed", () => {
    // 600 units away, speed 2/tick -> 300 ticks -> 5 s.
    const r = computeRadar({ units: [unit({ x: -500, vx: 2, speed: 2 })], cores: [CORE] });
    assert.equal(r.threats, 1);
    assert.equal(r.closestEtaTicks, 300);
    assert.match(formatRadarText(true, r), /ПРОРЫВ: 1 к ядру! ETA: ~5с/);
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
    const r = computeRadar({ units: [unit({ vx: -1 })], cores: [CORE, { x: -10, y: 0, health: 100, maxHealth: 100 }] });
    assert.equal(r.threats, 1);
    assert.equal(r.closestEtaTicks, 10);
});

check("with several threats the smallest ETA wins", () => {
    const slow = unit({ x: -500, vx: 1, speed: 1 }); // ETA 600
    const fast = unit({ x: -200, vx: 2, speed: 2 }); // ETA 150
    const r = computeRadar({ units: [slow, fast], cores: [CORE] });
    assert.equal(r.count, 2);
    assert.equal(r.threats, 2);
    assert.equal(r.closestEtaTicks, 150);
});

check("dead, removed and friendly units are filtered out", () => {
    const r = computeRadar({
        units: [unit({ dead: true }), unit({ added: false }), unit({ enemy: false }), unit({})],
        cores: [CORE]
    });
    assert.equal(r.count, 1);
    assert.equal(r.threats, 1);
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
    assert.equal(r.minCoreHpPercent, 30);
    const text = formatRadarText(true, r);
    assert.match(text, /КРИТИЧЕСКИЙ УРОН ЯДРУ: 30%!/);
});

check("power deficit and blackout diagnostics", () => {
    // Normal deficit with battery
    const r1 = computeRadar({
        units: [],
        cores: [CORE],
        power: { netBalance: -150, batteryStored: 500, batteryCapacity: 1000 }
    });
    assert.ok(r1.powerStatus.isDeficit);
    assert.ok(!r1.powerStatus.isBlackout);
    assert.match(formatRadarText(true, r1), /ДЕФИЦИТ ЭНЕРГИИ: -150\/с \(АКБ: 50%\)/);

    // Complete blackout
    const r2 = computeRadar({
        units: [],
        cores: [CORE],
        power: { netBalance: -50, batteryStored: 0, batteryCapacity: 1000 }
    });
    assert.ok(r2.powerStatus.isBlackout);
    assert.match(formatRadarText(true, r2), /СЕТЬ ОБЕСТОЧЕНА: -50\/с/);
});

check("empty turrets and damaged buildings diagnostics", () => {
    const r = computeRadar({
        units: [],
        cores: [CORE],
        turrets: [{ hasAmmo: false, totalAmmo: 0 }, { hasAmmo: true, totalAmmo: 10 }, { hasAmmo: false, totalAmmo: 0 }],
        buildings: [
            { health: 20, maxHealth: 100 },
            { health: 10, maxHealth: 100 },
            { health: 40, maxHealth: 100 }
        ]
    });
    assert.equal(r.emptyTurrets, 2);
    assert.equal(r.damagedBuildings, 3);
    const text = formatRadarText(true, r);
    assert.match(text, /Турели без патронов: 2 шт\./);
    assert.match(text, /Повреждения базы: 3 построек/);
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
});

console.log("\n" + passed + "/" + passed + " checks passed");
