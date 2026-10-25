// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <stdint.h>
#include "simcore/simcore.hpp"

namespace server_esp {

struct ServerConfig {
    const char* wifi_ssid     = "Mindustry-S3";
    const char* wifi_pass     = "serpulo123";
    uint16_t    tcp_port      = 26789u;
    uint8_t     tick_hz       = 30u;
    bool        enable_wifi   = true;
    bool        enable_serial = true;
};

bool init(const ServerConfig& cfg) noexcept;

// Принимает входящие кадры 0x4D53 (TCP и USB/UART) и отправляет снапшот подключённому ПК-клиенту
void poll_and_broadcast(simcore::SimWorld& world, uint32_t last_tick_us) noexcept;

bool has_active_serial_client() noexcept;
bool has_active_tcp_client() noexcept;

} // namespace server_esp
