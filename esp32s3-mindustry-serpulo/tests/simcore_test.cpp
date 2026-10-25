// SPDX-License-Identifier: GPL-3.0-or-later
#include <inttypes.h>
#include <memory>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>

#include "simcore/protocol.hpp"
#include "simcore/save_msv1.hpp"
#include "simcore/simcore.hpp"

namespace {

int g_failures = 0;

#define SIM_EXPECT(cond, msg)                                                              \
    do {                                                                                   \
        if (!(cond)) {                                                                     \
            fprintf(stderr, "[FAIL] %s:%d: %s\n", __FILE__, __LINE__, (msg));              \
            ++g_failures;                                                                  \
        }                                                                                  \
    } while (0)

#define SIM_EXPECT_EQ(a, b, msg)                                                           \
    do {                                                                                   \
        const auto _va = (a);                                                              \
        const auto _vb = (b);                                                              \
        if (_va != _vb) {                                                                  \
            fprintf(stderr, "[FAIL] %s:%d: %s (got %lld, expected %lld)\n",                \
                    __FILE__, __LINE__, (msg),                                             \
                    static_cast<long long>(_va), static_cast<long long>(_vb));             \
            ++g_failures;                                                                  \
        }                                                                                  \
    } while (0)

void test_q16_and_trig_lut() {
    using namespace simcore;
    SIM_EXPECT_EQ(fx_from_int(1), 65536, "1.0 in Q16.16");
    SIM_EXPECT_EQ(fx_mul(fx_from_int(3), kFxHalf), 98304, "3.0 * 0.5 = 1.5");
    SIM_EXPECT_EQ(fx_div(fx_from_int(3), fx_from_int(2)), 98304, "3.0 / 2.0 = 1.5");
    SIM_EXPECT_EQ(fx_sqrt(fx_from_int(9)), fx_from_int(3), "sqrt(9.0) = 3.0");
    SIM_EXPECT_EQ(fx_dist(fx_from_int(3), fx_from_int(4)), fx_from_int(5), "hypot(3,4) = 5");

    SIM_EXPECT_EQ(fx_sin_bam10(0u), 0, "sin(0) == 0");
    SIM_EXPECT_EQ(fx_sin_bam10(256u), 65536, "sin(pi/2) == 1.0");
    SIM_EXPECT_EQ(fx_sin_bam10(512u), 0, "sin(pi) == 0");
    SIM_EXPECT_EQ(fx_sin_bam10(768u), -65536, "sin(3pi/2) == -1.0");
    SIM_EXPECT_EQ(fx_cos_bam10(0u), 65536, "cos(0) == 1.0");

    // Проверка тождества sin^2 + cos^2 ~= 1.0 на всех 1024 углах
    for (uint32_t a = 0; a < kTrigLutSize; ++a) {
        const fx32_t s = fx_sin_bam10(a);
        const fx32_t c = fx_cos_bam10(a);
        const fx32_t norm = fx_mul(s, s) + fx_mul(c, c);
        SIM_EXPECT(fx_abs(norm - kFxOne) <= 8, "Pythagorean LUT accuracy within 8 LSB");
    }
}

void test_content_tables_v160_7() {
    using namespace simcore;
    SIM_EXPECT_EQ(kItemCount, 22u, "22 items from Items.java v160.7");
    SIM_EXPECT_EQ(kLiquidCount, 11u, "11 liquids from Liquids.java v160.7");
    SIM_EXPECT_EQ(kSectorPresetCount, 29u, "29 Serpulo sector presets from SectorPresets.java v160.7");

    size_t serpulo_cnt = 0;
    for (size_t i = 0; i < kItemCount; ++i) {
        if ((kItemsTable[i].flags & ITEM_FLAG_SERPULO) != 0u) ++serpulo_cnt;
    }
    SIM_EXPECT_EQ(serpulo_cnt, 16u, "Exactly 16 serpuloItems");
    SIM_EXPECT_EQ(kItemsTable[static_cast<size_t>(ItemId::Copper)].cost_q16, 32768, "Copper cost 0.5");
    SIM_EXPECT_EQ(kItemsTable[static_cast<size_t>(ItemId::SporePod)].flammability_q16, 75366, "SporePod flammability 1.15");
    SIM_EXPECT_EQ(kSectorsTable[0].sector_num, 15, "Ground Zero is sector 15");
    SIM_EXPECT_EQ(kSectorsTable[28].sector_num, 93, "Planetary Terminal is sector 93");
}

void test_golden_hashes_and_100x_replay() {
    using namespace simcore;
    auto hot_a = std::make_unique<SimHotState>();
    auto map_a = std::make_unique<SimMapStorage>();
    auto hot_b = std::make_unique<SimHotState>();
    auto map_b = std::make_unique<SimMapStorage>();

    SimWorld world_a{ hot_a.get(), map_a.get() };
    SimWorld world_b{ hot_b.get(), map_b.get() };

    sim_init_empty(world_a, 128u, 128u, kDefaultPrngSeed);
    SIM_EXPECT_EQ(sim_state_hash_fnv1a64(world_a), kGoldenHashes.empty128_tick0_fnv64,
                  "Golden FNV-1a 64 hash for empty 128x128 map at tick 0");
    SIM_EXPECT_EQ(sim_state_crc32(world_a), kGoldenHashes.empty128_tick0_crc32,
                  "Golden CRC32 for empty 128x128 map at tick 0");

    sim_setup_m0_golden_scenario(world_a);
    sim_step_ticks(world_a, 60u);
    SIM_EXPECT_EQ(sim_state_hash_fnv1a64(world_a), kGoldenHashes.m0_tick60_fnv64,
                  "Golden FNV-1a 64 hash for M0 scenario at tick 60");
    SIM_EXPECT_EQ(sim_state_crc32(world_a), kGoldenHashes.m0_tick60_crc32,
                  "Golden CRC32 for M0 scenario at tick 60");

    sim_step_ticks(world_a, 540u);
    const uint64_t h_tick600 = sim_state_hash_fnv1a64(world_a);
    SIM_EXPECT_EQ(h_tick600, kGoldenHashes.m0_tick600_fnv64,
                  "Golden FNV-1a 64 hash for M0 scenario at tick 600");
    SIM_EXPECT_EQ(world_a.hot->core_items[static_cast<size_t>(ItemId::Copper)], 6,
                  "Exactly 6 copper ore mined and delivered into CoreShard by tick 600");

    // 100 повторных реплеев обязаны дать побитово идентичный финальный хеш
    for (int run = 0; run < 100; ++run) {
        sim_setup_m0_golden_scenario(world_b);
        sim_step_ticks(world_b, 600u);
        if (sim_state_hash_fnv1a64(world_b) != h_tick600) {
            SIM_EXPECT(false, "100-run determinism replay hash mismatch");
            break;
        }
    }
}

void test_power_crafting_and_fluids() {
    using namespace simcore;
    auto hot = std::make_unique<SimHotState>();
    auto map = std::make_unique<SimMapStorage>();
    SimWorld w{ hot.get(), map.get() };
    sim_init_empty(w, 128u, 128u, kDefaultPrngSeed);
    w.hot->wave_countdown_ticks = 999999u;

    // Ядро в (30,30), Кремниевая печь 2x2 в (27,30), конвейер в ядро в (29,30), Солнечные панели
    sim_place_block(w, 30, 30, static_cast<uint16_t>(BlockId::CoreShard), 0u, 0u, false);
    const int32_t sm = sim_place_block(w, 27, 30, static_cast<uint16_t>(BlockId::SiliconSmelter), 0u, 0u, false);
    sim_place_block(w, 29, 30, static_cast<uint16_t>(BlockId::Conveyor), 0u, 0u, false);
    for (int i = 0; i < 6; ++i) {
        sim_place_block(w, static_cast<int16_t>(20 + i), 20, static_cast<uint16_t>(BlockId::SolarPanel), 0u, 0u, false);
    }

    SIM_EXPECT(sm >= 0, "SiliconSmelter placed");
    w.hot->buildings[sm].item_id = static_cast<uint8_t>(ItemId::Coal);
    w.hot->buildings[sm].item_count = 4u;
    w.hot->buildings[sm].aux_item_id = static_cast<uint8_t>(ItemId::Sand);
    w.hot->buildings[sm].aux_item_count = 8u;

    sim_step_ticks(w, 300u);
    SIM_EXPECT(w.hot->core_items[static_cast<size_t>(ItemId::Silicon)] >= 3,
               "SiliconSmelter powered by solar panels crafted Silicon and delivered to CoreShard");
}

void test_save_msv1_and_protocol_0x4d53() {
    using namespace simcore;
    auto hot1 = std::make_unique<SimHotState>();
    auto map1 = std::make_unique<SimMapStorage>();
    auto hot2 = std::make_unique<SimHotState>();
    auto map2 = std::make_unique<SimMapStorage>();
    SimWorld w1{ hot1.get(), map1.get() };
    SimWorld w2{ hot2.get(), map2.get() };

    sim_generate_sector(w1, 4u, 0u); // Biomass Facility
    sim_step_ticks(w1, 120u);

    // 1. Тест сохранения/загрузки MSV1 + защита от битого файла
    std::vector<uint8_t> save_buf(kSaveMaxBytes);
    const size_t slen = sim_save_msv1(w1, save_buf.data(), save_buf.size());
    SIM_EXPECT(slen > 200u, "sim_save_msv1 produced compact binary save");
    SIM_EXPECT(sim_load_msv1(w2, save_buf.data(), slen), "sim_load_msv1 loaded valid save");
    SIM_EXPECT_EQ(w2.hot->tick, w1.hot->tick, "Restored tick matches");
    SIM_EXPECT_EQ(w2.hot->sector_preset_id, w1.hot->sector_preset_id, "Restored sector_preset_id matches");

    save_buf[slen / 2] ^= 0xFFu;
    SIM_EXPECT(!sim_load_msv1(w2, save_buf.data(), slen), "Corrupted MSV1 save rejected by CRC32");

    // 2. Тест бинарного протокола 0x4D53 (побайтовый потоковый парсинг TCP/USB-CDC)
    auto parser = std::make_unique<ProtoStreamParser>();
    std::vector<uint8_t> frame_buf(kProtoMaxFrame);
    sim_init_empty(w2, 128u, 128u, kDefaultPrngSeed);

    for (uint16_t y = 0; y < 128u; y = static_cast<uint16_t>(y + 16u)) {
        const size_t fl = proto_encode_map_chunk(frame_buf.data(), frame_buf.size(), y, w1, y, 16u);
        SIM_EXPECT(fl > 0u, "Encoded MAP_STATIC chunk");
        bool got = false;
        for (size_t b = 0; b < fl; ++b) {
            ProtoParsedFrame fr{};
            if (parser->feed_byte(frame_buf[b], fr)) {
                got = proto_apply_map_chunk(w2, fr.payload, fr.len);
            }
        }
        SIM_EXPECT(got, "Parsed and applied MAP_STATIC chunk");
    }

    const size_t snap_len = proto_encode_snapshot(frame_buf.data(), frame_buf.size(), 99u, w1, true);
    SIM_EXPECT(snap_len > 0u && snap_len < 4096u, "Snapshot fits comfortably within USB-CDC / Wi-Fi budget");
    bool snap_applied = false;
    for (size_t b = 0; b < snap_len; ++b) {
        ProtoParsedFrame fr{};
        if (parser->feed_byte(frame_buf[b], fr)) {
            snap_applied = proto_apply_snapshot(w2, fr.payload, fr.len);
        }
    }
    SIM_EXPECT(snap_applied, "Parsed and applied SNAPSHOT_FULL");
    SIM_EXPECT_EQ(w2.hot->tick, w1.hot->tick, "Client synced world tick via 0x4D53");
    SIM_EXPECT_EQ(w2.hot->active_buildings, w1.hot->active_buildings, "Client synced buildings via 0x4D53");
}

} // namespace

int main() {
    test_q16_and_trig_lut();
    test_content_tables_v160_7();
    test_golden_hashes_and_100x_replay();
    test_power_crafting_and_fluids();
    test_save_msv1_and_protocol_0x4d53();

    if (g_failures == 0) {
        printf("[simcore_test] ALL TESTS PASSED (0 failures).\n");
        return 0;
    }
    fprintf(stderr, "[simcore_test] %d TEST(S) FAILED!\n", g_failures);
    return 1;
}
