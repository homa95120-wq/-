#ifndef SIM_TYPES_H
#define SIM_TYPES_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

/* ============================================================================
 * sim_types.h — общие типы симуляции сектора Серпуло (ESP32-S3, ESP-IDF)
 * ============================================================================ */

/* Размер тайла в world units (как в Mindustry: 1 тайл = 8 единиц) */
#define SIM_TILE_SIZE 8

/* Максимальные размеры активного сектора в тайлах.
 * ESP32-S3 SRAM ограничена, поэтому сектор невелик. */
#define SIM_MAX_WIDTH  128
#define SIM_MAX_HEIGHT 128

/* Максимальное число объектов на активном секторе (подлежит замеру на плате) */
#define SIM_MAX_BUILDINGS 512
#define SIM_MAX_UNITS     256
#define SIM_MAX_PROJECTILES 512
#define SIM_MAX_CONVEYORS 1024
#define SIM_MAX_PIPES     1024

/* Специальные значения id */
#define SIM_ID_NONE 0xFFFFu

/* Контентные id (ссылки на таблицы во flash) */
typedef uint16_t sim_block_id_t;   /* тип здания       */
typedef uint16_t sim_unit_id_t;    /* тип юнита        */
typedef uint16_t sim_item_id_t;    /* тип предмета     */
typedef uint16_t sim_liquid_id_t;  /* тип жидкости     */

/* Идентификаторы экземпляров */
typedef uint16_t sim_building_id_t;
typedef uint16_t sim_unit_inst_id_t;
typedef uint16_t sim_projectile_id_t;

/* Тип тайла карты */
typedef enum {
    SIM_TILE_EMPTY   = 0,
    SIM_TILE_FLOOR   = 1,   /* проходимая поверхность       */
    SIM_TILE_WALL    = 2,   /* непроходимая стена           */
    SIM_TILE_WATER   = 3,   /* вода (только трубы/мост)     */
    SIM_TILE_LAVA    = 4,
    SIM_TILE_ORE     = 5,   /* руда под буром               */
} sim_tile_type_t;

/* Состояние симуляции */
typedef struct {
    uint32_t tick;              /* глобальный тик               */
    uint32_t wave;              /* текущая волна                */
    float    wave_time_left;    /* секунд до следующей волны    */
    bool     wave_active;       /* идёт ли волна сейчас         */
    bool     game_over;         /* ядро уничтожено              */
    bool     sector_captured;   /* сектор захвачен              */
} sim_state_t;

/* Предмет в инвентаре */
typedef struct {
    sim_item_id_t item;         /* тип предмета (0 = пусто)     */
    int32_t       amount;       /* количество                   */
} sim_item_stack_t;

/* Жидкость в баке/трубе */
typedef struct {
    sim_liquid_id_t liquid;     /* тип жидкости (0 = пусто)     */
    float           amount;     /* количество в единицах        */
} sim_liquid_stack_t;

/*-Weltkoordinat в тайлах */
typedef struct {
    int16_t x, y;
} sim_tile_pos_t;

/*-Weltkoordinat в world units (float) */
typedef struct {
    float x, y;
} sim_vec2_t;

#endif /* SIM_TYPES_H */
