cmake_minimum_required(VERSION 3.20)
set(EXTRA_COMPONENT_DIRS
    "${CMAKE_CURRENT_LIST_DIR}/../simcore"
    "${CMAKE_CURRENT_LIST_DIR}/../server-esp"
)
include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(mindserpulo)
