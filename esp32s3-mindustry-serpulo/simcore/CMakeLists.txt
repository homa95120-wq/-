# SPDX-License-Identifier: GPL-3.0-or-later
set(SIMCORE_SOURCES
    "src/simcore.cpp"
)

if(ESP_PLATFORM)
    idf_component_register(
        SRCS ${SIMCORE_SOURCES}
        INCLUDE_DIRS "include"
    )
    target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_17)
    target_compile_options(${COMPONENT_LIB} PRIVATE
        "-std=gnu++17"
        "-fno-exceptions"
        "-fno-rtti"
        "-Wall"
        "-Wextra"
        "-DSIMCORE_MAX_MAP_DIM=128"
    )
else()
    add_library(simcore STATIC ${SIMCORE_SOURCES})
    target_include_directories(simcore PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
    target_compile_features(simcore PUBLIC cxx_std_17)
    set_target_properties(simcore PROPERTIES
        CXX_STANDARD 17
        CXX_STANDARD_REQUIRED ON
        CXX_EXTENSIONS OFF
    )

    if(MSVC)
        target_compile_options(simcore PRIVATE /W4 /EHs-c- /GR-)
        target_compile_definitions(simcore PRIVATE _HAS_EXCEPTIONS=0)
    else()
        target_compile_options(simcore PRIVATE
            -fno-exceptions
            -fno-rtti
            -Wall
            -Wextra
            -Wpedantic
        )
    endif()

    if(DEFINED SIMCORE_MAX_MAP_DIM)
        target_compile_definitions(simcore PUBLIC "SIMCORE_MAX_MAP_DIM=${SIMCORE_MAX_MAP_DIM}")
    endif()
endif()
