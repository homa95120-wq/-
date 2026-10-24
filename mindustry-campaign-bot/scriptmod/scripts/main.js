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
    var strongEnough = canSurviveWave(
        o.defenseDps || 0,
        o.defensePoolHp || 0,
        o.nextWaveHp || 0,
        o.nextWaveDps || 0,
        o.waveTimer ? 2.2 : 1.15
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
            if (cells[idx] !== CELL_FREE) continue;
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
            if (cells[n] !== CELL_FREE || dist[n] !== -1) continue;
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
                    else if (cells[n] === CELL_FREE && dist[n] >= 0 && dist[n] < startDist) {
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
            if (cells[y * w + x] !== CELL_FREE) continue;
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
            if (cells[uy * w + ux] !== CELL_FREE) continue;
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

function formatHudText(state, capturedPresets, totalPresets, sectorTitle, phaseText, researchText, armyText, detailText) {
    var lines = [];
    lines.push("[" + stateColor(state) + "]🤖 Автокампания Serpulo: " + stateName(state)
        + "[] [lightgray](" + capturedPresets + "/" + totalPresets + " сюж.)[]");
    if (sectorTitle) lines.push("📍 Сектор: [white]" + sectorTitle + "[]");
    if (phaseText) lines.push("⚙ Задача: [accent]" + phaseText + "[]");
    if (researchText) lines.push("🔬 Наука: [lightgray]" + researchText + "[]");
    if (armyText) lines.push("⚔ Армия: [lightgray]" + armyText + "[]");
    if (detailText) lines.push("💬 [lightgray]" + detailText + "[]");
    return lines.join("\n");
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
        collapsed: false
    };

    var hudLabel = null;
    var planetLabel = null;
    var bodyTable = null;
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
        g.canBuild = !u || !u.isValid() || !!u.canBuild();
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
        if (u && u.isValid() && u.mineTile) u.mineTile = null;
    }

    function haltUnitActions() {
        bot.hasTarget = false;
        bot.transferStage = 0;
        bot.transferTarget = null;
        clearMining();
        var u = Vars.player ? Vars.player.unit() : null;
        if (u && u.isValid()) {
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

    function updateArmySquads(data, core, team, sector) {
        var combat = [];
        var pUnit = Vars.player ? Vars.player.unit() : null;
        seqEach(Groups.unit, function (u) {
            if (!u || u.team !== team || u === pUnit || u.dead() || !u.isCommandable()) return;
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

        var nearEnemy = Units.closestEnemy(team, core.x, core.y, 42 * Vars.tilesize, boolf(function (e) { return !e.dead(); }));
        var diff = sector && sector.preset ? sector.preset.difficulty : 4;
        var cap = Units.getCap(team);
        bot.squadMode = decideSquadMode(!!Vars.state.rules.attackMode, bot.squadMode, combat.length, cap, nearEnemy ? 1 : 0, diff);

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

    function thinkInSector(unit) {
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

        maintainFactoriesAndPower(data, team);
        updateArmySquads(data, core, team, sector);

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
        obs.rearmInProgress = bot.transferStage !== 0 && bot.transferTarget && bot.transferTarget.isValid();
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

        if (obs.buildQueue === 0 && !obs.rearmInProgress) {
            var size = WINDOW_RADIUS * 2 + 1;
            var cells = [], ore = [];
            var origin = buildWindow(core, team, cells, ore);
            var hasUnloader = usable(Blocks.unloader);

            // 1. Rearm check
            var bestRearmDst = 1e12;
            seqEach(data.buildings, function (b) {
                if (!b.block || !b.block.ammoTypes || typeof b.totalAmmo !== "number") return;
                if (b.totalAmmo >= b.block.maxAmmo * REARM_FRACTION) return;
                var bestIt = null, bestAmt = 0;
                seqEach(b.block.ammoTypes.keys().toSeq(), function (it) {
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

            // 5. Fortress defense
            if (!captured) {
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
                [Blocks.siliconSmelter, null, Items.silicon, 1800, 3],
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

            // 8. Army + Reconstructors
            if (netPower >= 15 && core.items.get(Items.silicon) >= 45) {
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
        if (!bot.transferTarget || !bot.transferTarget.isValid() || !bot.transferItem) {
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
        return formatHudText(bot.state, prog[0], prog[1], secTitle, bot.lastAction, bot.lastResearch, bot.armySummary, detail);
    }

    function refreshUi() {
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
            var alive = !!(u && u.isValid() && !Vars.player.dead());
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
        }));

        if (typeof Timer !== "undefined" && Timer.schedule) {
            Timer.schedule(asRun(function () {
                updateOutOfGame();
                refreshUi();
            }), 2, 2);
        }

        var WLoad = typeof WorldLoadEvent !== "undefined" ? WorldLoadEvent : (typeof Packages !== "undefined" ? Packages.mindustry.game.EventType.WorldLoadEvent : null);
        if (WLoad) Events.on(WLoad, asCons(function () {
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
        }));

        if (typeof SectorCaptureEvent !== "undefined") {
            Events.on(SectorCaptureEvent, asCons(function (e) {
                if (bot.state === BOT_RUNNING) {
                    bot.capturedSinceSec = Time.time / 60;
                    botLog("сектор захвачен ✅");
                    runResearchPass();
                    checkVictory();
                }
            }));
        }

        if (typeof GameOverEvent !== "undefined") {
            Events.on(GameOverEvent, asCons(function () {
                if (bot.state === BOT_RUNNING) {
                    var lost = Vars.state ? Vars.state.getSector() : null;
                    if (lost) bot.sectorLosses[lost.id] = (bot.sectorLosses[lost.id] || 0) + 1;
                    var ls = lost ? bot.sectorLosses[lost.id] : 1;
                    haltUnitActions();
                    if (ls >= MAX_SECTOR_LOSSES) {
                        failBot("сектор потерян " + ls + " раза подряд");
                    } else {
                        bot.transitionPending = true;
                        if (typeof Timer !== "undefined" && Timer.schedule) {
                            Timer.schedule(asRun(function () {
                                if (bot.state === BOT_RUNNING) {
                                    bot.transitionPending = false;
                                    launchNextSector(null);
                                }
                            }), 3.5);
                        }
                    }
                }
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
        installMindustryCampaignBot: installMindustryCampaignBot
    };
}
