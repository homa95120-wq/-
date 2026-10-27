#!/usr/bin/env python3
"""Тестовый скрипт для проверки автономного движения и объединения камер.

Использование:
    python3 test_autonomous.py --test-cameras    # Тест камер
    python3 test_autonomous.py --test-merge      # Тест объединения
    python3 test_autonomous.py --test-lidar      # Тест лидара
    python3 test_autonomous.py --test-full       # Полный тест системы
"""

import argparse
import sys
import time
from pathlib import Path

# Добавляем корень проекта в путь
sys.path.insert(0, str(Path(__file__).parent.parent))


def test_cameras():
    """Проверка доступности камер."""
    print("=== Тест камер ===")
    try:
        import cv2

        for cam_id in [0, 1]:
            print(f"\nПроверка камеры {cam_id}...")
            cap = cv2.VideoCapture(cam_id, cv2.CAP_V4L2)

            if not cap.isOpened():
                print(f"  ❌ Камера {cam_id} недоступна")
                continue

            # Получаем один кадр
            ret, frame = cap.read()
            if ret and frame is not None:
                h, w = frame.shape[:2]
                print(f"  ✓ Камера {cam_id} работает: {w}×{h}")
            else:
                print(f"  ❌ Не удалось получить кадр с камеры {cam_id}")

            cap.release()

        print("\nТест камер завершён")

    except ImportError:
        print("❌ OpenCV не установлен. Установите: pip install opencv-python")
        return False
    except Exception as exc:
        print(f"❌ Ошибка: {exc}")
        return False

    return True


def test_merge():
    """Проверка объединения изображений с двух камер."""
    print("\n=== Тест объединения камер ===")
    try:
        from robot_control.dual_camera_merger import DualCameraMerger

        merger = DualCameraMerger(left_cam_id=0, right_cam_id=1)
        print("Запуск объединения камер...")
        merger.start()

        # Даём время на инициализацию
        time.sleep(3.0)

        if not merger.is_active:
            print("❌ Объединение камер не активно")
            merger.stop()
            return False

        print("✓ Объединение камер активно")

        # Получаем кадр
        print("Получение объединённого кадра...")
        frame = merger.get_merged_frame(max_age_s=5.0)

        if frame:
            # Сохраняем кадр
            output_file = "test_merged_frame.jpg"
            with open(output_file, "wb") as f:
                f.write(frame)
            print(f"✓ Кадр сохранён: {output_file} ({len(frame)} байт)")
        else:
            print("❌ Не удалось получить объединённый кадр")
            merger.stop()
            return False

        merger.stop()
        print("\nТест объединения завершён успешно")
        return True

    except Exception as exc:
        print(f"❌ Ошибка: {exc}")
        import traceback
        traceback.print_exc()
        return False


def test_lidar():
    """Проверка работы лидара."""
    print("\n=== Тест лидара ===")
    try:
        from robot_control.lidar import LidarManager

        manager = LidarManager()
        print("Инициализация лидара...")

        # Даём время на подключение
        time.sleep(2.0)

        # Проверяем статус
        status = manager.get_status()
        print(f"Статус: {status.get('reason', 'Нет данных')}")

        if not status.get("ok"):
            print("❌ Лидар не готов")
            return False

        # Получаем скан
        print("Получение скана...")
        scan = manager.get_scan(max_age=2.0)

        if scan:
            print(f"✓ Получен скан: {len(scan)} точек")

            # Анализируем скан
            if len(scan) > 0:
                angles = [p.get("a", 0) for p in scan]
                distances = [p.get("r", 0) for p in scan]
                print(f"  Углы: {min(angles):.2f} .. {max(angles):.2f} рад")
                print(f"  Дальность: {min(distances):.2f} .. {max(distances):.2f} м")
        else:
            print("❌ Не удалось получить скан")
            return False

        print("\nТест лидара завершён успешно")
        return True

    except Exception as exc:
        print(f"❌ Ошибка: {exc}")
        import traceback
        traceback.print_exc()
        return False


def test_full():
    """Полный тест всей системы автономного движения."""
    print("\n=== Полный тест системы ===")

    # Последовательно проверяем все компоненты
    results = {
        "Камеры": test_cameras(),
        "Объединение камер": test_merge(),
        "Лидар": test_lidar(),
    }

    print("\n" + "="*50)
    print("РЕЗУЛЬТАТЫ ТЕСТОВ:")
    print("="*50)

    for name, result in results.items():
        status = "✓ УСПЕШНО" if result else "❌ ОШИБКА"
        print(f"{name:20} {status}")

    all_passed = all(results.values())

    print("="*50)
    if all_passed:
        print("✓ ВСЕ ТЕСТЫ ПРОЙДЕНЫ")
        print("\nСистема готова к автономному движению!")
        print("Запустите робота и перейдите на страницу автономного движения.")
    else:
        print("❌ НЕКОТОРЫЕ ТЕСТЫ НЕ ПРОШЛИ")
        print("\nПроверьте:")
        print("  1. Подключены ли камеры к /dev/video0 и /dev/video1")
        print("  2. Установлен ли OpenCV: pip install opencv-python")
        print("  3. Подключён ли лидар")
        print("  4. Настроены ли права доступа к устройствам")

    return all_passed


def main():
    parser = argparse.ArgumentParser(
        description="Тестирование системы автономного движения"
    )
    parser.add_argument(
        "--test-cameras",
        action="store_true",
        help="Проверить доступность камер"
    )
    parser.add_argument(
        "--test-merge",
        action="store_true",
        help="Проверить объединение изображений"
    )
    parser.add_argument(
        "--test-lidar",
        action="store_true",
        help="Проверить работу лидара"
    )
    parser.add_argument(
        "--test-full",
        action="store_true",
        help="Выполнить все тесты"
    )

    args = parser.parse_args()

    # Если не указан ни один тест - запускаем полный
    if not any([args.test_cameras, args.test_merge, args.test_lidar, args.test_full]):
        args.test_full = True

    success = True

    if args.test_cameras:
        success = test_cameras() and success

    if args.test_merge:
        success = test_merge() and success

    if args.test_lidar:
        success = test_lidar() and success

    if args.test_full:
        success = test_full() and success

    sys.exit(0 if success else 1)


if __name__ == "__main__":
    main()
