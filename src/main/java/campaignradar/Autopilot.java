package campaignradar;

import arc.Events;
import arc.math.Mathf;
import arc.math.geom.Vec2;
import arc.struct.IntSet;
import arc.struct.Seq;
import arc.util.Log;
import arc.util.Time;
import mindustry.Vars;
import mindustry.content.Blocks;
import mindustry.entities.units.BuildPlan;
import mindustry.game.EventType.GameOverEvent;
import mindustry.game.EventType.SectorCaptureEvent;
import mindustry.game.EventType.Trigger;
import mindustry.game.EventType.WorldLoadEvent;
import mindustry.game.Team;
import mindustry.game.Teams.BlockPlan;
import mindustry.game.Teams.TeamData;
import mindustry.gen.Building;
import mindustry.gen.Call;
import mindustry.gen.Unit;
import mindustry.type.Item;
import mindustry.type.ItemStack;
import mindustry.type.Planet;
import mindustry.world.Block;
import mindustry.world.Build;
import mindustry.world.Tile;
import mindustry.world.blocks.defense.turrets.ItemTurret;
import mindustry.world.blocks.defense.turrets.ItemTurret.ItemTurretBuild;
import mindustry.world.blocks.production.Drill;
import mindustry.world.blocks.storage.CoreBlock.CoreBuild;

import static campaignradar.AutopilotLogic.*;

/**
 * Stage 0/1 of the Serpulo campaign autopilot: the world adapter and executor.
 * <p>
 * Off by default. When the player starts it in a local single-player Serpulo
 * campaign on Normal, it makes one small, re-validated decision per second
 * ({@link AutopilotLogic#decide}) and executes it with the same mechanics a
 * player uses: build plans of the player's own core unit, mining, taking items
 * from the core and handing them to turrets, and the "next wave" button.
 * It never writes saves, never edits sector progress and never acts in a
 * network game; any failed check stops it with a readable reason.
 */
public class Autopilot{
    private final CampaignThreatRadar radar;

    public int state = OFF;
    public String reason = "";
    public String lastAction = "";
    /** Last journal entries, newest last. Also mirrored to the game log. */
    public final Seq<String> journal = new Seq<>();

    private final Watchdog watchdog = new Watchdog();
    private final Seq<BuildPlan> ownPlans = new Seq<>();
    private final IntSet rejectedSites = new IntSet();
    private final Vec2 move = new Vec2();
    private float nextDecision;
    private float lastWaveCallSec = -1e9f;
    private float deadSinceSec = -1f;

    private boolean hasTarget;
    private float targetX, targetY, arriveDistance;

    // Rearm trip: 0 idle, 1 take ammo from the core, 2 bring it to the turret, 3 return leftovers.
    private int rearmStage;
    private Building rearmTarget;
    private Item rearmItem;

    // Candidates of the current decision, computed before deciding.
    private final Seq<BuildPlan> defenseCandidates = new Seq<>();
    private final Seq<BuildPlan> rebuildCandidates = new Seq<>();
    private final Seq<BuildPlan> drillCandidates = new Seq<>();
    private Tile mineCandidate;
    private String drillLabel = "";

    public Autopilot(CampaignThreatRadar radar){
        this.radar = radar;
        Events.run(Trigger.update, this::update);
        Events.on(WorldLoadEvent.class, event -> {
            if(state == RUNNING || state == PAUSED || state == NEEDS_HELP){
                // Never act during or right after loading: the player decides again.
                halt();
                state = OFF;
                reason = "загружен мир/сохранение — проверьте сектор и включите автопилот снова";
                log(reason);
            }else if(state == COMPLETE){
                state = OFF;
                reason = "";
            }
            lastAction = "";
            lastWaveCallSec = -1e9f;
            rejectedSites.clear();
        });
        Events.on(SectorCaptureEvent.class, event -> {
            if(state == RUNNING || state == PAUSED){
                halt();
                state = transition(state, CMD_CAPTURED);
                reason = "сектор захвачен ✅ — выберите следующий сектор на карте планеты";
                log(reason);
            }
        });
        Events.on(GameOverEvent.class, event -> {
            if(state == RUNNING || state == PAUSED) fail("игра окончена — ядро потеряно");
        });
    }

    // ------------------------------------------------------------- controls

    /** Starts or resumes. Refuses (with a reason) outside a Normal Serpulo campaign. */
    public void start(){
        String why = guardReason(guard());
        if(why != null){
            reason = "запуск невозможен: " + why;
            if(state == RUNNING || state == PAUSED) halt();
            state = state == COMPLETE ? COMPLETE : OFF;
            log(reason);
            return;
        }
        String goal = goalProblem(goal());
        if(goal != null){
            reason = "запуск невозможен: " + goal;
            log(reason);
            return;
        }
        boolean resumed = state == PAUSED;
        state = transition(state, CMD_START);
        reason = "";
        watchdog.reset();
        nextDecision = 0f;
        log(resumed ? "продолжаю" : "включён: цель — захватить текущий сектор");
    }

    /** Pauses: movement and new actions stop immediately, queued plans stay. */
    public void pause(){
        if(state != RUNNING) return;
        state = transition(state, CMD_PAUSE);
        hasTarget = false;
        clearMining();
        reason = "пауза — нажмите ▶, чтобы продолжить";
        log("пауза");
    }

    /** Emergency stop: no more actions, own build plans are cancelled. */
    public void stop(){
        if(state == OFF) return;
        halt();
        state = transition(state, CMD_STOP);
        reason = "остановлен игроком";
        log(reason);
    }

    public String statusText(){
        return formatStatus(state, reason, lastAction);
    }

    // ------------------------------------------------------------- frame loop

    private void update(){
        if(state != RUNNING) return;
        try{
            if(Vars.state == null || !Vars.state.isGame()){
                halt();
                state = OFF;
                reason = "игра закрыта";
                return;
            }
            String why = guardReason(guard());
            if(why != null){
                fail(why);
                return;
            }
            if(Vars.state.isPaused()) return;

            Unit unit = Vars.player.unit();
            boolean alive = unit != null && unit.isValid() && !Vars.player.dead();
            if(alive) steer(unit);

            if(Time.time < nextDecision) return;
            nextDecision = Time.time + DECISION_INTERVAL_TICKS;
            think(alive ? unit : null);
        }catch(Throwable error){
            Log.err("[campaign-radar] autopilot error", error);
            fail("непредвиденная ошибка: " + error.getClass().getSimpleName());
        }
    }

    /** Flies the core unit to the current build plan or action target. */
    private void steer(Unit unit){
        float tx, ty, arrive;
        BuildPlan plan = unit.plans.size > 0 ? unit.buildPlan() : null;
        if(plan != null){
            tx = plan.drawx();
            ty = plan.drawy();
            arrive = unit.type.buildRange * 0.5f;
        }else if(hasTarget){
            tx = targetX;
            ty = targetY;
            arrive = arriveDistance;
        }else{
            return;
        }
        float dx = tx - unit.x, dy = ty - unit.y;
        float dst = Mathf.len(dx, dy);
        if(dst <= arrive) return;
        move.set(dx, dy).setLength(unit.speed());
        unit.movePref(move);
        unit.lookAt(move.angle());
    }

    private void setTarget(float x, float y, float arrive){
        hasTarget = true;
        targetX = x;
        targetY = y;
        arriveDistance = arrive;
    }

    // ------------------------------------------------------------- decision

    private void think(Unit unit){
        float now = Time.time / 60f;
        Goal goal = goal();
        if(goal.captured){
            halt();
            state = transition(state, CMD_CAPTURED);
            reason = "сектор захвачен ✅ — выберите следующий сектор на карте планеты";
            log(reason);
            return;
        }
        String goalWhy = goalProblem(goal);
        if(goalWhy != null){
            fail(goalWhy);
            return;
        }

        Observation o = new Observation();
        o.playerAlive = unit != null;
        if(unit == null){
            if(deadSinceSec < 0f) deadSinceSec = now;
            if(now - deadSinceSec > RESPAWN_WAIT_SECONDS){
                fail("юнит не возрождается " + (int)RESPAWN_WAIT_SECONDS + " с");
                return;
            }
            lastAction = "ждём возрождения юнита";
            rearmStage = 0;
            return;
        }
        deadSinceSec = -1f;

        Team team = Vars.player.team();
        CoreBuild core = Vars.player.closestCore();
        if(core == null){
            fail("нет ядра");
            return;
        }
        TeamData data = Vars.state.teams.get(team);

        // Forget finished plans; detect a stuck queue.
        for(int i = ownPlans.size - 1; i >= 0; i--){
            if(unit.plans.indexOf(ownPlans.get(i), true) < 0) ownPlans.remove(i);
        }
        BuildPlan current = unit.plans.size > 0 ? unit.buildPlan() : null;
        long token = (Vars.state.stats != null ? Vars.state.stats.buildingsBuilt : 0) * 1_000_000L
                + unit.plans.size * 1000L + (current != null ? (int)(current.progress * 999f) : 0);
        if(watchdog.stalled(unit.plans.size > 0, token, now)){
            cancelOwnPlans(unit);
            fail("строительство стоит " + (int)STALL_SECONDS + " с: не хватает ресурсов или место недоступно");
            return;
        }
        if(unit.plans.size > 0) Vars.control.input.isBuilding = true;

        o.buildQueue = unit.plans.size;
        o.rearmInProgress = rearmStage != 0 && rearmTarget != null && rearmTarget.isValid();
        if(!o.rearmInProgress) rearmStage = 0;

        int[] budget = coreBudget(core);
        CampaignThreatRadar.Prediction prediction = radar.latestPrediction();
        boolean idle = o.buildQueue == 0 && !o.rearmInProgress;
        if(idle){
            o.rearmTargets = findRearmTarget(data, core) ? 1 : 0;
            o.defenseSlots = collectDefense(prediction, team, budget);
            o.rebuildSlots = collectRebuild(data, team, budget);
            o.drills = countDrills(data);
            if(o.drills < MAX_DRILLS) o.drillPossible = collectDrill(core, team, budget);
            mineCandidate = findMineTile(unit, core, team);
            o.minePossible = mineCandidate != null;
        }

        o.waves = Vars.state.rules.waves;
        o.waveSending = Vars.state.rules.waveSending;
        o.waveTimer = Vars.state.rules.waveTimer;
        o.spawning = Vars.spawner.isSpawning();
        o.enemies = Vars.state.enemies;
        o.wave = Vars.state.wave;
        o.winWave = Vars.state.rules.winWave;
        o.waveTimeSec = Vars.state.rules.waveTimer ? Vars.state.wavetime / 60f : -1f;
        o.secondsSinceWaveCall = now - lastWaveCallSec;
        o.coreHealthFrac = minCoreHealth(data);
        if(prediction != null && prediction.forecast != null){
            o.forecastAvailable = prediction.forecast.available;
            o.forecastFallWave = prediction.forecast.fallWave;
            o.forecastCappedByWin = prediction.forecast.cappedByWin;
        }

        Decision decision = decide(o);
        if(decision.action != ACT_MINE) clearMining();
        if(decision.action != ACT_MINE && decision.action != ACT_REARM) hasTarget = false;
        execute(decision, unit, core, team, now);
    }

    private void execute(Decision decision, Unit unit, CoreBuild core, Team team, float now){
        switch(decision.action){
            case ACT_REARM:
                rearm(unit, core);
                break;
            case ACT_DEFEND:
                queue(unit, defenseCandidates);
                action("оборона: " + defenseCandidates.size + " построек · " + decision.reason);
                break;
            case ACT_REBUILD:
                queue(unit, rebuildCandidates);
                action("восстанавливаю " + rebuildCandidates.size + " построек");
                break;
            case ACT_DRILL:
                queue(unit, drillCandidates);
                action("ставлю бур (" + drillLabel + ") и конвейер: " + (drillCandidates.size - 1) + " клеток");
                break;
            case ACT_MINE:
                mine(unit);
                lastAction = "добываю " + (mineCandidate != null && mineCandidate.drop() != null
                        ? mineCandidate.drop().localizedName : "руду") + " · " + decision.reason;
                break;
            case ACT_CALL_WAVE:
                Vars.logic.skipWave();
                lastWaveCallSec = now;
                action("вызываю волну " + Vars.state.wave + " · " + decision.reason);
                break;
            default:
                lastAction = decision.reason;
                break;
        }
    }

    // ------------------------------------------------------------- guards

    private Guard guard(){
        Guard g = new Guard();
        if(Vars.state == null) return g;
        g.inGame = Vars.state.isGame();
        g.netActive = Vars.net != null && Vars.net.active();
        g.campaign = Vars.state.isCampaign();
        g.gameOver = Vars.state.gameOver;
        Planet planet = Vars.state.getPlanet();
        g.planet = planet == null ? "" : planet.name;
        g.difficulty = planet == null || planet.campaignRules == null || planet.campaignRules.difficulty == null
                ? "" : planet.campaignRules.difficulty.name();
        Unit unit = Vars.player == null ? null : Vars.player.unit();
        g.canBuild = unit == null || !unit.isValid() || unit.canBuild();
        return g;
    }

    private Goal goal(){
        Goal goal = new Goal();
        if(Vars.state == null || Vars.state.rules == null) return goal;
        goal.waves = Vars.state.rules.waves;
        goal.attackMode = Vars.state.rules.attackMode;
        goal.winWave = Vars.state.rules.winWave;
        goal.captured = Vars.state.rules.sector != null && Vars.state.rules.sector.info != null
                && Vars.state.rules.sector.info.wasCaptured && !Vars.state.rules.waves && !Vars.state.rules.attackMode;
        return goal;
    }

    // ------------------------------------------------------------- observation helpers

    private int[] coreBudget(CoreBuild core){
        int[] budget = new int[Vars.content.items().size];
        for(Item item : Vars.content.items()) budget[item.id] = core.items.get(item);
        return budget;
    }

    /** Checks the cost against the remaining budget and reserves it when affordable. */
    private boolean reserve(int[] budget, Block block, int count){
        float multiplier = Vars.state.rules.buildCostMultiplier;
        for(ItemStack stack : block.requirements){
            int need = Mathf.ceil(stack.amount * multiplier) * count;
            int keep = "copper".equals(stack.item.name) ? COPPER_RESERVE : 0;
            if(budget[stack.item.id] - need < keep) return false;
        }
        for(ItemStack stack : block.requirements){
            budget[stack.item.id] -= Mathf.ceil(stack.amount * multiplier) * count;
        }
        return true;
    }

    private static boolean usable(Block block){
        return block != null && block.unlockedNow() && block.isPlaceable() && block.environmentBuildable();
    }

    private float minCoreHealth(TeamData data){
        float min = 1f;
        for(CoreBuild core : data.cores){
            if(core.maxHealth > 0f) min = Math.min(min, core.health / core.maxHealth);
        }
        return min;
    }

    private int countDrills(TeamData data){
        int count = 0;
        for(Building building : data.buildings){
            if(building.block instanceof Drill) count++;
        }
        return count;
    }

    private boolean findRearmTarget(TeamData data, CoreBuild core){
        Building best = null;
        Item bestItem = null;
        float bestDst = Float.MAX_VALUE;
        for(Building building : data.buildings){
            if(!(building instanceof ItemTurretBuild turret) || !(building.block instanceof ItemTurret block)) continue;
            if(turret.totalAmmo >= block.maxAmmo * REARM_FRACTION) continue;
            Item ammo = null;
            int stock = 0;
            for(Item item : block.ammoTypes.keys()){
                int amount = core.items.get(item);
                if(amount >= MIN_AMMO_STOCK && amount > stock){
                    ammo = item;
                    stock = amount;
                }
            }
            if(ammo == null) continue;
            float dst = building.dst(core);
            if(dst < bestDst){
                best = building;
                bestItem = ammo;
                bestDst = dst;
            }
        }
        if(best == null) return false;
        rearmTarget = best;
        rearmItem = bestItem;
        return true;
    }

    private int collectDefense(CampaignThreatRadar.Prediction prediction, Team team, int[] budget){
        defenseCandidates.clear();
        if(prediction == null || prediction.weakPoints == null) return 0;
        IntSet taken = new IntSet();
        for(CampaignThreatRadar.WeakPoint wp : prediction.weakPoints){
            if(wp.kind != MARKER_GROUND && wp.kind != MARKER_AIR && wp.kind != MARKER_WALL) continue;
            CampaignThreatRadar.DefensePlan plan = radar.buildDefensePlan(wp.tileX, wp.tileY, prediction);
            int[] kinds = new int[plan.placements.size];
            for(int i = 0; i < kinds.length; i++) kinds[i] = plan.placements.get(i).kind;
            for(int index : defenseOrder(wp.kind, kinds)){
                if(defenseCandidates.size >= MAX_DEFENSE_PLANS_PER_CYCLE) break;
                CampaignThreatRadar.PlanPlacement placement = plan.placements.get(index);
                Block block = placement.kind == PLAN_WALL ? Blocks.copperWall
                        : placement.kind == PLAN_DUO ? Blocks.duo
                        : placement.kind == PLAN_SCATTER ? Blocks.scatter : null;
                if(!usable(block) || overlaps(taken, block, placement.x, placement.y)) continue;
                if(!Build.validPlace(block, team, placement.x, placement.y, 0)) continue;
                if(!reserve(budget, block, 1)) continue;
                mark(taken, block, placement.x, placement.y);
                defenseCandidates.add(new BuildPlan(placement.x, placement.y, 0, block));
            }
            // One approach at a time keeps the base compact and the plan explainable.
            if(defenseCandidates.size > 0) break;
        }
        return defenseCandidates.size;
    }

    private int collectRebuild(TeamData data, Team team, int[] budget){
        rebuildCandidates.clear();
        for(BlockPlan plan : data.plans){
            if(rebuildCandidates.size >= MAX_DEFENSE_PLANS_PER_CYCLE) break;
            if(plan.removed || !usable(plan.block)) continue;
            if(!Build.validPlace(plan.block, team, plan.x, plan.y, plan.rotation)) continue;
            if(!reserve(budget, plan.block, 1)) continue;
            rebuildCandidates.add(new BuildPlan(plan.x, plan.y, plan.rotation, plan.block, plan.config));
        }
        return rebuildCandidates.size;
    }

    /** Fills the observed window around the core; returns its origin in tiles. */
    private int[] window(CoreBuild core, Team team, int[] cells, int[] ore){
        int size = WINDOW_RADIUS * 2 + 1;
        int ox = core.tileX() - WINDOW_RADIUS, oy = core.tileY() - WINDOW_RADIUS;
        for(int y = 0; y < size; y++){
            for(int x = 0; x < size; x++){
                int i = y * size + x;
                Tile tile = Vars.world.tile(ox + x, oy + y);
                ore[i] = -1;
                if(tile == null){
                    cells[i] = CELL_BLOCKED;
                    continue;
                }
                if(tile.build instanceof CoreBuild && tile.build.team == team){
                    cells[i] = CELL_CORE;
                    continue;
                }
                boolean free = !rejectedSites.contains(pack(ox + x, oy + y))
                        && Build.validPlace(Blocks.conveyor, team, ox + x, oy + y, 0);
                cells[i] = free ? CELL_FREE : CELL_BLOCKED;
                Item drop = tile.block() == Blocks.air ? tile.drop() : null;
                if(free && drop != null && !tile.floor().isLiquid) ore[i] = drop.id;
            }
        }
        return new int[]{ox, oy};
    }

    private boolean collectDrill(CoreBuild core, Team team, int[] budget){
        drillCandidates.clear();
        Drill drill = null;
        for(Block candidate : new Block[]{Blocks.pneumaticDrill, Blocks.mechanicalDrill}){
            if(candidate instanceof Drill d && usable(d)){
                drill = d;
                break;
            }
        }
        if(drill == null || !usable(Blocks.conveyor)) return false;

        int size = WINDOW_RADIUS * 2 + 1;
        int[] cells = new int[size * size], ore = new int[size * size];
        int[] origin = window(core, team, cells, ore);

        Seq<Item> items = Vars.content.items();
        String[] names = new String[items.size];
        int[] stock = new int[items.size];
        boolean[] available = new boolean[items.size];
        for(Item item : items){
            names[item.id] = item.name;
            stock[item.id] = core.items.get(item);
        }
        for(int value : ore){
            if(value >= 0 && items.get(value).hardness <= drill.tier) available[value] = true;
        }

        for(int itemIndex : rankItems(names, stock, available)){
            DrillSite site = findDrillSite(size, size, cells, ore, itemIndex, drill.size, MAX_CONVEYOR_PATH);
            if(site == null) continue;
            int bx = origin[0] + site.x, by = origin[1] + site.y;
            if(!Build.validPlace(drill, team, bx, by, 0)){
                rejectedSites.add(pack(bx, by));
                continue;
            }
            int[] work = budget.clone();
            if(!reserve(work, drill, 1) || !reserve(work, Blocks.conveyor, site.pathLength)) continue;
            Seq<BuildPlan> plans = new Seq<>();
            plans.add(new BuildPlan(bx, by, 0, drill));
            boolean ok = true;
            for(int s = 0; s < site.pathLength; s++){
                int cx = origin[0] + site.path[s * 3], cy = origin[1] + site.path[s * 3 + 1];
                int rotation = site.path[s * 3 + 2];
                if(!Build.validPlace(Blocks.conveyor, team, cx, cy, rotation)){
                    ok = false;
                    break;
                }
                plans.add(new BuildPlan(cx, cy, rotation, Blocks.conveyor));
            }
            if(!ok || plans.size > MAX_PLANS_PER_CYCLE) continue;
            System.arraycopy(work, 0, budget, 0, budget.length);
            drillCandidates.addAll(plans);
            drillLabel = items.get(itemIndex).localizedName;
            return true;
        }
        return false;
    }

    private Tile findMineTile(Unit unit, CoreBuild core, Team team){
        if(!unit.canMine() || !unit.type.mineFloor) return null;
        int size = WINDOW_RADIUS * 2 + 1;
        int[] cells = new int[size * size], ore = new int[size * size];
        int[] origin = window(core, team, cells, ore);
        Seq<Item> items = Vars.content.items();
        String[] names = new String[items.size];
        int[] stock = new int[items.size];
        boolean[] available = new boolean[items.size];
        for(Item item : items){
            names[item.id] = item.name;
            stock[item.id] = core.items.get(item);
        }
        for(int value : ore){
            if(value >= 0 && isMineWorthy(names[value]) && unit.canMine(items.get(value))) available[value] = true;
        }
        int maxDist = Math.min(WINDOW_RADIUS, (int)(Vars.mineTransferRange / Vars.tilesize) - 3);
        for(int itemIndex : rankItems(names, stock, available)){
            int cell = nearestOreCell(size, size, cells, ore, itemIndex, WINDOW_RADIUS, WINDOW_RADIUS, maxDist);
            if(cell >= 0) return Vars.world.tile(origin[0] + cell % size, origin[1] + cell / size);
        }
        return null;
    }

    // ------------------------------------------------------------- executors

    private void queue(Unit unit, Seq<BuildPlan> plans){
        Vars.control.input.isBuilding = true;
        for(BuildPlan plan : plans){
            unit.addBuild(plan);
            ownPlans.add(plan);
        }
        watchdog.success();
    }

    private void mine(Unit unit){
        Tile tile = mineCandidate;
        if(tile == null) return;
        if(unit.mineTile == tile) return;
        setTarget(tile.worldx(), tile.worldy(), unit.type.mineRange * 0.6f);
        if(unit.validMine(tile)){
            unit.mineTile = tile;
            hasTarget = false;
        }
    }

    private void clearMining(){
        Unit unit = Vars.player == null ? null : Vars.player.unit();
        if(unit != null && unit.isValid() && unit.mineTile != null) unit.mineTile = null;
    }

    private void rearm(Unit unit, CoreBuild core){
        float range = Vars.itemTransferRange * 0.75f;
        if(rearmStage == 0) rearmStage = 1;
        if(rearmTarget == null || !rearmTarget.isValid() || rearmItem == null){
            rearmStage = 0;
            return;
        }
        // Something else in the hands: put it into the core first.
        if(unit.stack.amount > 0 && unit.item() != rearmItem){
            rearmStage = Math.max(rearmStage, 1);
            if(Vars.player.within(core, range)){
                Call.transferInventory(Vars.player, core);
            }else{
                setTarget(core.x, core.y, range * 0.8f);
            }
            lastAction = "освобождаю руки у ядра";
            return;
        }
        if(rearmStage == 1){
            if(unit.stack.amount > 0){
                rearmStage = 2;
            }else if(Vars.player.within(core, range)){
                int amount = Math.min(unit.maxAccepted(rearmItem), core.items.get(rearmItem));
                if(amount <= 0){
                    rearmStage = 0;
                    if(watchdog.fail("rearm")) fail("в ядре закончились патроны " + rearmItem.localizedName);
                    return;
                }
                Call.requestItem(Vars.player, core, rearmItem, amount);
                rearmStage = 2;
                lastAction = "беру " + amount + " " + rearmItem.localizedName + " из ядра";
                return;
            }else{
                setTarget(core.x, core.y, range * 0.8f);
                lastAction = "лечу к ядру за патронами";
                return;
            }
        }
        if(rearmStage == 2){
            if(unit.stack.amount <= 0){
                rearmStage = 0;
                return;
            }
            if(Vars.player.within(rearmTarget, range)){
                Call.transferInventory(Vars.player, rearmTarget);
                action("зарядил турель " + rearmTarget.block.localizedName + " у " + rearmTarget.tileX() + "," + rearmTarget.tileY());
                watchdog.success();
                rearmStage = unit.stack.amount > 0 ? 3 : 0;
            }else{
                setTarget(rearmTarget.x, rearmTarget.y, range * 0.8f);
                lastAction = "несу " + rearmItem.localizedName + " к турели";
            }
            return;
        }
        if(rearmStage == 3){
            if(unit.stack.amount <= 0){
                rearmStage = 0;
            }else if(Vars.player.within(core, range)){
                Call.transferInventory(Vars.player, core);
                rearmStage = 0;
            }else{
                setTarget(core.x, core.y, range * 0.8f);
            }
        }
    }

    // ------------------------------------------------------------- stopping

    private void fail(String why){
        halt();
        state = transition(state, CMD_FAIL);
        reason = why;
        log("остановлен: " + why);
    }

    /** Stops every effect on the world that the autopilot started. */
    private void halt(){
        hasTarget = false;
        rearmStage = 0;
        rearmTarget = null;
        clearMining();
        Unit unit = Vars.player == null ? null : Vars.player.unit();
        if(unit != null && unit.isValid()) cancelOwnPlans(unit);
        ownPlans.clear();
        watchdog.reset();
    }

    private void cancelOwnPlans(Unit unit){
        for(BuildPlan plan : ownPlans){
            unit.plans.remove(plan, true);
        }
        ownPlans.clear();
    }

    // ------------------------------------------------------------- misc

    private void action(String text){
        lastAction = text;
        log(text);
    }

    private void log(String text){
        journal.add(text);
        if(journal.size > 8) journal.remove(0);
        Log.info("[campaign-radar] autopilot: @", text);
    }

    private static int pack(int x, int y){
        return (x & 0xFFFF) << 16 | (y & 0xFFFF);
    }

    private static boolean overlaps(IntSet taken, Block block, int x, int y){
        int o = sizeOffset(block.size);
        for(int dx = 0; dx < block.size; dx++){
            for(int dy = 0; dy < block.size; dy++){
                if(taken.contains(pack(x + o + dx, y + o + dy))) return true;
            }
        }
        return false;
    }

    private static void mark(IntSet taken, Block block, int x, int y){
        int o = sizeOffset(block.size);
        for(int dx = 0; dx < block.size; dx++){
            for(int dy = 0; dy < block.size; dy++){
                taken.add(pack(x + o + dx, y + o + dy));
            }
        }
    }
}
