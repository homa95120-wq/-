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
const drawCalls = [];
let loadHandler = null;
let rootTable = null;
let statusLabel = null;
let radarElement = null;
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

function makeCell(getter) {
    const cell = {
        color() { return cell; },
        left() { return cell; },
        right() { return cell; },
        top() { return cell; },
        bottom() { return cell; },
        growX() { return cell; },
        growY() { return cell; },
        size() { return cell; },
        pad() { return cell; },
        row() { return cell; },
        get() { return getter; }
    };
    return cell;
}

function makeTable() {
    const t = {
        touchable: null,
        updateFn: null,
        marginRightValue: null,
        marginTopValue: null,
        top() { return t; },
        left() { return t; },
        right() { return t; },
        bottom() { return t; },
        margin() { return t; },
        marginTop(v) { if (v !== undefined) t.marginTopValue = v; return t; },
        marginRight(v) { if (v !== undefined) t.marginRightValue = v; return t; },
        marginLeft() { return t; },
        marginBottom() { return t; },
        background() { return t; },
        defaults() { return makeCell(null); },
        update(fn) { t.updateFn = fn; return t; },
        table(style, consFn) {
            const sub = makeTable();
            consFn(sub);
            t.lastTable = sub;
            return sub;
        },
        add(item) {
            if (typeof item === "string") {
                const label = makeLabel();
                label.text = item;
                if (item === "Сканирование...") statusLabel = label;
                return makeCell(label);
            }
            // A real element (the tactical mini map).
            radarElement = item;
            return makeCell(item);
        },
        row() { return t; }
    };
    return t;
}

// Stand-in for arc.scene.Element, used by the extend() mock below.
function Element() {
    this.x = 0;
    this.y = 0;
    this.width = 160;
    this.height = 160;
    this.touchable = null;
}
Element.prototype.getWidth = function () { return this.width; };
Element.prototype.getHeight = function () { return this.height; };

const enemyUnit = {
    x: 0, y: 0,
    vel: { x: 1, y: 0, len() { return 1; } },
    dead: false,
    team: "enemy",
    type: {
        speed: 1, accel: 0.5, flying: false, localizedName: "Dagger",
        estimateDps: () => 10
    },
    isFlying: () => false,
    isBoss: () => false,
    isAdded() { return true; }
};

const deadUnit = Object.assign({}, enemyUnit, { dead: true, x: 50 });
const friendlyUnit = Object.assign({}, enemyUnit, { team: "player", x: 70 });

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
        player: { isAdded: () => true, team: () => "player", unit: () => ({ x: 90, y: 10 }) },
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
                [enemyUnit, deadUnit, friendlyUnit].forEach(consFn);
            }
        }
    },
    Time: { time: 0 },
    Color: { white: "white", lightGray: "lightGray", valueOf: (s) => s },
    Styles: { black8: "black8" },
    Touchable: { disabled: "disabled" },
    Log: { err: (msg) => logs.push(String(msg)) },
    Core: {
        settings: { getInt: () => 140 },
        graphics: { getWidth: () => 1920, getHeight: () => 1080 }
    },
    Scl: { scl: (v) => v },
    Mathf: {
        dst: (x, y) => Math.sqrt(x * x + y * y),
        atan2: (y, x) => Math.atan2(y, x),
        cos: (v) => Math.cos(v),
        sin: (v) => Math.sin(v)
    },
    Draw: { color: (...args) => { drawCalls.push(args); } },
    Fill: { rect() {}, circle() {}, tri() {} },
    Lines: { stroke() {}, circle() {}, line() {}, rect() {}, dashLine() {} },
    Packages: { arc: { scene: { Element } } },
    // Mirrors the extend() helper of the game's global.js (JavaAdapter based).
    extend(Base, def) {
        const instance = new Base();
        for (const key in def) instance[key] = def[key];
        return instance;
    }
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
    assert.ok(radarElement, "the tactical mini map was not created");
    assert.equal(typeof radarElement.draw, "function");
});

check("the panel keeps a clear gap to the left of the vanilla minimap", () => {
    const panel = rootTable.lastTable;
    assert.ok(panel, "the panel table was not created");
    // 150 (minimap) + 70 (gap) = 220 UI units, scaled by the UI scale.
    assert.equal(panel.marginRightValue, 220);
    assert.equal(panel.marginTopValue, 6);
});

check("one enemy heading to the core shows count, threats and warning", () => {
    assert.match(statusLabel.text, /Враги:.*1/);
    assert.match(statusLabel.text, /ПРОРЫВ: 1 к ядру · ETA \d+–\d+с/);
});

check("dead and friendly units are not counted", () => {
    // The mock provides three units, only one of them is a living enemy.
    assert.doesNotMatch(statusLabel.text, /Враги:.*2/);
});

check("the mini map draws without throwing", () => {
    const before = drawCalls.length;
    assert.doesNotThrow(() => radarElement.draw());
    assert.ok(drawCalls.length > before, "the mini map did not draw anything");
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

console.log("\n" + passed + "/" + passed + " checks passed");
