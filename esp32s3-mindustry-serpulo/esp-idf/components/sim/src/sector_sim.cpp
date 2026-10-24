#include "sector_sim.h"
#include "esp_log.h"
#include <string.h>

static const char *TAG = "sector_sim";

static inline size_t ti(int16_t x, int16_t y) {
    return (size_t)y * SIM_MAX_WIDTH + (size_t)x;
}
static inline bool inb(int16_t x, int16_t y) {
    return x >= 0 && x < SIM_MAX_WIDTH && y >= 0 && y < SIM_MAX_HEIGHT;
}

void sim_sector_init(sim_sector_t *s) {
    if (!s) return;
    memset(s, 0, sizeof(*s));

    /* Карта: всё пусто (full floor) */
    for (int16_t y = 0; y < SIM_MAX_HEIGHT; y++) {
        for (int16_t x = 0; x < SIM_MAX_WIDTH; x++) {
            s->map.tiles[ti(x, y)] = SIM_TILE_FLOOR;
        }
    }

    conv_network_init(&s->conveyors);
    fluid_network_init(&s->fluids);
    power_network_init(&s->power);
    combat_world_init(&s->combat);

    s->state.tick = 0;
    s->state.wave = 1;
    s->state.wave_time_left = 30.0f;
    s->state.wave_active = false;
    s->state.game_over = false;
    s->state.sector_captured = false;

    ESP_LOGI(TAG, "sector initialized");
}

bool sim_sector_place_building(sim_sector_t *s, int16_t x, int16_t y,
                               sim_block_id_t block_id) {
    if (!s || !inb(x, y)) return false;
    if (s->map.has_building[ti(x, y)]) return false;
    s->map.has_building[ti(x, y)] = true;
    s->map.building_type[ti(x, y)] = block_id;
    s->map.building_items[ti(x, y)].item = 0;
    s->map.building_items[ti(x, y)].amount = 0;
    return true;
}

void sim_sector_remove_building(sim_sector_t *s, int16_t x, int16_t y) {
    if (!s || !inb(x, y)) return;
    s->map.has_building[ti(x, y)] = false;
    s->map.building_type[ti(x, y)] = 0;
    s->map.building_items[ti(x, y)].item = 0;
    s->map.building_items[ti(x, y)].amount = 0;
}

void sim_sector_tick(sim_sector_t *s, float dt_seconds) {
    if (!s) return;
    s->state.tick++;

    /* 1. Электричество — считает баланс и дефицит */
    power_tick(&s->power);

    /* 2. Конвейеры —移动 предметов */
    uint32_t items_out = 0;
    conv_tick(&s->conveyors, &items_out);

    /* 3. Жидкости — перетекание между трубами */
    fluid_tick(&s->fluids);

    /* 4. Бой — снаряды, урон,units */
    combat_tick(&s->combat, dt_seconds);

    /* 5. Волны (упрощённо) */
    if (s->state.wave_active) {
        s->state.wave_time_left -= dt_seconds;
        if (s->state.wave_time_left <= 0.0f) {
            s->state.wave_time_left = 10.0f;
            s->state.wave++;
            ESP_LOGI(TAG, "wave %d started", s->state.wave);
        }
    } else {
        s->state.wave_time_left -= dt_seconds;
        if (s->state.wave_time_left <= 0.0f) {
            s->state.wave_active = true;
            s->state.wave_time_left = 30.0f;
            ESP_LOGI(TAG, "wave %d active", s->state.wave);
        }
    }
}

sim_tile_type_t sim_sector_tile(const sim_sector_t *s, int16_t x, int16_t y) {
    if (!s || !inb(x, y)) return SIM_TILE_WALL;
    return s->map.tiles[ti(x, y)];
}

bool sim_sector_walkable(int16_t x, int16_t y, sim_tile_type_t tile_type,
                         bool has_building, void *ctx) {
    (void)tile_type; (void)ctx;
    if (!inb(x, y)) return false;
    if (has_building) return false; /* здания блокируют проход */
    /* только FLOOR проходим */
    return tile_type == SIM_TILE_FLOOR;
}
