#!/usr/bin/env node
/*
 * Offline tests for the pure logic in scripts/main.js.
 *
 * No game, no Java, no mocks of the game API are needed: main.js only
 * touches Vars/Groups/Events when those globals exist, so in Node we can
 * require() it and feed computeRadar() plain objects.
 *
 * Run:  node scriptmod/test-logic.js
 * Exit code 0 = all checks passed.
 */
"use strict";

const assert = require("node:assert/strict");
const { REFRESH_INTERVAL, MIN_SPEED, TOWARDS_CORE_DOT, computeRadar, formatRadarText, etaSeconds } =
    require("./scripts/main.js");

const CORE = { x: 100, y: 0 };
function unit(overrides) {
    // Enemy at the origin, core 100 units to the east, moving east at 1/tick.
    return Object.assign(
        { x: 0, y: 0, vx: 1, vy: 0, speed: 1, dead: false, added: true, enemy: true },
        overrides
    );
}

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log("ok " + passed + " - " + name);
}

check("no enemy units: count 0, no threat, 'No enemy units detected.'", () => {
    const r = computeRadar([], [CORE]);
    assert.deepEqual(r, { count: 0, threats: 0, closestEtaTicks: null });
    assert.match(formatRadarText(true, r), /No enemy units detected\./);
});

check("stationary enemy is counted but is not a threat (MIN_SPEED)", () => {
    const r = computeRadar([unit({ vx: 0, vy: 0, speed: 0 })], [CORE]);
    assert.equal(r.count, 1);
    assert.equal(r.threats, 0);
    assert.equal(r.closestEtaTicks, null);
    assert.ok(MIN_SPEED === 0.05);
});

check("enemy moving directly away from the core is not a threat", () => {
    const r = computeRadar([unit({ vx: -1 })], [CORE]);
    assert.equal(r.count, 1);
    assert.equal(r.threats, 0);
});

check("enemy moving straight at the core: threat with ETA = dist / speed", () => {
    // 600 units away, speed 2/tick -> 300 ticks -> 5 s.
    const r = computeRadar([unit({ x: -500, vx: 2, speed: 2 })], [CORE]);
    assert.equal(r.threats, 1);
    assert.equal(r.closestEtaTicks, 300);
    assert.match(formatRadarText(true, r), /WARNING: likely approach\nNearest core in about 5s/);
});

check("enemy moving perpendicular to the core direction is not a threat", () => {
    const r = computeRadar([unit({ vx: 0, vy: 1 })], [CORE]);
    assert.equal(r.threats, 0);
});

check("heading threshold: cosine > 0.25 counts, below does not", () => {
    const at = (deg) => {
        const rad = (deg * Math.PI) / 180;
        return unit({ vx: Math.cos(rad), vy: Math.sin(rad), speed: 1 });
    };
    assert.equal(computeRadar([at(60)], [CORE]).threats, 1); // cos = 0.50
    assert.equal(computeRadar([at(80)], [CORE]).threats, 0); // cos = 0.17
    assert.ok(TOWARDS_CORE_DOT === 0.25);
});

check("the nearest core is used, not just any core", () => {
    // Core A is 100 east, core B is 10 west. Moving west must count as a
    // threat (towards B) with ETA based on B's distance.
    const r = computeRadar([unit({ vx: -1 })], [CORE, { x: -10, y: 0 }]);
    assert.equal(r.threats, 1);
    assert.equal(r.closestEtaTicks, 10);
});

check("with several threats the smallest ETA wins", () => {
    const slow = unit({ x: -500, vx: 1, speed: 1 }); // ETA 600
    const fast = unit({ x: -200, vx: 2, speed: 2 }); // ETA 150
    const r = computeRadar([slow, fast], [CORE]);
    assert.equal(r.count, 2);
    assert.equal(r.threats, 2);
    assert.equal(r.closestEtaTicks, 150);
});

check("dead, removed and friendly units are filtered out", () => {
    const r = computeRadar(
        [unit({ dead: true }), unit({ added: false }), unit({ enemy: false }), unit({})],
        [CORE]
    );
    assert.equal(r.count, 1);
    assert.equal(r.threats, 1);
});

check("no cores: enemies are counted, nothing can be a threat", () => {
    const r = computeRadar([unit({})], []);
    assert.equal(r.count, 1);
    assert.equal(r.threats, 0);
    assert.equal(r.closestEtaTicks, null);
});

check("outside a campaign the panel text is the inactive message", () => {
    assert.equal(formatRadarText(false, null), "Campaign only\nInactive outside a campaign.");
    assert.match(formatRadarText(true, computeRadar([unit({ vx: -1 })], [CORE])), /No clear core-bound movement detected\./);
});

check("ETA seconds truncate like the Java version and never go below 1", () => {
    assert.equal(etaSeconds(59), 1);
    assert.equal(etaSeconds(60), 1);
    assert.equal(etaSeconds(119), 1);
    assert.equal(etaSeconds(120), 2);
});

check("bad input does not throw; speed is derived from velocity if absent", () => {
    assert.deepEqual(computeRadar(null, null), { count: 0, threats: 0, closestEtaTicks: null });
    const noSpeed = unit({});
    delete noSpeed.speed;
    assert.equal(computeRadar([noSpeed], [CORE]).threats, 1);
    assert.ok(REFRESH_INTERVAL === 30);
});

console.log("\n" + passed + "/13 checks passed");
