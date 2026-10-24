#ifndef POWER_NETWORK_H
#define POWER_NETWORK_H

#include "sim_types.h"

/* ============================================================================
 * power_network.h — электрическая сеть (ESP32-S3)
 *
 * Модель: каждый тайл сети — узел. Производители добавляют энергию, потребители
 * забирают, батареи накапливают. Баланс считается за тик: если суммарное
 * производство < потребления — все потребители работают с коэффициентом
 * дефицита ( brownout ), батареи разряжаются.
 * ============================================================================ */

typedef enum {
    POWER_NONE    = 0,
    POWER_PRODUCER = 1,   /* генератор, солнечная панель, реактор */
    POWER_CONSUMER = 2,   /* турель, бур, конвейер, завод         */
    POWER_BATTERY  = 3,   /* аккумулятор                          */
    POWER_NODE     = 4,   /* силовой узел (передача)              */
} power_role_t;

typedef struct {
    bool          active;
    power_role_t  role;
    float         produce;   /* Вт, производится за тик (если producer) */
    float         consume;   /* Вт, требуется за тик (если consumer)  */
    float         stored;    /* заряд батареи (Дж)                    */
    float         capacity;  /* ёмкость батареи (Дж)                  */
    bool          networked; /* соединён с сетью                      */
} power_node_t;

typedef struct {
    power_node_t node[SIM_MAX_WIDTH * SIM_MAX_HEIGHT];
    uint32_t     count;
    /* Итоговый баланс за тик (расчитывается в power_tick) */
    float        total_produce;
    float        total_consume;
    float        total_stored;
    float        total_capacity;
    float        deficit_ratio; /* 0..1: доля нехватки энергии (1 = нет энергии) */
} power_network_t;

void power_network_init(power_network_t *net);
bool power_place(power_network_t *net, int16_t x, int16_t y, power_role_t role,
                 float produce, float consume, float capacity);
void power_remove(power_network_t *net, int16_t x, int16_t y);

/* Один тик: баланс энергии, заряд/разряд батарей, коэффициент дефицита */
void power_tick(power_network_t *net);

/* Может ли потребитель работать в этом тике? (учитывает deficit_ratio) */
bool power_can_consume(const power_network_t *net, float consume);

/* Зарегистрировать потребление (вызывается потребителем в тике) */
void power_consume(power_network_t *net, int16_t x, int16_t y, float consume);

/* Получить итоговый дефицит (0 = всё хорошо, 1 = полный блэкаут) */
float power_deficit(const power_network_t *net);

#endif /* POWER_NETWORK_H */
