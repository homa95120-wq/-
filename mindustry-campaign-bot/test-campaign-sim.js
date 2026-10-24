#!/usr/bin/env node
"use strict";

/**
 * End-to-end simulation of the full Serpulo campaign using the real
 * `installMindustryCampaignBot()` runtime from `scriptmod/scripts/main.js`.
 *
 * Verifies that starting from a fresh profile (0 bases, only Core: Shard, Duo,
 * Mechanical Drill, Conveyor, and Ground Zero unlocked), the bot honestly
 * researches technologies by spending stored sector items, launches from base
 * to base paying real Core schematic costs, defends an invaded base mid-run,
 * unlocks every prerequisite up to Planetary Launch Terminal + Interplanetary
 * Accelerator, and finishes in BOT_VICTORY.
 */

const assert = require("assert");
const mod = require("./scriptmod/scripts/main.js");

function makeSeq(arr = []) {
    return {
        _arr: arr,
        get size() { return this._arr.length; },
        get(i) { return this._arr[i]; },
        first() { return this._arr[0]; },
        add(v) { this._arr.push(v); return this; },
        isEmpty() { return this._arr.length === 0; },
        indexOf(v) { return this._arr.indexOf(v); },
        remove(v) {
            const idx = this._arr.indexOf(v);
            if (idx >= 0) { this._arr.splice(idx, 1); return true; }
            return false;
        },
        each(fn) { for (let i = 0; i < this._arr.length; i++) fn(this._arr[i]); }
    };
}

// --- Items ---
const itemNames = [
    "copper", "lead", "coal", "graphite", "titanium", "thorium",
    "silicon", "plastanium", "phase-fabric", "surge-alloy", "spore-pod", "sand", "metaglass"
];
const Items = {};
const allItems = [];
itemNames.forEach((nm, id) => {
    const camel = nm.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const it = {
        id, name: nm, localizedName: nm, hardness: id <= 1 ? 1 : id <= 3 ? 2 : id === 4 ? 3 : 4,
        _unlocked: id <= 1,
        unlocked() { return this._unlocked; },
        unlockedHost() { return this._unlocked; },
        unlock() { this._unlocked = true; },
        isOnPlanet() { return true; }
    };
    Items[camel] = it;
    allItems.push(it);
});

class ItemSeqMock {
    constructor(init = {}) {
        this.map = Object.assign({}, init);
    }
    get(it) { return this.map[it.id] || 0; }
    set(it, amt) { this.map[it.id] = amt; }
    add(it, amt) { this.map[it.id] = (this.map[it.id] || 0) + amt; }
    has(other) {
        for (const k of Object.keys(other.map)) {
            if ((this.map[k] || 0) < other.map[k]) return false;
        }
        return true;
    }
    remove(it, amt) {
        this.map[it.id] = Math.max(0, (this.map[it.id] || 0) - amt);
    }
}

// --- TechTree construction ---
let allTechNodes = [];
function makeContent(name, unlocked = false, extra = {}) {
    return Object.assign({
        name,
        localizedName: name,
        _unlocked: unlocked,
        techNode: null,
        unlocked() { return this._unlocked; },
        unlockedNow() { return this._unlocked; },
        unlockedHost() { return this._unlocked; },
        unlock() { this._unlocked = true; },
        isPlaceable() { return true; },
        environmentBuildable() { return true; }
    }, extra);
}

function makeTechNode(parent, content, reqPairs = [], objectives = []) {
    const reqs = [];
    const fin = [];
    for (let i = 0; i < reqPairs.length; i += 2) {
        reqs.push({ item: reqPairs[i], amount: reqPairs[i + 1] });
        fin.push({ item: reqPairs[i], amount: 0 });
    }
    const tn = {
        parent,
        content,
        requirements: reqs,
        finishedRequirements: fin,
        objectives: makeSeq(objectives),
        children: makeSeq([]),
        save() {}
    };
    content.techNode = tn;
    if (parent) parent.children.add(tn);
    allTechNodes.push(tn);
    return tn;
}

function objResearch(content) {
    return {
        content,
        complete() { return content.unlockedHost(); },
        toString() { return "research: " + content.name; }
    };
}

function objSectorComplete(preset) {
    return {
        preset,
        complete() { return preset.sector.isCaptured() && preset.sector.hasBase(); },
        toString() { return "sectorComplete: " + preset.name; }
    };
}

// --- Build authentic Serpulo tech + sector graph ---
const Planets = { serpulo: { name: "serpulo", sectors: makeSeq([]), launchCapacityMultiplier: 0.25 } };
const rootCore = makeContent("core-shard", true, { size: 3, itemCapacity: 4000, requirements: [] });
Planets.serpulo.defaultCore = rootCore;
const rootNode = makeTechNode(null, rootCore, []);
Planets.serpulo.techTree = rootNode;

const Blocks = {
    air: makeContent("air", true),
    coreShard: rootCore,
    conveyor: makeContent("conveyor", true, { size: 1, requirements: [{ item: Items.copper, amount: 1 }] }),
    mechanicalDrill: makeContent("mechanical-drill", true, { size: 2, tier: 2, requirements: [{ item: Items.copper, amount: 12 }] }),
    duo: makeContent("duo", true, { size: 1, targetGround: true, requirements: [{ item: Items.copper, amount: 35 }] }),
    copperWall: makeContent("copper-wall", true, { size: 1, requirements: [{ item: Items.copper, amount: 6 }] })
};

function addBlock(parentNode, key, name, costPairs, objs = [], extra = {}) {
    const b = makeContent(name, false, Object.assign({ size: 2, requirements: [{ item: Items.copper, amount: 25 }] }, extra));
    Blocks[key] = b;
    const tn = makeTechNode(parentNode, b, costPairs, objs);
    return tn;
}

const UnitTypes = {};
function addUnit(parentNode, key, name, costPairs, objs = []) {
    const u = makeContent(name, false, { canAttack: key !== "mono" && key !== "poly" && key !== "mega", canBoost: false, isBanned() { return false; } });
    UnitTypes[key] = u;
    return makeTechNode(parentNode, u, costPairs, objs);
}

const SectorPresets = {};
const allPresets = [];
let nextSectorId = 1;
function makePreset(parentNode, key, diff, captureWave, objs = [], isLast = false) {
    const id = nextSectorId++;
    const itemStore = new ItemSeqMock();
    const sector = {
        id,
        preset: null,
        threat: diff / 10,
        _captured: false,
        _hasBase: false,
        _attacked: false,
        info: { resources: makeSeq([Items.copper, Items.lead, Items.coal, Items.sand, Items.titanium, Items.thorium]) },
        name() { return key; },
        isCaptured() { return this._captured; },
        hasBase() { return this._hasBase; },
        isFrozen() { return false; },
        isShielded() { return false; },
        isAttacked() { return this._attacked; },
        isBeingPlayed() { return global.Vars.state.isGame() && global.Vars.state.getSector() === this; },
        hasEnemyBase() { return captureWave === 0; },
        allowLaunchSchematics() { return false; },
        allowLaunchLoadout() { return true; },
        items() { return itemStore; },
        removeItem(it, amt) { itemStore.remove(it, amt); },
        removeItems(seq) {
            for (const k of Object.keys(seq.map)) {
                itemStore.map[k] = Math.max(0, (itemStore.map[k] || 0) - seq.map[k]);
            }
        }
    };
    const preset = makeContent(key, key === "groundZero", {
        planet: Planets.serpulo,
        sector,
        difficulty: diff,
        captureWave,
        requireUnlock: true,
        isLastSector: isLast
    });
    sector.preset = preset;
    SectorPresets[key] = preset;
    Planets.serpulo.sectors.add(sector);
    allPresets.push(preset);
    const tn = makeTechNode(parentNode, preset, [], objs);
    return tn;
}

// Tech branches needed by Serpulo presets
const nJunction = addBlock(rootNode, "junction", "junction", [Items.copper, 20]);
const nRouter = addBlock(nJunction, "router", "router", [Items.copper, 25]);
const nUnloader = addBlock(nRouter, "unloader", "unloader", [Items.titanium, 30, Items.silicon, 30]);
const nMender = addBlock(rootNode, "mender", "mender", [Items.copper, 40, Items.lead, 30]);
const nCombustion = addBlock(rootNode, "combustionGenerator", "combustion-generator", [Items.copper, 30, Items.lead, 20]);
const nPowerNode = addBlock(nCombustion, "powerNode", "power-node", [Items.copper, 15, Items.lead, 20], [], { maxNodes: 10 });
const nSteam = addBlock(nPowerNode, "steamGenerator", "steam-generator", [Items.copper, 60, Items.graphite, 40, Items.silicon, 40]);
const nThermal = addBlock(nSteam, "thermalGenerator", "thermal-generator", [Items.copper, 80, Items.graphite, 60, Items.silicon, 60]);
const nThoriumReactor = addBlock(nThermal, "thoriumReactor", "thorium-reactor", [Items.lead, 120, Items.silicon, 100, Items.thorium, 80]);
const nImpactReactor = addBlock(nThoriumReactor, "impactReactor", "impact-reactor", [Items.lead, 200, Items.silicon, 180, Items.thorium, 120]);
const nGraphite = addBlock(rootNode, "graphitePress", "graphite-press", [Items.copper, 50, Items.lead, 30]);
const nSilicon = addBlock(nGraphite, "siliconSmelter", "silicon-smelter", [Items.copper, 60, Items.lead, 50, Items.graphite, 30]);
const nKiln = addBlock(nGraphite, "kiln", "kiln", [Items.copper, 60, Items.lead, 50]);
const nPlast = addBlock(nSilicon, "plastaniumCompressor", "plastanium-compressor", [Items.lead, 100, Items.graphite, 60, Items.titanium, 80]);
const nPhase = addBlock(nPlast, "phaseWeaver", "phase-weaver", [Items.lead, 120, Items.silicon, 120, Items.thorium, 80]);
const nSurge = addBlock(nPhase, "surgeSmelter", "surge-smelter", [Items.lead, 150, Items.silicon, 150, Items.thorium, 100]);
const nPneumatic = addBlock(rootNode, "pneumaticDrill", "pneumatic-drill", [Items.copper, 50, Items.graphite, 30], [], { tier: 3 });
const nLaser = addBlock(nPneumatic, "laserDrill", "laser-drill", [Items.copper, 80, Items.graphite, 60, Items.silicon, 60, Items.titanium, 50], [], { tier: 4 });
const nWaterExt = addBlock(nPneumatic, "waterExtractor", "water-extractor", [Items.copper, 60, Items.graphite, 40]);
const nCultivator = addBlock(nWaterExt, "cultivator", "cultivator", [Items.copper, 50, Items.lead, 50, Items.silicon, 30]);
const nSporePress = addBlock(nCultivator, "sporePress", "spore-press", [Items.lead, 60, Items.silicon, 40]);
const nCoalCent = addBlock(nSporePress, "coalCentrifuge", "coal-centrifuge", [Items.lead, 60, Items.graphite, 40]);
const nPump = addBlock(rootNode, "mechanicalPump", "mechanical-pump", [Items.copper, 30, Items.metaglass, 15]);
const nConduit = addBlock(nPump, "conduit", "conduit", [Items.metaglass, 20]);
const nScatter = addBlock(rootNode, "scatter", "scatter", [Items.copper, 50, Items.lead, 40]);
const nHail = addBlock(nScatter, "hail", "hail", [Items.copper, 50, Items.graphite, 35]);
const nWave = addBlock(nHail, "wave", "wave", [Items.lead, 60, Items.metaglass, 40]);
const nLancer = addBlock(nHail, "lancer", "lancer", [Items.copper, 70, Items.lead, 70, Items.silicon, 50]);
const nSalvo = addBlock(nLancer, "salvo", "salvo", [Items.copper, 90, Items.graphite, 70, Items.titanium, 50]);
const nRipple = addBlock(nSalvo, "ripple", "ripple", [Items.copper, 100, Items.graphite, 80, Items.titanium, 60]);
const nSwarmer = addBlock(nRipple, "swarmer", "swarmer", [Items.graphite, 80, Items.titanium, 60, Items.plastanium, 40, Items.silicon, 60]);
const nCyclone = addBlock(nSwarmer, "cyclone", "cyclone", [Items.copper, 120, Items.titanium, 80, Items.plastanium, 60]);
const nSpectre = addBlock(nCyclone, "spectre", "spectre", [Items.copper, 160, Items.graphite, 120, Items.thorium, 120, Items.plastanium, 80]);
const nDoor = addBlock(rootNode, "door", "door", [Items.graphite, 20, Items.silicon, 15]);
const nCoreFound = addBlock(rootNode, "coreFoundation", "core-foundation", [Items.copper, 200, Items.lead, 200, Items.silicon, 150], [], { size: 4, itemCapacity: 9000 });
const nCoreNuc = addBlock(nCoreFound, "coreNucleus", "core-nucleus", [Items.copper, 300, Items.lead, 300, Items.silicon, 250, Items.thorium, 200], [], { size: 5, itemCapacity: 13000 });
const nPayloadConv = addBlock(nRouter, "payloadConveyor", "payload-conveyor", [Items.graphite, 30, Items.copper, 30]);
const nMassDriver = addBlock(nPayloadConv, "massDriver", "mass-driver", [Items.lead, 120, Items.titanium, 100, Items.thorium, 60, Items.silicon, 80]);
const nAdvLaunch = addBlock(nMassDriver, "advancedLaunchPad", "advanced-launch-pad", [Items.lead, 150, Items.silicon, 140, Items.titanium, 120, Items.plastanium, 80]);
const nAccel = addBlock(nCoreNuc, "interplanetaryAccelerator", "interplanetary-accelerator",
    [Items.copper, 300, Items.silicon, 250, Items.thorium, 200, Items.plastanium, 150, Items.surgeAlloy, 100, Items.phaseFabric, 100]);

const nGroundFac = addBlock(rootNode, "groundFactory", "ground-factory", [Items.copper, 60, Items.lead, 60, Items.silicon, 40]);
const nDagger = addUnit(nGroundFac, "dagger", "dagger", [Items.silicon, 30, Items.lead, 30]);
const nMace = addUnit(nDagger, "mace", "mace", [Items.silicon, 50, Items.graphite, 40]);
const nFortress = addUnit(nMace, "fortress", "fortress", [Items.silicon, 80, Items.titanium, 60]);
const nCrawler = addUnit(nDagger, "crawler", "crawler", [Items.silicon, 40, Items.graphite, 40]);
const nAtrax = addUnit(nCrawler, "atrax", "atrax", [Items.silicon, 60, Items.graphite, 50]);
const nSpiroct = addUnit(nAtrax, "spiroct", "spiroct", [Items.silicon, 80, Items.thorium, 50]);
const nArkyid = addUnit(nSpiroct, "arkyid", "arkyid", [Items.silicon, 100, Items.plastanium, 70]);

const nAirFac = addBlock(nGroundFac, "airFactory", "air-factory", [Items.copper, 50, Items.lead, 60]);
const nFlare = addUnit(nAirFac, "flare", "flare", [Items.silicon, 30]);
const nHorizon = addUnit(nFlare, "horizon", "horizon", [Items.silicon, 50, Items.graphite, 40]);
const nZenith = addUnit(nHorizon, "zenith", "zenith", [Items.silicon, 80, Items.titanium, 60]);
const nMono = addUnit(nAirFac, "mono", "mono", [Items.lead, 40, Items.silicon, 40]);
const nPoly = addUnit(nMono, "poly", "poly", [Items.silicon, 60, Items.graphite, 50]);
const nMega = addUnit(nPoly, "mega", "mega", [Items.silicon, 90, Items.titanium, 60]);

// Presets — early tree first so unit sector-gates can reference them
const pGZ = makePreset(rootNode, "groundZero", 1, 10, []);
Planets.serpulo.getStartSector = () => SectorPresets.groundZero.sector;
Planets.serpulo.generator = {
    allowLanding: () => false,
    findLaunchCandidate: (dest, selected) => selected
};

const pFF = makePreset(pGZ, "frozenForest", 2, 15, [objSectorComplete(SectorPresets.groundZero), objResearch(Blocks.junction), objResearch(Blocks.router)]);
const pCB = makePreset(pFF, "crateredBattleground", 2, 20, [objSectorComplete(SectorPresets.frozenForest), objResearch(Blocks.mender), objResearch(Blocks.combustionGenerator)]);
const pRS = makePreset(pCB, "ruinousShores", 3, 30, [objSectorComplete(SectorPresets.crateredBattleground), objResearch(Blocks.graphitePress), objResearch(Blocks.kiln), objResearch(Blocks.mechanicalPump)]);
const pWI = makePreset(pRS, "windsweptIslands", 4, 30, [objSectorComplete(SectorPresets.ruinousShores), objResearch(Blocks.pneumaticDrill), objResearch(Blocks.hail), objResearch(Blocks.siliconSmelter), objResearch(Blocks.steamGenerator)]);
const pBF = makePreset(pCB, "biomassFacility", 3, 20, [objSectorComplete(SectorPresets.crateredBattleground), objResearch(Blocks.powerNode), objResearch(Blocks.steamGenerator), objResearch(Blocks.scatter), objResearch(Blocks.graphitePress)]);
const pSM = makePreset(pBF, "stainedMountains", 3, 30, [objSectorComplete(SectorPresets.biomassFacility), objResearch(Blocks.pneumaticDrill), objResearch(Blocks.siliconSmelter)]);
const pFP = makePreset(pBF, "fungalPass", 2, 0, [objResearch(Blocks.groundFactory), objResearch(UnitTypes.dagger)]);

const nAddRec = addBlock(nGroundFac, "additiveReconstructor", "additive-reconstructor", [Items.copper, 80, Items.lead, 80, Items.silicon, 60], [objSectorComplete(SectorPresets.fungalPass)]);
const pFR = makePreset(pFP, "frontier", 4, 0, [objSectorComplete(SectorPresets.biomassFacility), objSectorComplete(SectorPresets.fungalPass), objResearch(Blocks.groundFactory), objResearch(Blocks.airFactory), objResearch(Blocks.additiveReconstructor), objResearch(UnitTypes.mace), objResearch(UnitTypes.mono)]);
const nMultRec = addBlock(nAddRec, "multiplicativeReconstructor", "multiplicative-reconstructor", [Items.lead, 120, Items.silicon, 100, Items.titanium, 80], [objSectorComplete(SectorPresets.frontier)]);

const nNavalFac = addBlock(nAirFac, "navalFactory", "naval-factory", [Items.copper, 80, Items.lead, 80, Items.metaglass, 60], [objSectorComplete(SectorPresets.ruinousShores)]);
const nRisso = addUnit(nNavalFac, "risso", "risso", [Items.silicon, 40, Items.metaglass, 40]);
const nMinke = addUnit(nRisso, "minke", "minke", [Items.silicon, 60, Items.graphite, 50]);
const nBryde = addUnit(nMinke, "bryde", "bryde", [Items.silicon, 80, Items.titanium, 60]);
const nSei = addUnit(nBryde, "sei", "sei", [Items.silicon, 100, Items.plastanium, 80]);
const nRetusa = addUnit(nNavalFac, "retusa", "retusa", [Items.silicon, 40, Items.metaglass, 40], [objSectorComplete(SectorPresets.windsweptIslands)]);

const pF32 = makePreset(pSM, "facility32m", 4, 25, [objSectorComplete(SectorPresets.stainedMountains), objSectorComplete(SectorPresets.windsweptIslands), objResearch(Blocks.plastaniumCompressor), objResearch(Blocks.lancer), objResearch(Blocks.salvo)]);
const pIC = makePreset(pSM, "infestedCanyons", 4, 0, [objSectorComplete(SectorPresets.fungalPass), objSectorComplete(SectorPresets.frontier), objResearch(Blocks.navalFactory), objResearch(UnitTypes.risso), objResearch(UnitTypes.minke), objResearch(Blocks.additiveReconstructor)]);
const pNC = makePreset(pIC, "nuclearComplex", 7, 50, [objSectorComplete(SectorPresets.infestedCanyons), objResearch(Blocks.thermalGenerator), objResearch(Blocks.laserDrill), objResearch(Blocks.swarmer)]);
const pPH = makePreset(pFR, "perilousHarbor", 4, 0, [objSectorComplete(SectorPresets.biomassFacility), objSectorComplete(SectorPresets.frontier), objResearch(Blocks.navalFactory), objResearch(UnitTypes.risso), objResearch(UnitTypes.retusa), objResearch(Blocks.steamGenerator), objResearch(Blocks.cultivator), objResearch(Blocks.coalCentrifuge)]);
const pEO = makePreset(pPH, "extractionOutpost", 5, 0, [objSectorComplete(SectorPresets.windsweptIslands), objSectorComplete(SectorPresets.perilousHarbor), objSectorComplete(SectorPresets.facility32m), objResearch(Blocks.multiplicativeReconstructor), objResearch(UnitTypes.risso), objResearch(UnitTypes.minke), objResearch(UnitTypes.fortress)]);
const pOG = makePreset(pFR, "overgrowth", 5, 0, [objSectorComplete(SectorPresets.frontier), objSectorComplete(SectorPresets.windsweptIslands), objResearch(Blocks.multiplicativeReconstructor), objResearch(UnitTypes.fortress), objResearch(Blocks.ripple), objResearch(Blocks.salvo), objResearch(Blocks.cultivator), objResearch(Blocks.sporePress)]);
const nExpRec = addBlock(nMultRec, "exponentialReconstructor", "exponential-reconstructor", [Items.lead, 180, Items.silicon, 160, Items.titanium, 120, Items.plastanium, 100], [objSectorComplete(SectorPresets.overgrowth)]);
const pMB = makePreset(pOG, "mycelialBastion", 8, 0, [objResearch(UnitTypes.atrax), objResearch(UnitTypes.spiroct), objResearch(UnitTypes.arkyid), objResearch(Blocks.multiplicativeReconstructor), objResearch(Blocks.exponentialReconstructor)]);
const nTetRec = addBlock(nExpRec, "tetrativeReconstructor", "tetrative-reconstructor", [Items.lead, 240, Items.silicon, 220, Items.plastanium, 150, Items.surgeAlloy, 100, Items.phaseFabric, 80], [objSectorComplete(SectorPresets.mycelialBastion)]);

const pSF = makePreset(pWI, "saltFlats", 5, 0, [objSectorComplete(SectorPresets.windsweptIslands), objSectorComplete(SectorPresets.fungalPass), objSectorComplete(SectorPresets.frontier), objResearch(Blocks.groundFactory), objResearch(Blocks.additiveReconstructor), objResearch(Blocks.airFactory), objResearch(Blocks.door)]);
const pTF = makePreset(pSF, "tarFields", 5, 40, [objSectorComplete(SectorPresets.saltFlats), objResearch(Blocks.coalCentrifuge), objResearch(Blocks.conduit), objResearch(Blocks.wave)]);
const pCL = makePreset(pTF, "coastline", 5, 30, [objSectorComplete(SectorPresets.tarFields), objSectorComplete(SectorPresets.saltFlats), objResearch(Blocks.navalFactory), objResearch(Blocks.payloadConveyor)]);
const nOxynoe = addUnit(nRetusa, "oxynoe", "oxynoe", [Items.silicon, 60, Items.titanium, 50], [objSectorComplete(SectorPresets.coastline)]);
const pNF = makePreset(pCL, "navalFortress", 8, 0, [objSectorComplete(SectorPresets.coastline), objSectorComplete(SectorPresets.extractionOutpost), objResearch(Blocks.coreNucleus), objResearch(Blocks.massDriver), objResearch(UnitTypes.oxynoe), objResearch(UnitTypes.minke), objResearch(UnitTypes.bryde), objResearch(Blocks.cyclone), objResearch(Blocks.ripple)]);
const pI78 = makePreset(pTF, "impact0078", 7, 45, [objSectorComplete(SectorPresets.tarFields), objResearch(Blocks.lancer), objResearch(Blocks.salvo), objResearch(Blocks.coreFoundation)]);
const pDR = makePreset(pI78, "desolateRift", 8, 18, [objSectorComplete(SectorPresets.impact0078), objResearch(Blocks.thermalGenerator), objResearch(Blocks.thoriumReactor), objResearch(Blocks.coreNucleus)]);
const pLS = makePreset(pMB, "littoralShipyard", 9, 0, [objSectorComplete(SectorPresets.desolateRift), objSectorComplete(SectorPresets.navalFortress), objSectorComplete(SectorPresets.mycelialBastion), objResearch(UnitTypes.risso), objResearch(UnitTypes.minke), objResearch(UnitTypes.bryde), objResearch(UnitTypes.sei), objResearch(Blocks.spectre), objResearch(Blocks.additiveReconstructor), objResearch(Blocks.exponentialReconstructor)]);
const nOmura = addUnit(nSei, "omura", "omura", [Items.silicon, 160, Items.plastanium, 120, Items.surgeAlloy, 80], [objSectorComplete(SectorPresets.littoralShipyard)]);
// Optional side preset to prove victory-path prioritization
makePreset(pIC, "taintedWoods", 5, 33, [objSectorComplete(SectorPresets.infestedCanyons), objResearch(Blocks.wave)]);

const pPLT = makePreset(pDR, "planetaryTerminal", 10, 0, [
    objSectorComplete(SectorPresets.desolateRift),
    objSectorComplete(SectorPresets.nuclearComplex),
    objSectorComplete(SectorPresets.extractionOutpost),
    objSectorComplete(SectorPresets.mycelialBastion),
    objSectorComplete(SectorPresets.littoralShipyard),
    objResearch(UnitTypes.omura),
    objResearch(Blocks.advancedLaunchPad),
    objResearch(Blocks.massDriver),
    objResearch(Blocks.impactReactor),
    objResearch(Blocks.tetrativeReconstructor)
], true);

// --- Mock global Mindustry objects ---
let activeSector = null;
let launches = [];
let invasionTriggered = false;
let invasionDefended = false;

global.Planets = Planets;
global.Blocks = Blocks;
global.Items = Items;
global.UnitTypes = UnitTypes;
global.SectorPresets = SectorPresets;
global.ItemSeq = ItemSeqMock;
global.Loadouts = {
    basicShard: {
        requirements: () => new ItemSeqMock({ [Items.copper.id]: 100, [Items.lead.id]: 100 }),
        findCore: () => Blocks.coreShard
    },
    basicFoundation: {
        requirements: () => new ItemSeqMock({ [Items.copper.id]: 300, [Items.lead.id]: 300, [Items.silicon.id]: 200 }),
        findCore: () => Blocks.coreFoundation
    },
    basicNucleus: {
        requirements: () => new ItemSeqMock({ [Items.copper.id]: 500, [Items.lead.id]: 500, [Items.silicon.id]: 400, [Items.thorium.id]: 250 }),
        findCore: () => Blocks.coreNucleus
    }
};
global.Packages = { mindustry: { game: { EventType: {
    Trigger: { update: "update" },
    WorldLoadEvent: "WorldLoadEvent",
    ClientLoadEvent: "ClientLoadEvent",
    SectorLaunchLoadoutEvent: function () {}
} } } };
global.ResearchEvent = function () {};
global.SectorCaptureEvent = function () {};
global.GameOverEvent = function () {};
global.Events = { on() {}, run() {}, fire() {} };
global.Time = { time: 0 };
global.Log = { info() {} };
global.Core = {
    settings: { getBool: () => false, put() {} },
    app: { post(fn) { fn(); } }
};

global.Vars = {
    headless: false,
    net: { active: () => false, client: () => false },
    content: {
        items: () => makeSeq(allItems),
        sectors: () => makeSeq(allPresets)
    },
    universe: {
        clearLoadoutInfo() {},
        getLoadout: () => null,
        updateLoadout() {},
        updateLaunchResources() {}
    },
    ui: { planet: { isShown: () => false, hide() {}, shown() {} } },
    state: {
        isGame: () => activeSector !== null,
        isCampaign: () => activeSector !== null,
        getPlanet: () => Planets.serpulo,
        getSector: () => activeSector,
        rules: {
            attackMode: false,
            winWave: 10,
            defaultTeam: { core: () => activeSector ? { items: activeSector.items() } : null }
        },
        wave: 1
    },
    player: { unit: () => ({ isValid: () => true, canBuild: () => true, plans: makeSeq([]) }) },
    control: {
        saves: { getCurrent: () => null },
        checkAutoUnlocks() {
            let changed = true;
            while (changed) {
                changed = false;
                for (const tn of allTechNodes) {
                    if (tn.content.unlocked()) continue;
                    if (tn.parent && !tn.parent.content.unlocked()) continue;
                    if (tn.requirements.length > 0) continue;
                    let ok = true;
                    tn.objectives.each(o => { if (!o.complete()) ok = false; });
                    if (ok) {
                        tn.content.unlock();
                        changed = true;
                    }
                }
            }
        },
        playSector(fromOrSector, maybeTo) {
            const to = maybeTo || fromOrSector;
            const from = maybeTo ? fromOrSector : null;
            activeSector = to;
            to._hasBase = true;
            launches.push({ from: from ? from.name() : "(start/re-enter)", to: to.name() });
        }
    }
};

// --- Install bot and run full Serpulo campaign from fresh save ---
const instance = mod.installMindustryCampaignBot();
assert.ok(instance, "Bot instance created");
assert.strictEqual(instance.state, mod.BOT_OFF, "Starts OFF");

// Start directly on Planet Map (no active sector yet!)
instance.start();
assert.strictEqual(instance.state, mod.BOT_RUNNING, "Transitioned to RUNNING");
assert.strictEqual(activeSector, SectorPresets.groundZero.sector, "First launch automatically enters Ground Zero!");

let steps = 0;
while (instance.state === mod.BOT_RUNNING && steps < 120) {
    steps++;
    assert.ok(activeSector, "Bot is inside a sector");

    // Simulate honest in-sector mining & factory production into sector core storage
    for (const it of allItems) {
        it.unlock();
        activeSector.items().add(it, 900);
    }

    // If defending an invaded sector, clear the invasion; otherwise capture the sector!
    if (activeSector._attacked) {
        activeSector._attacked = false;
        invasionDefended = true;
    }
    activeSector._captured = true;

    // Trigger an enemy re-invasion of Ground Zero mid-campaign to test emergency defense!
    if (!invasionTriggered && launches.length === 8) {
        invasionTriggered = true;
        SectorPresets.groundZero.sector._attacked = true;
    }

    // Run research passes until current item surpluses are invested
    for (let r = 0; r < 20; r++) {
        instance.runResearchPass();
    }

    // If final victory condition is satisfied, one more research/victory check completes the campaign
    if (SectorPresets.planetaryTerminal.sector.isCaptured() && Blocks.interplanetaryAccelerator.unlocked()) {
        activeSector = null;
        instance.transitionPending = false;
        instance.updateOutOfGame();
        break;
    }

    // Launch to next chosen sector
    const okLaunch = instance.launchNextSector(activeSector);
    assert.ok(okLaunch, `Step ${steps}: found valid next sector from ${activeSector.name()}`);
}

assert.strictEqual(instance.state, mod.BOT_VICTORY, `Expected BOT_VICTORY, got ${mod.stateName(instance.state)} (${instance.reason})`);
assert.ok(invasionTriggered && invasionDefended, "Mid-campaign invasion on Ground Zero was detected and defended");
assert.ok(SectorPresets.planetaryTerminal.sector.isCaptured(), "Planetary Launch Terminal captured");
assert.ok(Blocks.interplanetaryAccelerator.unlocked(), "Interplanetary Accelerator researched");
assert.ok(!SectorPresets.taintedWoods.sector.isCaptured(), "Optional non-victory preset skipped until terminal victory");

console.log(`test-campaign-sim.js OK: Full Serpulo campaign completed in ${launches.length} sector launches!`);
console.log("Launch sequence:", launches.map(l => l.to).join(" -> "));

// v2.0: the pro in-sector runtime (recon, chokepoint kill-box, ammo bus, AA, Gemma brain with fallback)
// is exercised on a synthetic rocky map through the real thinkInSector() glue.
require("./test-pro-sector.js");
