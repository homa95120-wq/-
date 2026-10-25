// SPDX-License-Identifier: GPL-3.0-or-later
/*
 * app_main.cpp — Прошивка авторитарного сервера Mindustry Serpulo для ESP32-S3 N16R8.
 *
 * 1. Размещает горячее состояние SimHotState (~55 КБ) во внутренней быстрой SRAM,
 *    а карту SimMapStorage (~144 КБ) — в Octal PSRAM (с fallback во внутреннюю RAM).
 * 2. Прогоняет стартовый selftest эталонных golden-хешей FNV-1a 64 + CRC32 (Q16.16).
 * 3. Генерирует сектор Серпуло (Ground Zero) со стартовой линией добычи и обороной.
 * 4. Поднимает Wi-Fi SoftAP "Mindustry-S3" (192.168.4.1:26789) и USB/UART0 0x4D53 сервер.
 * 5. Ведёт цикл 30 Гц (по 2 детерминированных тика = эквивалент 60 TPS ПК) с замером esp_timer.
 */

#include <inttypes.h>
#include <stdio.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "server_esp.hpp"
#include "simcore/simcore.hpp"

namespace {

const char* kTag = "mindserpulo";

void setup_starter_outpost(simcore::SimWorld& w) noexcept {
    using namespace simcore;
    const int16_t cx = w.hot->core_x;
    const int16_t cy = w.hot->core_y;

    // Ставим стартовый механический бур на ближайшую медную жилу и ведём конвейер к ядру
    const int16_t drill_x = static_cast<int16_t>(cx - 7);
    const int16_t drill_y = static_cast<int16_t>(cy - 1);
    sim_place_block(w, drill_x, drill_y, static_cast<uint16_t>(BlockId::MechanicalDrill),
                    0u, static_cast<uint8_t>(TeamId::Sharded), false);
    for (int16_t x = static_cast<int16_t>(drill_x + 2); x < cx; ++x) {
        sim_place_block(w, x, drill_y, static_cast<uint16_t>(BlockId::Conveyor),
                        0u, static_cast<uint8_t>(TeamId::Sharded), false);
    }

    // Две турели Duo с боезапасом меди перед ядром для отражения первых волн
    const int32_t t1 = sim_place_block(w, cx, static_cast<int16_t>(cy - 3),
                                       static_cast<uint16_t>(BlockId::Duo), 1u,
                                       static_cast<uint8_t>(TeamId::Sharded), false);
    const int32_t t2 = sim_place_block(w, static_cast<int16_t>(cx + 2), static_cast<int16_t>(cy - 3),
                                       static_cast<uint16_t>(BlockId::Duo), 1u,
                                       static_cast<uint8_t>(TeamId::Sharded), false);
    if (t1 >= 0) {
        w.hot->buildings[t1].item_id = static_cast<uint8_t>(ItemId::Copper);
        w.hot->buildings[t1].item_count = 20u;
    }
    if (t2 >= 0) {
        w.hot->buildings[t2].item_id = static_cast<uint8_t>(ItemId::Copper);
        w.hot->buildings[t2].item_count = 20u;
    }
    sim_rebuild_flow_field(w);
}

void sort_u32(uint32_t* arr, size_t n) noexcept {
    for (size_t i = 1; i < n; ++i) {
        const uint32_t key = arr[i];
        size_t j = i;
        while (j > 0 && arr[j - 1] > key) {
            arr[j] = arr[j - 1];
            --j;
        }
        arr[j] = key;
    }
}

} // namespace

extern "C" void app_main(void) {
    using namespace simcore;

    ESP_LOGI(kTag, "=== Mindustry Serpulo Authoritative Server (ESP32-S3, Q16.16 simcore) ===");
    ESP_LOGI(kTag, "Heap before alloc: internal=%u B, PSRAM=%u B",
             static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
             static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));

    auto* hot = static_cast<SimHotState*>(
        heap_caps_malloc(sizeof(SimHotState), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    if (!hot) {
        hot = static_cast<SimHotState*>(heap_caps_malloc(sizeof(SimHotState), MALLOC_CAP_8BIT));
    }

    auto* map = static_cast<SimMapStorage*>(
        heap_caps_malloc(sizeof(SimMapStorage), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    bool map_in_psram = (map != nullptr);
    if (!map) {
        ESP_LOGW(kTag, "PSRAM unavailable — falling back to internal RAM for SimMapStorage");
        map = static_cast<SimMapStorage*>(heap_caps_malloc(sizeof(SimMapStorage), MALLOC_CAP_8BIT));
    }

    if (!hot || !map) {
        ESP_LOGE(kTag, "Allocation failed (need hot=%u B, map=%u B)",
                 static_cast<unsigned>(sizeof(SimHotState)),
                 static_cast<unsigned>(sizeof(SimMapStorage)));
        for (;;) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }

    ESP_LOGI(kTag, "Allocated SimHotState=%u B (SRAM), SimMapStorage=%u B (%s)",
             static_cast<unsigned>(sizeof(SimHotState)),
             static_cast<unsigned>(sizeof(SimMapStorage)),
             map_in_psram ? "Octal PSRAM" : "Internal RAM");

    SimWorld world{ hot, map };

    const int64_t t_self0 = esp_timer_get_time();
    const bool selftest_ok = sim_run_golden_selftest(world);
    const int64_t t_self1 = esp_timer_get_time();
    ESP_LOGI(kTag, "Determinism Golden Selftest: %s (%" PRId64 " us, tick600_fnv=0x%016" PRIX64 ")",
             selftest_ok ? "PASS" : "FAIL",
             (t_self1 - t_self0),
             kGoldenHashes.m0_tick600_fnv64);

    sim_generate_sector(world, 0u, 0u); // Сектор 15: Ground Zero (Отправная точка)
    setup_starter_outpost(world);

    server_esp::ServerConfig scfg{};
    server_esp::init(scfg);

    ESP_LOGI(kTag, "Heap after init: internal=%u B, PSRAM=%u B",
             static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_INTERNAL)),
             static_cast<unsigned>(heap_caps_get_free_size(MALLOC_CAP_SPIRAM)));

    uint32_t samples_us[30] = {};
    size_t sample_idx = 0u;
    uint32_t last_frame_us = 0u;

    for (;;) {
        const int64_t frame_start = esp_timer_get_time();

        // 2 подшага по 60 TPS за один кадр 30 Гц -> точный паритет скорости с ПК
        sim_step_ticks(world, 2u);
        const int64_t sim_done = esp_timer_get_time();
        last_frame_us = static_cast<uint32_t>(sim_done - frame_start);

        server_esp::poll_and_broadcast(world, last_frame_us);

        samples_us[sample_idx++] = last_frame_us;
        if (sample_idx >= 30u) {
            sample_idx = 0u;
            sort_u32(samples_us, 30u);
            const uint32_t p50 = samples_us[15];
            const uint32_t p99 = samples_us[29];

            if (!server_esp::has_active_serial_client()) {
                ESP_LOGI(kTag,
                         "tick=%" PRIu32 " wave=%u/%u bld=%u unit=%u proj=%u "
                         "cu=%" PRId32 " pwr=%" PRId32 "/%" PRId32 " "
                         "sim_us(p50=%" PRIu32 " max=%" PRIu32 ") client=%s",
                         world.hot->tick,
                         static_cast<unsigned>(world.hot->wave),
                         static_cast<unsigned>(world.hot->win_wave),
                         static_cast<unsigned>(world.hot->active_buildings),
                         static_cast<unsigned>(world.hot->active_units),
                         static_cast<unsigned>(world.hot->active_projectiles),
                         world.hot->core_items[static_cast<size_t>(ItemId::Copper)],
                         fx_to_int_round(world.hot->power_produced_q16),
                         fx_to_int_round(world.hot->power_consumed_q16),
                         p50, p99,
                         server_esp::has_active_tcp_client() ? "TCP" : "idle");
            }
        }

        const int64_t elapsed_ms = (esp_timer_get_time() - frame_start) / 1000;
        const int32_t wait_ms = 33 - static_cast<int32_t>(elapsed_ms);
        vTaskDelay(pdMS_TO_TICKS(wait_ms > 1 ? wait_ms : 1));
    }
}
