#ifndef CONVEYOR_H
#define CONVEYOR_H

#include "sim_types.h"

/* ============================================================================
 * conveyor.h — система конвейеров (транспортировка предметов между зданиями)
 *
 * Конвейер — это направленное ребро от тайла к тайлу. Предметы перемещаются
 * по конвейерам со скоростью 1 тайл за N тиков. На каждом тайле может быть
 * не более одного конвейера с направлением.
 * ============================================================================ */

typedef enum {
    CONV_DIR_UP    = 0,   /* конвейер отправляет предмет на север (y-1) */
    CONV_DIR_RIGHT = 1,   /* на восток (x+1)                            */
    CONV_DIR_DOWN  = 2,   /* на юг (y+1)                                */
    CONV_DIR_LEFT  = 3,   /* на запад (x-1)                             */
} conv_dir_t;

/* Один конвейерный сегмент на тайле */
typedef struct {
    bool        active;       /* сегмент занят зданием-конвейером */
    conv_dir_t  dir;          /* направление движения               */
    sim_item_stack_t item;    /* предмет на этом сегменте (если есть) */
    uint8_t     progress;     /* прогресс перемещения 0..100        */
} conv_segment_t;

/* Конвейерная сеть: плотный массив сегментов, индексируемый по тайлу */
typedef struct {
    conv_segment_t seg[SIM_MAX_WIDTH * SIM_MAX_HEIGHT];
    uint32_t       count;     /* число активных сегментов           */
} conv_network_t;

/* Инициализация пустой сети конвейеров */
void conv_network_init(conv_network_t *net);

/* Поставить конвейер на тайл с заданным направлением.
 * Возвращает false, если на тайле уже есть здание. */
bool conv_place(conv_network_t *net, int16_t x, int16_t y, conv_dir_t dir);

/* Убрать конвейер с тайла */
void conv_remove(conv_network_t *net, int16_t x, int16_t y);

/* Проверка: есть ли конвейер на тайле и в какую сторону он смотрит */
bool conv_get(const conv_network_t *net, int16_t x, int16_t y, conv_dir_t *out_dir);

/* Один тик симуляции конвейеров.
 * Перемещает предметы на один сегмент вперёд по направлению.
 * items_out — количество предметов, вышедших из сети (доставлено в приёмник). */
void conv_tick(conv_network_t *net, uint32_t *items_out);

/* Взять предмет из конвейерного сегмента (для здания-приёмника) */
bool conv_take(conv_network_t *net, int16_t x, int16_t y, sim_item_stack_t *out);

#endif /* CONVEYOR_H */
