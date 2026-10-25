// SPDX-License-Identifier: GPL-3.0-or-later
#include "simcore/simcore.hpp"
#include "simcore/protocol.hpp"
#include "simcore/save_msv1.hpp"

#include <string.h>

namespace simcore {

namespace {

inline constexpr uint8_t kOreNone = 0xFFu;
inline constexpr uint8_t kItemEmpty = 0xFFu;

constexpr bool in_bounds(const SimMapStorage* m, int32_t x, int32_t y) noexcept {
    return x >= 0 && y >= 0 &&
           x < static_cast<int32_t>(m->width) &&
           y < static_cast<int32_t>(m->height);
}

constexpr size_t tile_idx(const SimMapStorage* m, int32_t x, int32_t y) noexcept {
    return static_cast<size_t>(y) * static_cast<size_t>(m->width) + static_cast<size_t>(x);
}

constexpr bool is_liquid_floor(uint8_t fl) noexcept {
    return fl == static_cast<uint8_t>(FloorType::Water) ||
           fl == static_cast<uint8_t>(FloorType::DeepWater) ||
           fl == static_cast<uint8_t>(FloorType::Slag) ||
           fl == static_cast<uint8_t>(FloorType::Tar);
}

constexpr bool is_deep_liquid(uint8_t fl) noexcept {
    return fl == static_cast<uint8_t>(FloorType::DeepWater);
}

// Детерминированный целочисленный 2D-шум (0..1023) для генератора секторов
constexpr uint32_t hash2d(int32_t x, int32_t y, uint32_t seed) noexcept {
    uint32_t h = seed ^ (static_cast<uint32_t>(x) * 374761393u) ^ (static_cast<uint32_t>(y) * 668265263u);
    h = (h ^ (h >> 13u)) * 1274126177u;
    return (h ^ (h >> 16u)) & 1023u;
}

uint32_t smooth_noise(int32_t x, int32_t y, int32_t scale, uint32_t seed) noexcept {
    const int32_t gx = x / scale;
    const int32_t gy = y / scale;
    const int32_t fx = ((x % scale) * 256) / scale;
    const int32_t fy = ((y % scale) * 256) / scale;

    const uint32_t v00 = hash2d(gx, gy, seed);
    const uint32_t v10 = hash2d(gx + 1, gy, seed);
    const uint32_t v01 = hash2d(gx, gy + 1, seed);
    const uint32_t v11 = hash2d(gx + 1, gy + 1, seed);

    const uint32_t vx0 = (v00 * static_cast<uint32_t>(256 - fx) + v10 * static_cast<uint32_t>(fx)) >> 8u;
    const uint32_t vx1 = (v01 * static_cast<uint32_t>(256 - fx) + v11 * static_cast<uint32_t>(fx)) >> 8u;
    return (vx0 * static_cast<uint32_t>(256 - fy) + vx1 * static_cast<uint32_t>(fy)) >> 8u;
}

void destroy_building_slot(SimWorld& w, uint16_t slot) noexcept {
    if (slot >= kMaxBuildings) return;
    SimBuilding& b = w.hot->buildings[slot];
    if (!b.active) return;

    const BlockDef& def = kBlocksTable[b.block_id];
    for (uint8_t dy = 0u; dy < def.size; ++dy) {
        for (uint8_t dx = 0u; dx < def.size; ++dx) {
            const int32_t tx = static_cast<int32_t>(b.x) + static_cast<int32_t>(dx);
            const int32_t ty = static_cast<int32_t>(b.y) + static_cast<int32_t>(dy);
            if (in_bounds(w.map, tx, ty)) {
                const size_t idx = tile_idx(w.map, tx, ty);
                if (w.map->building_at[idx] == slot) {
                    w.map->building_at[idx] = kInvalidIndex;
                }
            }
        }
    }

    if (def.role == BlockRole::CORE && b.team == static_cast<uint8_t>(TeamId::Sharded)) {
        w.hot->flags |= WORLD_FLAG_GAME_OVER;
    }

    b.active = 0u;
    b.hp = 0;
    if (w.hot->active_buildings > 0u) {
        --w.hot->active_buildings;
    }
    w.hot->flags |= WORLD_FLAG_FLOW_DIRTY;
}

// Может ли здание b принять 1 предмет item_id (и положить его к себе / в ядро)
bool try_accept_item(SimWorld& w, uint16_t dst_slot, uint8_t item_id, uint8_t from_dir) noexcept {
    if (dst_slot >= kMaxBuildings || item_id >= kItemCount) return false;
    SimBuilding& dst = w.hot->buildings[dst_slot];
    if (!dst.active) return false;

    const BlockDef& def = kBlocksTable[dst.block_id];
    switch (def.role) {
        case BlockRole::CORE:
        case BlockRole::STORAGE:
            if (dst.team == static_cast<uint8_t>(TeamId::Sharded)) {
                if (w.hot->core_items[item_id] < 999999) {
                    w.hot->core_items[item_id] += 1;
                }
                return true;
            }
            return false;

        case BlockRole::CONVEYOR: {
            if (def.id == static_cast<uint16_t>(BlockId::ArmoredConveyor)) {
                // Бронированный конвейер принимает сбоку только от конвейеров/роутеров, но здесь базово принимаем если пуст
                (void)from_dir;
            }
            if (dst.item_count == 0u) {
                dst.item_id = item_id;
                dst.item_count = 1u;
                dst.progress_ticks = 0u;
                return true;
            }
            return false;
        }

        case BlockRole::JUNCTION:
        case BlockRole::ROUTER:
        case BlockRole::SORTER:
        case BlockRole::OVERFLOW_GATE:
        case BlockRole::BRIDGE:
            if (dst.item_count < 4u && (dst.item_count == 0u || dst.item_id == item_id)) {
                dst.item_id = item_id;
                dst.item_count = static_cast<uint8_t>(dst.item_count + 1u);
                dst.aux_item_id = from_dir; // запоминаем направление входа для перекрёстка/затвора
                return true;
            }
            return false;

        case BlockRole::GEN_FUEL:
        case BlockRole::GEN_STEAM: {
            const bool match_specific = (def.in_a.item_id == item_id);
            const bool match_flammable = (def.id == static_cast<uint16_t>(BlockId::CombustionGenerator) ||
                                          def.id == static_cast<uint16_t>(BlockId::SteamGenerator)) &&
                                         (kItemsTable[item_id].flammability_q16 > 0);
            if ((match_specific || match_flammable) && dst.item_count < 10u &&
                (dst.item_count == 0u || dst.item_id == item_id)) {
                dst.item_id = item_id;
                dst.item_count = static_cast<uint8_t>(dst.item_count + 1u);
                return true;
            }
            return false;
        }

        case BlockRole::CRAFTER:
            if (def.in_a.item_id == item_id && dst.item_count < 10u) {
                dst.item_id = item_id;
                dst.item_count = static_cast<uint8_t>(dst.item_count + 1u);
                return true;
            }
            if (def.in_b.item_id == item_id && dst.aux_item_count < 10u) {
                dst.aux_item_id = item_id;
                dst.aux_item_count = static_cast<uint8_t>(dst.aux_item_count + 1u);
                return true;
            }
            return false;

        case BlockRole::TURRET_ITEM:
        case BlockRole::TURRET_AIR:
        case BlockRole::TURRET_ARTY:
            if ((def.in_a.item_id == item_id || def.in_b.item_id == item_id) &&
                dst.item_count < 20u &&
                (dst.item_count == 0u || dst.item_id == item_id)) {
                dst.item_id = item_id;
                dst.item_count = static_cast<uint8_t>(dst.item_count + 1u);
                return true;
            }
            return false;

        default:
            return false;
    }
}

// Вытолкнуть 1 предмет с периметра многотайлового здания (бура / завода) в соседнюю логистику
bool eject_item_around_footprint(SimWorld& w, SimBuilding& src, uint8_t item_id) noexcept {
    const BlockDef& def = kBlocksTable[src.block_id];
    const int32_t sz = static_cast<int32_t>(def.size);
    const int32_t perim = sz * 4;
    for (int32_t step = 0; step < perim; ++step) {
        const int32_t p = (static_cast<int32_t>(src.rr_cursor) + step) % perim;
        int32_t nx = src.x;
        int32_t ny = src.y;
        uint8_t dir = 0u;
        if (p < sz) {
            nx = src.x + sz;
            ny = src.y + p;
            dir = 0u;
        } else if (p < sz * 2) {
            nx = src.x + (p - sz);
            ny = src.y - 1;
            dir = 1u;
        } else if (p < sz * 3) {
            nx = src.x - 1;
            ny = src.y + (p - sz * 2);
            dir = 2u;
        } else {
            nx = src.x + (p - sz * 3);
            ny = src.y + sz;
            dir = 3u;
        }
        if (!in_bounds(w.map, nx, ny)) continue;
        const uint16_t dst_slot = w.map->building_at[tile_idx(w.map, nx, ny)];
        if (dst_slot != kInvalidIndex && dst_slot != src.id) {
            if (try_accept_item(w, dst_slot, item_id, dir)) {
                src.rr_cursor = static_cast<uint8_t>((p + 1) % perim);
                return true;
            }
        }
    }
    return false;
}

bool try_accept_liquid(SimWorld& w, uint16_t dst_slot, uint8_t liq_id, uint16_t amount_q8) noexcept {
    if (dst_slot >= kMaxBuildings || amount_q8 == 0u) return false;
    SimBuilding& dst = w.hot->buildings[dst_slot];
    if (!dst.active) return false;
    const BlockDef& def = kBlocksTable[dst.block_id];
    uint16_t cap_q8 = 0u;
    if (def.role == BlockRole::PIPE || def.role == BlockRole::LIQ_ROUT) {
        cap_q8 = (def.size >= 3u) ? 25600u : 2560u;
    } else if (def.role == BlockRole::DRILL || def.role == BlockRole::GEN_STEAM) {
        if (liq_id != static_cast<uint8_t>(LiquidId::Water) &&
            liq_id != static_cast<uint8_t>(LiquidId::Cryofluid)) {
            return false;
        }
        cap_q8 = 2560u;
    } else {
        return false;
    }

    if (dst.liquid_q8 > 0u && dst.liquid_id != liq_id) return false;
    if (dst.liquid_q8 >= cap_q8) return false;
    const uint16_t space = static_cast<uint16_t>(cap_q8 - dst.liquid_q8);
    const uint16_t take = (amount_q8 < space) ? amount_q8 : space;
    dst.liquid_id = liq_id;
    dst.liquid_q8 = static_cast<uint16_t>(dst.liquid_q8 + take);
    return take > 0u;
}

void update_bridge_links(SimWorld& w, uint16_t placed_slot) noexcept {
    SimBuilding& b = w.hot->buildings[placed_slot];
    if (kBlocksTable[b.block_id].role != BlockRole::BRIDGE) return;

    // 1) Мост может смотреть вперёд на другой мост в пределах 4 тайлов
    const int32_t dx = kDirDx[b.rotation & 3u];
    const int32_t dy = kDirDy[b.rotation & 3u];
    for (int32_t dist = 2; dist <= 4; ++dist) {
        const int32_t tx = static_cast<int32_t>(b.x) + dx * dist;
        const int32_t ty = static_cast<int32_t>(b.y) + dy * dist;
        if (!in_bounds(w.map, tx, ty)) break;
        const uint16_t dst = w.map->building_at[tile_idx(w.map, tx, ty)];
        if (dst != kInvalidIndex && kBlocksTable[w.hot->buildings[dst].block_id].role == BlockRole::BRIDGE) {
            b.link_target_id = dst;
            break;
        }
    }

    // 2) Обратный поиск: если ранее поставленный мост смотрел в нашу клетку
    for (uint8_t dir = 0u; dir < 4u; ++dir) {
        const int32_t rdx = -kDirDx[dir];
        const int32_t rdy = -kDirDy[dir];
        for (int32_t dist = 2; dist <= 4; ++dist) {
            const int32_t sx = static_cast<int32_t>(b.x) + rdx * dist;
            const int32_t sy = static_cast<int32_t>(b.y) + rdy * dist;
            if (!in_bounds(w.map, sx, sy)) break;
            const uint16_t src = w.map->building_at[tile_idx(w.map, sx, sy)];
            if (src != kInvalidIndex) {
                SimBuilding& sb = w.hot->buildings[src];
                if (kBlocksTable[sb.block_id].role == BlockRole::BRIDGE &&
                    (sb.rotation & 3u) == dir && sb.link_target_id == kInvalidIndex) {
                    sb.link_target_id = placed_slot;
                }
            }
        }
    }
}

} // namespace

void sim_init_empty(SimWorld& w, uint16_t width, uint16_t height, uint64_t seed) noexcept {
    if (!w.hot || !w.map) return;

    memset(w.hot, 0, sizeof(SimHotState));
    memset(w.map, 0, sizeof(SimMapStorage));

    const uint16_t cw = (width == 0u || width > kMaxMapDim) ? kMaxMapDim : width;
    const uint16_t ch = (height == 0u || height > kMaxMapDim) ? kMaxMapDim : height;
    w.map->width = cw;
    w.map->height = ch;

    w.hot->rng.reseed(seed);
    w.hot->wave = 1u;
    w.hot->win_wave = 10u;
    w.hot->wave_countdown_ticks = 60u * 30u;
    w.hot->power_satisfaction_q16 = kFxOne;
    w.hot->core_x = static_cast<int16_t>(cw / 2u);
    w.hot->core_y = static_cast<int16_t>(ch - 16u);
    w.hot->spawn_x = static_cast<int16_t>(cw / 2u);
    w.hot->spawn_y = 10;

    const size_t total = static_cast<size_t>(cw) * static_cast<size_t>(ch);
    for (size_t i = 0; i < total; ++i) {
        w.map->floor[i] = static_cast<uint8_t>(FloorType::DarkStone);
        w.map->ore[i] = kOreNone;
        w.map->wall[i] = static_cast<uint8_t>(WallEnvType::None);
        w.map->building_at[i] = kInvalidIndex;
        w.map->flow_dist[i] = 0xFFFEu;
    }

    for (size_t i = 0; i < kMaxBuildings; ++i) {
        w.hot->buildings[i].id = static_cast<uint16_t>(i);
        w.hot->buildings[i].item_id = kItemEmpty;
        w.hot->buildings[i].aux_item_id = kItemEmpty;
        w.hot->buildings[i].config_item = kItemEmpty;
        w.hot->buildings[i].liquid_id = static_cast<uint8_t>(LiquidId::None);
        w.hot->buildings[i].link_target_id = kInvalidIndex;
    }
    for (size_t i = 0; i < kMaxUnits; ++i) {
        w.hot->units[i].id = static_cast<uint16_t>(i);
        w.hot->units[i].target_bld_id = kInvalidIndex;
    }
    for (size_t i = 0; i < kMaxProjectiles; ++i) {
        w.hot->projectiles[i].id = static_cast<uint16_t>(i);
    }
}

void sim_rebuild_flow_field(SimWorld& w) noexcept {
    if (!w.hot || !w.map) return;
    const uint16_t mw = w.map->width;
    const uint16_t mh = w.map->height;
    const size_t total = static_cast<size_t>(mw) * static_cast<size_t>(mh);
    if (total == 0u || total > kMaxMapTiles) return;

    for (size_t i = 0; i < total; ++i) {
        w.map->flow_dist[i] = 0xFFFEu;
    }

    uint32_t q_head = 0u;
    uint32_t q_tail = 0u;

    // Источник притяжения — тайлы ядра игрока (или core_x, core_y если ядра нет)
    bool seeded = false;
    for (size_t i = 0; i < kMaxBuildings; ++i) {
        const SimBuilding& b = w.hot->buildings[i];
        if (b.active && b.team == static_cast<uint8_t>(TeamId::Sharded) &&
            kBlocksTable[b.block_id].role == BlockRole::CORE) {
            const uint8_t sz = kBlocksTable[b.block_id].size;
            for (uint8_t dy = 0u; dy < sz; ++dy) {
                for (uint8_t dx = 0u; dx < sz; ++dx) {
                    const int32_t tx = static_cast<int32_t>(b.x) + dx;
                    const int32_t ty = static_cast<int32_t>(b.y) + dy;
                    if (in_bounds(w.map, tx, ty)) {
                        const uint16_t idx = static_cast<uint16_t>(tile_idx(w.map, tx, ty));
                        w.map->flow_dist[idx] = 0u;
                        w.map->bfs_queue[q_tail % kMaxMapTiles] = idx;
                        ++q_tail;
                        seeded = true;
                    }
                }
            }
        }
    }

    if (!seeded && in_bounds(w.map, w.hot->core_x, w.hot->core_y)) {
        const uint16_t idx = static_cast<uint16_t>(tile_idx(w.map, w.hot->core_x, w.hot->core_y));
        w.map->flow_dist[idx] = 0u;
        w.map->bfs_queue[q_tail++] = idx;
    }

    while (q_head != q_tail) {
        const uint16_t cur = w.map->bfs_queue[q_head % kMaxMapTiles];
        ++q_head;

        const uint16_t cur_d = w.map->flow_dist[cur];
        const int32_t cx = static_cast<int32_t>(cur % mw);
        const int32_t cy = static_cast<int32_t>(cur / mw);

        for (uint8_t dir = 0u; dir < 4u; ++dir) {
            const int32_t nx = cx + kDirDx[dir];
            const int32_t ny = cy + kDirDy[dir];
            if (!in_bounds(w.map, nx, ny)) continue;
            const uint16_t nidx = static_cast<uint16_t>(tile_idx(w.map, nx, ny));
            if (w.map->wall[nidx] != static_cast<uint8_t>(WallEnvType::None)) continue;
            if (is_deep_liquid(w.map->floor[nidx])) continue;

            uint16_t step_cost = 1u;
            const uint16_t bslot = w.map->building_at[nidx];
            if (bslot != kInvalidIndex) {
                const BlockRole role = kBlocksTable[w.hot->buildings[bslot].block_id].role;
                if (role != BlockRole::CONVEYOR && role != BlockRole::PIPE) {
                    step_cost = 10u; // Враги предпочитают обходить стены по лабиринту
                }
            }
            const uint32_t cand = static_cast<uint32_t>(cur_d) + step_cost;
            if (cand < static_cast<uint32_t>(w.map->flow_dist[nidx])) {
                w.map->flow_dist[nidx] = static_cast<uint16_t>(cand);
                w.map->bfs_queue[q_tail % kMaxMapTiles] = nidx;
                ++q_tail;
            }
        }
    }

    w.hot->flags = static_cast<uint8_t>(w.hot->flags & ~WORLD_FLAG_FLOW_DIRTY);
}

void sim_generate_sector(SimWorld& w, uint16_t sector_preset_id, uint64_t extra_seed) noexcept {
    const uint16_t pid = (sector_preset_id < kSectorPresetCount) ? sector_preset_id : 0u;
    const SectorPresetDef& sec = kSectorsTable[pid];
    const uint64_t seed = kDefaultPrngSeed ^ (static_cast<uint64_t>(pid + 1u) * 0x9E3779B97F4A7C15ULL) ^ extra_seed;

    sim_init_empty(w, kMaxMapDim, kMaxMapDim, seed);
    w.hot->sector_preset_id = pid;
    w.hot->win_wave = (sec.capture_wave > 0u) ? sec.capture_wave : static_cast<uint16_t>(15u + sec.difficulty * 3u);
    w.hot->wave_countdown_ticks = 60u * 35u;

    const int32_t mw = static_cast<int32_t>(w.map->width);
    const int32_t mh = static_cast<int32_t>(w.map->height);
    const int32_t cx = mw / 2;
    const int32_t core_y = mh - 20;
    const int32_t spawn_y = 12;
    w.hot->core_x = static_cast<int16_t>(cx - 1);
    w.hot->core_y = static_cast<int16_t>(core_y - 1);
    w.hot->spawn_x = static_cast<int16_t>(cx);
    w.hot->spawn_y = static_cast<int16_t>(spawn_y);

    const uint32_t s32 = static_cast<uint32_t>(seed & 0xFFFFFFFFu);

    FloorType base_floor = FloorType::DarkStone;
    WallEnvType base_wall = WallEnvType::StoneWall;
    if (sec.biome == 1u) { base_floor = FloorType::Moss; base_wall = WallEnvType::SporeWall; }
    else if (sec.biome == 2u) { base_floor = FloorType::Snow; base_wall = WallEnvType::IceWall; }
    else if (sec.biome == 3u) { base_floor = FloorType::Sand; base_wall = WallEnvType::DuneWall; }
    else if (sec.biome == 4u) { base_floor = FloorType::Sand; base_wall = WallEnvType::StoneWall; }
    else if (sec.biome == 5u) { base_floor = FloorType::Basalt; base_wall = WallEnvType::StoneWall; }

    for (int32_t y = 0; y < mh; ++y) {
        for (int32_t x = 0; x < mw; ++x) {
            const size_t idx = tile_idx(w.map, x, y);
            const uint32_t n_elev = smooth_noise(x, y, 14, s32 + 11u);
            const uint32_t n_det  = smooth_noise(x, y, 6, s32 + 97u);
            const uint32_t n_liq  = smooth_noise(x, y, 16, s32 + 233u);

            FloorType fl = base_floor;
            if (n_det > 620u && base_floor == FloorType::DarkStone) {
                fl = FloorType::Sand;
            } else if (n_det > 670u && base_floor != FloorType::Sand) {
                fl = FloorType::DarkStone;
            }

            // Озёра воды / смолы / шлака
            if (n_liq < 195u) {
                if (sec.biome == 5u || (sec.difficulty >= 6u && n_det > 700u)) {
                    fl = FloorType::Slag;
                } else if (sec.biome == 4u && n_det > 520u) {
                    fl = FloorType::Tar;
                } else {
                    fl = (n_liq < 110u && sec.biome == 3u) ? FloorType::DeepWater : FloorType::Water;
                }
            }
            w.map->floor[idx] = static_cast<uint8_t>(fl);

            // Каньонные стены по краям и скальным грядам, но с гарантированным проходом к ядру
            const bool border = (x < 3 || y < 3 || x >= mw - 3 || y >= mh - 3);
            const int32_t corridor_dx = (x > cx) ? (x - cx) : (cx - x);
            const int32_t sin_shift = (fx_sin_bam10(static_cast<uint32_t>(y * 12)) * 14) >> 16;
            const int32_t path_x = cx + sin_shift;
            const int32_t dist_path = (x > path_x) ? (x - path_x) : (path_x - x);

            const int32_t d_core_x = x - cx;
            const int32_t d_core_y = y - core_y;
            const int32_t d_sp_x = x - cx;
            const int32_t d_sp_y = y - spawn_y;
            const bool safe_core  = (d_core_x * d_core_x + d_core_y * d_core_y) <= 225;
            const bool safe_spawn = (d_sp_x * d_sp_x + d_sp_y * d_sp_y) <= 144;
            const bool in_corridor = (dist_path <= 6) || (corridor_dx <= 4 && y >= spawn_y && y <= core_y);

            if (safe_core || safe_spawn || in_corridor) {
                if (is_liquid_floor(w.map->floor[idx])) {
                    w.map->floor[idx] = static_cast<uint8_t>(base_floor);
                }
                w.map->wall[idx] = static_cast<uint8_t>(WallEnvType::None);
            } else if (border || (n_elev > 715u && !is_liquid_floor(w.map->floor[idx]))) {
                w.map->wall[idx] = static_cast<uint8_t>(base_wall);
            }

            // Генерация рудных жил на открытых нежидких тайлах
            if (w.map->wall[idx] == static_cast<uint8_t>(WallEnvType::None) &&
                !is_liquid_floor(w.map->floor[idx])) {
                const uint32_t o_cu = smooth_noise(x, y, 7, s32 + 401u);
                const uint32_t o_pb = smooth_noise(x, y, 7, s32 + 509u);
                const uint32_t o_co = smooth_noise(x, y, 8, s32 + 613u);
                const uint32_t o_ti = smooth_noise(x, y, 8, s32 + 727u);
                const uint32_t o_th = smooth_noise(x, y, 9, s32 + 839u);
                const uint32_t o_sc = smooth_noise(x, y, 8, s32 + 947u);

                if (o_cu > 775u) {
                    w.map->ore[idx] = static_cast<uint8_t>(ItemId::Copper);
                } else if (o_pb > 785u) {
                    w.map->ore[idx] = static_cast<uint8_t>(ItemId::Lead);
                } else if (o_co > 805u) {
                    w.map->ore[idx] = static_cast<uint8_t>(ItemId::Coal);
                } else if (sec.difficulty >= 2u && o_ti > 820u) {
                    w.map->ore[idx] = static_cast<uint8_t>(ItemId::Titanium);
                } else if (sec.difficulty >= 4u && o_th > 845u) {
                    w.map->ore[idx] = static_cast<uint8_t>(ItemId::Thorium);
                } else if (o_sc > 845u) {
                    w.map->ore[idx] = static_cast<uint8_t>(ItemId::Scrap);
                }
            }
        }
    }

    // Гарантированные стартовые жилы меди, свинца, угля и песка вблизи ядра игрока
    auto paint_patch = [&](int32_t px, int32_t py, uint8_t ore_id, FloorType fl_override, bool set_fl) {
        for (int32_t dy = -2; dy <= 2; ++dy) {
            for (int32_t dx = -2; dx <= 2; ++dx) {
                if (dx * dx + dy * dy <= 5 && in_bounds(w.map, px + dx, py + dy)) {
                    const size_t idx = tile_idx(w.map, px + dx, py + dy);
                    w.map->wall[idx] = static_cast<uint8_t>(WallEnvType::None);
                    if (set_fl) {
                        w.map->floor[idx] = static_cast<uint8_t>(fl_override);
                    } else {
                        w.map->floor[idx] = static_cast<uint8_t>(base_floor);
                        w.map->ore[idx] = ore_id;
                    }
                }
            }
        }
    };

    paint_patch(cx - 8, core_y - 2, static_cast<uint8_t>(ItemId::Copper), base_floor, false);
    paint_patch(cx + 8, core_y - 2, static_cast<uint8_t>(ItemId::Lead), base_floor, false);
    paint_patch(cx - 10, core_y - 10, static_cast<uint8_t>(ItemId::Coal), base_floor, false);
    paint_patch(cx + 10, core_y - 10, kOreNone, FloorType::Sand, true);
    paint_patch(cx - 14, core_y + 3, kOreNone, FloorType::Water, true);

    // Очистить площадку 5x5 под CoreShard
    for (int32_t dy = -1; dy <= 3; ++dy) {
        for (int32_t dx = -1; dx <= 3; ++dx) {
            const size_t idx = tile_idx(w.map, w.hot->core_x + dx, w.hot->core_y + dy);
            w.map->wall[idx] = static_cast<uint8_t>(WallEnvType::None);
            w.map->ore[idx] = kOreNone;
            w.map->floor[idx] = static_cast<uint8_t>(base_floor);
        }
    }

    // Стартовый запас ресурсов на ядре игрока (как при высадке на Серпуло)
    w.hot->core_items[static_cast<size_t>(ItemId::Copper)]   = 250;
    w.hot->core_items[static_cast<size_t>(ItemId::Lead)]     = 150;
    w.hot->core_items[static_cast<size_t>(ItemId::Graphite)] = 60;
    w.hot->core_items[static_cast<size_t>(ItemId::Silicon)]  = (sec.difficulty >= 3u) ? 80 : 0;
    w.hot->core_items[static_cast<size_t>(ItemId::Metaglass)] = 40;
    w.hot->core_items[static_cast<size_t>(ItemId::Titanium)] = (sec.difficulty >= 3u) ? 60 : 0;

    sim_place_block(w, w.hot->core_x, w.hot->core_y,
                    static_cast<uint16_t>(BlockId::CoreShard), 0u,
                    static_cast<uint8_t>(TeamId::Sharded), false);

    sim_rebuild_flow_field(w);
}

void sim_setup_m0_golden_scenario(SimWorld& w) noexcept {
    sim_init_empty(w, 128u, 128u, kDefaultPrngSeed);
    w.hot->wave_countdown_ticks = 999999u; // Отключаем случайные волны для чистого golden-сценария

    // Медная жила под механическим буром 2x2 в (20, 60)
    for (int32_t dy = 0; dy < 2; ++dy) {
        for (int32_t dx = 0; dx < 2; ++dx) {
            w.map->ore[tile_idx(w.map, 20 + dx, 60 + dy)] = static_cast<uint8_t>(ItemId::Copper);
        }
    }

    // Механический бур (20,60) -> 3 конвейера (22,60), (23,60), (24,60) -> CoreShard 3x3 в (25,59)
    sim_place_block(w, 25, 59, static_cast<uint16_t>(BlockId::CoreShard), 0u,
                    static_cast<uint8_t>(TeamId::Sharded), false);
    sim_place_block(w, 20, 60, static_cast<uint16_t>(BlockId::MechanicalDrill), 0u,
                    static_cast<uint8_t>(TeamId::Sharded), false);
    sim_place_block(w, 22, 60, static_cast<uint16_t>(BlockId::Conveyor), 0u,
                    static_cast<uint8_t>(TeamId::Sharded), false);
    sim_place_block(w, 23, 60, static_cast<uint16_t>(BlockId::Conveyor), 0u,
                    static_cast<uint8_t>(TeamId::Sharded), false);
    sim_place_block(w, 24, 60, static_cast<uint16_t>(BlockId::Conveyor), 0u,
                    static_cast<uint8_t>(TeamId::Sharded), false);

    // Встречный бой: вражеский Dagger в (40.0, 60.0) и снаряд игрока, летящий в него
    sim_spawn_unit(w, static_cast<uint8_t>(UnitTypeId::Dagger),
                   static_cast<uint8_t>(TeamId::Crux),
                   fx_from_int(40), fx_from_int(60));
    sim_spawn_projectile(w, static_cast<uint8_t>(TeamId::Sharded),
                         fx_from_int(34), fx_from_int(60),
                         kFxHalf, 0, 25, 40u, 0u, 0u, 1u);

    sim_rebuild_flow_field(w);
}

void sim_setup_esp_stress_benchmark(SimWorld& w) noexcept {
    sim_generate_sector(w, 0u, 0xBEEFULL);
    w.hot->flags |= WORLD_FLAG_SANDBOX;

    // Заполняем до лимита ESP32-S3: ~1024 здания, 256 юнитов, 512 снарядов
    for (int16_t y = 8; y < 118 && w.hot->active_buildings < kMaxBuildings - 4u; y += 3) {
        for (int16_t x = 8; x < 118 && w.hot->active_buildings < kMaxBuildings - 4u; x += 3) {
            if (sim_can_place_block(w, x, y, static_cast<uint16_t>(BlockId::Conveyor), 0u)) {
                const int32_t slot = sim_place_block(w, x, y, static_cast<uint16_t>(BlockId::Conveyor),
                                                     static_cast<uint8_t>((x + y) & 3), 0u, false);
                if (slot >= 0) {
                    w.hot->buildings[slot].item_id = static_cast<uint8_t>(ItemId::Copper);
                    w.hot->buildings[slot].item_count = 1u;
                }
            }
            if (w.hot->active_buildings < kMaxBuildings - 2u &&
                sim_can_place_block(w, static_cast<int16_t>(x + 1), y, static_cast<uint16_t>(BlockId::Duo), 0u)) {
                const int32_t slot = sim_place_block(w, static_cast<int16_t>(x + 1), y,
                                                     static_cast<uint16_t>(BlockId::Duo), 0u, 0u, false);
                if (slot >= 0) {
                    w.hot->buildings[slot].item_id = static_cast<uint8_t>(ItemId::Copper);
                    w.hot->buildings[slot].item_count = 10u;
                }
            }
        }
    }

    for (size_t i = 0; i < kMaxUnits; ++i) {
        const int32_t ux = 16 + static_cast<int32_t>((i * 7u) % 96u);
        const int32_t uy = 12 + static_cast<int32_t>((i * 5u) % 40u);
        sim_spawn_unit(w, static_cast<uint8_t>(i % kUnitTypeCount),
                       static_cast<uint8_t>(TeamId::Crux),
                       fx_from_int(ux), fx_from_int(uy));
    }

    for (size_t i = 0; i < kMaxProjectiles; ++i) {
        const int32_t px = 12 + static_cast<int32_t>((i * 3u) % 100u);
        const int32_t py = 20 + static_cast<int32_t>((i * 5u) % 80u);
        sim_spawn_projectile(w, static_cast<uint8_t>(TeamId::Sharded),
                             fx_from_int(px), fx_from_int(py),
                             16384, -16384, 12, 55u, 0u, 0u, 1u);
    }
    sim_rebuild_flow_field(w);
}

bool sim_can_place_block(const SimWorld& w, int16_t x, int16_t y, uint16_t block_id, uint8_t team) noexcept {
    if (!w.hot || !w.map || block_id >= kBlockCount) return false;
    const BlockDef& def = kBlocksTable[block_id];

    bool has_valid_resource = false;
    for (uint8_t dy = 0u; dy < def.size; ++dy) {
        for (uint8_t dx = 0u; dx < def.size; ++dx) {
            const int32_t tx = static_cast<int32_t>(x) + dx;
            const int32_t ty = static_cast<int32_t>(y) + dy;
            if (!in_bounds(w.map, tx, ty)) return false;
            const size_t idx = tile_idx(w.map, tx, ty);
            if (w.map->wall[idx] != static_cast<uint8_t>(WallEnvType::None)) return false;
            if (w.map->building_at[idx] != kInvalidIndex) return false;

            const uint8_t fl = w.map->floor[idx];
            if (def.role == BlockRole::PUMP) {
                if (is_liquid_floor(fl)) has_valid_resource = true;
            } else if (def.role == BlockRole::GEN_THERM) {
                if (fl == static_cast<uint8_t>(FloorType::Slag)) has_valid_resource = true;
            } else {
                if (is_deep_liquid(fl)) return false;
                if (is_liquid_floor(fl) && def.role != BlockRole::CONVEYOR &&
                    def.role != BlockRole::PIPE && def.role != BlockRole::BRIDGE) {
                    return false;
                }
            }

            if (def.role == BlockRole::DRILL) {
                const uint8_t ore_id = w.map->ore[idx];
                if (ore_id < kItemCount && kItemsTable[ore_id].hardness <= def.tier) {
                    has_valid_resource = true;
                } else if (fl == static_cast<uint8_t>(FloorType::Sand)) {
                    has_valid_resource = true;
                }
            }
        }
    }

    if ((def.role == BlockRole::DRILL || def.role == BlockRole::PUMP || def.role == BlockRole::GEN_THERM) &&
        !has_valid_resource) {
        return false;
    }

    // Проверка стоимости для игрока (если не включён режим песочницы)
    if (team == static_cast<uint8_t>(TeamId::Sharded) && (w.hot->flags & WORLD_FLAG_SANDBOX) == 0u) {
        for (uint8_t i = 0u; i < def.cost_count; ++i) {
            const uint16_t iid = def.cost[i].item_id;
            const int32_t need = static_cast<int32_t>(def.cost[i].amount);
            if (iid < kItemCount && w.hot->core_items[iid] < need) {
                return false;
            }
        }
    }
    return true;
}

int32_t sim_place_block(SimWorld& w, int16_t x, int16_t y, uint16_t block_id, uint8_t rotation,
                        uint8_t team, bool pay_cost) noexcept {
    if (!w.hot || !w.map || block_id >= kBlockCount) return -1;
    if (pay_cost && !sim_can_place_block(w, x, y, block_id, team)) {
        return -1;
    }

    const BlockDef& def = kBlocksTable[block_id];
    // Если pay_cost == false, всё равно проверяем границы и занятость клеток
    if (!pay_cost) {
        for (uint8_t dy = 0u; dy < def.size; ++dy) {
            for (uint8_t dx = 0u; dx < def.size; ++dx) {
                const int32_t tx = static_cast<int32_t>(x) + dx;
                const int32_t ty = static_cast<int32_t>(y) + dy;
                if (!in_bounds(w.map, tx, ty)) return -1;
                if (w.map->building_at[tile_idx(w.map, tx, ty)] != kInvalidIndex) return -1;
            }
        }
    }

    uint16_t free_slot = kInvalidIndex;
    for (size_t i = 0; i < kMaxBuildings; ++i) {
        if (!w.hot->buildings[i].active) {
            free_slot = static_cast<uint16_t>(i);
            break;
        }
    }
    if (free_slot == kInvalidIndex) return -1;

    if (pay_cost && team == static_cast<uint8_t>(TeamId::Sharded) &&
        (w.hot->flags & WORLD_FLAG_SANDBOX) == 0u) {
        for (uint8_t i = 0u; i < def.cost_count; ++i) {
            w.hot->core_items[def.cost[i].item_id] -= static_cast<int32_t>(def.cost[i].amount);
        }
    }

    SimBuilding& b = w.hot->buildings[free_slot];
    memset(&b, 0, sizeof(SimBuilding));
    b.id = free_slot;
    b.block_id = block_id;
    b.x = x;
    b.y = y;
    b.hp = def.max_hp;
    b.max_hp = def.max_hp;
    b.rotation = static_cast<uint8_t>(rotation & 3u);
    b.team = team;
    b.active = 1u;
    b.item_id = kItemEmpty;
    b.aux_item_id = kItemEmpty;
    b.config_item = static_cast<uint8_t>(ItemId::Copper);
    b.liquid_id = static_cast<uint8_t>(LiquidId::None);
    b.link_target_id = kInvalidIndex;

    for (uint8_t dy = 0u; dy < def.size; ++dy) {
        for (uint8_t dx = 0u; dx < def.size; ++dx) {
            w.map->building_at[tile_idx(w.map, x + dx, y + dy)] = free_slot;
        }
    }

    if (def.role == BlockRole::CORE && team == static_cast<uint8_t>(TeamId::Sharded)) {
        w.hot->core_x = x;
        w.hot->core_y = y;
    }

    ++w.hot->active_buildings;
    update_bridge_links(w, free_slot);
    w.hot->flags |= WORLD_FLAG_FLOW_DIRTY;
    return static_cast<int32_t>(free_slot);
}

bool sim_remove_block(SimWorld& w, int16_t x, int16_t y, bool refund_half) noexcept {
    if (!w.hot || !w.map || !in_bounds(w.map, x, y)) return false;
    const uint16_t slot = w.map->building_at[tile_idx(w.map, x, y)];
    if (slot == kInvalidIndex) return false;
    SimBuilding& b = w.hot->buildings[slot];
    if (!b.active) return false;
    const BlockDef& def = kBlocksTable[b.block_id];
    if (def.role == BlockRole::CORE) return false; // Не даём снести собственное ядро кликом

    if (refund_half && b.team == static_cast<uint8_t>(TeamId::Sharded) &&
        (w.hot->flags & WORLD_FLAG_SANDBOX) == 0u) {
        for (uint8_t i = 0u; i < def.cost_count; ++i) {
            const uint16_t iid = def.cost[i].item_id;
            const int32_t back = static_cast<int32_t>((def.cost[i].amount + 1u) / 2u);
            w.hot->core_items[iid] += back;
        }
    }

    destroy_building_slot(w, slot);
    return true;
}

int32_t sim_spawn_unit(SimWorld& w, uint8_t unit_type, uint8_t team, fx32_t x_q16, fx32_t y_q16) noexcept {
    if (!w.hot || unit_type >= kUnitTypeCount) return -1;
    for (size_t i = 0; i < kMaxUnits; ++i) {
        if (!w.hot->units[i].active) {
            SimUnit& u = w.hot->units[i];
            const UnitTypeDef& def = kUnitsTable[unit_type];
            memset(&u, 0, sizeof(SimUnit));
            u.id = static_cast<uint16_t>(i);
            u.unit_type = unit_type;
            u.team = team;
            u.active = 1u;
            u.flying = def.flying;
            u.hp = def.max_hp;
            u.max_hp = def.max_hp;
            u.x_q16 = x_q16;
            u.y_q16 = y_q16;
            u.angle_bam10 = 768u;
            u.target_bld_id = kInvalidIndex;
            ++w.hot->active_units;
            if (team == static_cast<uint8_t>(TeamId::Crux)) {
                ++w.hot->enemy_units;
            }
            return static_cast<int32_t>(i);
        }
    }
    return -1;
}

int32_t sim_spawn_projectile(SimWorld& w, uint8_t team, fx32_t x_q16, fx32_t y_q16,
                             fx32_t vx_q16, fx32_t vy_q16, int16_t damage, uint16_t ttl_ticks,
                             uint8_t splash_tiles, uint8_t style, uint8_t hit_air) noexcept {
    if (!w.hot) return -1;
    for (size_t i = 0; i < kMaxProjectiles; ++i) {
        if (!w.hot->projectiles[i].active) {
            SimProjectile& p = w.hot->projectiles[i];
            p.id = static_cast<uint16_t>(i);
            p.team = team;
            p.active = 1u;
            p.splash_radius_tiles = splash_tiles;
            p.pierce_left = (style == 2u) ? 4u : 1u;
            p.style = style;
            p.hit_air = hit_air;
            p.x_q16 = x_q16;
            p.y_q16 = y_q16;
            p.vx_q16 = vx_q16;
            p.vy_q16 = vy_q16;
            p.damage = damage;
            p.ttl_ticks = ttl_ticks;
            ++w.hot->active_projectiles;
            return static_cast<int32_t>(i);
        }
    }
    return -1;
}

void sim_trigger_next_wave(SimWorld& w) noexcept {
    if (!w.hot || !w.map) return;
    const uint16_t wave = w.hot->wave;
    const uint8_t diff = kSectorsTable[w.hot->sector_preset_id % kSectorPresetCount].difficulty;

    const uint32_t total_spawn = 2u + (wave * (1u + diff / 3u)) / 2u;
    const uint32_t capped = (total_spawn > 24u) ? 24u : total_spawn;

    for (uint32_t k = 0u; k < capped; ++k) {
        uint8_t utype = static_cast<uint8_t>(UnitTypeId::Dagger);
        if (wave >= 3u && (k % 4u == 1u)) utype = static_cast<uint8_t>(UnitTypeId::Crawler);
        if (wave >= 4u && (k % 5u == 2u)) utype = static_cast<uint8_t>(UnitTypeId::Flare);
        if (wave >= 6u && (k % 5u == 3u)) utype = static_cast<uint8_t>(UnitTypeId::Mace);
        if (wave >= 9u && (k % 6u == 4u)) utype = static_cast<uint8_t>(UnitTypeId::Horizon);
        if (wave >= 12u && (k % 7u == 0u)) utype = static_cast<uint8_t>(UnitTypeId::Fortress);
        if (wave >= 15u && (k % 8u == 5u)) utype = static_cast<uint8_t>(UnitTypeId::Spiroct);

        const int32_t ox = w.hot->rng.range_i32(-6, 6);
        const int32_t oy = w.hot->rng.range_i32(-3, 3);
        int32_t sx = static_cast<int32_t>(w.hot->spawn_x) + ox;
        int32_t sy = static_cast<int32_t>(w.hot->spawn_y) + oy;
        if (sx < 4) sx = 4;
        if (sx >= static_cast<int32_t>(w.map->width) - 4) sx = static_cast<int32_t>(w.map->width) - 5;
        if (sy < 4) sy = 4;
        if (sy >= static_cast<int32_t>(w.map->height) - 4) sy = static_cast<int32_t>(w.map->height) - 5;

        sim_spawn_unit(w, utype, static_cast<uint8_t>(TeamId::Crux),
                       fx_from_int(sx) + kFxHalf, fx_from_int(sy) + kFxHalf);
    }

    ++w.hot->wave;
    w.hot->wave_countdown_ticks = 60u * 35u;
}

bool sim_push_command(SimWorld& w, const SimCommand& cmd) noexcept {
    if (!w.hot || w.hot->cmd_count >= kMaxCommands) return false;
    w.hot->cmd_queue[w.hot->cmd_count] = cmd;
    ++w.hot->cmd_count;
    return true;
}

static void apply_command_now(SimWorld& w, const SimCommand& cmd) noexcept {
    switch (cmd.type) {
        case SimCmdType::PlaceBlock:
            sim_place_block(w, cmd.x, cmd.y, cmd.param16, cmd.rotation, cmd.team, true);
            break;
        case SimCmdType::RemoveBlock:
            sim_remove_block(w, cmd.x, cmd.y, true);
            break;
        case SimCmdType::TriggerWave:
            sim_trigger_next_wave(w);
            break;
        case SimCmdType::SetPaused:
            if (cmd.arg8 != 0u) w.hot->flags |= WORLD_FLAG_PAUSED;
            else w.hot->flags = static_cast<uint8_t>(w.hot->flags & ~WORLD_FLAG_PAUSED);
            break;
        case SimCmdType::SelectSector:
            sim_generate_sector(w, cmd.param16, 0u);
            break;
        case SimCmdType::SetSandbox:
            if (cmd.arg8 != 0u) w.hot->flags |= WORLD_FLAG_SANDBOX;
            else w.hot->flags = static_cast<uint8_t>(w.hot->flags & ~WORLD_FLAG_SANDBOX);
            break;
        case SimCmdType::ConfigureBlock:
            if (in_bounds(w.map, cmd.x, cmd.y)) {
                const uint16_t slot = w.map->building_at[tile_idx(w.map, cmd.x, cmd.y)];
                if (slot != kInvalidIndex && cmd.arg8 < kItemCount) {
                    w.hot->buildings[slot].config_item = cmd.arg8;
                }
            }
            break;
        default:
            break;
    }
}

void sim_step_tick(SimWorld& w) noexcept {
    if (!w.hot || !w.map) return;

    // 1. Обработка очереди команд в порядке поступления
    for (uint8_t i = 0u; i < w.hot->cmd_count; ++i) {
        apply_command_now(w, w.hot->cmd_queue[i]);
    }
    w.hot->cmd_count = 0u;

    if ((w.hot->flags & WORLD_FLAG_PAUSED) != 0u) {
        return;
    }
    if ((w.hot->flags & WORLD_FLAG_FLOW_DIRTY) != 0u &&
        (w.hot->tick == 0u || (w.hot->tick & 7u) == 0u)) {
        sim_rebuild_flow_field(w);
    }

    ++w.hot->tick;

    // Построение детерминированной пространственной сетки 16x16 по активным юнитам (O(N), в SRAM)
    for (size_t c = 0; c < 256u; ++c) {
        w.hot->unit_grid_head[c] = kInvalidIndex;
    }
    // Обходим с конца к началу, чтобы в списке ячейки индексы шли строго по возрастанию id!
    for (size_t rev = kMaxUnits; rev > 0u; --rev) {
        const uint16_t uid = static_cast<uint16_t>(rev - 1u);
        const SimUnit& u = w.hot->units[uid];
        if (!u.active) {
            w.hot->unit_grid_next[uid] = kInvalidIndex;
            continue;
        }
        int32_t gx = fx_to_int_floor(u.x_q16) >> 3;
        int32_t gy = fx_to_int_floor(u.y_q16) >> 3;
        if (gx < 0) gx = 0; else if (gx > 15) gx = 15;
        if (gy < 0) gy = 0; else if (gy > 15) gy = 15;
        const size_t cell = static_cast<size_t>((gy << 4) | gx);
        w.hot->unit_grid_next[uid] = w.hot->unit_grid_head[cell];
        w.hot->unit_grid_head[cell] = uid;
    }

    // 2. Энергосеть: подсчёт генерации, потребления и буфера аккумуляторов
    fx32_t prod_q16 = 0;
    fx32_t cons_q16 = 0;
    int32_t bat_cap = 0;

    for (size_t i = 0; i < kMaxBuildings; ++i) {
        SimBuilding& b = w.hot->buildings[i];
        if (!b.active) continue;
        const BlockDef& def = kBlocksTable[b.block_id];

        if (def.role == BlockRole::GEN_SOLAR || def.role == BlockRole::GEN_THERM) {
            prod_q16 += def.power_prod_q16;
        } else if (def.role == BlockRole::GEN_FUEL || def.role == BlockRole::GEN_STEAM) {
            if (b.cooldown_ticks > 0u) {
                --b.cooldown_ticks;
                prod_q16 += def.power_prod_q16;
            } else if (b.item_count > 0u) {
                const bool ok_water = (def.role != BlockRole::GEN_STEAM) || (b.liquid_q8 >= 16u);
                if (ok_water) {
                    --b.item_count;
                    if (def.role == BlockRole::GEN_STEAM) {
                        b.liquid_q8 = static_cast<uint16_t>(b.liquid_q8 - 16u);
                    }
                    b.cooldown_ticks = def.param_ticks;
                    prod_q16 += def.power_prod_q16;
                }
            }
        } else if (def.role == BlockRole::BATTERY) {
            bat_cap += static_cast<int32_t>(def.param_ticks);
        }

        if (def.power_cons_q16 > 0) {
            cons_q16 += def.power_cons_q16;
        }
    }

    w.hot->power_produced_q16 = prod_q16;
    w.hot->power_consumed_q16 = cons_q16;
    w.hot->power_capacity_units = bat_cap;
    if (w.hot->power_stored_units > bat_cap) {
        w.hot->power_stored_units = bat_cap;
    }

    if (prod_q16 >= cons_q16) {
        w.hot->power_satisfaction_q16 = kFxOne;
        const int32_t surplus = fx_to_int_floor(prod_q16 - cons_q16);
        if (surplus > 0 && w.hot->power_stored_units < bat_cap) {
            const int32_t nxt = w.hot->power_stored_units + surplus;
            w.hot->power_stored_units = (nxt > bat_cap) ? bat_cap : nxt;
        }
    } else {
        const int32_t deficit = fx_to_int_floor(cons_q16 - prod_q16) + 1;
        if (w.hot->power_stored_units >= deficit) {
            w.hot->power_stored_units -= deficit;
            w.hot->power_satisfaction_q16 = kFxOne;
        } else {
            w.hot->power_satisfaction_q16 = (cons_q16 > 0) ? fx_div(prod_q16, cons_q16) : kFxOne;
        }
    }

    const bool has_power = (w.hot->power_satisfaction_q16 >= (kFxOne / 2));

    // 3. Здания по возрастанию id: бурение, жидкости, конвейеры, заводы, турели
    for (size_t i = 0; i < kMaxBuildings; ++i) {
        SimBuilding& b = w.hot->buildings[i];
        if (!b.active) continue;
        const BlockDef& def = kBlocksTable[b.block_id];

        switch (def.role) {
            case BlockRole::DRILL: {
                if (def.power_cons_q16 > 0 && !has_power) break;
                uint8_t mined_item = kItemEmpty;
                uint32_t matching_tiles = 0u;
                for (uint8_t dy = 0u; dy < def.size; ++dy) {
                    for (uint8_t dx = 0u; dx < def.size; ++dx) {
                        const size_t idx = tile_idx(w.map, b.x + dx, b.y + dy);
                        const uint8_t ore = w.map->ore[idx];
                        if (ore < kItemCount && kItemsTable[ore].hardness <= def.tier) {
                            if (mined_item == kItemEmpty) mined_item = ore;
                            if (ore == mined_item) ++matching_tiles;
                        } else if (w.map->floor[idx] == static_cast<uint8_t>(FloorType::Sand)) {
                            if (mined_item == kItemEmpty) mined_item = static_cast<uint8_t>(ItemId::Sand);
                            if (mined_item == static_cast<uint8_t>(ItemId::Sand)) ++matching_tiles;
                        }
                    }
                }
                if (mined_item == kItemEmpty || matching_tiles == 0u) break;

                uint16_t inc = static_cast<uint16_t>(matching_tiles);
                if (b.liquid_q8 >= 8u) {
                    b.liquid_q8 = static_cast<uint16_t>(b.liquid_q8 - 4u);
                    inc = static_cast<uint16_t>(inc * 2u); // Водяное/криогенное ускорение бура
                }
                b.progress_ticks = static_cast<uint16_t>(b.progress_ticks + inc);
                const uint16_t need = static_cast<uint16_t>(def.param_ticks * 4u);
                if (b.progress_ticks >= need) {
                    if (eject_item_around_footprint(w, b, mined_item)) {
                        b.progress_ticks = static_cast<uint16_t>(b.progress_ticks - need);
                    } else {
                        b.progress_ticks = need;
                    }
                }
                break;
            }

            case BlockRole::CONVEYOR: {
                if (b.item_count == 0u) break;
                if (b.progress_ticks < def.param_ticks) {
                    ++b.progress_ticks;
                }
                if (b.progress_ticks >= def.param_ticks) {
                    const uint8_t dir = static_cast<uint8_t>(b.rotation & 3u);
                    const int32_t nx = static_cast<int32_t>(b.x) + kDirDx[dir];
                    const int32_t ny = static_cast<int32_t>(b.y) + kDirDy[dir];
                    if (in_bounds(w.map, nx, ny)) {
                        const uint16_t dst = w.map->building_at[tile_idx(w.map, nx, ny)];
                        if (dst != kInvalidIndex && try_accept_item(w, dst, b.item_id, dir)) {
                            b.item_count = 0u;
                            b.progress_ticks = 0u;
                        }
                    }
                }
                break;
            }

            case BlockRole::JUNCTION: {
                if (b.item_count == 0u) break;
                ++b.progress_ticks;
                if (b.progress_ticks >= def.param_ticks) {
                    const uint8_t dir = static_cast<uint8_t>(b.aux_item_id & 3u);
                    const int32_t nx = static_cast<int32_t>(b.x) + kDirDx[dir];
                    const int32_t ny = static_cast<int32_t>(b.y) + kDirDy[dir];
                    if (in_bounds(w.map, nx, ny)) {
                        const uint16_t dst = w.map->building_at[tile_idx(w.map, nx, ny)];
                        if (dst != kInvalidIndex && try_accept_item(w, dst, b.item_id, dir)) {
                            --b.item_count;
                            b.progress_ticks = 0u;
                        }
                    }
                }
                break;
            }

            case BlockRole::ROUTER: {
                if (b.item_count == 0u) break;
                if (eject_item_around_footprint(w, b, b.item_id)) {
                    --b.item_count;
                }
                break;
            }

            case BlockRole::SORTER: {
                if (b.item_count == 0u) break;
                const uint8_t in_dir = static_cast<uint8_t>(b.aux_item_id & 3u);
                const bool match = (b.item_id == b.config_item);
                const uint8_t d0 = match ? in_dir : static_cast<uint8_t>((in_dir + 1u) & 3u);
                const uint8_t d1 = match ? in_dir : static_cast<uint8_t>((in_dir + 3u) & 3u);
                const uint8_t dirs[2] = { d0, d1 };
                for (int k = 0; k < 2; ++k) {
                    const uint8_t d = dirs[(b.rr_cursor + k) & 1u];
                    const int32_t nx = static_cast<int32_t>(b.x) + kDirDx[d];
                    const int32_t ny = static_cast<int32_t>(b.y) + kDirDy[d];
                    if (in_bounds(w.map, nx, ny)) {
                        const uint16_t dst = w.map->building_at[tile_idx(w.map, nx, ny)];
                        if (dst != kInvalidIndex && try_accept_item(w, dst, b.item_id, d)) {
                            --b.item_count;
                            b.rr_cursor = static_cast<uint8_t>(b.rr_cursor ^ 1u);
                            break;
                        }
                    }
                }
                break;
            }

            case BlockRole::OVERFLOW_GATE: {
                if (b.item_count == 0u) break;
                const uint8_t in_dir = static_cast<uint8_t>(b.aux_item_id & 3u);
                const uint8_t try_dirs[3] = {
                    in_dir,
                    static_cast<uint8_t>((in_dir + 1u) & 3u),
                    static_cast<uint8_t>((in_dir + 3u) & 3u)
                };
                for (int k = 0; k < 3; ++k) {
                    const uint8_t d = try_dirs[k];
                    const int32_t nx = static_cast<int32_t>(b.x) + kDirDx[d];
                    const int32_t ny = static_cast<int32_t>(b.y) + kDirDy[d];
                    if (in_bounds(w.map, nx, ny)) {
                        const uint16_t dst = w.map->building_at[tile_idx(w.map, nx, ny)];
                        if (dst != kInvalidIndex && try_accept_item(w, dst, b.item_id, d)) {
                            --b.item_count;
                            break;
                        }
                    }
                }
                break;
            }

            case BlockRole::BRIDGE: {
                if (b.item_count == 0u) break;
                ++b.progress_ticks;
                if (b.progress_ticks >= def.param_ticks) {
                    if (b.link_target_id < kMaxBuildings &&
                        w.hot->buildings[b.link_target_id].active) {
                        if (try_accept_item(w, b.link_target_id, b.item_id, b.rotation)) {
                            --b.item_count;
                            b.progress_ticks = 0u;
                        }
                    } else {
                        // Приёмный конец моста выгружает вокруг себя
                        if (eject_item_around_footprint(w, b, b.item_id)) {
                            --b.item_count;
                            b.progress_ticks = 0u;
                        }
                    }
                }
                break;
            }

            case BlockRole::PUMP: {
                if (def.power_cons_q16 > 0 && !has_power) break;
                uint8_t liq = static_cast<uint8_t>(LiquidId::Water);
                const uint8_t fl = w.map->floor[tile_idx(w.map, b.x, b.y)];
                if (fl == static_cast<uint8_t>(FloorType::Slag)) liq = static_cast<uint8_t>(LiquidId::Slag);
                else if (fl == static_cast<uint8_t>(FloorType::Tar)) liq = static_cast<uint8_t>(LiquidId::Oil);

                for (uint8_t d = 0u; d < 4u; ++d) {
                    const int32_t nx = static_cast<int32_t>(b.x) + kDirDx[d] * def.size;
                    const int32_t ny = static_cast<int32_t>(b.y) + kDirDy[d] * def.size;
                    if (!in_bounds(w.map, nx, ny)) continue;
                    const uint16_t dst = w.map->building_at[tile_idx(w.map, nx, ny)];
                    if (dst != kInvalidIndex) {
                        try_accept_liquid(w, dst, liq, static_cast<uint16_t>(32u * def.tier));
                    }
                }
                break;
            }

            case BlockRole::PIPE: {
                if (b.liquid_q8 < 16u) break;
                const uint8_t d = static_cast<uint8_t>(b.rotation & 3u);
                const int32_t nx = static_cast<int32_t>(b.x) + kDirDx[d];
                const int32_t ny = static_cast<int32_t>(b.y) + kDirDy[d];
                if (in_bounds(w.map, nx, ny)) {
                    const uint16_t dst = w.map->building_at[tile_idx(w.map, nx, ny)];
                    if (dst != kInvalidIndex && try_accept_liquid(w, dst, b.liquid_id, 64u)) {
                        b.liquid_q8 = (b.liquid_q8 >= 64u) ? static_cast<uint16_t>(b.liquid_q8 - 64u) : 0u;
                    }
                }
                break;
            }

            case BlockRole::LIQ_ROUT: {
                if (b.liquid_q8 < 16u) break;
                for (uint8_t step = 0u; step < 4u && b.liquid_q8 >= 16u; ++step) {
                    const uint8_t d = static_cast<uint8_t>((b.rr_cursor + step) & 3u);
                    const int32_t nx = static_cast<int32_t>(b.x) + (d == 0u ? def.size : (d == 2u ? -1 : 0));
                    const int32_t ny = static_cast<int32_t>(b.y) + (d == 3u ? def.size : (d == 1u ? -1 : 0));
                    if (in_bounds(w.map, nx, ny)) {
                        const uint16_t dst = w.map->building_at[tile_idx(w.map, nx, ny)];
                        if (dst != kInvalidIndex && try_accept_liquid(w, dst, b.liquid_id, 32u)) {
                            b.liquid_q8 = (b.liquid_q8 >= 32u) ? static_cast<uint16_t>(b.liquid_q8 - 32u) : 0u;
                            b.rr_cursor = static_cast<uint8_t>((d + 1u) & 3u);
                            break;
                        }
                    }
                }
                break;
            }

            case BlockRole::CRAFTER: {
                if (def.power_cons_q16 > 0 && !has_power) break;
                const bool ok_a = (b.item_count >= def.in_a.amount);
                const bool ok_b = (def.in_b.item_id == 0xFFFFu) || (b.aux_item_count >= def.in_b.amount);
                if (ok_a && ok_b) {
                    ++b.progress_ticks;
                    if (b.progress_ticks >= def.param_ticks) {
                        if (eject_item_around_footprint(w, b, static_cast<uint8_t>(def.out_item.item_id))) {
                            b.item_count = static_cast<uint8_t>(b.item_count - def.in_a.amount);
                            if (def.in_b.item_id != 0xFFFFu) {
                                b.aux_item_count = static_cast<uint8_t>(b.aux_item_count - def.in_b.amount);
                            }
                            b.progress_ticks = 0u;
                        } else {
                            b.progress_ticks = def.param_ticks;
                        }
                    }
                }
                break;
            }

            case BlockRole::MENDER: {
                if (!has_power) break;
                if (b.cooldown_ticks > 0u) {
                    --b.cooldown_ticks;
                    break;
                }
                b.cooldown_ticks = def.param_ticks;
                const int32_t r = fx_to_int_round(def.range_tiles_q16);
                for (size_t j = 0; j < kMaxBuildings; ++j) {
                    SimBuilding& ally = w.hot->buildings[j];
                    if (!ally.active || ally.team != b.team || ally.hp >= ally.max_hp) continue;
                    const int32_t dx = static_cast<int32_t>(ally.x) - static_cast<int32_t>(b.x);
                    const int32_t dy = static_cast<int32_t>(ally.y) - static_cast<int32_t>(b.y);
                    if (dx * dx + dy * dy <= r * r) {
                        const int32_t nhp = static_cast<int32_t>(ally.hp) + def.damage;
                        ally.hp = static_cast<int16_t>(nhp > ally.max_hp ? ally.max_hp : nhp);
                    }
                }
                break;
            }

            case BlockRole::TURRET_ITEM:
            case BlockRole::TURRET_AIR:
            case BlockRole::TURRET_ARTY:
            case BlockRole::TURRET_PWR: {
                if (b.cooldown_ticks > 0u) {
                    --b.cooldown_ticks;
                }
                if (def.power_cons_q16 > 0 && !has_power) break;
                const bool needs_ammo = (def.role != BlockRole::TURRET_PWR);
                if (needs_ammo && b.item_count == 0u && (w.hot->flags & WORLD_FLAG_SANDBOX) == 0u) {
                    break;
                }

                const fx32_t cx_q16 = fx_from_int(b.x) + (static_cast<int32_t>(def.size) * kFxHalf);
                const fx32_t cy_q16 = fx_from_int(b.y) + (static_cast<int32_t>(def.size) * kFxHalf);
                const fx32_t range_q16 = def.range_tiles_q16;

                // Быстрая проверка сохранённой цели турели (b.link_target_id) перед полным обходом
                uint16_t best_u = kInvalidIndex;
                if (b.link_target_id < kMaxUnits) {
                    const SimUnit& cu = w.hot->units[b.link_target_id];
                    if (cu.active && cu.team != b.team &&
                        !(def.role == BlockRole::TURRET_AIR && !cu.flying) &&
                        !(def.role == BlockRole::TURRET_ARTY && cu.flying) &&
                        fx_dist(cu.x_q16 - cx_q16, cu.y_q16 - cy_q16) <= range_q16) {
                        best_u = b.link_target_id;
                    }
                }

                if (best_u == kInvalidIndex && (b.cooldown_ticks == 0u || ((w.hot->tick + i) & 3u) == 0u)) {
                    fx32_t best_dist = range_q16;
                    const int32_t r_cells = (fx_to_int_round(range_q16) >> 3) + 1;
                    const int32_t bgx = static_cast<int32_t>(b.x) >> 3;
                    const int32_t bgy = static_cast<int32_t>(b.y) >> 3;
                    const int32_t gy0 = (bgy - r_cells < 0) ? 0 : (bgy - r_cells);
                    const int32_t gy1 = (bgy + r_cells > 15) ? 15 : (bgy + r_cells);
                    const int32_t gx0 = (bgx - r_cells < 0) ? 0 : (bgx - r_cells);
                    const int32_t gx1 = (bgx + r_cells > 15) ? 15 : (bgx + r_cells);

                    for (int32_t gy = gy0; gy <= gy1; ++gy) {
                        for (int32_t gx = gx0; gx <= gx1; ++gx) {
                            for (uint16_t u_idx = w.hot->unit_grid_head[(gy << 4) | gx];
                                 u_idx != kInvalidIndex;
                                 u_idx = w.hot->unit_grid_next[u_idx]) {
                                const SimUnit& u = w.hot->units[u_idx];
                                if (!u.active || u.team == b.team) continue;
                                if (def.role == BlockRole::TURRET_AIR && !u.flying) continue;
                                if (def.role == BlockRole::TURRET_ARTY && u.flying) continue;
                                const fx32_t d = fx_dist(u.x_q16 - cx_q16, u.y_q16 - cy_q16);
                                if (d < best_dist || (d == best_dist && u_idx < best_u)) {
                                    best_dist = d;
                                    best_u = u_idx;
                                }
                            }
                        }
                    }
                    b.link_target_id = best_u;
                }

                if (best_u != kInvalidIndex) {
                    const SimUnit& tgt = w.hot->units[best_u];
                    const fx32_t dx = tgt.x_q16 - cx_q16;
                    const fx32_t dy = tgt.y_q16 - cy_q16;
                    b.aim_bam10 = fx_atan2_bam10(dy, dx);

                    if (b.cooldown_ticks == 0u) {
                        const fx32_t spd_q16 = (def.role == BlockRole::TURRET_PWR) ? (kFxOne / 2) : (kFxOne * 3 / 8);
                        const fx32_t vx = fx_mul(fx_cos_bam10(b.aim_bam10), spd_q16);
                        const fx32_t vy = fx_mul(fx_sin_bam10(b.aim_bam10), spd_q16);
                        const uint8_t splash = (def.role == BlockRole::TURRET_ARTY) ? 2u : 0u;
                        const uint8_t style = (def.role == BlockRole::TURRET_PWR) ? 2u : (splash ? 1u : 0u);
                        const uint8_t hit_air = (def.role == BlockRole::TURRET_ARTY) ? 0u : 1u;

                        int16_t dmg = def.damage;
                        if (needs_ammo && b.item_id == def.in_b.item_id) {
                            dmg = static_cast<int16_t>((dmg * 3) / 2); // Усиленный боеприпас (графит/пиратит/торий)
                        }

                        sim_spawn_projectile(w, b.team, cx_q16, cy_q16, vx, vy, dmg, 70u, splash, style, hit_air);
                        b.cooldown_ticks = def.param_ticks;
                        if (needs_ammo && b.item_count > 0u && (w.hot->flags & WORLD_FLAG_SANDBOX) == 0u) {
                            --b.item_count;
                        }
                    }
                }
                break;
            }

            default:
                break;
        }
    }

    // 4. Таймер волн и движение/атака юнитов по возрастанию id
    if ((w.hot->flags & (WORLD_FLAG_GAME_OVER | WORLD_FLAG_SECTOR_CAPTURED)) == 0u) {
        if (w.hot->wave <= w.hot->win_wave) {
            if (w.hot->wave_countdown_ticks > 0u) {
                --w.hot->wave_countdown_ticks;
            } else {
                sim_trigger_next_wave(w);
            }
        } else if (w.hot->enemy_units == 0u) {
            w.hot->flags |= WORLD_FLAG_SECTOR_CAPTURED;
        }
    }

    uint16_t enemy_alive = 0u;
    for (size_t i = 0; i < kMaxUnits; ++i) {
        SimUnit& u = w.hot->units[i];
        if (!u.active) continue;
        if (u.team == static_cast<uint8_t>(TeamId::Crux)) {
            ++enemy_alive;
        }

        const UnitTypeDef& udef = kUnitsTable[u.unit_type % kUnitTypeCount];
        if (u.cooldown_ticks > 0u) {
            --u.cooldown_ticks;
        }

        // Поиск ближайшего вражеского здания с кэшированием цели u.target_bld_id
        uint16_t tgt_bld = kInvalidIndex;
        const int32_t utx = fx_to_int_floor(u.x_q16);
        const int32_t uty = fx_to_int_floor(u.y_q16);

        if (u.target_bld_id < kMaxBuildings) {
            const SimBuilding& cb = w.hot->buildings[u.target_bld_id];
            if (cb.active && cb.team != u.team) {
                const fx32_t d = fx_dist((fx_from_int(cb.x) + kFxHalf) - u.x_q16,
                                         (fx_from_int(cb.y) + kFxHalf) - u.y_q16);
                if (d <= udef.range_tiles_q16) {
                    tgt_bld = u.target_bld_id;
                }
            }
        }

        if (tgt_bld == kInvalidIndex && ((w.hot->tick + i) & 7u) == 0u) {
            fx32_t best_bdist = udef.range_tiles_q16;
            const int32_t scan_r = fx_to_int_round(udef.range_tiles_q16) + 1;
            const int32_t sy0 = (uty - scan_r < 0) ? 0 : (uty - scan_r);
            const int32_t sy1 = (uty + scan_r >= static_cast<int32_t>(w.map->height))
                                    ? (static_cast<int32_t>(w.map->height) - 1) : (uty + scan_r);
            const int32_t sx0 = (utx - scan_r < 0) ? 0 : (utx - scan_r);
            const int32_t sx1 = (utx + scan_r >= static_cast<int32_t>(w.map->width))
                                    ? (static_cast<int32_t>(w.map->width) - 1) : (utx + scan_r);

            for (int32_t sy = sy0; sy <= sy1; ++sy) {
                const size_t row_off = static_cast<size_t>(sy) * w.map->width;
                for (int32_t sx = sx0; sx <= sx1; ++sx) {
                    const uint16_t bslot = w.map->building_at[row_off + static_cast<size_t>(sx)];
                    if (bslot == kInvalidIndex) continue;
                    const SimBuilding& b = w.hot->buildings[bslot];
                    if (!b.active || b.team == u.team) continue;
                    const fx32_t bx_q16 = fx_from_int(sx) + kFxHalf;
                    const fx32_t by_q16 = fx_from_int(sy) + kFxHalf;
                    const fx32_t d = fx_dist(bx_q16 - u.x_q16, by_q16 - u.y_q16);
                    if (d <= best_bdist) {
                        best_bdist = d;
                        tgt_bld = bslot;
                    }
                }
            }
            u.target_bld_id = tgt_bld;
        }

        if (tgt_bld != kInvalidIndex) {
            SimBuilding& b = w.hot->buildings[tgt_bld];
            const fx32_t bx_q16 = fx_from_int(b.x) + kFxHalf;
            const fx32_t by_q16 = fx_from_int(b.y) + kFxHalf;
            u.angle_bam10 = fx_atan2_bam10(by_q16 - u.y_q16, bx_q16 - u.x_q16);

            if (udef.suicide != 0u) {
                // Crawler взрывается при контакте
                b.hp = static_cast<int16_t>(b.hp - udef.damage);
                if (b.hp <= 0) destroy_building_slot(w, tgt_bld);
                u.active = 0u;
                --w.hot->active_units;
                if (enemy_alive > 0u && u.team == static_cast<uint8_t>(TeamId::Crux)) --enemy_alive;
                continue;
            } else if (u.cooldown_ticks == 0u) {
                const fx32_t spd = kFxOne / 3;
                const fx32_t vx = fx_mul(fx_cos_bam10(u.angle_bam10), spd);
                const fx32_t vy = fx_mul(fx_sin_bam10(u.angle_bam10), spd);
                sim_spawn_projectile(w, u.team, u.x_q16, u.y_q16, vx, vy, udef.damage, 50u, 0u, 0u, 0u);
                u.cooldown_ticks = udef.reload_ticks;
            }
        } else {
            // Движение к ядру игрока: летающие — напрямую, наземные — по градиенту flow_dist
            fx32_t goal_dx = (fx_from_int(w.hot->core_x) + kFxOne) - u.x_q16;
            fx32_t goal_dy = (fx_from_int(w.hot->core_y) + kFxOne) - u.y_q16;

            if (!u.flying && in_bounds(w.map, utx, uty)) {
                uint16_t best_f = w.map->flow_dist[tile_idx(w.map, utx, uty)];
                int32_t best_nx = utx;
                int32_t best_ny = uty;
                for (uint8_t d = 0u; d < 4u; ++d) {
                    const int32_t nx = utx + kDirDx[d];
                    const int32_t ny = uty + kDirDy[d];
                    if (!in_bounds(w.map, nx, ny)) continue;
                    const uint16_t nf = w.map->flow_dist[tile_idx(w.map, nx, ny)];
                    if (nf < best_f) {
                        best_f = nf;
                        best_nx = nx;
                        best_ny = ny;
                    }
                }
                if (best_nx != utx || best_ny != uty) {
                    goal_dx = (fx_from_int(best_nx) + kFxHalf) - u.x_q16;
                    goal_dy = (fx_from_int(best_ny) + kFxHalf) - u.y_q16;
                }
            }

            u.angle_bam10 = fx_atan2_bam10(goal_dy, goal_dx);
            u.vx_q16 = fx_mul(fx_cos_bam10(u.angle_bam10), udef.speed_q16);
            u.vy_q16 = fx_mul(fx_sin_bam10(u.angle_bam10), udef.speed_q16);
            const fx32_t nx_q16 = u.x_q16 + u.vx_q16;
            const fx32_t ny_q16 = u.y_q16 + u.vy_q16;
            const int32_t ntx = fx_to_int_floor(nx_q16);
            const int32_t nty = fx_to_int_floor(ny_q16);

            if (in_bounds(w.map, ntx, nty)) {
                const size_t nidx = tile_idx(w.map, ntx, nty);
                const bool blocked = !u.flying &&
                                     (w.map->wall[nidx] != static_cast<uint8_t>(WallEnvType::None) ||
                                      is_deep_liquid(w.map->floor[nidx]));
                if (!blocked) {
                    u.x_q16 = nx_q16;
                    u.y_q16 = ny_q16;
                }
            }
        }
    }
    w.hot->enemy_units = enemy_alive;

    // 5. Снаряды и коллизии по возрастанию id
    for (size_t i = 0; i < kMaxProjectiles; ++i) {
        SimProjectile& p = w.hot->projectiles[i];
        if (!p.active) continue;

        p.x_q16 += p.vx_q16;
        p.y_q16 += p.vy_q16;
        const int32_t tx = fx_to_int_floor(p.x_q16);
        const int32_t ty = fx_to_int_floor(p.y_q16);

        if (!in_bounds(w.map, tx, ty) || p.ttl_ticks == 0u) {
            p.active = 0u;
            if (w.hot->active_projectiles > 0u) --w.hot->active_projectiles;
            continue;
        }
        --p.ttl_ticks;

        bool consumed = false;
        if (p.team == static_cast<uint8_t>(TeamId::Sharded)) {
            // Снаряд игрока проверяет попадание только в соседних ячейках сетки 16x16
            const int32_t pgx = tx >> 3;
            const int32_t pgy = ty >> 3;
            const int32_t gy0 = (pgy > 0) ? (pgy - 1) : 0;
            const int32_t gy1 = (pgy < 15) ? (pgy + 1) : 15;
            const int32_t gx0 = (pgx > 0) ? (pgx - 1) : 0;
            const int32_t gx1 = (pgx < 15) ? (pgx + 1) : 15;

            for (int32_t gy = gy0; gy <= gy1 && !consumed; ++gy) {
                for (int32_t gx = gx0; gx <= gx1 && !consumed; ++gx) {
                    for (uint16_t u_idx = w.hot->unit_grid_head[(gy << 4) | gx];
                         u_idx != kInvalidIndex;
                         u_idx = w.hot->unit_grid_next[u_idx]) {
                        SimUnit& u = w.hot->units[u_idx];
                        if (!u.active || u.team == p.team) continue;
                        if (u.flying && p.hit_air == 0u) continue;
                        const fx32_t dx = fx_abs(u.x_q16 - p.x_q16);
                        const fx32_t dy = fx_abs(u.y_q16 - p.y_q16);
                        if (dx <= (kFxHalf + 16384) && dy <= (kFxHalf + 16384)) {
                            const int32_t armor = static_cast<int32_t>(kUnitsTable[u.unit_type % kUnitTypeCount].armor);
                            int32_t eff = static_cast<int32_t>(p.damage) - armor;
                            if (eff < 1) eff = 1;
                            u.hp = static_cast<int16_t>(u.hp - eff);
                            if (u.hp <= 0) {
                                u.active = 0u;
                                if (w.hot->active_units > 0u) --w.hot->active_units;
                                if (w.hot->enemy_units > 0u && u.team == static_cast<uint8_t>(TeamId::Crux)) {
                                    --w.hot->enemy_units;
                                }
                            }

                            if (p.splash_radius_tiles > 0u) {
                                const fx32_t sr = fx_from_int(p.splash_radius_tiles);
                                for (uint16_t k = w.hot->unit_grid_head[(gy << 4) | gx];
                                     k != kInvalidIndex;
                                     k = w.hot->unit_grid_next[k]) {
                                    SimUnit& su = w.hot->units[k];
                                    if (!su.active || su.team == p.team || k == u_idx) continue;
                                    if (fx_dist(su.x_q16 - p.x_q16, su.y_q16 - p.y_q16) <= sr) {
                                        su.hp = static_cast<int16_t>(su.hp - (eff / 2 + 1));
                                        if (su.hp <= 0) {
                                            su.active = 0u;
                                            if (w.hot->active_units > 0u) --w.hot->active_units;
                                            if (w.hot->enemy_units > 0u) --w.hot->enemy_units;
                                        }
                                    }
                                }
                            }

                            if (p.pierce_left <= 1u) {
                                consumed = true;
                                break;
                            } else {
                                --p.pierce_left;
                            }
                        }
                    }
                }
            }
        } else {
            // Снаряд врага проверяет попадание по зданиям игрока
            const uint16_t bslot = w.map->building_at[tile_idx(w.map, tx, ty)];
            if (bslot != kInvalidIndex) {
                SimBuilding& b = w.hot->buildings[bslot];
                if (b.active && b.team != p.team) {
                    b.hp = static_cast<int16_t>(b.hp - p.damage);
                    if (b.hp <= 0) {
                        destroy_building_slot(w, bslot);
                    }
                    consumed = true;
                }
            }
        }

        if (consumed) {
            p.active = 0u;
            if (w.hot->active_projectiles > 0u) --w.hot->active_projectiles;
        }
    }
}

void sim_step_ticks(SimWorld& w, uint32_t count) noexcept {
    for (uint32_t i = 0u; i < count; ++i) {
        sim_step_tick(w);
    }
}

template <typename Hasher>
static void feed_canonical_world_state(const SimWorld& w, Hasher& h) noexcept {
    const SimHotState& hot = *w.hot;
    const SimMapStorage& map = *w.map;

    h.feed_u32_le(hot.tick);
    h.feed_u16_le(hot.sector_preset_id);
    h.feed_u16_le(hot.wave);
    h.feed_u16_le(hot.win_wave);
    h.feed_u8(hot.flags);
    h.feed_u32_le(hot.wave_countdown_ticks);
    h.feed_i16_le(hot.core_x);
    h.feed_i16_le(hot.core_y);
    h.feed_i16_le(hot.spawn_x);
    h.feed_i16_le(hot.spawn_y);
    h.feed_u16_le(hot.active_buildings);
    h.feed_u16_le(hot.active_units);
    h.feed_u16_le(hot.active_projectiles);
    h.feed_u16_le(hot.enemy_units);
    h.feed_u64_le(hot.rng.state);

    for (size_t i = 0; i < kItemCount; ++i) {
        h.feed_i32_le(hot.core_items[i]);
    }

    h.feed_i32_le(hot.power_produced_q16);
    h.feed_i32_le(hot.power_consumed_q16);
    h.feed_i32_le(hot.power_satisfaction_q16);
    h.feed_i32_le(hot.power_stored_units);
    h.feed_i32_le(hot.power_capacity_units);

    h.feed_u16_le(map.width);
    h.feed_u16_le(map.height);
    const size_t total = static_cast<size_t>(map.width) * static_cast<size_t>(map.height);
    for (size_t i = 0; i < total; ++i) {
        h.feed_u8(map.floor[i]);
        h.feed_u8(map.ore[i]);
        h.feed_u8(map.wall[i]);
        h.feed_u16_le(map.building_at[i]);
    }

    for (size_t i = 0; i < kMaxBuildings; ++i) {
        const SimBuilding& b = hot.buildings[i];
        h.feed_u8(b.active);
        if (!b.active) continue;
        h.feed_u16_le(b.id);
        h.feed_u16_le(b.block_id);
        h.feed_i16_le(b.x);
        h.feed_i16_le(b.y);
        h.feed_i16_le(b.hp);
        h.feed_i16_le(b.max_hp);
        h.feed_u8(b.rotation);
        h.feed_u8(b.team);
        h.feed_u8(b.config_item);
        h.feed_u8(b.item_id);
        h.feed_u8(b.item_count);
        h.feed_u8(b.aux_item_id);
        h.feed_u8(b.aux_item_count);
        h.feed_u8(b.liquid_id);
        h.feed_u8(b.rr_cursor);
        h.feed_u16_le(b.liquid_q8);
        h.feed_u16_le(b.progress_ticks);
        h.feed_u16_le(b.cooldown_ticks);
        h.feed_u16_le(b.link_target_id);
        h.feed_u16_le(b.aim_bam10);
    }

    for (size_t i = 0; i < kMaxUnits; ++i) {
        const SimUnit& u = hot.units[i];
        h.feed_u8(u.active);
        if (!u.active) continue;
        h.feed_u16_le(u.id);
        h.feed_u8(u.unit_type);
        h.feed_u8(u.team);
        h.feed_u8(u.flying);
        h.feed_i16_le(u.hp);
        h.feed_i16_le(u.max_hp);
        h.feed_u16_le(u.cooldown_ticks);
        h.feed_i32_le(u.x_q16);
        h.feed_i32_le(u.y_q16);
        h.feed_i32_le(u.vx_q16);
        h.feed_i32_le(u.vy_q16);
        h.feed_u16_le(u.angle_bam10);
    }

    for (size_t i = 0; i < kMaxProjectiles; ++i) {
        const SimProjectile& p = hot.projectiles[i];
        h.feed_u8(p.active);
        if (!p.active) continue;
        h.feed_u16_le(p.id);
        h.feed_u8(p.team);
        h.feed_u8(p.splash_radius_tiles);
        h.feed_u8(p.pierce_left);
        h.feed_u8(p.style);
        h.feed_u8(p.hit_air);
        h.feed_i32_le(p.x_q16);
        h.feed_i32_le(p.y_q16);
        h.feed_i32_le(p.vx_q16);
        h.feed_i32_le(p.vy_q16);
        h.feed_i16_le(p.damage);
        h.feed_u16_le(p.ttl_ticks);
    }
}

uint64_t sim_state_hash_fnv1a64(const SimWorld& w) noexcept {
    if (!w.hot || !w.map) return 0u;
    Fnv1a64 h;
    feed_canonical_world_state(w, h);
    return h.value;
}

uint32_t sim_state_crc32(const SimWorld& w) noexcept {
    if (!w.hot || !w.map) return 0u;
    Crc32 c;
    feed_canonical_world_state(w, c);
    return c.finish();
}

bool sim_run_golden_selftest(SimWorld& scratch_world) noexcept {
    if (!scratch_world.hot || !scratch_world.map) return false;

    sim_init_empty(scratch_world, 128u, 128u, kDefaultPrngSeed);
    if (sim_state_hash_fnv1a64(scratch_world) != kGoldenHashes.empty128_tick0_fnv64) return false;
    if (sim_state_crc32(scratch_world) != kGoldenHashes.empty128_tick0_crc32) return false;

    sim_setup_m0_golden_scenario(scratch_world);
    sim_step_ticks(scratch_world, 60u);
    if (sim_state_hash_fnv1a64(scratch_world) != kGoldenHashes.m0_tick60_fnv64) return false;
    if (sim_state_crc32(scratch_world) != kGoldenHashes.m0_tick60_crc32) return false;

    sim_step_ticks(scratch_world, 540u);
    if (sim_state_hash_fnv1a64(scratch_world) != kGoldenHashes.m0_tick600_fnv64) return false;
    if (sim_state_crc32(scratch_world) != kGoldenHashes.m0_tick600_crc32) return false;

    return true;
}

// ============================================================================
// Кодек бинарного протокола 0x4D53 ("MS")
// ============================================================================

size_t proto_pack_frame(uint8_t* out_buf, size_t out_cap,
                        ProtoMsgType type, uint16_t seq,
                        const uint8_t* payload, size_t payload_len) noexcept {
    if (!out_buf || payload_len > kProtoMaxPayload) return 0u;
    const size_t total = kProtoHeaderBytes + payload_len + kProtoCrcBytes;
    if (out_cap < total) return 0u;

    wr_u16_le(out_buf + 0, kProtoMagic);
    out_buf[2] = static_cast<uint8_t>(type);
    wr_u16_le(out_buf + 3, seq);
    wr_u16_le(out_buf + 5, static_cast<uint16_t>(payload_len));
    if (payload_len > 0u && payload != nullptr && payload != (out_buf + kProtoHeaderBytes)) {
        memcpy(out_buf + kProtoHeaderBytes, payload, payload_len);
    }

    const uint16_t crc = crc16_ccitt(out_buf, kProtoHeaderBytes + payload_len);
    wr_u16_le(out_buf + kProtoHeaderBytes + payload_len, crc);
    return total;
}

size_t proto_encode_hello(uint8_t* out_buf, size_t out_cap, uint16_t seq,
                          uint16_t map_w, uint16_t map_h, uint8_t server_hz, uint16_t sector_id) noexcept {
    uint8_t pay[8];
    pay[0] = kProtoVersion;
    pay[1] = server_hz;
    wr_u16_le(pay + 2, map_w);
    wr_u16_le(pay + 4, map_h);
    wr_u16_le(pay + 6, sector_id);
    return proto_pack_frame(out_buf, out_cap, ProtoMsgType::Hello, seq, pay, sizeof(pay));
}

size_t proto_encode_map_chunk(uint8_t* out_buf, size_t out_cap, uint16_t seq,
                              const SimWorld& w, uint16_t y_start, uint16_t rows) noexcept {
    if (!w.map || y_start >= w.map->height) return 0u;
    uint16_t r = rows;
    if (static_cast<uint32_t>(y_start) + r > w.map->height) {
        r = static_cast<uint16_t>(w.map->height - y_start);
    }
    const size_t cells = static_cast<size_t>(r) * static_cast<size_t>(w.map->width);
    const size_t pay_len = 8u + cells * 3u;
    if (pay_len > kProtoMaxPayload || out_cap < kProtoHeaderBytes + pay_len + kProtoCrcBytes) {
        return 0u;
    }

    uint8_t* pay = out_buf + kProtoHeaderBytes;
    wr_u16_le(pay + 0, w.map->width);
    wr_u16_le(pay + 2, w.map->height);
    wr_u16_le(pay + 4, y_start);
    wr_u16_le(pay + 6, r);

    const size_t off0 = static_cast<size_t>(y_start) * static_cast<size_t>(w.map->width);
    memcpy(pay + 8u, w.map->floor + off0, cells);
    memcpy(pay + 8u + cells, w.map->ore + off0, cells);
    memcpy(pay + 8u + cells * 2u, w.map->wall + off0, cells);

    return proto_pack_frame(out_buf, out_cap, ProtoMsgType::MapStatic, seq, pay, pay_len);
}

bool proto_apply_map_chunk(SimWorld& w, const uint8_t* payload, size_t len) noexcept {
    if (!w.map || !payload || len < 8u) return false;
    const uint16_t mw = rd_u16_le(payload + 0);
    const uint16_t mh = rd_u16_le(payload + 2);
    const uint16_t ys = rd_u16_le(payload + 4);
    const uint16_t rows = rd_u16_le(payload + 6);
    if (mw == 0u || mw > kMaxMapDim || mh == 0u || mh > kMaxMapDim) return false;
    if (static_cast<uint32_t>(ys) + rows > mh) return false;

    const size_t cells = static_cast<size_t>(rows) * static_cast<size_t>(mw);
    if (len != 8u + cells * 3u) return false;

    w.map->width = mw;
    w.map->height = mh;
    const size_t off0 = static_cast<size_t>(ys) * static_cast<size_t>(mw);
    memcpy(w.map->floor + off0, payload + 8u, cells);
    memcpy(w.map->ore + off0, payload + 8u + cells, cells);
    memcpy(w.map->wall + off0, payload + 8u + cells * 2u, cells);
    return true;
}

size_t proto_encode_snapshot(uint8_t* out_buf, size_t out_cap, uint16_t seq,
                             const SimWorld& w, bool include_buildings) noexcept {
    if (!w.hot || !w.map || out_cap < kProtoHeaderBytes + 128u) return 0u;
    uint8_t* pay = out_buf + kProtoHeaderBytes;
    const size_t max_pay = (out_cap - kProtoHeaderBytes - kProtoCrcBytes < kProtoMaxPayload)
                               ? (out_cap - kProtoHeaderBytes - kProtoCrcBytes)
                               : kProtoMaxPayload;

    size_t p = 0u;
    if (max_pay < 120u) return 0u;

    wr_u32_le(pay + p, w.hot->tick); p += 4u;
    wr_u16_le(pay + p, w.hot->sector_preset_id); p += 2u;
    wr_u16_le(pay + p, w.hot->wave); p += 2u;
    wr_u16_le(pay + p, w.hot->win_wave); p += 2u;
    wr_u32_le(pay + p, w.hot->wave_countdown_ticks); p += 4u;
    pay[p++] = w.hot->flags;
    pay[p++] = include_buildings ? 1u : 0u;

    for (size_t i = 0; i < kSerpuloItemCount; ++i) {
        wr_i32_le(pay + p, w.hot->core_items[i]);
        p += 4u;
    }

    wr_i32_le(pay + p, w.hot->power_produced_q16); p += 4u;
    wr_i32_le(pay + p, w.hot->power_consumed_q16); p += 4u;
    wr_i32_le(pay + p, w.hot->power_stored_units); p += 4u;
    wr_i32_le(pay + p, w.hot->power_capacity_units); p += 4u;

    const size_t b_cnt_off = p;
    wr_u16_le(pay + p, 0u); p += 2u;
    uint16_t b_written = 0u;
    if (include_buildings) {
        for (size_t i = 0; i < kMaxBuildings; ++i) {
            const SimBuilding& b = w.hot->buildings[i];
            if (!b.active) continue;
            if (p + 18u > max_pay) break;
            wr_u16_le(pay + p + 0, b.id);
            wr_u16_le(pay + p + 2, b.block_id);
            wr_i16_le(pay + p + 4, b.x);
            wr_i16_le(pay + p + 6, b.y);
            wr_i16_le(pay + p + 8, b.hp);
            pay[p + 10] = b.rotation;
            pay[p + 11] = b.team;
            pay[p + 12] = b.item_id;
            pay[p + 13] = b.item_count;
            wr_u16_le(pay + p + 14, b.progress_ticks);
            wr_u16_le(pay + p + 16, b.aim_bam10);
            p += 18u;
            ++b_written;
        }
    }
    wr_u16_le(pay + b_cnt_off, b_written);

    const size_t u_cnt_off = p;
    wr_u16_le(pay + p, 0u); p += 2u;
    uint16_t u_written = 0u;
    for (size_t i = 0; i < kMaxUnits; ++i) {
        const SimUnit& u = w.hot->units[i];
        if (!u.active) continue;
        if (p + 16u > max_pay) break;
        wr_u16_le(pay + p + 0, u.id);
        pay[p + 2] = u.unit_type;
        pay[p + 3] = u.team;
        wr_i16_le(pay + p + 4, u.hp);
        wr_u16_le(pay + p + 6, u.angle_bam10);
        wr_i32_le(pay + p + 8, u.x_q16);
        wr_i32_le(pay + p + 12, u.y_q16);
        p += 16u;
        ++u_written;
    }
    wr_u16_le(pay + u_cnt_off, u_written);

    const size_t pr_cnt_off = p;
    wr_u16_le(pay + p, 0u); p += 2u;
    uint16_t pr_written = 0u;
    for (size_t i = 0; i < kMaxProjectiles; ++i) {
        const SimProjectile& pr = w.hot->projectiles[i];
        if (!pr.active) continue;
        if (p + 12u > max_pay) break;
        wr_u16_le(pay + p + 0, pr.id);
        pay[p + 2] = pr.team;
        pay[p + 3] = pr.style;
        wr_i32_le(pay + p + 4, pr.x_q16);
        wr_i32_le(pay + p + 8, pr.y_q16);
        p += 12u;
        ++pr_written;
    }
    wr_u16_le(pay + pr_cnt_off, pr_written);

    return proto_pack_frame(out_buf, out_cap,
                            include_buildings ? ProtoMsgType::SnapshotFull : ProtoMsgType::SnapshotDelta,
                            seq, pay, p);
}

bool proto_apply_snapshot(SimWorld& w, const uint8_t* payload, size_t len) noexcept {
    if (!w.hot || !w.map || !payload || len < 102u) return false;
    size_t p = 0u;
    w.hot->tick = rd_u32_le(payload + p); p += 4u;
    w.hot->sector_preset_id = rd_u16_le(payload + p); p += 2u;
    w.hot->wave = rd_u16_le(payload + p); p += 2u;
    w.hot->win_wave = rd_u16_le(payload + p); p += 2u;
    w.hot->wave_countdown_ticks = rd_u32_le(payload + p); p += 4u;
    w.hot->flags = payload[p++];
    const bool has_blds = (payload[p++] != 0u);

    for (size_t i = 0; i < kSerpuloItemCount; ++i) {
        w.hot->core_items[i] = rd_i32_le(payload + p);
        p += 4u;
    }
    w.hot->power_produced_q16 = rd_i32_le(payload + p); p += 4u;
    w.hot->power_consumed_q16 = rd_i32_le(payload + p); p += 4u;
    w.hot->power_stored_units = rd_i32_le(payload + p); p += 4u;
    w.hot->power_capacity_units = rd_i32_le(payload + p); p += 4u;

    if (p + 2u > len) return false;
    const uint16_t b_cnt = rd_u16_le(payload + p); p += 2u;
    if (p + static_cast<size_t>(b_cnt) * 18u > len) return false;

    if (has_blds) {
        const size_t total_cells = static_cast<size_t>(w.map->width) * static_cast<size_t>(w.map->height);
        for (size_t i = 0; i < total_cells; ++i) w.map->building_at[i] = kInvalidIndex;
        for (size_t i = 0; i < kMaxBuildings; ++i) w.hot->buildings[i].active = 0u;
        w.hot->active_buildings = b_cnt;

        for (uint16_t k = 0u; k < b_cnt; ++k) {
            const uint16_t bid = rd_u16_le(payload + p + 0);
            const uint16_t blk = rd_u16_le(payload + p + 2);
            if (bid < kMaxBuildings && blk < kBlockCount) {
                SimBuilding& b = w.hot->buildings[bid];
                b.id = bid;
                b.block_id = blk;
                b.x = rd_i16_le(payload + p + 4);
                b.y = rd_i16_le(payload + p + 6);
                b.hp = rd_i16_le(payload + p + 8);
                b.max_hp = kBlocksTable[blk].max_hp;
                b.rotation = payload[p + 10];
                b.team = payload[p + 11];
                b.item_id = payload[p + 12];
                b.item_count = payload[p + 13];
                b.progress_ticks = rd_u16_le(payload + p + 14);
                b.aim_bam10 = rd_u16_le(payload + p + 16);
                b.active = 1u;

                const uint8_t sz = kBlocksTable[blk].size;
                for (uint8_t dy = 0u; dy < sz; ++dy) {
                    for (uint8_t dx = 0u; dx < sz; ++dx) {
                        if (in_bounds(w.map, b.x + dx, b.y + dy)) {
                            w.map->building_at[tile_idx(w.map, b.x + dx, b.y + dy)] = bid;
                        }
                    }
                }
            }
            p += 18u;
        }
    }

    if (p + 2u > len) return false;
    const uint16_t u_cnt = rd_u16_le(payload + p); p += 2u;
    if (p + static_cast<size_t>(u_cnt) * 16u > len) return false;
    for (size_t i = 0; i < kMaxUnits; ++i) w.hot->units[i].active = 0u;
    w.hot->active_units = u_cnt;
    uint16_t enemies = 0u;

    for (uint16_t k = 0u; k < u_cnt; ++k) {
        const uint16_t uid = rd_u16_le(payload + p + 0);
        if (uid < kMaxUnits) {
            SimUnit& u = w.hot->units[uid];
            u.id = uid;
            u.unit_type = payload[p + 2] % kUnitTypeCount;
            u.team = payload[p + 3];
            u.flying = kUnitsTable[u.unit_type].flying;
            u.hp = rd_i16_le(payload + p + 4);
            u.max_hp = kUnitsTable[u.unit_type].max_hp;
            u.angle_bam10 = rd_u16_le(payload + p + 6);
            u.x_q16 = rd_i32_le(payload + p + 8);
            u.y_q16 = rd_i32_le(payload + p + 12);
            u.active = 1u;
            if (u.team == static_cast<uint8_t>(TeamId::Crux)) ++enemies;
        }
        p += 16u;
    }
    w.hot->enemy_units = enemies;

    if (p + 2u > len) return false;
    const uint16_t pr_cnt = rd_u16_le(payload + p); p += 2u;
    if (p + static_cast<size_t>(pr_cnt) * 12u > len) return false;
    for (size_t i = 0; i < kMaxProjectiles; ++i) w.hot->projectiles[i].active = 0u;
    w.hot->active_projectiles = pr_cnt;

    for (uint16_t k = 0u; k < pr_cnt; ++k) {
        const uint16_t pid = rd_u16_le(payload + p + 0);
        if (pid < kMaxProjectiles) {
            SimProjectile& pr = w.hot->projectiles[pid];
            pr.id = pid;
            pr.team = payload[p + 2];
            pr.style = payload[p + 3];
            pr.x_q16 = rd_i32_le(payload + p + 4);
            pr.y_q16 = rd_i32_le(payload + p + 8);
            pr.active = 1u;
        }
        p += 12u;
    }
    return true;
}

size_t proto_encode_cmd(uint8_t* out_buf, size_t out_cap, uint16_t seq, const SimCommand& cmd) noexcept {
    uint8_t pay[12];
    pay[0] = static_cast<uint8_t>(cmd.type);
    pay[1] = cmd.rotation;
    pay[2] = cmd.team;
    pay[3] = cmd.arg8;
    wr_i16_le(pay + 4, cmd.x);
    wr_i16_le(pay + 6, cmd.y);
    wr_u16_le(pay + 8, cmd.param16);
    wr_u16_le(pay + 10, cmd.reserved);
    return proto_pack_frame(out_buf, out_cap, ProtoMsgType::InputCmd, seq, pay, sizeof(pay));
}

bool proto_decode_cmd(const uint8_t* payload, size_t len, SimCommand& out_cmd) noexcept {
    if (!payload || len < 12u) return false;
    out_cmd.type = static_cast<SimCmdType>(payload[0]);
    out_cmd.rotation = payload[1];
    out_cmd.team = payload[2];
    out_cmd.arg8 = payload[3];
    out_cmd.x = rd_i16_le(payload + 4);
    out_cmd.y = rd_i16_le(payload + 6);
    out_cmd.param16 = rd_u16_le(payload + 8);
    out_cmd.reserved = rd_u16_le(payload + 10);
    return true;
}

size_t proto_encode_ping(uint8_t* out_buf, size_t out_cap, uint16_t seq, uint64_t client_time_us) noexcept {
    uint8_t pay[8];
    wr_u64_le(pay, client_time_us);
    return proto_pack_frame(out_buf, out_cap, ProtoMsgType::Ping, seq, pay, sizeof(pay));
}

size_t proto_encode_pong(uint8_t* out_buf, size_t out_cap, uint16_t seq,
                         uint64_t client_time_us, uint32_t server_tick, uint32_t last_tick_us) noexcept {
    uint8_t pay[16];
    wr_u64_le(pay + 0, client_time_us);
    wr_u32_le(pay + 8, server_tick);
    wr_u32_le(pay + 12, last_tick_us);
    return proto_pack_frame(out_buf, out_cap, ProtoMsgType::Pong, seq, pay, sizeof(pay));
}

bool ProtoStreamParser::feed_byte(uint8_t b, ProtoParsedFrame& out_frame) noexcept {
    if (pos == 0u) {
        if (b != static_cast<uint8_t>(kProtoMagic & 0xFFu)) return false;
        buf[pos++] = b;
        return false;
    }
    if (pos == 1u) {
        if (b != static_cast<uint8_t>((kProtoMagic >> 8u) & 0xFFu)) {
            pos = (b == static_cast<uint8_t>(kProtoMagic & 0xFFu)) ? 1u : 0u;
            if (pos == 1u) buf[0] = b;
            return false;
        }
        buf[pos++] = b;
        return false;
    }

    buf[pos++] = b;
    if (pos == kProtoHeaderBytes) {
        const uint16_t plen = rd_u16_le(buf + 5);
        if (plen > kProtoMaxPayload) {
            reset();
            ++crc_errors;
            return false;
        }
        expected_total = static_cast<uint32_t>(kProtoHeaderBytes + plen + kProtoCrcBytes);
    }

    if (pos >= kProtoHeaderBytes && pos == expected_total) {
        const uint16_t plen = rd_u16_le(buf + 5);
        const uint16_t got_crc = rd_u16_le(buf + kProtoHeaderBytes + plen);
        const uint16_t exp_crc = crc16_ccitt(buf, kProtoHeaderBytes + plen);
        reset();
        if (got_crc != exp_crc) {
            ++crc_errors;
            return false;
        }
        ++frames_ok;
        out_frame.type = static_cast<ProtoMsgType>(buf[2]);
        out_frame.seq = rd_u16_le(buf + 3);
        out_frame.len = plen;
        out_frame.payload = buf + kProtoHeaderBytes;
        return true;
    }
    return false;
}

// ============================================================================
// Кодек сохранений MSV1 (с защитой от битых файлов и CRC32)
// ============================================================================

size_t sim_save_msv1(const SimWorld& w, uint8_t* out_buf, size_t out_cap) noexcept {
    if (!w.hot || !w.map || !out_buf) return 0u;
    const size_t cells = static_cast<size_t>(w.map->width) * static_cast<size_t>(w.map->height);
    const size_t need = 16u + 128u + cells * 3u + kMaxBuildings * 32u + 4u;
    if (out_cap < need) return 0u;

    size_t p = 0u;
    wr_u32_le(out_buf + p, kSaveMagicMsv1); p += 4u;
    wr_u16_le(out_buf + p, 1u); p += 2u; // version
    wr_u16_le(out_buf + p, w.map->width); p += 2u;
    wr_u16_le(out_buf + p, w.map->height); p += 2u;
    wr_u16_le(out_buf + p, w.hot->sector_preset_id); p += 2u;
    wr_u32_le(out_buf + p, w.hot->tick); p += 4u;

    wr_u16_le(out_buf + p, w.hot->wave); p += 2u;
    wr_u16_le(out_buf + p, w.hot->win_wave); p += 2u;
    wr_u32_le(out_buf + p, w.hot->wave_countdown_ticks); p += 4u;
    out_buf[p++] = w.hot->flags;
    out_buf[p++] = 0u;
    wr_i16_le(out_buf + p, w.hot->core_x); p += 2u;
    wr_i16_le(out_buf + p, w.hot->core_y); p += 2u;
    wr_i16_le(out_buf + p, w.hot->spawn_x); p += 2u;
    wr_i16_le(out_buf + p, w.hot->spawn_y); p += 2u;
    wr_u64_le(out_buf + p, w.hot->rng.state); p += 8u;
    wr_i32_le(out_buf + p, w.hot->power_stored_units); p += 4u;

    for (size_t i = 0; i < kItemCount; ++i) {
        wr_i32_le(out_buf + p, w.hot->core_items[i]);
        p += 4u;
    }

    memcpy(out_buf + p, w.map->floor, cells); p += cells;
    memcpy(out_buf + p, w.map->ore, cells); p += cells;
    memcpy(out_buf + p, w.map->wall, cells); p += cells;

    uint16_t b_cnt = 0u;
    const size_t b_cnt_off = p;
    wr_u16_le(out_buf + p, 0u); p += 2u;
    for (size_t i = 0; i < kMaxBuildings; ++i) {
        const SimBuilding& b = w.hot->buildings[i];
        if (!b.active) continue;
        wr_u16_le(out_buf + p + 0, b.id);
        wr_u16_le(out_buf + p + 2, b.block_id);
        wr_i16_le(out_buf + p + 4, b.x);
        wr_i16_le(out_buf + p + 6, b.y);
        wr_i16_le(out_buf + p + 8, b.hp);
        out_buf[p + 10] = b.rotation;
        out_buf[p + 11] = b.team;
        out_buf[p + 12] = b.config_item;
        out_buf[p + 13] = b.item_id;
        out_buf[p + 14] = b.item_count;
        out_buf[p + 15] = b.aux_item_id;
        out_buf[p + 16] = b.aux_item_count;
        out_buf[p + 17] = b.liquid_id;
        wr_u16_le(out_buf + p + 18, b.liquid_q8);
        wr_u16_le(out_buf + p + 20, b.progress_ticks);
        wr_u16_le(out_buf + p + 22, b.cooldown_ticks);
        p += 24u;
        ++b_cnt;
    }
    wr_u16_le(out_buf + b_cnt_off, b_cnt);

    Crc32 crc;
    for (size_t i = 0; i < p; ++i) crc.feed_u8(out_buf[i]);
    wr_u32_le(out_buf + p, crc.finish());
    p += 4u;
    return p;
}

bool sim_load_msv1(SimWorld& w, const uint8_t* data, size_t len) noexcept {
    if (!w.hot || !w.map || !data || len < 140u) return false;
    if (rd_u32_le(data + 0) != kSaveMagicMsv1) return false;
    if (rd_u16_le(data + 4) != 1u) return false;

    Crc32 crc;
    for (size_t i = 0; i < len - 4u; ++i) crc.feed_u8(data[i]);
    if (crc.finish() != rd_u32_le(data + len - 4u)) return false;

    const uint16_t mw = rd_u16_le(data + 6);
    const uint16_t mh = rd_u16_le(data + 8);
    if (mw == 0u || mw > kMaxMapDim || mh == 0u || mh > kMaxMapDim) return false;
    const size_t cells = static_cast<size_t>(mw) * static_cast<size_t>(mh);

    const size_t min_len = 16u + 30u + kItemCount * 4u + cells * 3u + 2u + 4u;
    if (len < min_len) return false;

    sim_init_empty(w, mw, mh, kDefaultPrngSeed);
    size_t p = 10u;
    w.hot->sector_preset_id = rd_u16_le(data + p); p += 2u;
    w.hot->tick = rd_u32_le(data + p); p += 4u;
    w.hot->wave = rd_u16_le(data + p); p += 2u;
    w.hot->win_wave = rd_u16_le(data + p); p += 2u;
    w.hot->wave_countdown_ticks = rd_u32_le(data + p); p += 4u;
    w.hot->flags = static_cast<uint8_t>(data[p++] | WORLD_FLAG_FLOW_DIRTY);
    ++p;
    w.hot->core_x = rd_i16_le(data + p); p += 2u;
    w.hot->core_y = rd_i16_le(data + p); p += 2u;
    w.hot->spawn_x = rd_i16_le(data + p); p += 2u;
    w.hot->spawn_y = rd_i16_le(data + p); p += 2u;
    w.hot->rng.reseed(rd_u64_le(data + p)); p += 8u;
    w.hot->power_stored_units = rd_i32_le(data + p); p += 4u;

    for (size_t i = 0; i < kItemCount; ++i) {
        w.hot->core_items[i] = rd_i32_le(data + p);
        p += 4u;
    }

    memcpy(w.map->floor, data + p, cells); p += cells;
    memcpy(w.map->ore, data + p, cells); p += cells;
    memcpy(w.map->wall, data + p, cells); p += cells;

    const uint16_t b_cnt = rd_u16_le(data + p); p += 2u;
    if (b_cnt > kMaxBuildings || p + static_cast<size_t>(b_cnt) * 24u + 4u != len) {
        return false;
    }

    for (uint16_t k = 0u; k < b_cnt; ++k) {
        const uint16_t bid = rd_u16_le(data + p + 0);
        const uint16_t blk = rd_u16_le(data + p + 2);
        const int16_t bx = rd_i16_le(data + p + 4);
        const int16_t by = rd_i16_le(data + p + 6);
        if (bid >= kMaxBuildings || blk >= kBlockCount) return false;
        const int32_t placed = sim_place_block(w, bx, by, blk, data[p + 10], data[p + 11], false);
        if (placed >= 0) {
            SimBuilding& b = w.hot->buildings[placed];
            b.hp = rd_i16_le(data + p + 8);
            b.config_item = data[p + 12];
            b.item_id = data[p + 13];
            b.item_count = data[p + 14];
            b.aux_item_id = data[p + 15];
            b.aux_item_count = data[p + 16];
            b.liquid_id = data[p + 17];
            b.liquid_q8 = rd_u16_le(data + p + 18);
            b.progress_ticks = rd_u16_le(data + p + 20);
            b.cooldown_ticks = rd_u16_le(data + p + 22);
        }
        p += 24u;
    }

    sim_rebuild_flow_field(w);
    return true;
}

} // namespace simcore
