#include "pathfinding.h"
#include "esp_log.h"
#include <string.h>
#include <stdlib.h>

static const char *TAG = "pathfinding";

static inline size_t ti(int16_t x, int16_t y) {
    return (size_t)y * SIM_MAX_WIDTH + (size_t)x;
}
static inline bool inb(int16_t x, int16_t y) {
    return x >= 0 && x < SIM_MAX_WIDTH && y >= 0 && y < SIM_MAX_HEIGHT;
}

/* Узел открытого списка A* */
typedef struct {
    int16_t x, y;
    int16_t px, py;           /* родитель */
    uint32_t f, g, h;         /* оценки   */
    bool    in_open;
    bool    in_closed;
} pf_node_t;

/* Буфер узлов в SRAM (статический, для предсказуемой памяти) */
static pf_node_t pf_nodes[PF_MAX_NODES];
static uint32_t pf_node_count = 0;

static inline uint32_t heuristic(int16_t x1, int16_t y1, int16_t x2, int16_t y2) {
    return (uint32_t)(abs(x1 - x2) + abs(y1 - y2)); /*マンхэттен */
}

static pf_node_t *node_get(int16_t x, int16_t y) {
    /* Линейный поиск по буферу — просто и предсказуемо по памяти */
    for (uint32_t i = 0; i < pf_node_count; i++) {
        if (pf_nodes[i].x == x && pf_nodes[i].y == y) return &pf_nodes[i];
    }
    return NULL;
}

static pf_node_t *node_create(int16_t x, int16_t y) {
    if (pf_node_count >= PF_MAX_NODES) return NULL;
    pf_node_t *n = &pf_nodes[pf_node_count++];
    n->x = x; n->y = y;
    n->px = x; n->py = y;
    n->f = n->g = n->h = 0;
    n->in_open = false;
    n->in_closed = false;
    return n;
}

/* Поиск узла с минимальным f в открытом списке (линейно — просто и надёжно) */
static pf_node_t *open_pop_best() {
    pf_node_t *best = NULL;
    for (uint32_t i = 0; i < pf_node_count; i++) {
        pf_node_t *n = &pf_nodes[i];
        if (!n->in_open || n->in_closed) continue;
        if (!best || n->f < best->f) best = n;
    }
    return best;
}

bool pf_find(int16_t sx, int16_t sy, int16_t gx, int16_t gy,
             pf_walkable_fn walkable, void *ctx, pf_path_t *out_path) {
    if (!out_path) return false;
    if (!inb(sx, sy) || !inb(gx, gy)) return false;

    out_path->len = 0;
    out_path->found = false;
    pf_node_count = 0;
    memset(pf_nodes, 0, sizeof(pf_nodes));

    pf_node_t *start = node_create(sx, sy);
    if (!start) return false;
    start->g = 0;
    start->h = heuristic(sx, sy, gx, gy);
    start->f = start->g + start->h;
    start->in_open = true;

    /* Направления: 4 смежности */
    static const int16_t dx[4] = {0, 0, -1, 1};
    static const int16_t dy[4] = {-1, 1, 0, 0};

    bool found = false;

    while (true) {
        pf_node_t *cur = open_pop_best();
        if (!cur) break; /* открытый список пуст — пути нет */

        if (cur->x == gx && cur->y == gy) {
            found = true;
            break;
        }

        cur->in_open = false;
        cur->in_closed = true;

        for (int d = 0; d < 4; d++) {
            int16_t nx = cur->x + dx[d];
            int16_t ny = cur->y + dy[d];
            if (!inb(nx, ny)) continue;

            /* проходимость проверяет колбэк пользователя (реальная карта) */
            if (!walkable(nx, ny, ctx)) continue;

            pf_node_t *nb = node_get(nx, ny);
            if (!nb) {
                nb = node_create(nx, ny);
                if (!nb) continue;
            }
            if (nb->in_closed) continue;

            uint32_t tentative_g = cur->g + 1;
            if (!nb->in_open || tentative_g < nb->g) {
                nb->px = cur->x;
                nb->py = cur->y;
                nb->g = tentative_g;
                nb->h = heuristic(nx, ny, gx, gy);
                nb->f = nb->g + nb->h;
                if (!nb->in_open) {
                    nb->in_open = true;
                }
            }
        }
    }

    if (!found) return false;

    /* Восстанавливаем путь от цели к началу, потом разворачиваем */
    pf_cell_t rev[PF_MAX_PATH];
    uint16_t rlen = 0;
    pf_node_t *cur = node_get(gx, gy);
    if (!cur) return false;
    while (true) {
        if (rlen >= PF_MAX_PATH) return false; /* путь слишком длинный */
        rev[rlen].x = cur->x;
        rev[rlen].y = cur->y;
        rlen++;
        if (cur->x == sx && cur->y == sy) break;
        pf_node_t *parent = node_get(cur->px, cur->py);
        if (!parent) return false;
        cur = parent;
    }

    /* Разворачиваем */
    if (rlen > PF_MAX_PATH) return false;
    for (uint16_t i = 0; i < rlen; i++) {
        out_path->cells[i].x = rev[rlen - 1 - i].x;
        out_path->cells[i].y = rev[rlen - 1 - i].y;
    }
    out_path->len = rlen;
    out_path->found = true;
    ESP_LOGV(TAG, "path %d,%d -> %d,%d: %u cells", sx, sy, gx, gy, (unsigned)rlen);
    return true;
}
