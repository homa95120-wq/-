// SPDX-License-Identifier: GPL-3.0-or-later
#include <algorithm>
#include <chrono>
#include <inttypes.h>
#include <memory>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <thread>
#include <vector>

#include "simcore/protocol.hpp"
#include "simcore/simcore.hpp"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#else
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace {

int run_tcp_emulator(uint16_t port) {
    using namespace simcore;
#ifdef _WIN32
    WSADATA wsa{};
    WSAStartup(MAKEWORD(2, 2), &wsa);
    using sock_t = SOCKET;
    const sock_t kBad = INVALID_SOCKET;
    auto close_s = [](sock_t s) { closesocket(s); };
#else
    using sock_t = int;
    const sock_t kBad = -1;
    auto close_s = [](sock_t s) { ::close(s); };
#endif

    sock_t lfd = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (lfd == kBad) {
        fprintf(stderr, "Failed to create TCP socket\n");
        return 1;
    }

    int opt = 1;
    ::setsockopt(lfd, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&opt), sizeof(opt));
#ifdef _WIN32
    u_long nb = 1;
    ioctlsocket(lfd, FIONBIO, &nb);
#else
    ::fcntl(lfd, F_SETFL, ::fcntl(lfd, F_GETFL, 0) | O_NONBLOCK);
#endif

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    addr.sin_port = htons(port);
    if (::bind(lfd, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0 ||
        ::listen(lfd, 2) != 0) {
        fprintf(stderr, "Failed to bind 0.0.0.0:%u\n", static_cast<unsigned>(port));
        close_s(lfd);
        return 1;
    }

    auto hot = std::make_unique<SimHotState>();
    auto map = std::make_unique<SimMapStorage>();
    SimWorld world{ hot.get(), map.get() };
    sim_generate_sector(world, 0u, 0u);

    printf("[esp32-emulator] Authoritative 0x4D53 server listening on 0.0.0.0:%u (30 Hz)\n",
           static_cast<unsigned>(port));
    fflush(stdout);

    sock_t cfd = kBad;
    bool need_sync = false;
    uint16_t tx_seq = 1u;
    uint32_t frame_no = 0u;
    auto parser = std::make_unique<ProtoStreamParser>();
    std::vector<uint8_t> tx_buf(kProtoMaxFrame);

    auto send_all = [&](const uint8_t* d, size_t len) {
        if (cfd == kBad) return;
        size_t sent = 0;
        while (sent < len) {
            const auto n = ::send(cfd, reinterpret_cast<const char*>(d + sent),
                                  static_cast<int>(len - sent), 0);
            if (n > 0) sent += static_cast<size_t>(n);
            else { close_s(cfd); cfd = kBad; return; }
        }
    };

    for (;;) {
        const auto t0 = std::chrono::steady_clock::now();

        sockaddr_in ca{};
        socklen_t cl = sizeof(ca);
        sock_t nfd = ::accept(lfd, reinterpret_cast<sockaddr*>(&ca), &cl);
        if (nfd != kBad) {
            if (cfd != kBad) close_s(cfd);
            cfd = nfd;
            int nd = 1;
            ::setsockopt(cfd, IPPROTO_TCP, TCP_NODELAY, reinterpret_cast<const char*>(&nd), sizeof(nd));
#ifdef _WIN32
            u_long cnb = 1;
            ioctlsocket(cfd, FIONBIO, &cnb);
#else
            ::fcntl(cfd, F_SETFL, ::fcntl(cfd, F_GETFL, 0) | O_NONBLOCK);
#endif
            parser->reset();
            need_sync = true;
            printf("[esp32-emulator] Client connected\n");
            fflush(stdout);
        }

        sim_step_ticks(world, 2u);
        const auto t1 = std::chrono::steady_clock::now();
        const uint32_t tick_us = static_cast<uint32_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(t1 - t0).count());

        if (cfd != kBad) {
            uint8_t rx[1024];
            for (;;) {
                const auto got = ::recv(cfd, reinterpret_cast<char*>(rx), sizeof(rx), 0);
                if (got > 0) {
                    for (int i = 0; i < got; ++i) {
                        ProtoParsedFrame fr{};
                        if (parser->feed_byte(rx[i], fr)) {
                            if (fr.type == ProtoMsgType::Hello) {
                                need_sync = true;
                            } else if (fr.type == ProtoMsgType::InputCmd) {
                                SimCommand cmd{};
                                if (proto_decode_cmd(fr.payload, fr.len, cmd)) {
                                    sim_push_command(world, cmd);
                                    if (cmd.type == SimCmdType::SelectSector) need_sync = true;
                                }
                            } else if (fr.type == ProtoMsgType::Ping && fr.len >= 8u) {
                                const size_t pl = proto_encode_pong(
                                    tx_buf.data(), tx_buf.size(), tx_seq++,
                                    rd_u64_le(fr.payload), world.hot->tick, tick_us);
                                if (pl > 0u) send_all(tx_buf.data(), pl);
                            }
                        }
                    }
                } else {
                    break;
                }
            }

            if (need_sync) {
                need_sync = false;
                const size_t hl = proto_encode_hello(tx_buf.data(), tx_buf.size(), tx_seq++,
                                                     world.map->width, world.map->height, 30u,
                                                     world.hot->sector_preset_id);
                if (hl > 0u) send_all(tx_buf.data(), hl);
                for (uint16_t y = 0u; y < world.map->height; y = static_cast<uint16_t>(y + 16u)) {
                    const size_t ml = proto_encode_map_chunk(tx_buf.data(), tx_buf.size(), tx_seq++, world, y, 16u);
                    if (ml > 0u) send_all(tx_buf.data(), ml);
                }
            }

            ++frame_no;
            const size_t sl = proto_encode_snapshot(tx_buf.data(), tx_buf.size(), tx_seq++,
                                                    world, (frame_no % 4u == 0u));
            if (sl > 0u) send_all(tx_buf.data(), sl);
        }

        std::this_thread::sleep_until(t0 + std::chrono::milliseconds(33));
    }
}

} // namespace

int main(int argc, char** argv) {
    using namespace simcore;

    uint32_t bench_ticks = 1000u;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--serve") == 0) {
            const uint16_t port = (i + 1 < argc) ? static_cast<uint16_t>(atoi(argv[++i])) : 26789u;
            return run_tcp_emulator(port);
        }
        if (strcmp(argv[i], "--ticks") == 0 && i + 1 < argc) {
            bench_ticks = static_cast<uint32_t>(atoi(argv[++i]));
        }
    }

    auto hot = std::make_unique<SimHotState>();
    auto map = std::make_unique<SimMapStorage>();
    SimWorld world{ hot.get(), map.get() };

    const size_t flash_tables_bytes =
        sizeof(kItemsTable) + sizeof(kLiquidsTable) + sizeof(kBlocksTable) +
        sizeof(kUnitsTable) + sizeof(kSectorsTable) + sizeof(kSinLutQ16);

    printf("=== Mindustry Serpulo Headless Runner & ESP32-S3 Budget Benchmark ===\n");
    printf("Memory footprint:\n");
    printf("  sizeof(SimHotState)   [ESP32 SRAM]  = %7zu B (%.2f KB)\n",
           sizeof(SimHotState), sizeof(SimHotState) / 1024.0);
    printf("  sizeof(SimMapStorage) [ESP32 PSRAM] = %7zu B (%.2f KB)\n",
           sizeof(SimMapStorage), sizeof(SimMapStorage) / 1024.0);
    printf("  Flash .rodata tables  [XIP DROM]    = %7zu B (%.2f KB)\n",
           flash_tables_bytes, flash_tables_bytes / 1024.0);

    const bool selftest = sim_run_golden_selftest(world);
    printf("Golden determinism selftest: %s\n", selftest ? "PASS" : "FAIL");
    if (!selftest) return 1;

    sim_setup_esp_stress_benchmark(world);
    printf("Stress scenario initialized: buildings=%u, units=%u, projectiles=%u\n",
           static_cast<unsigned>(world.hot->active_buildings),
           static_cast<unsigned>(world.hot->active_units),
           static_cast<unsigned>(world.hot->active_projectiles));

    std::vector<double> samples_us;
    samples_us.reserve(bench_ticks);

    for (uint32_t t = 0u; t < bench_ticks; ++t) {
        const auto t0 = std::chrono::steady_clock::now();
        sim_step_tick(world);
        const auto t1 = std::chrono::steady_clock::now();
        const double us = std::chrono::duration<double, std::micro>(t1 - t0).count();
        samples_us.push_back(us);
    }

    std::sort(samples_us.begin(), samples_us.end());
    const double p50 = samples_us[samples_us.size() / 2];
    const double p95 = samples_us[(samples_us.size() * 95) / 100];
    const double p99 = samples_us[(samples_us.size() * 99) / 100];
    const double mx  = samples_us.back();

    printf("Benchmark (%u ticks): p50=%.2f us, p95=%.2f us, p99=%.2f us, max=%.2f us\n",
           bench_ticks, p50, p95, p99, mx);
    printf("Final canonical hash: FNV1a64=0x%016" PRIX64 " CRC32=0x%08" PRIX32 "\n",
           sim_state_hash_fnv1a64(world), sim_state_crc32(world));
    return 0;
}
