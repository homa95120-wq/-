idf_component_register(SRCS "app_main.cpp"
                     INCLUDE_DIRS "."
                     REQUIRES sim log)

target_compile_options(${COMPONENT_TARGET} PRIVATE "-std=gnu++11" "-fno-exceptions" "-fno-rtti")
