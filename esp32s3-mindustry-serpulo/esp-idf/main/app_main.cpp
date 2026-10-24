/*
 * app_main.cpp — точка входа ESP-IDF для прототипа симуляции Серпуло.
 *
 * Запускает активный сектор на ESP32-S3 и каждую секунду выводит краткую
 * статистику в лог (пока без дисплея — headless-сервер для клиента на ПК).
 *
 * Память: структура сектора занимает ~1.4 МБ (карта 128x128 + сети
 * конвейеров/труб/энергии), поэтому она целиком размещается в PSRAM
 * (N16R8 = 8 МБ Octal PSRAM). Внутренняя SRAM остаётся под стек, FreeRTOS
 * и служебные буферы подсистем.
 *
 * Статус: технический прототип. Проверен сборкой ESP-IDF; поведение на
 * реальной плате требует замера (этап 5 дорожной карты).
 */

#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_heap_caps.h"
#include "sector_sim.h"

static const char *TAG = "app_main";

static sim_sector_t *g_sector = NULL;

/* Сектор слишком велик для внутренней SRAM (512 КБ) — берём PSRAM,
 * при её отсутствии честно сообщаем и пробуем обычную кучу. */
static sim_sector_t *alloc_sector(void)
{
    const size_t need = sizeof(sim_sector_t);

    sim_sector_t *s = (sim_sector_t *)heap_caps_malloc(need, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (s) {
        ESP_LOGI(TAG, "sector struct: %u bytes in PSRAM", (unsigned)need);
        return s;
    }

    ESP_LOGW(TAG, "PSRAM allocation of %u bytes failed — retrying in internal RAM", (unsigned)need);
    s = (sim_sector_t *)heap_caps_malloc(need, MALLOC_CAP_8BIT);
    if (s) {
        ESP_LOGW(TAG, "sector struct: %u bytes in internal RAM (PSRAM missing?)", (unsigned)need);
    }
    return s;
}

extern "C" void app_main(void)
{
    ESP_LOGI(TAG, "=== mindserpulo: Serpulo simulation prototype (ESP32-S3) ===");
    ESP_LOGI(TAG, "free PSRAM: %u bytes, free internal: %u bytes",
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
             (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL));

    g_sector = alloc_sector();
    if (!g_sector) {
        ESP_LOGE(TAG, "not enough RAM for the sector (%u bytes needed)",
                 (unsigned)sizeof(sim_sector_t));
        for (;;) {
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }

    sim_sector_init(g_sector);

    /* --- Демонстрационная настройка сектора --- */

    /* Вода: источник в левом верхнем углу и трубы до резервуара */
    fluid_place(&g_sector->fluids, 2, 2, PIPE_NORMAL);
    fluid_set_source(&g_sector->fluids, 2, 2, 1); /* liquid id 1 = water */
    for (int x = 3; x <= 20; x++) {
        fluid_place(&g_sector->fluids, x, 2, PIPE_NORMAL);
    }
    fluid_place(&g_sector->fluids, 20, 2, PIPE_TANK);

    /* Электричество: генератор, батарея, потребитель (турель) */
    power_place(&g_sector->power, 10, 10, POWER_PRODUCER, 100.0f, 0.0f, 0.0f);
    power_place(&g_sector->power, 12, 10, POWER_BATTERY, 0.0f, 0.0f, 500.0f);
    power_place(&g_sector->power, 14, 10, POWER_CONSUMER, 0.0f, 40.0f, 0.0f);

    /* Конвейеры: линейка от (5,5) вправо */
    for (int x = 5; x <= 15; x++) {
        conv_place(&g_sector->conveyors, x, 5, CONV_DIR_RIGHT);
    }
    /* предмет на первом конвейере (y = 5, x = 5) */
    conv_segment_t *c = &g_sector->conveyors.seg[5 * SIM_MAX_WIDTH + 5];
    c->item.item = 1;   /* copper */
    c->item.amount = 50;
    c->progress = 100;

    /* Бой: вражеский юнит и выстрел по нему */
    combat_spawn_unit(&g_sector->combat, 1, 200.0f, 200.0f, 100.0f, 0.0f, 0.0f, false, true);
    combat_spawn_projectile(&g_sector->combat, PROJ_BULLET,
                            140.0f, 100.0f, 200.0f, 200.0f, 25.0f, 60.0f, 300.0f);

    /* Поиск пути: от (25,25) к тайлу (20,2) через A* */
    pf_path_t path;
    bool ok = pf_find(25, 25, 20, 2, sim_sector_walkable, g_sector, &path);
    if (ok) {
        ESP_LOGI(TAG, "path found: %u cells", (unsigned)path.len);
    } else {
        ESP_LOGW(TAG, "no path found (expected: buildings/walls may block)");
    }

    /* Главный цикл симуляции: 30 тиков в секунду (33.3 мс) */
    const TickType_t tick_period = pdMS_TO_TICKS(33);
    uint32_t sec_counter = 0;

    for (;;) {
        sim_sector_tick(g_sector, 1.0f / 30.0f);
        sec_counter++;

        if (sec_counter % 30 == 0) {
            float deficit = power_deficit(&g_sector->power);
            ESP_LOGI(TAG,
                     "tick=%u wave=%u active=%d "
                     "conv=%u fluid=%u power=%.1f/%.1f deficit=%.0f%% "
                     "units=%u projs=%u",
                     (unsigned)g_sector->state.tick,
                     (unsigned)g_sector->state.wave,
                     g_sector->state.wave_active ? 1 : 0,
                     (unsigned)g_sector->conveyors.count,
                     (unsigned)g_sector->fluids.count,
                     g_sector->power.total_produce,
                     g_sector->power.total_consume,
                     deficit * 100.0f,
                     (unsigned)g_sector->combat.unit_count,
                     (unsigned)g_sector->combat.proj_count);
        }

        vTaskDelay(tick_period);
    }
}
