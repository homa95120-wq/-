package campaignradar;

import arc.Events;
import arc.graphics.Color;
import arc.scene.event.Touchable;
import arc.scene.ui.Label;
import arc.scene.ui.layout.Table;
import arc.util.Time;
import mindustry.Vars;
import mindustry.game.EventType.ClientLoadEvent;
import mindustry.game.Team;
import mindustry.gen.Building;
import mindustry.gen.Groups;
import mindustry.gen.Unit;
import mindustry.mod.Mod;
import mindustry.ui.Styles;

/**
 * A HUD-only campaign helper for Mindustry v8 (builds 154 and newer).
 * It does not create entities, modify rules, or send packets.
 */
public class CampaignThreatRadar extends Mod {
    /** Refresh rate in in-game ticks (~30 ticks = 0.5 s at 60 fps). */
    private static final float REFRESH_INTERVAL = 30f;
    /** Ignore units that move slower than this (world units per tick). */
    private static final float MIN_SPEED = 0.05f;
    /** Velocity/direction dot product above which a unit counts as "heading to a core". */
    private static final float TOWARDS_CORE_DOT = 0.25f;

    private Label status;
    private float nextRefresh;

    public CampaignThreatRadar(){
        //Client-only mod: never register UI hooks on a headless server.
        if(Vars.headless) return;

        Events.on(ClientLoadEvent.class, event -> {
            //hudGroup is only visible while a game is running, so the panel
            //automatically hides itself in menus.
            Vars.ui.hudGroup.fill(t -> {
                t.top().left().margin(8f);
                t.touchable = Touchable.disabled;
                t.background(Styles.black8);
                t.add("CAMPAIGN RADAR").color(Color.valueOf("ffd37f")).left().row();
                status = t.add("Scanning...").color(Color.white).left().get();
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
        if(Vars.state == null || !Vars.state.isCampaign() || Vars.player == null || !Vars.player.isAdded()){
            status.setText("Campaign only\nInactive outside a campaign.");
            return;
        }

        final Team enemy = Vars.state.rules.waveTeam;
        int count = 0;
        int threats = 0;
        Unit closestThreat = null;
        float closestThreatEta = Float.MAX_VALUE;
        Building targetCore = null;

        for(Unit unit : Groups.unit){
            if(unit == null || unit.dead || !unit.isAdded() || unit.team != enemy) continue;
            count++;

            Building core = nearestCore(unit);
            if(core == null) continue;

            float dx = core.x - unit.x;
            float dy = core.y - unit.y;
            float speed = unit.vel.len();
            if(speed < MIN_SPEED) continue;

            float dist = (float)Math.sqrt(dx * dx + dy * dy);
            float towards = (unit.vel.x * dx + unit.vel.y * dy) / (speed * dist + 0.001f);
            if(towards > TOWARDS_CORE_DOT){
                threats++;
                float eta = dist / speed; //in ticks, 60 ticks = 1 second
                if(eta < closestThreatEta){
                    closestThreatEta = eta;
                    closestThreat = unit;
                    targetCore = core;
                }
            }
        }

        StringBuilder text = new StringBuilder();
        text.append("Enemy units: ").append(count).append('\n');
        text.append("Moving toward cores: ").append(threats);
        if(closestThreat != null && targetCore != null){
            int seconds = Math.max(1, (int)(closestThreatEta / 60f));
            text.append("\nWARNING: likely approach\nNearest core in about ").append(seconds).append("s");
        }else if(count > 0){
            text.append("\nNo clear core-bound movement detected.");
        }else{
            text.append("\nNo enemy units detected.");
        }
        status.setText(text);
    }

    private Building nearestCore(Unit unit){
        Building nearest = null;
        float best = Float.MAX_VALUE;
        for(Building core : Vars.state.teams.get(Vars.player.team()).cores){
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
