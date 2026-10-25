// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <stddef.h>
#include <stdint.h>

namespace simcore {

struct Fnv1a64 {
    static constexpr uint64_t kOffsetBasis = 0xCBF29CE484222325ULL;
    static constexpr uint64_t kPrime       = 0x00000100000001B3ULL;

    uint64_t value = kOffsetBasis;

    constexpr void feed_u8(uint8_t b) noexcept {
        value ^= static_cast<uint64_t>(b);
        value *= kPrime;
    }

    constexpr void feed_u16_le(uint16_t v) noexcept {
        feed_u8(static_cast<uint8_t>(v & 0xFFu));
        feed_u8(static_cast<uint8_t>((v >> 8u) & 0xFFu));
    }

    constexpr void feed_i16_le(int16_t v) noexcept {
        feed_u16_le(static_cast<uint16_t>(v));
    }

    constexpr void feed_u32_le(uint32_t v) noexcept {
        feed_u8(static_cast<uint8_t>(v & 0xFFu));
        feed_u8(static_cast<uint8_t>((v >> 8u) & 0xFFu));
        feed_u8(static_cast<uint8_t>((v >> 16u) & 0xFFu));
        feed_u8(static_cast<uint8_t>((v >> 24u) & 0xFFu));
    }

    constexpr void feed_i32_le(int32_t v) noexcept {
        feed_u32_le(static_cast<uint32_t>(v));
    }

    constexpr void feed_u64_le(uint64_t v) noexcept {
        feed_u32_le(static_cast<uint32_t>(v & 0xFFFFFFFFULL));
        feed_u32_le(static_cast<uint32_t>((v >> 32u) & 0xFFFFFFFFULL));
    }
};

struct Crc32 {
    uint32_t state = 0xFFFFFFFFu;

    constexpr void feed_u8(uint8_t b) noexcept {
        uint32_t c = state ^ static_cast<uint32_t>(b);
        for (int i = 0; i < 8; ++i) {
            c = (c & 1u) ? ((c >> 1u) ^ 0xEDB88320u) : (c >> 1u);
        }
        state = c;
    }

    constexpr void feed_u16_le(uint16_t v) noexcept {
        feed_u8(static_cast<uint8_t>(v & 0xFFu));
        feed_u8(static_cast<uint8_t>((v >> 8u) & 0xFFu));
    }

    constexpr void feed_i16_le(int16_t v) noexcept {
        feed_u16_le(static_cast<uint16_t>(v));
    }

    constexpr void feed_u32_le(uint32_t v) noexcept {
        feed_u8(static_cast<uint8_t>(v & 0xFFu));
        feed_u8(static_cast<uint8_t>((v >> 8u) & 0xFFu));
        feed_u8(static_cast<uint8_t>((v >> 16u) & 0xFFu));
        feed_u8(static_cast<uint8_t>((v >> 24u) & 0xFFu));
    }

    constexpr void feed_i32_le(int32_t v) noexcept {
        feed_u32_le(static_cast<uint32_t>(v));
    }

    constexpr void feed_u64_le(uint64_t v) noexcept {
        feed_u32_le(static_cast<uint32_t>(v & 0xFFFFFFFFULL));
        feed_u32_le(static_cast<uint32_t>((v >> 32u) & 0xFFFFFFFFULL));
    }

    constexpr uint32_t finish() const noexcept {
        return state ^ 0xFFFFFFFFu;
    }
};

// CRC-16/CCITT-FALSE (poly=0x1021, init=0xFFFF) для кадров протокола 0x4D53
constexpr uint16_t crc16_ccitt(const uint8_t* data, size_t len, uint16_t init = 0xFFFFu) noexcept {
    uint16_t crc = init;
    for (size_t i = 0; i < len; ++i) {
        crc ^= static_cast<uint16_t>(static_cast<uint16_t>(data[i]) << 8u);
        for (int bit = 0; bit < 8; ++bit) {
            if ((crc & 0x8000u) != 0u) {
                crc = static_cast<uint16_t>((crc << 1u) ^ 0x1021u);
            } else {
                crc = static_cast<uint16_t>(crc << 1u);
            }
        }
    }
    return crc;
}

} // namespace simcore
