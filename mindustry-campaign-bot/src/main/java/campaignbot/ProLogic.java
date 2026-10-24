package campaignbot;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;

/**
 * v2.0 "pro player" logic: terrain recon, chokepoint kill-boxes, layered armour,
 * anti-air umbrella, automatic ammo bus, reactor safety, wave schedule analysis,
 * Core zoning, damage heat map, flank routing (RTS), assault priorities and
 * unit-chain selection.
 * <p>
 * Like {@link CampaignBotLogic} this class has <b>zero</b> dependencies on
 * Mindustry or Arc classes so it can be unit-tested with plain {@code javac}.
 * Everything works on flat int arrays in window coordinates.
 */
public final class ProLogic{
    private ProLogic(){}

    public static final int ROLE_WALL_WINDOW = 5;
    public static final int ROLE_WALL_INNER = 6;
    public static final int ROLE_FRONT_TURRET = 7;
    public static final int ROLE_FORCE = 8;
    public static final int ROLE_OVERDRIVE = 9;
    public static final int ROLE_LIQUID_TURRET = 10;
    public static final int ROLE_POINT_DEFENSE = 11;

    public static final int ZONE_NONE = 0;
    public static final int ZONE_NUCLEUS = 1;
    public static final int ZONE_LANE = 2;
    public static final int KIND_CONVEYOR = 0;
    public static final int KIND_LOGISTICS = 1;
    public static final int KIND_OTHER = 2;

    public static final int BUS_CONVEYOR = 0;
    public static final int BUS_ROUTER = 1;
    public static final int BUS_JUNCTION = 2;
    public static final int BUS_UNLOADER = 3;

    public static final int CHOKE_MIN_DIST = 15;
    public static final int CHOKE_MAX_DIST = 45;
    public static final int CHOKE_MIN_WIDTH = 3;
    public static final int CHOKE_MAX_WIDTH = 14;

    // ---------------------------------------------------------------- helpers

    /** Tiny growable int list. */
    public static final class IntList{
        public int[] a = new int[16];
        public int n;

        public void add(int v){
            if(n == a.length) a = Arrays.copyOf(a, n * 2);
            a[n++] = v;
        }

        public void add(int v1, int v2){
            add(v1);
            add(v2);
        }

        public void add(int v1, int v2, int v3){
            add(v1);
            add(v2);
            add(v3);
        }

        public void add(int v1, int v2, int v3, int v4, int v5){
            add(v1);
            add(v2);
            add(v3);
            add(v4);
            add(v5);
        }

        public int get(int i){
            return a[i];
        }

        public int size(){
            return n;
        }

        public int[] toArray(){
            return Arrays.copyOf(a, n);
        }
    }

    static int[] fillArray(int n, int v){
        int[] a = new int[n];
        Arrays.fill(a, v);
        return a;
    }

    public static boolean inBounds(int w, int h, int x, int y){
        return x >= 0 && y >= 0 && x < w && y < h;
    }

    static int floorDiv2(int v){
        return Math.floorDiv(v, 2);
    }

    /** Safety scale for wave calls: aggression 0..1, NaN = neutral (v1 behaviour). */
    public static float aggressionSafetyScale(float aggression){
        if(Float.isNaN(aggression)) return 1f;
        return Math.max(0.5f, Math.min(1.5f, 1.5f - aggression));
    }

    // ------------------------------------------------------ terrain analysis

    /** Chebyshev distance transform: distance of every passable cell to the nearest rock / map edge. */
    public static int[] distanceToWall(int w, int h, boolean[] passable){
        int n = w * h;
        int[] dist = fillArray(n, -1);
        int[] queue = new int[n];
        int head = 0, tail = 0;
        for(int i = 0; i < n; i++){
            if(!passable[i]){
                dist[i] = 0;
                queue[tail++] = i;
            }
        }
        for(int i = 0; i < n; i++){
            if(!passable[i]) continue;
            int x = i % w, y = i / w;
            if(x == 0 || y == 0 || x == w - 1 || y == h - 1){
                dist[i] = 1;
                queue[tail++] = i;
            }
        }
        while(head < tail){
            int i = queue[head++];
            int x = i % w, y = i / w;
            for(int dy = -1; dy <= 1; dy++){
                for(int dx = -1; dx <= 1; dx++){
                    if(dx == 0 && dy == 0) continue;
                    int nx = x + dx, ny = y + dy;
                    if(nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                    int ni = ny * w + nx;
                    if(dist[ni] != -1) continue;
                    dist[ni] = dist[i] + 1;
                    queue[tail++] = ni;
                }
            }
        }
        return dist;
    }

    /**
     * Resumable A* over the ground-passability grid (time-sliced so the game thread
     * is never blocked). Costs mimic Mindustry's costGround: +2 next to solid rock.
     */
    public static final class PathSearch{
        public boolean done, found;
        public int expansions;
        public final IntList xs = new IntList();
        public final IntList ys = new IntList();

        private final int w, h, tx, ty, start, goal;
        private final boolean[] passable;
        private final int[] dist;
        private int[] g, parent;
        private boolean[] closed;
        private int[] hIdx = new int[64], hKey = new int[64];
        private int hSize;

        public PathSearch(int w, int h, boolean[] passable, int[] dist, int sx, int sy, int tx, int ty){
            this.w = w;
            this.h = h;
            this.passable = passable;
            this.dist = dist;
            this.tx = tx;
            this.ty = ty;
            this.start = sy * w + sx;
            this.goal = ty * w + tx;
            if(!inBounds(w, h, sx, sy) || !inBounds(w, h, tx, ty) || !passable[start] || !passable[goal]){
                done = true;
                return;
            }
            int n = w * h;
            g = fillArray(n, 1000000000);
            parent = fillArray(n, -1);
            closed = new boolean[n];
            g[start] = 0;
            push(start, heur(sx, sy));
        }

        private int heur(int x, int y){
            int dx = Math.abs(x - tx), dy = Math.abs(y - ty);
            return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
        }

        private void push(int idx, int key){
            if(hSize == hIdx.length){
                hIdx = Arrays.copyOf(hIdx, hSize * 2);
                hKey = Arrays.copyOf(hKey, hSize * 2);
            }
            int i = hSize++;
            hIdx[i] = idx;
            hKey[i] = key;
            while(i > 0){
                int p = (i - 1) >> 1;
                if(hKey[p] <= hKey[i]) break;
                int ti = hIdx[p], tk = hKey[p];
                hIdx[p] = hIdx[i];
                hKey[p] = hKey[i];
                hIdx[i] = ti;
                hKey[i] = tk;
                i = p;
            }
        }

        private int pop(){
            int top = hIdx[0];
            hSize--;
            if(hSize > 0){
                hIdx[0] = hIdx[hSize];
                hKey[0] = hKey[hSize];
                int i = 0;
                for(;;){
                    int l = 2 * i + 1, r = l + 1, m = i;
                    if(l < hSize && hKey[l] < hKey[m]) m = l;
                    if(r < hSize && hKey[r] < hKey[m]) m = r;
                    if(m == i) break;
                    int ti = hIdx[m], tk = hKey[m];
                    hIdx[m] = hIdx[i];
                    hKey[m] = hKey[i];
                    hIdx[i] = ti;
                    hKey[i] = tk;
                    i = m;
                }
            }
            return top;
        }

        /** Runs up to maxExpansions node expansions; returns true when finished. */
        public boolean step(int maxExpansions){
            if(done) return true;
            int budget = maxExpansions;
            while(hSize > 0 && budget-- > 0){
                int cur = pop();
                if(closed[cur]) continue;
                closed[cur] = true;
                expansions++;
                if(cur == goal){
                    IntList rev = new IntList();
                    for(int c = goal; c != -1; c = parent[c]) rev.add(c);
                    for(int q = rev.size() - 1; q >= 0; q--){
                        int cell = rev.get(q);
                        xs.add(cell % w);
                        ys.add(cell / w);
                    }
                    found = true;
                    done = true;
                    return true;
                }
                int x = cur % w, y = cur / w;
                for(int dy = -1; dy <= 1; dy++){
                    for(int dx = -1; dx <= 1; dx++){
                        if(dx == 0 && dy == 0) continue;
                        int nx = x + dx, ny = y + dy;
                        if(nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                        int ni = ny * w + nx;
                        if(!passable[ni] || closed[ni]) continue;
                        if(dx != 0 && dy != 0 && (!passable[y * w + nx] || !passable[ny * w + x])) continue;
                        int step = (dx != 0 && dy != 0) ? 14 : 10;
                        if(dist != null && dist[ni] >= 0 && dist[ni] <= 1) step += 20;
                        int ng = g[cur] + step;
                        if(ng < g[ni]){
                            g[ni] = ng;
                            parent[ni] = cur;
                            push(ni, ng + heur(nx, ny));
                        }
                    }
                }
            }
            if(hSize == 0) done = true;
            return done;
        }
    }

    /** A ground path, ordered start to goal. */
    public static final class GroundPath{
        public boolean found;
        public int[] xs = new int[0];
        public int[] ys = new int[0];
    }

    public static GroundPath findGroundPath(int w, int h, boolean[] passable, int[] dist, int sx, int sy, int tx, int ty){
        PathSearch s = new PathSearch(w, h, passable, dist, sx, sy, tx, ty);
        s.step(2000000000);
        GroundPath p = new GroundPath();
        p.found = s.found;
        p.xs = s.xs.toArray();
        p.ys = s.ys.toArray();
        return p;
    }

    /** Passable run {lo, hi, width} through (x, y). axis 1 = wall runs along Y. */
    public static int[] scanRun(int w, int h, boolean[] passable, int axis, int x, int y, int cap){
        int c = axis == 1 ? y : x;
        int lo = c, hi = c;
        while(hi - lo + 1 <= cap && runOk(w, h, passable, axis, x, y, hi + 1)) hi++;
        while(hi - lo + 1 <= cap && runOk(w, h, passable, axis, x, y, lo - 1)) lo--;
        return new int[]{lo, hi, hi - lo + 1};
    }

    private static boolean runOk(int w, int h, boolean[] passable, int axis, int x, int y, int v){
        int px = axis == 1 ? x : v, py = axis == 1 ? v : y;
        return inBounds(w, h, px, py) && passable[py * w + px];
    }

    /** A bottleneck on a spawn to core corridor. Coordinates are window tiles. */
    public static final class Choke{
        public int score, axis, fwd, cx, cy, lo, hi, width, p0, pathIndex;
        public float dist;
        public int dtWidth;
    }

    /** Map (p along the wall line, k depth toward the enemy) of a chokepoint to tile coordinates. */
    public static int[] chokePos(Choke ch, int p, int k){
        return ch.axis == 1 ? new int[]{ch.cx + ch.fwd * k, p} : new int[]{p, ch.cy + ch.fwd * k};
    }

    public static float distPointToPoint(float ax, float ay, float bx, float by){
        float dx = ax - bx, dy = ay - by;
        return (float)Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Finds the narrowest 3..14 tile bottleneck on every spawn to core corridor,
     * 15..45 tiles from the core, closed rock to rock. Paths run spawn to core.
     */
    public static ArrayList<Choke> findChokepoints(int w, int h, boolean[] passable, int[] dist, GroundPath[] paths, int coreX, int coreY){
        ArrayList<Choke> found = new ArrayList<Choke>();
        for(int pi = 0; pi < paths.length; pi++){
            GroundPath path = paths[pi];
            if(path == null || path.xs.length < 10) continue;
            Choke best = null;
            for(int i = 0; i < path.xs.length; i++){
                int x = path.xs[i], y = path.ys[i];
                float d = distPointToPoint(x, y, coreX, coreY);
                if(d < CHOKE_MIN_DIST || d > CHOKE_MAX_DIST) continue;
                int j0 = Math.max(0, i - 4), j1 = Math.min(path.xs.length - 1, i + 4);
                int tx = path.xs[j1] - path.xs[j0], ty = path.ys[j1] - path.ys[j0];
                if(tx == 0 && ty == 0) continue;
                int axis, fwd;
                if(Math.abs(tx) >= Math.abs(ty)){
                    axis = 1;
                    fwd = tx > 0 ? -1 : 1;
                }else{
                    axis = 0;
                    fwd = ty > 0 ? -1 : 1;
                }
                int[] run = scanRun(w, h, passable, axis, x, y, 40);
                if(run[2] < CHOKE_MIN_WIDTH || run[2] > CHOKE_MAX_WIDTH) continue;
                int score = run[2] * 100 + (int)(d * 3);
                if(best == null || score < best.score){
                    int idx = y * w + x;
                    best = new Choke();
                    best.score = score;
                    best.axis = axis;
                    best.fwd = fwd;
                    best.cx = x;
                    best.cy = y;
                    best.lo = run[0];
                    best.hi = run[1];
                    best.width = run[2];
                    best.p0 = floorDiv2(run[0] + run[1]);
                    best.dist = d;
                    best.dtWidth = dist != null ? 2 * dist[idx] - 1 : run[2];
                    best.pathIndex = i;
                }
            }
            if(best == null) continue;
            boolean dup = false;
            for(int f = 0; f < found.size(); f++){
                Choke o = found.get(f);
                if(Math.abs(o.cx - best.cx) + Math.abs(o.cy - best.cy) <= 10){
                    dup = true;
                    break;
                }
            }
            if(!dup) found.add(best);
        }
        // insertion sort by score (stable, tiny list)
        for(int i = 1; i < found.size(); i++){
            Choke c = found.get(i);
            int j = i - 1;
            while(j >= 0 && found.get(j).score > c.score){
                found.set(j + 1, found.get(j));
                j--;
            }
            found.set(j + 1, c);
        }
        return found;
    }

    /** Eight-way compass name of a direction (y grows to the north, like the Mindustry world). */
    public static String compassFlank(float dx, float dy){
        if(Math.abs(dx) < 1e-6f && Math.abs(dy) < 1e-6f) return "any";
        double ang = Math.atan2(dy, dx) * 180.0 / Math.PI;
        if(ang < 0) ang += 360.0;
        String[] names = {"east", "north-east", "north", "north-west", "west", "south-west", "south", "south-east"};
        return names[(int)Math.floor((ang + 22.5) / 45.0) % 8];
    }

    /** Unit-ish direction of a compass name, or null for "any"/unknown. */
    public static int[] flankVector(String name){
        if(name == null) return null;
        switch(name){
            case "east": return new int[]{1, 0};
            case "north-east": return new int[]{1, 1};
            case "north": return new int[]{0, 1};
            case "north-west": return new int[]{-1, 1};
            case "west": return new int[]{-1, 0};
            case "south-west": return new int[]{-1, -1};
            case "south": return new int[]{0, -1};
            case "south-east": return new int[]{1, -1};
            default: return null;
        }
    }

    // ------------------------------------------------------- kill-box fortress

    /** Options of {@link #buildKillBox}. */
    public static final class KillBoxOpts{
        public int frontSize = 1, mainSize = 1, supportSize = 1;
        /** 0 = automatic (3 for wide passes, else 2). */
        public int flankLayers = 0;
        public boolean wantForce, wantOverdrive;
        public boolean wantInner = true;
    }

    /** Result of {@link #buildKillBox}: slots are flat 5-tuples x, y, size, role, layer. */
    public static final class KillBox{
        public int[] slots = new int[0];
        /** Ammo bus spine tiles, flat x, y pairs. */
        public int[] spine = new int[0];
        public int spineLen;
        public int wLo, wHi, winW, p0, kb, flankLayers, windowLayers;
    }

    /**
     * Builds the chokepoint "kill-box" layout (see the JS reference): walls with a thinner
     * bait window in the middle, a plastanium inner layer, front turret row, ammo bus spine,
     * main strike row, support row, power node, force and overdrive projectors.
     */
    public static KillBox buildKillBox(int w, int h, boolean[] passable, Choke ch, KillBoxOpts opts){
        return new KillBoxBuilder(w, h, passable, ch, opts).build();
    }

    private static final class KillBoxBuilder{
        final int w, h;
        final boolean[] passable;
        final Choke ch;
        final KillBoxOpts opts;
        final IntList slots = new IntList();
        final HashSet<String> used = new HashSet<String>();
        int width, flankLayers, windowLayers, winW, p0, wLo, wHi;

        KillBoxBuilder(int w, int h, boolean[] passable, Choke ch, KillBoxOpts opts){
            this.w = w;
            this.h = h;
            this.passable = passable;
            this.ch = ch;
            this.opts = opts;
        }

        boolean cellOk(int p, int k){
            int[] xy = chokePos(ch, p, k);
            return inBounds(w, h, xy[0], xy[1]) && passable[xy[1] * w + xy[0]];
        }

        String usedKey(int p, int k){
            return p + "," + k;
        }

        /** Passable span {lo, hi} of depth row k around p0, or null. */
        int[] rowSpan(int k){
            int start = Integer.MIN_VALUE;
            for(int d = 0; d <= 3 && start == Integer.MIN_VALUE; d++){
                if(cellOk(p0 + d, k)) start = p0 + d;
                else if(cellOk(p0 - d, k)) start = p0 - d;
            }
            if(start == Integer.MIN_VALUE) return null;
            int lo = start, hi = start;
            while(hi - lo < 40 && cellOk(hi + 1, k)) hi++;
            while(hi - lo < 40 && cellOk(lo - 1, k)) lo--;
            return new int[]{lo, hi};
        }

        int[] originOf(int pA, int pB, int kA, int kB, int size){
            int[] a = chokePos(ch, pA, kA), b = chokePos(ch, pB, kB);
            int off = (size - 1) / 2;
            return new int[]{Math.min(a[0], b[0]) + off, Math.min(a[1], b[1]) + off};
        }

        boolean footprintOk(int pA, int pB, int kA, int kB){
            for(int p = pA; p <= pB; p++){
                for(int k = Math.min(kA, kB); k <= Math.max(kA, kB); k++){
                    if(!cellOk(p, k) || used.contains(usedKey(p, k))) return false;
                }
            }
            return true;
        }

        void markFootprint(int pA, int pB, int kA, int kB){
            for(int p = pA; p <= pB; p++){
                for(int k = Math.min(kA, kB); k <= Math.max(kA, kB); k++) used.add(usedKey(p, k));
            }
        }

        boolean addBlock(int pA, int size, int kTop, int role, int layer){
            int pB = pA + size - 1, kBot = kTop - (size - 1);
            if(!footprintOk(pA, pB, kBot, kTop)) return false;
            markFootprint(pA, pB, kBot, kTop);
            int[] o = originOf(pA, pB, kBot, kTop, size);
            slots.add(o[0], o[1], size, role, layer);
            return true;
        }

        boolean skipCell(boolean innerBand, int layerIndex, int p){
            return !innerBand && layerIndex >= windowLayers && p >= wLo && p <= wHi;
        }

        int roleAt(boolean innerBand, int layerIndex, int p){
            if(innerBand) return ROLE_WALL_INNER;
            return (layerIndex < windowLayers && p >= wLo && p <= wHi) ? ROLE_WALL_WINDOW : CampaignBotLogic.ROLE_WALL;
        }

        void wallBand(int kLow, int layerId, boolean innerBand, int layerIndex){
            int[] s1 = rowSpan(kLow), s2 = rowSpan(kLow + 1);
            if(s1 == null && s2 == null) return;
            int lo = Math.min(s1 != null ? s1[0] : 1000000000, s2 != null ? s2[0] : 1000000000);
            int hi = Math.max(s1 != null ? s1[1] : -1000000000, s2 != null ? s2[1] : -1000000000);
            if(innerBand){
                lo = Math.max(lo, ch.lo - 1);
                hi = Math.min(hi, ch.hi + 1);
            }else if(layerIndex > 0 && hi - lo + 1 > width + 10){
                return; // the pass flares into a hall: skip the extra layer
            }
            for(int p = lo; p <= hi; p++){
                if(skipCell(innerBand, layerIndex, p)) continue;
                if(!skipCell(innerBand, layerIndex, p + 1) && roleAt(innerBand, layerIndex, p) == roleAt(innerBand, layerIndex, p + 1)
                        && footprintOk(p, p + 1, kLow, kLow + 1)){
                    markFootprint(p, p + 1, kLow, kLow + 1);
                    int[] o = originOf(p, p + 1, kLow, kLow + 1, 2);
                    slots.add(o[0], o[1], 2, roleAt(innerBand, layerIndex, p), layerId);
                    continue;
                }
                for(int k = kLow; k <= kLow + 1; k++){
                    if(!cellOk(p, k) || used.contains(usedKey(p, k))) continue;
                    used.add(usedKey(p, k));
                    int[] xy = chokePos(ch, p, k);
                    slots.add(xy[0], xy[1], 1, roleAt(innerBand, layerIndex, p), layerId);
                }
            }
        }

        int spineLo, spineHi;

        void rowSlots(int size, int kTop, int role){
            ArrayList<Integer> ps = new ArrayList<Integer>();
            for(int p = spineLo; p + size - 1 <= spineHi; p += 4) ps.add(p);
            // stable insertion sort by distance of the block centre to p0
            for(int i = 1; i < ps.size(); i++){
                int c = ps.get(i);
                double dc = Math.abs(c + (size - 1) / 2.0 - p0);
                int j = i - 1;
                while(j >= 0 && Math.abs(ps.get(j) + (size - 1) / 2.0 - p0) > dc){
                    ps.set(j + 1, ps.get(j));
                    j--;
                }
                ps.set(j + 1, c);
            }
            int idx = 0;
            for(int i = 0; i < ps.size(); i++){
                if(addBlock(ps.get(i), size, kTop, role, idx)) idx++;
            }
        }

        KillBox build(){
            int fs = Math.max(1, opts.frontSize), ms = Math.max(1, opts.mainSize), ss = Math.max(1, opts.supportSize);
            width = ch.width;
            flankLayers = opts.flankLayers > 0 ? opts.flankLayers : (width >= 8 ? 3 : 2);
            windowLayers = Math.max(1, flankLayers - 1);
            winW = Math.max(2, 2 * Math.round(width / 6f));
            winW = Math.min(winW, Math.max(1, width - 2));
            p0 = ch.p0;
            wLo = p0 - winW / 2;
            wHi = wLo + winW - 1;

            int kb = -3 - fs;
            IntList spine = new IntList();
            spineLo = 0;
            spineHi = -1;
            int[] spanB = rowSpan(kb);
            if(spanB != null){
                spineLo = Math.max(spanB[0], p0 - 8);
                spineHi = Math.min(spanB[1], p0 + 8);
                if((spineHi - spineLo + 1) % 2 == 0) spineHi--;
                if(spineHi - spineLo + 1 < 3){
                    spineLo = 0;
                    spineHi = -1;
                }
            }
            for(int sp = spineLo; sp <= spineHi; sp++){
                int[] sxy = chokePos(ch, sp, kb);
                spine.add(sxy[0], sxy[1]);
                used.add(usedKey(sp, kb));
            }
            boolean hasSpine = spine.size() > 0;
            if(hasSpine){
                rowSlots(ms, kb - 1, CampaignBotLogic.ROLE_GROUND_TURRET);
                rowSlots(fs, -3, ROLE_FRONT_TURRET);
            }

            int supTop = kb - ms - 1;
            int supIdx = 0;
            if(hasSpine){
                for(int q = spineLo + 2; q + ss - 1 <= spineHi; q += 4){
                    if(addBlock(q, ss, supTop, CampaignBotLogic.ROLE_SUPPORT, supIdx)) supIdx++;
                }
            }
            int powerK = supTop - ss;
            addBlock(p0, 1, powerK, CampaignBotLogic.ROLE_POWER_NODE, 0);
            if(opts.wantForce) addBlock(p0 - 1, 3, powerK - 1, ROLE_FORCE, 0);
            if(opts.wantOverdrive) addBlock(p0 + 3, 2, powerK - 1, ROLE_OVERDRIVE, 0);

            for(int j = 0; j < flankLayers; j++) wallBand(2 * j, j, false, j);
            if(opts.wantInner) wallBand(-2, 100, true, 0);

            KillBox kbx = new KillBox();
            kbx.slots = slots.toArray();
            kbx.spine = spine.toArray();
            kbx.spineLen = spine.size() / 2;
            kbx.wLo = wLo;
            kbx.wHi = wHi;
            kbx.winW = winW;
            kbx.p0 = p0;
            kbx.kb = kb;
            kbx.flankLayers = flankLayers;
            kbx.windowLayers = windowLayers;
            return kbx;
        }
    }

    /** Wall HP to Mindustry ground flowfield step cost for enemy units (PathTile.health * 5 / 100). */
    public static int groundPathCostThroughWall(float buildingHp){
        int healthField = Math.min((int)Math.floor(buildingHp / 40f), 80);
        return 1 + healthField * 5 / 100;
    }

    /**
     * Verifies the kill-box funnel: returns the line coordinate p where the cheapest
     * enemy ground route crosses the wall band, or NaN when it cannot cross.
     */
    public static float killBoxCrossingP(int w, int h, boolean[] passable, Choke ch, int[] slots, float wallHp){
        int n = w * h;
        float[] cost = new float[n];
        for(int i = 0; i < n; i++) cost[i] = passable[i] ? 10f : -1f;
        float wcost = groundPathCostThroughWall(wallHp) * 10f;
        for(int s = 0; s + 4 < slots.length; s += 5){
            int sx = slots[s], sy = slots[s + 1], size = slots[s + 2], role = slots[s + 3];
            if(role == CampaignBotLogic.ROLE_POWER_NODE) continue;
            int off = (size - 1) / 2;
            for(int dy = 0; dy < size; dy++){
                for(int dx = 0; dx < size; dx++){
                    int cx = sx - off + dx, cy = sy - off + dy;
                    if(inBounds(w, h, cx, cy) && cost[cy * w + cx] > 0) cost[cy * w + cx] = wcost;
                }
            }
        }
        int[] a = chokePos(ch, ch.p0, 12), b = chokePos(ch, ch.p0, -16);
        if(!inBounds(w, h, a[0], a[1]) || !inBounds(w, h, b[0], b[1])) return Float.NaN;
        int start = a[1] * w + a[0], goal = b[1] * w + b[0];
        if(cost[start] < 0 || cost[goal] < 0) return Float.NaN;
        float[] d = new float[n];
        Arrays.fill(d, 1e9f);
        int[] par = fillArray(n, -1);
        boolean[] done = new boolean[n];
        d[start] = 0;
        IntList frontier = new IntList();
        frontier.add(start);
        while(frontier.size() > 0){
            int bi = 0;
            for(int f = 1; f < frontier.n; f++) if(d[frontier.a[f]] < d[frontier.a[bi]]) bi = f;
            int cur = frontier.a[bi];
            frontier.a[bi] = frontier.a[frontier.n - 1];
            frontier.n--;
            if(done[cur]) continue;
            done[cur] = true;
            if(cur == goal) break;
            int x = cur % w, y = cur / w;
            for(int ey = -1; ey <= 1; ey++){
                for(int ex = -1; ex <= 1; ex++){
                    if(ex == 0 && ey == 0) continue;
                    int nx = x + ex, ny = y + ey;
                    if(!inBounds(w, h, nx, ny)) continue;
                    int ni = ny * w + nx;
                    if(cost[ni] < 0 || done[ni]) continue;
                    if(ex != 0 && ey != 0 && (cost[y * w + nx] < 0 || cost[ny * w + x] < 0)) continue;
                    float nd = d[cur] + cost[ni] * ((ex != 0 && ey != 0) ? 1.4f : 1f);
                    if(nd < d[ni]){
                        d[ni] = nd;
                        par[ni] = cur;
                        frontier.add(ni);
                    }
                }
            }
        }
        if(!done[goal]) return Float.NaN;
        float sum = 0;
        int count = 0;
        for(int c = goal; c != -1; c = par[c]){
            int px = c % w, py = c / w;
            int pp = ch.axis == 1 ? py : px;
            int kk = ch.axis == 1 ? (px - ch.cx) * ch.fwd : (py - ch.cy) * ch.fwd;
            if(kk == 0 || kk == 1){
                sum += pp;
                count++;
            }
        }
        return count == 0 ? Float.NaN : sum / count;
    }

    // ------------------------------------------------------- anti-air umbrella

    /**
     * Anti-air corridor on the straight air vector spawn to core plus cover slots next to
     * generator/reactor clusters. Returns flat triples x, y, kind (0 = vector line, 1 = generator cover).
     * Exact tiles are validated by the caller.
     */
    public static int[] planAaCorridor(int coreX, int coreY, int spawnX, int spawnY, int[] generators, int count, int spacing, int distance){
        IntList out = new IntList();
        float dx = spawnX - coreX, dy = spawnY - coreY;
        float len = (float)Math.sqrt(dx * dx + dy * dy);
        if(len < 1e-3f) return new int[0];
        float ux = dx / len, uy = dy / len;
        float px = -uy, py = ux;
        float dAa = Math.min(distance, Math.max(8f, len * 0.4f));
        float cx = coreX + ux * dAa, cy = coreY + uy * dAa;
        float[] offsets = new float[count];
        for(int i = 0; i < count; i++) offsets[i] = (i - (count - 1) / 2f) * spacing;
        for(int i = 1; i < offsets.length; i++){
            float c = offsets[i];
            int j = i - 1;
            while(j >= 0 && Math.abs(offsets[j]) > Math.abs(c)){
                offsets[j + 1] = offsets[j];
                j--;
            }
            offsets[j + 1] = c;
        }
        for(int o = 0; o < offsets.length; o++){
            out.add(Math.round(cx + px * offsets[o]), Math.round(cy + py * offsets[o]), 0);
        }
        int[] gens = generators == null ? new int[0] : generators;
        ArrayList<int[]> clusters = new ArrayList<int[]>(); // x, y, n
        for(int g = 0; g + 1 < gens.length; g += 2){
            boolean placed = false;
            for(int c = 0; c < clusters.size(); c++){
                int[] cl = clusters.get(c);
                if(distPointToPoint(gens[g], gens[g + 1], cl[0], cl[1]) <= 8f){
                    cl[2]++;
                    placed = true;
                    break;
                }
            }
            if(!placed) clusters.add(new int[]{gens[g], gens[g + 1], 1});
        }
        for(int i = 1; i < clusters.size(); i++){
            int[] c = clusters.get(i);
            int j = i - 1;
            while(j >= 0 && clusters.get(j)[2] < c[2]){
                clusters.set(j + 1, clusters.get(j));
                j--;
            }
            clusters.set(j + 1, c);
        }
        for(int k = 0; k < clusters.size() && k < 2; k++){
            int[] cl = clusters.get(k);
            int gx = Math.round(cl[0] + ux * 4), gy = Math.round(cl[1] + uy * 4);
            boolean dup = false;
            for(int j = 0; j + 2 < out.size(); j += 3){
                if(distPointToPoint(out.get(j), out.get(j + 1), gx, gy) < 3f){
                    dup = true;
                    break;
                }
            }
            if(!dup) out.add(gx, gy, 1);
        }
        return out.toArray();
    }

    // ------------------------------------------------------------ ammo logistics

    private static final HashMap<String, String[]> TURRET_AMMO = new HashMap<String, String[]>();
    private static final HashMap<String, Integer> AMMO_MIN_STOCK = new HashMap<String, Integer>();

    static{
        TURRET_AMMO.put("duo", new String[]{"silicon", "graphite", "copper"});
        TURRET_AMMO.put("scatter", new String[]{"metaglass", "lead", "scrap"});
        TURRET_AMMO.put("scorch", new String[]{"coal"});
        TURRET_AMMO.put("hail", new String[]{"silicon", "pyratite", "graphite"});
        TURRET_AMMO.put("salvo", new String[]{"thorium", "blast-compound", "silicon", "pyratite", "graphite", "copper"});
        TURRET_AMMO.put("ripple", new String[]{"plastanium", "blast-compound", "pyratite", "silicon", "graphite"});
        TURRET_AMMO.put("cyclone", new String[]{"surge-alloy", "plastanium", "blast-compound", "metaglass"});
        TURRET_AMMO.put("swarmer", new String[]{"surge-alloy", "blast-compound", "pyratite"});
        TURRET_AMMO.put("spectre", new String[]{"thorium", "pyratite", "graphite"});
        TURRET_AMMO.put("fuse", new String[]{"thorium", "titanium", "copper"});
        TURRET_AMMO.put("foreshadow", new String[]{"surge-alloy"});

        AMMO_MIN_STOCK.put("copper", 150);
        AMMO_MIN_STOCK.put("lead", 120);
        AMMO_MIN_STOCK.put("graphite", 120);
        AMMO_MIN_STOCK.put("silicon", 200);
        AMMO_MIN_STOCK.put("metaglass", 120);
        AMMO_MIN_STOCK.put("coal", 60);
        AMMO_MIN_STOCK.put("scrap", 60);
        AMMO_MIN_STOCK.put("pyratite", 120);
        AMMO_MIN_STOCK.put("blast-compound", 120);
        AMMO_MIN_STOCK.put("plastanium", 250);
        AMMO_MIN_STOCK.put("thorium", 250);
        AMMO_MIN_STOCK.put("surge-alloy", 250);
        AMMO_MIN_STOCK.put("titanium", 250);
    }

    /** Ammo items a turret accepts, best first (empty when the turret takes no item ammo). */
    public static String[] turretAmmoList(String turret){
        String[] l = TURRET_AMMO.get(turret);
        return l == null ? new String[0] : l;
    }

    public static boolean turretAcceptsAmmo(String turret, String item){
        String[] list = TURRET_AMMO.get(turret);
        if(list == null || item == null) return false;
        for(int i = 0; i < list.length; i++) if(list[i].equals(item)) return true;
        return false;
    }

    public static boolean ammoStockOk(String item, HashMap<String, Integer> stock, HashMap<String, Boolean> unlocked){
        if(unlocked != null && Boolean.FALSE.equals(unlocked.get(item))) return false;
        Integer need = AMMO_MIN_STOCK.get(item);
        Integer have = stock.get(item);
        return (have == null ? 0 : have.intValue()) >= (need == null ? 100 : need.intValue());
    }

    /** Best usable ammo for one turret. {@code preferred} (e.g. from the AI brain) wins when accepted and stocked. */
    public static String chooseAmmoItem(String turret, HashMap<String, Integer> stock, HashMap<String, Boolean> unlocked, String preferred){
        String[] list = TURRET_AMMO.get(turret);
        if(list == null) return null;
        if(preferred != null && !preferred.isEmpty() && turretAcceptsAmmo(turret, preferred) && ammoStockOk(preferred, stock, unlocked)) return preferred;
        for(int i = 0; i < list.length; i++){
            if(ammoStockOk(list[i], stock, unlocked)) return list[i];
        }
        return null;
    }

    /** One item for a whole shared bus: accepted by as many turrets as possible, then best-ranked. */
    public static String chooseBusAmmo(String[] turrets, HashMap<String, Integer> stock, HashMap<String, Boolean> unlocked, String preferred){
        HashMap<String, int[]> cands = new HashMap<String, int[]>();
        ArrayList<String> order = new ArrayList<String>();
        for(int t = 0; t < turrets.length; t++){
            String[] list = turretAmmoList(turrets[t]);
            for(int i = 0; i < list.length; i++){
                int[] c = cands.get(list[i]);
                if(c == null){
                    c = new int[2];
                    cands.put(list[i], c);
                    order.add(list[i]);
                }
                c[0]++;
                c[1] += list.length - i;
            }
        }
        String best = null;
        int bestScore = -1;
        for(int i = 0; i < order.size(); i++){
            String nm = order.get(i);
            if(!ammoStockOk(nm, stock, unlocked)) continue;
            int[] c = cands.get(nm);
            int score = c[0] * 100 + c[1] + (nm.equals(preferred) ? 50 : 0);
            if(score > bestScore){
                bestScore = score;
                best = nm;
            }
        }
        return best;
    }

    /** First ladder turret that is available and accepts the bus ammo (or needs no ammo). */
    public static String pickTurretForAmmo(String[] ladder, String ammo, HashMap<String, Boolean> available){
        for(int i = 0; i < ladder.length; i++){
            String nm = ladder[i];
            if(available != null && !Boolean.TRUE.equals(available.get(nm))) continue;
            if(!TURRET_AMMO.containsKey(nm) || turretAcceptsAmmo(nm, ammo)) return nm;
        }
        return null;
    }

    /** Status-effect synergy bonus of a liquid turret + ammo combination. */
    public static int statusSynergyBonus(String liquid, String ammo){
        if("cryofluid".equals(liquid) && "blast-compound".equals(ammo)) return 3;
        if("cryofluid".equals(liquid)) return 1;
        if(("oil".equals(liquid) || "slag".equals(liquid)) && "pyratite".equals(ammo)) return 3;
        if("water".equals(liquid) && ("arc".equals(ammo) || "lancer".equals(ammo))) return 2;
        if("water".equals(liquid)) return 1;
        return 0;
    }

    /** Russian explanation of {@link #statusSynergyBonus}. */
    public static String statusSynergyText(String liquid, String ammo){
        if("cryofluid".equals(liquid) && "blast-compound".equals(ammo)) return "заморозка + взрывчатка (шоковый раскол)";
        if("cryofluid".equals(liquid)) return "заморозка замедляет волну";
        if(("oil".equals(liquid) || "slag".equals(liquid)) && "pyratite".equals(ammo)) return "масло/шлак + пиратит (горение)";
        if("water".equals(liquid) && ("arc".equals(ammo) || "lancer".equals(ammo))) return "вода + электричество (шок)";
        if("water".equals(liquid)) return "вода тушит и замедляет";
        return "";
    }

    /** Result of {@link #planAmmoBus}. pieces are flat 4-tuples x, y, type, rotation. */
    public static final class BusPlan{
        public boolean ok;
        public String reason = "";
        public int[] pieces = new int[0];
        public int feederLength;
    }

    private static boolean busBuildable(int w, int h, int[] cells, int x, int y){
        if(!inBounds(w, h, x, y)) return false;
        int c = cells[y * w + x];
        return c == CampaignBotLogic.CELL_FREE || c == CampaignBotLogic.CELL_LANE;
    }

    /**
     * Plans the ammo bus: Unloader (touching the core) to feeder conveyor (BFS) to an
     * alternating Router/Junction spine along the turret rows. unloader = {x, y} or null.
     */
    public static BusPlan planAmmoBus(int w, int h, int[] cells, int[] unloader, int[] spine){
        BusPlan res = new BusPlan();
        int n = spine.length / 2;
        if(n % 2 == 0) n--;
        if(n < 1){
            res.reason = "нет места под шину";
            return res;
        }
        for(int i = 0; i < n; i++){
            if(!busBuildable(w, h, cells, spine[i * 2], spine[i * 2 + 1])){
                n = i;
                break;
            }
        }
        if(n % 2 == 0) n--;
        if(n < 1){
            res.reason = "шина упирается в препятствие";
            return res;
        }
        HashSet<String> occupied = new HashSet<String>();
        for(int i = 0; i < n; i++) occupied.add(spine[i * 2] + "," + spine[i * 2 + 1]);

        IntList pieces = new IntList();
        IntList feeder = new IntList();
        int sx0 = spine[0], sy0 = spine[1];
        if(unloader != null){
            if(!busBuildable(w, h, cells, unloader[0], unloader[1])){
                res.reason = "нет клетки под Unloader";
                return res;
            }
            occupied.add(unloader[0] + "," + unloader[1]);
            HashMap<String, String> prev = new HashMap<String, String>();
            ArrayList<int[]> queue = new ArrayList<int[]>();
            for(int d = 0; d < 4; d++){
                int qx = unloader[0] + CampaignBotLogic.DX[d], qy = unloader[1] + CampaignBotLogic.DY[d];
                String key = qx + "," + qy;
                if(!busBuildable(w, h, cells, qx, qy) || occupied.contains(key) || prev.containsKey(key)) continue;
                prev.put(key, "start");
                queue.add(new int[]{qx, qy});
            }
            int[] goalNode = null;
            int head = 0;
            while(head < queue.size()){
                int[] cur = queue.get(head++);
                for(int e = 0; e < 4; e++){
                    if(cur[0] + CampaignBotLogic.DX[e] == sx0 && cur[1] + CampaignBotLogic.DY[e] == sy0){
                        goalNode = cur;
                        break;
                    }
                }
                if(goalNode != null) break;
                for(int f = 0; f < 4; f++){
                    int nx = cur[0] + CampaignBotLogic.DX[f], ny = cur[1] + CampaignBotLogic.DY[f];
                    String nk = nx + "," + ny;
                    if(!busBuildable(w, h, cells, nx, ny) || occupied.contains(nk) || prev.containsKey(nk)) continue;
                    prev.put(nk, cur[0] + "," + cur[1]);
                    queue.add(new int[]{nx, ny});
                }
            }
            boolean touches = false;
            for(int t = 0; t < 4; t++){
                if(unloader[0] + CampaignBotLogic.DX[t] == sx0 && unloader[1] + CampaignBotLogic.DY[t] == sy0) touches = true;
            }
            if(goalNode == null && !touches){
                res.reason = "нет пути конвейера от Unloader к шине";
                return res;
            }
            if(goalNode != null){
                ArrayList<int[]> chain = new ArrayList<int[]>();
                String ck = goalNode[0] + "," + goalNode[1];
                while(!"start".equals(ck)){
                    String[] parts = ck.split(",");
                    chain.add(new int[]{Integer.parseInt(parts[0]), Integer.parseInt(parts[1])});
                    ck = prev.get(ck);
                }
                for(int c = chain.size() - 1; c >= 0; c--){
                    int[] cell = chain.get(c);
                    int tx = c - 1 >= 0 ? chain.get(c - 1)[0] : sx0;
                    int ty = c - 1 >= 0 ? chain.get(c - 1)[1] : sy0;
                    int rot = 0;
                    for(int r = 0; r < 4; r++){
                        if(cell[0] + CampaignBotLogic.DX[r] == tx && cell[1] + CampaignBotLogic.DY[r] == ty) rot = r;
                    }
                    feeder.add(cell[0]);
                    feeder.add(cell[1]);
                    feeder.add(BUS_CONVEYOR);
                    feeder.add(rot);
                }
            }
            pieces.add(unloader[0]);
            pieces.add(unloader[1]);
            pieces.add(BUS_UNLOADER);
            pieces.add(0);
        }
        for(int i = 0; i < feeder.size(); i++) pieces.add(feeder.get(i));
        res.feederLength = feeder.size() / 4;
        for(int i = 0; i < n; i++){
            pieces.add(spine[i * 2]);
            pieces.add(spine[i * 2 + 1]);
            pieces.add(i % 2 == 0 ? BUS_ROUTER : BUS_JUNCTION);
            pieces.add(0);
        }
        res.pieces = pieces.toArray();
        res.ok = true;
        return res;
    }

    /** Drill-fed variant: a drill + conveyor path ending at the spine start (treated as a core cell). */
    public static CampaignBotLogic.DrillSite planAmmoDrillFeed(int w, int h, int[] cells, int[] ore, int itemIdx, int size, int spineX, int spineY, int maxPath){
        int[] copy = cells.clone();
        copy[spineY * w + spineX] = CampaignBotLogic.CELL_CORE;
        return CampaignBotLogic.findDrillSite(w, h, copy, ore, itemIdx, size, maxPath);
    }

    public static boolean rectTouchesCell(int x0, int y0, int size, int cx, int cy){
        boolean inside = cx >= x0 && cx < x0 + size && cy >= y0 && cy < y0 + size;
        if(inside) return false;
        return cx >= x0 - 1 && cx <= x0 + size && cy >= y0 - 1 && cy <= y0 + size
            && ((cx >= x0 && cx < x0 + size) || (cy >= y0 && cy < y0 + size));
    }

    // -------------------------------------------------------- reactor safety

    /** Inputs of {@link #reactorGuard}. */
    public static final class ReactorState{
        public boolean reactorUnlocked, mixerBuilt, waterOk;
        public float mixerCryoFrac;
        public int titaniumStock, thoriumStock;
        /** Negative = unknown. */
        public float siteDistFromCore = -1f;
        public float powerNetPerSec;
    }

    /**
     * Thorium Reactor guard: never build without guaranteed cryofluid. Returns null
     * when safe or a Russian reason when placement must be refused.
     */
    public static String reactorGuard(ReactorState s){
        if(!s.reactorUnlocked) return "реактор не изучен";
        if(!s.mixerBuilt) return "сначала Cryofluid Mixer: без охлаждения реактор взорвётся";
        if(!s.waterOk) return "нет воды для криогенного миксера";
        if(s.titaniumStock < 80) return "мало титана для криожидкости";
        if(s.mixerCryoFrac < 0.5f) return "криожидкость ещё не накоплена — жду";
        if(s.thoriumStock < 120) return "мало тория для топлива";
        if(s.siteDistFromCore >= 0f && s.siteDistFromCore < 12f) return "реактор слишком близко к ядру";
        return null;
    }

    public static boolean reactorShouldCutFuel(float heat, float cryoFrac){
        return heat >= 0.45f && cryoFrac < 0.25f;
    }

    /** A reactor site: reactor centre, mixer origin, extractor origin. */
    public static final class ReactorSite{
        public int rx, ry, mx, my, ex, ey;
        public float dist;
    }

    /**
     * Finds a reactor site away from the threat: 3x3 reactor + adjacent 2x2 cryofluid
     * mixer + adjacent 2x2 water extractor (window coordinates, reactor by centre).
     */
    public static ReactorSite findReactorSite(int w, int h, int[] cells, int coreX, int coreY, float awayX, float awayY, float minDist, float maxDist){
        float alen = (float)Math.sqrt(awayX * awayX + awayY * awayY);
        if(alen == 0f) alen = 1f;
        float ax = awayX / alen, ay = awayY / alen;
        int rOff = CampaignBotLogic.sizeOffset(3);
        int[][] mixerRel = {{2, -1}, {-1, 2}, {-3, -1}, {-1, -3}};
        int[][] extRel = {{2, 0}, {0, 2}, {-2, 0}, {0, -2}};
        ReactorSite best = null;
        float bestScore = -1e9f;
        for(int ry = 2; ry < h - 2; ry++){
            for(int rx = 2; rx < w - 2; rx++){
                float d = distPointToPoint(rx, ry, coreX, coreY);
                if(d < minDist || d > maxDist) continue;
                float dot = ((rx - coreX) * ax + (ry - coreY) * ay) / d;
                if(dot > 0.35f) continue;
                if(!CampaignBotLogic.rectFree(w, h, cells, rx + rOff, ry + rOff, 3)) continue;
                boolean found = false;
                for(int side = 0; side < 4 && !found; side++){
                    int mx0 = rx + mixerRel[side][0], my0 = ry + mixerRel[side][1];
                    if(!CampaignBotLogic.rectFree(w, h, cells, mx0, my0, 2)) continue;
                    for(int es = 0; es < 4 && !found; es++){
                        int ex0 = mx0 + extRel[es][0], ey0 = my0 + extRel[es][1];
                        if(CampaignBotLogic.rectsOverlap(rx + rOff, ry + rOff, 3, ex0, ey0, 2)) continue;
                        if(!CampaignBotLogic.rectFree(w, h, cells, ex0, ey0, 2)) continue;
                        float score = -Math.abs(d - (minDist + 4)) - dot * 5f;
                        if(score > bestScore){
                            bestScore = score;
                            best = new ReactorSite();
                            best.rx = rx;
                            best.ry = ry;
                            best.mx = mx0;
                            best.my = my0;
                            best.ex = ex0;
                            best.ey = ey0;
                            best.dist = d;
                        }
                        found = true;
                    }
                }
            }
        }
        return best;
    }

    // ------------------------------------------------------ recon: wave schedule

    /** Plain description of one Mindustry SpawnGroup. end &lt; 0 = never ends, max &lt; 0 = unlimited, scaling &lt;= 0 = none. */
    public static final class WaveGroup{
        public String type = "";
        public boolean flying, boss;
        public int begin, end = -1, spacing = 1, amount = 1, max = -1;
        public float scaling, hp = 100f, dps = 10f, shield, shieldScaling;
    }

    /** Mindustry SpawnGroup.getSpawned semantics on a plain group description. */
    public static int waveGroupCount(WaveGroup g, int wave){
        int spacing = g.spacing > 0 ? g.spacing : 1;
        int begin = g.begin;
        int end = g.end < 0 ? 1000000000 : g.end;
        if(wave < begin || wave > end || (wave - begin) % spacing != 0) return 0;
        float scaling = g.scaling > 0f ? g.scaling : 1e9f;
        int count = (g.amount > 0 ? g.amount : 1) + (int)Math.floor((double)((wave - begin) / spacing) / scaling);
        return g.max < 0 ? count : Math.min(count, g.max);
    }

    /** Forecast of one upcoming wave. */
    public static final class WaveForecast{
        public int wave, count, airCount;
        public float hp, dps, airHp, groundHp;
        public boolean boss;
        public ArrayList<String> types = new ArrayList<String>();
    }

    /** Result of {@link #analyzeWaveSchedule}. Wave numbers are 1-based, -1 = none. */
    public static final class WaveReport{
        public int firstAirWave = -1, nextAirWave = -1, firstGroundWave = -1, bossWave = -1, airWaves;
        public String bossType = "";
        public boolean bossFlying;
        public ArrayList<WaveForecast> forecast = new ArrayList<WaveForecast>();
        public float airShareNext;
    }

    /** Reads the whole future wave table. waveIdx = 0-based index of the next wave. */
    public static WaveReport analyzeWaveSchedule(WaveGroup[] groups, int waveIdx, int horizon, int maxScan){
        WaveReport rep = new WaveReport();
        for(int wave = 0; wave < maxScan; wave++){
            boolean airHere = false, groundHere = false;
            for(int gi = 0; gi < groups.length; gi++){
                WaveGroup g = groups[gi];
                if(waveGroupCount(g, wave) <= 0) continue;
                if(g.flying) airHere = true;
                else groundHere = true;
                if(g.boss && rep.bossWave < 0){
                    rep.bossWave = wave + 1;
                    rep.bossType = g.type;
                    rep.bossFlying = g.flying;
                }
            }
            if(airHere){
                rep.airWaves++;
                if(rep.firstAirWave < 0) rep.firstAirWave = wave + 1;
                if(rep.nextAirWave < 0 && wave >= waveIdx) rep.nextAirWave = wave + 1;
            }
            if(groundHere && rep.firstGroundWave < 0) rep.firstGroundWave = wave + 1;
        }
        float airHpSum = 0, hpSum = 0;
        for(int wave = waveIdx; wave < waveIdx + horizon && wave < maxScan + horizon; wave++){
            WaveForecast f = new WaveForecast();
            f.wave = wave + 1;
            for(int gi = 0; gi < groups.length; gi++){
                WaveGroup gg = groups[gi];
                int cnt = waveGroupCount(gg, wave);
                if(cnt <= 0) continue;
                float shield = Math.max(0f, gg.shield + gg.shieldScaling * (wave - gg.begin));
                float hp = cnt * ((gg.hp > 0f ? gg.hp : 100f) + shield);
                f.count += cnt;
                f.hp += hp;
                f.dps += cnt * (gg.dps > 0f ? gg.dps : 10f);
                if(gg.flying){
                    f.airCount += cnt;
                    f.airHp += hp;
                }else{
                    f.groundHp += hp;
                }
                if(gg.boss) f.boss = true;
                f.types.add(cnt + "x" + gg.type);
            }
            rep.forecast.add(f);
            airHpSum += f.airHp;
            hpSum += f.hp;
        }
        rep.airShareNext = hpSum > 0f ? airHpSum / hpSum : 0f;
        return rep;
    }

    // ----------------------------------------------------------- core zoning

    /**
     * Zones around the core: ZONE_NUCLEUS = future 5x5 Core: Nucleus footprint (minus the
     * current core), ZONE_LANE = three-wide conveyor corridors in the four cardinal
     * directions so early buildings never wall the core in.
     */
    public static int[] computeCoreZones(int w, int h, int cx, int cy, int coreSize, int laneLen){
        if(laneLen <= 0) laneLen = 12;
        int[] zone = new int[w * h];
        int cOff = CampaignBotLogic.sizeOffset(coreSize);
        int cx0 = cx + cOff, cy0 = cy + cOff;
        for(int d = 3; d <= laneLen + 3; d++){
            for(int lane = -1; lane <= 1; lane++){
                int[][] pts = {{cx + lane, cy + 2 + d}, {cx + lane, cy - 2 - d}, {cx + 2 + d, cy + lane}, {cx - 2 - d, cy + lane}};
                for(int q = 0; q < 4; q++){
                    int x = pts[q][0], y = pts[q][1];
                    if(inBounds(w, h, x, y)) zone[y * w + x] = ZONE_LANE;
                }
            }
        }
        for(int y = cy - 2; y <= cy + 2; y++){
            for(int x = cx - 2; x <= cx + 2; x++){
                if(!inBounds(w, h, x, y)) continue;
                if(x >= cx0 && x < cx0 + coreSize && y >= cy0 && y < cy0 + coreSize) continue;
                zone[y * w + x] = ZONE_NUCLEUS;
            }
        }
        return zone;
    }

    public static boolean zoneAllows(int zone, int kind){
        if(zone == ZONE_NUCLEUS) return kind <= KIND_LOGISTICS;
        if(zone == ZONE_LANE) return kind == KIND_CONVEYOR;
        return true;
    }

    /**
     * Marks the zones in the window grid: lanes become CELL_LANE (only conveyors, routers
     * and unloaders), the Nucleus reserve becomes CELL_LANE too when reserveNucleus is set.
     * Tiles with ore are never reserved so drills keep their sites.
     */
    public static void applyCoreZones(int w, int h, int[] cells, int cx, int cy, int coreSize, int laneLen, boolean reserveNucleus, int[] ore){
        int[] zone = computeCoreZones(w, h, cx, cy, coreSize, laneLen);
        for(int i = 0; i < zone.length; i++){
            if(cells[i] != CampaignBotLogic.CELL_FREE) continue;
            if(ore != null && ore[i] >= 0) continue;
            if(zone[i] == ZONE_LANE || (zone[i] == ZONE_NUCLEUS && reserveNucleus)) cells[i] = CampaignBotLogic.CELL_LANE;
        }
    }

    // ------------------------------------------------- after-action heat map

    /** One 4x4 tile bucket of the damage heat map. */
    public static final class HeatBucket{
        public int x, y;
        public float amount, air;
    }

    /** Damage heat map by 4x4 tile buckets, with air/ground attribution. */
    public static final class DamageHeat{
        public final java.util.LinkedHashMap<String, HeatBucket> buckets = new java.util.LinkedHashMap<String, HeatBucket>();
        public float total, air, ground;

        public void record(float x, float y, float amount, boolean isAir){
            if(!(amount > 0f)) return;
            int bx = (int)Math.floor(x / 4f), by = (int)Math.floor(y / 4f);
            String key = bx + "," + by;
            HeatBucket b = buckets.get(key);
            if(b == null){
                b = new HeatBucket();
                b.x = bx * 4 + 2;
                b.y = by * 4 + 2;
                buckets.put(key, b);
            }
            b.amount += amount;
            if(isAir){
                b.air += amount;
                air += amount;
            }else{
                ground += amount;
            }
            total += amount;
        }

        /** The n hottest buckets, hottest first. */
        public ArrayList<HeatBucket> hottest(int n){
            ArrayList<HeatBucket> arr = new ArrayList<HeatBucket>(buckets.values());
            for(int i = 1; i < arr.size(); i++){
                HeatBucket c = arr.get(i);
                int j = i - 1;
                while(j >= 0 && arr.get(j).amount < c.amount){
                    arr.set(j + 1, arr.get(j));
                    j--;
                }
                arr.set(j + 1, c);
            }
            while(arr.size() > n) arr.remove(arr.size() - 1);
            return arr;
        }

        public String dominantFlank(float coreX, float coreY){
            HashMap<String, Float> acc = new HashMap<String, Float>();
            String best = "any";
            float bestV = 0f;
            for(HeatBucket b : buckets.values()){
                String f = compassFlank(b.x - coreX, b.y - coreY);
                Float prev = acc.get(f);
                float v = (prev == null ? 0f : prev.floatValue()) + b.amount;
                acc.put(f, v);
                if(v > bestV){
                    bestV = v;
                    best = f;
                }
            }
            return best;
        }

        public float airShare(){
            return total > 0f ? air / total : 0f;
        }

        public void reset(){
            buckets.clear();
            total = 0f;
            air = 0f;
            ground = 0f;
        }
    }

    /** Result of {@link #pickBreachReinforcement}. */
    public static final class Breach{
        public int x, y;
        public boolean air;
        public float amount, airShare;
        public String flank = "any";
    }

    /** After-action decision: where and how to reinforce (null when the wave did no meaningful damage). */
    public static Breach pickBreachReinforcement(DamageHeat heat, float coreX, float coreY, float minTotal){
        if(heat == null || heat.total < (minTotal > 0f ? minTotal : 600f)) return null;
        ArrayList<HeatBucket> top = heat.hottest(1);
        if(top.isEmpty()) return null;
        Breach b = new Breach();
        b.x = top.get(0).x;
        b.y = top.get(0).y;
        b.air = heat.airShare() >= 0.5f;
        b.amount = top.get(0).amount;
        b.flank = heat.dominantFlank(coreX, coreY);
        b.airShare = heat.airShare();
        return b;
    }

    // --------------------------------------------- danger map & flank routing

    /** Enemy turret danger grid. threats: flat 4-tuples x, y, rangeTiles, weight (as floats). */
    public static int[] buildDangerGrid(int w, int h, float[] threats){
        int[] danger = new int[w * h];
        for(int t = 0; t + 3 < threats.length; t += 4){
            float tx = threats[t], ty = threats[t + 1], tr = threats[t + 2], weight = threats[t + 3];
            if(tr <= 0f) continue;
            int r = (int)Math.ceil(tr);
            for(int y = Math.max(0, (int)Math.floor(ty) - r); y <= Math.min(h - 1, (int)Math.floor(ty) + r); y++){
                for(int x = Math.max(0, (int)Math.floor(tx) - r); x <= Math.min(w - 1, (int)Math.floor(tx) + r); x++){
                    float d = distPointToPoint(x, y, tx, ty);
                    if(d > tr) continue;
                    danger[y * w + x] += Math.round((weight > 0f ? weight : 1f) * (6f + 6f * (1f - d / tr)));
                }
            }
        }
        return danger;
    }

    public static float straightPathDanger(int w, int h, int[] danger, float sx, float sy, float gx, float gy){
        int steps = Math.max(1, (int)Math.ceil(distPointToPoint(sx, sy, gx, gy)));
        float sum = 0f;
        for(int i = 0; i <= steps; i++){
            int x = Math.round(sx + (gx - sx) * i / steps), y = Math.round(sy + (gy - sy) * i / steps);
            if(inBounds(w, h, x, y)) sum += danger[y * w + x];
        }
        return sum;
    }

    /** Result of {@link #planFlankRoute}. */
    public static final class FlankRoute{
        /** Flat x, y waypoints (window tiles); the last one is always the goal. */
        public int[] waypoints = new int[0];
        public float danger, directDanger, length, directLength;
        public boolean useFlank;
    }

    private static final class RouteNode{
        final double key;
        final int cell;

        RouteNode(double key, int cell){
            this.key = key;
            this.cell = cell;
        }
    }

    /** Danger-aware route on a coarse grid (step tiles). passable may be null for air units. */
    public static FlankRoute planFlankRoute(int w, int h, int[] danger, boolean[] passable, int sx, int sy, int gx, int gy, int step, float dangerK){
        if(step <= 0) step = 3;
        int cw = (w + step - 1) / step, ch = (h + step - 1) / step;
        float directDanger = straightPathDanger(w, h, danger, sx, sy, gx, gy);
        float directLength = distPointToPoint(sx, sy, gx, gy);
        FlankRoute res = new FlankRoute();
        res.waypoints = new int[]{gx, gy};
        res.danger = directDanger;
        res.directDanger = directDanger;
        res.length = directLength;
        res.directLength = directLength;
        int si = Math.min(cw - 1, sx / step), sj = Math.min(ch - 1, sy / step);
        int gi2 = Math.min(cw - 1, gx / step), gj = Math.min(ch - 1, gy / step);
        int n = cw * ch;
        double[] dist = new double[n];
        Arrays.fill(dist, 1e18);
        int[] par = fillArray(n, -1);
        boolean[] done = new boolean[n];
        java.util.PriorityQueue<RouteNode> open = new java.util.PriorityQueue<RouteNode>(64, new java.util.Comparator<RouteNode>(){
            @Override
            public int compare(RouteNode a, RouteNode b){
                return Double.compare(a.key, b.key);
            }
        });
        int s0 = sj * cw + si, g0 = gj * cw + gi2;
        dist[s0] = 0;
        open.add(new RouteNode(0, s0));
        while(!open.isEmpty()){
            int cur = open.poll().cell;
            if(done[cur]) continue;
            done[cur] = true;
            if(cur == g0) break;
            int ci = cur % cw, cj = cur / cw;
            for(int dy = -1; dy <= 1; dy++){
                for(int dx = -1; dx <= 1; dx++){
                    if(dx == 0 && dy == 0) continue;
                    int ni = ci + dx, nj = cj + dy;
                    if(ni < 0 || nj < 0 || ni >= cw || nj >= ch) continue;
                    int nn = nj * cw + ni;
                    if(done[nn]) continue;
                    int px = Math.min(w - 1, ni * step + (step >> 1)), py = Math.min(h - 1, nj * step + (step >> 1));
                    if(passable != null && nn != g0 && !passable[py * w + px]) continue;
                    double stepLen = step * ((dx != 0 && dy != 0) ? 1.414 : 1.0);
                    double nd = dist[cur] + stepLen + danger[py * w + px] * dangerK;
                    if(nd < dist[nn]){
                        dist[nn] = nd;
                        par[nn] = cur;
                        open.add(new RouteNode(nd, nn));
                    }
                }
            }
        }
        if(!done[g0]) return res;
        IntList rev = new IntList();
        for(int c = g0; c != -1; c = par[c]) rev.add(c);
        IntList pts = new IntList();
        float routeDanger = 0f, length = 0f;
        int lx = sx, ly = sy;
        for(int q = rev.size() - 1; q >= 0; q--){
            int cell = rev.get(q);
            int qi = cell % cw, qj = cell / cw;
            boolean last = q == 0;
            int wx = last ? gx : Math.min(w - 1, qi * step + (step >> 1));
            int wy = last ? gy : Math.min(h - 1, qj * step + (step >> 1));
            routeDanger += danger[Math.min(h - 1, wy) * w + Math.min(w - 1, wx)];
            length += distPointToPoint(lx, ly, wx, wy);
            lx = wx;
            ly = wy;
            pts.add(wx, wy);
        }
        IntList thin = new IntList();
        int lastX = sx, lastY = sy;
        float lastDirX = 0f, lastDirY = 0f;
        for(int k = 0; k + 1 < pts.size(); k += 2){
            float ddx = pts.get(k) - lastX, ddy = pts.get(k + 1) - lastY;
            float dl = (float)Math.sqrt(ddx * ddx + ddy * ddy);
            if(dl == 0f) dl = 1f;
            float ux = ddx / dl, uy = ddy / dl;
            boolean turned = Math.abs(ux - lastDirX) + Math.abs(uy - lastDirY) > 0.5f;
            if(k + 2 >= pts.size() || (turned && dl >= 4f) || dl >= 24f){
                thin.add(pts.get(k), pts.get(k + 1));
                lastX = pts.get(k);
                lastY = pts.get(k + 1);
                lastDirX = ux;
                lastDirY = uy;
            }
        }
        if(thin.size() == 0) thin.add(gx, gy);
        res.waypoints = thin.toArray();
        res.danger = routeDanger;
        res.length = length;
        res.useFlank = directDanger > 0f && routeDanger < directDanger * 0.6f && length <= directLength * 2.4f;
        if(!res.useFlank) res.waypoints = new int[]{gx, gy};
        return res;
    }

    // ---------------------------------------------------- fortress equipment

    public static final String[] WALL_TIERS = {"copper-wall", "titanium-wall", "thorium-wall", "surge-wall"};
    public static final String[] KIT_MAIN_NAMES = {"spectre", "ripple", "cyclone", "salvo", "hail", "duo"};
    public static final int[] KIT_MAIN_SIZES = {4, 3, 3, 2, 1, 1};
    public static final String[] KIT_FRONT_NAMES = {"lancer", "arc", "scorch"};
    public static final int[] KIT_FRONT_SIZES = {2, 1, 1};

    private static boolean isOn(HashMap<String, Boolean> map, String key){
        return map != null && Boolean.TRUE.equals(map.get(key));
    }

    /**
     * Wall block candidates for a kill-box slot, best first (callers fall back to the next one when
     * the stock is short). The strongest tier goes outside, the bait window stays cheap, the inner
     * layer is plastanium (absorbs piercing lasers of Quasar/Vela/Corvus).
     */
    public static String[] pickFortressWalls(int role, int size, int layer, int flankLayers, HashMap<String, Boolean> usableMap){
        ArrayList<String> tiers = new ArrayList<String>();
        for(int i = 0; i < WALL_TIERS.length; i++){
            String nm = size == 2 ? WALL_TIERS[i] + "-large" : WALL_TIERS[i];
            if(isOn(usableMap, nm)) tiers.add(nm);
        }
        ArrayList<String> out = new ArrayList<String>();
        if(role == ROLE_WALL_INNER){
            String pl = size == 2 ? "plastanium-wall-large" : "plastanium-wall";
            if(isOn(usableMap, pl)) out.add(pl);
            for(int i = tiers.size() - 1; i >= 0; i--) out.add(tiers.get(i));
            return out.toArray(new String[0]);
        }
        if(tiers.isEmpty()) return new String[0];
        if(role == ROLE_WALL_WINDOW) return new String[]{tiers.get(0)};
        int best = tiers.size() - 1;
        int idx = Math.max(0, Math.min(best, best - (flankLayers - 1 - layer)));
        for(int i = idx; i >= 0; i--) out.add(tiers.get(i));
        return out.toArray(new String[0]);
    }

    /** Affordability callback of {@link #chooseFortressKit}. */
    public interface Afford{
        boolean ok(String blockName, int count);
    }

    /** The kill-box turret kit. */
    public static final class Kit{
        public String main = "duo", front = "", support = "", ammo = "";
        public int mainSize = 1, frontSize = 1, supportSize = 1;
        public boolean wantForce, wantOverdrive;
    }

    private static int stockOf(HashMap<String, Integer> stock, String item){
        Integer v = stock.get(item);
        return v == null ? 0 : v.intValue();
    }

    /** Chooses the kill-box turret kit from what is unlocked, affordable and fed by the ammo bus. */
    public static Kit chooseFortressKit(HashMap<String, Boolean> usableMap, Afford afford, HashMap<String, Integer> stock, float netPower, String preferredAmmo){
        Kit kit = new Kit();
        String pref = preferredAmmo == null ? "" : preferredAmmo;
        for(int i = 0; i < KIT_MAIN_NAMES.length; i++){
            String name = KIT_MAIN_NAMES[i];
            if(!isOn(usableMap, name) || !afford.ok(name, 3)) continue;
            if(chooseAmmoItem(name, stock, null, pref) == null) continue;
            kit.main = name;
            kit.mainSize = KIT_MAIN_SIZES[i];
            break;
        }
        if("duo".equals(kit.main) && !isOn(usableMap, "duo")){
            kit.main = "";
            kit.mainSize = 1;
        }
        if(!kit.main.isEmpty()){
            String a = chooseAmmoItem(kit.main, stock, null, pref);
            kit.ammo = a == null ? "copper" : a;
        }
        for(int i = 0; i < KIT_FRONT_NAMES.length; i++){
            String name = KIT_FRONT_NAMES[i];
            if(!isOn(usableMap, name) || !afford.ok(name, 2)) continue;
            if("scorch".equals(name) ? stockOf(stock, "coal") < 60 : netPower < 30f) continue;
            kit.front = name;
            kit.frontSize = KIT_FRONT_SIZES[i];
            break;
        }
        if(isOn(usableMap, "mend-projector") && afford.ok("mend-projector", 1)){
            kit.support = "mend-projector";
            kit.supportSize = 2;
        }else if(isOn(usableMap, "mender")){
            kit.support = "mender";
            kit.supportSize = 1;
        }
        kit.wantForce = isOn(usableMap, "force-projector") && netPower >= 60f && afford.ok("force-projector", 1);
        kit.wantOverdrive = isOn(usableMap, "overdrive-projector") && netPower >= 150f && afford.ok("overdrive-projector", 1);
        return kit;
    }

    private static int listRank(String[] list, String name){
        for(int i = 0; i < list.length; i++) if(list[i].equals(name)) return i;
        return 99;
    }

    /** Rank of a ground strike turret in the kit ladder (lower = stronger, 99 = unknown). */
    public static int mainTurretRank(String name){
        return listRank(KIT_MAIN_NAMES, name);
    }

    /**
     * Keeps the kit (and therefore the kill-box geometry) stable: it only changes to a strictly better kit
     * while nothing is built yet or once the current layout is complete (turrets upgrade in place).
     */
    public static Kit mergeKit(Kit old, Kit fresh, boolean complete, boolean nothingBuilt){
        if(old == null) return fresh;
        boolean better = listRank(KIT_MAIN_NAMES, fresh.main) < listRank(KIT_MAIN_NAMES, old.main)
            || (!fresh.front.isEmpty() && (old.front.isEmpty() || listRank(KIT_FRONT_NAMES, fresh.front) < listRank(KIT_FRONT_NAMES, old.front)))
            || ("mend-projector".equals(fresh.support) && !"mend-projector".equals(old.support))
            || (fresh.wantForce && !old.wantForce) || (fresh.wantOverdrive && !old.wantOverdrive);
        if(better && (complete || nothingBuilt)) return fresh;
        if(!fresh.ammo.isEmpty()) old.ammo = fresh.ammo;
        return old;
    }

    /** Window cell adjacent to the core (FREE or LANE) closest to (tx, ty): where the bus Unloader goes. */
    public static int findBusUnloaderCell(int w, int h, int[] cells, int tx, int ty){
        int best = -1;
        long bestD = Long.MAX_VALUE;
        for(int y = 0; y < h; y++){
            for(int x = 0; x < w; x++){
                int c = cells[y * w + x];
                if(c != CampaignBotLogic.CELL_FREE && c != CampaignBotLogic.CELL_LANE) continue;
                boolean touches = false;
                for(int d = 0; d < 4; d++){
                    int nx = x + CampaignBotLogic.DX[d], ny = y + CampaignBotLogic.DY[d];
                    if(nx >= 0 && ny >= 0 && nx < w && ny < h && cells[ny * w + nx] == CampaignBotLogic.CELL_CORE){
                        touches = true;
                        break;
                    }
                }
                if(!touches) continue;
                long dd = (long)(x - tx) * (x - tx) + (long)(y - ty) * (y - ty);
                if(dd < bestD){
                    bestD = dd;
                    best = y * w + x;
                }
            }
        }
        return best;
    }

    // ---------------------------------------------------- assault target priority

    public static final String TARGET_GENERATOR = "generator";
    public static final String TARGET_POWER_NODE = "power-node";
    public static final String TARGET_BATTERY = "battery";
    public static final String TARGET_AMMO_FEED = "ammo-feed";
    public static final String TARGET_TURRET = "turret";
    public static final String TARGET_FACTORY = "factory";
    public static final String TARGET_CORE = "core";

    /** Assault target candidate; powered = false when a turret is already disarmed. */
    public static final class AssaultCand{
        public String kind = "other";
        public float x, y;
        public boolean powered = true;

        public AssaultCand(String kind, float x, float y, boolean powered){
            this.kind = kind;
            this.x = x;
            this.y = y;
            this.powered = powered;
        }
    }

    public static int assaultBaseScore(String kind){
        switch(kind){
            case "generator": return 100;
            case "power-node": return 95;
            case "battery": return 85;
            case "ammo-feed": return 80;
            case "turret": return 50;
            case "factory": return 40;
            case "core": return 20;
            default: return 5;
        }
    }

    /**
     * Picks the next assault target: power first, then ammo logistics ("blind and disarm" the base),
     * turrets, and the core only when the base is disarmed. turrets/disarmed are counts of enemy turrets
     * and how many are unpowered/empty. Returns the candidate index or -1.
     */
    public static int pickAssaultTarget(AssaultCand[] cands, float refX, float refY, int turrets, int disarmed){
        int best = -1;
        float bestScore = -1e9f;
        float disarmedFrac = turrets > 0 ? (float)disarmed / turrets : 1f;
        boolean anyNonCore = false;
        for(int i = 0; i < cands.length; i++) if(!"core".equals(cands[i].kind)) anyNonCore = true;
        for(int i = 0; i < cands.length; i++){
            AssaultCand c = cands[i];
            int base = assaultBaseScore(c.kind);
            if("core".equals(c.kind) && anyNonCore && disarmedFrac < 0.7f) continue;
            if("turret".equals(c.kind) && !c.powered) continue;
            float score = base - distPointToPoint(c.x, c.y, refX, refY) * 0.3f;
            if(score > bestScore){
                bestScore = score;
                best = i;
            }
        }
        if(best < 0){
            for(int i = 0; i < cands.length; i++) if("core".equals(cands[i].kind)) return i;
        }
        return best;
    }

    /** Wounded units (&lt;45% HP) retreat to the repair point and return only above 85%. */
    public static boolean shouldRetreat(float hpFrac, boolean wasRetreating){
        return wasRetreating ? hpFrac < 0.85f : hpFrac < 0.45f;
    }

    // ------------------------------------------------- unit lines (T1..T5 chains)

    public static final String[][] UNIT_LINES = {
        {"dagger", "mace", "fortress", "scepter", "reign"},
        {"flare", "horizon", "zenith", "antumbra", "eclipse"},
        {"risso", "minke", "bryde", "sei", "omura"},
        {"crawler", "atrax", "spiroct", "arkyid", "toxopid"},
        {"nova", "pulsar", "quasar", "vela", "corvus"}
    };
    public static final String[] UNIT_LINE_KEYS = {"ground", "air", "naval", "legs", "support"};
    public static final String[] UNIT_LINE_FACTORY = {"ground-factory", "air-factory", "naval-factory", "ground-factory", "ground-factory"};
    public static final String[] RECONSTRUCTOR_BY_TIER = {null, null, "additive-reconstructor", "multiplicative-reconstructor", "exponential-reconstructor", "tetrative-reconstructor"};

    /** Result of {@link #chooseUnitLine}. */
    public static final class UnitLinePlan{
        public String line = "", factory = "";
        public int tiers, wantTier;
        public String[] chain = new String[0];
    }

    private static int lineIndex(String key){
        for(int i = 0; i < UNIT_LINE_KEYS.length; i++) if(UNIT_LINE_KEYS[i].equals(key)) return i;
        return 0;
    }

    /**
     * Chooses the best unit line the bot can fully produce (unlocked holds unit and block names).
     * Heavy sectors (diff &gt;= 8) aim for T5.
     */
    public static UnitLinePlan chooseUnitLine(int diff, HashMap<String, Boolean> unlocked, boolean preferAir, boolean hasWater){
        String[] order = preferAir
            ? new String[]{"air", "ground", "support", "legs", "naval"}
            : new String[]{"ground", "air", "support", "legs", "naval"};
        int wantTier = diff >= 8 ? 5 : diff >= 6 ? 4 : diff >= 4 ? 3 : 2;
        UnitLinePlan best = null;
        for(int o = 0; o < order.length; o++){
            String key = order[o];
            if("naval".equals(key) && !hasWater) continue;
            int li = lineIndex(key);
            String[] units = UNIT_LINES[li];
            String factory = UNIT_LINE_FACTORY[li];
            if(!isOn(unlocked, factory) || !isOn(unlocked, units[0])) continue;
            int tiers = 1;
            for(int t = 2; t <= wantTier; t++){
                if(!isOn(unlocked, units[t - 1]) || !isOn(unlocked, RECONSTRUCTOR_BY_TIER[t])) break;
                tiers = t;
            }
            if(best == null || tiers > best.tiers){
                best = new UnitLinePlan();
                best.line = key;
                best.tiers = tiers;
                best.chain = Arrays.copyOf(units, tiers);
                best.factory = factory;
                best.wantTier = wantTier;
            }
            if(best.tiers >= wantTier) break;
        }
        return best;
    }

    public static final int[] CHAIN_SIZES = {3, 3, 5, 7, 9};

    /** One block of a unit chain: centre in window coordinates; kind = "factory", "payload" or a reconstructor name. */
    public static final class ChainStage{
        public int cx, cy, size;
        public String kind;

        ChainStage(int cx, int cy, int size, String kind){
            this.cx = cx;
            this.cy = cy;
            this.size = size;
            this.kind = kind;
        }
    }

    /** Result of {@link #findUnitChainSlotTiers}. */
    public static final class ChainSlot{
        public int rotation, exitX, exitY, tiers, unloaderX = -1, unloaderY = -1;
        public boolean hasUnloader;
        public ArrayList<ChainStage> stages = new ArrayList<ChainStage>();
    }

    /**
     * Factory + up to four reconstructor tiers on one axis (payload passes along adjacent blocks);
     * a 3x3 PayloadConveyor spacer links Exponential to Tetrative (T5). Returns null when nothing fits.
     */
    public static ChainSlot findUnitChainSlotTiers(int w, int h, int[] cells, int coreWinX, int coreWinY, boolean allowUnloader, int tiers){
        tiers = Math.max(1, Math.min(5, tiers));
        int fOff = CampaignBotLogic.sizeOffset(3);
        for(int pass = allowUnloader ? 0 : 1; pass <= 1; pass++){
            for(int r = 3; r <= 15; r++){
                for(int fy = coreWinY - r; fy <= coreWinY + r; fy++){
                    for(int fx = coreWinX - r; fx <= coreWinX + r; fx++){
                        if(Math.max(Math.abs(fx - coreWinX), Math.abs(fy - coreWinY)) != r) continue;
                        int fx0 = fx + fOff, fy0 = fy + fOff;
                        if(!CampaignBotLogic.rectFree(w, h, cells, fx0, fy0, 3)) continue;
                        int ux = -1, uy = -1;
                        if(pass == 0){
                            int uCell = CampaignBotLogic.findUnloaderCell(w, h, cells, fx0, fy0, 3);
                            if(uCell < 0) continue;
                            ux = uCell % w;
                            uy = uCell / w;
                        }
                        for(int rot = 0; rot < 4; rot++){
                            ArrayList<ChainStage> stages = new ArrayList<ChainStage>();
                            stages.add(new ChainStage(fx, fy, 3, "factory"));
                            int cxp = fx, cyp = fy, prevHalf = 1;
                            boolean ok = true;
                            for(int t = 2; t <= tiers && ok; t++){
                                int size = CHAIN_SIZES[t - 1];
                                int half = (size - 1) / 2;
                                if(t == 5){
                                    cxp += CampaignBotLogic.DX[rot] * (prevHalf + 1 + 1);
                                    cyp += CampaignBotLogic.DY[rot] * (prevHalf + 1 + 1);
                                    stages.add(new ChainStage(cxp, cyp, 3, "payload"));
                                    prevHalf = 1;
                                }
                                cxp += CampaignBotLogic.DX[rot] * (prevHalf + 1 + half);
                                cyp += CampaignBotLogic.DY[rot] * (prevHalf + 1 + half);
                                stages.add(new ChainStage(cxp, cyp, size, RECONSTRUCTOR_BY_TIER[t]));
                                prevHalf = half;
                            }
                            for(int s = 1; s < stages.size() && ok; s++){
                                ChainStage st = stages.get(s);
                                int so = CampaignBotLogic.sizeOffset(st.size);
                                int rx0 = st.cx + so, ry0 = st.cy + so;
                                if(!CampaignBotLogic.rectFree(w, h, cells, rx0, ry0, st.size)) ok = false;
                                else if(ux >= 0 && ux >= rx0 && ux < rx0 + st.size && uy >= ry0 && uy < ry0 + st.size) ok = false;
                            }
                            if(!ok) continue;
                            ChainStage last = stages.get(stages.size() - 1);
                            int exitX = last.cx + CampaignBotLogic.DX[rot] * (last.size / 2 + 1);
                            int exitY = last.cy + CampaignBotLogic.DY[rot] * (last.size / 2 + 1);
                            if(!inBounds(w, h, exitX, exitY) || cells[exitY * w + exitX] != CampaignBotLogic.CELL_FREE) continue;
                            if(exitX == ux && exitY == uy) continue;
                            ChainSlot slot = new ChainSlot();
                            slot.rotation = rot;
                            slot.stages = stages;
                            slot.hasUnloader = ux >= 0;
                            slot.unloaderX = ux;
                            slot.unloaderY = uy;
                            slot.exitX = exitX;
                            slot.exitY = exitY;
                            slot.tiers = tiers;
                            return slot;
                        }
                    }
                }
            }
        }
        return null;
    }

    // ------------------------------------------------ recon: time-sliced terrain scan

    /** Environment of {@link TerrainScan}: passability and a feature classifier per tile. */
    public interface ScanEnv{
        boolean passable(int x, int y);

        /** "", "ore:&lt;item&gt;", "water", "deep", "oil" or "heat". */
        String feature(int x, int y);
    }

    /**
     * Time-sliced whole-map scan (never blocks the game thread): passability grid, distance
     * transform, A* corridors spawn/enemy core to our core, chokepoints and a resource inventory.
     */
    public static final class TerrainScan{
        public final int w, h;
        public boolean done;
        public final boolean[] passable;
        public int[] dist;
        public final ArrayList<GroundPath> paths = new ArrayList<GroundPath>();
        public ArrayList<Choke> chokes = new ArrayList<Choke>();
        public final java.util.LinkedHashMap<String, Integer> counts = new java.util.LinkedHashMap<String, Integer>();
        public final HashMap<String, Float> nearest = new HashMap<String, Float>();
        public int pathsFound;

        private final ScanEnv env;
        private final int coreX, coreY;
        private final int[] sources;
        private String phase = "grid";
        private int cursor, pathIndex, seedCursor, head, tail;
        private int[] queue;
        private PathSearch search;

        public TerrainScan(int w, int h, int coreX, int coreY, int[] sources, ScanEnv env){
            this.w = w;
            this.h = h;
            this.coreX = coreX;
            this.coreY = coreY;
            this.sources = sources == null ? new int[0] : sources;
            this.env = env;
            this.passable = new boolean[w * h];
        }

        public int sourcesTotal(){
            return sources.length / 2;
        }

        /** Runs one slice; returns true when the scan is finished. */
        public boolean step(int tileBudget, int pathBudget){
            if(done) return true;
            int n = w * h;
            if(phase.equals("grid")){
                int end = Math.min(n, cursor + tileBudget);
                for(int i = cursor; i < end; i++){
                    int x = i % w, y = i / w;
                    passable[i] = env.passable(x, y);
                    String f = env.feature(x, y);
                    if(f != null && !f.isEmpty()){
                        Integer c = counts.get(f);
                        counts.put(f, c == null ? 1 : c.intValue() + 1);
                        float dd = distPointToPoint(x, y, coreX, coreY);
                        Float nd = nearest.get(f);
                        if(nd == null || dd < nd.floatValue()) nearest.put(f, dd);
                    }
                }
                cursor = end;
                if(cursor >= n){
                    phase = "dist";
                    dist = fillArray(n, -1);
                    queue = new int[n];
                    seedCursor = 0;
                    head = 0;
                    tail = 0;
                }
                return false;
            }
            if(phase.equals("dist")){
                if(seedCursor < n){
                    int sEnd = Math.min(n, seedCursor + tileBudget * 4);
                    for(int i = seedCursor; i < sEnd; i++){
                        if(!passable[i]){
                            dist[i] = 0;
                            queue[tail++] = i;
                        }
                    }
                    seedCursor = sEnd;
                    if(seedCursor >= n){
                        for(int i = 0; i < n; i++){
                            if(!passable[i]) continue;
                            int x = i % w, y = i / w;
                            if(x == 0 || y == 0 || x == w - 1 || y == h - 1){
                                dist[i] = 1;
                                queue[tail++] = i;
                            }
                        }
                    }
                    return false;
                }
                int budget = tileBudget * 4;
                while(head < tail && budget-- > 0){
                    int i = queue[head++];
                    int x = i % w, y = i / w;
                    for(int dy = -1; dy <= 1; dy++){
                        for(int dx = -1; dx <= 1; dx++){
                            if(dx == 0 && dy == 0) continue;
                            int nx = x + dx, ny = y + dy;
                            if(nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                            int ni = ny * w + nx;
                            if(dist[ni] != -1) continue;
                            dist[ni] = dist[i] + 1;
                            queue[tail++] = ni;
                        }
                    }
                }
                if(head >= tail){
                    phase = "paths";
                    queue = null;
                }
                return false;
            }
            if(phase.equals("paths")){
                if(pathIndex * 2 >= sources.length){
                    phase = "chokes";
                    return false;
                }
                if(search == null){
                    int sx = sources[pathIndex * 2], sy = sources[pathIndex * 2 + 1];
                    int[] near = nearestPassable(w, h, passable, sx, sy, 4);
                    int[] tc = nearestPassable(w, h, passable, coreX, coreY, 4);
                    if(near == null || tc == null){
                        pathIndex++;
                        return false;
                    }
                    search = new PathSearch(w, h, passable, dist, near[0], near[1], tc[0], tc[1]);
                }
                if(search.step(pathBudget)){
                    if(search.found){
                        GroundPath gp = new GroundPath();
                        gp.found = true;
                        gp.xs = search.xs.toArray();
                        gp.ys = search.ys.toArray();
                        paths.add(gp);
                        pathsFound++;
                    }
                    search = null;
                    pathIndex++;
                }
                return false;
            }
            if(phase.equals("chokes")){
                chokes = findChokepoints(w, h, passable, dist, paths.toArray(new GroundPath[0]), coreX, coreY);
                done = true;
                phase = "done";
                return true;
            }
            return done;
        }
    }

    public static int[] nearestPassable(int w, int h, boolean[] passable, int x, int y, int maxR){
        for(int r = 0; r <= maxR; r++){
            for(int dy = -r; dy <= r; dy++){
                for(int dx = -r; dx <= r; dx++){
                    if(Math.max(Math.abs(dx), Math.abs(dy)) != r) continue;
                    int nx = x + dx, ny = y + dy;
                    if(inBounds(w, h, nx, ny) && passable[ny * w + nx]) return new int[]{nx, ny};
                }
            }
        }
        return null;
    }

    private static int countOf(TerrainScan scan, String key){
        Integer c = scan.counts.get(key);
        return c == null ? 0 : c.intValue();
    }

    /** One-line Russian recon summary for the HUD / journal. sched may be null. */
    public static String summarizeRecon(TerrainScan scan, WaveReport sched, int coreX, int coreY){
        ArrayList<String> parts = new ArrayList<String>();
        StringBuilder ores = new StringBuilder();
        for(java.util.Map.Entry<String, Integer> e : scan.counts.entrySet()){
            if(e.getKey().startsWith("ore:")){
                if(ores.length() > 0) ores.append(", ");
                ores.append(e.getKey().substring(4)).append(' ').append(e.getValue());
            }
        }
        parts.add("руды: " + (ores.length() > 0 ? ores.toString() : "нет"));
        parts.add("вода: " + (countOf(scan, "water") > 0 || countOf(scan, "deep") > 0 ? "есть" : "нет")
            + ", нефть: " + (countOf(scan, "oil") > 0 ? "есть" : "нет") + ", термо: " + countOf(scan, "heat"));
        if(!scan.chokes.isEmpty()){
            Choke c = scan.chokes.get(0);
            parts.add("проходы: " + scan.chokes.size() + " (ширина " + c.width + " в " + Math.round(c.dist) + " тайлах, "
                + compassFlank(c.cx - coreX, c.cy - coreY) + ")");
        }else{
            parts.add("проходы: нет");
        }
        if(sched != null){
            parts.add("авиация с волны " + (sched.firstAirWave > 0 ? String.valueOf(sched.firstAirWave) : "—")
                + ", босс " + (sched.bossWave > 0 ? "волна " + sched.bossWave + " (" + sched.bossType + (sched.bossFlying ? ", воздух" : ", земля") + ")" : "—"));
        }
        StringBuilder sb = new StringBuilder();
        for(int i = 0; i < parts.size(); i++){
            if(i > 0) sb.append(" · ");
            sb.append(parts.get(i));
        }
        return sb.toString();
    }

}
