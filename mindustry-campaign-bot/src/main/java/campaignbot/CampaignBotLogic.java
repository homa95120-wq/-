package campaignbot;

/**
 * Pure, deterministic strategic and tactical algorithms for the standalone
 * Serpulo Campaign Auto-Player mod ({@code SerpuloCampaignBot}).
 * <p>
 * This class has <b>zero</b> dependencies on Mindustry or Arc classes so that
 * every rule (campaign state machine, TechTree dependency graph solver, sector
 * selection and post-capture hold logic, drill + conveyor BFS routing, core-hub
 * Unloader + Crafter placement, liquid-paired crafter placement, unit factory +
 * reconstructor chain placement, multi-tier fortress layout, RTS squad assault
 * state machine, wave safety caller, and anti-stall watchdog) can be verified
 * offline in both pure Java ({@code CampaignBotLogicCheck}) and Node.js.
 */
public final class CampaignBotLogic{

    // ------------------------------------------------------------------ states

    /** Bot is turned off and never modifies game or campaign state. */
    public static final int OFF = 0;
    /** Bot actively plays sectors, researches tech, and launches across Serpulo. */
    public static final int RUNNING = 1;
    /** Paused by the player; resumes cleanly on start. */
    public static final int PAUSED = 2;
    /** Halted by a safety guard, repeated sector loss, or watchdog stall. */
    public static final int NEEDS_HELP = 3;
    /** Planetary Launch Terminal captured and campaign goal achieved. */
    public static final int VICTORY = 4;

    // ---------------------------------------------------------------- commands

    public static final int CMD_START = 0;
    public static final int CMD_PAUSE = 1;
    public static final int CMD_STOP = 2;
    public static final int CMD_FAIL = 3;
    public static final int CMD_VICTORY = 4;

    // --------------------------------------------------------- in-sector actions

    public static final int ACT_WAIT = 0;
    public static final int ACT_UPGRADE_CORE = 1;
    public static final int ACT_REARM = 2;
    public static final int ACT_POWER = 3;
    public static final int ACT_DEFEND = 4;
    public static final int ACT_REBUILD = 5;
    public static final int ACT_DRILL = 6;
    public static final int ACT_INDUSTRY = 7;
    public static final int ACT_ARMY = 8;
    public static final int ACT_COURIER = 9;
    public static final int ACT_CALL_WAVE = 10;
    public static final int ACT_MINE = 11;
    public static final int ACT_READY_NEXT_SECTOR = 12;

    // ------------------------------------------------------------- squad modes

    public static final int SQUAD_RALLY = 0;
    public static final int SQUAD_ASSAULT = 1;
    public static final int SQUAD_DEFEND = 2;

    // -------------------------------------------------------------------- grid

    /** Free land tile where conveyors, drills, crafters, or turrets can be placed. */
    public static final int CELL_FREE = 0;
    /** Occupied, solid wall, liquid, map border, or rejected tile. */
    public static final int CELL_BLOCKED = 1;
    /** Friendly Core or Core-linked Container/Vault tile. */
    public static final int CELL_CORE = 2;
    /** Natural water liquid tile where a pump or naval block may sit. */
    public static final int CELL_WATER = 3;
    /** Natural oil liquid tile where a pump may sit. */
    public static final int CELL_OIL = 4;
    /** Reserved conveyor corridor / Core: Nucleus 5x5 reserve: only conveyors, routers and unloaders may use it. */
    public static final int CELL_LANE = 5;

    // ----------------------------------------------------------- tuning limits

    public static final float DECISION_INTERVAL_TICKS = 45f;
    public static final int WINDOW_RADIUS = 44;
    public static final int MAX_CONVEYOR_PATH = 38;
    public static final int MAX_PLANS_PER_CYCLE = 42;
    public static final int MAX_DEFENSE_PLANS_PER_CYCLE = 6;
    public static final int MAX_DRILLS = 24;
    public static final int COPPER_RESERVE = 50;
    public static final int LEAD_RESERVE = 30;
    public static final float REARM_FRACTION = 0.40f;
    public static final int MIN_AMMO_STOCK = 12;
    public static final float WAVE_CALL_COOLDOWN_SEC = 14f;
    public static final int SAFE_WAVE_MARGIN = 3;
    public static final float EARLY_CALL_MIN_TIMER_SEC = 12f;
    public static final float MIN_CORE_HEALTH_FOR_WAVE = 0.82f;
    public static final float STALL_SECONDS = 55f;
    public static final int MAX_FAILURES = 6;
    public static final float RESPAWN_WAIT_SECONDS = 35f;
    public static final int MAX_SECTOR_LOSSES = 3;
    public static final float POST_CAPTURE_MAX_HOLD_SEC = 210f;

    public static final int[] DX = {1, 0, -1, 0};
    public static final int[] DY = {0, 1, 0, -1};

    private CampaignBotLogic(){
    }

    // ----------------------------------------------------------- state machine

    public static String stateName(int state){
        switch(state){
            case RUNNING: return "РАБОТАЕТ";
            case PAUSED: return "ПАУЗА";
            case NEEDS_HELP: return "НУЖНА ПОМОЩЬ";
            case VICTORY: return "КАМПАНИЯ ПРОЙДЕНА";
            default: return "ВЫКЛ";
        }
    }

    public static String stateColor(int state){
        switch(state){
            case RUNNING: return "green";
            case PAUSED: return "yellow";
            case NEEDS_HELP: return "scarlet";
            case VICTORY: return "accent";
            default: return "lightgray";
        }
    }

    public static String actionName(int action){
        switch(action){
            case ACT_UPGRADE_CORE: return "апгрейд ядра/склада";
            case ACT_REARM: return "боеприпасы";
            case ACT_POWER: return "энергетика";
            case ACT_DEFEND: return "оборона";
            case ACT_REBUILD: return "восстановление";
            case ACT_DRILL: return "буры и конвейеры";
            case ACT_INDUSTRY: return "производство";
            case ACT_ARMY: return "заводы юнитов";
            case ACT_COURIER: return "снабжение завода";
            case ACT_CALL_WAVE: return "вызов волны";
            case ACT_MINE: return "ручная добыча";
            case ACT_READY_NEXT_SECTOR: return "вылет в следующий сектор";
            default: return "ожидание";
        }
    }

    public static int transition(int state, int command){
        switch(command){
            case CMD_START:
                return RUNNING;
            case CMD_PAUSE:
                return state == RUNNING ? PAUSED : state;
            case CMD_STOP:
                return OFF;
            case CMD_FAIL:
                return state == RUNNING || state == PAUSED ? NEEDS_HELP : state;
            case CMD_VICTORY:
                return state == RUNNING || state == PAUSED ? VICTORY : state;
            default:
                return state;
        }
    }

    // ------------------------------------------------------------------- guard

    public static class Guard{
        public boolean inGame;
        public boolean netActive;
        public boolean campaign;
        public String planet = "";
        public boolean canBuild = true;
    }

    /**
     * Checks whether the campaign bot is allowed to act.
     * Note: When {@code !inGame} (player is on the Planet Map or main menu),
     * the bot IS allowed to run so it can research tech and launch into Serpulo!
     */
    public static String guardReason(Guard g){
        if(g == null) return "нет состояния игры";
        if(g.netActive) return "сетевая игра — автопрохождение работает только локально";
        if(!g.inGame) return null;
        if(!g.campaign) return "открыта не кампания — откройте карту планеты Serpulo";
        if(!"serpulo".equals(g.planet)) return "текущая планета не Serpulo";
        if(!g.canBuild) return "текущий юнит не умеет строить";
        return null;
    }

    // --------------------------------------------------------- research solver

    public static class TechNodeInfo{
        public int index;
        public String name = "";
        public int parent = -1;
        public boolean unlocked;
        public boolean isSectorPreset;
        public boolean nonResearchObjectivesMet = true;
        public boolean allObjectivesMet = true;
        public boolean canAffordAny;
        public boolean canFinishNow;
        public int remainingCost;
        public int essentialTier = 1;
        public int[] researchDeps = new int[0];
    }

    /**
     * Computes which locked TechNodes sit on the dependency path of any frontier
     * SectorPreset (or the final interplanetary accelerator) and returns all
     * currently spendable node indices sorted from highest to lowest priority.
     */
    public static int[] rankResearchNodes(TechNodeInfo[] nodes, int finalGoalIndex){
        int n = nodes == null ? 0 : nodes.length;
        if(n == 0) return new int[0];

        boolean[] critical = computeCriticalTechMask(nodes, finalGoalIndex);

        int count = 0;
        for(int i = 0; i < n; i++){
            TechNodeInfo node = nodes[i];
            if(isSpendableNow(node, nodes)) count++;
        }
        int[] out = new int[count];
        int at = 0;
        for(int i = 0; i < n; i++){
            if(isSpendableNow(nodes[i], nodes)) out[at++] = i;
        }

        // Stable insertion sort by priority score descending, then remainingCost ascending.
        for(int i = 1; i < out.length; i++){
            int cur = out[i];
            int j = i - 1;
            while(j >= 0 && compareResearch(nodes[cur], critical[cur], nodes[out[j]], critical[out[j]]) < 0){
                out[j + 1] = out[j];
                j--;
            }
            out[j + 1] = cur;
        }
        return out;
    }

    private static boolean isSpendableNow(TechNodeInfo node, TechNodeInfo[] all){
        if(node == null || node.unlocked || node.isSectorPreset) return false;
        if(node.parent >= 0 && node.parent < all.length && !all[node.parent].unlocked) return false;
        if(!node.allObjectivesMet) return false;
        return node.canAffordAny || node.remainingCost <= 0;
    }

    private static int compareResearch(TechNodeInfo a, boolean critA, TechNodeInfo b, boolean critB){
        if(critA != critB) return critA ? -1 : 1;
        if(a.canFinishNow != b.canFinishNow) return a.canFinishNow ? -1 : 1;
        if(a.essentialTier != b.essentialTier) return Integer.compare(b.essentialTier, a.essentialTier);
        if(a.remainingCost != b.remainingCost) return Integer.compare(a.remainingCost, b.remainingCost);
        return Integer.compare(a.index, b.index);
    }

    /** Marks every TechNode required to unlock frontier SectorPresets or finalGoalIndex. */
    public static boolean[] computeCriticalTechMask(TechNodeInfo[] nodes, int finalGoalIndex){
        int n = nodes == null ? 0 : nodes.length;
        boolean[] critical = new boolean[n];
        int[] queue = new int[Math.max(1, n * 2)];
        int head = 0, tail = 0;

        boolean anyFrontierPreset = false;
        for(int i = 0; i < n; i++){
            TechNodeInfo node = nodes[i];
            if(node == null || !node.isSectorPreset || node.unlocked) continue;
            boolean parentReady = node.parent < 0 || node.parent >= n || nodes[node.parent].unlocked;
            if(parentReady && node.nonResearchObjectivesMet){
                anyFrontierPreset = true;
                for(int dep : node.researchDeps){
                    if(dep >= 0 && dep < n && !critical[dep]){
                        critical[dep] = true;
                        queue[tail++] = dep;
                    }
                }
            }
        }

        if(!anyFrontierPreset){
            for(int i = 0; i < n; i++){
                TechNodeInfo node = nodes[i];
                if(node == null || !node.isSectorPreset || node.unlocked) continue;
                for(int dep : node.researchDeps){
                    if(dep >= 0 && dep < n && !critical[dep]){
                        critical[dep] = true;
                        queue[tail++] = dep;
                    }
                }
            }
        }

        if(finalGoalIndex >= 0 && finalGoalIndex < n && !nodes[finalGoalIndex].unlocked && !critical[finalGoalIndex]){
            critical[finalGoalIndex] = true;
            queue[tail++] = finalGoalIndex;
        }

        while(head < tail){
            int cur = queue[head++];
            TechNodeInfo info = nodes[cur];
            if(info == null) continue;
            if(info.parent >= 0 && info.parent < n && !nodes[info.parent].unlocked && !critical[info.parent]){
                critical[info.parent] = true;
                if(tail < queue.length) queue[tail++] = info.parent;
            }
            for(int dep : info.researchDeps){
                if(dep >= 0 && dep < n && !nodes[dep].unlocked && !critical[dep]){
                    critical[dep] = true;
                    if(tail < queue.length) queue[tail++] = dep;
                }
            }
        }
        return critical;
    }

    /** Essential tier for Serpulo blocks and units (3 = core progression, 2 = strong, 1 = optional). */
    public static int essentialTechTier(String name){
        if(name == null) return 1;
        switch(name){
            case "conveyor":
            case "junction":
            case "router":
            case "item-bridge":
            case "titanium-conveyor":
            case "container":
            case "unloader":
            case "vault":
            case "mechanical-drill":
            case "pneumatic-drill":
            case "laser-drill":
            case "blast-drill":
            case "mechanical-pump":
            case "conduit":
            case "water-extractor":
            case "cultivator":
            case "graphite-press":
            case "silicon-smelter":
            case "kiln":
            case "spore-press":
            case "coal-centrifuge":
            case "plastanium-compressor":
            case "cryofluid-mixer":
            case "surge-smelter":
            case "phase-weaver":
            case "combustion-generator":
            case "power-node":
            case "power-node-large":
            case "battery":
            case "steam-generator":
            case "thermal-generator":
            case "thorium-reactor":
            case "impact-reactor":
            case "duo":
            case "scatter":
            case "copper-wall":
            case "copper-wall-large":
            case "titanium-wall":
            case "titanium-wall-large":
            case "mender":
            case "mend-projector":
            case "hail":
            case "arc":
            case "lancer":
            case "salvo":
            case "ripple":
            case "swarmer":
            case "cyclone":
            case "spectre":
            case "ground-factory":
            case "dagger":
            case "mace":
            case "fortress":
            case "air-factory":
            case "flare":
            case "horizon":
            case "zenith":
            case "mono":
            case "poly":
            case "mega":
            case "naval-factory":
            case "risso":
            case "minke":
            case "bryde":
            case "sei":
            case "omura":
            case "retusa":
            case "oxynoe":
            case "additive-reconstructor":
            case "multiplicative-reconstructor":
            case "exponential-reconstructor":
            case "tetrative-reconstructor":
            case "core-foundation":
            case "core-nucleus":
            case "payload-conveyor":
            case "mass-driver":
            case "advanced-launch-pad":
            case "interplanetary-accelerator":
                return 3;
            case "scorch":
            case "wave":
            case "meltdown":
            case "force-projector":
            case "overdrive-projector":
            case "rtg-generator":
            case "solar-panel":
            case "pyratite-mixer":
            case "blast-mixer":
            case "pulverizer":
            case "multi-press":
            case "oil-extractor":
            case "plastanium-wall":
            case "thorium-wall":
            case "surge-wall":
            case "nova":
            case "pulsar":
            case "quasar":
            case "crawler":
            case "atrax":
            case "spiroct":
            case "arkyid":
            case "door":
                return 2;
            default:
                return 1;
        }
    }

    // --------------------------------------------------- campaign sector choice

    public static class SectorCandidate{
        public int id;
        public String name = "";
        public boolean isPreset;
        public boolean onVictoryPath;
        public boolean isFinalSector;
        public boolean captured;
        public boolean hasBase;
        public boolean underAttack;
        public boolean unlocked;
        public boolean canLaunchNow;
        public boolean hasEnemyBase;
        public float difficulty;
        public int losses;
        /** Score of how many missing tech/launch resources this captured base can supply. */
        public int farmingScore;
    }

    /**
     * Picks the best next sector on Serpulo to play or launch into, or -1 if none.
     * Order:
     * <ol>
     *   <li>Defend an invaded preset base (protects SectorComplete objectives).</li>
     *   <li>Launch to / resume an uncaptured, unlocked SectorPreset (victory-path first, lowest difficulty first).</li>
     *   <li>Defend an invaded numbered base.</li>
     *   <li>Visit the best captured farming base when resources/research are needed to unlock the next preset.</li>
     * </ol>
     */
    public static int chooseNextSector(SectorCandidate[] sectors){
        if(sectors == null || sectors.length == 0) return -1;
        int bestIndex = -1;
        long bestScore = Long.MIN_VALUE;

        for(int i = 0; i < sectors.length; i++){
            SectorCandidate s = sectors[i];
            if(s == null || s.losses >= MAX_SECTOR_LOSSES) continue;

            long score = Long.MIN_VALUE;
            if(s.hasBase && s.underAttack){
                score = s.isPreset ? 900_000L : 350_000L;
                score -= (long)(s.difficulty * 500f);
            }else if(s.isPreset && !s.captured && s.unlocked && s.canLaunchNow){
                if(s.isFinalSector){
                    score = 700_000L;
                }else{
                    score = (s.onVictoryPath ? 800_000L : 500_000L)
                            - (long)(s.difficulty * 4_000f)
                            - (s.hasEnemyBase ? 1_200L : 0L)
                            + (s.hasBase ? 2_500L : 0L)
                            - s.losses * 10_000L;
                }
            }else if(s.captured && s.hasBase && s.farmingScore > 0){
                score = 100_000L + s.farmingScore * 100L;
            }

            if(score > bestScore){
                bestScore = score;
                bestIndex = i;
            }
        }
        return bestScore == Long.MIN_VALUE ? -1 : bestIndex;
    }

    /**
     * Decides whether the bot should stay in a freshly captured sector a little
     * longer before leaving: e.g. to stockpile core launch copper/lead or produce
     * missing items present on this sector for a critical research node.
     */
    public static boolean shouldHoldCapturedSector(
            boolean anotherSectorUnderAttack,
            boolean hasLaunchablePresetNow,
            boolean launchOriginCanAffordCore,
            boolean sectorProducesNeededTechItem,
            float coreFillFraction,
            float heldSeconds){
        if(anotherSectorUnderAttack) return false;
        if(coreFillFraction >= 0.88f) return false;
        if(!launchOriginCanAffordCore && heldSeconds < POST_CAPTURE_MAX_HOLD_SEC * 1.5f) return true;
        if(!hasLaunchablePresetNow && sectorProducesNeededTechItem && heldSeconds < POST_CAPTURE_MAX_HOLD_SEC * 2f){
            return true;
        }
        if(sectorProducesNeededTechItem && heldSeconds < POST_CAPTURE_MAX_HOLD_SEC){
            return true;
        }
        return false;
    }

    // --------------------------------------------------- in-sector observations

    public static class SectorObservation{
        public boolean captured;
        public boolean holdAfterCapture;
        public boolean attackMode;
        public boolean playerAlive = true;
        public int buildQueue;
        public boolean rearmInProgress;
        public int rearmTargets;
        public boolean coreUpgradeReady;
        public boolean powerNeeded;
        public boolean powerPossible;
        public int defenseSlots;
        public int rebuildSlots;
        public int drills;
        public boolean drillPossible;
        public boolean industryPossible;
        public boolean armyPossible;
        public boolean courierPossible;
        public boolean minePossible;
        // Wave state
        public boolean waves;
        public boolean waveSending;
        public boolean waveTimer;
        public boolean spawning;
        public int enemies;
        public int wave;
        public int winWave;
        public float waveTimeSec = -1f;
        public float coreHealthFrac = 1f;
        public float secondsSinceWaveCall = Float.MAX_VALUE;
        public float defenseDps;
        public float nextWaveHp;
        public float nextWaveDps;
        public float defensePoolHp;
        // v2.0 strategic bias from the planner (Gemma or the built-in heuristic); empty / NaN = v1 behaviour
        public String priority = "";
        public float aggression = Float.NaN;
    }

    public static class Decision{
        public final int action;
        public final String reason;

        public Decision(int action, String reason){
            this.action = action;
            this.reason = reason;
        }
    }

    /**
     * Chooses one atomic in-sector action per cycle.
     */
    public static Decision decideSector(SectorObservation o){
        if(o.captured && !o.holdAfterCapture){
            return new Decision(ACT_READY_NEXT_SECTOR, "сектор захвачен — готов к вылету");
        }
        if(!o.playerAlive){
            return new Decision(ACT_WAIT, "ждём возрождения юнита ядра");
        }
        if(o.rearmInProgress){
            return new Decision(ACT_REARM, "доставляю боеприпасы в турель");
        }
        if(o.buildQueue > 0){
            return new Decision(ACT_WAIT, "строится объектов: " + o.buildQueue);
        }
        if(o.rearmTargets > 0){
            return new Decision(ACT_REARM, "заряжаю турели (" + o.rearmTargets + ")");
        }
        if(o.coreUpgradeReady){
            return new Decision(ACT_UPGRADE_CORE, "расширяю ядро / хранилище");
        }
        if(o.powerNeeded && o.powerPossible){
            return new Decision(ACT_POWER, "строю генератор / энергосеть");
        }
        if(o.rebuildSlots > 0){
            return new Decision(ACT_REBUILD, "восстанавливаю постройки (" + o.rebuildSlots + ")");
        }
        // Keep early economy alive before over-investing in walls/turrets
        if(o.drills < 3 && o.drillPossible){
            return new Decision(ACT_DRILL, "стартовые буры (" + o.drills + "/3)");
        }
        // v2.0 strategic bias: the planner can pull industry / army forward
        if(!o.captured && "EXPAND_SILICON_ECONOMY".equals(o.priority) && o.industryPossible && o.drills >= 3 && o.defenseSlots <= 2){
            return new Decision(ACT_INDUSTRY, "стратегия: расширяю кремниевую экономику");
        }
        if(!o.captured && ("BUILD_T3_AIR_FLANK".equals(o.priority) || "BUILD_ARMY".equals(o.priority)) && o.armyPossible && o.drills >= 3 && o.defenseSlots <= 2){
            return new Decision(ACT_ARMY, "стратегия: строю армию (" + o.priority + ")");
        }
        if(!o.captured && o.defenseSlots > 0){
            return new Decision(ACT_DEFEND, "укрепляю оборону (" + o.defenseSlots + ")");
        }
        if(o.drills < 8 && o.drillPossible){
            return new Decision(ACT_DRILL, "расширяю добычу (" + o.drills + "/" + MAX_DRILLS + ")");
        }
        if(o.industryPossible){
            return new Decision(ACT_INDUSTRY, "строю переработку ресурсов");
        }
        if(o.armyPossible){
            return new Decision(ACT_ARMY, o.attackMode ? "строю ударные заводы юнитов" : "строю заводы поддержки");
        }
        if(o.drills < MAX_DRILLS && o.drillPossible){
            return new Decision(ACT_DRILL, "дополнительные буры (" + o.drills + "/" + MAX_DRILLS + ")");
        }
        if(o.powerPossible && !o.captured){
            return new Decision(ACT_POWER, "наращиваю запас энергии");
        }
        if(o.courierPossible){
            return new Decision(ACT_COURIER, "загружаю завод ресурсами из ядра");
        }
        if(!o.captured && !o.attackMode){
            String waveProblem = waveCallProblem(o);
            if(waveProblem == null){
                return new Decision(ACT_CALL_WAVE, "вызываю волну " + (o.wave + 1));
            }
            if(o.minePossible){
                return new Decision(ACT_MINE, waveProblem);
            }
            return new Decision(ACT_WAIT, waveProblem);
        }
        if(o.minePossible){
            return new Decision(ACT_MINE, o.captured ? "коплю ресурсы для технологий и вылета" : "добываю ресурсы для армии");
        }
        return new Decision(ACT_WAIT, o.captured ? "заводы копят ресурсы для технологий" : "готовим штурмовую группу");
    }

    /** Checks if calling the next wave immediately is safe. */
    public static String waveCallProblem(SectorObservation o){
        if(!o.waves || !o.waveSending) return "вызов волн недоступен";
        if(o.attackMode) return "режим штурма базы — лишние волны не вызываем";
        if(o.winWave > 0 && o.wave >= o.winWave){
            return o.enemies > 0 ? "добиваем финальную волну" : "ждём зачёта сектора";
        }
        if(o.enemies > 0 || o.spawning) return "идёт бой с текущей волной";
        if(o.coreHealthFrac < MIN_CORE_HEALTH_FOR_WAVE) return "ядро повреждено — ждём починки";
        if(o.secondsSinceWaveCall < WAVE_CALL_COOLDOWN_SEC) return "пауза между волнами";

        if("HOLD_AND_RESEARCH".equals(o.priority) && o.waveTimer) return "стратегия: копим ресурсы и науку, волну не торопим";
        boolean strongEnough = canSurviveWave(o.defenseDps, o.defensePoolHp, o.nextWaveHp, o.nextWaveDps,
            (o.waveTimer ? 2.2f : 1.15f) * ProLogic.aggressionSafetyScale(o.aggression));
        if(o.waveTimer){
            if(o.waveTimeSec >= 0f && o.waveTimeSec < EARLY_CALL_MIN_TIMER_SEC){
                return "волна скоро придёт по таймеру";
            }
            return strongEnough ? null : "оборона копит запас перед волной";
        }
        return strongEnough ? null : "нужно усилить оборону перед следующей волной";
    }

    public static boolean canSurviveWave(float defenseDps, float defensePoolHp, float waveHp, float waveDps, float safetyFactor){
        if(waveHp <= 0f) return defenseDps >= 15f;
        float effDefDps = Math.max(1f, defenseDps * 0.55f);
        if(effDefDps <= 8f) return false;
        float killTime = waveHp / effDefDps;
        if(killTime > 28f) return false;
        float incomingDamage = waveDps * 0.35f * 0.65f * killTime * safetyFactor;
        return defensePoolHp > Math.max(220f, incomingDamage);
    }

    // --------------------------------------------------------- squad assault AI

    /**
     * Decides whether friendly combat units should rally at base, defend against
     * close enemies, or storm the enemy base/core.
     */
    public static int decideSquadMode(
            boolean attackMode,
            int currentMode,
            int combatUnits,
            int unitCap,
            int enemiesNearBase,
            float sectorDifficulty){
        if(combatUnits <= 0) return SQUAD_RALLY;
        if(enemiesNearBase > 0 && (!attackMode || combatUnits < 6)){
            return SQUAD_DEFEND;
        }
        if(!attackMode){
            return enemiesNearBase > 0 ? SQUAD_DEFEND : SQUAD_RALLY;
        }
        int baseThreshold = sectorDifficulty <= 3f ? 6
                : sectorDifficulty <= 5f ? 11
                : sectorDifficulty <= 7f ? 16 : 20;
        int launchThreshold = unitCap > 0 ? Math.min(baseThreshold, Math.max(4, (unitCap * 3) / 4)) : baseThreshold;
        int retreatThreshold = Math.max(2, launchThreshold / 3);

        if(currentMode == SQUAD_ASSAULT){
            return combatUnits < retreatThreshold ? SQUAD_RALLY : SQUAD_ASSAULT;
        }
        return combatUnits >= launchThreshold ? SQUAD_ASSAULT : SQUAD_RALLY;
    }

    // --------------------------------------------------- economy & item weights

    public static float itemWeight(String name, boolean needPower, boolean needGraphite, boolean needSilicon, boolean needTitanium, boolean needThorium){
        if(name == null) return 0.1f;
        switch(name){
            case "copper": return 1.0f;
            case "lead": return 0.85f;
            case "coal": return (needPower || needGraphite || needSilicon) ? 1.15f : 0.65f;
            case "sand": return needSilicon ? 0.90f : 0.45f;
            case "titanium": return needTitanium ? 1.10f : 0.80f;
            case "thorium": return needThorium ? 1.05f : 0.75f;
            case "scrap": return 0.25f;
            default: return 0.2f;
        }
    }

    public static int[] rankItems(String[] names, int[] stock, boolean[] available, float[] weights){
        int count = 0;
        for(int i = 0; i < names.length; i++) if(available[i]) count++;
        int[] result = new int[count];
        int at = 0;
        for(int i = 0; i < names.length; i++) if(available[i]) result[at++] = i;

        for(int i = 1; i < result.length; i++){
            int cur = result[i];
            float wCur = weights != null && cur < weights.length ? Math.max(0.05f, weights[cur]) : 0.5f;
            float score = stock[cur] / wCur;
            int j = i - 1;
            while(j >= 0){
                int prev = result[j];
                float wPrev = weights != null && prev < weights.length ? Math.max(0.05f, weights[prev]) : 0.5f;
                if(stock[prev] / wPrev <= score) break;
                result[j + 1] = prev;
                j--;
            }
            result[j + 1] = cur;
        }
        return result;
    }

    public static int sizeOffset(int size){
        return -((size - 1) / 2);
    }

    // ------------------------------------------------ drill + conveyor routing

    public static class DrillSite{
        public int x, y, oreCount, pathLength;
        /** Triples (x, y, rotation) in window coordinates from drill edge to core. */
        public int[] path = new int[0];
    }

    public static int[] coreDistances(int w, int h, int[] cells, int maxPath){
        int[] dist = new int[w * h];
        int[] queue = new int[w * h];
        int head = 0, tail = 0;
        for(int i = 0; i < dist.length; i++) dist[i] = -1;

        for(int y = 0; y < h; y++){
            for(int x = 0; x < w; x++){
                int i = y * w + x;
                if(cells[i] != CELL_FREE && cells[i] != CELL_LANE) continue;
                for(int d = 0; d < 4; d++){
                    int nx = x + DX[d], ny = y + DY[d];
                    if(nx >= 0 && ny >= 0 && nx < w && ny < h && cells[ny * w + nx] == CELL_CORE){
                        dist[i] = 0;
                        queue[tail++] = i;
                        break;
                    }
                }
            }
        }
        while(head < tail){
            int i = queue[head++];
            if(dist[i] >= maxPath - 1) continue;
            int x = i % w, y = i / w;
            for(int d = 0; d < 4; d++){
                int nx = x + DX[d], ny = y + DY[d];
                if(nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                int n = ny * w + nx;
                if((cells[n] != CELL_FREE && cells[n] != CELL_LANE) || dist[n] != -1) continue;
                dist[n] = dist[i] + 1;
                queue[tail++] = n;
            }
        }
        return dist;
    }

    public static DrillSite findDrillSite(int w, int h, int[] cells, int[] ore, int item, int size, int maxPath){
        int[] dist = coreDistances(w, h, cells, maxPath);
        int offset = sizeOffset(size);
        int minOre = Math.max(2, (size * size + 1) / 2);
        DrillSite best = null;
        int bestStart = -1;

        for(int by = 0; by < h; by++){
            for(int bx = 0; bx < w; bx++){
                int x0 = bx + offset, y0 = by + offset;
                if(x0 < 0 || y0 < 0 || x0 + size > w || y0 + size > h) continue;
                int target = 0, other = 0;
                boolean ok = true, touchesCore = false;
                for(int dy = 0; dy < size && ok; dy++){
                    for(int dx = 0; dx < size; dx++){
                        int i = (y0 + dy) * w + (x0 + dx);
                        if(cells[i] != CELL_FREE){
                            ok = false;
                            break;
                        }
                        if(ore[i] == item) target++;
                        else if(ore[i] >= 0) other = Math.max(other, countOre(w, ore, x0, y0, size, ore[i]));
                    }
                }
                if(!ok || target < minOre || target <= other) continue;

                int startCell = -1, startDist = Integer.MAX_VALUE;
                for(int dy = -1; dy <= size; dy++){
                    for(int dx = -1; dx <= size; dx++){
                        boolean edgeX = dx == -1 || dx == size, edgeY = dy == -1 || dy == size;
                        if(edgeX == edgeY) continue;
                        int nx = x0 + dx, ny = y0 + dy;
                        if(nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                        int n = ny * w + nx;
                        if(cells[n] == CELL_CORE) touchesCore = true;
                        else if((cells[n] == CELL_FREE || cells[n] == CELL_LANE) && dist[n] >= 0 && dist[n] < startDist){
                            startDist = dist[n];
                            startCell = n;
                        }
                    }
                }
                int pathLen = touchesCore ? 0 : (startCell >= 0 ? startDist + 1 : -1);
                if(pathLen < 0 || pathLen > maxPath) continue;
                if(best == null
                        || scoreDrillSite(target, pathLen, size) > scoreDrillSite(best.oreCount, best.pathLength, size)){
                    best = new DrillSite();
                    best.x = bx;
                    best.y = by;
                    best.oreCount = target;
                    best.pathLength = pathLen;
                    bestStart = touchesCore ? -1 : startCell;
                }
            }
        }
        if(best == null) return null;
        best.path = tracePath(w, h, cells, dist, bestStart, best.pathLength);
        return best;
    }

    private static int scoreDrillSite(int oreCount, int pathLen, int size){
        return oreCount * 6 - pathLen * 2 + size * 3;
    }

    private static int countOre(int w, int[] ore, int x0, int y0, int size, int item){
        int c = 0;
        for(int dy = 0; dy < size; dy++){
            for(int dx = 0; dx < size; dx++){
                if(ore[(y0 + dy) * w + (x0 + dx)] == item) c++;
            }
        }
        return c;
    }

    private static int[] tracePath(int w, int h, int[] cells, int[] dist, int start, int length){
        int[] path = new int[length * 3];
        int cell = start;
        for(int step = 0; step < length && cell >= 0; step++){
            int x = cell % w, y = cell / w;
            int rotation = 0, next = -1;
            for(int d = 0; d < 4; d++){
                int nx = x + DX[d], ny = y + DY[d];
                if(nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                int n = ny * w + nx;
                if(dist[cell] == 0 ? cells[n] == CELL_CORE : dist[n] == dist[cell] - 1){
                    rotation = d;
                    next = dist[cell] == 0 ? -1 : n;
                    break;
                }
            }
            path[step * 3] = x;
            path[step * 3 + 1] = y;
            path[step * 3 + 2] = rotation;
            cell = next;
        }
        return path;
    }

    public static int nearestOreCell(int w, int h, int[] cells, int[] ore, int item, int cx, int cy, int maxDist){
        for(int r = 0; r <= maxDist; r++){
            for(int y = cy - r; y <= cy + r; y++){
                for(int x = cx - r; x <= cx + r; x++){
                    if(Math.max(Math.abs(x - cx), Math.abs(y - cy)) != r) continue;
                    if(x < 0 || y < 0 || x >= w || y >= h) continue;
                    int i = y * w + x;
                    if(cells[i] == CELL_FREE && ore[i] == item) return i;
                }
            }
        }
        return -1;
    }

    // ----------------------------------- core-hub crafter & unloader geometry

    public static class HubCrafterSlot{
        public int crafterX, crafterY;
        public boolean hasUnloader;
        public int unloaderX, unloaderY;
        public boolean hasSupport;
        public int supportX, supportY;
    }

    /**
     * Finds a compact slot around the Core (or Core-linked Container/Vault) for a
     * solid-item crafter/generator of {@code crafterSize}:
     * <ul>
     *   <li>The crafter footprint is completely {@code CELL_FREE} (and avoids covering scarce ore when possible).</li>
     *   <li>At least one edge cell of the crafter touches {@code CELL_CORE}, so crafted output dumps directly into the Core!</li>
     *   <li>When {@code withUnloader} is true, finds a {@code CELL_FREE} 1x1 cell that touches BOTH {@code CELL_CORE} and the crafter footprint, feeding all inputs from the Core automatically!</li>
     *   <li>When {@code supportSize > 0} (e.g. a 2x2 {@code waterExtractor} or {@code sporePress}), also places the support block adjacent to the crafter!</li>
     *   <li>Leaves at least 2 core perimeter cells free so conveyors from drills can always enter the Core.</li>
     * </ul>
     */
    public static HubCrafterSlot findHubCrafterSlot(
            int w, int h, int[] cells, int[] ore,
            int crafterSize, boolean withUnloader, int supportSize){
        int freeCoreEdges = countFreeCorePerimeter(w, h, cells);
        int neededEdges = 1 + (withUnloader ? 1 : 0);
        if(freeCoreEdges - neededEdges < 2) return null;

        int offset = sizeOffset(crafterSize);
        HubCrafterSlot best = null;
        int bestPenalty = Integer.MAX_VALUE;

        for(int cy = 1; cy < h - 1; cy++){
            for(int cx = 1; cx < w - 1; cx++){
                int x0 = cx + offset, y0 = cy + offset;
                if(!rectFree(w, h, cells, x0, y0, crafterSize)) continue;
                if(!rectTouches(w, h, cells, x0, y0, crafterSize, CELL_CORE)) continue;

                int ux = -1, uy = -1;
                if(withUnloader){
                    int uCell = findUnloaderCell(w, h, cells, x0, y0, crafterSize);
                    if(uCell < 0) continue;
                    ux = uCell % w;
                    uy = uCell / w;
                }

                int sx = -1, sy = -1;
                if(supportSize > 0){
                    int sCell = findSupportBlockOrigin(w, h, cells, x0, y0, crafterSize, ux, uy, supportSize);
                    if(sCell < 0) continue;
                    sx = sCell % w;
                    sy = sCell / w;
                }

                int penalty = countRectOre(w, ore, x0, y0, crafterSize) * 10;
                if(withUnloader && ore != null && ore[uy * w + ux] >= 0) penalty += 5;
                if(penalty < bestPenalty){
                    bestPenalty = penalty;
                    best = new HubCrafterSlot();
                    best.crafterX = cx;
                    best.crafterY = cy;
                    best.hasUnloader = withUnloader;
                    best.unloaderX = ux;
                    best.unloaderY = uy;
                    best.hasSupport = supportSize > 0;
                    best.supportX = sx;
                    best.supportY = sy;
                }
            }
        }
        return best;
    }

    public static int countFreeCorePerimeter(int w, int h, int[] cells){
        int count = 0;
        for(int y = 0; y < h; y++){
            for(int x = 0; x < w; x++){
                if(cells[y * w + x] != CELL_FREE && cells[y * w + x] != CELL_LANE) continue;
                for(int d = 0; d < 4; d++){
                    int nx = x + DX[d], ny = y + DY[d];
                    if(nx >= 0 && ny >= 0 && nx < w && ny < h && cells[ny * w + nx] == CELL_CORE){
                        count++;
                        break;
                    }
                }
            }
        }
        return count;
    }

    public static boolean rectFree(int w, int h, int[] cells, int x0, int y0, int size){
        if(x0 < 0 || y0 < 0 || x0 + size > w || y0 + size > h) return false;
        for(int dy = 0; dy < size; dy++){
            for(int dx = 0; dx < size; dx++){
                if(cells[(y0 + dy) * w + (x0 + dx)] != CELL_FREE) return false;
            }
        }
        return true;
    }

    public static boolean rectTouches(int w, int h, int[] cells, int x0, int y0, int size, int targetCellKind){
        for(int dy = 0; dy < size; dy++){
            for(int dx = 0; dx < size; dx++){
                int x = x0 + dx, y = y0 + dy;
                for(int d = 0; d < 4; d++){
                    int nx = x + DX[d], ny = y + DY[d];
                    if(nx >= 0 && ny >= 0 && nx < w && ny < h && cells[ny * w + nx] == targetCellKind){
                        return true;
                    }
                }
            }
        }
        return false;
    }

    static int findUnloaderCell(int w, int h, int[] cells, int x0, int y0, int size){
        for(int dy = -1; dy <= size; dy++){
            for(int dx = -1; dx <= size; dx++){
                boolean edgeX = dx == -1 || dx == size, edgeY = dy == -1 || dy == size;
                if(edgeX == edgeY) continue;
                int ux = x0 + dx, uy = y0 + dy;
                if(ux < 0 || uy < 0 || ux >= w || uy >= h) continue;
                if(cells[uy * w + ux] != CELL_FREE && cells[uy * w + ux] != CELL_LANE) continue;
                for(int d = 0; d < 4; d++){
                    int nx = ux + DX[d], ny = uy + DY[d];
                    if(nx >= 0 && ny >= 0 && nx < w && ny < h && cells[ny * w + nx] == CELL_CORE){
                        return uy * w + ux;
                    }
                }
            }
        }
        return -1;
    }

    private static int findSupportBlockOrigin(
            int w, int h, int[] cells,
            int cx0, int cy0, int cSize,
            int ux, int uy, int sSize){
        int sOff = sizeOffset(sSize);
        for(int sy = cy0 - sSize; sy <= cy0 + cSize + sSize; sy++){
            for(int sx = cx0 - sSize; sx <= cx0 + cSize + sSize; sx++){
                int sx0 = sx + sOff, sy0 = sy + sOff;
                if(!rectFree(w, h, cells, sx0, sy0, sSize)) continue;
                if(rectsOverlap(cx0, cy0, cSize, sx0, sy0, sSize)) continue;
                if(ux >= 0 && ux >= sx0 && ux < sx0 + sSize && uy >= sy0 && uy < sy0 + sSize) continue;
                if(rectsTouchEdge(cx0, cy0, cSize, sx0, sy0, sSize)){
                    return sy * w + sx;
                }
            }
        }
        return -1;
    }

    public static boolean rectsOverlap(int ax0, int ay0, int aSize, int bx0, int by0, int bSize){
        return ax0 < bx0 + bSize && ax0 + aSize > bx0 && ay0 < by0 + bSize && ay0 + aSize > by0;
    }

    public static boolean rectsTouchEdge(int ax0, int ay0, int aSize, int bx0, int by0, int bSize){
        boolean touchX = (ax0 + aSize == bx0 || bx0 + bSize == ax0)
                && (ay0 < by0 + bSize && ay0 + aSize > by0);
        boolean touchY = (ay0 + aSize == by0 || by0 + bSize == ay0)
                && (ax0 < bx0 + bSize && ax0 + aSize > bx0);
        return touchX || touchY;
    }

    private static int countRectOre(int w, int[] ore, int x0, int y0, int size){
        if(ore == null) return 0;
        int c = 0;
        for(int dy = 0; dy < size; dy++){
            for(int dx = 0; dx < size; dx++){
                if(ore[(y0 + dy) * w + (x0 + dx)] >= 0) c++;
            }
        }
        return c;
    }

    // ----------------------------- unit factory + reconstructor chain geometry

    public static class UnitChainSlot{
        public int rotation;
        public int factoryX, factoryY;
        public boolean hasUnloader;
        public int unloaderX, unloaderY;
        public boolean hasAdditive;
        public int additiveX, additiveY;
        public boolean hasMultiplicative;
        public int multiplicativeX, multiplicativeY;
    }

    /**
     * Finds space near the Core (within courier transfer range, preferring an
     * Unloader touching the Core when possible) for a 3x3 UnitFactory and optional
     * aligned 3x3 AdditiveReconstructor + 5x5 MultiplicativeReconstructor + clear exit.
     */
    public static UnitChainSlot findUnitChainSlot(
            int w, int h, int[] cells,
            int coreWinX, int coreWinY,
            boolean allowUnloader,
            boolean wantAdditive,
            boolean wantMultiplicative){
        int fOff = sizeOffset(3);
        int mOff = sizeOffset(5);

        // Pass 0: factory directly fed by an Unloader touching CELL_CORE.
        // Pass 1: factory anywhere within 14 tiles of Core (fed by Core Unit courier).
        for(int pass = allowUnloader ? 0 : 1; pass <= 1; pass++){
            for(int r = 3; r <= 15; r++){
                for(int fy = coreWinY - r; fy <= coreWinY + r; fy++){
                    for(int fx = coreWinX - r; fx <= coreWinX + r; fx++){
                        if(Math.max(Math.abs(fx - coreWinX), Math.abs(fy - coreWinY)) != r) continue;
                        int fx0 = fx + fOff, fy0 = fy + fOff;
                        if(!rectFree(w, h, cells, fx0, fy0, 3)) continue;

                        int ux = -1, uy = -1;
                        if(pass == 0){
                            int uCell = findUnloaderCell(w, h, cells, fx0, fy0, 3);
                            if(uCell < 0) continue;
                            ux = uCell % w;
                            uy = uCell / w;
                        }

                        for(int rot = 0; rot < 4; rot++){
                            int ax = fx + DX[rot] * 3, ay = fy + DY[rot] * 3;
                            int mx = ax + DX[rot] * 4, my = ay + DY[rot] * 4;
                            int exitX, exitY;

                            if(wantAdditive){
                                int ax0 = ax + fOff, ay0 = ay + fOff;
                                if(!rectFree(w, h, cells, ax0, ay0, 3)) continue;
                                if(ux >= 0 && ux >= ax0 && ux < ax0 + 3 && uy >= ay0 && uy < ay0 + 3) continue;
                                if(wantMultiplicative){
                                    int mx0 = mx + mOff, my0 = my + mOff;
                                    if(!rectFree(w, h, cells, mx0, my0, 5)) continue;
                                    if(ux >= 0 && ux >= mx0 && ux < mx0 + 5 && uy >= my0 && uy < my0 + 5) continue;
                                    exitX = mx + DX[rot] * 3;
                                    exitY = my + DY[rot] * 3;
                                }else{
                                    exitX = ax + DX[rot] * 2;
                                    exitY = ay + DY[rot] * 2;
                                }
                            }else{
                                exitX = fx + DX[rot] * 2;
                                exitY = fy + DY[rot] * 2;
                            }

                            if(exitX < 0 || exitY < 0 || exitX >= w || exitY >= h) continue;
                            if(cells[exitY * w + exitX] != CELL_FREE) continue;
                            if(exitX == ux && exitY == uy) continue;

                            UnitChainSlot slot = new UnitChainSlot();
                            slot.rotation = rot;
                            slot.factoryX = fx;
                            slot.factoryY = fy;
                            slot.hasUnloader = ux >= 0;
                            slot.unloaderX = ux;
                            slot.unloaderY = uy;
                            slot.hasAdditive = wantAdditive;
                            slot.additiveX = ax;
                            slot.additiveY = ay;
                            slot.hasMultiplicative = wantAdditive && wantMultiplicative;
                            slot.multiplicativeX = mx;
                            slot.multiplicativeY = my;
                            return slot;
                        }
                    }
                }
            }
        }
        return null;
    }

    // --------------------------------------------------- defense bunker layout

    public static final int ROLE_WALL = 0;
    public static final int ROLE_GROUND_TURRET = 1;
    public static final int ROLE_AIR_TURRET = 2;
    public static final int ROLE_SUPPORT = 3;
    public static final int ROLE_POWER_NODE = 4;

    /**
     * Generates a directional defensive battery centered at {@code (cx, cy)} facing
     * threat direction {@code (dirX, dirY)}: front wall arc, anti-ground turrets,
     * anti-air turrets, support mender/projector, and a power node behind.
     * Returns flat triples {@code (tileX, tileY, role)}.
     */
    public static int[] buildFortressTemplate(int cx, int cy, float dirX, float dirY){
        float len = (float)Math.hypot(dirX, dirY);
        float fx = len < 1e-4f ? 1f : dirX / len;
        float fy = len < 1e-4f ? 0f : dirY / len;
        // Snap forward vector to dominant axis + perpendicular lateral axis for crisp grid packing.
        int sx, sy, px, py;
        if(Math.abs(fx) >= Math.abs(fy)){
            sx = fx >= 0f ? 1 : -1;
            sy = 0;
            px = 0;
            py = 1;
        }else{
            sx = 0;
            sy = fy >= 0f ? 1 : -1;
            px = 1;
            py = 0;
        }

        // 16-slot template: 7 front walls, 4 ground turrets, 3 AA turrets, 1 support, 1 power node.
        int[][] rel = {
            // Front wall line (forward +2)
            {2, -3, ROLE_WALL}, {2, -2, ROLE_WALL}, {2, -1, ROLE_WALL}, {2, 0, ROLE_WALL},
            {2, 1, ROLE_WALL}, {2, 2, ROLE_WALL}, {2, 3, ROLE_WALL},
            // Main turret row (forward 0)
            {0, -2, ROLE_GROUND_TURRET}, {0, 0, ROLE_GROUND_TURRET}, {0, 2, ROLE_GROUND_TURRET}, {0, 4, ROLE_GROUND_TURRET},
            // Anti-air + support row (backward -2)
            {-2, -2, ROLE_AIR_TURRET}, {-2, 2, ROLE_AIR_TURRET}, {-2, -4, ROLE_AIR_TURRET},
            {-1, 0, ROLE_SUPPORT},
            {-3, 0, ROLE_POWER_NODE}
        };

        int[] out = new int[rel.length * 3];
        for(int i = 0; i < rel.length; i++){
            int f = rel[i][0], lat = rel[i][1], role = rel[i][2];
            out[i * 3] = cx + sx * f + px * lat;
            out[i * 3 + 1] = cy + sy * f + py * lat;
            out[i * 3 + 2] = role;
        }
        return out;
    }

    // --------------------------------------------------------------- watchdog

    public static class Watchdog{
        public float lastProgressSec = Float.NaN;
        public long lastToken = Long.MIN_VALUE;
        public int failures;
        public String failKey = "";

        public boolean stalled(boolean busy, long token, float nowSec){
            if(!busy || token != lastToken || Float.isNaN(lastProgressSec)){
                lastToken = token;
                lastProgressSec = nowSec;
                return false;
            }
            return nowSec - lastProgressSec >= STALL_SECONDS;
        }

        public boolean fail(String key){
            if(key != null && key.equals(failKey)){
                failures++;
            }else{
                failKey = key == null ? "" : key;
                failures = 1;
            }
            return failures >= MAX_FAILURES;
        }

        public void success(){
            failures = 0;
            failKey = "";
        }

        public void reset(){
            success();
            lastToken = Long.MIN_VALUE;
            lastProgressSec = Float.NaN;
        }
    }

    // --------------------------------------------------------------- HUD text

    public static String formatHudText(
            int state,
            int capturedPresets,
            int totalPresets,
            String sectorTitle,
            String phaseText,
            String researchText,
            String armyText,
            String detailText){
        return formatHudText(state, capturedPresets, totalPresets, sectorTitle, phaseText, researchText, armyText, detailText, null);
    }

    public static String formatHudText(
            int state,
            int capturedPresets,
            int totalPresets,
            String sectorTitle,
            String phaseText,
            String researchText,
            String armyText,
            String detailText,
            String thoughtLine){
        StringBuilder sb = new StringBuilder();
        sb.append("[").append(stateColor(state)).append("]🤖 Автокампания Serpulo: ")
          .append(stateName(state)).append("[]");
        sb.append(" [lightgray](").append(capturedPresets).append("/").append(totalPresets).append(" сюж.)[]");

        if(sectorTitle != null && !sectorTitle.isEmpty()){
            sb.append("\n📍 Сектор: [white]").append(sectorTitle).append("[]");
        }
        if(phaseText != null && !phaseText.isEmpty()){
            sb.append("\n⚙ Задача: [accent]").append(phaseText).append("[]");
        }
        if(researchText != null && !researchText.isEmpty()){
            sb.append("\n🔬 Наука: [lightgray]").append(researchText).append("[]");
        }
        if(armyText != null && !armyText.isEmpty()){
            sb.append("\n⚔ Армия: [lightgray]").append(armyText).append("[]");
        }
        if(detailText != null && !detailText.isEmpty()){
            sb.append("\n💬 [lightgray]").append(detailText).append("[]");
        }
        if(thoughtLine != null && !thoughtLine.isEmpty()){
            sb.append("\n").append(thoughtLine);
        }
        return sb.toString();
    }
}
