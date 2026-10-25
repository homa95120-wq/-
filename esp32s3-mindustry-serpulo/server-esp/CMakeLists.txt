# SPDX-License-Identifier: GPL-3.0-or-later
idf_component_register(
    SRCS "src/server_esp.cpp"
    INCLUDE_DIRS "include"
    REQUIRES simcore esp_wifi esp_event esp_netif nvs_flash lwip esp_timer driver log
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_17)
target_compile_options(${COMPONENT_LIB} PRIVATE
    "-std=gnu++17"
    "-fno-exceptions"
    "-fno-rtti"
    "-Wall"
    "-Wextra"
)
