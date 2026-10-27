# Автономное движение — Новая функциональность

## Что добавлено

В систему управления роботом добавлены модули для **автономного движения** с построением карты.

### Основные компоненты:

1. **`dual_camera_merger.py`** — Объединение изображений с двух Logitech Brio 500 в одно широкое изображение
2. **`autonomous_navigation.py`** — Автономное движение по дороге с избежанием препятствий
3. **`autonomous_api.py`** — API эндпоинты для управления автономным движением
4. **`autonomous_integration_example.py`** — Пример интеграции в основное приложение

## Структура файлов

```
robot_control/
├── dual_camera_merger.py          # Объединение камер
├── autonomous_navigation.py       # Автономное движение
├── autonomous_api.py              # API для автономного движения
└── autonomous_integration_example.py  # Пример интеграции

docs/
├── AUTONOMOUS_NAVIGATION.md       # Полная документация
└── QUICKSTART_AUTONOMOUS.md       # Быстрый старт

scripts/
└── test_autonomous.py             # Тестовый скрипт
```

## Быстрый старт

### 1. Установите зависимости

```bash
pip install opencv-python numpy
```

### 2. Настройте .env

```bash
# Добавьте в .env
RC_AUTO_NAV_ENABLE=1
RC_ROAD_WIDTH_M=7.5
RC_AUTO_NAV_SPEED_MPS=0.08
RC_CAMERA_FRONT=/dev/video0
RC_CAMERA_REAR=/dev/video1
```

### 3. Проверьте систему

```bash
python3 scripts/test_autonomous.py --test-full
```

### 4. Интеграция в приложение

Добавьте в `robot_control/app.py` после создания других сервисов:

```python
from .autonomous_navigation import AutonomousNavigationService
from .dual_camera_merger import get_merger
from .autonomous_api import create_autonomous_blueprint

# Инициализация
dual_camera_merger = get_merger()
dual_camera_merger.start()

autonomous_service = AutonomousNavigationService(
    map_service=slam_map_service,
    source=source,
    lidar_manager=lidar_manager,
)

# Регистрация API
autonomous_bp = create_autonomous_blueprint(
    autonomous_service, dual_camera_merger
)
app.register_blueprint(autonomous_bp)
```

### 5. Запустите робота

```bash
./scripts/start_robot.sh
```

### 6. Откройте веб-интерфейс

Добавьте страницу автономного движения из `autonomous_integration_example.py` или используйте API напрямую.

## API Endpoints

### Автономное движение

- `GET /api/autonomous/status` — Статус автономного движения
- `POST /api/autonomous/start` — Запустить автономное движение
- `POST /api/autonomous/stop` — Остановить автономное движение

### Объединение камер

- `GET /api/dual-camera/status` — Статус объединения камер
- `GET /api/dual-camera/stream` — MJPEG-поток объединённого изображения
- `GET /api/dual-camera/frame` — Один кадр объединённого изображения

## Примеры использования

### Python

```python
import requests

# Запуск автономного движения
response = requests.post("http://192.168.1.100:8080/api/autonomous/start")
print(response.json())

# Получение статуса
response = requests.get("http://192.168.1.100:8080/api/autonomous/status")
status = response.json()
print(f"Пройдено: {status['distance_traveled']} м")
```

### Curl

```bash
# Запуск
curl -X POST http://192.168.1.100:8080/api/autonomous/start

# Статус
curl http://192.168.1.100:8080/api/autonomous/status

# Остановка
curl -X POST http://192.168.1.100:8080/api/autonomous/stop \
  -H "Content-Type: application/json" \
  -d '{"reason": "Тестовая остановка"}'
```

## Конфигурация

### Основные параметры (.env)

```bash
# Включение автономного движения
RC_AUTO_NAV_ENABLE=1

# Параметры дороги
RC_ROAD_WIDTH_M=7.5              # Ширина дороги (3.0-15.0 м)
RC_SAFE_DISTANCE_M=0.8           # Безопасное расстояние от края (0.3-2.0 м)

# Параметры движения
RC_AUTO_NAV_SPEED_MPS=0.08       # Скорость (0.02-0.15 м/с)
RC_SCAN_INTERVAL_S=0.5           # Интервал сканирования (0.2-2.0 с)
RC_TURN_ANGLE_DEG=30.0           # Угол поворота при препятствии (15-90°)

# Камеры
RC_CAMERA_FRONT=/dev/video0      # Левая камера
RC_CAMERA_REAR=/dev/video1       # Правая камера
```

## Алгоритм работы

1. **Анализ окружения** — Робот сканирует пространство лидаром
   - Передний сектор (±30°) — проверка препятствий
   - Левый/правый секторы — расстояние до краёв дороги

2. **Принятие решения** — На основе анализа:
   - Движение прямо (если дорога свободна)
   - Корректировка курса (если близко к краю)
   - Обход препятствия (если обнаружено)

3. **Управление движением** — Робот:
   - Выставляет угол колёс
   - Подаёт тягу
   - Контролирует выполнение

4. **Построение карты** — Данные лидара автоматически добавляются на карту

## Безопасность

### Аппаратные меры
- E-STOP (физическая + программная кнопка)
- Watchdog (650 мс)
- Проверка свежести данных лидара

### Программные ограничения
- Максимальная скорость: 0.15 м/с
- Минимальное расстояние до препятствия: 1.0 м
- Безопасное расстояние от края: 0.8 м
- Проверка готовности перед стартом

## Тестирование

### Тест всей системы
```bash
python3 scripts/test_autonomous.py --test-full
```

### Отдельные тесты
```bash
# Камеры
python3 scripts/test_autonomous.py --test-cameras

# Объединение изображений
python3 scripts/test_autonomous.py --test-merge

# Лидар
python3 scripts/test_autonomous.py --test-lidar
```

## Характеристики железа

### Основной компьютер
- **Процессор**: Intel Core i5-13400 (10 ядер, 16 потоков)
- **Память**: 16 ГБ RAM
- **ОС**: Ubuntu 22.04 LTS (рекомендуется)

### Камеры
- **Модель**: Logitech Brio 500 (2 штуки)
- **Разрешение**: 1920×1080 @ 30 FPS
- **Поле зрения**: ~90° каждая
- **Интерфейс**: USB 3.0

### Лидар
- **Модель**: RPLIDAR A1/A2/A3 или совместимый
- **Дальность**: до 12 м
- **Частота**: 360° при 5-10 Гц
- **Интерфейс**: USB

### Колёса
- **Модули**: 4× Arduino Mega с рулевыми моторами
- **Управление**: USB (индивидуальное для каждого)
- **Углы поворота**: ±100°

## Ограничения

1. **Скорость** — Максимум 0.15 м/с (для безопасности)
2. **Дорога** — Ширина 3-15 метров, ровная поверхность
3. **Препятствия** — Только те, что видит лидар
4. **Освещение** — Камеры требуют достаточного света
5. **Высота** — Без резких перепадов

## Устранение проблем

### Камеры не работают
```bash
# Проверка
ls -l /dev/video*
sudo usermod -aG video $USER
# Выход и вход заново
```

### Лидар не готов
```bash
# Проверка ROS2
./scripts/ros2_lidar.sh --status

# Обновление порта в .env
RC_LIDAR_PORT=/dev/ttyUSB0
```

### Автономное движение не запускается
- Проверьте `RC_AUTO_NAV_ENABLE=1` в `.env`
- Снимите E-STOP
- Откалибруйте колёса
- Проверьте `RC_NAV_MPS_PER_PERCENT`

## Документация

- **Полная документация**: `docs/AUTONOMOUS_NAVIGATION.md`
- **Быстрый старт**: `docs/QUICKSTART_AUTONOMOUS.md`
- **Основная документация**: `README.md`
- **Схема подключений**: `docs/connections.md`

## Дальнейшее развитие

Возможные улучшения:

1. **GPS-навигация** — Добавление глобальных координат
2. **Распознавание объектов** — Нейросети для классификации
3. **Маршруты** — Движение по заданным точкам
4. **Групповое движение** — Координация роботов
5. **Облачная синхронизация** — Обмен картами

## Контакты и поддержка

При возникновении проблем:

1. Проверьте логи: `tail -f var/logs/robot.log`
2. Запустите тесты: `python3 scripts/test_autonomous.py --test-full`
3. Изучите документацию: `docs/AUTONOMOUS_NAVIGATION.md`
4. Проверьте конфигурацию: `.env` файл

---

**Статус**: ✅ Готово к использованию  
**Версия**: 1.0.0  
**Дата**: 2026-10-27  
**Совместимость**: Zapret v0.1.0+
