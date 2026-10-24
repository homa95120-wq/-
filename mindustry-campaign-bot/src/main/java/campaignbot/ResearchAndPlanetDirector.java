package campaignbot;

import arc.Core;
import arc.Events;
import arc.math.Mathf;
import arc.struct.IntIntMap;
import arc.struct.ObjectIntMap;
import arc.struct.ObjectSet;
import arc.struct.Seq;
import mindustry.Vars;
import mindustry.content.Blocks;
import mindustry.content.Items;
import mindustry.content.Loadouts;
import mindustry.content.Planets;
import mindustry.content.SectorPresets;
import mindustry.content.TechTree.TechNode;
import mindustry.ctype.UnlockableContent;
import mindustry.game.EventType.ResearchEvent;
import mindustry.game.EventType.SectorLaunchLoadoutEvent;
import mindustry.game.Objectives.Objective;
import mindustry.game.Objectives.OnSector;
import mindustry.game.Objectives.Produce;
import mindustry.game.Objectives.Research;
import mindustry.game.Objectives.SectorComplete;
import mindustry.game.Schematic;
import mindustry.type.Item;
import mindustry.type.ItemSeq;
import mindustry.type.ItemStack;
import mindustry.type.Planet;
import mindustry.type.Sector;
import mindustry.type.SectorPreset;
import mindustry.world.blocks.storage.CoreBlock;

import static campaignbot.CampaignBotLogic.*;

/**
 * Campaign-level director for {@link Planets#serpulo}:
 * <ul>
 *   <li>honestly researches {@link TechNode}s by spending real items stored across non-frozen Serpulo bases,</li>
 *   <li>tracks the full dependency closure of {@link SectorPresets#planetaryTerminal} and {@link Blocks#interplanetaryAccelerator},</li>
 *   <li>evaluates when to stay in a freshly captured sector to farm missing tech/launch items,</li>
 *   <li>selects and launches into the next Serpulo sector (paying real core schematic + cargo item costs).</li>
 * </ul>
 */
public class ResearchAndPlanetDirector{

    private final IntIntMap sectorLosses = new IntIntMap();
    private final ObjectSet<SectorPreset> victoryPresets = new ObjectSet<>();
    private boolean victoryGraphBuilt = false;

    public String lastResearchSummary = "ожидание ресурсов";
    public String nextTargetSummary = "";
    private final ObjectSet<Item> neededItems = new ObjectSet<>();

    public void recordSectorLoss(Sector sector){
        if(sector == null) return;
        sectorLosses.put(sector.id, sectorLosses.get(sector.id, 0) + 1);
    }

    public int getLosses(Sector sector){
        return sector == null ? 0 : sectorLosses.get(sector.id, 0);
    }

    public void clearLosses(){
        sectorLosses.clear();
    }

    /** Counts captured story presets vs total presets on Serpulo. */
    public int[] countPresetProgress(){
        int captured = 0, total = 0;
        if(Vars.content == null) return new int[]{0, 0};
        for(SectorPreset preset : Vars.content.sectors()){
            if(preset.planet != Planets.serpulo || !preset.requireUnlock) continue;
            total++;
            if(preset.sector != null && preset.sector.isCaptured()) captured++;
        }
        return new int[]{captured, total};
    }

    /** True when Planetary Launch Terminal is captured and Interplanetary Accelerator is researched. */
    public boolean isCampaignWon(){
        if(SectorPresets.planetaryTerminal == null || SectorPresets.planetaryTerminal.sector == null){
            return false;
        }
        if(!SectorPresets.planetaryTerminal.sector.isCaptured()) return false;
        return Blocks.interplanetaryAccelerator == null
                || Blocks.interplanetaryAccelerator.techNode == null
                || Blocks.interplanetaryAccelerator.unlocked();
    }

    /** Builds the exact transitive set of SectorPresets required to unlock Planetary Launch Terminal. */
    private void ensureVictoryGraph(){
        if(victoryGraphBuilt || Planets.serpulo == null || Planets.serpulo.techTree == null) return;
        victoryGraphBuilt = true;
        victoryPresets.clear();

        Seq<TechNode> queue = new Seq<>();
        ObjectSet<TechNode> visited = new ObjectSet<>();
        if(SectorPresets.planetaryTerminal != null && SectorPresets.planetaryTerminal.techNode != null){
            queue.add(SectorPresets.planetaryTerminal.techNode);
            visited.add(SectorPresets.planetaryTerminal.techNode);
        }
        if(Blocks.interplanetaryAccelerator != null && Blocks.interplanetaryAccelerator.techNode != null){
            if(visited.add(Blocks.interplanetaryAccelerator.techNode)){
                queue.add(Blocks.interplanetaryAccelerator.techNode);
            }
        }

        while(!queue.isEmpty()){
            TechNode cur = queue.pop();
            if(cur.content instanceof SectorPreset preset && preset.planet == Planets.serpulo){
                victoryPresets.add(preset);
            }
            if(cur.parent != null && visited.add(cur.parent)){
                queue.add(cur.parent);
            }
            for(Objective obj : cur.objectives){
                SectorPreset p = null;
                UnlockableContent depContent = null;
                if(obj instanceof SectorComplete sc) p = sc.preset;
                else if(obj instanceof OnSector os) p = os.preset;
                else if(obj instanceof Research r && r.content instanceof UnlockableContent uc) depContent = uc;
                else if(obj instanceof Produce pr && pr.content instanceof UnlockableContent uc) depContent = uc;

                if(p != null && p.planet == Planets.serpulo){
                    victoryPresets.add(p);
                    if(p.techNode != null && visited.add(p.techNode)) queue.add(p.techNode);
                }
                if(depContent != null && depContent.techNode != null && visited.add(depContent.techNode)){
                    queue.add(depContent.techNode);
                }
            }
        }
    }

    // -------------------------------------------------------- honest research

    /**
     * Runs one honest research pass over {@code Planets.serpulo.techTree}:
     * triggers {@code checkAutoUnlocks()}, pools spendable items across non-frozen
     * Serpulo bases (preserving combat reserves in the active sector), and spends
     * toward the highest-priority researchable nodes.
     *
     * @return name of newly unlocked content if one completed this pass, else null
     */
    public String runResearchPass(){
        if(Vars.net != null && Vars.net.client()) return null;
        if(Planets.serpulo == null || Planets.serpulo.techTree == null) return null;

        // Unlock any 0-cost nodes (including SectorPresets) whose objectives are now met.
        if(Vars.control != null){
            Vars.control.checkAutoUnlocks();
        }
        // Ensure items currently sitting in the active core count as produced.
        if(Vars.state != null && Vars.state.isCampaign() && Vars.state.getPlanet() == Planets.serpulo){
            var core = Vars.state.rules.defaultTeam.core();
            if(core != null && core.items != null){
                core.items.each((item, amount) -> {
                    if(amount > 0 && !item.unlocked()) item.unlock();
                });
            }
        }

        Seq<TechNode> allNodes = new Seq<>();
        ObjectIntMap<TechNode> indexMap = new ObjectIntMap<>();
        Planets.serpulo.techTree.each(node -> {
            indexMap.put(node, allNodes.size);
            allNodes.add(node);
        });

        Sector activeSector = Vars.state != null && Vars.state.isCampaign() ? Vars.state.getSector() : null;
        Seq<Sector> donorSectors = new Seq<>();
        int itemCount = Vars.content.items().size;
        int[] pool = new int[itemCount];

        for(Sector sec : Planets.serpulo.sectors){
            if(!sec.hasBase() || sec.isFrozen()) continue;
            donorSectors.add(sec);
            ItemSeq items = sec.items();
            for(Item item : Vars.content.items()){
                int keep = sec == activeSector ? activeReserveForResearch(sec, item) : 50;
                int avail = Math.max(0, items.get(item) - keep);
                pool[item.id] += avail;
            }
        }

        int accelIdx = Blocks.interplanetaryAccelerator != null && Blocks.interplanetaryAccelerator.techNode != null
                ? indexMap.get(Blocks.interplanetaryAccelerator.techNode, -1) : -1;

        TechNodeInfo[] infos = new TechNodeInfo[allNodes.size];
        for(int i = 0; i < allNodes.size; i++){
            TechNode node = allNodes.get(i);
            TechNodeInfo info = new TechNodeInfo();
            info.index = i;
            info.name = node.content.name;
            info.parent = node.parent == null ? -1 : indexMap.get(node.parent, -1);
            info.unlocked = node.content.unlockedHost();
            info.isSectorPreset = node.content instanceof SectorPreset;
            info.essentialTier = essentialTechTier(node.content.name);

            boolean allObj = true, nonResObj = true;
            IntSeq deps = new IntSeq();
            for(Objective obj : node.objectives){
                boolean done = obj.complete();
                if(!done) allObj = false;
                if(obj instanceof Research r && r.content != null && r.content.techNode != null){
                    int depIdx = indexMap.get(r.content.techNode, -1);
                    if(depIdx >= 0) deps.add(depIdx);
                }else if(!done){
                    nonResObj = false;
                }
            }
            info.allObjectivesMet = allObj;
            info.nonResearchObjectivesMet = nonResObj;
            info.researchDeps = deps.toArray();

            int remTotal = 0;
            boolean affordAny = node.requirements.length == 0;
            boolean finishNow = true;
            for(int r = 0; r < node.requirements.length; r++){
                int req = node.requirements[r].amount;
                int done = r < node.finishedRequirements.length ? node.finishedRequirements[r].amount : 0;
                int need = Math.max(0, req - done);
                remTotal += need;
                if(need > 0){
                    int have = pool[node.requirements[r].item.id];
                    if(have > 0) affordAny = true;
                    if(have < need) finishNow = false;
                }
            }
            info.remainingCost = remTotal;
            info.canAffordAny = affordAny;
            info.canFinishNow = finishNow;
            infos[i] = info;
        }

        // Track items needed by critical locked tech nodes for farming & industry decisions.
        neededItems.clear();
        boolean[] critical = computeCriticalTechMask(infos, accelIdx);
        TechNode topLockedTarget = null;
        for(int i = 0; i < infos.length; i++){
            if(!critical[i] || infos[i].unlocked || infos[i].isSectorPreset) continue;
            TechNode node = allNodes.get(i);
            if(topLockedTarget == null && (infos[i].parent < 0 || infos[infos[i].parent].unlocked)){
                topLockedTarget = node;
            }
            for(int r = 0; r < node.requirements.length; r++){
                int done = r < node.finishedRequirements.length ? node.finishedRequirements[r].amount : 0;
                if(done < node.requirements[r].amount){
                    neededItems.add(node.requirements[r].item);
                }
            }
        }

        int[] ranked = rankResearchNodes(infos, accelIdx);
        String unlockedName = null;

        // Spend on up to 3 nodes per cycle so cheap chains unlock briskly.
        int limit = Math.min(3, ranked.length);
        for(int k = 0; k < limit; k++){
            TechNode node = allNodes.get(ranked[k]);
            if(spendOnNode(node, donorSectors, activeSector, pool)){
                unlockedName = node.content.localizedName;
                if(Vars.control != null) Vars.control.checkAutoUnlocks();
            }
        }

        if(unlockedName != null){
            lastResearchSummary = "изучено: " + unlockedName + " ✅";
        }else if(ranked.length > 0){
            TechNode current = allNodes.get(ranked[0]);
            lastResearchSummary = progressLabel(current);
        }else if(topLockedTarget != null){
            lastResearchSummary = "копим на " + topLockedTarget.content.localizedName;
        }else{
            lastResearchSummary = "все доступные узлы изучены";
        }

        return unlockedName;
    }

    private int activeReserveForResearch(Sector sec, Item item){
        boolean captured = sec.isCaptured();
        if(item == Items.copper) return captured ? 120 : 220;
        if(item == Items.lead) return captured ? 100 : 180;
        if(item == Items.graphite || item == Items.silicon || item == Items.titanium){
            return captured ? 40 : 90;
        }
        return captured ? 20 : 50;
    }

    private boolean spendOnNode(TechNode node, Seq<Sector> donors, Sector activeSector, int[] pool){
        boolean complete = true;
        boolean anySpent = false;

        for(int i = 0; i < node.requirements.length; i++){
            ItemStack req = node.requirements[i];
            ItemStack finished = node.finishedRequirements[i];
            int missing = Math.max(0, req.amount - finished.amount);
            if(missing > 0){
                int spend = Math.min(missing, pool[req.item.id]);
                if(spend > 0){
                    int deducted = deductAcrossSectors(donors, activeSector, req.item, spend);
                    finished.amount += deducted;
                    pool[req.item.id] = Math.max(0, pool[req.item.id] - deducted);
                    anySpent = true;
                }
            }
            if(finished.amount < req.amount){
                complete = false;
            }
        }

        if(anySpent || node.requirements.length == 0){
            if(complete){
                node.content.unlock();
                TechNode p = node.parent;
                while(p != null){
                    p.content.unlock();
                    p = p.parent;
                }
                Events.fire(new ResearchEvent(node.content));
            }
            node.save();
        }
        return complete && node.content.unlockedHost();
    }

    private int deductAcrossSectors(Seq<Sector> donors, Sector activeSector, Item item, int amount){
        int remaining = amount;
        // Spend from background sectors first, active sector last (matches ResearchDialog).
        for(Sector sec : donors){
            if(remaining <= 0) break;
            if(sec == activeSector) continue;
            int avail = Math.max(0, sec.items().get(item) - 50);
            int take = Math.min(remaining, avail);
            if(take > 0){
                sec.removeItem(item, take);
                remaining -= take;
            }
        }
        if(remaining > 0 && activeSector != null && donors.contains(activeSector)){
            int keep = activeReserveForResearch(activeSector, item);
            int avail = Math.max(0, activeSector.items().get(item) - keep);
            int take = Math.min(remaining, avail);
            if(take > 0){
                activeSector.removeItem(item, take);
                remaining -= take;
            }
        }
        return amount - remaining;
    }

    private String progressLabel(TechNode node){
        long have = 0, total = 0;
        for(int i = 0; i < node.requirements.length; i++){
            total += node.requirements[i].amount;
            have += Math.min(node.requirements[i].amount, node.finishedRequirements[i].amount);
        }
        int pct = total <= 0 ? 100 : (int)Math.min(99L, (have * 100L) / total);
        return node.content.localizedName + " (" + pct + "%)";
    }

    public boolean isItemNeededForTech(Item item){
        return item != null && neededItems.contains(item);
    }

    // ----------------------------------------- sector selection & launching

    /** Checks whether a freshly captured sector should keep running before launching out. */
    public boolean shouldHoldCurrentSector(Sector current, float heldSeconds, float coreFillFrac, boolean producesNeededItem){
        if(current == null || !current.isCaptured()) return false;
        ensureVictoryGraph();

        boolean anotherAttacked = false;
        boolean hasLaunchablePreset = false;
        for(Sector s : Planets.serpulo.sectors){
            if(s != current && s.hasBase() && s.isAttacked()) anotherAttacked = true;
            if(s.preset != null && s.preset.requireUnlock && !s.isCaptured() && isUnlockedToSelect(s) && findValidLaunchOrigin(s, current) != null){
                hasLaunchablePreset = true;
            }
        }
        boolean originAffordable = canAnyBaseAffordBasicLaunch();
        return shouldHoldCapturedSector(
                anotherAttacked,
                hasLaunchablePreset,
                originAffordable,
                producesNeededItem,
                coreFillFrac,
                heldSeconds);
    }

    /** Picks the next Serpulo sector and launches / switches into it honestly. */
    public boolean launchNextSector(Sector currentSector){
        if(Planets.serpulo == null) return false;
        ensureVictoryGraph();
        if(Vars.control != null) Vars.control.checkAutoUnlocks();

        Seq<Sector> candidateRefs = new Seq<>();
        Seq<SectorCandidate> candidateInfos = new Seq<>();

        for(Sector sec : Planets.serpulo.sectors){
            boolean isPreset = sec.preset != null && sec.preset.requireUnlock;
            boolean underAttack = sec.hasBase() && sec.isAttacked();
            boolean unlocked = isUnlockedToSelect(sec);
            if(!isPreset && !underAttack && !sec.hasBase()) continue;
            if(sec == currentSector && sec.isBeingPlayed() && !underAttack) continue;

            Sector origin = sec.hasBase() ? sec
                    : sec == Planets.serpulo.getStartSector() ? null
                    : findValidLaunchOrigin(sec, currentSector);
            boolean canLaunch = sec.hasBase()
                    || sec == Planets.serpulo.getStartSector()
                    || origin != null;

            SectorCandidate c = new SectorCandidate();
            c.id = sec.id;
            c.name = sec.name();
            c.isPreset = isPreset;
            c.onVictoryPath = isPreset && victoryPresets.contains(sec.preset);
            c.isFinalSector = isPreset && sec.preset.isLastSector;
            c.captured = sec.isCaptured();
            c.hasBase = sec.hasBase();
            c.underAttack = underAttack;
            c.unlocked = unlocked;
            c.canLaunchNow = canLaunch;
            c.hasEnemyBase = sec.hasEnemyBase();
            c.difficulty = isPreset ? sec.preset.difficulty : sec.threat * 10f;
            c.losses = getLosses(sec);
            c.farmingScore = sec.hasBase() && sec.isCaptured() ? computeFarmingScore(sec) : 0;

            candidateRefs.add(sec);
            candidateInfos.add(c);
        }

        SectorCandidate[] arr = candidateInfos.toArray(SectorCandidate.class);
        int chosenIdx = chooseNextSector(arr);
        if(chosenIdx < 0) return false;

        Sector target = candidateRefs.get(chosenIdx);
        nextTargetSummary = target.name();
        executeSectorTransition(currentSector, target);
        return true;
    }

    private int computeFarmingScore(Sector sec){
        int score = 0;
        if(!canAnyBaseAffordBasicLaunch()){
            score += 20;
        }
        if(sec.info != null && sec.info.resources != null){
            for(UnlockableContent uc : sec.info.resources){
                if(uc instanceof Item item && neededItems.contains(item)){
                    score += item == Items.thorium ? 30 : item == Items.titanium ? 25 : 15;
                }
            }
        }
        return score;
    }

    private boolean isUnlockedToSelect(Sector sec){
        if(sec == null || sec.isShielded()) return false;
        if(sec.hasBase() || sec == Planets.serpulo.getStartSector()) return true;
        if(sec.preset != null && sec.preset.requireUnlock){
            return sec.preset.unlocked();
        }
        return Planets.serpulo.generator != null && Planets.serpulo.generator.allowLanding(sec);
    }

    private boolean canAnyBaseAffordBasicLaunch(){
        Schematic shard = Loadouts.basicShard;
        if(shard == null) return true;
        ItemSeq req = shard.requirements();
        for(Sector s : Planets.serpulo.sectors){
            if(s.hasBase() && !s.isAttacked() && s.items().has(req)) return true;
        }
        return false;
    }

    /** Finds the richest valid launch-origin sector that can afford the core schematic for {@code destination}. */
    private Sector findValidLaunchOrigin(Sector destination, Sector preferred){
        if(destination == Planets.serpulo.getStartSector()) return null;
        Planet planet = Planets.serpulo;
        if(planet.generator == null) return null;

        Schematic minSchem = Loadouts.basicShard;
        ItemSeq minReq = minSchem != null ? minSchem.requirements() : new ItemSeq();

        Sector best = null;
        int bestWealth = -1;

        for(Sector base : planet.sectors){
            if(!base.hasBase() || base.isAttacked()) continue;
            Sector candidate = planet.generator.findLaunchCandidate(destination, base);
            if(candidate == null || !candidate.hasBase() || candidate.isAttacked()) continue;
            ItemSeq items = candidate.items();
            if(!items.has(minReq)) continue;
            if(!destination.allowLaunchLoadout() && destination.preset != null && destination.preset.generator != null){
                // Preset has fixed rules loadout verified inside findLaunchCandidate.
            }
            int wealth = items.get(Items.copper) + items.get(Items.lead)
                    + items.get(Items.silicon) * 2 + items.get(Items.titanium) * 2
                    + (candidate == preferred ? 500 : 0);
            if(wealth > bestWealth){
                bestWealth = wealth;
                best = candidate;
            }
        }
        return best;
    }

    private void executeSectorTransition(Sector currentSector, Sector target){
        Core.app.post(() -> {
            if(Vars.net != null && Vars.net.active()) return;

            // Save active sector before leaving, exactly like PlanetDialog.playSelected().
            if(Vars.control.saves.getCurrent() != null && Vars.state.isGame()){
                try{
                    Vars.control.saves.getCurrent().save();
                }catch(Throwable ignored){
                }
            }
            if(Vars.ui != null && Vars.ui.planet != null && Vars.ui.planet.isShown()){
                Vars.ui.planet.hide();
            }

            if(target.hasBase()){
                Vars.control.playSector(target);
                return;
            }

            if(target == Planets.serpulo.getStartSector()){
                Vars.universe.clearLoadoutInfo();
                Vars.control.playSector(target);
                return;
            }

            Sector from = findValidLaunchOrigin(target, currentSector);
            if(from == null){
                return;
            }

            CoreBlock coreBlock = chooseLaunchCore(from, target);
            Schematic loadout = Vars.universe.getLoadout(coreBlock);
            if(loadout == null){
                loadout = coreBlock == Blocks.coreNucleus && Loadouts.basicNucleus != null ? Loadouts.basicNucleus
                        : coreBlock == Blocks.coreFoundation && Loadouts.basicFoundation != null ? Loadouts.basicFoundation
                        : Loadouts.basicShard;
            }

            ItemSeq schemReq = loadout.requirements();
            ItemSeq fromItems = from.items();
            if(!fromItems.has(schemReq)) return;

            ItemSeq resources = new ItemSeq();
            int cap = (int)(Planets.serpulo.launchCapacityMultiplier * loadout.findCore().itemCapacity);

            if(!target.allowLaunchLoadout()){
                if(target.preset != null && target.preset.generator != null && target.preset.generator.map != null){
                    var rules = target.preset.generator.map.rules();
                    for(ItemStack stack : rules.loadout){
                        if(stack.item.isOnPlanet(Planets.serpulo)){
                            resources.add(stack.item, stack.amount);
                        }
                    }
                }
            }else{
                for(Item item : Vars.content.items()){
                    if(!item.isOnPlanet(Planets.serpulo)) continue;
                    int spare = fromItems.get(item) - schemReq.get(item) - 80;
                    int take = Mathf.clamp(spare, 0, cap);
                    if(take > 0) resources.set(item, take);
                }
            }

            Vars.universe.updateLoadout(coreBlock, loadout);
            Vars.universe.updateLaunchResources(resources);
            from.removeItems(schemReq);
            from.removeItems(resources);
            Events.fire(new SectorLaunchLoadoutEvent(target, from, loadout));
            Vars.control.playSector(from, target);
        });
    }

    private CoreBlock chooseLaunchCore(Sector from, Sector destination){
        CoreBlock def = (CoreBlock)Planets.serpulo.defaultCore;
        if(!destination.allowLaunchSchematics()) return def;
        ItemSeq items = from.items();
        if(Blocks.coreNucleus instanceof CoreBlock nuc && nuc.unlockedNow()
                && Loadouts.basicNucleus != null && items.has(Loadouts.basicNucleus.requirements())){
            return nuc;
        }
        if(Blocks.coreFoundation instanceof CoreBlock fnd && fnd.unlockedNow()
                && Loadouts.basicFoundation != null && items.has(Loadouts.basicFoundation.requirements())){
            return fnd;
        }
        return def;
    }

    // --------------------------------------------------- integer helper buffer

    private static final class IntSeq{
        int[] data = new int[4];
        int size = 0;

        void add(int v){
            if(size == data.length){
                int[] next = new int[data.length * 2];
                System.arraycopy(data, 0, next, 0, size);
                data = next;
            }
            data[size++] = v;
        }

        int[] toArray(){
            int[] out = new int[size];
            System.arraycopy(data, 0, out, 0, size);
            return out;
        }
    }
}
