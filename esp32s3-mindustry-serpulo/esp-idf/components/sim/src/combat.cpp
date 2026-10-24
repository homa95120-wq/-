#include "combat.h"
#include "esp_log.h"
#include <string.h>
#include <math.h>

static const char *TAG = "combat";

static inline float dist2(float x1, float y1, float x2, float y2) {
    float dx = x1 - x2, dy = y1 - y2;
    return dx*dx + dy*dy;
}
static inline float dist(float x1, float y1, float x2, float y2) {
    return sqrtf(dist2(x1, y1, x2, y2));
}

void combat_world_init(combat_world_t *cw) {
    if (!cw) return;
    memset(cw->projs, 0, sizeof(cw->projs));
    memset(cw->units, 0, sizeof(cw->units));
    cw->proj_count = 0;
    cw->unit_count = 0;
}

sim_projectile_id_t combat_spawn_projectile(combat_world_t *cw, proj_type_t type,
                                            float sx, float sy, float tx, float ty,
                                            float damage, float speed, float range) {
    if (!cw) return SIM_ID_NONE;
    /* ищем свободный слот */
    uint32_t slot = SIM_ID_NONE;
    for (uint32_t i = 0; i < SIM_MAX_PROJECTILES; i++) {
        if (!cw->projs[i].active) { slot = i; break; }
    }
    if (slot == SIM_ID_NONE) return SIM_ID_NONE; /* нет мест для снарядов */

    projectile_t *p = &cw->projs[slot];
    p->active = true;
    p->id = slot + 1;
    p->type = type;
    p->pos.x = sx; p->pos.y = sy;
    p->target.x = tx; p->target.y = ty;
    p->damage = damage;
    p->range = range;
    p->travelled = 0.0f;
    p->homing = (type == PROJ_SHELL);

    float dx = tx - sx, dy = ty - sy;
    float d = sqrtf(dx*dx + dy*dy);
    if (d > 0.001f) {
        p->vel.x = (dx / d) * speed;
        p->vel.y = (dy / d) * speed;
    } else {
        p->vel.x = 0; p->vel.y = 0;
    }
    p->target_unit = SIM_ID_NONE;

    cw->proj_count++;
    return p->id;
}

sim_unit_inst_id_t combat_spawn_unit(combat_world_t *cw, sim_unit_id_t type,
                                     float x, float y, float hp, float dps,
                                     float range, bool flying, bool enemy) {
    if (!cw) return SIM_ID_NONE;
    uint32_t slot = SIM_ID_NONE;
    for (uint32_t i = 0; i < SIM_MAX_UNITS; i++) {
        if (!cw->units[i].active) { slot = i; break; }
    }
    if (slot == SIM_ID_NONE) return SIM_ID_NONE;

    unit_instance_t *u = &cw->units[slot];
    u->active = true;
    u->id = slot + 1;
    u->type = type;
    u->pos.x = x; u->pos.y = y;
    u->vel.x = 0; u->vel.y = 0;
    u->hp = hp; u->max_hp = hp;
    u->dps = dps;
    u->range = range;
    u->flying = flying;
    u->enemy = enemy;
    u->target_tile.x = (int16_t)(x / SIM_TILE_SIZE);
    u->target_tile.y = (int16_t)(y / SIM_TILE_SIZE);
    u->has_path = false;

    cw->unit_count++;
    return u->id;
}

void combat_tick(combat_world_t *cw, float dt_seconds) {
    if (!cw || dt_seconds <= 0.0f) return;

    /* --- Снаряды: движение и попадания --- */
    for (uint32_t i = 0; i < SIM_MAX_PROJECTILES; i++) {
        projectile_t *p = &cw->projs[i];
        if (!p->active) continue;

        p->pos.x += p->vel.x * dt_seconds;
        p->pos.y += p->vel.y * dt_seconds;
        p->travelled += sqrtf(p->vel.x*p->vel.x + p->vel.y*p->vel.y) * dt_seconds;

        bool hit = false;
        sim_unit_inst_id_t hit_unit = SIM_ID_NONE;

        if (p->homing && p->target_unit != SIM_ID_NONE) {
            /* наведение на юнит */
            for (uint32_t j = 0; j < SIM_MAX_UNITS; j++) {
                unit_instance_t *u = &cw->units[j];
                if (!u->active || u->id != p->target_unit) continue;
                if (dist(p->pos.x, p->pos.y, u->pos.x, u->pos.y) < 12.0f) {
                    hit = true; hit_unit = u->id;
                }
                break;
            }
        } else {
            /* ищем ближайший вражеский юнит на пути */
            for (uint32_t j = 0; j < SIM_MAX_UNITS; j++) {
                unit_instance_t *u = &cw->units[j];
                if (!u->active || !u->enemy) continue;
                if (dist(p->pos.x, p->pos.y, u->pos.x, u->pos.y) < 14.0f) {
                    hit = true; hit_unit = u->id;
                    break;
                }
            }
        }

        /* сбой по дистанции */
        if (p->travelled > p->range) hit = true;

        if (hit) {
            /* наносим урон цели */
            if (hit_unit != SIM_ID_NONE) {
                for (uint32_t j = 0; j < SIM_MAX_UNITS; j++) {
                    unit_instance_t *u = &cw->units[j];
                    if (!u->active || u->id != hit_unit) continue;
                    u->hp -= p->damage;
                    ESP_LOGD(TAG, "unit %d hp=%.1f dmg=%.1f", u->id, u->hp, p->damage);
                    break;
                }
            }
            p->active = false;
            cw->proj_count--;
            continue;
        }
    }

    /* --- Юниты: убиваем мертвых --- */
    for (uint32_t i = 0; i < SIM_MAX_UNITS; i++) {
        unit_instance_t *u = &cw->units[i];
        if (!u->active) continue;
        if (u->hp <= 0.0f) {
            u->active = false;
            cw->unit_count--;
        }
    }
}

bool combat_hit_point(combat_world_t *cw, float x, float y, float radius, float damage,
                      bool damage_enemies, bool damage_allies) {
    if (!cw) return false;
    bool any = false;
    float r2 = radius * radius;
    for (uint32_t i = 0; i < SIM_MAX_UNITS; i++) {
        unit_instance_t *u = &cw->units[i];
        if (!u->active) continue;
        if (damage_enemies && !u->enemy) continue;
        if (damage_allies && u->enemy) continue;
        if (dist2(x, y, u->pos.x, u->pos.y) <= r2) {
            u->hp -= damage;
            any = true;
        }
    }
    return any;
}
