/*
 * Campaign Threat Radar (ZIP) - script version of campaignradar.CampaignThreatRadar.
 *
 * This is the same read-only logic as the Java mod, ported to the Rhino
 * JavaScript API that Mindustry v8 (build 154+) exposes to script mods
 * (see core/assets/scripts/global.js in the game sources: Vars, Groups,
 * Events, ClientLoadEvent, Styles, ... are imported for every script).
 *
 * The file is split into three parts:
 *   1. Pure logic (computeRadar / formatRadarText) - plain JS objects in,
 *      plain result out. No game API is touched here, so this part can be
 *      unit-tested outside the game (scriptmod/test-logic.js, Node >= 18).
 *   2. An adapter that reads the live game state into plain objects.
 *   3. HUD registration. Only runs inside the game, guarded so that
 *      requiring this file in Node does nothing.
 *
 * Do NOT install/enable this together with the Java jar: you would get
 * two panels. The internal name is deliberately different
 * (campaign-threat-radar-zip), so the game does not refuse to load the
 * second file with "a mod with the name ... is already imported".
 */

// ---------------------------------------------------------------- logic

var REFRESH_INTERVAL = 30; // ticks, ~0.5 s at 60 fps (same as the Java mod)
var MIN_SPEED = 0.05; // world units per tick; slower units are ignored
var TOWARDS_CORE_DOT = 0.25; // velocity/direction cosine above which a unit counts as heading to a core

function nearestCore(x, y, cores) {
    var best = null;
    var bestDst2 = Infinity;
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
 * units: [{x, y, vx, vy, speed, dead, added, enemy}]
 * cores: [{x, y}]
 * Returns {count, threats, closestEtaTicks} where closestEtaTicks is
 * null when no unit is heading to a core.
 */
function computeRadar(units, cores) {
    var count = 0;
    var threats = 0;
    var closestEtaTicks = null;

    if (!units) units = [];
    if (!cores) cores = [];

    for (var i = 0; i < units.length; i++) {
        var unit = units[i];
        if (!unit || unit.dead || !unit.added || !unit.enemy) continue;
        count++;

        var core = nearestCore(unit.x, unit.y, cores);
        if (!core) continue;

        var speed = typeof unit.speed === "number" ? unit.speed : Math.sqrt(unit.vx * unit.vx + unit.vy * unit.vy);
        if (speed < MIN_SPEED) continue;

        var dx = core.x - unit.x;
        var dy = core.y - unit.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        // Same epsilon as the Java version: / (speed * dist + 0.001f).
        var towards = (unit.vx * dx + unit.vy * dy) / (speed * dist + 0.001);
        if (towards > TOWARDS_CORE_DOT) {
            threats++;
            var eta = dist / speed; // ticks, 60 ticks = 1 second
            if (closestEtaTicks === null || eta < closestEtaTicks) {
                closestEtaTicks = eta;
            }
        }
    }

    return { count: count, threats: threats, closestEtaTicks: closestEtaTicks };
}

function etaSeconds(etaTicks) {
    // Java: Math.max(1, (int)(eta / 60f)) - truncation, not rounding.
    return Math.max(1, Math.floor(etaTicks / 60));
}

function formatRadarText(inCampaign, result) {
    if (!inCampaign) {
        return "Campaign only\nInactive outside a campaign.";
    }
    var text = "Enemy units: " + result.count + "\nMoving toward cores: " + result.threats;
    if (result.closestEtaTicks !== null && result.closestEtaTicks !== undefined) {
        text += "\nWARNING: likely approach\nNearest core in about " + etaSeconds(result.closestEtaTicks) + "s";
    } else if (result.count > 0) {
        text += "\nNo clear core-bound movement detected.";
    } else {
        text += "\nNo enemy units detected.";
    }
    return text;
}

// Exported only for the offline test harness; `module` is undefined in Rhino.
if (typeof module !== "undefined" && module && module.exports) {
    module.exports = {
        REFRESH_INTERVAL: REFRESH_INTERVAL,
        MIN_SPEED: MIN_SPEED,
        TOWARDS_CORE_DOT: TOWARDS_CORE_DOT,
        computeRadar: computeRadar,
        formatRadarText: formatRadarText,
        etaSeconds: etaSeconds
    };
}

// ---------------------------------------------------------------- game glue

// Only register anything when the game globals really exist. In Node
// (tests) and on a headless server this whole block is skipped.
if (typeof Vars !== "undefined" && typeof Events !== "undefined" && typeof ClientLoadEvent !== "undefined" && !Vars.headless) {

    // global.js provides cons() (arc.func.Cons wrapper). Rhino can coerce a
    // plain function to a SAM interface, but the explicit wrapper removes
    // any overload ambiguity (e.g. Group.fill has several overloads).
    var asCons = typeof cons !== "undefined" ? cons : function (f) { return f; };

    var statusLabel = null;
    var nextRefresh = 0;

    var logError = function (where, err) {
        // Keep the prefix stable: users are told to grep the game log
        // (last_log.txt) for "[campaign-radar]".
        try {
            Log.err("[campaign-radar] " + where + ": " + err);
        } catch (ignored) {
            // Logging must never take the HUD down with it.
        }
    };

    var refreshRadar = function () {
        if (!statusLabel) return;
        try {
            if (!Vars.state || !Vars.state.isCampaign() || !Vars.player || !Vars.player.isAdded()) {
                statusLabel.setText(formatRadarText(false, null));
                return;
            }

            var enemyTeam = Vars.state.rules.waveTeam;

            var cores = [];
            var coreSeq = Vars.state.teams.get(Vars.player.team()).cores;
            for (var i = 0; i < coreSeq.size; i++) {
                var core = coreSeq.get(i);
                if (core) cores.push({ x: core.x, y: core.y });
            }

            var units = [];
            Groups.unit.each(asCons(function (unit) {
                if (!unit) return;
                units.push({
                    x: unit.x,
                    y: unit.y,
                    vx: unit.vel.x,
                    vy: unit.vel.y,
                    speed: unit.vel.len(),
                    dead: !!unit.dead,
                    added: unit.isAdded(),
                    enemy: unit.team === enemyTeam
                });
            }));

            statusLabel.setText(formatRadarText(true, computeRadar(units, cores)));
        } catch (err) {
            logError("refresh failed", err);
            try {
                statusLabel.setText("Radar error\nSee last_log.txt: [campaign-radar]");
            } catch (ignored) {}
        }
    };

    Events.on(ClientLoadEvent, asCons(function () {
        try {
            // hudGroup is only visible while a game is running, so the
            // panel hides itself in menus - same as the Java version.
            Vars.ui.hudGroup.fill(asCons(function (t) {
                t.top().left().margin(8);
                t.touchable = Touchable.disabled;
                t.background(Styles.black8);
                t.add("CAMPAIGN RADAR").color(Color.valueOf("ffd37f")).left().row();
                statusLabel = t.add("Scanning...").color(Color.white).left().get();
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
