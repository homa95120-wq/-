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


// =====================================================================
// v2.0 PRO LOGIC: terrain / chokepoint / kill-box / ammo bus / flank / Gemma brain
// =====================================================================
{
    // ---- synthetic cave map: core room (x<=34) -- canyon (35..60, height canyonH) -- spawn hall (x>=61)
    function makeCave(canyonH) {
        const W = 100, H = 60, passable = new Array(W * H).fill(0);
        const open = (x, y) => {
            if (x >= 4 && x <= 34 && y >= 14 && y <= 46) return true;
            if (x >= 35 && x <= 60 && Math.abs(y - 30) <= Math.floor(canyonH / 2)) return true;
            if (x >= 61 && x <= 95 && y >= 8 && y <= 52) return true;
            return false;
        };
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) passable[y * W + x] = open(x, y) ? 1 : 0;
        return { W, H, passable };
    }
    function floodReach(W, H, blocked, sx, sy, tx, ty) {
        const seen = new Uint8Array(W * H), q = [sy * W + sx];
        seen[q[0]] = 1;
        for (let h = 0; h < q.length; h++) {
            const c = q[h], x = c % W, y = (c - x) / W;
            for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                const nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
                const ni = ny * W + nx;
                if (seen[ni] || blocked[ni]) continue;
                if (dx && dy && (blocked[y * W + nx] || blocked[ny * W + x])) continue; // no corner cutting
                seen[ni] = 1; q.push(ni);
            }
        }
        return !!seen[ty * W + tx];
    }

    for (const canyonH of [7, 11]) {
        const { W, H, passable } = makeCave(canyonH);
        const dist = bot.distanceToWall(W, H, passable);
        ok(dist[30 * W + 45] === Math.ceil(canyonH / 2), `distance transform in a ${canyonH}-wide canyon`);
        const path = bot.findGroundPath(W, H, passable, dist, 90, 30, 10, 30);
        ok(path.found && path.xs.length >= 80, "ground path spawn -> core found");
        ok(path.xs[0] === 90 && path.xs[path.xs.length - 1] === 10, "path runs spawn -> core");
        const chokes = bot.findChokepoints(W, H, passable, dist, [path], 10, 30);
        ok(chokes.length === 1, "one chokepoint found");
        const ch = chokes[0];
        ok(ch.width === canyonH && ch.dist >= 15 && ch.dist <= 45, `choke width ${ch.width} at ${ch.dist.toFixed(1)}`);
        ok(ch.axis === 1 && ch.fwd === 1, "wall line vertical, enemy on the +x side");
        ok(bot.compassFlank(ch.cx - 10, ch.cy - 30) === "east", "choke flank = east");

        const kb = bot.buildKillBox(W, H, passable, ch, { frontSize: 1, mainSize: 1, supportSize: 1, wantForce: true });
        const blocked = new Uint8Array(W * H);
        for (let i = 0; i < W * H; i++) blocked[i] = passable[i] ? 0 : 1;
        let wallCells = 0, depthWindow = 0, depthFlank = 0;
        const depthAt = new Map();
        for (let s = 0; s < kb.slots.length; s += 5) {
            const x = kb.slots[s], y = kb.slots[s + 1], size = kb.slots[s + 2], role = kb.slots[s + 3];
            ok(x >= 0 && y >= 0 && x < W && y < H && passable[y * W + x] === 1, "slot origin on open ground");
            if (role === bot.ROLE_WALL || role === bot.ROLE_WALL_WINDOW) {
                const off = Math.floor((size - 1) / 2);
                for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
                    const cx = x - off + dx, cy = y - off + dy;
                    if (cx >= 35 && passable[cy * W + cx]) {
                        blocked[cy * W + cx] = 1; wallCells++;
                        depthAt.set(cy, (depthAt.get(cy) || 0) + 1);
                    }
                }
            }
        }
        const cyLo = 30 - Math.floor(canyonH / 2), cyHi = 30 + Math.floor(canyonH / 2);
        depthWindow = depthAt.get(Math.floor((kb.wLo + kb.wHi) / 2)) || 0;
        depthFlank = Math.max(depthAt.get(cyLo) || 0, depthAt.get(cyHi) || 0);
        ok(!floodReach(W, H, blocked, 55, 30, 20, 30), "walls close the canyon rock-to-rock");
        ok(wallCells >= canyonH * 2, "wall cells placed");
        ok(depthFlank > depthWindow && depthWindow >= 1, `flanks (${depthFlank}) thicker than the bait window (${depthWindow})`);
        ok(kb.spineLen >= 3 && kb.spineLen % 2 === 1, "ammo spine has odd length >= 3");
        ok(kb.winW >= 2 && kb.wLo >= ch.lo && kb.wHi <= ch.hi, "bait window inside the pass");
        const cross = bot.killBoxCrossingP(W, H, passable, ch, kb.slots, 350);
        ok(cross !== null && cross >= kb.wLo - 1 && cross <= kb.wHi + 1, `cheapest crossing (${cross}) funnels into the window ${kb.wLo}..${kb.wHi}`);
        ok(bot.groundPathCostThroughWall(2000) > bot.groundPathCostThroughWall(300), "thicker HP -> higher flowfield cost");
        // roles present
        const roles = new Set();
        for (let s = 0; s < kb.slots.length; s += 5) roles.add(kb.slots[s + 3]);
        ok(roles.has(bot.ROLE_GROUND_TURRET) && roles.has(bot.ROLE_FRONT_TURRET) && roles.has(bot.ROLE_SUPPORT) && roles.has(bot.ROLE_WALL_INNER), "kill-box has strike, front, support and inner-wall roles");
        // no two slots overlap
        const occ = new Set();
        let overlap = false;
        for (let s = 0; s < kb.slots.length; s += 5) {
            const x = kb.slots[s], y = kb.slots[s + 1], size = kb.slots[s + 2], off = Math.floor((size - 1) / 2);
            for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) {
                const key = (x - off + dx) + "," + (y - off + dy);
                if (occ.has(key)) overlap = true;
                occ.add(key);
            }
        }
        ok(!overlap, "kill-box slots never overlap");
    }

    // ---- time-sliced terrain scan (never blocks): grid + DT + A* + chokes + resources
    {
        const { W, H, passable } = makeCave(9);
        const scan = bot.createTerrainScan({
            w: W, h: H, passable: (x, y) => !!passable[y * W + x],
            feature: (x, y) => (passable[y * W + x] && x < 20 && y < 20 ? "ore:copper" : (x === 50 && y === 30 ? "water" : "")),
            coreX: 10, coreY: 30, sources: [90, 30]
        });
        let steps = 0;
        while (!scan.step(800, 400) && steps < 5000) steps++;
        ok(scan.done && steps > 5, `terrain scan finished in ${steps} slices`);
        ok(scan.chokes.length === 1 && scan.chokes[0].width === 9, "scan found the canyon choke");
        ok(scan.counts["ore:copper"] > 50 && scan.counts["water"] === 1, "scan inventoried resources");
        const rec = bot.summarizeRecon(scan, null, 10, 30);
        ok(rec.indexOf("copper") >= 0 && rec.indexOf("проходы: 1") >= 0, "Russian recon summary");
    }

    // ---- AA corridor on the air vector + generator cover
    {
        const aa = bot.planAaCorridor(50, 50, 150, 50, [60, 60, 61, 62, 20, 80], { count: 4 });
        ok(aa.length >= 12 && aa.length % 3 === 0, "AA corridor slots");
        ok(aa[0] > 50 && aa[0] < 80, "AA placed on the spawn->core vector");
        let cover = 0;
        for (let i = 2; i < aa.length; i += 3) if (aa[i] === 1) cover++;
        ok(cover >= 1, "generator cover slot");
    }

    // ---- ammo choice
    {
        const stock = { copper: 800, graphite: 400, silicon: 50, pyratite: 0, thorium: 300, metaglass: 0, lead: 500 };
        ok(bot.chooseAmmoItem("duo", stock, null, "") === "graphite", "silicon too low -> graphite for Duo");
        ok(bot.chooseAmmoItem("salvo", stock, null, "") === "thorium", "Salvo prefers thorium when stocked");
        ok(bot.chooseAmmoItem("duo", stock, null, "copper") === "copper", "brain preference honoured");
        ok(bot.chooseAmmoItem("duo", stock, { graphite: false }, "") === "copper", "locked item not used");
        ok(bot.chooseAmmoItem("scatter", { lead: 10 }, null, "") === null, "no stock -> null");
        ok(bot.chooseBusAmmo(["duo", "hail", "salvo"], stock, null, "") === "graphite", "shared bus ammo covers all turrets");
        ok(bot.pickTurretForAmmo(["ripple", "hail", "duo"], "graphite", { ripple: true, hail: true, duo: true }) === "ripple", "ladder pick");
        ok(bot.pickTurretForAmmo(["ripple", "hail", "duo"], "copper", { ripple: true, hail: true, duo: true }) === "duo", "copper only fits Duo");
        ok(bot.statusSynergy("cryofluid", "blast-compound").bonus > bot.statusSynergy("water", "graphite").bonus, "status synergy ranking");
    }

    // ---- ammo bus: Unloader -> BFS conveyor -> Router/Junction spine
    {
        const W = 40, H = 30, cells = new Array(W * H).fill(bot.CELL_FREE);
        for (let y = 13; y <= 15; y++) for (let x = 13; x <= 15; x++) cells[y * W + x] = bot.CELL_CORE;
        const spine = []; for (let x = 8; x <= 14; x++) spine.push(x, 22);
        const unl = { x: 14, y: 16 };
        const bus = bot.planAmmoBus(W, H, cells, unl, spine);
        ok(bus.ok && bus.feederLength >= 1, "ammo bus planned");
        ok(bus.pieces[2] === bot.BUS_UNLOADER, "bus starts with Unloader");
        // follow the conveyors from the unloader to the spine start
        const at = {}; for (let i = 0; i < bus.pieces.length; i += 4) at[bus.pieces[i] + "," + bus.pieces[i + 1]] = { type: bus.pieces[i + 2], rot: bus.pieces[i + 3] };
        let cx = unl.x, cy = unl.y, reached = false;
        const start = at["14,17"] || at["13,16"] || at["15,16"];
        ok(!!start, "unloader has an adjacent feeder");
        let cur = null; for (const k of ["14,17", "13,16", "15,16"]) if (at[k]) cur = k;
        for (let g = 0; g < 60 && cur; g++) {
            const [px, py] = cur.split(",").map(Number), p = at[cur];
            if (p.type === bot.BUS_ROUTER) { reached = (px === 8 && py === 22); break; }
            const nx = px + bot.DX[p.rot], ny = py + bot.DY[p.rot];
            cur = at[nx + "," + ny] ? nx + "," + ny : null;
        }
        ok(reached, "feeder conveyors lead from the Unloader to the first Router");
        const types = []; for (let i = 0; i < bus.pieces.length; i += 4) if (bus.pieces[i + 1] === 22) types.push(bus.pieces[i + 2]);
        ok(types[0] === bot.BUS_ROUTER && types[1] === bot.BUS_JUNCTION && types[2] === bot.BUS_ROUTER, "spine alternates Router/Junction");
        const keys = Object.keys(at); ok(keys.length === bus.pieces.length / 4, "no piece placed twice");
        // blocked spine -> truncated to an odd length; fully blocked -> refusal
        const c2 = cells.slice(); c2[22 * W + 12] = bot.CELL_BLOCKED;
        const b2 = bot.planAmmoBus(W, H, c2, unl, spine);
        ok(b2.ok && ((b2.pieces.filter((_, i) => i % 4 === 1).filter(v => v === 22)).length) === 3, "spine truncated before the obstacle (odd length)");
        const c3 = cells.slice(); c3[22 * W + 8] = bot.CELL_BLOCKED;
        ok(!bot.planAmmoBus(W, H, c3, unl, spine).ok, "blocked spine start -> refusal");
        // drill-fed variant
        const ore = new Array(W * H).fill(-1);
        for (let y = 24; y <= 27; y++) for (let x = 8; x <= 11; x++) ore[y * W + x] = 1;
        const feed = bot.planAmmoDrillFeed(W, H, cells, ore, 1, 2, 8, 22, 12);
        ok(feed && feed.oreCount >= 2, "graphite-style drill feed found for the spine");
        ok(bot.rectTouchesCell(10, 10, 2, 12, 10) && !bot.rectTouchesCell(10, 10, 2, 12, 13), "rectTouchesCell");
    }

    // ---- Thorium reactor guard / site
    {
        const rectsOverlapT = (ax, ay, as, bx, by, bs) => ax < bx + bs && bx < ax + as && ay < by + bs && by < ay + as;
        const base = { reactorUnlocked: true, mixerBuilt: true, mixerCryoFrac: 0.9, waterOk: true, titaniumStock: 400, thoriumStock: 300, siteDistFromCore: 20 };
        ok(bot.reactorGuard(base) === null, "reactor allowed with guaranteed cryofluid");
        ok(bot.reactorGuard(Object.assign({}, base, { mixerBuilt: false })) !== null, "no mixer -> no reactor");
        ok(bot.reactorGuard(Object.assign({}, base, { waterOk: false })) !== null, "no water -> no reactor");
        ok(bot.reactorGuard(Object.assign({}, base, { mixerCryoFrac: 0.1 })) !== null, "empty cryo tank -> no reactor");
        ok(bot.reactorGuard(Object.assign({}, base, { siteDistFromCore: 5 })) !== null, "too close to the core");
        ok(bot.reactorShouldCutFuel(0.6, 0.1) && !bot.reactorShouldCutFuel(0.6, 0.8), "emergency fuel cut only when coolant is low");
        const W = 60, H = 60, cells = new Array(W * H).fill(bot.CELL_FREE);
        const site = bot.findReactorSite(W, H, cells, 30, 30, 1, 0, 14, 26);
        ok(site && site.dist >= 14 && site.dist <= 26, "reactor site far from the core");
        ok((site.rx - 30) < 0.35 * site.dist, "reactor not toward the enemy side");
        ok(!rectsOverlapT(site.rx - 1, site.ry - 1, 3, site.mx, site.my, 2), "mixer does not overlap the reactor");
        ok(!rectsOverlapT(site.mx, site.my, 2, site.ex, site.ey, 2), "water extractor does not overlap the mixer");
    }

    // ---- wave schedule (default-wave-gen-like table)
    {
        const groups = [
            { type: "dagger", begin: 0, end: 10, amount: 2, scaling: 2, hp: 130, dps: 20 },
            { type: "flare", flying: true, begin: 12, end: 30, spacing: 2, amount: 3, hp: 70, dps: 9 },
            { type: "fortress", begin: 20, spacing: 5, amount: 1, boss: true, hp: 900, dps: 30, shield: 100 }
        ];
        const r = bot.analyzeWaveSchedule(groups, 10, 5, 80);
        ok(r.firstAirWave === 13, "first air wave detected");
        ok(r.bossWave === 21 && r.bossType === "fortress" && !r.bossFlying, "boss wave/type detected");
        ok(r.firstGroundWave === 1, "first ground wave");
        ok(r.forecast.length === 5 && r.forecast[0].wave === 11, "forecast covers the next 5 waves");
        ok(r.forecast[2].airCount === 3 && r.forecast[2].types.indexOf("3xflare") >= 0, "forecast counts air groups");
        ok(bot.waveGroupCount(groups[0], 6) === 5, "wave group scaling");
    }

    // ---- core zoning: Nucleus reserve + conveyor lanes
    {
        const W = 50, H = 50, z = bot.computeCoreZones(W, H, 25, 25, 3, 12);
        ok(z[25 * W + 25 + 2] === bot.ZONE_NUCLEUS && z[(25 + 5) * W + 25] === bot.ZONE_LANE && z[(25 + 3) * W + 25] === bot.ZONE_NONE, "nucleus reserve and lanes");
        ok(!bot.zoneAllows(bot.ZONE_NUCLEUS, bot.KIND_OTHER) && bot.zoneAllows(bot.ZONE_LANE, bot.KIND_CONVEYOR) && !bot.zoneAllows(bot.ZONE_LANE, bot.KIND_OTHER), "zone rules");
        ok(bot.zoneAllows(bot.ZONE_NONE, bot.KIND_OTHER), "free zone allows anything");
    }

    // ---- after-action heat map
    {
        const heat = bot.createDamageHeat();
        for (let i = 0; i < 30; i++) heat.record(80, 52, 40, false);
        heat.record(10, 10, 20, true);
        ok(bot.pickBreachReinforcement(createHeatDummy(), 50, 50, 600) === null, "no meaningful damage -> no reinforcement");
        const br = bot.pickBreachReinforcement(heat, 50, 50, 600);
        ok(br && br.flank === "east" && !br.air && br.amount >= 1200, "hot spot east of the core -> reinforce east");
        ok(heat.airShare() < 0.1, "air share tracked");
        heat.reset(); ok(heat.total === 0, "heat reset");
        function createHeatDummy() { return bot.createDamageHeat(); }
    }

    // ---- danger map + flank route
    {
        const W = 120, H = 80, passable = new Array(W * H).fill(1);
        const danger = bot.buildDangerGrid(W, H, [{ x: 60, y: 40, r: 18, weight: 1 }]);
        const direct = bot.straightPathDanger(W, H, danger, 10, 40, 110, 40);
        ok(direct > 0, "straight route crosses the turret range");
        const route = bot.planFlankRoute(W, H, danger, passable, 10, 40, 110, 40, {});
        ok(route.useFlank && route.waypoints.length >= 4, "flank route chosen");
        ok(route.danger < route.directDanger * 0.5 && route.length < route.directLength * 1.6, "flank is safer and not absurdly long");
        const last = route.waypoints.length;
        ok(route.waypoints[last - 2] === 110 && route.waypoints[last - 1] === 40, "route ends at the goal");
        const safe = bot.planFlankRoute(W, H, bot.buildDangerGrid(W, H, []), passable, 10, 40, 110, 40, {});
        ok(!safe.useFlank && safe.waypoints.length === 2, "no threats -> go straight");
        // walls force the route; air route ignores passable
        const rock = passable.slice(); for (let y = 0; y < 60; y++) rock[y * W + 60] = 0;
        const around = bot.planFlankRoute(W, H, bot.buildDangerGrid(W, H, []), rock, 10, 30, 110, 30, {});
        ok(around.waypoints.length >= 2, "route search survives walls");
    }

    // ---- assault priorities + wounded retreat
    {
        const cands = [
            { kind: "turret", x: 100, y: 50, powered: true }, { kind: "power-node", x: 110, y: 60 },
            { kind: "generator", x: 120, y: 70 }, { kind: "core", x: 130, y: 50 }, { kind: "ammo-feed", x: 105, y: 52 }
        ];
        ok(cands[bot.pickAssaultTarget(cands, { x: 50, y: 50 }, { turrets: 4, disarmed: 0 })].kind === "generator", "generators first");
        const noGen = cands.filter(c => c.kind !== "generator");
        ok(noGen[bot.pickAssaultTarget(noGen, { x: 50, y: 50 }, { turrets: 4, disarmed: 0 })].kind === "power-node", "then power nodes");
        const onlyTc = [cands[0], cands[3]];
        ok(onlyTc[bot.pickAssaultTarget(onlyTc, { x: 50, y: 50 }, { turrets: 4, disarmed: 0 })].kind === "turret", "core waits while turrets are armed");
        onlyTc[0].powered = false;
        ok(onlyTc[bot.pickAssaultTarget(onlyTc, { x: 50, y: 50 }, { turrets: 4, disarmed: 4 })].kind === "core", "disarmed base -> go for the core");
        const sp = bot.splitSquadByHealth([{ id: 1, hpFrac: 0.9 }, { id: 2, hpFrac: 0.3 }, { id: 3, hpFrac: 0.6 }, { id: 4, hpFrac: 0.9 }], { 3: true, 4: true });
        ok(sp.retreat.join() === "2,3" && sp.fight.join() === "1,4", "retreat below 45%, return only above 85% (hysteresis)");
    }

    // ---- unit chains T1..T5
    {
        const unl = { "ground-factory": true, dagger: true, mace: true, fortress: true, scepter: true, reign: true,
            "additive-reconstructor": true, "multiplicative-reconstructor": true, "exponential-reconstructor": true, "tetrative-reconstructor": true };
        const l8 = bot.chooseUnitLine(8, unl, false, false);
        ok(l8 && l8.line === "ground" && l8.tiers === 5 && l8.chain[4] === "reign", "diff>=8 aims for the T5 Reign");
        const l3 = bot.chooseUnitLine(4, Object.assign({}, unl, { "exponential-reconstructor": false }), false, false);
        ok(l3.tiers === 3, "diff 4 -> T3 chain");
        const limited = bot.chooseUnitLine(8, Object.assign({}, unl, { "exponential-reconstructor": false }), false, false);
        ok(limited.tiers === 3, "missing T4 reconstructor limits the chain");
        const W = 70, H = 70, cells = new Array(W * H).fill(bot.CELL_FREE);
        for (let y = 33; y <= 35; y++) for (let x = 33; x <= 35; x++) cells[y * W + x] = bot.CELL_CORE;
        const chain = bot.findUnitChainSlotTiers(W, H, cells, 34, 34, true, 5);
        ok(chain && chain.stages.length === 6, "T1..T5 chain with PayloadConveyor spacer fits");
        ok(chain.stages[4].kind === "payload" && chain.stages[5].kind === "tetrative-reconstructor", "payload conveyor before T5");
    }

    // ---- Gemma brain: JSON parsing, prompt budget, fallback, timeouts
    {
        const good = JSON.stringify({ message: { role: "assistant", content: JSON.stringify({ thought: "Строю ПВО у генераторов", priority: "BUILD_AA_SHIELD", flank: "north-east", ammo: "Graphite", aggression: 0.25 }) } });
        const p = bot.parseLlmResponse(good);
        ok(p.ok && p.priority === "BUILD_AA_SHIELD" && p.flank === "north-east" && p.ammo === "graphite" && p.aggression === 0.25, "Ollama /api/chat reply parsed");
        ok(bot.parseLlmResponse(JSON.stringify({ response: "```json\n{\"priority\":\"hold and research\",\"aggression\":7}\n```" })).aggression === 1, "generate-style + fenced + clamped");
        ok(bot.parseLlmResponse(JSON.stringify({ choices: [{ message: { content: "{\"priority\":\"BUILD_POWER\"}" } }] })).ok, "OpenAI-compatible reply parsed");
        ok(bot.parseLlmResponse("{\"priority\":\"CALL_WAVE_EARLY\",\"thought\":\"go\"}").ok, "bare plan parsed");
        for (const bad of ["", "   ", "garbage", "{\"message\":{\"content\":\"{broken\"}}", "{\"message\":", "{\"message\":{\"content\":\"{\\\"priority\\\":\\\"DROP_TABLES\\\"}\"}}", null, undefined, 42, "{\"priority\":null}"]) {
            let r; try { r = bot.parseLlmResponse(bad); } catch (e) { r = null; }
            ok(r && r.ok === false && typeof r.error === "string", "broken response never throws: " + String(bad).slice(0, 20));
        }
        const th = bot.parseLlmResponse(JSON.stringify({ priority: "BUILD_POWER", thought: "[red]hack[]\n" + "я".repeat(400), ammo: "uranium", flank: "up", aggression: "x" }));
        ok(th.ok && th.thought.indexOf("[") < 0 && th.thought.length <= 170 && th.ammo === "" && th.flank === "any" && th.aggression === 0.5, "thought sanitised, junk fields normalised");

        const sit = {
            attackMode: false, sectorName: "frozenForest", wave: 7, winWave: 15, enemies: 0, coreName: "shard",
            items: { copper: 900, lead: 400, graphite: 150, silicon: 60, titanium: 0 }, income: { copper: 3.2, lead: 1.1 }, power: 1.5,
            forecast: bot.analyzeWaveSchedule([{ type: "dagger", begin: 0, amount: 3, scaling: 2, hp: 130, dps: 20 }, { type: "flare", flying: true, begin: 8, spacing: 1, amount: 2, hp: 70, dps: 9 }], 6, 5, 60),
            chokeCount: 1, chokeWidth: 8, chokeDist: 27, chokeFlank: "east", weakFlank: "east", fortressBuilt: false, aaBuilt: false,
            turrets: 2, defenseDps: 120, armyUnits: 0, turretsAvailable: ["duo", "hail", "scatter"], aaAvailable: true,
            busPossible: true, canCallWave: true
        };
        const prompt = bot.buildLlmPrompt(sit);
        ok(prompt.length < 2400, `prompt is compact (${prompt.length} chars ~ ${Math.round(prompt.length / 3.5)} tokens)`);
        ok(prompt.indexOf("BUILD_CHOKEPOINT_FORTRESS") >= 0 && prompt.indexOf("FIRST_AIR_WAVE") >= 0, "prompt lists plans and the forecast");
        const body = JSON.parse(bot.buildLlmRequestBody("gemma4:e2b", prompt));
        ok(body.model === "gemma4:e2b" && body.stream === false && body.format === "json" && body.messages.length === 2, "Ollama request body");

        const h = bot.heuristicPlan(sit);
        ok(h.ok && h.source === "heuristic" && /[а-яё]/i.test(h.thought) && h.priority === "BUILD_AA_SHIELD", "heuristic: air in <=2 waves and no AA -> AA shield (Russian thought)");
        ok(bot.heuristicPlan(Object.assign({}, sit, { aaBuilt: true })).priority === "BUILD_CHOKEPOINT_FORTRESS", "heuristic: then the choke fortress");
        ok(bot.heuristicPlan(Object.assign({}, sit, { breach: { air: false, flank: "south", amount: 900 } })).priority === "REINFORCE_BREACH", "heuristic: breach first");
        ok(bot.heuristicPlan(Object.assign({}, sit, { attackMode: true, enemyBaseKnown: true, enemyPowerNodes: 3, armyUnits: 6 })).priority === "SNIPE_ENEMY_POWER", "heuristic: snipe enemy power");

        // brain with a fake async transport
        let clock = 100, pending = [], posts = 0;
        const env = { enabled: () => true, url: () => "http://127.0.0.1:11434/api/chat", model: () => "gemma4:e2b", now: () => clock, post: (url, b, t, cb) => { posts++; pending.push(cb); } };
        const brain = bot.createLlmBrain(env);
        let plan = brain.update(sit);
        ok(plan.source === "heuristic" && posts === 1, "first tick: instant heuristic + one non-blocking request");
        brain.update(sit); ok(posts === 1, "no second request while one is in flight");
        clock += 1;
        pending.shift()(true, good);
        plan = brain.update(sit);
        ok(plan.source === "gemma" && plan.priority === "BUILD_AA_SHIELD" && brain.hudLine().indexOf("💭 Мысль:") === 0, "Gemma plan applied + HUD thought line");
        clock += 30; plan = brain.update(sit); ok(plan.source === "gemma" && posts === 2, "plan reused within the TTL; refresh every ~10 s");
        pending.shift()(true, "{garbage");
        clock += 70; plan = brain.update(sit);
        ok(plan.source === "heuristic" && brain.badCount === 1, "broken JSON -> instant fallback, no exception");
        clock += 15; brain.update(sit); pending.shift()(false, "timeout");
        ok(brain.failures === 2, "failures counted");
        for (let i = 0; i < 6; i++) { clock += 130; brain.update(sit); if (pending.length) pending.shift()(false, "refused"); }
        const sentBefore = posts; clock += 5; brain.update(sit);
        ok(posts === sentBefore && bot.llmBackoffInterval(8) <= 120, "exponential backoff while Ollama is down");
        plan = brain.update(sit);
        ok(plan.ok && plan.source === "heuristic" && brain.status.indexOf("Ollama недоступна") >= 0, "Ollama down: campaign continues on the built-in planner");
        // infeasible plan from the model is ignored
        const clock2 = { t: 0 }; const pend2 = [];
        const b2 = bot.createLlmBrain({ enabled: () => true, url: () => "u", model: () => "m", now: () => clock2.t, post: (u, bd, t, cb) => pend2.push(cb) });
        b2.update(sit); pend2.shift()(true, JSON.stringify({ priority: "ASSAULT_BASE", thought: "x" }));
        ok(b2.update(sit).source === "heuristic", "infeasible model plan (no attack mode) rejected");
        // post() that throws, and a disabled switch
        const b3 = bot.createLlmBrain({ enabled: () => true, url: () => "u", model: () => "m", now: () => 0, post: () => { throw new Error("boom"); } });
        ok(b3.update(sit).ok && b3.failures === 1, "throwing transport is contained");
        let posted = 0;
        const b4 = bot.createLlmBrain({ enabled: () => false, url: () => "u", model: () => "m", now: () => 0, post: () => { posted++; } });
        ok(b4.update(sit).source === "heuristic" && posted === 0 && b4.status.indexOf("выкл") >= 0, "switch off: no network at all");
        // late/stale responses are ignored
        const b5 = bot.createLlmBrain({ enabled: () => true, url: () => "u", model: () => "m", now: () => 0, post: (u, bd, t, cb) => pend2.push(cb) });
        b5.update(sit); b5.onResponse(999, true, good); ok(b5.llmPlan === null, "stale response ignored");
    }

    // ---- strategy bias in decideSector (v1 behaviour unchanged without the new fields)
    {
        const o = { drills: 4, drillPossible: false, industryPossible: true, armyPossible: false, defenseSlots: 0, captured: false, waves: true, waveSending: true, waveTimer: true, waveTimeSec: 500, defenseDps: 400, defensePoolHp: 4000, nextWaveHp: 300, nextWaveDps: 40 };
        const base = bot.decideSector(o);
        const hold = bot.decideSector(Object.assign({}, o, { industryPossible: false, priority: "HOLD_AND_RESEARCH" }));
        const none = bot.decideSector(Object.assign({}, o, { industryPossible: false }));
        ok(hold.action !== bot.ACT_CALL_WAVE, "HOLD_AND_RESEARCH blocks early wave calls");
        ok(none.action === bot.ACT_CALL_WAVE || none.action === bot.ACT_MINE || none.action === bot.ACT_WAIT, "v1 flow untouched without a priority");
        const si = bot.decideSector(Object.assign({}, o, { priority: "EXPAND_SILICON_ECONOMY" }));
        ok(si.action === bot.ACT_INDUSTRY, "silicon-economy plan pulls industry forward");
        const aggressive = bot.decideSector(Object.assign({}, o, { industryPossible: false, aggression: 1 }));
        ok(bot.aggressionSafetyScale(1) < bot.aggressionSafetyScale(0) && bot.aggressionSafetyScale(undefined) === 1 && !!aggressive, "aggression scales the wave-call safety margin");
        ok(base.action === bot.ACT_INDUSTRY, "baseline decision sanity");
    }
}

console.log(`test-logic.js OK: ${checks} assertions passed.`);
