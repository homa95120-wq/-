/*
 * Campaign Threat Radar (ZIP) - script version of campaignradar.CampaignThreatRadar.
 *
 * Client-only HUD tactical radar for Mindustry v8 (build 154+).
 * Shows enemy unit counts (ground/flying/bosses), predicted approach ETA to cores,
 * core health, power deficit, turret ammo alerts, and defense diagnostics.
 *
 * Positioned at top-right, to the left of the minimap.
 * Uses `hidden: true` so it never affects multiplayer server compatibility.
 */

// ---------------------------------------------------------------- logic

var REFRESH_INTERVAL = 30; // ticks, ~0.5 s at 60 fps
var MIN_SPEED = 0.05; // world units per tick; slower units are ignored for ETA
var TOWARDS_CORE_DOT = 0.25; // velocity/direction cosine above which a unit counts as heading to a core
var CLOSE_DISTANCE = 320; // 40 tiles (8 units per tile)

function nearestCore(x, y, cores) {
    var best = null;
    var bestDst2 = Infinity;
    if (!cores) return null;
    for (var i = 0; i < cores.length; i++) {
        var core = cores[i];
        if (!core) continue;
        var dx = core.x - x;
        var dy = core.y - y;
        var dst2 = dx * dx + dy * dy;
        if (dst2 < bestDst2) {
            bestDst2 = dst2;
            best = core;
        }
    }
    return best;
}

/*
 * data: {
 *   units: [{x, y, vx, vy, speed, dead, added, enemy, flying, boss, name}],
 *   cores: [{x, y, health, maxHealth}],
 *   power: {netBalance, batteryStored, batteryCapacity},
 *   turrets: [{hasAmmo, totalAmmo}],
 *   buildings: [{health, maxHealth}]
 * }
 */
function computeRadar(data) {
    if (!data) data = {};
    var units = data.units || [];
    var cores = data.cores || [];
    var power = data.power || null;
    var turrets = data.turrets || [];
    var buildings = data.buildings || [];

    var count = 0;
    var groundCount = 0;
    var flyingCount = 0;
    var bossCount = 0;
    var bossNames = [];
    var threats = 0;
    var closeThreats = 0;
    var closestEtaTicks = null;
    var closestDistTiles = null;

    for (var i = 0; i < units.length; i++) {
        var unit = units[i];
        if (!unit || unit.dead || !unit.added || !unit.enemy) continue;
        count++;

        if (unit.flying) {
            flyingCount++;
        } else {
            groundCount++;
        }

        if (unit.boss) {
            bossCount++;
            var name = unit.name || "Boss";
            if (bossNames.indexOf(name) === -1) {
                bossNames.push(name);
            }
        }

        var core = nearestCore(unit.x, unit.y, cores);
        if (!core) continue;

        var dx = core.x - unit.x;
        var dy = core.y - unit.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var distTiles = dist / 8.0;

        if (closestDistTiles === null || distTiles < closestDistTiles) {
            closestDistTiles = distTiles;
        }

        if (dist <= CLOSE_DISTANCE) {
            closeThreats++;
        }

        var speed = typeof unit.speed === "number" ? unit.speed : Math.sqrt((unit.vx || 0) * (unit.vx || 0) + (unit.vy || 0) * (unit.vy || 0));
        if (speed < MIN_SPEED) continue;

        var towards = ((unit.vx || 0) * dx + (unit.vy || 0) * dy) / (speed * dist + 0.001);
        if (towards > TOWARDS_CORE_DOT) {
            threats++;
            var eta = dist / speed; // ticks (60 ticks = 1 sec)
            if (closestEtaTicks === null || eta < closestEtaTicks) {
                closestEtaTicks = eta;
            }
        }
    }

    // Core health status
    var minCoreHpPercent = null;
    for (var c = 0; c < cores.length; c++) {
        var cor = cores[c];
        if (cor && typeof cor.health === "number" && typeof cor.maxHealth === "number" && cor.maxHealth > 0) {
            var pct = (cor.health / cor.maxHealth) * 100.0;
            if (minCoreHpPercent === null || pct < minCoreHpPercent) {
                minCoreHpPercent = pct;
            }
        }
    }

    // Power status
    var powerStatus = null;
    if (power) {
        var net = typeof power.netBalance === "number" ? power.netBalance : 0;
        var stored = typeof power.batteryStored === "number" ? power.batteryStored : 0;
        var cap = typeof power.batteryCapacity === "number" ? power.batteryCapacity : 0;
        var batPct = cap > 0 ? (stored / cap) * 100.0 : 100.0;
        var isDeficit = net < -5.0;
        var isBlackout = (isDeficit && stored <= 1.0) || (net < -30.0 && batPct < 10.0);
        powerStatus = {
            net: net,
            stored: stored,
            capacity: cap,
            percent: batPct,
            isDeficit: isDeficit,
            isBlackout: isBlackout
        };
    }

    // Empty turrets
    var emptyTurrets = 0;
    for (var t = 0; t < turrets.length; t++) {
        var tur = turrets[t];
        if (tur) {
            if (tur.hasAmmo === false || tur.totalAmmo === 0) {
                emptyTurrets++;
            }
        }
    }

    // Damaged buildings (< 50% HP)
    var damagedBuildings = 0;
    for (var b = 0; b < buildings.length; b++) {
        var bld = buildings[b];
        if (bld && typeof bld.health === "number" && typeof bld.maxHealth === "number" && bld.maxHealth > 0) {
            if (bld.health < bld.maxHealth * 0.5) {
                damagedBuildings++;
            }
        }
    }

    return {
        count: count,
        groundCount: groundCount,
        flyingCount: flyingCount,
        bossCount: bossCount,
        bossNames: bossNames,
        threats: threats,
        closeThreats: closeThreats,
        closestEtaTicks: closestEtaTicks,
        closestDistTiles: closestDistTiles,
        minCoreHpPercent: minCoreHpPercent,
        powerStatus: powerStatus,
        emptyTurrets: emptyTurrets,
        damagedBuildings: damagedBuildings
    };
}

function etaSeconds(etaTicks) {
    return Math.max(1, Math.floor(etaTicks / 60));
}

function formatRadarText(inGame, result) {
    if (!inGame || !result) {
        return "[gold]РАДАР КАМПАНИИ[]\n[gray]Неактивен вне игры[]";
    }

    var lines = [];
    lines.push("[gold]РАДАР КАМПАНИИ[] [lightgray]v1.2[]");

    // Line 1: Enemy counts & composition
    var countText = "[white]Враги:[accent] " + result.count + "[]";
    if (result.count > 0) {
        countText += " [lightgray](🚜" + result.groundCount + " 🛸" + result.flyingCount + ")[]";
        if (result.bossCount > 0) {
            countText += " [scarlet]💀" + result.bossCount + "[]";
        }
    }
    lines.push(countText);

    // Line 2: Threat & approach prediction
    if (result.closestEtaTicks !== null && result.closestEtaTicks !== undefined) {
        var sec = etaSeconds(result.closestEtaTicks);
        lines.push("[scarlet]⚠️ ПРОРЫВ: " + result.threats + " к ядру! ETA: ~" + sec + "с[]");
    } else if (result.closeThreats > 0) {
        var dist = result.closestDistTiles !== null ? Math.round(result.closestDistTiles) : 40;
        lines.push("[crimson]🚨 Враг рядом с ядром (~" + dist + " бл.)![]");
    } else if (result.count > 0) {
        lines.push("[orange]Враги на карте (курс мимо ядра)[]");
    } else {
        lines.push("[lightgray]Вражеских юнитов нет[]");
    }

    // Line 3: Boss warning
    if (result.bossCount > 0 && result.bossNames && result.bossNames.length > 0) {
        lines.push("[scarlet]💀 БОСС: " + result.bossNames.join(", ") + "[]");
    }

    // Line 4: Core status
    if (result.minCoreHpPercent !== null && result.minCoreHpPercent !== undefined && result.minCoreHpPercent < 99) {
        var hp = Math.round(result.minCoreHpPercent);
        if (hp <= 35) {
            lines.push("[crimson]🚨 КРИТИЧЕСКИЙ УРОН ЯДРУ: " + hp + "%![]");
        } else {
            lines.push("[coral]⚠️ ЯДРО ПОВРЕЖДЕНО: " + hp + "%[]");
        }
    }

    // Line 5: Power deficit / blackout
    if (result.powerStatus) {
        if (result.powerStatus.isBlackout) {
            lines.push("[scarlet]⚡ СЕТЬ ОБЕСТОЧЕНА: " + Math.round(result.powerStatus.net) + "/с[]");
        } else if (result.powerStatus.isDeficit) {
            lines.push("[coral]⚡ ДЕФИЦИТ ЭНЕРГИИ: " + Math.round(result.powerStatus.net) + "/с (АКБ: " + Math.round(result.powerStatus.percent) + "%)[]");
        }
    }

    // Line 6: Empty turrets
    if (result.emptyTurrets > 0) {
        lines.push("[yellow]📦 Турели без патронов: " + result.emptyTurrets + " шт.[]");
    }

    // Line 7: Damaged defenses
    if (result.damagedBuildings >= 3) {
        lines.push("[yellow]🛠️ Повреждения базы: " + result.damagedBuildings + " построек[]");
    }

    // Line 8: Safe status when no issues
    var hasAlerts = (result.threats > 0) || (result.closeThreats > 0) || (result.bossCount > 0) ||
                    (result.minCoreHpPercent !== null && result.minCoreHpPercent < 99) ||
                    (result.powerStatus && result.powerStatus.isDeficit) ||
                    (result.emptyTurrets > 0) || (result.damagedBuildings >= 3);

    if (!hasAlerts && result.count === 0) {
        lines.push("[green]✅ Все системы стабильны[]");
    }

    return lines.join("\n");
}

// Exported only for the offline test harness; `module` is undefined in Rhino.
if (typeof module !== "undefined" && module && module.exports) {
    module.exports = {
        REFRESH_INTERVAL: REFRESH_INTERVAL,
        MIN_SPEED: MIN_SPEED,
        TOWARDS_CORE_DOT: TOWARDS_CORE_DOT,
        CLOSE_DISTANCE: CLOSE_DISTANCE,
        computeRadar: computeRadar,
        formatRadarText: formatRadarText,
        etaSeconds: etaSeconds
    };
}

// ---------------------------------------------------------------- game glue

// Only register anything when the game globals really exist. In Node
// (tests) and on a headless server this whole block is skipped.
if (typeof Vars !== "undefined" && typeof Events !== "undefined" && typeof ClientLoadEvent !== "undefined" && !Vars.headless) {

    var asCons = typeof cons !== "undefined" ? cons : function (f) { return f; };

    var statusLabel = null;
    var nextRefresh = 0;

    var logError = function (where, err) {
        try {
            Log.err("[campaign-radar] " + where + ": " + err);
        } catch (ignored) {}
    };

    var refreshRadar = function () {
        if (!statusLabel) return;
        try {
            if (!Vars.state || !Vars.state.isGame() || !Vars.player || !Vars.player.isAdded()) {
                statusLabel.setText(formatRadarText(false, null));
                return;
            }

            var enemyTeam = Vars.state.rules.waveTeam || Team.crux;
            var playerTeam = Vars.player.team();
            var teamData = Vars.state.teams ? Vars.state.teams.get(playerTeam) : null;

            var cores = [];
            var mainCore = null;
            if (teamData && teamData.cores) {
                var coreSeq = teamData.cores;
                for (var i = 0; i < coreSeq.size; i++) {
                    var core = coreSeq.get(i);
                    if (core && core.isValid && core.isValid()) {
                        if (!mainCore) mainCore = core;
                        cores.push({
                            x: core.x,
                            y: core.y,
                            health: core.health,
                            maxHealth: core.maxHealth
                        });
                    }
                }
            }

            var units = [];
            if (typeof Groups !== "undefined" && Groups.unit) {
                Groups.unit.each(asCons(function (unit) {
                    if (!unit) return;
                    var isEnemy = unit.team === enemyTeam;
                    var isFlying = unit.isFlying ? unit.isFlying() : (unit.type && unit.type.flying);
                    var isBoss = unit.isBoss ? unit.isBoss() : false;
                    var typeName = unit.type ? (unit.type.localizedName || unit.type.name) : "Enemy";
                    units.push({
                        x: unit.x,
                        y: unit.y,
                        vx: unit.vel ? unit.vel.x : 0,
                        vy: unit.vel ? unit.vel.y : 0,
                        speed: unit.vel ? unit.vel.len() : 0,
                        dead: !!unit.dead,
                        added: unit.isAdded ? unit.isAdded() : true,
                        enemy: isEnemy,
                        flying: !!isFlying,
                        boss: !!isBoss,
                        name: typeName
                    });
                }));
            }

            // Power network diagnostics
            var powerInfo = null;
            if (mainCore && mainCore.power && mainCore.power.graph) {
                var graph = mainCore.power.graph;
                var netBalance = graph.getPowerBalance ? graph.getPowerBalance() * 60.0 : 0;
                var batStored = graph.getBatteryStored ? graph.getBatteryStored() : 0;
                var batCap = graph.getBatteryCapacity ? graph.getBatteryCapacity() : 0;
                powerInfo = {
                    netBalance: netBalance,
                    batteryStored: batStored,
                    batteryCapacity: batCap
                };
            }

            // Turrets & damaged buildings
            var turrets = [];
            var buildings = [];
            if (teamData && teamData.buildings) {
                var bSeq = teamData.buildings;
                for (var b = 0; b < bSeq.size; b++) {
                    var bld = bSeq.get(b);
                    if (!bld || !bld.isValid || !bld.isValid()) continue;
                    buildings.push({
                        health: bld.health,
                        maxHealth: bld.maxHealth
                    });
                    if (bld.totalAmmo !== undefined || bld.hasAmmo !== undefined) {
                        turrets.push({
                            hasAmmo: bld.hasAmmo !== undefined ? (typeof bld.hasAmmo === "function" ? bld.hasAmmo() : !!bld.hasAmmo) : (bld.totalAmmo > 0),
                            totalAmmo: bld.totalAmmo !== undefined ? bld.totalAmmo : 1
                        });
                    }
                }
            }

            var radarData = computeRadar({
                units: units,
                cores: cores,
                power: powerInfo,
                turrets: turrets,
                buildings: buildings
            });

            statusLabel.setText(formatRadarText(true, radarData));
        } catch (err) {
            logError("refresh failed", err);
            try {
                statusLabel.setText("[gold]РАДАР КАМПАНИИ[]\n[scarlet]Ошибка обновления[]\n[gray]Подробнее в last_log.txt[]");
            } catch (ignored) {}
        }
    };

    Events.on(ClientLoadEvent, asCons(function () {
        try {
            // hudGroup is only visible while a game is running.
            // Placed at top-right, but to the left of the minimap.
            Vars.ui.hudGroup.fill(asCons(function (t) {
                t.top().right();
                t.touchable = Touchable.disabled;

                var offset = 220;
                try {
                    if (typeof Core !== "undefined" && Core.settings) {
                        offset = Core.settings.getInt("minimapsize", 140) + 40;
                    }
                } catch (ignored) {}

                t.table(Styles.black8, asCons(function (panel) {
                    panel.margin(8);
                    statusLabel = panel.add("Сканирование...").color(Color.white).left().get();
                })).marginTop(8).marginRight(offset);

                t.update(function () {
                    if (Time.time >= nextRefresh) {
                        nextRefresh = Time.time + REFRESH_INTERVAL;
                        refreshRadar();
                    }
                });
                refreshRadar();
            }));
        } catch (err) {
            logError("failed to install HUD", err);
        }
    }));
}
