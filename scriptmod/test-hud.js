#!/usr/bin/env node
/*
 * Mock-harness for the in-game glue in scripts/main.js.
 *
 * There is no Mindustry in this environment, so this loads main.js in a
 * Node `vm` context whose globals imitate the ones Mindustry's global.js
 * provides (Vars, Groups, Events, ClientLoadEvent, ...), fires the
 * ClientLoadEvent handler, and checks what the HUD label ends up showing.
 * It catches typos and wrong property names in the glue that the pure
 * logic tests cannot see; it does NOT prove Rhino-specific behaviour
 * (SAM conversion, Java field access) - that still needs a real game run.
 *
 * Run:  node scriptmod/test-hud.js
 */
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const logs = [];
let loadHandler = null;
let table = null;
let statusLabel = null;
let inCampaign = true;
let unitEachThrows = false;

function makeLabel() {
    return {
        text: "",
        setText(t) {
            this.text = String(t);
        }
    };
}

function makeTable() {
    const t = {
        touchable: null,
        updateFn: null,
        top() { return t; },
        left() { return t; },
        margin() { return t; },
        background() { return t; },
        update(fn) { t.updateFn = fn; return t; },
        add(text) {
            const label = text === "Scanning..." ? (statusLabel = makeLabel()) : makeLabel();
            label.text = String(text);
            const cell = {
                color() { return cell; },
                left() { return cell; },
                row() { return cell; },
                get() { return label; }
            };
            return cell;
        }
    };
    return t;
}

const enemyUnit = {
    x: 0, y: 0,
    vel: { x: 1, y: 0, len() { return 1; } },
    dead: false,
    team: "enemy",
    isAdded() { return true; }
};

const sandbox = {
    console,
    cons: (f) => f,
    ClientLoadEvent: class ClientLoadEvent {},
    Events: {
        on(eventClass, handler) {
            assert.equal(eventClass, sandbox.ClientLoadEvent);
            loadHandler = handler;
        }
    },
    Vars: {
        headless: false,
        state: {
            isCampaign: () => inCampaign,
            rules: { waveTeam: "enemy" },
            teams: {
                get: () => ({ cores: { size: 1, get: () => ({ x: 100, y: 0 }) } })
            }
        },
        player: { isAdded: () => true, team: () => "player" },
        ui: {
            hudGroup: {
                fill(consFn) {
                    table = makeTable();
                    consFn(table);
                }
            }
        }
    },
    Groups: {
        unit: {
            each(consFn) {
                if (unitEachThrows) throw new Error("boom from Groups.unit.each");
                [enemyUnit].forEach(consFn);
            }
        }
    },
    Time: { time: 0 },
    Color: { valueOf: (s) => s },
    Styles: { black8: "black8" },
    Touchable: { disabled: "disabled" },
    Log: { err: (msg) => logs.push(String(msg)) }
};
sandbox.globalThis = sandbox;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "scripts", "main.js"), "utf8"), sandbox, {
    filename: "main.js"
});

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log("ok " + passed + " - " + name);
}

check("ClientLoadEvent handler is registered and builds the panel", () => {
    assert.equal(typeof loadHandler, "function");
    loadHandler();
    assert.ok(table, "hudGroup.fill was not called");
    assert.equal(table.touchable, "disabled");
    assert.ok(statusLabel, "status label was not captured");
});

check("one enemy heading to the core shows count, threats and warning", () => {
    assert.match(statusLabel.text, /Enemy units: 1/);
    assert.match(statusLabel.text, /Moving toward cores: 1/);
    assert.match(statusLabel.text, /WARNING: likely approach/);
    // 100 units at speed 1 -> 100 ticks -> truncated to 1 s (Java parity).
    assert.match(statusLabel.text, /Nearest core in about 1s/);
});

check("panel refreshes only after REFRESH_INTERVAL ticks, then shows inactive outside campaign", () => {
    // First update runs immediately (nextRefresh starts at 0, as in the
    // Java version) and schedules the next refresh 30 ticks later.
    sandbox.Time.time = 0;
    table.updateFn();
    assert.match(statusLabel.text, /WARNING/);
    inCampaign = false;
    sandbox.Time.time = 1; // < 30: too early, text must not change yet
    table.updateFn();
    assert.match(statusLabel.text, /WARNING/);
    sandbox.Time.time = 31; // >= 30: refresh happens
    table.updateFn();
    assert.match(statusLabel.text, /Campaign only/);
});

check("a failure while reading the game state shows 'Radar error' and logs [campaign-radar]", () => {
    inCampaign = true;
    unitEachThrows = true;
    sandbox.Time.time = 2000;
    table.updateFn();
    assert.match(statusLabel.text, /Radar error/);
    assert.ok(logs.some((line) => line.includes("[campaign-radar]")), "no [campaign-radar] log line, got: " + logs.join(" | "));
});

console.log("\n" + passed + "/4 checks passed");
