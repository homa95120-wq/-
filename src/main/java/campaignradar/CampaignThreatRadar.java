package campaignradar;

import arc.Core;
import arc.Events;
import arc.graphics.Color;
import arc.scene.event.Touchable;
import arc.scene.ui.Label;
import arc.scene.ui.layout.Table;
import arc.struct.Seq;
import arc.util.Time;
import mindustry.Vars;
import mindustry.game.EventType.ClientLoadEvent;
import mindustry.game.Team;
import mindustry.game.Teams.TeamData;
import mindustry.gen.Building;
import mindustry.gen.Groups;
import mindustry.gen.Unit;
import mindustry.mod.Mod;
import mindustry.ui.Styles;
import mindustry.world.blocks.defense.turrets.Turret.TurretBuild;
import mindustry.world.blocks.power.PowerGraph;

/**
 * A HUD-only campaign and singleplayer tactical radar for Mindustry v8 (builds 154 and newer).
 * Positioned at top-right, to the left of the minimap.
 * Does not create entities, modify rules, or send packets (hidden: true).
 */
public class CampaignThreatRadar extends Mod {
    /** Refresh rate in in-game ticks (~30 ticks = 0.5 s at 60 fps). */
    private static final float REFRESH_INTERVAL = 30f;
    /** Ignore units that move slower than this (world units per tick) for ETA. */
    private static final float MIN_SPEED = 0.05f;
    /** Velocity/direction dot product above which a unit counts as "heading to a core". */
    private static final float TOWARDS_CORE_DOT = 0.25f;
    /** Proximity threshold to core in world units (40 tiles = 320 world units). */
    private static final float CLOSE_DISTANCE = 320f;

    private Label status;
    private float nextRefresh;

    public CampaignThreatRadar(){
        // Client-only mod: never register UI hooks on a headless server.
        if(Vars.headless) return;

        Events.on(ClientLoadEvent.class, event -> {
            // hudGroup is only visible while a game is running.
            Vars.ui.hudGroup.fill(t -> {
                t.top().right();
                t.touchable = Touchable.disabled;

                float offset = 220f;
                if(Core.settings != null){
                    offset = Core.settings.getInt("minimapsize", 140) + 40f;
                }

                t.table(Styles.black8, panel -> {
                    panel.margin(8f);
                    status = panel.add("Сканирование...").color(Color.white).left().get();
                }).marginTop(8f).marginRight(offset);

                t.update(() -> {
                    if(Time.time >= nextRefresh){
                        nextRefresh = Time.time + REFRESH_INTERVAL;
                        refresh();
                    }
                });
                refresh();
            });
        });
    }

    private void refresh(){
        if(status == null) return;
        if(Vars.state == null || !Vars.state.isGame() || Vars.player == null || !Vars.player.isAdded()){
            status.setText("[gold]РАДАР КАМПАНИИ[]\n[gray]Неактивен вне игры[]");
            return;
        }

        Team enemy = Vars.state.rules.waveTeam != null ? Vars.state.rules.waveTeam : Team.crux;
        Team playerTeam = Vars.player.team();
        TeamData teamData = Vars.state.teams != null ? Vars.state.teams.get(playerTeam) : null;

        int totalCount = 0;
        int groundCount = 0;
        int flyingCount = 0;
        int bossCount = 0;
        Seq<String> bossNames = new Seq<>();

        int threats = 0;
        int closeThreats = 0;
        float closestEta = Float.MAX_VALUE;
        float closestDistTiles = Float.MAX_VALUE;

        for(Unit unit : Groups.unit){
            if(unit == null || unit.dead || !unit.isAdded() || unit.team != enemy) continue;
            totalCount++;

            if(unit.isFlying()){
                flyingCount++;
            }else{
                groundCount++;
            }

            if(unit.isBoss()){
                bossCount++;
                String name = unit.type != null ? unit.type.localizedName : "Босс";
                if(!bossNames.contains(name)){
                    bossNames.add(name);
                }
            }

            Building core = nearestCore(unit, teamData);
            if(core == null) continue;

            float dx = core.x - unit.x;
            float dy = core.y - unit.y;
            float dist = (float)Math.sqrt(dx * dx + dy * dy);
            float distTiles = dist / 8.0f;

            if(distTiles < closestDistTiles){
                closestDistTiles = distTiles;
            }

            if(dist <= CLOSE_DISTANCE){
                closeThreats++;
            }

            float speed = unit.vel.len();
            if(speed < MIN_SPEED) continue;

            float towards = (unit.vel.x * dx + unit.vel.y * dy) / (speed * dist + 0.001f);
            if(towards > TOWARDS_CORE_DOT){
                threats++;
                float eta = dist / speed; // in ticks (60 ticks = 1 sec)
                if(eta < closestEta){
                    closestEta = eta;
                }
            }
        }

        // Core Health diagnostics
        float minCoreHpPercent = 100f;
        boolean hasCores = false;
        Building mainCore = null;
        if(teamData != null && teamData.cores != null && teamData.cores.size > 0){
            hasCores = true;
            mainCore = teamData.cores.first();
            for(Building core : teamData.cores){
                if(core == null || !core.isValid()) continue;
                float pct = (core.health / core.maxHealth) * 100.0f;
                if(pct < minCoreHpPercent){
                    minCoreHpPercent = pct;
                }
            }
        }

        // Power diagnostics
        boolean hasPowerDeficit = false;
        boolean hasBlackout = false;
        float powerNet = 0f;
        float batPercent = 100f;
        if(mainCore != null && mainCore.power != null && mainCore.power.graph != null){
            PowerGraph graph = mainCore.power.graph;
            powerNet = graph.getPowerBalance() * 60f;
            float batStored = graph.getBatteryStored();
            float batCap = graph.getBatteryCapacity();
            batPercent = batCap > 0f ? (batStored / batCap) * 100f : 100f;
            hasPowerDeficit = powerNet < -5f;
            hasBlackout = (hasPowerDeficit && batStored <= 1f) || (powerNet < -30f && batPercent < 10f);
        }

        // Turrets & Damaged buildings diagnostics
        int emptyTurrets = 0;
        int damagedBuildings = 0;
        if(teamData != null && teamData.buildings != null){
            for(Building bld : teamData.buildings){
                if(bld == null || !bld.isValid()) continue;
                if(bld.health < bld.maxHealth * 0.5f){
                    damagedBuildings++;
                }
                if(bld instanceof TurretBuild tb){
                    if(!tb.hasAmmo()){
                        emptyTurrets++;
                    }
                }
            }
        }

        // Format UI string
        StringBuilder text = new StringBuilder();
        text.append("[gold]РАДАР КАМПАНИИ[] [lightgray]v1.2[]\n");

        // Line 1: Counts
        text.append("[white]Враги:[accent] ").append(totalCount).append("[]");
        if(totalCount > 0){
            text.append(" [lightgray](🚜").append(groundCount).append(" 🛸").append(flyingCount).append(")[]");
            if(bossCount > 0){
                text.append(" [scarlet]💀").append(bossCount).append("[]");
            }
        }
        text.append('\n');

        // Line 2: Threat & Approach
        if(threats > 0 && closestEta < Float.MAX_VALUE){
            int sec = Math.max(1, (int)(closestEta / 60f));
            text.append("[scarlet]⚠️ ПРОРЫВ: ").append(threats).append(" к ядру! ETA: ~").append(sec).append("с[]\n");
        }else if(closeThreats > 0 && closestDistTiles < Float.MAX_VALUE){
            text.append("[crimson]🚨 Враг рядом с ядром (~").append((int)closestDistTiles).append(" бл.)![]\n");
        }else if(totalCount > 0){
            text.append("[orange]Враги на карте (курс мимо ядра)[]\n");
        }else{
            text.append("[lightgray]Вражеских юнитов нет[]\n");
        }

        // Line 3: Boss warning
        if(bossCount > 0 && bossNames.size > 0){
            text.append("[scarlet]💀 БОСС: ").append(bossNames.toString(", ")).append("[]\n");
        }

        // Line 4: Core HP
        if(hasCores && minCoreHpPercent < 99f){
            int hp = (int)minCoreHpPercent;
            if(hp <= 35){
                text.append("[crimson]🚨 КРИТИЧЕСКИЙ УРОН ЯДРУ: ").append(hp).append("%![]\n");
            }else{
                text.append("[coral]⚠️ ЯДРО ПОВРЕЖДЕНО: ").append(hp).append("%[]\n");
            }
        }

        // Line 5: Power
        if(hasBlackout){
            text.append("[scarlet]⚡ СЕТЬ ОБЕСТОЧЕНА: ").append((int)powerNet).append("/с[]\n");
        }else if(hasPowerDeficit){
            text.append("[coral]⚡ ДЕФИЦИТ ЭНЕРГИИ: ").append((int)powerNet).append("/с (АКБ: ").append((int)batPercent).append("%)[]\n");
        }

        // Line 6: Empty turrets
        if(emptyTurrets > 0){
            text.append("[yellow]📦 Турели без патронов: ").append(emptyTurrets).append(" шт.[]\n");
        }

        // Line 7: Damaged defenses
        if(damagedBuildings >= 3){
            text.append("[yellow]🛠️ Повреждения базы: ").append(damagedBuildings).append(" построек[]\n");
        }

        // Line 8: All stable status
        boolean hasAlerts = threats > 0 || closeThreats > 0 || bossCount > 0 ||
                (hasCores && minCoreHpPercent < 99f) || hasPowerDeficit ||
                emptyTurrets > 0 || damagedBuildings >= 3;

        if(!hasAlerts && totalCount == 0){
            text.append("[green]✅ Все системы стабильны[]");
        }

        // Remove trailing newline if any
        if(text.charAt(text.length() - 1) == '\n'){
            text.setLength(text.length() - 1);
        }

        status.setText(text.toString());
    }

    private Building nearestCore(Unit unit, TeamData teamData){
        if(teamData == null || teamData.cores == null || teamData.cores.size == 0) return null;
        Building nearest = null;
        float best = Float.MAX_VALUE;
        for(Building core : teamData.cores){
            if(core == null || !core.isValid()) continue;
            float dx = core.x - unit.x;
            float dy = core.y - unit.y;
            float dst2 = dx * dx + dy * dy;
            if(dst2 < best){
                best = dst2;
                nearest = core;
            }
        }
        return nearest;
    }
}
