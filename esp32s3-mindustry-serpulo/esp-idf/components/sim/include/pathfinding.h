#ifndef PATHFINDING_H
#define PATHFINDING_H

#include "sim_types.h"

/* ============================================================================
 * pathfinding.h — поиск пути A* на секторе (ESP32-S3)
 *
 * Карта проходимости берётся из тайлов сектора. Путь возвращается как
 * массив координат тайлов. Ограничение по количеству узлов открытого списка
 * и длина пути — для предсказуемого использования SRAM.
 * ============================================================================ */

#define PF_MAX_NODES 2048     /* максимум узлов в открытом/закрытом списке */
#define PF_MAX_PATH  512      /*	max длина пути в тайлах                  */

typedef struct {
    int16_t x, y;
} pf_cell_t;

typedef struct {
    pf_cell_t cells[PF_MAX_PATH];
    uint16_t  len;            /* число клеток в пути               */
    bool      found;          /* путь найден                       */
} pf_path_t;

/* Функция проверки проходимости тайла. Пользователь передаёт свою.
 * ctx — произвольный контекст (например, указатель на сектор), чтобы колбэк
 * мог посмотреть реальный тип тайла и наличие здания в своей карте. */
typedef bool (*pf_walkable_fn)(int16_t x, int16_t y, void *ctx);

/* Поиск пути от (sx,sy) до (gx,gy). Возвращает true, если путь найден. */
bool pf_find(int16_t sx, int16_t sy, int16_t gx, int16_t gy,
             pf_walkable_fn walkable, void *ctx, pf_path_t *out_path);

#endif /* PATHFINDING_H */
