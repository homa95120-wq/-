"""Модуль объединения изображений с двух передних камер Logitech Brio 500.

Объединяет изображения с двух камер в одно широкое изображение для улучшенного
обзора при автономном движении. Камеры расположены спереди робота.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Optional

import cv2
import numpy as np

log = logging.getLogger("robot_control.dual_camera_merger")


class DualCameraMerger:
    """Объединяет изображения с двух передних камер в одно."""

    def __init__(self, left_cam_id: int = 0, right_cam_id: int = 1):
        self.left_cam_id = left_cam_id
        self.right_cam_id = right_cam_id
        self.lock = threading.Lock()
        self.merged_jpeg: Optional[bytes] = None
        self.merged_time: float = 0.0
        self.is_active = False
        self._stop = False
        self._thread: Optional[threading.Thread] = None

        # Настройки камер Logitech Brio 500
        self.width = 1920
        self.height = 1080
        self.fps = 30

        # Параметры для выравнивания изображений
        self.overlap_percent = 0.1  # 10% перекрытия для сшивки

    def start(self) -> None:
        """Запускает фоновый поток объединения камер."""
        if self._thread and self._thread.is_alive():
            return
        self._stop = False
        self._thread = threading.Thread(target=self._merge_loop, daemon=True)
        self._thread.start()
        log.info("Запущено объединение камер %d и %d", self.left_cam_id, self.right_cam_id)

    def stop(self) -> None:
        """Останавливает объединение камер."""
        self._stop = True
        self.is_active = False
        log.info("Остановлено объединение камер")

    def get_merged_frame(self, max_age_s: float = 2.0) -> Optional[bytes]:
        """Возвращает последний объединённый кадр."""
        with self.lock:
            if self.merged_jpeg and (time.time() - self.merged_time) < max_age_s:
                return self.merged_jpeg
        return None

    def _merge_loop(self) -> None:
        """Основной цикл объединения изображений с камер."""
        cap_left = None
        cap_right = None

        while not self._stop:
            try:
                # Открываем обе камеры
                if cap_left is None or not cap_left.isOpened():
                    cap_left = cv2.VideoCapture(self.left_cam_id, cv2.CAP_V4L2)
                    if cap_left.isOpened():
                        cap_left.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
                        cap_left.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
                        cap_left.set(cv2.CAP_PROP_FPS, self.fps)
                        log.info("Левая камера подключена (id=%d)", self.left_cam_id)
                    else:
                        time.sleep(2.0)
                        continue

                if cap_right is None or not cap_right.isOpened():
                    cap_right = cv2.VideoCapture(self.right_cam_id, cv2.CAP_V4L2)
                    if cap_right.isOpened():
                        cap_right.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
                        cap_right.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
                        cap_right.set(cv2.CAP_PROP_FPS, self.fps)
                        log.info("Правая камера подключена (id=%d)", self.right_cam_id)
                    else:
                        time.sleep(2.0)
                        continue

                # Читаем кадры с обеих камер
                ret_left, frame_left = cap_left.read()
                ret_right, frame_right = cap_right.read()

                if not ret_left or not ret_right or frame_left is None or frame_right is None:
                    time.sleep(0.04)
                    continue

                # Объединяем изображения
                merged_frame = self._merge_frames(frame_left, frame_right)

                if merged_frame is not None:
                    # Кодируем в JPEG
                    encode_param = [int(cv2.IMWRITE_JPEG_QUALITY), 85]
                    ret, buf = cv2.imencode(".jpg", merged_frame, encode_param)

                    if ret:
                        with self.lock:
                            self.merged_jpeg = buf.tobytes()
                            self.merged_time = time.time()
                            self.is_active = True

                time.sleep(1.0 / self.fps)

            except Exception as exc:  # noqa: BLE001
                log.debug("Ошибка объединения камер: %s", exc)
                self.is_active = False
                if cap_left is not None:
                    cap_left.release()
                    cap_left = None
                if cap_right is not None:
                    cap_right.release()
                    cap_right = None
                time.sleep(2.0)

        # Освобождаем камеры при остановке
        if cap_left is not None:
            cap_left.release()
        if cap_right is not None:
            cap_right.release()

    def _merge_frames(self, left: np.ndarray, right: np.ndarray) -> Optional[np.ndarray]:
        """Объединяет два кадра в один с учётом перекрытия.

        Args:
            left: Кадр с левой камеры
            right: Кадр с правой камеры

        Returns:
            Объединённый кадр или None при ошибке
        """
        try:
            height, width = left.shape[:2]

            # Вычисляем зону перекрытия
            overlap_pixels = int(width * self.overlap_percent)

            if overlap_pixels > 0:
                # Берём правую часть левого кадра и левую часть правого для сшивки
                left_part = left[:, :width - overlap_pixels]
                overlap_left = left[:, width - overlap_pixels:]
                overlap_right = right[:, :overlap_pixels]
                right_part = right[:, overlap_pixels:]

                # Создаём плавный переход в зоне перекрытия
                alpha = np.linspace(1, 0, overlap_pixels)
                alpha = alpha.reshape(1, -1, 1)

                overlap_merged = (overlap_left * alpha + overlap_right * (1 - alpha)).astype(np.uint8)

                # Объединяем все части
                merged = np.hstack([left_part, overlap_merged, right_part])
            else:
                # Просто склеиваем без перекрытия
                merged = np.hstack([left, right])

            return merged

        except Exception as exc:
            log.error("Ошибка при объединении кадров: %s", exc)
            return None


# Глобальный экземпляр для доступа из других модулей
_merger_instance: Optional[DualCameraMerger] = None


def get_merger() -> DualCameraMerger:
    """Возвращает глобальный экземпляр DualCameraMerger."""
    global _merger_instance
    if _merger_instance is None:
        _merger_instance = DualCameraMerger()
    return _merger_instance


def reset_merger() -> None:
    """Сбрасывает глобальный экземпляр (для тестов)."""
    global _merger_instance
    if _merger_instance is not None:
        _merger_instance.stop()
        _merger_instance = None
