// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "simcore/protocol.hpp"
#include "simcore/simcore.hpp"

namespace client_net {

enum class TransportKind : uint8_t {
    None   = 0u,
    Tcp    = 1u,
    Serial = 2u,
};

struct InterpEntity {
    bool   valid = false;
    double prev_x = 0.0;
    double prev_y = 0.0;
    double curr_x = 0.0;
    double curr_y = 0.0;
};

class RemoteLink {
public:
    RemoteLink() noexcept;
    ~RemoteLink() noexcept;

    RemoteLink(const RemoteLink&) = delete;
    RemoteLink& operator=(const RemoteLink&) = delete;

    bool connect_tcp(const char* host, uint16_t port) noexcept;
    bool connect_serial(const char* port_name, uint32_t baud = 115200u) noexcept;
    void disconnect() noexcept;

    bool is_connected() const noexcept { return kind_ != TransportKind::None; }
    TransportKind kind() const noexcept { return kind_; }
    const char* endpoint_label() const noexcept { return label_; }

    // Неблокирующий приём кадров с ESP32-S3 / TCP-сервера + периодический PING
    void poll(simcore::SimWorld& remote_world, uint64_t now_us) noexcept;

    // Отправка команды игрока по протоколу 0x4D53
    bool send_command(const simcore::SimCommand& cmd) noexcept;

    // Коэффициент интерполяции [0..1] между двумя последними снапшотами сервера
    double interp_alpha(uint64_t now_us) const noexcept;
    void   interpolated_unit_pos(size_t idx, double alpha, double& out_x, double& out_y) const noexcept;
    void   interpolated_proj_pos(size_t idx, double alpha, double& out_x, double& out_y) const noexcept;

    uint32_t rtt_us() const noexcept { return rtt_us_; }
    uint32_t server_tick_us() const noexcept { return server_tick_us_; }
    double   rx_kbps() const noexcept { return rx_kbps_; }
    uint32_t rx_frames() const noexcept { return parser_.frames_ok; }
    uint32_t crc_errors() const noexcept { return parser_.crc_errors; }

private:
    bool raw_send(const uint8_t* data, size_t len) noexcept;
    int  raw_recv(uint8_t* buf, size_t cap) noexcept;

    TransportKind              kind_ = TransportKind::None;
    intptr_t                   handle_ = -1;
    uint16_t                   tx_seq_ = 1u;
    uint8_t                    server_hz_ = 30u;
    uint64_t                   last_ping_us_ = 0u;
    uint64_t                   last_snap_us_ = 0u;
    uint64_t                   snap_interval_us_ = 33333u;
    uint64_t                   bw_window_start_us_ = 0u;
    uint64_t                   bw_bytes_accum_ = 0u;
    double                     rx_kbps_ = 0.0;
    uint32_t                   rtt_us_ = 0u;
    uint32_t                   server_tick_us_ = 0u;
    char                       label_[96]{};
    simcore::ProtoStreamParser parser_{};
    uint8_t                    tx_buf_[1024]{};
    InterpEntity               unit_interp_[simcore::kMaxUnits]{};
    InterpEntity               proj_interp_[simcore::kMaxProjectiles]{};
};

} // namespace client_net
