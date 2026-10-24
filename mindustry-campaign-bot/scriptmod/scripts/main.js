/*
 * Serpulo Campaign Bot (ZIP) — standalone Mindustry v8 campaign auto-player.
 *
 * Mirrors the Java mod (campaignbot.*) 1-to-1 on Mindustry's Rhino JS API:
 * - Campaign-level Research & Planet Director: honestly unlocks TechNodes using
 *   stored items across non-frozen Serpulo bases, tracks the full dependency
 *   graph to Planetary Launch Terminal & Interplanetary Accelerator, defends
 *   invaded sectors, and launches between sectors paying real core + cargo costs.
 * - In-sector AI: Core upgrades (Shard -> Foundation -> Nucleus) + Vaults,
 *   multi-tier drills + conveyors, thermal/steam/combustion/RTG/solar power +
 *   automatic PowerNode linking, Core-hub Unloader + Crafter industrial chains
 *   (graphite, silicon, metaglass, spores, oil, plastanium, cryofluid, pyratite,
 *   blast compound, phase fabric, surge alloy), multi-tier fortresses, UnitFactory
 *   + Reconstructor T1->T2->T3 chains, and RTS CommandAI squad assaults.
 * - Client-only (`hidden: true`) and strictly refuses to act in multiplayer.
 *
 * v2.0.1: Rhino exposes Java *fields* before methods, so `unit.dead` is a boolean
 * in game even though the compiled Java mod calls `unit.dead()`. Every unit
 * accessor now goes through readMember()/unitDead()/unitFlying()/... and every
 * update stage runs inside loopSafe(), which logs a failure once and keeps the
 * game (and the campaign) running.
 */

// ------------------------------------------------------------------ states

var BOT_OFF = 0;
var BOT_RUNNING = 1;
var BOT_PAUSED = 2;
var BOT_NEEDS_HELP = 3;
var BOT_VICTORY = 4;

var CMD_START = 0;
var CMD_PAUSE = 1;
var CMD_STOP = 2;
var CMD_FAIL = 3;
var CMD_VICTORY = 4;

var ACT_WAIT = 0;
var ACT_UPGRADE_CORE = 1;
var ACT_REARM = 2;
var ACT_POWER = 3;
var ACT_DEFEND = 4;
var ACT_REBUILD = 5;
var ACT_DRILL = 6;
var ACT_INDUSTRY = 7;
var ACT_ARMY = 8;
var ACT_COURIER = 9;
var ACT_CALL_WAVE = 10;
var ACT_MINE = 11;
var ACT_READY_NEXT_SECTOR = 12;

var SQUAD_RALLY = 0;
var SQUAD_ASSAULT = 1;
var SQUAD_DEFEND = 2;

var CELL_FREE = 0;
var CELL_BLOCKED = 1;
var CELL_CORE = 2;

var ROLE_WALL = 0;
var ROLE_GROUND_TURRET = 1;
var ROLE_AIR_TURRET = 2;
var ROLE_SUPPORT = 3;
var ROLE_POWER_NODE = 4;

var DECISION_INTERVAL_TICKS = 45;
var WINDOW_RADIUS = 44;
var MAX_CONVEYOR_PATH = 38;
var MAX_PLANS_PER_CYCLE = 42;
var MAX_DEFENSE_PLANS_PER_CYCLE = 6;
var MAX_DRILLS = 24;
var COPPER_RESERVE = 50;
var LEAD_RESERVE = 30;
var REARM_FRACTION = 0.40;
var MIN_AMMO_STOCK = 12;
var WAVE_CALL_COOLDOWN_SEC = 14;
var EARLY_CALL_MIN_TIMER_SEC = 12;
var MIN_CORE_HEALTH_FOR_WAVE = 0.82;
var STALL_SECONDS = 55;
var MAX_FAILURES = 6;
var RESPAWN_WAIT_SECONDS = 35;
var MAX_SECTOR_LOSSES = 3;
var POST_CAPTURE_MAX_HOLD_SEC = 210;

var DX = [1, 0, -1, 0];
var DY = [0, 1, 0, -1];

var PREF_ENABLED = "scb-campaign-autopilot-enabled";

// ------------------------------------------------------------ pure helpers

function stateName(state) {
    if (state === BOT_RUNNING) return "РАБОТАЕТ";
    if (state === BOT_PAUSED) return "ПАУЗА";
    if (state === BOT_NEEDS_HELP) return "НУЖНА ПОМОЩЬ";
    if (state === BOT_VICTORY) return "КАМПАНИЯ ПРОЙДЕНА";
    return "ВЫКЛ";
}

function stateColor(state) {
    if (state === BOT_RUNNING) return "green";
    if (state === BOT_PAUSED) return "yellow";
    if (state === BOT_NEEDS_HELP) return "scarlet";
    if (state === BOT_VICTORY) return "accent";
    return "lightgray";
}

function transition(state, cmd) {
    if (cmd === CMD_START) return BOT_RUNNING;
    if (cmd === CMD_PAUSE) return state === BOT_RUNNING ? BOT_PAUSED : state;
    if (cmd === CMD_STOP) return BOT_OFF;
    if (cmd === CMD_FAIL) return (state === BOT_RUNNING || state === BOT_PAUSED) ? BOT_NEEDS_HELP : state;
    if (cmd === CMD_VICTORY) return (state === BOT_RUNNING || state === BOT_PAUSED) ? BOT_VICTORY : state;
    return state;
}

function guardReason(g) {
    if (!g) return "нет состояния игры";
    if (g.netActive) return "сетевая игра — автопрохождение работает только локально";
    if (!g.inGame) return null;
    if (!g.campaign) return "открыта не кампания — откройте карту планеты Serpulo";
    if (g.planet !== "serpulo") return "текущая планета не Serpulo";
    if (g.canBuild === false) return "текущий юнит не умеет строить";
    return null;
}

// ------------------------------------------------ Rhino field/method safety

/**
 * Reads a Mindustry member that may be exposed as a plain field OR as a
 * no-argument method.
 *
 * In the compiled Java mod every accessor is a real method (`unit.dead()`),
 * but Rhino (the in-game script engine) resolves a *field* first and a boolean
 * field shadows the method with the same name. That is exactly what crashed
 * v2.0 in game: `TypeError: Cannot call property dead in object Unit#1816:flare
 * ... it is "boolean"`. Reading through this helper works in both worlds:
 * a function is called, a field is returned as-is, anything that throws
 * yields `undefined` instead of taking the whole update loop down.
 */
function readMember(obj, name) {
    if (!obj) return undefined;
    var value;
    try { value = obj[name]; } catch (e) { return undefined; }
    if (typeof value === "function") {
        try { return value.call(obj); } catch (e) { return undefined; }
    }
    return value;
}

/** True when a unit is dead/gone. Works with `dead` as boolean field or as method. */
function unitDead(u) {
    if (!u) return true;
    var d = readMember(u, "dead");
    if (d === true) return true;
    var hp = readMember(u, "health");
    if (typeof hp === "number" && hp <= 0) return true;
    return false;
}

/** True when a unit is alive and still valid (Rhino-safe counterpart of `u.isValid()`). */
function unitAlive(u) {
    if (!u || unitDead(u)) return false;
    return readMember(u, "isValid") !== false;
}

/** True when `isFlying` is either a boolean field or a method returning true. */
function unitFlying(u) {
    return readMember(u, "isFlying") === true;
}

/** True when a unit accepts RTS commands (`isCommandable` as field or method). */
function unitCommandable(u) {
    return readMember(u, "isCommandable") === true;
}

/** True when the player pawn is dead (in Rhino `dead` is a boolean field). */
function playerDead(p) {
    if (!p) return true;
    return readMember(p, "dead") === true;
}

/** Safe `isValid()` for any game object (units, buildings, plans). */
function memberValid(o) {
    if (!o) return false;
    return readMember(o, "isValid") !== false;
}

var ESSENTIAL_TIER_3 = {
    "conveyor": 1, "junction": 1, "router": 1, "item-bridge": 1, "titanium-conveyor": 1,
    "container": 1, "unloader": 1, "vault": 1,
    "mechanical-drill": 1, "pneumatic-drill": 1, "laser-drill": 1, "blast-drill": 1,
    "mechanical-pump": 1, "conduit": 1, "water-extractor": 1, "cultivator": 1,
    "graphite-press": 1, "silicon-smelter": 1, "kiln": 1, "spore-press": 1,
    "coal-centrifuge": 1, "plastanium-compressor": 1, "cryofluid-mixer": 1,
    "surge-smelter": 1, "phase-weaver": 1,
    "combustion-generator": 1, "power-node": 1, "power-node-large": 1, "battery": 1,
    "steam-generator": 1, "thermal-generator": 1, "thorium-reactor": 1, "impact-reactor": 1,
    "duo": 1, "scatter": 1, "copper-wall": 1, "copper-wall-large": 1,
    "titanium-wall": 1, "titanium-wall-large": 1, "mender": 1, "mend-projector": 1,
    "hail": 1, "arc": 1, "lancer": 1, "salvo": 1, "ripple": 1, "swarmer": 1, "cyclone": 1, "spectre": 1,
    "ground-factory": 1, "dagger": 1, "mace": 1, "fortress": 1,
    "air-factory": 1, "flare": 1, "horizon": 1, "zenith": 1, "mono": 1, "poly": 1, "mega": 1,
    "naval-factory": 1, "risso": 1, "minke": 1, "bryde": 1, "sei": 1, "omura": 1, "retusa": 1, "oxynoe": 1,
    "additive-reconstructor": 1, "multiplicative-reconstructor": 1,
    "exponential-reconstructor": 1, "tetrative-reconstructor": 1,
    "core-foundation": 1, "core-nucleus": 1, "payload-conveyor": 1,
    "mass-driver": 1, "advanced-launch-pad": 1, "interplanetary-accelerator": 1
};

var ESSENTIAL_TIER_2 = {
    "scorch": 1, "wave": 1, "meltdown": 1, "force-projector": 1, "overdrive-projector": 1,
    "rtg-generator": 1, "solar-panel": 1, "pyratite-mixer": 1, "blast-mixer": 1,
    "pulverizer": 1, "multi-press": 1, "oil-extractor": 1,
    "plastanium-wall": 1, "thorium-wall": 1, "surge-wall": 1,
    "nova": 1, "pulsar": 1, "quasar": 1, "crawler": 1, "atrax": 1, "spiroct": 1, "arkyid": 1, "door": 1
};

function essentialTechTier(name) {
    if (!name) return 1;
    if (ESSENTIAL_TIER_3[name]) return 3;
    if (ESSENTIAL_TIER_2[name]) return 2;
    return 1;
}

function computeCriticalTechMask(nodes, finalGoalIndex) {
    var n = nodes ? nodes.length : 0;
    var critical = [];
    var i, j, dep;
    for (i = 0; i < n; i++) critical[i] = false;
    var queue = [];
    var head = 0;
    var anyFrontier = false;

    for (i = 0; i < n; i++) {
        var node = nodes[i];
        if (!node || !node.isSectorPreset || node.unlocked) continue;
        var parentReady = node.parent < 0 || node.parent >= n || nodes[node.parent].unlocked;
        if (parentReady && node.nonResearchObjectivesMet !== false) {
            anyFrontier = true;
            var deps = node.researchDeps || [];
            for (j = 0; j < deps.length; j++) {
                dep = deps[j];
                if (dep >= 0 && dep < n && !critical[dep]) {
                    critical[dep] = true;
                    queue.push(dep);
                }
            }
        }
    }

    if (!anyFrontier) {
        for (i = 0; i < n; i++) {
            var nd = nodes[i];
            if (!nd || !nd.isSectorPreset || nd.unlocked) continue;
            var ds = nd.researchDeps || [];
            for (j = 0; j < ds.length; j++) {
                dep = ds[j];
                if (dep >= 0 && dep < n && !critical[dep]) {
                    critical[dep] = true;
                    queue.push(dep);
                }
            }
        }
    }

    if (finalGoalIndex >= 0 && finalGoalIndex < n && !nodes[finalGoalIndex].unlocked && !critical[finalGoalIndex]) {
        critical[finalGoalIndex] = true;
        queue.push(finalGoalIndex);
    }

    while (head < queue.length) {
        var cur = queue[head++];
        var info = nodes[cur];
        if (!info) continue;
        if (info.parent >= 0 && info.parent < n && !nodes[info.parent].unlocked && !critical[info.parent]) {
            critical[info.parent] = true;
            queue.push(info.parent);
        }
        var rdeps = info.researchDeps || [];
        for (j = 0; j < rdeps.length; j++) {
            dep = rdeps[j];
            if (dep >= 0 && dep < n && !nodes[dep].unlocked && !critical[dep]) {
                critical[dep] = true;
                queue.push(dep);
            }
        }
    }
    return critical;
}

function isSpendableNow(node, all) {
    if (!node || node.unlocked || node.isSectorPreset) return false;
    if (node.parent >= 0 && node.parent < all.length && !all[node.parent].unlocked) return false;
    if (node.allObjectivesMet === false) return false;
    return !!(node.canAffordAny || node.remainingCost <= 0);
}

function compareResearch(a, critA, b, critB) {
    if (critA !== critB) return critA ? -1 : 1;
    if (!!a.canFinishNow !== !!b.canFinishNow) return a.canFinishNow ? -1 : 1;
    var ta = a.essentialTier || 1, tb = b.essentialTier || 1;
    if (ta !== tb) return tb - ta;
    if (a.remainingCost !== b.remainingCost) return a.remainingCost - b.remainingCost;
    return (a.index || 0) - (b.index || 0);
}

function rankResearchNodes(nodes, finalGoalIndex) {
    if (!nodes || !nodes.length) return [];
    var crit = computeCriticalTechMask(nodes, finalGoalIndex === undefined ? -1 : finalGoalIndex);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
        if (isSpendableNow(nodes[i], nodes)) out.push(i);
    }
    for (var k = 1; k < out.length; k++) {
        var cur = out[k];
        var j = k - 1;
        while (j >= 0 && compareResearch(nodes[cur], crit[cur], nodes[out[j]], crit[out[j]]) < 0) {
            out[j + 1] = out[j];
            j--;
        }
        out[j + 1] = cur;
    }
    return out;
}

function chooseNextSector(sectors) {
    if (!sectors || !sectors.length) return -1;
    var bestIdx = -1;
    var bestScore = -1e15;
    for (var i = 0; i < sectors.length; i++) {
        var s = sectors[i];
        if (!s || (s.losses || 0) >= MAX_SECTOR_LOSSES) continue;
        var score = -1e15;
        if (s.hasBase && s.underAttack) {
            score = (s.isPreset ? 900000 : 350000) - Math.round((s.difficulty || 0) * 500);
        } else if (s.isPreset && !s.captured && s.unlocked && s.canLaunchNow) {
            if (s.isFinalSector) {
                score = 700000;
            } else {
                score = (s.onVictoryPath ? 800000 : 500000)
                    - Math.round((s.difficulty || 0) * 4000)
                    - (s.hasEnemyBase ? 1200 : 0)
                    + (s.hasBase ? 2500 : 0)
                    - (s.losses || 0) * 10000;
            }
        } else if (s.captured && s.hasBase && (s.farmingScore || 0) > 0) {
            score = 100000 + s.farmingScore * 100;
        }
        if (score > bestScore) {
            bestScore = score;
            bestIdx = i;
        }
    }
    return bestScore <= -1e14 ? -1 : bestIdx;
}

function shouldHoldCapturedSector(
    anotherUnderAttack,
    hasLaunchablePresetNow,
    launchOriginCanAffordCore,
    sectorProducesNeededTechItem,
    coreFillFraction,
    heldSeconds
) {
    if (anotherUnderAttack) return false;
    if (coreFillFraction >= 0.88) return false;
    if (!launchOriginCanAffordCore && heldSeconds < POST_CAPTURE_MAX_HOLD_SEC * 1.5) return true;
    if (!hasLaunchablePresetNow && sectorProducesNeededTechItem && heldSeconds < POST_CAPTURE_MAX_HOLD_SEC * 2) {
        return true;
    }
    if (sectorProducesNeededTechItem && heldSeconds < POST_CAPTURE_MAX_HOLD_SEC) return true;
    return false;
}

function canSurviveWave(defenseDps, defensePoolHp, waveHp, waveDps, safetyFactor) {
    if (waveHp <= 0) return defenseDps >= 15;
    var effDefDps = Math.max(1, defenseDps * 0.55);
    if (effDefDps <= 8) return false;
    var killTime = waveHp / effDefDps;
    if (killTime > 28) return false;
    var incoming = waveDps * 0.35 * 0.65 * killTime * safetyFactor;
    return defensePoolHp > Math.max(220, incoming);
}

function waveCallProblem(o) {
    if (!o.waves || !o.waveSending) return "вызов волн недоступен";
    if (o.attackMode) return "режим штурма базы — лишние волны не вызываем";
    if (o.winWave > 0 && o.wave >= o.winWave) {
        return o.enemies > 0 ? "добиваем финальную волну" : "ждём зачёта сектора";
    }
    if (o.enemies > 0 || o.spawning) return "идёт бой с текущей волной";
    if ((o.coreHealthFrac === undefined ? 1 : o.coreHealthFrac) < MIN_CORE_HEALTH_FOR_WAVE) {
        return "ядро повреждено — ждём починки";
    }
    if ((o.secondsSinceWaveCall === undefined ? 1e9 : o.secondsSinceWaveCall) < WAVE_CALL_COOLDOWN_SEC) {
        return "пауза между волнами";
    }
    if (o.priority === "HOLD_AND_RESEARCH" && o.waveTimer) return "стратегия: копим ресурсы и науку, волну не торопим";
    var strongEnough = canSurviveWave(
        o.defenseDps || 0,
        o.defensePoolHp || 0,
        o.nextWaveHp || 0,
        o.nextWaveDps || 0,
        (o.waveTimer ? 2.2 : 1.15) * aggressionSafetyScale(o.aggression)
    );
    if (o.waveTimer) {
        if (o.waveTimeSec >= 0 && o.waveTimeSec < EARLY_CALL_MIN_TIMER_SEC) {
            return "волна скоро придёт по таймеру";
        }
        return strongEnough ? null : "оборона копит запас перед волной";
    }
    return strongEnough ? null : "нужно усилить оборону перед следующей волной";
}

function decideSector(o) {
    if (o.captured && !o.holdAfterCapture) {
        return { action: ACT_READY_NEXT_SECTOR, reason: "сектор захвачен — готов к вылету" };
    }
    if (o.playerAlive === false) {
        return { action: ACT_WAIT, reason: "ждём возрождения юнита ядра" };
    }
    if (o.rearmInProgress) {
        return { action: ACT_REARM, reason: "доставляю боеприпасы в турель" };
    }
    if ((o.buildQueue || 0) > 0) {
        return { action: ACT_WAIT, reason: "строится объектов: " + o.buildQueue };
    }
    if ((o.rearmTargets || 0) > 0) {
        return { action: ACT_REARM, reason: "заряжаю турели (" + o.rearmTargets + ")" };
    }
    if (o.coreUpgradeReady) {
        return { action: ACT_UPGRADE_CORE, reason: "расширяю ядро / хранилище" };
    }
    if (o.powerNeeded && o.powerPossible) {
        return { action: ACT_POWER, reason: "строю генератор / энергосеть" };
    }
    if ((o.rebuildSlots || 0) > 0) {
        return { action: ACT_REBUILD, reason: "восстанавливаю постройки (" + o.rebuildSlots + ")" };
    }
    if ((o.drills || 0) < 3 && o.drillPossible) {
        return { action: ACT_DRILL, reason: "стартовые буры (" + (o.drills || 0) + "/3)" };
    }
    // v2.0 strategic bias: the planner (Gemma or heuristic) can pull industry / army forward
    if (!o.captured && o.priority === "EXPAND_SILICON_ECONOMY" && o.industryPossible && (o.drills || 0) >= 3 && (o.defenseSlots || 0) <= 2) {
        return { action: ACT_INDUSTRY, reason: "стратегия: расширяю кремниевую экономику" };
    }
    if (!o.captured && (o.priority === "BUILD_T3_AIR_FLANK" || o.priority === "BUILD_ARMY") && o.armyPossible && (o.drills || 0) >= 3 && (o.defenseSlots || 0) <= 2) {
        return { action: ACT_ARMY, reason: "стратегия: строю армию (" + o.priority + ")" };
    }
    if (!o.captured && (o.defenseSlots || 0) > 0) {
        return { action: ACT_DEFEND, reason: "укрепляю оборону (" + o.defenseSlots + ")" };
    }
    if ((o.drills || 0) < 8 && o.drillPossible) {
        return { action: ACT_DRILL, reason: "расширяю добычу (" + (o.drills || 0) + "/" + MAX_DRILLS + ")" };
    }
    if (o.industryPossible) {
        return { action: ACT_INDUSTRY, reason: "строю переработку ресурсов" };
    }
    if (o.armyPossible) {
        return { action: ACT_ARMY, reason: o.attackMode ? "строю ударные заводы юнитов" : "строю заводы поддержки" };
    }
    if ((o.drills || 0) < MAX_DRILLS && o.drillPossible) {
        return { action: ACT_DRILL, reason: "дополнительные буры (" + (o.drills || 0) + "/" + MAX_DRILLS + ")" };
    }
    if (o.powerPossible && !o.captured) {
        return { action: ACT_POWER, reason: "наращиваю запас энергии" };
    }
    if (o.courierPossible) {
        return { action: ACT_COURIER, reason: "загружаю завод ресурсами из ядра" };
    }
    if (!o.captured && !o.attackMode) {
        var wp = waveCallProblem(o);
        if (wp === null) {
            return { action: ACT_CALL_WAVE, reason: "вызываю волну " + ((o.wave || 0) + 1) };
        }
        if (o.minePossible) return { action: ACT_MINE, reason: wp };
        return { action: ACT_WAIT, reason: wp };
    }
    if (o.minePossible) {
        return { action: ACT_MINE, reason: o.captured ? "коплю ресурсы для технологий и вылета" : "добываю ресурсы для армии" };
    }
    return { action: ACT_WAIT, reason: o.captured ? "заводы копят ресурсы для технологий" : "готовим штурмовую группу" };
}

function decideSquadMode(attackMode, currentMode, combatUnits, unitCap, enemiesNearBase, sectorDifficulty) {
    if (combatUnits <= 0) return SQUAD_RALLY;
    if (enemiesNearBase > 0 && (!attackMode || combatUnits < 6)) return SQUAD_DEFEND;
    if (!attackMode) return enemiesNearBase > 0 ? SQUAD_DEFEND : SQUAD_RALLY;

    var baseThreshold = sectorDifficulty <= 3 ? 6 : sectorDifficulty <= 5 ? 11 : sectorDifficulty <= 7 ? 16 : 20;
    var launchThreshold = unitCap > 0 ? Math.min(baseThreshold, Math.max(4, Math.floor((unitCap * 3) / 4))) : baseThreshold;
    var retreatThreshold = Math.max(2, Math.floor(launchThreshold / 3));

    if (currentMode === SQUAD_ASSAULT) {
        return combatUnits < retreatThreshold ? SQUAD_RALLY : SQUAD_ASSAULT;
    }
    return combatUnits >= launchThreshold ? SQUAD_ASSAULT : SQUAD_RALLY;
}

function itemWeight(name, needPower, needGraphite, needSilicon, needTitanium, needThorium) {
    if (name === "copper") return 1.0;
    if (name === "lead") return 0.85;
    if (name === "coal") return (needPower || needGraphite || needSilicon) ? 1.15 : 0.65;
    if (name === "sand") return needSilicon ? 0.90 : 0.45;
    if (name === "titanium") return needTitanium ? 1.10 : 0.80;
    if (name === "thorium") return needThorium ? 1.05 : 0.75;
    if (name === "scrap") return 0.25;
    return 0.2;
}

function rankItems(names, stock, available, weights) {
    var result = [];
    for (var i = 0; i < names.length; i++) {
        if (available[i]) result.push(i);
    }
    for (var k = 1; k < result.length; k++) {
        var cur = result[k];
        var wCur = weights && weights[cur] ? Math.max(0.05, weights[cur]) : 0.5;
        var score = stock[cur] / wCur;
        var j = k - 1;
        while (j >= 0) {
            var prev = result[j];
            var wPrev = weights && weights[prev] ? Math.max(0.05, weights[prev]) : 0.5;
            if (stock[prev] / wPrev <= score) break;
            result[j + 1] = prev;
            j--;
        }
        result[j + 1] = cur;
    }
    return result;
}

function sizeOffset(size) {
    return -Math.floor((size - 1) / 2);
}

// ------------------------------------------------ drill + conveyor routing

function coreDistances(w, h, cells, maxPath) {
    var dist = [];
    var queue = [];
    var head = 0;
    for (var i = 0; i < w * h; i++) dist[i] = -1;
    for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
            var idx = y * w + x;
            if (cells[idx] !== CELL_FREE && cells[idx] !== CELL_LANE) continue;
            for (var d = 0; d < 4; d++) {
                var nx = x + DX[d], ny = y + DY[d];
                if (nx >= 0 && ny >= 0 && nx < w && ny < h && cells[ny * w + nx] === CELL_CORE) {
                    dist[idx] = 0;
                    queue.push(idx);
                    break;
                }
            }
        }
    }
    while (head < queue.length) {
        var cur = queue[head++];
        if (dist[cur] >= maxPath - 1) continue;
        var cx = cur % w, cy = Math.floor(cur / w);
        for (var dir = 0; dir < 4; dir++) {
            var rx = cx + DX[dir], ry = cy + DY[dir];
            if (rx < 0 || ry < 0 || rx >= w || ry >= h) continue;
            var n = ry * w + rx;
            if ((cells[n] !== CELL_FREE && cells[n] !== CELL_LANE) || dist[n] !== -1) continue;
            dist[n] = dist[cur] + 1;
            queue.push(n);
        }
    }
    return dist;
}

function countOreInRect(w, ore, x0, y0, size, item) {
    var c = 0;
    for (var dy = 0; dy < size; dy++) {
        for (var dx = 0; dx < size; dx++) {
            if (ore[(y0 + dy) * w + (x0 + dx)] === item) c++;
        }
    }
    return c;
}

function traceConveyorPath(w, h, cells, dist, start, length) {
    var path = [];
    var cell = start;
    for (var step = 0; step < length && cell >= 0; step++) {
        var x = cell % w, y = Math.floor(cell / w);
        var rotation = 0, next = -1;
        for (var d = 0; d < 4; d++) {
            var nx = x + DX[d], ny = y + DY[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            var n = ny * w + nx;
            if (dist[cell] === 0 ? cells[n] === CELL_CORE : dist[n] === dist[cell] - 1) {
                rotation = d;
                next = dist[cell] === 0 ? -1 : n;
                break;
            }
        }
        path.push(x, y, rotation);
        cell = next;
    }
    return path;
}

function findDrillSite(w, h, cells, ore, item, size, maxPath) {
    var dist = coreDistances(w, h, cells, maxPath);
    var offset = sizeOffset(size);
    var minOre = Math.max(2, Math.floor((size * size + 1) / 2));
    var best = null;
    var bestScore = -1e9;
    var bestStart = -1;

    for (var by = 0; by < h; by++) {
        for (var bx = 0; bx < w; bx++) {
            var x0 = bx + offset, y0 = by + offset;
            if (x0 < 0 || y0 < 0 || x0 + size > w || y0 + size > h) continue;
            var target = 0, other = 0, ok = true, touchesCore = false;
            for (var dy = 0; dy < size && ok; dy++) {
                for (var dx = 0; dx < size; dx++) {
                    var idx = (y0 + dy) * w + (x0 + dx);
                    if (cells[idx] !== CELL_FREE) { ok = false; break; }
                    if (ore[idx] === item) target++;
                    else if (ore[idx] >= 0) other = Math.max(other, countOreInRect(w, ore, x0, y0, size, ore[idx]));
                }
            }
            if (!ok || target < minOre || target <= other) continue;

            var startCell = -1, startDist = 1e9;
            for (var edy = -1; edy <= size; edy++) {
                for (var edx = -1; edx <= size; edx++) {
                    var edgeX = edx === -1 || edx === size, edgeY = edy === -1 || edy === size;
                    if (edgeX === edgeY) continue;
                    var nx = x0 + edx, ny = y0 + edy;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    var n = ny * w + nx;
                    if (cells[n] === CELL_CORE) touchesCore = true;
                    else if ((cells[n] === CELL_FREE || cells[n] === CELL_LANE) && dist[n] >= 0 && dist[n] < startDist) {
                        startDist = dist[n];
                        startCell = n;
                    }
                }
            }
            var pathLen = touchesCore ? 0 : (startCell >= 0 ? startDist + 1 : -1);
            if (pathLen < 0 || pathLen > maxPath) continue;
            var score = target * 6 - pathLen * 2 + size * 3;
            if (best === null || score > bestScore) {
                bestScore = score;
                best = { x: bx, y: by, oreCount: target, pathLength: pathLen, path: [] };
                bestStart = touchesCore ? -1 : startCell;
            }
        }
    }
    if (!best) return null;
    best.path = traceConveyorPath(w, h, cells, dist, bestStart, best.pathLength);
    return best;
}

function nearestOreCell(w, h, cells, ore, item, cx, cy, maxDist) {
    for (var r = 0; r <= maxDist; r++) {
        for (var y = cy - r; y <= cy + r; y++) {
            for (var x = cx - r; x <= cx + r; x++) {
                if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue;
                if (x < 0 || y < 0 || x >= w || y >= h) continue;
                var i = y * w + x;
                if (cells[i] === CELL_FREE && ore[i] === item) return i;
            }
        }
    }
    return -1;
}

// ------------------------------- core-hub crafter & reconstructor geometry

function rectFree(w, h, cells, x0, y0, size) {
    if (x0 < 0 || y0 < 0 || x0 + size > w || y0 + size > h) return false;
    for (var dy = 0; dy < size; dy++) {
        for (var dx = 0; dx < size; dx++) {
            if (cells[(y0 + dy) * w + (x0 + dx)] !== CELL_FREE) return false;
        }
    }
    return true;
}

function rectTouches(w, h, cells, x0, y0, size, targetKind) {
    for (var dy = 0; dy < size; dy++) {
        for (var dx = 0; dx < size; dx++) {
            var x = x0 + dx, y = y0 + dy;
            for (var d = 0; d < 4; d++) {
                var nx = x + DX[d], ny = y + DY[d];
                if (nx >= 0 && ny >= 0 && nx < w && ny < h && cells[ny * w + nx] === targetKind) {
                    return true;
                }
            }
        }
    }
    return false;
}

function rectsOverlap(ax0, ay0, aSize, bx0, by0, bSize) {
    return ax0 < bx0 + bSize && ax0 + aSize > bx0 && ay0 < by0 + bSize && ay0 + aSize > by0;
}

function rectsTouchEdge(ax0, ay0, aSize, bx0, by0, bSize) {
    var touchX = (ax0 + aSize === bx0 || bx0 + bSize === ax0) && (ay0 < by0 + bSize && ay0 + aSize > by0);
    var touchY = (ay0 + aSize === by0 || by0 + bSize === ay0) && (ax0 < bx0 + bSize && ax0 + aSize > bx0);
    return touchX || touchY;
}

function countFreeCorePerimeter(w, h, cells) {
    var count = 0;
    for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
            if (cells[y * w + x] !== CELL_FREE && cells[y * w + x] !== CELL_LANE) continue;
            for (var d = 0; d < 4; d++) {
                var nx = x + DX[d], ny = y + DY[d];
                if (nx >= 0 && ny >= 0 && nx < w && ny < h && cells[ny * w + nx] === CELL_CORE) {
                    count++;
                    break;
                }
            }
        }
    }
    return count;
}

function findUnloaderCell(w, h, cells, x0, y0, size) {
    for (var dy = -1; dy <= size; dy++) {
        for (var dx = -1; dx <= size; dx++) {
            var edgeX = dx === -1 || dx === size, edgeY = dy === -1 || dy === size;
            if (edgeX === edgeY) continue;
            var ux = x0 + dx, uy = y0 + dy;
            if (ux < 0 || uy < 0 || ux >= w || uy >= h) continue;
            if (cells[uy * w + ux] !== CELL_FREE && cells[uy * w + ux] !== CELL_LANE) continue;
            for (var d = 0; d < 4; d++) {
                var nx = ux + DX[d], ny = uy + DY[d];
                if (nx >= 0 && ny >= 0 && nx < w && ny < h && cells[ny * w + nx] === CELL_CORE) {
                    return uy * w + ux;
                }
            }
        }
    }
    return -1;
}

function findSupportBlockOrigin(w, h, cells, cx0, cy0, cSize, ux, uy, sSize) {
    var sOff = sizeOffset(sSize);
    for (var sy = cy0 - sSize; sy <= cy0 + cSize + sSize; sy++) {
        for (var sx = cx0 - sSize; sx <= cx0 + cSize + sSize; sx++) {
            var sx0 = sx + sOff, sy0 = sy + sOff;
            if (!rectFree(w, h, cells, sx0, sy0, sSize)) continue;
            if (rectsOverlap(cx0, cy0, cSize, sx0, sy0, sSize)) continue;
            if (ux >= 0 && ux >= sx0 && ux < sx0 + sSize && uy >= sy0 && uy < sy0 + sSize) continue;
            if (rectsTouchEdge(cx0, cy0, cSize, sx0, sy0, sSize)) {
                return sy * w + sx;
            }
        }
    }
    return -1;
}

function findHubCrafterSlot(w, h, cells, ore, crafterSize, withUnloader, supportSize) {
    var freeEdges = countFreeCorePerimeter(w, h, cells);
    var needed = 1 + (withUnloader ? 1 : 0);
    if (freeEdges - needed < 2) return null;

    var offset = sizeOffset(crafterSize);
    var best = null;
    var bestPenalty = 1e9;

    for (var cy = 1; cy < h - 1; cy++) {
        for (var cx = 1; cx < w - 1; cx++) {
            var x0 = cx + offset, y0 = cy + offset;
            if (!rectFree(w, h, cells, x0, y0, crafterSize)) continue;
            if (!rectTouches(w, h, cells, x0, y0, crafterSize, CELL_CORE)) continue;

            var ux = -1, uy = -1;
            if (withUnloader) {
                var uCell = findUnloaderCell(w, h, cells, x0, y0, crafterSize);
                if (uCell < 0) continue;
                ux = uCell % w;
                uy = Math.floor(uCell / w);
            }

            var sx = -1, sy = -1;
            if (supportSize > 0) {
                var sCell = findSupportBlockOrigin(w, h, cells, x0, y0, crafterSize, ux, uy, supportSize);
                if (sCell < 0) continue;
                sx = sCell % w;
                sy = Math.floor(sCell / w);
            }

            var penalty = 0;
            if (ore) {
                for (var dy = 0; dy < crafterSize; dy++) {
                    for (var dx = 0; dx < crafterSize; dx++) {
                        if (ore[(y0 + dy) * w + (x0 + dx)] >= 0) penalty += 10;
                    }
                }
                if (withUnloader && ore[uy * w + ux] >= 0) penalty += 5;
            }
            if (penalty < bestPenalty) {
                bestPenalty = penalty;
                best = {
                    crafterX: cx, crafterY: cy,
                    hasUnloader: !!withUnloader, unloaderX: ux, unloaderY: uy,
                    hasSupport: supportSize > 0, supportX: sx, supportY: sy
                };
            }
        }
    }
    return best;
}

function findUnitChainSlot(w, h, cells, coreWinX, coreWinY, allowUnloader, wantAdditive, wantMultiplicative) {
    var fOff = sizeOffset(3);
    var mOff = sizeOffset(5);

    for (var pass = allowUnloader ? 0 : 1; pass <= 1; pass++) {
        for (var r = 3; r <= 15; r++) {
            for (var fy = coreWinY - r; fy <= coreWinY + r; fy++) {
                for (var fx = coreWinX - r; fx <= coreWinX + r; fx++) {
                    if (Math.max(Math.abs(fx - coreWinX), Math.abs(fy - coreWinY)) !== r) continue;
                    var fx0 = fx + fOff, fy0 = fy + fOff;
                    if (!rectFree(w, h, cells, fx0, fy0, 3)) continue;

                    var ux = -1, uy = -1;
                    if (pass === 0) {
                        var uCell = findUnloaderCell(w, h, cells, fx0, fy0, 3);
                        if (uCell < 0) continue;
                        ux = uCell % w;
                        uy = Math.floor(uCell / w);
                    }

                    for (var rot = 0; rot < 4; rot++) {
                        var ax = fx + DX[rot] * 3, ay = fy + DY[rot] * 3;
                        var mx = ax + DX[rot] * 4, my = ay + DY[rot] * 4;
                        var exitX, exitY;

                        if (wantAdditive) {
                            var ax0 = ax + fOff, ay0 = ay + fOff;
                            if (!rectFree(w, h, cells, ax0, ay0, 3)) continue;
                            if (ux >= 0 && ux >= ax0 && ux < ax0 + 3 && uy >= ay0 && uy < ay0 + 3) continue;
                            if (wantMultiplicative) {
                                var mx0 = mx + mOff, my0 = my + mOff;
                                if (!rectFree(w, h, cells, mx0, my0, 5)) continue;
                                if (ux >= 0 && ux >= mx0 && ux < mx0 + 5 && uy >= my0 && uy < my0 + 5) continue;
                                exitX = mx + DX[rot] * 3;
                                exitY = my + DY[rot] * 3;
                            } else {
                                exitX = ax + DX[rot] * 2;
                                exitY = ay + DY[rot] * 2;
                            }
                        } else {
                            exitX = fx + DX[rot] * 2;
                            exitY = fy + DY[rot] * 2;
                        }

                        if (exitX < 0 || exitY < 0 || exitX >= w || exitY >= h) continue;
                        if (cells[exitY * w + exitX] !== CELL_FREE) continue;
                        if (exitX === ux && exitY === uy) continue;

                        return {
                            rotation: rot,
                            factoryX: fx, factoryY: fy,
                            hasUnloader: ux >= 0, unloaderX: ux, unloaderY: uy,
                            hasAdditive: !!wantAdditive, additiveX: ax, additiveY: ay,
                            hasMultiplicative: !!(wantAdditive && wantMultiplicative),
                            multiplicativeX: mx, multiplicativeY: my
                        };
                    }
                }
            }
        }
    }
    return null;
}

function buildFortressTemplate(cx, cy, dirX, dirY) {
    var len = Math.sqrt(dirX * dirX + dirY * dirY);
    var fx = len < 1e-4 ? 1 : dirX / len;
    var fy = len < 1e-4 ? 0 : dirY / len;
    var sx, sy, px, py;
    if (Math.abs(fx) >= Math.abs(fy)) {
        sx = fx >= 0 ? 1 : -1; sy = 0; px = 0; py = 1;
    } else {
        sx = 0; sy = fy >= 0 ? 1 : -1; px = 1; py = 0;
    }
    var rel = [
        [2, -3, ROLE_WALL], [2, -2, ROLE_WALL], [2, -1, ROLE_WALL], [2, 0, ROLE_WALL],
        [2, 1, ROLE_WALL], [2, 2, ROLE_WALL], [2, 3, ROLE_WALL],
        [0, -2, ROLE_GROUND_TURRET], [0, 0, ROLE_GROUND_TURRET], [0, 2, ROLE_GROUND_TURRET], [0, 4, ROLE_GROUND_TURRET],
        [-2, -2, ROLE_AIR_TURRET], [-2, 2, ROLE_AIR_TURRET], [-2, -4, ROLE_AIR_TURRET],
        [-1, 0, ROLE_SUPPORT],
        [-3, 0, ROLE_POWER_NODE]
    ];
    var out = [];
    for (var i = 0; i < rel.length; i++) {
        out.push(
            cx + sx * rel[i][0] + px * rel[i][1],
            cy + sy * rel[i][0] + py * rel[i][1],
            rel[i][2]
        );
    }
    return out;
}

function createWatchdog() {
    return {
        lastProgressSec: NaN,
        lastToken: -1,
        failures: 0,
        failKey: "",
        stalled: function (busy, token, nowSec) {
            if (!busy || token !== this.lastToken || isNaN(this.lastProgressSec)) {
                this.lastToken = token;
                this.lastProgressSec = nowSec;
                return false;
            }
            return nowSec - this.lastProgressSec >= STALL_SECONDS;
        },
        fail: function (key) {
            if (key === this.failKey) this.failures++;
            else { this.failKey = key || ""; this.failures = 1; }
            return this.failures >= MAX_FAILURES;
        },
        success: function () {
            this.failures = 0;
            this.failKey = "";
        },
        reset: function () {
            this.success();
            this.lastToken = -1;
            this.lastProgressSec = NaN;
        }
    };
}

function formatHudText(state, capturedPresets, totalPresets, sectorTitle, phaseText, researchText, armyText, detailText, thoughtLine) {
    var lines = [];
    lines.push("[" + stateColor(state) + "]🤖 Автокампания Serpulo: " + stateName(state)
        + "[] [lightgray](" + capturedPresets + "/" + totalPresets + " сюж.)[]");
    if (sectorTitle) lines.push("📍 Сектор: [white]" + sectorTitle + "[]");
    if (phaseText) lines.push("⚙ Задача: [accent]" + phaseText + "[]");
    if (researchText) lines.push("🔬 Наука: [lightgray]" + researchText + "[]");
    if (armyText) lines.push("⚔ Армия: [lightgray]" + armyText + "[]");
    if (detailText) lines.push("💬 [lightgray]" + detailText + "[]");
    if (thoughtLine) lines.push(thoughtLine);
    return lines.join("\n");
}

// ============================================================================
// v2.0 PRO LOGIC — pure deterministic algorithms (no Mindustry dependencies).
// Terrain analysis -> chokepoints -> kill-box fortress -> ammo bus -> AA umbrella
// -> reactor safety -> wave recon -> core zoning -> after-action heat map ->
// danger-map flank routing -> assault priorities -> unit tier chains.
// Mirrored 1:1 by campaignbot/ProLogic.java.
// ============================================================================

var CELL_LANE = 5;

var ROLE_WALL_WINDOW = 5;
var ROLE_WALL_INNER = 6;
var ROLE_FRONT_TURRET = 7;
var ROLE_FORCE = 8;
var ROLE_OVERDRIVE = 9;
var ROLE_LIQUID_TURRET = 10;
var ROLE_POINT_DEFENSE = 11;

var ZONE_NONE = 0;
var ZONE_NUCLEUS = 1;
var ZONE_LANE = 2;
var KIND_CONVEYOR = 0;
var KIND_LOGISTICS = 1;
var KIND_OTHER = 2;

var BUS_CONVEYOR = 0;
var BUS_ROUTER = 1;
var BUS_JUNCTION = 2;
var BUS_UNLOADER = 3;

var CHOKE_MIN_DIST = 15;
var CHOKE_MAX_DIST = 45;
var CHOKE_MIN_WIDTH = 3;
var CHOKE_MAX_WIDTH = 14;

function fillArray(n, v) {
    var a = new Array(n);
    for (var i = 0; i < n; i++) a[i] = v;
    return a;
}

function inBounds(w, h, x, y) {
    return x >= 0 && y >= 0 && x < w && y < h;
}

// ------------------------------------------------------------ terrain analysis

/** Chebyshev distance transform: distance of every passable cell to the nearest rock / map edge. */
function distanceToWall(w, h, passable) {
    var n = w * h;
    var dist = fillArray(n, -1);
    var queue = new Array(n);
    var head = 0, tail = 0, i, x, y;
    for (i = 0; i < n; i++) {
        if (!passable[i]) { dist[i] = 0; queue[tail++] = i; }
    }
    for (i = 0; i < n; i++) {
        if (!passable[i]) continue;
        x = i % w; y = (i - x) / w;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { dist[i] = 1; queue[tail++] = i; }
    }
    while (head < tail) {
        i = queue[head++];
        x = i % w; y = (i - x) / w;
        for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                var nx = x + dx, ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                var ni = ny * w + nx;
                if (dist[ni] !== -1) continue;
                dist[ni] = dist[i] + 1;
                queue[tail++] = ni;
            }
        }
    }
    return dist;
}

/**
 * Resumable A* over the ground-passability grid (time-sliced so the game thread
 * is never blocked). Costs mimic Mindustry's costGround: +2 next to solid rock.
 */
function createPathSearch(w, h, passable, dist, sx, sy, tx, ty) {
    var n = w * h;
    var s = { done: false, found: false, expansions: 0, xs: [], ys: [] };
    if (!inBounds(w, h, sx, sy) || !inBounds(w, h, tx, ty) || !passable[sy * w + sx] || !passable[ty * w + tx]) {
        s.done = true;
        return s;
    }
    var g = fillArray(n, 1000000000);
    var parent = fillArray(n, -1);
    var closed = fillArray(n, 0);
    var hIdx = [], hKey = [];
    var hSize = 0;

    function push(idx, key) {
        var i = hSize++;
        hIdx[i] = idx; hKey[i] = key;
        while (i > 0) {
            var p = (i - 1) >> 1;
            if (hKey[p] <= hKey[i]) break;
            var ti = hIdx[p], tk = hKey[p];
            hIdx[p] = hIdx[i]; hKey[p] = hKey[i];
            hIdx[i] = ti; hKey[i] = tk;
            i = p;
        }
    }
    function pop() {
        var top = hIdx[0];
        hSize--;
        if (hSize > 0) {
            hIdx[0] = hIdx[hSize]; hKey[0] = hKey[hSize];
            var i = 0;
            for (;;) {
                var l = 2 * i + 1, r = l + 1, m = i;
                if (l < hSize && hKey[l] < hKey[m]) m = l;
                if (r < hSize && hKey[r] < hKey[m]) m = r;
                if (m === i) break;
                var ti = hIdx[m], tk = hKey[m];
                hIdx[m] = hIdx[i]; hKey[m] = hKey[i];
                hIdx[i] = ti; hKey[i] = tk;
                i = m;
            }
        }
        return top;
    }
    function heur(x, y) {
        var dx = Math.abs(x - tx), dy = Math.abs(y - ty);
        return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
    }

    var start = sy * w + sx, goal = ty * w + tx;
    g[start] = 0;
    push(start, heur(sx, sy));

    s.step = function (maxExpansions) {
        if (s.done) return true;
        var budget = maxExpansions;
        while (hSize > 0 && budget-- > 0) {
            var cur = pop();
            if (closed[cur]) continue;
            closed[cur] = 1;
            s.expansions++;
            if (cur === goal) {
                var path = [];
                for (var c = goal; c !== -1; c = parent[c]) path.push(c);
                path.reverse();
                for (var q = 0; q < path.length; q++) {
                    s.xs.push(path[q] % w);
                    s.ys.push((path[q] - (path[q] % w)) / w);
                }
                s.found = true;
                s.done = true;
                return true;
            }
            var x = cur % w, y = (cur - x) / w;
            for (var dy = -1; dy <= 1; dy++) {
                for (var dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    var nx = x + dx, ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    var ni = ny * w + nx;
                    if (!passable[ni] || closed[ni]) continue;
                    if (dx !== 0 && dy !== 0 && (!passable[y * w + nx] || !passable[ny * w + x])) continue;
                    var step = (dx !== 0 && dy !== 0) ? 14 : 10;
                    if (dist && dist[ni] >= 0 && dist[ni] <= 1) step += 20;
                    var ng = g[cur] + step;
                    if (ng < g[ni]) {
                        g[ni] = ng;
                        parent[ni] = cur;
                        push(ni, ng + heur(nx, ny));
                    }
                }
            }
        }
        if (hSize === 0) s.done = true;
        return s.done;
    };
    return s;
}

function findGroundPath(w, h, passable, dist, sx, sy, tx, ty) {
    var s = createPathSearch(w, h, passable, dist, sx, sy, tx, ty);
    if (s.step) s.step(2000000000);
    return { found: s.found, xs: s.xs, ys: s.ys };
}

/** Passable run (min/max coordinate along the wall line) through (x, y). axis 1 = wall runs along Y. */
function scanRun(w, h, passable, axis, x, y, cap) {
    var c = axis === 1 ? y : x;
    var lo = c, hi = c;
    function ok(v) {
        var px = axis === 1 ? x : v, py = axis === 1 ? v : y;
        return inBounds(w, h, px, py) && !!passable[py * w + px];
    }
    while (hi - lo + 1 <= cap && ok(hi + 1)) hi++;
    while (hi - lo + 1 <= cap && ok(lo - 1)) lo--;
    return { lo: lo, hi: hi, width: hi - lo + 1 };
}

/** Map (p along the wall line, k depth toward enemy) of a chokepoint to tile coordinates. */
function chokePos(ch, p, k) {
    return ch.axis === 1 ? [ch.cx + ch.fwd * k, p] : [p, ch.cy + ch.fwd * k];
}

function distPointToPoint(ax, ay, bx, by) {
    var dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Finds the narrowest 3..14 tile bottleneck on every spawn->core corridor,
 * 15..45 tiles from the core, closed rock-to-rock.
 * paths: [{xs:[], ys:[]}] ordered spawn -> core.
 */
function findChokepoints(w, h, passable, dist, paths, coreX, coreY, opts) {
    opts = opts || {};
    var minD = opts.minDist || CHOKE_MIN_DIST, maxD = opts.maxDist || CHOKE_MAX_DIST;
    var minW = opts.minWidth || CHOKE_MIN_WIDTH, maxW = opts.maxWidth || CHOKE_MAX_WIDTH;
    var found = [];
    for (var pi = 0; pi < paths.length; pi++) {
        var path = paths[pi];
        if (!path || !path.xs || path.xs.length < 10) continue;
        var best = null;
        for (var i = 0; i < path.xs.length; i++) {
            var x = path.xs[i], y = path.ys[i];
            var d = distPointToPoint(x, y, coreX, coreY);
            if (d < minD || d > maxD) continue;
            var j0 = Math.max(0, i - 4), j1 = Math.min(path.xs.length - 1, i + 4);
            var tx = path.xs[j1] - path.xs[j0], ty = path.ys[j1] - path.ys[j0];
            if (tx === 0 && ty === 0) continue;
            var axis, fwd;
            if (Math.abs(tx) >= Math.abs(ty)) { axis = 1; fwd = tx > 0 ? -1 : 1; }
            else { axis = 0; fwd = ty > 0 ? -1 : 1; }
            var run = scanRun(w, h, passable, axis, x, y, 40);
            if (run.width < minW || run.width > maxW) continue;
            var score = run.width * 100 + d * 3;
            if (!best || score < best.score) {
                var idx = y * w + x;
                best = {
                    score: score, axis: axis, fwd: fwd, cx: x, cy: y,
                    lo: run.lo, hi: run.hi, width: run.width,
                    p0: Math.floor((run.lo + run.hi) / 2),
                    dist: d, dtWidth: dist ? 2 * dist[idx] - 1 : run.width, pathIndex: i
                };
            }
        }
        if (!best) continue;
        var dup = false;
        for (var f = 0; f < found.length; f++) {
            if (Math.abs(found[f].cx - best.cx) + Math.abs(found[f].cy - best.cy) <= 10) { dup = true; break; }
        }
        if (!dup) found.push(best);
    }
    found.sort(function (a, b) { return a.score - b.score; });
    return found;
}

/** Eight-way compass name of a direction (y grows to the north, like the Mindustry world). */
function compassFlank(dx, dy) {
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return "any";
    var ang = Math.atan2(dy, dx) * 180 / Math.PI;
    if (ang < 0) ang += 360;
    var names = ["east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"];
    return names[Math.floor((ang + 22.5) / 45) % 8];
}

function flankVector(name) {
    var m = {
        "east": [1, 0], "north-east": [1, 1], "north": [0, 1], "north-west": [-1, 1],
        "west": [-1, 0], "south-west": [-1, -1], "south": [0, -1], "south-east": [1, -1]
    };
    return m[name] || null;
}

// ------------------------------------------------------- kill-box fortress

/**
 * Builds the chokepoint "kill-box" layout. Returns flat 5-tuples
 * [x, y, size, role, layer] (x/y = Mindustry block origin tile) plus the ammo
 * bus spine [x, y, ...] running behind the front turret row.
 *
 * Layers (depth k grows toward the enemy):
 *   walls     k = 0 .. 2*flankLayers-1 (2x2 large walls, singles fill the gaps),
 *             flanks next to the rocks have flankLayers layers, the focus
 *             "bait window" in the middle has one layer less (recessed pocket)
 *             so Mindustry's ground flowfield (wall HP cost) funnels the whole
 *             wave into the crossfire point;
 *   inner     k = -2 .. -1 plastanium layer that absorbs piercing lasers;
 *   front     turret row right behind the inner layer;
 *   bus spine Router/Junction line behind the front row;
 *   main      main strike row on the other side of the spine;
 *   support   menders/projectors, power node, force + overdrive projectors.
 */
function buildKillBox(w, h, passable, ch, opts) {
    opts = opts || {};
    var fs = opts.frontSize || 1, ms = opts.mainSize || 1, ss = opts.supportSize || 1;
    var width = ch.width;
    var flankLayers = opts.flankLayers || (width >= 8 ? 3 : 2);
    var windowLayers = Math.max(1, flankLayers - 1);
    var winW = Math.max(2, 2 * Math.round(width / 6));
    winW = Math.min(winW, Math.max(1, width - 2));
    var p0 = ch.p0;
    var wLo = p0 - Math.floor(winW / 2), wHi = wLo + winW - 1;
    var slots = [];
    var used = {};

    function cellOk(p, k) {
        var xy = chokePos(ch, p, k);
        return inBounds(w, h, xy[0], xy[1]) && !!passable[xy[1] * w + xy[0]];
    }
    function usedKey(p, k) { return p + "," + k; }
    function rowSpan(k) {
        var start = null;
        for (var d = 0; d <= 3 && start === null; d++) {
            if (cellOk(p0 + d, k)) start = p0 + d;
            else if (cellOk(p0 - d, k)) start = p0 - d;
        }
        if (start === null) return null;
        var lo = start, hi = start;
        while (hi - lo < 40 && cellOk(hi + 1, k)) hi++;
        while (hi - lo < 40 && cellOk(lo - 1, k)) lo--;
        return { lo: lo, hi: hi };
    }
    function originOf(pA, pB, kA, kB, size) {
        var a = chokePos(ch, pA, kA), b = chokePos(ch, pB, kB);
        var off = Math.floor((size - 1) / 2);
        return [Math.min(a[0], b[0]) + off, Math.min(a[1], b[1]) + off];
    }
    function footprintOk(pA, pB, kA, kB) {
        for (var p = pA; p <= pB; p++) {
            for (var k = Math.min(kA, kB); k <= Math.max(kA, kB); k++) {
                if (!cellOk(p, k) || used[usedKey(p, k)]) return false;
            }
        }
        return true;
    }
    function markFootprint(pA, pB, kA, kB) {
        for (var p = pA; p <= pB; p++) {
            for (var k = Math.min(kA, kB); k <= Math.max(kA, kB); k++) used[usedKey(p, k)] = true;
        }
    }
    function addBlock(pA, size, kTop, role, layer) {
        // footprint spans p = pA..pA+size-1 and depth kTop-(size-1)..kTop
        var pB = pA + size - 1, kBot = kTop - (size - 1);
        if (!footprintOk(pA, pB, kBot, kTop)) return false;
        markFootprint(pA, pB, kBot, kTop);
        var o = originOf(pA, pB, kBot, kTop, size);
        slots.push(o[0], o[1], size, role, layer);
        return true;
    }

    function wallBand(kLow, layerId, innerBand, layerIndex) {
        var s1 = rowSpan(kLow), s2 = rowSpan(kLow + 1);
        if (!s1 && !s2) return;
        var lo = Math.min(s1 ? s1.lo : 1e9, s2 ? s2.lo : 1e9);
        var hi = Math.max(s1 ? s1.hi : -1e9, s2 ? s2.hi : -1e9);
        if (innerBand) { lo = Math.max(lo, ch.lo - 1); hi = Math.min(hi, ch.hi + 1); }
        else if (layerIndex > 0 && hi - lo + 1 > width + 10) return; // the pass flares into a hall: skip the extra layer
        function skip(p) { return !innerBand && layerIndex >= windowLayers && p >= wLo && p <= wHi; }
        function roleAt(p) {
            if (innerBand) return ROLE_WALL_INNER;
            return (layerIndex < windowLayers && p >= wLo && p <= wHi) ? ROLE_WALL_WINDOW : ROLE_WALL;
        }
        for (var p = lo; p <= hi; p++) {
            if (skip(p)) continue;
            if (!skip(p + 1) && roleAt(p) === roleAt(p + 1)
                && footprintOk(p, p + 1, kLow, kLow + 1)) {
                markFootprint(p, p + 1, kLow, kLow + 1);
                var o = originOf(p, p + 1, kLow, kLow + 1, 2);
                slots.push(o[0], o[1], 2, roleAt(p), layerId);
                continue;
            }
            for (var k = kLow; k <= kLow + 1; k++) {
                if (!cellOk(p, k) || used[usedKey(p, k)]) continue;
                used[usedKey(p, k)] = true;
                var xy = chokePos(ch, p, k);
                slots.push(xy[0], xy[1], 1, roleAt(p), layerId);
            }
        }
    }

    // spine + turret rows first (they claim their cells before walls tile the leftovers)
    var kb = -3 - fs;
    var spine = [];
    var spineLo = 0, spineHi = -1;
    var spanB = rowSpan(kb);
    if (spanB) {
        spineLo = Math.max(spanB.lo, p0 - 8);
        spineHi = Math.min(spanB.hi, p0 + 8);
        if ((spineHi - spineLo + 1) % 2 === 0) spineHi--;
        if (spineHi - spineLo + 1 < 3) { spineLo = 0; spineHi = -1; }
    }
    for (var sp = spineLo; sp <= spineHi; sp++) {
        var sxy = chokePos(ch, sp, kb);
        spine.push(sxy[0], sxy[1]);
        used[usedKey(sp, kb)] = true;
    }
    function rowSlots(size, kTop, role) {
        var ps = [];
        for (var p = spineLo; p + size - 1 <= spineHi; p += 4) ps.push(p);
        ps.sort(function (a, b) {
            return Math.abs(a + (size - 1) / 2 - p0) - Math.abs(b + (size - 1) / 2 - p0);
        });
        var idx = 0;
        for (var i = 0; i < ps.length; i++) {
            if (addBlock(ps[i], size, kTop, role, idx)) idx++;
        }
    }
    if (spine.length) {
        rowSlots(ms, kb - 1, ROLE_GROUND_TURRET);
        rowSlots(fs, -3, ROLE_FRONT_TURRET);
    }

    // support row, power node, force + overdrive projectors
    var supTop = kb - ms - 1;
    var supIdx = 0;
    if (spine.length) {
        for (var q = spineLo + 2; q + ss - 1 <= spineHi; q += 4) {
            if (addBlock(q, ss, supTop, ROLE_SUPPORT, supIdx)) supIdx++;
        }
    }
    var powerK = supTop - ss;
    addBlock(p0, 1, powerK, ROLE_POWER_NODE, 0);
    if (opts.wantForce) addBlock(p0 - 1, 3, powerK - 1, ROLE_FORCE, 0);
    if (opts.wantOverdrive) addBlock(p0 + 3, 2, powerK - 1, ROLE_OVERDRIVE, 0);

    // walls: outer layers (flank thick, window thinner) then inner plastanium layer
    for (var j = 0; j < flankLayers; j++) wallBand(2 * j, j, false, j);
    if (opts.wantInner !== false) wallBand(-2, 100, true, 0);

    return {
        slots: slots, spine: spine, spineLen: spine.length / 2,
        wLo: wLo, wHi: wHi, winW: winW, p0: p0, kb: kb,
        flankLayers: flankLayers, windowLayers: windowLayers
    };
}

/** Wall HP -> Mindustry ground flowfield step cost for enemy units (PathTile.health * 5 / 100). */
function groundPathCostThroughWall(buildingHp) {
    var healthField = Math.min(Math.floor(buildingHp / 40), 80);
    return 1 + Math.floor(healthField * 5 / 100);
}

/**
 * Verifies the kill-box funnel: returns the line coordinate p where the cheapest
 * enemy ground route crosses the wall band (or null when it cannot cross).
 */
function killBoxCrossingP(w, h, passable, ch, slots, wallHp) {
    var cost = fillArray(w * h, 0);
    for (var i = 0; i < w * h; i++) cost[i] = passable[i] ? 10 : -1;
    var wcost = groundPathCostThroughWall(wallHp) * 10;
    for (var s = 0; s + 4 < slots.length; s += 5) {
        var sx = slots[s], sy = slots[s + 1], size = slots[s + 2], role = slots[s + 3];
        if (role === ROLE_POWER_NODE) continue;
        var off = Math.floor((size - 1) / 2);
        for (var dy = 0; dy < size; dy++) {
            for (var dx = 0; dx < size; dx++) {
                var cx = sx - off + dx, cy = sy - off + dy;
                if (inBounds(w, h, cx, cy) && cost[cy * w + cx] > 0) cost[cy * w + cx] = wcost;
            }
        }
    }
    var a = chokePos(ch, ch.p0, 12), b = chokePos(ch, ch.p0, -16);
    var n = w * h;
    var d = fillArray(n, 1000000000), par = fillArray(n, -1), done = fillArray(n, 0);
    var start = a[1] * w + a[0], goal = b[1] * w + b[0];
    if (!inBounds(w, h, a[0], a[1]) || !inBounds(w, h, b[0], b[1]) || cost[start] < 0 || cost[goal] < 0) return null;
    d[start] = 0;
    // simple O(n log n)-free Dijkstra using bucket-less linear scan over a frontier list (maps are tiny in tests)
    var frontier = [start];
    while (frontier.length) {
        var bi = 0;
        for (var f = 1; f < frontier.length; f++) if (d[frontier[f]] < d[frontier[bi]]) bi = f;
        var cur = frontier.splice(bi, 1)[0];
        if (done[cur]) continue;
        done[cur] = 1;
        if (cur === goal) break;
        var x = cur % w, y = (cur - x) / w;
        for (var ey = -1; ey <= 1; ey++) {
            for (var ex = -1; ex <= 1; ex++) {
                if (!ex && !ey) continue;
                var nx = x + ex, ny = y + ey;
                if (!inBounds(w, h, nx, ny)) continue;
                var ni = ny * w + nx;
                if (cost[ni] < 0 || done[ni]) continue;
                if (ex && ey && (cost[y * w + nx] < 0 || cost[ny * w + x] < 0)) continue;
                var nd = d[cur] + cost[ni] * ((ex && ey) ? 1.4 : 1);
                if (nd < d[ni]) { d[ni] = nd; par[ni] = cur; frontier.push(ni); }
            }
        }
    }
    if (!done[goal]) return null;
    var crossings = [];
    for (var c = goal; c !== -1; c = par[c]) {
        var px = c % w, py = (c - px) / w;
        var pp = ch.axis === 1 ? py : px;
        var kk = ch.axis === 1 ? (px - ch.cx) * ch.fwd : (py - ch.cy) * ch.fwd;
        if (kk === 0 || kk === 1) crossings.push(pp);
    }
    if (!crossings.length) return null;
    var sum = 0;
    for (var z = 0; z < crossings.length; z++) sum += crossings[z];
    return sum / crossings.length;
}

// ------------------------------------------------------- anti-air umbrella

/**
 * Anti-air corridor on the straight air vector spawn -> core plus cover slots
 * next to generator/reactor clusters. Returns flat triples [x, y, kind]
 * (kind 0 = vector line, 1 = generator cover). Exact tiles are validated by the caller.
 */
function planAaCorridor(coreX, coreY, spawnX, spawnY, generators, opts) {
    opts = opts || {};
    var count = opts.count || 4;
    var spacing = opts.spacing || 6;
    var dx = spawnX - coreX, dy = spawnY - coreY;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-3) return [];
    var ux = dx / len, uy = dy / len;
    var px = -uy, py = ux;
    var dAa = Math.min(opts.distance || 16, Math.max(8, len * 0.4));
    var cx = coreX + ux * dAa, cy = coreY + uy * dAa;
    var out = [];
    var offsets = [];
    for (var i = 0; i < count; i++) offsets.push((i - (count - 1) / 2) * spacing);
    offsets.sort(function (a, b) { return Math.abs(a) - Math.abs(b); });
    for (var o = 0; o < offsets.length; o++) {
        out.push(Math.round(cx + px * offsets[o]), Math.round(cy + py * offsets[o]), 0);
    }
    // generator clusters (greedy, 8 tile radius, at most 2 clusters)
    var gens = generators || [];
    var clusters = [];
    for (var g = 0; g + 1 < gens.length; g += 2) {
        var placed = false;
        for (var c = 0; c < clusters.length; c++) {
            if (distPointToPoint(gens[g], gens[g + 1], clusters[c].x, clusters[c].y) <= 8) {
                clusters[c].n++;
                placed = true;
                break;
            }
        }
        if (!placed) clusters.push({ x: gens[g], y: gens[g + 1], n: 1 });
    }
    clusters.sort(function (a, b) { return b.n - a.n; });
    for (var k = 0; k < clusters.length && k < 2; k++) {
        var gx = Math.round(clusters[k].x + ux * 4), gy = Math.round(clusters[k].y + uy * 4);
        var dup = false;
        for (var j = 0; j + 2 < out.length; j += 3) {
            if (distPointToPoint(out[j], out[j + 1], gx, gy) < 3) { dup = true; break; }
        }
        if (!dup) out.push(gx, gy, 1);
    }
    return out;
}

// ------------------------------------------------------------ ammo logistics

/** Preferred ammo per turret, best first. Names are Mindustry item names. */
var TURRET_AMMO = {
    "duo": ["silicon", "graphite", "copper"],
    "scatter": ["metaglass", "lead", "scrap"],
    "scorch": ["coal"],
    "hail": ["silicon", "pyratite", "graphite"],
    "salvo": ["thorium", "blast-compound", "silicon", "pyratite", "graphite", "copper"],
    "ripple": ["plastanium", "blast-compound", "pyratite", "silicon", "graphite"],
    "cyclone": ["surge-alloy", "plastanium", "blast-compound", "metaglass"],
    "swarmer": ["surge-alloy", "blast-compound", "pyratite"],
    "spectre": ["thorium", "pyratite", "graphite"],
    "fuse": ["thorium", "titanium", "copper"],
    "foreshadow": ["surge-alloy"]
};

/** Minimum core stock before an item may be used as turret ammo (keeps building reserves). */
var AMMO_MIN_STOCK = {
    "copper": 150, "lead": 120, "graphite": 120, "silicon": 200, "metaglass": 120,
    "coal": 60, "scrap": 60, "pyratite": 120, "blast-compound": 120,
    "plastanium": 250, "thorium": 250, "surge-alloy": 250, "titanium": 250
};

function turretAcceptsAmmo(turret, item) {
    var list = TURRET_AMMO[turret];
    if (!list) return false;
    for (var i = 0; i < list.length; i++) if (list[i] === item) return true;
    return false;
}

function ammoStockOk(item, stock, unlocked) {
    if (unlocked && unlocked[item] === false) return false;
    var need = AMMO_MIN_STOCK[item] || 100;
    return (stock[item] || 0) >= need;
}

/** Best usable ammo for one turret. preferred (e.g. from the AI brain) wins when accepted and stocked. */
function chooseAmmoItem(turret, stock, unlocked, preferred) {
    var list = TURRET_AMMO[turret];
    if (!list) return null;
    if (preferred && turretAcceptsAmmo(turret, preferred) && ammoStockOk(preferred, stock, unlocked)) return preferred;
    for (var i = 0; i < list.length; i++) {
        if (ammoStockOk(list[i], stock, unlocked)) return list[i];
    }
    return null;
}

/** One item for a whole shared bus: accepted by as many turrets as possible, then best-ranked. */
function chooseBusAmmo(turrets, stock, unlocked, preferred) {
    var cands = {};
    var t, i;
    for (t = 0; t < turrets.length; t++) {
        var list = TURRET_AMMO[turrets[t]] || [];
        for (i = 0; i < list.length; i++) {
            if (!cands[list[i]]) cands[list[i]] = { coverage: 0, rank: 0 };
            cands[list[i]].coverage++;
            cands[list[i]].rank += list.length - i;
        }
    }
    var best = null, bestScore = -1;
    var names = Object.keys(cands);
    for (i = 0; i < names.length; i++) {
        var nm = names[i];
        if (!ammoStockOk(nm, stock, unlocked)) continue;
        var score = cands[nm].coverage * 100 + cands[nm].rank + (nm === preferred ? 50 : 0);
        if (score > bestScore) { bestScore = score; best = nm; }
    }
    return best;
}

/** First ladder turret that is available and accepts the bus ammo (or needs no ammo). */
function pickTurretForAmmo(ladder, ammo, available) {
    for (var i = 0; i < ladder.length; i++) {
        var nm = ladder[i];
        if (available && !available[nm]) continue;
        if (!TURRET_AMMO[nm] || turretAcceptsAmmo(nm, ammo)) return nm;
    }
    return null;
}

/** Status-effect synergy of a liquid turret + ammo combination (bonus score and Russian explanation). */
function statusSynergy(liquid, ammo) {
    if (liquid === "cryofluid" && ammo === "blast-compound") return { bonus: 3, text: "заморозка + взрывчатка (шоковый раскол)" };
    if (liquid === "cryofluid") return { bonus: 1, text: "заморозка замедляет волну" };
    if ((liquid === "oil" || liquid === "slag") && ammo === "pyratite") return { bonus: 3, text: "масло/шлак + пиратит (горение)" };
    if (liquid === "water" && (ammo === "arc" || ammo === "lancer")) return { bonus: 2, text: "вода + электричество (шок)" };
    if (liquid === "water") return { bonus: 1, text: "вода тушит и замедляет" };
    return { bonus: 0, text: "" };
}

/**
 * Plans the ammo bus: Unloader (touching the core) -> feeder conveyor (BFS) ->
 * alternating Router/Junction spine along the turret rows.
 * cells: window grid (CELL_FREE / CELL_LANE are buildable); spine: [x,y,...].
 * Returns { ok, reason, pieces: [x, y, type, rot, ...], feederLength }.
 */
function planAmmoBus(w, h, cells, unloader, spine) {
    var res = { ok: false, reason: "", pieces: [], feederLength: 0 };
    var n = spine.length / 2;
    if (n % 2 === 0) n--;
    if (n < 1) { res.reason = "нет места под шину"; return res; }
    var i;
    var buildable = function (x, y) {
        if (!inBounds(w, h, x, y)) return false;
        var c = cells[y * w + x];
        return c === CELL_FREE || c === CELL_LANE;
    };
    var occupied = {};
    for (i = 0; i < n; i++) {
        if (!buildable(spine[i * 2], spine[i * 2 + 1])) { n = i; break; }
    }
    if (n % 2 === 0) n--;
    if (n < 1) { res.reason = "шина упирается в препятствие"; return res; }
    for (i = 0; i < n; i++) occupied[spine[i * 2] + "," + spine[i * 2 + 1]] = true;

    var feeder = [];
    var sx0 = spine[0], sy0 = spine[1];
    if (unloader) {
        if (!buildable(unloader.x, unloader.y)) { res.reason = "нет клетки под Unloader"; return res; }
        occupied[unloader.x + "," + unloader.y] = true;
        // BFS from the free neighbours of the unloader to any cell touching spine[0]
        var prev = {}, queue = [];
        for (var d = 0; d < 4; d++) {
            var qx = unloader.x + DX[d], qy = unloader.y + DY[d];
            var key = qx + "," + qy;
            if (!buildable(qx, qy) || occupied[key] || prev[key] !== undefined) continue;
            prev[key] = "start";
            queue.push([qx, qy]);
        }
        var goalNode = null, head = 0;
        while (head < queue.length) {
            var cur = queue[head++];
            for (var e = 0; e < 4; e++) {
                if (cur[0] + DX[e] === sx0 && cur[1] + DY[e] === sy0) { goalNode = cur; break; }
            }
            if (goalNode) break;
            for (var f = 0; f < 4; f++) {
                var nx = cur[0] + DX[f], ny = cur[1] + DY[f];
                var nk = nx + "," + ny;
                if (!buildable(nx, ny) || occupied[nk] || prev[nk] !== undefined) continue;
                prev[nk] = cur[0] + "," + cur[1];
                queue.push([nx, ny]);
            }
        }
        // unloader directly touches the spine start: no feeder required
        var touches = false;
        for (var t = 0; t < 4; t++) if (unloader.x + DX[t] === sx0 && unloader.y + DY[t] === sy0) touches = true;
        if (!goalNode && !touches) { res.reason = "нет пути конвейера от Unloader к шине"; return res; }
        if (goalNode) {
            var chain = [];
            var ck = goalNode[0] + "," + goalNode[1];
            while (ck !== "start") {
                var parts = ck.split(",");
                chain.push([parseInt(parts[0], 10), parseInt(parts[1], 10)]);
                ck = prev[ck];
            }
            chain.reverse();
            for (var c = 0; c < chain.length; c++) {
                var tx = c + 1 < chain.length ? chain[c + 1][0] : sx0;
                var ty = c + 1 < chain.length ? chain[c + 1][1] : sy0;
                var rot = 0;
                for (var r = 0; r < 4; r++) if (chain[c][0] + DX[r] === tx && chain[c][1] + DY[r] === ty) rot = r;
                feeder.push(chain[c][0], chain[c][1], BUS_CONVEYOR, rot);
            }
        }
        res.pieces.push(unloader.x, unloader.y, BUS_UNLOADER, 0);
    }
    for (i = 0; i < feeder.length; i++) res.pieces.push(feeder[i]);
    res.feederLength = feeder.length / 4;
    for (i = 0; i < n; i++) {
        res.pieces.push(spine[i * 2], spine[i * 2 + 1], i % 2 === 0 ? BUS_ROUTER : BUS_JUNCTION, 0);
    }
    res.ok = true;
    return res;
}

/** Drill-fed variant: finds a drill + conveyor path ending at the spine start (treated as a core cell). */
function planAmmoDrillFeed(w, h, cells, ore, itemIdx, size, spineX, spineY, maxPath) {
    var copy = cells.slice();
    copy[spineY * w + spineX] = CELL_CORE;
    return findDrillSite(w, h, copy, ore, itemIdx, size, maxPath);
}

function rectTouchesCell(x0, y0, size, cx, cy) {
    var inside = cx >= x0 && cx < x0 + size && cy >= y0 && cy < y0 + size;
    if (inside) return false;
    return cx >= x0 - 1 && cx <= x0 + size && cy >= y0 - 1 && cy <= y0 + size && (cx >= x0 && cx < x0 + size || cy >= y0 && cy < y0 + size);
}

// -------------------------------------------------------- reactor safety

/**
 * Thorium Reactor guard: never build without guaranteed cryofluid. Returns null
 * when safe or a Russian reason when placement must be refused.
 * s: { reactorUnlocked, mixerBuilt, mixerCryoFrac, waterOk, titaniumStock, thoriumStock, siteDistFromCore, powerNetPerSec }
 */
function reactorGuard(s) {
    if (!s.reactorUnlocked) return "реактор не изучен";
    if (!s.mixerBuilt) return "сначала Cryofluid Mixer: без охлаждения реактор взорвётся";
    if (!s.waterOk) return "нет воды для криогенного миксера";
    if ((s.titaniumStock || 0) < 80) return "мало титана для криожидкости";
    if ((s.mixerCryoFrac || 0) < 0.5) return "криожидкость ещё не накоплена — жду";
    if ((s.thoriumStock || 0) < 120) return "мало тория для топлива";
    if (s.siteDistFromCore !== undefined && s.siteDistFromCore < 12) return "реактор слишком близко к ядру";
    return null;
}

function reactorShouldCutFuel(heat, cryoFrac) {
    return heat >= 0.45 && cryoFrac < 0.25;
}

/**
 * Finds a reactor site away from the threat: 3x3 reactor + adjacent 2x2 cryofluid
 * mixer + adjacent 2x2 water extractor (window coordinates, reactor by centre).
 */
function findReactorSite(w, h, cells, coreX, coreY, awayX, awayY, minDist, maxDist) {
    var alen = Math.sqrt(awayX * awayX + awayY * awayY) || 1;
    var ax = awayX / alen, ay = awayY / alen;
    var rOff = sizeOffset(3);
    // mixer (2x2) origin relative to the reactor centre for the four sides
    var mixerRel = [[2, -1], [-1, 2], [-3, -1], [-1, -3]];
    var extRel = [[2, 0], [0, 2], [-2, 0], [0, -2]];
    var best = null, bestScore = -1e9;
    for (var ry = 2; ry < h - 2; ry++) {
        for (var rx = 2; rx < w - 2; rx++) {
            var d = distPointToPoint(rx, ry, coreX, coreY);
            if (d < minDist || d > maxDist) continue;
            var dot = ((rx - coreX) * ax + (ry - coreY) * ay) / d;
            if (dot > 0.35) continue; // never toward the enemy
            if (!rectFree(w, h, cells, rx + rOff, ry + rOff, 3)) continue;
            var found = false;
            for (var side = 0; side < 4 && !found; side++) {
                var mx0 = rx + mixerRel[side][0], my0 = ry + mixerRel[side][1];
                if (!rectFree(w, h, cells, mx0, my0, 2)) continue;
                for (var es = 0; es < 4 && !found; es++) {
                    var ex0 = mx0 + extRel[es][0], ey0 = my0 + extRel[es][1];
                    if (rectsOverlap(rx + rOff, ry + rOff, 3, ex0, ey0, 2)) continue;
                    if (!rectFree(w, h, cells, ex0, ey0, 2)) continue;
                    var score = -Math.abs(d - (minDist + 4)) - dot * 5;
                    if (score > bestScore) {
                        bestScore = score;
                        best = { rx: rx, ry: ry, mx: mx0, my: my0, ex: ex0, ey: ey0, dist: d };
                    }
                    found = true;
                }
            }
        }
    }
    return best;
}

// ------------------------------------------------------ recon: wave schedule

/** Mindustry SpawnGroup.getSpawned semantics on a plain group description. */
function waveGroupCount(g, wave) {
    var spacing = g.spacing > 0 ? g.spacing : 1;
    var begin = g.begin || 0, end = g.end === undefined || g.end < 0 ? 1e9 : g.end;
    if (wave < begin || wave > end || (wave - begin) % spacing !== 0) return 0;
    var scaling = g.scaling > 0 ? g.scaling : 1e9;
    var count = (g.amount || 1) + Math.floor(Math.floor((wave - begin) / spacing) / scaling);
    return Math.min(count, g.max === undefined ? 1e9 : g.max);
}

/**
 * Reads the whole future wave table. groups: [{type, flying, begin, end, spacing, amount,
 * scaling, max, boss, hp, dps, shield, shieldScaling}]. waveIdx = 0-based index of the next wave.
 */
function analyzeWaveSchedule(groups, waveIdx, horizon, maxScan) {
    horizon = horizon || 5;
    maxScan = maxScan || 150;
    var rep = {
        firstAirWave: -1, nextAirWave: -1, firstGroundWave: -1, bossWave: -1, bossType: "", bossFlying: false,
        forecast: [], airShareNext: 0, airWaves: 0
    };
    var wave, gi;
    for (wave = 0; wave < maxScan; wave++) {
        var airHere = false, groundHere = false;
        for (gi = 0; gi < groups.length; gi++) {
            var g = groups[gi];
            var c = waveGroupCount(g, wave);
            if (c <= 0) continue;
            if (g.flying) { airHere = true; } else { groundHere = true; }
            if (g.boss && rep.bossWave < 0) {
                rep.bossWave = wave + 1; rep.bossType = g.type; rep.bossFlying = !!g.flying;
            }
        }
        if (airHere) {
            rep.airWaves++;
            if (rep.firstAirWave < 0) rep.firstAirWave = wave + 1;
            if (rep.nextAirWave < 0 && wave >= waveIdx) rep.nextAirWave = wave + 1;
        }
        if (groundHere && rep.firstGroundWave < 0) rep.firstGroundWave = wave + 1;
    }
    var airHpSum = 0, hpSum = 0;
    for (wave = waveIdx; wave < waveIdx + horizon && wave < maxScan + horizon; wave++) {
        var f = { wave: wave + 1, count: 0, hp: 0, dps: 0, airCount: 0, airHp: 0, groundHp: 0, boss: false, types: [] };
        for (gi = 0; gi < groups.length; gi++) {
            var gg = groups[gi];
            var cnt = waveGroupCount(gg, wave);
            if (cnt <= 0) continue;
            var shield = Math.max(0, (gg.shield || 0) + (gg.shieldScaling || 0) * (wave - (gg.begin || 0)));
            var hp = cnt * ((gg.hp || 100) + shield);
            f.count += cnt;
            f.hp += hp;
            f.dps += cnt * (gg.dps || 10);
            if (gg.flying) { f.airCount += cnt; f.airHp += hp; } else { f.groundHp += hp; }
            if (gg.boss) f.boss = true;
            f.types.push(cnt + "x" + gg.type);
        }
        rep.forecast.push(f);
        airHpSum += f.airHp;
        hpSum += f.hp;
    }
    rep.airShareNext = hpSum > 0 ? airHpSum / hpSum : 0;
    return rep;
}

// ----------------------------------------------------------- core zoning

/**
 * Zones around the core: ZONE_NUCLEUS = future 5x5 Core: Nucleus footprint (minus the
 * current core), ZONE_LANE = three-wide conveyor corridors in the four cardinal
 * directions so early buildings never wall the core in.
 */
function computeCoreZones(w, h, cx, cy, coreSize, laneLen) {
    laneLen = laneLen || 12;
    var zone = fillArray(w * h, ZONE_NONE);
    var cOff = sizeOffset(coreSize);
    var cx0 = cx + cOff, cy0 = cy + cOff;
    var x, y;
    // lanes start 3 tiles beyond the Nucleus ring so hub crafters (2x2/3x3 touching the core) keep their spots
    for (var d = 3; d <= laneLen + 3; d++) {
        for (var lane = -1; lane <= 1; lane++) {
            var pts = [[cx + lane, cy + 2 + d], [cx + lane, cy - 2 - d], [cx + 2 + d, cy + lane], [cx - 2 - d, cy + lane]];
            for (var q = 0; q < 4; q++) {
                x = pts[q][0]; y = pts[q][1];
                if (inBounds(w, h, x, y)) zone[y * w + x] = ZONE_LANE;
            }
        }
    }
    for (y = cy - 2; y <= cy + 2; y++) {
        for (x = cx - 2; x <= cx + 2; x++) {
            if (!inBounds(w, h, x, y)) continue;
            if (x >= cx0 && x < cx0 + coreSize && y >= cy0 && y < cy0 + coreSize) continue;
            zone[y * w + x] = ZONE_NUCLEUS;
        }
    }
    return zone;
}

function zoneAllows(zone, kind) {
    if (zone === ZONE_NUCLEUS) return kind <= KIND_LOGISTICS;
    if (zone === ZONE_LANE) return kind === KIND_CONVEYOR;
    return true;
}

// ------------------------------------------------- after-action heat map

/** Damage heat map by 4x4 tile buckets, with air/ground attribution. */
function createDamageHeat() {
    var heat = { buckets: {}, total: 0, air: 0, ground: 0 };
    heat.record = function (x, y, amount, air) {
        if (!(amount > 0)) return;
        var key = Math.floor(x / 4) + "," + Math.floor(y / 4);
        var b = heat.buckets[key];
        if (!b) { b = { x: Math.floor(x / 4) * 4 + 2, y: Math.floor(y / 4) * 4 + 2, amount: 0, air: 0 }; heat.buckets[key] = b; }
        b.amount += amount;
        if (air) { b.air += amount; heat.air += amount; } else heat.ground += amount;
        heat.total += amount;
    };
    heat.hottest = function (n) {
        var arr = [];
        var keys = Object.keys(heat.buckets);
        for (var i = 0; i < keys.length; i++) arr.push(heat.buckets[keys[i]]);
        arr.sort(function (a, b) { return b.amount - a.amount; });
        return arr.slice(0, n);
    };
    heat.dominantFlank = function (coreX, coreY) {
        var acc = {};
        var keys = Object.keys(heat.buckets);
        var best = "any", bestV = 0;
        for (var i = 0; i < keys.length; i++) {
            var b = heat.buckets[keys[i]];
            var f = compassFlank(b.x - coreX, b.y - coreY);
            acc[f] = (acc[f] || 0) + b.amount;
            if (acc[f] > bestV) { bestV = acc[f]; best = f; }
        }
        return best;
    };
    heat.airShare = function () { return heat.total > 0 ? heat.air / heat.total : 0; };
    heat.reset = function () { heat.buckets = {}; heat.total = 0; heat.air = 0; heat.ground = 0; };
    return heat;
}

/** After-action decision: where and how to reinforce (null when the wave did no meaningful damage). */
function pickBreachReinforcement(heat, coreX, coreY, minTotal) {
    if (!heat || heat.total < (minTotal || 600)) return null;
    var top = heat.hottest(1);
    if (!top.length) return null;
    var air = heat.airShare() >= 0.5;
    return {
        x: top[0].x, y: top[0].y, air: air, amount: top[0].amount,
        flank: heat.dominantFlank(coreX, coreY), airShare: heat.airShare()
    };
}

// --------------------------------------------- danger map & flank routing

/** Enemy turret danger grid. threats: [{x, y, r (tiles), weight}] -> int danger per tile (0 = safe). */
function buildDangerGrid(w, h, threats) {
    var danger = fillArray(w * h, 0);
    for (var t = 0; t < threats.length; t++) {
        var th = threats[t];
        var r = Math.ceil(th.r);
        for (var y = Math.max(0, Math.floor(th.y) - r); y <= Math.min(h - 1, Math.floor(th.y) + r); y++) {
            for (var x = Math.max(0, Math.floor(th.x) - r); x <= Math.min(w - 1, Math.floor(th.x) + r); x++) {
                var d = distPointToPoint(x, y, th.x, th.y);
                if (d > th.r) continue;
                danger[y * w + x] += Math.round((th.weight || 1) * (6 + 6 * (1 - d / th.r)));
            }
        }
    }
    return danger;
}

function straightPathDanger(w, h, danger, sx, sy, gx, gy) {
    var steps = Math.max(1, Math.ceil(distPointToPoint(sx, sy, gx, gy)));
    var sum = 0;
    for (var i = 0; i <= steps; i++) {
        var x = Math.round(sx + (gx - sx) * i / steps), y = Math.round(sy + (gy - sy) * i / steps);
        if (inBounds(w, h, x, y)) sum += danger[y * w + x];
    }
    return sum;
}

/**
 * Danger-aware route on a coarse grid (step tiles). passable may be null for air units.
 * Returns { waypoints:[x,y,...], danger, directDanger, length, directLength, useFlank }.
 */
function planFlankRoute(w, h, danger, passable, sx, sy, gx, gy, opts) {
    opts = opts || {};
    var step = opts.step || 3;
    var dangerK = opts.dangerK === undefined ? 0.8 : opts.dangerK;
    var cw = Math.ceil(w / step), ch = Math.ceil(h / step);
    var directDanger = straightPathDanger(w, h, danger, sx, sy, gx, gy);
    var directLength = distPointToPoint(sx, sy, gx, gy);
    var res = { waypoints: [gx, gy], danger: directDanger, directDanger: directDanger, length: directLength, directLength: directLength, useFlank: false };
    function cellX(i) { return Math.min(w - 1, i * step + (step >> 1)); }
    function cellY(j) { return Math.min(h - 1, j * step + (step >> 1)); }
    var si = Math.min(cw - 1, Math.floor(sx / step)), sj = Math.min(ch - 1, Math.floor(sy / step));
    var gi2 = Math.min(cw - 1, Math.floor(gx / step)), gj = Math.min(ch - 1, Math.floor(gy / step));
    var n = cw * ch;
    var dist = fillArray(n, 1e18), par = fillArray(n, -1), done = fillArray(n, 0);
    var open = [];
    var s0 = sj * cw + si, g0 = gj * cw + gi2;
    dist[s0] = 0;
    open.push([0, s0]);
    function heapPush(item) {
        open.push(item);
        var i = open.length - 1;
        while (i > 0) {
            var p = (i - 1) >> 1;
            if (open[p][0] <= open[i][0]) break;
            var t = open[p]; open[p] = open[i]; open[i] = t; i = p;
        }
    }
    function heapPop() {
        var top = open[0], last = open.pop();
        if (open.length) {
            open[0] = last;
            var i = 0;
            for (;;) {
                var l = 2 * i + 1, r = l + 1, m = i;
                if (l < open.length && open[l][0] < open[m][0]) m = l;
                if (r < open.length && open[r][0] < open[m][0]) m = r;
                if (m === i) break;
                var t = open[m]; open[m] = open[i]; open[i] = t; i = m;
            }
        }
        return top;
    }
    open = [[0, s0]];
    while (open.length) {
        var cur = heapPop()[1];
        if (done[cur]) continue;
        done[cur] = 1;
        if (cur === g0) break;
        var ci = cur % cw, cj = (cur - ci) / cw;
        for (var dy = -1; dy <= 1; dy++) {
            for (var dx = -1; dx <= 1; dx++) {
                if (!dx && !dy) continue;
                var ni = ci + dx, nj = cj + dy;
                if (ni < 0 || nj < 0 || ni >= cw || nj >= ch) continue;
                var nn = nj * cw + ni;
                if (done[nn]) continue;
                var px = cellX(ni), py = cellY(nj);
                if (passable && nn !== g0 && !passable[py * w + px]) continue;
                var stepLen = step * ((dx && dy) ? 1.414 : 1);
                var nd = dist[cur] + stepLen + danger[py * w + px] * dangerK;
                if (nd < dist[nn]) { dist[nn] = nd; par[nn] = cur; heapPush([nd, nn]); }
            }
        }
    }
    if (!done[g0]) return res;
    var cellsPath = [];
    for (var c = g0; c !== -1; c = par[c]) cellsPath.push(c);
    cellsPath.reverse();
    var pts = [];
    var routeDanger = 0, length = 0, lx = sx, ly = sy;
    for (var q = 0; q < cellsPath.length; q++) {
        var qi = cellsPath[q] % cw, qj = (cellsPath[q] - qi) / cw;
        var wx = q === cellsPath.length - 1 ? gx : cellX(qi), wy = q === cellsPath.length - 1 ? gy : cellY(qj);
        routeDanger += danger[Math.min(h - 1, wy) * w + Math.min(w - 1, wx)];
        length += distPointToPoint(lx, ly, wx, wy);
        lx = wx; ly = wy;
        pts.push(wx, wy);
    }
    // thin out waypoints: keep a point only where the heading changes or after >= 8 tiles
    var thin = [];
    var lastX = sx, lastY = sy, lastDirX = 0, lastDirY = 0;
    for (var k = 0; k + 1 < pts.length; k += 2) {
        var ddx = pts[k] - lastX, ddy = pts[k + 1] - lastY;
        var dl = Math.sqrt(ddx * ddx + ddy * ddy) || 1;
        var ux = ddx / dl, uy = ddy / dl;
        var turned = Math.abs(ux - lastDirX) + Math.abs(uy - lastDirY) > 0.5;
        if (k + 2 >= pts.length || (turned && dl >= 4) || dl >= 24) {
            thin.push(pts[k], pts[k + 1]);
            lastX = pts[k]; lastY = pts[k + 1]; lastDirX = ux; lastDirY = uy;
        }
    }
    if (!thin.length) thin = [gx, gy];
    res.waypoints = thin;
    res.danger = routeDanger;
    res.length = length;
    res.useFlank = directDanger > 0 && routeDanger < directDanger * 0.6 && length <= directLength * 2.4;
    if (!res.useFlank) res.waypoints = [gx, gy];
    return res;
}

// ---------------------------------------------------- assault target priority

var ASSAULT_BASE_SCORE = {
    "generator": 100, "power-node": 95, "battery": 85, "ammo-feed": 80,
    "turret": 50, "factory": 40, "core": 20, "other": 5
};

/**
 * Picks the next assault target: power first, then ammo logistics ("blind and
 * disarm" the base), turrets, and the core only when the base is disarmed.
 * cands: [{kind, x, y, powered}] ; ref: {x, y} (our rally point);
 * st: {turrets, disarmed} counts of enemy turrets and how many are unpowered/empty.
 */
function pickAssaultTarget(cands, ref, st) {
    var best = -1, bestScore = -1e9;
    var disarmedFrac = st && st.turrets > 0 ? st.disarmed / st.turrets : 1;
    var anyNonCore = false, i;
    for (i = 0; i < cands.length; i++) if (cands[i].kind !== "core") anyNonCore = true;
    for (i = 0; i < cands.length; i++) {
        var c = cands[i];
        var base = ASSAULT_BASE_SCORE[c.kind];
        if (base === undefined) base = 5;
        if (c.kind === "core" && anyNonCore && disarmedFrac < 0.7) continue;
        if (c.kind === "turret" && c.powered === false) continue; // already disarmed
        var score = base - distPointToPoint(c.x, c.y, ref.x, ref.y) * 0.3;
        if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) {
        for (i = 0; i < cands.length; i++) if (cands[i].kind === "core") return i;
    }
    return best;
}

/** Wounded units (<45% HP) retreat to the repair point and return only above 85%. */
function splitSquadByHealth(units, retreating) {
    var fight = [], retreat = [];
    for (var i = 0; i < units.length; i++) {
        var u = units[i];
        var wasRetreating = !!retreating[u.id];
        var go = wasRetreating ? u.hpFrac < 0.85 : u.hpFrac < 0.45;
        if (go) retreat.push(u.id); else fight.push(u.id);
    }
    return { fight: fight, retreat: retreat };
}

// ------------------------------------------------- unit lines (T1..T5 chains)

var UNIT_LINES = {
    "ground": ["dagger", "mace", "fortress", "scepter", "reign"],
    "air": ["flare", "horizon", "zenith", "antumbra", "eclipse"],
    "naval": ["risso", "minke", "bryde", "sei", "omura"],
    "legs": ["crawler", "atrax", "spiroct", "arkyid", "toxopid"],
    "support": ["nova", "pulsar", "quasar", "vela", "corvus"]
};
var UNIT_LINE_FACTORY = { "ground": "ground-factory", "legs": "ground-factory", "support": "ground-factory", "air": "air-factory", "naval": "naval-factory" };
var RECONSTRUCTOR_BY_TIER = [null, null, "additive-reconstructor", "multiplicative-reconstructor", "exponential-reconstructor", "tetrative-reconstructor"];

/**
 * Chooses the best unit line the bot can fully produce.
 * unlocked: {unitName: bool, blockName: bool}. Heavy sectors (diff >= 8) aim for T5.
 */
function chooseUnitLine(diff, unlocked, preferAir, hasWater) {
    var order = preferAir ? ["air", "ground", "support", "legs", "naval"] : ["ground", "air", "support", "legs", "naval"];
    var wantTier = diff >= 8 ? 5 : diff >= 6 ? 4 : diff >= 4 ? 3 : 2;
    var best = null;
    for (var o = 0; o < order.length; o++) {
        var key = order[o];
        if (key === "naval" && !hasWater) continue;
        var units = UNIT_LINES[key];
        var factory = UNIT_LINE_FACTORY[key];
        if (!unlocked[factory] || !unlocked[units[0]]) continue;
        var tiers = 1;
        for (var t = 2; t <= wantTier; t++) {
            if (!unlocked[units[t - 1]] || !unlocked[RECONSTRUCTOR_BY_TIER[t]]) break;
            tiers = t;
        }
        if (!best || tiers > best.tiers) best = { line: key, tiers: tiers, chain: units.slice(0, tiers), factory: factory, wantTier: wantTier };
        if (best.tiers >= wantTier) break;
    }
    return best;
}

var CHAIN_SIZES = [3, 3, 5, 7, 9];
/**
 * Factory + up to four reconstructor tiers on one axis (payload passes along adjacent blocks);
 * a 3x3 PayloadConveyor spacer links Exponential -> Tetrative (T5).
 * Returns the slot or null; positions are block centres in window coordinates.
 */
function findUnitChainSlotTiers(w, h, cells, coreWinX, coreWinY, allowUnloader, tiers) {
    tiers = Math.max(1, Math.min(5, tiers));
    var fOff = sizeOffset(3);
    for (var pass = allowUnloader ? 0 : 1; pass <= 1; pass++) {
        for (var r = 3; r <= 15; r++) {
            for (var fy = coreWinY - r; fy <= coreWinY + r; fy++) {
                for (var fx = coreWinX - r; fx <= coreWinX + r; fx++) {
                    if (Math.max(Math.abs(fx - coreWinX), Math.abs(fy - coreWinY)) !== r) continue;
                    var fx0 = fx + fOff, fy0 = fy + fOff;
                    if (!rectFree(w, h, cells, fx0, fy0, 3)) continue;
                    var ux = -1, uy = -1;
                    if (pass === 0) {
                        var uCell = findUnloaderCell(w, h, cells, fx0, fy0, 3);
                        if (uCell < 0) continue;
                        ux = uCell % w; uy = Math.floor(uCell / w);
                    }
                    for (var rot = 0; rot < 4; rot++) {
                        var stages = [{ cx: fx, cy: fy, size: 3, kind: "factory" }];
                        var cxp = fx, cyp = fy, prevHalf = 1, ok = true;
                        for (var t = 2; t <= tiers && ok; t++) {
                            var size = CHAIN_SIZES[t - 1];
                            var half = (size - 1) / 2;
                            if (t === 5) {
                                // payload conveyor spacer between T4 and T5
                                cxp += DX[rot] * (prevHalf + 1 + 1); cyp += DY[rot] * (prevHalf + 1 + 1);
                                stages.push({ cx: cxp, cy: cyp, size: 3, kind: "payload" });
                                prevHalf = 1;
                            }
                            cxp += DX[rot] * (prevHalf + 1 + half); cyp += DY[rot] * (prevHalf + 1 + half);
                            stages.push({ cx: cxp, cy: cyp, size: size, kind: RECONSTRUCTOR_BY_TIER[t] });
                            prevHalf = half;
                        }
                        for (var s = 1; s < stages.length && ok; s++) {
                            var so = sizeOffset(stages[s].size);
                            var rx0 = stages[s].cx + so, ry0 = stages[s].cy + so;
                            if (!rectFree(w, h, cells, rx0, ry0, stages[s].size)) ok = false;
                            else if (ux >= 0 && ux >= rx0 && ux < rx0 + stages[s].size && uy >= ry0 && uy < ry0 + stages[s].size) ok = false;
                        }
                        if (!ok) continue;
                        var last = stages[stages.length - 1];
                        var exitX = last.cx + DX[rot] * (Math.floor(last.size / 2) + 1);
                        var exitY = last.cy + DY[rot] * (Math.floor(last.size / 2) + 1);
                        if (!inBounds(w, h, exitX, exitY) || cells[exitY * w + exitX] !== CELL_FREE) continue;
                        if (exitX === ux && exitY === uy) continue;
                        return { rotation: rot, stages: stages, hasUnloader: ux >= 0, unloaderX: ux, unloaderY: uy, exitX: exitX, exitY: exitY, tiers: tiers };
                    }
                }
            }
        }
    }
    return null;
}

// =========================================================================
// v2.0 "strategic brain": Gemma 4 E2B (gemma4:e2b) over local Ollama with an
// instant deterministic human-like fallback planner.
// =========================================================================

var LLM_DEFAULT_URL = "http://127.0.0.1:11434/api/chat";
var LLM_DEFAULT_MODEL = "gemma4:e2b";
var LLM_INTERVAL_SEC = 10;
var LLM_TIMEOUT_MS = 4000;
var LLM_PLAN_TTL_SEC = 60;
var PREF_LLM_ENABLED = "scb-llm-enabled";
var PREF_LLM_URL = "scb-llm-url";
var PREF_LLM_MODEL = "scb-llm-model";

var LLM_PLANS = [
    "BUILD_CHOKEPOINT_FORTRESS", "BUILD_AA_SHIELD", "BUILD_AMMO_BUS", "EXPAND_ECONOMY",
    "EXPAND_SILICON_ECONOMY", "BUILD_POWER", "REINFORCE_BREACH", "BUILD_T3_AIR_FLANK",
    "BUILD_ARMY", "SNIPE_ENEMY_POWER", "ASSAULT_BASE", "HOLD_AND_RESEARCH", "CALL_WAVE_EARLY"
];
var LLM_FLANKS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west", "any"];
var LLM_AMMO = [
    "copper", "lead", "graphite", "silicon", "metaglass", "coal", "scrap", "pyratite",
    "blast-compound", "plastanium", "thorium", "surge-alloy", "titanium"
];

/** Extracts the first balanced {...} object from arbitrary text (string-aware), or null. */
function extractJsonObject(text) {
    if (typeof text !== "string") return null;
    var start = text.indexOf("{");
    while (start >= 0) {
        var depth = 0, inStr = false, esc = false;
        for (var i = start; i < text.length; i++) {
            var c = text.charAt(i);
            if (inStr) {
                if (esc) esc = false;
                else if (c === "\\") esc = true;
                else if (c === "\"") inStr = false;
                continue;
            }
            if (c === "\"") inStr = true;
            else if (c === "{") depth++;
            else if (c === "}") {
                depth--;
                if (depth === 0) return text.substring(start, i + 1);
            }
        }
        start = text.indexOf("{", start + 1);
    }
    return null;
}

function tryParseJson(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
}

function sanitizeThought(s) {
    if (typeof s !== "string") return "";
    var out = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ");
    out = out.replace(/^\s+|\s+$/g, "");
    if (out.length > 170) out = out.substring(0, 167) + "...";
    return out;
}

function normalizeFlank(v) {
    if (typeof v !== "string") return "any";
    var s = v.toLowerCase().replace(/[\s_]+/g, "-").replace(/^\s+|\s+$/g, "");
    var alias = { "n": "north", "ne": "north-east", "e": "east", "se": "south-east", "s": "south", "sw": "south-west", "w": "west", "nw": "north-west", "northeast": "north-east", "northwest": "north-west", "southeast": "south-east", "southwest": "south-west" };
    if (alias[s]) s = alias[s];
    for (var i = 0; i < LLM_FLANKS.length; i++) if (LLM_FLANKS[i] === s) return s;
    return "any";
}

function normalizeAmmo(v) {
    if (typeof v !== "string") return "";
    var s = v.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase().replace(/[\s_]+/g, "-");
    if (s === "blast" || s === "blastcompound") s = "blast-compound";
    if (s === "surge" || s === "surgealloy") s = "surge-alloy";
    for (var i = 0; i < LLM_AMMO.length; i++) if (LLM_AMMO[i] === s) return s;
    return "";
}

/**
 * Parses an Ollama (/api/chat, /api/generate) or OpenAI-compatible response, or the bare
 * JSON plan itself. Never throws. Returns { ok, thought, priority, flank, ammo, aggression, error }.
 */
function parseLlmResponse(raw) {
    var fail = function (why) { return { ok: false, thought: "", priority: "", flank: "any", ammo: "", aggression: 0.5, error: why }; };
    if (typeof raw !== "string" || !raw.replace(/\s+/g, "").length) return fail("пустой ответ");
    var outerText = extractJsonObject(raw);
    var content = null;
    var outer = outerText ? tryParseJson(outerText) : null;
    if (outer && typeof outer === "object") {
        if (outer.message && typeof outer.message.content === "string") content = outer.message.content;
        else if (typeof outer.response === "string") content = outer.response;
        else if (outer.choices && outer.choices.length && outer.choices[0] && outer.choices[0].message
            && typeof outer.choices[0].message.content === "string") content = outer.choices[0].message.content;
        else if (typeof outer.priority === "string") content = outerText; // already the plan
    }
    if (content === null) return fail("битый JSON ответа");
    var innerText = extractJsonObject(content);
    var plan = innerText ? tryParseJson(innerText) : null;
    if (!plan || typeof plan !== "object") return fail("нет JSON-плана в ответе модели");
    var pr = typeof plan.priority === "string" ? plan.priority.replace(/^\s+|\s+$/g, "").toUpperCase().replace(/[\s-]+/g, "_") : "";
    var known = false;
    for (var i = 0; i < LLM_PLANS.length; i++) if (LLM_PLANS[i] === pr) known = true;
    if (!known) return fail("неизвестный priority: " + pr);
    var ag = typeof plan.aggression === "number" ? plan.aggression : parseFloat(plan.aggression);
    if (isNaN(ag)) ag = 0.5;
    ag = Math.max(0, Math.min(1, ag));
    return {
        ok: true, thought: sanitizeThought(plan.thought), priority: pr, flank: normalizeFlank(plan.flank),
        ammo: normalizeAmmo(plan.ammo), aggression: ag, error: ""
    };
}

function fmtNum(v) {
    if (v === undefined || v === null || isNaN(v)) return "0";
    return String(Math.round(v * 10) / 10);
}

/** Compact (< 600 tokens) English situation summary; the model answers in strict JSON. */
function buildLlmPrompt(sit) {
    var it = sit.items || {}, inc = sit.income || {};
    var lines = [];
    lines.push("Mindustry campaign bot. Reply ONLY JSON: {\"thought\":\"<=140 chars, Russian\",\"priority\":\"PLAN\",\"flank\":\"north|north-east|east|south-east|south|south-west|west|north-west|any\",\"ammo\":\"item or none\",\"aggression\":0.0-1.0}");
    lines.push("PLANS: " + LLM_PLANS.join(","));
    lines.push("SECTOR: " + (sit.attackMode ? "attack" : "survival") + " " + (sit.sectorName || "?") + " wave " + (sit.wave || 0) + "/" + (sit.winWave || 0) + " enemies " + (sit.enemies || 0) + " core " + (sit.coreName || "shard"));
    lines.push("ITEMS: cu " + (it.copper || 0) + " pb " + (it.lead || 0) + " graphite " + (it.graphite || 0) + " si " + (it.silicon || 0) + " ti " + (it.titanium || 0) + " th " + (it.thorium || 0) + " plast " + (it.plastanium || 0) + " metaglass " + (it.metaglass || 0));
    lines.push("INCOME/s: cu " + fmtNum(inc.copper) + " pb " + fmtNum(inc.lead) + " graphite " + fmtNum(inc.graphite) + " si " + fmtNum(inc.silicon) + " ti " + fmtNum(inc.titanium) + " | POWER " + fmtNum(sit.power) + "/s");
    var fc = sit.forecast;
    if (fc && fc.forecast) {
        var parts = [];
        for (var i = 0; i < fc.forecast.length && i < 5; i++) {
            var f = fc.forecast[i];
            parts.push("w" + f.wave + ":" + (f.types.length ? f.types.join("+") : "none") + (f.airCount > 0 ? "(air " + f.airCount + ")" : ""));
        }
        lines.push("FORECAST: " + parts.join(" "));
        lines.push("FIRST_AIR_WAVE: " + fc.firstAirWave + " NEXT_AIR: " + fc.nextAirWave + " BOSS: " + (fc.bossWave > 0 ? "w" + fc.bossWave + " " + fc.bossType + (fc.bossFlying ? " flying" : " ground") : "none"));
    }
    lines.push("CHOKES: " + (sit.chokeCount || 0) + (sit.chokeCount ? " (width " + sit.chokeWidth + " at " + Math.round(sit.chokeDist) + " tiles, " + sit.chokeFlank + ")" : "") + " WEAK_FLANK: " + (sit.weakFlank || "none") + (sit.breach ? " BREACH " + (sit.breach.air ? "air" : "ground") + " " + sit.breach.flank : ""));
    lines.push("HAVE: fortress " + (sit.fortressBuilt ? "yes" : "no") + " aa " + (sit.aaBuilt ? "yes" : "no") + " ammo_bus " + (sit.busBuilt ? "yes" : "no") + " turrets " + (sit.turrets || 0) + " dps " + Math.round(sit.defenseDps || 0) + " army " + (sit.armyUnits || 0));
    lines.push("TURRETS_UNLOCKED: " + ((sit.turretsAvailable || []).join(",") || "none"));
    if (sit.attackMode) lines.push("ENEMY_BASE: " + (sit.enemyBaseKnown ? "scouted" : "unknown") + " power_nodes " + (sit.enemyPowerNodes || 0));
    return lines.join("\n");
}

var LLM_SYSTEM_PROMPT = "You are an expert Mindustry player. Think like a human pro: chokepoint kill-boxes, layered walls, automatic ammo belts, anti-air near generators, never rush. Answer with one JSON object only.";

function buildLlmRequestBody(model, prompt) {
    return JSON.stringify({
        model: model,
        messages: [{ role: "system", content: LLM_SYSTEM_PROMPT }, { role: "user", content: prompt }],
        stream: false,
        format: "json",
        options: { temperature: 0.3, num_predict: 220 }
    });
}

/** Can the plan actually be executed right now? The model must never break the bot. */
function planFeasible(priority, sit) {
    switch (priority) {
        case "BUILD_CHOKEPOINT_FORTRESS": return (sit.turretsAvailable || []).length > 0;
        case "BUILD_AA_SHIELD": return !!sit.aaAvailable;
        case "BUILD_AMMO_BUS": return !!sit.busPossible;
        case "EXPAND_SILICON_ECONOMY": return !!sit.smelterAvailable;
        case "BUILD_T3_AIR_FLANK": return !!sit.airChainAvailable;
        case "BUILD_ARMY": return !!sit.armyPossible;
        case "SNIPE_ENEMY_POWER": return !!sit.attackMode && !!sit.enemyBaseKnown;
        case "ASSAULT_BASE": return !!sit.attackMode;
        case "CALL_WAVE_EARLY": return !sit.attackMode && !!sit.canCallWave;
        case "REINFORCE_BREACH": return !!sit.breach;
        default: return true;
    }
}

/** Deterministic "pro player" planner. Always instant; explains itself in Russian. */
function heuristicPlan(sit) {
    var fc = sit.forecast || { nextAirWave: -1, firstAirWave: -1, bossWave: -1, airShareNext: 0, forecast: [] };
    var wave = sit.wave || 1;
    var turrets = sit.turrets || 0;
    var priority = "HOLD_AND_RESEARCH", thought = "";
    var flank = (sit.breach && sit.breach.flank) || sit.weakFlank || sit.chokeFlank || "any";
    var aggression = 0.35;
    var airSoon = fc.nextAirWave > 0 && fc.nextAirWave - wave <= 2;
    var items = sit.items || {};
    if (sit.breach) {
        priority = "REINFORCE_BREACH";
        thought = "Волна пробила " + sit.breach.flank + " фланг (" + Math.round(sit.breach.amount) + " урона) — усиливаю "
            + (sit.breach.air ? "ПВО" : "стены и огневую точку") + " именно там.";
        aggression = 0.15;
    } else if (sit.attackMode && sit.enemyBaseKnown && sit.enemyPowerNodes > 0 && (sit.armyUnits || 0) >= 4) {
        priority = "SNIPE_ENEMY_POWER";
        thought = "У врага " + sit.enemyPowerNodes + " энергоузлов/генераторов — обхожу по флангу и обесточиваю базу, потом бью ядро.";
        aggression = 0.8;
    } else if (sit.attackMode && sit.enemyBaseKnown && (sit.armyUnits || 0) >= 8) {
        priority = "ASSAULT_BASE";
        thought = "Армия собрана (" + sit.armyUnits + ") — иду на штурм в обход дальнобойных турелей.";
        aggression = 0.85;
    } else if (sit.aaAvailable && !sit.aaBuilt && airSoon) {
        priority = "BUILD_AA_SHIELD";
        thought = "На волне " + fc.nextAirWave + " прилетит авиация, а ПВО нет — ставлю Scatter на воздушном векторе и прикрываю генераторы.";
        aggression = 0.2;
    } else if (!sit.fortressBuilt && (sit.turretsAvailable || []).length > 0 && sit.chokeCount > 0) {
        priority = "BUILD_CHOKEPOINT_FORTRESS";
        thought = "Нашёл горлышко шириной " + sit.chokeWidth + " в " + Math.round(sit.chokeDist) + " тайлах от ядра (" + sit.chokeFlank
            + ") — перекрою скала-в-скалу и оставлю приманку-окно под перекрёстный огонь.";
        aggression = 0.25;
    } else if (!sit.fortressBuilt && (sit.turretsAvailable || []).length > 0 && turrets < 4) {
        priority = "BUILD_CHOKEPOINT_FORTRESS";
        thought = "Узких проходов нет — ставлю укрепрайон у ядра в сторону врага, пока волны слабые.";
        aggression = 0.25;
    } else if (sit.busPossible && !sit.busBuilt && turrets >= 3) {
        priority = "BUILD_AMMO_BUS";
        thought = "Турелей " + turrets + ", а патроны ношу руками — тяну шину Router+Junction от Unloader, чтобы не бегать.";
        aggression = 0.3;
    } else if (sit.smelterAvailable && (items.silicon || 0) < 200 && ((sit.income || {}).silicon || 0) < 0.2 && wave >= 3) {
        priority = "EXPAND_SILICON_ECONOMY";
        thought = "Кремния " + (items.silicon || 0) + " и почти нет притока — расширяю кремниевую экономику (Lancer, Unloader, юниты).";
        aggression = 0.3;
    } else if (sit.airChainAvailable && fc.airShareNext >= 0.4 && (sit.armyUnits || 0) < 6) {
        priority = "BUILD_T3_AIR_FLANK";
        thought = "Следующие волны на " + Math.round(fc.airShareNext * 100) + "% воздушные — строю воздушную цепочку юнитов для фланга.";
        aggression = 0.4;
    } else if (sit.canCallWave && !sit.attackMode && (sit.enemies || 0) === 0) {
        priority = "CALL_WAVE_EARLY";
        thought = "Оборона держит прогноз волны " + (wave) + " с запасом — вызываю волну раньше таймера.";
        aggression = 0.7;
    } else {
        priority = "HOLD_AND_RESEARCH";
        thought = (fc.bossWave > 0 ? "До босса (волна " + fc.bossWave + (fc.bossFlying ? ", воздух" : ", земля") + ") копим ресурсы и науку." : "Копим ресурсы и изучаем технологии, оборона в норме.");
        aggression = 0.3;
    }
    var ammoTurrets = sit.turretsAvailable || [];
    var ammo = chooseBusAmmo(ammoTurrets, sit.items || {}, sit.itemUnlocked || null, "") || "";
    return { ok: true, thought: thought, priority: priority, flank: flank, ammo: ammo, aggression: aggression, source: "heuristic", error: "" };
}

function llmBackoffInterval(failures) {
    if (failures <= 2) return LLM_INTERVAL_SEC;
    return Math.min(120, LLM_INTERVAL_SEC * Math.pow(2, failures - 2));
}

/**
 * The strategic brain. env = { enabled(), url(), model(), post(url, body, timeoutMs, cb(ok, text)), now() }.
 * update() is synchronous & instant: it always returns a plan (LLM when fresh, heuristic otherwise)
 * and fires a non-blocking request when due.
 */
function createLlmBrain(env) {
    var brain = {
        lastQuery: -1e9, inFlight: false, failures: 0, requestId: 0, requests: 0, okCount: 0, badCount: 0,
        llmPlan: null, llmAt: -1e9, lastError: "", eventPending: false, events: [],
        plan: null, thought: "", source: "heuristic", status: "эвристика"
    };
    brain.markEvent = function (name) { brain.eventPending = true; brain.events.push(name); if (brain.events.length > 8) brain.events.shift(); };
    brain.onResponse = function (id, ok, text) {
        if (id !== brain.requestId || !brain.inFlight) return; // stale/late answer
        brain.inFlight = false;
        var now = env.now();
        if (!ok) { brain.failures++; brain.lastError = "Ollama недоступна"; return; }
        var parsed = parseLlmResponse(text);
        if (parsed.ok) {
            brain.llmPlan = parsed; brain.llmAt = now; brain.failures = 0; brain.okCount++; brain.lastError = "";
        } else {
            brain.failures++; brain.badCount++; brain.lastError = parsed.error;
        }
    };
    brain.update = function (sit) {
        var now = env.now();
        var enabled = false;
        try { enabled = !!env.enabled(); } catch (e) { enabled = false; }
        if (brain.inFlight && now - brain.lastQuery > (LLM_TIMEOUT_MS / 1000) * 3) {
            brain.inFlight = false; brain.failures++; brain.lastError = "таймаут";
        }
        if (enabled && !brain.inFlight) {
            var gap = brain.failures >= 3 ? llmBackoffInterval(brain.failures) : (brain.eventPending ? 2 : LLM_INTERVAL_SEC);
            if (now - brain.lastQuery >= gap) {
                brain.lastQuery = now;
                brain.eventPending = false;
                brain.inFlight = true;
                brain.requests++;
                var id = ++brain.requestId;
                try {
                    env.post(env.url(), buildLlmRequestBody(env.model(), buildLlmPrompt(sit)), LLM_TIMEOUT_MS, function (ok, text) {
                        brain.onResponse(id, ok, text);
                    });
                } catch (err) {
                    brain.inFlight = false; brain.failures++; brain.lastError = "ошибка запроса";
                }
            }
        }
        var heur = heuristicPlan(sit);
        var plan = heur;
        if (enabled && brain.llmPlan && now - brain.llmAt <= LLM_PLAN_TTL_SEC && planFeasible(brain.llmPlan.priority, sit)) {
            var lp = brain.llmPlan;
            plan = {
                ok: true, thought: lp.thought || heur.thought, priority: lp.priority,
                flank: lp.flank !== "any" ? lp.flank : heur.flank,
                ammo: lp.ammo || heur.ammo, aggression: lp.aggression, source: "gemma", error: ""
            };
        }
        brain.plan = plan;
        brain.thought = plan.thought;
        brain.source = plan.source;
        brain.status = !enabled ? "ИИ выкл — эвристика"
            : plan.source === "gemma" ? "Gemma 4 E2B"
            : brain.failures > 0 ? "эвристика (Ollama недоступна)" : "эвристика";
        return plan;
    };
    brain.hudLine = function () {
        var tag = brain.source === "gemma" ? "[#8be9fd]🧠[]" : "[lightgray]⚙[]";
        return "💭 Мысль: [white]" + (brain.thought || "оцениваю обстановку...") + "[] " + tag;
    };
    return brain;
}

/** Applies the strategy bias to a safety factor / priorities (used by decideSector). */
function aggressionSafetyScale(aggression) {
    if (typeof aggression !== "number" || isNaN(aggression)) return 1;
    return Math.max(0.5, Math.min(1.5, 1.5 - aggression));
}

// ------------------------------------------------ recon: time-sliced terrain scan

/**
 * Time-sliced whole-map scan (never blocks the game thread): passability grid, distance
 * transform, A* corridors spawn/enemy core -> our core, chokepoints and a resource inventory.
 * env: { w, h, passable(x,y)->bool, feature(x,y)->string ("" | "ore:<item>" | "water" | "deep" | "oil" | "heat"),
 *        coreX, coreY, sources:[x,y,...] }.
 * step(tileBudget, pathBudget) returns true when finished.
 */
function createTerrainScan(env) {
    var w = env.w, h = env.h, n = w * h;
    var sc = {
        phase: "grid", done: false, passable: fillArray(n, 0), dist: null, paths: [], chokes: [],
        counts: {}, nearest: {}, cursor: 0, pathIndex: 0, search: null, seedCursor: 0, queue: null, head: 0, tail: 0,
        pathsFound: 0, sourcesTotal: (env.sources || []).length / 2
    };
    sc.step = function (tileBudget, pathBudget) {
        if (sc.done) return true;
        var i, x, y;
        if (sc.phase === "grid") {
            var end = Math.min(n, sc.cursor + tileBudget);
            for (i = sc.cursor; i < end; i++) {
                x = i % w; y = (i - x) / w;
                sc.passable[i] = env.passable(x, y) ? 1 : 0;
                var f = env.feature ? env.feature(x, y) : "";
                if (f) {
                    sc.counts[f] = (sc.counts[f] || 0) + 1;
                    var dd = distPointToPoint(x, y, env.coreX, env.coreY);
                    if (sc.nearest[f] === undefined || dd < sc.nearest[f]) sc.nearest[f] = dd;
                }
            }
            sc.cursor = end;
            if (sc.cursor >= n) { sc.phase = "dist"; sc.dist = fillArray(n, -1); sc.queue = new Array(n); sc.seedCursor = 0; sc.head = 0; sc.tail = 0; }
            return false;
        }
        if (sc.phase === "dist") {
            if (sc.seedCursor < n) {
                var sEnd = Math.min(n, sc.seedCursor + tileBudget * 4);
                for (i = sc.seedCursor; i < sEnd; i++) {
                    if (!sc.passable[i]) { sc.dist[i] = 0; sc.queue[sc.tail++] = i; }
                }
                sc.seedCursor = sEnd;
                if (sc.seedCursor >= n) {
                    for (i = 0; i < n; i++) {
                        if (!sc.passable[i]) continue;
                        x = i % w; y = (i - x) / w;
                        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { sc.dist[i] = 1; sc.queue[sc.tail++] = i; }
                    }
                }
                return false;
            }
            var budget = tileBudget * 4;
            while (sc.head < sc.tail && budget-- > 0) {
                i = sc.queue[sc.head++];
                x = i % w; y = (i - x) / w;
                for (var dy = -1; dy <= 1; dy++) {
                    for (var dx = -1; dx <= 1; dx++) {
                        if (!dx && !dy) continue;
                        var nx = x + dx, ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                        var ni = ny * w + nx;
                        if (sc.dist[ni] !== -1) continue;
                        sc.dist[ni] = sc.dist[i] + 1;
                        sc.queue[sc.tail++] = ni;
                    }
                }
            }
            if (sc.head >= sc.tail) { sc.phase = "paths"; sc.queue = null; }
            return false;
        }
        if (sc.phase === "paths") {
            var srcs = env.sources || [];
            if (sc.pathIndex * 2 >= srcs.length) { sc.phase = "chokes"; return false; }
            if (!sc.search) {
                var sx = srcs[sc.pathIndex * 2], sy = srcs[sc.pathIndex * 2 + 1];
                var near = nearestPassable(w, h, sc.passable, sx, sy, 4);
                var tc = nearestPassable(w, h, sc.passable, env.coreX, env.coreY, 4);
                if (!near || !tc) { sc.pathIndex++; return false; }
                sc.search = createPathSearch(w, h, sc.passable, sc.dist, near[0], near[1], tc[0], tc[1]);
            }
            if (sc.search.step(pathBudget)) {
                if (sc.search.found) { sc.paths.push({ xs: sc.search.xs, ys: sc.search.ys }); sc.pathsFound++; }
                sc.search = null;
                sc.pathIndex++;
            }
            return false;
        }
        if (sc.phase === "chokes") {
            sc.chokes = findChokepoints(w, h, sc.passable, sc.dist, sc.paths, env.coreX, env.coreY, env.chokeOpts || {});
            sc.done = true;
            sc.phase = "done";
            return true;
        }
        return sc.done;
    };
    return sc;
}

function nearestPassable(w, h, passable, x, y, maxR) {
    for (var r = 0; r <= maxR; r++) {
        for (var dy = -r; dy <= r; dy++) {
            for (var dx = -r; dx <= r; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                var nx = x + dx, ny = y + dy;
                if (inBounds(w, h, nx, ny) && passable[ny * w + nx]) return [nx, ny];
            }
        }
    }
    return null;
}

/** One-line Russian recon summary for the HUD / journal. */
function summarizeRecon(scan, sched, coreX, coreY) {
    var parts = [];
    var ores = [];
    var keys = Object.keys(scan.counts);
    for (var i = 0; i < keys.length; i++) {
        if (keys[i].indexOf("ore:") === 0) ores.push(keys[i].substring(4) + " " + scan.counts[keys[i]]);
    }
    parts.push("руды: " + (ores.length ? ores.join(", ") : "нет"));
    parts.push("вода: " + (scan.counts["water"] || scan.counts["deep"] ? "есть" : "нет")
        + ", нефть: " + (scan.counts["oil"] ? "есть" : "нет") + ", термо: " + (scan.counts["heat"] || 0));
    if (scan.chokes.length) {
        var c = scan.chokes[0];
        parts.push("проходы: " + scan.chokes.length + " (ширина " + c.width + " в " + Math.round(c.dist) + " тайлах, "
            + compassFlank((c.cx - coreX), (c.cy - coreY)) + ")");
    } else {
        parts.push("проходы: нет");
    }
    if (sched) {
        parts.push("авиация с волны " + (sched.firstAirWave > 0 ? sched.firstAirWave : "—")
            + ", босс " + (sched.bossWave > 0 ? "волна " + sched.bossWave + " (" + sched.bossType + (sched.bossFlying ? ", воздух" : ", земля") + ")" : "—"));
    }
    return parts.join(" · ");
}

// ------------------------------------------------ fortress kit / walls / core zoning helpers

var WALL_TIERS = ["copper-wall", "titanium-wall", "thorium-wall", "surge-wall"];

/**
 * Wall block candidates for a kill-box slot, best first (callers fall back to the next one when
 * the stock is short). usableMap: {blockName: bool}. layer 0 is the layer nearest to the turrets,
 * the last layer is the outermost: the strongest tier goes outside, the bait window stays cheap,
 * the inner layer is plastanium (absorbs piercing lasers of Quasar/Vela/Corvus).
 */
function pickFortressWalls(role, size, layer, flankLayers, usableMap) {
    var tiers = [], i;
    for (i = 0; i < WALL_TIERS.length; i++) {
        var nm = size === 2 ? WALL_TIERS[i] + "-large" : WALL_TIERS[i];
        if (usableMap[nm]) tiers.push(nm);
    }
    var out = [];
    if (role === ROLE_WALL_INNER) {
        var pl = size === 2 ? "plastanium-wall-large" : "plastanium-wall";
        if (usableMap[pl]) out.push(pl);
        for (i = tiers.length - 1; i >= 0; i--) out.push(tiers[i]);
        return out;
    }
    if (!tiers.length) return out;
    if (role === ROLE_WALL_WINDOW) return [tiers[0]];
    var best = tiers.length - 1;
    var idx = Math.max(0, Math.min(best, best - (flankLayers - 1 - layer)));
    for (i = idx; i >= 0; i--) out.push(tiers[i]);
    return out;
}

var KIT_MAIN = [["spectre", 4], ["ripple", 3], ["cyclone", 3], ["salvo", 2], ["hail", 1], ["duo", 1]];
var KIT_FRONT = [["lancer", 2], ["arc", 1], ["scorch", 1]];

/**
 * Chooses the kill-box turret kit from what is unlocked, affordable and fed by the ammo bus.
 * usableMap: {name: bool}; afford(name, count) -> bool; stock: {item: amount}; netPower: units/s.
 */
function chooseFortressKit(usableMap, afford, stock, netPower, preferredAmmo) {
    var kit = { main: "duo", mainSize: 1, front: "", frontSize: 1, support: "", supportSize: 1, wantForce: false, wantOverdrive: false, ammo: "" };
    var i, e, name;
    for (i = 0; i < KIT_MAIN.length; i++) {
        e = KIT_MAIN[i]; name = e[0];
        if (!usableMap[name] || !afford(name, 3)) continue;
        if (!chooseAmmoItem(name, stock, null, preferredAmmo || "")) continue;
        kit.main = name; kit.mainSize = e[1];
        break;
    }
    if (kit.main === "duo" && !usableMap["duo"]) { kit.main = ""; kit.mainSize = 1; }
    if (kit.main) kit.ammo = chooseAmmoItem(kit.main, stock, null, preferredAmmo || "") || "copper";
    for (i = 0; i < KIT_FRONT.length; i++) {
        e = KIT_FRONT[i]; name = e[0];
        if (!usableMap[name] || !afford(name, 2)) continue;
        if (name === "scorch" ? (stock["coal"] || 0) < 60 : netPower < 30) continue;
        kit.front = name; kit.frontSize = e[1];
        break;
    }
    if (usableMap["mend-projector"] && afford("mend-projector", 1)) { kit.support = "mend-projector"; kit.supportSize = 2; }
    else if (usableMap["mender"]) { kit.support = "mender"; kit.supportSize = 1; }
    kit.wantForce = !!(usableMap["force-projector"] && netPower >= 60 && afford("force-projector", 1));
    kit.wantOverdrive = !!(usableMap["overdrive-projector"] && netPower >= 150 && afford("overdrive-projector", 1));
    return kit;
}

/** Window cell adjacent to the core (FREE or LANE) closest to (tx, ty): where the bus Unloader goes. */
function findBusUnloaderCell(w, h, cells, tx, ty) {
    var best = -1, bestD = 1e18;
    for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
            var c = cells[y * w + x];
            if (c !== CELL_FREE && c !== CELL_LANE) continue;
            var touches = false;
            for (var d = 0; d < 4; d++) {
                var nx = x + DX[d], ny = y + DY[d];
                if (nx >= 0 && ny >= 0 && nx < w && ny < h && cells[ny * w + nx] === CELL_CORE) { touches = true; break; }
            }
            if (!touches) continue;
            var dd = (x - tx) * (x - tx) + (y - ty) * (y - ty);
            if (dd < bestD) { bestD = dd; best = y * w + x; }
        }
    }
    return best;
}

/** Marks conveyor corridors (and, when asked, the Nucleus 5x5 reserve) on the window grid as CELL_LANE. */
function applyCoreZones(w, h, cells, cx, cy, coreSize, laneLen, reserveNucleus, ore) {
    var zone = computeCoreZones(w, h, cx, cy, coreSize, laneLen);
    var n = 0;
    for (var i = 0; i < w * h; i++) {
        if (zone[i] === ZONE_NONE || cells[i] !== CELL_FREE) continue;
        if (zone[i] === ZONE_NUCLEUS && !reserveNucleus) continue;
        if (ore && ore[i] >= 0) continue; // never reserve ore tiles: drills come first
        cells[i] = CELL_LANE;
        n++;
    }
    return n;
}

function kebabToCamel(name) {
    return String(name).replace(/-([a-z0-9])/g, function (m, c) { return c.toUpperCase(); });
}

// --------------------------------------------------- Mindustry runtime glue

function installMindustryCampaignBot() {
    if (typeof Vars === "undefined" || !Vars || Vars.headless) return null;

    var asCons = function (fn) { return typeof cons === "function" ? cons(fn) : fn; };
    var asRun = function (fn) { return typeof run === "function" ? run(fn) : fn; };

    var bot = {
        state: BOT_OFF,
        reason: "",
        lastAction: "готов к запуску",
        lastResearch: "ожидание ресурсов",
        armySummary: "нет боевых юнитов",
        nextTargetSummary: "",
        journal: [],
        sectorLosses: {},
        neededItems: {},
        victoryPresets: {},
        victoryBuilt: false,
        watchdog: createWatchdog(),
        ownPlans: [],
        rejectedSites: {},
        nextDecisionTime: 0,
        nextResearchTime: 0,
        settleUntilTime: 0,
        capturedSinceSec: -1,
        lastWaveCallSec: -1e9,
        deadSinceSec: -1,
        transitionPending: false,
        hasTarget: false,
        targetX: 0,
        targetY: 0,
        arriveDistance: 0,
        transferStage: 0,
        transferTarget: null,
        transferItem: null,
        transferLabel: "",
        squadMode: SQUAD_RALLY,
        collapsed: false,
        loopErrors: 0,
        loopErrLogged: {}
    };

    var hudLabel = null;
    var planetLabel = null;
    var bodyTable = null;
    var llmButton = null;
    var nextUiRefresh = 0;

    try {
        if (typeof Core !== "undefined" && Core.settings && Core.settings.getBool(PREF_ENABLED, false)) {
            bot.state = BOT_RUNNING;
            bot.lastAction = "автовосстановление после запуска";
        }
    } catch (ignored) {}

    function botLog(msg) {
        bot.journal.push(msg);
        if (bot.journal.length > 10) bot.journal.shift();
        try { Log.info("[serpulo-campaign-bot] @", msg); } catch (ignored) {}
    }

    /**
     * Guards every stage of the per-tick update loop. A single broken game
     * member (a field that is not a method in Rhino, a stale Unit, a mod
     * conflict) must never crash the game: the stage is skipped, the failure is
     * logged exactly once through botLog(), and the remaining stages keep
     * running on the next tick.
     */
    function loopSafe(label, fn, fallback) {
        try {
            return fn();
        } catch (e) {
            bot.loopErrors++;
            if (!bot.loopErrLogged[label]) {
                bot.loopErrLogged[label] = true;
                var detail = "";
                try { detail = e && e.message ? String(e.message) : String(e); } catch (ignored) { detail = "неизвестная ошибка"; }
                botLog("сбой в цикле «" + label + "»: " + detail + " — пропускаю этот шаг, бот продолжает работу");
            }
            return fallback;
        }
    }

    function saveEnabled(flag) {
        try {
            if (typeof Core !== "undefined" && Core.settings) {
                Core.settings.put(PREF_ENABLED, !!flag);
            }
        } catch (ignored) {}
    }

    function packCoord(x, y) {
        return ((x & 0xFFFF) << 16) | (y & 0xFFFF);
    }

    function seqEach(seq, cb) {
        if (!seq) return;
        if (typeof seq.size === "number" && typeof seq.get === "function") {
            for (var i = 0; i < seq.size; i++) cb(seq.get(i), i);
        } else if (Array.isArray(seq)) {
            for (var j = 0; j < seq.length; j++) cb(seq[j], j);
        } else if (typeof seq.each === "function") {
            seq.each(asCons(cb));
        }
    }

    function buildGuard() {
        var g = {
            netActive: !!(Vars.net && Vars.net.active()),
            inGame: !!(Vars.state && Vars.state.isGame()),
            campaign: false,
            planet: "",
            canBuild: true
        };
        if (!g.inGame) return g;
        g.campaign = !!Vars.state.isCampaign();
        var p = Vars.state.getPlanet();
        g.planet = p ? String(p.name) : "";
        var u = Vars.player ? Vars.player.unit() : null;
        g.canBuild = !u || !memberValid(u) || !!u.canBuild();
        return g;
    }

    function countPresetProgress() {
        var captured = 0, total = 0;
        if (!Vars.content) return [0, 0];
        seqEach(Vars.content.sectors(), function (preset) {
            if (!preset || preset.planet !== Planets.serpulo || !preset.requireUnlock) return;
            total++;
            if (preset.sector && preset.sector.isCaptured()) captured++;
        });
        return [captured, total];
    }

    function isCampaignWon() {
        if (typeof SectorPresets === "undefined" || !SectorPresets.planetaryTerminal || !SectorPresets.planetaryTerminal.sector) {
            return false;
        }
        if (!SectorPresets.planetaryTerminal.sector.isCaptured()) return false;
        if (typeof Blocks !== "undefined" && Blocks.interplanetaryAccelerator && Blocks.interplanetaryAccelerator.techNode) {
            return !!Blocks.interplanetaryAccelerator.unlocked();
        }
        return true;
    }

    function ensureVictoryGraph() {
        if (bot.victoryBuilt || typeof Planets === "undefined" || !Planets.serpulo || !Planets.serpulo.techTree) return;
        bot.victoryBuilt = true;
        bot.victoryPresets = {};
        var queue = [];
        var seen = [];
        var pushNode = function (tn) {
            if (!tn || seen.indexOf(tn) >= 0) return;
            seen.push(tn);
            queue.push(tn);
        };
        if (typeof SectorPresets !== "undefined" && SectorPresets.planetaryTerminal) {
            pushNode(SectorPresets.planetaryTerminal.techNode);
        }
        if (typeof Blocks !== "undefined" && Blocks.interplanetaryAccelerator) {
            pushNode(Blocks.interplanetaryAccelerator.techNode);
        }
        while (queue.length > 0) {
            var cur = queue.pop();
            if (cur.content && cur.content.planet === Planets.serpulo && cur.content.sector) {
                bot.victoryPresets[String(cur.content.name)] = true;
            }
            if (cur.parent) pushNode(cur.parent);
            seqEach(cur.objectives, function (obj) {
                if (!obj) return;
                if (obj.preset && obj.preset.planet === Planets.serpulo) {
                    bot.victoryPresets[String(obj.preset.name)] = true;
                    pushNode(obj.preset.techNode);
                }
                if (obj.content && obj.content.techNode) {
                    pushNode(obj.content.techNode);
                }
            });
        }
    }

    function activeReserve(sec, item) {
        var cap = sec.isCaptured();
        var nm = String(item.name);
        if (nm === "copper") return cap ? 120 : 220;
        if (nm === "lead") return cap ? 100 : 180;
        if (nm === "graphite" || nm === "silicon" || nm === "titanium") return cap ? 40 : 90;
        return cap ? 20 : 50;
    }

    function runResearchPass() {
        if (Vars.net && Vars.net.client()) return null;
        if (typeof Planets === "undefined" || !Planets.serpulo || !Planets.serpulo.techTree) return null;
        if (Vars.control && typeof Vars.control.checkAutoUnlocks === "function") {
            Vars.control.checkAutoUnlocks();
        }
        if (Vars.state && Vars.state.isCampaign() && Vars.state.getPlanet() === Planets.serpulo) {
            var c = Vars.state.rules.defaultTeam.core();
            if (c && c.items) {
                seqEach(Vars.content.items(), function (it) {
                    if (c.items.get(it) > 0 && !it.unlocked()) it.unlock();
                });
            }
        }

        var allNodes = [];
        var collectTree = function (tn) {
            if (!tn) return;
            allNodes.push(tn);
            seqEach(tn.children, collectTree);
        };
        collectTree(Planets.serpulo.techTree);

        var activeSec = Vars.state && Vars.state.isCampaign() ? Vars.state.getSector() : null;
        var donors = [];
        var pool = [];
        seqEach(Vars.content.items(), function (it) { pool[it.id] = 0; });

        seqEach(Planets.serpulo.sectors, function (sec) {
            if (!sec.hasBase() || sec.isFrozen()) return;
            donors.push(sec);
            var sitems = sec.items();
            seqEach(Vars.content.items(), function (it) {
                var keep = sec === activeSec ? activeReserve(sec, it) : 50;
                pool[it.id] = (pool[it.id] || 0) + Math.max(0, sitems.get(it) - keep);
            });
        });

        var accelIdx = -1;
        var infos = [];
        for (var i = 0; i < allNodes.length; i++) {
            var node = allNodes[i];
            if (typeof Blocks !== "undefined" && Blocks.interplanetaryAccelerator && node.content === Blocks.interplanetaryAccelerator) {
                accelIdx = i;
            }
            var parentIdx = node.parent ? allNodes.indexOf(node.parent) : -1;
            var isPreset = !!(node.content && node.content.sector && node.content.planet);
            var allObj = true, nonResObj = true;
            var rdeps = [];
            seqEach(node.objectives, function (obj) {
                var done = !!obj.complete();
                if (!done) allObj = false;
                if (obj.content && obj.content.techNode && !obj.preset && String(obj).indexOf("research") === 0) {
                    var di = allNodes.indexOf(obj.content.techNode);
                    if (di >= 0) rdeps.push(di);
                } else if (!done) {
                    nonResObj = false;
                }
            });

            var rem = 0, affordAny = node.requirements.length === 0, finishNow = true;
            for (var r = 0; r < node.requirements.length; r++) {
                var reqAmt = node.requirements[r].amount;
                var doneAmt = node.finishedRequirements && node.finishedRequirements[r] ? node.finishedRequirements[r].amount : 0;
                var need = Math.max(0, reqAmt - doneAmt);
                rem += need;
                if (need > 0) {
                    var have = pool[node.requirements[r].item.id] || 0;
                    if (have > 0) affordAny = true;
                    if (have < need) finishNow = false;
                }
            }
            infos.push({
                index: i,
                name: String(node.content.name),
                parent: parentIdx,
                unlocked: !!node.content.unlockedHost(),
                isSectorPreset: isPreset,
                allObjectivesMet: allObj,
                nonResearchObjectivesMet: nonResObj,
                researchDeps: rdeps,
                remainingCost: rem,
                canAffordAny: affordAny,
                canFinishNow: finishNow,
                essentialTier: essentialTechTier(String(node.content.name))
            });
        }

        bot.neededItems = {};
        var crit = computeCriticalTechMask(infos, accelIdx);
        var topTarget = null;
        for (var m = 0; m < infos.length; m++) {
            if (!crit[m] || infos[m].unlocked || infos[m].isSectorPreset) continue;
            var tn = allNodes[m];
            if (!topTarget && (infos[m].parent < 0 || infos[infos[m].parent].unlocked)) topTarget = tn;
            for (var rq = 0; rq < tn.requirements.length; rq++) {
                var dn = tn.finishedRequirements[rq] ? tn.finishedRequirements[rq].amount : 0;
                if (dn < tn.requirements[rq].amount) {
                    bot.neededItems[String(tn.requirements[rq].item.name)] = true;
                }
            }
        }

        var ranked = rankResearchNodes(infos, accelIdx);
        var unlockedName = null;
        var spendLimit = Math.min(3, ranked.length);
        for (var k = 0; k < spendLimit; k++) {
            var targetNode = allNodes[ranked[k]];
            if (spendOnNode(targetNode, donors, activeSec, pool)) {
                unlockedName = String(targetNode.content.localizedName || targetNode.content.name);
                if (Vars.control && typeof Vars.control.checkAutoUnlocks === "function") {
                    Vars.control.checkAutoUnlocks();
                }
            }
        }

        if (unlockedName) {
            bot.lastResearch = "изучено: " + unlockedName + " ✅";
        } else if (ranked.length > 0) {
            var curN = allNodes[ranked[0]];
            var hSum = 0, tSum = 0;
            for (var p = 0; p < curN.requirements.length; p++) {
                tSum += curN.requirements[p].amount;
                hSum += Math.min(curN.requirements[p].amount, curN.finishedRequirements[p].amount);
            }
            var pct = tSum <= 0 ? 100 : Math.min(99, Math.floor((hSum * 100) / tSum));
            bot.lastResearch = String(curN.content.localizedName || curN.content.name) + " (" + pct + "%)";
        } else if (topTarget) {
            bot.lastResearch = "копим на " + String(topTarget.content.localizedName || topTarget.content.name);
        } else {
            bot.lastResearch = "все доступные узлы изучены";
        }
        return unlockedName;
    }

    function spendOnNode(node, donors, activeSec, pool) {
        var complete = true;
        var anySpent = false;
        for (var i = 0; i < node.requirements.length; i++) {
            var req = node.requirements[i];
            var fin = node.finishedRequirements[i];
            var missing = Math.max(0, req.amount - fin.amount);
            if (missing > 0) {
                var spend = Math.min(missing, pool[req.item.id] || 0);
                if (spend > 0) {
                    var deducted = deductItems(donors, activeSec, req.item, spend);
                    fin.amount += deducted;
                    pool[req.item.id] = Math.max(0, (pool[req.item.id] || 0) - deducted);
                    anySpent = true;
                }
            }
            if (fin.amount < req.amount) complete = false;
        }
        if (anySpent || node.requirements.length === 0) {
            if (complete) {
                node.content.unlock();
                var par = node.parent;
                while (par) { par.content.unlock(); par = par.parent; }
                try {
                    if (typeof ResearchEvent !== "undefined") Events.fire(new ResearchEvent(node.content));
                } catch (ignored) {}
            }
            node.save();
        }
        return complete && !!node.content.unlockedHost();
    }

    function deductItems(donors, activeSec, item, amount) {
        var rem = amount;
        for (var i = 0; i < donors.length && rem > 0; i++) {
            var sec = donors[i];
            if (sec === activeSec) continue;
            var avail = Math.max(0, sec.items().get(item) - 50);
            var take = Math.min(rem, avail);
            if (take > 0) {
                sec.removeItem(item, take);
                rem -= take;
            }
        }
        if (rem > 0 && activeSec && donors.indexOf(activeSec) >= 0) {
            var keep = activeReserve(activeSec, item);
            var availAct = Math.max(0, activeSec.items().get(item) - keep);
            var takeAct = Math.min(rem, availAct);
            if (takeAct > 0) {
                activeSec.removeItem(item, takeAct);
                rem -= takeAct;
            }
        }
        return amount - rem;
    }

    function isUnlockedToSelect(sec) {
        if (!sec || sec.isShielded()) return false;
        if (sec.hasBase() || sec === Planets.serpulo.getStartSector()) return true;
        if (sec.preset && sec.preset.requireUnlock) return !!sec.preset.unlocked();
        return !!(Planets.serpulo.generator && Planets.serpulo.generator.allowLanding(sec));
    }

    function canAnyBaseAffordBasicLaunch() {
        if (typeof Loadouts === "undefined" || !Loadouts.basicShard) return true;
        var req = Loadouts.basicShard.requirements();
        var ok = false;
        seqEach(Planets.serpulo.sectors, function (s) {
            if (!ok && s.hasBase() && !s.isAttacked() && s.items().has(req)) ok = true;
        });
        return ok;
    }

    function findValidLaunchOrigin(dest, preferred) {
        if (dest === Planets.serpulo.getStartSector()) return null;
        if (!Planets.serpulo.generator) return null;
        var minReq = (typeof Loadouts !== "undefined" && Loadouts.basicShard) ? Loadouts.basicShard.requirements() : null;
        var best = null, bestWealth = -1;
        seqEach(Planets.serpulo.sectors, function (base) {
            if (!base.hasBase() || base.isAttacked()) return;
            var cand = Planets.serpulo.generator.findLaunchCandidate(dest, base);
            if (!cand || !cand.hasBase() || cand.isAttacked()) return;
            var items = cand.items();
            if (minReq && !items.has(minReq)) return;
            var wealth = items.get(Items.copper) + items.get(Items.lead)
                + items.get(Items.silicon) * 2 + items.get(Items.titanium) * 2
                + (cand === preferred ? 500 : 0);
            if (wealth > bestWealth) {
                bestWealth = wealth;
                best = cand;
            }
        });
        return best;
    }

    function launchNextSector(currentSector) {
        if (typeof Planets === "undefined" || !Planets.serpulo) return false;
        ensureVictoryGraph();
        if (Vars.control && typeof Vars.control.checkAutoUnlocks === "function") {
            Vars.control.checkAutoUnlocks();
        }

        var refs = [];
        var cands = [];
        seqEach(Planets.serpulo.sectors, function (sec) {
            var isPreset = !!(sec.preset && sec.preset.requireUnlock);
            var underAttack = !!(sec.hasBase() && sec.isAttacked());
            var unlocked = isUnlockedToSelect(sec);
            if (!isPreset && !underAttack && !sec.hasBase()) return;
            if (sec === currentSector && sec.isBeingPlayed() && !underAttack) return;

            var origin = sec.hasBase() ? sec
                : sec === Planets.serpulo.getStartSector() ? null
                : findValidLaunchOrigin(sec, currentSector);
            var canLaunch = !!(sec.hasBase() || sec === Planets.serpulo.getStartSector() || origin);

            var farm = 0;
            if (sec.hasBase() && sec.isCaptured()) {
                if (!canAnyBaseAffordBasicLaunch()) farm += 20;
                if (sec.info && sec.info.resources) {
                    seqEach(sec.info.resources, function (uc) {
                        if (uc && bot.neededItems[String(uc.name)]) {
                            farm += String(uc.name) === "thorium" ? 30 : String(uc.name) === "titanium" ? 25 : 15;
                        }
                    });
                }
            }

            refs.push(sec);
            cands.push({
                id: sec.id,
                name: String(sec.name()),
                isPreset: isPreset,
                onVictoryPath: isPreset && !!bot.victoryPresets[String(sec.preset.name)],
                isFinalSector: isPreset && !!sec.preset.isLastSector,
                captured: !!sec.isCaptured(),
                hasBase: !!sec.hasBase(),
                underAttack: underAttack,
                unlocked: unlocked,
                canLaunchNow: canLaunch,
                hasEnemyBase: !!sec.hasEnemyBase(),
                difficulty: isPreset ? sec.preset.difficulty : sec.threat * 10,
                losses: bot.sectorLosses[sec.id] || 0,
                farmingScore: farm
            });
        });

        var idx = chooseNextSector(cands);
        if (idx < 0) return false;
        var target = refs[idx];
        bot.nextTargetSummary = String(target.name());

        var doTransition = function () {
            if (Vars.net && Vars.net.active()) return;
            try {
                if (Vars.control.saves && Vars.control.saves.getCurrent() && Vars.state.isGame()) {
                    Vars.control.saves.getCurrent().save();
                }
            } catch (ignored) {}
            try {
                if (Vars.ui && Vars.ui.planet && Vars.ui.planet.isShown()) Vars.ui.planet.hide();
            } catch (ignored) {}

            if (target.hasBase()) {
                Vars.control.playSector(target);
                return;
            }
            if (target === Planets.serpulo.getStartSector()) {
                Vars.universe.clearLoadoutInfo();
                Vars.control.playSector(target);
                return;
            }
            var from = findValidLaunchOrigin(target, currentSector);
            if (!from) return;

            var coreBlock = Planets.serpulo.defaultCore;
            var fromItems = from.items();
            if (target.allowLaunchSchematics()) {
                if (Blocks.coreNucleus && Blocks.coreNucleus.unlockedNow() && Loadouts.basicNucleus && fromItems.has(Loadouts.basicNucleus.requirements())) {
                    coreBlock = Blocks.coreNucleus;
                } else if (Blocks.coreFoundation && Blocks.coreFoundation.unlockedNow() && Loadouts.basicFoundation && fromItems.has(Loadouts.basicFoundation.requirements())) {
                    coreBlock = Blocks.coreFoundation;
                }
            }
            var loadout = Vars.universe.getLoadout(coreBlock);
            if (!loadout) {
                loadout = coreBlock === Blocks.coreNucleus ? Loadouts.basicNucleus
                    : coreBlock === Blocks.coreFoundation ? Loadouts.basicFoundation
                    : Loadouts.basicShard;
            }
            var schemReq = loadout.requirements();
            if (!fromItems.has(schemReq)) return;

            var resources = new ItemSeq();
            var cap = Math.floor(Planets.serpulo.launchCapacityMultiplier * loadout.findCore().itemCapacity);
            if (!target.allowLaunchLoadout()) {
                if (target.preset && target.preset.generator && target.preset.generator.map) {
                    var rules = target.preset.generator.map.rules();
                    seqEach(rules.loadout, function (st) {
                        if (st.item.isOnPlanet(Planets.serpulo)) resources.add(st.item, st.amount);
                    });
                }
            } else {
                seqEach(Vars.content.items(), function (item) {
                    if (!item.isOnPlanet(Planets.serpulo)) return;
                    var spare = fromItems.get(item) - schemReq.get(item) - 80;
                    var take = Math.max(0, Math.min(cap, spare));
                    if (take > 0) resources.set(item, take);
                });
            }
            Vars.universe.updateLoadout(coreBlock, loadout);
            Vars.universe.updateLaunchResources(resources);
            from.removeItems(schemReq);
            from.removeItems(resources);
            try {
                var LaunchEvt = Packages.mindustry.game.EventType.SectorLaunchLoadoutEvent;
                Events.fire(new LaunchEvt(target, from, loadout));
            } catch (ignored) {}
            Vars.control.playSector(from, target);
        };

        if (typeof Core !== "undefined" && Core.app && typeof Core.app.post === "function") {
            Core.app.post(asRun(doTransition));
        } else {
            doTransition();
        }
        return true;
    }

    // ------------------------------------------------- in-sector world glue

    function usable(block) {
        return !!(block && block.unlockedNow() && block.isPlaceable() && block.environmentBuildable());
    }

    function coreBudget(core) {
        var b = [];
        seqEach(Vars.content.items(), function (it) { b[it.id] = core.items.get(it); });
        return b;
    }

    function reserve(budget, block, count) {
        if (!block || count <= 0) return count === 0;
        var mult = Vars.state.rules.buildCostMultiplier || 1;
        var reqs = block.requirements;
        for (var i = 0; i < reqs.length; i++) {
            var st = reqs[i];
            var need = Math.ceil(st.amount * mult) * count;
            var nm = String(st.item.name);
            var keep = nm === "copper" ? COPPER_RESERVE : nm === "lead" ? LEAD_RESERVE : 0;
            if ((budget[st.item.id] || 0) - need < keep) return false;
        }
        for (var j = 0; j < reqs.length; j++) {
            budget[reqs[j].item.id] -= Math.ceil(reqs[j].amount * mult) * count;
        }
        return true;
    }

    function buildWindow(core, team, cells, ore) {
        var size = WINDOW_RADIUS * 2 + 1;
        var ox = core.tileX() - WINDOW_RADIUS, oy = core.tileY() - WINDOW_RADIUS;
        for (var y = 0; y < size; y++) {
            for (var x = 0; x < size; x++) {
                var idx = y * size + x;
                var wx = ox + x, wy = oy + y;
                var tile = Vars.world.tile(wx, wy);
                ore[idx] = -1;
                if (!tile) { cells[idx] = CELL_BLOCKED; continue; }
                var b = tile.build;
                if (b && b.team === team && (b.block === Blocks.coreShard || b.block === Blocks.coreFoundation || b.block === Blocks.coreNucleus || b.linkedCore)) {
                    cells[idx] = CELL_CORE;
                    continue;
                }
                var free = !bot.rejectedSites[packCoord(wx, wy)] && Build.validPlace(Blocks.conveyor, team, wx, wy, 0);
                cells[idx] = free ? CELL_FREE : CELL_BLOCKED;
                var drop = tile.block() === Blocks.air ? tile.drop() : null;
                if (free && drop && !tile.floor().isLiquid) ore[idx] = drop.id;
            }
        }
        return [ox, oy];
    }

    function countBlock(data, block) {
        if (!block) return 0;
        var c = 0;
        seqEach(data.buildings, function (b) { if (b.block === block) c++; });
        return c;
    }

    function countDrills(data) {
        var c = 0;
        seqEach(data.buildings, function (b) {
            if (b.block && typeof b.block.tier === "number" && b.block !== Blocks.waterExtractor) c++;
        });
        return c;
    }

    function findSpotNear(block, team, tx, ty, maxR) {
        for (var r = 0; r <= maxR; r++) {
            for (var dy = -r; dy <= r; dy++) {
                for (var dx = -r; dx <= r; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
                    var wx = tx + dx, wy = ty + dy;
                    if (!bot.rejectedSites[packCoord(wx, wy)] && Build.validPlace(block, team, wx, wy, 0)) {
                        return [wx, wy];
                    }
                }
            }
        }
        return null;
    }

    function computeNetPowerPerSec(data) {
        var seen = [];
        var net = 0;
        seqEach(data.buildings, function (b) {
            if (b.power && b.power.graph && seen.indexOf(b.power.graph) < 0) {
                seen.push(b.power.graph);
                net += b.power.graph.getPowerBalance() * 60;
            }
        });
        return net;
    }

    function clearMining() {
        var u = Vars.player ? Vars.player.unit() : null;
        if (u && memberValid(u) && u.mineTile) u.mineTile = null;
    }

    function haltUnitActions() {
        bot.hasTarget = false;
        bot.transferStage = 0;
        bot.transferTarget = null;
        clearMining();
        var u = Vars.player ? Vars.player.unit() : null;
        if (u && memberValid(u)) {
            for (var i = 0; i < bot.ownPlans.length; i++) {
                u.plans.remove(bot.ownPlans[i], true);
            }
            try { u.controlWeapons(false, false); } catch (ignored) {}
        }
        bot.ownPlans = [];
        bot.watchdog.reset();
    }

    function checkVictory() {
        if (isCampaignWon()) {
            haltUnitActions();
            bot.state = transition(bot.state, CMD_VICTORY);
            saveEnabled(false);
            bot.reason = "Planetary Launch Terminal захвачен и межпланетный ускоритель открыт! 🏆";
            bot.lastAction = bot.reason;
            botLog(bot.reason);
            return true;
        }
        return false;
    }

    function failBot(why) {
        haltUnitActions();
        bot.state = transition(bot.state, CMD_FAIL);
        saveEnabled(false);
        bot.reason = why;
        botLog("остановлен: " + why);
    }

    function pauseWithReason(msg) {
        bot.state = transition(bot.state, CMD_PAUSE);
        saveEnabled(false);
        bot.hasTarget = false;
        clearMining();
        bot.reason = msg;
        botLog(msg);
    }

    function updateOutOfGame() {
        if (bot.state !== BOT_RUNNING || bot.transitionPending) return;
        if (Vars.state && Vars.state.isGame()) return;
        if (Vars.net && Vars.net.active()) {
            pauseWithReason("сетевая игра — автопилот поставлен на паузу");
            return;
        }
        runResearchPass();
        if (checkVictory()) return;
        bot.transitionPending = true;
        bot.lastAction = "выбираю следующий сектор Serpulo...";
        if (!launchNextSector(null)) {
            bot.transitionPending = false;
            failBot("не найден доступный сектор Serpulo для вылета");
        } else {
            botLog("вылетаю в сектор: " + bot.nextTargetSummary);
        }
    }

    function queuePlans(unit, plans) {
        Vars.control.input.isBuilding = true;
        for (var i = 0; i < plans.length; i++) {
            unit.addBuild(plans[i]);
            bot.ownPlans.push(plans[i]);
        }
        bot.watchdog.success();
    }

    function chooseFactoryPlan(uf, wantSupport) {
        var checkType = function (ut) {
            if (!ut || !ut.unlockedNow() || ut.isBanned()) return -1;
            for (var i = 0; i < uf.plans.size; i++) {
                if (uf.plans.get(i).unit === ut) return i;
            }
            return -1;
        };
        if (uf === Blocks.airFactory) {
            if (wantSupport) {
                var mi = checkType(UnitTypes.mono);
                if (mi >= 0) return mi;
            }
            var fi = checkType(UnitTypes.flare);
            if (fi >= 0) return fi;
        } else if (uf === Blocks.groundFactory) {
            var order = [UnitTypes.dagger, UnitTypes.nova, UnitTypes.crawler];
            for (var g = 0; g < order.length; g++) {
                var gi = checkType(order[g]);
                if (gi >= 0) return gi;
            }
        } else if (uf === Blocks.navalFactory) {
            var nOrder = [UnitTypes.risso, UnitTypes.retusa];
            for (var n = 0; n < nOrder.length; n++) {
                var ni = checkType(nOrder[n]);
                if (ni >= 0) return ni;
            }
        }
        for (var k = 0; k < uf.plans.size; k++) {
            var u = uf.plans.get(k).unit;
            if (u.unlockedNow() && !u.isBanned()) return k;
        }
        return -1;
    }

    function maintainFactoriesAndPower(data, team) {
        var supportAir = data.countType(UnitTypes.mono) + data.countType(UnitTypes.poly) + data.countType(UnitTypes.mega);
        var cap = Units.getCap(team);
        var wantSupport = supportAir < Math.min(4, Math.max(2, Math.floor(cap / 3)));

        seqEach(data.buildings, function (b) {
            if (b.block && b.block.plans && typeof b.currentPlan === "number") {
                var desired = chooseFactoryPlan(b.block, wantSupport);
                if (desired >= 0 && b.currentPlan !== desired) {
                    Call.tileConfig(Vars.player, b, java.lang.Integer.valueOf(desired));
                }
            } else if (b.block && typeof b.block.maxNodes === "number" && b.power && b.power.links.size < b.block.maxNodes) {
                seqEach(data.buildings, function (other) {
                    if (b.power.links.size >= b.block.maxNodes) return;
                    if (other === b || !other.power || !other.block.hasPower) return;
                    if (b.power.graph === other.power.graph) return;
                    if (b.block.linkValid(b, other) && !PowerNode.insulated(b, other)) {
                        Call.tileConfig(Vars.player, b, java.lang.Integer.valueOf(other.pos()));
                    }
                });
            }
        });
    }

    /** v2.0 RTS assault: danger-map flank route, power/ammo-first target priority, wounded units retreat to repair. */
    function proAssault(ids, combat, core, team, cap) {
        var enemyData = Vars.state.teams.get(Vars.state.rules.waveTeam);
        if (!enemyData) return false;
        var nowSec = Time.time / 60;
        var res = proSafe("RTS", function () {
            var pro = bot.pro;
            var units = [];
            for (var i = 0; i < combat.length && i < 180; i++) {
                var hp = combat[i].maxHealth > 0 ? combat[i].health / combat[i].maxHealth : 1;
                units.push({ id: combat[i].id, hpFrac: isNaN(hp) ? 1 : hp });
            }
            var split = splitSquadByHealth(units, pro.retreating);
            pro.retreating = {};
            for (var r = 0; r < split.retreat.length; r++) pro.retreating[split.retreat[r]] = true;
            var cmd = proAssaultCommand(split.fight, combat, core, team, enemyData, nowSec);
            if (!cmd) return null;
            return { split: split, cmd: cmd };
        }, null);
        if (!res) return false;
        if (res.split.retreat.length) {
            Call.commandUnits(Vars.player, res.split.retreat, null, null, proRepairSpot(team, core), false, true);
        }
        var cmd = res.cmd, fightIds = res.split.fight;
        if (fightIds.length) {
            if (cmd.last && cmd.target.build) {
                Call.commandUnits(Vars.player, fightIds, cmd.target.build, null, new Vec2(cmd.target.build.x, cmd.target.build.y), false, true);
            } else {
                Call.commandUnits(Vars.player, fightIds, null, null, new Vec2(cmd.wx * Vars.tilesize, cmd.wy * Vars.tilesize), false, true);
            }
        }
        bot.armySummary = combat.length + "/" + cap + " · штурм: " + cmd.target.kind + (cmd.flank ? " (обход)" : "")
            + (res.split.retreat.length ? " · ремонт: " + res.split.retreat.length : "");
        return true;
    }

    function updateArmySquads(data, core, team, sector) {
        var combat = [];
        var pUnit = Vars.player ? Vars.player.unit() : null;
        seqEach(Groups.unit, function (u) {
            if (!u || u.team !== team || u === pUnit || unitDead(u) || !unitCommandable(u)) return;
            var ai = u.command();
            if (u.type === UnitTypes.mono) {
                if (ai.command !== UnitCommand.mineCommand) ai.command(UnitCommand.mineCommand);
                return;
            }
            if (u.type === UnitTypes.poly) {
                var cmd = data.plans.size > 0 ? UnitCommand.rebuildCommand : UnitCommand.assistCommand;
                if (ai.command !== cmd) ai.command(cmd);
                return;
            }
            if (u.type === UnitTypes.mega || u.type === UnitTypes.retusa || u.type === UnitTypes.oxynoe) {
                if (ai.command !== UnitCommand.repairCommand) ai.command(UnitCommand.repairCommand);
                return;
            }
            if (u.type.canAttack) combat.push(u);
        });

        var nearEnemy = Units.closestEnemy(team, core.x, core.y, 42 * Vars.tilesize, boolf(function (e) { return !unitDead(e); }));
        var diff = sector && sector.preset ? sector.preset.difficulty : 4;
        var cap = Units.getCap(team);
        bot.squadMode = decideSquadMode(!!Vars.state.rules.attackMode, bot.squadMode, combat.length, cap, nearEnemy ? 1 : 0, diff);

        bot.pro.armyCount = combat.length;
        if (!combat.length) {
            bot.armySummary = "0/" + cap + " боевых";
            return;
        }
        var ids = [];
        for (var i = 0; i < combat.length && i < 180; i++) {
            ids.push(combat[i].id);
            var cai = combat[i].command();
            cai.setStance(UnitStance.pursueTarget, true);
            if (combat[i].type.canBoost) cai.setStance(UnitStance.boost, true);
        }

        if (bot.squadMode === SQUAD_DEFEND && nearEnemy) {
            Call.commandUnits(Vars.player, ids, null, nearEnemy, new Vec2(nearEnemy.x, nearEnemy.y), false, true);
            bot.armySummary = combat.length + "/" + cap + " · защита базы";
        } else if (bot.squadMode === SQUAD_ASSAULT && proAssault(ids, combat, core, team, cap)) {
            // v2.0 RTS: flank route, power-first targets, wounded retreat (handled in proAssault)
        } else if (bot.squadMode === SQUAD_ASSAULT) {
            var enemyData = Vars.state.teams.get(Vars.state.rules.waveTeam);
            var targetBuild = null, bestCoreDst = 1e12, enemyCore = null, bestTurret = null, bestTurretDst = 1e12;
            if (enemyData) {
                seqEach(enemyData.cores, function (ec) {
                    var d = ec.dst(core);
                    if (d < bestCoreDst) { bestCoreDst = d; enemyCore = ec; }
                });
                seqEach(enemyData.buildings, function (eb) {
                    if (eb.block && (eb.block.targetGround !== undefined || eb.block.plans)) {
                        var d = eb.dst(core);
                        if (d < bestTurretDst && (!enemyCore || d < bestCoreDst - 80)) {
                            bestTurretDst = d;
                            bestTurret = eb;
                        }
                    }
                });
            }
            targetBuild = bestTurret || enemyCore;
            if (targetBuild) {
                Call.commandUnits(Vars.player, ids, targetBuild, null, new Vec2(targetBuild.x, targetBuild.y), false, true);
                bot.armySummary = combat.length + "/" + cap + " · штурм (" + targetBuild.block.localizedName + ")";
            }
        } else {
            var dirX = 1, dirY = 0;
            var ed = Vars.state.teams.get(Vars.state.rules.waveTeam);
            if (ed && ed.cores.size > 0) {
                dirX = ed.cores.first().x - core.x;
                dirY = ed.cores.first().y - core.y;
            } else if (Vars.spawner.getSpawns().size > 0) {
                var sp = Vars.spawner.getSpawns().first();
                dirX = sp.worldx() - core.x;
                dirY = sp.worldy() - core.y;
            }
            var len = Math.max(1, Math.sqrt(dirX * dirX + dirY * dirY));
            var dist = Math.min(len * 0.35, 18 * Vars.tilesize);
            var rally = new Vec2(core.x + (dirX / len) * dist, core.y + (dirY / len) * dist);
            Call.commandUnits(Vars.player, ids, null, null, rally, false, true);
            bot.armySummary = combat.length + "/" + cap + " · сбор у рубежа";
        }
    }

    function tryPlanHubBlock(origin, size, cells, ore, team, budget, crafter, wantUnloader, supportBlock, outPlans) {
        var sSize = supportBlock ? supportBlock.size : 0;
        var slot = findHubCrafterSlot(size, size, cells, ore, crafter.size, wantUnloader, sSize);
        if (!slot && wantUnloader) slot = findHubCrafterSlot(size, size, cells, ore, crafter.size, false, sSize);
        if (!slot) return null;

        var cx = origin[0] + slot.crafterX, cy = origin[1] + slot.crafterY;
        if (!Build.validPlace(crafter, team, cx, cy, 0)) return null;
        var work = budget.slice();
        if (!reserve(work, crafter, 1)) return null;

        var plans = [new BuildPlan(cx, cy, 0, crafter)];
        if (slot.hasUnloader && usable(Blocks.unloader)) {
            var ux = origin[0] + slot.unloaderX, uy = origin[1] + slot.unloaderY;
            if (!Build.validPlace(Blocks.unloader, team, ux, uy, 0) || !reserve(work, Blocks.unloader, 1)) return null;
            plans.push(new BuildPlan(ux, uy, 0, Blocks.unloader));
        }
        if (slot.hasSupport && supportBlock) {
            var sx = origin[0] + slot.supportX, sy = origin[1] + slot.supportY;
            if (!Build.validPlace(supportBlock, team, sx, sy, 0) || !reserve(work, supportBlock, 1)) return null;
            plans.push(new BuildPlan(sx, sy, 0, supportBlock));
        }
        if ((crafter.consumesPower || crafter.outputsPower || (supportBlock && supportBlock.consumesPower)) && usable(Blocks.powerNode)) {
            var np = findSpotNear(Blocks.powerNode, team, cx + crafter.size, cy, 3);
            if (np && reserve(work, Blocks.powerNode, 1)) {
                plans.push(new BuildPlan(np[0], np[1], 0, Blocks.powerNode));
            }
        }
        for (var i = 0; i < work.length; i++) budget[i] = work[i];
        for (var j = 0; j < plans.length; j++) outPlans.push(plans[j]);
        return String(crafter.localizedName);
    }

    // ======================================================================
    // v2.0 pro runtime: recon, chokepoint kill-box, ammo bus, AA corridor,
    // after-action learning, RTS flanking and the Gemma strategic brain.
    // Every part is wrapped in proSafe(): a failure disables only that part,
    // the v1 planner keeps working.
    // ======================================================================

    function proNewState() {
        return {
            sectorKey: null, scan: null, scanDone: false, choke: null, chokes: [], kill: null, killKey: "", recon: "",
            sched: null, heat: createDamageHeat(), prevHp: {}, nextHeatSec: 0, breach: null, breachHandled: -1,
            busPlan: null, busBuilt: false, busFails: 0, aaBuilt: 0, startSec: 0, lastRetuneSec: 0,
            fortTotal: 0, fortSat: 0, fortTurretsBuilt: 0, kit: null, lastSit: null, plan: null,
            route: null, routeKey: "", routeIdx: 0, routeAt: -1e9, retreating: {}, errLogged: {}, ammoNow: "",
            reactor: { phase: 0, site: null, mixerPlanned: false }, enemyKnown: false
        };
    }
    bot.pro = proNewState();

    function proSafe(label, fn, fallback) {
        try { return fn(); } catch (e) {
            if (!bot.pro.errLogged[label]) {
                bot.pro.errLogged[label] = true;
                botLog("про-модуль «" + label + "» отключён: " + e);
            }
            return fallback;
        }
    }

    function llmSettingBool(key, def) {
        try { return Core.settings.getBool(key, def); } catch (e) { return def; }
    }
    function llmSettingStr(key, def) {
        try { var v = Core.settings.getString(key, def); return v && String(v).length ? String(v) : def; } catch (e) { return def; }
    }

    var llmEnv = {
        enabled: function () { return llmSettingBool(PREF_LLM_ENABLED, true); },
        url: function () { return llmSettingStr(PREF_LLM_URL, LLM_DEFAULT_URL); },
        model: function () { return llmSettingStr(PREF_LLM_MODEL, LLM_DEFAULT_MODEL); },
        now: function () { return Time.time / 60; },
        // Non-blocking HTTP: arc.util.Http runs on its own thread, the answer is applied on the game thread.
        post: function (url, body, timeoutMs, cb) {
            var req = Http.post(url, body);
            req.header("Content-Type", "application/json");
            req.timeout(timeoutMs);
            req.error(asCons(function (err) {
                Core.app.post(asRun(function () { cb(false, String(err)); }));
            }));
            req.submit(asCons(function (res) {
                var text = "";
                try { text = String(res.getResultAsString()); } catch (e) { text = ""; }
                Core.app.post(asRun(function () { cb(true, text); }));
            }));
        }
    };
    bot.pro.brain = createLlmBrain(llmEnv);

    function toggleLlm() {
        var on = !llmSettingBool(PREF_LLM_ENABLED, true);
        try { Core.settings.put(PREF_LLM_ENABLED, on); } catch (ignored) {}
        botLog(on ? "ИИ Gemma включён" : "ИИ Gemma выключен — работает встроенный планировщик");
        refreshUi();
    }

    function proBlock(name) {
        var b = null;
        try { b = Blocks[kebabToCamel(name)]; } catch (e) { b = null; }
        return b || null;
    }
    function proItem(name) {
        var it = null;
        try { it = Items[kebabToCamel(name)]; } catch (e) { it = null; }
        return it || null;
    }

    function proStockMap(core) {
        var m = {};
        seqEach(Vars.content.items(), function (it) { m[String(it.name)] = core.items.get(it); });
        return m;
    }

    function proUsableMap() {
        var names = ["copper-wall", "copper-wall-large", "titanium-wall", "titanium-wall-large", "thorium-wall", "thorium-wall-large",
            "surge-wall", "surge-wall-large", "plastanium-wall", "plastanium-wall-large",
            "duo", "scatter", "scorch", "hail", "wave", "lancer", "arc", "swarmer", "salvo", "segment", "tsunami", "fuse", "ripple",
            "cyclone", "foreshadow", "spectre", "meltdown", "mender", "mend-projector", "overdrive-projector", "force-projector",
            "router", "junction", "unloader", "conveyor", "titanium-conveyor", "thorium-reactor", "cryofluid-mixer", "water-extractor",
            "repair-point", "payload-conveyor", "power-node", "ground-factory", "air-factory", "naval-factory",
            "additive-reconstructor", "multiplicative-reconstructor", "exponential-reconstructor", "tetrative-reconstructor"];
        var m = {};
        for (var i = 0; i < names.length; i++) m[names[i]] = usable(proBlock(names[i]));
        return m;
    }

    function proTileOf(entity) {
        return [Math.round(entity.x / Vars.tilesize), Math.round(entity.y / Vars.tilesize)];
    }

    function proWaveGroups() {
        var groups = [];
        seqEach(Vars.state.rules.spawns, function (grp) {
            if (!grp || !grp.type) return;
            var dps = 10;
            try { if (grp.type.estimateDps) dps = grp.type.estimateDps(); } catch (e) { dps = 10; }
            var boss = false;
            try { boss = typeof StatusEffects !== "undefined" && grp.effect === StatusEffects.boss; } catch (e) { boss = false; }
            groups.push({
                type: String(grp.type.name), flying: !!grp.type.flying, begin: grp.begin || 0,
                end: grp.end === undefined ? -1 : grp.end, spacing: grp.spacing || 1,
                amount: typeof grp.unitAmount === "number" ? grp.unitAmount : 1,
                scaling: typeof grp.unitScaling === "number" ? grp.unitScaling : 1e9,
                max: typeof grp.max === "number" ? grp.max : 1e9, boss: boss,
                hp: grp.type.health || 100, dps: dps, shield: grp.shields || 0, shieldScaling: grp.shieldScaling || 0
            });
        });
        return groups;
    }

    function proScanEnv(core) {
        var sources = [];
        seqEach(Vars.spawner.getSpawns(), function (sp) {
            if (typeof sp.x === "number" && typeof sp.y === "number") sources.push(sp.x, sp.y);
            else sources.push(Math.round(sp.worldx() / Vars.tilesize), Math.round(sp.worldy() / Vars.tilesize));
        });
        var enemyData = Vars.state.teams.get(Vars.state.rules.waveTeam);
        if (enemyData) seqEach(enemyData.cores, function (ec) { var t = proTileOf(ec); sources.push(t[0], t[1]); });
        return {
            w: Vars.world.width(), h: Vars.world.height(), coreX: core.tileX(), coreY: core.tileY(), sources: sources,
            passable: function (x, y) {
                var t = Vars.world.tile(x, y);
                if (!t) return false;
                var fl = t.floor();
                if (fl && typeof fl.isDeep === "function" && fl.isDeep()) return false;
                if (typeof t.solid === "function" && t.solid() && !t.build) return false;
                return true;
            },
            feature: function (x, y) {
                var t = Vars.world.tile(x, y);
                if (!t) return "";
                var fl = t.floor();
                if (fl && typeof fl.isDeep === "function" && fl.isDeep()) return "deep";
                if (fl && fl.isLiquid) {
                    var ld = fl.liquidDrop;
                    if (ld) return String(ld.name) === "oil" ? "oil" : "water";
                }
                if (t.block() === Blocks.air) {
                    var d = t.drop();
                    if (d) return "ore:" + String(d.name);
                }
                if (fl && fl.attributes && typeof Attribute !== "undefined" && fl.attributes.get(Attribute.heat) > 0.25) return "heat";
                return "";
            }
        };
    }

    function proEnterSector(sector, core, nowSec) {
        var key = (sector ? String(sector.id) : "?") + ":" + core.tileX() + ":" + core.tileY();
        if (bot.pro.sectorKey === key) return;
        var brain = bot.pro.brain;
        bot.pro = proNewState();
        bot.pro.brain = brain;
        bot.pro.sectorKey = key;
        bot.pro.startSec = nowSec;
        proSafe("разведка", function () {
            bot.pro.scan = createTerrainScan(proScanEnv(core));
            bot.pro.sched = analyzeWaveSchedule(proWaveGroups(), Math.max(0, (Vars.state.wave || 1) - 1), 5, 150);
            brain.markEvent("sector");
            var s = bot.pro.sched;
            botLog("разведка карты: " + (s.firstAirWave > 0 ? "авиация с волны " + s.firstAirWave : "авиации нет")
                + (s.bossWave > 0 ? ", босс " + s.bossType + " на волне " + s.bossWave : ""));
        }, null);
    }

    function proStepScan(core) {
        var pro = bot.pro;
        if (!pro.scan || pro.scanDone) return;
        proSafe("разведка", function () {
            if (pro.scan.step(4000, 2500)) {
                pro.scanDone = true;
                pro.chokes = pro.scan.chokes;
                pro.choke = pro.chokes.length ? pro.chokes[0] : null;
                pro.recon = summarizeRecon(pro.scan, pro.sched, core.tileX(), core.tileY());
                botLog("разведка: " + pro.recon);
                bot.pro.brain.markEvent("recon");
            }
        }, null);
        if (bot.pro.errLogged["разведка"]) { pro.scan = null; pro.scanDone = true; }
    }

    /** After-action learning: tracks HP loss of our buildings between decisions (4x4 heat buckets). */
    function proUpdateHeat(data, team, core, nowSec) {
        var pro = bot.pro;
        if (nowSec < pro.nextHeatSec) return;
        pro.nextHeatSec = nowSec + 1.5;
        var fresh = {};
        seqEach(data.buildings, function (b) {
            if (!b || !b.block || b === core) return;
            var key = b.pos();
            var hp = b.health;
            fresh[key] = hp;
            var prev = pro.prevHp[key];
            if (prev !== undefined && hp < prev - 1) {
                var air = false;
                var en = Units.closestEnemy(team, b.x, b.y, 14 * Vars.tilesize, boolf(function (e) { return !unitDead(e) && unitFlying(e); }));
                if (en) air = true;
                pro.heat.record(Math.round(b.x / Vars.tilesize), Math.round(b.y / Vars.tilesize), prev - hp, air);
            }
        });
        pro.prevHp = fresh;
    }

    function proAfterWave(core) {
        var pro = bot.pro;
        if (pro.heat.total <= 0) return;
        var rep = pickBreachReinforcement(pro.heat, core.tileX(), core.tileY(), 600);
        if (rep) {
            rep.wave = Vars.state.wave || 0;
            pro.breach = rep;
            botLog("разбор волны: пробито направление " + rep.flank + " (" + Math.round(rep.amount) + " урона" + (rep.air ? ", воздух" : "") + ")");
            pro.brain.markEvent("breach");
        }
        pro.heat.reset();
    }

    function proWallsGate(pro) {
        return pro.fortTurretsBuilt >= 2 || (Vars.state.wave || 0) >= 4;
    }

    function proSlotSatisfied(x, y, role, team) {
        var t = Vars.world.tile(x, y);
        if (!t || !t.build || t.build.team !== team) return false;
        var bb = t.build.block;
        var nm = String(bb.name);
        if (role === ROLE_WALL || role === ROLE_WALL_WINDOW || role === ROLE_WALL_INNER) {
            return typeof BlockGroup !== "undefined" && bb.group === BlockGroup.walls;
        }
        if (role === ROLE_GROUND_TURRET || role === ROLE_FRONT_TURRET || role === ROLE_AIR_TURRET || role === ROLE_LIQUID_TURRET || role === ROLE_POINT_DEFENSE) {
            if (!(bb.ammoTypes || bb.targetGround !== undefined)) return false;
            if (role === ROLE_GROUND_TURRET && bot.pro.kit && bot.pro.kit.main) {
                return proListRank(KIT_MAIN, nm) <= proListRank(KIT_MAIN, bot.pro.kit.main) || proListRank(KIT_MAIN, nm) === 99;
            }
            return true;
        }
        if (role === ROLE_SUPPORT) return nm === "mender" || nm === "mend-projector";
        if (role === ROLE_POWER_NODE) return typeof bb.maxNodes === "number";
        if (role === ROLE_FORCE) return nm.indexOf("force-projector") >= 0;
        if (role === ROLE_OVERDRIVE) return nm.indexOf("overdrive") >= 0;
        return false;
    }

    function proListRank(list, name) {
        for (var i = 0; i < list.length; i++) if (list[i][0] === name) return i;
        return 99;
    }

    /** Keeps the kit (and therefore the kill-box geometry) stable: it only changes to a strictly better kit
     *  while nothing is built yet or once the current layout is complete (turrets upgrade in place). */
    function proMergeKit(old, fresh, complete, nothingBuilt) {
        if (!old) return fresh;
        var better = proListRank(KIT_MAIN, fresh.main) < proListRank(KIT_MAIN, old.main)
            || (fresh.front && (!old.front || proListRank(KIT_FRONT, fresh.front) < proListRank(KIT_FRONT, old.front)))
            || (fresh.support === "mend-projector" && old.support !== "mend-projector")
            || (fresh.wantForce && !old.wantForce) || (fresh.wantOverdrive && !old.wantOverdrive);
        if (better && (complete || nothingBuilt)) return fresh;
        old.ammo = fresh.ammo || old.ammo;
        return old;
    }

    function proKillBox(core, budget, stock, netPower, usableMap) {
        var pro = bot.pro;
        if (!pro.choke || !pro.scan) return null;
        var fullStock = coreBudget(core);
        var fresh = chooseFortressKit(usableMap, function (nm, cnt) {
            var blk = proBlock(nm);
            return !!blk && reserve(fullStock.slice(), blk, cnt);
        }, stock, netPower, pro.brain.plan ? pro.brain.plan.ammo : "");
        var kit = proMergeKit(pro.kit, fresh, pro.fortTotal > 0 && pro.fortSat >= pro.fortTotal * 0.8, pro.fortTurretsBuilt === 0);
        pro.kit = kit;
        var key = [kit.main, kit.front, kit.support, kit.wantForce ? 1 : 0, kit.wantOverdrive ? 1 : 0, pro.choke.cx, pro.choke.cy].join("|");
        if (pro.kill && pro.killKey === key) return pro.kill;
        pro.kill = buildKillBox(Vars.world.width(), Vars.world.height(), pro.scan.passable, pro.choke, {
            frontSize: kit.front ? kit.frontSize : 1, mainSize: kit.mainSize, supportSize: kit.support ? kit.supportSize : 1,
            wantForce: kit.wantForce, wantOverdrive: kit.wantOverdrive
        });
        pro.killKey = key;
        pro.busPlan = null; // the spine moves with the kit: recompute the bus
        botLog("укрепрайон: горлышко " + pro.choke.width + " тайлов, " + compassFlank(pro.choke.cx - core.tileX(), pro.choke.cy - core.tileY())
            + ", ударные: " + (kit.main || "—") + ", передний ряд: " + (kit.front || "—"));
        return pro.kill;
    }

    /** Does the current kit/unlock state provide a block for this slot at all? */
    function proSlotWanted(role, size, layer, kb, kit, usableMap) {
        if (role === ROLE_WALL || role === ROLE_WALL_WINDOW || role === ROLE_WALL_INNER) {
            return pickFortressWalls(role, size, layer, kb.flankLayers, usableMap).length > 0;
        }
        if (role === ROLE_GROUND_TURRET) return !!kit.main;
        if (role === ROLE_FRONT_TURRET) return !!kit.front;
        if (role === ROLE_SUPPORT) return !!kit.support;
        if (role === ROLE_POWER_NODE) return !!usableMap["power-node"];
        if (role === ROLE_FORCE) return !!usableMap["force-projector"];
        if (role === ROLE_OVERDRIVE) return !!usableMap["overdrive-projector"];
        return false;
    }

    function proPlanFortress(team, budget, kb, kit, usableMap, out) {
        var pro = bot.pro;
        var total = 0, sat = 0, turretsBuilt = 0;
        var wallsOpen = proWallsGate(pro);
        for (var s = 0; s + 4 < kb.slots.length; s += 5) {
            var sx = kb.slots[s], sy = kb.slots[s + 1], size = kb.slots[s + 2], role = kb.slots[s + 3], layer = kb.slots[s + 4];
            var isWall = role === ROLE_WALL || role === ROLE_WALL_WINDOW || role === ROLE_WALL_INNER;
            if (!proSlotWanted(role, size, layer, kb, kit, usableMap)) continue;
            total++;
            if (proSlotSatisfied(sx, sy, role, team)) {
                sat++;
                if (role === ROLE_GROUND_TURRET || role === ROLE_FRONT_TURRET) turretsBuilt++;
                continue;
            }
            if (isWall && !wallsOpen) continue;
            var cands = [];
            if (isWall) {
                var wn = pickFortressWalls(role, size, layer, kb.flankLayers, usableMap);
                for (var q = 0; q < wn.length; q++) cands.push(proBlock(wn[q]));
            } else if (role === ROLE_GROUND_TURRET) cands.push(proBlock(kit.main));
            else if (role === ROLE_FRONT_TURRET) cands.push(kit.front ? proBlock(kit.front) : null);
            else if (role === ROLE_SUPPORT) cands.push(kit.support ? proBlock(kit.support) : null);
            else if (role === ROLE_POWER_NODE) cands.push(usableMap["power-node"] ? Blocks.powerNode : null);
            else if (role === ROLE_FORCE) cands.push(proBlock("force-projector"));
            else if (role === ROLE_OVERDRIVE) cands.push(proBlock("overdrive-projector"));
            var list = isWall ? out.walls : out.turrets;
            var limit = isWall ? 12 : MAX_DEFENSE_PLANS_PER_CYCLE;
            if (list.length >= limit) continue;
            for (var c = 0; c < cands.length; c++) {
                var blk = cands[c];
                if (!blk || blk.size !== size || !usable(blk)) continue;
                if (bot.rejectedSites[packCoord(sx, sy)] || !Build.validPlace(blk, team, sx, sy, 0)) continue;
                if (!reserve(budget, blk, 1)) continue;
                list.push(new BuildPlan(sx, sy, 0, blk));
                break;
            }
        }
        pro.fortTotal = total; pro.fortSat = sat; pro.fortTurretsBuilt = turretsBuilt;
    }

    function proPieceBlock(type, usableMap) {
        if (type === BUS_UNLOADER) return Blocks.unloader;
        if (type === BUS_ROUTER) return Blocks.router;
        if (type === BUS_JUNCTION) return Blocks.junction;
        return usableMap["titanium-conveyor"] ? Blocks.titaniumConveyor : Blocks.conveyor;
    }

    /** Ammo bus: Unloader at the core -> conveyor -> Router/Junction spine behind the turret rows. */
    function proPlanBus(core, team, budget, cells, origin, size, kb, kit, usableMap, stock, outPlans) {
        var pro = bot.pro;
        if (!kb || kb.spineLen < 3 || !usableMap["router"] || !usableMap["junction"]) return;
        if (pro.fortTurretsBuilt < 2) return;
        if (pro.busFails >= 3) return;
        var ammoName = (pro.brain.plan && pro.brain.plan.ammo && turretAcceptsAmmo(kit.main, pro.brain.plan.ammo)) ? pro.brain.plan.ammo : (kit.ammo || "");
        if (!pro.busPlan) {
            var spineWin = [];
            for (var i = 0; i < kb.spineLen; i++) {
                var wx = kb.spine[i * 2] - origin[0], wy = kb.spine[i * 2 + 1] - origin[1];
                if (wx < 0 || wy < 0 || wx >= size || wy >= size) break;
                spineWin.push(wx, wy);
            }
            if (spineWin.length < 6) { pro.busFails = 3; return; }
            var unl = null;
            if (usableMap["unloader"]) {
                var ui = findBusUnloaderCell(size, size, cells, spineWin[0], spineWin[1]);
                if (ui >= 0) unl = { x: ui % size, y: Math.floor(ui / size) };
            }
            var bus = planAmmoBus(size, size, cells, unl, spineWin);
            if (!bus.ok) { pro.busFails++; botLog("шина боепитания: " + bus.reason); return; }
            var pieces = [];
            for (var p = 0; p + 3 < bus.pieces.length; p += 4) {
                pieces.push([origin[0] + bus.pieces[p], origin[1] + bus.pieces[p + 1], bus.pieces[p + 2], bus.pieces[p + 3]]);
            }
            pro.busPlan = { pieces: pieces, hasUnloader: !!unl, spine0: [kb.spine[0], kb.spine[1]], len: pieces.length, ammo: ammoName };
            botLog("шина боепитания: " + pieces.length + " блоков (" + (unl ? "Unloader" : "без Unloader") + "), патрон: " + (ammoName || "—"));
        }
        var bp = pro.busPlan, missing = 0, queued = 0;
        for (var k = 0; k < bp.pieces.length; k++) {
            var pc = bp.pieces[k];
            var blk = proPieceBlock(pc[2], usableMap);
            var t = Vars.world.tile(pc[0], pc[1]);
            if (t && t.build && t.build.team === team && (t.build.block === blk || (pc[2] === BUS_CONVEYOR && String(t.build.block.name).indexOf("conveyor") >= 0))) continue;
            missing++;
            if (queued >= 24) continue;
            if (!Build.validPlace(blk, team, pc[0], pc[1], pc[3])) { pro.busFails++; pro.busPlan = null; return; }
            if (!reserve(budget, blk, 1)) continue;
            var cfg = (pc[2] === BUS_UNLOADER && ammoName && proItem(ammoName)) ? proItem(ammoName) : null;
            outPlans.push(new BuildPlan(pc[0], pc[1], pc[3], blk, cfg));
            queued++;
        }
        pro.busBuilt = missing === 0;
    }

    function proRetuneBus(team, nowSec) {
        var pro = bot.pro;
        if (!pro.busPlan || !pro.busBuilt || nowSec - pro.lastRetuneSec < 6) return;
        pro.lastRetuneSec = nowSec;
        var ammo = pro.brain.plan ? pro.brain.plan.ammo : "";
        if (!ammo || !pro.kit || !turretAcceptsAmmo(pro.kit.main, ammo)) ammo = pro.kit ? pro.kit.ammo : "";
        var item = ammo ? proItem(ammo) : null;
        if (!item) return;
        for (var i = 0; i < pro.busPlan.pieces.length; i++) {
            var pc = pro.busPlan.pieces[i];
            if (pc[2] !== BUS_UNLOADER) continue;
            var t = Vars.world.tile(pc[0], pc[1]);
            if (t && t.build && t.build.team === team && t.build.block === Blocks.unloader && t.build.config() !== item) {
                Call.tileConfig(Vars.player, t.build, item);
                pro.ammoNow = ammo;
            }
        }
    }

    function proAaPlans(core, team, budget, usableMap, stock, data, outPlans) {
        var pro = bot.pro;
        var ladder = ["cyclone", "salvo", "scatter"], blk = null;
        for (var i = 0; i < ladder.length && !blk; i++) {
            var cand = proBlock(ladder[i]);
            if (!cand || !usableMap[ladder[i]] || !reserve(budget.slice(), cand, 2)) continue;
            if (!chooseAmmoItem(ladder[i], stock, null, "")) continue;
            blk = cand;
        }
        if (!blk) return;
        var gens = [];
        seqEach(data.buildings, function (b) { if (b.block && b.block.outputsPower && b.block !== Blocks.solarPanel) { var t = proTileOf(b); gens.push(t[0], t[1]); } });
        var sp = null;
        seqEach(Vars.spawner.getSpawns(), function (s) { if (!sp) sp = [typeof s.x === "number" ? s.x : Math.round(s.worldx() / Vars.tilesize), typeof s.y === "number" ? s.y : Math.round(s.worldy() / Vars.tilesize)]; });
        if (!sp) {
            var ed = Vars.state.teams.get(Vars.state.rules.waveTeam);
            if (ed && ed.cores.size > 0) sp = proTileOf(ed.cores.first());
        }
        if (!sp) return;
        var slots = planAaCorridor(core.tileX(), core.tileY(), sp[0], sp[1], gens, { count: 4 });
        var built = 0;
        seqEach(data.buildings, function (b) {
            var nm = b.block ? String(b.block.name) : "";
            if (nm === "scatter" || nm === "cyclone" || nm === "swarmer") built++;
        });
        pro.aaBuilt = built;
        for (var s2 = 0; s2 + 2 < slots.length && outPlans.length < 2; s2 += 3) {
            var spot = findSpotNear(blk, team, slots[s2], slots[s2 + 1], 3);
            if (!spot) continue;
            var near = false;
            for (var dy = -4; dy <= 4 && !near; dy++) {
                for (var dx = -4; dx <= 4; dx++) {
                    var tl = Vars.world.tile(spot[0] + dx, spot[1] + dy);
                    if (tl && tl.build && tl.build.team === team && tl.build.block && (tl.build.block === Blocks.scatter || String(tl.build.block.name) === "cyclone")) { near = true; break; }
                }
            }
            if (near) continue;
            if (reserve(budget, blk, 1)) outPlans.push(new BuildPlan(spot[0], spot[1], 0, blk));
        }
    }

    function proBreachPlans(core, team, budget, usableMap, outPlans) {
        var pro = bot.pro;
        var br = pro.breach;
        if (!br || pro.breachHandled === br.wave) return;
        var ladder = br.air ? ["cyclone", "salvo", "scatter"] : [pro.kit ? pro.kit.main : "duo", "salvo", "hail", "duo"];
        var tx = Math.round(br.x), ty = Math.round(br.y);
        var made = 0;
        for (var i = 0; i < ladder.length && made < 2; i++) {
            var blk = proBlock(ladder[i]);
            if (!blk || !usableMap[ladder[i]]) continue;
            var spot = findSpotNear(blk, team, tx, ty, 6);
            if (spot && reserve(budget, blk, 1)) { outPlans.push(new BuildPlan(spot[0], spot[1], 0, blk)); made++; }
        }
        var sup = proBlock(usableMap["mend-projector"] ? "mend-projector" : "mender");
        if (sup && usable(sup)) {
            var sSpot = findSpotNear(sup, team, tx, ty, 7);
            if (sSpot && reserve(budget, sup, 1)) outPlans.push(new BuildPlan(sSpot[0], sSpot[1], 0, sup));
        }
        pro.breachHandled = br.wave;
        botLog("усиливаю пробитое направление " + br.flank + " (" + outPlans.length + " постр.)");
    }

    /** Reactor safety: cryofluid first. The reactor is only queued after the mixer holds coolant. */
    function proReactorPlans(core, team, budget, usableMap, stock, data, netPower, cells, origin, size, outPlans) {
        var pro = bot.pro, rs = pro.reactor;
        if (!usableMap["thorium-reactor"] || !usableMap["cryofluid-mixer"] || !usableMap["water-extractor"]) return;
        var existing = countBlock(data, Blocks.thoriumReactor);
        if (existing > 0) return;
        if ((stock["thorium"] || 0) < 120 || (stock["titanium"] || 0) < 120 || netPower < 90) return;
        var away = [1, 0];
        var sp = pro.scan && pro.scan.paths.length ? [pro.scan.paths[0].xs[0], pro.scan.paths[0].ys[0]] : null;
        if (sp) away = [sp[0] - core.tileX(), sp[1] - core.tileY()];
        if (!rs.site) {
            var wcells = cells;
            var site = findReactorSite(size, size, wcells, size >> 1, size >> 1, away[0], away[1], 14, 30);
            if (!site) return;
            rs.site = { rx: origin[0] + site.rx, ry: origin[1] + site.ry, mx: origin[0] + site.mx, my: origin[1] + site.my, ex: origin[0] + site.ex, ey: origin[1] + site.ey };
        }
        var S = rs.site;
        var mixer = Blocks.cryofluidMixer, ext = Blocks.waterExtractor, rea = Blocks.thoriumReactor;
        var mt = Vars.world.tile(S.mx, S.my), mb = mt && mt.build && mt.build.block === mixer ? mt.build : null;
        if (!mb) {
            if (Build.validPlace(mixer, team, S.mx, S.my, 0) && reserve(budget, mixer, 1)) outPlans.push(new BuildPlan(S.mx, S.my, 0, mixer));
            var et = Vars.world.tile(S.ex, S.ey);
            if (!(et && et.build) && Build.validPlace(ext, team, S.ex, S.ey, 0) && reserve(budget, ext, 1)) outPlans.push(new BuildPlan(S.ex, S.ey, 0, ext));
            var pn = findSpotNear(Blocks.powerNode, team, S.mx + 2, S.my + 2, 3);
            if (pn && reserve(budget, Blocks.powerNode, 1)) outPlans.push(new BuildPlan(pn[0], pn[1], 0, Blocks.powerNode));
            return;
        }
        var frac = 0;
        try { frac = mb.liquids.currentAmount() / Math.max(1, mb.block.liquidCapacity); } catch (e) { frac = 0; }
        var why = reactorGuard({
            reactorUnlocked: true, mixerBuilt: true, mixerCryoFrac: frac, waterOk: true,
            titaniumStock: stock["titanium"] || 0, thoriumStock: stock["thorium"] || 0,
            siteDistFromCore: distPointToPoint(S.rx, S.ry, core.tileX(), core.tileY()), powerNetPerSec: netPower
        });
        if (why) { bot.pro.reactorWhy = why; return; }
        if (Build.validPlace(rea, team, S.rx, S.ry, 0) && reserve(budget, rea, 1)) {
            outPlans.push(new BuildPlan(S.rx, S.ry, 0, rea));
            botLog("реактор: охлаждение подтверждено (" + Math.round(frac * 100) + "%), ставлю Thorium Reactor");
        }
    }

    /** Emergency fuel cut: a hot reactor with low coolant gets its fuel pulled. */
    function proReactorWatch(data, team) {
        seqEach(data.buildings, function (b) {
            if (!b.block || String(b.block.name) !== "thorium-reactor") return;
            var heat = typeof b.heat === "number" ? b.heat : 0;
            var cryo = 0;
            try { cryo = b.liquids.currentAmount() / Math.max(1, b.block.liquidCapacity); } catch (e) { cryo = 1; }
            if (reactorShouldCutFuel(heat, cryo)) {
                try { b.items.clear(); } catch (e) { /* fuel cut is best effort */ }
                bot.pro.brain.markEvent("reactor");
            }
        });
    }

    // ---------------------------------------------------------- RTS helpers

    function proEnemyCandidates(enemyData, core) {
        var cands = [], turrets = 0, disarmed = 0, threats = [];
        seqEach(enemyData.buildings, function (eb) {
            if (!eb || !eb.block || cands.length >= 160) return;
            var t = proTileOf(eb), b = eb.block, kind = null, powered = true;
            var isTurret = b.targetGround !== undefined || !!b.ammoTypes;
            if (b.outputsPower) kind = "generator";
            else if (typeof b.maxNodes === "number") kind = "power-node";
            else if (String(b.name).indexOf("battery") >= 0) kind = "battery";
            else if (isTurret) {
                kind = "turret"; turrets++;
                var armed = true;
                try { armed = typeof eb.hasAmmo === "function" ? eb.hasAmmo() : true; } catch (e) { armed = true; }
                if (eb.power && typeof eb.power.status === "number" && eb.power.status < 0.05 && b.consumesPower) armed = false;
                powered = armed;
                if (!armed) disarmed++;
                var rng = 0;
                try { rng = eb.range ? eb.range() : 0; } catch (e) { rng = 0; }
                threats.push({ x: t[0], y: t[1], r: Math.max(6, rng / Vars.tilesize + 2), weight: 1 });
            } else if (b.plans) kind = "factory";
            else if (typeof BlockGroup !== "undefined" && b.group === BlockGroup.transportation) kind = "ammo-feed";
            if (kind) cands.push({ kind: kind, x: t[0], y: t[1], powered: powered, build: eb });
        });
        seqEach(enemyData.cores, function (ec) { var t = proTileOf(ec); cands.push({ kind: "core", x: t[0], y: t[1], powered: true, build: ec }); });
        return { cands: cands, turrets: turrets, disarmed: disarmed, threats: threats };
    }

    function proAssaultCommand(ids, combat, core, team, enemyData, nowSec) {
        var pro = bot.pro;
        var info = proEnemyCandidates(enemyData, core);
        pro.enemyKnown = info.cands.length > 0;
        pro.enemyPower = 0;
        for (var i = 0; i < info.cands.length; i++) if (info.cands[i].kind === "generator" || info.cands[i].kind === "power-node") pro.enemyPower++;
        if (!info.cands.length) return null;
        var ref = { x: core.tileX(), y: core.tileY() };
        var pick = pickAssaultTarget(info.cands, ref, { turrets: info.turrets, disarmed: info.disarmed });
        if (pick < 0) return null;
        var target = info.cands[pick];
        var cx = 0, cy = 0, groundN = 0;
        for (var u = 0; u < combat.length; u++) {
            cx += combat[u].x; cy += combat[u].y;
            if (!unitFlying(combat[u])) groundN++;
        }
        cx = Math.round(cx / combat.length / Vars.tilesize); cy = Math.round(cy / combat.length / Vars.tilesize);
        var key = target.kind + ":" + target.x + ":" + target.y;
        var w = Vars.world.width(), h = Vars.world.height();
        if (pro.routeKey !== key || nowSec - pro.routeAt > 25) {
            var danger = buildDangerGrid(w, h, info.threats);
            var ground = groundN * 2 >= combat.length && pro.scan && pro.scan.passable ? pro.scan.passable : null;
            pro.route = planFlankRoute(w, h, danger, ground, cx, cy, target.x, target.y, {});
            if (pro.routeKey !== key) pro.routeIdx = 0;
            pro.routeKey = key; pro.routeAt = nowSec;
            if (pro.route.useFlank) botLog("штурм: обход по флангу к цели «" + target.kind + "» (" + pro.route.waypoints.length / 2 + " точек)");
        }
        var wp = pro.route.waypoints;
        while (pro.routeIdx * 2 + 3 < wp.length && distPointToPoint(cx, cy, wp[pro.routeIdx * 2], wp[pro.routeIdx * 2 + 1]) < 8) pro.routeIdx++;
        var last = pro.routeIdx * 2 + 2 >= wp.length;
        return { target: target, wx: wp[pro.routeIdx * 2], wy: wp[pro.routeIdx * 2 + 1], last: last, flank: pro.route.useFlank, threats: info.threats.length };
    }

    function proRepairSpot(team, core) {
        var best = null, bd = 1e12;
        var data = Vars.state.teams.get(team);
        if (!data) return null;
        seqEach(data.buildings, function (b) {
            if (!b.block) return;
            var nm = String(b.block.name);
            if (nm !== "repair-point" && nm !== "mend-projector") return;
            var d = b.dst(core);
            if (d < bd) { bd = d; best = b; }
        });
        return best ? new Vec2(best.x, best.y) : new Vec2(core.x, core.y);
    }

    function proWantAa(plan) {
        var pro = bot.pro;
        if (pro.aaBuilt >= 2 && !(pro.breach && pro.breach.air && pro.breachHandled !== pro.breach.wave)) return false;
        if (plan && plan.priority === "BUILD_AA_SHIELD") return true;
        var sc = pro.sched;
        var wave = Vars.state.wave || 1;
        if (sc && sc.nextAirWave > 0 && sc.nextAirWave - wave <= 2) return true;
        return pro.heat.total > 0 && pro.heat.airShare() >= 0.5;
    }

    function proNearBus(b) {
        var bp = bot.pro.busPlan;
        if (!bp || !bp.spine0) return false;
        var reach = (bot.pro.kill ? bot.pro.kill.spineLen : 9) + 8;
        return distPointToPoint(b.x / Vars.tilesize, b.y / Vars.tilesize, bp.spine0[0], bp.spine0[1]) <= reach;
    }

    function proIncome(stock, nowSec) {
        var pro = bot.pro;
        var snap = pro.itemSnap;
        if (!snap) { pro.itemSnap = { t: nowSec, items: stock }; pro.income = {}; return pro.income; }
        if (nowSec - snap.t >= 20) {
            var inc = {}, keys = Object.keys(stock);
            for (var i = 0; i < keys.length; i++) inc[keys[i]] = (stock[keys[i]] - (snap.items[keys[i]] || 0)) / (nowSec - snap.t);
            pro.income = inc;
            pro.itemSnap = { t: nowSec, items: stock };
        }
        return pro.income || {};
    }

    var PRO_TURRET_NAMES = ["duo", "hail", "scatter", "lancer", "salvo", "ripple", "cyclone", "swarmer", "spectre", "fuse", "arc", "scorch"];

    function proBuildSit(core, data, team, netPower, usableMap, stock, nowSec) {
        var pro = bot.pro;
        var wave = Vars.state.wave || 0;
        if (!pro.sched || pro.schedWave !== wave) {
            pro.sched = analyzeWaveSchedule(proWaveGroups(), Math.max(0, wave - 1), 5, 150);
            pro.schedWave = wave;
        }
        var turrets = 0, aa = 0;
        seqEach(data.buildings, function (b) {
            if (!b.block) return;
            if (b.block.ammoTypes || (b.block.targetGround !== undefined && b.estimateDps)) turrets++;
            var nm = String(b.block.name);
            if (nm === "scatter" || nm === "cyclone" || nm === "swarmer") aa++;
        });
        pro.aaBuilt = aa;
        var avail = [];
        for (var i = 0; i < PRO_TURRET_NAMES.length; i++) if (usableMap[PRO_TURRET_NAMES[i]]) avail.push(PRO_TURRET_NAMES[i]);
        var ch = pro.choke;
        var breach = pro.breach && pro.breachHandled !== pro.breach.wave ? { air: pro.breach.air, flank: pro.breach.flank, amount: pro.breach.amount } : null;
        var v1Done = !pro.choke && turrets >= 4;
        var fortressBuilt = pro.choke ? (pro.fortTotal > 0 && pro.fortSat >= pro.fortTotal * 0.85) : v1Done;
        var sit = {
            attackMode: !!Vars.state.rules.attackMode, sectorName: pro.sectorKey || "?", wave: wave, winWave: Vars.state.rules.winWave || 0,
            enemies: Vars.state.enemies || 0, coreName: String(core.block.name).replace("core-", ""),
            items: stock, income: proIncome(stock, nowSec), power: netPower / 60, forecast: pro.sched,
            chokeCount: pro.chokes.length, chokeWidth: ch ? ch.width : 0, chokeDist: ch ? ch.dist : 0,
            chokeFlank: ch ? compassFlank(ch.cx - core.tileX(), ch.cy - core.tileY()) : "any",
            weakFlank: pro.heat.total > 0 ? pro.heat.dominantFlank(core.tileX(), core.tileY()) : "",
            breach: breach, fortressBuilt: fortressBuilt, aaBuilt: aa >= 2, busBuilt: pro.busBuilt,
            turrets: turrets, defenseDps: pro.lastDps || 0, armyUnits: pro.armyCount || 0,
            turretsAvailable: avail, aaAvailable: !!(usableMap["scatter"] || usableMap["cyclone"] || usableMap["salvo"]),
            busPossible: !!(pro.kill && usableMap["router"] && usableMap["junction"] && pro.busFails < 3),
            smelterAvailable: usable(Blocks.siliconSmelter), airChainAvailable: usable(Blocks.airFactory) && usable(Blocks.additiveReconstructor),
            enemyBaseKnown: !!pro.enemyKnown, enemyPowerNodes: pro.enemyPower || 0,
            canCallWave: !!Vars.state.rules.waves && !!Vars.state.rules.waveSending && !Vars.state.rules.attackMode,
            itemUnlocked: null
        };
        pro.lastSit = sit;
        return sit;
    }

    /** One decision tick. Never throws: a failing stage is logged once and skipped. */
    function thinkInSector(unit) {
        return loopSafe("решение в секторе", function () { return thinkInSectorStep(unit); }, undefined);
    }

    function thinkInSectorStep(unit) {
        var nowSec = Time.time / 60;
        var sector = Vars.state.getSector();

        if (Time.time >= bot.nextResearchTime) {
            bot.nextResearchTime = Time.time + 180;
            var unlocked = runResearchPass();
            if (unlocked) botLog("наука: изучено " + unlocked);
            if (checkVictory()) return;
        }

        var team = Vars.player.team();
        var core = Vars.player.closestCore();
        if (!core) { bot.lastAction = "ожидание ядра..."; return; }
        var data = Vars.state.teams.get(team);

        proEnterSector(sector, core, nowSec);
        proStepScan(core);
        proSafe("тепловая карта", function () { proUpdateHeat(data, team, core, nowSec); }, null);

        loopSafe("заводы и энергия", function () { maintainFactoriesAndPower(data, team); }, null);
        loopSafe("армия", function () { updateArmySquads(data, core, team, sector); }, null);

        var captured = !!(sector && sector.isCaptured());
        if (captured && bot.capturedSinceSec < 0) bot.capturedSinceSec = nowSec;

        var obs = {
            captured: captured,
            holdAfterCapture: false,
            attackMode: !!Vars.state.rules.attackMode,
            playerAlive: !!unit
        };

        if (captured) {
            var capMax = Math.max(1, core.storageCapacity);
            var fill = Math.max(core.items.get(Items.copper) / capMax, core.items.get(Items.lead) / capMax, core.items.get(Items.silicon) / capMax);
            var producesNeeded = false;
            if (sector.info && sector.info.resources) {
                seqEach(sector.info.resources, function (uc) {
                    if (uc && bot.neededItems[String(uc.name)]) producesNeeded = true;
                });
            }
            var anotherAttacked = false, hasLaunchable = false;
            seqEach(Planets.serpulo.sectors, function (s) {
                if (s !== sector && s.hasBase() && s.isAttacked()) anotherAttacked = true;
                if (s.preset && s.preset.requireUnlock && !s.isCaptured() && isUnlockedToSelect(s) && findValidLaunchOrigin(s, sector)) {
                    hasLaunchable = true;
                }
            });
            obs.holdAfterCapture = shouldHoldCapturedSector(
                anotherAttacked, hasLaunchable, canAnyBaseAffordBasicLaunch(),
                producesNeeded, fill, Math.max(0, nowSec - bot.capturedSinceSec)
            );
        }

        if (!unit) {
            if (bot.deadSinceSec < 0) bot.deadSinceSec = nowSec;
            if (nowSec - bot.deadSinceSec > RESPAWN_WAIT_SECONDS) {
                failBot("юнит ядра не возрождается дольше " + RESPAWN_WAIT_SECONDS + " с");
                return;
            }
            bot.lastAction = "ждём возрождения юнита";
            bot.transferStage = 0;
            return;
        }
        bot.deadSinceSec = -1;

        for (var p = bot.ownPlans.length - 1; p >= 0; p--) {
            if (unit.plans.indexOf(bot.ownPlans[p], true) < 0) bot.ownPlans.splice(p, 1);
        }
        var headPlan = unit.plans.size > 0 ? unit.buildPlan() : null;
        var builtCount = Vars.state.stats ? Vars.state.stats.buildingsBuilt : 0;
        var token = builtCount * 1000000 + unit.plans.size * 1000 + (headPlan ? Math.floor(headPlan.progress * 999) : 0);
        if (bot.watchdog.stalled(unit.plans.size > 0, token, nowSec)) {
            if (headPlan) bot.rejectedSites[packCoord(headPlan.x, headPlan.y)] = true;
            haltUnitActions();
            botLog("сброшен застрявший план строительства");
        }
        if (unit.plans.size > 0) Vars.control.input.isBuilding = true;

        obs.buildQueue = unit.plans.size;
        obs.rearmInProgress = bot.transferStage !== 0 && !!bot.transferTarget && memberValid(bot.transferTarget);
        if (!obs.rearmInProgress) bot.transferStage = 0;

        var budget = coreBudget(core);
        var netPower = computeNetPowerPerSec(data);
        obs.drills = countDrills(data);

        var corePlans = [], powerPlans = [], defPlans = [], rebPlans = [], drlPlans = [], indPlans = [], armPlans = [];
        var rearmTarget = null, rearmItem = null, courierTarget = null, courierItem = null, mineTile = null;
        var coreLbl = "", powLbl = "", drlLbl = "", indLbl = "", armLbl = "";

        // Power deficit check
        var gens = 0, unpowered = null, poweredAnchor = null;
        seqEach(data.buildings, function (b) {
            if (b.block.outputsPower) gens++;
            if (!unpowered && b.block.consumesPower && b.power && b.power.graph.producers.isEmpty()) unpowered = b;
            if (!poweredAnchor && (b.block.outputsPower || typeof b.block.maxNodes === "number") && b.power && !b.power.graph.producers.isEmpty()) {
                poweredAnchor = b;
            }
        });
        obs.powerNeeded = usable(Blocks.powerNode) && (!!unpowered || (gens === 0 && obs.drills >= 3 && usable(Blocks.combustionGenerator)) || (netPower < 90 && gens < 10));

        var usableMap = proSafe("блоки", proUsableMap, {});
        var stockMap = proSafe("склад", function () { return proStockMap(core); }, {});
        var sit = proSafe("оценка ситуации", function () { return proBuildSit(core, data, team, netPower, usableMap, stockMap, nowSec); }, null);
        var brainPlan = sit ? proSafe("мозг", function () { return bot.pro.brain.update(sit); }, null) : null;
        bot.pro.plan = brainPlan;
        if (brainPlan) { obs.priority = brainPlan.priority; obs.aggression = brainPlan.aggression; }
        proSafe("шина", function () { proRetuneBus(team, nowSec); }, null);
        proSafe("реактор", function () { proReactorWatch(data, team); }, null);

        if (obs.buildQueue === 0 && !obs.rearmInProgress) {
            var size = WINDOW_RADIUS * 2 + 1;
            var cells = [], ore = [];
            var origin = buildWindow(core, team, cells, ore);
            var hasUnloader = usable(Blocks.unloader);
            proSafe("зоны ядра", function () {
                applyCoreZones(size, size, cells, WINDOW_RADIUS, WINDOW_RADIUS, core.block.size, 12,
                    core.block.size === 4 && usable(Blocks.coreNucleus), ore);
            }, 0);

            // 1. Rearm check
            var bestRearmDst = 1e12;
            seqEach(data.buildings, function (b) {
                if (!b.block || !b.block.ammoTypes || typeof b.totalAmmo !== "number") return;
                if (b.totalAmmo >= b.block.maxAmmo * REARM_FRACTION) return;
                // bus-fed turrets are only hand-fed in an emergency (<15% ammo)
                if (bot.pro.busBuilt && b.totalAmmo >= b.block.maxAmmo * 0.15 && proNearBus(b)) return;
                var bestIt = null, bestAmt = 0;
                var proAmmo = proSafe("боеприпас", function () {
                    return chooseAmmoItem(String(b.block.name), stockMap, null, brainPlan ? brainPlan.ammo : "");
                }, null);
                var proAmmoItem = proAmmo ? proItem(proAmmo) : null;
                if (proAmmoItem && b.block.ammoTypes.containsKey && b.block.ammoTypes.containsKey(proAmmoItem)) {
                    bestIt = proAmmoItem; bestAmt = core.items.get(proAmmoItem);
                } else seqEach(b.block.ammoTypes.keys().toSeq(), function (it) {
                    var hv = core.items.get(it);
                    if (hv >= MIN_AMMO_STOCK && hv > bestAmt) { bestAmt = hv; bestIt = it; }
                });
                if (bestIt && b.dst(core) < bestRearmDst) {
                    bestRearmDst = b.dst(core);
                    rearmTarget = b;
                    rearmItem = bestIt;
                }
            });
            obs.rearmTargets = rearmTarget ? 1 : 0;

            // 2. Core upgrade
            var coreUpgrades = [Blocks.coreNucleus, Blocks.coreFoundation];
            for (var cu = 0; cu < coreUpgrades.length; cu++) {
                var cb = coreUpgrades[cu];
                if (usable(cb) && cb.size > core.block.size && Build.validPlace(cb, team, core.tileX(), core.tileY(), 0) && reserve(budget, cb, 1)) {
                    corePlans.push(new BuildPlan(core.tileX(), core.tileY(), 0, cb));
                    obs.coreUpgradeReady = true;
                    coreLbl = String(cb.localizedName);
                    break;
                }
            }

            // 3. Power expansion
            if (usable(Blocks.powerNode)) {
                if (unpowered && poweredAnchor) {
                    var d = poweredAnchor.dst(unpowered);
                    var step = Math.min(1, (5 * Vars.tilesize) / Math.max(1, d));
                    var pSpot = findSpotNear(Blocks.powerNode, team,
                        Math.round((poweredAnchor.x + (unpowered.x - poweredAnchor.x) * step) / Vars.tilesize),
                        Math.round((poweredAnchor.y + (unpowered.y - poweredAnchor.y) * step) / Vars.tilesize), 3);
                    if (pSpot && reserve(budget, Blocks.powerNode, 1)) {
                        powerPlans.push(new BuildPlan(pSpot[0], pSpot[1], 0, Blocks.powerNode));
                        obs.powerPossible = true;
                        powLbl = "энергоузел";
                    }
                } else if (netPower < 240) {
                    if (usable(Blocks.steamGenerator) && usable(Blocks.waterExtractor) && (core.items.get(Items.coal) >= 25 || core.items.get(Items.sporePod) >= 25)) {
                        var sLbl = tryPlanHubBlock(origin, size, cells, ore, team, budget, Blocks.steamGenerator, hasUnloader, Blocks.waterExtractor, powerPlans);
                        if (sLbl) { obs.powerPossible = true; powLbl = sLbl; }
                    }
                    if (!obs.powerPossible && usable(Blocks.combustionGenerator) && (core.items.get(Items.coal) >= 15 || core.items.get(Items.sporePod) >= 15)) {
                        var cLbl = tryPlanHubBlock(origin, size, cells, ore, team, budget, Blocks.combustionGenerator, hasUnloader, null, powerPlans);
                        if (cLbl) { obs.powerPossible = true; powLbl = cLbl; }
                    }
                    if (!obs.powerPossible && usable(Blocks.solarPanel)) {
                        var sol = findSpotNear(Blocks.solarPanel, team, core.tileX() + 5, core.tileY() + 5, 5);
                        if (sol && reserve(budget, Blocks.solarPanel, 1)) {
                            powerPlans.push(new BuildPlan(sol[0], sol[1], 0, Blocks.solarPanel));
                            obs.powerPossible = true;
                            powLbl = String(Blocks.solarPanel.localizedName);
                        }
                    }
                }
            }

            // 4. Rebuild
            seqEach(data.plans, function (pl) {
                if (rebPlans.length >= MAX_DEFENSE_PLANS_PER_CYCLE || pl.removed || !usable(pl.block)) return;
                if (Build.validPlace(pl.block, team, pl.x, pl.y, pl.rotation) && reserve(budget, pl.block, 1)) {
                    rebPlans.push(new BuildPlan(pl.x, pl.y, pl.rotation, pl.block, pl.config));
                }
            });
            obs.rebuildSlots = rebPlans.length;

            // 5. Fortress defense (v2.0: chokepoint kill-box, AA corridor, ammo bus; v1 template as fallback)
            if (!captured) {
                var kb = proSafe("укрепрайон", function () { return proKillBox(core, budget, stockMap, netPower, usableMap); }, null);
                if (kb) {
                    var fort = { turrets: [], walls: [] };
                    proSafe("укрепрайон", function () { proPlanFortress(team, budget, kb, bot.pro.kit, usableMap, fort); }, null);
                    var aaPlans = [], busPlans = [], brPlans = [];
                    var wantAa = proWantAa(brainPlan);
                    if (wantAa) proSafe("ПВО", function () { proAaPlans(core, team, budget, usableMap, stockMap, data, aaPlans); }, null);
                    proSafe("шина", function () { proPlanBus(core, team, budget, cells, origin, size, kb, bot.pro.kit, usableMap, stockMap, busPlans); }, null);
                    proSafe("пробитие", function () { proBreachPlans(core, team, budget, usableMap, brPlans); }, null);
                    var groups = brainPlan && brainPlan.priority === "BUILD_AMMO_BUS" ? [brPlans, aaPlans, busPlans, fort.turrets, fort.walls]
                        : [brPlans, aaPlans, fort.turrets, busPlans, fort.walls];
                    for (var gi = 0; gi < groups.length && defPlans.length === 0; gi++) defPlans = groups[gi];
                } else {
                    var aaOnly = [];
                    if (proWantAa(brainPlan)) proSafe("ПВО", function () { proAaPlans(core, team, budget, usableMap, stockMap, data, aaOnly); }, null);
                    if (aaOnly.length) defPlans = aaOnly;
                }
                var scanning = !!(bot.pro.scan && !bot.pro.scanDone) && (Vars.state.wave || 0) < 3 && !(Vars.state.enemies > 0);
                if (!kb && !scanning && defPlans.length === 0) {
                    var threats = [];
                    seqEach(Vars.spawner.getSpawns(), function (sp) { threats.push([sp.worldx(), sp.worldy()]); });
                    var enemyTeamData = Vars.state.teams.get(Vars.state.rules.waveTeam);
                    if (enemyTeamData) seqEach(enemyTeamData.cores, function (ec) { threats.push([ec.x, ec.y]); });

                    var pickFirst = function (arr) {
                        for (var ii = 0; ii < arr.length; ii++) if (usable(arr[ii])) return arr[ii];
                        return null;
                    };
                    var wallB = pickFirst([Blocks.surgeWall, Blocks.thoriumWall, Blocks.plastaniumWall, Blocks.titaniumWall, Blocks.copperWall]);
                    var gTurret = pickFirst([Blocks.salvo, Blocks.lancer, Blocks.scorch, Blocks.hail, Blocks.arc, Blocks.duo]);
                    var aTurret = pickFirst([Blocks.swarmer, Blocks.salvo, Blocks.scatter, Blocks.duo]);
                    var supB = pickFirst([Blocks.mendProjector, Blocks.mender]);

                    for (var ti = 0; ti < threats.length && defPlans.length === 0; ti++) {
                        var dx = threats[ti][0] - core.x, dy = threats[ti][1] - core.y;
                        var tLen = Math.max(1, Math.sqrt(dx * dx + dy * dy));
                        var rDist = Math.min(tLen * 0.45, 22 * Vars.tilesize);
                        var fcx = Math.max(6, Math.min(Vars.world.width() - 7, Math.round((core.x + (dx / tLen) * rDist) / Vars.tilesize)));
                        var fcy = Math.max(6, Math.min(Vars.world.height() - 7, Math.round((core.y + (dy / tLen) * rDist) / Vars.tilesize)));

                        var locDps = 0;
                        seqEach(data.buildings, function (b) {
                            if (b.estimateDps && b.within(fcx * Vars.tilesize, fcy * Vars.tilesize, (b.range ? b.range() : 80) + 24)) {
                                locDps += b.estimateDps();
                            }
                        });
                        if (locDps >= 75 + Vars.state.wave * 18) continue;

                        var tpl = buildFortressTemplate(fcx, fcy, dx, dy);
                        var takenDef = {};
                        var slotSatisfied = function (sx, sy, role) {
                            for (var sdy = -1; sdy <= 1; sdy++) {
                                for (var sdx = -1; sdx <= 1; sdx++) {
                                    var tl = Vars.world.tile(sx + sdx, sy + sdy);
                                    if (!tl || !tl.build || tl.build.team !== team) continue;
                                    var bb = tl.build.block;
                                    if (role === ROLE_WALL && typeof BlockGroup !== "undefined" && bb.group === BlockGroup.walls && sdx === 0 && sdy === 0) return true;
                                    if ((role === ROLE_GROUND_TURRET || role === ROLE_AIR_TURRET) && (bb.ammoTypes || bb.targetGround !== undefined)) return true;
                                    if (role === ROLE_SUPPORT && (bb === Blocks.mender || bb === Blocks.mendProjector)) return true;
                                    if (role === ROLE_POWER_NODE && typeof bb.maxNodes === "number") return true;
                                }
                            }
                            return false;
                        };
                        for (var si = 0; si < tpl.length / 3 && defPlans.length < MAX_DEFENSE_PLANS_PER_CYCLE; si++) {
                            var stx = tpl[si * 3], sty = tpl[si * 3 + 1], role = tpl[si * 3 + 2];
                            if (slotSatisfied(stx, sty, role)) continue;
                            var blk = role === ROLE_WALL ? wallB : role === ROLE_GROUND_TURRET ? gTurret : role === ROLE_AIR_TURRET ? aTurret : role === ROLE_SUPPORT ? supB : (usable(Blocks.powerNode) ? Blocks.powerNode : null);
                            if (!blk) continue;
                            var spSpot = findSpotNear(blk, team, stx, sty, 2);
                            if (!spSpot) continue;
                            var defKey = packCoord(spSpot[0], spSpot[1]);
                            if (takenDef[defKey]) continue;
                            if (reserve(budget, blk, 1)) {
                                var bOff = sizeOffset(blk.size);
                                for (var tdy = 0; tdy < blk.size; tdy++) {
                                    for (var tdx = 0; tdx < blk.size; tdx++) {
                                        takenDef[packCoord(spSpot[0] + bOff + tdx, spSpot[1] + bOff + tdy)] = true;
                                    }
                                }
                                defPlans.push(new BuildPlan(spSpot[0], spSpot[1], 0, blk));
                            }
                        }
                    }
                }
                obs.defenseSlots = defPlans.length;
            }

            // 6. Drills + Conveyors
            if (obs.drills < MAX_DRILLS) {
                var belt = usable(Blocks.titaniumConveyor) && (budget[Items.titanium.id] || 0) >= 80 ? Blocks.titaniumConveyor : Blocks.conveyor;
                var candDrills = [];
                if (usable(Blocks.blastDrill) && netPower > 200) candDrills.push(Blocks.blastDrill);
                if (usable(Blocks.laserDrill) && netPower > 80) candDrills.push(Blocks.laserDrill);
                if (usable(Blocks.pneumaticDrill)) candDrills.push(Blocks.pneumaticDrill);
                if (usable(Blocks.mechanicalDrill)) candDrills.push(Blocks.mechanicalDrill);

                if (usable(belt) && candDrills.length > 0) {
                    var maxTier = 0;
                    for (var cd = 0; cd < candDrills.length; cd++) maxTier = Math.max(maxTier, candDrills[cd].tier);
                    var names = [], stocks = [], weights = [], avail = [];
                    seqEach(Vars.content.items(), function (it) {
                        names[it.id] = String(it.name);
                        stocks[it.id] = core.items.get(it);
                        weights[it.id] = itemWeight(String(it.name), netPower < 80, core.items.get(Items.graphite) < 200, core.items.get(Items.silicon) < 400, true, true);
                        avail[it.id] = false;
                    });
                    for (var oi = 0; oi < ore.length; oi++) {
                        if (ore[oi] >= 0 && Vars.content.item(ore[oi]).hardness <= maxTier) avail[ore[oi]] = true;
                    }
                    var rankedItems = rankItems(names, stocks, avail, weights);
                    for (var ri = 0; ri < rankedItems.length; ri++) {
                        var itemIdx = rankedItems[ri];
                        var tgtItem = Vars.content.item(itemIdx);
                        var chosenD = null;
                        for (var di = 0; di < candDrills.length; di++) {
                            if (tgtItem.hardness <= candDrills[di].tier) { chosenD = candDrills[di]; break; }
                        }
                        if (!chosenD) continue;
                        var site = findDrillSite(size, size, cells, ore, itemIdx, chosenD.size, MAX_CONVEYOR_PATH);
                        if (!site) continue;
                        var bx = origin[0] + site.x, by = origin[1] + site.y;
                        if (!Build.validPlace(chosenD, team, bx, by, 0)) {
                            bot.rejectedSites[packCoord(bx, by)] = true;
                            continue;
                        }
                        var dWork = budget.slice();
                        if (!reserve(dWork, chosenD, 1) || !reserve(dWork, belt, site.pathLength)) continue;
                        var dList = [new BuildPlan(bx, by, 0, chosenD)];
                        var pathOk = true;
                        for (var ps = 0; ps < site.pathLength; ps++) {
                            var cxp = origin[0] + site.path[ps * 3], cyp = origin[1] + site.path[ps * 3 + 1], rot = site.path[ps * 3 + 2];
                            if (!Build.validPlace(belt, team, cxp, cyp, rot)) { pathOk = false; break; }
                            dList.push(new BuildPlan(cxp, cyp, rot, belt));
                        }
                        if (!pathOk || dList.length > MAX_PLANS_PER_CYCLE) continue;
                        for (var wi = 0; wi < dWork.length; wi++) budget[wi] = dWork[wi];
                        drlPlans = dList;
                        obs.drillPossible = true;
                        drlLbl = chosenD.localizedName + " (" + tgtItem.localizedName + ")";
                        break;
                    }
                }
            }

            // 7. Industry chains
            var tryChain = [
                [Blocks.graphitePress, null, Items.graphite, 800, 2],
                [Blocks.siliconSmelter, null, Items.silicon, 1800, obs.priority === "EXPAND_SILICON_ECONOMY" ? 5 : 3],
                [Blocks.kiln, null, Items.metaglass, 700, 2],
                [Blocks.cultivator, Blocks.waterExtractor, Items.sporePod, 500, 2],
                [Blocks.cryofluidMixer, Blocks.waterExtractor, null, 0, 1],
                [Blocks.plastaniumCompressor, Blocks.sporePress, Items.plastanium, 900, 2],
                [Blocks.pyratiteMixer, null, Items.pyratite, 350, 1],
                [Blocks.blastMixer, null, Items.blastCompound, 350, 1],
                [Blocks.phaseWeaver, null, Items.phaseFabric, 800, 2],
                [Blocks.surgeSmelter, null, Items.surgeAlloy, 800, 2]
            ];
            for (var ic = 0; ic < tryChain.length; ic++) {
                var cBlk = tryChain[ic][0], supBlk = tryChain[ic][1], outIt = tryChain[ic][2], capAmt = tryChain[ic][3], maxCnt = tryChain[ic][4];
                if (!usable(cBlk) || countBlock(data, cBlk) >= maxCnt) continue;
                if (supBlk && !usable(supBlk)) continue;
                if (outIt && core.items.get(outIt) >= capAmt) continue;
                if (cBlk.consumesPower && netPower < -15) continue;
                var iLbl = tryPlanHubBlock(origin, size, cells, ore, team, budget, cBlk, hasUnloader, supBlk, indPlans);
                if (iLbl) { obs.industryPossible = true; indLbl = iLbl; break; }
            }
            if (!obs.industryPossible) {
                proSafe("реактор", function () {
                    proReactorPlans(core, team, budget, usableMap, stockMap, data, netPower, cells, origin, size, indPlans);
                    if (indPlans.length) { obs.industryPossible = true; indLbl = "Thorium Reactor + криомиксер"; }
                }, null);
            }

            // 8a. v2.0 unit chains up to T4/T5 (heavy sectors)
            if (netPower >= 15 && core.items.get(Items.silicon) >= 45 && (obs.attackMode || obs.priority === "BUILD_T3_AIR_FLANK" || obs.priority === "BUILD_ARMY")) {
                proSafe("цепочка юнитов", function () {
                    var diffNow = sector && sector.preset ? sector.preset.difficulty : 4;
                    var unlockedMap = {};
                    var uNames = Object.keys(UNIT_LINES);
                    for (var ul = 0; ul < uNames.length; ul++) {
                        var arr = UNIT_LINES[uNames[ul]];
                        for (var ua = 0; ua < arr.length; ua++) {
                            var ut = UnitTypes[arr[ua]];
                            unlockedMap[arr[ua]] = !!(ut && ut.unlockedNow && ut.unlockedNow());
                        }
                    }
                    var bnames = ["ground-factory", "air-factory", "naval-factory", "additive-reconstructor", "multiplicative-reconstructor", "exponential-reconstructor", "tetrative-reconstructor"];
                    for (var bn = 0; bn < bnames.length; bn++) unlockedMap[bnames[bn]] = !!usableMap[bnames[bn]];
                    var fc = bot.pro.sched;
                    var preferAir = obs.priority === "BUILD_T3_AIR_FLANK" || !!(fc && fc.airShareNext >= 0.5);
                    var line = chooseUnitLine(diffNow, unlockedMap, preferAir, bot.pro.scan && bot.pro.scan.counts && !!bot.pro.scan.counts["water"]);
                    if (!line || line.tiers < 3) return;
                    var facB = proBlock(line.factory);
                    if (!facB || countBlock(data, facB) >= 2) return;
                    for (var tiers = line.tiers; tiers >= 3; tiers--) {
                        var chain = findUnitChainSlotTiers(size, size, cells, WINDOW_RADIUS, WINDOW_RADIUS, hasUnloader, tiers);
                        if (!chain) continue;
                        var work = budget.slice(), list = [], good = true;
                        for (var st = 0; st < chain.stages.length && good; st++) {
                            var stg = chain.stages[st];
                            var sb = st === 0 ? facB : (stg.kind === "payload" ? proBlock("payload-conveyor") : proBlock(stg.kind));
                            var sx = origin[0] + stg.cx, sy = origin[1] + stg.cy;
                            if (!sb || !usable(sb) || !Build.validPlace(sb, team, sx, sy, chain.rotation) || !reserve(work, sb, 1)) { good = false; break; }
                            var cfg = null;
                            if (st === 0 && sb.plans) {
                                var want = UnitTypes[line.chain[0]];
                                for (var pi = 0; pi < sb.plans.size; pi++) if (sb.plans.get(pi).unit === want) cfg = java.lang.Integer.valueOf(pi);
                            }
                            list.push(new BuildPlan(sx, sy, chain.rotation, sb, cfg));
                        }
                        if (!good) continue;
                        if (chain.hasUnloader && usable(Blocks.unloader) && reserve(work, Blocks.unloader, 1)) {
                            list.push(new BuildPlan(origin[0] + chain.unloaderX, origin[1] + chain.unloaderY, 0, Blocks.unloader));
                        }
                        for (var bi = 0; bi < work.length; bi++) budget[bi] = work[bi];
                        for (var li = 0; li < list.length; li++) armPlans.push(list[li]);
                        obs.armyPossible = true;
                        armLbl = line.chain[line.chain.length - 1] + " (T" + tiers + ")";
                        break;
                    }
                }, null);
            }

            // 8. Army + Reconstructors
            if (!obs.armyPossible && netPower >= 15 && core.items.get(Items.silicon) >= 45) {
                var fac = null, t2 = null, t3 = null;
                if (usable(Blocks.airFactory) && countBlock(data, Blocks.airFactory) < (obs.attackMode ? 2 : 1)
                    && (UnitTypes.mono.unlockedNow() || UnitTypes.flare.unlockedNow())) {
                    fac = Blocks.airFactory;
                    t2 = obs.attackMode && UnitTypes.horizon.unlockedNow() ? UnitTypes.horizon : (UnitTypes.poly.unlockedNow() ? UnitTypes.poly : null);
                    t3 = obs.attackMode && UnitTypes.zenith.unlockedNow() ? UnitTypes.zenith : (UnitTypes.mega.unlockedNow() ? UnitTypes.mega : null);
                } else if (obs.attackMode && usable(Blocks.groundFactory) && countBlock(data, Blocks.groundFactory) < 2 && UnitTypes.dagger.unlockedNow()) {
                    fac = Blocks.groundFactory;
                    t2 = UnitTypes.mace.unlockedNow() ? UnitTypes.mace : null;
                    t3 = UnitTypes.fortress.unlockedNow() ? UnitTypes.fortress : null;
                }
                if (fac) {
                    var wAdd = !!(obs.attackMode && usable(Blocks.additiveReconstructor) && t2 && core.items.get(Items.graphite) >= 60);
                    var wMult = !!(wAdd && usable(Blocks.multiplicativeReconstructor) && t3 && core.items.get(Items.titanium) >= 140 && netPower >= 180);
                    var uSlot = findUnitChainSlot(size, size, cells, WINDOW_RADIUS, WINDOW_RADIUS, hasUnloader, wAdd, wMult)
                        || (wMult ? findUnitChainSlot(size, size, cells, WINDOW_RADIUS, WINDOW_RADIUS, hasUnloader, wAdd, false) : null)
                        || (wAdd ? findUnitChainSlot(size, size, cells, WINDOW_RADIUS, WINDOW_RADIUS, hasUnloader, false, false) : null);
                    if (uSlot) {
                        var fx = origin[0] + uSlot.factoryX, fy = origin[1] + uSlot.factoryY;
                        var aWork = budget.slice();
                        if (Build.validPlace(fac, team, fx, fy, uSlot.rotation) && reserve(aWork, fac, 1)) {
                            var plIdx = chooseFactoryPlan(fac, !obs.attackMode);
                            armPlans.push(new BuildPlan(fx, fy, uSlot.rotation, fac, plIdx >= 0 ? java.lang.Integer.valueOf(plIdx) : null));
                            if (uSlot.hasUnloader && usable(Blocks.unloader) && reserve(aWork, Blocks.unloader, 1)) {
                                armPlans.push(new BuildPlan(origin[0] + uSlot.unloaderX, origin[1] + uSlot.unloaderY, 0, Blocks.unloader));
                            }
                            if (uSlot.hasAdditive && reserve(aWork, Blocks.additiveReconstructor, 1)) {
                                armPlans.push(new BuildPlan(origin[0] + uSlot.additiveX, origin[1] + uSlot.additiveY, uSlot.rotation, Blocks.additiveReconstructor));
                            }
                            if (uSlot.hasMultiplicative && reserve(aWork, Blocks.multiplicativeReconstructor, 1)) {
                                armPlans.push(new BuildPlan(origin[0] + uSlot.multiplicativeX, origin[1] + uSlot.multiplicativeY, uSlot.rotation, Blocks.multiplicativeReconstructor));
                            }
                            for (var ai = 0; ai < aWork.length; ai++) budget[ai] = aWork[ai];
                            obs.armyPossible = true;
                            armLbl = String(fac.localizedName);
                        }
                    }
                }
            }

            // 9. Universal Core Courier
            seqEach(data.buildings, function (b) {
                if (courierTarget || !b.items || b.dst(core) > 45 * Vars.tilesize) return;
                if (b.block === Blocks.coreShard || b.block === Blocks.coreFoundation || b.block === Blocks.coreNucleus) return;
                if (b.block.ammoTypes) return;
                var hasUnl = false;
                if (b.proximity) seqEach(b.proximity, function (nb) { if (nb.block === Blocks.unloader) hasUnl = true; });
                if (hasUnl) return;
                seqEach(Vars.content.items(), function (it) {
                    if (courierTarget) return;
                    var kp = String(it.name) === "copper" ? COPPER_RESERVE : String(it.name) === "lead" ? LEAD_RESERVE : 5;
                    if (core.items.get(it) <= kp + 8) return;
                    var maxAcc = Math.max(1, b.getMaximumAccepted(it));
                    if (b.acceptItem(core, it) && b.items.get(it) <= Math.floor(maxAcc / 2)) {
                        courierTarget = b;
                        courierItem = it;
                    }
                });
            });
            obs.courierPossible = !!courierTarget;

            // 10. Manual mining
            if (unit.canMine() && unit.type.mineFloor) {
                var mNames = [], mStocks = [], mAvail = [], mWeights = [];
                seqEach(Vars.content.items(), function (it) {
                    mNames[it.id] = String(it.name);
                    mStocks[it.id] = core.items.get(it);
                    mWeights[it.id] = itemWeight(String(it.name), false, true, true, true, false);
                    mAvail[it.id] = false;
                });
                for (var mo = 0; mo < ore.length; mo++) {
                    if (ore[mo] >= 0 && unit.canMine(Vars.content.item(ore[mo]))) mAvail[ore[mo]] = true;
                }
                var mRanked = rankItems(mNames, mStocks, mAvail, mWeights);
                var maxM = Math.min(WINDOW_RADIUS, Math.floor(Vars.mineTransferRange / Vars.tilesize) - 3);
                for (var mr = 0; mr < mRanked.length; mr++) {
                    var mc = nearestOreCell(size, size, cells, ore, mRanked[mr], WINDOW_RADIUS, WINDOW_RADIUS, maxM);
                    if (mc >= 0) {
                        mineTile = Vars.world.tile(origin[0] + (mc % size), origin[1] + Math.floor(mc / size));
                        break;
                    }
                }
            }
            obs.minePossible = !!mineTile;
        }

        // Wave stats
        obs.waves = !!Vars.state.rules.waves;
        obs.waveSending = !!Vars.state.rules.waveSending;
        obs.waveTimer = !!Vars.state.rules.waveTimer;
        obs.spawning = !!Vars.spawner.isSpawning();
        obs.enemies = Vars.state.enemies || 0;
        obs.wave = Vars.state.wave || 0;
        obs.winWave = Vars.state.rules.winWave || 0;
        obs.waveTimeSec = obs.waveTimer ? (Vars.state.wavetime || 0) / 60 : -1;
        obs.secondsSinceWaveCall = nowSec - bot.lastWaveCallSec;
        obs.coreHealthFrac = core.maxHealth > 0 ? core.health / core.maxHealth : 1;

        var defDps = 0, defHp = 0;
        seqEach(data.buildings, function (b) {
            if (b.estimateDps && b.hasAmmo && b.hasAmmo()) { defDps += b.estimateDps(); defHp += b.health; }
            else if (typeof BlockGroup !== "undefined" && b.block.group === BlockGroup.walls) defHp += b.health;
        });
        obs.defenseDps = defDps;
        obs.defensePoolHp = defHp;
        bot.pro.lastDps = defDps;
        if ((bot.pro.prevEnemies || 0) > 0 && obs.enemies === 0) proSafe("разбор волны", function () { proAfterWave(core); }, null);
        bot.pro.prevEnemies = obs.enemies;

        var wHp = 0, wDps = 0, wIdx = Math.max(0, obs.wave - 1);
        seqEach(Vars.state.rules.spawns, function (grp) {
            if (!grp || !grp.type) return;
            var cnt = grp.getSpawned(wIdx);
            if (cnt > 0) {
                wHp += cnt * (grp.type.health + grp.getShield(wIdx));
                wDps += cnt * (grp.type.estimateDps ? grp.type.estimateDps() : 10);
            }
        });
        obs.nextWaveHp = wHp;
        obs.nextWaveDps = wDps;

        var dec = decideSector(obs);
        if (dec.action !== ACT_MINE) clearMining();
        if (dec.action !== ACT_MINE && dec.action !== ACT_REARM && dec.action !== ACT_COURIER) bot.hasTarget = false;

        if (dec.action === ACT_READY_NEXT_SECTOR) {
            if (!bot.transitionPending) {
                runResearchPass();
                if (checkVictory()) return;
                bot.transitionPending = true;
                if (launchNextSector(sector)) {
                    bot.lastAction = "переход в сектор: " + bot.nextTargetSummary;
                    botLog(bot.lastAction);
                } else {
                    bot.transitionPending = false;
                }
            }
        } else if (dec.action === ACT_UPGRADE_CORE) {
            queuePlans(unit, corePlans); bot.lastAction = "улучшаю " + coreLbl; botLog(bot.lastAction);
        } else if (dec.action === ACT_REARM) {
            if (bot.transferStage === 0 && rearmTarget) {
                bot.transferTarget = rearmTarget; bot.transferItem = rearmItem;
                bot.transferLabel = "патроны -> " + rearmTarget.block.localizedName; bot.transferStage = 1;
            }
            runItemTransfer(unit, core);
        } else if (dec.action === ACT_COURIER) {
            if (bot.transferStage === 0 && courierTarget) {
                bot.transferTarget = courierTarget; bot.transferItem = courierItem;
                bot.transferLabel = courierItem.localizedName + " -> " + courierTarget.block.localizedName; bot.transferStage = 1;
            }
            runItemTransfer(unit, core);
        } else if (dec.action === ACT_POWER) {
            queuePlans(unit, powerPlans); bot.lastAction = "энергетика: " + powLbl; botLog(bot.lastAction);
        } else if (dec.action === ACT_DEFEND) {
            queuePlans(unit, defPlans); bot.lastAction = "укрепляю оборону (" + defPlans.length + ")"; botLog(bot.lastAction);
        } else if (dec.action === ACT_REBUILD) {
            queuePlans(unit, rebPlans); bot.lastAction = "восстанавливаю (" + rebPlans.length + ")"; botLog(bot.lastAction);
        } else if (dec.action === ACT_DRILL) {
            queuePlans(unit, drlPlans); bot.lastAction = "ставлю бур: " + drlLbl; botLog(bot.lastAction);
        } else if (dec.action === ACT_INDUSTRY) {
            queuePlans(unit, indPlans); bot.lastAction = "завод: " + indLbl; botLog(bot.lastAction);
        } else if (dec.action === ACT_ARMY) {
            queuePlans(unit, armPlans); bot.lastAction = "армия: " + armLbl; botLog(bot.lastAction);
        } else if (dec.action === ACT_CALL_WAVE) {
            Vars.logic.skipWave(); bot.lastWaveCallSec = nowSec;
            bot.lastAction = "вызываю волну " + Vars.state.wave; botLog(bot.lastAction);
        } else if (dec.action === ACT_MINE && mineTile) {
            if (unit.mineTile !== mineTile) {
                bot.hasTarget = true; bot.targetX = mineTile.worldx(); bot.targetY = mineTile.worldy();
                bot.arriveDistance = unit.type.mineRange * 0.6;
                if (unit.validMine(mineTile)) { unit.mineTile = mineTile; bot.hasTarget = false; }
            }
            bot.lastAction = "добываю руду · " + dec.reason;
        } else {
            bot.lastAction = dec.reason;
        }
    }

    function runItemTransfer(unit, core) {
        var range = Vars.itemTransferRange * 0.78;
        if (!bot.transferTarget || !memberValid(bot.transferTarget) || !bot.transferItem) {
            bot.transferStage = 0; return;
        }
        if (unit.stack.amount > 0 && unit.item() !== bot.transferItem) {
            if (Vars.player.within(core, range)) Call.transferInventory(Vars.player, core);
            else { bot.hasTarget = true; bot.targetX = core.x; bot.targetY = core.y; bot.arriveDistance = range * 0.75; }
            return;
        }
        if (bot.transferStage === 1) {
            if (unit.stack.amount > 0) bot.transferStage = 2;
            else if (Vars.player.within(core, range)) {
                var amt = Math.min(unit.maxAccepted(bot.transferItem), core.items.get(bot.transferItem));
                if (amt <= 0) { bot.transferStage = 0; return; }
                Call.requestItem(Vars.player, core, bot.transferItem, amt);
                bot.transferStage = 2;
                return;
            } else {
                bot.hasTarget = true; bot.targetX = core.x; bot.targetY = core.y; bot.arriveDistance = range * 0.75;
                return;
            }
        }
        if (bot.transferStage === 2) {
            if (unit.stack.amount <= 0) { bot.transferStage = 0; return; }
            if (Vars.player.within(bot.transferTarget, range)) {
                Call.transferInventory(Vars.player, bot.transferTarget);
                bot.watchdog.success();
                bot.lastAction = "снабжение: " + bot.transferLabel;
                bot.transferStage = unit.stack.amount > 0 ? 3 : 0;
            } else {
                bot.hasTarget = true; bot.targetX = bot.transferTarget.x; bot.targetY = bot.transferTarget.y; bot.arriveDistance = range * 0.75;
            }
            return;
        }
        if (bot.transferStage === 3) {
            if (unit.stack.amount <= 0) bot.transferStage = 0;
            else if (Vars.player.within(core, range)) { Call.transferInventory(Vars.player, core); bot.transferStage = 0; }
            else { bot.hasTarget = true; bot.targetX = core.x; bot.targetY = core.y; bot.arriveDistance = range * 0.75; }
        }
    }

    // --------------------------------------------------- controls & UI hooks

    bot.start = function () {
        var why = guardReason(buildGuard());
        if (why) { bot.reason = "запуск невозможен: " + why; botLog(bot.reason); refreshUi(); return; }
        bot.state = transition(bot.state, CMD_START);
        saveEnabled(true);
        bot.reason = "";
        bot.watchdog.reset();
        bot.transitionPending = false;
        bot.nextDecisionTime = 0;
        botLog("автопрохождение кампании Serpulo включено ▶");
        if (!Vars.state || !Vars.state.isGame()) updateOutOfGame();
        refreshUi();
    };

    bot.pause = function () {
        if (bot.state !== BOT_RUNNING) return;
        pauseWithReason("пауза — нажмите ▶, чтобы продолжить");
        refreshUi();
    };

    bot.stop = function () {
        if (bot.state === BOT_OFF) return;
        haltUnitActions();
        bot.state = transition(bot.state, CMD_STOP);
        saveEnabled(false);
        bot.transitionPending = false;
        bot.reason = "остановлен игроком";
        botLog(bot.reason);
        refreshUi();
    };

    function composeHudString() {
        var prog = countPresetProgress();
        var sec = Vars.state && Vars.state.isCampaign() ? Vars.state.getSector() : null;
        var secTitle = !sec ? "—" : String(sec.name())
            + (Vars.state.rules.attackMode ? " [scarlet](штурм базы)[]"
            : Vars.state.rules.winWave > 0 ? " (волна " + Vars.state.wave + "/" + Vars.state.rules.winWave + ")"
            : sec.isCaptured() ? " [accent](захвачен)[]" : "");
        var detail = bot.state === BOT_RUNNING ? bot.lastAction : (bot.reason || bot.lastAction);
        var thought = "";
        if (bot.state === BOT_RUNNING && Vars.state && Vars.state.isGame() && Vars.state.isCampaign()) {
            thought = bot.pro.brain.hudLine() + "\n[lightgray]🧠 " + bot.pro.brain.status
                + (bot.pro.recon ? " · " + bot.pro.recon : "") + "[]";
        }
        return formatHudText(bot.state, prog[0], prog[1], secTitle, bot.lastAction, bot.lastResearch, bot.armySummary, detail, thought);
    }

    function llmButtonText() {
        return "🧠 ИИ: Gemma " + (llmSettingBool(PREF_LLM_ENABLED, true) ? "[green]вкл[]" : "[scarlet]выкл[]");
    }

    function refreshUi() {
        if (llmButton) { try { llmButton.setText(llmButtonText()); } catch (ignored) {} }
        if (hudLabel) hudLabel.setText(composeHudString());
        if (planetLabel) {
            var prog = countPresetProgress();
            var det = bot.state === BOT_RUNNING ? bot.lastAction : (bot.reason || "Нажмите ▶, чтобы бот сам прошёл кампанию Serpulo");
            planetLabel.setText("[" + stateColor(bot.state) + "]🤖 Автокампания Serpulo: " + stateName(bot.state)
                + "[] [lightgray](" + prog[0] + "/" + prog[1] + " сюж.)[]\n[lightgray]" + det + "[]");
        }
    }

    // Event hooks
    if (typeof Events !== "undefined") {
        var Trig = typeof Trigger !== "undefined" ? Trigger : (typeof Packages !== "undefined" ? Packages.mindustry.game.EventType.Trigger : null);
        if (Trig) Events.run(Trig.update, asRun(function () {
            loopSafe("тик обновления", updateTick, null);
        }));

        function updateTick() {
            if (Time.time >= nextUiRefresh) {
                nextUiRefresh = Time.time + 30;
                refreshUi();
            }
            if (bot.state !== BOT_RUNNING) return;
            if (!Vars.state || !Vars.state.isGame()) return;
            var why = guardReason(buildGuard());
            if (why) { pauseWithReason(why); return; }
            if (Vars.state.isPaused() || Vars.state.gameOver) return;
            if (Time.time < bot.settleUntilTime) return;

            var u = Vars.player ? Vars.player.unit() : null;
            var alive = !!(unitAlive(u) && !playerDead(Vars.player));
            if (alive) {
                var pl = u.plans.size > 0 ? u.buildPlan() : null;
                var tx = pl ? pl.drawx() : (bot.hasTarget ? bot.targetX : null);
                var ty = pl ? pl.drawy() : (bot.hasTarget ? bot.targetY : null);
                var arr = pl ? u.type.buildRange * 0.55 : bot.arriveDistance;
                if (tx !== null) {
                    var dx = tx - u.x, dy = ty - u.y;
                    var dst = Math.sqrt(dx * dx + dy * dy);
                    if (dst > arr) {
                        var mv = new Vec2(dx, dy).setLength(u.speed());
                        u.movePref(mv);
                        u.lookAt(mv.angle());
                    }
                }
            }
            if (Time.time < bot.nextDecisionTime) return;
            bot.nextDecisionTime = Time.time + DECISION_INTERVAL_TICKS;
            thinkInSector(alive ? u : null);
        }

        if (typeof Timer !== "undefined" && Timer.schedule) {
            Timer.schedule(asRun(function () {
                loopSafe("вне игры", updateOutOfGame, null);
                loopSafe("интерфейс", refreshUi, null);
            }), 2, 2);
        }

        var WLoad = typeof WorldLoadEvent !== "undefined" ? WorldLoadEvent : (typeof Packages !== "undefined" ? Packages.mindustry.game.EventType.WorldLoadEvent : null);
        if (WLoad) Events.on(WLoad, asCons(function () {
            loopSafe("загрузка мира", function () {
                bot.ownPlans = [];
                bot.rejectedSites = {};
                bot.watchdog.reset();
                bot.hasTarget = false;
                bot.transferStage = 0;
                bot.squadMode = SQUAD_RALLY;
                bot.nextDecisionTime = 0;
                bot.nextResearchTime = 0;
                bot.capturedSinceSec = -1;
                bot.settleUntilTime = Time.time + 90;
                bot.transitionPending = false;
                bot.pro.sectorKey = null;
                bot.pro.prevHp = {};
            }, null);
        }));

        if (typeof SectorCaptureEvent !== "undefined") {
            Events.on(SectorCaptureEvent, asCons(function (e) {
                loopSafe("захват сектора", function () {
                    if (bot.state === BOT_RUNNING) {
                        bot.capturedSinceSec = Time.time / 60;
                        botLog("сектор захвачен ✅");
                        runResearchPass();
                        checkVictory();
                    }
                }, null);
            }));
        }

        if (typeof GameOverEvent !== "undefined") {
            Events.on(GameOverEvent, asCons(function () {
                loopSafe("проигрыш сектора", function () {
                    if (bot.state !== BOT_RUNNING) return;
                    var lost = Vars.state ? Vars.state.getSector() : null;
                    if (lost) bot.sectorLosses[lost.id] = (bot.sectorLosses[lost.id] || 0) + 1;
                    var ls = lost ? bot.sectorLosses[lost.id] : 1;
                    loopSafe("сброс действий юнита", haltUnitActions, null);
                    if (ls >= MAX_SECTOR_LOSSES) {
                        failBot("сектор потерян " + ls + " раза подряд");
                    } else {
                        bot.transitionPending = true;
                        if (typeof Timer !== "undefined" && Timer.schedule) {
                            Timer.schedule(asRun(function () {
                                loopSafe("переход после проигрыша", function () {
                                    if (bot.state === BOT_RUNNING) {
                                        bot.transitionPending = false;
                                        launchNextSector(null);
                                    }
                                }, null);
                            }), 3.5);
                        }
                    }
                }, null);
            }));
        }

        var CLoad = typeof ClientLoadEvent !== "undefined" ? ClientLoadEvent : (typeof Packages !== "undefined" ? Packages.mindustry.game.EventType.ClientLoadEvent : null);
        if (CLoad) Events.on(CLoad, asCons(function () {
            if (Vars.ui && Vars.ui.hudGroup) {
                Vars.ui.hudGroup.fill(asCons(function (root) {
                    root.top().left();
                    root.touchable = Touchable.childrenOnly;
                    var contentW = Scl.scl(340);
                    root.table(Styles.black8, asCons(function (panel) {
                        panel.margin(6);
                        panel.touchable = Touchable.childrenOnly;
                        panel.defaults().left().top();
                        panel.table(asCons(function (hdr) {
                            hdr.defaults().height(28).pad(1);
                            hdr.button("▶ Кампания", Styles.flatt, asRun(bot.start)).growX();
                            hdr.button("⏸ Пауза", Styles.flatt, asRun(bot.pause)).growX();
                            hdr.button("■ Стоп", Styles.flatt, asRun(bot.stop)).growX();
                            hdr.button("▾", Styles.flatt, asRun(function () {
                                bot.collapsed = !bot.collapsed;
                                if (bodyTable) bodyTable.visible = !bot.collapsed;
                            })).width(32);
                        })).width(contentW).left();
                        panel.row();
                        llmButton = panel.button(llmButtonText(), Styles.flatt, asRun(toggleLlm)).growX().height(26).left().get();
                        panel.row();
                        bodyTable = panel.table(asCons(function (body) {
                            hudLabel = body.add(composeHudString()).color(Color.white).left().width(contentW).get();
                            try { hudLabel.setWrap(true); } catch (ignored) {}
                        })).width(contentW).left().get();
                    })).marginTop(Scl.scl(152)).marginLeft(Scl.scl(8));
                }));
            }

            if (Vars.ui && Vars.ui.planet && typeof Vars.ui.planet.shown === "function") {
                Vars.ui.planet.shown(asRun(function () {
                    var bar = new Table(Styles.black8);
                    bar.margin(8);
                    bar.touchable = Touchable.childrenOnly;
                    planetLabel = bar.add("").color(Color.white).left().width(360).get();
                    try { planetLabel.setWrap(true); } catch (ignored) {}
                    bar.row();
                    bar.table(asCons(function (btns) {
                        btns.defaults().height(34).width(116).pad(2);
                        btns.button("▶ Кампания", Styles.flatt, asRun(bot.start));
                        btns.button("⏸ Пауза", Styles.flatt, asRun(bot.pause));
                        btns.button("■ Стоп", Styles.flatt, asRun(bot.stop));
                    })).left();
                    var cont = new Table();
                    cont.setFillParent(true);
                    cont.top();
                    cont.touchable = Touchable.childrenOnly;
                    cont.add(bar).padTop(42);
                    Vars.ui.planet.addChild(cont);
                    refreshUi();
                }));
            }
        }));
    }

    bot.runResearchPass = runResearchPass;
    bot.launchNextSector = launchNextSector;
    bot.thinkInSector = thinkInSector;
    bot.updateOutOfGame = updateOutOfGame;
    return bot;
}

if (typeof Vars !== "undefined" && Vars && !Vars.headless) {
    installMindustryCampaignBot();
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        BOT_OFF: BOT_OFF,
        BOT_RUNNING: BOT_RUNNING,
        BOT_PAUSED: BOT_PAUSED,
        BOT_NEEDS_HELP: BOT_NEEDS_HELP,
        BOT_VICTORY: BOT_VICTORY,
        CMD_START: CMD_START,
        CMD_PAUSE: CMD_PAUSE,
        CMD_STOP: CMD_STOP,
        CMD_FAIL: CMD_FAIL,
        CMD_VICTORY: CMD_VICTORY,
        ACT_WAIT: ACT_WAIT,
        ACT_UPGRADE_CORE: ACT_UPGRADE_CORE,
        ACT_REARM: ACT_REARM,
        ACT_POWER: ACT_POWER,
        ACT_DEFEND: ACT_DEFEND,
        ACT_REBUILD: ACT_REBUILD,
        ACT_DRILL: ACT_DRILL,
        ACT_INDUSTRY: ACT_INDUSTRY,
        ACT_ARMY: ACT_ARMY,
        ACT_COURIER: ACT_COURIER,
        ACT_CALL_WAVE: ACT_CALL_WAVE,
        ACT_MINE: ACT_MINE,
        ACT_READY_NEXT_SECTOR: ACT_READY_NEXT_SECTOR,
        SQUAD_RALLY: SQUAD_RALLY,
        SQUAD_ASSAULT: SQUAD_ASSAULT,
        SQUAD_DEFEND: SQUAD_DEFEND,
        CELL_FREE: CELL_FREE,
        CELL_BLOCKED: CELL_BLOCKED,
        CELL_CORE: CELL_CORE,
        stateName: stateName,
        stateColor: stateColor,
        transition: transition,
        guardReason: guardReason,
        essentialTechTier: essentialTechTier,
        computeCriticalTechMask: computeCriticalTechMask,
        rankResearchNodes: rankResearchNodes,
        chooseNextSector: chooseNextSector,
        shouldHoldCapturedSector: shouldHoldCapturedSector,
        canSurviveWave: canSurviveWave,
        waveCallProblem: waveCallProblem,
        decideSector: decideSector,
        decideSquadMode: decideSquadMode,
        itemWeight: itemWeight,
        rankItems: rankItems,
        sizeOffset: sizeOffset,
        coreDistances: coreDistances,
        findDrillSite: findDrillSite,
        nearestOreCell: nearestOreCell,
        findHubCrafterSlot: findHubCrafterSlot,
        findUnitChainSlot: findUnitChainSlot,
        buildFortressTemplate: buildFortressTemplate,
        createWatchdog: createWatchdog,
        formatHudText: formatHudText,
        CELL_LANE: CELL_LANE,
        ROLE_WALL: ROLE_WALL,
        ROLE_GROUND_TURRET: ROLE_GROUND_TURRET,
        ROLE_AIR_TURRET: ROLE_AIR_TURRET,
        ROLE_SUPPORT: ROLE_SUPPORT,
        ROLE_POWER_NODE: ROLE_POWER_NODE,
        DX: DX,
        DY: DY,
        ROLE_WALL_WINDOW: ROLE_WALL_WINDOW,
        ROLE_WALL_INNER: ROLE_WALL_INNER,
        ROLE_FRONT_TURRET: ROLE_FRONT_TURRET,
        ROLE_FORCE: ROLE_FORCE,
        ROLE_OVERDRIVE: ROLE_OVERDRIVE,
        ROLE_LIQUID_TURRET: ROLE_LIQUID_TURRET,
        ROLE_POINT_DEFENSE: ROLE_POINT_DEFENSE,
        ZONE_NONE: ZONE_NONE,
        ZONE_NUCLEUS: ZONE_NUCLEUS,
        ZONE_LANE: ZONE_LANE,
        KIND_CONVEYOR: KIND_CONVEYOR,
        KIND_LOGISTICS: KIND_LOGISTICS,
        KIND_OTHER: KIND_OTHER,
        BUS_CONVEYOR: BUS_CONVEYOR,
        BUS_ROUTER: BUS_ROUTER,
        BUS_JUNCTION: BUS_JUNCTION,
        BUS_UNLOADER: BUS_UNLOADER,
        distanceToWall: distanceToWall,
        createPathSearch: createPathSearch,
        findGroundPath: findGroundPath,
        findChokepoints: findChokepoints,
        chokePos: chokePos,
        compassFlank: compassFlank,
        flankVector: flankVector,
        buildKillBox: buildKillBox,
        groundPathCostThroughWall: groundPathCostThroughWall,
        killBoxCrossingP: killBoxCrossingP,
        planAaCorridor: planAaCorridor,
        TURRET_AMMO: TURRET_AMMO,
        turretAcceptsAmmo: turretAcceptsAmmo,
        chooseAmmoItem: chooseAmmoItem,
        chooseBusAmmo: chooseBusAmmo,
        pickTurretForAmmo: pickTurretForAmmo,
        statusSynergy: statusSynergy,
        planAmmoBus: planAmmoBus,
        planAmmoDrillFeed: planAmmoDrillFeed,
        rectTouchesCell: rectTouchesCell,
        reactorGuard: reactorGuard,
        reactorShouldCutFuel: reactorShouldCutFuel,
        findReactorSite: findReactorSite,
        waveGroupCount: waveGroupCount,
        analyzeWaveSchedule: analyzeWaveSchedule,
        computeCoreZones: computeCoreZones,
        zoneAllows: zoneAllows,
        createDamageHeat: createDamageHeat,
        pickBreachReinforcement: pickBreachReinforcement,
        buildDangerGrid: buildDangerGrid,
        straightPathDanger: straightPathDanger,
        planFlankRoute: planFlankRoute,
        pickAssaultTarget: pickAssaultTarget,
        splitSquadByHealth: splitSquadByHealth,
        UNIT_LINES: UNIT_LINES,
        chooseUnitLine: chooseUnitLine,
        findUnitChainSlotTiers: findUnitChainSlotTiers,
        extractJsonObject: extractJsonObject,
        sanitizeThought: sanitizeThought,
        normalizeFlank: normalizeFlank,
        normalizeAmmo: normalizeAmmo,
        parseLlmResponse: parseLlmResponse,
        buildLlmPrompt: buildLlmPrompt,
        buildLlmRequestBody: buildLlmRequestBody,
        planFeasible: planFeasible,
        heuristicPlan: heuristicPlan,
        llmBackoffInterval: llmBackoffInterval,
        createLlmBrain: createLlmBrain,
        aggressionSafetyScale: aggressionSafetyScale,
        createTerrainScan: createTerrainScan,
        summarizeRecon: summarizeRecon,
        LLM_PLANS: LLM_PLANS,
        LLM_DEFAULT_URL: LLM_DEFAULT_URL,
        LLM_DEFAULT_MODEL: LLM_DEFAULT_MODEL,
        WALL_TIERS: WALL_TIERS,
        KIT_MAIN: KIT_MAIN,
        KIT_FRONT: KIT_FRONT,
        pickFortressWalls: pickFortressWalls,
        chooseFortressKit: chooseFortressKit,
        findBusUnloaderCell: findBusUnloaderCell,
        applyCoreZones: applyCoreZones,
        kebabToCamel: kebabToCamel,
        readMember: readMember,
        unitDead: unitDead,
        unitAlive: unitAlive,
        unitFlying: unitFlying,
        unitCommandable: unitCommandable,
        playerDead: playerDead,
        memberValid: memberValid,
        installMindustryCampaignBot: installMindustryCampaignBot
    };
}
