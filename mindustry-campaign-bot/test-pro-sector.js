#!/usr/bin/env node
"use strict";

/**
 * In-sector integration test of the v2.0 pro runtime (recon -> chokepoint kill-box -> ammo bus ->
 * AA corridor -> Gemma brain) on a synthetic cave map with rocks, driven through the REAL
 * thinkInSector() glue of scriptmod/scripts/main.js.
 */

const assert = require("assert");
const bot = require("./scriptmod/scripts/main.js");

let checks = 0;
function ok(cond, msg) {
    checks++;
    assert.ok(cond, `Check #${checks} failed: ${msg}`);
}

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
        duo: mkBlock("duo", 1, { targetGround: true, maxAmmo: 30, ammoTypes: { keys: () => ({ toSeq: () => seq([copper, graphite]) }) } }),
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
        multiplicativeReconstructor: mkBlock("multiplicative-reconstructor", 5, { unlockedNow: () => false }),
        router: mkBlock("router", 1), junction: mkBlock("junction", 1),
        copperWallLarge: mkBlock("copper-wall-large", 2, { group: "walls" }),
        titaniumWallLarge: mkBlock("titanium-wall-large", 2, { group: "walls", unlockedNow: () => false }),
        ripple: mkBlock("ripple", 3, { targetGround: true, maxAmmo: 30, unlockedNow: () => false, ammoTypes: { keys: () => ({ toSeq: () => seq([graphite]) }) } })
    };
    Blocks.hail = mkBlock("hail", 1, { targetGround: true, maxAmmo: 30, ammoTypes: { keys: () => ({ toSeq: () => seq([graphite]) }) } });
    Blocks.scatter = mkBlock("scatter", 2, { targetGround: false, maxAmmo: 30, ammoTypes: { keys: () => ({ toSeq: () => seq([lead]) }) } });
    Blocks.mender.unlockedNow = () => true;

    const UnitTypes = {
        __unused: null,
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

    const decorateGroups = (arr) => arr.map(g => Object.assign(g, {
        getSpawned(w) { return bot.waveGroupCount({ begin: g.begin, end: g.end, spacing: g.spacing, amount: g.unitAmount, scaling: g.unitScaling, max: g.max }, w); },
        getShield() { return 0; }
    }));
    const W = 100, H = 60;
    const grid = new Array(W * H).fill(null);
    const rock = new Array(W * H).fill(1);
    const caveOpen = (x, y) => (x >= 4 && x <= 34 && y >= 14 && y <= 46) || (x >= 35 && x <= 60 && Math.abs(y - 30) <= 3) || (x >= 61 && x <= 95 && y >= 8 && y <= 52);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rock[y * W + x] = caveOpen(x, y) ? 0 : 1;
    const ores = new Array(W * H).fill(null);
    // Patch of copper at (24..25, 30..31), coal at (24..25, 27..28), lead at (35..36, 30..31)
    for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
            ores[(33 + dy) * W + (18 + dx)] = copper;
            ores[(26 + dy) * W + (18 + dx)] = coal;
            ores[(36 + dy) * W + (24 + dx)] = lead;
        }
    }

    const coreStock = { 0: 6000, 1: 4000, 2: 600, 3: 1500, 4: 1500, 5: 800, 6: 600, 7: 0 };
    const coreItems = { get: (it) => coreStock[it.id] || 0 };
    const coreBuild = {
        block: Blocks.coreShard, team: 1, x: 12 * 8, y: 30 * 8,
        tileX: () => 12, tileY: () => 30,
        health: 2000, maxHealth: 2000, storageCapacity: 4000,
        items: coreItems, dst(o) { return Math.hypot(this.x - o.x, this.y - o.y); },
        isValid: () => true
    };
    for (let y = 29; y <= 31; y++) for (let x = 11; x <= 13; x++) grid[y * W + x] = coreBuild;

    const teamBuildings = seq([coreBuild]);
    const placeBuilding = (plan) => {
        const off = bot.sizeOffset(plan.block.size);
        const b = {
            block: plan.block, team: 1, config: () => plan.config, plan,
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
                    if (grid[gy * W + gx] !== null || rock[gy * W + gx]) return false;
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
    global.Core = { settings: { getBool: (k, d) => k === "scb-llm-enabled" ? true : false, getString: (k, d) => d, put() {} }, app: { post(f) { f(); } } };
    const httpPosts = [];
    global.Http = {
        post(url, body) {
            const req = { url, body, _h: {}, header(k, v) { this._h[k] = v; return this; }, timeout(t) { this.t = t; return this; },
                error(cb) { this._err = cb; return this; }, submit(cb) { this._ok = cb; httpPosts.push(this); return this; } };
            return req;
        }
    };

    const enemyCore = { x: 92 * 8, y: 30 * 8, block: mkBlock("enemy-core", 3), dst: (o) => Math.hypot(92 * 8 - o.x, 30 * 8 - o.y) };
    const playerUnit = {
        x: 12 * 8, y: 30 * 8, plans: seq([]), stack: { amount: 0 },
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
                    build: b, x, y,
                    block: () => b ? b.block : Blocks.air,
                    drop: () => d,
                    solid: () => !!rock[y * W + x] || !!(b && b.block.solid),
                    floor: () => ({ isLiquid: false, isDeep: () => false }),
                    worldx: () => x * 8, worldy: () => y * 8
                };
            }
        },
        spawner: { getSpawns: () => seq([{ x: 90, y: 30, worldx: () => 90 * 8, worldy: () => 30 * 8 }]), isSpawning: () => false },
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
                attackMode: false, waves: true, waveSending: true, waveTimer: true,
                winWave: 0, waveTeam: 2, buildCostMultiplier: 1,
                defaultTeam: { core: () => coreBuild },
                spawns: seq(decorateGroups([
                    { type: { name: "dagger", health: 130, flying: false }, begin: 0, end: 99999, spacing: 1, unitAmount: 2, unitScaling: 2, max: 50 },
                    { type: { name: "flare", health: 70, flying: true }, begin: 2, end: 99999, spacing: 2, unitAmount: 2, unitScaling: 3, max: 50 }
                ]))
            },
            wave: 2, wavetime: 3600, enemies: 0, stats: { buildingsBuilt: 0 },
            teams: {
                get: (t) => t === 1
                    ? { buildings: teamBuildings, plans: seq([]), countType: () => 2 }
                    : { cores: seq([enemyCore]), buildings: seq([enemyCore]) }
            }
        }
    };


    const inst = bot.installMindustryCampaignBot();
    inst.start();
    const cfgCalls = [];
    global.Call.tileConfig = (_p, b, item) => { cfgCalls.push([b, item]); };
    let postsAtCycle20 = 0;
    let posted = false, sawGemma = false, gemmaPlan = null;
    for (let cycle = 0; cycle < 140; cycle++) {
        global.Time.time += 200;
        if (cycle === 20) postsAtCycle20 = httpPosts.length;
        inst.thinkInSector(playerUnit);
        // the (fake) Ollama answers once, asynchronously
        if (httpPosts.length && !posted && cycle >= 20 && httpPosts.length > postsAtCycle20) {
            posted = true;
            const req = httpPosts[httpPosts.length - 1];
            req._ok({ getResultAsString: () => JSON.stringify({ message: { content: JSON.stringify({ thought: "Держу горлышко и тяну шину патронов", priority: "BUILD_AMMO_BUS", flank: "east", ammo: "graphite", aggression: 0.3 }) } }) });
        }
        if (inst.pro.plan && inst.pro.plan.source === "gemma") { sawGemma = true; gemmaPlan = inst.pro.plan; }
        while (!playerUnit.plans.isEmpty()) {
            const pl = playerUnit.plans.first();
            playerUnit.plans.remove(pl);
            placeBuilding(pl);
            global.Vars.state.stats.buildingsBuilt++;
        }
    }

    const pro = inst.pro;
    if (process.env.DEBUG_PRO) {
        const kb = pro.kill; const un = [];
        for (let i = 0; i < kb.slots.length; i += 5) {
            const t = global.Vars.world.tile(kb.slots[i], kb.slots[i + 1]);
            if (!t.build || t.build.team !== 1) un.push(kb.slots.slice(i, i + 5).join(","));
        }
        console.log("unsatisfied:", un.join(" | "));
        for (const [x, y] of [[35, 27], [36, 29], [36, 30], [37, 30], [36, 27]]) { const t = global.Vars.world.tile(x, y); console.log(x, y, t.build ? t.build.block.name + "@" + t.build.x / 8 + "," + t.build.y / 8 : "none"); }
        for (let y = 36; y >= 24; y--) { let row = ""; for (let x = 20; x < 50; x++) { const t = global.Vars.world.tile(x, y); row += t.build ? t.build.block.name[0] : (rock[y * W + x] ? "#" : "."); } console.log(row); }
    }
    if (process.env.DEBUG_PRO) { console.log(inst.journal.join("\n")); console.log(pro.brain.status, pro.brain.thought, pro.brain.okCount, pro.fortSat, "/", pro.fortTotal, JSON.stringify(pro.kit)); }
    ok(pro.scanDone && pro.choke, "recon finished and found the canyon choke");
    ok(pro.choke.width === 7, `choke width ${pro.choke.width}`);
    ok(pro.recon.indexOf("проходы: 1") >= 0, "recon summary in Russian: " + pro.recon);
    ok(pro.sched.firstAirWave === 3, "wave table analysis found the first air wave");

    const built = {};
    teamBuildings.each(b => { built[b.block.name] = (built[b.block.name] || 0) + 1; });
    ok((built["duo"] || 0) + (built["hail"] || 0) >= 3, "kill-box turrets built: " + JSON.stringify(built));
    ok((built["copper-wall-large"] || 0) + (built["copper-wall"] || 0) >= 8, "layered walls built: " + JSON.stringify(built));
    ok(built["mender"] >= 1, "mender support built");

    // walls close the canyon rock-to-rock
    const blocked = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) blocked[i] = rock[i];
    teamBuildings.each(b => {
        if (b.block.group !== "walls") return;
        const off = bot.sizeOffset(b.block.size), px = Math.round(b.x / 8), py = Math.round(b.y / 8);
        for (let dy = 0; dy < b.block.size; dy++) for (let dx = 0; dx < b.block.size; dx++) blocked[(py + off + dy) * W + (px + off + dx)] = 1;
    });
    const seen = new Uint8Array(W * H), q = [30 * W + 55];
    seen[q[0]] = 1;
    for (let h = 0; h < q.length; h++) {
        const c = q[h], x = c % W, y = (c - x) / W;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if ((!dx && !dy) || nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const ni = ny * W + nx;
            if (seen[ni] || blocked[ni]) continue;
            if (dx && dy && (blocked[y * W + nx] || blocked[ny * W + x])) continue;
            seen[ni] = 1; q.push(ni);
        }
    }
    ok(!seen[30 * W + 20], "built walls seal the canyon: enemies must break through the kill-box");

    // ammo bus: Unloader at the core with the chosen ammo + Router/Junction spine
    ok(pro.busPlan && pro.busBuilt, "ammo bus planned and fully built");
    ok((built["unloader"] || 0) >= 1 && (built["router"] || 0) >= 2 && (built["junction"] || 0) >= 1, "bus pieces built: " + JSON.stringify(built));
    let unloaderCfg = null;
    teamBuildings.each(b => { if (b.block.name === "unloader" && b.plan.config) unloaderCfg = b.plan.config; });
    ok(unloaderCfg && ["graphite", "silicon", "copper"].indexOf(unloaderCfg.name) >= 0, "Unloader configured with an ammo item (" + (unloaderCfg && unloaderCfg.name) + ")");
    ok(cfgCalls.some(c => c[1] && c[1].name === "graphite"), "Unloader re-tuned via Call.tileConfig to the ammo Gemma chose");

    // AA corridor against the first air wave
    ok((built["scatter"] || 0) >= 1, "AA (Scatter) built before the first air wave");

    // Gemma brain: request goes through arc.util.Http, answer applied, thought shown
    ok(httpPosts.length >= 1, "Gemma request sent through Http.post");
    const reqBody = JSON.parse(httpPosts[0].body);
    ok(reqBody.model === "gemma4:e2b" && reqBody.stream === false && reqBody.format === "json", "request body for Ollama /api/chat");
    ok(httpPosts[0].url === "http://127.0.0.1:11434/api/chat" && httpPosts[0].t === 4000, "default URL and 4 s timeout");
    ok(pro.brain.okCount >= 1 && sawGemma && gemmaPlan.priority === "BUILD_AMMO_BUS" && /Держу горлышко/.test(gemmaPlan.thought) && gemmaPlan.ammo === "graphite", "Gemma plan was applied through Core.app.post and then expired back to the planner");
    ok(!inst.journal.some(j => j.indexOf("отключён") >= 0), "no pro module crashed: " + inst.journal.join(" / "));
    ok(pro.brain.hudLine().indexOf("💭 Мысль:") === 0, "HUD thought line");
}

console.log(`test-pro-sector.js OK: ${checks} assertions passed.`);
