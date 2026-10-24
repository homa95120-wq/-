/*
 * mindserpulo — самостоятельная переосмысленная реализация планеты Серпуло
 * из Mindustry (v160.7, коммит 17012d61) для ESP32-S3 N16R8.
 *
 * СТАТУС: только заготовка (stub). Реализация начинается после этапа 5
 * дорожной карты (замеры на реальной плате) и согласования архитектуры.
 * Проект не претендует на статус «полного порта» до подтверждения тестами.
 *
 * Лицензия: GNU GPL v3 (произведение, основанное на Mindustry, см. LICENSE).
 */

#include <esp_log.h>
#include <esp_system.h>
#include <esp_chip_info.h>
#include <esp_flash.h>

static const char *TAG = "mindserpulo";

void app_main(void)
{
    esp_chip_info_t chip_info;
    uint32_t flash_size;
    esp_chip_info(&chip_info);
    esp_flash_get_size(NULL, &flash_size);

    ESP_LOGI(TAG, "mindserpulo stub — ESP32-S3 Serpulo reimagining");
    ESP_LOGI(TAG, "cores: %d, revision: %d", chip_info.cores, chip_info.revision);
    ESP_LOGI(TAG, "flash: %" PRIu32 " MB", flash_size / (1024 * 1024));
    ESP_LOGI(TAG, "features: %s%s%s%s%s%s",
             chip_info.features & CHIP_FEATURE_EMB_FLASH ? "/embedded-flash" : "",
             chip_info.features & CHIP_FEATURE_WIFI_BGN ? "/wifi-bgn" : "",
             chip_info.features & CHIP_FEATURE_BLE ? "/ble" : "",
             chip_info.features & CHIP_FEATURE_BT ? "/bt" : "",
             chip_info.features & CHIP_FEATURE_IEEE802154 ? "/ieee802154" : "",
             chip_info.features & CHIP_FEATURE_SPIRAM ? "/spiram" : "");

    ESP_LOGW(TAG, "реализация симуляции Серпуло ещё не начата (см. roadmap в README.md)");

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(1000));
    }
}
