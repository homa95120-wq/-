#include "power_network.h"
#include "esp_log.h"
#include <string.h>

static const char *TAG = "power";

static inline size_t ti(int16_t x, int16_t y) {
    return (size_t)y * SIM_MAX_WIDTH + (size_t)x;
}
static inline bool inb(int16_t x, int16_t y) {
    return x >= 0 && x < SIM_MAX_WIDTH && y >= 0 && y < SIM_MAX_HEIGHT;
}

void power_network_init(power_network_t *net) {
    if (!net) return;
    memset(net->node, 0, sizeof(net->node));
    net->count = 0;
    net->total_produce = 0;
    net->total_consume = 0;
    net->total_stored = 0;
    net->total_capacity = 0;
    net->deficit_ratio = 0;
}

bool power_place(power_network_t *net, int16_t x, int16_t y, power_role_t role,
                 float produce, float consume, float capacity) {
    if (!net || !inb(x, y)) return false;
    size_t idx = ti(x, y);
    if (net->node[idx].active) return false;
    power_node_t *n = &net->node[idx];
    n->active = true;
    n->role = role;
    n->produce = produce;
    n->consume = consume;
    n->stored = (role == POWER_BATTERY) ? capacity * 0.5f : 0.0f; /* стартовый заряд 50% */
    n->capacity = capacity;
    n->networked = true;
    net->count++;
    ESP_LOGD(TAG, "power place %d,%d role=%d", x, y, (int)role);
    return true;
}

void power_remove(power_network_t *net, int16_t x, int16_t y) {
    if (!net || !inb(x, y)) return;
    size_t idx = ti(x, y);
    if (!net->node[idx].active) return;
    memset(&net->node[idx], 0, sizeof(net->node[idx]));
    net->count--;
}

void power_tick(power_network_t *net) {
    if (!net) return;

    net->total_produce = 0;
    net->total_consume = 0;
    net->total_stored = 0;
    net->total_capacity = 0;

    for (int16_t y = 0; y < SIM_MAX_HEIGHT; y++) {
        for (int16_t x = 0; x < SIM_MAX_WIDTH; x++) {
            power_node_t *n = &net->node[ti(x, y)];
            if (!n->active || !n->networked) continue;
            if (n->role == POWER_PRODUCER) {
                net->total_produce += n->produce;
            } else if (n->role == POWER_CONSUMER) {
                net->total_consume += n->consume;
            } else if (n->role == POWER_BATTERY) {
                net->total_stored += n->stored;
                net->total_capacity += n->capacity;
            }
        }
    }

    float net_power = net->total_produce - net->total_consume;

    if (net_power >= 0.0f) {
        /* Энергии достаточно — заряжаем батареи */
        float spare = net_power;
        net->deficit_ratio = 0.0f;
        for (int16_t y = 0; y < SIM_MAX_HEIGHT; y++) {
            for (int16_t x = 0; x < SIM_MAX_WIDTH; x++) {
                power_node_t *n = &net->node[ti(x, y)];
                if (!n->active || n->role != POWER_BATTERY) continue;
                float free = n->capacity - n->stored;
                if (free <= 0.0f) continue;
                float charge = spare < free ? spare : free;
                n->stored += charge;
                spare -= charge;
                if (spare <= 0.0f) break;
            }
        }
    } else {
        /* Дефицит — разряжаем батареи, потом применяем коэффициент дефицита */
        float need = -net_power;
        net->deficit_ratio = 1.0f; /* предполагаем полный блэкаут */
        if (net->total_consume > 0.0f) {
            net->deficit_ratio = need / net->total_consume;
            if (net->deficit_ratio > 1.0f) net->deficit_ratio = 1.0f;
        }

        /* Батареи отдают энергию */
        for (int16_t y = 0; y < SIM_MAX_HEIGHT; y++) {
            for (int16_t x = 0; x < SIM_MAX_WIDTH; x++) {
                power_node_t *n = &net->node[ti(x, y)];
                if (!n->active || n->role != POWER_BATTERY) continue;
                if (need <= 0.0f) break;
                float give = n->stored < need ? n->stored : need;
                n->stored -= give;
                need -= give;
            }
        }

        /* Пересчитаем дефицит после разряда батарей */
        /* В упрощённой модели дефицит остаётся, пропорционально уменьшает работу потребителей */
    }

    /* Обновляем stored/capacity итоги (уже посчитаны выше) */
    ESP_LOGV(TAG, "tick produce=%.2f consume=%.2f deficit=%.2f",
             net->total_produce, net->total_consume, net->deficit_ratio);
}

bool power_can_consume(const power_network_t *net, float consume) {
    if (!net) return false;
    /* Если дефицита нет — можно. Если есть — все работают частично,
     * отдельный потребитель не может "отключиться" в этой модели,
     * он получает часть энергии пропорционально. */
    return net->deficit_ratio < 1.0f || consume == 0.0f;
}

void power_consume(power_network_t *net, int16_t x, int16_t y, float consume) {
    (void)net; (void)x; (void)y; (void)consume;
    /* Потребление уже учтено в total_consume при расчёте баланса.
     * Здесь можно добавить списание с конкретного узла при необходимости. */
}

float power_deficit(const power_network_t *net) {
    if (!net) return 1.0f;
    return net->deficit_ratio;
}
