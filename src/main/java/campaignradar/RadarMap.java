package campaignradar;

import arc.graphics.Color;
import arc.graphics.g2d.Draw;
import arc.graphics.g2d.Fill;
import arc.graphics.g2d.Lines;
import arc.scene.Element;
import arc.scene.event.Touchable;
import arc.struct.Seq;

/**
 * A small tactical view of the <b>whole map</b>.
 * <p>
 * The world rectangle is fitted into the square HUD element while preserving
 * its aspect ratio (letterboxed, never stretched), so every player core, wave
 * spawn point, enemy and weak defence sector is visible at once. Enemies that
 * are briefly outside the world bounds (air units spawn in a small margin) are
 * clamped to the nearest map edge instead of disappearing.
 */
public class RadarMap extends Element{
    /** Enemy units. */
    public Seq<CampaignThreatRadar.Blip> blips = new Seq<>();
    /** Player cores. */
    public Seq<CampaignThreatRadar.Blip> cores = new Seq<>();
    /** Wave spawn points. */
    public Seq<CampaignThreatRadar.PointInfo> spawns = new Seq<>();
    /** Places where the defence should be improved. */
    public Seq<CampaignThreatRadar.WeakPoint> weakPoints = new Seq<>();

    /** Size of the displayed world (or fallback bounding box) in world units. */
    public float mapWidth = 1920f, mapHeight = 1920f;
    /** World coordinates of the lower-left corner of the displayed area. */
    public float mapOffsetX, mapOffsetY;

    /** Position of the player in world units. */
    public float playerX, playerY;
    public boolean hasPlayer;
    /** Closest threat and the core it approaches, in world units. */
    public float threatX, threatY, threatCoreX, threatCoreY;
    public boolean hasThreat;

    private static final Color colorGround = new Color(1f, 0.36f, 0.3f, 1f);
    private static final Color colorFlying = new Color(1f, 0.7f, 0.2f, 1f);
    private static final Color colorBoss = new Color(1f, 0.13f, 0.13f, 1f);
    private static final Color colorCore = new Color(0.35f, 0.65f, 1f, 1f);
    private static final Color colorWeakest = new Color(1f, 0.85f, 0.25f, 1f);
    private static final Color colorCriticalCore = new Color(1f, 0.25f, 0.2f, 1f);
    private static final Color colorMarker = new Color(1f, 0.85f, 0.2f, 1f);
    private static final Color colorMarkerSevere = new Color(1f, 0.45f, 0.15f, 1f);
    private static final Color colorSpawn = new Color(1f, 0.25f, 0.25f, 0.85f);

    public RadarMap(){
        // The radar must never eat clicks meant for the game.
        touchable = Touchable.disabled;
    }

    /** Removes every marker from the radar. */
    public void clear(){
        blips.clear();
        cores.clear();
        spawns.clear();
        weakPoints.clear();
        hasPlayer = false;
        hasThreat = false;
    }

    private float projectX(float worldX, float originX, float scale){
        float local = Math.max(0f, Math.min(Math.max(1f, mapWidth), worldX - mapOffsetX));
        return originX + local * scale;
    }

    private float projectY(float worldY, float originY, float scale){
        float local = Math.max(0f, Math.min(Math.max(1f, mapHeight), worldY - mapOffsetY));
        return originY + local * scale;
    }

    @Override
    public void draw(){
        super.draw();

        float w = getWidth();
        float h = getHeight();
        if(w <= 0f || h <= 0f) return;

        float padding = 4f;
        float safeMapW = Math.max(1f, mapWidth);
        float safeMapH = Math.max(1f, mapHeight);
        float scale = Math.min(Math.max(1f, w - padding * 2f) / safeMapW,
                Math.max(1f, h - padding * 2f) / safeMapH);
        float viewW = safeMapW * scale;
        float viewH = safeMapH * scale;
        float mapX = x + (w - viewW) / 2f;
        float mapY = y + (h - viewH) / 2f;

        // Letterbox and map background.
        Draw.color(0.015f, 0.025f, 0.045f, 0.92f);
        Fill.rect(x, y, w, h);
        Draw.color(0.05f, 0.08f, 0.12f, 0.95f);
        Fill.rect(mapX, mapY, viewW, viewH);

        // Quarter grid helps compare this abstract map with the vanilla minimap.
        Draw.color(0.35f, 0.5f, 0.65f, 0.18f);
        Lines.stroke(1f);
        for(int i = 1; i <= 3; i++){
            float gx = mapX + viewW * i / 4f;
            float gy = mapY + viewH * i / 4f;
            Lines.line(gx, mapY, gx, mapY + viewH);
            Lines.line(mapX, gy, mapX + viewW, gy);
        }

        // Frame of the element and the actual world boundary inside it.
        Draw.color(0.45f, 0.6f, 0.8f, 0.55f);
        Lines.stroke(1.5f);
        Lines.rect(x, y, w, h);
        Draw.color(0.55f, 0.75f, 1f, 0.8f);
        Lines.stroke(1.2f);
        Lines.rect(mapX, mapY, viewW, viewH);

        // Wave spawn points: small hollow red squares.
        Draw.color(colorSpawn);
        Lines.stroke(1.2f);
        for(CampaignThreatRadar.PointInfo spawn : spawns){
            float px = projectX(spawn.x, mapX, scale);
            float py = projectY(spawn.y, mapY, scale);
            Lines.rect(px - 3f, py - 3f, 6f, 6f);
        }

        // Places where the defence should be improved (also listed in the text).
        for(CampaignThreatRadar.WeakPoint marker : weakPoints){
            float px = projectX(marker.x, mapX, scale);
            float py = projectY(marker.y, mapY, scale);
            Draw.color(marker.severity >= 0.65f ? colorMarkerSevere : colorMarker);
            Lines.stroke(1.6f);
            Lines.circle(px, py, 7f);
            Lines.line(px - 4f, py, px + 4f, py);
            Lines.line(px, py - 4f, px, py + 4f);
        }

        // The closest threat and the core it is approaching.
        if(hasThreat){
            float fromX = projectX(threatCoreX, mapX, scale);
            float fromY = projectY(threatCoreY, mapY, scale);
            float toX = projectX(threatX, mapX, scale);
            float toY = projectY(threatY, mapY, scale);
            Draw.color(1f, 0.4f, 0.3f, 0.65f);
            Lines.stroke(1f);
            Lines.dashLine(fromX, fromY, toX, toY, 12);
        }

        // Every player core in the world, with the weakest one ringed.
        for(CampaignThreatRadar.Blip core : cores){
            float px = projectX(core.x, mapX, scale);
            float py = projectY(core.y, mapY, scale);
            if(core.weakest){
                Draw.color(core.healthFrac <= 0.35f ? colorCriticalCore : colorWeakest);
                Lines.stroke(1.4f);
                Lines.circle(px, py, 7.5f);
            }
            Draw.color(colorCore);
            Fill.rect(px - 3.5f, py - 3.5f, 7f, 7f);
            Draw.color(Color.white);
            Fill.rect(px - 1.25f, py - 1.25f, 2.5f, 2.5f);
        }

        // Enemy units, clamped to the map edge when briefly outside it.
        for(CampaignThreatRadar.Blip blip : blips){
            float px = projectX(blip.x, mapX, scale);
            float py = projectY(blip.y, mapY, scale);
            Color color = blip.kind == CampaignThreatRadar.KIND_BOSS ? colorBoss
                    : (blip.kind == CampaignThreatRadar.KIND_FLYING ? colorFlying : colorGround);
            Draw.color(color);
            Fill.circle(px, py, blip.kind == CampaignThreatRadar.KIND_BOSS ? 3.5f : 2.1f);
            if(blip.kind == CampaignThreatRadar.KIND_BOSS){
                Draw.color(color.r, color.g, color.b, 0.55f);
                Lines.stroke(1f);
                Lines.circle(px, py, 6f);
            }
        }

        // The player himself, drawn last so it remains visible on a busy map.
        if(hasPlayer){
            float px = projectX(playerX, mapX, scale);
            float py = projectY(playerY, mapY, scale);
            Draw.color(0f, 0f, 0f, 0.75f);
            Fill.circle(px, py, 3.4f);
            Draw.color(Color.white);
            Fill.circle(px, py, 2.5f);
        }
    }
}
