package campaignradar;

import arc.graphics.Color;
import arc.graphics.g2d.Draw;
import arc.graphics.g2d.Fill;
import arc.graphics.g2d.Lines;
import arc.math.Mathf;
import arc.scene.Element;
import arc.scene.event.Touchable;
import arc.struct.Seq;

/**
 * A small tactical mini map that shows every enemy unit around the player's core.
 * <p>
 * The radar is centered on the weakest core, so it always shows the place that is
 * about to be attacked. Units outside of the radar radius are drawn as arrows on
 * the border, pointing at the direction they come from.
 */
public class RadarMap extends Element{
    /** Enemy units. */
    public Seq<CampaignThreatRadar.Blip> blips = new Seq<>();
    /** Player cores. */
    public Seq<CampaignThreatRadar.Blip> cores = new Seq<>();
    /** Center of the radar in world units. */
    public float centerX, centerY;
    /** Radius of the radar in world units. */
    public float range = 960f;
    /** Position of the player in world units. */
    public float playerX, playerY;
    public boolean hasPlayer;
    /** Position of the closest threat in world units. */
    public float threatX, threatY;
    public boolean hasThreat;

    private static final Color colorGround = new Color(1f, 0.36f, 0.3f, 1f);
    private static final Color colorFlying = new Color(1f, 0.7f, 0.2f, 1f);
    private static final Color colorBoss = new Color(1f, 0.13f, 0.13f, 1f);
    private static final Color colorCore = new Color(0.35f, 0.65f, 1f, 1f);

    public RadarMap(){
        // The radar must never eat clicks meant for the game.
        touchable = Touchable.disabled;
    }

    /** Removes every marker from the radar. */
    public void clear(){
        blips.clear();
        cores.clear();
        hasPlayer = false;
        hasThreat = false;
    }

    @Override
    public void draw(){
        super.draw();

        float w = getWidth();
        float h = getHeight();
        if(w <= 0f || h <= 0f) return;

        float cx = x + w / 2f;
        float cy = y + h / 2f;
        float radius = Math.min(w, h) / 2f - 4f;
        float scale = radius / Math.max(range, 1f);

        // background
        Draw.color(0.04f, 0.06f, 0.1f, 0.85f);
        Fill.rect(x, y, w, h);

        // range rings and crosshair
        Draw.color(0.35f, 0.5f, 0.65f, 0.25f);
        Lines.stroke(1f);
        for(int i = 1; i <= 3; i++){
            Lines.circle(cx, cy, radius * i / 3f);
        }
        Lines.line(cx, y, cx, y + h);
        Lines.line(x, cy, x + w, cy);

        // frame
        Draw.color(0.45f, 0.6f, 0.8f, 0.55f);
        Lines.stroke(1.5f);
        Lines.rect(x, y, w, h);

        // direction of the closest threat
        if(hasThreat){
            float tx = cx + (threatX - centerX) * scale;
            float ty = cy + (threatY - centerY) * scale;
            float dx = tx - cx;
            float dy = ty - cy;
            float len = Mathf.dst(dx, dy);
            if(len > radius - 2f){
                float angle = Mathf.atan2(dy, dx);
                tx = cx + Mathf.cos(angle) * (radius - 2f);
                ty = cy + Mathf.sin(angle) * (radius - 2f);
            }
            Draw.color(1f, 0.4f, 0.3f, 0.6f);
            Lines.stroke(1f);
            Lines.dashLine(cx, cy, tx, ty, 12);
        }

        // player cores
        for(CampaignThreatRadar.Blip core : cores){
            float px = cx + (core.x - centerX) * scale;
            float py = cy + (core.y - centerY) * scale;
            Draw.color(colorCore);
            Fill.rect(px - 3f, py - 3f, 6f, 6f);
        }

        // the player himself
        if(hasPlayer){
            float px = cx + (playerX - centerX) * scale;
            float py = cy + (playerY - centerY) * scale;
            Draw.color(Color.white);
            Fill.circle(px, py, 2.5f);
        }

        // enemy units
        for(CampaignThreatRadar.Blip blip : blips){
            float dx = (blip.x - centerX) * scale;
            float dy = (blip.y - centerY) * scale;
            float dist = Mathf.dst(dx, dy);
            Color color = blip.kind == CampaignThreatRadar.KIND_BOSS ? colorBoss
                    : (blip.kind == CampaignThreatRadar.KIND_FLYING ? colorFlying : colorGround);

            if(dist > radius - 3f){
                // Outside of the radar: only the direction is shown.
                float angle = Mathf.atan2(dy, dx);
                float px = cx + Mathf.cos(angle) * (radius - 4f);
                float py = cy + Mathf.sin(angle) * (radius - 4f);
                float cos = Mathf.cos(angle);
                float sin = Mathf.sin(angle);
                Draw.color(color.r, color.g, color.b, 0.55f);
                Fill.tri(px + cos * 5f, py + sin * 5f,
                        px - cos * 3f + sin * 3f, py - sin * 3f - cos * 3f,
                        px - cos * 3f - sin * 3f, py - sin * 3f + cos * 3f);
            }else{
                float px = cx + dx;
                float py = cy + dy;
                Draw.color(color);
                Fill.circle(px, py, blip.kind == CampaignThreatRadar.KIND_BOSS ? 3.5f : 2f);
                if(blip.kind == CampaignThreatRadar.KIND_BOSS){
                    Draw.color(color.r, color.g, color.b, 0.5f);
                    Lines.stroke(1f);
                    Lines.circle(px, py, 6f);
                }
            }
        }
    }
}
