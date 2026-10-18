package campaignradar;

import static campaignradar.AutopilotLogic.*;

/**
 * Dependency-free checks of {@link AutopilotLogic}; runs without Mindustry and JUnit:
 * <pre>
 * javac -d build/autopilot-check src/main/java/campaignradar/AutopilotLogic.java \
 *     src/test/java/campaignradar/AutopilotLogicCheck.java
 * java -cp build/autopilot-check campaignradar.AutopilotLogicCheck
 * </pre>
 * The same scenarios are covered for the script mirror in scriptmod/test-logic.js.
 */
public final class AutopilotLogicCheck{
    private static int passed;

    public static void main(String[] args){
        guardChecks();
        stateMachineChecks();
        goalChecks();
        decisionChecks();
        waveChecks();
        watchdogChecks();
        economyChecks();
        drillChecks();
        defenseChecks();
        statusChecks();
        System.out.println("AutopilotLogicCheck: " + passed + " checks passed");
    }

    private static void check(boolean condition, String name){
        if(!condition) throw new AssertionError("FAILED: " + name);
        passed++;
        System.out.println("ok " + passed + " - " + name);
    }

    private static Guard okGuard(){
        Guard g = new Guard();
        g.inGame = true;
        g.campaign = true;
        g.planet = "serpulo";
        g.difficulty = "normal";
        return g;
    }

    private static void guardChecks(){
        check(guardReason(okGuard()) == null, "guard: local Normal Serpulo campaign is allowed");
        Guard g = okGuard();
        g.netActive = true;
        check(guardReason(g).contains("сетевая"), "guard: network game is refused");
        g = okGuard();
        g.planet = "erekir";
        check(guardReason(g).contains("Serpulo"), "guard: other planet is refused");
        g = okGuard();
        g.difficulty = "hard";
        check(guardReason(g).contains("Normal"), "guard: other difficulty is refused");
        g = okGuard();
        g.campaign = false;
        check(guardReason(g).contains("кампания"), "guard: custom game is refused");
        check(guardReason(new Guard()).contains("игры"), "guard: menu is refused");
        g = okGuard();
        g.canBuild = false;
        check(guardReason(g) != null, "guard: unit that cannot build is refused");
    }

    private static void stateMachineChecks(){
        check(transition(OFF, CMD_START) == RUNNING, "fsm: start");
        check(transition(RUNNING, CMD_PAUSE) == PAUSED, "fsm: pause");
        check(transition(PAUSED, CMD_START) == RUNNING, "fsm: resume");
        check(transition(OFF, CMD_PAUSE) == OFF, "fsm: pause while off is ignored");
        check(transition(RUNNING, CMD_STOP) == OFF && transition(NEEDS_HELP, CMD_STOP) == OFF, "fsm: stop always turns off");
        check(transition(RUNNING, CMD_FAIL) == NEEDS_HELP && transition(OFF, CMD_FAIL) == OFF, "fsm: failure only from active states");
        check(transition(RUNNING, CMD_CAPTURED) == COMPLETE, "fsm: captured");
    }

    private static void goalChecks(){
        Goal goal = new Goal();
        goal.waves = true;
        goal.winWave = 15;
        check(goalProblem(goal) == null, "goal: survive to win wave is supported");
        goal.attackMode = true;
        check(goalProblem(goal).contains("базу"), "goal: attack sector needs help");
        goal = new Goal();
        goal.waves = true;
        check(goalProblem(goal).contains("волны победы"), "goal: endless waves need help");
        goal.captured = true;
        check(goalProblem(goal) == null, "goal: captured sector is fine");
    }

    private static Observation calm(){
        Observation o = new Observation();
        o.waves = true;
        o.waveSending = true;
        o.waveTimer = true;
        o.wave = 3;
        o.winWave = 15;
        o.waveTimeSec = 90f;
        o.minePossible = true;
        return o;
    }

    private static void decisionChecks(){
        Observation o = calm();
        o.captured = true;
        check(decide(o).action == ACT_DONE, "decide: captured is done");
        o = calm();
        o.playerAlive = false;
        check(decide(o).action == ACT_WAIT, "decide: wait for respawn");
        o = calm();
        o.buildQueue = 3;
        o.rearmTargets = 1;
        check(decide(o).action == ACT_WAIT, "decide: finish the build queue first");
        o.rearmInProgress = true;
        check(decide(o).action == ACT_REARM, "decide: an ammo trip continues");
        o = calm();
        o.rearmTargets = 1;
        o.defenseSlots = 4;
        check(decide(o).action == ACT_REARM, "decide: ammo before new turrets");
        o.rearmTargets = 0;
        o.rebuildSlots = 2;
        check(decide(o).action == ACT_DEFEND, "decide: defence before rebuild");
        o.defenseSlots = 0;
        o.drillPossible = true;
        check(decide(o).action == ACT_REBUILD, "decide: rebuild before economy");
        o.rebuildSlots = 0;
        check(decide(o).action == ACT_DRILL, "decide: drills when nothing is broken");
        o.drills = MAX_DRILLS;
        check(decide(o).action == ACT_MINE, "decide: mine when the wave should not be called");
        o.minePossible = false;
        check(decide(o).action == ACT_WAIT, "decide: wait without ore");
    }

    private static void waveChecks(){
        Observation o = calm();
        o.waveTimer = false;
        o.waveTimeSec = -1f;
        o.forecastAvailable = true;
        o.forecastFallWave = 0;
        check(waveCallProblem(o) == null, "wave: manual waves are called when the forecast is safe");
        check(decide(o).action == ACT_CALL_WAVE, "wave: decide calls the wave");
        o.forecastFallWave = 4;
        check(waveCallProblem(o) != null, "wave: manual wave predicted lethal is not called");
        o.forecastFallWave = 5;
        check(waveCallProblem(o) == null, "wave: one safe wave is enough for manual waves");
        o.enemies = 2;
        check(waveCallProblem(o).contains("бой"), "wave: never during a battle");
        o = calm();
        o.forecastAvailable = true;
        o.forecastFallWave = 6;
        check(waveCallProblem(o) != null, "wave: with a timer, a 2-wave margin is too small");
        o.forecastFallWave = 7;
        check(waveCallProblem(o) == null, "wave: with a timer, a 3-wave margin allows an early call");
        o.waveTimeSec = 10f;
        check(waveCallProblem(o).contains("скоро"), "wave: no early call right before the timer");
        o = calm();
        o.forecastAvailable = false;
        check(waveCallProblem(o) != null, "wave: no early call without a forecast");
        o = calm();
        o.wave = 15;
        check(waveCallProblem(o).contains("захвата"), "wave: after the win wave just wait");
        o = calm();
        o.waveTimer = false;
        o.coreHealthFrac = 0.5f;
        check(waveCallProblem(o).contains("ядро"), "wave: damaged core blocks the call");
        o.coreHealthFrac = 1f;
        o.secondsSinceWaveCall = 5f;
        check(waveCallProblem(o).contains("пауза"), "wave: cooldown between calls");
    }

    private static void watchdogChecks(){
        Watchdog w = new Watchdog();
        check(!w.stalled(true, 10, 0f), "watchdog: first observation is not a stall");
        check(!w.stalled(true, 10, STALL_SECONDS - 1f), "watchdog: short wait is fine");
        check(w.stalled(true, 10, STALL_SECONDS + 1f), "watchdog: unchanged busy queue stalls");
        check(!w.stalled(true, 11, STALL_SECONDS + 2f), "watchdog: progress resets");
        check(!w.stalled(false, 11, 500f), "watchdog: idle never stalls");
        boolean tripped = false;
        for(int i = 0; i < MAX_FAILURES; i++) tripped = w.fail("x");
        check(tripped, "watchdog: repeated failures trip");
        w.success();
        check(!w.fail("x"), "watchdog: success resets failures");
    }

    private static void economyChecks(){
        String[] names = {"copper", "lead", "sand", "coal"};
        int[] ranked = rankItems(names, new int[]{500, 100, 0, 0}, new boolean[]{true, true, true, false});
        check(ranked.length == 3 && ranked[0] == 2 && ranked[1] == 1 && ranked[2] == 0, "economy: lowest stock per weight first");
        check(isMineWorthy("copper") && !isMineWorthy("sand"), "economy: the unit hand-mines only useful ore");
        check(sizeOffset(2) == 0 && sizeOffset(3) == -1 && sizeOffset(1) == 0, "economy: Mindustry size offsets");
    }

    /** 12x6 window, core at x 0..2, y 1..3; copper ore 2x2 at x 8..9, y 2..3. */
    private static void drillChecks(){
        int w = 12, h = 6;
        int[] cells = new int[w * h];
        int[] ore = new int[w * h];
        for(int i = 0; i < ore.length; i++) ore[i] = -1;
        for(int y = 1; y <= 3; y++) for(int x = 0; x <= 2; x++) cells[y * w + x] = CELL_CORE;
        for(int y = 2; y <= 3; y++) for(int x = 8; x <= 9; x++) ore[y * w + x] = 0;

        DrillSite site = findDrillSite(w, h, cells, ore, 0, 2, MAX_CONVEYOR_PATH);
        check(site != null && site.x == 8 && site.y == 2 && site.ore == 4, "drill: finds the ore patch");
        check(site.pathLength == 5, "drill: shortest conveyor line (x 3..7)");
        boolean straight = true;
        for(int s = 0; s < site.pathLength; s++){
            straight &= site.path[s * 3 + 2] == 2; // every conveyor points left, to the core
        }
        check(straight && site.path[0] == 7 && site.path[(site.pathLength - 1) * 3] == 3, "drill: conveyors lead into the core");

        check(findDrillSite(w, h, cells, ore, 1, 2, MAX_CONVEYOR_PATH) == null, "drill: no site for missing ore");
        check(findDrillSite(w, h, cells, ore, 0, 2, 3) == null, "drill: respects the max line length");

        int[] blocked = cells.clone();
        for(int y = 0; y < h; y++) blocked[y * w + 5] = CELL_BLOCKED;
        check(findDrillSite(w, h, blocked, ore, 0, 2, MAX_CONVEYOR_PATH) == null, "drill: wall between ore and core");
        blocked[0 * w + 5] = CELL_FREE;
        DrillSite around = findDrillSite(w, h, blocked, ore, 0, 2, MAX_CONVEYOR_PATH);
        check(around != null && around.pathLength > 5, "drill: routes around obstacles");
        boolean avoids = true;
        for(int s = 0; s < around.pathLength; s++){
            int x = around.path[s * 3], y = around.path[s * 3 + 1];
            avoids &= blocked[y * w + x] == CELL_FREE && !(x >= 8 && x <= 9 && y >= 2 && y <= 3);
            if(s + 1 < around.pathLength){
                int r = around.path[s * 3 + 2];
                int nx = x + (r == 0 ? 1 : r == 2 ? -1 : 0), ny = y + (r == 1 ? 1 : r == 3 ? -1 : 0);
                avoids &= nx == around.path[(s + 1) * 3] && ny == around.path[(s + 1) * 3 + 1];
            }
        }
        check(avoids, "drill: every conveyor points to the next one and avoids the drill");

        int[] adjacent = new int[w * h];
        for(int i = 0; i < adjacent.length; i++) adjacent[i] = -1;
        for(int y = 1; y <= 2; y++) for(int x = 3; x <= 4; x++) adjacent[y * w + x] = 0;
        DrillSite touching = findDrillSite(w, h, cells, adjacent, 0, 2, MAX_CONVEYOR_PATH);
        check(touching != null && touching.pathLength == 0 && touching.path.length == 0, "drill: next to the core needs no conveyor");

        int[] mixed = ore.clone();
        mixed[2 * w + 8] = 1;
        mixed[3 * w + 8] = 1;
        check(findDrillSite(w, h, cells, mixed, 0, 2, MAX_CONVEYOR_PATH) == null, "drill: half-covered patch is rejected");

        check(nearestOreCell(w, h, cells, ore, 0, 1, 2, 10) == 2 * w + 8, "mine: nearest ore cell");
        check(nearestOreCell(w, h, cells, ore, 0, 1, 2, 5) == -1, "mine: respects the distance");
    }

    private static void defenseChecks(){
        int[] kinds = {PLAN_WALL, PLAN_DUO, PLAN_SCATTER, PLAN_MENDER, PLAN_DUO};
        int[] ground = defenseOrder(MARKER_GROUND, kinds);
        check(ground.length == 4 && ground[0] == 1 && ground[1] == 4 && ground[2] == 0 && ground[3] == 2, "defence: Duo first against ground");
        int[] air = defenseOrder(MARKER_AIR, kinds);
        check(air[0] == 2, "defence: Scatter first against air");
        check(defenseOrder(MARKER_WALL, kinds)[0] == 0, "defence: walls first for a wall gap");
        check(defenseOrder(MARKER_SUPPLY, kinds).length == 0, "defence: ammo markers are not a build order");
    }

    private static void statusChecks(){
        check(formatStatus(OFF, "", "").contains("ВЫКЛ"), "status: off");
        check(formatStatus(RUNNING, "", "ставлю бур").contains("ставлю бур"), "status: running shows the last action");
        check(formatStatus(NEEDS_HELP, "нет ядра", "x").contains("нет ядра"), "status: needs help shows the reason");
    }
}
