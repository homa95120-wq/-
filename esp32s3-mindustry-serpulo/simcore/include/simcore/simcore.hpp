// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "simcore/fixed_q16.hpp"
#include "simcore/hash.hpp"
#include "simcore/prng.hpp"
#include "simcore/generated/blocks_table.hpp"
#include "simcore/generated/items_table.hpp"
#include "simcore/generated/liquids_table.hpp"
#include "simcore/generated/sectors_table.hpp"
#include "simcore/generated/trig_lut.hpp"
#include "simcore/generated/units_table.hpp"

#ifndef SIMCORE_MAX_MAP_DIM
#define SIMCORE_MAX_MAP_DIM 128
#endif

namespace simcore {

inline constexpr uint16_t kMaxMapDim       = static_cast<uint16_t>(SIMCORE_MAX_MAP_DIM);
inline constexpr size_t   kMaxMapTiles     = static_cast<size_t>(kMaxMapDim) * static_cast<size_t>(kMaxMapDim);
inline constexpr size_t   kMaxBuildings    = 1024u;
inline constexpr size_t   kMaxUnits        = 256u;
inline constexpr size_t   kMaxProjectiles  = 512u;
inline constexpr size_t   kMaxCommands     = 64u;
inline constexpr uint16_t kInvalidIndex    = 0xFFFFu;

// Направления в тайловой сетке: 0 = +X (Right), 1 = -Y (Up), 2 = -X (Left), 3 = +Y (Down)
inline constexpr int8_t kDirDx[4] = { 1,  0, -1, 0 };
inline constexpr int8_t kDirDy[4] = { 0, -1,  0, 1 };

enum class FloorType : uint8_t {
    DarkStone = 0u,
    Sand      = 1u,
    Moss      = 2u,
    Snow      = 3u,
    Basalt    = 4u,
    Tar       = 5u,
    Water     = 6u,
    DeepWater = 7u,
    Slag      = 8u,
};

enum class WallEnvType : uint8_t {
    None      = 0u,
    StoneWall = 1u,
    SporeWall = 2u,
    IceWall   = 3u,
    DuneWall  = 4u,
};

enum class TeamId : uint8_t {
    Sharded = 0u, // Игрок (жёлтый)
    Crux    = 1u, // Враг Серпуло (красный)
};

// Флаги состояния мира (SimHotState::flags)
inline constexpr uint8_t WORLD_FLAG_PAUSED          = 1u << 0;
inline constexpr uint8_t WORLD_FLAG_SANDBOX         = 1u << 1;
inline constexpr uint8_t WORLD_FLAG_GAME_OVER       = 1u << 2;
inline constexpr uint8_t WORLD_FLAG_SECTOR_CAPTURED = 1u << 3;
inline constexpr uint8_t WORLD_FLAG_FLOW_DIRTY      = 1u << 4;

enum class SimCmdType : uint8_t {
    None            = 0u,
    PlaceBlock      = 1u,
    RemoveBlock     = 2u,
    TriggerWave     = 3u,
    SetPaused       = 4u,
    SelectSector    = 5u,
    SetSandbox      = 6u,
    ConfigureBlock  = 7u,
};

struct SimCommand {
    SimCmdType type;
    uint8_t    rotation;
    uint8_t    team;
    uint8_t    arg8;
    int16_t    x;
    int16_t    y;
    uint16_t   param16;
    uint16_t   reserved;
};

// Компактное здание в SRAM (32 байта)
struct SimBuilding {
    uint16_t id;
    uint16_t block_id;
    int16_t  x;
    int16_t  y;
    int16_t  hp;
    int16_t  max_hp;
    uint8_t  rotation;
    uint8_t  team;
    uint8_t  active;
    uint8_t  config_item;
    uint8_t  item_id;
    uint8_t  item_count;
    uint8_t  aux_item_id;
    uint8_t  aux_item_count;
    uint8_t  liquid_id;
    uint8_t  rr_cursor;
    uint16_t liquid_q8;       // Количество жидкости (0..25600 = 0..100.0 ед.)
    uint16_t progress_ticks;  // Прогресс бурения/конвейера/крафта
    uint16_t cooldown_ticks;  // Перезарядка турели/генератора
    uint16_t link_target_id;  // Ссылка моста или индекс энергосети
    uint16_t aim_bam10;       // Угол ствола турели (0..1023)
};

// Компактный юнит в SRAM (32 байта)
struct SimUnit {
    uint16_t id;
    uint8_t  unit_type;
    uint8_t  team;
    uint8_t  active;
    uint8_t  flying;
    int16_t  hp;
    int16_t  max_hp;
    uint16_t cooldown_ticks;
    fx32_t   x_q16;           // Позиция в тайлах (Q16.16)
    fx32_t   y_q16;
    fx32_t   vx_q16;
    fx32_t   vy_q16;
    uint16_t angle_bam10;
    uint16_t target_bld_id;
};

// Компактный снаряд в SRAM (28 байт)
struct SimProjectile {
    uint16_t id;
    uint8_t  team;
    uint8_t  active;
    uint8_t  splash_radius_tiles;
    uint8_t  pierce_left;
    uint8_t  style;           // 0=bullet, 1=artillery, 2=laser, 3=flame, 4=arc
    uint8_t  hit_air;
    fx32_t   x_q16;
    fx32_t   y_q16;
    fx32_t   vx_q16;
    fx32_t   vy_q16;
    int16_t  damage;
    uint16_t ttl_ticks;
};

// Горячее состояние симуляции — живёт во внутренней SRAM ESP32-S3 (~58 КБ)
struct SimHotState {
    uint32_t       tick;
    uint16_t       sector_preset_id;
    uint16_t       wave;
    uint16_t       win_wave;
    uint8_t        flags;
    uint8_t        cmd_count;
    uint32_t       wave_countdown_ticks;
    int16_t        core_x;
    int16_t        core_y;
    int16_t        spawn_x;
    int16_t        spawn_y;
    uint16_t       active_buildings;
    uint16_t       active_units;
    uint16_t       active_projectiles;
    uint16_t       enemy_units;

    Xorshift64Star rng;

    int32_t        core_items[kItemCount];

    fx32_t         power_produced_q16;
    fx32_t         power_consumed_q16;
    fx32_t         power_satisfaction_q16;
    int32_t        power_stored_units;
    int32_t        power_capacity_units;

    SimCommand     cmd_queue[kMaxCommands];
    SimBuilding    buildings[kMaxBuildings];
    SimUnit        units[kMaxUnits];
    SimProjectile  projectiles[kMaxProjectiles];
    uint16_t       unit_grid_head[256];       // Пространственная сетка 16x16 (по 8x8 тайлов) в SRAM
    uint16_t       unit_grid_next[kMaxUnits]; // Односвязный список юнитов внутри ячейки
};

// Статическое хранилище карты и индекса — живёт в Octal PSRAM ESP32-S3 (~144 КБ)
struct SimMapStorage {
    uint16_t width;
    uint16_t height;
    uint8_t  floor[kMaxMapTiles];
    uint8_t  ore[kMaxMapTiles];          // 0xFF = нет руды, иначе ItemId
    uint8_t  wall[kMaxMapTiles];         // WallEnvType
    uint16_t building_at[kMaxMapTiles];  // Индекс в buildings[] или kInvalidIndex
    uint16_t flow_dist[kMaxMapTiles];    // BFS-поле расстояний к ядру для юнитов
    uint16_t bfs_queue[kMaxMapTiles];    // Кольцевой буфер BFS без нагрузки на стек
};

struct SimWorld {
    SimHotState*   hot;
    SimMapStorage* map;
};

// Эталонные (golden) хеши для самопроверки детерминизма x86-64 / ARM64 / ESP32-S3
struct SimGoldenHashes {
    uint64_t empty128_tick0_fnv64;
    uint32_t empty128_tick0_crc32;
    uint64_t m0_tick60_fnv64;
    uint32_t m0_tick60_crc32;
    uint64_t m0_tick600_fnv64;
    uint32_t m0_tick600_crc32;
};

inline constexpr SimGoldenHashes kGoldenHashes = {
    0x80F18980BF80ADBEULL,
    0x5F00343Eu,
    0xCF13DADCA7610D89ULL,
    0x635F4F00u,
    0x4979BCAF8D29E303ULL,
    0x818A445Eu
};

// Инициализация и генерация мира
void sim_init_empty(SimWorld& w, uint16_t width, uint16_t height, uint64_t seed = kDefaultPrngSeed) noexcept;
void sim_generate_sector(SimWorld& w, uint16_t sector_preset_id, uint64_t extra_seed = 0u) noexcept;
void sim_setup_m0_golden_scenario(SimWorld& w) noexcept;
void sim_setup_esp_stress_benchmark(SimWorld& w) noexcept;

// Команды и строительные операции
bool sim_push_command(SimWorld& w, const SimCommand& cmd) noexcept;
bool sim_can_place_block(const SimWorld& w, int16_t x, int16_t y, uint16_t block_id, uint8_t team) noexcept;
int32_t sim_place_block(SimWorld& w, int16_t x, int16_t y, uint16_t block_id, uint8_t rotation,
                        uint8_t team, bool pay_cost) noexcept;
bool sim_remove_block(SimWorld& w, int16_t x, int16_t y, bool refund_half) noexcept;
int32_t sim_spawn_unit(SimWorld& w, uint8_t unit_type, uint8_t team, fx32_t x_q16, fx32_t y_q16) noexcept;
int32_t sim_spawn_projectile(SimWorld& w, uint8_t team, fx32_t x_q16, fx32_t y_q16,
                             fx32_t vx_q16, fx32_t vy_q16, int16_t damage, uint16_t ttl_ticks,
                             uint8_t splash_tiles = 0u, uint8_t style = 0u, uint8_t hit_air = 1u) noexcept;
void sim_trigger_next_wave(SimWorld& w) noexcept;
void sim_rebuild_flow_field(SimWorld& w) noexcept;

// Основной детерминированный тик (60 Гц на ПК, 30 Гц × 2 подшага или 30 Гц на ESP32-S3)
void sim_step_tick(SimWorld& w) noexcept;
void sim_step_ticks(SimWorld& w, uint32_t count) noexcept;

// Каноническое little-endian хеширование состояния мира
uint64_t sim_state_hash_fnv1a64(const SimWorld& w) noexcept;
uint32_t sim_state_crc32(const SimWorld& w) noexcept;

// Встроенный selftest (возвращает true при полном совпадении golden-хешей)
bool sim_run_golden_selftest(SimWorld& scratch_world) noexcept;

} // namespace simcore
