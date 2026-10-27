"""Модуль автономного движения робота с построением карты.

Робот самостоятельно перемещается по дороге шириной 7.5 метра,
строя карту окружения на основе данных лидара и камер.
"""

from __future__ import annotations

import logging
import math
import os
import threading
import time
from typing import Any, Optional

log = logging.getLogger("robot_control.autonomous_navigation")


# Параметры автономного движения
DEFAULT_ROAD_WIDTH_M = 7.5  # Ширина дороги в метрах
DEFAULT_SAFE_DISTANCE_M = 0.8  # Безопасное расстояние от края
DEFAULT_EXPLORATION_SPEED_MPS = 0.08  # Скорость исследования (м/с)
DEFAULT_SCAN_INTERVAL_S = 0.5  # Интервал обновления сканирования
DEFAULT_TURN_ANGLE_DEG = 30.0  # Угол поворота при препятствии


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_float(name: str, default: float, lo: float, hi: float) -> float:
    try:
        value = float(os.environ.get(name, ""))
    except (TypeError, ValueError):
        return default
    if not math.isfinite(value):
        return default
    return max(lo, min(hi, value))


class AutonomousNavigationError(ValueError):
    """Ошибка автономной навигации."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


class AutonomousNavigationService:
    """Сервис автономного движения с построением карты."""

    def __init__(self, map_service, source, lidar_manager=None, camera_manager=None, *,
                 enabled: Optional[bool] = None,
                 road_width_m: Optional[float] = None,
                 speed_mps: Optional[float] = None,
                 clock=time.time):
        self.map_service = map_service
        self.source = source
        self.lidar_manager = lidar_manager
        self.camera_manager = camera_manager
        self.clock = clock

        # Настройки из окружения или параметров
        self.enabled = _env_bool("RC_AUTO_NAV_ENABLE", False) if enabled is None else bool(enabled)
        self.road_width_m = (road_width_m if road_width_m is not None else
                            _env_float("RC_ROAD_WIDTH_M", DEFAULT_ROAD_WIDTH_M, 3.0, 15.0))
        self.safe_distance_m = _env_float("RC_SAFE_DISTANCE_M", DEFAULT_SAFE_DISTANCE_M, 0.3, 2.0)
        self.speed_mps = (speed_mps if speed_mps is not None else
                         _env_float("RC_AUTO_NAV_SPEED_MPS", DEFAULT_EXPLORATION_SPEED_MPS, 0.02, 0.15))
        self.scan_interval_s = _env_float("RC_SCAN_INTERVAL_S", DEFAULT_SCAN_INTERVAL_S, 0.2, 2.0)
        self.turn_angle_deg = _env_float("RC_TURN_ANGLE_DEG", DEFAULT_TURN_ANGLE_DEG, 15.0, 90.0)

        # Состояние
        self._lock = threading.RLock()
        self._cancel = threading.Event()
        self._worker: Optional[threading.Thread] = None
        self._state = {
            "phase": "idle",
            "message": "Автономное движение не запущено",
            "distance_traveled": 0.0,
            "exploration_time": 0.0,
            "obstacles_detected": 0,
            "updatedAt": self.clock(),
        }

    @property
    def active(self) -> bool:
        """Проверяет, активно ли автономное движение."""
        with self._lock:
            return bool(self._worker and self._worker.is_alive())

    def status(self) -> dict:
        """Возвращает текущее состояние автономного движения."""
        with self._lock:
            state = dict(self._state)
        return {
            "ok": True,
            "enabled": self.enabled,
            "active": self.active,
            "roadWidthM": self.road_width_m,
            "speedMps": self.speed_mps,
            **state,
        }

    def start(self) -> dict:
        """Запускает автономное движение."""
        if not self.enabled:
            raise AutonomousNavigationError(
                "not_enabled",
                "Автономное движение выключено. Установите RC_AUTO_NAV_ENABLE=1"
            )

        if self.active:
            raise AutonomousNavigationError(
                "already_active",
                "Автономное движение уже запущено"
            )

        # Проверка готовности системы
        self._check_system_ready()

        with self._lock:
            self._cancel = threading.Event()
            self._state = {
                "phase": "starting",
                "message": "Инициализация автономного движения",
                "distance_traveled": 0.0,
                "exploration_time": 0.0,
                "obstacles_detected": 0,
                "updatedAt": self.clock(),
            }

            worker = threading.Thread(
                target=self._autonomous_loop,
                name="autonomous-navigation",
                daemon=True,
            )
            self._worker = worker
            worker.start()

        log.info("Автономное движение запущено")
        return {"ok": True, "status": self.status()}

    def stop(self, reason: str = "Остановлено оператором") -> dict:
        """Останавливает автономное движение."""
        with self._lock:
            worker = self._worker
            active = bool(worker and worker.is_alive())
            if active:
                self._cancel.set()
                self._state.update({
                    "phase": "stopping",
                    "message": reason,
                    "updatedAt": self.clock(),
                })

        if active:
            try:
                if getattr(self.source, "supports_drive", False):
                    self.source.drive(0)
            except Exception as exc:  # noqa: BLE001
                log.error("Ошибка остановки привода: %s", exc)

        log.info("Автономное движение остановлено: %s", reason)
        return {"ok": True, "active": active, "status": self.status()}

    def _check_system_ready(self) -> None:
        """Проверяет готовность системы к автономному движению."""
        # Проверка лидара
        if self.lidar_manager is None:
            raise AutonomousNavigationError(
                "lidar_missing",
                "Менеджер лидара недоступен"
            )

        # Проверка камер
        if self.camera_manager is None:
            raise AutonomousNavigationError(
                "camera_missing",
                "Менеджер камер недоступен"
            )

        # Проверка привода
        if not getattr(self.source, "supports_drive", False):
            raise AutonomousNavigationError(
                "drive_unavailable",
                "Привод не поддерживается текущим источником"
            )

    def _get_scan(self) -> Optional[list[dict]]:
        """Получает текущий скан лидара."""
        if self.lidar_manager is None:
            return None
        getter = getattr(self.lidar_manager, "get_scan", None)
        if not callable(getter):
            return None
        try:
            return getter(max_age=self.scan_interval_s * 2)
        except Exception:
            return None

    def _analyze_surroundings(self, scan: list[dict]) -> dict:
        """Анализирует окружение на основе скана лидара.

        Returns:
            Словарь с информацией о препятствиях:
            - front_clear: свободно ли спереди
            - left_distance: расстояние до левого края
            - right_distance: расстояние до правого края
            - obstacle_angle: угол до ближайшего препятствия
            - obstacle_distance: расстояние до ближайшего препятствия
        """
        if not scan:
            return {
                "front_clear": False,
                "left_distance": 0.0,
                "right_distance": 0.0,
                "obstacle_angle": 0.0,
                "obstacle_distance": 0.0,
            }

        front_clear = True
        min_front_distance = float("inf")
        left_distances = []
        right_distances = []
        closest_obstacle_distance = float("inf")
        closest_obstacle_angle = 0.0

        for point in scan:
            try:
                angle = float(point.get("a", 0.0))
                distance = float(point.get("r", 0.0))
            except (TypeError, ValueError):
                continue

            if not math.isfinite(angle) or not math.isfinite(distance):
                continue

            # Проверка препятствий спереди (±30 градусов)
            if -math.pi / 6 <= angle <= math.pi / 6:
                if distance < min_front_distance:
                    min_front_distance = distance
                if distance < 1.5:  # Препятствие ближе 1.5 м
                    front_clear = False

            # Измерение расстояний до краёв дороги
            # Левая сторона (60-120 градусов)
            if math.pi / 3 <= angle <= 2 * math.pi / 3:
                left_distances.append(distance)

            # Правая сторона (-60 до -120 градусов)
            if -2 * math.pi / 3 <= angle <= -math.pi / 3:
                right_distances.append(distance)

            # Ближайшее препятствие
            if distance < closest_obstacle_distance:
                closest_obstacle_distance = distance
                closest_obstacle_angle = angle

        # Вычисляем средние расстояния до краёв
        left_dist = min(left_distances) if left_distances else self.road_width_m / 2
        right_dist = min(right_distances) if right_distances else self.road_width_m / 2

        return {
            "front_clear": front_clear,
            "left_distance": left_dist,
            "right_distance": right_dist,
            "obstacle_angle": closest_obstacle_angle,
            "obstacle_distance": closest_obstacle_distance if closest_obstacle_distance != float("inf") else 0.0,
        }

    def _decide_movement(self, surroundings: dict) -> tuple[float, float, float]:
        """Принимает решение о движении на основе анализа окружения.

        Returns:
            Кортеж (скорость, угол поворота, приоритет_действия):
            - скорость в м/с
            - угол поворота колёс в градусах
            - приоритет: 0=движение, 1=корректировка, 2=избежание препятствия
        """
        front_clear = surroundings["front_clear"]
        left_dist = surroundings["left_distance"]
        right_dist = surroundings["right_distance"]
        obstacle_dist = surroundings["obstacle_distance"]

        # Если спереди препятствие - остановка и поворот
        if not front_clear or obstacle_dist < 1.0:
            log.warning("Препятствие обнаружено на расстоянии %.2f м", obstacle_dist)
            # Поворачиваем в сторону с большим расстоянием
            turn_direction = 1.0 if left_dist > right_dist else -1.0
            return 0.0, self.turn_angle_deg * turn_direction, 2

        # Корректировка положения относительно центра дороги
        center_offset = (left_dist - right_dist) / 2.0

        # Если слишком близко к краю - корректируем курс
        if left_dist < self.safe_distance_m:
            # Слишком близко к левому краю - поворачиваем вправо
            correction_angle = -15.0
            return self.speed_mps * 0.7, correction_angle, 1
        elif right_dist < self.safe_distance_m:
            # Слишком близко к правому краю - поворачиваем влево
            correction_angle = 15.0
            return self.speed_mps * 0.7, correction_angle, 1

        # Плавная корректировка к центру дороги
        # Коэффициент пропорционален смещению от центра
        steering_correction = 0.0
        if abs(center_offset) > 0.2:  # Если смещение более 20 см
            steering_correction = math.copysign(
                min(abs(center_offset) * 5.0, 10.0),  # Макс 10 градусов коррекции
                center_offset
            )

        # Нормальное движение прямо с небольшой коррекцией
        return self.speed_mps, steering_correction, 0

    def _set_state(self, **fields: Any) -> None:
        """Обновляет состояние автономного движения."""
        with self._lock:
            self._state.update(fields)
            self._state["updatedAt"] = self.clock()

    def _autonomous_loop(self) -> None:
        """Основной цикл автономного движения."""
        start_time = self.clock()
        last_position: Optional[tuple[float, float]] = None
        total_distance = 0.0
        obstacles_count = 0

        try:
            self._set_state(
                phase="exploring",
                message="Автономное исследование местности"
            )

            while not self._cancel.is_set():
                # Получаем скан лидара
                scan = self._get_scan()
                if not scan:
                    log.warning("Нет данных лидара, ожидание...")
                    time.sleep(self.scan_interval_s)
                    continue

                # Анализируем окружение
                surroundings = self._analyze_surroundings(scan)

                # Принимаем решение о движении
                speed, steering_angle, priority = self._decide_movement(surroundings)

                # Учитываем обнаруженные препятствия
                if priority == 2:
                    obstacles_count += 1
                    self._set_state(
                        phase="avoiding",
                        message=f"Обход препятствия на расстоянии {surroundings['obstacle_distance']:.1f} м",
                        obstacles_detected=obstacles_count
                    )

                # Получаем текущую позицию с карты
                try:
                    snapshot = self.map_service.navigation_snapshot()
                    pose = snapshot.get("pose", {})
                    current_x = float(pose.get("x", 0.0))
                    current_y = float(pose.get("y", 0.0))
                    current_pos = (current_x, current_y)

                    # Вычисляем пройденное расстояние
                    if last_position is not None:
                        dx = current_x - last_position[0]
                        dy = current_y - last_position[1]
                        distance_delta = math.hypot(dx, dy)
                        if distance_delta < 1.0:  # Фильтр выбросов
                            total_distance += distance_delta

                    last_position = current_pos

                except Exception as exc:
                    log.debug("Ошибка получения позиции: %s", exc)

                # Обновляем состояние
                exploration_time = self.clock() - start_time
                self._set_state(
                    distance_traveled=round(total_distance, 2),
                    exploration_time=round(exploration_time, 1)
                )

                # Отправляем команды движения
                try:
                    if speed > 0:
                        # Сначала выставляем угол поворота колёс
                        if abs(steering_angle) > 1.0:
                            if hasattr(self.source, "steer_all"):
                                self.source.steer_all(steering_angle)
                            time.sleep(0.3)  # Ждём выставления колёс

                        # Затем подаём тягу
                        if hasattr(self.source, "drive"):
                            # Преобразуем скорость в проценты (примерная калибровка)
                            speed_percent = int(speed * 20)  # 0.05 м/с ≈ 1%
                            self.source.drive(min(speed_percent, 20))
                    else:
                        # Остановка
                        if hasattr(self.source, "drive"):
                            self.source.drive(0)

                        # При препятствии - поворачиваем колёса для обхода
                        if abs(steering_angle) > 1.0 and hasattr(self.source, "steer_all"):
                            self.source.steer_all(steering_angle)

                except Exception as exc:
                    log.error("Ошибка управления приводом: %s", exc)
                    raise AutonomousNavigationError(
                        "drive_error",
                        f"Ошибка управления приводом: {exc}"
                    )

                # Пауза перед следующим циклом
                time.sleep(self.scan_interval_s)

            # Завершение работы - останавливаем робота
            try:
                if hasattr(self.source, "drive"):
                    self.source.drive(0)
            except Exception as exc:
                log.error("Ошибка остановки при завершении: %s", exc)

            self._set_state(
                phase="completed",
                message="Автономное движение завершено",
                distance_traveled=round(total_distance, 2),
                exploration_time=round(self.clock() - start_time, 1)
            )

        except AutonomousNavigationError as exc:
            self._set_state(
                phase="error",
                message=exc.message
            )
            log.error("Ошибка автономного движения: %s", exc.message)

        except Exception as exc:
            log.exception("Неожиданная ошибка автономного движения")
            self._set_state(
                phase="error",
                message=f"Неожиданная ошибка: {str(exc)[:100]}"
            )

        finally:
            with self._lock:
                self._worker = None
                log.info("Поток автономного движения завершён")
