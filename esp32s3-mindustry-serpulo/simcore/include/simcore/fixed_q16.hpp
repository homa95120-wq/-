// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <stdint.h>

namespace simcore {

using fx32_t = int32_t;

inline constexpr int32_t kFxShift = 16;
inline constexpr fx32_t  kFxOne   = 65536;
inline constexpr fx32_t  kFxHalf  = 32768;

constexpr fx32_t fx_from_int(int32_t v) noexcept {
    return static_cast<fx32_t>(static_cast<uint32_t>(v) << kFxShift);
}

constexpr int32_t fx_to_int_floor(fx32_t v) noexcept {
    return v >> kFxShift;
}

constexpr int32_t fx_to_int_round(fx32_t v) noexcept {
    return (v >= 0) ? ((v + kFxHalf) >> kFxShift) : -(((-v) + kFxHalf) >> kFxShift);
}

constexpr fx32_t fx_abs(fx32_t v) noexcept {
    return (v >= 0) ? v : -v;
}

constexpr fx32_t fx_clamp(fx32_t v, fx32_t lo, fx32_t hi) noexcept {
    return (v < lo) ? lo : ((v > hi) ? hi : v);
}

constexpr fx32_t fx_mul(fx32_t a, fx32_t b) noexcept {
    const int64_t prod = static_cast<int64_t>(a) * static_cast<int64_t>(b);
    return static_cast<fx32_t>(prod >> kFxShift);
}

constexpr fx32_t fx_div(fx32_t a, fx32_t b) noexcept {
    if (b == 0) {
        return (a >= 0) ? 0x7FFFFFFF : -0x7FFFFFFF;
    }
    const int64_t num = static_cast<int64_t>(a) * static_cast<int64_t>(kFxOne);
    return static_cast<fx32_t>(num / static_cast<int64_t>(b));
}

constexpr uint32_t isqrt64(uint64_t x) noexcept {
    uint64_t op = x;
    uint64_t res = 0u;
    uint64_t one = static_cast<uint64_t>(1u) << 62u;
    while (one > op) {
        one >>= 2u;
    }
    while (one != 0u) {
        if (op >= res + one) {
            op -= res + one;
            res = (res >> 1u) + one;
        } else {
            res >>= 1u;
        }
        one >>= 2u;
    }
    return static_cast<uint32_t>(res);
}

constexpr fx32_t fx_sqrt(fx32_t x) noexcept {
    if (x <= 0) {
        return 0;
    }
    const uint64_t scaled = static_cast<uint64_t>(static_cast<uint32_t>(x)) << kFxShift;
    return static_cast<fx32_t>(isqrt64(scaled));
}

struct Vec2Fx {
    fx32_t x;
    fx32_t y;
};

constexpr fx32_t fx_dist(fx32_t dx, fx32_t dy) noexcept {
    const int64_t adx = (dx >= 0) ? dx : -static_cast<int64_t>(dx);
    const int64_t ady = (dy >= 0) ? dy : -static_cast<int64_t>(dy);
    const uint64_t sq = static_cast<uint64_t>(adx * adx + ady * ady);
    const uint32_t root = isqrt64(sq);
    return (root > 0x7FFFFFFFu) ? 0x7FFFFFFF : static_cast<fx32_t>(root);
}

// Целочисленный октантный atan2 -> угол BAM10 (0..1023, где 256 = +90 deg)
constexpr uint16_t fx_atan2_bam10(fx32_t dy, fx32_t dx) noexcept {
    if (dx == 0 && dy == 0) {
        return 0u;
    }
    const int64_t ax = (dx >= 0) ? dx : -static_cast<int64_t>(dx);
    const int64_t ay = (dy >= 0) ? dy : -static_cast<int64_t>(dy);

    // Линейно-квадратичная аппроксимация в первом октанте [0..128] BAM10
    int64_t mn = (ax < ay) ? ax : ay;
    int64_t mx = (ax > ay) ? ax : ay;
    // r in Q16.16 = (mn << 16) / mx, in [0..65536]
    const int64_t r = (mn << 16) / mx;
    // atan(r) / (pi/4) ~= r * (1.273 - 0.273 * r) -> масштабируем в [0..128]
    const int64_t one_minus_r = 65536 - r;
    const int64_t corr = 65536 + ((17891 * one_minus_r) >> 16);
    int32_t ang = static_cast<int32_t>(((r * corr) >> 16) * 128 >> 16);
    if (ang > 128) ang = 128;

    if (ay > ax) {
        ang = 256 - ang;
    }
    if (dx < 0) {
        ang = 512 - ang;
    }
    if (dy < 0) {
        ang = 1024 - ang;
    }
    return static_cast<uint16_t>(static_cast<uint32_t>(ang) & 1023u);
}

} // namespace simcore
