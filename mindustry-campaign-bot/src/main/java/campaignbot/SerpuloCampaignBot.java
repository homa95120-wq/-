package campaignbot;

import arc.Core;
import arc.Events;
import arc.graphics.Color;
import arc.scene.event.Touchable;
import arc.scene.ui.Label;
import arc.scene.ui.layout.Scl;
import arc.scene.ui.layout.Table;
import arc.util.Time;
import mindustry.Vars;
import mindustry.game.EventType.ClientLoadEvent;
import mindustry.game.EventType.Trigger;
import mindustry.mod.Mod;
import mindustry.type.Sector;
import mindustry.ui.Styles;

import static campaignbot.CampaignBotLogic.*;

/**
 * Standalone Mindustry v8 mod that autonomously completes the Serpulo campaign:
 * builds economy, power, industrial chains, defenses, and unit reconstructor lines,
 * commands assault squads against enemy bases, researches the Serpulo TechTree using
 * real sector resources, and launches from sector to sector all the way to
 * Planetary Launch Terminal.
 */
public class SerpuloCampaignBot extends Mod{

    public static final float PANEL_WIDTH = 340f;
    public static final float REFRESH_TICKS = 30f;

    private SectorAutopilot autopilot;
    private Label hudLabel;
    private Label planetLabel;
    private Table bodyTable;
    private boolean collapsed = false;
    private float nextRefresh;

    public SerpuloCampaignBot(){
        if(Vars.headless) return;

        autopilot = new SectorAutopilot();

        Events.on(ClientLoadEvent.class, event -> {
            buildInGameHud();
            attachPlanetDialogOverlay();
        });

        Events.run(Trigger.update, () -> {
            if(Time.time < nextRefresh) return;
            nextRefresh = Time.time + REFRESH_TICKS;
            refreshLabels();
        });
    }

    private void buildInGameHud(){
        if(Vars.ui == null || Vars.ui.hudGroup == null) return;

        Vars.ui.hudGroup.fill(root -> {
            root.top().left();
            root.touchable = Touchable.childrenOnly;

            float width = Scl.scl(PANEL_WIDTH);
            if(Core.graphics != null){
                width = Math.min(width, Core.graphics.getWidth() * 0.42f);
            }
            final float contentW = Math.max(180f, width);

            root.table(Styles.black8, panel -> {
                panel.margin(6f);
                panel.touchable = Touchable.childrenOnly;
                panel.defaults().left().top();

                panel.table(header -> {
                    header.defaults().height(28f).pad(1f);
                    header.button("▶ Кампания", Styles.flatt, () -> {
                        autopilot.start();
                        refreshLabels();
                    }).growX();
                    header.button("⏸ Пауза", Styles.flatt, () -> {
                        autopilot.pause();
                        refreshLabels();
                    }).growX();
                    header.button("■ Стоп", Styles.flatt, () -> {
                        autopilot.stop();
                        refreshLabels();
                    }).growX();
                    header.button("▾", Styles.flatt, () -> {
                        collapsed = !collapsed;
                        if(bodyTable != null) bodyTable.visible = !collapsed;
                    }).width(32f);
                }).width(contentW).left();
                panel.row();

                bodyTable = panel.table(body -> {
                    body.defaults().left().top();
                    hudLabel = body.add(composeHudString()).color(Color.white).left().width(contentW).get();
                    hudLabel.setWrap(true);
                }).width(contentW).left().get();
            }).marginTop(Scl.scl(152f)).marginLeft(Scl.scl(8f));
        });
    }

    private void attachPlanetDialogOverlay(){
        if(Vars.ui == null || Vars.ui.planet == null) return;

        Vars.ui.planet.shown(() -> Core.app.post(() -> {
            Table bar = new Table(Styles.black8);
            bar.margin(8f);
            bar.touchable = Touchable.childrenOnly;
            bar.defaults().pad(2f);

            planetLabel = bar.add(composePlanetString()).color(Color.white).left().width(360f).get();
            planetLabel.setWrap(true);
            bar.row();

            bar.table(btns -> {
                btns.defaults().height(34f).width(116f).pad(2f);
                btns.button("▶ Кампания", Styles.flatt, () -> {
                    autopilot.start();
                    refreshLabels();
                });
                btns.button("⏸ Пауза", Styles.flatt, () -> {
                    autopilot.pause();
                    refreshLabels();
                });
                btns.button("■ Стоп", Styles.flatt, () -> {
                    autopilot.stop();
                    refreshLabels();
                });
            }).left();

            Table container = new Table();
            container.setFillParent(true);
            container.top().padTop(42f);
            container.touchable = Touchable.childrenOnly;
            container.add(bar);
            Vars.ui.planet.addChild(container);
        }));
    }

    private void refreshLabels(){
        if(hudLabel != null){
            hudLabel.setText(composeHudString());
        }
        if(planetLabel != null){
            planetLabel.setText(composePlanetString());
        }
    }

    private String composeHudString(){
        int[] prog = autopilot.director.countPresetProgress();
        Sector sec = Vars.state != null && Vars.state.isCampaign() ? Vars.state.getSector() : null;
        String secTitle = sec == null ? "—" : sec.name()
                + (Vars.state.rules.attackMode ? " [scarlet](штурм базы)[]"
                : Vars.state.rules.winWave > 0 ? " (волна " + Vars.state.wave + "/" + Vars.state.rules.winWave + ")"
                : sec.isCaptured() ? " [accent](захвачен)[]" : "");
        String detail = autopilot.state == RUNNING ? autopilot.lastAction
                : (autopilot.reason == null || autopilot.reason.isEmpty() ? autopilot.lastAction : autopilot.reason);
        return formatHudText(
                autopilot.state,
                prog[0], prog[1],
                secTitle,
                autopilot.lastAction,
                autopilot.director.lastResearchSummary,
                autopilot.armySummary,
                detail);
    }

    private String composePlanetString(){
        int[] prog = autopilot.director.countPresetProgress();
        String detail = autopilot.state == RUNNING ? autopilot.lastAction
                : (autopilot.reason == null || autopilot.reason.isEmpty()
                ? "Нажмите ▶, чтобы бот сам прошёл кампанию Serpulo" : autopilot.reason);
        return "[" + stateColor(autopilot.state) + "]🤖 Автокампания Serpulo: " + stateName(autopilot.state)
                + "[] [lightgray](" + prog[0] + "/" + prog[1] + " сюж.)[]\n"
                + "[lightgray]" + detail + "[]";
    }
}
