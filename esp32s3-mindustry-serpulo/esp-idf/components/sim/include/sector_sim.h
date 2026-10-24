#ifndef SECTOR_SIM_H
#define SECTOR_SIM_H

#include "sim_types.h"
#include "conveyor.h"
#include "fluid_network.h"
#include "power_network.h"
#include "pathfinding.h"
#include "combat.h"

/* ============================================================================
 * sector_sim.h — активный сектор: собирает все подсистемы в один тик.
 * ============================================================================ */

typedef struct {
    sim_tile_type_t tiles[SIM_MAX_WIDTH * SIM_MAX_HEIGHT];
    bool            has_building[SIM_MAX_WIDTH * SIM_MAX_HEIGHT];
    sim_block_id_t  building_type[SIM_MAX_WIDTH * SIM_MAX_HEIGHT];
    sim_item_stack_t building_items[SIM_MAX_WIDTH * SIM_MAX_HEIGHT]; /* инвентарь здания */
} sim_map_t;

typedef struct {
    sim_map_t       map;
    sim_state_t     state;
    conv_network_t  conveyors;
    fluid_network_t fluids;
    power_network_t power;
    combat_world_t  combat;
} sim_sector_t;

/* Создать новый сектор с пустой картой */
void sim_sector_init(sim_sector_t *s);

/* Поставить здание на тайл */
bool sim_sector_place_building(sim_sector_t *s, int16_t x, int16_t y,
                               sim_block_id_t block_id);

/* Убрать здание */
void sim_sector_remove_building(sim_sector_t *s, int16_t x, int16_t y);

/* Один тик всей симуляции сектора */
void sim_sector_tick(sim_sector_t *s, float dt_seconds);

/* Получить тип тайла */
sim_tile_type_t sim_sector_tile(const sim_sector_t *s, int16_t x, int16_t y);

/* Проверить проходимость для A* ( колбэк pathfinding) */
bool sim_sector_walkable(int16_t x, int16_t y, sim_tile_type_t tile_type,
                         bool has_building, void *ctx);

#endif /* SECTOR_SIM_H */
