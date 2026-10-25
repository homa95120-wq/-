// SPDX-License-Identifier: GPL-3.0-or-later
#include "server_esp.hpp"

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include "driver/uart.h"
#include "esp_event.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "lwip/inet.h"
#include "lwip/sockets.h"
#include "nvs_flash.h"

#include "simcore/protocol.hpp"

namespace server_esp {

namespace {

const char* kTag = "server_esp";

struct ServerRuntime {
    int                         listen_fd = -1;
    int                         client_fd = -1;
    bool                        tcp_need_full_sync = false;
    bool                        serial_active = false;
    bool                        serial_need_full_sync = false;
    uint64_t                    serial_last_rx_us = 0u;
    uint16_t                    tx_seq = 1u;
    uint16_t                    last_sector_id = 0xFFFFu;
    uint32_t                    broadcast_counter = 0u;
    uint8_t                     server_hz = 30u;
    simcore::ProtoStreamParser* tcp_parser = nullptr;
    simcore::ProtoStreamParser* serial_parser = nullptr;
    uint8_t*                    tx_buf = nullptr;
};

ServerRuntime g_srv;

void send_all_tcp(int fd, const uint8_t* data, size_t len) noexcept {
    if (fd < 0 || !data || len == 0u) return;
    size_t sent = 0u;
    int retries = 0;
    while (sent < len && retries < 16) {
        const ssize_t n = ::send(fd, data + sent, len - sent, 0);
        if (n > 0) {
            sent += static_cast<size_t>(n);
        } else if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            ++retries;
        } else {
            ::close(g_srv.client_fd);
            g_srv.client_fd = -1;
            return;
        }
    }
}

void send_all_serial(const uint8_t* data, size_t len) noexcept {
    if (!data || len == 0u) return;
    uart_write_bytes(UART_NUM_0, reinterpret_cast<const char*>(data), len);
}

template <typename SendFn>
void send_initial_sync(simcore::SimWorld& world, SendFn&& send_fn) noexcept {
    if (!g_srv.tx_buf) return;
    const size_t hlen = simcore::proto_encode_hello(
        g_srv.tx_buf, simcore::kProtoMaxFrame, g_srv.tx_seq++,
        world.map->width, world.map->height, g_srv.server_hz, world.hot->sector_preset_id);
    if (hlen > 0u) send_fn(g_srv.tx_buf, hlen);

    // Карта 128x128 передаётся 8 компактными чанками по 16 строк (~6 КБ каждый)
    for (uint16_t y = 0u; y < world.map->height; y = static_cast<uint16_t>(y + 16u)) {
        const size_t mlen = simcore::proto_encode_map_chunk(
            g_srv.tx_buf, simcore::kProtoMaxFrame, g_srv.tx_seq++, world, y, 16u);
        if (mlen > 0u) send_fn(g_srv.tx_buf, mlen);
    }

    const size_t slen = simcore::proto_encode_snapshot(
        g_srv.tx_buf, simcore::kProtoMaxFrame, g_srv.tx_seq++, world, true);
    if (slen > 0u) send_fn(g_srv.tx_buf, slen);
}

template <typename SendFn>
void handle_incoming_frame(const simcore::ProtoParsedFrame& fr,
                           simcore::SimWorld& world,
                           uint32_t last_tick_us,
                           bool& need_full_sync,
                           SendFn&& send_fn) noexcept {
    switch (fr.type) {
        case simcore::ProtoMsgType::Hello:
            need_full_sync = true;
            break;

        case simcore::ProtoMsgType::InputCmd: {
            simcore::SimCommand cmd{};
            if (simcore::proto_decode_cmd(fr.payload, fr.len, cmd)) {
                simcore::sim_push_command(world, cmd);
                if (cmd.type == simcore::SimCmdType::SelectSector) {
                    need_full_sync = true;
                }
            }
            break;
        }

        case simcore::ProtoMsgType::Ping: {
            if (fr.len >= 8u && g_srv.tx_buf != nullptr) {
                const uint64_t t_cli = simcore::rd_u64_le(fr.payload);
                const size_t plen = simcore::proto_encode_pong(
                    g_srv.tx_buf, simcore::kProtoMaxFrame, g_srv.tx_seq++,
                    t_cli, world.hot->tick, last_tick_us);
                if (plen > 0u) send_fn(g_srv.tx_buf, plen);
            }
            break;
        }

        default:
            break;
    }
}

bool start_wifi_softap(const ServerConfig& cfg) noexcept {
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        ret = nvs_flash_init();
    }
    if (ret != ESP_OK) {
        ESP_LOGW(kTag, "NVS init failed (%d), skipping Wi-Fi AP", static_cast<int>(ret));
        return false;
    }

    if (esp_netif_init() != ESP_OK) return false;
    if (esp_event_loop_create_default() != ESP_OK) return false;
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t wcfg = WIFI_INIT_CONFIG_DEFAULT();
    if (esp_wifi_init(&wcfg) != ESP_OK) {
        ESP_LOGW(kTag, "esp_wifi_init failed");
        return false;
    }

    wifi_config_t ap_cfg{};
    const size_t ssid_len = strlen(cfg.wifi_ssid);
    const size_t copy_ssid = (ssid_len < sizeof(ap_cfg.ap.ssid) - 1u) ? ssid_len : (sizeof(ap_cfg.ap.ssid) - 1u);
    memcpy(ap_cfg.ap.ssid, cfg.wifi_ssid, copy_ssid);
    ap_cfg.ap.ssid[copy_ssid] = 0u;
    ap_cfg.ap.ssid_len = static_cast<uint8_t>(copy_ssid);

    const size_t pass_len = strlen(cfg.wifi_pass);
    const size_t copy_pass = (pass_len < sizeof(ap_cfg.ap.password) - 1u) ? pass_len : (sizeof(ap_cfg.ap.password) - 1u);
    memcpy(ap_cfg.ap.password, cfg.wifi_pass, copy_pass);
    ap_cfg.ap.password[copy_pass] = 0u;
    ap_cfg.ap.channel = 6;
    ap_cfg.ap.max_connection = 4;
    ap_cfg.ap.authmode = (copy_pass >= 8u) ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;

    esp_wifi_set_mode(WIFI_MODE_AP);
    esp_wifi_set_config(WIFI_IF_AP, &ap_cfg);
    if (esp_wifi_start() != ESP_OK) {
        ESP_LOGW(kTag, "esp_wifi_start failed");
        return false;
    }

    ESP_LOGI(kTag, "Wi-Fi SoftAP '%s' started -> connect PC client to 192.168.4.1:%u",
             cfg.wifi_ssid, static_cast<unsigned>(cfg.tcp_port));
    return true;
}

bool start_tcp_listener(uint16_t port) noexcept {
    const int fd = ::socket(AF_INET, SOCK_STREAM, IPPROTO_IP);
    if (fd < 0) return false;

    int opt = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    const int flags = ::fcntl(fd, F_GETFL, 0);
    ::fcntl(fd, F_SETFL, flags | O_NONBLOCK);

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(port);

    if (::bind(fd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0 ||
        ::listen(fd, 2) != 0) {
        ::close(fd);
        return false;
    }

    g_srv.listen_fd = fd;
    return true;
}

void alloc_buffers() noexcept {
    auto alloc_any = [](size_t sz) -> void* {
        void* p = heap_caps_malloc(sz, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!p) p = heap_caps_malloc(sz, MALLOC_CAP_8BIT);
        return p;
    };

    g_srv.tx_buf = static_cast<uint8_t*>(alloc_any(simcore::kProtoMaxFrame));
    g_srv.tcp_parser = static_cast<simcore::ProtoStreamParser*>(
        alloc_any(sizeof(simcore::ProtoStreamParser)));
    g_srv.serial_parser = static_cast<simcore::ProtoStreamParser*>(
        alloc_any(sizeof(simcore::ProtoStreamParser)));

    if (g_srv.tcp_parser) {
        g_srv.tcp_parser->reset();
        g_srv.tcp_parser->crc_errors = 0u;
        g_srv.tcp_parser->frames_ok = 0u;
    }
    if (g_srv.serial_parser) {
        g_srv.serial_parser->reset();
        g_srv.serial_parser->crc_errors = 0u;
        g_srv.serial_parser->frames_ok = 0u;
    }
}

} // namespace

bool init(const ServerConfig& cfg) noexcept {
    g_srv.server_hz = cfg.tick_hz;
    alloc_buffers();
    if (!g_srv.tx_buf || !g_srv.tcp_parser || !g_srv.serial_parser) {
        ESP_LOGE(kTag, "Failed to allocate 0x4D53 protocol buffers");
        return false;
    }

    if (cfg.enable_serial) {
        uart_driver_install(UART_NUM_0, 4096, 0, 0, nullptr, 0);
    }

    if (cfg.enable_wifi && start_wifi_softap(cfg)) {
        start_tcp_listener(cfg.tcp_port);
    }
    return true;
}

void poll_and_broadcast(simcore::SimWorld& world, uint32_t last_tick_us) noexcept {
    if (!g_srv.tx_buf) return;

    // 1. Новое TCP-подключение от ПК-клиента
    if (g_srv.listen_fd >= 0) {
        sockaddr_in caddr{};
        socklen_t clen = sizeof(caddr);
        const int nfd = ::accept(g_srv.listen_fd, reinterpret_cast<sockaddr*>(&caddr), &clen);
        if (nfd >= 0) {
            if (g_srv.client_fd >= 0) ::close(g_srv.client_fd);
            int nodelay = 1;
            ::setsockopt(nfd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));
            const int fl = ::fcntl(nfd, F_GETFL, 0);
            ::fcntl(nfd, F_SETFL, fl | O_NONBLOCK);
            g_srv.client_fd = nfd;
            g_srv.tcp_parser->reset();
            g_srv.tcp_need_full_sync = true;
            ESP_LOGI(kTag, "PC TCP client connected (0x4D53 protocol)");
        }
    }

    // 2. Чтение кадров из TCP
    if (g_srv.client_fd >= 0) {
        uint8_t rx[512];
        for (;;) {
            const ssize_t n = ::recv(g_srv.client_fd, rx, sizeof(rx), 0);
            if (n > 0) {
                for (ssize_t i = 0; i < n; ++i) {
                    simcore::ProtoParsedFrame fr{};
                    if (g_srv.tcp_parser->feed_byte(rx[i], fr)) {
                        handle_incoming_frame(fr, world, last_tick_us, g_srv.tcp_need_full_sync,
                            [](const uint8_t* d, size_t l) { send_all_tcp(g_srv.client_fd, d, l); });
                    }
                }
            } else if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK)) {
                ESP_LOGI(kTag, "PC TCP client disconnected");
                ::close(g_srv.client_fd);
                g_srv.client_fd = -1;
                break;
            } else {
                break;
            }
        }
    }

    // 3. Чтение кадров из USB/UART0
    {
        uint8_t srx[256];
        const int sn = uart_read_bytes(UART_NUM_0, srx, sizeof(srx), 0);
        if (sn > 0) {
            for (int i = 0; i < sn; ++i) {
                simcore::ProtoParsedFrame fr{};
                if (g_srv.serial_parser->feed_byte(srx[i], fr)) {
                    g_srv.serial_active = true;
                    g_srv.serial_last_rx_us = static_cast<uint64_t>(esp_timer_get_time());
                    handle_incoming_frame(fr, world, last_tick_us, g_srv.serial_need_full_sync,
                        [](const uint8_t* d, size_t l) { send_all_serial(d, l); });
                }
            }
        }
        if (g_srv.serial_active) {
            const uint64_t now_us = static_cast<uint64_t>(esp_timer_get_time());
            if (now_us - g_srv.serial_last_rx_us > 5000000ULL) {
                g_srv.serial_active = false;
            }
        }
    }

    if (g_srv.last_sector_id != world.hot->sector_preset_id) {
        g_srv.last_sector_id = world.hot->sector_preset_id;
        if (g_srv.client_fd >= 0) g_srv.tcp_need_full_sync = true;
        if (g_srv.serial_active) g_srv.serial_need_full_sync = true;
    }

    ++g_srv.broadcast_counter;
    const bool include_blds = (g_srv.broadcast_counter % 4u == 0u);

    if (g_srv.client_fd >= 0) {
        if (g_srv.tcp_need_full_sync) {
            g_srv.tcp_need_full_sync = false;
            send_initial_sync(world, [](const uint8_t* d, size_t l) { send_all_tcp(g_srv.client_fd, d, l); });
        } else {
            const size_t slen = simcore::proto_encode_snapshot(
                g_srv.tx_buf, simcore::kProtoMaxFrame, g_srv.tx_seq++, world, include_blds);
            if (slen > 0u) send_all_tcp(g_srv.client_fd, g_srv.tx_buf, slen);
        }
    }

    if (g_srv.serial_active) {
        if (g_srv.serial_need_full_sync) {
            g_srv.serial_need_full_sync = false;
            send_initial_sync(world, [](const uint8_t* d, size_t l) { send_all_serial(d, l); });
        } else if ((g_srv.broadcast_counter & 1u) == 0u) {
            // По UART 115200 шлём снапшоты 15 Гц, чтобы гарантировать отсутствие переполнения TX
            const size_t slen = simcore::proto_encode_snapshot(
                g_srv.tx_buf, simcore::kProtoMaxFrame, g_srv.tx_seq++, world, include_blds);
            if (slen > 0u) send_all_serial(g_srv.tx_buf, slen);
        }
    }
}

bool has_active_serial_client() noexcept {
    return g_srv.serial_active;
}

bool has_active_tcp_client() noexcept {
    return g_srv.client_fd >= 0;
}

} // namespace server_esp
