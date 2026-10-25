idf_component_register(
    SRCS "app_main.cpp"
    INCLUDE_DIRS "."
    REQUIRES simcore server-esp esp_timer esp_system heap log
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_17)
target_compile_options(${COMPONENT_LIB} PRIVATE
    "-std=gnu++17"
    "-fno-exceptions"
    "-fno-rtti"
    "-Wall"
    "-Wextra"
)
