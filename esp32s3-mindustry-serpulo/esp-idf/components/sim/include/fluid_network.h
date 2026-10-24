#ifndef FLUID_NETWORK_H
#define FLUID_NETWORK_H

#include "sim_types.h"

/* ============================================================================
 * fluid_network.h — гидравлическая сеть (трубы, насосы, баки)
 *
 * Упрощённая модель: жидкость перетекает между соединёнными трубами и баками
 * пропорционально разнице заполнения. Насос перекачивает из источника в трубу.
 * Каждый 타이л хранит sim_liquid_stack_t.
 * ============================================================================ */

typedef enum {
    PIPE_NORMAL   = 0,   /* обычная труба           */
    PIPE_PUMP     = 1,   /* насос (требует энергии) */
    PIPE_TANK     = 2,   /* резервуар (большой объём)*/
} pipe_type_t;

typedef struct {
    bool          active;
    pipe_type_t   type;
    sim_liquid_stack_t content;  /* жидкость на этом тайле     */
    float         pressure;      /* текущее давление (0..1)    */
    bool          is_source;     /* источник (водоём/бур)      */
} pipe_segment_t;

typedef struct {
    pipe_segment_t seg[SIM_MAX_WIDTH * SIM_MAX_HEIGHT];
    uint32_t       count;
} fluid_network_t;

void fluid_network_init(fluid_network_t *net);
bool fluid_place(fluid_network_t *net, int16_t x, int16_t y, pipe_type_t type);
void fluid_remove(fluid_network_t *net, int16_t x, int16_t y);

/* Пометить тайл как источник бесконечной жидкости (водоём, бур) */
void fluid_set_source(fluid_network_t *net, int16_t x, int16_t y, sim_liquid_id_t liquid);

/* Один тик гидравлики: перетекание между соседними тайлами */
void fluid_tick(fluid_network_t *net);

/* Забрать жидкость из трубы/бака (для потребителя) */
bool fluid_take(fluid_network_t *net, int16_t x, int16_t y, sim_liquid_stack_t *out, float max_amount);

/* Добавить жидкость (для производителя) */
bool fluid_put(fluid_network_t *net, int16_t x, int16_t y, sim_liquid_id_t liquid, float amount);

/* Получить содержимое тайла */
bool fluid_get(const fluid_network_t *net, int16_t x, int16_t y, sim_liquid_stack_t *out);

#endif /* FLUID_NETWORK_H */
