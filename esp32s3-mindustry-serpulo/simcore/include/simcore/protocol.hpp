// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "simcore/hash.hpp"
#include "simcore/simcore.hpp"

namespace simcore {

inline constexpr uint16_t kProtoMagic       = 0x4D53u; // "MS"
inline constexpr uint8_t  kProtoVersion     = 1u;
inline constexpr size_t   kProtoHeaderBytes = 7u;
inline constexpr size_t   kProtoCrcBytes    = 2u;
inline constexpr size_t   kProtoMaxPayload  = 16384u;
inline constexpr size_t   kProtoMaxFrame    = kProtoHeaderBytes + kProtoMaxPayload + kProtoCrcBytes;

enum class ProtoMsgType : uint8_t {
    Hello         = 0x01u,
    MapStatic     = 0x02u,
    SnapshotFull  = 0x03u,
    SnapshotDelta = 0x04u,
    InputCmd      = 0x05u,
    Ping          = 0x06u,
    Pong          = 0x07u,
};

// Помощники чтения/записи little-endian без UB выравнивания
constexpr void wr_u16_le(uint8_t* p, uint16_t v) noexcept {
    p[0] = static_cast<uint8_t>(v & 0xFFu);
    p[1] = static_cast<uint8_t>((v >> 8u) & 0xFFu);
}

constexpr void wr_i16_le(uint8_t* p, int16_t v) noexcept {
    wr_u16_le(p, static_cast<uint16_t>(v));
}

constexpr void wr_u32_le(uint8_t* p, uint32_t v) noexcept {
    p[0] = static_cast<uint8_t>(v & 0xFFu);
    p[1] = static_cast<uint8_t>((v >> 8u) & 0xFFu);
    p[2] = static_cast<uint8_t>((v >> 16u) & 0xFFu);
    p[3] = static_cast<uint8_t>((v >> 24u) & 0xFFu);
}

constexpr void wr_i32_le(uint8_t* p, int32_t v) noexcept {
    wr_u32_le(p, static_cast<uint32_t>(v));
}

constexpr void wr_u64_le(uint8_t* p, uint64_t v) noexcept {
    wr_u32_le(p, static_cast<uint32_t>(v & 0xFFFFFFFFULL));
    wr_u32_le(p + 4, static_cast<uint32_t>((v >> 32u) & 0xFFFFFFFFULL));
}

constexpr uint16_t rd_u16_le(const uint8_t* p) noexcept {
    return static_cast<uint16_t>(static_cast<uint16_t>(p[0]) |
                                 static_cast<uint16_t>(static_cast<uint16_t>(p[1]) << 8u));
}

constexpr int16_t rd_i16_le(const uint8_t* p) noexcept {
    return static_cast<int16_t>(rd_u16_le(p));
}

constexpr uint32_t rd_u32_le(const uint8_t* p) noexcept {
    return static_cast<uint32_t>(p[0]) |
           (static_cast<uint32_t>(p[1]) << 8u) |
           (static_cast<uint32_t>(p[2]) << 16u) |
           (static_cast<uint32_t>(p[3]) << 24u);
}

constexpr int32_t rd_i32_le(const uint8_t* p) noexcept {
    return static_cast<int32_t>(rd_u32_le(p));
}

constexpr uint64_t rd_u64_le(const uint8_t* p) noexcept {
    return static_cast<uint64_t>(rd_u32_le(p)) |
           (static_cast<uint64_t>(rd_u32_le(p + 4)) << 32u);
}

// Упаковка готового кадра 0x4D53 (возвращает полный размер кадра или 0 при ошибке)
size_t proto_pack_frame(uint8_t* out_buf, size_t out_cap,
                        ProtoMsgType type, uint16_t seq,
                        const uint8_t* payload, size_t payload_len) noexcept;

// Сообщения верхнего уровня
size_t proto_encode_hello(uint8_t* out_buf, size_t out_cap, uint16_t seq,
                          uint16_t map_w, uint16_t map_h, uint8_t server_hz, uint16_t sector_id) noexcept;
size_t proto_encode_map_chunk(uint8_t* out_buf, size_t out_cap, uint16_t seq,
                              const SimWorld& w, uint16_t y_start, uint16_t rows) noexcept;
bool   proto_apply_map_chunk(SimWorld& w, const uint8_t* payload, size_t len) noexcept;

size_t proto_encode_snapshot(uint8_t* out_buf, size_t out_cap, uint16_t seq,
                             const SimWorld& w, bool include_buildings) noexcept;
bool   proto_apply_snapshot(SimWorld& w, const uint8_t* payload, size_t len) noexcept;

size_t proto_encode_cmd(uint8_t* out_buf, size_t out_cap, uint16_t seq, const SimCommand& cmd) noexcept;
bool   proto_decode_cmd(const uint8_t* payload, size_t len, SimCommand& out_cmd) noexcept;

size_t proto_encode_ping(uint8_t* out_buf, size_t out_cap, uint16_t seq, uint64_t client_time_us) noexcept;
size_t proto_encode_pong(uint8_t* out_buf, size_t out_cap, uint16_t seq,
                         uint64_t client_time_us, uint32_t server_tick, uint32_t last_tick_us) noexcept;

// Потоковый парсер кадров (для TCP и USB-CDC без динамической памяти)
struct ProtoParsedFrame {
    ProtoMsgType   type;
    uint16_t       seq;
    uint16_t       len;
    const uint8_t* payload;
};

struct ProtoStreamParser {
    uint8_t  buf[kProtoMaxFrame];
    uint32_t pos = 0u;
    uint32_t expected_total = 0u;
    uint32_t crc_errors = 0u;
    uint32_t frames_ok = 0u;

    void reset() noexcept {
        pos = 0u;
        expected_total = 0u;
    }

    // Подаёт 1 байт; возвращает true, когда валидный кадр собран в out_frame
    bool feed_byte(uint8_t b, ProtoParsedFrame& out_frame) noexcept;
};

} // namespace simcore
