package campaignbot;

import arc.math.geom.Vec2;
import arc.struct.Seq;
import mindustry.Vars;
import mindustry.content.Blocks;
import mindustry.content.Items;
import mindustry.content.StatusEffects;
import mindustry.ctype.ContentType;
import mindustry.entities.Units;
import mindustry.entities.units.BuildPlan;
import mindustry.game.SpawnGroup;
import mindustry.game.Team;
import mindustry.game.Teams.TeamData;
import mindustry.gen.Building;
import mindustry.gen.Call;
import mindustry.gen.Unit;
import mindustry.type.Item;
import mindustry.type.Sector;
import mindustry.world.Block;
import mindustry.world.Build;
import mindustry.world.Tile;
import mindustry.world.blocks.defense.turrets.ItemTurret;
import mindustry.world.blocks.defense.turrets.Turret.TurretBuild;
import mindustry.world.blocks.power.NuclearReactor.NuclearReactorBuild;
import mindustry.world.blocks.power.PowerNode.PowerNodeBuild;
import mindustry.world.blocks.storage.CoreBlock.CoreBuild;
import mindustry.world.meta.Attribute;
import mindustry.world.meta.BlockGroup;

import java.util.ArrayList;
import java.util.HashMap;

import static campaignbot.CampaignBotLogic.*;
import static campaignbot.ProLogic.*;

/**
 * v2.0 "pro player" runtime: glue between the pure {@link ProLogic}/{@link LlmBrain}
 * and the live Mindustry world. Every public entry point is wrapped by the caller in
 * try/catch, so a failure here can only fall back to the v1 behaviour.
 */
public class ProRuntime{
    private static final String[] USABLE_NAMES = {
        "copper-wall", "copper-wall-large", "titanium-wall", "titanium-wall-large", "thorium-wall", "thorium-wall-large",
        "surge-wall", "surge-wall-large", "plastanium-wall", "plastanium-wall-large",
        "duo", "scatter", "scorch", "hail", "wave", "lancer", "arc", "swarmer", "salvo", "segment", "tsunami", "fuse", "ripple",
        "cyclone", "foreshadow", "spectre", "meltdown", "mender", "mend-projector", "overdrive-projector", "force-projector",
        "router", "junction", "unloader", "conveyor", "titanium-conveyor", "thorium-reactor", "cryofluid-mixer", "water-extractor",
        "repair-point", "payload-conveyor", "power-node", "ground-factory", "air-factory", "naval-factory",
        "additive-reconstructor", "multiplicative-reconstructor", "exponential-reconstructor", "tetrative-reconstructor"
    };
    private static final String[] TURRET_NAMES = {"duo", "hail", "scatter", "lancer", "salvo", "ripple", "cyclone", "swarmer", "spectre", "fuse", "arc", "scorch"};

    private final SectorAutopilot ap;
    public final LlmClient client = new LlmClient();
    public final LlmBrain.Brain brain = new LlmBrain.Brain(client);

    // ---- per-sector state
    public String sectorKey;
    public TerrainScan scan;
    public boolean scanDone;
    public Choke choke;
    public ArrayList<Choke> chokes = new ArrayList<Choke>();
    public KillBox kill;
    private String killKey = "";
    public String recon = "";
    public WaveReport sched;
    private int schedWave = -1;
    public final DamageHeat heat = new DamageHeat();
    private HashMap<Integer, Float> prevHp = new HashMap<Integer, Float>();
    private float nextHeatSec;
    public Breach breach;
    private int breachWave = -1, breachHandled = -1;
    private int[] busPieces;      // world x, y, type, rotation
    private int busSpineX = -1, busSpineY = -1;
    public boolean busBuilt;
    private int busFails;
    private float lastRetuneSec;
    public int aaBuilt;
    private int fortTotal, fortSat, fortTurretsBuilt;
    public Kit kit;
    public LlmBrain.Plan plan;
    public boolean enemyKnown;
    public int enemyPower;
    public float lastDps;
    public int armyCount;
    private HashMap<String, Float> itemSnapValues;
    private float itemSnapAt = -1f;
    private HashMap<String, Float> income = new HashMap<String, Float>();
    private float[] routeCache;
    private String routeKey = "";
    private float routeAt = -1e9f;
    private int routeIdx;
    private FlankRoute route;
    public final HashMap<Integer, Boolean> retreating = new HashMap<Integer, Boolean>();
    private int reactorMx = Integer.MIN_VALUE, reactorMy, reactorEx, reactorEy, reactorRx, reactorRy;
    private boolean reactorSite;
    public String reactorWhy = "";
    private final HashMap<String, Boolean> errLogged = new HashMap<String, Boolean>();

    public ProRuntime(SectorAutopilot ap){
        this.ap = ap;
    }

    // ------------------------------------------------------------ helpers

    private void resetSector(){
        scan = null;
        scanDone = false;
        choke = null;
        chokes = new ArrayList<Choke>();
        kill = null;
        killKey = "";
        recon = "";
        sched = null;
        schedWave = -1;
        heat.reset();
        prevHp = new HashMap<Integer, Float>();
        nextHeatSec = 0f;
        breach = null;
        breachWave = -1;
        breachHandled = -1;
        busPieces = null;
        busBuilt = false;
        busFails = 0;
        aaBuilt = 0;
        fortTotal = 0;
        fortSat = 0;
        fortTurretsBuilt = 0;
        kit = null;
        plan = null;
        enemyKnown = false;
        enemyPower = 0;
        routeKey = "";
        route = null;
        routeIdx = 0;
        retreating.clear();
        reactorSite = false;
        reactorWhy = "";
        itemSnapValues = null;
        itemSnapAt = -1f;
        income = new HashMap<String, Float>();
    }

    /** Called when a new world loads. */
    public void onWorldLoad(){
        sectorKey = null;
        resetSector();
    }

    private void once(String label, Throwable t){
        if(errLogged.containsKey(label)) return;
        errLogged.put(label, Boolean.TRUE);
        ap.logPro("про-модуль «" + label + "» отключён: " + t);
    }

    static Block block(String name){
        try{
            return Vars.content.getByName(ContentType.block, name);
        }catch(Throwable t){
            return null;
        }
    }

    static Item item(String name){
        if(name == null || name.isEmpty()) return null;
        try{
            return Vars.content.getByName(ContentType.item, name);
        }catch(Throwable t){
            return null;
        }
    }

    public HashMap<String, Boolean> usableMap(){
        HashMap<String, Boolean> m = new HashMap<String, Boolean>();
        for(String n : USABLE_NAMES) m.put(n, SectorAutopilot.usable(block(n)));
        return m;
    }

    public HashMap<String, Integer> stockMap(CoreBuild core){
        HashMap<String, Integer> m = new HashMap<String, Integer>();
        for(Item it : Vars.content.items()) m.put(it.name, core.items.get(it));
        return m;
    }

    private static int tileOf(float world){
        return Math.round(world / Vars.tilesize);
    }

    private WaveGroup[] waveGroups(){
        ArrayList<WaveGroup> out = new ArrayList<WaveGroup>();
        if(Vars.state.rules.spawns == null) return new WaveGroup[0];
        for(SpawnGroup grp : Vars.state.rules.spawns){
            if(grp == null || grp.type == null) continue;
            WaveGroup g = new WaveGroup();
            g.type = grp.type.name;
            g.flying = grp.type.flying;
            g.begin = grp.begin;
            g.end = grp.end >= 1000000 ? -1 : grp.end;
            g.spacing = Math.max(1, grp.spacing);
            g.amount = Math.max(1, grp.unitAmount);
            g.scaling = grp.unitScaling > 0f && grp.unitScaling < 1000000f ? grp.unitScaling : 0f;
            g.max = grp.max >= 1000000 ? -1 : grp.max;
            g.boss = grp.effect == StatusEffects.boss;
            g.hp = grp.type.health > 0f ? grp.type.health : 100f;
            float dps = 10f;
            try{
                dps = grp.type.estimateDps();
            }catch(Throwable ignored){
            }
            g.dps = dps > 0f ? dps : 10f;
            g.shield = grp.shields;
            g.shieldScaling = grp.shieldScaling;
            out.add(g);
        }
        return out.toArray(new WaveGroup[0]);
    }

    // -------------------------------------------------------------- recon

    /** Starts recon when a new sector (or a new core position) is entered. */
    public void enter(Sector sector, CoreBuild core, float nowSec){
        String key = (sector != null ? String.valueOf(sector.id) : "?") + ":" + core.tileX() + ":" + core.tileY();
        if(key.equals(sectorKey)) return;
        resetSector();
        sectorKey = key;
        try{
            final int w = Vars.world.width(), h = Vars.world.height();
            ArrayList<Integer> src = new ArrayList<Integer>();
            for(Tile sp : Vars.spawner.getSpawns()){
                src.add((int)sp.x);
                src.add((int)sp.y);
            }
            TeamData enemyData = Vars.state.teams.get(Vars.state.rules.waveTeam);
            if(enemyData != null){
                for(CoreBuild ec : enemyData.cores){
                    src.add(ec.tileX());
                    src.add(ec.tileY());
                }
            }
            int[] sources = new int[src.size()];
            for(int i = 0; i < sources.length; i++) sources[i] = src.get(i);
            scan = new TerrainScan(w, h, core.tileX(), core.tileY(), sources, new ScanEnv(){
                @Override
                public boolean passable(int x, int y){
                    Tile t = Vars.world.tile(x, y);
                    if(t == null) return false;
                    if(t.floor() != null && t.floor().isDeep()) return false;
                    return !(t.solid() && t.build == null);
                }

                @Override
                public String feature(int x, int y){
                    Tile t = Vars.world.tile(x, y);
                    if(t == null) return "";
                    if(t.floor() != null && t.floor().isDeep()) return "deep";
                    if(t.floor() != null && t.floor().isLiquid && t.floor().liquidDrop != null){
                        return "oil".equals(t.floor().liquidDrop.name) ? "oil" : "water";
                    }
                    if(t.block() == Blocks.air){
                        Item d = t.drop();
                        if(d != null) return "ore:" + d.name;
                    }
                    if(t.floor() != null && t.floor().attributes.get(Attribute.heat) > 0.25f) return "heat";
                    return "";
                }
            });
            sched = analyzeWaveSchedule(waveGroups(), Math.max(0, Vars.state.wave - 1), 5, 150);
            schedWave = Vars.state.wave;
            brain.markEvent("sector");
            ap.logPro("разведка карты: " + (sched.firstAirWave > 0 ? "авиация с волны " + sched.firstAirWave : "авиации нет")
                + (sched.bossWave > 0 ? ", босс " + sched.bossType + " на волне " + sched.bossWave : ""));
        }catch(Throwable t){
            once("разведка", t);
            scan = null;
            scanDone = true;
        }
    }

    /** One time-sliced step of the terrain scan. */
    public void stepScan(CoreBuild core){
        if(scan == null || scanDone) return;
        try{
            if(scan.step(4000, 2500)){
                scanDone = true;
                chokes = scan.chokes;
                choke = chokes.isEmpty() ? null : chokes.get(0);
                recon = summarizeRecon(scan, sched, core.tileX(), core.tileY());
                ap.logPro("разведка: " + recon);
                brain.markEvent("recon");
            }
        }catch(Throwable t){
            once("разведка", t);
            scan = null;
            scanDone = true;
        }
    }

    /** After-action learning: tracks HP loss of our buildings between decisions (4x4 heat buckets). */
    public void updateHeat(TeamData data, Team team, CoreBuild core, float nowSec){
        if(nowSec < nextHeatSec) return;
        nextHeatSec = nowSec + 1.5f;
        HashMap<Integer, Float> fresh = new HashMap<Integer, Float>();
        for(Building b : data.buildings){
            if(b == null || b.block == null || b == core) continue;
            Integer key = b.pos();
            float hp = b.health;
            fresh.put(key, hp);
            Float prev = prevHp.get(key);
            if(prev != null && hp < prev.floatValue() - 1f){
                // Java mod: dead()/isFlying() are methods (Healthc / Unit). The Rhino ZIP edition uses
                // the field-safe helpers unitDead()/unitFlying() in scriptmod/scripts/main.js.
                boolean air = Units.closestEnemy(team, b.x, b.y, 14f * Vars.tilesize, e -> !e.dead() && e.isFlying()) != null;
                heat.record(tileOf(b.x), tileOf(b.y), prev.floatValue() - hp, air);
            }
        }
        prevHp = fresh;
    }

    /** Called once a wave has been cleared: turns the heat map into a reinforcement decision. */
    public void afterWave(CoreBuild core){
        if(heat.total <= 0f) return;
        Breach rep = pickBreachReinforcement(heat, core.tileX(), core.tileY(), 600f);
        if(rep != null){
            breach = rep;
            breachWave = Vars.state.wave;
            ap.logPro("разбор волны: пробито направление " + rep.flank + " (" + Math.round(rep.amount) + " урона" + (rep.air ? ", воздух" : "") + ")");
            brain.markEvent("breach");
        }
        heat.reset();
    }

    // ---------------------------------------------------------- strategy

    private HashMap<String, Float> incomeOf(HashMap<String, Integer> stock, float nowSec){
        if(itemSnapValues == null){
            itemSnapAt = nowSec;
            itemSnapValues = new HashMap<String, Float>();
            for(String k : stock.keySet()) itemSnapValues.put(k, (float)stock.get(k));
            return income;
        }
        if(nowSec - itemSnapAt >= 20f){
            HashMap<String, Float> inc = new HashMap<String, Float>();
            HashMap<String, Float> snap = new HashMap<String, Float>();
            for(String k : stock.keySet()){
                Float old = itemSnapValues.get(k);
                inc.put(k, (stock.get(k) - (old == null ? 0f : old.floatValue())) / (nowSec - itemSnapAt));
                snap.put(k, (float)stock.get(k));
            }
            income = inc;
            itemSnapValues = snap;
            itemSnapAt = nowSec;
        }
        return income;
    }

    /** Builds the situation summary and asks the brain (Gemma or the instant heuristic) for a plan. */
    public LlmBrain.Plan think(CoreBuild core, TeamData data, Team team, float netPowerPerSec, HashMap<String, Boolean> usable,
                               HashMap<String, Integer> stock, float nowSec){
        int wave = Vars.state.wave;
        if(sched == null || schedWave != wave){
            sched = analyzeWaveSchedule(waveGroups(), Math.max(0, wave - 1), 5, 150);
            schedWave = wave;
        }
        int turrets = 0, aa = 0;
        for(Building b : data.buildings){
            if(b.block == null) continue;
            if(b instanceof TurretBuild) turrets++;
            if(b.block == Blocks.scatter || b.block == block("cyclone") || b.block == block("swarmer")) aa++;
        }
        aaBuilt = aa;
        ArrayList<String> avail = new ArrayList<String>();
        for(String n : TURRET_NAMES) if(Boolean.TRUE.equals(usable.get(n))) avail.add(n);

        LlmBrain.Sit sit = new LlmBrain.Sit();
        sit.attackMode = Vars.state.rules.attackMode;
        sit.sectorName = sectorKey == null ? "?" : sectorKey;
        sit.wave = wave;
        sit.winWave = Vars.state.rules.winWave;
        sit.enemies = Vars.state.enemies;
        sit.coreName = core.block.name.replace("core-", "");
        sit.items = stock;
        sit.income = incomeOf(stock, nowSec);
        sit.power = netPowerPerSec / 60f;
        sit.forecast = sched;
        sit.chokeCount = chokes.size();
        if(choke != null){
            sit.chokeWidth = choke.width;
            sit.chokeDist = choke.dist;
            sit.chokeFlank = compassFlank(choke.cx - core.tileX(), choke.cy - core.tileY());
        }
        sit.weakFlank = heat.total > 0f ? heat.dominantFlank(core.tileX(), core.tileY()) : "";
        sit.breach = breach != null && breachHandled != breachWave ? breach : null;
        boolean v1Done = choke == null && turrets >= 4;
        sit.fortressBuilt = choke != null ? (fortTotal > 0 && fortSat >= fortTotal * 0.85f) : v1Done;
        sit.aaBuilt = aa >= 2;
        sit.busBuilt = busBuilt;
        sit.turrets = turrets;
        sit.defenseDps = lastDps;
        sit.armyUnits = armyCount;
        sit.turretsAvailable = avail.toArray(new String[0]);
        sit.aaAvailable = on(usable, "scatter") || on(usable, "cyclone") || on(usable, "salvo");
        sit.busPossible = kill != null && on(usable, "router") && on(usable, "junction") && busFails < 3;
        sit.smelterAvailable = SectorAutopilot.usable(Blocks.siliconSmelter);
        sit.airChainAvailable = SectorAutopilot.usable(Blocks.airFactory) && SectorAutopilot.usable(Blocks.additiveReconstructor);
        sit.enemyBaseKnown = enemyKnown;
        sit.enemyPowerNodes = enemyPower;
        sit.canCallWave = Vars.state.rules.waves && Vars.state.rules.waveSending && !Vars.state.rules.attackMode;
        plan = brain.update(sit);
        return plan;
    }

    private static boolean on(HashMap<String, Boolean> m, String k){
        return Boolean.TRUE.equals(m.get(k));
    }

    // ------------------------------------------------------- fortress

    private boolean wallsOpen(){
        return fortTurretsBuilt >= 2 || Vars.state.wave >= 4;
    }

    private boolean slotSatisfied(int x, int y, int role, Team team){
        Tile t = Vars.world.tile(x, y);
        if(t == null || t.build == null || t.build.team != team) return false;
        Block bb = t.build.block;
        if(role == CampaignBotLogic.ROLE_WALL || role == ROLE_WALL_WINDOW || role == ROLE_WALL_INNER){
            return bb.group == BlockGroup.walls;
        }
        if(role == CampaignBotLogic.ROLE_GROUND_TURRET || role == ROLE_FRONT_TURRET || role == CampaignBotLogic.ROLE_AIR_TURRET
                || role == ROLE_LIQUID_TURRET || role == ROLE_POINT_DEFENSE){
            if(!(t.build instanceof TurretBuild)) return false;
            if(role == CampaignBotLogic.ROLE_GROUND_TURRET && kit != null && !kit.main.isEmpty()){
                int r = mainTurretRank(bb.name);
                return r <= mainTurretRank(kit.main) || r == 99;
            }
            return true;
        }
        if(role == CampaignBotLogic.ROLE_SUPPORT) return bb == Blocks.mender || bb == Blocks.mendProjector;
        if(role == CampaignBotLogic.ROLE_POWER_NODE) return t.build instanceof PowerNodeBuild;
        if(role == ROLE_FORCE) return bb == Blocks.forceProjector;
        if(role == ROLE_OVERDRIVE) return bb == Blocks.overdriveProjector;
        return false;
    }

    private KillBox killBox(CoreBuild core, HashMap<String, Boolean> usable, HashMap<String, Integer> stock, float netPower){
        if(choke == null || scan == null) return null;
        final int[] fullStock = ap.coreBudget(core);
        Kit fresh = chooseFortressKit(usable, new Afford(){
            @Override
            public boolean ok(String blockName, int count){
                Block blk = block(blockName);
                return blk != null && ap.reserve(fullStock.clone(), blk, count);
            }
        }, stock, netPower, plan != null ? plan.ammo : "");
        kit = mergeKit(kit, fresh, fortTotal > 0 && fortSat >= fortTotal * 0.8f, fortTurretsBuilt == 0);
        String key = kit.main + "|" + kit.front + "|" + kit.support + "|" + kit.wantForce + "|" + kit.wantOverdrive + "|" + choke.cx + "|" + choke.cy;
        if(kill != null && key.equals(killKey)) return kill;
        KillBoxOpts o = new KillBoxOpts();
        o.frontSize = kit.front.isEmpty() ? 1 : kit.frontSize;
        o.mainSize = kit.mainSize;
        o.supportSize = kit.support.isEmpty() ? 1 : kit.supportSize;
        o.wantForce = kit.wantForce;
        o.wantOverdrive = kit.wantOverdrive;
        kill = buildKillBox(Vars.world.width(), Vars.world.height(), scan.passable, choke, o);
        killKey = key;
        busPieces = null;
        ap.logPro("укрепрайон: горлышко " + choke.width + " тайлов, " + compassFlank(choke.cx - core.tileX(), choke.cy - core.tileY())
            + ", ударные: " + (kit.main.isEmpty() ? "—" : kit.main) + ", передний ряд: " + (kit.front.isEmpty() ? "—" : kit.front));
        return kill;
    }

    private boolean slotWanted(int role, int size, int layer, KillBox kb, Kit k, HashMap<String, Boolean> usable){
        if(role == CampaignBotLogic.ROLE_WALL || role == ROLE_WALL_WINDOW || role == ROLE_WALL_INNER){
            return pickFortressWalls(role, size, layer, kb.flankLayers, usable).length > 0;
        }
        if(role == CampaignBotLogic.ROLE_GROUND_TURRET) return !k.main.isEmpty();
        if(role == ROLE_FRONT_TURRET) return !k.front.isEmpty();
        if(role == CampaignBotLogic.ROLE_SUPPORT) return !k.support.isEmpty();
        if(role == CampaignBotLogic.ROLE_POWER_NODE) return on(usable, "power-node");
        if(role == ROLE_FORCE) return on(usable, "force-projector");
        if(role == ROLE_OVERDRIVE) return on(usable, "overdrive-projector");
        return false;
    }

    private void planFortress(Team team, int[] budget, KillBox kb, HashMap<String, Boolean> usable, Seq<BuildPlan> turretsOut, Seq<BuildPlan> wallsOut){
        int total = 0, sat = 0, turretsBuilt = 0;
        boolean wallsGate = wallsOpen();
        for(int s = 0; s + 4 < kb.slots.length; s += 5){
            int sx = kb.slots[s], sy = kb.slots[s + 1], size = kb.slots[s + 2], role = kb.slots[s + 3], layer = kb.slots[s + 4];
            boolean isWall = role == CampaignBotLogic.ROLE_WALL || role == ROLE_WALL_WINDOW || role == ROLE_WALL_INNER;
            if(!slotWanted(role, size, layer, kb, kit, usable)) continue;
            total++;
            if(slotSatisfied(sx, sy, role, team)){
                sat++;
                if(role == CampaignBotLogic.ROLE_GROUND_TURRET || role == ROLE_FRONT_TURRET) turretsBuilt++;
                continue;
            }
            if(isWall && !wallsGate) continue;
            ArrayList<Block> cands = new ArrayList<Block>();
            if(isWall){
                for(String wn : pickFortressWalls(role, size, layer, kb.flankLayers, usable)) cands.add(block(wn));
            }else if(role == CampaignBotLogic.ROLE_GROUND_TURRET){
                cands.add(block(kit.main));
            }else if(role == ROLE_FRONT_TURRET){
                cands.add(kit.front.isEmpty() ? null : block(kit.front));
            }else if(role == CampaignBotLogic.ROLE_SUPPORT){
                cands.add(kit.support.isEmpty() ? null : block(kit.support));
            }else if(role == CampaignBotLogic.ROLE_POWER_NODE){
                cands.add(on(usable, "power-node") ? Blocks.powerNode : null);
            }else if(role == ROLE_FORCE){
                cands.add(block("force-projector"));
            }else if(role == ROLE_OVERDRIVE){
                cands.add(block("overdrive-projector"));
            }
            Seq<BuildPlan> list = isWall ? wallsOut : turretsOut;
            int limit = isWall ? 12 : MAX_DEFENSE_PLANS_PER_CYCLE;
            if(list.size >= limit) continue;
            for(Block blk : cands){
                if(blk == null || blk.size != size || !SectorAutopilot.usable(blk)) continue;
                if(ap.isRejected(sx, sy) || !Build.validPlace(blk, team, sx, sy, 0)) continue;
                if(!ap.reserve(budget, blk, 1)) continue;
                list.add(new BuildPlan(sx, sy, 0, blk));
                break;
            }
        }
        fortTotal = total;
        fortSat = sat;
        fortTurretsBuilt = turretsBuilt;
    }

    private static Block pieceBlock(int type, HashMap<String, Boolean> usable){
        if(type == BUS_UNLOADER) return Blocks.unloader;
        if(type == BUS_ROUTER) return Blocks.router;
        if(type == BUS_JUNCTION) return Blocks.junction;
        return on(usable, "titanium-conveyor") ? Blocks.titaniumConveyor : Blocks.conveyor;
    }

    private String busAmmoName(){
        String ammo = plan != null ? plan.ammo : "";
        if(kit != null && (ammo == null || ammo.isEmpty() || !turretAcceptsAmmo(kit.main, ammo))) ammo = kit.ammo;
        return ammo == null ? "" : ammo;
    }

    /** Ammo bus: Unloader at the core, conveyor, Router/Junction spine behind the turret rows. */
    private void planBus(CoreBuild core, Team team, int[] budget, int[] cells, int[] origin, int size, KillBox kb,
                         HashMap<String, Boolean> usable, Seq<BuildPlan> out){
        if(kb == null || kb.spineLen < 3 || !on(usable, "router") || !on(usable, "junction")) return;
        if(fortTurretsBuilt < 2 || busFails >= 3) return;
        String ammoName = busAmmoName();
        if(busPieces == null){
            IntList spineWin = new IntList();
            for(int i = 0; i < kb.spineLen; i++){
                int wx = kb.spine[i * 2] - origin[0], wy = kb.spine[i * 2 + 1] - origin[1];
                if(wx < 0 || wy < 0 || wx >= size || wy >= size) break;
                spineWin.add(wx, wy);
            }
            if(spineWin.size() < 6){
                busFails = 3;
                return;
            }
            int[] unl = null;
            if(on(usable, "unloader")){
                int ui = findBusUnloaderCell(size, size, cells, spineWin.get(0), spineWin.get(1));
                if(ui >= 0) unl = new int[]{ui % size, ui / size};
            }
            BusPlan bus = planAmmoBus(size, size, cells, unl, spineWin.toArray());
            if(!bus.ok){
                busFails++;
                ap.logPro("шина боепитания: " + bus.reason);
                return;
            }
            int[] pieces = new int[bus.pieces.length];
            for(int p = 0; p + 3 < bus.pieces.length; p += 4){
                pieces[p] = origin[0] + bus.pieces[p];
                pieces[p + 1] = origin[1] + bus.pieces[p + 1];
                pieces[p + 2] = bus.pieces[p + 2];
                pieces[p + 3] = bus.pieces[p + 3];
            }
            busPieces = pieces;
            busSpineX = kb.spine[0];
            busSpineY = kb.spine[1];
            ap.logPro("шина боепитания: " + (pieces.length / 4) + " блоков (" + (unl != null ? "Unloader" : "без Unloader") + "), патрон: " + (ammoName.isEmpty() ? "—" : ammoName));
        }
        int missing = 0, queued = 0;
        for(int k = 0; k + 3 < busPieces.length; k += 4){
            int px = busPieces[k], py = busPieces[k + 1], type = busPieces[k + 2], rot = busPieces[k + 3];
            Block blk = pieceBlock(type, usable);
            Tile t = Vars.world.tile(px, py);
            if(t != null && t.build != null && t.build.team == team
                    && (t.build.block == blk || (type == BUS_CONVEYOR && t.build.block.name.contains("conveyor")))) continue;
            missing++;
            if(queued >= 24) continue;
            if(!Build.validPlace(blk, team, px, py, rot)){
                busFails++;
                busPieces = null;
                return;
            }
            if(!ap.reserve(budget, blk, 1)) continue;
            Item cfg = type == BUS_UNLOADER ? item(ammoName) : null;
            out.add(cfg != null ? new BuildPlan(px, py, rot, blk, cfg) : new BuildPlan(px, py, rot, blk));
            queued++;
        }
        busBuilt = missing == 0;
    }

    /** Keeps the bus Unloader on the best ammo (Gemma's choice when the turrets accept it). */
    public void retuneBus(Team team, float nowSec){
        if(busPieces == null || !busBuilt || nowSec - lastRetuneSec < 6f) return;
        lastRetuneSec = nowSec;
        Item it = item(busAmmoName());
        if(it == null) return;
        for(int k = 0; k + 3 < busPieces.length; k += 4){
            if(busPieces[k + 2] != BUS_UNLOADER) continue;
            Tile t = Vars.world.tile(busPieces[k], busPieces[k + 1]);
            if(t != null && t.build != null && t.build.team == team && t.build.block == Blocks.unloader && t.build.config() != it){
                Call.tileConfig(Vars.player, t.build, it);
            }
        }
    }

    /** Is this turret next to the ammo bus (then it does not need hand delivery)? */
    public boolean nearBus(Building b){
        if(busPieces == null || busSpineX < 0) return false;
        float reach = (kill != null ? kill.spineLen : 9) + 8f;
        return distPointToPoint(b.x / Vars.tilesize, b.y / Vars.tilesize, busSpineX, busSpineY) <= reach;
    }

    /** Preferred (best stocked) ammo item for a hand-fed turret, or null. */
    public Item preferredAmmo(Building b, HashMap<String, Integer> stock){
        String nm = chooseAmmoItem(b.block.name, stock, null, plan != null ? plan.ammo : "");
        return nm == null ? null : item(nm);
    }

    private boolean wantAa(){
        if(aaBuilt >= 2 && !(breach != null && breach.air && breachHandled != breachWave)) return false;
        if(plan != null && "BUILD_AA_SHIELD".equals(plan.priority)) return true;
        int wave = Math.max(1, Vars.state.wave);
        if(sched != null && sched.nextAirWave > 0 && sched.nextAirWave - wave <= 2) return true;
        return heat.total > 0f && heat.airShare() >= 0.5f;
    }

    private void planAa(CoreBuild core, Team team, int[] budget, HashMap<String, Boolean> usable, HashMap<String, Integer> stock,
                        TeamData data, Seq<BuildPlan> out){
        String[] ladder = {"cyclone", "salvo", "scatter"};
        Block blk = null;
        for(int i = 0; i < ladder.length && blk == null; i++){
            Block cand = block(ladder[i]);
            if(cand == null || !on(usable, ladder[i]) || !ap.reserve(budget.clone(), cand, 2)) continue;
            if(chooseAmmoItem(ladder[i], stock, null, "") == null) continue;
            blk = cand;
        }
        if(blk == null) return;
        IntList gens = new IntList();
        for(Building b : data.buildings){
            if(b.block != null && b.block.outputsPower && b.block != Blocks.solarPanel) gens.add(tileOf(b.x), tileOf(b.y));
        }
        int spx = -1, spy = -1;
        for(Tile s : Vars.spawner.getSpawns()){
            spx = s.x;
            spy = s.y;
            break;
        }
        if(spx < 0){
            TeamData ed = Vars.state.teams.get(Vars.state.rules.waveTeam);
            if(ed != null && ed.cores.size > 0){
                spx = ed.cores.first().tileX();
                spy = ed.cores.first().tileY();
            }
        }
        if(spx < 0) return;
        int[] slots = planAaCorridor(core.tileX(), core.tileY(), spx, spy, gens.toArray(), 4, 6, 16);
        for(int s2 = 0; s2 + 2 < slots.length && out.size < 2; s2 += 3){
            int[] spot = ap.findValidSpotNear(blk, team, slots[s2], slots[s2 + 1], 3);
            if(spot == null) continue;
            boolean near = false;
            for(int dy = -4; dy <= 4 && !near; dy++){
                for(int dx = -4; dx <= 4; dx++){
                    Tile tl = Vars.world.tile(spot[0] + dx, spot[1] + dy);
                    if(tl != null && tl.build != null && tl.build.team == team && tl.build.block != null
                            && (tl.build.block == Blocks.scatter || tl.build.block == block("cyclone"))){
                        near = true;
                        break;
                    }
                }
            }
            if(near) continue;
            if(ap.reserve(budget, blk, 1)) out.add(new BuildPlan(spot[0], spot[1], 0, blk));
        }
    }

    private void planBreach(Team team, int[] budget, HashMap<String, Boolean> usable, Seq<BuildPlan> out){
        if(breach == null || breachHandled == breachWave) return;
        String[] ladder = breach.air ? new String[]{"cyclone", "salvo", "scatter"}
            : new String[]{kit != null && !kit.main.isEmpty() ? kit.main : "duo", "salvo", "hail", "duo"};
        int made = 0;
        for(int i = 0; i < ladder.length && made < 2; i++){
            Block blk = block(ladder[i]);
            if(blk == null || !on(usable, ladder[i])) continue;
            int[] spot = ap.findValidSpotNear(blk, team, breach.x, breach.y, 6);
            if(spot != null && ap.reserve(budget, blk, 1)){
                out.add(new BuildPlan(spot[0], spot[1], 0, blk));
                made++;
            }
        }
        if(made > 0){
            breachHandled = breachWave;
            ap.logPro("усиливаю пробитое направление " + breach.flank);
        }else if(out.isEmpty()){
            breachHandled = breachWave;
        }
    }

    /**
     * Fills {@code out} with the next defense plans: breach repair, AA umbrella, kill-box turrets, ammo bus and walls
     * (ordered by the brain's priority). Returns -1 when the v1 fortress template must be used instead.
     */
    public int planDefense(CoreBuild core, TeamData data, Team team, int[] budget, int[] cells, int[] origin, int size,
                           float netPower, HashMap<String, Boolean> usable, HashMap<String, Integer> stock, Seq<BuildPlan> out){
        out.clear();
        KillBox kb = killBox(core, usable, stock, netPower);
        if(kb != null){
            Seq<BuildPlan> turrets = new Seq<>(), walls = new Seq<>(), aaPlans = new Seq<>(), busPlans = new Seq<>(), brPlans = new Seq<>();
            planFortress(team, budget, kb, usable, turrets, walls);
            if(wantAa()) planAa(core, team, budget, usable, stock, data, aaPlans);
            planBus(core, team, budget, cells, origin, size, kb, usable, busPlans);
            planBreach(team, budget, usable, brPlans);
            boolean busFirst = plan != null && "BUILD_AMMO_BUS".equals(plan.priority);
            Seq<?>[] groups = busFirst ? new Seq<?>[]{brPlans, aaPlans, busPlans, turrets, walls}
                : new Seq<?>[]{brPlans, aaPlans, turrets, busPlans, walls};
            for(Seq<?> g : groups){
                if(g.size == 0) continue;
                for(Object o : g) out.add((BuildPlan)o);
                break;
            }
            return out.size;
        }
        Seq<BuildPlan> aaOnly = new Seq<>();
        if(wantAa()) planAa(core, team, budget, usable, stock, data, aaOnly);
        if(aaOnly.size > 0){
            out.addAll(aaOnly);
            return out.size;
        }
        boolean scanning = scan != null && !scanDone && Vars.state.wave < 3 && Vars.state.enemies <= 0;
        return scanning ? 0 : -1;
    }

    // --------------------------------------------------------- reactor

    /** Cryofluid first, reactor only after the coolant is guaranteed. Returns true when plans were added. */
    public boolean planReactor(CoreBuild core, TeamData data, Team team, int[] budget, HashMap<String, Boolean> usable,
                               HashMap<String, Integer> stock, float netPower, int[] cells, int[] origin, int size, Seq<BuildPlan> out){
        if(!on(usable, "thorium-reactor") || !on(usable, "cryofluid-mixer") || !on(usable, "water-extractor")) return false;
        for(Building b : data.buildings) if(b.block == Blocks.thoriumReactor) return false;
        int thorium = stock.containsKey("thorium") ? stock.get("thorium") : 0;
        int titanium = stock.containsKey("titanium") ? stock.get("titanium") : 0;
        if(thorium < 120 || titanium < 120 || netPower < 90f) return false;
        float awayX = 1f, awayY = 0f;
        if(scan != null && !scan.paths.isEmpty() && scan.paths.get(0).xs.length > 0){
            awayX = scan.paths.get(0).xs[0] - core.tileX();
            awayY = scan.paths.get(0).ys[0] - core.tileY();
        }
        if(!reactorSite){
            ReactorSite site = findReactorSite(size, size, cells, size >> 1, size >> 1, awayX, awayY, 14f, 30f);
            if(site == null) return false;
            reactorRx = origin[0] + site.rx;
            reactorRy = origin[1] + site.ry;
            reactorMx = origin[0] + site.mx;
            reactorMy = origin[1] + site.my;
            reactorEx = origin[0] + site.ex;
            reactorEy = origin[1] + site.ey;
            reactorSite = true;
        }
        Block mixer = Blocks.cryofluidMixer, ext = Blocks.waterExtractor, rea = Blocks.thoriumReactor;
        Tile mt = Vars.world.tile(reactorMx, reactorMy);
        Building mb = mt != null && mt.build != null && mt.build.block == mixer ? mt.build : null;
        if(mb == null){
            if(Build.validPlace(mixer, team, reactorMx, reactorMy, 0) && ap.reserve(budget, mixer, 1)) out.add(new BuildPlan(reactorMx, reactorMy, 0, mixer));
            Tile et = Vars.world.tile(reactorEx, reactorEy);
            if(!(et != null && et.build != null) && Build.validPlace(ext, team, reactorEx, reactorEy, 0) && ap.reserve(budget, ext, 1)){
                out.add(new BuildPlan(reactorEx, reactorEy, 0, ext));
            }
            int[] pn = ap.findValidSpotNear(Blocks.powerNode, team, reactorMx + 2, reactorMy + 2, 3);
            if(pn != null && ap.reserve(budget, Blocks.powerNode, 1)) out.add(new BuildPlan(pn[0], pn[1], 0, Blocks.powerNode));
            return !out.isEmpty();
        }
        float frac = 0f;
        try{
            frac = mb.liquids.currentAmount() / Math.max(1f, mb.block.liquidCapacity);
        }catch(Throwable t){
            frac = 0f;
        }
        ReactorState rs = new ReactorState();
        rs.reactorUnlocked = true;
        rs.mixerBuilt = true;
        rs.mixerCryoFrac = frac;
        rs.waterOk = true;
        rs.titaniumStock = titanium;
        rs.thoriumStock = thorium;
        rs.siteDistFromCore = distPointToPoint(reactorRx, reactorRy, core.tileX(), core.tileY());
        rs.powerNetPerSec = netPower;
        String why = reactorGuard(rs);
        if(why != null){
            reactorWhy = why;
            return false;
        }
        if(Build.validPlace(rea, team, reactorRx, reactorRy, 0) && ap.reserve(budget, rea, 1)){
            out.add(new BuildPlan(reactorRx, reactorRy, 0, rea));
            ap.logPro("реактор: охлаждение подтверждено (" + Math.round(frac * 100f) + "%), ставлю Thorium Reactor");
            return true;
        }
        return false;
    }

    /** Emergency fuel cut: a hot reactor with low coolant gets its fuel pulled. */
    public void reactorWatch(TeamData data){
        for(Building b : data.buildings){
            if(!(b instanceof NuclearReactorBuild)) continue;
            NuclearReactorBuild nb = (NuclearReactorBuild)b;
            float cryo = 1f;
            try{
                cryo = nb.liquids.currentAmount() / Math.max(1f, nb.block.liquidCapacity);
            }catch(Throwable t){
                cryo = 1f;
            }
            if(reactorShouldCutFuel(nb.heat, cryo)){
                try{
                    nb.items.clear();
                }catch(Throwable ignored){
                }
                brain.markEvent("reactor");
            }
        }
    }

    // ------------------------------------------------------------ RTS

    /** Where the assault group should go next. */
    public static final class AssaultOrder{
        public Building target;
        public float wx, wy;
        public boolean last, flank;
        public int threats;
    }

    /** Priority target + danger-aware (flank) route for the assault squad. Returns null when nothing is known. */
    public AssaultOrder assaultOrder(Seq<Unit> combat, CoreBuild core, Team team, float nowSec){
        TeamData enemyData = Vars.state.teams.get(Vars.state.rules.waveTeam);
        if(enemyData == null || combat.isEmpty()) return null;
        ArrayList<AssaultCand> cands = new ArrayList<AssaultCand>();
        ArrayList<Building> builds = new ArrayList<Building>();
        ArrayList<float[]> threats = new ArrayList<float[]>();
        int turrets = 0, disarmed = 0;
        for(Building eb : enemyData.buildings){
            if(eb == null || eb.block == null || cands.size() >= 160) continue;
            float tx = tileOf(eb.x), ty = tileOf(eb.y);
            Block b = eb.block;
            String kind = null;
            boolean powered = true;
            if(b.outputsPower) kind = TARGET_GENERATOR;
            else if(b instanceof mindustry.world.blocks.power.PowerNode) kind = TARGET_POWER_NODE;
            else if(b.name.contains("battery")) kind = TARGET_BATTERY;
            else if(eb instanceof TurretBuild){
                kind = TARGET_TURRET;
                turrets++;
                boolean armed = true;
                try{
                    armed = ((TurretBuild)eb).hasAmmo();
                }catch(Throwable t){
                    armed = true;
                }
                if(eb.power != null && b.consumesPower && eb.power.status < 0.05f) armed = false;
                powered = armed;
                if(!armed) disarmed++;
                float rng = 0f;
                try{
                    rng = ((TurretBuild)eb).range();
                }catch(Throwable t){
                    rng = 0f;
                }
                threats.add(new float[]{tx, ty, Math.max(6f, rng / Vars.tilesize + 2f), 1f});
            }else if(b instanceof mindustry.world.blocks.units.UnitFactory) kind = TARGET_FACTORY;
            else if(b.group == BlockGroup.transportation) kind = TARGET_AMMO_FEED;
            if(kind != null){
                cands.add(new AssaultCand(kind, tx, ty, powered));
                builds.add(eb);
            }
        }
        for(CoreBuild ec : enemyData.cores){
            cands.add(new AssaultCand(TARGET_CORE, tileOf(ec.x), tileOf(ec.y), true));
            builds.add(ec);
        }
        enemyKnown = !cands.isEmpty();
        enemyPower = 0;
        for(AssaultCand c : cands) if(TARGET_GENERATOR.equals(c.kind) || TARGET_POWER_NODE.equals(c.kind)) enemyPower++;
        if(cands.isEmpty()) return null;
        int pick = pickAssaultTarget(cands.toArray(new AssaultCand[0]), core.tileX(), core.tileY(), turrets, disarmed);
        if(pick < 0) return null;
        AssaultCand target = cands.get(pick);
        float sumX = 0f, sumY = 0f;
        int groundN = 0;
        for(Unit u : combat){
            sumX += u.x;
            sumY += u.y;
            if(!u.isFlying()) groundN++;
        }
        int cx = tileOf(sumX / combat.size), cy = tileOf(sumY / combat.size);
        int w = Vars.world.width(), h = Vars.world.height();
        String key = target.kind + ":" + (int)target.x + ":" + (int)target.y;
        if(!key.equals(routeKey) || nowSec - routeAt > 25f || route == null){
            float[] flat = new float[threats.size() * 4];
            for(int i = 0; i < threats.size(); i++) System.arraycopy(threats.get(i), 0, flat, i * 4, 4);
            int[] danger = buildDangerGrid(w, h, flat);
            boolean[] ground = groundN * 2 >= combat.size && scan != null ? scan.passable : null;
            route = planFlankRoute(w, h, danger, ground, clampTo(cx, w), clampTo(cy, h), clampTo((int)target.x, w), clampTo((int)target.y, h), 3, 0.8f);
            if(!key.equals(routeKey)) routeIdx = 0;
            routeKey = key;
            routeAt = nowSec;
            if(route.useFlank) ap.logPro("штурм: обход по флангу к цели «" + target.kind + "» (" + route.waypoints.length / 2 + " точек)");
        }
        int[] wp = route.waypoints;
        while(routeIdx * 2 + 3 < wp.length && distPointToPoint(cx, cy, wp[routeIdx * 2], wp[routeIdx * 2 + 1]) < 8f) routeIdx++;
        AssaultOrder ord = new AssaultOrder();
        ord.target = builds.get(pick);
        ord.wx = wp[routeIdx * 2] * Vars.tilesize;
        ord.wy = wp[routeIdx * 2 + 1] * Vars.tilesize;
        ord.last = routeIdx * 2 + 2 >= wp.length;
        ord.flank = route.useFlank;
        ord.threats = threats.size();
        return ord;
    }

    private static int clampTo(int v, int size){
        return Math.max(0, Math.min(size - 1, v));
    }

    /** Repair Point / Mend Projector closest to the core (or the core itself). */
    public Vec2 repairSpot(Team team, CoreBuild core){
        Building best = null;
        float bd = Float.MAX_VALUE;
        TeamData data = Vars.state.teams.get(team);
        if(data != null){
            for(Building b : data.buildings){
                if(b.block == null) continue;
                if(b.block != Blocks.repairPoint && b.block != Blocks.mendProjector) continue;
                float d = b.dst(core);
                if(d < bd){
                    bd = d;
                    best = b;
                }
            }
        }
        return best != null ? new Vec2(best.x, best.y) : new Vec2(core.x, core.y);
    }

    /** Short Russian status for the HUD journal. */
    public String statusLine(){
        return brain.status;
    }
}
