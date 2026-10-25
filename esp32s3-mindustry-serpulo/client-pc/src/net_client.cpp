// SPDX-License-Identifier: GPL-3.0-or-later
#include "net_client.hpp"

#include <stdio.h>
#include <string.h>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#else
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <termios.h>
#include <unistd.h>
#endif

namespace client_net {

namespace {
#ifdef _WIN32
void ensure_winsock() noexcept {
    static bool s_init = false;
    if (!s_init) {
        WSADATA wsa{};
        WSAStartup(MAKEWORD(2, 2), &wsa);
        s_init = true;
    }
}
#endif
} // namespace

RemoteLink::RemoteLink() noexcept = default;

RemoteLink::~RemoteLink() noexcept {
    disconnect();
}

void RemoteLink::disconnect() noexcept {
    if (kind_ == TransportKind::Tcp && handle_ != -1) {
#ifdef _WIN32
        closesocket(static_cast<SOCKET>(handle_));
#else
        ::close(static_cast<int>(handle_));
#endif
    } else if (kind_ == TransportKind::Serial && handle_ != -1) {
#ifdef _WIN32
        CloseHandle(reinterpret_cast<HANDLE>(handle_));
#else
        ::close(static_cast<int>(handle_));
#endif
    }
    kind_ = TransportKind::None;
    handle_ = -1;
    label_[0] = '\0';
}

bool RemoteLink::connect_tcp(const char* host, uint16_t port) noexcept {
    disconnect();
    if (!host || !host[0]) return false;

#ifdef _WIN32
    ensure_winsock();
#endif

    char port_str[16];
    snprintf(port_str, sizeof(port_str), "%u", static_cast<unsigned>(port));

    addrinfo hints{};
    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    addrinfo* res = nullptr;
    if (getaddrinfo(host, port_str, &hints, &res) != 0 || !res) {
        return false;
    }

#ifdef _WIN32
    SOCKET s = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (s == INVALID_SOCKET) {
        freeaddrinfo(res);
        return false;
    }
    if (connect(s, res->ai_addr, static_cast<int>(res->ai_addrlen)) != 0) {
        closesocket(s);
        freeaddrinfo(res);
        return false;
    }
    BOOL nodelay = TRUE;
    setsockopt(s, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&nodelay), sizeof(nodelay));
    u_long nonblock = 1;
    ioctlsocket(s, FIONBIO, &nonblock);
    handle_ = static_cast<intptr_t>(s);
#else
    int s = ::socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (s < 0) {
        freeaddrinfo(res);
        return false;
    }
    if (::connect(s, res->ai_addr, res->ai_addrlen) != 0) {
        ::close(s);
        freeaddrinfo(res);
        return false;
    }
    int nodelay = 1;
    ::setsockopt(s, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));
    const int fl = ::fcntl(s, F_GETFL, 0);
    ::fcntl(s, F_SETFL, fl | O_NONBLOCK);
    handle_ = static_cast<intptr_t>(s);
#endif

    freeaddrinfo(res);
    kind_ = TransportKind::Tcp;
    parser_.reset();
    parser_.frames_ok = 0u;
    parser_.crc_errors = 0u;
    for (auto& u : unit_interp_) u.valid = false;
    for (auto& p : proj_interp_) p.valid = false;
    snprintf(label_, sizeof(label_), "TCP %s:%u", host, static_cast<unsigned>(port));

    // Отправляем HELLO для запроса полной синхронизации карты и снапшота
    const size_t hlen = simcore::proto_encode_hello(
        tx_buf_, sizeof(tx_buf_), tx_seq_++, 128u, 128u, 60u, 0u);
    if (hlen > 0u) raw_send(tx_buf_, hlen);
    return true;
}

bool RemoteLink::connect_serial(const char* port_name, uint32_t baud) noexcept {
    disconnect();
    if (!port_name || !port_name[0]) return false;

#ifdef _WIN32
    char full_name[64];
    if (strncmp(port_name, "\\\\.\\", 4) == 0) {
        snprintf(full_name, sizeof(full_name), "%s", port_name);
    } else {
        snprintf(full_name, sizeof(full_name), "\\\\.\\%s", port_name);
    }
    HANDLE h = CreateFileA(full_name, GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                           OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;

    DCB dcb{};
    dcb.DCBlength = sizeof(dcb);
    if (!GetCommState(h, &dcb)) {
        CloseHandle(h);
        return false;
    }
    dcb.BaudRate = baud;
    dcb.ByteSize = 8;
    dcb.StopBits = ONESTOPBIT;
    dcb.Parity = NOPARITY;
    dcb.fBinary = TRUE;
    dcb.fDtrControl = DTR_CONTROL_ENABLE;
    dcb.fRtsControl = RTS_CONTROL_ENABLE;
    SetCommState(h, &dcb);

    COMMTIMEOUTS to{};
    to.ReadIntervalTimeout = MAXDWORD;
    to.ReadTotalTimeoutMultiplier = 0;
    to.ReadTotalTimeoutConstant = 0;
    to.WriteTotalTimeoutMultiplier = 0;
    to.WriteTotalTimeoutConstant = 20;
    SetCommTimeouts(h, &to);
    handle_ = reinterpret_cast<intptr_t>(h);
#else
    const int fd = ::open(port_name, O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (fd < 0) return false;
    termios tio{};
    if (tcgetattr(fd, &tio) == 0) {
        cfmakeraw(&tio);
        speed_t sp = B115200;
#ifdef B921600
        if (baud >= 921600u) sp = B921600;
#endif
#ifdef B460800
        else if (baud >= 460800u) sp = B460800;
#endif
        cfsetispeed(&tio, sp);
        cfsetospeed(&tio, sp);
        tio.c_cflag |= (CLOCAL | CREAD);
        tio.c_cc[VMIN] = 0;
        tio.c_cc[VTIME] = 0;
        tcsetattr(fd, TCSANOW, &tio);
    }
    handle_ = static_cast<intptr_t>(fd);
#endif

    kind_ = TransportKind::Serial;
    parser_.reset();
    parser_.frames_ok = 0u;
    parser_.crc_errors = 0u;
    for (auto& u : unit_interp_) u.valid = false;
    for (auto& p : proj_interp_) p.valid = false;
    snprintf(label_, sizeof(label_), "USB-Serial %s @ %u", port_name, static_cast<unsigned>(baud));

    const size_t hlen = simcore::proto_encode_hello(
        tx_buf_, sizeof(tx_buf_), tx_seq_++, 128u, 128u, 60u, 0u);
    if (hlen > 0u) raw_send(tx_buf_, hlen);
    return true;
}

bool RemoteLink::raw_send(const uint8_t* data, size_t len) noexcept {
    if (kind_ == TransportKind::None || handle_ == -1 || !data || len == 0u) return false;
    if (kind_ == TransportKind::Tcp) {
        size_t sent = 0u;
        while (sent < len) {
#ifdef _WIN32
            const int n = send(static_cast<SOCKET>(handle_),
                               reinterpret_cast<const char*>(data + sent),
                               static_cast<int>(len - sent), 0);
            if (n > 0) sent += static_cast<size_t>(n);
            else if (WSAGetLastError() == WSAEWOULDBLOCK) continue;
            else { disconnect(); return false; }
#else
            const ssize_t n = ::send(static_cast<int>(handle_), data + sent, len - sent, 0);
            if (n > 0) sent += static_cast<size_t>(n);
            else if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue;
            else { disconnect(); return false; }
#endif
        }
        return true;
    } else {
#ifdef _WIN32
        DWORD written = 0;
        return WriteFile(reinterpret_cast<HANDLE>(handle_), data, static_cast<DWORD>(len), &written, nullptr) != 0;
#else
        const ssize_t n = ::write(static_cast<int>(handle_), data, len);
        return n == static_cast<ssize_t>(len);
#endif
    }
}

int RemoteLink::raw_recv(uint8_t* buf, size_t cap) noexcept {
    if (kind_ == TransportKind::None || handle_ == -1) return -1;
    if (kind_ == TransportKind::Tcp) {
#ifdef _WIN32
        const int n = recv(static_cast<SOCKET>(handle_), reinterpret_cast<char*>(buf), static_cast<int>(cap), 0);
        if (n > 0) return n;
        if (n == 0) { disconnect(); return -1; }
        const int err = WSAGetLastError();
        if (err == WSAEWOULDBLOCK) return 0;
        disconnect();
        return -1;
#else
        const ssize_t n = ::recv(static_cast<int>(handle_), buf, cap, 0);
        if (n > 0) return static_cast<int>(n);
        if (n == 0) { disconnect(); return -1; }
        if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
        disconnect();
        return -1;
#endif
    } else {
#ifdef _WIN32
        DWORD got = 0;
        if (!ReadFile(reinterpret_cast<HANDLE>(handle_), buf, static_cast<DWORD>(cap), &got, nullptr)) {
            disconnect();
            return -1;
        }
        return static_cast<int>(got);
#else
        const ssize_t n = ::read(static_cast<int>(handle_), buf, cap);
        if (n >= 0) return static_cast<int>(n);
        if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
        disconnect();
        return -1;
#endif
    }
}

bool RemoteLink::send_command(const simcore::SimCommand& cmd) noexcept {
    if (!is_connected()) return false;
    const size_t flen = simcore::proto_encode_cmd(tx_buf_, sizeof(tx_buf_), tx_seq_++, cmd);
    return (flen > 0u) ? raw_send(tx_buf_, flen) : false;
}

void RemoteLink::poll(simcore::SimWorld& remote_world, uint64_t now_us) noexcept {
    if (!is_connected()) return;

    if (bw_window_start_us_ == 0u) bw_window_start_us_ = now_us;
    if (now_us - last_ping_us_ >= 1000000ULL) {
        last_ping_us_ = now_us;
        const size_t plen = simcore::proto_encode_ping(tx_buf_, sizeof(tx_buf_), tx_seq_++, now_us);
        if (plen > 0u) raw_send(tx_buf_, plen);
    }

    uint8_t rx[2048];
    for (int iter = 0; iter < 16 && is_connected(); ++iter) {
        const int got = raw_recv(rx, sizeof(rx));
        if (got <= 0) break;
        bw_bytes_accum_ += static_cast<uint64_t>(got);

        for (int i = 0; i < got; ++i) {
            simcore::ProtoParsedFrame fr{};
            if (!parser_.feed_byte(rx[i], fr)) continue;

            switch (fr.type) {
                case simcore::ProtoMsgType::Hello:
                    if (fr.len >= 8u) {
                        server_hz_ = fr.payload[1] > 0u ? fr.payload[1] : 30u;
                        snap_interval_us_ = 1000000ULL / server_hz_;
                    }
                    break;

                case simcore::ProtoMsgType::MapStatic:
                    simcore::proto_apply_map_chunk(remote_world, fr.payload, fr.len);
                    break;

                case simcore::ProtoMsgType::SnapshotFull:
                case simcore::ProtoMsgType::SnapshotDelta: {
                    if (simcore::proto_apply_snapshot(remote_world, fr.payload, fr.len)) {
                        if (last_snap_us_ != 0u && now_us > last_snap_us_) {
                            const uint64_t dt = now_us - last_snap_us_;
                            if (dt >= 5000ULL && dt <= 250000ULL) {
                                snap_interval_us_ = (snap_interval_us_ * 3ULL + dt) / 4ULL;
                            }
                        }
                        last_snap_us_ = now_us;

                        for (size_t u = 0; u < simcore::kMaxUnits; ++u) {
                            const auto& su = remote_world.hot->units[u];
                            auto& iu = unit_interp_[u];
                            if (su.active) {
                                const double nx = static_cast<double>(su.x_q16) / 65536.0;
                                const double ny = static_cast<double>(su.y_q16) / 65536.0;
                                if (!iu.valid) { iu.prev_x = nx; iu.prev_y = ny; }
                                else { iu.prev_x = iu.curr_x; iu.prev_y = iu.curr_y; }
                                iu.curr_x = nx;
                                iu.curr_y = ny;
                                iu.valid = true;
                            } else {
                                iu.valid = false;
                            }
                        }

                        for (size_t p = 0; p < simcore::kMaxProjectiles; ++p) {
                            const auto& sp = remote_world.hot->projectiles[p];
                            auto& ip = proj_interp_[p];
                            if (sp.active) {
                                const double nx = static_cast<double>(sp.x_q16) / 65536.0;
                                const double ny = static_cast<double>(sp.y_q16) / 65536.0;
                                if (!ip.valid) { ip.prev_x = nx; ip.prev_y = ny; }
                                else { ip.prev_x = ip.curr_x; ip.prev_y = ip.curr_y; }
                                ip.curr_x = nx;
                                ip.curr_y = ny;
                                ip.valid = true;
                            } else {
                                ip.valid = false;
                            }
                        }
                    }
                    break;
                }

                case simcore::ProtoMsgType::Pong:
                    if (fr.len >= 16u) {
                        const uint64_t t0 = simcore::rd_u64_le(fr.payload);
                        if (now_us >= t0) rtt_us_ = static_cast<uint32_t>(now_us - t0);
                        server_tick_us_ = simcore::rd_u32_le(fr.payload + 12);
                    }
                    break;

                default:
                    break;
            }
        }
    }

    if (now_us - bw_window_start_us_ >= 1000000ULL) {
        const double sec = static_cast<double>(now_us - bw_window_start_us_) / 1000000.0;
        rx_kbps_ = (static_cast<double>(bw_bytes_accum_) / 1024.0) / sec;
        bw_bytes_accum_ = 0u;
        bw_window_start_us_ = now_us;
    }
}

double RemoteLink::interp_alpha(uint64_t now_us) const noexcept {
    if (last_snap_us_ == 0u || snap_interval_us_ == 0u || now_us <= last_snap_us_) return 1.0;
    const double a = static_cast<double>(now_us - last_snap_us_) / static_cast<double>(snap_interval_us_);
    return (a < 0.0) ? 0.0 : ((a > 1.0) ? 1.0 : a);
}

void RemoteLink::interpolated_unit_pos(size_t idx, double alpha, double& out_x, double& out_y) const noexcept {
    if (idx >= simcore::kMaxUnits || !unit_interp_[idx].valid) {
        out_x = 0.0; out_y = 0.0;
        return;
    }
    const auto& iu = unit_interp_[idx];
    out_x = iu.prev_x + (iu.curr_x - iu.prev_x) * alpha;
    out_y = iu.prev_y + (iu.curr_y - iu.prev_y) * alpha;
}

void RemoteLink::interpolated_proj_pos(size_t idx, double alpha, double& out_x, double& out_y) const noexcept {
    if (idx >= simcore::kMaxProjectiles || !proj_interp_[idx].valid) {
        out_x = 0.0; out_y = 0.0;
        return;
    }
    const auto& ip = proj_interp_[idx];
    out_x = ip.prev_x + (ip.curr_x - ip.prev_x) * alpha;
    out_y = ip.prev_y + (ip.curr_y - ip.prev_y) * alpha;
}

} // namespace client_net
