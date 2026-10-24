#ifndef COMBAT_H
#define COMBAT_H

#include "sim_types.h"

/* ============================================================================
 * combat.h — боевая система (ESP32-S3)
 *
 * Турели стреляют снарядами по ближайшему вражескому юниту в радиусе.
 * Снаряды летят линейно со скоростью, наносят урон при попадании.
 * Юниты имеют HP и могут атаковать/buildings при контакте.
 * ============================================================================ */

typedef enum {
    PROJ_NONE   = 0,
    PROJ_BULLET = 1,   /* пуля (быстрая, маленький урон)     */
    PROJ_SHELL  = 2,   /* снаряд (медленный, большой урон)   */
    PROJ_LASER  = 3,   /* лазер (мгновенный hit-scan)        */
} proj_type_t;

typedef struct {
    bool            active;
    sim_projectile_id_t id;
    proj_type_t     type;
    sim_vec2_t      pos;      /* позиция в world units              */
    sim_vec2_t      vel;      /* скорость в world units / тик       */
    sim_vec2_t      target;   /* цель (для наведения)               */
    float           damage;   /* урон при попадании                 */
    float           range;    /* максимальная дальность               */
    float           travelled;/* пройденное расстояние                */
    bool            homing;   /* преследует ли цель                 */
    sim_unit_inst_id_t target_unit; /* id цели-юнита (если homing)  */
} projectile_t;

typedef struct {
    bool            active;
    sim_unit_inst_id_t id;
    sim_unit_id_t   type;     /* тип юнита (из таблицы контента)    */
    sim_vec2_t      pos;
    sim_vec2_t      vel;
    float           hp;       /* текущие очки прочности             */
    float           max_hp;
    float           dps;      /* урон в секунду при контакте        */
    float           range;    /* радиус атаки                       */
    bool            flying;   /* летающий (игнорирует стены)        */
    bool            enemy;    /* враг (true) или свой (false)       */
    sim_tile_pos_t  target_tile; /* цель для перемещения            */
    bool            has_path;
} unit_instance_t;

typedef struct {
    projectile_t    projs[SIM_MAX_PROJECTILES];
    unit_instance_t units[SIM_MAX_UNITS];
    uint32_t        proj_count;
    uint32_t        unit_count;
} combat_world_t;

/* Инициализация мира боя */
void combat_world_init(combat_world_t *cw);

/* Создать снаряд (вызывается турелью) */
sim_projectile_id_t combat_spawn_projectile(combat_world_t *cw, proj_type_t type,
                                            float sx, float sy, float tx, float ty,
                                            float damage, float speed, float range);

/* Создать юнита */
sim_unit_inst_id_t combat_spawn_unit(combat_world_t *cw, sim_unit_id_t type,
                                     float x, float y, float hp, float dps,
                                     float range, bool flying, bool enemy);

/* Один тик боя: движение снарядов, попадания, урон, движение юнитов */
void combat_tick(combat_world_t *cw, float dt_seconds);

/* Проверить, попадает ли тайл/позиция под урон взрыва (опционально) */
bool combat_hit_point(combat_world_t *cw, float x, float y, float radius, float damage,
                      bool damage_enemies, bool damage_allies);

#endif /* COMBAT_H */
