"""API эндпоинты для автономного движения и объединения камер."""

from __future__ import annotations

import logging
from flask import Blueprint, Response, jsonify, request

log = logging.getLogger("robot_control.autonomous_api")


def create_autonomous_blueprint(autonomous_service, dual_camera_merger) -> Blueprint:
    """Создаёт Blueprint для автономного движения.

    Args:
        autonomous_service: Экземпляр AutonomousNavigationService
        dual_camera_merger: Экземпляр DualCameraMerger

    Returns:
        Настроенный Blueprint
    """
    bp = Blueprint("autonomous", __name__)

    @bp.route("/api/autonomous/status", methods=["GET"])
    def get_status():
        """Возвращает текущее состояние автономного движения."""
        try:
            status = autonomous_service.status()
            return jsonify(status)
        except Exception as exc:
            log.error("Ошибка получения статуса автономного движения: %s", exc)
            return jsonify({
                "ok": False,
                "error": str(exc)
            }), 500

    @bp.route("/api/autonomous/start", methods=["POST"])
    def start_autonomous():
        """Запускает автономное движение."""
        try:
            result = autonomous_service.start()
            return jsonify(result), 200
        except Exception as exc:
            log.error("Ошибка запуска автономного движения: %s", exc)
            return jsonify({
                "ok": False,
                "error": str(exc),
                "code": getattr(exc, "code", "unknown_error")
            }), 409

    @bp.route("/api/autonomous/stop", methods=["POST"])
    def stop_autonomous():
        """Останавливает автономное движение."""
        try:
            reason = request.json.get("reason", "Остановлено оператором") if request.json else "Остановлено оператором"
            result = autonomous_service.stop(reason=reason)
            return jsonify(result), 200
        except Exception as exc:
            log.error("Ошибка остановки автономного движения: %s", exc)
            return jsonify({
                "ok": False,
                "error": str(exc)
            }), 500

    @bp.route("/api/dual-camera/status", methods=["GET"])
    def get_dual_camera_status():
        """Возвращает состояние объединения камер."""
        try:
            return jsonify({
                "ok": True,
                "active": dual_camera_merger.is_active,
                "leftCamId": dual_camera_merger.left_cam_id,
                "rightCamId": dual_camera_merger.right_cam_id,
                "width": dual_camera_merger.width,
                "height": dual_camera_merger.height,
                "fps": dual_camera_merger.fps,
            })
        except Exception as exc:
            log.error("Ошибка получения статуса камер: %s", exc)
            return jsonify({
                "ok": False,
                "error": str(exc)
            }), 500

    @bp.route("/api/dual-camera/stream", methods=["GET"])
    def get_dual_camera_stream():
        """Возвращает MJPEG-поток объединённого изображения."""
        def generate():
            import time
            while True:
                frame = dual_camera_merger.get_merged_frame(max_age_s=2.0)
                if frame:
                    yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + frame + b"\r\n"
                time.sleep(1.0 / 30)  # ~30 FPS

        return Response(
            generate(),
            mimetype="multipart/x-mixed-replace; boundary=frame"
        )

    @bp.route("/api/dual-camera/frame", methods=["GET"])
    def get_dual_camera_frame():
        """Возвращает один объединённый кадр."""
        try:
            frame = dual_camera_merger.get_merged_frame(max_age_s=2.0)
            if frame:
                return Response(frame, mimetype="image/jpeg")
            return jsonify({
                "ok": False,
                "error": "Нет доступного кадра"
            }), 503
        except Exception as exc:
            log.error("Ошибка получения кадра: %s", exc)
            return jsonify({
                "ok": False,
                "error": str(exc)
            }), 500

    return bp
