package campaignbot;

import static campaignbot.CampaignBotLogic.*;
import static campaignbot.ProLogic.*;

import java.util.ArrayList;
import java.util.HashMap;

/**
 * Pure-Java verification of the v2.0 pro logic ({@link ProLogic}, {@link LlmBrain}):
 * chokepoint / kill-box on a rocky map, ammo bus, flank route, assault priorities,
 * unit chains and the Gemma JSON parser incl. broken answers and the offline fallback.
 */
public final class ProLogicCheck{
    private static int checks = 0;

    private static void check(boolean cond, String msg){
        checks++;
        if(!cond) throw new AssertionError("FAILED pro check #" + checks + ": " + msg);
    }

    /** Runs all checks and returns how many were executed. */
    public static int run(){
        testTerrainAndKillBox();
        testAmmo();
        testAmmoBus();
        testFlankRoute();
        testAssaultAndChains();
        testReactorGuard();
        testGemma();
        testBrainFallback();
        return checks;
    }

    public static void main(String[] args){
        int n = run();
        System.out.println("ProLogicCheck OK: " + n + " checks passed.");
    }

    // ----------------------------------------------------------------- terrain

    private static boolean[] caveMap(int w, int h){
        boolean[] pass = new boolean[w * h];
        for(int y = 0; y < h; y++){
            for(int x = 0; x < w; x++){
                boolean open;
                if(x >= 35 && x <= 60) open = y >= 27 && y <= 33;
                else open = y >= 8 && y <= h - 8;
                pass[y * w + x] = open;
            }
        }
        return pass;
    }

    private static void testTerrainAndKillBox(){
        final int w = 100, h = 60;
        final boolean[] cave = caveMap(w, h);
        TerrainScan scan = new TerrainScan(w, h, 12, 30, new int[]{90, 30}, new ScanEnv(){
            @Override
            public boolean passable(int x, int y){
                return cave[y * w + x];
            }

            @Override
            public String feature(int x, int y){
                return x == 20 && y == 20 ? "ore:copper" : "";
            }
        });
        int guard = 0;
        while(!scan.step(6000, 4000) && guard++ < 5000){
            // time-sliced scan, never blocks
        }
        check(scan.done, "terrain scan finishes");
        check(scan.pathsFound >= 1, "ground corridor from spawn to core found");
        check(!scan.chokes.isEmpty(), "chokepoint found in the canyon");
        Choke ch = scan.chokes.get(0);
        check(ch.width >= 3 && ch.width <= 14, "choke width within 3..14: " + ch.width);
        check(ch.dist >= 15f && ch.dist <= 45f, "choke 15..45 tiles from the core: " + ch.dist);
        check(ch.cx >= 33 && ch.cx <= 62, "choke sits inside the canyon: " + ch.cx);

        KillBoxOpts o = new KillBoxOpts();
        o.mainSize = 2;
        o.frontSize = 1;
        KillBox kb = buildKillBox(w, h, scan.passable, ch, o);
        check(kb.slots.length > 0 && kb.slots.length % 5 == 0, "kill-box slots are 5-tuples");
        int walls = 0, windows = 0, turrets = 0, big = 0;
        for(int i = 0; i + 4 < kb.slots.length; i += 5){
            int size = kb.slots[i + 2], role = kb.slots[i + 3];
            int x = kb.slots[i], y = kb.slots[i + 1];
            check(inBounds(w, h, x, y) && scan.passable[y * w + x], "slot on open ground");
            if(role == CampaignBotLogic.ROLE_WALL) walls++;
            if(role == ROLE_WALL_WINDOW) windows++;
            if(role == CampaignBotLogic.ROLE_GROUND_TURRET) turrets++;
            if(size == 2) big++;
        }
        check(walls > 0 && windows > 0, "walls plus thinner bait window");
        check(turrets >= 3, "turret row present");
        check(big > 0, "2x2 wall blocks are used");
        check(kb.spineLen >= 3, "ammo bus spine planned");

        // heavier map: a tiny cave must not produce nonsense
        boolean[] open = new boolean[40 * 40];
        java.util.Arrays.fill(open, true);
        TerrainScan s2 = new TerrainScan(40, 40, 5, 5, new int[]{35, 35}, new ScanEnv(){
            @Override
            public boolean passable(int x, int y){
                return true;
            }

            @Override
            public String feature(int x, int y){
                return "";
            }
        });
        int g2 = 0;
        while(!s2.step(5000, 3000) && g2++ < 2000){
            // run
        }
        check(s2.done, "open map scan finishes");
        check(s2.chokes.isEmpty() || s2.chokes.get(0).width <= 14, "open field has no fake choke");
    }

    // -------------------------------------------------------------------- ammo

    private static HashMap<String, Integer> stock(Object... kv){
        HashMap<String, Integer> m = new HashMap<String, Integer>();
        for(int i = 0; i + 1 < kv.length; i += 2) m.put((String)kv[i], (Integer)kv[i + 1]);
        return m;
    }

    private static void testAmmo(){
        HashMap<String, Integer> st = stock("copper", 800, "graphite", 400, "silicon", 50, "pyratite", 0, "thorium", 300, "metaglass", 0, "lead", 500);
        check("graphite".equals(chooseAmmoItem("duo", st, null, "")), "silicon too low -> graphite for Duo");
        check("thorium".equals(chooseAmmoItem("salvo", st, null, "")), "Salvo prefers thorium when stocked");
        check("copper".equals(chooseAmmoItem("duo", st, null, "copper")), "brain preference honoured");
        HashMap<String, Boolean> locked = new HashMap<String, Boolean>();
        locked.put("graphite", Boolean.FALSE);
        check("copper".equals(chooseAmmoItem("duo", st, locked, "")), "locked item not used");
        check(chooseAmmoItem("scatter", stock("lead", 10), null, "") == null, "no stock -> null");
        check("graphite".equals(chooseBusAmmo(new String[]{"duo", "hail", "salvo"}, st, null, "")), "shared bus ammo covers all turrets");
        check(turretAcceptsAmmo("duo", "graphite") && !turretAcceptsAmmo("duo", "thorium"), "turret ammo table");
    }

    private static void testAmmoBus(){
        int w = 40, h = 30;
        int[] cells = fillArray(w * h, CampaignBotLogic.CELL_FREE);
        for(int y = 13; y <= 15; y++) for(int x = 13; x <= 15; x++) cells[y * w + x] = CampaignBotLogic.CELL_CORE;
        int[] spine = new int[14];
        for(int i = 0; i < 7; i++){
            spine[i * 2] = 8 + i;
            spine[i * 2 + 1] = 22;
        }
        int[] unl = {14, 16};
        BusPlan bus = planAmmoBus(w, h, cells, unl, spine);
        check(bus.ok && bus.feederLength >= 1, "ammo bus planned");
        check(bus.pieces[2] == BUS_UNLOADER, "bus starts with the Unloader");
        int routers = 0, junctions = 0;
        HashMap<String, Integer> seen = new HashMap<String, Integer>();
        for(int i = 0; i + 3 < bus.pieces.length; i += 4){
            String key = bus.pieces[i] + "," + bus.pieces[i + 1];
            check(!seen.containsKey(key), "no piece placed twice");
            seen.put(key, bus.pieces[i + 2]);
            if(bus.pieces[i + 2] == BUS_ROUTER) routers++;
            if(bus.pieces[i + 2] == BUS_JUNCTION) junctions++;
        }
        check(routers == 4 && junctions == 3, "spine alternates Router/Junction (4/3)");
        check(seen.get("8,22") == BUS_ROUTER, "first spine block is a Router");

        int[] c3 = cells.clone();
        c3[22 * w + 8] = CampaignBotLogic.CELL_BLOCKED;
        check(!planAmmoBus(w, h, c3, unl, spine).ok, "blocked spine start -> refusal");
        int[] c2 = cells.clone();
        c2[22 * w + 12] = CampaignBotLogic.CELL_BLOCKED;
        BusPlan b2 = planAmmoBus(w, h, c2, unl, spine);
        int onSpine = 0;
        for(int i = 0; i + 3 < b2.pieces.length; i += 4) if(b2.pieces[i + 1] == 22) onSpine++;
        check(b2.ok && onSpine == 3, "spine truncated before the obstacle (odd length)");
    }

    // ------------------------------------------------------------ flank route

    private static void testFlankRoute(){
        int w = 120, h = 80;
        boolean[] pass = new boolean[w * h];
        java.util.Arrays.fill(pass, true);
        int[] danger = buildDangerGrid(w, h, new float[]{60f, 40f, 18f, 1f});
        float direct = straightPathDanger(w, h, danger, 10f, 40f, 110f, 40f);
        check(direct > 0f, "straight route crosses the turret range");
        FlankRoute route = planFlankRoute(w, h, danger, pass, 10, 40, 110, 40, 3, 0.8f);
        check(route.useFlank && route.waypoints.length >= 4, "flank route chosen");
        check(route.danger < route.directDanger * 0.5f && route.length < route.directLength * 1.6f, "flank is safer and not absurdly long");
        int n = route.waypoints.length;
        check(route.waypoints[n - 2] == 110 && route.waypoints[n - 1] == 40, "route ends at the goal");
        FlankRoute safe = planFlankRoute(w, h, buildDangerGrid(w, h, new float[0]), pass, 10, 40, 110, 40, 3, 0.8f);
        check(!safe.useFlank && safe.waypoints.length == 2, "no threats -> go straight");
        boolean[] rock = pass.clone();
        for(int y = 0; y < 60; y++) rock[y * w + 60] = false;
        FlankRoute around = planFlankRoute(w, h, buildDangerGrid(w, h, new float[0]), rock, 10, 30, 110, 30, 3, 0.8f);
        check(around.waypoints.length >= 2, "route search survives walls");
    }

    // ----------------------------------------------------------- RTS / chains

    private static void testAssaultAndChains(){
        AssaultCand[] all = {
            new AssaultCand(TARGET_TURRET, 100, 50, true), new AssaultCand(TARGET_POWER_NODE, 110, 60, true),
            new AssaultCand(TARGET_GENERATOR, 120, 70, true), new AssaultCand(TARGET_CORE, 130, 50, true),
            new AssaultCand(TARGET_AMMO_FEED, 105, 52, true)
        };
        check(TARGET_GENERATOR.equals(all[pickAssaultTarget(all, 50f, 50f, 4, 0)].kind), "generators first");
        AssaultCand[] noGen = {all[0], all[1], all[3], all[4]};
        check(TARGET_POWER_NODE.equals(noGen[pickAssaultTarget(noGen, 50f, 50f, 4, 0)].kind), "then power nodes");
        AssaultCand[] tc = {new AssaultCand(TARGET_TURRET, 100, 50, true), new AssaultCand(TARGET_CORE, 130, 50, true)};
        check(TARGET_TURRET.equals(tc[pickAssaultTarget(tc, 50f, 50f, 4, 0)].kind), "core waits while turrets are armed");
        tc[0].powered = false;
        check(TARGET_CORE.equals(tc[pickAssaultTarget(tc, 50f, 50f, 4, 4)].kind), "disarmed base -> go for the core");
        check(shouldRetreat(0.3f, false) && !shouldRetreat(0.9f, false), "retreat below 45%");
        check(shouldRetreat(0.6f, true) && !shouldRetreat(0.9f, true), "hysteresis: return only when healed");

        HashMap<String, Boolean> unl = new HashMap<String, Boolean>();
        for(String k : new String[]{"ground-factory", "dagger", "mace", "fortress", "scepter", "reign", "additive-reconstructor",
                "multiplicative-reconstructor", "exponential-reconstructor", "tetrative-reconstructor"}){
            unl.put(k, Boolean.TRUE);
        }
        UnitLinePlan l8 = chooseUnitLine(8, unl, false, false);
        check(l8 != null && l8.tiers == 5 && "reign".equals(l8.chain[4]), "diff>=8 aims for the T5 Reign");
        HashMap<String, Boolean> noT4 = new HashMap<String, Boolean>(unl);
        noT4.put("exponential-reconstructor", Boolean.FALSE);
        UnitLinePlan limited = chooseUnitLine(8, noT4, false, false);
        check(limited != null && limited.tiers == 3, "missing T4 reconstructor limits the chain");
        int w = 70, h = 70;
        int[] cells = fillArray(w * h, CampaignBotLogic.CELL_FREE);
        for(int y = 33; y <= 35; y++) for(int x = 33; x <= 35; x++) cells[y * w + x] = CampaignBotLogic.CELL_CORE;
        ChainSlot chain = findUnitChainSlotTiers(w, h, cells, 34, 34, true, 5);
        check(chain != null && chain.stages.size() == 6, "T1..T5 chain with a PayloadConveyor spacer fits");
        check(chain != null && "payload".equals(chain.stages.get(4).kind) && "tetrative-reconstructor".equals(chain.stages.get(5).kind), "payload conveyor before T5");
    }

    private static void testReactorGuard(){
        ReactorState s = new ReactorState();
        s.reactorUnlocked = true;
        s.mixerBuilt = false;
        s.waterOk = true;
        s.titaniumStock = 500;
        s.thoriumStock = 500;
        s.siteDistFromCore = 30f;
        s.powerNetPerSec = 200f;
        check(reactorGuard(s) != null, "no reactor without a Cryofluid Mixer");
        s.mixerBuilt = true;
        s.mixerCryoFrac = 0.1f;
        check(reactorGuard(s) != null, "no reactor while the coolant is not filled");
        s.mixerCryoFrac = 0.9f;
        check(reactorGuard(s) == null, "reactor allowed with guaranteed cryofluid");
        s.siteDistFromCore = 3f;
        check(reactorGuard(s) != null, "reactor must stand far from the core");
        check(reactorShouldCutFuel(0.95f, 0.05f) && !reactorShouldCutFuel(0.2f, 0.9f), "emergency fuel cut");
    }

    // ------------------------------------------------------------------- Gemma

    private static void testGemma(){
        String inner = "{\"thought\":\"Строю ПВО у генераторов\",\"priority\":\"BUILD_AA_SHIELD\",\"flank\":\"north-east\",\"ammo\":\"Graphite\",\"aggression\":0.25}";
        String good = "{\"message\":{\"role\":\"assistant\",\"content\":" + LlmBrain.jsonQuote(inner) + "}}";
        LlmBrain.Plan p = LlmBrain.parseLlmResponse(good);
        check(p.ok && "BUILD_AA_SHIELD".equals(p.priority) && "north-east".equals(p.flank) && "graphite".equals(p.ammo) && Math.abs(p.aggression - 0.25f) < 1e-4f,
            "Ollama /api/chat reply parsed");
        check(LlmBrain.parseLlmResponse("{\"priority\":\"CALL_WAVE_EARLY\",\"thought\":\"go\"}").ok, "bare plan parsed");
        LlmBrain.Plan clamp = LlmBrain.parseLlmResponse("{\"priority\":\"BUILD_POWER\",\"aggression\":7}");
        check(clamp.ok && clamp.aggression == 1f, "aggression clamped");
        String[] bad = {"", "   ", "garbage", "{\"message\":{\"content\":\"{broken\"}}", "{\"message\":", "{\"priority\":null}",
            "{\"message\":{\"content\":\"{\\\"priority\\\":\\\"DROP_TABLES\\\"}\"}}", "[[[[", null};
        for(String b : bad){
            LlmBrain.Plan r = null;
            boolean threw = false;
            try{
                r = LlmBrain.parseLlmResponse(b);
            }catch(Throwable t){
                threw = true;
            }
            check(!threw && r != null && !r.ok, "broken response never throws and is rejected: " + b);
        }
        LlmBrain.Plan th = LlmBrain.parseLlmResponse("{\"priority\":\"BUILD_POWER\",\"thought\":\"[red]hack[]\",\"ammo\":\"uranium\",\"flank\":\"up\",\"aggression\":\"x\"}");
        check(th.ok && th.thought.indexOf('[') < 0 && "".equals(th.ammo) && "any".equals(th.flank), "thought sanitised, junk fields normalised");
    }

    private static final class FakeEnv implements LlmBrain.Env{
        float clock = 100f;
        boolean on = true;
        boolean fail;
        boolean silent;
        int posts;
        String lastBody = "";
        String answer = "";
        LlmBrain.Callback pending;

        @Override
        public boolean enabled(){
            return on;
        }

        @Override
        public String url(){
            return LlmBrain.DEFAULT_URL;
        }

        @Override
        public String model(){
            return LlmBrain.DEFAULT_MODEL;
        }

        @Override
        public float now(){
            return clock;
        }

        @Override
        public void post(String url, String body, int timeoutMs, LlmBrain.Callback cb){
            posts++;
            lastBody = body;
            if(silent){
                pending = cb;
                return;
            }
            cb.done(!fail, fail ? "connection refused" : answer);
        }
    }

    private static LlmBrain.Sit sit(){
        LlmBrain.Sit s = new LlmBrain.Sit();
        s.sectorName = "frozenForest";
        s.wave = 7;
        s.winWave = 15;
        s.coreName = "shard";
        s.items.put("copper", 900);
        s.items.put("lead", 400);
        s.items.put("graphite", 150);
        s.turrets = 4;
        s.turretsAvailable = new String[]{"duo", "hail"};
        s.busPossible = true;
        s.aaAvailable = true;
        s.chokeCount = 1;
        s.chokeWidth = 7;
        s.chokeDist = 24f;
        s.chokeFlank = "east";
        return s;
    }

    private static void testBrainFallback(){
        FakeEnv env = new FakeEnv();
        env.answer = "{\"message\":{\"content\":" + LlmBrain.jsonQuote("{\"thought\":\"держим горлышко\",\"priority\":\"BUILD_AMMO_BUS\",\"flank\":\"east\",\"ammo\":\"graphite\",\"aggression\":0.4}") + "}}";
        LlmBrain.Brain brain = new LlmBrain.Brain(env);
        LlmBrain.Sit s = sit();
        String prompt = LlmBrain.buildLlmPrompt(s);
        check(prompt.length() < 2400, "prompt stays compact: " + prompt.length());
        String body = LlmBrain.buildLlmRequestBody(LlmBrain.DEFAULT_MODEL, prompt);
        check(body.contains("\"gemma4:e2b\"") && body.contains("\"stream\":false") && body.contains("\"format\":\"json\""), "request body shape");

        LlmBrain.Plan first = brain.update(s);
        check(first != null && first.ok && !first.priority.isEmpty(), "instant plan on the first call");
        check(env.posts == 1, "one non-blocking request issued");
        check("gemma".equals(brain.update(s).source) && "BUILD_AMMO_BUS".equals(brain.plan.priority), "Gemma answer applied");
        check(brain.hudLine().startsWith("💭 Мысль:"), "HUD thought line");

        // Ollama is down: heuristic plan, no exception, backoff
        FakeEnv down = new FakeEnv();
        down.fail = true;
        LlmBrain.Brain b2 = new LlmBrain.Brain(down);
        for(int i = 0; i < 12; i++){
            down.clock += 3f;
            LlmBrain.Plan r = b2.update(s);
            check(r != null && r.ok && "heuristic".equals(r.source), "offline -> heuristic plan");
        }
        check(down.posts < 12 && b2.failures >= 3, "failures lead to backoff");

        // broken JSON from the model
        FakeEnv junk = new FakeEnv();
        junk.answer = "{\"message\":{\"content\":\"{not json\"}}";
        LlmBrain.Brain b3 = new LlmBrain.Brain(junk);
        LlmBrain.Plan r3 = b3.update(s);
        check(r3.ok && "heuristic".equals(r3.source) && b3.badCount == 1, "broken JSON -> fallback");

        // timeout: nobody answers
        FakeEnv slow = new FakeEnv();
        slow.silent = true;
        LlmBrain.Brain b4 = new LlmBrain.Brain(slow);
        b4.update(s);
        LlmBrain.Callback firstCall = slow.pending;
        slow.clock += 30f;
        LlmBrain.Plan r4 = b4.update(s);
        check(r4.ok && "heuristic".equals(r4.source) && b4.failures >= 1, "timeout -> fallback");
        firstCall.done(true, env.answer); // late answer to an old request must be ignored
        check(b4.okCount == 0, "stale answer ignored");

        // toggle off
        FakeEnv off = new FakeEnv();
        off.on = false;
        LlmBrain.Brain b5 = new LlmBrain.Brain(off);
        LlmBrain.Plan r5 = b5.update(s);
        check(off.posts == 0 && "heuristic".equals(r5.source), "disabled brain never calls the network");
    }
}
