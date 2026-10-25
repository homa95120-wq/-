# SPDX-License-Identifier: GPL-3.0-or-later
cmake_minimum_required(VERSION 3.20)
project(mindustry_serpulo VERSION 0.2.0 LANGUAGES CXX)

option(MIND_BUILD_TESTS     "Build simcore determinism unit & golden tests" ON)
option(MIND_BUILD_HEADLESS  "Build headless simulation runner & 0x4D53 TCP server" ON)
option(MIND_BUILD_WEB_PC    "Build zero-dependency C++ PC HTTP/Canvas game server" ON)
option(MIND_BUILD_CLIENT_PC "Build native SDL2 + OpenGL 3.3 PC game executable" ON)

set(SIMCORE_MAX_MAP_DIM 128 CACHE STRING "Maximum sector map dimension (128 for ESP32-S3 parity)")

if(MSVC)
    add_compile_options(/utf-8)
    add_compile_definitions(_CRT_SECURE_NO_WARNINGS NOMINMAX)
endif()

find_package(Threads REQUIRED)

add_subdirectory(simcore)

# Транспортная библиотека протокола 0x4D53 (общая для нативного и веб ПК-клиента)
add_library(mind_net_client STATIC "client-pc/src/net_client.cpp")
target_include_directories(mind_net_client PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/client-pc/include")
target_link_libraries(mind_net_client PUBLIC simcore)
set_target_properties(mind_net_client PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
if(WIN32)
    target_link_libraries(mind_net_client PUBLIC ws2_32)
endif()

if(MIND_BUILD_HEADLESS)
    add_executable(headless_runner "tools/headless_runner.cpp")
    target_link_libraries(headless_runner PRIVATE simcore Threads::Threads)
    set_target_properties(headless_runner PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
    if(WIN32)
        target_link_libraries(headless_runner PRIVATE ws2_32)
    endif()
endif()

if(MIND_BUILD_WEB_PC)
    add_executable(mindustry-serpulo-web "web-preview/server_web.cpp")
    target_link_libraries(mindustry-serpulo-web PRIVATE mind_net_client simcore Threads::Threads)
    set_target_properties(mindustry-serpulo-web PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
    if(WIN32)
        target_link_libraries(mindustry-serpulo-web PRIVATE ws2_32)
    endif()
endif()

if(MIND_BUILD_CLIENT_PC)
    find_package(SDL2 QUIET)
    if(TARGET SDL2::SDL2)
        add_executable(mindustry-serpulo-pc "client-pc/src/main_pc.cpp")
        target_include_directories(mindustry-serpulo-pc PRIVATE
            "${CMAKE_CURRENT_SOURCE_DIR}/client-pc/include"
            ${SDL2_INCLUDE_DIRS}
        )
        target_link_libraries(mindustry-serpulo-pc PRIVATE mind_net_client simcore SDL2::SDL2 Threads::Threads)
        set_target_properties(mindustry-serpulo-pc PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
        if(UNIX AND NOT APPLE)
            target_link_libraries(mindustry-serpulo-pc PRIVATE dl m)
        endif()
        message(STATUS "[client-pc] Native SDL2 + OpenGL 3.3 target 'mindustry-serpulo-pc' ENABLED")
    elseif(SDL2_FOUND)
        add_executable(mindustry-serpulo-pc "client-pc/src/main_pc.cpp")
        target_include_directories(mindustry-serpulo-pc PRIVATE
            "${CMAKE_CURRENT_SOURCE_DIR}/client-pc/include"
            ${SDL2_INCLUDE_DIRS}
        )
        target_link_libraries(mindustry-serpulo-pc PRIVATE mind_net_client simcore ${SDL2_LIBRARIES} Threads::Threads)
        set_target_properties(mindustry-serpulo-pc PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
        message(STATUS "[client-pc] Native SDL2 + OpenGL 3.3 target 'mindustry-serpulo-pc' ENABLED (legacy vars)")
    else()
        message(STATUS "[client-pc] SDL2 not found -> skipping native 'mindustry-serpulo-pc' (use -DSDL2_DIR=... or install libsdl2-dev)")
    endif()
endif()

if(MIND_BUILD_TESTS)
    enable_testing()
    add_executable(simcore_test "tests/simcore_test.cpp")
    target_link_libraries(simcore_test PRIVATE simcore)
    set_target_properties(simcore_test PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
    add_test(NAME simcore_determinism_and_protocol COMMAND simcore_test)
endif()
