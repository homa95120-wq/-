package campaignbot;

import static campaignbot.CampaignBotLogic.*;

/**
 * Pure-Java verification suite for {@link CampaignBotLogic} (no game runtime needed).
 * Executed in CI prior to {@code gradle jar}.
 */
public final class CampaignBotLogicCheck{

    private static int checks = 0;

    private static void check(boolean cond, String msg){
        checks++;
        if(!cond) throw new AssertionError("FAILED check #" + checks + ": " + msg);
    }

    public static void main(String[] args){
        testStateMachine();
        testGuards();
        testResearchRanking();
        testSectorChoiceAndHold();
        testDrillRouting();
        testHubCrafterAndUnitChainGeometry();
        testFortressAndSquadAndWaves();
        System.out.println("CampaignBotLogicCheck OK: " + checks + " checks passed.");
    }

    private static void testStateMachine(){
        check(transition(OFF, CMD_START) == RUNNING, "OFF -> RUNNING");
        check(transition(RUNNING, CMD_PAUSE) == PAUSED, "RUNNING -> PAUSED");
        check(transition(PAUSED, CMD_START) == RUNNING, "PAUSED -> RUNNING");
        check(transition(RUNNING, CMD_FAIL) == NEEDS_HELP, "RUNNING -> NEEDS_HELP");
        check(transition(RUNNING, CMD_VICTORY) == VICTORY, "RUNNING -> VICTORY");
        check(transition(VICTORY, CMD_STOP) == OFF, "VICTORY -> OFF");
    }

    private static void testGuards(){
        Guard g = new Guard();
        g.inGame = false;
        g.netActive = false;
        check(guardReason(g) == null, "Planet map / menu allowed when offline");

        g.netActive = true;
        check(guardReason(g) != null, "Multiplayer rejected");

        g.netActive = false;
        g.inGame = true;
        g.campaign = true;
        g.planet = "serpulo";
        g.canBuild = true;
        check(guardReason(g) == null, "Serpulo campaign allowed");

        g.planet = "erekir";
        check(guardReason(g) != null, "Other planet rejected");
    }

    private static void testResearchRanking(){
        // Root (0, unlocked) -> Conveyor (1, locked) -> Junction (2, locked)
        // FrozenForest preset (3, locked, requires Research(Junction=2))
        // Decorative optional block (4, locked, parent=0)
        TechNodeInfo n0 = new TechNodeInfo();
        n0.index = 0; n0.name = "core-shard"; n0.unlocked = true;

        TechNodeInfo n1 = new TechNodeInfo();
        n1.index = 1; n1.name = "conveyor"; n1.parent = 0; n1.unlocked = false;
        n1.canAffordAny = true; n1.canFinishNow = true; n1.remainingCost = 5; n1.essentialTier = 3;

        TechNodeInfo n2 = new TechNodeInfo();
        n2.index = 2; n2.name = "junction"; n2.parent = 1; n2.unlocked = false;
        n2.canAffordAny = true; n2.canFinishNow = true; n2.remainingCost = 10; n2.essentialTier = 3;

        TechNodeInfo n3 = new TechNodeInfo();
        n3.index = 3; n3.name = "frozenForest"; n3.parent = 0; n3.unlocked = false;
        n3.isSectorPreset = true; n3.nonResearchObjectivesMet = true;
        n3.researchDeps = new int[]{2};

        TechNodeInfo n4 = new TechNodeInfo();
        n4.index = 4; n4.name = "illuminator"; n4.parent = 0; n4.unlocked = false;
        n4.canAffordAny = true; n4.canFinishNow = true; n4.remainingCost = 2; n4.essentialTier = 1;

        TechNodeInfo[] all = {n0, n1, n2, n3, n4};
        boolean[] crit = computeCriticalTechMask(all, -1);
        check(crit[1] && crit[2] && !crit[4], "Ancestor of sector research prerequisite marked critical");

        int[] ranked = rankResearchNodes(all, -1);
        check(ranked.length == 2 && ranked[0] == 1 && ranked[1] == 4, "Critical conveyor ranked before optional illuminator, locked-parent junction excluded");
    }

    private static void testSectorChoiceAndHold(){
        SectorCandidate sEasy = new SectorCandidate();
        sEasy.id = 86; sEasy.isPreset = true; sEasy.onVictoryPath = true;
        sEasy.unlocked = true; sEasy.canLaunchNow = true; sEasy.difficulty = 2f;

        SectorCandidate sHard = new SectorCandidate();
        sHard.id = 227; sHard.isPreset = true; sHard.onVictoryPath = true;
        sHard.unlocked = true; sHard.canLaunchNow = true; sHard.difficulty = 7f;

        SectorCandidate sInvaded = new SectorCandidate();
        sInvaded.id = 15; sInvaded.isPreset = true; sInvaded.hasBase = true;
        sInvaded.underAttack = true; sInvaded.difficulty = 1f;

        check(chooseNextSector(new SectorCandidate[]{sHard, sEasy}) == 1, "Lower difficulty preset chosen first");
        check(chooseNextSector(new SectorCandidate[]{sHard, sEasy, sInvaded}) == 2, "Invaded preset defended first");

        check(shouldHoldCapturedSector(false, true, false, false, 0.3f, 20f), "Hold when no base can afford launch core yet");
        check(!shouldHoldCapturedSector(true, true, false, true, 0.3f, 20f), "Never hold when another base is under attack");
        check(!shouldHoldCapturedSector(false, true, true, true, 0.92f, 20f), "Release hold when core is full");
    }

    private static void testDrillRouting(){
        int w = 15, h = 15;
        int[] cells = new int[w * h];
        int[] ore = new int[w * h];
        for(int i = 0; i < ore.length; i++) ore[i] = -1;
        // 3x3 core at center (6..8, 6..8)
        for(int y = 6; y <= 8; y++){
            for(int x = 6; x <= 8; x++){
                cells[y * w + x] = CELL_CORE;
            }
        }
        // 2x2 ore patch at (2..3, 7..8)
        ore[7 * w + 2] = 0; ore[7 * w + 3] = 0;
        ore[8 * w + 2] = 0; ore[8 * w + 3] = 0;

        DrillSite site = findDrillSite(w, h, cells, ore, 0, 2, 20);
        check(site != null && site.oreCount == 4 && site.pathLength == 2, "Drill site and 2-tile conveyor path found");
    }

    private static void testHubCrafterAndUnitChainGeometry(){
        int w = 25, h = 25;
        int[] cells = new int[w * h];
        int[] ore = new int[w * h];
        for(int i = 0; i < ore.length; i++) ore[i] = -1;
        for(int y = 11; y <= 13; y++){
            for(int x = 11; x <= 13; x++){
                cells[y * w + x] = CELL_CORE;
            }
        }
        HubCrafterSlot hub = findHubCrafterSlot(w, h, cells, ore, 2, true, 2);
        check(hub != null && hub.hasUnloader && hub.hasSupport, "Core-hub crafter + unloader + 2x2 support fits cleanly");

        UnitChainSlot chain = findUnitChainSlot(w, h, cells, 12, 12, true, true, true);
        check(chain != null && chain.hasUnloader && chain.hasAdditive && chain.hasMultiplicative,
                "3x3 factory -> 3x3 additive -> 5x5 multiplicative chain fits near core");
    }

    private static void testFortressAndSquadAndWaves(){
        int[] fort = buildFortressTemplate(50, 50, 1f, 0f);
        check(fort.length == 16 * 3, "16-slot fortress template generated");

        int mode1 = decideSquadMode(true, SQUAD_RALLY, 4, 24, 0, 4f);
        check(mode1 == SQUAD_RALLY, "Small squad rallies first");
        int mode2 = decideSquadMode(true, SQUAD_RALLY, 12, 24, 0, 4f);
        check(mode2 == SQUAD_ASSAULT, "Full squad launches assault");
        int mode3 = decideSquadMode(true, SQUAD_ASSAULT, 6, 24, 0, 4f);
        check(mode3 == SQUAD_ASSAULT, "Assault continues above retreat threshold");
        int mode4 = decideSquadMode(true, SQUAD_ASSAULT, 2, 24, 0, 4f);
        check(mode4 == SQUAD_RALLY, "Depleted squad regroups at rally");

        SectorObservation obs = new SectorObservation();
        obs.waves = true;
        obs.waveSending = true;
        obs.waveTimer = false;
        obs.wave = 3;
        obs.winWave = 10;
        obs.defenseDps = 180f;
        obs.defensePoolHp = 1800f;
        obs.nextWaveHp = 400f;
        obs.nextWaveDps = 35f;
        obs.drills = 8;
        Decision dec = decideSector(obs);
        check(dec.action == ACT_CALL_WAVE, "Calls next wave when defense dominates");
    }
}
