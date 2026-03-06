"""
backend/collection.py — 데이터 수집 세션 관리
================================================

[역할]
    AI 검사 없이 카메라에서 이미지만 수집하여 디스크에 저장합니다.
    InspectionWorker와 독립적으로 동작하며, 카메라 충돌을 방지합니다.

[모드]
    - trigger   : Basler 하드웨어 트리거 신호마다 자동 저장
    - continuous: 스페이스바를 누르고 있는 동안 프레임을 연속 저장

[저장 경로]
    only_image/{line_name}/YYYYMMDD_HHMMSS_mmm.jpg
"""

from __future__ import annotations

import cv2
import os
import sys
import time
import threading
from datetime import datetime
from queue import Queue, Full
from typing import Optional

_FRAMEWORK_PATH = os.path.join(os.path.dirname(__file__), '..', 'inspection_framework')

# rotation 문자열 → cv2 상수 매핑
_ROTATION_STR_TO_CV2 = {
    "CLOCKWISE_90":        cv2.ROTATE_90_CLOCKWISE,
    "COUNTERCLOCKWISE_90": cv2.ROTATE_90_COUNTERCLOCKWISE,
    "180":                 cv2.ROTATE_180,
    "NONE":                None,
}


class CollectionSession:
    """
    경량 카메라 수집 세션.
    AI 모델, 리젝터, DataManager 없이 카메라 grab + JPEG 스트리밍 + 이미지 저장만 수행합니다.
    """

    def __init__(
        self,
        line_name: str,
        camera_type: str,
        camera_ip: str,
        pfs_file: str,
        rotation: str,
        crop_region: Optional[list],
        save_dir: str,
        force_mode: Optional[str] = None,  # None=auto, "trigger", "continuous"
    ):
        self.line_name = line_name
        self.save_dir = save_dir
        self.frame_queue: Queue = Queue(maxsize=2)

        # 카메라 설정
        self._camera_type = camera_type
        self._camera_ip = camera_ip
        self._pfs_file = pfs_file
        self._rotation = rotation
        self._crop_region = crop_region

        # 내부 상태
        self._camera = None
        self._thread: Optional[threading.Thread] = None
        self._stop_event = threading.Event()
        self._status = "stopped"
        self._last_error = ""
        self._mode_detected = False  # 트리거 모드 감지 완료 여부
        self._force_mode = force_mode  # None | "trigger" | "continuous"

        # 저장 제어
        self._pending_saves = 0         # 연속 모드: 스페이스 1회 = +1, 루프에서 1장 저장 후 -1
        self._save_lock = threading.Lock()
        self._auto_save = False         # 트리거 모드: 매 프레임 자동 저장
        self._detected_mode = "continuous"
        self._saved_count = 0
        self._fps = 0.0

    # ── 공개 프로퍼티 ──────────────────────────────────────────────

    @property
    def status(self) -> str:
        return self._status

    @property
    def detected_mode(self) -> str:
        return self._detected_mode

    @property
    def stats(self) -> dict:
        return {
            "line_name": self.line_name,
            "status": self._status,
            "detected_mode": self._detected_mode,
            "fps": round(self._fps, 1),
            "saved_count": self._saved_count,
            "pending_saves": self._pending_saves,
            "last_error": self._last_error,
        }

    # ── 공개 메서드 ────────────────────────────────────────────────

    def start(self):
        """백그라운드 스레드에서 수집 루프를 시작합니다."""
        if self._status == "running":
            return
        self._stop_event.clear()
        self._pending_saves = 0
        self._saved_count = 0
        self._last_error = ""
        self._status = "running"
        self._thread = threading.Thread(
            target=self._run_loop,
            name=f"collect-{self.line_name}",
            daemon=True,
        )
        self._thread.start()

    def stop(self):
        """수집 루프 종료를 요청합니다."""
        self._stop_event.set()

    def join(self, timeout: float = 5.0):
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=timeout)

    def request_save(self):
        """저장 요청 1회 추가 (스페이스바 1회 = 1장 저장)."""
        with self._save_lock:
            self._pending_saves += 1

    # ── 내부 메서드 ────────────────────────────────────────────────

    def _init_camera(self):
        """카메라 인스턴스 생성 + 연결."""
        if _FRAMEWORK_PATH not in sys.path:
            sys.path.insert(0, _FRAMEWORK_PATH)

        rotation_cv2 = _ROTATION_STR_TO_CV2.get(self._rotation, None)

        if self._camera_type == "webcam":
            from webcam_camera import WebcamCamera
            self._camera = WebcamCamera(
                camera_ip=self._camera_ip,
                rotation=rotation_cv2,
                crop_region=self._crop_region,
            )
        else:
            from camera import BaslerCamera
            self._camera = BaslerCamera(
                camera_ip=self._camera_ip,
                pfs_file=self._pfs_file,
                rotation=rotation_cv2,
                crop_region=self._crop_region,
            )
        self._camera.open()

    def _detect_trigger_mode(self) -> bool:
        """카메라 open 후 TriggerMode를 읽어 트리거 모드 여부를 판별합니다."""
        try:
            return self._camera.get_trigger_mode() == "On"
        except Exception:
            return False

    def _save_image(self, image):
        """이미지를 YYYYMMDD_HHMMSS_mmm.jpg 형식으로 저장합니다."""
        now = datetime.now()
        filename = now.strftime("%Y%m%d_%H%M%S") + f"_{now.microsecond // 1000:03d}.jpg"
        filepath = os.path.join(self.save_dir, filename)
        ok = cv2.imwrite(filepath, image)
        if not ok:
            print(f"[Collection:{self.line_name}] WARNING: imwrite failed → {filepath}")
            return
        self._saved_count += 1
        print(f"[Collection:{self.line_name}] Saved #{self._saved_count}: {filename}")

    def _push_frame(self, image):
        """JPEG 인코딩 후 frame_queue에 넣습니다."""
        ok, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 80])
        if not ok:
            return
        jpeg = buf.tobytes()
        try:
            self.frame_queue.put_nowait(jpeg)
        except Full:
            try:
                self.frame_queue.get_nowait()
                self.frame_queue.put_nowait(jpeg)
            except Exception:
                pass

    def _run_loop(self):
        """백그라운드 스레드: 카메라 초기화 → 수집 루프."""
        try:
            # 1. 카메라 초기화
            self._init_camera()

            # 2. 트리거 모드 감지 (force_mode가 auto/None이면 카메라 설정으로 자동 감지)
            if self._force_mode == "trigger":
                is_trigger = True
            elif self._force_mode == "continuous":
                is_trigger = False
            else:
                is_trigger = self._detect_trigger_mode()
            self._auto_save = is_trigger
            self._detected_mode = "trigger" if is_trigger else "continuous"
            self._mode_detected = True
            print(f"[Collection:{self.line_name}] Mode: {self._detected_mode}"
                  + (" (forced)" if self._force_mode else " (auto-detected)"))

            # 3. 저장 디렉토리 생성
            os.makedirs(self.save_dir, exist_ok=True)
            print(f"[Collection:{self.line_name}] Save dir: {self.save_dir}")

            # 4. 수집 루프
            while not self._stop_event.is_set():
                loop_start = time.time()

                frame, cropped, triggered = self._camera.grab()
                if not triggered or frame is None:
                    continue

                # 저장 판단: 트리거 모드면 항상, 연속 모드면 pending 카운터 소비
                should_save = False
                if self._auto_save:
                    should_save = True
                else:
                    with self._save_lock:
                        if self._pending_saves > 0:
                            self._pending_saves -= 1
                            should_save = True
                if should_save:
                    self._save_image(cropped)

                # WebSocket 프리뷰용 JPEG 전송
                self._push_frame(cropped)

                elapsed = time.time() - loop_start
                self._fps = 1.0 / max(elapsed, 1e-6)

        except Exception as e:
            self._last_error = str(e)
            self._status = "error"
            print(f"[Collection:{self.line_name}] ERROR: {e}")
        finally:
            self._cleanup()

    def _cleanup(self):
        """루프 종료 후 자원 해제."""
        if self._status != "error":
            self._status = "stopped"
        self._pending_saves = 0
        if self._camera is not None:
            self._camera.close()
        print(f"[Collection:{self.line_name}] Session stopped. Saved {self._saved_count} images.")
