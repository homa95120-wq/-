#include "fluid_network.h"
#include "esp_log.h"
#include <string.h>

static const char *TAG = "fluid";

static inline size_t ti(int16_t x, int16_t y) {
    return (size_t)y * SIM_MAX_WIDTH + (size_t)x;
}
static inline bool inb(int16_t x, int16_t y) {
    return x >= 0 && x < SIM_MAX_WIDTH && y >= 0 && y < SIM_MAX_HEIGHT;
}

#define PIPE_CAPACITY  10.0f   /* обычная труба               */
#define TANK_CAPACITY  100.0f  /* резервуар                   */
#define FLOW_RATE      0.5f    /* доля перетекания за тик     */

void fluid_network_init(fluid_network_t *net) {
    if (!net) return;
    memset(net->seg, 0, sizeof(net->seg));
    net->count = 0;
}

bool fluid_place(fluid_network_t *net, int16_t x, int16_t y, pipe_type_t type) {
    if (!net || !inb(x, y)) return false;
    size_t idx = ti(x, y);
    if (net->seg[idx].active) return false;
    net->seg[idx].active = true;
    net->seg[idx].type = type;
    net->seg[idx].content.liquid = 0;
    net->seg[idx].content.amount = 0.0f;
    net->seg[idx].pressure = 0.0f;
    net->seg[idx].is_source = false;
    net->count++;
    return true;
}

void fluid_remove(fluid_network_t *net, int16_t x, int16_t y) {
    if (!net || !inb(x, y)) return;
    size_t idx = ti(x, y);
    if (!net->seg[idx].active) return;
    net->seg[idx].active = false;
    net->seg[idx].content.liquid = 0;
    net->seg[idx].content.amount = 0.0f;
    net->seg[idx].pressure = 0.0f;
    net->seg[idx].is_source = false;
    net->count--;
}

void fluid_set_source(fluid_network_t *net, int16_t x, int16_t y, sim_liquid_id_t liquid) {
    if (!net || !inb(x, y)) return;
    pipe_segment_t *s = &net->seg[ti(x, y)];
    if (!s->active) return;
    s->is_source = true;
    s->content.liquid = liquid;
    s->content.amount = PIPE_CAPACITY; /* источник всегда полон */
    s->pressure = 1.0f;
}

void fluid_tick(fluid_network_t *net) {
    if (!net) return;

    /* Сначала обновляем источники */
    for (int16_t y = 0; y < SIM_MAX_HEIGHT; y++) {
        for (int16_t x = 0; x < SIM_MAX_WIDTH; x++) {
            pipe_segment_t *s = &net->seg[ti(x, y)];
            if (s->active && s->is_source) {
                s->content.amount = PIPE_CAPACITY;
                s->pressure = 1.0f;
            }
        }
    }

    /* Перетекание между соседними трубами (4 направления) */
    static float delta[SIM_MAX_WIDTH * SIM_MAX_HEIGHT];
    memset(delta, 0, sizeof(delta));

    for (int16_t y = 0; y < SIM_MAX_HEIGHT; y++) {
        for (int16_t x = 0; x < SIM_MAX_WIDTH; x++) {
            pipe_segment_t *s = &net->seg[ti(x, y)];
            if (!s->active) continue;

            float cap = (s->type == PIPE_TANK) ? TANK_CAPACITY : PIPE_CAPACITY;
            float fill = s->content.amount / cap;

            /* Соседи: вверх, вниз, влево, вправо */
            int16_t nx[4] = {x, x, x - 1, x + 1};
            int16_t ny[4] = {y - 1, y + 1, y, y};

            for (int d = 0; d < 4; d++) {
                if (!inb(nx[d], ny[d])) continue;
                pipe_segment_t *t = &net->seg[ti(nx[d], ny[d])];
                if (!t->active || t->type != PIPE_NORMAL && t->type != PIPE_TANK) continue;
                /* Жидкость не перетекает через насос как через обычную трубу */
                if (t->type == PIPE_PUMP) continue;

                float tcap = (t->type == PIPE_TANK) ? TANK_CAPACITY : PIPE_CAPACITY;
                float tfill = t->content.amount / tcap;
                if (fill > tfill + 0.01f) {
                    float flow = (fill - tfill) * FLOW_RATE;
                    float amt = flow * cap;
                    if (amt > s->content.amount) amt = s->content.amount;
                    if (amt > tcap - t->content.amount) amt = tcap - t->content.amount;
                    if (amt > 0.0f) {
                        /* Ограничиваем разные жидкости не смешиваются */
                        if (t->content.liquid == 0) t->content.liquid = s->content.liquid;
                        if (t->content.liquid == s->content.liquid) {
                            delta[ti(x, y)] -= amt;
                            delta[ti(nx[d], ny[d])] += amt;
                        }
                    }
                }
            }
        }
    }

    /* Применяем дельты */
    for (int16_t y = 0; y < SIM_MAX_HEIGHT; y++) {
        for (int16_t x = 0; x < SIM_MAX_WIDTH; x++) {
            size_t idx = ti(x, y);
            pipe_segment_t *s = &net->seg[idx];
            if (!s->active) continue;
            s->content.amount += delta[idx];
            if (s->content.amount < 0.0f) s->content.amount = 0.0f;
            float cap = (s->type == PIPE_TANK) ? TANK_CAPACITY : PIPE_CAPACITY;
            if (s->content.amount > cap) s->content.amount = cap;
            s->pressure = s->content.amount / cap;
        }
    }
}

bool fluid_take(fluid_network_t *net, int16_t x, int16_t y, sim_liquid_stack_t *out, float max_amount) {
    if (!net || !inb(x, y) || !out) return false;
    pipe_segment_t *s = &net->seg[ti(x, y)];
    if (!s->active || s->content.amount <= 0.0f) return false;
    float take = s->content.amount;
    if (take > max_amount) take = max_amount;
    out->liquid = s->content.liquid;
    out->amount = take;
    s->content.amount -= take;
    if (s->content.amount < 0.0f) s->content.amount = 0.0f;
    s->pressure = s->content.amount / ((s->type == PIPE_TANK) ? TANK_CAPACITY : PIPE_CAPACITY);
    return true;
}

bool fluid_put(fluid_network_t *net, int16_t x, int16_t y, sim_liquid_id_t liquid, float amount) {
    if (!net || !inb(x, y) || amount <= 0.0f) return false;
    pipe_segment_t *s = &net->seg[ti(x, y)];
    if (!s->active) return false;
    float cap = (s->type == PIPE_TANK) ? TANK_CAPACITY : PIPE_CAPACITY;
    float free = cap - s->content.amount;
    if (free <= 0.0f) return false;
    float put = amount < free ? amount : free;
    if (s->content.liquid == 0) s->content.liquid = liquid;
    if (s->content.liquid == liquid) {
        s->content.amount += put;
        s->pressure = s->content.amount / cap;
        return true;
    }
    return false; /* разная жидкость — не смешиваем */
}

bool fluid_get(const fluid_network_t *net, int16_t x, int16_t y, sim_liquid_stack_t *out) {
    if (!net || !inb(x, y) || !out) return false;
    const pipe_segment_t *s = &net->seg[ti(x, y)];
    if (!s->active) return false;
    *out = s->content;
    return true;
}
