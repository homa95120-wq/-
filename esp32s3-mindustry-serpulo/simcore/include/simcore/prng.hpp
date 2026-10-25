// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <stdint.h>

namespace simcore {

inline constexpr uint64_t kDefaultPrngSeed = 0x4D494E4453455250ULL; // "MINDSERP"

struct Xorshift64Star {
    uint64_t state;

    constexpr void reseed(uint64_t seed) noexcept {
        state = (seed != 0u) ? seed : kDefaultPrngSeed;
    }

    constexpr uint64_t next_u64() noexcept {
        uint64_t x = state;
        x ^= x >> 12u;
        x ^= x << 25u;
        x ^= x >> 27u;
        state = x;
        return x * 0x2545F4914F6CDD1DULL;
    }

    constexpr uint32_t next_u32() noexcept {
        return static_cast<uint32_t>(next_u64() >> 32u);
    }

    constexpr uint32_t range_u32(uint32_t bound) noexcept {
        return (bound <= 1u) ? 0u : (next_u32() % bound);
    }

    constexpr int32_t range_i32(int32_t lo, int32_t hi_inclusive) noexcept {
        if (hi_inclusive <= lo) {
            return lo;
        }
        const uint32_t span = static_cast<uint32_t>(hi_inclusive - lo) + 1u;
        return lo + static_cast<int32_t>(range_u32(span));
    }
};

} // namespace simcore
