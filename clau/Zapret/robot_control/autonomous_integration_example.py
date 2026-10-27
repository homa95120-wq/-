"""Пример интеграции автономного движения в основное приложение.

Добавьте этот код в robot_control/app.py для подключения автономной навигации.
"""

# === В начале файла, после других импортов ===
from .autonomous_navigation import AutonomousNavigationService
from .dual_camera_merger import get_merger
from .autonomous_api import create_autonomous_blueprint


# === В функции create_app, после создания других сервисов ===

def integrate_autonomous_navigation(app, config, source, lidar_manager, slam_map_service):
    """Интегрирует автономное движение в приложение.

    Args:
        app: Flask приложение
        config: Конфигурация
        source: Источник данных шасси (master bridge)
        lidar_manager: Менеджер лидара
        slam_map_service: Сервис карты SLAM
    """

    # Инициализируем объединение камер
    dual_camera_merger = get_merger()
    dual_camera_merger.start()

    # Инициализируем автономную навигацию
    autonomous_service = AutonomousNavigationService(
        map_service=slam_map_service,
        source=source,
        lidar_manager=lidar_manager,
        camera_manager=None,  # Опционально: передать CameraManager
        enabled=None,  # Будет взято из RC_AUTO_NAV_ENABLE
        road_width_m=None,  # Будет взято из RC_ROAD_WIDTH_M
        speed_mps=None,  # Будет взято из RC_AUTO_NAV_SPEED_MPS
    )

    # Регистрируем Blueprint с API
    autonomous_bp = create_autonomous_blueprint(
        autonomous_service=autonomous_service,
        dual_camera_merger=dual_camera_merger
    )
    app.register_blueprint(autonomous_bp)

    # Сохраняем сервисы в расширениях приложения для доступа из других модулей
    app.extensions["rc_autonomous"] = autonomous_service
    app.extensions["rc_dual_camera"] = dual_camera_merger

    log.info("Автономная навигация инициализирована")

    return autonomous_service, dual_camera_merger


# === Пример использования в create_app ===

# После создания slam_map_service и перед возвратом app:
"""
    # Подключаем автономное движение, если включено
    if config.auto_nav_enable:
        try:
            autonomous_service, dual_camera = integrate_autonomous_navigation(
                app=app,
                config=config,
                source=source,
                lidar_manager=lidar_manager,
                slam_map_service=slam_map_service
            )
        except Exception as exc:
            log.error("Не удалось инициализировать автономное движение: %s", exc)
"""


# === Добавьте в Config класс (robot_control/config.py) ===
"""
class Config:
    # ... существующие поля ...

    @property
    def auto_nav_enable(self) -> bool:
        '''Включено ли автономное движение.'''
        return self._env_bool("RC_AUTO_NAV_ENABLE", False)

    @property
    def road_width_m(self) -> float:
        '''Ширина дороги в метрах.'''
        return self._env_float("RC_ROAD_WIDTH_M", 7.5, 3.0, 15.0)

    @property
    def safe_distance_m(self) -> float:
        '''Безопасное расстояние от края дороги.'''
        return self._env_float("RC_SAFE_DISTANCE_M", 0.8, 0.3, 2.0)
"""


# === HTML интерфейс (пример страницы в templates/) ===

AUTONOMOUS_PAGE_HTML = """
<!DOCTYPE html>
<html lang="ru">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Автономное движение</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #0A0D12;
            color: #E5E7EB;
        }
        .card {
            background: #161D2B;
            border-radius: 12px;
            padding: 24px;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0, 0, 0, 0.3);
        }
        .status {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 16px;
            margin-bottom: 20px;
        }
        .stat {
            background: #1E2636;
            padding: 16px;
            border-radius: 8px;
        }
        .stat-label {
            font-size: 14px;
            color: #9CA3AF;
            margin-bottom: 4px;
        }
        .stat-value {
            font-size: 24px;
            font-weight: 600;
            color: #38BDF8;
        }
        button {
            background: #38BDF8;
            color: #05070C;
            border: none;
            padding: 12px 24px;
            border-radius: 999px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
        }
        button:hover {
            background: #0EA5E9;
            transform: translateY(-2px);
        }
        button:disabled {
            background: #374151;
            color: #6B7280;
            cursor: not-allowed;
            transform: none;
        }
        .stop-btn {
            background: #EF4444;
            color: white;
        }
        .stop-btn:hover {
            background: #DC2626;
        }
        #camera-view {
            width: 100%;
            border-radius: 8px;
            background: #000;
        }
        .phase {
            display: inline-block;
            padding: 6px 12px;
            border-radius: 999px;
            font-size: 14px;
            font-weight: 600;
            margin-bottom: 12px;
        }
        .phase-idle { background: #374151; color: #9CA3AF; }
        .phase-starting { background: #FCD34D; color: #78350F; }
        .phase-exploring { background: #34D399; color: #064E3B; }
        .phase-avoiding { background: #FBBF24; color: #78350F; }
        .phase-stopping { background: #F87171; color: #7F1D1D; }
        .phase-error { background: #DC2626; color: white; }
    </style>
</head>
<body>
    <h1>🤖 Автономное движение</h1>

    <div class="card">
        <h2>Статус</h2>
        <div class="phase" id="phase">Загрузка...</div>
        <p id="message">Загрузка статуса...</p>

        <div style="margin-top: 20px;">
            <button id="start-btn" onclick="startAutonomous()">▶ Запустить</button>
            <button id="stop-btn" class="stop-btn" onclick="stopAutonomous()" style="display:none;">⏹ Остановить</button>
        </div>
    </div>

    <div class="card">
        <h2>Показатели</h2>
        <div class="status">
            <div class="stat">
                <div class="stat-label">Пройдено</div>
                <div class="stat-value" id="distance">0.0 м</div>
            </div>
            <div class="stat">
                <div class="stat-label">Время</div>
                <div class="stat-value" id="time">0 с</div>
            </div>
            <div class="stat">
                <div class="stat-label">Препятствий</div>
                <div class="stat-value" id="obstacles">0</div>
            </div>
            <div class="stat">
                <div class="stat-label">Скорость</div>
                <div class="stat-value" id="speed">0.08 м/с</div>
            </div>
        </div>
    </div>

    <div class="card">
        <h2>Вид с камер</h2>
        <img id="camera-view" src="/api/dual-camera/stream" alt="Объединённый вид с двух камер">
    </div>

    <script>
        const phaseClasses = {
            idle: 'phase-idle',
            starting: 'phase-starting',
            exploring: 'phase-exploring',
            avoiding: 'phase-avoiding',
            stopping: 'phase-stopping',
            error: 'phase-error'
        };

        const phaseLabels = {
            idle: 'Ожидание',
            starting: 'Запуск',
            exploring: 'Исследование',
            avoiding: 'Обход препятствия',
            stopping: 'Остановка',
            error: 'Ошибка'
        };

        async function updateStatus() {
            try {
                const response = await fetch('/api/autonomous/status');
                const data = await response.json();

                // Обновляем фазу
                const phaseEl = document.getElementById('phase');
                phaseEl.className = 'phase ' + (phaseClasses[data.phase] || 'phase-idle');
                phaseEl.textContent = phaseLabels[data.phase] || data.phase;

                // Обновляем сообщение
                document.getElementById('message').textContent = data.message || 'Нет данных';

                // Обновляем показатели
                document.getElementById('distance').textContent = (data.distance_traveled || 0).toFixed(1) + ' м';
                document.getElementById('time').textContent = Math.floor(data.exploration_time || 0) + ' с';
                document.getElementById('obstacles').textContent = data.obstacles_detected || 0;
                document.getElementById('speed').textContent = (data.speedMps || 0).toFixed(2) + ' м/с';

                // Обновляем кнопки
                const startBtn = document.getElementById('start-btn');
                const stopBtn = document.getElementById('stop-btn');

                if (data.active) {
                    startBtn.style.display = 'none';
                    stopBtn.style.display = 'inline-block';
                } else {
                    startBtn.style.display = 'inline-block';
                    startBtn.disabled = !data.enabled;
                    stopBtn.style.display = 'none';
                }
            } catch (error) {
                console.error('Ошибка получения статуса:', error);
            }
        }

        async function startAutonomous() {
            try {
                const response = await fetch('/api/autonomous/start', { method: 'POST' });
                const data = await response.json();

                if (!data.ok) {
                    alert('Ошибка запуска: ' + (data.error || 'Неизвестная ошибка'));
                }

                updateStatus();
            } catch (error) {
                alert('Ошибка запуска: ' + error.message);
            }
        }

        async function stopAutonomous() {
            try {
                const response = await fetch('/api/autonomous/stop', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason: 'Остановлено оператором' })
                });

                const data = await response.json();

                if (!data.ok) {
                    alert('Ошибка остановки: ' + (data.error || 'Неизвестная ошибка'));
                }

                updateStatus();
            } catch (error) {
                alert('Ошибка остановки: ' + error.message);
            }
        }

        // Обновляем статус каждую секунду
        updateStatus();
        setInterval(updateStatus, 1000);
    </script>
</body>
</html>
"""


# === Route для страницы автономного движения ===
"""
@app.route("/autonomous")
@login_required
def autonomous_page():
    return render_template_string(AUTONOMOUS_PAGE_HTML)
"""
