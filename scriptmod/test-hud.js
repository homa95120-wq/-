#!/usr/bin/env node
/*
 * Mock-harness for the in-game glue in scripts/main.js.
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
let rootTable = null;
let statusLabel = null;
let inGame = true;
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
        right() { return t; },
        bottom() { return t; },
        margin() { return t; },
        marginTop() { return t; },
        marginRight() { return t; },
        marginLeft() { return t; },
        marginBottom() { return t; },
        background() { return t; },
        update(fn) { t.updateFn = fn; return t; },
        table(style, consFn) {
            const sub = makeTable();
            consFn(sub);
            return sub;
        },
        add(text) {
            const label = makeLabel();
            label.text = String(text);
            if (text === "Сканирование...") {
                statusLabel = label;
            }
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
    isFlying: () => false,
    isBoss: () => false,
    type: { localizedName: "Dagger" },
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
            isGame: () => inGame,
            rules: { waveTeam: "enemy" },
            teams: {
                get: () => ({
                    cores: {
                        size: 1,
                        get: () => ({ x: 100, y: 0, isValid: () => true, health: 1000, maxHealth: 1000, power: null })
                    },
                    buildings: {
                        size: 0,
                        get: () => null
                    }
                })
            }
        },
        player: { isAdded: () => true, team: () => "player" },
        ui: {
            hudGroup: {
                fill(consFn) {
                    rootTable = makeTable();
                    consFn(rootTable);
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
    Color: { white: "white", valueOf: (s) => s },
    Styles: { black8: "black8" },
    Touchable: { disabled: "disabled" },
    Log: { err: (msg) => logs.push(String(msg)) },
    Core: { settings: { getInt: () => 140 } }
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
    assert.ok(rootTable, "hudGroup.fill was not called");
    assert.equal(rootTable.touchable, "disabled");
    assert.ok(statusLabel, "status label was not captured");
});

check("one enemy heading to the core shows count, threats and warning", () => {
    assert.match(statusLabel.text, /Враги:.*1/);
    assert.match(statusLabel.text, /ПРОРЫВ: 1 к ядру! ETA: ~1с/);
});

check("panel refreshes only after REFRESH_INTERVAL ticks, then shows inactive outside game", () => {
    sandbox.Time.time = 0;
    rootTable.updateFn();
    assert.match(statusLabel.text, /ПРОРЫВ/);
    inGame = false;
    sandbox.Time.time = 1; // < 30: too early
    rootTable.updateFn();
    assert.match(statusLabel.text, /ПРОРЫВ/);
    sandbox.Time.time = 31; // >= 30: refresh happens
    rootTable.updateFn();
    assert.match(statusLabel.text, /Неактивен вне игры/);
});

check("a failure while reading the game state shows error and logs [campaign-radar]", () => {
    inGame = true;
    unitEachThrows = true;
    sandbox.Time.time = 2000;
    rootTable.updateFn();
    assert.match(statusLabel.text, /Ошибка обновления/);
    assert.ok(logs.some((line) => line.includes("[campaign-radar]")), "no [campaign-radar] log line, got: " + logs.join(" | "));
});

console.log("\n" + passed + "/4 checks passed");
