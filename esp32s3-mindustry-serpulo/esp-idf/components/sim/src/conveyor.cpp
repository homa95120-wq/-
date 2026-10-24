#include "conveyor.h"
#include "esp_log.h"
#include <string.h>

static const char *TAG = "conveyor";

static inline size_t tile_index(int16_t x, int16_t y) {
    return (size_t)y * SIM_MAX_WIDTH + (size_t)x;
}

static inline bool tile_in_bounds(int16_t x, int16_t y) {
    return x >= 0 && x < SIM_MAX_WIDTH && y >= 0 && y < SIM_MAX_HEIGHT;
}

void conv_network_init(conv_network_t *net) {
    if (!net) return;
    memset(net->seg, 0, sizeof(net->seg));
    net->count = 0;
}

bool conv_place(conv_network_t *net, int16_t x, int16_t y, conv_dir_t dir) {
    if (!net || !tile_in_bounds(x, y)) return false;
    size_t idx = tile_index(x, y);
    if (net->seg[idx].active) return false; /* уже есть здание/конвейер */
    net->seg[idx].active = true;
    net->seg[idx].dir = dir;
    net->seg[idx].item.item = 0;
    net->seg[idx].item.amount = 0;
    net->seg[idx].progress = 0;
    net->count++;
    ESP_LOGD(TAG, "conv place %d,%d dir=%d", x, y, (int)dir);
    return true;
}

void conv_remove(conv_network_t *net, int16_t x, int16_t y) {
    if (!net || !tile_in_bounds(x, y)) return;
    size_t idx = tile_index(x, y);
    if (!net->seg[idx].active) return;
    net->seg[idx].active = false;
    net->seg[idx].item.item = 0;
    net->seg[idx].item.amount = 0;
    net->seg[idx].progress = 0;
    net->count--;
}

bool conv_get(const conv_network_t *net, int16_t x, int16_t y, conv_dir_t *out_dir) {
    if (!net || !tile_in_bounds(x, y) || !out_dir) return false;
    const conv_segment_t *s = &net->seg[tile_index(x, y)];
    if (!s->active) return false;
    *out_dir = s->dir;
    return true;
}

void conv_tick(conv_network_t *net, uint32_t *items_out) {
    if (!net) return;
    if (items_out) *items_out = 0;

    /* Два прохода: сначала сбор, потом перемещение, чтобы избежать конфликтов
     * между сегментами в одном тике. */

    /* Собираем предметы, которые должны переместиться в этом тике */
    static sim_item_stack_t move_items[SIM_MAX_CONVEYORS];
    static int16_t move_from_x[SIM_MAX_CONVEYORS];
    static int16_t move_from_y[SIM_MAX_CONVEYORS];
    static int16_t move_to_x[SIM_MAX_CONVEYORS];
    static int16_t move_to_y[SIM_MAX_CONVEYORS];
    static uint8_t move_progress_next[SIM_MAX_CONVEYORS];
    static uint32_t move_count = 0;
    move_count = 0;

    for (int16_t y = 0; y < SIM_MAX_HEIGHT; y++) {
        for (int16_t x = 0; x < SIM_MAX_WIDTH; x++) {
            size_t idx = tile_index(x, y);
            conv_segment_t *s = &net->seg[idx];
            if (!s->active || s->item.item == 0) continue;

            s->progress++;
            if (s->progress >= 100) {
                /* item готов переместиться на следующий сегмент */
                conv_dir_t d = s->dir;
                int16_t tx = x, ty = y;
                switch (d) {
                    case CONV_DIR_UP:    ty--; break;
                    case CONV_DIR_DOWN:  ty++; break;
                    case CONV_DIR_LEFT:  tx--; break;
                    case CONV_DIR_RIGHT: tx++; break;
                }
                if (!tile_in_bounds(tx, ty)) {
                    /* вылетел за карту — теряется */
                    if (items_out) (*items_out)++;
                    s->item.item = 0; s->item.amount = 0; s->progress = 0;
                    continue;
                }
                size_t tidx = tile_index(tx, ty);
                conv_segment_t *ts = &net->seg[tidx];
                if (!ts->active || ts->dir != d || ts->item.item != 0) {
                    /* цель не конвейер или занята — стоит на месте */
                    if (s->progress > 100) s->progress = 100;
                    continue;
                }
                /* записываем перемещение */
                if (move_count < SIM_MAX_CONVEYORS) {
                    move_items[move_count] = s->item;
                    move_from_x[move_count] = x;
                    move_from_y[move_count] = y;
                    move_to_x[move_count] = tx;
                    move_to_y[move_count] = ty;
                    move_progress_next[move_count] = 0;
                    move_count++;
                }
                s->item.item = 0; s->item.amount = 0; s->progress = 0;
            }
        }
    }

    /* Применяем перемещения */
    for (uint32_t i = 0; i < move_count; i++) {
        size_t tidx = tile_index(move_to_x[i], move_to_y[i]);
        conv_segment_t *ts = &net->seg[tidx];
        ts->item = move_items[i];
        ts->progress = move_progress_next[i];
    }
}

bool conv_take(conv_network_t *net, int16_t x, int16_t y, sim_item_stack_t *out) {
    if (!net || !tile_in_bounds(x, y) || !out) return false;
    conv_segment_t *s = &net->seg[tile_index(x, y)];
    if (!s->active || s->item.item == 0) return false;
    *out = s->item;
    s->item.item = 0;
    s->item.amount = 0;
    s->progress = 0;
    return true;
}
