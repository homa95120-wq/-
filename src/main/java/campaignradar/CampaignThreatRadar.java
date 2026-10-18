package campaignradar;

import arc.util.Time;
import mindustry.Vars;
import mindustry.game.EventType.ClientLoadEvent;
import mindustry.gen.Groups;
import mindustry.gen.Unit;
import mindustry.mod.Mod;
import arc.scene.ui.Label;
import arc.scene.ui.layout.Table;
import arc.graphics.Color;
import mindustry.gen.Building;

/**
 * A HUD-only campaign helper. It does not create entities, modify rules, or send packets.
 */
public class CampaignThreatRadar extends Mod {
    private Table panel;
    private Label status;
    private float nextRefresh;

    @Override
    public void init() {
        if (Vars.headless) return;

        mindustry.game.Events.on(ClientLoadEvent.class, event -> {
            panel = new Table();
            panel.left().top().margin(8f);
            panel.add("CAMPAIGN RADAR").color(Color.valueOf("ffd37f")).left().row();
            status = panel.add("Scanning...").color(Color.white).left().get();
            panel.setPosition(8f, Vars.ui.hudGroup.getHeight() - 8f, arc.util.Align.topLeft);
            Vars.ui.hudGroup.addChild(panel);
            panel.update(() -> {
                if (Time.time >= nextRefresh) {
                    nextRefresh = Time.time + 30f;
                    refresh();
                }
            });
            refresh();
        });
    }

    private void refresh() {
        if (panel == null || status == null) return;
        if (!Vars.state.isCampaign() || Vars.player == null || !Vars.player.isAdded()) {
            status.setText("Campaign only\nInactive outside a campaign.");
            return;
        }

        final mindustry.game.Team enemy = Vars.state.rules.waveTeam;
        int count = 0;
        int threats = 0;
        Unit closestThreat = null;
        float closestThreatEta = Float.MAX_VALUE;
        Building targetCore = null;

        for (Unit unit : Groups.unit) {
            if (unit == null || unit.dead || !unit.isAdded() || unit.team != enemy) continue;
            count++;
            Building core = nearestCore(unit);
            if (core == null) continue;
            float dx = core.x - unit.x;
            float dy = core.y - unit.y;
            float speed = unit.vel.len();
            if (speed < 0.05f) continue;
            float toward = (unit.vel.x * dx + unit.vel.y * dy) / (speed * (float)Math.sqrt(dx * dx + dy * dy) + 0.001f);
            if (toward > 0.25f) {
                threats++;
                float eta = (float)Math.sqrt(dx * dx + dy * dy) / speed;
                if (eta < closestThreatEta) {
                    closestThreatEta = eta;
                    closestThreat = unit;
                    targetCore = core;
                }
            }
        }

        StringBuilder text = new StringBuilder();
        text.append("Enemy units: ").append(count).append('\n');
        text.append("Moving toward cores: ").append(threats);
        if (closestThreat != null && targetCore != null) {
            int seconds = Math.max(1, (int)(closestThreatEta / 60f));
            text.append("\nWARNING: likely approach\nNearest core in about ")
                .append(seconds).append("s");
        } else if (count > 0) {
            text.append("\nNo clear core-bound movement detected.");
        } else {
            text.append("\nNo enemy units detected.");
        }
        status.setText(text.toString());
    }

    private Building nearestCore(Unit unit) {
        Building nearest = null;
        float best = Float.MAX_VALUE;
        for (Building core : Vars.state.teams.get(Vars.player.team()).cores) {
            float dx = core.x - unit.x;
            float dy = core.y - unit.y;
            float dst2 = dx * dx + dy * dy;
            if (dst2 < best) {
                best = dst2;
                nearest = core;
            }
        }
        return nearest;
    }
}
