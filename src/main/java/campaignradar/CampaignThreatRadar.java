package campaignradar;

import arc.Core;
import arc.Events;
import arc.graphics.Color;
import arc.math.Mathf;
import arc.scene.event.Touchable;
import arc.scene.ui.Label;
import arc.scene.ui.layout.Scl;
import arc.scene.ui.layout.Table;
import arc.struct.ObjectIntMap;
import arc.struct.Seq;
import arc.util.Time;
import mindustry.Vars;
import mindustry.content.StatusEffects;
import mindustry.game.EventType.ClientLoadEvent;
import mindustry.game.SpawnGroup;
import mindustry.game.Team;
import mindustry.game.Teams.TeamData;
import mindustry.gen.Building;
import mindustry.gen.Groups;
import mindustry.gen.Unit;
import mindustry.mod.Mod;
import mindustry.ui.Styles;
import mindustry.world.blocks.defense.turrets.Turret;
import mindustry.world.blocks.defense.turrets.Turret.TurretBuild;
import mindustry.world.blocks.power.PowerGraph;
import mindustry.world.Tile;
import mindustry.world.blocks.storage.CoreBlock.CoreBuild;
import mindustry.world.meta.BlockGroup;

/**
 * A HUD-only campaign and singleplayer tactical radar for Mindustry v8 (builds 154 and newer).
 * Positioned at top-right, to the left of the vanilla minimap, and made of:
 * <ul>
 *     <li>a text panel with enemy counts, threat ETAs, base diagnostics and forecasts,</li>
 *     <li>a small tactical whole-map view with every core, spawn, enemy and weak defence sector.</li>
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
    /** Legacy/local fallback radius when the world size is unknown, in tiles. */
    public static final float RADAR_RANGE_TILES = 120f;
    /** Distance from a core where an approaching wave should meet the defence, in tiles. */
    public static final float DEFENSE_RING_TILES = 26f;
    /** Maximum number of "improve defence here" markers. */
    public static final int WEAK_POINT_MAX = 3;
    /** How far ahead the forecast looks, in seconds. */
    public static final float HORIZON_SECONDS = 60f;
    /** How many future waves the survival forecast simulates. */
    public static final int WAVE_FORECAST_MAX = 100;
    /** Share of the nominal turret/unit DPS that is really on target. */
    public static final float DEFENSE_EFFICIENCY = 0.55f;
    /** Share of the nominal enemy DPS that is really firing at the base at once. */
    public static final float ENEMY_ENGAGEMENT = 0.35f;
    /** Average enemy DPS during a battle, as a share of the starting DPS (units die off). */
    public static final float BATTLE_ATTRITION = 0.6f;
    /** Share of air damage that bypasses the front line and hits the core directly. */
    public static final float AIR_TO_CORE = 0.3f;
    /** Share of the missing front-line HP repaired between two waves. */
    public static final float REPAIR_FRACTION = 0.25f;

    /** Blip kind: ground unit. */
    public static final int KIND_GROUND = 0;
    /** Blip kind: flying unit. */
    public static final int KIND_FLYING = 1;
    /** Blip kind: boss. */
    public static final int KIND_BOSS = 2;
    /** Blip kind: player core. */
    public static final int KIND_CORE = 3;

    /** Weak-point kind: not enough anti-ground damage. */
    public static final int MARKER_GROUND = 0;
    /** Weak-point kind: not enough anti-air damage. */
    public static final int MARKER_AIR = 1;
    /** Weak-point kind: not enough wall HP in front of the turrets. */
    public static final int MARKER_WALL = 2;
    /** Weak-point kind: a nearby turret has no ammo. */
    public static final int MARKER_SUPPLY = 3;
    /** Weak-point kind: front-line buildings are badly damaged. */
    public static final int MARKER_REPAIR = 4;

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
        return "[lightgray]◆[accent] ядро  [lightgray]✚[yellow] усилить  [lightgray]□[scarlet] спавн  [lightgray]●[scarlet] враг  [lightgray]●[orange] авиация  [lightgray]◉[scarlet] босс[]";
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

        BaseInfo base = new BaseInfo();

        // Enemy units, plus the player's own combat units (they defend too)
        for(Unit unit : Groups.unit){
            if(unit == null || unit.dead || !unit.isAdded()) continue;
            // isFlying() is true while a unit is airborne, so the type is the reliable source here.
            boolean flying = unit.type != null ? unit.type.flying : unit.isFlying();

            if(unit.team == playerTeam){
                base.ownCount++;
                if(flying) base.ownFlying++; else base.ownGround++;
                base.allyDps += unit.type != null ? unit.type.estimateDps() : 0f;
                continue;
            }
            if(unit.team != enemy) continue;

            UnitInfo info = new UnitInfo();
            info.x = unit.x;
            info.y = unit.y;
            info.vx = unit.vel != null ? unit.vel.x : 0f;
            info.vy = unit.vel != null ? unit.vel.y : 0f;
            info.speed = unit.vel != null ? unit.vel.len() : 0f;
            info.maxSpeed = unit.type != null ? unit.type.speed : 0f;
            info.accel = unit.type != null ? unit.type.accel : 0.5f;
            info.dps = unit.type != null ? unit.type.estimateDps() : 0f;
            // Remaining strength: hull HP plus whatever shield is left.
            info.hp = unit.health + Math.max(0f, unit.shield);
            info.boss = unit.isBoss();
            info.flying = flying;
            info.name = unit.type != null ? unit.type.localizedName : "Босс";
            units.add(info);
        }

        // Turrets, damaged buildings, the estimated defensive DPS (split by what
        // the turrets can actually target) and the HP of the front line itself.
        if(teamData != null && teamData.buildings != null){
            for(Building bld : teamData.buildings){
                if(bld == null || !bld.isValid()) continue;
                base.buildingCount++;
                if(bld.health < bld.maxHealth * 0.5f){
                    base.damagedBuildings++;
                }
                boolean isTurret = bld instanceof TurretBuild;
                boolean isWall = bld.block != null && bld.block.group == BlockGroup.walls;
                // The front line that soaks up wave damage: turrets and walls.
                if(isTurret || isWall){
                    base.defenseHp += bld.health;
                    base.defenseMaxHp += bld.maxHealth;
                }
                if(isWall){
                    WallInfo wall = new WallInfo();
                    wall.x = bld.x;
                    wall.y = bld.y;
                    wall.health = bld.health;
                    wall.maxHealth = bld.maxHealth;
                    base.walls.add(wall);
                }
                if(bld instanceof TurretBuild tb){
                    base.turretCount++;
                    boolean hasAmmo = tb.hasAmmo();
                    if(!hasAmmo) base.emptyTurrets++;

                    float turretDps = hasAmmo ? tb.estimateDps() : 0f;
                    boolean targetsGround = true, targetsAir = true;
                    if(bld.block instanceof Turret turretBlock){
                        targetsGround = turretBlock.targetGround;
                        targetsAir = turretBlock.targetAir;
                    }
                    if(hasAmmo){
                        base.defenseDps += turretDps;
                        if(targetsGround && targetsAir) base.sharedDps += turretDps;
                        else if(targetsGround) base.groundDps += turretDps;
                        else if(targetsAir) base.airDps += turretDps;
                        else base.sharedDps += turretDps;
                    }

                    TurretInfo turret = new TurretInfo();
                    turret.x = bld.x;
                    turret.y = bld.y;
                    turret.dps = turretDps;
                    turret.range = tb.range();
                    turret.targetsGround = targetsGround;
                    turret.targetsAir = targetsAir;
                    turret.hasAmmo = hasAmmo;
                    turret.health = bld.health;
                    turret.maxHealth = bld.maxHealth;
                    base.defenders.add(turret);
                }
            }
        }

        // Power network diagnostics
        if(mainCore != null && mainCore.power != null && mainCore.power.graph != null){
            base.hasPower = true;
            PowerGraph graph = mainCore.power.graph;
            base.powerNet = graph.getPowerBalance() * 60f;
            float batStored = graph.getBatteryStored();
            float batCap = graph.getBatteryCapacity();
            base.battery = batCap > 0f ? (batStored / batCap) * 100f : 100f;
            // How long the batteries can cover the current deficit.
            base.batterySeconds = base.powerNet < 0f && batStored > 0f
                    ? batStored / Math.abs(base.powerNet) : Float.MAX_VALUE;
        }

        // Items stored in the (main) core
        if(mainCore instanceof CoreBuild coreBuild && coreBuild.items != null){
            base.coreItems = coreBuild.items.total();
        }

        // The game's own session statistics
        if(Vars.state.stats != null){
            base.hasStats = true;
            base.kills = Vars.state.stats.enemyUnitsDestroyed;
            base.built = Vars.state.stats.buildingsBuilt;
            base.destroyed = Vars.state.stats.buildingsDestroyed;
            base.unitsCreated = Vars.state.stats.unitsCreated;
        }

        Prediction prediction = compute(units, cores, base, buildWaveInfo(enemy), HORIZON_SECONDS);

        status.setText(format(true, prediction));
        updateRadar(prediction, cores);
    }

    /**
     * Builds the loads of the coming waves from the real spawn rules.
     * <p>
     * Mirrors {@code WaveSpawner.spawnEnemies()} in v160.7: the next spawn uses
     * the spawn index {@code state.wave - 1}, campaign difficulty multiplies the
     * amount (bosses are rounded down), unit HP is scaled by the rules
     * multipliers and the per-wave shield is added. Wave labels are
     * {@code spawnIndex + 2}, which is the number the in-game wave counter (and
     * the game-over statistics) shows while that wave is being fought, so the
     * last needed wave is {@code winWave}.
     */
    private WaveInfo buildWaveInfo(Team enemy){
        WaveInfo info = new WaveInfo();
        if(Vars.state.rules == null) return info;

        info.waves = Vars.state.rules.waves;
        info.wave = Vars.state.wave;
        info.winWave = Vars.state.rules.winWave;
        info.waveTimeSec = Vars.state.rules.waveTimer ? Math.max(0f, Vars.state.wavetime / 60f) : -1f;
        info.inProgress = Vars.state.enemies > 0;
        if(Vars.world != null){
            info.mapWidthTiles = Vars.world.width();
            info.mapHeightTiles = Vars.world.height();
        }
        if(Vars.spawner != null && Vars.spawner.getSpawns() != null){
            for(Tile spawn : Vars.spawner.getSpawns()){
                if(spawn != null) info.spawns.add(new PointInfo(spawn.worldx(), spawn.worldy()));
            }
        }
        if(!info.waves || Vars.state.rules.spawns == null || Vars.state.rules.spawns.size == 0 || info.wave <= 0){
            return info;
        }

        boolean campaign = Vars.state.isCampaign();
        float spawnMult = 1f;
        if(campaign && Vars.state.getPlanet() != null){
            spawnMult = Vars.state.getPlanet().campaignRules.difficulty.enemySpawnMultiplier;
        }
        float healthMult = Vars.state.rules.unitHealth(enemy);
        float damageMult = Vars.state.rules.unitDamage(enemy);

        int lastLabel = info.wave + WAVE_FORECAST_MAX;
        if(info.winWave > 0) lastLabel = Math.min(lastLabel, info.winWave);

        for(int label = info.wave + 1; label <= lastLabel; label++){
            int index = label - 2;
            WaveLoad load = new WaveLoad();
            load.wave = label;
            Seq<String> compNames = new Seq<>();
            ObjectIntMap<String> compCounts = new ObjectIntMap<>();

            for(SpawnGroup group : Vars.state.rules.spawns){
                if(group == null || group.type == null) continue;
                int amount = group.getSpawned(index);
                if(amount <= 0) continue;

                boolean boss = group.effect == StatusEffects.boss;
                if(campaign && spawnMult != 1f){
                    amount = Math.max(1, boss ? (int)(amount * spawnMult) : Mathf.round(amount * spawnMult));
                }

                float perHp = group.type.health * healthMult + Math.max(0f, group.getShield(index));
                float perDps = group.type.estimateDps() * damageMult;

                load.count += amount;
                load.totalHp += perHp * amount;
                load.totalDps += perDps * amount;
                if(group.type.flying){
                    load.flyingCount += amount;
                    load.flyingHp += perHp * amount;
                    load.flyingDps += perDps * amount;
                }else{
                    load.groundCount += amount;
                    load.groundHp += perHp * amount;
                    load.groundDps += perDps * amount;
                }
                if(boss){
                    load.bossCount += amount;
                    load.bossHp += perHp * amount;
                }

                String unitName = group.type.localizedName != null ? group.type.localizedName : group.type.name;
                if(!compNames.contains(unitName)) compNames.add(unitName);
                compCounts.increment(unitName, amount);
            }

            // The three most numerous unit types of the wave, biggest first.
            StringBuilder comp = new StringBuilder();
            boolean[] picked = new boolean[compNames.size];
            for(int pick = 0; pick < 3; pick++){
                int bestAt = -1;
                int bestCount = -1;
                for(int i = 0; i < compNames.size; i++){
                    if(picked[i]) continue;
                    int count = compCounts.get(compNames.get(i), 0);
                    if(count > bestCount){
                        bestCount = count;
                        bestAt = i;
                    }
                }
                if(bestAt < 0) break;
                picked[bestAt] = true;
                if(comp.length() > 0) comp.append(", ");
                comp.append(bestCount).append("×").append(compNames.get(bestAt));
            }
            load.composition = comp.toString();

            info.future.add(load);
        }
        return info;
    }

    /** Feeds the whole-map mini map with the freshly computed data. */
    private void updateRadar(Prediction prediction, Seq<CoreInfo> cores){
        if(radar == null) return;
        radar.clear();

        if(prediction.spawns != null) radar.spawns.addAll(prediction.spawns);
        if(prediction.weakPoints != null) radar.weakPoints.addAll(prediction.weakPoints);

        // The weakest core (by HP fraction) is highlighted; the map itself no
        // longer follows it, because the whole world is always visible.
        CoreInfo weakest = null;
        float weakestFrac = Float.MAX_VALUE;
        for(CoreInfo core : cores){
            float frac = core.maxHealth > 0f ? core.health / core.maxHealth : 1f;
            if(weakest == null || frac < weakestFrac){
                weakest = core;
                weakestFrac = frac;
            }
        }
        for(CoreInfo core : cores){
            Blip blip = new Blip(core.x, core.y, 0f, KIND_CORE);
            blip.healthFrac = core.maxHealth > 0f ? core.health / core.maxHealth : 1f;
            blip.weakest = core == weakest;
            radar.cores.add(blip);
        }
        for(Blip blip : prediction.blips){
            radar.blips.add(blip);
        }

        float playerX = 0f, playerY = 0f;
        boolean hasPlayer = Vars.player != null && Vars.player.unit() != null;
        if(hasPlayer){
            playerX = Vars.player.unit().x;
            playerY = Vars.player.unit().y;
            radar.playerX = playerX;
            radar.playerY = playerY;
            radar.hasPlayer = true;
        }

        // Whole world first. If its size is unavailable, fall back to a padded
        // bounding box around every known object so distant cores still show.
        if(prediction.mapWidthTiles > 0 && prediction.mapHeightTiles > 0){
            radar.mapOffsetX = 0f;
            radar.mapOffsetY = 0f;
            radar.mapWidth = prediction.mapWidthTiles * TILE_SIZE;
            radar.mapHeight = prediction.mapHeightTiles * TILE_SIZE;
        }else{
            float[] bounds = {Float.MAX_VALUE, Float.MAX_VALUE, -Float.MAX_VALUE, -Float.MAX_VALUE};
            for(Blip core : radar.cores) includePoint(bounds, core.x, core.y);
            for(Blip blip : radar.blips) includePoint(bounds, blip.x, blip.y);
            for(PointInfo spawn : radar.spawns) includePoint(bounds, spawn.x, spawn.y);
            for(WeakPoint marker : radar.weakPoints) includePoint(bounds, marker.x, marker.y);
            if(hasPlayer) includePoint(bounds, playerX, playerY);
            if(bounds[0] == Float.MAX_VALUE){
                bounds[0] = -RADAR_RANGE_TILES * TILE_SIZE;
                bounds[1] = -RADAR_RANGE_TILES * TILE_SIZE;
                bounds[2] = RADAR_RANGE_TILES * TILE_SIZE;
                bounds[3] = RADAR_RANGE_TILES * TILE_SIZE;
            }
            float pad = 40f * TILE_SIZE;
            radar.mapOffsetX = bounds[0] - pad;
            radar.mapOffsetY = bounds[1] - pad;
            radar.mapWidth = Math.max(TILE_SIZE, bounds[2] - bounds[0] + pad * 2f);
            radar.mapHeight = Math.max(TILE_SIZE, bounds[3] - bounds[1] + pad * 2f);
        }

        // Draw the attack line from the core this enemy is actually approaching.
        Blip closest = null;
        for(Blip blip : prediction.blips){
            if(closest == null || blip.eta < closest.eta) closest = blip;
        }
        if(closest != null && closest.eta < Float.MAX_VALUE){
            CoreInfo targetCore = nearestCoreAt(closest.x, closest.y, cores);
            if(targetCore != null){
                radar.threatX = closest.x;
                radar.threatY = closest.y;
                radar.threatCoreX = targetCore.x;
                radar.threatCoreY = targetCore.y;
                radar.hasThreat = true;
            }
        }
    }

    private static void includePoint(float[] bounds, float x, float y){
        if(!Float.isFinite(x) || !Float.isFinite(y)) return;
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x);
        bounds[3] = Math.max(bounds[3], y);
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
        /** Remaining strength of the unit: hull HP plus shield. */
        public float hp;
        public boolean flying, boss;
        public String name = "";
    }

    /** Snapshot of the player base: defences, power, storage and session statistics. */
    public static class BaseInfo{
        public int emptyTurrets, damagedBuildings, turretCount, buildingCount;
        /** DPS of all turrets with ammo, every turret counted once. */
        public float defenseDps;
        /** Turret DPS split by target flags: ground only, air only, both. */
        public float groundDps, airDps, sharedDps;
        /** Combined DPS of the player's own units. */
        public float allyDps;
        public int ownCount, ownGround, ownFlying;
        /** Current / maximum HP of the front line (turrets + walls). */
        public float defenseHp, defenseMaxHp;
        /** Positional snapshots used to find weak defence sectors. */
        public Seq<TurretInfo> defenders = new Seq<>();
        public Seq<WallInfo> walls = new Seq<>();
        /** Items stored in the main core, -1 when unknown. */
        public int coreItems = -1;
        public float powerNet, battery = 100f, batterySeconds = Float.MAX_VALUE;
        public boolean hasPower;
        /** The game's own GameStats counters. */
        public boolean hasStats;
        public int kills, built, destroyed, unitsCreated;
    }

    /** Snapshot of one turret for positional defence coverage checks. */
    public static class TurretInfo{
        public float x, y, dps, range, health, maxHealth;
        public boolean targetsGround, targetsAir, hasAmmo;
    }

    /** Snapshot of one wall block. */
    public static class WallInfo{
        public float x, y, health, maxHealth;
    }

    /** A plain world-space point (a wave spawn point). */
    public static class PointInfo{
        public float x, y;

        public PointInfo(){
        }

        public PointInfo(float x, float y){
            this.x = x;
            this.y = y;
        }
    }

    /** A place where the defence should be improved. */
    public static class WeakPoint{
        public float x, y, coreX, coreY;
        /** One of the MARKER_* constants. */
        public int kind;
        /** Relative severity from 0 (barely worth marking) to 1 (wide open). */
        public float severity;
        /** Compass direction of the marker seen from its core, in Russian. */
        public String direction = "";
        public float groundDps, airDps, wallHp, healthPct = 100f;
        public int wallCount, turretCount, tileX, tileY;
    }

    /** One simulated wave, built from the spawn rules before the wave exists. */
    public static class WaveLoad{
        /** Wave number as the in-game counter shows it while the wave is fought. */
        public int wave;
        public int count, groundCount, flyingCount, bossCount;
        public float totalHp, totalDps, groundHp, flyingHp, groundDps, flyingDps, bossHp;
        /** The most numerous unit types, e.g. "6×Dagger, 3×Flare". */
        public String composition = "";
    }

    /** Wave state of the current game plus the loads of the coming waves. */
    public static class WaveInfo{
        public boolean waves, inProgress;
        /** Current value of the in-game wave counter. */
        public int wave;
        /** Seconds until the next wave spawns, -1 when waves are sent manually. */
        public float waveTimeSec = -1f;
        /** Wave at which the game is won, 0 when the waves are endless. */
        public int winWave;
        /** Whole-map radar bounds in tiles; 0 when unknown. */
        public int mapWidthTiles, mapHeightTiles;
        /** Real wave spawn points in world units. */
        public Seq<PointInfo> spawns = new Seq<>();
        public Seq<WaveLoad> future = new Seq<>();
    }

    /** Result of the wave survival simulation. */
    public static class WaveForecast{
        public boolean available, cappedByWin, cappedByHorizon;
        /** Wave on which the base falls, 0 when it survives everything simulated. */
        public int fallWave, lastSafeWave, wavesLeft;
        /** Why the base falls: ground, air, boss, no-ground, no-air or no-defense. */
        public String reason = "";
        public int nextBossWave, nextBossIn;
        /** Expected damage of the next battle as a share of front line + core HP. */
        public float nextLoadRatio;
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
        /** Core HP fraction and highlight flag; only used for KIND_CORE blips. */
        public float healthFrac = 1f;
        public boolean weakest;

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
        /** Combined remaining HP / DPS of every enemy currently on the map. */
        public float totalEnemyHp, totalEnemyDps;
        /** Distance of the closest enemy to its nearest core, in tiles. */
        public float nearestTiles = Float.MAX_VALUE;
        /** Turret DPS that can hit ground / air targets (dual turrets in both). */
        public float defenseGroundDps, defenseAirDps, defenseSharedDps, allyDps;
        public int turretCount, buildingCount, ownCount, ownGround, ownFlying;
        public float defenseHp, defenseMaxHp;
        public int coreItems = -1;
        public boolean hasStats;
        public int kills, built, destroyed, unitsCreated;
        public boolean hasWaves, waveInProgress;
        public int wave, winWave;
        public float waveTimeSec = -1f;
        /** First coming wave that actually spawns something, null when none is known. */
        public WaveLoad nextWave;
        public WaveForecast forecast = new WaveForecast();
        /** Whole-map bounds, wave spawn points and weak defence sectors. */
        public int mapWidthTiles, mapHeightTiles;
        public Seq<PointInfo> spawns = new Seq<>();
        public Seq<WeakPoint> weakPoints = new Seq<>();
        public float powerNet, battery, batterySeconds = Float.MAX_VALUE;
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

    /** Runs the whole analysis: counts, ETAs, forecasts, wave survival and diagnostics. */
    public static Prediction compute(Seq<UnitInfo> units, Seq<CoreInfo> cores, BaseInfo base, WaveInfo wave, float horizonSeconds){
        if(base == null) base = new BaseInfo();
        if(wave == null) wave = new WaveInfo();
        Prediction result = new Prediction();
        result.emptyTurrets = base.emptyTurrets;
        result.damagedBuildings = base.damagedBuildings;
        result.turretCount = base.turretCount;
        result.buildingCount = base.buildingCount;
        result.defenseDps = base.defenseDps;
        result.defenseGroundDps = base.groundDps;
        result.defenseAirDps = base.airDps;
        result.defenseSharedDps = base.sharedDps;
        result.allyDps = base.allyDps;
        result.ownCount = base.ownCount;
        result.ownGround = base.ownGround;
        result.ownFlying = base.ownFlying;
        result.defenseHp = base.defenseHp;
        result.defenseMaxHp = base.defenseMaxHp;
        result.coreItems = base.coreItems;
        result.hasStats = base.hasStats;
        result.kills = base.kills;
        result.built = base.built;
        result.destroyed = base.destroyed;
        result.unitsCreated = base.unitsCreated;
        result.hasWaves = wave.waves;
        result.wave = wave.wave;
        result.winWave = wave.winWave;
        result.waveTimeSec = wave.waveTimeSec;
        result.waveInProgress = wave.inProgress;
        result.mapWidthTiles = wave.mapWidthTiles;
        result.mapHeightTiles = wave.mapHeightTiles;
        result.spawns = wave.spawns != null ? wave.spawns : new Seq<>();
        result.hasPower = base.hasPower;
        result.powerNet = base.powerNet;
        result.battery = base.battery;
        result.batterySeconds = base.batterySeconds;

        float horizon = horizonSeconds * 60f;
        float closest = Float.MAX_VALUE;
        Arrival closestArrival = null;
        Arrival closestDirect = null;
        // Remaining strength of the enemies already on the map (the "current wave" load).
        float curGroundHp = 0f, curFlyingHp = 0f, curGroundDps = 0f, curFlyingDps = 0f, curBossHp = 0f;

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

            result.totalEnemyHp += unit.hp;
            result.totalEnemyDps += unit.dps;
            if(unit.flying){
                result.flyingCount++;
                curFlyingHp += unit.hp;
                curFlyingDps += unit.dps;
            }else{
                result.groundCount++;
                curGroundHp += unit.hp;
                curGroundDps += unit.dps;
            }
            if(unit.boss) curBossHp += unit.hp;

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
            if(dist / TILE_SIZE < result.nearestTiles){
                result.nearestTiles = dist / TILE_SIZE;
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
        float netDps = result.incomingDps - base.defenseDps;
        if(netDps > 0f && coreHealth > 0f){
            result.coreDeath = coreHealth / netDps;
        }

        if(base.hasPower){
            result.powerDeficit = base.powerNet < -5f;
            result.blackout = (result.powerDeficit && base.battery <= 1f) || (base.powerNet < -30f && base.battery < 10f);
        }

        // Wave survival forecast: the enemies already on the map plus every future
        // wave from the real spawn rules, simulated against the current defence.
        float splitGround = base.groundDps;
        float splitAir = base.airDps;
        float splitShared = base.sharedDps;
        if(splitGround + splitAir + splitShared <= 0f && base.defenseDps > 0f){
            // No targeting split was provided: treat the total as flexible DPS.
            splitShared = base.defenseDps;
        }
        WaveLoad currentLoad = null;
        if(result.count > 0){
            currentLoad = new WaveLoad();
            currentLoad.wave = result.wave;
            currentLoad.count = result.count;
            currentLoad.groundCount = result.groundCount;
            currentLoad.flyingCount = result.flyingCount;
            currentLoad.bossCount = result.bossCount;
            currentLoad.groundHp = curGroundHp;
            currentLoad.flyingHp = curFlyingHp;
            currentLoad.groundDps = curGroundDps;
            currentLoad.flyingDps = curFlyingDps;
            currentLoad.totalHp = result.totalEnemyHp;
            currentLoad.totalDps = result.totalEnemyDps;
            currentLoad.bossHp = curBossHp;
        }
        // Starved power turrets do not fire at full strength.
        float powerFactor = result.blackout ? 0.45f : (result.powerDeficit ? 0.8f : 1f);
        result.forecast = forecastWaves(wave.future, currentLoad, result.wave, coreHealth,
                base.defenseHp, base.defenseMaxHp, splitGround, splitAir, splitShared, base.allyDps,
                powerFactor, result.winWave);
        if(wave.future != null){
            for(WaveLoad load : wave.future){
                if(load != null && load.count > 0){
                    result.nextWave = load;
                    break;
                }
            }
        }

        result.weakPoints = computeWeakPoints(cores, base.defenders, base.walls, result.spawns, wave.future,
                curGroundDps, curFlyingDps, result.mapWidthTiles, result.mapHeightTiles);

        return result;
    }

    /**
     * Simulates the coming waves against the current defence and estimates how
     * many more waves the base survives.
     * <p>
     * The model is deliberately simple and conservative: the defence kills a
     * layer (ground or air) in {@code hp / effectiveDps} seconds, only a share
     * of the nominal DPS ever is on target ({@link #DEFENSE_EFFICIENCY}) and
     * turrets that can hit both layers are split between them by HP share.
     * While a layer is being killed it damages the front line (turrets + walls
     * HP pool); air units partly bypass it ({@link #AIR_TO_CORE}). Front-line
     * losses reduce the turret DPS of the following waves, and a part of the
     * damage is repaired between waves ({@link #REPAIR_FRACTION}).
     */
    public static WaveForecast forecastWaves(Seq<WaveLoad> future, WaveLoad currentLoad, int currentWave,
                                             float coreHealth, float defenseHp, float defenseMaxHp,
                                             float groundDps, float airDps, float sharedDps, float allyDps,
                                             float powerFactor, int winWave){
        WaveForecast result = new WaveForecast();
        result.lastSafeWave = currentWave;

        boolean hasCurrent = currentLoad != null && currentLoad.count > 0;
        if((future == null || future.size == 0) && !hasCurrent) return result;
        if(coreHealth <= 0f) return result;
        result.available = true;

        if(future != null){
            for(WaveLoad load : future){
                if(load != null && load.bossCount > 0){
                    result.nextBossWave = load.wave;
                    result.nextBossIn = load.wave - currentWave;
                    break;
                }
            }
        }

        Seq<WaveLoad> sequence = new Seq<>();
        Seq<Boolean> isFuture = new Seq<>();
        if(hasCurrent){
            sequence.add(currentLoad);
            isFuture.add(false);
        }
        if(future != null){
            for(WaveLoad load : future){
                if(load == null) continue;
                sequence.add(load);
                isFuture.add(true);
            }
        }

        float poolMax = Math.max(defenseMaxHp, defenseHp);
        float initialPool = defenseHp;
        float pool = initialPool;
        float core = coreHealth;
        float totalDefense = groundDps + airDps + sharedDps + allyDps;
        int survivedFuture = 0;

        for(int s = 0; s < sequence.size; s++){
            WaveLoad load = sequence.get(s);

            if(load.count <= 0 || load.totalHp <= 0f || load.totalDps <= 0f){
                // An empty wave (or unarmed units): survived, and there is time to repair.
                pool += (poolMax - pool) * REPAIR_FRACTION;
                if(isFuture.get(s)){
                    survivedFuture++;
                    result.lastSafeWave = load.wave;
                }
                continue;
            }

            float shareGround = load.totalHp > 0f ? load.groundHp / load.totalHp : 0f;
            float turretScale = initialPool > 0f ? Math.max(0f, Math.min(1f, pool / initialPool)) : 1f;
            float effGround = ((groundDps + sharedDps * shareGround) * turretScale
                    + allyDps * shareGround) * DEFENSE_EFFICIENCY * powerFactor;
            float effAir = ((airDps + sharedDps * (1f - shareGround)) * turretScale
                    + allyDps * (1f - shareGround)) * DEFENSE_EFFICIENCY * powerFactor;

            String reason = "";
            if(totalDefense <= 0f){
                reason = "no-defense";
            }else if(load.groundHp > 0f && load.groundDps > 0f && effGround <= 0f){
                reason = "no-ground";
            }else if(load.flyingHp > 0f && load.flyingDps > 0f && effAir <= 0f){
                reason = "no-air";
            }

            float groundDamage = 0f;
            float airDamage = 0f;
            if(reason.isEmpty()){
                if(load.groundHp > 0f && effGround > 0f){
                    groundDamage = load.groundDps * ENEMY_ENGAGEMENT * BATTLE_ATTRITION * (load.groundHp / effGround);
                }
                if(load.flyingHp > 0f && effAir > 0f){
                    airDamage = load.flyingDps * ENEMY_ENGAGEMENT * BATTLE_ATTRITION * (load.flyingHp / effAir);
                }
            }

            if(result.nextLoadRatio == 0f && pool + core > 0f){
                result.nextLoadRatio = reason.isEmpty() ? (groundDamage + airDamage) / (pool + core) : Float.MAX_VALUE;
            }

            if(reason.isEmpty()){
                // Ground damage is soaked up by the front line first, the rest reaches the core.
                float absorbed = Math.min(pool, groundDamage);
                pool -= absorbed;
                core -= groundDamage - absorbed;
                // Air units partly fly over the front line.
                core -= airDamage * AIR_TO_CORE;
                float airRest = airDamage * (1f - AIR_TO_CORE);
                absorbed = Math.min(pool, airRest);
                pool -= absorbed;
                core -= airRest - absorbed;

                if(core <= 0f){
                    reason = load.bossHp > 0f && load.bossHp >= load.totalHp * 0.5f
                            ? "boss" : (airDamage > groundDamage ? "air" : "ground");
                }
            }

            if(!reason.isEmpty()){
                result.fallWave = load.wave;
                result.reason = reason;
                result.wavesLeft = survivedFuture;
                return result;
            }

            if(isFuture.get(s)){
                survivedFuture++;
                result.lastSafeWave = load.wave;
            }
            // Menders and repair units fix a part of the front line before the next wave.
            pool += (poolMax - pool) * REPAIR_FRACTION;
        }

        result.wavesLeft = survivedFuture;
        if(winWave > 0 && future != null && future.size > 0 && result.lastSafeWave >= winWave){
            result.cappedByWin = true;
        }else{
            result.cappedByHorizon = true;
        }
        return result;
    }

    /** Nearest core to a unit, or null when the player has no core. */
    public static CoreInfo nearestCore(UnitInfo unit, Seq<CoreInfo> cores){
        return unit == null ? null : nearestCoreAt(unit.x, unit.y, cores);
    }

    /** Nearest core to a world position, or null when the player has no core. */
    public static CoreInfo nearestCoreAt(float x, float y, Seq<CoreInfo> cores){
        if(cores == null || cores.size == 0) return null;
        CoreInfo nearest = null;
        float best = Float.MAX_VALUE;
        for(CoreInfo core : cores){
            if(core == null) continue;
            float dx = core.x - x;
            float dy = core.y - y;
            float dst2 = dx * dx + dy * dy;
            if(dst2 < best){
                best = dst2;
                nearest = core;
            }
        }
        return nearest;
    }

    /**
     * Finds the places where the defence should be improved.
     * <p>
     * For every core the function looks along the real approaches (from the wave
     * spawn points; in all eight directions when no spawn point is known) and
     * evaluates a point on the expected defence ring. A sector is weak when the
     * turrets that can actually reach that point do not provide enough ground or
     * air DPS for the coming waves, when there is almost no wall HP in front of
     * them, or when a nearby turret is sitting without ammo. Badly damaged
     * front-line buildings near a core get a separate repair marker at their
     * real position.
     */
    public static Seq<WeakPoint> computeWeakPoints(Seq<CoreInfo> cores, Seq<TurretInfo> defenders, Seq<WallInfo> walls,
                                                   Seq<PointInfo> spawns, Seq<WaveLoad> future,
                                                   float currentGroundDps, float currentFlyingDps,
                                                   int mapWidthTiles, int mapHeightTiles){
        Seq<WeakPoint> markers = new Seq<>();
        if(cores == null || cores.size == 0) return markers;
        if(defenders == null) defenders = new Seq<>();
        if(walls == null) walls = new Seq<>();
        if(spawns == null) spawns = new Seq<>();
        if(future == null) future = new Seq<>();

        // What the next waves will mostly consist of. The current enemies count
        // as one extra sample; the strongest of the next ten waves raises the bar.
        int samples = 0;
        float sumGroundDps = 0f, sumAirDps = 0f;
        float maxGroundDps = 0f, maxAirDps = 0f;
        int seen = 0;
        for(WaveLoad load : future){
            if(seen >= 10) break;
            if(load == null || load.count <= 0) continue;
            seen++;
            maxGroundDps = Math.max(maxGroundDps, load.groundDps);
            maxAirDps = Math.max(maxAirDps, load.flyingDps);
            if(seen <= 5){
                samples++;
                sumGroundDps += load.groundDps;
                sumAirDps += load.flyingDps;
            }
        }
        if(currentGroundDps > 0f || currentFlyingDps > 0f){
            samples++;
            sumGroundDps += currentGroundDps;
            sumAirDps += currentFlyingDps;
            maxGroundDps = Math.max(maxGroundDps, currentGroundDps);
            maxAirDps = Math.max(maxAirDps, currentFlyingDps);
        }

        float avgGroundDps = samples > 0 ? sumGroundDps / samples : 0f;
        float avgAirDps = samples > 0 ? sumAirDps / samples : 0f;
        float expectedGround = Math.max(avgGroundDps, maxGroundDps * 0.55f);
        float expectedAir = Math.max(avgAirDps, maxAirDps * 0.55f);
        float threatTotal = expectedGround + expectedAir;
        float groundNeed = threatTotal > 0f ? expectedGround / threatTotal : 1f;
        float airNeed = threatTotal > 0f ? expectedAir / threatTotal : 0f;
        float requiredGround = clampFloat(expectedGround * 0.65f, 25f, 700f);
        float requiredAir = airNeed > 0.03f ? clampFloat(expectedAir * 0.65f, 18f, 700f) : 0f;
        float requiredWallHp = clampFloat(expectedGround * 5f, 600f, 3500f);
        // Without any known wave/enemy approach, guessing all eight directions
        // would just be noise. Exact repair markers below remain useful regardless.
        boolean hasThreatContext = samples > 0 || spawns.size > 0;

        float mapW = mapWidthTiles * TILE_SIZE;
        float mapH = mapHeightTiles * TILE_SIZE;

        if(hasThreatContext){
            for(CoreInfo core : cores){
                if(core == null) continue;

                Seq<Float> angles = new Seq<>();
                for(PointInfo spawn : spawns){
                    if(spawn == null) continue;
                    float angle = (float)Math.atan2(spawn.y - core.y, spawn.x - core.x);
                    boolean duplicate = false;
                    for(float existing : angles){
                        float diff = Math.abs(angle - existing);
                        diff = Math.min(diff, (float)(Math.PI * 2.0) - diff);
                        if(diff < (float)(Math.PI / 12.0)) duplicate = true;
                    }
                    if(!duplicate) angles.add(angle);
                }
                if(angles.size == 0){
                    for(int d = 0; d < 8; d++) angles.add((float)(d * Math.PI / 4.0));
                }

                for(float angle : angles){
                    float px = core.x + (float)Math.cos(angle) * DEFENSE_RING_TILES * TILE_SIZE;
                    float py = core.y + (float)Math.sin(angle) * DEFENSE_RING_TILES * TILE_SIZE;
                    if(mapW > 0f) px = clampFloat(px, TILE_SIZE * 2f, Math.max(TILE_SIZE * 2f, mapW - TILE_SIZE * 2f));
                    if(mapH > 0f) py = clampFloat(py, TILE_SIZE * 2f, Math.max(TILE_SIZE * 2f, mapH - TILE_SIZE * 2f));

                    float groundDps = 0f, airDps = 0f;
                    int coveringTurrets = 0;
                    TurretInfo emptyNear = null;
                    float emptyDist = Float.MAX_VALUE;
                    float damagedHp = 0f, damagedMaxHp = 0f;
                    for(TurretInfo turret : defenders){
                        if(turret == null) continue;
                        float dx = px - turret.x;
                        float dy = py - turret.y;
                        float dist = (float)Math.sqrt(dx * dx + dy * dy);
                        float reach = Math.max(40f, turret.range) * 0.95f;
                        if(turret.hasAmmo && dist <= reach){
                            coveringTurrets++;
                            if(turret.targetsGround) groundDps += turret.dps;
                            if(turret.targetsAir) airDps += turret.dps;
                        }
                        if(!turret.hasAmmo && dist < emptyDist){
                            emptyDist = dist;
                            emptyNear = turret;
                        }
                        if(dist <= 12f * TILE_SIZE && turret.maxHealth > 0f){
                            damagedHp += turret.health;
                            damagedMaxHp += turret.maxHealth;
                        }
                    }

                    float wallHp = 0f;
                    int wallCount = 0;
                    for(WallInfo wall : walls){
                        if(wall == null) continue;
                        float dx = px - wall.x;
                        float dy = py - wall.y;
                        if(dx * dx + dy * dy <= (7f * TILE_SIZE) * (7f * TILE_SIZE)){
                            wallHp += wall.health;
                            wallCount++;
                        }
                    }

                    float groundLack = clampFloat(1f - (requiredGround > 0f ? groundDps / requiredGround : 1f), 0f, 1f);
                    float airLack = requiredAir > 0f ? clampFloat(1f - airDps / requiredAir, 0f, 1f) : 0f;
                    float wallLack = clampFloat(1f - (requiredWallHp > 0f ? wallHp / requiredWallHp : 1f), 0f, 1f);
                    float maxSeverity = groundNeed + airNeed + groundNeed * 0.45f;
                    float severity = maxSeverity > 0f
                            ? (groundNeed * groundLack + airNeed * airLack + groundNeed * 0.45f * wallLack) / maxSeverity : 0f;

                    boolean hasEmptyNear = emptyNear != null && emptyDist <= 12f * TILE_SIZE;
                    if(hasEmptyNear) severity = Math.max(severity, 0.72f);
                    if(severity < 0.22f && !hasEmptyNear) continue;

                    int kind = MARKER_GROUND;
                    float markerX = px, markerY = py;
                    if(hasEmptyNear && severity >= 0.35f){
                        kind = MARKER_SUPPLY;
                        markerX = emptyNear.x;
                        markerY = emptyNear.y;
                    }else if(airNeed > 0.08f && airLack > 0.35f && airLack >= groundLack){
                        kind = MARKER_AIR;
                    }else if(groundLack < 0.25f && wallLack > 0.35f){
                        kind = MARKER_WALL;
                    }

                    WeakPoint marker = new WeakPoint();
                    marker.x = markerX;
                    marker.y = markerY;
                    marker.coreX = core.x;
                    marker.coreY = core.y;
                    marker.kind = kind;
                    marker.severity = severity;
                    marker.direction = directionName(markerX - core.x, markerY - core.y);
                    marker.groundDps = groundDps;
                    marker.airDps = airDps;
                    marker.wallHp = wallHp;
                    marker.wallCount = wallCount;
                    marker.turretCount = coveringTurrets;
                    marker.healthPct = damagedMaxHp > 0f ? damagedHp / damagedMaxHp * 100f : 100f;
                    marker.tileX = Math.round(markerX / TILE_SIZE);
                    marker.tileY = Math.round(markerY / TILE_SIZE);
                    markers.add(marker);
                }
            }
        }

        // One explicit repair marker for the most damaged front-line building
        // that actually protects a core. Its position is exact.
        WeakPoint repair = null;
        for(TurretInfo turret : defenders){
            if(turret == null || turret.maxHealth <= 0f) continue;
            float pct = turret.health / turret.maxHealth * 100f;
            if(pct > 35f) continue;
            CoreInfo nearest = nearestCoreAt(turret.x, turret.y, cores);
            if(nearest == null) continue;
            float dx = turret.x - nearest.x;
            float dy = turret.y - nearest.y;
            if(dx * dx + dy * dy > (48f * TILE_SIZE) * (48f * TILE_SIZE)) continue;
            if(repair == null || pct < repair.healthPct){
                repair = repairMarker(turret.x, turret.y, nearest, pct);
            }
        }
        for(WallInfo wall : walls){
            if(wall == null || wall.maxHealth <= 0f) continue;
            float pct = wall.health / wall.maxHealth * 100f;
            if(pct > 35f) continue;
            CoreInfo nearest = nearestCoreAt(wall.x, wall.y, cores);
            if(nearest == null) continue;
            float dx = wall.x - nearest.x;
            float dy = wall.y - nearest.y;
            if(dx * dx + dy * dy > (48f * TILE_SIZE) * (48f * TILE_SIZE)) continue;
            if(repair == null || pct < repair.healthPct){
                repair = repairMarker(wall.x, wall.y, nearest, pct);
            }
        }
        if(repair != null) markers.add(repair);

        // Highest severity first, without stacking several markers in one place.
        Seq<WeakPoint> result = new Seq<>();
        boolean[] used = new boolean[markers.size];
        while(result.size < WEAK_POINT_MAX){
            int bestAt = -1;
            float bestSeverity = -1f;
            for(int i = 0; i < markers.size; i++){
                if(!used[i] && markers.get(i).severity > bestSeverity){
                    bestSeverity = markers.get(i).severity;
                    bestAt = i;
                }
            }
            if(bestAt < 0) break;
            used[bestAt] = true;
            WeakPoint candidate = markers.get(bestAt);
            boolean tooClose = false;
            for(WeakPoint chosen : result){
                float dx = candidate.x - chosen.x;
                float dy = candidate.y - chosen.y;
                if(dx * dx + dy * dy < (16f * TILE_SIZE) * (16f * TILE_SIZE)) tooClose = true;
            }
            if(!tooClose) result.add(candidate);
        }
        return result;
    }

    private static WeakPoint repairMarker(float x, float y, CoreInfo core, float healthPct){
        WeakPoint marker = new WeakPoint();
        marker.x = x;
        marker.y = y;
        marker.coreX = core.x;
        marker.coreY = core.y;
        marker.kind = MARKER_REPAIR;
        marker.severity = 0.86f;
        marker.direction = directionName(x - core.x, y - core.y);
        marker.healthPct = healthPct;
        marker.tileX = Math.round(x / TILE_SIZE);
        marker.tileY = Math.round(y / TILE_SIZE);
        return marker;
    }

    /** Formats the panel text. */
    public static String format(boolean inGame, Prediction p){
        if(!inGame || p == null){
            return "[gold]РАДАР КАМПАНИИ[]\n[gray]Неактивен вне игры[]";
        }

        StringBuilder text = new StringBuilder();
        text.append("[gold]РАДАР КАМПАНИИ[] [lightgray]v1.4[]\n");

        // Wave status
        if(p.hasWaves && p.wave > 0){
            text.append("[accent]🌊 Волна ").append(p.wave).append("[]");
            if(p.winWave > 0){
                text.append("[lightgray]/").append(p.winWave).append("[]");
            }
            if(p.waveInProgress){
                text.append(" [orange]· идёт бой[]");
            }
            if(p.waveTimeSec >= 0f){
                text.append(" [lightgray]· след. через ").append(fmtTime(p.waveTimeSec)).append("[]");
            }else if(!p.waveInProgress){
                text.append(" [lightgray]· след. по кнопке[]");
            }
            text.append('\n');
        }

        // Enemy counts
        text.append("[white]Враги:[accent] ").append(p.count).append("[]");
        if(p.count > 0){
            text.append(" [lightgray](🚜").append(p.groundCount).append(" 🛸").append(p.flyingCount).append(")[]");
            if(p.bossCount > 0){
                text.append(" [scarlet]💀").append(p.bossCount).append("[]");
            }
            if(p.totalEnemyHp > 0f){
                text.append(" [lightgray]· ΣHP ~").append(fmtAmount(p.totalEnemyHp))
                        .append(" · урон ~").append((int)p.totalEnemyDps).append("/с[]");
            }
            if(p.nearestTiles < Float.MAX_VALUE){
                text.append(" [lightgray]· ближ. ").append((int)(p.nearestTiles + 0.5f)).append(" бл.[]");
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
                    .append(holds ? "шанс отбить высокий" : "может не удержать");
            int defG = (int)(p.defenseGroundDps + p.defenseSharedDps);
            int defA = (int)(p.defenseAirDps + p.defenseSharedDps);
            if(defG > 0 || defA > 0){
                text.append(" (🚜").append(defG).append(" 🛸").append(defA);
                if(p.allyDps > 0f) text.append(" 🤖").append((int)p.allyDps);
                text.append(')');
            }
            text.append("[]\n");
        }

        // Wave survival forecast: how many more waves this defence can take
        WaveForecast fc = p.forecast;
        if(fc != null && fc.available){
            if(fc.fallWave > 0){
                String reasonText = switch(fc.reason){
                    case "ground" -> " — пробьёт наземка";
                    case "air" -> " — пробьёт авиация";
                    case "boss" -> " — убьёт босс/гардиан";
                    case "no-ground" -> " — нет урона по земле";
                    case "no-air" -> " — нет ПВО";
                    case "no-defense" -> " — обороны нет";
                    default -> "";
                };
                if(p.wave > 0 && fc.fallWave <= p.wave){
                    text.append("[crimson]🏰 Прогноз: эта волна может стать последней").append(reasonText).append("[]\n");
                }else{
                    text.append(fc.wavesLeft <= 1 ? "[crimson]" : (fc.wavesLeft <= 4 ? "[orange]" : "[yellow]"))
                            .append("🏰 Прогноз: ещё ~").append(fc.wavesLeft).append(' ').append(waveWord(fc.wavesLeft))
                            .append(" · падёт на ~").append(fc.fallWave).append("-й").append(reasonText).append("[]\n");
                }
            }else if(fc.cappedByWin){
                text.append("[green]🏰 Прогноз: дотянет до победы (волна ").append(p.winWave).append(") ✅[]\n");
            }else if(fc.wavesLeft > 0){
                text.append("[green]🏰 Прогноз: держится ещё ").append(fc.wavesLeft).append("+ ")
                        .append(waveWord(fc.wavesLeft)).append("[]\n");
            }
        }
        if(p.nextWave != null){
            WaveLoad nw = p.nextWave;
            text.append("[lightgray]🌊 Волна ").append(nw.wave).append(": ").append(nw.count)
                    .append(" враг. (🚜").append(nw.groundCount).append(" 🛸").append(nw.flyingCount).append(')');
            if(nw.bossCount > 0) text.append(" 💀").append(nw.bossCount);
            text.append(" · ΣHP ~").append(fmtAmount(nw.totalHp))
                    .append(" · урон ~").append((int)nw.totalDps).append("/с");
            if(nw.composition != null && !nw.composition.isEmpty()){
                text.append(" · ").append(nw.composition);
            }
            text.append("[]\n");
        }
        if(fc != null && fc.available && fc.nextBossWave > 0 && fc.nextBossIn > 0 && fc.nextBossIn <= 10
                && p.bossCount == 0 && (p.nextWave == null || p.nextWave.wave != fc.nextBossWave)){
            text.append("[scarlet]💀 Босс/гардиан на волне ").append(fc.nextBossWave)
                    .append(" (через ").append(fc.nextBossIn).append(' ').append(waveWord(fc.nextBossIn)).append(")[]\n");
        }

        // Weak defence sectors: the same places are marked with ✚ on the whole-map radar.
        if(p.weakPoints != null && p.weakPoints.size > 0){
            int shownWeak = Math.min(2, p.weakPoints.size);
            for(int i = 0; i < shownWeak; i++){
                WeakPoint wp = p.weakPoints.get(i);
                String reason = switch(wp.kind){
                    case MARKER_AIR -> wp.airDps > 0f ? "слабое ПВО (~" + (int)wp.airDps + "/с)" : "нет ПВО";
                    case MARKER_WALL -> "нужны стены (сейчас ~" + fmtAmount(wp.wallHp) + " HP)";
                    case MARKER_SUPPLY -> "турель без патронов";
                    case MARKER_REPAIR -> "оборона повреждена (" + (int)wp.healthPct + "% HP)";
                    default -> "мало урона по земле (~" + (int)wp.groundDps + "/с)";
                };
                text.append(wp.severity >= 0.65f ? "[orange]" : "[yellow]")
                        .append("🧭 Усилить ").append(wp.direction)
                        .append(" (").append(wp.tileX).append(',').append(wp.tileY).append("): ")
                        .append(reason).append("[]\n");
            }
            if(p.weakPoints.size > shownWeak){
                text.append("[lightgray]🧭 Ещё меток усиления: ").append(p.weakPoints.size - shownWeak)
                        .append(" — см. карту ✚[]\n");
            }
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
                    .append((int)p.battery).append("%)");
            if(p.batterySeconds < Float.MAX_VALUE){
                text.append(" · АКБ на ~").append(fmtTime(p.batterySeconds));
            }
            text.append("[]\n");
        }

        // Turrets and damaged buildings
        if(p.emptyTurrets > 0){
            text.append("[yellow]📦 Турели без патронов: ").append(p.emptyTurrets).append(" шт.[]\n");
        }
        if(p.damagedBuildings >= 3){
            text.append("[yellow]🛠️ Повреждения базы: ").append(p.damagedBuildings).append(" построек[]\n");
        }

        // Base statistics
        StringBuilder baseLine = new StringBuilder();
        if(p.buildingCount > 0) baseLine.append("построек ").append(p.buildingCount);
        if(p.turretCount > 0){
            if(baseLine.length() > 0) baseLine.append(" · ");
            baseLine.append("турелей ").append(p.turretCount);
        }
        if(p.ownCount > 0){
            if(baseLine.length() > 0) baseLine.append(" · ");
            baseLine.append("свои юниты ").append(p.ownCount)
                    .append(" (🚜").append(p.ownGround).append(" 🛸").append(p.ownFlying).append(')');
        }
        if(p.hasPower && !p.powerDeficit){
            if(baseLine.length() > 0) baseLine.append(" · ");
            baseLine.append("⚡").append(p.powerNet >= 0f ? "+" : "").append((int)p.powerNet).append("/с");
        }
        if(baseLine.length() > 0){
            text.append("[lightgray]🏭 ").append(baseLine).append("[]\n");
        }

        // Session statistics (the game's own GameStats counters)
        if(p.hasStats){
            text.append("[gray]📈 Убито ").append(p.kills)
                    .append(" · построено ").append(p.built)
                    .append(" · потеряно ").append(p.destroyed)
                    .append(" · юнитов созд. ").append(p.unitsCreated);
            if(p.coreItems >= 0) text.append(" · 📦 в ядре ").append(fmtAmount(p.coreItems));
            text.append("[]\n");
        }else if(p.coreItems >= 0){
            text.append("[gray]📦 Предметов в ядре: ").append(fmtAmount(p.coreItems)).append("[]\n");
        }

        // Everything is fine
        boolean hasAlerts = p.threats > 0 || p.closeThreats > 0 || p.bossCount > 0 || p.incoming > 0 ||
                p.minCoreHp < 99f || p.powerDeficit ||
                (p.forecast != null && p.forecast.fallWave > 0 && p.forecast.wavesLeft <= 1) ||
                (p.weakPoints != null && p.weakPoints.size > 0) ||
                p.emptyTurrets > 0 || p.damagedBuildings >= 3;
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

    /** Compact amount: 950 -> "950", 1234 -> "1.2k", 25400 -> "25k", 1200000 -> "1.2M". */
    public static String fmtAmount(float value){
        float v = Math.abs(value);
        if(v < 1000f) return "" + Math.round(value);
        if(v < 10000f){
            String scaled = oneDecimal(value / 1000f);
            return scaled + "k";
        }
        if(v < 1000000f) return Math.round(value / 1000f) + "k";
        return oneDecimal(value / 1000000f) + "M";
    }

    /** One decimal digit, dropping a trailing ".0" (locale independent). */
    private static String oneDecimal(float value){
        int scaled = Math.round(value * 10f);
        int whole = scaled / 10;
        int frac = Math.abs(scaled % 10);
        return frac == 0 ? "" + whole : whole + "." + frac;
    }

    /** Seconds as m:ss ("1:05"). */
    public static String fmtTime(float seconds){
        int s = Math.max(0, Math.round(seconds));
        int rest = s % 60;
        return (s / 60) + ":" + (rest < 10 ? "0" : "") + rest;
    }

    /** Clamps a float without depending on a particular Mathf overload. */
    public static float clampFloat(float value, float min, float max){
        return Math.max(min, Math.min(max, value));
    }

    /** Eight-point compass name (in Russian) for a world-space direction. */
    public static String directionName(float dx, float dy){
        if(!Float.isFinite(dx) || !Float.isFinite(dy) || (dx == 0f && dy == 0f)) return "у ядра";
        String[] names = {"В", "СВ", "С", "СЗ", "З", "ЮЗ", "Ю", "ЮВ"};
        int index = Math.round((float)(Math.atan2(dy, dx) / (Math.PI / 4.0)));
        index = ((index % 8) + 8) % 8;
        return names[index];
    }

    /** Russian plural of "wave": волну / волны / волн. */
    public static String waveWord(int n){
        int mod10 = n % 10;
        int mod100 = n % 100;
        if(mod10 == 1 && mod100 != 11) return "волну";
        if(mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "волны";
        return "волн";
    }
}
