// SPDX-License-Identifier: GPL-3.0-or-later
#include <atomic>
#include <chrono>
#include <fstream>
#include <inttypes.h>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <thread>

#include "net_client.hpp"
#include "simcore/simcore.hpp"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
using sock_t = SOCKET;
static constexpr sock_t kInvalidSock = INVALID_SOCKET;
static void close_sock(sock_t s) { closesocket(s); }
#else
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>
using sock_t = int;
static constexpr sock_t kInvalidSock = -1;
static void close_sock(sock_t s) { ::close(s); }
#endif

namespace {

std::string load_html_file(const char* exe_dir_hint) {
    const char* candidates[] = {
        "web-preview/index.html",
        "esp32s3-mindustry-serpulo/web-preview/index.html",
        "../web-preview/index.html",
    };
    for (const char* c : candidates) {
        std::ifstream f(c, std::ios::binary);
        if (f.good()) {
            std::ostringstream ss;
            ss << f.rdbuf();
            return ss.str();
        }
    }
    if (exe_dir_hint && exe_dir_hint[0]) {
        std::string p = std::string(exe_dir_hint) + "/index.html";
        std::ifstream f(p, std::ios::binary);
        if (f.good()) {
            std::ostringstream ss;
            ss << f.rdbuf();
            return ss.str();
        }
    }
    return "<html><body><h1>index.html not found</h1></body></html>";
}

int json_int(const std::string& body, const char* key, int def_val = 0) {
    const std::string pat = std::string("\"") + key + "\"";
    const size_t pos = body.find(pat);
    if (pos == std::string::npos) return def_val;
    const size_t col = body.find(':', pos + pat.size());
    if (col == std::string::npos) return def_val;
    return atoi(body.c_str() + col + 1);
}

std::string json_str(const std::string& body, const char* key) {
    const std::string pat = std::string("\"") + key + "\"";
    const size_t pos = body.find(pat);
    if (pos == std::string::npos) return "";
    const size_t q1 = body.find('"', pos + pat.size() + 1);
    if (q1 == std::string::npos) return "";
    const size_t q2 = body.find('"', q1 + 1);
    if (q2 == std::string::npos) return "";
    return body.substr(q1 + 1, q2 - q1 - 1);
}

std::string build_meta_json() {
    using namespace simcore;
    std::ostringstream s;
    s << "{\"items\":[";
    for (size_t i = 0; i < kItemCount; ++i) {
        if (i) s << ",";
        s << "{\"id\":" << i
          << ",\"name\":\"" << kItemsTable[i].name << "\""
          << ",\"ru\":\"" << kItemsTable[i].title_ru << "\""
          << ",\"color\":" << kItemsTable[i].color_rgb << "}";
    }
    s << "],\"blocks\":[";
    for (size_t i = 0; i < kBlockCount; ++i) {
        if (i) s << ",";
        const auto& b = kBlocksTable[i];
        s << "{\"id\":" << i
          << ",\"cat\":" << static_cast<unsigned>(b.category)
          << ",\"role\":" << static_cast<unsigned>(b.role)
          << ",\"size\":" << static_cast<unsigned>(b.size)
          << ",\"param\":" << b.param_ticks
          << ",\"range\":" << (b.range_tiles_q16 / 65536.0)
          << ",\"color\":" << b.color_rgb
          << ",\"name\":\"" << b.name << "\""
          << ",\"ru\":\"" << b.title_ru << "\",\"cost\":[";
        for (uint8_t c = 0; c < b.cost_count; ++c) {
            if (c) s << ",";
            s << "[" << b.cost[c].item_id << "," << b.cost[c].amount << "]";
        }
        s << "]}";
    }
    s << "],\"sectors\":[";
    for (size_t i = 0; i < kSectorPresetCount; ++i) {
        if (i) s << ",";
        const auto& sc = kSectorsTable[i];
        s << "{\"id\":" << i
          << ",\"num\":" << sc.sector_num
          << ",\"diff\":" << static_cast<unsigned>(sc.difficulty)
          << ",\"waves\":" << static_cast<unsigned>(sc.capture_wave)
          << ",\"name\":\"" << sc.name << "\""
          << ",\"ru\":\"" << sc.title_ru << "\"}";
    }
    s << "]}";
    return s.str();
}

std::string build_map_json(const simcore::SimWorld& w) {
    std::ostringstream s;
    const size_t total = static_cast<size_t>(w.map->width) * static_cast<size_t>(w.map->height);
    s << "{\"w\":" << w.map->width << ",\"h\":" << w.map->height << ",\"floor\":[";
    for (size_t i = 0; i < total; ++i) {
        if (i) s << ",";
        s << static_cast<unsigned>(w.map->floor[i]);
    }
    s << "],\"ore\":[";
    for (size_t i = 0; i < total; ++i) {
        if (i) s << ",";
        s << static_cast<unsigned>(w.map->ore[i]);
    }
    s << "],\"wall\":[";
    for (size_t i = 0; i < total; ++i) {
        if (i) s << ",";
        s << static_cast<unsigned>(w.map->wall[i]);
    }
    s << "]}";
    return s.str();
}

std::string build_state_json(const simcore::SimWorld& w,
                             const client_net::RemoteLink& net,
                             uint32_t local_tick_us) {
    using namespace simcore;
    std::ostringstream s;
    s << "{\"tick\":" << w.hot->tick
      << ",\"sector\":" << w.hot->sector_preset_id
      << ",\"wave\":" << w.hot->wave
      << ",\"win_wave\":" << w.hot->win_wave
      << ",\"countdown\":" << w.hot->wave_countdown_ticks
      << ",\"flags\":" << static_cast<unsigned>(w.hot->flags)
      << ",\"enemies\":" << w.hot->enemy_units
      << ",\"spawn_x\":" << w.hot->spawn_x
      << ",\"spawn_y\":" << w.hot->spawn_y
      << ",\"pwr_prod\":" << fx_to_int_round(w.hot->power_produced_q16)
      << ",\"pwr_cons\":" << fx_to_int_round(w.hot->power_consumed_q16)
      << ",\"pwr_stored\":" << w.hot->power_stored_units
      << ",\"pwr_cap\":" << w.hot->power_capacity_units
      << ",\"tick_us\":" << (net.is_connected() ? net.server_tick_us() : local_tick_us)
      << ",\"esp_connected\":" << (net.is_connected() ? "true" : "false")
      << ",\"esp_label\":\"" << net.endpoint_label() << "\""
      << ",\"items\":[";
    for (size_t i = 0; i < kSerpuloItemCount; ++i) {
        if (i) s << ",";
        s << w.hot->core_items[i];
    }
    s << "],\"buildings\":[";
    bool first = true;
    for (size_t i = 0; i < kMaxBuildings; ++i) {
        const auto& b = w.hot->buildings[i];
        if (!b.active) continue;
        if (!first) s << ",";
        first = false;
        s << "[" << b.id << "," << b.block_id << "," << b.x << "," << b.y << ","
          << b.hp << "," << static_cast<unsigned>(b.rotation) << ","
          << static_cast<unsigned>(b.item_id) << "," << static_cast<unsigned>(b.item_count) << ","
          << b.progress_ticks << "," << b.aim_bam10 << "]";
    }
    s << "],\"units\":[";
    first = true;
    for (size_t i = 0; i < kMaxUnits; ++i) {
        const auto& u = w.hot->units[i];
        if (!u.active) continue;
        if (!first) s << ",";
        first = false;
        s << "[" << u.id << "," << static_cast<unsigned>(u.unit_type) << ","
          << static_cast<unsigned>(u.team) << ","
          << (u.x_q16 / 65536.0) << "," << (u.y_q16 / 65536.0) << ","
          << u.angle_bam10 << "," << u.hp << "]";
    }
    s << "],\"projs\":[";
    first = true;
    for (size_t i = 0; i < kMaxProjectiles; ++i) {
        const auto& p = w.hot->projectiles[i];
        if (!p.active) continue;
        if (!first) s << ",";
        first = false;
        s << "[" << p.id << "," << static_cast<unsigned>(p.team) << ","
          << static_cast<unsigned>(p.style) << ","
          << (p.x_q16 / 65536.0) << "," << (p.y_q16 / 65536.0) << "]";
    }
    s << "]}";
    return s.str();
}

} // namespace

int main(int argc, char** argv) {
    using namespace simcore;
    uint16_t port = 8080u;
    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
            port = static_cast<uint16_t>(atoi(argv[++i]));
        }
    }

#ifdef _WIN32
    WSADATA wsa{};
    WSAStartup(MAKEWORD(2, 2), &wsa);
#endif

    auto local_hot = std::make_unique<SimHotState>();
    auto local_map = std::make_unique<SimMapStorage>();
    auto rem_hot   = std::make_unique<SimHotState>();
    auto rem_map   = std::make_unique<SimMapStorage>();

    SimWorld local_world{ local_hot.get(), local_map.get() };
    SimWorld remote_world{ rem_hot.get(), rem_map.get() };

    sim_generate_sector(local_world, 0u, 0u);
    sim_init_empty(remote_world, 128u, 128u, kDefaultPrngSeed);

    // Поставим стартовый бур с конвейером к ядру, чтобы игрок сразу видел живую добычу!
    {
        const int16_t cx = local_world.hot->core_x;
        const int16_t cy = local_world.hot->core_y;
        sim_place_block(local_world, static_cast<int16_t>(cx - 7), static_cast<int16_t>(cy - 1),
                        static_cast<uint16_t>(BlockId::MechanicalDrill), 0u, 0u, false);
        for (int16_t x = static_cast<int16_t>(cx - 5); x < cx; ++x) {
            sim_place_block(local_world, x, static_cast<int16_t>(cy - 1),
                            static_cast<uint16_t>(BlockId::Conveyor), 0u, 0u, false);
        }
        const int32_t d1 = sim_place_block(local_world, cx, static_cast<int16_t>(cy - 3),
                                           static_cast<uint16_t>(BlockId::Duo), 1u, 0u, false);
        if (d1 >= 0) {
            local_world.hot->buildings[d1].item_id = static_cast<uint8_t>(ItemId::Copper);
            local_world.hot->buildings[d1].item_count = 20u;
        }
        sim_rebuild_flow_field(local_world);
    }

    client_net::RemoteLink net;
    std::mutex mtx;
    std::atomic<uint32_t> last_tick_us{0u};
    const std::string meta_json = build_meta_json();
    const std::string html_page = load_html_file(nullptr);

    // Фоновый поток симуляции 60 Гц (или опроса удалённого ESP32-S3)
    std::thread sim_thread([&]() {
        const auto boot = std::chrono::steady_clock::now();
        for (;;) {
            const auto t0 = std::chrono::steady_clock::now();
            const uint64_t now_us = static_cast<uint64_t>(
                std::chrono::duration_cast<std::chrono::microseconds>(t0 - boot).count());
            {
                std::lock_guard<std::mutex> lk(mtx);
                if (net.is_connected()) {
                    net.poll(remote_world, now_us);
                } else {
                    const auto s0 = std::chrono::steady_clock::now();
                    sim_step_tick(local_world);
                    const auto s1 = std::chrono::steady_clock::now();
                    last_tick_us.store(static_cast<uint32_t>(
                        std::chrono::duration_cast<std::chrono::microseconds>(s1 - s0).count()));
                }
            }
            std::this_thread::sleep_until(t0 + std::chrono::microseconds(16666));
        }
    });
    sim_thread.detach();

    sock_t srv = ::socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (srv == kInvalidSock) {
        fprintf(stderr, "Failed to create HTTP socket\n");
        return 1;
    }
    int opt = 1;
    ::setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&opt), sizeof(opt));

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_ANY); // 0.0.0.0
    addr.sin_port = htons(port);

    if (::bind(srv, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0 ||
        ::listen(srv, 16) != 0) {
        fprintf(stderr, "Failed to bind 0.0.0.0:%u\n", static_cast<unsigned>(port));
        close_sock(srv);
        return 1;
    }

    printf("[mindustry-serpulo-web] C++17 Q16.16 simcore PC server listening on http://0.0.0.0:%u\n",
           static_cast<unsigned>(port));
    fflush(stdout);

    for (;;) {
        sockaddr_in ca{};
        socklen_t cl = sizeof(ca);
        sock_t cfd = ::accept(srv, reinterpret_cast<sockaddr*>(&ca), &cl);
        if (cfd == kInvalidSock) continue;

        char buf[8192];
        int total = 0;
        for (;;) {
            const auto n = ::recv(cfd, buf + total, static_cast<int>(sizeof(buf) - 1 - total), 0);
            if (n <= 0) break;
            total += static_cast<int>(n);
            buf[total] = '\0';
            const char* hdr_end = strstr(buf, "\r\n\r\n");
            if (hdr_end) {
                const char* cl_hdr = strstr(buf, "Content-Length:");
                if (!cl_hdr) cl_hdr = strstr(buf, "content-length:");
                int need_body = cl_hdr ? atoi(cl_hdr + 15) : 0;
                const int have_body = total - static_cast<int>((hdr_end + 4) - buf);
                if (have_body >= need_body) break;
            }
            if (total >= static_cast<int>(sizeof(buf) - 2)) break;
        }

        if (total <= 0) {
            close_sock(cfd);
            continue;
        }
        buf[total] = '\0';

        std::string req(buf, static_cast<size_t>(total));
        std::string content_type = "application/json; charset=utf-8";
        std::string resp_body = "{\"ok\":true}";

        if (req.rfind("GET /api/meta", 0) == 0) {
            resp_body = meta_json;
        } else if (req.rfind("GET /api/map", 0) == 0) {
            std::lock_guard<std::mutex> lk(mtx);
            resp_body = build_map_json(net.is_connected() ? remote_world : local_world);
        } else if (req.rfind("GET /api/state", 0) == 0) {
            std::lock_guard<std::mutex> lk(mtx);
            resp_body = build_state_json(net.is_connected() ? remote_world : local_world,
                                         net, last_tick_us.load());
        } else if (req.rfind("POST /api/cmd", 0) == 0) {
            const size_t bpos = req.find("\r\n\r\n");
            const std::string body = (bpos != std::string::npos) ? req.substr(bpos + 4) : "";
            const std::string cname = json_str(body, "cmd");
            std::lock_guard<std::mutex> lk(mtx);

            auto dispatch = [&](const SimCommand& cmd) {
                if (net.is_connected()) net.send_command(cmd);
                else sim_push_command(local_world, cmd);
            };

            if (cname == "place") {
                dispatch({SimCmdType::PlaceBlock,
                          static_cast<uint8_t>(json_int(body, "rot") & 3),
                          0u, 0u,
                          static_cast<int16_t>(json_int(body, "x")),
                          static_cast<int16_t>(json_int(body, "y")),
                          static_cast<uint16_t>(json_int(body, "block")), 0u});
            } else if (cname == "remove") {
                dispatch({SimCmdType::RemoveBlock, 0u, 0u, 0u,
                          static_cast<int16_t>(json_int(body, "x")),
                          static_cast<int16_t>(json_int(body, "y")), 0u, 0u});
            } else if (cname == "wave") {
                dispatch({SimCmdType::TriggerWave, 0u, 0u, 0u, 0, 0, 0u, 0u});
            } else if (cname == "pause") {
                dispatch({SimCmdType::SetPaused, 0u, 0u,
                          static_cast<uint8_t>(json_int(body, "arg")), 0, 0, 0u, 0u});
            } else if (cname == "sandbox") {
                dispatch({SimCmdType::SetSandbox, 0u, 0u,
                          static_cast<uint8_t>(json_int(body, "arg")), 0, 0, 0u, 0u});
            } else if (cname == "sector") {
                SimCommand sc{SimCmdType::SelectSector, 0u, 0u, 0u, 0, 0,
                              static_cast<uint16_t>(json_int(body, "param")), 0u};
                if (net.is_connected()) net.send_command(sc);
                else sim_generate_sector(local_world, sc.param16, 0u);
            } else if (cname == "esp_tcp") {
                const std::string ep = json_str(body, "addr");
                const size_t col = ep.find(':');
                const std::string h = (col != std::string::npos) ? ep.substr(0, col) : ep;
                const uint16_t prt = (col != std::string::npos)
                    ? static_cast<uint16_t>(atoi(ep.c_str() + col + 1))
                    : 26789u;
                net.connect_tcp(h.c_str(), prt);
            } else if (cname == "esp_off") {
                net.disconnect();
            }
        } else {
            content_type = "text/html; charset=utf-8";
            resp_body = html_page;
        }

        std::ostringstream hdr;
        hdr << "HTTP/1.1 200 OK\r\n"
            << "Content-Type: " << content_type << "\r\n"
            << "Content-Length: " << resp_body.size() << "\r\n"
            << "Cache-Control: no-store\r\n"
            << "Access-Control-Allow-Origin: *\r\n"
            << "Connection: close\r\n\r\n";
        const std::string hstr = hdr.str();
        ::send(cfd, hstr.data(), static_cast<int>(hstr.size()), 0);
        size_t off = 0;
        while (off < resp_body.size()) {
            const auto w = ::send(cfd, resp_body.data() + off,
                                  static_cast<int>(resp_body.size() - off), 0);
            if (w <= 0) break;
            off += static_cast<size_t>(w);
        }
        close_sock(cfd);
    }
}
