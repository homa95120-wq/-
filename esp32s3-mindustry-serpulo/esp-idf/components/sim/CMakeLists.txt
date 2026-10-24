idf_component_register(SRCS "src/conveyor.cpp"
                     "src/fluid_network.cpp"
                     "src/power_network.cpp"
                     "src/pathfinding.cpp"
                     "src/combat.cpp"
                     "src/sector_sim.cpp"
                     INCLUDE_DIRS "include"
                     REQUIRED "esp_log")

target_compile_options(${COMPONENT_TARGET} PRIVATE "-std=gnu++11" "-fno-exceptions" "-fno-rtti")
