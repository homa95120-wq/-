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
const fillRectCalls = [];
let loadHandler = null;
let rootTable = null;
let statusLabel = null;
let statusCell = null;
let legendLabel = null;
let legendCell = null;
let radarElement = null;
let radarCell = null;
let inGame = true;
let unitEachThrows = false;
const airBlock = { name: "air" };
const occupiedTiles = new Set(["152,98"]);
const waterTiles = new Set(["152,99"]);

function makeLabel() {
    return {
        text: "",
        wrapped: false,
        setText(t) {
            this.text = String(t);
        },
        setWrap(wrapped) {
            this.wrapped = !!wrapped;
        }
    };
}

function makeCell(getter) {
    const cell = {
        widthValue: null,
        sizeValue: null,
        color() { return cell; },
        left() { return cell; },
        right() { return cell; },
        top() { return cell; },
        bottom() { return cell; },
        growX() { return cell; },
        growY() { return cell; },
        width(v) { if (v !== undefined) cell.widthValue = v; return cell; },
        size(w, h) {
            if (w !== undefined && h !== undefined) {
                cell.sizeValue = [w, h];
                if (getter && typeof getter === "object") {
                    getter.width = w;
                    getter.height = h;
                }
            }
            return cell;
        },
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
                const cell = makeCell(label);
                if (item === "Сканирование...") {
                    statusLabel = label;
                    statusCell = cell;
                }
                if (item.includes("Карта мира")) {
                    legendLabel = label;
                    legendCell = cell;
                }
                return cell;
            }
            // A real element (the tactical whole-map view).
            radarElement = item;
            radarCell = makeCell(item);
            return radarCell;
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
    this.listeners = [];
}
Element.prototype.getWidth = function () { return this.width; };
Element.prototype.getHeight = function () { return this.height; };
Element.prototype.addListener = function (listener) { this.listeners.push(listener); return true; };
function ClickListener() {}

const enemyUnit = {
    x: 0, y: 0,
    health: 150, shield: 0,
    vel: { x: 1, y: 0, len() { return 1; } },
    dead: false,
    team: "enemy",
    type: {
        speed: 1, accel: 0.5, flying: false, health: 150, localizedName: "Dagger",
        estimateDps: () => 10
    },
    isFlying: () => false,
    isBoss: () => false,
    isAdded() { return true; }
};

// Fake spawn rules: Daggers scale with the wave, a boss arrives at spawn index 9.
const spawnGroups = [
    {
        type: { health: 150, flying: false, localizedName: "Dagger", estimateDps: () => 10 },
        effect: null,
        getSpawned: (index) => index + 2,
        getShield: () => 0
    },
    {
        type: { health: 20000, flying: false, localizedName: "Scepter", estimateDps: () => 300 },
        effect: "boss-effect",
        getSpawned: (index) => (index === 9 ? 1 : 0),
        getShield: () => 0
    }
];

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
    StatusEffects: { boss: "boss-effect" },
    BlockGroup: { walls: "walls" },
    Vars: {
        headless: false,
        world: {
            width: () => 300,
            height: () => 200,
            tile(x, y) {
                if (x < 0 || y < 0 || x >= 300 || y >= 200) return null;
                const key = x + "," + y;
                return {
                    floor: () => ({ isLiquid: waterTiles.has(key) }),
                    block: () => occupiedTiles.has(key) ? { name: "copper-wall" } : airBlock
                };
            }
        },
        spawner: {
            getSpawns: () => ({
                size: 1,
                get: () => ({ x: 280, y: 100, worldx: () => 2240, worldy: () => 800 })
            })
        },
        state: {
            isGame: () => inGame,
            isCampaign: () => false,
            wave: 3,
            wavetime: 65 * 60,
            enemies: 1,
            stats: { enemyUnitsDestroyed: 12, buildingsBuilt: 20, buildingsDestroyed: 1, unitsCreated: 3 },
            rules: {
                waveTeam: "enemy", waves: true, waveTimer: true, winWave: 12,
                spawns: { size: spawnGroups.length, get: (i) => spawnGroups[i] },
                unitHealth: () => 1, unitDamage: () => 1
            },
            teams: {
                get: () => ({
                    cores: {
                        size: 2,
                        get: (i) => ([
                            { x: 100, y: 0, isValid: () => true, health: 1000, maxHealth: 1000, power: null },
                            { x: 2200, y: 1400, isValid: () => true, health: 900, maxHealth: 1000, power: null }
                        ][i])
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
    Touchable: { disabled: "disabled", childrenOnly: "childrenOnly", enabled: "enabled" },
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
    Fill: { rect: (...args) => { fillRectCalls.push(args); }, circle() {}, tri() {} },
    Lines: { stroke() {}, circle() {}, line() {}, rect() {}, dashLine() {} },
    Packages: {
        arc: { scene: { Element, event: { ClickListener } } },
        mindustry: { content: { Blocks: { air: airBlock } } }
    },
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
    assert.equal(rootTable.touchable, "childrenOnly");
    assert.ok(statusLabel, "status label was not captured");
    assert.ok(radarElement, "the tactical mini map was not created");
    assert.equal(typeof radarElement.draw, "function");
    assert.equal(radarElement.touchable, "enabled");
    assert.equal(radarElement.listeners.length, 1);
});

check("the HUD uses a larger map and a width-limited, wrapped text column", () => {
    const panel = rootTable.lastTable;
    assert.ok(panel, "the panel table was not created");
    assert.equal(panel.touchable, "childrenOnly");
    // 150 (minimap) + 40 (gap) = 190 UI units.
    assert.equal(panel.marginRightValue, 190);
    assert.equal(panel.marginTopValue, 6);
    assert.equal(statusCell.widthValue, 390);
    assert.equal(statusLabel.wrapped, true);
    assert.equal(radarCell.sizeValue[0], 220);
    assert.equal(radarCell.sizeValue[1], 220);
    assert.equal(legendCell.widthValue, 390);
    assert.equal(legendLabel.wrapped, true);
    assert.match(legendLabel.text, /Клик по карте — выбрать участок/);
    assert.match(legendLabel.text, /не строит автоматически/);
});

check("the HUD shrinks automatically on narrow and short screens", () => {
    sandbox.Core.graphics.getWidth = () => 800;
    sandbox.Core.graphics.getHeight = () => 600;
    loadHandler();
    const panel = rootTable.lastTable;
    assert.equal(statusCell.widthValue, 304);
    assert.equal(radarCell.sizeValue[0], 156);
    assert.ok(statusCell.widthValue < 800 * 0.5);
    assert.equal(panel.marginRightValue, 190);

    // Restore the default preview dimensions for the remaining HUD checks.
    sandbox.Core.graphics.getWidth = () => 1920;
    sandbox.Core.graphics.getHeight = () => 1080;
    loadHandler();
});

check("one enemy heading to the core shows a clear count and arrival estimate", () => {
    assert.match(statusLabel.text, /Враги: 1 \(земля 1, авиация 0\)/);
    assert.match(statusLabel.text, /К ядру идут 1 · прибытие \d+–\d+ с/);
});

check("dead and friendly units are not counted", () => {
    // The mock provides three units, only one of them is a living enemy.
    assert.doesNotMatch(statusLabel.text, /Враги: 2/);
});

check("wave status, survival forecast and next wave preview come from the spawn rules", () => {
    assert.match(statusLabel.text, /Волна 3/);
    assert.match(statusLabel.text, /следующая через 1:05/);
    // Next spawn index is state.wave - 1 = 2, displayed as wave 4 with 4 Daggers.
    assert.match(statusLabel.text, /Следующая волна 4: 4 врага .*4×Dagger/);
    assert.match(statusLabel.text, /🏰/);
    assert.match(statusLabel.text, /Что улучшить:.*ТУРЕЛЬ\[\] \[lightgray\]· (В|СВ) \d+,\d+ — нужно \+\d+ урона\/с/);
    // Session counters and non-actionable base statistics stay out of view.
    assert.doesNotMatch(statusLabel.text, /Убито|построено|создано|турелей/);
});

check("clicking a map tile selects a spawn-facing terrain-checked plan and toggles it off", () => {
    const targetX = 150, targetY = 100;
    const view = sandbox.mapViewport(
        radarElement.getWidth(), radarElement.getHeight(),
        sandbox.radarState.mapWidth, sandbox.radarState.mapHeight
    );
    const localX = view.x + ((targetX + 0.5) * 8 - sandbox.radarState.mapOffsetX) * view.scale;
    const localY = view.y + ((targetY + 0.5) * 8 - sandbox.radarState.mapOffsetY) * view.scale;
    const clickListener = radarElement.listeners[0];
    assert.equal(typeof clickListener.clicked, "function");
    clickListener.clicked(null, localX, localY);
    assert.match(statusLabel.text, /План защиты · участок 150,100 · фронт В/);
    assert.match(statusLabel.text, /7 медных стен.*4 Duo.*2 Scatter.*1 Mender.*14 мест/);
    assert.match(statusLabel.text, /доступно 14\/14 · сдвинуто 2 · только рекомендация/);
    assert.equal(sandbox.radarState.defensePlan.placements.length, 14);
    assert.equal(sandbox.radarState.defensePlan.adjusted, 2);
    assert.doesNotThrow(() => radarElement.draw());

    clickListener.clicked(null, localX, localY);
    assert.doesNotMatch(statusLabel.text, /План защиты/);
    assert.equal(sandbox.radarState.defensePlan, null);
});

check("the whole-map mini map draws without throwing", () => {
    const before = drawCalls.length;
    fillRectCalls.length = 0;
    assert.doesNotThrow(() => radarElement.draw());
    assert.ok(drawCalls.length > before, "the mini map did not draw anything");
    // The second core sits at world (2200, 1400) on a 300x200-tile map: it
    // would be far outside the old 120-tile local radar, but the whole-map
    // projection places its larger core marker near the opposite corner of the element.
    assert.ok(fillRectCalls.some((args) => args[0] > 130 && args[1] > 100 && args[2] > 9 && args[3] > 9),
        "the distant core was not drawn inside the whole map: " + JSON.stringify(fillRectCalls));
});

check("panel refreshes only after REFRESH_INTERVAL ticks, then shows inactive outside game", () => {
    sandbox.Time.time = 0;
    rootTable.updateFn();
    assert.match(statusLabel.text, /К ядру идут/);
    inGame = false;
    sandbox.Time.time = 1; // < 30: too early
    rootTable.updateFn();
    assert.match(statusLabel.text, /К ядру идут/);
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
