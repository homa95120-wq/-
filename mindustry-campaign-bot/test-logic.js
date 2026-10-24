#!/usr/bin/env node
"use strict";

const assert = require("assert");
const bot = require("./scriptmod/scripts/main.js");

let checks = 0;
function ok(cond, msg) {
    checks++;
    assert.ok(cond, `Check #${checks} failed: ${msg}`);
}

// 1. State machine transitions
ok(bot.transition(bot.BOT_OFF, bot.CMD_START) === bot.BOT_RUNNING, "OFF -> RUNNING");
ok(bot.transition(bot.BOT_RUNNING, bot.CMD_PAUSE) === bot.BOT_PAUSED, "RUNNING -> PAUSED");
ok(bot.transition(bot.BOT_PAUSED, bot.CMD_START) === bot.BOT_RUNNING, "PAUSED -> RUNNING");
ok(bot.transition(bot.BOT_RUNNING, bot.CMD_FAIL) === bot.BOT_NEEDS_HELP, "RUNNING -> NEEDS_HELP");
ok(bot.transition(bot.BOT_RUNNING, bot.CMD_VICTORY) === bot.BOT_VICTORY, "RUNNING -> VICTORY");
ok(bot.transition(bot.BOT_VICTORY, bot.CMD_STOP) === bot.BOT_OFF, "VICTORY -> OFF");
ok(bot.stateName(bot.BOT_VICTORY).includes("ПРОЙДЕНА"), "Russian victory label");

// 2. Safety guards
ok(bot.guardReason({ netActive: false, inGame: false }) === null, "Offline Planet Map / Menu allowed");
ok(bot.guardReason({ netActive: true, inGame: false }) !== null, "Multiplayer rejected");
ok(bot.guardReason({ netActive: false, inGame: true, campaign: true, planet: "serpulo", canBuild: true }) === null, "Serpulo campaign allowed");
ok(bot.guardReason({ netActive: false, inGame: true, campaign: true, planet: "erekir", canBuild: true }) !== null, "Erekir rejected");
ok(bot.guardReason({ netActive: false, inGame: true, campaign: false, planet: "serpulo", canBuild: true }) !== null, "Custom skirmish rejected");

// 3. TechTree critical path & research ranker
{
    const nodes = [
        { index: 0, name: "core-shard", parent: -1, unlocked: true },
        { index: 1, name: "conveyor", parent: 0, unlocked: false, allObjectivesMet: true, canAffordAny: true, canFinishNow: true, remainingCost: 5, essentialTier: 3 },
        { index: 2, name: "junction", parent: 1, unlocked: false, allObjectivesMet: true, canAffordAny: true, canFinishNow: true, remainingCost: 10, essentialTier: 3 },
        { index: 3, name: "frozenForest", parent: 0, unlocked: false, isSectorPreset: true, nonResearchObjectivesMet: true, researchDeps: [2] },
        { index: 4, name: "illuminator", parent: 0, unlocked: false, allObjectivesMet: true, canAffordAny: true, canFinishNow: true, remainingCost: 2, essentialTier: 1 }
    ];
    const crit = bot.computeCriticalTechMask(nodes, -1);
    ok(crit[1] && crit[2] && !crit[4], "Ancestor of sector research prerequisite marked critical");
    const ranked = bot.rankResearchNodes(nodes, -1);
    ok(ranked.length === 2 && ranked[0] === 1 && ranked[1] === 4, "Critical conveyor ranked ahead of optional illuminator; locked-parent junction excluded");
}

// 4. Sector selector & post-capture hold
{
    const easy = { id: 86, isPreset: true, onVictoryPath: true, unlocked: true, canLaunchNow: true, difficulty: 2 };
    const hard = { id: 227, isPreset: true, onVictoryPath: true, unlocked: true, canLaunchNow: true, difficulty: 7 };
    const optionalPreset = { id: 3, isPreset: true, onVictoryPath: false, unlocked: true, canLaunchNow: true, difficulty: 1 };
    const invaded = { id: 15, isPreset: true, hasBase: true, underAttack: true, difficulty: 1 };
    const finalTerminal = { id: 93, isPreset: true, onVictoryPath: true, isFinalSector: true, unlocked: true, canLaunchNow: true, difficulty: 10 };

    ok(bot.chooseNextSector([hard, easy, optionalPreset]) === 1, "Victory-path easy preset chosen before hard and optional");
    ok(bot.chooseNextSector([hard, easy, invaded]) === 2, "Invaded base defended before expanding");
    ok(bot.chooseNextSector([finalTerminal, easy]) === 1, "Normal victory-path prerequisite captured before final terminal");
    ok(bot.chooseNextSector([finalTerminal, optionalPreset]) === 0, "Final terminal chosen over optional side-branch");

    ok(bot.shouldHoldCapturedSector(false, true, false, false, 0.3, 30) === true, "Hold sector until launch core is affordable");
    ok(bot.shouldHoldCapturedSector(true, true, false, true, 0.3, 30) === false, "Release hold immediately if another base is under attack");
    ok(bot.shouldHoldCapturedSector(false, true, true, true, 0.90, 30) === false, "Release hold when core is >=88% full");
}

// 5. Drill & conveyor BFS solver (2x2, 3x3, 4x4)
for (const drillSize of [2, 3, 4]) {
    const w = 24, h = 24;
    const cells = new Array(w * h).fill(bot.CELL_FREE);
    const ore = new Array(w * h).fill(-1);
    for (let y = 10; y <= 12; y++) {
        for (let x = 10; x <= 12; x++) cells[y * w + x] = bot.CELL_CORE;
    }
    const off = bot.sizeOffset(drillSize);
    for (let dy = 0; dy < drillSize; dy++) {
        for (let dx = 0; dx < drillSize; dx++) {
            ore[(11 + off + dy) * w + (4 + off + dx)] = 0;
        }
    }
    const site = bot.findDrillSite(w, h, cells, ore, 0, drillSize, 25);
    ok(site !== null && site.oreCount === drillSize * drillSize && site.pathLength > 0, `Drill size ${drillSize}x${drillSize} routed cleanly to core`);
}

// 6. Core-hub [Unloader + Crafter + 2x2 Support] geometry
{
    const w = 25, h = 25;
    const cells = new Array(w * h).fill(bot.CELL_FREE);
    const ore = new Array(w * h).fill(-1);
    for (let y = 11; y <= 13; y++) {
        for (let x = 11; x <= 13; x++) cells[y * w + x] = bot.CELL_CORE;
    }
    const slot = bot.findHubCrafterSlot(w, h, cells, ore, 2, true, 2);
    ok(slot && slot.hasUnloader && slot.hasSupport, "Hub 2x2 crafter + 1x1 unloader + 2x2 liquid support placed around 3x3 core");
    const slot3 = bot.findHubCrafterSlot(w, h, cells, ore, 3, true, 0);
    ok(slot3 && slot3.hasUnloader, "Hub 3x3 surge smelter + 1x1 unloader placed around 3x3 core");
}

// 7. UnitFactory (3x3) -> AdditiveReconstructor (3x3) -> MultiplicativeReconstructor (5x5) chain
{
    const w = 31, h = 31;
    const cells = new Array(w * h).fill(bot.CELL_FREE);
    for (let y = 14; y <= 16; y++) {
        for (let x = 14; x <= 16; x++) cells[y * w + x] = bot.CELL_CORE;
    }
    const chain = bot.findUnitChainSlot(w, h, cells, 15, 15, true, true, true);
    ok(chain && chain.hasUnloader && chain.hasAdditive && chain.hasMultiplicative, "Full T1->T2->T3 reconstructor chain placed");
    const distFA = Math.abs(chain.additiveX - chain.factoryX) + Math.abs(chain.additiveY - chain.factoryY);
    const distAM = Math.abs(chain.multiplicativeX - chain.additiveX) + Math.abs(chain.multiplicativeY - chain.additiveY);
    ok(distFA === 3 && distAM === 4, "Exact center-to-center payload alignment (3->3 = 3 tiles, 3->5 = 4 tiles)");
}

// 8. Fortress template, RTS squad state machine, wave safety, and watchdog
{
    const fort = bot.buildFortressTemplate(40, 40, 0, -1);
    ok(fort.length === 48, "16-slot directional fortress template built");

    ok(bot.decideSquadMode(true, bot.SQUAD_RALLY, 3, 24, 0, 5) === bot.SQUAD_RALLY, "Squad rallies below threshold");
    ok(bot.decideSquadMode(true, bot.SQUAD_RALLY, 12, 24, 0, 5) === bot.SQUAD_ASSAULT, "Squad assaults at threshold");
    ok(bot.decideSquadMode(true, bot.SQUAD_ASSAULT, 6, 24, 0, 5) === bot.SQUAD_ASSAULT, "Hysteresis keeps squad in assault");
    ok(bot.decideSquadMode(true, bot.SQUAD_ASSAULT, 2, 24, 0, 5) === bot.SQUAD_RALLY, "Depleted squad regroups");
    ok(bot.decideSquadMode(false, bot.SQUAD_RALLY, 4, 24, 2, 3) === bot.SQUAD_DEFEND, "Survival squad intercepts base attackers");

    const obs = {
        waves: true, waveSending: true, waveTimer: false,
        wave: 4, winWave: 15, drills: 9,
        defenseDps: 240, defensePoolHp: 2200,
        nextWaveHp: 500, nextWaveDps: 45
    };
    ok(bot.decideSector(obs).action === bot.ACT_CALL_WAVE, "Calls next wave when defense dominates");
    obs.defenseDps = 10;
    ok(bot.decideSector(obs).action !== bot.ACT_CALL_WAVE, "Refuses wave call when defense is weak");

    const wd = bot.createWatchdog();
    ok(!wd.stalled(true, 42, 0), "Watchdog starts timer");
    ok(!wd.stalled(true, 42, 30), "Watchdog waits before timeout");
    ok(wd.stalled(true, 42, 60), "Watchdog detects 55s+ stall");
}

// 9. Full In-Sector AI Simulation (drills -> power -> turret fortress -> industry -> army -> RTS assault)
{
    function seq(arr = []) {
        return {
            _a: arr,
            get size() { return this._a.length; },
            get(i) { return this._a[i]; },
            first() { return this._a[0]; },
            add(v) { this._a.push(v); return this; },
            isEmpty() { return this._a.length === 0; },
            indexOf(v) { return this._a.indexOf(v); },
            remove(v) { const i = this._a.indexOf(v); if (i >= 0) this._a.splice(i, 1); return i >= 0; },
            each(fn) { for (const x of this._a) fn(x); }
        };
    }

    const copper = { id: 0, name: "copper", localizedName: "Copper", hardness: 1, unlocked: () => true, unlock() {}, isOnPlanet: () => true };
    const lead = { id: 1, name: "lead", localizedName: "Lead", hardness: 1, unlocked: () => true, unlock() {}, isOnPlanet: () => true };
    const coal = { id: 2, name: "coal", localizedName: "Coal", hardness: 2, unlocked: () => true, unlock() {}, isOnPlanet: () => true };
    const graphite = { id: 3, name: "graphite", localizedName: "Graphite", hardness: 2, unlocked: () => true, unlock() {}, isOnPlanet: () => true };
    const silicon = { id: 4, name: "silicon", localizedName: "Silicon", hardness: 2, unlocked: () => true, unlock() {}, isOnPlanet: () => true };
    const titanium = { id: 5, name: "titanium", localizedName: "Titanium", hardness: 3, unlocked: () => true, unlock() {}, isOnPlanet: () => true };
    const thorium = { id: 6, name: "thorium", localizedName: "Thorium", hardness: 4, unlocked: () => true, unlock() {}, isOnPlanet: () => true };
    const sporePod = { id: 7, name: "spore-pod", localizedName: "Spore Pod", hardness: 1, unlocked: () => true, unlock() {}, isOnPlanet: () => true };
    const itemsList = [copper, lead, coal, graphite, silicon, titanium, thorium, sporePod];

    const mkBlock = (name, size, extra = {}) => Object.assign({
        name, localizedName: name, size,
        requirements: [{ item: copper, amount: 10 }],
        unlockedNow: () => true, isPlaceable: () => true, environmentBuildable: () => true
    }, extra);

    const Blocks = {
        air: mkBlock("air", 1),
        coreShard: mkBlock("core-shard", 3),
        coreFoundation: mkBlock("core-foundation", 4, { unlockedNow: () => false }),
        coreNucleus: mkBlock("core-nucleus", 5, { unlockedNow: () => false }),
        conveyor: mkBlock("conveyor", 1),
        titaniumConveyor: mkBlock("titanium-conveyor", 1, { unlockedNow: () => false }),
        unloader: mkBlock("unloader", 1),
        mechanicalDrill: mkBlock("mechanical-drill", 2, { tier: 2 }),
        pneumaticDrill: mkBlock("pneumatic-drill", 2, { tier: 3 }),
        laserDrill: mkBlock("laser-drill", 3, { tier: 4, unlockedNow: () => false }),
        blastDrill: mkBlock("blast-drill", 4, { tier: 4, unlockedNow: () => false }),
        waterExtractor: mkBlock("water-extractor", 2),
        powerNode: mkBlock("power-node", 1, { maxNodes: 10, hasPower: true, linkValid: () => true }),
        combustionGenerator: mkBlock("combustion-generator", 1, { outputsPower: true, hasPower: true }),
        steamGenerator: mkBlock("steam-generator", 2, { outputsPower: true, hasPower: true, unlockedNow: () => false }),
        solarPanel: mkBlock("solar-panel", 1, { outputsPower: true, hasPower: true }),
        copperWall: mkBlock("copper-wall", 1, { group: "walls" }),
        titaniumWall: mkBlock("titanium-wall", 1, { group: "walls", unlockedNow: () => false }),
        plastaniumWall: mkBlock("plastanium-wall", 1, { unlockedNow: () => false }),
        thoriumWall: mkBlock("thorium-wall", 1, { unlockedNow: () => false }),
        surgeWall: mkBlock("surge-wall", 1, { unlockedNow: () => false }),
        duo: mkBlock("duo", 1, { targetGround: true, maxAmmo: 30, ammoTypes: { keys: () => ({ toSeq: () => seq([copper]) }) } }),
        scatter: mkBlock("scatter", 2, { maxAmmo: 30, ammoTypes: { keys: () => ({ toSeq: () => seq([lead]) }) } }),
        hail: mkBlock("hail", 1, { unlockedNow: () => false }),
        arc: mkBlock("arc", 1, { unlockedNow: () => false }),
        scorch: mkBlock("scorch", 1, { unlockedNow: () => false }),
        lancer: mkBlock("lancer", 2, { unlockedNow: () => false }),
        salvo: mkBlock("salvo", 2, { unlockedNow: () => false }),
        swarmer: mkBlock("swarmer", 2, { unlockedNow: () => false }),
        mender: mkBlock("mender", 1, { consumesPower: true, hasPower: true }),
        mendProjector: mkBlock("mend-projector", 2, { unlockedNow: () => false }),
        graphitePress: mkBlock("graphite-press", 2),
        siliconSmelter: mkBlock("silicon-smelter", 2, { consumesPower: true, hasPower: true }),
        kiln: mkBlock("kiln", 2, { unlockedNow: () => false }),
        cultivator: mkBlock("cultivator", 2, { unlockedNow: () => false }),
        cryofluidMixer: mkBlock("cryofluid-mixer", 2, { unlockedNow: () => false }),
        plastaniumCompressor: mkBlock("plastanium-compressor", 2, { unlockedNow: () => false }),
        sporePress: mkBlock("spore-press", 2, { unlockedNow: () => false }),
        pyratiteMixer: mkBlock("pyratite-mixer", 2, { unlockedNow: () => false }),
        blastMixer: mkBlock("blast-mixer", 2, { unlockedNow: () => false }),
        phaseWeaver: mkBlock("phase-weaver", 2, { unlockedNow: () => false }),
        surgeSmelter: mkBlock("surge-smelter", 3, { unlockedNow: () => false }),
        airFactory: mkBlock("air-factory", 3, { consumesPower: true, hasPower: true, plans: seq([]) }),
        groundFactory: mkBlock("ground-factory", 3, { consumesPower: true, hasPower: true, plans: seq([]) }),
        navalFactory: mkBlock("naval-factory", 3, { unlockedNow: () => false, plans: seq([]) }),
        additiveReconstructor: mkBlock("additive-reconstructor", 3, { consumesPower: true, hasPower: true }),
        multiplicativeReconstructor: mkBlock("multiplicative-reconstructor", 5, { unlockedNow: () => false })
    };

    const UnitTypes = {
        mono: { name: "mono", canAttack: false, canBoost: false, unlockedNow: () => true, isBanned: () => false },
        poly: { name: "poly", canAttack: false, canBoost: false, unlockedNow: () => true, isBanned: () => false },
        mega: { name: "mega", canAttack: false, canBoost: false, unlockedNow: () => false, isBanned: () => false },
        flare: { name: "flare", canAttack: true, canBoost: false, unlockedNow: () => true, isBanned: () => false },
        horizon: { name: "horizon", canAttack: true, canBoost: false, unlockedNow: () => true, isBanned: () => false },
        zenith: { name: "zenith", canAttack: true, canBoost: false, unlockedNow: () => false, isBanned: () => false },
        dagger: { name: "dagger", canAttack: true, canBoost: false, unlockedNow: () => true, isBanned: () => false },
        nova: { name: "nova", canAttack: true, canBoost: true, unlockedNow: () => false, isBanned: () => false },
        crawler: { name: "crawler", canAttack: true, canBoost: false, unlockedNow: () => false, isBanned: () => false },
        mace: { name: "mace", canAttack: true, canBoost: false, unlockedNow: () => true, isBanned: () => false },
        fortress: { name: "fortress", canAttack: true, canBoost: false, unlockedNow: () => false, isBanned: () => false },
        risso: { name: "risso", canAttack: true, canBoost: false, unlockedNow: () => false, isBanned: () => false },
        retusa: { name: "retusa", canAttack: false, canBoost: false, unlockedNow: () => false, isBanned: () => false },
        oxynoe: { name: "oxynoe", canAttack: false, canBoost: false, unlockedNow: () => false, isBanned: () => false }
    };
    Blocks.airFactory.plans.add({ unit: UnitTypes.flare }).add({ unit: UnitTypes.mono });
    Blocks.groundFactory.plans.add({ unit: UnitTypes.dagger });

    const W = 60, H = 60;
    const grid = new Array(W * H).fill(null);
    const ores = new Array(W * H).fill(null);
    // Patch of copper at (24..25, 30..31), coal at (24..25, 27..28), lead at (35..36, 30..31)
    for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
            ores[(30 + dy) * W + (24 + dx)] = copper;
            ores[(27 + dy) * W + (24 + dx)] = coal;
            ores[(30 + dy) * W + (35 + dx)] = lead;
        }
    }

    const coreStock = { 0: 800, 1: 800, 2: 300, 3: 300, 4: 400, 5: 300 };
    const coreItems = { get: (it) => coreStock[it.id] || 0 };
    const coreBuild = {
        block: Blocks.coreShard, team: 1, x: 30 * 8, y: 30 * 8,
        tileX: () => 30, tileY: () => 30,
        health: 2000, maxHealth: 2000, storageCapacity: 4000,
        items: coreItems, dst(o) { return Math.hypot(this.x - o.x, this.y - o.y); },
        isValid: () => true
    };
    for (let y = 29; y <= 31; y++) for (let x = 29; x <= 31; x++) grid[y * W + x] = coreBuild;

    const teamBuildings = seq([coreBuild]);
    const placeBuilding = (plan) => {
        const off = bot.sizeOffset(plan.block.size);
        const b = {
            block: plan.block, team: 1,
            x: plan.x * 8, y: plan.y * 8,
            pos: () => (plan.x << 16) | plan.y,
            health: 200, isValid: () => true,
            totalAmmo: plan.block.maxAmmo || 0,
            hasAmmo: () => true,
            estimateDps: () => plan.block === Blocks.duo ? 25 : 0,
            range: () => 120,
            within(wx, wy, r) { return Math.hypot(this.x - wx, this.y - wy) <= r; },
            dst(o) { return Math.hypot(this.x - o.x, this.y - o.y); },
            power: plan.block.hasPower ? {
                links: seq([]),
                graph: {
                    producers: seq(plan.block.outputsPower ? [1] : [1]),
                    getPowerBalance: () => plan.block.outputsPower ? 3.5 : -0.2
                }
            } : null
        };
        for (let dy = 0; dy < plan.block.size; dy++) {
            for (let dx = 0; dx < plan.block.size; dx++) {
                const gx = plan.x + off + dx, gy = plan.y + off + dy;
                if (gx >= 0 && gy >= 0 && gx < W && gy < H) grid[gy * W + gx] = b;
            }
        }
        teamBuildings.add(b);
    };

    let commandedUnitsCount = 0;
    const combatUnits = [];
    for (let i = 0; i < 8; i++) {
        combatUnits.push({
            id: i + 1, team: 1, type: UnitTypes.dagger,
            dead: () => false, isCommandable: () => true,
            command: () => ({ command: null, setStance() {} })
        });
    }

    global.Blocks = Blocks;
    global.Items = { copper, lead, coal, graphite, silicon, titanium, thorium, sporePod };
    global.UnitTypes = UnitTypes;
    global.BlockGroup = { walls: "walls" };
    global.UnitCommand = { mineCommand: "mine", assistCommand: "assist", rebuildCommand: "rebuild", repairCommand: "repair" };
    global.UnitStance = { pursueTarget: "pursue", boost: "boost" };
    global.PowerNode = { insulated: () => false };
    global.java = { lang: { Integer: { valueOf: (v) => v } } };
    global.boolf = (fn) => fn;
    global.Vec2 = function (x, y) { this.x = x; this.y = y; this.setLength = () => this; this.angle = () => 0; };
    global.BuildPlan = function (x, y, rot, block, cfg) {
        this.x = x; this.y = y; this.rotation = rot; this.block = block; this.config = cfg; this.progress = 0;
        this.drawx = () => x * 8; this.drawy = () => y * 8;
    };
    global.Build = {
        validPlace(block, team, x, y) {
            const off = bot.sizeOffset(block.size);
            for (let dy = 0; dy < block.size; dy++) {
                for (let dx = 0; dx < block.size; dx++) {
                    const gx = x + off + dx, gy = y + off + dy;
                    if (gx < 1 || gy < 1 || gx >= W - 1 || gy >= H - 1) return false;
                    if (grid[gy * W + gx] !== null) return false;
                }
            }
            return true;
        }
    };
    global.Units = { getCap: () => 24, closestEnemy: () => null };
    global.Groups = { unit: seq(combatUnits) };
    global.Call = {
        tileConfig() {},
        requestItem() {},
        transferInventory() {},
        commandUnits(_p, ids) { commandedUnitsCount = ids.length; }
    };
    global.Planets = { serpulo: { name: "serpulo", sectors: seq([]), techTree: null } };
    global.SectorPresets = {};
    global.Events = { on() {}, run() {}, fire() {} };
    global.Time = { time: 1000 };
    global.Log = { info() {} };
    global.Core = { settings: { getBool: () => false, put() {} }, app: { post(f) { f(); } } };

    const enemyCore = { x: 52 * 8, y: 30 * 8, block: mkBlock("enemy-core", 3), dst: (o) => Math.hypot(52 * 8 - o.x, 30 * 8 - o.y) };
    const playerUnit = {
        x: 30 * 8, y: 30 * 8, plans: seq([]), stack: { amount: 0 },
        type: { buildRange: 220, mineRange: 70, mineFloor: true },
        isValid: () => true, canBuild: () => true, canMine: () => true, validMine: () => true,
        addBuild(pl) { this.plans.add(pl); },
        buildPlan() { return this.plans.first(); }
    };

    global.Vars = {
        headless: false, tilesize: 8, itemTransferRange: 220, mineTransferRange: 220,
        net: { active: () => false, client: () => false },
        content: { items: () => seq(itemsList), item: (id) => itemsList[id], sectors: () => seq([]) },
        world: {
            width: () => W, height: () => H,
            tile(x, y) {
                if (x < 0 || y < 0 || x >= W || y >= H) return null;
                const b = grid[y * W + x];
                const d = ores[y * W + x];
                return {
                    build: b,
                    block: () => b ? b.block : Blocks.air,
                    drop: () => d,
                    floor: () => ({ isLiquid: false }),
                    worldx: () => x * 8, worldy: () => y * 8
                };
            }
        },
        spawner: { getSpawns: () => seq([{ worldx: () => 50 * 8, worldy: () => 30 * 8 }]), isSpawning: () => false },
        control: { input: { isBuilding: false }, checkAutoUnlocks() {} },
        logic: { skipWave() {} },
        player: {
            team: () => 1, closestCore: () => coreBuild, unit: () => playerUnit, dead: () => false,
            within: () => true
        },
        state: {
            isGame: () => true, isCampaign: () => true, isPaused: () => false, gameOver: false,
            getPlanet: () => global.Planets.serpulo,
            getSector: () => ({ id: 21, name: () => "fungalPass", isCaptured: () => false, preset: { difficulty: 2 } }),
            rules: {
                attackMode: true, waves: true, waveSending: false, waveTimer: true,
                winWave: 0, waveTeam: 2, buildCostMultiplier: 1,
                defaultTeam: { core: () => coreBuild },
                spawns: seq([])
            },
            wave: 1, wavetime: 3600, enemies: 0, stats: { buildingsBuilt: 0 },
            teams: {
                get: (t) => t === 1
                    ? { buildings: teamBuildings, plans: seq([]), countType: () => 2 }
                    : { cores: seq([enemyCore]), buildings: seq([enemyCore]) }
            }
        }
    };

    const inst = bot.installMindustryCampaignBot();
    inst.start();
    for (let cycle = 0; cycle < 18; cycle++) {
        global.Time.time += 200;
        inst.thinkInSector(playerUnit);
        while (!playerUnit.plans.isEmpty()) {
            const pl = playerUnit.plans.first();
            playerUnit.plans.remove(pl);
            placeBuilding(pl);
            global.Vars.state.stats.buildingsBuilt++;
        }
    }

    let builtDrills = 0, builtTurrets = 0, builtCrafters = 0, builtFactories = 0;
    teamBuildings.each(b => {
        if (b.block.tier) builtDrills++;
        if (b.block === Blocks.duo || b.block === Blocks.scatter) builtTurrets++;
        if (b.block === Blocks.graphitePress || b.block === Blocks.siliconSmelter) builtCrafters++;
        if (b.block === Blocks.airFactory || b.block === Blocks.groundFactory) builtFactories++;
    });
    ok(builtDrills >= 3, `In-sector AI built drills (${builtDrills})`);
    ok(builtTurrets >= 2, `In-sector AI built fortress turrets (${builtTurrets})`);
    ok(builtCrafters >= 1, `In-sector AI built industrial crafters (${builtCrafters})`);
    ok(builtFactories >= 1, `In-sector AI built unit factories (${builtFactories})`);
    ok(commandedUnitsCount === 8, `RTS commander issued assault orders to ${commandedUnitsCount} combat units`);
}

console.log(`test-logic.js OK: ${checks} assertions passed.`);
