package campaignradar;

/**
 * Pure, deterministic decision logic of the Serpulo campaign autopilot.
 * <p>
 * This class intentionally has <b>no</b> dependency on Mindustry or Arc: it only
 * works with plain numbers, strings and arrays. Everything that reads or changes
 * the game lives in {@link Autopilot}; this split keeps the rules testable without
 * the game ({@code src/test/java/campaignradar/AutopilotLogicCheck.java}) and is
 * mirrored one-to-one by the {@code autopilot*} functions of the script version.
 */
public final class AutopilotLogic{
    // ------------------------------------------------------------------ states

    /** Autopilot is disabled; it never touches the world in this state. */
    public static final int OFF = 0;
    /** Autopilot observes the sector and executes one small action per cycle. */
    public static final int RUNNING = 1;
    /** Temporarily stopped by the player; resumes from the same state. */
    public static final int PAUSED = 2;
    /** Stopped by a safety check; the reason explains what the player must do. */
    public static final int NEEDS_HELP = 3;
    /** The active sector was captured; nothing else to do in this sector. */
    public static final int COMPLETE = 4;

    /** Player pressed "start" (or "resume"). */
    public static final int CMD_START = 0;
    /** Player pressed "pause". */
    public static final int CMD_PAUSE = 1;
    /** Player pressed "stop" (emergency stop). */
    public static final int CMD_STOP = 2;
    /** A guard or the watchdog failed. */
    public static final int CMD_FAIL = 3;
    /** The sector was captured. */
    public static final int CMD_CAPTURED = 4;

    // ----------------------------------------------------------------- actions

    /** Nothing to do this cycle (building in progress, respawning, ...). */
    public static final int ACT_WAIT = 0;
    /** Bring ammo from the core to a turret that runs dry. */
    public static final int ACT_REARM = 1;
    /** Build defence (Duo / walls / Scatter) on the weakest approach. */
    public static final int ACT_DEFEND = 2;
    /** Rebuild destroyed blocks from the team's rebuild queue. */
    public static final int ACT_REBUILD = 3;
    /** Place a mechanical drill on ore with a conveyor line to the core. */
    public static final int ACT_DRILL = 4;
    /** Let the core unit mine ore that goes straight into the core. */
    public static final int ACT_MINE = 5;
    /** Call the next wave (the real "skip wave" button). */
    public static final int ACT_CALL_WAVE = 6;
    /** The sector is finished. */
    public static final int ACT_DONE = 7;

    // ----------------------------------------------------------------- grid

    /** Window cell: a conveyor/drill may be placed here. */
    public static final int CELL_FREE = 0;
    /** Window cell: occupied, liquid, outside the map or otherwise unusable. */
    public static final int CELL_BLOCKED = 1;
    /** Window cell: part of a friendly core. */
    public static final int CELL_CORE = 2;

    /** Blueprint kinds (same values as CampaignThreatRadar.PLAN_*). */
    public static final int PLAN_WALL = 0, PLAN_DUO = 1, PLAN_SCATTER = 2, PLAN_MENDER = 3;
    /** Weak point kinds (same values as CampaignThreatRadar.MARKER_*). */
    public static final int MARKER_GROUND = 0, MARKER_AIR = 1, MARKER_WALL = 2, MARKER_SUPPLY = 3, MARKER_REPAIR = 4;

    // ------------------------------------------------------------- tuning

    /** One decision per second; movement is still updated every frame. */
    public static final float DECISION_INTERVAL_TICKS = 60f;
    /** Upper bound of build plans queued in one decision. */
    public static final int MAX_PLANS_PER_CYCLE = 24;
    /** Upper bound of defence/rebuild plans queued in one decision. */
    public static final int MAX_DEFENSE_PLANS_PER_CYCLE = 4;
    /** Number of automatic drills the autopilot keeps in a sector. */
    public static final int MAX_DRILLS = 12;
    /** Longest conveyor line between a drill and the core, in tiles. */
    public static final int MAX_CONVEYOR_PATH = 20;
    /** Half size of the observed square window around the core, in tiles. */
    public static final int WINDOW_RADIUS = 24;
    /** Copper that is never spent on buildings, so turrets can still be rearmed. */
    public static final int COPPER_RESERVE = 40;
    /** A turret is rearmed when its ammo drops below this share of the maximum. */
    public static final float REARM_FRACTION = 0.34f;
    /** Minimum core amount of an ammo item to start a rearm trip. */
    public static final int MIN_AMMO_STOCK = 10;
    /** Minimum pause between two called waves, in seconds. */
    public static final float WAVE_CALL_COOLDOWN_SEC = 20f;
    /** With a running wave timer, call early only if this many extra waves are safe. */
    public static final int SAFE_WAVE_MARGIN = 3;
    /** Calling early makes no sense when the timer will fire soon anyway, in seconds. */
    public static final float EARLY_CALL_MIN_TIMER_SEC = 15f;
    /** Do not call a wave while the weakest core is below this HP share. */
    public static final float MIN_CORE_HEALTH_FOR_WAVE = 0.8f;
    /** Building queue without any progress for this long means "stuck", in seconds. */
    public static final float STALL_SECONDS = 45f;
    /** The same failing action this many times in a row means "stuck". */
    public static final int MAX_FAILURES = 5;
    /** How long to wait for the core unit to respawn, in seconds. */
    public static final float RESPAWN_WAIT_SECONDS = 30f;

    private AutopilotLogic(){
    }

    /** Short state name for the HUD. */
    public static String stateName(int state){
        switch(state){
            case RUNNING: return "РАБОТАЕТ";
            case PAUSED: return "ПАУЗА";
            case NEEDS_HELP: return "НУЖНА ПОМОЩЬ";
            case COMPLETE: return "СЕКТОР ЗАХВАЧЕН";
            default: return "ВЫКЛ";
        }
    }

    /** Markup colour of a state. */
    public static String stateColor(int state){
        switch(state){
            case RUNNING: return "green";
            case PAUSED: return "yellow";
            case NEEDS_HELP: return "scarlet";
            case COMPLETE: return "accent";
            default: return "lightgray";
        }
    }

    /** Human readable action name for the journal. */
    public static String actionName(int action){
        switch(action){
            case ACT_REARM: return "патроны";
            case ACT_DEFEND: return "оборона";
            case ACT_REBUILD: return "восстановление";
            case ACT_DRILL: return "бур";
            case ACT_MINE: return "добыча";
            case ACT_CALL_WAVE: return "волна";
            case ACT_DONE: return "готово";
            default: return "ожидание";
        }
    }

    /**
     * State machine of the autopilot. Unknown or impossible commands keep the state.
     * {@code CMD_START} is only accepted by the caller after the guard passed.
     */
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
            case CMD_CAPTURED:
                return state == RUNNING || state == PAUSED ? COMPLETE : state;
            default:
                return state;
        }
    }

    // ------------------------------------------------------------- guard

    /** Everything the safety guard needs to know about the session. */
    public static class Guard{
        public boolean inGame, netActive, campaign, gameOver;
        /** Internal planet name, e.g. "serpulo". */
        public String planet = "";
        /** Campaign difficulty enum name, e.g. "normal". */
        public String difficulty = "";
        /** False only when the controlled unit exists and cannot build. */
        public boolean canBuild = true;
    }

    /** @return null when the autopilot may act, otherwise the reason it must not. */
    public static String guardReason(Guard g){
        if(g == null || !g.inGame) return "нет активной игры";
        if(g.netActive) return "сетевая игра — автопилот работает только в одиночной кампании";
        if(!g.campaign) return "это не кампания — автопилот работает только в секторе кампании";
        if(!"serpulo".equals(g.planet)) return "планета не Serpulo";
        if(!"normal".equals(g.difficulty)) return "сложность кампании не Normal";
        if(g.gameOver) return "игра окончена";
        if(!g.canBuild) return "текущий юнит не умеет строить";
        return null;
    }

    // ---------------------------------------------------------- sector goal

    /** What the sector requires, read once per decision. */
    public static class Goal{
        public boolean captured, waves, attackMode;
        public int winWave;
    }

    /**
     * @return null when the autopilot can work toward capturing this sector,
     * otherwise why stage 1 cannot finish it.
     */
    public static String goalProblem(Goal goal){
        if(goal == null) return "цель сектора неизвестна";
        if(goal.captured) return null;
        if(goal.attackMode) return "нужно уничтожить вражескую базу — атака пока не поддерживается";
        if(!goal.waves) return "в секторе нет волн — цель сектора не распознана";
        if(goal.winWave <= 0) return "у сектора нет волны победы — бесконечную оборону автопилот не завершит";
        return null;
    }

    // ------------------------------------------------------------- decision

    /** Snapshot of everything the decision needs; filled by the world adapter. */
    public static class Observation{
        public boolean captured;
        public boolean playerAlive = true;
        public float deadSeconds;
        /** Build plans in the player unit queue. */
        public int buildQueue;
        /** A rearm trip is already in progress. */
        public boolean rearmInProgress;
        /** Turrets low on ammo for which the core has an ammo item. */
        public int rearmTargets;
        /** Defence plans that can be queued right now (valid, unlocked, affordable). */
        public int defenseSlots;
        /** Destroyed blocks that can be rebuilt right now. */
        public int rebuildSlots;
        /** Number of drills of the team and whether a new drill + line is possible. */
        public int drills;
        public boolean drillPossible;
        /** Ore the core unit can mine near the core exists. */
        public boolean minePossible;
        // waves
        public boolean waves, waveSending, waveTimer, spawning;
        public int enemies, wave, winWave;
        public float waveTimeSec = -1f;
        public float coreHealthFrac = 1f;
        public float secondsSinceWaveCall = Float.MAX_VALUE;
        // forecast of the radar
        public boolean forecastAvailable;
        /** Wave the base falls on, 0 when it survives everything simulated. */
        public int forecastFallWave;
        /** True when the simulation ran until the win wave. */
        public boolean forecastCappedByWin;
    }

    /** Result of one decision. */
    public static class Decision{
        public final int action;
        public final String reason;

        public Decision(int action, String reason){
            this.action = action;
            this.reason = reason;
        }
    }

    /**
     * Picks exactly one action. Order: finished → wait for the unit → finish
     * building → ammo → defence → rebuild → economy → call a wave → mine.
     */
    public static Decision decide(Observation o){
        if(o.captured) return new Decision(ACT_DONE, "сектор захвачен");
        if(!o.playerAlive) return new Decision(ACT_WAIT, "ждём возрождения юнита");
        if(o.rearmInProgress) return new Decision(ACT_REARM, "несу патроны к турели");
        if(o.buildQueue > 0) return new Decision(ACT_WAIT, "строится: " + o.buildQueue);
        if(o.rearmTargets > 0) return new Decision(ACT_REARM, "турелей без патронов: " + o.rearmTargets);
        if(o.defenseSlots > 0) return new Decision(ACT_DEFEND, "слабое направление: можно поставить " + o.defenseSlots);
        if(o.rebuildSlots > 0) return new Decision(ACT_REBUILD, "разрушено и можно восстановить: " + o.rebuildSlots);
        if(o.drills < MAX_DRILLS && o.drillPossible) return new Decision(ACT_DRILL, "буров " + o.drills + "/" + MAX_DRILLS);
        String waveBlock = waveCallProblem(o);
        if(waveBlock == null) return new Decision(ACT_CALL_WAVE, "база готова к волне " + (o.wave + 1));
        if(o.minePossible) return new Decision(ACT_MINE, waveBlock);
        return new Decision(ACT_WAIT, waveBlock);
    }

    /** @return null when the next wave may be called now, otherwise why not. */
    public static String waveCallProblem(Observation o){
        if(!o.waves || !o.waveSending) return "волны отключены";
        if(o.winWave > 0 && o.wave >= o.winWave){
            return o.enemies > 0 ? "добиваем последнюю волну" : "ждём захвата сектора";
        }
        if(o.enemies > 0 || o.spawning) return "идёт бой";
        if(o.coreHealthFrac < MIN_CORE_HEALTH_FOR_WAVE) return "ядро повреждено — ждём ремонта";
        if(o.secondsSinceWaveCall < WAVE_CALL_COOLDOWN_SEC) return "пауза между волнами";
        int nextWave = o.wave + 1;
        int margin = !o.forecastAvailable || o.forecastFallWave <= 0
                ? Integer.MAX_VALUE : o.forecastFallWave - nextWave;
        if(o.waveTimer){
            if(o.waveTimeSec >= 0f && o.waveTimeSec < EARLY_CALL_MIN_TIMER_SEC) return "волна скоро придёт сама";
            boolean safe = o.forecastAvailable && (o.forecastFallWave <= 0 || margin >= SAFE_WAVE_MARGIN);
            return safe ? null : "оборона слабая — ждём таймер волны";
        }
        // Waves are only sent manually here: the sector never ends without calling them.
        return margin >= 1 ? null : "прогноз: оборона не выдержит волну " + nextWave;
    }

    // ------------------------------------------------------------- watchdog

    /** Detects a building queue that does not progress and repeated failures. */
    public static class Watchdog{
        public float lastProgressSec = Float.NaN;
        public long lastToken = Long.MIN_VALUE;
        public int failures;
        public String failKey = "";

        /** @return true when the queue was busy and unchanged for {@link #STALL_SECONDS}. */
        public boolean stalled(boolean busy, long token, float nowSec){
            if(!busy || token != lastToken || Float.isNaN(lastProgressSec)){
                lastToken = token;
                lastProgressSec = nowSec;
                return false;
            }
            return nowSec - lastProgressSec >= STALL_SECONDS;
        }

        /** Records a failed attempt; @return true when it failed too often in a row. */
        public boolean fail(String key){
            if(key.equals(failKey)){
                failures++;
            }else{
                failKey = key;
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

    // ------------------------------------------------------------- economy

    /** Relative value of a resource for the early economy. */
    public static float itemWeight(String name){
        if(name == null) return 0.1f;
        switch(name){
            case "copper": return 1f;
            case "lead": return 0.7f;
            case "titanium": return 0.6f;
            case "sand": return 0.4f;
            case "coal": return 0.35f;
            case "scrap": return 0.2f;
            default: return 0.1f;
        }
    }

    /** The core unit only hand-mines what stage 1 really spends: copper, lead, titanium. */
    public static boolean isMineWorthy(String name){
        return "copper".equals(name) || "lead".equals(name) || "titanium".equals(name);
    }

    /**
     * Orders the available resources from the most to the least needed:
     * lowest {@code stock / weight} first, ties by index.
     */
    public static int[] rankItems(String[] names, int[] stock, boolean[] available){
        int count = 0;
        for(int i = 0; i < names.length; i++) if(available[i]) count++;
        int[] result = new int[count];
        int at = 0;
        for(int i = 0; i < names.length; i++) if(available[i]) result[at++] = i;
        // Insertion sort: tiny arrays, stable and identical in the JS mirror.
        for(int i = 1; i < result.length; i++){
            int current = result[i];
            float score = stock[current] / itemWeight(names[current]);
            int j = i - 1;
            while(j >= 0 && stock[result[j]] / itemWeight(names[result[j]]) > score){
                result[j + 1] = result[j];
                j--;
            }
            result[j + 1] = current;
        }
        return result;
    }

    /** A drill position (block origin, window coordinates) and its conveyor line. */
    public static class DrillSite{
        public int x, y, ore, pathLength;
        /** Conveyor cells as triples x, y, rotation (0 right, 1 up, 2 left, 3 down). */
        public int[] path = new int[0];
    }

    private static final int[] DX = {1, 0, -1, 0};
    private static final int[] DY = {0, 1, 0, -1};

    /** Mindustry's offset from the block origin to its bottom-left tile. */
    public static int sizeOffset(int size){
        return -((size - 1) / 2);
    }

    /**
     * Distance (in conveyor tiles) from every free cell to the nearest cell that
     * touches a core; -1 where the core cannot be reached within {@code maxPath}.
     */
    public static int[] coreDistances(int w, int h, int[] cells, int maxPath){
        int[] dist = new int[w * h];
        int[] queue = new int[w * h];
        int head = 0, tail = 0;
        for(int i = 0; i < dist.length; i++) dist[i] = -1;
        for(int y = 0; y < h; y++){
            for(int x = 0; x < w; x++){
                int i = y * w + x;
                if(cells[i] != CELL_FREE) continue;
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
                if(cells[n] != CELL_FREE || dist[n] != -1) continue;
                dist[n] = dist[i] + 1;
                queue[tail++] = n;
            }
        }
        return dist;
    }

    /**
     * Finds the best drill site for {@code item}: every footprint cell free, at
     * least three quarters of it on that ore (and more of it than of any other ore),
     * and the shortest conveyor line to a core. Ties: more ore, then lower y, x.
     * @param ore per cell ore index, -1 for none
     * @return null when nothing fits
     */
    public static DrillSite findDrillSite(int w, int h, int[] cells, int[] ore, int item, int size, int maxPath){
        int[] dist = coreDistances(w, h, cells, maxPath);
        int offset = sizeOffset(size);
        int minOre = (size * size * 3 + 3) / 4;
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
                        if(cells[i] != CELL_FREE){ ok = false; break; }
                        if(ore[i] == item) target++;
                        else if(ore[i] >= 0) other = Math.max(other, countOre(w, ore, x0, y0, size, ore[i]));
                    }
                }
                if(!ok || target < minOre || target <= other) continue;

                // Cells around the footprint: either a core, or a conveyor start.
                int startCell = -1, startDist = Integer.MAX_VALUE;
                for(int dy = -1; dy <= size; dy++){
                    for(int dx = -1; dx <= size; dx++){
                        boolean edgeX = dx == -1 || dx == size, edgeY = dy == -1 || dy == size;
                        if(edgeX == edgeY) continue; // inside or a corner
                        int nx = x0 + dx, ny = y0 + dy;
                        if(nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                        int n = ny * w + nx;
                        if(cells[n] == CELL_CORE) touchesCore = true;
                        else if(cells[n] == CELL_FREE && dist[n] >= 0 && dist[n] < startDist){
                            startDist = dist[n];
                            startCell = n;
                        }
                    }
                }
                int pathLength = touchesCore ? 0 : (startCell >= 0 ? startDist + 1 : -1);
                if(pathLength < 0 || pathLength > maxPath) continue;
                if(best == null || pathLength < best.pathLength
                        || (pathLength == best.pathLength && target > best.ore)){
                    best = new DrillSite();
                    best.x = bx;
                    best.y = by;
                    best.ore = target;
                    best.pathLength = pathLength;
                    bestStart = touchesCore ? -1 : startCell;
                }
            }
        }
        if(best == null) return null;
        best.path = tracePath(w, h, cells, dist, bestStart, best.pathLength);
        return best;
    }

    private static int countOre(int w, int[] ore, int x0, int y0, int size, int item){
        int count = 0;
        for(int dy = 0; dy < size; dy++){
            for(int dx = 0; dx < size; dx++){
                if(ore[(y0 + dy) * w + (x0 + dx)] == item) count++;
            }
        }
        return count;
    }

    /** Follows decreasing core distance from {@code start}; the last conveyor faces the core. */
    private static int[] tracePath(int w, int h, int[] cells, int[] dist, int start, int length){
        int[] path = new int[length * 3];
        int cell = start;
        for(int step = 0; step < length && cell >= 0; step++){
            int x = cell % w, y = cell / w;
            int rotation = -1, next = -1;
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
            path[step * 3 + 2] = Math.max(rotation, 0);
            cell = next;
        }
        return path;
    }

    /**
     * Nearest cell (Chebyshev rings, then index order) carrying {@code item}
     * within {@code maxDist} of (cx, cy) that is free; -1 when none.
     */
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

    // ------------------------------------------------------------- defence

    /** Priority of a blueprint kind for a weak point kind; -1 means "do not build". */
    public static int defensePriority(int markerKind, int planKind){
        if(planKind == PLAN_MENDER) return -1; // needs power and silicon — not in stage 1
        switch(markerKind){
            case MARKER_GROUND:
                return planKind == PLAN_DUO ? 0 : planKind == PLAN_WALL ? 1 : 2;
            case MARKER_AIR:
                return planKind == PLAN_SCATTER ? 0 : planKind == PLAN_DUO ? 1 : 2;
            case MARKER_WALL:
                return planKind == PLAN_WALL ? 0 : planKind == PLAN_DUO ? 1 : 2;
            default:
                return -1; // ammo and repair markers are handled by other actions
        }
    }

    /** Indices of the blueprint placements in build order for this weak point. */
    public static int[] defenseOrder(int markerKind, int[] planKinds){
        int count = 0;
        for(int kind : planKinds) if(defensePriority(markerKind, kind) >= 0) count++;
        int[] order = new int[count];
        int at = 0;
        for(int priority = 0; priority <= 2; priority++){
            for(int i = 0; i < planKinds.length; i++){
                if(defensePriority(markerKind, planKinds[i]) == priority) order[at++] = i;
            }
        }
        return order;
    }

    // ------------------------------------------------------------- HUD text

    /** Two short HUD lines: state + goal, then the last action or the stop reason. */
    public static String formatStatus(int state, String reason, String lastAction){
        StringBuilder text = new StringBuilder("[").append(stateColor(state)).append("]🤖 Автопилот: ")
                .append(stateName(state)).append("[]");
        if(state == OFF && (reason == null || reason.isEmpty())){
            text.append(" [lightgray]· Serpulo, Normal, один сектор[]");
            return text.toString();
        }
        String detail = state == RUNNING ? lastAction : (reason == null || reason.isEmpty() ? lastAction : reason);
        if(detail != null && !detail.isEmpty()){
            text.append("\n[lightgray]").append(detail).append("[]");
        }
        return text.toString();
    }
}
