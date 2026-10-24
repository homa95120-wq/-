package campaignbot;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * v2.0 strategic brain: Gemma 4 E2B ({@code gemma4:e2b}) over a local Ollama server with an
 * instant deterministic "pro player" fallback planner.
 * <p>
 * Pure Java (no Mindustry / Arc imports): the HTTP transport is injected through {@link Env},
 * so the whole parse / prompt / fallback logic is unit-tested with plain {@code javac}.
 */
public final class LlmBrain{
    public static final String DEFAULT_URL = "http://127.0.0.1:11434/api/chat";
    public static final String DEFAULT_MODEL = "gemma4:e2b";
    public static final float INTERVAL_SEC = 10f;
    public static final int TIMEOUT_MS = 4000;
    public static final float PLAN_TTL_SEC = 60f;

    public static final String[] PLANS = {
        "BUILD_CHOKEPOINT_FORTRESS", "BUILD_AA_SHIELD", "BUILD_AMMO_BUS", "EXPAND_ECONOMY",
        "EXPAND_SILICON_ECONOMY", "BUILD_POWER", "REINFORCE_BREACH", "BUILD_T3_AIR_FLANK",
        "BUILD_ARMY", "SNIPE_ENEMY_POWER", "ASSAULT_BASE", "HOLD_AND_RESEARCH", "CALL_WAVE_EARLY"
    };
    public static final String[] FLANKS = {"north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west", "any"};
    public static final String[] AMMO = {
        "copper", "lead", "graphite", "silicon", "metaglass", "coal", "scrap", "pyratite",
        "blast-compound", "plastanium", "thorium", "surge-alloy", "titanium"
    };

    private LlmBrain(){}

    // ------------------------------------------------------------ tiny JSON

    /** Minimal strict JSON parser (objects, arrays, strings, numbers, booleans, null). Throws on bad input. */
    public static final class MiniJson{
        private final String s;
        private int i;

        private MiniJson(String s){
            this.s = s;
        }

        /** Parses a JSON document; throws IllegalArgumentException when malformed. */
        public static Object parse(String text){
            MiniJson p = new MiniJson(text);
            p.ws();
            Object v = p.value(0);
            p.ws();
            if(p.i != p.s.length()) throw new IllegalArgumentException("trailing data");
            return v;
        }

        private void ws(){
            while(i < s.length()){
                char c = s.charAt(i);
                if(c == ' ' || c == '\n' || c == '\r' || c == '\t') i++;
                else break;
            }
        }

        private char peek(){
            if(i >= s.length()) throw new IllegalArgumentException("unexpected end");
            return s.charAt(i);
        }

        private Object value(int depth){
            if(depth > 24) throw new IllegalArgumentException("too deep");
            char c = peek();
            if(c == '{') return object(depth);
            if(c == '[') return array(depth);
            if(c == '"') return string();
            if(s.startsWith("true", i)){
                i += 4;
                return Boolean.TRUE;
            }
            if(s.startsWith("false", i)){
                i += 5;
                return Boolean.FALSE;
            }
            if(s.startsWith("null", i)){
                i += 4;
                return null;
            }
            return number();
        }

        private Map<String, Object> object(int depth){
            LinkedHashMap<String, Object> m = new LinkedHashMap<String, Object>();
            i++;
            ws();
            if(peek() == '}'){
                i++;
                return m;
            }
            for(;;){
                ws();
                if(peek() != '"') throw new IllegalArgumentException("key expected");
                String k = string();
                ws();
                if(peek() != ':') throw new IllegalArgumentException(": expected");
                i++;
                ws();
                m.put(k, value(depth + 1));
                ws();
                char c = peek();
                i++;
                if(c == '}') return m;
                if(c != ',') throw new IllegalArgumentException(", expected");
            }
        }

        private List<Object> array(int depth){
            ArrayList<Object> a = new ArrayList<Object>();
            i++;
            ws();
            if(peek() == ']'){
                i++;
                return a;
            }
            for(;;){
                ws();
                a.add(value(depth + 1));
                ws();
                char c = peek();
                i++;
                if(c == ']') return a;
                if(c != ',') throw new IllegalArgumentException(", expected");
            }
        }

        private String string(){
            StringBuilder sb = new StringBuilder();
            i++;
            for(;;){
                char c = peek();
                i++;
                if(c == '"') return sb.toString();
                if(c == '\\'){
                    char e = peek();
                    i++;
                    switch(e){
                        case 'n': sb.append('\n'); break;
                        case 't': sb.append('\t'); break;
                        case 'r': sb.append('\r'); break;
                        case 'b': sb.append('\b'); break;
                        case 'f': sb.append('\f'); break;
                        case 'u':
                            if(i + 4 > s.length()) throw new IllegalArgumentException("bad escape");
                            sb.append((char)Integer.parseInt(s.substring(i, i + 4), 16));
                            i += 4;
                            break;
                        default: sb.append(e);
                    }
                }else{
                    sb.append(c);
                }
            }
        }

        private Double number(){
            int start = i;
            while(i < s.length()){
                char c = s.charAt(i);
                if((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') i++;
                else break;
            }
            if(start == i) throw new IllegalArgumentException("value expected");
            return Double.valueOf(s.substring(start, i));
        }
    }

    /** JSON string literal with quotes. */
    public static String jsonQuote(String v){
        StringBuilder sb = new StringBuilder("\"");
        for(int k = 0; k < v.length(); k++){
            char c = v.charAt(k);
            switch(c){
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if(c < 0x20) sb.append(String.format("\\u%04x", (int)c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    /** First balanced {...} object of arbitrary text (string-aware), or null. */
    public static String extractJsonObject(String text){
        if(text == null) return null;
        int start = text.indexOf('{');
        while(start >= 0){
            int depth = 0;
            boolean inStr = false, esc = false;
            for(int i = start; i < text.length(); i++){
                char c = text.charAt(i);
                if(inStr){
                    if(esc) esc = false;
                    else if(c == '\\') esc = true;
                    else if(c == '"') inStr = false;
                    continue;
                }
                if(c == '"') inStr = true;
                else if(c == '{') depth++;
                else if(c == '}'){
                    depth--;
                    if(depth == 0) return text.substring(start, i + 1);
                }
            }
            start = text.indexOf('{', start + 1);
        }
        return null;
    }

    private static Object tryParse(String text){
        try{
            return MiniJson.parse(text);
        }catch(RuntimeException e){
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object o){
        return o instanceof Map ? (Map<String, Object>)o : null;
    }

    @SuppressWarnings("unchecked")
    private static List<Object> asList(Object o){
        return o instanceof List ? (List<Object>)o : null;
    }

    public static String sanitizeThought(Object o){
        if(!(o instanceof String)) return "";
        String out = ((String)o).replaceAll("[\\u0000-\\u001f\\u007f]+", " ").replace('[', '(').replace(']', ')').replaceAll("\\s+", " ").trim();
        if(out.length() > 170) out = out.substring(0, 167) + "...";
        return out;
    }

    public static String normalizeFlank(Object v){
        if(!(v instanceof String)) return "any";
        String s = ((String)v).toLowerCase().replaceAll("[\\s_]+", "-").trim();
        switch(s){
            case "n": s = "north"; break;
            case "ne": case "northeast": s = "north-east"; break;
            case "e": s = "east"; break;
            case "se": case "southeast": s = "south-east"; break;
            case "s": s = "south"; break;
            case "sw": case "southwest": s = "south-west"; break;
            case "w": s = "west"; break;
            case "nw": case "northwest": s = "north-west"; break;
            default: break;
        }
        for(int i = 0; i < FLANKS.length; i++) if(FLANKS[i].equals(s)) return s;
        return "any";
    }

    public static String normalizeAmmo(Object v){
        if(!(v instanceof String)) return "";
        String s = ((String)v).replaceAll("([a-z])([A-Z])", "$1-$2").toLowerCase().replaceAll("[\\s_]+", "-");
        if(s.equals("blast") || s.equals("blastcompound")) s = "blast-compound";
        if(s.equals("surge") || s.equals("surgealloy")) s = "surge-alloy";
        for(int i = 0; i < AMMO.length; i++) if(AMMO[i].equals(s)) return s;
        return "";
    }

    /** One strategic plan. */
    public static final class Plan{
        public boolean ok;
        public String thought = "", priority = "", flank = "any", ammo = "", source = "heuristic", error = "";
        public float aggression = 0.5f;
    }

    private static Plan fail(String why){
        Plan p = new Plan();
        p.ok = false;
        p.error = why;
        return p;
    }

    /**
     * Parses an Ollama (/api/chat, /api/generate) or OpenAI-compatible response, or the bare JSON plan
     * itself. Never throws; a broken answer yields a plan with ok = false and a Russian reason.
     */
    public static Plan parseLlmResponse(String raw){
        if(raw == null || raw.trim().isEmpty()) return fail("пустой ответ");
        String outerText = extractJsonObject(raw);
        String content = null;
        Map<String, Object> outer = outerText == null ? null : asMap(tryParse(outerText));
        if(outer != null){
            Map<String, Object> msg = asMap(outer.get("message"));
            List<Object> choices = asList(outer.get("choices"));
            if(msg != null && msg.get("content") instanceof String){
                content = (String)msg.get("content");
            }else if(outer.get("response") instanceof String){
                content = (String)outer.get("response");
            }else if(choices != null && !choices.isEmpty() && asMap(choices.get(0)) != null
                    && asMap(asMap(choices.get(0)).get("message")) != null
                    && asMap(asMap(choices.get(0)).get("message")).get("content") instanceof String){
                content = (String)asMap(asMap(choices.get(0)).get("message")).get("content");
            }else if(outer.get("priority") instanceof String){
                content = outerText;
            }
        }
        if(content == null) return fail("битый JSON ответа");
        String innerText = extractJsonObject(content);
        Map<String, Object> plan = innerText == null ? null : asMap(tryParse(innerText));
        if(plan == null) return fail("нет JSON-плана в ответе модели");
        String pr = plan.get("priority") instanceof String
            ? ((String)plan.get("priority")).trim().toUpperCase().replaceAll("[\\s-]+", "_") : "";
        boolean known = false;
        for(int i = 0; i < PLANS.length; i++) if(PLANS[i].equals(pr)) known = true;
        if(!known) return fail("неизвестный priority: " + pr);
        float ag = 0.5f;
        Object ago = plan.get("aggression");
        if(ago instanceof Double){
            ag = ((Double)ago).floatValue();
        }else if(ago instanceof String){
            try{
                ag = Float.parseFloat(((String)ago).trim());
            }catch(NumberFormatException e){
                ag = 0.5f;
            }
        }
        if(Float.isNaN(ag)) ag = 0.5f;
        ag = Math.max(0f, Math.min(1f, ag));
        Plan p = new Plan();
        p.ok = true;
        p.thought = sanitizeThought(plan.get("thought"));
        p.priority = pr;
        p.flank = normalizeFlank(plan.get("flank"));
        p.ammo = normalizeAmmo(plan.get("ammo"));
        p.aggression = ag;
        return p;
    }

    // ------------------------------------------------------------ situation

    /** Everything the planner knows about the sector right now. */
    public static final class Sit{
        public boolean attackMode, fortressBuilt, aaBuilt, busBuilt, enemyBaseKnown;
        public boolean aaAvailable, busPossible, smelterAvailable, airChainAvailable, armyPossible, canCallWave;
        public String sectorName = "?", coreName = "shard", chokeFlank = "any", weakFlank = "";
        public int wave, winWave, enemies, chokeCount, chokeWidth, turrets, armyUnits, enemyPowerNodes;
        public float chokeDist, power, defenseDps;
        public HashMap<String, Integer> items = new HashMap<String, Integer>();
        public HashMap<String, Float> income = new HashMap<String, Float>();
        public HashMap<String, Boolean> itemUnlocked;
        public String[] turretsAvailable = new String[0];
        public ProLogic.WaveReport forecast;
        public ProLogic.Breach breach;
    }

    private static int itemOf(Sit s, String k){
        Integer v = s.items.get(k);
        return v == null ? 0 : v.intValue();
    }

    private static float incomeOf(Sit s, String k){
        Float v = s.income.get(k);
        return v == null ? 0f : v.floatValue();
    }

    static String fmtNum(float v){
        if(Float.isNaN(v) || Float.isInfinite(v)) return "0";
        float r = Math.round(v * 10f) / 10f;
        if(r == Math.rint(r)) return Long.toString((long)r);
        return Float.toString(r);
    }

    private static String join(String sep, String[] parts){
        StringBuilder sb = new StringBuilder();
        for(int i = 0; i < parts.length; i++){
            if(i > 0) sb.append(sep);
            sb.append(parts[i]);
        }
        return sb.toString();
    }

    /** Compact (&lt; 600 tokens) English situation summary; the model answers in strict JSON. */
    public static String buildLlmPrompt(Sit sit){
        StringBuilder sb = new StringBuilder();
        sb.append("Mindustry campaign bot. Reply ONLY JSON: {\"thought\":\"<=140 chars, Russian\",\"priority\":\"PLAN\",\"flank\":\"north|north-east|east|south-east|south|south-west|west|north-west|any\",\"ammo\":\"item or none\",\"aggression\":0.0-1.0}\n");
        sb.append("PLANS: ").append(join(",", PLANS)).append('\n');
        sb.append("SECTOR: ").append(sit.attackMode ? "attack" : "survival").append(' ').append(sit.sectorName)
          .append(" wave ").append(sit.wave).append('/').append(sit.winWave).append(" enemies ").append(sit.enemies)
          .append(" core ").append(sit.coreName).append('\n');
        sb.append("ITEMS: cu ").append(itemOf(sit, "copper")).append(" pb ").append(itemOf(sit, "lead"))
          .append(" graphite ").append(itemOf(sit, "graphite")).append(" si ").append(itemOf(sit, "silicon"))
          .append(" ti ").append(itemOf(sit, "titanium")).append(" th ").append(itemOf(sit, "thorium"))
          .append(" plast ").append(itemOf(sit, "plastanium")).append(" metaglass ").append(itemOf(sit, "metaglass")).append('\n');
        sb.append("INCOME/s: cu ").append(fmtNum(incomeOf(sit, "copper"))).append(" pb ").append(fmtNum(incomeOf(sit, "lead")))
          .append(" graphite ").append(fmtNum(incomeOf(sit, "graphite"))).append(" si ").append(fmtNum(incomeOf(sit, "silicon")))
          .append(" ti ").append(fmtNum(incomeOf(sit, "titanium"))).append(" | POWER ").append(fmtNum(sit.power)).append("/s\n");
        ProLogic.WaveReport fc = sit.forecast;
        if(fc != null){
            StringBuilder parts = new StringBuilder();
            for(int i = 0; i < fc.forecast.size() && i < 5; i++){
                ProLogic.WaveForecast f = fc.forecast.get(i);
                if(i > 0) parts.append(' ');
                parts.append('w').append(f.wave).append(':');
                if(f.types.isEmpty()) parts.append("none");
                else parts.append(join("+", f.types.toArray(new String[0])));
                if(f.airCount > 0) parts.append("(air ").append(f.airCount).append(')');
            }
            sb.append("FORECAST: ").append(parts).append('\n');
            sb.append("FIRST_AIR_WAVE: ").append(fc.firstAirWave).append(" NEXT_AIR: ").append(fc.nextAirWave).append(" BOSS: ");
            if(fc.bossWave > 0) sb.append('w').append(fc.bossWave).append(' ').append(fc.bossType).append(fc.bossFlying ? " flying" : " ground");
            else sb.append("none");
            sb.append('\n');
        }
        sb.append("CHOKES: ").append(sit.chokeCount);
        if(sit.chokeCount > 0){
            sb.append(" (width ").append(sit.chokeWidth).append(" at ").append(Math.round(sit.chokeDist)).append(" tiles, ").append(sit.chokeFlank).append(')');
        }
        sb.append(" WEAK_FLANK: ").append(sit.weakFlank == null || sit.weakFlank.isEmpty() ? "none" : sit.weakFlank);
        if(sit.breach != null) sb.append(" BREACH ").append(sit.breach.air ? "air" : "ground").append(' ').append(sit.breach.flank);
        sb.append('\n');
        sb.append("HAVE: fortress ").append(sit.fortressBuilt ? "yes" : "no").append(" aa ").append(sit.aaBuilt ? "yes" : "no")
          .append(" ammo_bus ").append(sit.busBuilt ? "yes" : "no").append(" turrets ").append(sit.turrets)
          .append(" dps ").append(Math.round(sit.defenseDps)).append(" army ").append(sit.armyUnits).append('\n');
        sb.append("TURRETS_UNLOCKED: ").append(sit.turretsAvailable.length == 0 ? "none" : join(",", sit.turretsAvailable));
        if(sit.attackMode){
            sb.append("\nENEMY_BASE: ").append(sit.enemyBaseKnown ? "scouted" : "unknown").append(" power_nodes ").append(sit.enemyPowerNodes);
        }
        return sb.toString();
    }

    public static final String SYSTEM_PROMPT = "You are an expert Mindustry player. Think like a human pro: chokepoint kill-boxes, layered walls, automatic ammo belts, anti-air near generators, never rush. Answer with one JSON object only.";

    /** Ollama /api/chat request body: stream:false, format:json. */
    public static String buildLlmRequestBody(String model, String prompt){
        return "{\"model\":" + jsonQuote(model)
            + ",\"messages\":[{\"role\":\"system\",\"content\":" + jsonQuote(SYSTEM_PROMPT)
            + "},{\"role\":\"user\",\"content\":" + jsonQuote(prompt)
            + "}],\"stream\":false,\"format\":\"json\",\"options\":{\"temperature\":0.3,\"num_predict\":220}}";
    }

    /** Can the plan actually be executed right now? The model must never break the bot. */
    public static boolean planFeasible(String priority, Sit sit){
        switch(priority){
            case "BUILD_CHOKEPOINT_FORTRESS": return sit.turretsAvailable.length > 0;
            case "BUILD_AA_SHIELD": return sit.aaAvailable;
            case "BUILD_AMMO_BUS": return sit.busPossible;
            case "EXPAND_SILICON_ECONOMY": return sit.smelterAvailable;
            case "BUILD_T3_AIR_FLANK": return sit.airChainAvailable;
            case "BUILD_ARMY": return sit.armyPossible;
            case "SNIPE_ENEMY_POWER": return sit.attackMode && sit.enemyBaseKnown;
            case "ASSAULT_BASE": return sit.attackMode;
            case "CALL_WAVE_EARLY": return !sit.attackMode && sit.canCallWave;
            case "REINFORCE_BREACH": return sit.breach != null;
            default: return true;
        }
    }

    /** Deterministic "pro player" planner. Always instant; explains itself in Russian. */
    public static Plan heuristicPlan(Sit sit){
        ProLogic.WaveReport fc = sit.forecast;
        int nextAir = fc == null ? -1 : fc.nextAirWave;
        int wave = sit.wave > 0 ? sit.wave : 1;
        int turrets = sit.turrets;
        String priority, thought;
        String flank = sit.breach != null ? sit.breach.flank
            : (sit.weakFlank != null && !sit.weakFlank.isEmpty() ? sit.weakFlank : sit.chokeFlank);
        if(flank == null || flank.isEmpty()) flank = "any";
        float aggression;
        boolean airSoon = nextAir > 0 && nextAir - wave <= 2;
        if(sit.breach != null){
            priority = "REINFORCE_BREACH";
            thought = "Волна пробила " + sit.breach.flank + " фланг (" + Math.round(sit.breach.amount) + " урона) — усиливаю "
                + (sit.breach.air ? "ПВО" : "стены и огневую точку") + " именно там.";
            aggression = 0.15f;
        }else if(sit.attackMode && sit.enemyBaseKnown && sit.enemyPowerNodes > 0 && sit.armyUnits >= 4){
            priority = "SNIPE_ENEMY_POWER";
            thought = "У врага " + sit.enemyPowerNodes + " энергоузлов/генераторов — обхожу по флангу и обесточиваю базу, потом бью ядро.";
            aggression = 0.8f;
        }else if(sit.attackMode && sit.enemyBaseKnown && sit.armyUnits >= 8){
            priority = "ASSAULT_BASE";
            thought = "Армия собрана (" + sit.armyUnits + ") — иду на штурм в обход дальнобойных турелей.";
            aggression = 0.85f;
        }else if(sit.aaAvailable && !sit.aaBuilt && airSoon){
            priority = "BUILD_AA_SHIELD";
            thought = "На волне " + nextAir + " прилетит авиация, а ПВО нет — ставлю Scatter на воздушном векторе и прикрываю генераторы.";
            aggression = 0.2f;
        }else if(!sit.fortressBuilt && sit.turretsAvailable.length > 0 && sit.chokeCount > 0){
            priority = "BUILD_CHOKEPOINT_FORTRESS";
            thought = "Нашёл горлышко шириной " + sit.chokeWidth + " в " + Math.round(sit.chokeDist) + " тайлах от ядра (" + sit.chokeFlank
                + ") — перекрою скала-в-скалу и оставлю приманку-окно под перекрёстный огонь.";
            aggression = 0.25f;
        }else if(!sit.fortressBuilt && sit.turretsAvailable.length > 0 && turrets < 4){
            priority = "BUILD_CHOKEPOINT_FORTRESS";
            thought = "Узких проходов нет — ставлю укрепрайон у ядра в сторону врага, пока волны слабые.";
            aggression = 0.25f;
        }else if(sit.busPossible && !sit.busBuilt && turrets >= 3){
            priority = "BUILD_AMMO_BUS";
            thought = "Турелей " + turrets + ", а патроны ношу руками — тяну шину Router+Junction от Unloader, чтобы не бегать.";
            aggression = 0.3f;
        }else if(sit.smelterAvailable && itemOf(sit, "silicon") < 200 && incomeOf(sit, "silicon") < 0.2f && wave >= 3){
            priority = "EXPAND_SILICON_ECONOMY";
            thought = "Кремния " + itemOf(sit, "silicon") + " и почти нет притока — расширяю кремниевую экономику (Lancer, Unloader, юниты).";
            aggression = 0.3f;
        }else if(sit.airChainAvailable && fc != null && fc.airShareNext >= 0.4f && sit.armyUnits < 6){
            priority = "BUILD_T3_AIR_FLANK";
            thought = "Следующие волны на " + Math.round(fc.airShareNext * 100f) + "% воздушные — строю воздушную цепочку юнитов для фланга.";
            aggression = 0.4f;
        }else if(sit.canCallWave && !sit.attackMode && sit.enemies == 0){
            priority = "CALL_WAVE_EARLY";
            thought = "Оборона держит прогноз волны " + wave + " с запасом — вызываю волну раньше таймера.";
            aggression = 0.7f;
        }else{
            priority = "HOLD_AND_RESEARCH";
            thought = fc != null && fc.bossWave > 0
                ? "До босса (волна " + fc.bossWave + (fc.bossFlying ? ", воздух" : ", земля") + ") копим ресурсы и науку."
                : "Копим ресурсы и изучаем технологии, оборона в норме.";
            aggression = 0.3f;
        }
        String ammo = ProLogic.chooseBusAmmo(sit.turretsAvailable, sit.items, sit.itemUnlocked, "");
        Plan p = new Plan();
        p.ok = true;
        p.thought = thought;
        p.priority = priority;
        p.flank = flank;
        p.ammo = ammo == null ? "" : ammo;
        p.aggression = aggression;
        p.source = "heuristic";
        return p;
    }

    public static float backoffInterval(int failures){
        if(failures <= 2) return INTERVAL_SEC;
        return Math.min(120f, INTERVAL_SEC * (float)Math.pow(2, failures - 2));
    }

    // ----------------------------------------------------------------- brain

    /** Completion callback of an HTTP request. */
    public interface Callback{
        void done(boolean ok, String text);
    }

    /** Injected environment (transport + settings + clock). */
    public interface Env{
        boolean enabled();

        String url();

        String model();

        float now();

        /** Fires a NON-blocking POST; the callback must run on the game thread. */
        void post(String url, String body, int timeoutMs, Callback cb);
    }

    /** The strategic brain. update() is synchronous and instant: it always returns a plan. */
    public static final class Brain{
        private final Env env;
        public float lastQuery = -1e9f, llmAt = -1e9f;
        public boolean inFlight, eventPending;
        public int failures, requestId, requests, okCount, badCount;
        public Plan llmPlan, plan;
        public String lastError = "", thought = "", source = "heuristic", status = "эвристика";
        public final ArrayList<String> events = new ArrayList<String>();

        public Brain(Env env){
            this.env = env;
        }

        public void markEvent(String name){
            eventPending = true;
            events.add(name);
            if(events.size() > 8) events.remove(0);
        }

        public void onResponse(int id, boolean ok, String text){
            if(id != requestId || !inFlight) return; // stale / late answer
            inFlight = false;
            float now = env.now();
            if(!ok){
                failures++;
                lastError = "Ollama недоступна";
                return;
            }
            Plan parsed = parseLlmResponse(text);
            if(parsed.ok){
                llmPlan = parsed;
                llmAt = now;
                failures = 0;
                okCount++;
                lastError = "";
            }else{
                failures++;
                badCount++;
                lastError = parsed.error;
            }
        }

        public Plan update(Sit sit){
            float now = env.now();
            boolean enabled;
            try{
                enabled = env.enabled();
            }catch(RuntimeException e){
                enabled = false;
            }
            if(inFlight && now - lastQuery > (TIMEOUT_MS / 1000f) * 3f){
                inFlight = false;
                failures++;
                lastError = "таймаут";
            }
            if(enabled && !inFlight){
                float gap = failures >= 3 ? backoffInterval(failures) : (eventPending ? 2f : INTERVAL_SEC);
                if(now - lastQuery >= gap){
                    lastQuery = now;
                    eventPending = false;
                    inFlight = true;
                    requests++;
                    final int id = ++requestId;
                    try{
                        env.post(env.url(), buildLlmRequestBody(env.model(), buildLlmPrompt(sit)), TIMEOUT_MS, new Callback(){
                            @Override
                            public void done(boolean ok, String text){
                                onResponse(id, ok, text);
                            }
                        });
                    }catch(RuntimeException err){
                        inFlight = false;
                        failures++;
                        lastError = "ошибка запроса";
                    }
                }
            }
            Plan heur = heuristicPlan(sit);
            Plan result = heur;
            if(enabled && llmPlan != null && now - llmAt <= PLAN_TTL_SEC && planFeasible(llmPlan.priority, sit)){
                Plan lp = llmPlan;
                result = new Plan();
                result.ok = true;
                result.thought = lp.thought.isEmpty() ? heur.thought : lp.thought;
                result.priority = lp.priority;
                result.flank = !"any".equals(lp.flank) ? lp.flank : heur.flank;
                result.ammo = lp.ammo.isEmpty() ? heur.ammo : lp.ammo;
                result.aggression = lp.aggression;
                result.source = "gemma";
            }
            plan = result;
            thought = result.thought;
            source = result.source;
            if(!enabled) status = "ИИ выкл — эвристика";
            else if("gemma".equals(result.source)) status = "Gemma 4 E2B";
            else if(failures > 0) status = "эвристика (Ollama недоступна)";
            else status = "эвристика";
            return result;
        }

        public String hudLine(){
            String tag = "gemma".equals(source) ? "[#8be9fd]🧠[]" : "[lightgray]⚙[]";
            return "💭 Мысль: [white]" + (thought.isEmpty() ? "оцениваю обстановку..." : thought) + "[] " + tag;
        }
    }
}
