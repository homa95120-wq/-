// SPDX-License-Identifier: GPL-3.0-or-later
#define SDL_MAIN_HANDLED
#include <SDL.h>

#include <algorithm>
#include <inttypes.h>
#include <math.h>
#include <memory>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>

#include "font5x7.hpp"
#include "gl_minimal.hpp"
#include "net_client.hpp"
#include "simcore/save_msv1.hpp"
#include "simcore/simcore.hpp"

namespace {

struct Vertex2D {
    float   x, y;
    uint8_t r, g, b, a;
};

struct Color4 {
    uint8_t r, g, b, a;
};

constexpr Color4 rgba_hex(uint32_t rgb, uint8_t a = 255u) noexcept {
    return {
        static_cast<uint8_t>((rgb >> 16u) & 0xFFu),
        static_cast<uint8_t>((rgb >> 8u) & 0xFFu),
        static_cast<uint8_t>(rgb & 0xFFu),
        a
    };
}

constexpr Color4 darken(Color4 c, float k) noexcept {
    return {
        static_cast<uint8_t>(c.r * k),
        static_cast<uint8_t>(c.g * k),
        static_cast<uint8_t>(c.b * k),
        c.a
    };
}

class BatchRenderer {
public:
    bool init(gl33::Procs& gl) {
        gl_ = &gl;
        const char* vs_src =
            "#version 330 core\n"
            "layout(location = 0) in vec2 aPos;\n"
            "layout(location = 1) in vec4 aCol;\n"
            "uniform vec2 uScreen;\n"
            "out vec4 vCol;\n"
            "void main() {\n"
            "    vec2 ndc = vec2((aPos.x / uScreen.x) * 2.0 - 1.0, 1.0 - (aPos.y / uScreen.y) * 2.0);\n"
            "    gl_Position = vec4(ndc, 0.0, 1.0);\n"
            "    vCol = aCol;\n"
            "}\n";

        const char* fs_src =
            "#version 330 core\n"
            "in vec4 vCol;\n"
            "out vec4 FragColor;\n"
            "void main() { FragColor = vCol; }\n";

        gl33::GLuint vs = compile(gl33::GL_VERTEX_SHADER_V, vs_src);
        gl33::GLuint fs = compile(gl33::GL_FRAGMENT_SHADER_V, fs_src);
        if (!vs || !fs) return false;

        prog_ = gl_->CreateProgram();
        gl_->AttachShader(prog_, vs);
        gl_->AttachShader(prog_, fs);
        gl_->LinkProgram(prog_);
        gl_->DeleteShader(vs);
        gl_->DeleteShader(fs);

        gl33::GLint ok = 0;
        gl_->GetProgramiv(prog_, gl33::GL_LINK_STATUS_V, &ok);
        if (!ok) return false;

        u_screen_ = gl_->GetUniformLocation(prog_, "uScreen");

        gl_->GenVertexArrays(1, &vao_);
        gl_->GenBuffers(1, &vbo_);
        gl_->BindVertexArray(vao_);
        gl_->BindBuffer(gl33::GL_ARRAY_BUFFER_V, vbo_);
        verts_.reserve(262144);
        gl_->BufferData(gl33::GL_ARRAY_BUFFER_V,
                        static_cast<gl33::GLsizeiptr>(262144 * sizeof(Vertex2D)),
                        nullptr, gl33::GL_STREAM_DRAW_V);

        gl_->EnableVertexAttribArray(0);
        gl_->VertexAttribPointer(0, 2, gl33::GL_FLOAT_V, gl33::GL_FALSE_V,
                                 sizeof(Vertex2D), reinterpret_cast<const void*>(0));
        gl_->EnableVertexAttribArray(1);
        gl_->VertexAttribPointer(1, 4, gl33::GL_UNSIGNED_BYTE_V, 1,
                                 sizeof(Vertex2D), reinterpret_cast<const void*>(8));
        return true;
    }

    void begin(int w, int h) {
        win_w_ = w;
        win_h_ = h;
        verts_.clear();
    }

    void flush() {
        if (verts_.empty() || !gl_) return;
        gl_->UseProgram(prog_);
        gl_->Uniform2f(u_screen_, static_cast<float>(win_w_), static_cast<float>(win_h_));
        gl_->BindVertexArray(vao_);
        gl_->BindBuffer(gl33::GL_ARRAY_BUFFER_V, vbo_);

        const size_t max_chunk = 262144;
        size_t offset = 0;
        while (offset < verts_.size()) {
            const size_t cnt = (verts_.size() - offset > max_chunk) ? max_chunk : (verts_.size() - offset);
            gl_->BufferSubData(gl33::GL_ARRAY_BUFFER_V, 0,
                               static_cast<gl33::GLsizeiptr>(cnt * sizeof(Vertex2D)),
                               verts_.data() + offset);
            gl_->DrawArrays(gl33::GL_TRIANGLES_V, 0, static_cast<gl33::GLsizei>(cnt));
            offset += cnt;
        }
        verts_.clear();
    }

    void tri(float x0, float y0, float x1, float y1, float x2, float y2, Color4 c) {
        verts_.push_back({x0, y0, c.r, c.g, c.b, c.a});
        verts_.push_back({x1, y1, c.r, c.g, c.b, c.a});
        verts_.push_back({x2, y2, c.r, c.g, c.b, c.a});
    }

    void rect(float x, float y, float w, float h, Color4 c) {
        tri(x, y, x + w, y, x + w, y + h, c);
        tri(x, y, x + w, y + h, x, y + h, c);
    }

    void frame_rect(float x, float y, float w, float h, float t, Color4 c) {
        rect(x, y, w, t, c);
        rect(x, y + h - t, w, t, c);
        rect(x, y + t, t, h - t * 2.0f, c);
        rect(x + w - t, y + t, t, h - t * 2.0f, c);
    }

    void line(float x0, float y0, float x1, float y1, float thickness, Color4 c) {
        const float dx = x1 - x0;
        const float dy = y1 - y0;
        const float len = sqrtf(dx * dx + dy * dy);
        if (len < 0.001f) return;
        const float nx = (-dy / len) * (thickness * 0.5f);
        const float ny = (dx / len) * (thickness * 0.5f);
        tri(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, c);
        tri(x0 + nx, y0 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny, c);
    }

    void circle_outline(float cx, float cy, float r, int segs, float thickness, Color4 c) {
        float px = cx + r;
        float py = cy;
        for (int i = 1; i <= segs; ++i) {
            const float ang = (static_cast<float>(i) / static_cast<float>(segs)) * 6.2831853f;
            const float nx = cx + cosf(ang) * r;
            const float ny = cy + sinf(ang) * r;
            line(px, py, nx, ny, thickness, c);
            px = nx;
            py = ny;
        }
    }

    void text(float x, float y, int scale, const char* utf8, Color4 c) {
        if (!utf8 || scale <= 0) return;
        float pen_x = x;
        const float s = static_cast<float>(scale);
        const char* p = utf8;
        for (;;) {
            const uint32_t cp = ui_font::next_utf8(p);
            if (cp == 0u) break;
            if (cp == '\n') {
                pen_x = x;
                y += 9.0f * s;
                continue;
            }
            const ui_font::Glyph5x7 g = ui_font::glyph_unicode(cp);
            for (int ry = 0; ry < 7; ++ry) {
                const uint8_t row = g.rows[ry];
                if (!row) continue;
                for (int rx = 0; rx < 5; ++rx) {
                    if ((row & (1u << (4 - rx))) != 0u) {
                        rect(pen_x + rx * s, y + ry * s, s, s, c);
                    }
                }
            }
            pen_x += 6.0f * s;
        }
    }

private:
    gl33::GLuint compile(gl33::GLenum type, const char* src) {
        gl33::GLuint sh = gl_->CreateShader(type);
        gl_->ShaderSource(sh, 1, &src, nullptr);
        gl_->CompileShader(sh);
        gl33::GLint ok = 0;
        gl_->GetShaderiv(sh, gl33::GL_COMPILE_STATUS_V, &ok);
        if (!ok) {
            char log[512]{};
            gl_->GetShaderInfoLog(sh, sizeof(log), nullptr, log);
            fprintf(stderr, "GL shader compile error: %s\n", log);
            gl_->DeleteShader(sh);
            return 0;
        }
        return sh;
    }

    gl33::Procs*          gl_ = nullptr;
    gl33::GLuint          prog_ = 0;
    gl33::GLuint          vao_ = 0;
    gl33::GLuint          vbo_ = 0;
    gl33::GLint           u_screen_ = -1;
    int                   win_w_ = 1280;
    int                   win_h_ = 720;
    std::vector<Vertex2D> verts_;
};

Color4 floor_color(uint8_t fl, uint32_t tick, int x, int y) noexcept {
    using simcore::FloorType;
    const int checker = ((x + y) & 1) ? 5 : 0;
    switch (static_cast<FloorType>(fl)) {
        case FloorType::DarkStone: return {static_cast<uint8_t>(38 + checker), static_cast<uint8_t>(40 + checker), static_cast<uint8_t>(48 + checker), 255};
        case FloorType::Sand:      return {static_cast<uint8_t>(182 + checker), static_cast<uint8_t>(152 + checker), static_cast<uint8_t>(114 + checker), 255};
        case FloorType::Moss:      return {static_cast<uint8_t>(52 + checker), static_cast<uint8_t>(68 + checker), static_cast<uint8_t>(56 + checker), 255};
        case FloorType::Snow:      return {static_cast<uint8_t>(186 + checker), static_cast<uint8_t>(198 + checker), static_cast<uint8_t>(214 + checker), 255};
        case FloorType::Basalt:    return {static_cast<uint8_t>(30 + checker), static_cast<uint8_t>(30 + checker), static_cast<uint8_t>(35 + checker), 255};
        case FloorType::Tar:       return {28, 30, 38, 255};
        case FloorType::Water: {
            const int wave = static_cast<int>(((tick / 8u + x + y) & 3u) * 4u);
            return {static_cast<uint8_t>(58 + wave), static_cast<uint8_t>(84 + wave), static_cast<uint8_t>(156 + wave), 255};
        }
        case FloorType::DeepWater: return {38, 56, 122, 255};
        case FloorType::Slag: {
            const int glow = static_cast<int>(((tick / 6u + x * 2 + y) & 3u) * 8u);
            return {235, static_cast<uint8_t>(118 + glow), 45, 255};
        }
        default: return {40, 42, 50, 255};
    }
}

Color4 wall_env_color(uint8_t w) noexcept {
    using simcore::WallEnvType;
    switch (static_cast<WallEnvType>(w)) {
        case WallEnvType::StoneWall: return {72, 75, 88, 255};
        case WallEnvType::SporeWall: return {88, 66, 124, 255};
        case WallEnvType::IceWall:   return {142, 166, 198, 255};
        case WallEnvType::DuneWall:  return {136, 110, 82, 255};
        default:                     return {0, 0, 0, 0};
    }
}

struct CategoryInfo {
    uint8_t     cat;
    const char* ru;
    const char* en;
};

constexpr CategoryInfo kCategories[7] = {
    { 1, "1:БУРЫ",    "1:DRILLS" },
    { 2, "2:КОНВЕЙЕР","2:BELTS"  },
    { 3, "3:ЖИДКОСТИ","3:LIQUID" },
    { 4, "4:ЭНЕРГИЯ", "4:POWER"  },
    { 5, "5:ЗАВОДЫ",  "5:CRAFT"  },
    { 6, "6:СТЕНЫ",   "6:WALLS"  },
    { 7, "7:ТУРЕЛИ",  "7:TURRET" },
};

bool save_world_file(const simcore::SimWorld& w, const char* path) {
    std::vector<uint8_t> buf(simcore::kSaveMaxBytes);
    const size_t n = simcore::sim_save_msv1(w, buf.data(), buf.size());
    if (n == 0u) return false;
    FILE* f = fopen(path, "wb");
    if (!f) return false;
    const size_t wr = fwrite(buf.data(), 1, n, f);
    fclose(f);
    return wr == n;
}

bool load_world_file(simcore::SimWorld& w, const char* path) {
    FILE* f = fopen(path, "rb");
    if (!f) return false;
    fseek(f, 0, SEEK_END);
    const long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0 || sz > static_cast<long>(simcore::kSaveMaxBytes)) {
        fclose(f);
        return false;
    }
    std::vector<uint8_t> buf(static_cast<size_t>(sz));
    const size_t rd = fread(buf.data(), 1, buf.size(), f);
    fclose(f);
    if (rd != buf.size()) return false;
    return simcore::sim_load_msv1(w, buf.data(), buf.size());
}

} // namespace

int main(int argc, char** argv) {
    using namespace simcore;

    const char* cli_tcp_host = "192.168.4.1";
    uint16_t    cli_tcp_port = 26789u;
    bool        auto_tcp = false;
    const char* cli_serial = nullptr;
    uint32_t    cli_baud = 115200u;

    for (int i = 1; i < argc; ++i) {
        if (strcmp(argv[i], "--tcp") == 0 && i + 1 < argc) {
            const char* arg = argv[++i];
            static char host_buf[128];
            const char* colon = strchr(arg, ':');
            if (colon) {
                const size_t hl = static_cast<size_t>(colon - arg);
                const size_t cp = hl < sizeof(host_buf) - 1 ? hl : sizeof(host_buf) - 1;
                memcpy(host_buf, arg, cp);
                host_buf[cp] = '\0';
                cli_tcp_host = host_buf;
                cli_tcp_port = static_cast<uint16_t>(atoi(colon + 1));
            } else {
                cli_tcp_host = arg;
            }
            auto_tcp = true;
        } else if (strcmp(argv[i], "--serial") == 0 && i + 1 < argc) {
            cli_serial = argv[++i];
        } else if (strcmp(argv[i], "--baud") == 0 && i + 1 < argc) {
            cli_baud = static_cast<uint32_t>(atoi(argv[++i]));
        } else if (strcmp(argv[i], "--help") == 0) {
            printf("Mindustry Serpulo PC (Standalone + ESP32-S3 Client)\n"
                   "Usage:\n"
                   "  %s                           # Standalone PC game (60 TPS local simcore)\n"
                   "  %s --tcp 192.168.4.1:26789   # Connect to ESP32-S3 Wi-Fi AP TCP server\n"
                   "  %s --serial COM7             # Connect to ESP32-S3 over USB-CDC / UART\n",
                   argv[0], argv[0], argv[0]);
            return 0;
        }
    }

    SDL_SetMainReady();
    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_TIMER) != 0) {
        fprintf(stderr, "SDL_Init failed: %s\n", SDL_GetError());
        return 1;
    }

    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 3);
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_CORE);
#ifdef __APPLE__
    SDL_GL_SetAttribute(SDL_GL_CONTEXT_FLAGS, SDL_GL_CONTEXT_FORWARD_COMPATIBLE_FLAG);
#endif
    SDL_GL_SetAttribute(SDL_GL_DOUBLEBUFFER, 1);

    SDL_Window* window = SDL_CreateWindow(
        "Mindustry: Serpulo — PC & ESP32-S3 (v160.7 Q16.16)",
        SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
        1360, 820,
        SDL_WINDOW_OPENGL | SDL_WINDOW_RESIZABLE | SDL_WINDOW_ALLOW_HIGHDPI);
    if (!window) {
        fprintf(stderr, "SDL_CreateWindow failed: %s\n", SDL_GetError());
        SDL_Quit();
        return 1;
    }

    SDL_GLContext gl_ctx = SDL_GL_CreateContext(window);
    if (!gl_ctx) {
        fprintf(stderr, "OpenGL 3.3 Core context creation failed: %s\n", SDL_GetError());
        SDL_DestroyWindow(window);
        SDL_Quit();
        return 1;
    }
    SDL_GL_SetSwapInterval(1);

    gl33::Procs gl{};
    if (!gl.load()) {
        fprintf(stderr, "Failed to load OpenGL 3.3 core procedures\n");
        SDL_GL_DeleteContext(gl_ctx);
        SDL_DestroyWindow(window);
        SDL_Quit();
        return 1;
    }

    BatchRenderer batch;
    if (!batch.init(gl)) {
        fprintf(stderr, "Failed to compile OpenGL 3.3 shaders\n");
        SDL_GL_DeleteContext(gl_ctx);
        SDL_DestroyWindow(window);
        SDL_Quit();
        return 1;
    }

    // Два мира: local_world (автономная игра на ПК) и remote_world (приём от ESP32-S3)
    auto local_hot = std::make_unique<SimHotState>();
    auto local_map = std::make_unique<SimMapStorage>();
    auto rem_hot   = std::make_unique<SimHotState>();
    auto rem_map   = std::make_unique<SimMapStorage>();

    SimWorld local_world{ local_hot.get(), local_map.get() };
    SimWorld remote_world{ rem_hot.get(), rem_map.get() };

    sim_generate_sector(local_world, 0u, 0u);
    sim_init_empty(remote_world, 128u, 128u, kDefaultPrngSeed);

    client_net::RemoteLink net;
    char toast_msg[128] = "";
    uint64_t toast_until_us = 0u;

    auto show_toast = [&](const char* msg, uint64_t now_us) {
        snprintf(toast_msg, sizeof(toast_msg), "%s", msg);
        toast_until_us = now_us + 3200000ULL;
    };

    const uint64_t perf_freq = SDL_GetPerformanceFrequency();
    auto now_micros = [&]() -> uint64_t {
        return (SDL_GetPerformanceCounter() * 1000000ULL) / perf_freq;
    };

    if (cli_serial) {
        if (net.connect_serial(cli_serial, cli_baud)) {
            show_toast("ПОДКЛЮЧЕНО К ESP32-S3 ПО USB-SERIAL", now_micros());
        } else {
            show_toast("ОШИБКА USB-SERIAL -> ЛОКАЛЬНЫЙ РЕЖИМ ПК", now_micros());
        }
    } else if (auto_tcp) {
        if (net.connect_tcp(cli_tcp_host, cli_tcp_port)) {
            show_toast("ПОДКЛЮЧЕНО К ESP32-S3 ПО WI-FI TCP", now_micros());
        } else {
            show_toast("ESP32 НЕ НАЙДЕН -> ЛОКАЛЬНЫЙ РЕЖИМ ПК", now_micros());
        }
    }

    // Состояние камеры и интерфейса
    float cam_x = static_cast<float>(local_world.hot->core_x) + 1.5f;
    float cam_y = static_cast<float>(local_world.hot->core_y) - 4.0f;
    float tile_px = 24.0f;

    uint8_t  cur_category = 1u;
    uint16_t selected_block = static_cast<uint16_t>(BlockId::MechanicalDrill);
    uint8_t  build_rot = 0u;
    bool     show_grid = true;
    bool     show_debug = true;
    bool     show_sector_modal = false;
    bool     lang_ru = true;

    bool     lmb_dragging = false;
    int      last_drag_tx = -1;
    int      last_drag_ty = -1;
    bool     rmb_dragging = false;
    bool     mmb_panning = false;

    uint64_t prev_us = now_micros();
    double   sim_accum_s = 0.0;
    uint32_t last_local_tick_us = 0u;
    float    fps_smooth = 60.0f;

    auto dispatch_cmd = [&](const SimCommand& cmd) {
        if (net.is_connected()) {
            net.send_command(cmd);
        } else {
            sim_push_command(local_world, cmd);
        }
    };

    bool running = true;
    while (running) {
        const uint64_t cur_us = now_micros();
        double dt_s = static_cast<double>(cur_us - prev_us) / 1000000.0;
        prev_us = cur_us;
        if (dt_s > 0.1) dt_s = 0.1;
        if (dt_s > 0.0001) {
            fps_smooth = fps_smooth * 0.92f + static_cast<float>(1.0 / dt_s) * 0.08f;
        }

        int win_w = 1360, win_h = 820;
        SDL_GL_GetDrawableSize(window, &win_w, &win_h);

        int mouse_x = 0, mouse_y = 0;
        SDL_GetMouseState(&mouse_x, &mouse_y);
        int log_w = 1, log_h = 1;
        SDL_GetWindowSize(window, &log_w, &log_h);
        if (log_w > 0 && log_h > 0) {
            mouse_x = (mouse_x * win_w) / log_w;
            mouse_y = (mouse_y * win_h) / log_h;
        }

        SimWorld& active_w = net.is_connected() ? remote_world : local_world;

        auto screen_to_tile = [&](int sx, int sy, int& tx, int& ty) {
            const float wx = cam_x + (static_cast<float>(sx) - win_w * 0.5f) / tile_px;
            const float wy = cam_y + (static_cast<float>(sy) - win_h * 0.5f) / tile_px;
            tx = static_cast<int>(floorf(wx));
            ty = static_cast<int>(floorf(wy));
        };

        // Позиции UI-зон
        const float top_bar_h = 54.0f;
        const float bot_bar_h = 98.0f;
        const float mm_size = 168.0f;
        const float mm_x = static_cast<float>(win_w) - mm_size - 14.0f;
        const float mm_y = top_bar_h + 12.0f;
        const bool mouse_on_ui = (mouse_y < top_bar_h) ||
                                 (mouse_y > win_h - bot_bar_h) ||
                                 (mouse_x >= mm_x && mouse_x <= mm_x + mm_size &&
                                  mouse_y >= mm_y && mouse_y <= mm_y + mm_size) ||
                                 show_sector_modal;

        SDL_Event ev;
        while (SDL_PollEvent(&ev)) {
            if (ev.type == SDL_QUIT) {
                running = false;
            } else if (ev.type == SDL_MOUSEWHEEL && !show_sector_modal) {
                const float factor = (ev.wheel.y > 0) ? 1.15f : (1.0f / 1.15f);
                tile_px *= factor;
                if (tile_px < 6.0f) tile_px = 6.0f;
                if (tile_px > 64.0f) tile_px = 64.0f;
            } else if (ev.type == SDL_KEYDOWN) {
                const SDL_Keycode key = ev.key.keysym.sym;
                if (key == SDLK_ESCAPE) {
                    if (show_sector_modal) show_sector_modal = false;
                    else running = false;
                } else if (key == SDLK_r) {
                    build_rot = static_cast<uint8_t>((build_rot + 1u) & 3u);
                } else if (key == SDLK_g) {
                    show_grid = !show_grid;
                } else if (key == SDLK_F3) {
                    show_debug = !show_debug;
                } else if (key == SDLK_l) {
                    lang_ru = !lang_ru;
                } else if (key == SDLK_m) {
                    show_sector_modal = !show_sector_modal;
                } else if (key == SDLK_SPACE) {
                    SimCommand c{SimCmdType::TriggerWave, 0, 0, 0, 0, 0, 0, 0};
                    dispatch_cmd(c);
                } else if (key == SDLK_p) {
                    const uint8_t next_p = (active_w.hot->flags & WORLD_FLAG_PAUSED) ? 0u : 1u;
                    SimCommand c{SimCmdType::SetPaused, 0, 0, next_p, 0, 0, 0, 0};
                    dispatch_cmd(c);
                } else if (key == SDLK_b) {
                    const uint8_t next_sb = (active_w.hot->flags & WORLD_FLAG_SANDBOX) ? 0u : 1u;
                    SimCommand c{SimCmdType::SetSandbox, 0, 0, next_sb, 0, 0, 0, 0};
                    dispatch_cmd(c);
                    show_toast(next_sb ? (lang_ru ? "ПЕСОЧНИЦА: БЕСПЛАТНАЯ ПОСТРОЙКА" : "SANDBOX ENABLED")
                                       : (lang_ru ? "КАМПАНИЯ: РЕСУРСЫ ЯДРА" : "SURVIVAL COSTS ENABLED"), cur_us);
                } else if (key == SDLK_F5 && !net.is_connected()) {
                    if (save_world_file(local_world, "serpulo_save.msv1")) {
                        show_toast(lang_ru ? "СОХРАНЕНО В SERPULO_SAVE.MSV1" : "SAVED SERPULO_SAVE.MSV1", cur_us);
                    }
                } else if (key == SDLK_F9 && !net.is_connected()) {
                    if (load_world_file(local_world, "serpulo_save.msv1")) {
                        cam_x = static_cast<float>(local_world.hot->core_x) + 1.5f;
                        cam_y = static_cast<float>(local_world.hot->core_y);
                        show_toast(lang_ru ? "ЗАГРУЖЕНО SERPULO_SAVE.MSV1" : "LOADED SERPULO_SAVE.MSV1", cur_us);
                    } else {
                        show_toast(lang_ru ? "ФАЙЛ СОХРАНЕНИЯ НЕ НАЙДЕН" : "SAVE FILE NOT FOUND", cur_us);
                    }
                } else if (key == SDLK_F2) {
                    if (net.is_connected()) {
                        net.disconnect();
                        show_toast(lang_ru ? "ОТКЛЮЧЕНО ОТ ESP32 -> ЛОКАЛЬНЫЙ ПК" : "SWITCHED TO LOCAL PC SIMCORE", cur_us);
                    } else {
                        if (net.connect_tcp(cli_tcp_host, cli_tcp_port) ||
                            net.connect_tcp("127.0.0.1", cli_tcp_port)) {
                            show_toast(lang_ru ? "ПОДКЛЮЧЕНО К СЕРВЕРУ 0x4D53!" : "CONNECTED TO 0x4D53 SERVER!", cur_us);
                        } else {
                            show_toast(lang_ru ? "ESP32 НЕ НАЙДЕН (192.168.4.1:26789)" : "ESP32 SERVER UNREACHABLE", cur_us);
                        }
                    }
                } else if (key >= SDLK_1 && key <= SDLK_7) {
                    cur_category = static_cast<uint8_t>(1 + (key - SDLK_1));
                    for (size_t b = 0; b < kBlockCount; ++b) {
                        if (kBlocksTable[b].category == cur_category) {
                            selected_block = static_cast<uint16_t>(b);
                            break;
                        }
                    }
                }
            } else if (ev.type == SDL_MOUSEBUTTONDOWN) {
                if (ev.button.button == SDL_BUTTON_MIDDLE) {
                    mmb_panning = true;
                } else if (ev.button.button == SDL_BUTTON_LEFT) {
                    if (show_sector_modal) {
                        const float mw_box = 860.0f;
                        const float mh_box = 540.0f;
                        const float mx0 = (win_w - mw_box) * 0.5f;
                        const float my0 = (win_h - mh_box) * 0.5f;
                        if (mouse_x < mx0 || mouse_x > mx0 + mw_box || mouse_y < my0 || mouse_y > my0 + mh_box) {
                            show_sector_modal = false;
                        } else {
                            for (size_t s = 0; s < kSectorPresetCount; ++s) {
                                const int col = static_cast<int>(s % 3u);
                                const int row = static_cast<int>(s / 3u);
                                const float bx = mx0 + 18.0f + col * 278.0f;
                                const float by = my0 + 52.0f + row * 46.0f;
                                if (mouse_x >= bx && mouse_x <= bx + 268.0f &&
                                    mouse_y >= by && mouse_y <= by + 40.0f) {
                                    SimCommand cmd{SimCmdType::SelectSector, 0, 0, 0, 0, 0, static_cast<uint16_t>(s), 0};
                                    dispatch_cmd(cmd);
                                    show_sector_modal = false;
                                    show_toast(lang_ru ? kSectorsTable[s].title_ru : kSectorsTable[s].name, cur_us);
                                    break;
                                }
                            }
                        }
                    } else if (mouse_y < top_bar_h) {
                        // Кнопки верхней панели: [ВОЛНА] [ПАУЗА] [СЕКТОРА(M)] [ПЕСОЧН(B)] [ESP32(F2)]
                        const float btn_x0 = static_cast<float>(win_w) - 610.0f;
                        if (mouse_x >= btn_x0 && mouse_x < btn_x0 + 110.0f) {
                            dispatch_cmd({SimCmdType::TriggerWave, 0, 0, 0, 0, 0, 0, 0});
                        } else if (mouse_x >= btn_x0 + 118.0f && mouse_x < btn_x0 + 228.0f) {
                            const uint8_t np = (active_w.hot->flags & WORLD_FLAG_PAUSED) ? 0u : 1u;
                            dispatch_cmd({SimCmdType::SetPaused, 0, 0, np, 0, 0, 0, 0});
                        } else if (mouse_x >= btn_x0 + 236.0f && mouse_x < btn_x0 + 356.0f) {
                            show_sector_modal = !show_sector_modal;
                        } else if (mouse_x >= btn_x0 + 364.0f && mouse_x < btn_x0 + 480.0f) {
                            const uint8_t nsb = (active_w.hot->flags & WORLD_FLAG_SANDBOX) ? 0u : 1u;
                            dispatch_cmd({SimCmdType::SetSandbox, 0, 0, nsb, 0, 0, 0, 0});
                        } else if (mouse_x >= btn_x0 + 488.0f && mouse_x < btn_x0 + 602.0f) {
                            if (net.is_connected()) net.disconnect();
                            else if (!net.connect_tcp(cli_tcp_host, cli_tcp_port)) {
                                net.connect_tcp("127.0.0.1", cli_tcp_port);
                            }
                        }
                    } else if (mouse_y > win_h - bot_bar_h) {
                        // Вкладки категорий или карточки блоков
                        const float py0 = static_cast<float>(win_h) - bot_bar_h;
                        if (mouse_y < py0 + 30.0f) {
                            for (int c = 0; c < 7; ++c) {
                                const float cx0 = 14.0f + c * 136.0f;
                                if (mouse_x >= cx0 && mouse_x <= cx0 + 130.0f) {
                                    cur_category = kCategories[c].cat;
                                    for (size_t b = 0; b < kBlockCount; ++b) {
                                        if (kBlocksTable[b].category == cur_category) {
                                            selected_block = static_cast<uint16_t>(b);
                                            break;
                                        }
                                    }
                                }
                            }
                        } else {
                            int slot_i = 0;
                            for (size_t b = 0; b < kBlockCount; ++b) {
                                if (kBlocksTable[b].category != cur_category) continue;
                                const float bx = 14.0f + slot_i * 144.0f;
                                if (mouse_x >= bx && mouse_x <= bx + 138.0f) {
                                    selected_block = static_cast<uint16_t>(b);
                                    break;
                                }
                                ++slot_i;
                            }
                        }
                    } else if (mouse_x >= mm_x && mouse_x <= mm_x + mm_size &&
                               mouse_y >= mm_y && mouse_y <= mm_y + mm_size) {
                        cam_x = ((mouse_x - mm_x) / mm_size) * active_w.map->width;
                        cam_y = ((mouse_y - mm_y) / mm_size) * active_w.map->height;
                    } else {
                        lmb_dragging = true;
                        int tx = 0, ty = 0;
                        screen_to_tile(mouse_x, mouse_y, tx, ty);
                        last_drag_tx = tx;
                        last_drag_ty = ty;
                        dispatch_cmd({SimCmdType::PlaceBlock, build_rot, 0u, 0u,
                                      static_cast<int16_t>(tx), static_cast<int16_t>(ty), selected_block, 0u});
                    }
                } else if (ev.button.button == SDL_BUTTON_RIGHT && !mouse_on_ui) {
                    rmb_dragging = true;
                    int tx = 0, ty = 0;
                    screen_to_tile(mouse_x, mouse_y, tx, ty);
                    dispatch_cmd({SimCmdType::RemoveBlock, 0u, 0u, 0u,
                                  static_cast<int16_t>(tx), static_cast<int16_t>(ty), 0u, 0u});
                }
            } else if (ev.type == SDL_MOUSEBUTTONUP) {
                if (ev.button.button == SDL_BUTTON_MIDDLE) mmb_panning = false;
                if (ev.button.button == SDL_BUTTON_LEFT) lmb_dragging = false;
                if (ev.button.button == SDL_BUTTON_RIGHT) rmb_dragging = false;
            } else if (ev.type == SDL_MOUSEMOTION) {
                if (mmb_panning) {
                    cam_x -= static_cast<float>(ev.motion.xrel) / tile_px;
                    cam_y -= static_cast<float>(ev.motion.yrel) / tile_px;
                } else if (lmb_dragging && !mouse_on_ui) {
                    int tx = 0, ty = 0;
                    screen_to_tile(mouse_x, mouse_y, tx, ty);
                    if (tx != last_drag_tx || ty != last_drag_ty) {
                        // Автоповорот конвейеров и труб вдоль протяжки мышью
                        const BlockRole rl = kBlocksTable[selected_block].role;
                        if (rl == BlockRole::CONVEYOR || rl == BlockRole::PIPE) {
                            const int dx = tx - last_drag_tx;
                            const int dy = ty - last_drag_ty;
                            if (abs(dx) >= abs(dy)) build_rot = (dx >= 0) ? 0u : 2u;
                            else build_rot = (dy < 0) ? 1u : 3u;
                        }
                        last_drag_tx = tx;
                        last_drag_ty = ty;
                        dispatch_cmd({SimCmdType::PlaceBlock, build_rot, 0u, 0u,
                                      static_cast<int16_t>(tx), static_cast<int16_t>(ty), selected_block, 0u});
                    }
                } else if (rmb_dragging && !mouse_on_ui) {
                    int tx = 0, ty = 0;
                    screen_to_tile(mouse_x, mouse_y, tx, ty);
                    dispatch_cmd({SimCmdType::RemoveBlock, 0u, 0u, 0u,
                                  static_cast<int16_t>(tx), static_cast<int16_t>(ty), 0u, 0u});
                }
            }
        }

        // Движение камеры клавишами WASD / стрелками
        const Uint8* ks = SDL_GetKeyboardState(nullptr);
        const float pan_spd = (520.0f / tile_px) * static_cast<float>(dt_s);
        if (ks[SDL_SCANCODE_W] || ks[SDL_SCANCODE_UP])    cam_y -= pan_spd;
        if (ks[SDL_SCANCODE_S] || ks[SDL_SCANCODE_DOWN])  cam_y += pan_spd;
        if (ks[SDL_SCANCODE_A] || ks[SDL_SCANCODE_LEFT])  cam_x -= pan_spd;
        if (ks[SDL_SCANCODE_D] || ks[SDL_SCANCODE_RIGHT]) cam_x += pan_spd;

        // Шаг симуляции (локальный 60 TPS либо приём кадров с ESP32-S3)
        if (net.is_connected()) {
            net.poll(remote_world, cur_us);
        } else {
            sim_accum_s += dt_s;
            int steps = 0;
            while (sim_accum_s >= (1.0 / 60.0) && steps < 4) {
                const uint64_t t0 = now_micros();
                sim_step_tick(local_world);
                last_local_tick_us = static_cast<uint32_t>(now_micros() - t0);
                sim_accum_s -= (1.0 / 60.0);
                ++steps;
            }
        }

        SimWorld& w = net.is_connected() ? remote_world : local_world;

        // ==================== ОТРИСОВКА КАДРА (OpenGL 3.3) ====================
        gl.Viewport(0, 0, win_w, win_h);
        gl.ClearColor(0.08f, 0.09f, 0.11f, 1.0f);
        gl.Clear(gl33::GL_COLOR_BUFFER_BIT_V);
        gl.Enable(gl33::GL_BLEND_V);
        gl.BlendFunc(gl33::GL_SRC_ALPHA_V, gl33::GL_ONE_MINUS_SRC_ALPHA_V);

        batch.begin(win_w, win_h);

        auto tile_to_screen_x = [&](float wx) { return (wx - cam_x) * tile_px + win_w * 0.5f; };
        auto tile_to_screen_y = [&](float wy) { return (wy - cam_y) * tile_px + win_h * 0.5f; };

        const int min_tx = std::max(0, static_cast<int>(floorf(cam_x - (win_w * 0.5f) / tile_px)) - 1);
        const int max_tx = std::min(static_cast<int>(w.map->width) - 1,
                                    static_cast<int>(ceilf(cam_x + (win_w * 0.5f) / tile_px)) + 1);
        const int min_ty = std::max(0, static_cast<int>(floorf(cam_y - (win_h * 0.5f) / tile_px)) - 1);
        const int max_ty = std::min(static_cast<int>(w.map->height) - 1,
                                    static_cast<int>(ceilf(cam_y + (win_h * 0.5f) / tile_px)) + 1);

        // 1. Видимые тайлы карты (пол, рудные кристаллы, скальные стены, сетка)
        for (int ty = min_ty; ty <= max_ty; ++ty) {
            const float sy = tile_to_screen_y(static_cast<float>(ty));
            for (int tx = min_tx; tx <= max_tx; ++tx) {
                const float sx = tile_to_screen_x(static_cast<float>(tx));
                const size_t idx = static_cast<size_t>(ty) * w.map->width + static_cast<size_t>(tx);

                batch.rect(sx, sy, tile_px + 0.5f, tile_px + 0.5f,
                           floor_color(w.map->floor[idx], w.hot->tick, tx, ty));

                const uint8_t ore = w.map->ore[idx];
                if (ore < kItemCount) {
                    const Color4 oc = rgba_hex(kItemsTable[ore].color_rgb);
                    const float p1 = tile_px * 0.22f;
                    const float s1 = tile_px * 0.28f;
                    batch.rect(sx + p1, sy + p1, s1, s1, oc);
                    batch.rect(sx + tile_px * 0.52f, sy + tile_px * 0.46f, s1, s1, oc);
                    batch.rect(sx + tile_px * 0.28f, sy + tile_px * 0.56f, s1 * 0.8f, s1 * 0.8f, darken(oc, 0.8f));
                }

                const uint8_t wl = w.map->wall[idx];
                if (wl != 0u) {
                    const Color4 wc = wall_env_color(wl);
                    batch.rect(sx, sy, tile_px + 0.5f, tile_px + 0.5f, wc);
                    batch.rect(sx + tile_px * 0.12f, sy + tile_px * 0.12f,
                               tile_px * 0.76f, tile_px * 0.76f, darken(wc, 1.18f));
                }

                if (show_grid && tile_px >= 14.0f) {
                    batch.rect(sx, sy, tile_px, 1.0f, {255, 255, 255, 14});
                    batch.rect(sx, sy, 1.0f, tile_px, {255, 255, 255, 14});
                }
            }
        }

        // Маркер зоны спавна врагов Crux
        {
            const float spx = tile_to_screen_x(static_cast<float>(w.hot->spawn_x) + 0.5f);
            const float spy = tile_to_screen_y(static_cast<float>(w.hot->spawn_y) + 0.5f);
            batch.circle_outline(spx, spy, tile_px * 4.5f, 28, 2.0f, {255, 90, 90, 140});
        }

        // 2. Здания + предметы на конвейерах + лазеры энергосети и мостов
        for (size_t i = 0; i < kMaxBuildings; ++i) {
            const SimBuilding& b = w.hot->buildings[i];
            if (!b.active || b.block_id >= kBlockCount) continue;
            const BlockDef& def = kBlocksTable[b.block_id];
            const float bx = tile_to_screen_x(static_cast<float>(b.x));
            const float by = tile_to_screen_y(static_cast<float>(b.y));
            const float bw = def.size * tile_px;

            if (bx + bw < -64.0f || by + bw < -64.0f || bx > win_w + 64.0f || by > win_h + 64.0f) {
                continue;
            }

            const Color4 base_c = rgba_hex(def.color_rgb);
            batch.rect(bx + 1.0f, by + 1.0f, bw - 2.0f, bw - 2.0f, darken(base_c, 0.58f));
            batch.rect(bx + 3.0f, by + 3.0f, bw - 6.0f, bw - 6.0f, base_c);

            // Направленный шеврон для конвейеров и труб + движущийся предмет
            if (def.role == BlockRole::CONVEYOR || def.role == BlockRole::PIPE) {
                const float cx = bx + bw * 0.5f;
                const float cy = by + bw * 0.5f;
                const int d = b.rotation & 3;
                const float ax = kDirDx[d] * tile_px * 0.30f;
                const float ay = kDirDy[d] * tile_px * 0.30f;
                batch.line(cx - ax * 0.6f, cy - ay * 0.6f, cx + ax, cy + ay, 2.5f, {255, 240, 200, 200});

                if (def.role == BlockRole::CONVEYOR && b.item_count > 0u && b.item_id < kItemCount) {
                    const float prog = (def.param_ticks > 0u)
                        ? (static_cast<float>(b.progress_ticks) / static_cast<float>(def.param_ticks))
                        : 0.5f;
                    const float shift = (prog - 0.5f) * tile_px * 0.75f;
                    const float ix = cx + kDirDx[d] * shift;
                    const float iy = cy + kDirDy[d] * shift;
                    const float isz = tile_px * 0.42f;
                    batch.rect(ix - isz * 0.5f, iy - isz * 0.5f, isz, isz,
                               rgba_hex(kItemsTable[b.item_id].color_rgb));
                }
            } else if (def.role == BlockRole::DRILL) {
                const float ang = static_cast<float>((w.hot->tick * 4u) % 360u) * 0.017453f;
                const float cx = bx + bw * 0.5f;
                const float cy = by + bw * 0.5f;
                const float r = bw * 0.28f;
                batch.line(cx - cosf(ang) * r, cy - sinf(ang) * r,
                           cx + cosf(ang) * r, cy + sinf(ang) * r, 3.0f, {50, 55, 65, 255});
                batch.line(cx + sinf(ang) * r, cy - cosf(ang) * r,
                           cx - sinf(ang) * r, cy + cosf(ang) * r, 3.0f, {50, 55, 65, 255});
            } else if (def.role == BlockRole::TURRET_ITEM || def.role == BlockRole::TURRET_AIR ||
                       def.role == BlockRole::TURRET_ARTY || def.role == BlockRole::TURRET_PWR) {
                const float cx = bx + bw * 0.5f;
                const float cy = by + bw * 0.5f;
                const float rad = (static_cast<float>(b.aim_bam10) / 1024.0f) * 6.2831853f;
                batch.line(cx, cy, cx + cosf(rad) * bw * 0.48f, cy + sinf(rad) * bw * 0.48f,
                           std::max(3.0f, tile_px * 0.20f), {45, 48, 58, 255});
            } else if (def.role == BlockRole::CORE) {
                batch.frame_rect(bx + 4.0f, by + 4.0f, bw - 8.0f, bw - 8.0f, 2.5f, {255, 245, 190, 255});
            }

            // Луч мостового конвейера
            if (def.role == BlockRole::BRIDGE && b.link_target_id < kMaxBuildings &&
                w.hot->buildings[b.link_target_id].active) {
                const SimBuilding& dst = w.hot->buildings[b.link_target_id];
                batch.line(bx + tile_px * 0.5f, by + tile_px * 0.5f,
                           tile_to_screen_x(dst.x + 0.5f), tile_to_screen_y(dst.y + 0.5f),
                           3.0f, {160, 220, 255, 130});
            }

            // Лучи силового узла к соседним энергоблокам в радиусе
            if (def.role == BlockRole::PWR_NODE) {
                const int r_tiles = fx_to_int_round(def.range_tiles_q16);
                for (size_t j = 0; j < kMaxBuildings; ++j) {
                    if (j == i || !w.hot->buildings[j].active) continue;
                    const SimBuilding& nb = w.hot->buildings[j];
                    const BlockDef& nd = kBlocksTable[nb.block_id];
                    if (nd.power_prod_q16 == 0 && nd.power_cons_q16 == 0 &&
                        nd.role != BlockRole::BATTERY &&
                        !(nd.role == BlockRole::PWR_NODE && j > i)) {
                        continue;
                    }
                    const int dx = nb.x - b.x;
                    const int dy = nb.y - b.y;
                    if (dx * dx + dy * dy <= r_tiles * r_tiles) {
                        batch.line(bx + bw * 0.5f, by + bw * 0.5f,
                                   tile_to_screen_x(nb.x + nd.size * 0.5f),
                                   tile_to_screen_y(nb.y + nd.size * 0.5f),
                                   1.8f, {255, 232, 120, 115});
                    }
                }
            }

            // Полоска здоровья повреждённых построек
            if (b.hp < b.max_hp && b.max_hp > 0) {
                const float ratio = static_cast<float>(b.hp) / static_cast<float>(b.max_hp);
                batch.rect(bx + 2.0f, by - 5.0f, bw - 4.0f, 3.5f, {30, 30, 30, 210});
                batch.rect(bx + 2.0f, by - 5.0f, (bw - 4.0f) * ratio, 3.5f, {110, 240, 125, 240});
            }
        }

        // 3. Юниты (с плавной интерполяцией при игре через ESP32-S3)
        const double alpha = net.interp_alpha(cur_us);
        for (size_t i = 0; i < kMaxUnits; ++i) {
            const SimUnit& u = w.hot->units[i];
            if (!u.active) continue;
            double wx = static_cast<double>(u.x_q16) / 65536.0;
            double wy = static_cast<double>(u.y_q16) / 65536.0;
            if (net.is_connected()) {
                net.interpolated_unit_pos(i, alpha, wx, wy);
            }
            const float sx = tile_to_screen_x(static_cast<float>(wx));
            const float sy = tile_to_screen_y(static_cast<float>(wy));
            const UnitTypeDef& ud = kUnitsTable[u.unit_type % kUnitTypeCount];
            const Color4 uc = (u.team == 1u) ? Color4{255, 92, 92, 255} : rgba_hex(ud.color_rgb);
            const float r = tile_px * (u.flying ? 0.44f : 0.38f);
            const float rad = (static_cast<float>(u.angle_bam10) / 1024.0f) * 6.2831853f;

            batch.tri(sx + cosf(rad) * r * 1.35f, sy + sinf(rad) * r * 1.35f,
                      sx + cosf(rad + 2.35f) * r, sy + sinf(rad + 2.35f) * r,
                      sx + cosf(rad - 2.35f) * r, sy + sinf(rad - 2.35f) * r, uc);

            if (u.hp < u.max_hp && u.max_hp > 0) {
                const float hpr = static_cast<float>(u.hp) / static_cast<float>(u.max_hp);
                batch.rect(sx - 12.0f, sy - r - 7.0f, 24.0f, 3.5f, {20, 20, 25, 220});
                batch.rect(sx - 12.0f, sy - r - 7.0f, 24.0f * hpr, 3.5f, {255, 85, 85, 245});
            }
        }

        // 4. Снаряды и лазерные импульсы
        for (size_t i = 0; i < kMaxProjectiles; ++i) {
            const SimProjectile& p = w.hot->projectiles[i];
            if (!p.active) continue;
            double wx = static_cast<double>(p.x_q16) / 65536.0;
            double wy = static_cast<double>(p.y_q16) / 65536.0;
            if (net.is_connected()) {
                net.interpolated_proj_pos(i, alpha, wx, wy);
            }
            const float sx = tile_to_screen_x(static_cast<float>(wx));
            const float sy = tile_to_screen_y(static_cast<float>(wy));
            const Color4 pc = (p.style == 2u)
                ? Color4{145, 235, 255, 255}
                : ((p.team == 0u) ? Color4{255, 226, 120, 255} : Color4{255, 105, 95, 255});
            const float bsz = std::max(4.0f, tile_px * 0.22f);
            batch.rect(sx - bsz * 0.5f, sy - bsz * 0.5f, bsz, bsz, pc);
        }

        // 5. Призрак постройки под курсором + круг дальности турелей/узлов
        if (!mouse_on_ui && selected_block < kBlockCount) {
            int htx = 0, hty = 0;
            screen_to_tile(mouse_x, mouse_y, htx, hty);
            const BlockDef& bd = kBlocksTable[selected_block];
            const bool ok = sim_can_place_block(w, static_cast<int16_t>(htx), static_cast<int16_t>(hty),
                                                selected_block, 0u);
            const float gx = tile_to_screen_x(static_cast<float>(htx));
            const float gy = tile_to_screen_y(static_cast<float>(hty));
            const float gw = bd.size * tile_px;
            const Color4 gc = ok ? Color4{120, 255, 140, 110} : Color4{255, 95, 95, 120};
            batch.rect(gx, gy, gw, gw, gc);
            batch.frame_rect(gx, gy, gw, gw, 2.0f, ok ? Color4{140, 255, 160, 230} : Color4{255, 110, 110, 230});

            if (bd.role == BlockRole::CONVEYOR || bd.role == BlockRole::PIPE || bd.role == BlockRole::BRIDGE) {
                const float cx = gx + gw * 0.5f;
                const float cy = gy + gw * 0.5f;
                batch.line(cx, cy, cx + kDirDx[build_rot] * tile_px * 0.45f,
                           cy + kDirDy[build_rot] * tile_px * 0.45f, 3.0f, {255, 255, 255, 220});
            }
            if (bd.range_tiles_q16 > 0) {
                const float rr = (static_cast<float>(bd.range_tiles_q16) / 65536.0f) * tile_px;
                batch.circle_outline(gx + gw * 0.5f, gy + gw * 0.5f, rr, 40, 1.5f, {255, 225, 130, 135});
            }
        }

        // ==================== ВЕРХНЯЯ ПАНЕЛЬ РЕСУРСОВ И УПРАВЛЕНИЯ ====================
        batch.rect(0.0f, 0.0f, static_cast<float>(win_w), top_bar_h, {18, 20, 26, 238});
        batch.rect(0.0f, top_bar_h - 2.0f, static_cast<float>(win_w), 2.0f, {255, 211, 127, 160});

        // Инвентарь ключевых ресурсов ядра Серпуло
        const uint8_t hud_items[8] = { 0, 1, 3, 9, 2, 6, 7, 5 }; // Cu, Pb, C(gr), Si, Glass, Ti, Th, Coal
        for (int k = 0; k < 8; ++k) {
            const uint8_t iid = hud_items[k];
            const float ix = 12.0f + k * 84.0f;
            batch.rect(ix, 10.0f, 12.0f, 12.0f, rgba_hex(kItemsTable[iid].color_rgb));
            char num[24];
            snprintf(num, sizeof(num), "%" PRId32, w.hot->core_items[iid]);
            batch.text(ix + 16.0f, 10.0f, 2, num, {235, 238, 245, 255});
            batch.text(ix, 30.0f, 1, lang_ru ? kItemsTable[iid].title_ru : kItemsTable[iid].name, {165, 172, 188, 255});
        }

        // Индикатор волны и баланса энергии
        {
            char wave_txt[96];
            const int sec_left = static_cast<int>(w.hot->wave_countdown_ticks / 60u);
            snprintf(wave_txt, sizeof(wave_txt),
                     lang_ru ? "ВОЛНА %u/%u (%dС)  ВРАГИ:%u  ЭНЕРГИЯ:%+d (%d/%d)"
                             : "WAVE %u/%u (%dS)  ENEMIES:%u  PWR:%+d (%d/%d)",
                     static_cast<unsigned>(w.hot->wave),
                     static_cast<unsigned>(w.hot->win_wave),
                     sec_left,
                     static_cast<unsigned>(w.hot->enemy_units),
                     static_cast<int>(fx_to_int_round(w.hot->power_produced_q16 - w.hot->power_consumed_q16)),
                     static_cast<int>(w.hot->power_stored_units),
                     static_cast<int>(w.hot->power_capacity_units));
            batch.text(12.0f, top_bar_h + 10.0f, 2, wave_txt, {255, 224, 140, 255});
        }

        // Кнопки справа вверху
        auto draw_top_btn = [&](float x, float wbtn, const char* label, Color4 bg) {
            batch.rect(x, 9.0f, wbtn, 36.0f, bg);
            batch.frame_rect(x, 9.0f, wbtn, 36.0f, 1.5f, {255, 215, 130, 170});
            const int tw = ui_font::text_width_px(label, 2);
            batch.text(x + (wbtn - tw) * 0.5f, 20.0f, 2, label, {250, 250, 252, 255});
        };
        const float bx0 = static_cast<float>(win_w) - 610.0f;
        draw_top_btn(bx0,          110.0f, lang_ru ? "ВОЛНА" : "WAVE",    {72, 42, 42, 245});
        draw_top_btn(bx0 + 118.0f, 110.0f,
                     (w.hot->flags & WORLD_FLAG_PAUSED) ? (lang_ru ? "ПУСК" : "PLAY") : (lang_ru ? "ПАУЗА" : "PAUSE"),
                     (w.hot->flags & WORLD_FLAG_PAUSED) ? Color4{85, 72, 30, 245} : Color4{36, 42, 54, 245});
        draw_top_btn(bx0 + 236.0f, 120.0f, lang_ru ? "СЕКТОРА" : "SECTORS", {36, 52, 68, 245});
        draw_top_btn(bx0 + 364.0f, 116.0f, lang_ru ? "ПЕСОЧН." : "SANDBOX",
                     (w.hot->flags & WORLD_FLAG_SANDBOX) ? Color4{42, 82, 52, 245} : Color4{36, 42, 54, 245});
        draw_top_btn(bx0 + 488.0f, 114.0f, net.is_connected() ? "ESP32:ON" : "ESP32:F2",
                     net.is_connected() ? Color4{32, 96, 76, 245} : Color4{48, 42, 66, 245});

        // ==================== МИНИКАРТА (128x128) ====================
        batch.rect(mm_x - 3.0f, mm_y - 3.0f, mm_size + 6.0f, mm_size + 6.0f, {16, 18, 24, 240});
        const float cell_mm = mm_size / 32.0f;
        for (int my = 0; my < 32; ++my) {
            for (int mx = 0; mx < 32; ++mx) {
                const int tx = (mx * w.map->width) / 32;
                const int ty = (my * w.map->height) / 32;
                const size_t idx = static_cast<size_t>(ty) * w.map->width + static_cast<size_t>(tx);
                Color4 mc = floor_color(w.map->floor[idx], 0u, 0, 0);
                if (w.map->wall[idx] != 0u) mc = wall_env_color(w.map->wall[idx]);
                if (w.map->building_at[idx] != kInvalidIndex) mc = {255, 211, 127, 255};
                batch.rect(mm_x + mx * cell_mm, mm_y + my * cell_mm, cell_mm + 0.5f, cell_mm + 0.5f, mc);
            }
        }
        for (size_t u = 0; u < kMaxUnits; ++u) {
            if (!w.hot->units[u].active) continue;
            const float ux = mm_x + (static_cast<float>(fx_to_int_floor(w.hot->units[u].x_q16)) / w.map->width) * mm_size;
            const float uy = mm_y + (static_cast<float>(fx_to_int_floor(w.hot->units[u].y_q16)) / w.map->height) * mm_size;
            batch.rect(ux - 2.0f, uy - 2.0f, 4.0f, 4.0f, {255, 70, 70, 255});
        }
        batch.frame_rect(mm_x - 3.0f, mm_y - 3.0f, mm_size + 6.0f, mm_size + 6.0f, 1.5f, {255, 211, 127, 170});

        // ==================== ДЕБАГ / ТЕЛЕМЕТРИЯ [F3] ====================
        if (show_debug) {
            const float dx0 = 12.0f;
            const float dy0 = top_bar_h + 36.0f;
            batch.rect(dx0, dy0, 430.0f, 94.0f, {14, 16, 22, 200});
            char line1[128], line2[128], line3[128], line4[128];
            const SectorPresetDef& sec = kSectorsTable[w.hot->sector_preset_id % kSectorPresetCount];
            snprintf(line1, sizeof(line1), "MODE: %s | SECTOR: %s (#%d)",
                     net.is_connected() ? net.endpoint_label() : (lang_ru ? "ЛОКАЛЬНЫЙ ПК (60 TPS)" : "LOCAL PC (60 TPS)"),
                     lang_ru ? sec.title_ru : sec.name,
                     static_cast<int>(sec.sector_num));
            snprintf(line2, sizeof(line2), "FPS: %.0f | TICK: %" PRIu32 " | SIM_US: %u | BLD:%u UNIT:%u PROJ:%u",
                     fps_smooth, w.hot->tick,
                     net.is_connected() ? net.server_tick_us() : last_local_tick_us,
                     static_cast<unsigned>(w.hot->active_buildings),
                     static_cast<unsigned>(w.hot->active_units),
                     static_cast<unsigned>(w.hot->active_projectiles));
            snprintf(line3, sizeof(line3), "SRAM HOT: %.1f KB | PSRAM MAP: %.1f KB | Q16.16 NO-FLOAT",
                     sizeof(SimHotState) / 1024.0, sizeof(SimMapStorage) / 1024.0);
            if (net.is_connected()) {
                snprintf(line4, sizeof(line4), "0x4D53 RTT: %.2f MS | RX: %.1f KB/S | FRAMES: %u (CRC_ERR:%u)",
                         net.rtt_us() / 1000.0, net.rx_kbps(), net.rx_frames(), net.crc_errors());
            } else {
                snprintf(line4, sizeof(line4), "KEYS: WASD/WHEEL=CAM  LMB=BUILD  RMB=DEL  R=ROT  F5/F9=SAVE  F2=ESP32");
            }
            batch.text(dx0 + 8.0f, dy0 + 8.0f,  1, line1, {140, 235, 195, 255});
            batch.text(dx0 + 8.0f, dy0 + 28.0f, 1, line2, {225, 230, 240, 255});
            batch.text(dx0 + 8.0f, dy0 + 48.0f, 1, line3, {185, 195, 215, 255});
            batch.text(dx0 + 8.0f, dy0 + 68.0f, 1, line4, {255, 215, 130, 255});
        }

        // Баннер захвата сектора / поражения / уведомлений
        if (w.hot->flags & WORLD_FLAG_SECTOR_CAPTURED) {
            batch.rect(win_w * 0.5f - 220.0f, top_bar_h + 16.0f, 440.0f, 38.0f, {30, 95, 52, 240});
            batch.text(win_w * 0.5f - 180.0f, top_bar_h + 28.0f, 2,
                       lang_ru ? "СЕКТОР ЗАХВАЧЕН! [M] СЛЕДУЮЩИЙ" : "SECTOR CAPTURED! PRESS [M]",
                       {240, 255, 240, 255});
        } else if (w.hot->flags & WORLD_FLAG_GAME_OVER) {
            batch.rect(win_w * 0.5f - 220.0f, top_bar_h + 16.0f, 440.0f, 38.0f, {125, 32, 32, 240});
            batch.text(win_w * 0.5f - 185.0f, top_bar_h + 28.0f, 2,
                       lang_ru ? "ЯДРО УНИЧТОЖЕНО! [M] ПЕРЕЗАПУСК" : "CORE DESTROYED! PRESS [M]",
                       {255, 235, 235, 255});
        } else if (cur_us < toast_until_us && toast_msg[0] != '\0') {
            const int tw = ui_font::text_width_px(toast_msg, 2) + 28;
            batch.rect((win_w - tw) * 0.5f, top_bar_h + 44.0f, static_cast<float>(tw), 32.0f, {28, 36, 52, 240});
            batch.frame_rect((win_w - tw) * 0.5f, top_bar_h + 44.0f, static_cast<float>(tw), 32.0f, 1.5f, {255, 211, 127, 200});
            batch.text((win_w - tw) * 0.5f + 14.0f, top_bar_h + 53.0f, 2, toast_msg, {255, 240, 185, 255});
        }

        // ==================== НИЖНЯЯ ПАЛИТРА СТРОИТЕЛЬСТВА ====================
        const float py0 = static_cast<float>(win_h) - bot_bar_h;
        batch.rect(0.0f, py0, static_cast<float>(win_w), bot_bar_h, {18, 20, 26, 242});
        batch.rect(0.0f, py0, static_cast<float>(win_w), 2.0f, {255, 211, 127, 160});

        for (int c = 0; c < 7; ++c) {
            const float cx0 = 14.0f + c * 136.0f;
            const bool sel = (cur_category == kCategories[c].cat);
            batch.rect(cx0, py0 + 5.0f, 130.0f, 24.0f, sel ? Color4{72, 62, 34, 255} : Color4{30, 34, 44, 255});
            if (sel) batch.frame_rect(cx0, py0 + 5.0f, 130.0f, 24.0f, 1.5f, {255, 211, 127, 255});
            batch.text(cx0 + 8.0f, py0 + 11.0f, 1, lang_ru ? kCategories[c].ru : kCategories[c].en,
                       sel ? Color4{255, 232, 150, 255} : Color4{185, 192, 208, 255});
        }

        {
            char rot_hint[64];
            const char* rnames[4] = { "-> (+X)", "^ (-Y)", "<- (-X)", "v (+Y)" };
            snprintf(rot_hint, sizeof(rot_hint), "[R] %s   [L] %s", rnames[build_rot & 3u], lang_ru ? "RU" : "EN");
            batch.text(980.0f, py0 + 11.0f, 1, rot_hint, {200, 210, 230, 255});
        }

        int slot_i = 0;
        for (size_t b = 0; b < kBlockCount; ++b) {
            const BlockDef& bd = kBlocksTable[b];
            if (bd.category != cur_category) continue;
            const float bx = 14.0f + slot_i * 144.0f;
            const float by = py0 + 34.0f;
            if (bx + 138.0f > win_w - 8.0f) break;

            const bool is_sel = (selected_block == b);
            batch.rect(bx, by, 138.0f, 58.0f, is_sel ? Color4{56, 52, 34, 255} : Color4{28, 32, 42, 255});
            batch.frame_rect(bx, by, 138.0f, 58.0f, is_sel ? 2.0f : 1.0f,
                             is_sel ? Color4{255, 215, 120, 255} : Color4{75, 82, 98, 255});

            batch.rect(bx + 7.0f, by + 8.0f, 22.0f, 22.0f, rgba_hex(bd.color_rgb));
            batch.text(bx + 34.0f, by + 9.0f, 1, lang_ru ? bd.title_ru : bd.name, {240, 242, 248, 255});

            char cost_line[64] = "";
            if (bd.cost_count > 0u) {
                const uint16_t i0 = bd.cost[0].item_id;
                if (bd.cost_count >= 2u) {
                    const uint16_t i1 = bd.cost[1].item_id;
                    snprintf(cost_line, sizeof(cost_line), "%s:%u %s:%u",
                             lang_ru ? kItemsTable[i0].title_ru : kItemsTable[i0].name,
                             static_cast<unsigned>(bd.cost[0].amount),
                             lang_ru ? kItemsTable[i1].title_ru : kItemsTable[i1].name,
                             static_cast<unsigned>(bd.cost[1].amount));
                } else {
                    snprintf(cost_line, sizeof(cost_line), "%s:%u (%ux%u)",
                             lang_ru ? kItemsTable[i0].title_ru : kItemsTable[i0].name,
                             static_cast<unsigned>(bd.cost[0].amount),
                             static_cast<unsigned>(bd.size), static_cast<unsigned>(bd.size));
                }
            }
            batch.text(bx + 7.0f, by + 39.0f, 1, cost_line, {180, 190, 210, 255});
            ++slot_i;
        }

        // ==================== МОДАЛЬНОЕ ОКНО ВЫБОРА СЕКТОРА СЕРПУЛО [M] ====================
        if (show_sector_modal) {
            batch.rect(0.0f, 0.0f, static_cast<float>(win_w), static_cast<float>(win_h), {0, 0, 0, 165});
            const float mw_box = 860.0f;
            const float mh_box = 540.0f;
            const float mx0 = (win_w - mw_box) * 0.5f;
            const float my0 = (win_h - mh_box) * 0.5f;
            batch.rect(mx0, my0, mw_box, mh_box, {22, 25, 34, 250});
            batch.frame_rect(mx0, my0, mw_box, mh_box, 2.0f, {255, 211, 127, 230});
            batch.text(mx0 + 20.0f, my0 + 18.0f, 2,
                       lang_ru ? "ПЛАНЕТА СЕРПУЛО — 29 ПРЕСЕТОВ СЕКТОРОВ (MINDUSTRY V160.7)"
                               : "PLANET SERPULO — 29 SECTOR PRESETS (MINDUSTRY V160.7)",
                       {255, 224, 140, 255});

            for (size_t s = 0; s < kSectorPresetCount; ++s) {
                const SectorPresetDef& sp = kSectorsTable[s];
                const int col = static_cast<int>(s % 3u);
                const int row = static_cast<int>(s / 3u);
                const float bx = mx0 + 18.0f + col * 278.0f;
                const float by = my0 + 52.0f + row * 46.0f;
                const bool active_s = (w.hot->sector_preset_id == s);
                batch.rect(bx, by, 268.0f, 40.0f, active_s ? Color4{65, 58, 32, 255} : Color4{32, 37, 48, 255});
                batch.frame_rect(bx, by, 268.0f, 40.0f, 1.0f,
                                 active_s ? Color4{255, 215, 120, 255} : Color4{75, 84, 102, 255});
                batch.text(bx + 8.0f, by + 7.0f, 1, lang_ru ? sp.title_ru : sp.name, {242, 244, 250, 255});
                char sub[64];
                snprintf(sub, sizeof(sub), "ID:%d  DIFF:%u/10  WAVES:%u",
                         static_cast<int>(sp.sector_num),
                         static_cast<unsigned>(sp.difficulty),
                         static_cast<unsigned>(sp.capture_wave));
                batch.text(bx + 8.0f, by + 24.0f, 1, sub, {175, 188, 210, 255});
            }
        }

        batch.flush();
        SDL_GL_SwapWindow(window);
    }

    net.disconnect();
    SDL_GL_DeleteContext(gl_ctx);
    SDL_DestroyWindow(window);
    SDL_Quit();
    return 0;
}
