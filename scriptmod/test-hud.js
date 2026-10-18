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
let autopilotLabel = null;
const buttons = {};
const eventHandlers = new Map();
const triggerHandlers = [];
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
        height() { return cell; },
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
            const fn = typeof style === "function" ? style : consFn;
            fn(sub);
            if (typeof style !== "function") t.lastTable = sub;
            return sub;
        },
        width(v) { if (v !== undefined) t.widthValue = v; return t; },
        button(text, style, listener) {
            buttons[text] = listener;
            return makeCell(null);
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
                if (item.includes("Автопилот")) autopilotLabel = label;
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
            if (eventClass === sandbox.ClientLoadEvent) loadHandler = handler;
            eventHandlers.set(eventClass, handler);
        },
        run(trigger, handler) {
            assert.equal(trigger, sandbox.Trigger.update);
            triggerHandlers.push(handler);
        }
    },
    Trigger: { update: "update-trigger" },
    WorldLoadEvent: class WorldLoadEvent {},
    SectorCaptureEvent: class SectorCaptureEvent {},
    GameOverEvent: class GameOverEvent {},
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
    Log: { err: (msg) => logs.push(String(msg)), info: (msg) => logs.push(String(msg)) },
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
    assert.match(legendLabel.text, /строит только включённый автопилот/);
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

// ------------------------------------------------------------ autopilot glue

check("autopilot: off by default, with ▶ / ⏸ / ■ controls and hooks registered", () => {
    assert.ok(autopilotLabel, "autopilot status label missing");
    assert.match(autopilotLabel.text, /Автопилот: ВЫКЛ/);
    for (const name of ["▶ Автопилот", "⏸ Пауза", "■ Стоп"]) {
        assert.equal(typeof buttons[name], "function", "missing button " + name);
    }
    assert.equal(triggerHandlers.length, 1, "Trigger.update handler not registered");
    assert.ok(eventHandlers.has(sandbox.WorldLoadEvent));
    assert.ok(eventHandlers.has(sandbox.SectorCaptureEvent));
    assert.ok(eventHandlers.has(sandbox.GameOverEvent));
});

check("autopilot: refuses to start outside a campaign and never touches the world", () => {
    unitEachThrows = false;
    buttons["▶ Автопилот"]();
    assert.equal(sandbox.autopilot.state, sandbox.AP_OFF);
    assert.match(autopilotLabel.text, /запуск невозможен: это не кампания/);
});

// A small synthetic Serpulo sector: 3x3 core at tiles 50..52, copper ore at 60..61 x 51..52.
class Drill { constructor(props) { Object.assign(this, props); } }
class ItemTurret { constructor(props) { Object.assign(this, props); } }
class CoreBlock { constructor(props) { Object.assign(this, props); } }
class BuildPlan {
    constructor(x, y, rotation, block, config) {
        this.x = x; this.y = y; this.rotation = rotation; this.block = block; this.config = config; this.progress = 0;
    }
    drawx() { return this.x * 8; }
    drawy() { return this.y * 8; }
}
class Vec2 {
    constructor() { this.x = 0; this.y = 0; }
    set(x, y) { this.x = x; this.y = y; return this; }
    setLength(len) { const l = Math.hypot(this.x, this.y) || 1; this.x *= len / l; this.y *= len / l; return this; }
    angle() { return Math.atan2(this.y, this.x) * 180 / Math.PI; }
}
function makeQueue(items) {
    return {
        items,
        get size() { return items.length; },
        first() { return items[0]; },
        indexOf(value) { return items.indexOf(value); },
        remove(value) { const i = items.indexOf(value); if (i >= 0) items.splice(i, 1); return i >= 0; },
        iterator() { let i = 0; return { hasNext: () => i < items.length, next: () => items[i++] }; }
    };
}
function block(name, props) {
    return Object.assign({
        name, size: 1, requirements: [{ item: copper, amount: 1 }],
        unlockedNow: () => true, isPlaceable: () => true, environmentBuildable: () => true
    }, props);
}
const copper = { id: 0, name: "copper", hardness: 1, localizedName: "Медь" };
const lead = { id: 1, name: "lead", hardness: 1, localizedName: "Свинец" };
const air = sandbox.Packages.mindustry.content.Blocks.air;
const coreBlock = new CoreBlock({ name: "core-shard", size: 3 });
const coreItems = { 0: 400, 1: 100 };
const mainCore = {
    x: 51 * 8, y: 51 * 8, health: 1000, maxHealth: 1000, power: null, team: "player", block: coreBlock,
    isValid: () => true, tileX: () => 51, tileY: () => 51,
    items: { get: (item) => coreItems[item.id] || 0, total: () => 500 },
    dst(other) { return Math.hypot(other.x - this.x, other.y - this.y); }
};
const placed = new Set();
function isCoreTile(x, y) { return x >= 50 && x <= 52 && y >= 50 && y <= 52; }
const unitPlans = [];
const moves = [];
const playerUnit = {
    x: 51 * 8, y: 54 * 8, mineTile: null,
    plans: makeQueue(unitPlans),
    stack: { amount: 0 },
    type: { buildRange: 220, mineRange: 70, mineFloor: true },
    isValid: () => true,
    canBuild: () => true,
    canMine: (item) => item === undefined ? true : item.hardness <= 1,
    buildPlan() { return unitPlans[0] || null; },
    addBuild(plan) { unitPlans.push(plan); },
    validMine(tile) { return Math.hypot(tile.worldx() - this.x, tile.worldy() - this.y) <= 70; },
    speed: () => 3,
    movePref(v) { moves.push([v.x, v.y]); },
    lookAt() {},
    item: () => null,
    maxAccepted: () => 30
};
const calls = { skipWave: 0 };
let netActive = false;

function installSector() {
    Object.assign(sandbox, {
        Drill, ItemTurret, BuildPlan, Vec2,
        Blocks: {
            air,
            conveyor: block("conveyor"),
            copperWall: block("copper-wall", { requirements: [{ item: copper, amount: 6 }] }),
            duo: block("duo", { requirements: [{ item: copper, amount: 35 }] }),
            scatter: block("scatter", { size: 2, requirements: [{ item: copper, amount: 85 }, { item: lead, amount: 45 }] }),
            mechanicalDrill: new Drill(block("mechanical-drill", { size: 2, tier: 2, requirements: [{ item: copper, amount: 12 }] })),
            pneumaticDrill: new Drill(block("pneumatic-drill", { size: 2, tier: 3, unlockedNow: () => false }))
        },
        Build: {
            validPlace(b, team, x, y) {
                const o = -Math.floor((b.size - 1) / 2);
                for (let dx = 0; dx < b.size; dx++) for (let dy = 0; dy < b.size; dy++) {
                    const tx = x + o + dx, ty = y + o + dy;
                    if (tx < 0 || ty < 0 || tx >= 300 || ty >= 200 || isCoreTile(tx, ty) || placed.has(tx + "," + ty)) return false;
                }
                return true;
            }
        },
        Call: { transferInventory() {}, requestItem() {} }
    });
    sandbox.Packages.mindustry.world = { blocks: { storage: { CoreBlock } } };
    sandbox.Vars.world.tile = (x, y) => {
        if (x < 0 || y < 0 || x >= 300 || y >= 200) return null;
        const ore = x >= 60 && x <= 61 && y >= 51 && y <= 52 ? copper : null;
        return {
            x, y,
            build: isCoreTile(x, y) ? mainCore : null,
            block: () => air,
            drop: () => ore,
            floor: () => ({ isLiquid: false }),
            worldx: () => x * 8,
            worldy: () => y * 8
        };
    };
    Object.assign(sandbox.Vars, {
        net: { active: () => netActive },
        control: { input: { isBuilding: false } },
        logic: { skipWave: () => { calls.skipWave++; } },
        content: { items: () => ({ size: 2, get: (i) => [copper, lead][i] }) },
        mineTransferRange: 220, itemTransferRange: 220, tilesize: 8
    });
    sandbox.Vars.spawner.isSpawning = () => false;
    Object.assign(sandbox.Vars.state, {
        isCampaign: () => true,
        isPaused: () => false,
        gameOver: false,
        enemies: 0,
        wave: 2,
        getPlanet: () => ({ name: "serpulo", campaignRules: { difficulty: { name: () => "normal" } } })
    });
    Object.assign(sandbox.Vars.state.rules, {
        waves: true, waveSending: true, waveTimer: false, winWave: 10, attackMode: false,
        buildCostMultiplier: 1, sector: { info: { wasCaptured: false } }
    });
    sandbox.Vars.state.teams.get = () => ({
        cores: { size: 1, get: () => mainCore },
        buildings: { size: 0, get: () => null },
        plans: makeQueue([])
    });
    Object.assign(sandbox.Vars.player, {
        unit: () => playerUnit,
        dead: () => false,
        closestCore: () => mainCore,
        within(target, range) { return Math.hypot(target.x - playerUnit.x, target.y - playerUnit.y) <= range; }
    });
}

function tick(ticks, prediction) {
    sandbox.Time.time += ticks;
    // Isolate the autopilot from the radar refresh unless a test supplies a prediction.
    sandbox.lastPrediction = prediction || null;
    triggerHandlers[0]();
}

check("autopilot: starts in a Normal Serpulo campaign sector", () => {
    installSector();
    buttons["▶ Автопилот"]();
    assert.equal(sandbox.autopilot.state, sandbox.AP_RUNNING, sandbox.autopilot.reason);
    assert.match(autopilotLabel.text, /Автопилот: РАБОТАЕТ/);
});

check("autopilot: places a mechanical drill on copper with a conveyor line into the core", () => {
    tick(100);
    assert.equal(unitPlans.length, 8, "plans: " + JSON.stringify(unitPlans.map((p) => [p.block.name, p.x, p.y, p.rotation])));
    assert.equal(unitPlans[0].block.name, "mechanical-drill");
    assert.deepEqual([unitPlans[0].x, unitPlans[0].y], [60, 51]);
    const line = unitPlans.slice(1);
    assert.ok(line.every((p) => p.block.name === "conveyor" && p.rotation === 2 && p.y === 51));
    assert.deepEqual(line.map((p) => p.x), [59, 58, 57, 56, 55, 54, 53]);
    assert.equal(sandbox.Vars.control.input.isBuilding, true);
    assert.match(sandbox.autopilot.lastAction, /ставлю бур \(Медь\) и конвейер: 7 клеток/);
});

check("autopilot: flies to the queued plan and waits while building", () => {
    moves.length = 0;
    tick(1);
    assert.equal(moves.length, 0, "already within build range: no movement");
    playerUnit.x = 10 * 8; // far west of the drill
    tick(1);
    assert.ok(moves.length > 0, "the unit was not steered");
    assert.ok(moves[0][0] > 0, "the unit should fly east toward the drill");
    tick(100);
    assert.match(sandbox.autopilot.lastAction, /строится: 8/);
});

check("autopilot: a stalled build queue stops with a reason and cancels its own plans", () => {
    tick(60 * 50);
    tick(60 * 50);
    assert.equal(sandbox.autopilot.state, sandbox.AP_NEEDS_HELP);
    assert.match(sandbox.autopilot.reason, /строительство стоит/);
    assert.equal(unitPlans.length, 0);
    assert.match(sandbox.apStatusText(), /НУЖНА ПОМОЩЬ/);
});

check("autopilot: calls manual waves when the base has nothing left to build", () => {
    // The drill is "built": its tiles are occupied now and the line is done.
    for (let x = 53; x <= 61; x++) { placed.add(x + ",51"); placed.add(x + ",52"); }
    coreItems[0] = 45; // below reserve + drill cost: no new drill
    buttons["▶ Автопилот"]();
    assert.equal(sandbox.autopilot.state, sandbox.AP_RUNNING);
    tick(100);
    assert.equal(calls.skipWave, 1, sandbox.autopilot.lastAction);
    assert.match(sandbox.autopilot.lastAction, /вызываю волну/);
    tick(100);
    assert.equal(calls.skipWave, 1, "the cooldown must prevent a second call");
});

check("autopilot: a weak ground approach gets Duo turrets first, facing the spawn", () => {
    coreItems[0] = 400;
    const prediction = {
        weakPoints: [{ kind: sandbox.MARKER_GROUND, tileX: 80, tileY: 51, severity: 0.9 }],
        spawns: [{ x: 150 * 8, y: 51 * 8 }],
        blips: [],
        mapWidthTiles: 300,
        mapHeightTiles: 200,
        forecast: { available: true, fallWave: 0 }
    };
    tick(100, prediction);
    assert.equal(unitPlans.length, 4, sandbox.autopilot.lastAction);
    assert.ok(unitPlans.every((p) => p.block.name === "duo"));
    assert.ok(unitPlans.every((p) => Math.abs(p.x - 80) <= 1 && Math.abs(p.y - 51) <= 1));
    assert.match(sandbox.autopilot.lastAction, /оборона: 4 построек/);
    unitPlans.length = 0;
});

check("autopilot: pause stops actions, stop turns it off", () => {
    buttons["⏸ Пауза"]();
    assert.equal(sandbox.autopilot.state, sandbox.AP_PAUSED);
    const before = calls.skipWave;
    tick(60 * 60);
    assert.equal(calls.skipWave, before);
    buttons["■ Стоп"]();
    assert.equal(sandbox.autopilot.state, sandbox.AP_OFF);
    assert.match(sandbox.apStatusText(), /остановлен игроком/);
});

check("autopilot: a network game stops it immediately", () => {
    buttons["▶ Автопилот"]();
    assert.equal(sandbox.autopilot.state, sandbox.AP_RUNNING);
    netActive = true;
    tick(1);
    assert.equal(sandbox.autopilot.state, sandbox.AP_NEEDS_HELP);
    assert.match(sandbox.autopilot.reason, /сетевая игра/);
    netActive = false;
});

check("autopilot: loading a save never resumes automatically", () => {
    buttons["▶ Автопилот"]();
    eventHandlers.get(sandbox.WorldLoadEvent)();
    assert.equal(sandbox.autopilot.state, sandbox.AP_OFF);
    assert.match(sandbox.autopilot.reason, /загружен мир/);
});

check("autopilot: sector capture finishes the run", () => {
    buttons["▶ Автопилот"]();
    eventHandlers.get(sandbox.SectorCaptureEvent)();
    assert.equal(sandbox.autopilot.state, sandbox.AP_COMPLETE);
    assert.match(sandbox.apStatusText(), /СЕКТОР ЗАХВАЧЕН/);
});

console.log("\n" + passed + "/" + passed + " checks passed");
