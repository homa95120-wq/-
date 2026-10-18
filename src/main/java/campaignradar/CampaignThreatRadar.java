package campaignradar;

import arc.Core;
import arc.Events;
import arc.graphics.Color;
import arc.scene.event.Touchable;
import arc.scene.ui.Label;
import arc.scene.ui.layout.Scl;
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
 * Positioned at top-right, to the left of the vanilla minimap, and made of:
 * <ul>
 *     <li>a text panel with enemy counts, threat ETAs, base diagnostics and forecasts,</li>
 *     <li>a small tactical mini map that shows every enemy unit around your core.</li>
 * </ul>
 * Does not create entities, modify rules, or send packets (hidden: true).
 */
public class CampaignThreatRadar extends Mod{
    /** Refresh rate in in-game ticks (~30 ticks = 0.5 s at 60 fps). */
    public static final float REFRESH_INTERVAL = 30f;
    /** Ignore units that move slower than this (world units per tick) for ETA. */
    public static final float MIN_SPEED = 0.05f;
    /** Velocity/direction dot product above which a unit counts as "heading to a core". */
    public static final float TOWARDS_CORE_DOT = 0.25f;
    /** Proximity threshold to core in world units (40 tiles = 320 world units). */
    public static final float CLOSE_DISTANCE = 320f;
    /** World units per tile. */
    public static final float TILE_SIZE = 8f;
    /** Width of the vanilla minimap in UI units (it is drawn at Scl.scl(140) + margins). */
    public static final float MINIMAP_WIDTH = 150f;
    /** Gap between the vanilla minimap and this panel, in UI units. */
    public static final float MINIMAP_GAP = 70f;
    /** Side of the square tactical mini map, in UI units. */
    public static final float RADAR_SIZE = 160f;
    /** Radius of the tactical mini map, in tiles. */
    public static final float RADAR_RANGE_TILES = 120f;
    /** How far ahead the forecast looks, in seconds. */
    public static final float HORIZON_SECONDS = 60f;

    /** Blip kind: ground unit. */
    public static final int KIND_GROUND = 0;
    /** Blip kind: flying unit. */
    public static final int KIND_FLYING = 1;
    /** Blip kind: boss. */
    public static final int KIND_BOSS = 2;
    /** Blip kind: player core. */
    public static final int KIND_CORE = 3;

    private Label status;
    private RadarMap radar;
    private float nextRefresh;

    public CampaignThreatRadar(){
        // Client-only mod: never register UI hooks on a headless server.
        if(Vars.headless) return;

        Events.on(ClientLoadEvent.class, event -> {
            // hudGroup is only visible while a game is running.
            Vars.ui.hudGroup.fill(t -> {
                t.top().right();
                t.touchable = Touchable.disabled;

                // The panel lives left of the vanilla minimap, with a clear gap
                // so that neither of the two overlaps on small screens.
                float offset = Scl.scl(MINIMAP_WIDTH + MINIMAP_GAP);
                if(Core.graphics != null){
                    offset = Math.min(offset, Core.graphics.getWidth() * 0.5f);
                }

                t.table(Styles.black8, panel -> {
                    panel.margin(6f);
                    panel.defaults().left().top();

                    status = panel.add("Сканирование...").color(Color.white).left().growX().get();
                    panel.row();
                    radar = panel.add(new RadarMap()).size(Scl.scl(RADAR_SIZE), Scl.scl(RADAR_SIZE)).get();
                    panel.row();
                    panel.add(legend()).color(Color.lightGray).left().growX().get();
                }).marginTop(Scl.scl(6f)).marginRight(offset);

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

    /** Legend shown under the tactical mini map. */
    public static String legend(){
        return "[lightgray]◆[accent] ядро  [lightgray]●[scarlet] враг  [lightgray]●[orange] авиация  [lightgray]◉[scarlet] босс[]";
    }

    private void refresh(){
        if(status == null) return;
        if(Vars.state == null || !Vars.state.isGame() || Vars.player == null || !Vars.player.isAdded()){
            status.setText(format(false, null));
            if(radar != null) radar.clear();
            return;
        }

        Team enemy = Vars.state.rules.waveTeam != null ? Vars.state.rules.waveTeam : Team.crux;
        Team playerTeam = Vars.player.team();
        TeamData teamData = Vars.state.teams != null ? Vars.state.teams.get(playerTeam) : null;

        Seq<UnitInfo> units = new Seq<>();
        Seq<CoreInfo> cores = new Seq<>();

        // Player cores
        Building mainCore = null;
        if(teamData != null && teamData.cores != null && teamData.cores.size > 0){
            for(Building core : teamData.cores){
                if(core == null || !core.isValid()) continue;
                CoreInfo info = new CoreInfo();
                info.x = core.x;
                info.y = core.y;
                info.health = core.health;
                info.maxHealth = core.maxHealth;
                cores.add(info);
                if(mainCore == null) mainCore = core;
            }
        }

        // Enemy units
        for(Unit unit : Groups.unit){
            if(unit == null || unit.dead || !unit.isAdded() || unit.team != enemy) continue;

            UnitInfo info = new UnitInfo();
            info.x = unit.x;
            info.y = unit.y;
            info.vx = unit.vel != null ? unit.vel.x : 0f;
            info.vy = unit.vel != null ? unit.vel.y : 0f;
            info.speed = unit.vel != null ? unit.vel.len() : 0f;
            info.maxSpeed = unit.type != null ? unit.type.speed : 0f;
            info.accel = unit.type != null ? unit.type.accel : 0.5f;
            info.dps = unit.type != null ? unit.type.estimateDps() : 0f;
            info.boss = unit.isBoss();
            // isFlying() is true while a unit is airborne, so the type is the reliable source here.
            info.flying = unit.type != null ? unit.type.flying : unit.isFlying();
            info.name = unit.type != null ? unit.type.localizedName : "Босс";
            units.add(info);
        }

        // Turrets, damaged buildings and the estimated defensive DPS
        int emptyTurrets = 0;
        int damagedBuildings = 0;
        float defenseDps = 0f;
        if(teamData != null && teamData.buildings != null){
            for(Building bld : teamData.buildings){
                if(bld == null || !bld.isValid()) continue;
                if(bld.health < bld.maxHealth * 0.5f){
                    damagedBuildings++;
                }
                if(bld instanceof TurretBuild tb){
                    if(!tb.hasAmmo()){
                        emptyTurrets++;
                    }else{
                        defenseDps += tb.estimateDps();
                    }
                }
            }
        }

        // Power network diagnostics
        boolean hasPower = false;
        float powerNet = 0f;
        float battery = 100f;
        if(mainCore != null && mainCore.power != null && mainCore.power.graph != null){
            hasPower = true;
            PowerGraph graph = mainCore.power.graph;
            powerNet = graph.getPowerBalance() * 60f;
            float batStored = graph.getBatteryStored();
            float batCap = graph.getBatteryCapacity();
            battery = batCap > 0f ? (batStored / batCap) * 100f : 100f;
        }

        Prediction prediction = compute(units, cores, emptyTurrets, damagedBuildings, defenseDps,
                powerNet, battery, hasPower, HORIZON_SECONDS);

        status.setText(format(true, prediction));
        updateRadar(prediction, cores);
    }

    /** Feeds the mini map with the freshly computed data. */
    private void updateRadar(Prediction prediction, Seq<CoreInfo> cores){
        if(radar == null) return;
        radar.clear();

        float centerX = 0f, centerY = 0f;
        if(cores.size > 0){
            // The radar follows the weakest core: that is where the attack will land.
            CoreInfo weakest = cores.first();
            for(CoreInfo core : cores){
                if(core.health < weakest.health) weakest = core;
            }
            centerX = weakest.x;
            centerY = weakest.y;
        }else if(Vars.player != null && Vars.player.unit != null){
            centerX = Vars.player.unit.x;
            centerY = Vars.player.unit.y;
        }
        radar.centerX = centerX;
        radar.centerY = centerY;
        radar.range = RADAR_RANGE_TILES * TILE_SIZE;

        for(CoreInfo core : cores){
            radar.cores.add(new Blip(core.x, core.y, 0f, KIND_CORE));
        }
        for(Blip blip : prediction.blips){
            radar.blips.add(blip);
        }

        if(Vars.player != null && Vars.player.unit != null){
            radar.playerX = Vars.player.unit.x;
            radar.playerY = Vars.player.unit.y;
            radar.hasPlayer = true;
        }else{
            radar.hasPlayer = false;
        }

        // Point at the closest threat so the direction of the attack is obvious.
        Blip closest = null;
        for(Blip blip : prediction.blips){
            if(closest == null || blip.eta < closest.eta) closest = blip;
        }
        if(closest != null){
            radar.threatX = closest.x;
            radar.threatY = closest.y;
            radar.hasThreat = true;
        }else{
            radar.hasThreat = false;
        }
    }

    // ---------------------------------------------------------------- logic

    /** Snapshot of a single enemy unit. */
    public static class UnitInfo{
        public float x, y, vx, vy;
        /** Current speed in world units per tick. */
        public float speed;
        /** Maximum speed of the unit type in world units per tick. */
        public float maxSpeed;
        /** Acceleration of the unit type (fraction of speed per tick). */
        public float accel = 0.5f;
        /** Rough damage per second this unit deals to a single target. */
        public float dps;
        public boolean flying, boss;
        public String name = "";
    }

    /** Snapshot of a single player core. */
    public static class CoreInfo{
        public float x, y, health, maxHealth;
    }

    /** A marker drawn on the tactical mini map. */
    public static class Blip{
        public final float x, y;
        /** ETA of that unit, Float.MAX_VALUE when it is unknown. */
        public float eta;
        public final int kind;

        public Blip(float x, float y, float eta, int kind){
            this.x = x;
            this.y = y;
            this.eta = eta;
            this.kind = kind;
        }
    }

    /** Estimated arrival of one unit at the core. */
    public static class Arrival{
        /** Expected time to contact, in ticks. */
        public float eta;
        /** Optimistic and pessimistic bounds, in ticks. */
        public float low, high;
        /** True when the unit is already moving towards the core. */
        public boolean direct;
        /** True when the unit is stuck, blocked or busy shooting. */
        public boolean engaged;
    }

    /** Everything the panel needs after one analysis pass. */
    public static class Prediction{
        public int count, groundCount, flyingCount, bossCount;
        public int threats, closeThreats, incoming;
        public int emptyTurrets, damagedBuildings;
        public Seq<String> bossNames = new Seq<>();
        /** ETA of the closest unit, in ticks. */
        public float eta = Float.MAX_VALUE, etaLow = Float.MAX_VALUE, etaHigh = Float.MAX_VALUE;
        /** ETA of the closest unit that is already heading for the core, in ticks. */
        public float directEta = Float.MAX_VALUE, directEtaLow = Float.MAX_VALUE, directEtaHigh = Float.MAX_VALUE;
        public boolean etaDirect;
        /** Combined damage per second of every unit that reaches the core within the horizon. */
        public float incomingDps;
        /** Estimated damage per second of the player defences. */
        public float defenseDps;
        /** Seconds until the weakest core dies if the incoming damage keeps coming. */
        public float coreDeath = Float.MAX_VALUE;
        public float minCoreHp = 100f;
        public float coreHealth;
        public float powerNet, battery;
        public boolean hasPower, powerDeficit, blackout;
        public Seq<Blip> blips = new Seq<>();
    }

    /**
     * Estimates when a unit reaches the core.
     * <p>
     * The estimate is deliberately pessimistic: ground units have to walk around
     * obstacles, units lose time to turns and to the fire of the turrets, and a unit
     * that is currently shooting something has to finish that first.
     */
    public static Arrival predictArrival(UnitInfo unit, float dist, boolean direct){
        Arrival result = new Arrival();

        float maxSpeed = unit.maxSpeed > 0f ? unit.maxSpeed : Math.max(unit.speed, 0.05f);
        // Average speed a unit really keeps: turns, terrain and incoming fire cost time.
        float cruise = maxSpeed * (unit.flying ? 0.95f : 0.82f);
        // Ground units walk around obstacles, flyers go straight.
        float path = dist * (unit.flying ? 1.05f : 1.3f);

        float accel = Math.max(0.02f, maxSpeed * Math.max(unit.accel, 0.1f));
        float ramp = unit.speed < cruise ? Math.min(60f, (cruise - unit.speed) / accel) : 0f;

        // A unit that barely moves is either accelerating, blocked or shooting something.
        boolean engaged = unit.speed < cruise * 0.35f;

        float effective = cruise;
        float delay = 0f;
        if(!direct){
            // It has to turn around and take a detour before it reaches the core.
            effective = cruise * 0.75f;
            delay = 120f;
        }
        if(engaged){
            // It has to finish the current action before it moves again.
            effective = Math.max(cruise * 0.6f, 0.05f);
            delay += 180f;
        }

        float eta = path / Math.max(effective, 0.01f) + ramp + delay;
        result.eta = eta;
        result.low = eta * (engaged ? 0.5f : (direct ? 0.8f : 0.7f));
        result.high = eta * (engaged ? 2f : (direct ? 1.3f : 1.5f));
        result.direct = direct;
        result.engaged = engaged;
        return result;
    }

    /** Runs the whole analysis: counts, ETAs, forecast and diagnostics. */
    public static Prediction compute(Seq<UnitInfo> units, Seq<CoreInfo> cores, int emptyTurrets, int damagedBuildings,
                                     float defenseDps, float powerNet, float battery, boolean hasPower, float horizonSeconds){
        Prediction result = new Prediction();
        result.emptyTurrets = emptyTurrets;
        result.damagedBuildings = damagedBuildings;
        result.defenseDps = defenseDps;
        result.hasPower = hasPower;
        result.powerNet = powerNet;
        result.battery = battery;

        float horizon = horizonSeconds * 60f;
        float closest = Float.MAX_VALUE;
        Arrival closestArrival = null;
        Arrival closestDirect = null;

        // Weakest core: the point the attack is most likely to break through.
        float minCoreHp = 100f;
        float coreHealth = 0f;
        boolean hasCore = false;
        for(CoreInfo core : cores){
            float pct = core.maxHealth > 0f ? (core.health / core.maxHealth) * 100f : 100f;
            if(!hasCore || pct < minCoreHp){
                minCoreHp = pct;
                coreHealth = core.health;
                hasCore = true;
            }
        }
        result.minCoreHp = minCoreHp;
        result.coreHealth = coreHealth;

        for(UnitInfo unit : units){
            if(unit == null) continue;
            result.count++;
            if(unit.flying){
                result.flyingCount++;
            }else{
                result.groundCount++;
            }
            if(unit.boss){
                result.bossCount++;
                if(!result.bossNames.contains(unit.name)){
                    result.bossNames.add(unit.name);
                }
            }

            CoreInfo core = nearestCore(unit, cores);

            // Every enemy unit is drawn on the mini map, even when the player has no core.
            Blip blip = new Blip(unit.x, unit.y, Float.MAX_VALUE,
                    unit.boss ? KIND_BOSS : (unit.flying ? KIND_FLYING : KIND_GROUND));
            result.blips.add(blip);
            if(core == null) continue;

            float dx = core.x - unit.x;
            float dy = core.y - unit.y;
            float dist = (float)Math.sqrt(dx * dx + dy * dy);
            if(dist <= CLOSE_DISTANCE){
                result.closeThreats++;
            }

            float speed = unit.speed;
            float towards = speed > MIN_SPEED ? (unit.vx * dx + unit.vy * dy) / (speed * dist + 0.001f) : 0f;
            boolean direct = towards > TOWARDS_CORE_DOT;
            if(direct){
                result.threats++;
            }

            Arrival arrival = predictArrival(unit, dist, direct);
            blip.eta = arrival.eta;
            if(arrival.eta < closest){
                closest = arrival.eta;
                closestArrival = arrival;
            }
            if(direct && arrival.eta < result.directEta){
                result.directEta = arrival.eta;
                closestDirect = arrival;
            }

            if(arrival.eta <= horizon){
                result.incoming++;
                result.incomingDps += unit.dps;
            }
        }

        if(closestArrival != null){
            result.eta = closestArrival.eta;
            result.etaLow = closestArrival.low;
            result.etaHigh = closestArrival.high;
            result.etaDirect = closestArrival.direct;
        }
        if(closestDirect != null){
            result.directEtaLow = closestDirect.low;
            result.directEtaHigh = closestDirect.high;
        }

        // How long the weakest core survives if the attack keeps coming.
        // The turrets shoot back, so only the difference matters.
        float netDps = result.incomingDps - defenseDps;
        if(netDps > 0f && coreHealth > 0f){
            result.coreDeath = coreHealth / netDps;
        }

        if(hasPower){
            result.powerDeficit = powerNet < -5f;
            result.blackout = (result.powerDeficit && battery <= 1f) || (powerNet < -30f && battery < 10f);
        }

        return result;
    }

    /** Nearest core to a unit, or null when the player has no core. */
    public static CoreInfo nearestCore(UnitInfo unit, Seq<CoreInfo> cores){
        if(cores == null || cores.size == 0) return null;
        CoreInfo nearest = null;
        float best = Float.MAX_VALUE;
        for(CoreInfo core : cores){
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

    /** Formats the panel text. */
    public static String format(boolean inGame, Prediction p){
        if(!inGame || p == null){
            return "[gold]РАДАР КАМПАНИИ[]\n[gray]Неактивен вне игры[]";
        }

        StringBuilder text = new StringBuilder();
        text.append("[gold]РАДАР КАМПАНИИ[] [lightgray]v1.3[]\n");

        // Enemy counts
        text.append("[white]Враги:[accent] ").append(p.count).append("[]");
        if(p.count > 0){
            text.append(" [lightgray](🚜").append(p.groundCount).append(" 🛸").append(p.flyingCount).append(")[]");
            if(p.bossCount > 0){
                text.append(" [scarlet]💀").append(p.bossCount).append("[]");
            }
        }
        text.append('\n');

        // Threat and time to contact
        if(p.threats > 0 && p.directEta < Float.MAX_VALUE){
            text.append("[scarlet]⚠️ ПРОРЫВ: ").append(p.threats).append(" к ядру · ETA ")
                    .append(etaSeconds(p.directEtaLow)).append("–").append(etaSeconds(p.directEtaHigh)).append("с[]\n");
        }else if(p.closeThreats > 0){
            text.append("[crimson]🚨 Враг рядом с ядром![]\n");
        }else if(p.count > 0 && p.eta < Float.MAX_VALUE){
            text.append("[orange]🟠 Враги в обход · ETA ")
                    .append(etaSeconds(p.etaLow)).append("–").append(etaSeconds(p.etaHigh)).append("с[]\n");
        }else if(p.count == 0){
            text.append("[lightgray]Вражеских юнитов нет[]\n");
        }

        // Forecast: what is going to happen in the next minutes
        if(p.incoming > 0){
            text.append("[lightgray]🔮 За ").append((int)HORIZON_SECONDS).append(" с: ")
                    .append(p.incoming).append(" врага у ядра · урон ~").append((int)p.incomingDps).append("/с[]\n");
        }
        if(p.coreDeath < Float.MAX_VALUE){
            text.append("[crimson]💥 Ядро (").append((int)p.coreHealth).append(" HP) падёт через ~")
                    .append((int)p.coreDeath).append("с[]\n");
        }
        if(p.defenseDps > 0f){
            boolean holds = p.incomingDps <= 0f || p.defenseDps >= p.incomingDps;
            text.append(holds ? "[green]🛡 Оборона ~" : "[orange]🛡 Оборона ~")
                    .append((int)p.defenseDps).append("/с — ")
                    .append(holds ? "шанс отбить высокий" : "может не удержать")
                    .append("[]\n");
        }

        // Bosses
        if(p.bossCount > 0 && p.bossNames.size > 0){
            text.append("[scarlet]💀 БОСС: ").append(p.bossNames.toString(", ")).append("[]\n");
        }

        // Core health
        if(p.minCoreHp < 99f){
            int hp = (int)p.minCoreHp;
            if(hp <= 35){
                text.append("[crimson]🚨 КРИТИЧЕСКИЙ УРОН ЯДРУ: ").append(hp).append("%![]\n");
            }else{
                text.append("[coral]⚠️ ЯДРО ПОВРЕЖДЕНО: ").append(hp).append("%[]\n");
            }
        }

        // Power
        if(p.blackout){
            text.append("[scarlet]⚡ СЕТЬ ОБЕСТОЧЕНА: ").append((int)p.powerNet).append("/с[]\n");
        }else if(p.powerDeficit){
            text.append("[coral]⚡ ДЕФИЦИТ ЭНЕРГИИ: ").append((int)p.powerNet).append("/с (АКБ: ")
                    .append((int)p.battery).append("%)[]\n");
        }

        // Turrets and damaged buildings
        if(p.emptyTurrets > 0){
            text.append("[yellow]📦 Турели без патронов: ").append(p.emptyTurrets).append(" шт.[]\n");
        }
        if(p.damagedBuildings >= 3){
            text.append("[yellow]🛠️ Повреждения базы: ").append(p.damagedBuildings).append(" построек[]\n");
        }

        // Everything is fine
        boolean hasAlerts = p.threats > 0 || p.closeThreats > 0 || p.bossCount > 0 || p.incoming > 0 ||
                p.minCoreHp < 99f || p.powerDeficit || p.emptyTurrets > 0 || p.damagedBuildings >= 3;
        if(!hasAlerts && p.count == 0){
            text.append("[green]✅ Все системы стабильны[]");
        }

        // Remove trailing newline if any
        if(text.charAt(text.length() - 1) == '\n'){
            text.setLength(text.length() - 1);
        }

        return text.toString();
    }

    /** Converts ticks into whole seconds, never below one. */
    public static int etaSeconds(float etaTicks){
        return Math.max(1, (int)(etaTicks / 60f));
    }
}
