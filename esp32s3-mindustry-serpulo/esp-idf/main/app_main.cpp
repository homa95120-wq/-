/*
 * app_main.cpp — точка входа ESP-IDF для прототипа симуляции Серпуло.
 *
 * Запускает активный сектор на ESP32-S3 и каждую секунду выводит краткую
 * статистику в лог (пока без дисплея — headless-сервер для клиента на ПК).
 *
 * Статус: технический прототип этапа 4. Код не собран в песочнице
 * (нет ESP-IDF toolchain) — требует проверки на реальной плате.
 */

#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_system.h"
#include "sector_sim.h"

static const char *TAG = "app_main";

static sim_sector_t g_sector;

extern "C" void app_main(void)
{
    ESP_LOGI(TAG, "=== mindserpulo Serpulo server prototype (ESP32-S3) ===");
    ESP_LOGI(TAG, "building heavy-system prototype: conveyors, fluids, power, pathfinding, combat");

    sim_sector_init(&g_sector);

    /* Демонстрационная настройка:
     * - источник воды в левом верхнем углу
     * - трубы прокладываются к центру
     * - генератор и потребитель (турель)
     * - batería
     * - несколько конвейеров
     * - вражеский юнит и своя турель (бой)
     */

    /* Вода: источник */
    fluid_place(&g_sector.fluids, 2, 2, PIPE_NORMAL);
    fluid_set_source(&g_sector.fluids, 2, 2, 1); /* liquid id 1 = water */
    /* трубы до центра */
    for (int x = 3; x <= 20; x++) {
        fluid_place(&g_sector.fluids, x, 2, PIPE_NORMAL);
    }
    fluid_place(&g_sector.fluids, 20, 2, PIPE_TANK);

    /* Электричество: генератор, батарея, турель-потребитель */
    power_place(&g_sector.power, 10, 10, POWER_PRODUCER, 100.0f, 0.0f, 0.0f);
    power_place(&g_sector.power, 12, 10, POWER_BATTERY, 0.0f, 0.0f, 500.0f);
    power_place(&g_sector.power, 14, 10, POWER_CONSUMER, 0.0f, 40.0f, 0.0f);

    /* Конвейеры: линейка от (5,5) вправо */
    for (int x = 5; x <= 15; x++) {
        conv_place(&g_sector.conveyors, x, 5, CONV_DIR_RIGHT);
    }
    /* предмет на первом конвейере */
    conv_segment_t *s = &g_sector.conveyors.seg[2 * SIM_MAX_WIDTH + 5];
    s->item.item = 1;   /* copper */
    s->item.amount = 50;
    s->progress = 100;

    /* Бой: своя турель (потребитель уже есть на 14,10) и вражеский юнит */
    combat_spawn_unit(&g_sector, 1, 200.0f, 200.0f, 100.0f, 0.0f, 0.0f, false, true);
    /* выстрел по врагу */
    combat_spawn_projectile(&g_sector, PROJ_BULLET, 140.0f, 100.0f, 200.0f, 200.0f, 25.0f, 60.0f, 300.0f);

    /* Поиск пути: от юнита к тайлу (20,2) — через A* */
    pf_path_t path;
    bool ok = pf_find(25, 25, 20, 2,
                      sim_sector_walkable, NULL, &path);
    if (ok) {
        ESP_LOGI(TAG, "path found: %d cells", path.len);
    } else {
        ESP_LOGW(TAG, "no path found (expected: buildings/walls may block)");
    }

    /* Главный цикл симуляции: 30 тиков в секунду (33.3 мс) */
    const TickType_t tick_period = pdMS_TO_TICKS(33);
    uint32_t sec_counter = 0;

    for (;;) {
        sim_sector_tick(&g_sector, 1.0f / 30.0f);
        sec_counter++;

        if (sec_counter % 30 == 0) {
            /* каждую секунду выводим статистику */
            float deficit = power_deficit(&g_sector.power);
            ESP_LOGI(TAG,
                     "tick=%u wave=%u active=%d "
                     "conv=%u fluid=%u power=%.1f/%.1f deficit=%.0f%% "
                     "units=%u projs=%u",
                     g_sector.state.tick, g_sector.state.wave,
                     g_sector.state.wave_active ? 1 : 0,
                     g_sector.conveyors.count,
                     g_sector.fluids.count,
                     g_sector.power.total_produce, g_sector.power.total_consume,
                     deficit * 100.0f,
                     g_sector.combat.unit_count,
                     g_sector.combat.proj_count);
        }

        vTaskDelay(tick_period);
    }
}
