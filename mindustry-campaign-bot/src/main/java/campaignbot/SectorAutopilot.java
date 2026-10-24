package campaignbot;

import arc.Core;
import arc.Events;
import arc.math.Mathf;
import arc.math.geom.Vec2;
import arc.struct.IntSet;
import arc.struct.ObjectSet;
import arc.struct.Seq;
import arc.util.Log;
import arc.util.Time;
import arc.util.Timer;
import mindustry.Vars;
import mindustry.ai.UnitCommand;
import mindustry.ai.UnitStance;
import mindustry.ai.types.CommandAI;
import mindustry.content.Blocks;
import mindustry.content.Items;
import mindustry.content.Liquids;
import mindustry.content.Planets;
import mindustry.content.UnitTypes;
import mindustry.entities.Units;
import mindustry.entities.units.BuildPlan;
import mindustry.game.EventType.GameOverEvent;
import mindustry.game.EventType.SectorCaptureEvent;
import mindustry.game.EventType.Trigger;
import mindustry.game.EventType.WorldLoadEvent;
import mindustry.game.SpawnGroup;
import mindustry.game.Team;
import mindustry.game.Teams.BlockPlan;
import mindustry.game.Teams.TeamData;
import mindustry.gen.Building;
import mindustry.gen.Call;
import mindustry.gen.Groups;
import mindustry.gen.Unit;
import mindustry.type.Item;
import mindustry.type.ItemStack;
import mindustry.type.Planet;
import mindustry.type.Sector;
import mindustry.type.UnitType;
import mindustry.world.Block;
import mindustry.world.Build;
import mindustry.world.Tile;
import mindustry.world.blocks.defense.turrets.ItemTurret;
import mindustry.world.blocks.defense.turrets.ItemTurret.ItemTurretBuild;
import mindustry.world.blocks.defense.turrets.Turret;
import mindustry.world.blocks.defense.turrets.Turret.TurretBuild;
import mindustry.world.blocks.power.ConsumeGenerator.ConsumeGeneratorBuild;
import mindustry.world.blocks.power.PowerGraph;
import mindustry.world.blocks.power.PowerNode;
import mindustry.world.blocks.power.PowerNode.PowerNodeBuild;
import mindustry.world.blocks.production.Drill;
import mindustry.world.blocks.production.GenericCrafter.GenericCrafterBuild;
import mindustry.world.blocks.storage.CoreBlock;
import mindustry.world.blocks.storage.CoreBlock.CoreBuild;
import mindustry.world.blocks.storage.StorageBlock.StorageBuild;
import mindustry.world.blocks.storage.Unloader.UnloaderBuild;
import mindustry.world.blocks.units.Reconstructor.ReconstructorBuild;
import mindustry.world.blocks.units.UnitFactory;
import mindustry.world.blocks.units.UnitFactory.UnitFactoryBuild;
import mindustry.world.meta.BlockGroup;

import static campaignbot.CampaignBotLogic.*;

/**
 * Full-campaign autonomous player for {@link Planets#serpulo}.
 * <p>
 * Combines {@link ResearchAndPlanetDirector} (TechTree research &amp; inter-sector
 * launches) with complete in-sector base building, industrial supply chains,
 * power networks, multi-tier defense, unit factory + reconstructor production,
 * and RTS {@link CommandAI} squad assaults on enemy bases.
 */
public class SectorAutopilot{

    private static final String PREF_ENABLED = "scb-campaign-autopilot-enabled";

    public final ResearchAndPlanetDirector director = new ResearchAndPlanetDirector();

    public int state = OFF;
    public String reason = "";
    public String lastAction = "готов к запуску";
    public String armySummary = "нет боевых юнитов";
    public final Seq<String> journal = new Seq<>();

    private final Watchdog watchdog = new Watchdog();
    private final Seq<BuildPlan> ownPlans = new Seq<>();
    private final IntSet rejectedSites = new IntSet();
    private final Vec2 move = new Vec2();

    // v2.0 pro runtime (chokepoint kill-box, ammo bus, flank RTS, Gemma brain)
    final ProRuntime pro = new ProRuntime(this);
    private final java.util.HashSet<String> proErrors = new java.util.HashSet<>();
    private int prevEnemies;

    private float nextDecisionTime;
    private float nextResearchTime;
    private float settleUntilTime;
    private float capturedSinceSec = -1f;
    private float lastWaveCallSec = -1e9f;
    private float deadSinceSec = -1f;
    private boolean transitionPending = false;

    // Unit movement target
    private boolean hasTarget;
    private float targetX, targetY, arriveDistance;

    // Item transfer state (used for both turret rearming and factory courier)
    private int transferStage;
    private Building transferTarget;
    private Item transferItem;
    private String transferLabel = "";

    // Squad assault state
    private int squadMode = SQUAD_RALLY;

    // Candidate plans prepared during observation
    private final Seq<BuildPlan> coreUpgradePlans = new Seq<>();
    private final Seq<BuildPlan> powerPlans = new Seq<>();
    private final Seq<BuildPlan> defensePlans = new Seq<>();
    private final Seq<BuildPlan> rebuildPlans = new Seq<>();
    private final Seq<BuildPlan> drillPlans = new Seq<>();
    private final Seq<BuildPlan> industryPlans = new Seq<>();
    private final Seq<BuildPlan> armyPlans = new Seq<>();
    private Building rearmCandidate;
    private Item rearmCandidateItem;
    private Building courierCandidate;
    private Item courierCandidateItem;
    private Tile mineCandidate;
    private String corePlanLabel = "";
    private String powerPlanLabel = "";
    private String drillPlanLabel = "";
    private String industryPlanLabel = "";
    private String armyPlanLabel = "";

    public SectorAutopilot(){
        if(Core.settings != null && Core.settings.getBool(PREF_ENABLED, false)){
            state = RUNNING;
            lastAction = "автовосстановление после запуска";
        }

        Events.run(Trigger.update, this::updateInGame);

        // Background 2-second heartbeat so the bot also acts on the Planet Map / Menu!
        Timer.schedule(() -> {
            if(Core.app != null){
                Core.app.post(this::updateOutOfGame);
            }
        }, 2f, 2f);

        Events.on(WorldLoadEvent.class, event -> {
            resetTransientSectorState();
            settleUntilTime = Time.time + 90f;
            transitionPending = false;
            if(state == RUNNING){
                String why = guardReason(buildGuard());
                if(why != null){
                    pauseWithReason("пауза: " + why);
                }else{
                    Sector sec = Vars.state.getSector();
                    log("загружен сектор " + (sec == null ? "?" : sec.name()) + " — разворачиваю базу");
                }
            }
        });

        Events.on(SectorCaptureEvent.class, event -> {
            if(state == RUNNING){
                capturedSinceSec = Time.time / 60f;
                log("сектор " + (event.sector == null ? "" : event.sector.name() + " ") + "захвачен ✅");
                director.runResearchPass();
                checkVictory();
            }
        });

        Events.on(GameOverEvent.class, event -> {
            if(state == RUNNING){
                Sector lost = Vars.state != null ? Vars.state.getSector() : null;
                director.recordSectorLoss(lost);
                int losses = director.getLosses(lost);
                haltUnitActions();
                if(losses >= MAX_SECTOR_LOSSES){
                    fail("сектор " + (lost == null ? "" : lost.name()) + " потерян " + losses + " раза подряд");
                }else{
                    log("ядро потеряно (попытка " + losses + "/" + MAX_SECTOR_LOSSES + ") — перегруппировка");
                    transitionPending = true;
                    Timer.schedule(() -> Core.app.post(() -> {
                        if(state == RUNNING){
                            transitionPending = false;
                            director.launchNextSector(null);
                        }
                    }), 3.5f);
                }
            }
        });
    }

    private void resetTransientSectorState(){
        try{
            pro.onWorldLoad();
        }catch(Throwable t){
            proFail("сброс", t);
        }
        prevEnemies = 0;
        ownPlans.clear();
        rejectedSites.clear();
        watchdog.reset();
        hasTarget = false;
        transferStage = 0;
        transferTarget = null;
        transferItem = null;
        squadMode = SQUAD_RALLY;
        nextDecisionTime = 0f;
        nextResearchTime = 0f;
        capturedSinceSec = -1f;
        lastWaveCallSec = -1e9f;
        deadSinceSec = -1f;
    }

    // ------------------------------------------------------------- controls

    public void start(){
        String why = guardReason(buildGuard());
        if(why != null){
            reason = "запуск невозможен: " + why;
            log(reason);
            return;
        }
        state = transition(state, CMD_START);
        saveEnabledPref(true);
        reason = "";
        watchdog.reset();
        transitionPending = false;
        nextDecisionTime = 0f;
        log("автопрохождение кампании Serpulo включено ▶");

        if(Vars.state == null || !Vars.state.isGame()){
            updateOutOfGame();
        }
    }

    public void pause(){
        if(state != RUNNING) return;
        pauseWithReason("пауза — нажмите ▶, чтобы продолжить");
    }

    private void pauseWithReason(String msg){
        state = transition(state, CMD_PAUSE);
        saveEnabledPref(false);
        hasTarget = false;
        clearMining();
        reason = msg;
        log(msg);
    }

    public void stop(){
        if(state == OFF) return;
        haltUnitActions();
        state = transition(state, CMD_STOP);
        saveEnabledPref(false);
        transitionPending = false;
        reason = "остановлен игроком";
        log(reason);
    }

    private void saveEnabledPref(boolean enabled){
        if(Core.settings != null){
            Core.settings.put(PREF_ENABLED, enabled);
        }
    }

    private boolean checkVictory(){
        if(director.isCampaignWon()){
            haltUnitActions();
            state = transition(state, CMD_VICTORY);
            saveEnabledPref(false);
            reason = "Planetary Launch Terminal захвачен и межпланетный ускоритель открыт! 🏆";
            lastAction = reason;
            log(reason);
            return true;
        }
        return false;
    }

    // --------------------------------------------- planet map / menu loop

    private void updateOutOfGame(){
        if(state != RUNNING || transitionPending) return;
        if(Vars.state != null && Vars.state.isGame()) return;
        if(Vars.net != null && Vars.net.active()){
            pauseWithReason("сетевая игра — автопилот поставлен на паузу");
            return;
        }
        try{
            director.runResearchPass();
            if(checkVictory()) return;
            transitionPending = true;
            lastAction = "выбираю следующий сектор на карте Serpulo...";
            if(!director.launchNextSector(null)){
                transitionPending = false;
                fail("не найден доступный сектор Serpulo для вылета");
            }else{
                log("вылетаю в сектор: " + director.nextTargetSummary);
            }
        }catch(Throwable t){
            transitionPending = false;
            Log.err("[serpulo-campaign-bot] out-of-game error", t);
        }
    }

    // ------------------------------------------------------- in-sector loop

    private void updateInGame(){
        if(state != RUNNING) return;
        try{
            if(Vars.state == null || !Vars.state.isGame()) return;
            String why = guardReason(buildGuard());
            if(why != null){
                pauseWithReason(why);
                return;
            }
            if(Vars.state.isPaused() || Vars.state.gameOver) return;
            if(Time.time < settleUntilTime) return;

            Unit unit = Vars.player == null ? null : Vars.player.unit();
            boolean alive = unit != null && unit.isValid() && !Vars.player.dead();
            if(alive){
                steerUnit(unit);
                assistDefenseFire(unit);
            }

            if(Time.time < nextDecisionTime) return;
            nextDecisionTime = Time.time + DECISION_INTERVAL_TICKS;
            thinkInSector(alive ? unit : null);
        }catch(Throwable error){
            Log.err("[serpulo-campaign-bot] sector error", error);
            fail("ошибка ИИ: " + error.getClass().getSimpleName());
        }
    }

    private void steerUnit(Unit unit){
        float tx, ty, arrive;
        BuildPlan plan = unit.plans.size > 0 ? unit.buildPlan() : null;
        if(plan != null){
            tx = plan.drawx();
            ty = plan.drawy();
            arrive = unit.type.buildRange * 0.55f;
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

    /** Lets the player core unit auto-shoot nearby enemies while flying around the base. */
    private void assistDefenseFire(Unit unit){
        if(unit.type == null || !unit.type.canAttack) return;
        Unit enemy = Units.closestEnemy(unit.team, unit.x, unit.y, unit.range(), u -> !u.dead());
        if(enemy != null){
            unit.aim(enemy);
            unit.controlWeapons(true, true);
        }else{
            unit.controlWeapons(false, false);
        }
    }

    private void setTarget(float x, float y, float arrive){
        hasTarget = true;
        targetX = x;
        targetY = y;
        arriveDistance = arrive;
    }

    // --------------------------------------------------- main sector decision

    private void thinkInSector(Unit unit){
        float nowSec = Time.time / 60f;
        Sector sector = Vars.state.getSector();

        if(Time.time >= nextResearchTime){
            nextResearchTime = Time.time + 180f;
            String unlocked = director.runResearchPass();
            if(unlocked != null){
                log("наука: изучено " + unlocked);
            }
            if(checkVictory()) return;
        }

        Team team = Vars.player.team();
        CoreBuild core = Vars.player.closestCore();
        if(core == null){
            lastAction = "ожидание ядра...";
            return;
        }
        TeamData data = Vars.state.teams.get(team);

        // Keep UnitFactories, PowerNodes, Support Drones, and Combat Squads updated every cycle!
        maintainFactoryConfigsAndLinks(data, team);
        updateSupportAndCombatUnits(data, core, team, sector);

        boolean captured = sector != null && sector.isCaptured();
        if(captured && capturedSinceSec < 0f) capturedSinceSec = nowSec;

        try{
            pro.enter(sector, core, nowSec);
            pro.stepScan(core);
            pro.updateHeat(data, team, core, nowSec);
        }catch(Throwable t){
            proFail("разведка", t);
        }

        SectorObservation o = new SectorObservation();
        o.captured = captured;
        o.attackMode = Vars.state.rules.attackMode;
        o.playerAlive = unit != null;

        if(captured){
            float fillFrac = coreFillFraction(core);
            boolean producesNeeded = sectorProducesNeededItem(sector, data);
            o.holdAfterCapture = director.shouldHoldCurrentSector(
                    sector,
                    Math.max(0f, nowSec - capturedSinceSec),
                    fillFrac,
                    producesNeeded);
        }

        if(unit == null){
            if(deadSinceSec < 0f) deadSinceSec = nowSec;
            if(nowSec - deadSinceSec > RESPAWN_WAIT_SECONDS){
                fail("юнит ядра не возрождается дольше " + (int)RESPAWN_WAIT_SECONDS + " с");
                return;
            }
            lastAction = "ждём возрождения юнита";
            transferStage = 0;
            return;
        }
        deadSinceSec = -1f;

        // Prune finished plans & run anti-stall watchdog.
        for(int i = ownPlans.size - 1; i >= 0; i--){
            if(unit.plans.indexOf(ownPlans.get(i), true) < 0) ownPlans.remove(i);
        }
        BuildPlan headPlan = unit.plans.size > 0 ? unit.buildPlan() : null;
        long token = (Vars.state.stats != null ? Vars.state.stats.buildingsBuilt : 0L) * 1_000_000L
                + unit.plans.size * 1000L + (headPlan != null ? (int)(headPlan.progress * 999f) : 0);
        if(watchdog.stalled(unit.plans.size > 0, token, nowSec)){
            if(headPlan != null){
                rejectedSites.add(pack(headPlan.x, headPlan.y));
            }
            cancelOwnPlans(unit);
            watchdog.reset();
            log("строительство застряло — сбрасываю проблемный план и выбираю другое место");
        }
        if(unit.plans.size > 0){
            Vars.control.input.isBuilding = true;
        }

        o.buildQueue = unit.plans.size;
        o.rearmInProgress = transferStage != 0 && transferTarget != null && transferTarget.isValid();
        if(!o.rearmInProgress) transferStage = 0;

        int[] budget = coreBudget(core);
        float netPowerPerSec = computeNetPowerPerSec(data);
        o.drills = countDrills(data);
        o.powerNeeded = hasPowerDeficitOrUnlinked(data, netPowerPerSec);

        java.util.HashMap<String, Boolean> usableMap = new java.util.HashMap<>();
        java.util.HashMap<String, Integer> stockMap = new java.util.HashMap<>();
        try{
            usableMap = pro.usableMap();
            stockMap = pro.stockMap(core);
            LlmBrain.Plan brainPlan = pro.think(core, data, team, netPowerPerSec, usableMap, stockMap, nowSec);
            if(brainPlan != null){
                o.priority = brainPlan.priority;
                o.aggression = brainPlan.aggression;
            }
            pro.retuneBus(team, nowSec);
            pro.reactorWatch(data);
        }catch(Throwable t){
            proFail("мозг", t);
        }

        boolean idle = o.buildQueue == 0 && !o.rearmInProgress;
        if(idle){
            o.rearmTargets = findRearmTarget(data, core) ? 1 : 0;
            o.coreUpgradeReady = planCoreOrVaultUpgrade(core, data, team, budget);
            o.powerPossible = planPowerExpansion(core, data, team, budget, netPowerPerSec);
            o.rebuildSlots = collectRebuild(data, team, budget);
            if(!captured){
                int proSlots = -1;
                try{
                    int wsize = WINDOW_RADIUS * 2 + 1;
                    int[] wcells = new int[wsize * wsize], wore = new int[wsize * wsize];
                    int[] worigin = buildWindow(core, team, wcells, wore);
                    proSlots = pro.planDefense(core, data, team, budget, wcells, worigin, wsize, netPowerPerSec, usableMap, stockMap, defensePlans);
                }catch(Throwable t){
                    proFail("оборона", t);
                    proSlots = -1;
                }
                o.defenseSlots = proSlots >= 0 ? proSlots : planFortressDefense(core, data, team, budget);
            }
            if(o.drills < MAX_DRILLS) o.drillPossible = planDrillAndConveyor(core, data, team, budget, netPowerPerSec);
            o.industryPossible = planIndustry(core, data, team, budget, netPowerPerSec);
            if(!o.industryPossible){
                try{
                    int rsize = WINDOW_RADIUS * 2 + 1;
                    int[] rcells = new int[rsize * rsize], rore = new int[rsize * rsize];
                    int[] rorigin = buildWindow(core, team, rcells, rore);
                    industryPlans.clear();
                    if(pro.planReactor(core, data, team, budget, usableMap, stockMap, netPowerPerSec, rcells, rorigin, rsize, industryPlans)){
                        o.industryPossible = true;
                        industryPlanLabel = "Thorium Reactor + криомиксер";
                    }
                }catch(Throwable t){
                    proFail("реактор", t);
                }
            }
            o.armyPossible = false;
            if(netPowerPerSec >= 15f && core.items.get(Items.silicon) >= 45
                    && (o.attackMode || "BUILD_T3_AIR_FLANK".equals(o.priority) || "BUILD_ARMY".equals(o.priority))){
                try{
                    o.armyPossible = planProUnitChain(core, data, team, budget, usableMap, sector);
                }catch(Throwable t){
                    proFail("цепочка юнитов", t);
                }
            }
            if(!o.armyPossible) o.armyPossible = planArmy(core, data, team, budget, o.attackMode, netPowerPerSec);
            o.courierPossible = findCourierTarget(data, core);
            mineCandidate = findMineTile(unit, core, team);
            o.minePossible = mineCandidate != null;
        }

        // Wave survival observation
        o.waves = Vars.state.rules.waves;
        o.waveSending = Vars.state.rules.waveSending;
        o.waveTimer = Vars.state.rules.waveTimer;
        o.spawning = Vars.spawner.isSpawning();
        o.enemies = Vars.state.enemies;
        o.wave = Vars.state.wave;
        o.winWave = Vars.state.rules.winWave;
        o.waveTimeSec = Vars.state.rules.waveTimer ? Vars.state.wavetime / 60f : -1f;
        o.secondsSinceWaveCall = nowSec - lastWaveCallSec;
        o.coreHealthFrac = minCoreHealth(data);
        float[] defStats = computeDefenseStats(data, team);
        o.defenseDps = defStats[0];
        o.defensePoolHp = defStats[1];
        pro.lastDps = defStats[0];
        if(prevEnemies > 0 && o.enemies == 0){
            try{
                pro.afterWave(core);
                pro.brain.markEvent("wave");
            }catch(Throwable t){
                proFail("разбор волны", t);
            }
        }
        prevEnemies = o.enemies;
        float[] waveStats = computeNextWaveStats(Vars.state.wave - 1);
        o.nextWaveHp = waveStats[0];
        o.nextWaveDps = waveStats[1];

        Decision decision = decideSector(o);
        if(decision.action != ACT_MINE) clearMining();
        if(decision.action != ACT_MINE && decision.action != ACT_REARM && decision.action != ACT_COURIER){
            hasTarget = false;
        }
        executeDecision(decision, unit, core, sector, nowSec);
    }

    private void executeDecision(Decision decision, Unit unit, CoreBuild core, Sector sector, float nowSec){
        switch(decision.action){
            case ACT_READY_NEXT_SECTOR:
                if(!transitionPending){
                    director.runResearchPass();
                    if(checkVictory()) return;
                    transitionPending = true;
                    if(director.launchNextSector(sector)){
                        action("переход в следующий сектор: " + director.nextTargetSummary);
                    }else{
                        transitionPending = false;
                        lastAction = "копим ресурсы для открытия следующего сектора";
                    }
                }
                break;
            case ACT_UPGRADE_CORE:
                queuePlans(unit, coreUpgradePlans);
                action("улучшаю ядро / хранилище (" + corePlanLabel + ")");
                break;
            case ACT_REARM:
                if(transferStage == 0 && rearmCandidate != null){
                    transferTarget = rearmCandidate;
                    transferItem = rearmCandidateItem;
                    transferLabel = "боеприпасы -> " + rearmCandidate.block.localizedName;
                    transferStage = 1;
                }
                runItemTransfer(unit, core);
                break;
            case ACT_COURIER:
                if(transferStage == 0 && courierCandidate != null){
                    transferTarget = courierCandidate;
                    transferItem = courierCandidateItem;
                    transferLabel = courierCandidateItem.localizedName + " -> " + courierCandidate.block.localizedName;
                    transferStage = 1;
                }
                runItemTransfer(unit, core);
                break;
            case ACT_POWER:
                queuePlans(unit, powerPlans);
                action("энергетика: " + powerPlanLabel);
                break;
            case ACT_DEFEND:
                queuePlans(unit, defensePlans);
                action("укрепляю оборону (" + defensePlans.size + " блоков)");
                break;
            case ACT_REBUILD:
                queuePlans(unit, rebuildPlans);
                action("восстанавливаю разрушенное (" + rebuildPlans.size + ")");
                break;
            case ACT_DRILL:
                queuePlans(unit, drillPlans);
                action("ставлю бур: " + drillPlanLabel);
                break;
            case ACT_INDUSTRY:
                queuePlans(unit, industryPlans);
                action("завод: " + industryPlanLabel);
                break;
            case ACT_ARMY:
                queuePlans(unit, armyPlans);
                action("армия: " + armyPlanLabel);
                break;
            case ACT_CALL_WAVE:
                Vars.logic.skipWave();
                lastWaveCallSec = nowSec;
                action("вызываю волну " + Vars.state.wave);
                break;
            case ACT_MINE:
                executeMine(unit);
                lastAction = "добываю " + (mineCandidate != null && mineCandidate.drop() != null
                        ? mineCandidate.drop().localizedName : "руду") + " · " + decision.reason;
                break;
            default:
                lastAction = decision.reason;
                break;
        }
    }

    // ----------------------------- factory configuration, power & RTS army

    private void maintainFactoryConfigsAndLinks(TeamData data, Team team){
        int supportAir = data.countType(UnitTypes.mono) + data.countType(UnitTypes.poly) + data.countType(UnitTypes.mega);
        int unitCap = Units.getCap(team);
        int desiredSupportAir = Math.min(4, Math.max(2, unitCap / 3));

        for(Building b : data.buildings){
            if(b instanceof UnitFactoryBuild ufb && b.block instanceof UnitFactory uf){
                int desiredPlan = chooseFactoryPlan(uf, supportAir < desiredSupportAir);
                if(desiredPlan >= 0 && ufb.currentPlan != desiredPlan){
                    Call.tileConfig(Vars.player, ufb, desiredPlan);
                }
            }else if(b instanceof PowerNodeBuild pnb && b.block instanceof PowerNode pn){
                if(pnb.power.links.size < pn.maxNodes){
                    for(Building other : data.buildings){
                        if(pnb.power.links.size >= pn.maxNodes) break;
                        if(other == pnb || other.power == null || !other.block.hasPower) continue;
                        if(pnb.power.graph == other.power.graph) continue;
                        if(pn.linkValid(pnb, other) && !PowerNode.insulated(pnb, other)){
                            Call.tileConfig(Vars.player, pnb, other.pos());
                        }
                    }
                }
            }
        }
    }

    private int chooseFactoryPlan(UnitFactory uf, boolean wantSupportDrone){
        if(uf == Blocks.airFactory){
            if(wantSupportDrone){
                int monoIdx = findPlanIndex(uf, UnitTypes.mono);
                if(monoIdx >= 0) return monoIdx;
            }
            int flareIdx = findPlanIndex(uf, UnitTypes.flare);
            if(flareIdx >= 0) return flareIdx;
        }else if(uf == Blocks.groundFactory){
            // Prefer dagger -> mace -> fortress (solid all-rounder), fallback nova or crawler.
            for(UnitType t : new UnitType[]{UnitTypes.dagger, UnitTypes.nova, UnitTypes.crawler}){
                int idx = findPlanIndex(uf, t);
                if(idx >= 0) return idx;
            }
        }else if(uf == Blocks.navalFactory){
            for(UnitType t : new UnitType[]{UnitTypes.risso, UnitTypes.retusa}){
                int idx = findPlanIndex(uf, t);
                if(idx >= 0) return idx;
            }
        }
        for(int i = 0; i < uf.plans.size; i++){
            if(uf.plans.get(i).unit.unlockedNow() && !uf.plans.get(i).unit.isBanned()) return i;
        }
        return -1;
    }

    private int findPlanIndex(UnitFactory uf, UnitType type){
        if(type == null || !type.unlockedNow() || type.isBanned()) return -1;
        for(int i = 0; i < uf.plans.size; i++){
            if(uf.plans.get(i).unit == type) return i;
        }
        return -1;
    }

    private void updateSupportAndCombatUnits(TeamData data, CoreBuild core, Team team, Sector sector){
        Seq<Unit> combatUnits = new Seq<>();
        Unit playerUnit = Vars.player == null ? null : Vars.player.unit();

        // Java: Unit.dead() is a real method of Healthc, so this call is safe here.
        // Only the Rhino (script/ZIP) edition sees `dead` as a boolean field and must use unitDead().
        Groups.unit.each(u -> {
            if(u.team != team || u == playerUnit || u.dead() || !u.isCommandable()) return;
            CommandAI ai = u.command();
            if(u.type == UnitTypes.mono){
                if(ai.command != UnitCommand.mineCommand) ai.command(UnitCommand.mineCommand);
                return;
            }
            if(u.type == UnitTypes.poly){
                UnitCommand cmd = data.plans.size > 0 ? UnitCommand.rebuildCommand : UnitCommand.assistCommand;
                if(ai.command != cmd) ai.command(cmd);
                return;
            }
            if(u.type == UnitTypes.mega || u.type == UnitTypes.retusa || u.type == UnitTypes.oxynoe){
                if(ai.command != UnitCommand.repairCommand) ai.command(UnitCommand.repairCommand);
                return;
            }
            if(u.type.canAttack){
                combatUnits.add(u);
            }
        });

        int enemiesNearCore = 0;
        Unit closestNearEnemy = Units.closestEnemy(team, core.x, core.y, 42f * Vars.tilesize, e -> !e.dead());
        if(closestNearEnemy != null) enemiesNearCore = 1;

        float diff = sector != null && sector.preset != null ? sector.preset.difficulty : 4f;
        int unitCap = Units.getCap(team);
        squadMode = decideSquadMode(
                Vars.state.rules.attackMode,
                squadMode,
                combatUnits.size,
                unitCap,
                enemiesNearCore,
                diff);

        pro.armyCount = combatUnits.size;
        if(combatUnits.isEmpty()){
            armySummary = "0/" + unitCap + " боевых";
            return;
        }

        int[] ids = new int[Math.min(combatUnits.size, 180)];
        for(int i = 0; i < ids.length; i++){
            Unit u = combatUnits.get(i);
            ids[i] = u.id;
            CommandAI ai = u.command();
            ai.setStance(UnitStance.pursueTarget, true);
            if(u.type.canBoost){
                ai.setStance(UnitStance.boost, true);
            }
        }

        if(squadMode == SQUAD_DEFEND && closestNearEnemy != null){
            Call.commandUnits(Vars.player, ids, null, closestNearEnemy, new Vec2(closestNearEnemy.x, closestNearEnemy.y), false, true);
            armySummary = combatUnits.size + "/" + unitCap + " · защита базы";
        }else if(squadMode == SQUAD_ASSAULT){
            ProRuntime.AssaultOrder order = null;
            try{
                order = assaultWithRetreat(combatUnits, core, team, unitCap);
            }catch(Throwable t){
                proFail("RTS", t);
            }
            if(order != null) return;
            Building enemyTarget = findAssaultBuildingTarget(core, Vars.state.rules.waveTeam);
            if(enemyTarget != null){
                Call.commandUnits(Vars.player, ids, enemyTarget, null, new Vec2(enemyTarget.x, enemyTarget.y), false, true);
                armySummary = combatUnits.size + "/" + unitCap + " · штурм (" + enemyTarget.block.localizedName + ")";
            }else if(closestNearEnemy != null){
                Call.commandUnits(Vars.player, ids, null, closestNearEnemy, new Vec2(closestNearEnemy.x, closestNearEnemy.y), false, true);
                armySummary = combatUnits.size + "/" + unitCap + " · зачистка врагов";
            }
        }else{
            Vec2 rally = computeRallyPoint(core);
            Call.commandUnits(Vars.player, ids, null, null, rally, false, true);
            armySummary = combatUnits.size + "/" + unitCap + " · сбор у рубежа";
        }
    }

    /**
     * v2.0 RTS: priority target (generators, nodes, ammo feeds first), flank route around enemy turret range and
     * retreat of wounded units (<45% HP, hysteresis) to the nearest repair spot. Returns null to fall back to v1.
     */
    private ProRuntime.AssaultOrder assaultWithRetreat(Seq<Unit> combatUnits, CoreBuild core, Team team, int unitCap){
        float nowSec = Time.time / 60f;
        ProRuntime.AssaultOrder order = pro.assaultOrder(combatUnits, core, team, nowSec);
        if(order == null) return null;
        Seq<Unit> healthy = new Seq<>(), wounded = new Seq<>();
        for(Unit u : combatUnits){
            boolean was = pro.retreating.containsKey(u.id);
            boolean back = ProLogic.shouldRetreat(u.health / Math.max(1f, u.maxHealth), was);
            if(back) pro.retreating.put(u.id, Boolean.TRUE);
            else pro.retreating.remove(u.id);
            (back ? wounded : healthy).add(u);
        }
        if(wounded.size > 0){
            int[] wid = new int[Math.min(wounded.size, 180)];
            for(int i = 0; i < wid.length; i++) wid[i] = wounded.get(i).id;
            Call.commandUnits(Vars.player, wid, null, null, pro.repairSpot(team, core), false, true);
        }
        if(healthy.size > 0){
            int[] hid = new int[Math.min(healthy.size, 180)];
            for(int i = 0; i < hid.length; i++) hid[i] = healthy.get(i).id;
            if(order.last && order.target != null && order.target.isValid()){
                Call.commandUnits(Vars.player, hid, order.target, null, new Vec2(order.target.x, order.target.y), false, true);
            }else{
                Call.commandUnits(Vars.player, hid, null, null, new Vec2(order.wx, order.wy), false, true);
            }
        }
        pro.armyCount = combatUnits.size;
        armySummary = combatUnits.size + "/" + unitCap + " · штурм"
                + (order.target != null ? " (" + order.target.block.localizedName + ")" : "")
                + (order.flank ? " · обход по флангу" : "")
                + (wounded.size > 0 ? " · отвод раненых: " + wounded.size : "");
        return order;
    }

    private Building findAssaultBuildingTarget(CoreBuild ourCore, Team enemyTeam){
        TeamData enemyData = Vars.state.teams.get(enemyTeam);
        if(enemyData == null) return null;

        CoreBuild enemyCore = null;
        float bestCoreDst = Float.MAX_VALUE;
        for(CoreBuild c : enemyData.cores){
            float d = c.dst(ourCore);
            if(d < bestCoreDst){
                bestCoreDst = d;
                enemyCore = c;
            }
        }
        // Check if an enemy turret or unit factory sits along the corridor to the enemy core; clear it or strike core.
        Building bestTurret = null;
        float bestTurretDst = Float.MAX_VALUE;
        for(Building b : enemyData.buildings){
            if(b instanceof TurretBuild || b instanceof UnitFactoryBuild){
                float d = b.dst(ourCore);
                if(d < bestTurretDst && (enemyCore == null || d < bestCoreDst - 10f * Vars.tilesize)){
                    bestTurretDst = d;
                    bestTurret = b;
                }
            }
        }
        return bestTurret != null ? bestTurret : enemyCore;
    }

    private Vec2 computeRallyPoint(CoreBuild core){
        float dirX = 1f, dirY = 0f;
        TeamData enemyData = Vars.state.teams.get(Vars.state.rules.waveTeam);
        if(enemyData != null && !enemyData.cores.isEmpty()){
            CoreBuild ec = enemyData.cores.first();
            dirX = ec.x - core.x;
            dirY = ec.y - core.y;
        }else if(!Vars.spawner.getSpawns().isEmpty()){
            Tile sp = Vars.spawner.getSpawns().first();
            dirX = sp.worldx() - core.x;
            dirY = sp.worldy() - core.y;
        }
        float len = Math.max(1f, Mathf.len(dirX, dirY));
        float dist = Math.min(len * 0.35f, 18f * Vars.tilesize);
        float rx = Mathf.clamp(core.x + (dirX / len) * dist, 32f, Vars.world.unitWidth() - 32f);
        float ry = Mathf.clamp(core.y + (dirY / len) * dist, 32f, Vars.world.unitHeight() - 32f);
        return new Vec2(rx, ry);
    }

    // ----------------------------------------- core upgrade & storage vaults

    private boolean planCoreOrVaultUpgrade(CoreBuild core, TeamData data, Team team, int[] budget){
        coreUpgradePlans.clear();

        // 1. Direct Core upgrade: Shard -> Foundation -> Nucleus
        for(Block nextCore : new Block[]{Blocks.coreNucleus, Blocks.coreFoundation}){
            if(!(nextCore instanceof CoreBlock cb) || !usable(cb)) continue;
            if(cb.size <= core.block.size) continue;
            if(Build.validPlace(cb, team, core.tileX(), core.tileY(), 0) && reserve(budget, cb, 1)){
                coreUpgradePlans.add(new BuildPlan(core.tileX(), core.tileY(), 0, cb));
                corePlanLabel = cb.localizedName;
                return true;
            }
        }

        // 2. Attach up to 2 Vaults/Containers directly touching the Core when storage > 65% full
        if(coreFillFraction(core) < 0.65f) return false;
        int linkedStorages = 0;
        for(Building b : data.buildings){
            if(b instanceof StorageBuild sb && sb.linkedCore != null) linkedStorages++;
        }
        if(linkedStorages >= 2) return false;

        for(Block storage : new Block[]{Blocks.vault, Blocks.container}){
            if(!usable(storage)) continue;
            int[] work = budget.clone();
            if(!reserve(work, storage, 1)) continue;

            int size = WINDOW_RADIUS * 2 + 1;
            int[] cells = new int[size * size], ore = new int[size * size];
            int[] origin = buildWindow(core, team, cells, ore);
            HubCrafterSlot slot = findHubCrafterSlot(size, size, cells, ore, storage.size, false, 0);
            if(slot == null) continue;
            int wx = origin[0] + slot.crafterX, wy = origin[1] + slot.crafterY;
            if(!Build.validPlace(storage, team, wx, wy, 0)) continue;

            System.arraycopy(work, 0, budget, 0, budget.length);
            coreUpgradePlans.add(new BuildPlan(wx, wy, 0, storage));
            corePlanLabel = storage.localizedName;
            return true;
        }
        return false;
    }

    // ------------------------------------------------------ power expansion

    private float computeNetPowerPerSec(TeamData data){
        ObjectSet<PowerGraph> seen = new ObjectSet<>();
        float net = 0f;
        for(Building b : data.buildings){
            if(b.power != null && b.power.graph != null && seen.add(b.power.graph)){
                net += b.power.graph.getPowerBalance() * 60f;
            }
        }
        return net;
    }

    private boolean hasPowerDeficitOrUnlinked(TeamData data, float netPowerPerSec){
        if(!usable(Blocks.powerNode)) return false;
        int generators = 0, unpoweredConsumers = 0;
        for(Building b : data.buildings){
            if(b.block.outputsPower) generators++;
            if(b.block.consumesPower && b.power != null && (b.power.graph == null || b.power.graph.producers.isEmpty())){
                unpoweredConsumers++;
            }
        }
        if(unpoweredConsumers > 0) return true;
        if(generators == 0 && (usable(Blocks.combustionGenerator) || usable(Blocks.solarPanel) || usable(Blocks.thermalGenerator))){
            return countDrills(data) >= 3;
        }
        return netPowerPerSec < 90f && generators < 10;
    }

    private boolean planPowerExpansion(CoreBuild core, TeamData data, Team team, int[] budget, float netPowerPerSec){
        powerPlans.clear();
        if(!usable(Blocks.powerNode)) return false;

        // 1. Bridge any unlinked powered building to the nearest generator/powerNode!
        Building unpowered = null;
        for(Building b : data.buildings){
            if(b.block.consumesPower && b.power != null && b.power.graph.producers.isEmpty()){
                unpowered = b;
                break;
            }
        }
        Building poweredAnchor = null;
        float bestAnchorDst = Float.MAX_VALUE;
        if(unpowered != null){
            for(Building b : data.buildings){
                if((b.block.outputsPower || b instanceof PowerNodeBuild) && b.power != null && !b.power.graph.producers.isEmpty()){
                    float d = b.dst(unpowered);
                    if(d < bestAnchorDst){
                        bestAnchorDst = d;
                        poweredAnchor = b;
                    }
                }
            }
        }
        if(unpowered != null && poweredAnchor != null){
            Block nodeBlock = usable(Blocks.powerNodeLarge) && bestAnchorDst > 7f * Vars.tilesize
                    ? Blocks.powerNodeLarge : Blocks.powerNode;
            float stepRange = (nodeBlock == Blocks.powerNodeLarge ? 12f : 5f) * Vars.tilesize;
            float ratio = Math.min(1f, stepRange / Math.max(1f, bestAnchorDst));
            int tx = World_toTile(Mathf.lerp(poweredAnchor.x, unpowered.x, ratio));
            int ty = World_toTile(Mathf.lerp(poweredAnchor.y, unpowered.y, ratio));
            int[] place = findValidSpotNear(nodeBlock, team, tx, ty, 3);
            if(place != null && reserve(budget, nodeBlock, 1)){
                powerPlans.add(new BuildPlan(place[0], place[1], 0, nodeBlock));
                powerPlanLabel = nodeBlock.localizedName + " (связь энергосети)";
                return true;
            }
        }

        if(netPowerPerSec >= 240f) return false;

        // 2. Thermal Generator on any magma/hot tile near base (free infinite power!)
        if(usable(Blocks.thermalGenerator)){
            for(int r = 3; r <= 36; r += 2){
                for(int dy = -r; dy <= r; dy += 2){
                    for(int dx = -r; dx <= r; dx += 2){
                        if(Math.max(Math.abs(dx), Math.abs(dy)) < r - 1) continue;
                        int wx = core.tileX() + dx, wy = core.tileY() + dy;
                        if(Build.validPlace(Blocks.thermalGenerator, team, wx, wy, 0)){
                            int[] work = budget.clone();
                            if(reserve(work, Blocks.thermalGenerator, 1) && reserve(work, Blocks.powerNode, 1)){
                                int[] np = findValidSpotNear(Blocks.powerNode, team, wx + 2, wy, 2);
                                System.arraycopy(work, 0, budget, 0, budget.length);
                                powerPlans.add(new BuildPlan(wx, wy, 0, Blocks.thermalGenerator));
                                if(np != null) powerPlans.add(new BuildPlan(np[0], np[1], 0, Blocks.powerNode));
                                powerPlanLabel = Blocks.thermalGenerator.localizedName;
                                return true;
                            }
                        }
                    }
                }
            }
        }

        int size = WINDOW_RADIUS * 2 + 1;
        int[] cells = new int[size * size], ore = new int[size * size];
        int[] origin = buildWindow(core, team, cells, ore);
        boolean hasUnloader = usable(Blocks.unloader);

        // 3. RTG Generator touching Core (uses tiny thorium, super safe!)
        if(usable(Blocks.rtgGenerator) && core.items.get(Items.thorium) >= 40){
            if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.rtgGenerator, hasUnloader, null, powerPlans)){
                powerPlanLabel = industryPlanLabel;
                return true;
            }
        }

        // 4. Steam Generator + WaterExtractor around Core when coal or sporePod is available
        if(usable(Blocks.steamGenerator) && usable(Blocks.waterExtractor)
                && (core.items.get(Items.coal) >= 25 || core.items.get(Items.sporePod) >= 25)){
            if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.steamGenerator, hasUnloader, Blocks.waterExtractor, powerPlans)){
                powerPlanLabel = industryPlanLabel;
                return true;
            }
        }

        // 5. Combustion Generator directly touching an existing Coal drill, or Core hub
        if(usable(Blocks.combustionGenerator)){
            for(Building b : data.buildings){
                if(b.block instanceof Drill && b.tile != null && b.tile.drop() == Items.coal){
                    int[] spot = findAdjacentSpotToBuilding(Blocks.combustionGenerator, team, b);
                    if(spot != null){
                        int[] work = budget.clone();
                        if(reserve(work, Blocks.combustionGenerator, 1)){
                            System.arraycopy(work, 0, budget, 0, budget.length);
                            powerPlans.add(new BuildPlan(spot[0], spot[1], 0, Blocks.combustionGenerator));
                            int[] np = findValidSpotNear(Blocks.powerNode, team, spot[0] + 1, spot[1], 2);
                            if(np != null && reserve(budget, Blocks.powerNode, 1)){
                                powerPlans.add(new BuildPlan(np[0], np[1], 0, Blocks.powerNode));
                            }
                            if(usable(Blocks.battery)){
                                int[] bp = findValidSpotNear(Blocks.battery, team, spot[0], spot[1] + 1, 2);
                                if(bp != null && reserve(budget, Blocks.battery, 1)){
                                    powerPlans.add(new BuildPlan(bp[0], bp[1], 0, Blocks.battery));
                                }
                            }
                            powerPlanLabel = Blocks.combustionGenerator.localizedName + " у угольного бура";
                            return true;
                        }
                    }
                }
            }
            if(core.items.get(Items.coal) >= 20 || core.items.get(Items.sporePod) >= 20){
                if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.combustionGenerator, hasUnloader, null, powerPlans)){
                    powerPlanLabel = industryPlanLabel;
                    return true;
                }
            }
        }

        // 6. Solar fallback when map lacks fuel
        Block solar = usable(Blocks.largeSolarPanel) ? Blocks.largeSolarPanel
                : usable(Blocks.solarPanel) ? Blocks.solarPanel : null;
        if(solar != null){
            int[] sp = findValidSpotNear(solar, team, core.tileX() + 5, core.tileY() + 5, 6);
            if(sp != null && reserve(budget, solar, 1)){
                powerPlans.add(new BuildPlan(sp[0], sp[1], 0, solar));
                powerPlanLabel = solar.localizedName;
                return true;
            }
        }
        return false;
    }

    // ----------------------------------------- industrial production chains

    private boolean planIndustry(CoreBuild core, TeamData data, Team team, int[] budget, float netPowerPerSec){
        industryPlans.clear();

        // 0. Ensure Liquids.water and Liquids.oil unlock naturally when shore liquid tiles exist!
        if(usable(Blocks.mechanicalPump)){
            if((!Liquids.water.unlocked() || countBlock(data, Blocks.mechanicalPump) == 0)
                    && tryPlaceLiquidPump(core, team, budget, Liquids.water)){
                return true;
            }
            if(!Liquids.oil.unlocked() && tryPlaceLiquidPump(core, team, budget, Liquids.oil)){
                return true;
            }
        }

        int size = WINDOW_RADIUS * 2 + 1;
        int[] cells = new int[size * size], ore = new int[size * size];
        int[] origin = buildWindow(core, team, cells, ore);
        boolean hasUnloader = usable(Blocks.unloader);

        // 1. Graphite Press (no power needed! Critical early resource)
        if(usable(Blocks.graphitePress)
                && countBlock(data, Blocks.graphitePress) < (core.items.get(Items.graphite) < 250 ? 2 : 1)
                && core.items.get(Items.graphite) < 900
                && (core.items.get(Items.coal) >= 15 || hasOreOnMap(ore, Items.coal))){
            if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.graphitePress, hasUnloader, null, industryPlans)){
                return true;
            }
        }

        if(netPowerPerSec < -15f) return false;

        // 2. Pulverizer (scrap -> sand) if map has scrap but low sand
        if(usable(Blocks.pulverizer)
                && countBlock(data, Blocks.pulverizer) < 2
                && core.items.get(Items.sand) < 80
                && core.items.get(Items.scrap) >= 30){
            if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.pulverizer, hasUnloader, null, industryPlans)){
                return true;
            }
        }

        // 3. Silicon Smelter (up to 3 — backbone of units & mid-game tech!)
        if(usable(Blocks.siliconSmelter)
                && countBlock(data, Blocks.siliconSmelter) < (pro.plan != null && "EXPAND_SILICON_ECONOMY".equals(pro.plan.priority) ? 5 : 3)
                && core.items.get(Items.silicon) < 1800
                && core.items.get(Items.coal) >= 15
                && core.items.get(Items.sand) >= 20){
            if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.siliconSmelter, hasUnloader, null, industryPlans)){
                return true;
            }
        }

        // 4. Kiln (lead + sand -> metaglass; unlocks navalFactory, conduits, multiplicativeReconstructor)
        if(usable(Blocks.kiln)
                && countBlock(data, Blocks.kiln) < 2
                && core.items.get(Items.metaglass) < 700
                && core.items.get(Items.lead) >= 30
                && core.items.get(Items.sand) >= 25){
            if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.kiln, hasUnloader, null, industryPlans)){
                return true;
            }
        }

        // 5. Cultivator (+ WaterExtractor or shore Pump -> sporePod)
        if(usable(Blocks.cultivator)
                && countBlock(data, Blocks.cultivator) < 2
                && core.items.get(Items.sporePod) < 500){
            if(usable(Blocks.waterExtractor)){
                if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.cultivator, false, Blocks.waterExtractor, industryPlans)){
                    return true;
                }
            }else if(usable(Blocks.mechanicalPump) && tryPlaceShorePair(core, team, budget, Liquids.water, Blocks.cultivator)){
                return true;
            }
        }

        // 6. Cryofluid Mixer (+ WaterExtractor or shore Pump -> unlocks Liquids.cryofluid!)
        if(usable(Blocks.cryofluidMixer)
                && countBlock(data, Blocks.cryofluidMixer) < 1
                && core.items.get(Items.titanium) >= 30){
            if(usable(Blocks.waterExtractor)){
                if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.cryofluidMixer, hasUnloader, Blocks.waterExtractor, industryPlans)){
                    return true;
                }
            }else if(usable(Blocks.mechanicalPump) && tryPlaceShorePair(core, team, budget, Liquids.water, Blocks.cryofluidMixer)){
                return true;
            }
        }

        // 7. Plastanium Compressor (+ SporePress or shore Oil Pump -> unlocks Liquids.oil & Items.plastanium!)
        if(usable(Blocks.plastaniumCompressor)
                && countBlock(data, Blocks.plastaniumCompressor) < 2
                && core.items.get(Items.plastanium) < 900
                && core.items.get(Items.titanium) >= 40){
            if(usable(Blocks.mechanicalPump) && tryPlaceShorePair(core, team, budget, Liquids.oil, Blocks.plastaniumCompressor)){
                return true;
            }
            if(usable(Blocks.sporePress) && core.items.get(Items.sporePod) >= 15){
                if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.plastaniumCompressor, hasUnloader, Blocks.sporePress, industryPlans)){
                    return true;
                }
            }
        }

        // 8. SporePress + CoalCentrifuge if sector lacks coal!
        if(usable(Blocks.coalCentrifuge) && usable(Blocks.sporePress)
                && countBlock(data, Blocks.coalCentrifuge) < 1
                && core.items.get(Items.coal) < 60
                && core.items.get(Items.sporePod) >= 20){
            if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.coalCentrifuge, false, Blocks.sporePress, industryPlans)){
                return true;
            }
        }

        // 9. Pyratite -> Blast Compound -> Phase Fabric -> Surge Alloy
        if(usable(Blocks.pyratiteMixer) && countBlock(data, Blocks.pyratiteMixer) < 1
                && core.items.get(Items.pyratite) < 350
                && core.items.get(Items.coal) >= 30 && core.items.get(Items.lead) >= 50 && core.items.get(Items.sand) >= 50){
            if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.pyratiteMixer, hasUnloader, null, industryPlans)){
                return true;
            }
        }
        if(usable(Blocks.blastMixer) && countBlock(data, Blocks.blastMixer) < 1
                && core.items.get(Items.blastCompound) < 350
                && core.items.get(Items.pyratite) >= 20 && core.items.get(Items.sporePod) >= 20){
            if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.blastMixer, hasUnloader, null, industryPlans)){
                return true;
            }
        }
        if(usable(Blocks.phaseWeaver) && countBlock(data, Blocks.phaseWeaver) < 2
                && core.items.get(Items.phaseFabric) < 800
                && core.items.get(Items.thorium) >= 60 && core.items.get(Items.sand) >= 100){
            if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.phaseWeaver, hasUnloader, null, industryPlans)){
                return true;
            }
        }
        if(usable(Blocks.surgeSmelter) && countBlock(data, Blocks.surgeSmelter) < 2
                && core.items.get(Items.surgeAlloy) < 800
                && core.items.get(Items.copper) >= 150 && core.items.get(Items.lead) >= 180
                && core.items.get(Items.titanium) >= 100 && core.items.get(Items.silicon) >= 120){
            if(tryPlanHubCrafter(origin, size, cells, ore, team, budget, Blocks.surgeSmelter, hasUnloader, null, industryPlans)){
                return true;
            }
        }
        return false;
    }

    private boolean tryPlanHubCrafter(
            int[] origin, int size, int[] cells, int[] ore,
            Team team, int[] budget,
            Block crafter, boolean wantUnloader, Block supportBlock,
            Seq<BuildPlan> out){
        int sSize = supportBlock == null ? 0 : supportBlock.size;
        HubCrafterSlot slot = findHubCrafterSlot(size, size, cells, ore, crafter.size, wantUnloader, sSize);
        if(slot == null && wantUnloader){
            slot = findHubCrafterSlot(size, size, cells, ore, crafter.size, false, sSize);
        }
        if(slot == null) return false;

        int cx = origin[0] + slot.crafterX, cy = origin[1] + slot.crafterY;
        if(!Build.validPlace(crafter, team, cx, cy, 0)) return false;

        int[] work = budget.clone();
        if(!reserve(work, crafter, 1)) return false;

        Seq<BuildPlan> plans = new Seq<>();
        plans.add(new BuildPlan(cx, cy, 0, crafter));

        if(slot.hasUnloader && usable(Blocks.unloader)){
            int ux = origin[0] + slot.unloaderX, uy = origin[1] + slot.unloaderY;
            if(!Build.validPlace(Blocks.unloader, team, ux, uy, 0) || !reserve(work, Blocks.unloader, 1)){
                return false;
            }
            plans.add(new BuildPlan(ux, uy, 0, Blocks.unloader));
        }

        if(slot.hasSupport && supportBlock != null){
            int sx = origin[0] + slot.supportX, sy = origin[1] + slot.supportY;
            if(!Build.validPlace(supportBlock, team, sx, sy, 0) || !reserve(work, supportBlock, 1)){
                return false;
            }
            plans.add(new BuildPlan(sx, sy, 0, supportBlock));
            if(usable(Blocks.unloader) && supportBlock == Blocks.sporePress){
                int[] spUnloader = findValidCoreUnloaderAdjacent(team, sx, sy, supportBlock.size, cx, cy, crafter.size);
                if(spUnloader != null && reserve(work, Blocks.unloader, 1)){
                    plans.add(new BuildPlan(spUnloader[0], spUnloader[1], 0, Blocks.unloader));
                }
            }
        }

        if((crafter.consumesPower || crafter.outputsPower || (supportBlock != null && supportBlock.consumesPower))
                && usable(Blocks.powerNode)){
            int[] np = findValidSpotNear(Blocks.powerNode, team, cx + crafter.size, cy, 3);
            if(np != null && !sameSpot(plans, np[0], np[1]) && reserve(work, Blocks.powerNode, 1)){
                plans.add(new BuildPlan(np[0], np[1], 0, Blocks.powerNode));
            }
        }

        System.arraycopy(work, 0, budget, 0, budget.length);
        out.addAll(plans);
        industryPlanLabel = crafter.localizedName + (supportBlock != null ? " + " + supportBlock.localizedName : "");
        return true;
    }

    private boolean tryPlaceLiquidPump(CoreBuild core, Team team, int[] budget, mindustry.type.Liquid liquid){
        for(int r = 2; r <= 42; r++){
            for(int dy = -r; dy <= r; dy++){
                for(int dx = -r; dx <= r; dx++){
                    if(Math.max(Math.abs(dx), Math.abs(dy)) != r) continue;
                    int wx = core.tileX() + dx, wy = core.tileY() + dy;
                    Tile t = Vars.world.tile(wx, wy);
                    if(t == null || t.floor().liquidDrop != liquid) continue;
                    if(!Build.validPlace(Blocks.mechanicalPump, team, wx, wy, 0)) continue;
                    if(!reserve(budget, Blocks.mechanicalPump, 1)) return false;
                    industryPlans.add(new BuildPlan(wx, wy, 0, Blocks.mechanicalPump));
                    industryPlanLabel = Blocks.mechanicalPump.localizedName + " (" + liquid.localizedName + ")";
                    return true;
                }
            }
        }
        return false;
    }

    private boolean tryPlaceShorePair(CoreBuild core, Team team, int[] budget, mindustry.type.Liquid liquid, Block consumer){
        for(int r = 2; r <= 32; r++){
            for(int dy = -r; dy <= r; dy++){
                for(int dx = -r; dx <= r; dx++){
                    if(Math.max(Math.abs(dx), Math.abs(dy)) != r) continue;
                    int px = core.tileX() + dx, py = core.tileY() + dy;
                    Tile t = Vars.world.tile(px, py);
                    if(t == null || t.floor().liquidDrop != liquid) continue;
                    if(!Build.validPlace(Blocks.mechanicalPump, team, px, py, 0)) continue;

                    for(int d = 0; d < 4; d++){
                        int cx = px + DX[d] * 2, cy = py + DY[d] * 2;
                        if(!Build.validPlace(consumer, team, cx, cy, 0)) continue;
                        int[] work = budget.clone();
                        if(!reserve(work, Blocks.mechanicalPump, 1) || !reserve(work, consumer, 1)) return false;
                        System.arraycopy(work, 0, budget, 0, budget.length);
                        industryPlans.add(new BuildPlan(px, py, 0, Blocks.mechanicalPump));
                        industryPlans.add(new BuildPlan(cx, cy, 0, consumer));
                        if(usable(Blocks.powerNode)){
                            int[] np = findValidSpotNear(Blocks.powerNode, team, cx + 2, cy, 2);
                            if(np != null && reserve(budget, Blocks.powerNode, 1)){
                                industryPlans.add(new BuildPlan(np[0], np[1], 0, Blocks.powerNode));
                            }
                        }
                        industryPlanLabel = consumer.localizedName + " у источника " + liquid.localizedName;
                        return true;
                    }
                }
            }
        }
        return false;
    }

    // ----------------------------------- unit factories & reconstructors

    private boolean planArmy(CoreBuild core, TeamData data, Team team, int[] budget, boolean attackMode, float netPowerPerSec){
        armyPlans.clear();
        if(netPowerPerSec < 15f || core.items.get(Items.silicon) < 45) return false;

        int airFactories = countBlock(data, Blocks.airFactory);
        int groundFactories = countBlock(data, Blocks.groundFactory);
        int navalFactories = countBlock(data, Blocks.navalFactory);

        // Support air factory (mono/poly/flare/horizon/zenith) helps in EVERY sector; extra factories in attackMode!
        Block factoryChoice = null;
        UnitType t2Upgrade = null;
        UnitType t3Upgrade = null;

        if(usable(Blocks.airFactory) && airFactories < (attackMode ? 2 : 1)
                && (UnitTypes.mono.unlockedNow() || UnitTypes.flare.unlockedNow())){
            factoryChoice = Blocks.airFactory;
            t2Upgrade = attackMode && UnitTypes.horizon.unlockedNow() ? UnitTypes.horizon
                    : UnitTypes.poly.unlockedNow() ? UnitTypes.poly : null;
            t3Upgrade = attackMode && UnitTypes.zenith.unlockedNow() ? UnitTypes.zenith
                    : UnitTypes.mega.unlockedNow() ? UnitTypes.mega : null;
        }else if(attackMode && usable(Blocks.groundFactory) && groundFactories < 2 && UnitTypes.dagger.unlockedNow()){
            factoryChoice = Blocks.groundFactory;
            t2Upgrade = UnitTypes.mace.unlockedNow() ? UnitTypes.mace : null;
            t3Upgrade = UnitTypes.fortress.unlockedNow() ? UnitTypes.fortress : null;
        }else if(attackMode && usable(Blocks.navalFactory) && navalFactories < 1 && UnitTypes.risso.unlockedNow()){
            return tryPlaceNavalFactory(core, team, budget);
        }

        if(!(factoryChoice instanceof UnitFactory uf)) return false;

        boolean wantAdd = attackMode && usable(Blocks.additiveReconstructor) && t2Upgrade != null
                && core.items.get(Items.silicon) >= 140 && core.items.get(Items.graphite) >= 60;
        boolean wantMult = wantAdd && usable(Blocks.multiplicativeReconstructor) && t3Upgrade != null
                && core.items.get(Items.titanium) >= 140 && core.items.get(Items.metaglass) >= 80
                && netPowerPerSec >= 180f;

        int size = WINDOW_RADIUS * 2 + 1;
        int[] cells = new int[size * size], ore = new int[size * size];
        int[] origin = buildWindow(core, team, cells, ore);

        UnitChainSlot slot = findUnitChainSlot(
                size, size, cells,
                WINDOW_RADIUS, WINDOW_RADIUS,
                usable(Blocks.unloader),
                wantAdd,
                wantMult);
        if(slot == null && wantMult){
            slot = findUnitChainSlot(size, size, cells, WINDOW_RADIUS, WINDOW_RADIUS, usable(Blocks.unloader), wantAdd, false);
        }
        if(slot == null && wantAdd){
            slot = findUnitChainSlot(size, size, cells, WINDOW_RADIUS, WINDOW_RADIUS, usable(Blocks.unloader), false, false);
        }
        if(slot == null) return false;

        int fx = origin[0] + slot.factoryX, fy = origin[1] + slot.factoryY;
        if(!Build.validPlace(uf, team, fx, fy, slot.rotation)) return false;

        int[] work = budget.clone();
        if(!reserve(work, uf, 1)) return false;

        int planIdx = chooseFactoryPlan(uf, !attackMode || airFactories == 0);
        Seq<BuildPlan> plans = new Seq<>();
        plans.add(new BuildPlan(fx, fy, slot.rotation, uf, planIdx >= 0 ? Integer.valueOf(planIdx) : null));

        if(slot.hasUnloader && usable(Blocks.unloader)){
            int ux = origin[0] + slot.unloaderX, uy = origin[1] + slot.unloaderY;
            if(Build.validPlace(Blocks.unloader, team, ux, uy, 0) && reserve(work, Blocks.unloader, 1)){
                plans.add(new BuildPlan(ux, uy, 0, Blocks.unloader));
            }
        }
        if(slot.hasAdditive){
            int ax = origin[0] + slot.additiveX, ay = origin[1] + slot.additiveY;
            if(!Build.validPlace(Blocks.additiveReconstructor, team, ax, ay, slot.rotation)
                    || !reserve(work, Blocks.additiveReconstructor, 1)){
                return false;
            }
            plans.add(new BuildPlan(ax, ay, slot.rotation, Blocks.additiveReconstructor));
        }
        if(slot.hasMultiplicative){
            int mx = origin[0] + slot.multiplicativeX, my = origin[1] + slot.multiplicativeY;
            if(!Build.validPlace(Blocks.multiplicativeReconstructor, team, mx, my, slot.rotation)
                    || !reserve(work, Blocks.multiplicativeReconstructor, 1)){
                return false;
            }
            plans.add(new BuildPlan(mx, my, slot.rotation, Blocks.multiplicativeReconstructor));
        }
        if(usable(Blocks.powerNode)){
            int[] np = findValidSpotNear(Blocks.powerNode, team, fx + 2, fy + 2, 3);
            if(np != null && !sameSpot(plans, np[0], np[1]) && reserve(work, Blocks.powerNode, 1)){
                plans.add(new BuildPlan(np[0], np[1], 0, Blocks.powerNode));
            }
        }

        System.arraycopy(work, 0, budget, 0, budget.length);
        armyPlans.addAll(plans);
        armyPlanLabel = uf.localizedName
                + (slot.hasMultiplicative ? " + T3 реконструктор" : slot.hasAdditive ? " + T2 реконструктор" : "");
        return true;
    }

    /** v2.0: factory + reconstructor chain up to T4/T5 (Exponential / Tetrative via PayloadConveyor). */
    private boolean planProUnitChain(CoreBuild core, TeamData data, Team team, int[] budget,
                                     java.util.HashMap<String, Boolean> usableMap, Sector sector){
        armyPlans.clear();
        int diff = sector != null && sector.preset != null ? (int)sector.preset.difficulty : 4;
        java.util.HashMap<String, Boolean> unlocked = new java.util.HashMap<>();
        for(String[] line : ProLogic.UNIT_LINES){
            for(String un : line){
                UnitType ut = Vars.content.getByName(mindustry.ctype.ContentType.unit, un);
                unlocked.put(un, ut != null && ut.unlockedNow() && !ut.isBanned());
            }
        }
        for(String bn : new String[]{"ground-factory", "air-factory", "naval-factory", "additive-reconstructor",
                "multiplicative-reconstructor", "exponential-reconstructor", "tetrative-reconstructor"}){
            unlocked.put(bn, Boolean.TRUE.equals(usableMap.get(bn)));
        }
        ProLogic.WaveReport fc = pro.sched;
        boolean preferAir = "BUILD_T3_AIR_FLANK".equals(pro.plan != null ? pro.plan.priority : "") || (fc != null && fc.airShareNext >= 0.5f);
        boolean hasWater = pro.scan != null && pro.scan.counts.containsKey("water");
        ProLogic.UnitLinePlan line = ProLogic.chooseUnitLine(diff, unlocked, preferAir, hasWater);
        if(line == null || line.tiers < 3) return false;
        Block facB = ProRuntime.block(line.factory);
        if(!(facB instanceof UnitFactory uf) || countBlock(data, facB) >= 2) return false;

        int size = WINDOW_RADIUS * 2 + 1;
        int[] cells = new int[size * size], ore = new int[size * size];
        int[] origin = buildWindow(core, team, cells, ore);
        for(int tiers = line.tiers; tiers >= 3; tiers--){
            ProLogic.ChainSlot chain = ProLogic.findUnitChainSlotTiers(size, size, cells, WINDOW_RADIUS, WINDOW_RADIUS, usable(Blocks.unloader), tiers);
            if(chain == null) continue;
            int[] work = budget.clone();
            Seq<BuildPlan> list = new Seq<>();
            boolean good = true;
            for(int st = 0; st < chain.stages.size() && good; st++){
                ProLogic.ChainStage stg = chain.stages.get(st);
                Block sb = st == 0 ? facB : ("payload".equals(stg.kind) ? ProRuntime.block("payload-conveyor") : ProRuntime.block(stg.kind));
                int sx = origin[0] + stg.cx, sy = origin[1] + stg.cy;
                if(sb == null || !usable(sb) || !Build.validPlace(sb, team, sx, sy, chain.rotation) || !reserve(work, sb, 1)){
                    good = false;
                    break;
                }
                Object cfg = null;
                if(st == 0){
                    int idx = findPlanIndex(uf, Vars.content.getByName(mindustry.ctype.ContentType.unit, line.chain[0]));
                    if(idx >= 0) cfg = Integer.valueOf(idx);
                }
                list.add(new BuildPlan(sx, sy, chain.rotation, sb, cfg));
            }
            if(!good) continue;
            if(chain.hasUnloader && usable(Blocks.unloader) && reserve(work, Blocks.unloader, 1)){
                list.add(new BuildPlan(origin[0] + chain.unloaderX, origin[1] + chain.unloaderY, 0, Blocks.unloader));
            }
            System.arraycopy(work, 0, budget, 0, budget.length);
            armyPlans.addAll(list);
            armyPlanLabel = line.chain[line.chain.length - 1] + " (T" + tiers + ")";
            return true;
        }
        return false;
    }

    private boolean tryPlaceNavalFactory(CoreBuild core, Team team, int[] budget){
        if(!(Blocks.navalFactory instanceof UnitFactory nf)) return false;
        for(int r = 4; r <= 28; r++){
            for(int dy = -r; dy <= r; dy++){
                for(int dx = -r; dx <= r; dx++){
                    if(Math.max(Math.abs(dx), Math.abs(dy)) != r) continue;
                    int wx = core.tileX() + dx, wy = core.tileY() + dy;
                    for(int rot = 0; rot < 4; rot++){
                        if(!Build.validPlace(nf, team, wx, wy, rot)) continue;
                        Tile exit = Vars.world.tile(wx + DX[rot] * 2, wy + DY[rot] * 2);
                        if(exit == null || !exit.floor().isLiquid) continue;
                        if(!reserve(budget, nf, 1)) return false;
                        int planIdx = chooseFactoryPlan(nf, false);
                        armyPlans.add(new BuildPlan(wx, wy, rot, nf, planIdx >= 0 ? Integer.valueOf(planIdx) : null));
                        armyPlanLabel = nf.localizedName;
                        return true;
                    }
                }
            }
        }
        return false;
    }

    // ----------------------------------------- multi-tier fortress defense

    private int planFortressDefense(CoreBuild core, TeamData data, Team team, int[] budget){
        defensePlans.clear();

        // Pick threat anchors: real wave spawns and/or enemy cores!
        Seq<Vec2> threats = new Seq<>();
        for(Tile sp : Vars.spawner.getSpawns()){
            threats.add(new Vec2(sp.worldx(), sp.worldy()));
        }
        TeamData enemyData = Vars.state.teams.get(Vars.state.rules.waveTeam);
        if(enemyData != null){
            for(CoreBuild ec : enemyData.cores){
                threats.add(new Vec2(ec.x, ec.y));
            }
        }
        if(threats.isEmpty()) return 0;

        Block wallBlock = firstUsableAffordable(budget,
                Blocks.surgeWall, Blocks.thoriumWall, Blocks.plastaniumWall, Blocks.titaniumWall, Blocks.copperWall);
        Block groundTurret = firstUsableAffordable(budget,
                Blocks.salvo, Blocks.lancer, Blocks.scorch, Blocks.hail, Blocks.arc, Blocks.duo);
        Block airTurret = firstUsableAffordable(budget,
                Blocks.swarmer, Blocks.salvo, Blocks.scatter, Blocks.duo);
        Block supportBlock = firstUsableAffordable(budget,
                Blocks.mendProjector, Blocks.mender);

        if(groundTurret == null && wallBlock == null) return 0;

        // Check defense coverage at 22 tiles from Core toward each threat
        IntSet taken = new IntSet();
        for(Vec2 threat : threats){
            float dx = threat.x - core.x, dy = threat.y - core.y;
            float len = Math.max(1f, Mathf.len(dx, dy));
            float ringDist = Math.min(len * 0.45f, 22f * Vars.tilesize);
            int cx = Mathf.clamp(World_toTile(core.x + (dx / len) * ringDist), 6, Vars.world.width() - 7);
            int cy = Mathf.clamp(World_toTile(core.y + (dy / len) * ringDist), 6, Vars.world.height() - 7);

            // Check existing DPS covering (cx, cy)
            float localDps = 0f;
            float wx = cx * Vars.tilesize, wy = cy * Vars.tilesize;
            for(Building b : data.buildings){
                if(b instanceof TurretBuild tb && b.within(wx, wy, tb.range() + 24f)){
                    localDps += tb.estimateDps();
                }
            }
            float targetDps = 75f + Vars.state.wave * 18f;
            if(localDps >= targetDps) continue;

            int[] template = buildFortressTemplate(cx, cy, dx, dy);
            for(int i = 0; i < template.length / 3 && defensePlans.size < MAX_DEFENSE_PLANS_PER_CYCLE; i++){
                int tx = template[i * 3], ty = template[i * 3 + 1], role = template[i * 3 + 2];
                if(isFortressSlotSatisfied(team, tx, ty, role)) continue;
                Block chosen = role == ROLE_WALL ? wallBlock
                        : role == ROLE_GROUND_TURRET ? groundTurret
                        : role == ROLE_AIR_TURRET ? airTurret
                        : role == ROLE_SUPPORT ? supportBlock
                        : usable(Blocks.powerNode) ? Blocks.powerNode : null;
                if(chosen == null) continue;

                int[] spot = findValidSpotNear(chosen, team, tx, ty, 2);
                if(spot == null || overlaps(taken, chosen, spot[0], spot[1])) continue;
                if(!reserve(budget, chosen, 1)) continue;
                mark(taken, chosen, spot[0], spot[1]);
                defensePlans.add(new BuildPlan(spot[0], spot[1], 0, chosen));
            }
            if(!defensePlans.isEmpty()) break;
        }
        return defensePlans.size;
    }

    private boolean isFortressSlotSatisfied(Team team, int tx, int ty, int role){
        for(int dy = -1; dy <= 1; dy++){
            for(int dx = -1; dx <= 1; dx++){
                Tile t = Vars.world.tile(tx + dx, ty + dy);
                if(t == null || t.build == null || t.build.team != team) continue;
                Block b = t.build.block;
                if(role == ROLE_WALL && b.group == BlockGroup.walls && dx == 0 && dy == 0) return true;
                if((role == ROLE_GROUND_TURRET || role == ROLE_AIR_TURRET) && t.build instanceof TurretBuild) return true;
                if(role == ROLE_SUPPORT && (b == Blocks.mender || b == Blocks.mendProjector)) return true;
                if(role == ROLE_POWER_NODE && t.build instanceof PowerNodeBuild) return true;
            }
        }
        return false;
    }

    private Block firstUsableAffordable(int[] budget, Block... blocks){
        float mult = Vars.state.rules.buildCostMultiplier;
        for(Block b : blocks){
            if(!usable(b)) continue;
            boolean ok = true;
            for(ItemStack s : b.requirements){
                int need = Mathf.ceil(s.amount * mult) * 2;
                if(budget[s.item.id] < need){
                    ok = false;
                    break;
                }
            }
            if(ok) return b;
        }
        return null;
    }

    // ------------------------------------------------ drills & conveyors

    private boolean planDrillAndConveyor(CoreBuild core, TeamData data, Team team, int[] budget, float netPowerPerSec){
        drillPlans.clear();
        Block belt = usable(Blocks.titaniumConveyor) && budget[Items.titanium.id] >= 80
                ? Blocks.titaniumConveyor : Blocks.conveyor;
        if(!usable(belt)) return false;

        int size = WINDOW_RADIUS * 2 + 1;
        int[] cells = new int[size * size], ore = new int[size * size];
        int[] origin = buildWindow(core, team, cells, ore);

        Seq<Item> items = Vars.content.items();
        String[] names = new String[items.size];
        int[] stock = new int[items.size];
        float[] weights = new float[items.size];

        boolean needPower = netPowerPerSec < 80f;
        boolean needGraphite = core.items.get(Items.graphite) < 200;
        boolean needSilicon = core.items.get(Items.silicon) < 400;
        boolean needTitanium = core.items.get(Items.titanium) < 350 || director.isItemNeededForTech(Items.titanium);
        boolean needThorium = core.items.get(Items.thorium) < 350 || director.isItemNeededForTech(Items.thorium);

        for(Item item : items){
            names[item.id] = item.name;
            stock[item.id] = core.items.get(item);
            weights[item.id] = itemWeight(item.name, needPower, needGraphite, needSilicon, needTitanium, needThorium);
            if(director.isItemNeededForTech(item)) weights[item.id] += 0.45f;
        }

        // Try drills capable of mining the needed ore (laserDrill/blastDrill for thorium!)
        Seq<Drill> candidateDrills = new Seq<>();
        if(usable(Blocks.blastDrill) && netPowerPerSec > 200f && budget[Items.thorium.id] >= 90){
            candidateDrills.add((Drill)Blocks.blastDrill);
        }
        if(usable(Blocks.laserDrill) && netPowerPerSec > 80f && budget[Items.silicon.id] >= 60 && budget[Items.titanium.id] >= 50){
            candidateDrills.add((Drill)Blocks.laserDrill);
        }
        if(usable(Blocks.pneumaticDrill) && budget[Items.graphite.id] >= 20){
            candidateDrills.add((Drill)Blocks.pneumaticDrill);
        }
        if(usable(Blocks.mechanicalDrill)){
            candidateDrills.add((Drill)Blocks.mechanicalDrill);
        }
        if(candidateDrills.isEmpty()) return false;

        int maxTier = 0;
        for(Drill d : candidateDrills) maxTier = Math.max(maxTier, d.tier);

        boolean[] available = new boolean[items.size];
        for(int v : ore){
            if(v >= 0 && items.get(v).hardness <= maxTier) available[v] = true;
        }

        for(int itemIdx : rankItems(names, stock, available, weights)){
            Item targetItem = items.get(itemIdx);
            Drill chosenDrill = null;
            for(Drill d : candidateDrills){
                if(targetItem.hardness <= d.tier){
                    chosenDrill = d;
                    break;
                }
            }
            if(chosenDrill == null) continue;

            DrillSite site = findDrillSite(size, size, cells, ore, itemIdx, chosenDrill.size, MAX_CONVEYOR_PATH);
            if(site == null) continue;

            int bx = origin[0] + site.x, by = origin[1] + site.y;
            if(!Build.validPlace(chosenDrill, team, bx, by, 0)){
                rejectedSites.add(pack(bx, by));
                continue;
            }
            int[] work = budget.clone();
            if(!reserve(work, chosenDrill, 1) || !reserve(work, belt, site.pathLength)) continue;

            Seq<BuildPlan> plans = new Seq<>();
            plans.add(new BuildPlan(bx, by, 0, chosenDrill));
            boolean ok = true;
            for(int s = 0; s < site.pathLength; s++){
                int cx = origin[0] + site.path[s * 3];
                int cy = origin[1] + site.path[s * 3 + 1];
                int rot = site.path[s * 3 + 2];
                if(!Build.validPlace(belt, team, cx, cy, rot)){
                    ok = false;
                    break;
                }
                plans.add(new BuildPlan(cx, cy, rot, belt));
            }
            if(!ok || plans.size > MAX_PLANS_PER_CYCLE) continue;

            if(chosenDrill.consumesPower && usable(Blocks.powerNode)){
                int[] np = findValidSpotNear(Blocks.powerNode, team, bx + chosenDrill.size, by, 2);
                if(np != null && !sameSpot(plans, np[0], np[1]) && reserve(work, Blocks.powerNode, 1)){
                    plans.add(new BuildPlan(np[0], np[1], 0, Blocks.powerNode));
                }
            }

            System.arraycopy(work, 0, budget, 0, budget.length);
            drillPlans.addAll(plans);
            drillPlanLabel = chosenDrill.localizedName + " (" + targetItem.localizedName + ", конвейер " + site.pathLength + ")";
            return true;
        }
        return false;
    }

    // --------------------------------- rearm, courier & manual mining

    private boolean findRearmTarget(TeamData data, CoreBuild core){
        rearmCandidate = null;
        rearmCandidateItem = null;
        float bestDst = Float.MAX_VALUE;
        java.util.HashMap<String, Integer> proStock = new java.util.HashMap<>();
        try{
            proStock = pro.stockMap(core);
        }catch(Throwable t){
            proFail("склад", t);
        }

        for(Building b : data.buildings){
            if(!(b instanceof ItemTurretBuild tb) || !(b.block instanceof ItemTurret block)) continue;
            if(tb.totalAmmo >= block.maxAmmo * REARM_FRACTION) continue;
            boolean busFed = false;
            Item wanted = null;
            try{
                busFed = pro.busBuilt && pro.nearBus(b) && tb.totalAmmo >= block.maxAmmo * 0.15f;
                wanted = pro.preferredAmmo(b, proStock);
            }catch(Throwable t){
                proFail("боепитание", t);
            }
            if(busFed) continue;
            Item bestAmmo = null;
            float bestScore = -1f;
            for(var entry : block.ammoTypes.entries()){
                int have = core.items.get(entry.key);
                if(have < MIN_AMMO_STOCK) continue;
                float score = entry.value.estimateDPS() * 10f + Math.min(have, 200) + (entry.key == wanted ? 400f : 0f);
                if(score > bestScore){
                    bestScore = score;
                    bestAmmo = entry.key;
                }
            }
            if(bestAmmo == null) continue;
            float dst = b.dst(core);
            if(dst < bestDst){
                bestDst = dst;
                rearmCandidate = b;
                rearmCandidateItem = bestAmmo;
            }
        }
        return rearmCandidate != null;
    }

    /** Universal Core-to-Building item courier for crafters, generators, unit factories & reconstructors without unloaders. */
    private boolean findCourierTarget(TeamData data, CoreBuild core){
        courierCandidate = null;
        courierCandidateItem = null;
        float bestDst = Float.MAX_VALUE;

        for(Building b : data.buildings){
            boolean eligible = b instanceof GenericCrafterBuild
                    || b instanceof UnitFactoryBuild
                    || b instanceof ReconstructorBuild
                    || b instanceof ConsumeGeneratorBuild;
            if(!eligible || b.items == null) continue;
            if(hasAdjacentUnloader(b)) continue;

            for(Item item : Vars.content.items()){
                int keep = item == Items.copper ? COPPER_RESERVE : item == Items.lead ? LEAD_RESERVE : 5;
                if(core.items.get(item) <= keep + 8) continue;
                int cap = Math.max(1, b.getMaximumAccepted(item));
                if(b.acceptItem(core, item) && b.items.get(item) <= cap / 2){
                    float dst = b.dst(core);
                    if(dst < bestDst && dst <= 45f * Vars.tilesize){
                        bestDst = dst;
                        courierCandidate = b;
                        courierCandidateItem = item;
                    }
                    break;
                }
            }
        }
        return courierCandidate != null;
    }

    private boolean hasAdjacentUnloader(Building b){
        if(b.proximity == null) return false;
        for(Building other : b.proximity){
            if(other instanceof UnloaderBuild) return true;
        }
        return false;
    }

    private void runItemTransfer(Unit unit, CoreBuild core){
        float range = Vars.itemTransferRange * 0.78f;
        if(transferTarget == null || !transferTarget.isValid() || transferItem == null){
            transferStage = 0;
            return;
        }
        if(unit.stack.amount > 0 && unit.item() != transferItem){
            if(Vars.player.within(core, range)){
                Call.transferInventory(Vars.player, core);
            }else{
                setTarget(core.x, core.y, range * 0.75f);
            }
            lastAction = "сбрасываю лишние предметы в ядро";
            return;
        }
        if(transferStage == 1){
            if(unit.stack.amount > 0){
                transferStage = 2;
            }else if(Vars.player.within(core, range)){
                int amount = Math.min(unit.maxAccepted(transferItem), core.items.get(transferItem));
                if(amount <= 0){
                    transferStage = 0;
                    return;
                }
                Call.requestItem(Vars.player, core, transferItem, amount);
                transferStage = 2;
                lastAction = "беру " + amount + " " + transferItem.localizedName;
                return;
            }else{
                setTarget(core.x, core.y, range * 0.75f);
                lastAction = "лечу к ядру за " + transferItem.localizedName;
                return;
            }
        }
        if(transferStage == 2){
            if(unit.stack.amount <= 0){
                transferStage = 0;
                return;
            }
            if(Vars.player.within(transferTarget, range)){
                Call.transferInventory(Vars.player, transferTarget);
                watchdog.success();
                lastAction = "снабжение: " + transferLabel;
                transferStage = unit.stack.amount > 0 ? 3 : 0;
            }else{
                setTarget(transferTarget.x, transferTarget.y, range * 0.75f);
                lastAction = "несу " + transferLabel;
            }
            return;
        }
        if(transferStage == 3){
            if(unit.stack.amount <= 0){
                transferStage = 0;
            }else if(Vars.player.within(core, range)){
                Call.transferInventory(Vars.player, core);
                transferStage = 0;
            }else{
                setTarget(core.x, core.y, range * 0.75f);
            }
        }
    }

    private Tile findMineTile(Unit unit, CoreBuild core, Team team){
        if(!unit.canMine() || !unit.type.mineFloor) return null;
        int size = WINDOW_RADIUS * 2 + 1;
        int[] cells = new int[size * size], ore = new int[size * size];
        int[] origin = buildWindow(core, team, cells, ore);

        Seq<Item> items = Vars.content.items();
        String[] names = new String[items.size];
        int[] stock = new int[items.size];
        boolean[] available = new boolean[items.size];
        float[] weights = new float[items.size];
        for(Item item : items){
            names[item.id] = item.name;
            stock[item.id] = core.items.get(item);
            weights[item.id] = itemWeight(item.name, false, true, true, true, false);
        }
        for(int v : ore){
            if(v >= 0 && unit.canMine(items.get(v))) available[v] = true;
        }
        int maxDist = Math.min(WINDOW_RADIUS, (int)(Vars.mineTransferRange / Vars.tilesize) - 3);
        for(int idx : rankItems(names, stock, available, weights)){
            int cell = nearestOreCell(size, size, cells, ore, idx, WINDOW_RADIUS, WINDOW_RADIUS, maxDist);
            if(cell >= 0){
                return Vars.world.tile(origin[0] + cell % size, origin[1] + cell / size);
            }
        }
        return null;
    }

    private void executeMine(Unit unit){
        Tile tile = mineCandidate;
        if(tile == null || unit.mineTile == tile) return;
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

    // ----------------------------------------- rebuild, window & stats

    private int collectRebuild(TeamData data, Team team, int[] budget){
        rebuildPlans.clear();
        for(BlockPlan plan : data.plans){
            if(rebuildPlans.size >= MAX_DEFENSE_PLANS_PER_CYCLE) break;
            if(plan.removed || !usable(plan.block)) continue;
            if(!Build.validPlace(plan.block, team, plan.x, plan.y, plan.rotation)) continue;
            if(!reserve(budget, plan.block, 1)) continue;
            rebuildPlans.add(new BuildPlan(plan.x, plan.y, plan.rotation, plan.block, plan.config));
        }
        return rebuildPlans.size;
    }

    int[] buildWindow(CoreBuild core, Team team, int[] cells, int[] ore){
        int size = WINDOW_RADIUS * 2 + 1;
        int ox = core.tileX() - WINDOW_RADIUS, oy = core.tileY() - WINDOW_RADIUS;
        for(int y = 0; y < size; y++){
            for(int x = 0; x < size; x++){
                int i = y * size + x;
                int wx = ox + x, wy = oy + y;
                Tile tile = Vars.world.tile(wx, wy);
                ore[i] = -1;
                if(tile == null){
                    cells[i] = CELL_BLOCKED;
                    continue;
                }
                Building b = tile.build;
                if(b != null && b.team == team
                        && (b instanceof CoreBuild || (b instanceof StorageBuild sb && sb.linkedCore != null))){
                    cells[i] = CELL_CORE;
                    continue;
                }
                boolean free = !rejectedSites.contains(pack(wx, wy))
                        && Build.validPlace(Blocks.conveyor, team, wx, wy, 0);
                cells[i] = free ? CELL_FREE : CELL_BLOCKED;
                Item drop = tile.block() == Blocks.air ? tile.drop() : null;
                if(free && drop != null && !tile.floor().isLiquid){
                    ore[i] = drop.id;
                }
            }
        }
        try{
            ProLogic.applyCoreZones(size, size, cells, WINDOW_RADIUS, WINDOW_RADIUS, core.block.size, 12,
                    core.block.size == 4 && usable(Blocks.coreNucleus), ore);
        }catch(Throwable t){
            proFail("зоны ядра", t);
        }
        return new int[]{ox, oy};
    }

    private float[] computeDefenseStats(TeamData data, Team team){
        float[] stats = {0f, 0f};
        for(Building b : data.buildings){
            if(b instanceof TurretBuild tb && tb.hasAmmo()){
                stats[0] += tb.estimateDps();
                stats[1] += b.health;
            }else if(b.block.group == BlockGroup.walls){
                stats[1] += b.health;
            }
        }
        Groups.unit.each(u -> {
            if(u.team == team && !u.dead() && u.type != null && u.type.canAttack){
                stats[0] += u.type.estimateDps();
                stats[1] += u.health * 0.5f;
            }
        });
        return stats;
    }

    private float[] computeNextWaveStats(int waveIndex){
        if(Vars.state == null || Vars.state.rules == null || Vars.state.rules.spawns == null){
            return new float[]{0f, 0f};
        }
        int idx = Math.max(0, waveIndex);
        float hp = 0f, dps = 0f;
        Team waveTeam = Vars.state.rules.waveTeam;
        float hpMult = Vars.state.rules.unitHealth(waveTeam);
        float dmgMult = Vars.state.rules.unitDamage(waveTeam);
        for(SpawnGroup group : Vars.state.rules.spawns){
            if(group.type == null) continue;
            int count = group.getSpawned(idx);
            if(count <= 0) continue;
            float unitHp = group.type.health * hpMult + group.getShield(idx);
            hp += count * unitHp;
            dps += count * group.type.estimateDps() * dmgMult;
        }
        return new float[]{hp, dps};
    }

    // ----------------------------------------- low-level helpers

    private Guard buildGuard(){
        Guard g = new Guard();
        g.netActive = Vars.net != null && Vars.net.active();
        g.inGame = Vars.state != null && Vars.state.isGame();
        if(!g.inGame) return g;
        g.campaign = Vars.state.isCampaign();
        Planet p = Vars.state.getPlanet();
        g.planet = p == null ? "" : p.name;
        Unit u = Vars.player == null ? null : Vars.player.unit();
        g.canBuild = u == null || !u.isValid() || u.canBuild();
        return g;
    }

    int[] coreBudget(CoreBuild core){
        int[] budget = new int[Vars.content.items().size];
        for(Item item : Vars.content.items()){
            budget[item.id] = core.items.get(item);
        }
        return budget;
    }

    boolean reserve(int[] budget, Block block, int count){
        if(block == null || count <= 0){
            return count == 0;
        }
        float mult = Vars.state.rules.buildCostMultiplier;
        for(ItemStack stack : block.requirements){
            int need = Mathf.ceil(stack.amount * mult) * count;
            int keep = stack.item == Items.copper ? COPPER_RESERVE
                    : stack.item == Items.lead ? LEAD_RESERVE : 0;
            if(budget[stack.item.id] - need < keep) return false;
        }
        for(ItemStack stack : block.requirements){
            budget[stack.item.id] -= Mathf.ceil(stack.amount * mult) * count;
        }
        return true;
    }

    static boolean usable(Block block){
        return block != null && block.unlockedNow() && block.isPlaceable() && block.environmentBuildable();
    }

    private float coreFillFraction(CoreBuild core){
        int cap = Math.max(1, core.storageCapacity);
        float maxFill = 0f;
        for(Item item : new Item[]{Items.copper, Items.lead, Items.silicon, Items.graphite, Items.titanium}){
            maxFill = Math.max(maxFill, (float)core.items.get(item) / cap);
        }
        return maxFill;
    }

    private boolean sectorProducesNeededItem(Sector sector, TeamData data){
        if(sector != null && sector.info != null && sector.info.resources != null){
            for(var uc : sector.info.resources){
                if(uc instanceof Item item && director.isItemNeededForTech(item)) return true;
            }
        }
        for(Building b : data.buildings){
            if(b instanceof GenericCrafterBuild && b.block instanceof mindustry.world.blocks.production.GenericCrafter gc){
                if(gc.outputItem != null && director.isItemNeededForTech(gc.outputItem.item)) return true;
            }
        }
        return false;
    }

    private boolean hasOreOnMap(int[] ore, Item item){
        if(item == null) return false;
        for(int v : ore){
            if(v == item.id) return true;
        }
        return false;
    }

    private int countDrills(TeamData data){
        int c = 0;
        for(Building b : data.buildings){
            if(b.block instanceof Drill) c++;
        }
        return c;
    }

    private int countBlock(TeamData data, Block block){
        if(block == null) return 0;
        int c = 0;
        for(Building b : data.buildings){
            if(b.block == block) c++;
        }
        return c;
    }

    private float minCoreHealth(TeamData data){
        float min = 1f;
        for(CoreBuild c : data.cores){
            if(c.maxHealth > 0f) min = Math.min(min, c.health / c.maxHealth);
        }
        return min;
    }

    int[] findValidSpotNear(Block block, Team team, int tx, int ty, int maxRadius){
        for(int r = 0; r <= maxRadius; r++){
            for(int dy = -r; dy <= r; dy++){
                for(int dx = -r; dx <= r; dx++){
                    if(Math.max(Math.abs(dx), Math.abs(dy)) != r) continue;
                    int wx = tx + dx, wy = ty + dy;
                    if(!rejectedSites.contains(pack(wx, wy)) && Build.validPlace(block, team, wx, wy, 0)){
                        return new int[]{wx, wy};
                    }
                }
            }
        }
        return null;
    }

    private int[] findAdjacentSpotToBuilding(Block toPlace, Team team, Building anchor){
        int aOff = sizeOffset(anchor.block.size);
        int ax0 = anchor.tileX() + aOff, ay0 = anchor.tileY() + aOff;
        int pOff = sizeOffset(toPlace.size);
        for(int py = ay0 - toPlace.size; py <= ay0 + anchor.block.size + toPlace.size; py++){
            for(int px = ax0 - toPlace.size; px <= ax0 + anchor.block.size + toPlace.size; px++){
                int px0 = px + pOff, py0 = py + pOff;
                if(rectsOverlap(ax0, ay0, anchor.block.size, px0, py0, toPlace.size)) continue;
                if(!rectsTouchEdge(ax0, ay0, anchor.block.size, px0, py0, toPlace.size)) continue;
                if(Build.validPlace(toPlace, team, px, py, 0)){
                    return new int[]{px, py};
                }
            }
        }
        return null;
    }

    private int[] findValidCoreUnloaderAdjacent(Team team, int sx, int sy, int sSize, int cx, int cy, int cSize){
        int sOff = sizeOffset(sSize), cOff = sizeOffset(cSize);
        int sx0 = sx + sOff, sy0 = sy + sOff;
        int cx0 = cx + cOff, cy0 = cy + cOff;
        for(int dy = -1; dy <= sSize; dy++){
            for(int dx = -1; dx <= sSize; dx++){
                boolean edgeX = dx == -1 || dx == sSize, edgeY = dy == -1 || dy == sSize;
                if(edgeX == edgeY) continue;
                int ux = sx0 + dx, uy = sy0 + dy;
                if(ux >= cx0 && ux < cx0 + cSize && uy >= cy0 && uy < cy0 + cSize) continue;
                if(!Build.validPlace(Blocks.unloader, team, ux, uy, 0)) continue;
                for(int d = 0; d < 4; d++){
                    Tile nt = Vars.world.tile(ux + DX[d], uy + DY[d]);
                    if(nt != null && nt.build != null && nt.build.team == team
                            && (nt.build instanceof CoreBuild || (nt.build instanceof StorageBuild sb && sb.linkedCore != null))){
                        return new int[]{ux, uy};
                    }
                }
            }
        }
        return null;
    }

    private static boolean sameSpot(Seq<BuildPlan> plans, int x, int y){
        for(BuildPlan p : plans){
            if(p.x == x && p.y == y) return true;
        }
        return false;
    }

    private static int World_toTile(float worldCoord){
        return Math.round(worldCoord / Vars.tilesize);
    }

    private void queuePlans(Unit unit, Seq<BuildPlan> plans){
        Vars.control.input.isBuilding = true;
        for(BuildPlan p : plans){
            unit.addBuild(p);
            ownPlans.add(p);
        }
        watchdog.success();
    }

    private void fail(String why){
        haltUnitActions();
        state = transition(state, CMD_FAIL);
        saveEnabledPref(false);
        reason = why;
        log("остановлен: " + why);
    }

    private void haltUnitActions(){
        hasTarget = false;
        transferStage = 0;
        transferTarget = null;
        clearMining();
        Unit u = Vars.player == null ? null : Vars.player.unit();
        if(u != null && u.isValid()){
            cancelOwnPlans(u);
            u.controlWeapons(false, false);
        }
        ownPlans.clear();
        watchdog.reset();
    }

    private void cancelOwnPlans(Unit unit){
        for(BuildPlan p : ownPlans){
            unit.plans.remove(p, true);
        }
        ownPlans.clear();
    }

    private void action(String text){
        lastAction = text;
        log(text);
    }

    /** Journal entry written by the v2.0 pro runtime. */
    void logPro(String text){
        log(text);
    }

    boolean isRejected(int x, int y){
        return rejectedSites.contains(pack(x, y));
    }

    private void proFail(String label, Throwable t){
        if(proErrors.add(label)){
            log("про-модуль «" + label + "» временно отключён, работает v1: " + t);
        }
    }

    private void log(String text){
        journal.add(text);
        if(journal.size > 10) journal.remove(0);
        Log.info("[serpulo-campaign-bot] @", text);
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
