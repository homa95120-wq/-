// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <stddef.h>
#include <stdint.h>

#include "simcore/simcore.hpp"

namespace simcore {

inline constexpr uint32_t kSaveMagicMsv1 = 0x3156534Du; // "MSV1" little-endian
inline constexpr size_t   kSaveMaxBytes  = 131072u;     // <= 128 КБ на полный сектор

// Сериализация полного состояния сектора в буфер (0 байт динамической памяти)
size_t sim_save_msv1(const SimWorld& w, uint8_t* out_buf, size_t out_cap) noexcept;

// Десериализация состояния сектора с проверкой magic, границ полей и CRC32
bool sim_load_msv1(SimWorld& w, const uint8_t* data, size_t len) noexcept;

} // namespace simcore
