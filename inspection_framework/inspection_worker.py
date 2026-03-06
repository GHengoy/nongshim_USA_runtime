"""
inspection_worker.py — 백그라운드 검사 워커
============================================

[역할]
    카메라 1대의 검사 루프를 백그라운드 스레드에서 실행합니다.
    start() / stop() 으로 비동기 제어하고,
    frame_queue 로 JPEG 프레임을 외부에 노출합니다.

[왜 이렇게 바꿨나? (inspection_runtime.py 와의 차이)]
    기존 inspection_runtime.py 는 run() 이 blocking(멈춤) 이었습니다.
    카메라 6대를 동시에 띄우거나, FastAPI WebSocket 에서
    프레임을 받아가려면 run() 이 백그라운드에서 돌아야 합니다.

    InspectionWorker 는:
        - start()  → 백그라운드 스레드 시작 (즉시 반환)
        - stop()   → 루프 종료 요청 (즉시 반환, 루프는 곧 멈춤)
        - status   → 현재 상태 문자열 반환 ("running" / "stopped" / "error")
        - stats    → FPS, 총 불량 수 등 딕셔너리 반환
        - frame_queue → (JPEG bytes) 큐. 외부에서 꺼내 WebSocket 전송 가능.

[나중에 FastAPI 에서 이렇게 씁니다]
    worker = InspectionWorker(config)
    worker.start()

    # WebSocket 핸들러에서:
    while True:
        jpeg_bytes = await asyncio.get_event_loop().run_in_executor(
            None, worker.frame_queue.get
        )
        await websocket.send_bytes(jpeg_bytes)

    worker.stop()
"""

import cv2
import time
import threading
import traceback
from datetime import date
from queue import Queue, Full
from typing import Callable, Optional

from config import InspectionConfig
# 나머지 모듈은 _build_modules() 에서 lazy import
# (pypylon / ultralytics 없는 환경에서도 서버가 정상 기동되도록)


# ──────────────────────────────────────────────────────────────────────
#  워커 상태 상수
# ──────────────────────────────────────────────────────────────────────
STATUS_STOPPED      = "stopped"        # 실행 전 또는 정상 종료
STATUS_INITIALIZING = "initializing"   # 모듈 초기화 진행 중
STATUS_RUNNING      = "running"        # 검사 루프 실행 중
STATUS_ERROR        = "error"          # 예외 발생으로 종료


class InspectionWorker:
    """
    카메라 1대 = 검사 워커 1개.

    사용법 예시
    -----------
    config = InspectionConfig.from_json("configs/4-7-pouch-C.json")
    worker = InspectionWorker(config)

    worker.start()          # 백그라운드에서 검사 시작 (즉시 반환)
    print(worker.status)    # "running"
    print(worker.stats)     # {"fps": 12.3, "defect_count": 5, ...}

    # JPEG 프레임 꺼내기 (WebSocket / OpenCV 창에 사용)
    jpeg = worker.frame_queue.get(timeout=1.0)

    worker.stop()           # 검사 중지 요청 (즉시 반환)
    worker.join()           # 스레드가 완전히 끝날 때까지 대기
    """

    def __init__(self, config: InspectionConfig, frame_queue_size: int = 2,
                 process_fn=None, on_save_callback: Optional[Callable] = None):
        """
        Parameters
        ----------
        config           : InspectionConfig 인스턴스 (모든 설정 포함)
        frame_queue_size : frame_queue 최대 크기.
                           작을수록 메모리 적게 씀 (기본 2 = 항상 최신 2프레임 유지).
        process_fn       : 이미지 획득 후 처리 함수 (run_local.py 에서 주입).
                           시그니처: process_fn(frame, cropped, *, detector, rejecter,
                                                data_manager, config) -> (annotated, is_defect)
                           None 이면 기본 동작 (AI 감지 → 리젝트 → 저장) 을 사용합니다.
        on_save_callback : 이미지 저장 후 호출되는 콜백 (S3 업로드 등).
                           시그니처: on_save_callback(category, save_dir, filename, line_name)
                           None 이면 아무 것도 하지 않습니다.
        """
        self.config = config

        # ── 외부에서 읽을 수 있는 상태 값들 ──────────────────────────
        self.frame_queue: Queue = Queue(maxsize=frame_queue_size)
        """
        JPEG bytes 가 들어오는 큐.
        - 외부(FastAPI WebSocket, OpenCV 창 등)에서 get() 으로 꺼냅니다.
        - maxsize 초과 시 오래된 프레임을 버리고 최신 프레임만 유지합니다.
        """

        # ── 내부 상태 ─────────────────────────────────────────────────
        self._status: str = STATUS_STOPPED
        self._stop_event = threading.Event()   # stop() 호출 → set()
        self._thread: Optional[threading.Thread] = None

        # 통계 (stats 프로퍼티로 외부 노출)
        self._fps: float = 0.0
        self._defect_count: int = 0
        self._total_count: int = 0
        self._last_error: str = ""
        self._reset_date: date = date.today()  # 카운터가 리셋된 날짜

        # 초기화 단계 추적 (stats 프로퍼티로 외부 노출)
        self._init_stage: str = ""       # 현재 초기화 단계명 (camera, model 등)
        self._init_total: int = 0        # 총 초기화 단계 수
        self._init_current: int = 0      # 현재 진행 중인 단계 번호

        # 커스텀 처리 함수 (run_local.py에서 주입)
        self._process_fn = process_fn

        # 이미지 저장 후 콜백 (S3 업로드 등)
        self._on_save_callback = on_save_callback

        # 각 모듈 인스턴스 (start() 시 생성)
        self._camera = None
        self._detector = None   # BaseDetector subclass instance
        self._rejecter = None
        self._data_manager = None

    # ──────────────────────────────────────────────────────────────────
    # 공개 프로퍼티 (Read-Only)
    # ──────────────────────────────────────────────────────────────────

    @property
    def status(self) -> str:
        """현재 워커 상태. "running" / "stopped" / "error" 중 하나."""
        return self._status

    @property
    def stats(self) -> dict:
        """
        현재 통계를 딕셔너리로 반환합니다.
        FastAPI 가 /stats 엔드포인트로 그대로 JSON 응답할 수 있습니다.

        반환 예시
        ---------
        {
            "line_name":    "4-7-pouch-C",
            "status":       "running",
            "fps":          12.3,
            "total_count":  1500,
            "defect_count": 23,
            "defect_rate":  "1.53%",
            "last_error":   ""
        }
        """
        defect_rate = (
            f"{self._defect_count / self._total_count * 100:.2f}%"
            if self._total_count > 0 else "0.00%"
        )
        return {
            "line_name":    self.config.line_name,
            "project_name": getattr(self.config, 'project_name', '') or self.config.line_name,
            "status":       self._status,
            "fps":          round(self._fps, 1),
            "total_count":  self._total_count,
            "defect_count": self._defect_count,
            "defect_rate":  defect_rate,
            "last_error":   self._last_error,
            "reset_date":   self._reset_date.isoformat(),
            "reject_window_size": (
                self._rejecter.reject_delay_frames if self._rejecter is not None else 0
            ),
            "reject_window_marks": (
                [i for i, v in enumerate(self._rejecter.window_state) if v == 1]
                if self._rejecter is not None else []
            ),
            # 초기화 진행 상태
            "init_stage":   self._init_stage,
            "init_current": self._init_current,
            "init_total":   self._init_total,
        }

    # ──────────────────────────────────────────────────────────────────
    # 공개 메서드 (Public Methods)
    # ──────────────────────────────────────────────────────────────────

    def start(self):
        """
        백그라운드 스레드에서 검사 루프를 시작합니다.
        이 메서드는 즉시 반환됩니다 (non-blocking).
        status 는 즉시 "initializing" 으로 설정됩니다.
        """
        if self._status == STATUS_RUNNING:
            print(f"[Worker:{self.config.line_name}] Already running.")
            return
        if self._status == STATUS_INITIALIZING:
            print(f"[Worker:{self.config.line_name}] Already initializing.")
            return

        self._stop_event.clear()
        self._defect_count = 0
        self._total_count  = 0
        self._last_error   = ""
        self._reset_date   = date.today()
        self._init_stage   = ""
        self._init_current = 0
        self._init_total   = 0
        self._status = STATUS_INITIALIZING   # 즉시 "initializing" 설정

        self._thread = threading.Thread(
            target=self._run_loop,
            name=f"worker-{self.config.line_name}",
            daemon=True,
        )
        self._thread.start()

    def stop(self):
        """
        검사 루프 종료를 요청합니다.
        이 메서드는 즉시 반환됩니다 (non-blocking).
        루프가 완전히 끝나길 기다리려면 join() 을 추가로 호출하세요.
        """
        print(f"[Worker:{self.config.line_name}] 종료 요청 중...")
        self._stop_event.set()

    def join(self, timeout: float = 5.0):
        """
        백그라운드 스레드가 종료될 때까지 최대 timeout 초 대기합니다.

        Parameters
        ----------
        timeout : 최대 대기 시간 [초]. 기본 5초.
        """
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=timeout)

    def update_class_thresholds(self, class_thresholds: Optional[dict]) -> None:
        """
        검사 중 class threshold를 동적으로 변경합니다.
        save_thresholds가 있으면 effective_thresholds를 재계산하여 detector에 전달합니다.

        Parameters
        ----------
        class_thresholds : dict or None
            새로운 class threshold (e.g., {"defect": 0.75, "pinhole": 0.90})
            None 이면 threshold 초기화.
        """
        self.config.class_thresholds = class_thresholds
        self._original_class_thresholds = class_thresholds
        if self._detector is not None:
            # save_thresholds가 있으면 effective = min(class, save)
            effective = dict(class_thresholds or {})
            if self.config.save_thresholds:
                for cls, thr in self.config.save_thresholds.items():
                    if cls in effective:
                        effective[cls] = min(effective[cls], thr)
                    else:
                        effective[cls] = thr
            self._detector.set_class_thresholds(effective if effective else class_thresholds)

    # ──────────────────────────────────────────────────────────────────
    # 내부 메서드 (Internal Methods) — 외부에서 호출하지 마세요
    # ──────────────────────────────────────────────────────────────────

    # ──────────────────────────────────────────────────────────────────
    # 초기화 단계별 sub-methods (_run_loop 에서 단계별로 호출)
    # ──────────────────────────────────────────────────────────────────

    def _init_camera(self):
        """[Init Step] 카메라 인스턴스 생성 + 연결."""
        c = self.config
        if c.camera_type == "webcam":
            from webcam_camera import WebcamCamera          # noqa: PLC0415
            self._camera = WebcamCamera(
                camera_ip=c.camera_ip,
                rotation=c.rotation,
                crop_region=c.crop_region,
            )
        else:
            from camera import BaslerCamera                 # noqa: PLC0415
            self._camera = BaslerCamera(
                camera_ip=c.camera_ip,
                pfs_file=c.pfs_file,
                rotation=c.rotation,
                crop_region=c.crop_region,
            )
        self._camera.open()

        # Force trigger mode if configured (Basler only, 'auto' = use PFS setting)
        # Must stop grabbing first — TriggerMode cannot be changed while grabbing.
        force_trigger = getattr(c, 'collection_mode', 'auto') or 'auto'
        if force_trigger != 'auto' and c.camera_type == 'basler':
            try:
                from pypylon import pylon                    # noqa: PLC0415
                mode_val = "On" if force_trigger == 'trigger' else "Off"
                self._camera._cameras.StopGrabbing()
                self._camera._cam.TriggerMode.SetValue(mode_val)
                self._camera._cameras.StartGrabbing(pylon.GrabStrategy_LatestImageOnly)
                print(f"[Worker:{c.line_name}] TriggerMode forced → {mode_val}")
            except Exception as e:
                print(f"[Worker:{c.line_name}] Warning: could not force TriggerMode: {e}")

        # 트리거 모드 전용: 센서 인식 후 촬영 딜레이 [µs]
        trigger_delay = getattr(c, 'trigger_delay_us', None)
        if trigger_delay and force_trigger == 'trigger' and c.camera_type == 'basler':
            try:
                self._camera.set_trigger_delay(float(trigger_delay))
                print(f"[Worker:{c.line_name}] TriggerDelayAbs → {trigger_delay} µs")
            except Exception as e:
                print(f"[Worker:{c.line_name}] Warning: could not set trigger delay: {e}")

        # 트리거 노이즈 제거: LineDebouncerHighTime [µs]
        debounce_us = getattr(c, 'trigger_debounce_us', None)
        if debounce_us and force_trigger == 'trigger' and c.camera_type == 'basler':
            try:
                cam = self._camera._cam
                cam.LineSelector.SetValue("Line1")
                cam.LineDebouncerHighTimeAbs.SetValue(float(debounce_us))
                print(f"[Worker:{c.line_name}] LineDebouncerHighTime → {debounce_us} µs")
            except Exception as e:
                print(f"[Worker:{c.line_name}] Warning: could not set debounce: {e}")

    def _init_detector(self):
        """[Init Step] AI 디텍터 생성 (inspection 모드 전용)."""
        c = self.config
        from detector import create_detector                # noqa: PLC0415

        effective_thresholds = dict(c.class_thresholds or {})
        self._original_class_thresholds = c.class_thresholds
        if c.save_thresholds:
            for cls, thr in c.save_thresholds.items():
                if cls in effective_thresholds:
                    effective_thresholds[cls] = min(effective_thresholds[cls], thr)
                else:
                    effective_thresholds[cls] = thr

        self._detector = create_detector(
            detector_type=getattr(c, 'detector_type', 'yolo'),
            model_path=c.model_path,
            class_thresholds=effective_thresholds if effective_thresholds else c.class_thresholds,
            device=c.device,
            detector_config=getattr(c, 'detector_config', None),
        )

    def _measure_camera_fps(self, n_frames: int = 20) -> float:
        """카메라에서 n_frames를 촬영해 실제 FPS를 측정합니다.
        연속(continuous) 카메라 모드에서 reject_delay_seconds → frames 변환에 사용.
        트리거 모드에서는 호출하지 않습니다.
        """
        import time as _time
        grabbed = 0
        t0 = _time.time()
        for _ in range(n_frames):
            _, _, ok = self._camera.grab()
            if ok:
                grabbed += 1
        elapsed = _time.time() - t0
        if grabbed < 2 or elapsed < 0.01:
            return 30.0  # 측정 실패 시 기본값 30fps
        fps = grabbed / elapsed
        print(f"[Worker:{self.config.line_name}] FPS 측정: {fps:.1f} fps ({grabbed}/{n_frames} 프레임, {elapsed:.2f}s)")
        return fps

    def _init_support_modules(self):
        """[Init Step] 리젝터 + DataManager 생성."""
        c = self.config
        if self._camera is not None:
            from rejecter import Rejecter                   # noqa: PLC0415

            # reject_delay_seconds가 설정된 경우 연속 모드에서 FPS 측정 후 프레임 수로 변환
            delay_frames = c.reject_delay_frames
            reject_delay_sec = getattr(c, 'reject_delay_seconds', None)
            is_continuous = getattr(c, 'collection_mode', 'auto') in ('continuous', 'auto')
            if reject_delay_sec and reject_delay_sec > 0 and is_continuous:
                measured_fps = self._measure_camera_fps(n_frames=20)
                delay_frames = max(1, round(measured_fps * reject_delay_sec))
                print(f"[Worker:{c.line_name}] reject_delay_seconds={reject_delay_sec}s "
                      f"→ {delay_frames} frames (@ {measured_fps:.1f} fps)")

            self._rejecter = Rejecter(
                camera=self._camera,
                reject_delay_frames=delay_frames,
                reject_positions=c.reject_positions,
                reject_mode=getattr(c, 'reject_mode', 'individual'),
                time_valve_on=c.time_valve_on,
                pre_valve_delay=c.pre_valve_delay,
            )
        else:
            self._rejecter = None

        from datamanager import DataManager                 # noqa: PLC0415
        self._data_manager = DataManager(save_root=c.save_root)
        if c.retention_days > 0:
            self._data_manager.cleanup_old_data(c.retention_days)

    def _default_process(self, frame, cropped):
        """
        기본 처리 흐름: AI 감지 → 박스 그리기 → 리젝트 신호 → 저장.

        역할 분리:
          - class_thresholds → 리젝트 판정만
          - save_thresholds  → 이미지 저장만

        Returns
        -------
        (annotated, is_defect) : 박스가 그려진 이미지, 불량 여부
        """
        # ── AI 감지 ───────────────────────────────────────────────────
        if self._detector is not None:
            detections = self._detector.detect(cropped)

            # save_thresholds 사용 시: 원래 class_thresholds로 is_defect 재평가
            # (detector에는 낮은 effective_thresholds를 전달했으므로)
            orig_thr = getattr(self, '_original_class_thresholds', None)
            if orig_thr is not None and self.config.save_thresholds:
                for det in detections:
                    if det.label in orig_thr:
                        det.is_defect = det.confidence >= orig_thr[det.label]
                    else:
                        det.is_defect = False

            annotated = self._detector.draw(cropped, detections)
            is_defect = self._detector.has_defect(detections)
        else:
            detections = []
            annotated  = cropped
            is_defect  = False

        # ── 리젝트 신호 (class_thresholds 기준) ──────────────────────
        if self._rejecter is not None:
            self._rejecter.push(is_defect=is_defect)

        # ── 이미지 저장 (save_thresholds 기준) ───────────────────────
        # 저장 폴더명: active_product > project_name > line_name 순으로 폴백
        line = getattr(self.config, 'active_product', None) or getattr(self.config, 'project_name', None) or self.config.line_name
        saved_category = None
        saved_dets = None
        if self.config.save_thresholds:
            save_thr = self.config.save_thresholds
            save_dets = [
                d for d in detections
                if d.label in save_thr and d.confidence >= save_thr[d.label]
            ]
            if save_dets:
                if is_defect:
                    self._data_manager.save_defect(
                        image=cropped, annotated=annotated,
                        detections=detections, line_name=line,
                    )
                    saved_category = "defect"
                    saved_dets = detections
                else:
                    self._data_manager.save_borderline(
                        image=cropped, annotated=annotated,
                        detections=save_dets, line_name=line,
                    )
                    saved_category = "borderline"
        else:
            # save_thresholds 미설정: 불량이면 저장
            if is_defect:
                self._data_manager.save_defect(
                    image=cropped, annotated=annotated,
                    detections=detections, line_name=line,
                )
                saved_category = "defect"
                saved_dets = detections

        # ── 저장 후 콜백 (S3 업로드 등) ───────────────────────────────
        if saved_category is not None and self._on_save_callback is not None:
            try:
                self._on_save_callback(
                    category=saved_category,
                    save_root=self.config.save_root,
                    line_name=line,
                    detections=saved_dets or detections,
                )
            except Exception:
                pass  # 콜백 실패가 검사 루프를 중단하지 않도록

        return annotated, is_defect

    def _run_loop(self):
        """백그라운드 스레드: 단계별 초기화 → 검사 루프."""
        c = self.config

        # ── 초기화 단계 목록 구성 ────────────────────────────────────
        steps = []
        step_num = 1
        steps.append((step_num, "Camera", c.camera_type, self._init_camera))
        step_num += 1
        # inspection 모드만 지원
        det_type = getattr(c, 'detector_type', 'yolo')
        steps.append((step_num, "AI Model", det_type, self._init_detector))
        step_num += 1
        steps.append((step_num, "Rejecter / DataManager", "", self._init_support_modules))

        # 초기화 단계 수 동적 계산
        total = len(steps)
        self._init_total = total

        # ── 배너 출력 ───────────────────────────────────────────────
        banner_w = 47
        print(f"\n{'=' * banner_w}")
        print(f"  [{c.line_name}] Initialization")
        print(f"{'=' * banner_w}")

        try:
            # ── 단계별 초기화 (각 단계 최소 1초 유지) ─────────────────
            MIN_STEP_SEC = 1.0

            for num, label, detail, init_fn in steps:
                self._init_stage = label
                self._init_current = num
                tag = f"{label} ({detail})" if detail else label
                step_t0 = time.time()
                try:
                    init_fn()
                except Exception as e:
                    pad = max(2, 34 - len(f"[{num}/{total}] {tag}"))
                    print(f"  [{num}/{total}] {tag} {'.' * pad} FAIL")
                    raise RuntimeError(
                        f"Initialization failed at step [{num}/{total}] {tag}: {e}"
                    ) from e
                pad = max(2, 34 - len(f"[{num}/{total}] {tag}"))
                print(f"  [{num}/{total}] {tag} {'.' * pad} OK")
                # 최소 1초 대기 (프론트엔드에서 단계별 진행이 보이도록)
                remaining = MIN_STEP_SEC - (time.time() - step_t0)
                if remaining > 0:
                    time.sleep(remaining)

            # ── 최종 단계: Streaming started ─────────────────────────
            # STATUS_INITIALIZING 유지 → 프론트엔드가 이 단계를 볼 수 있도록
            self._init_stage = "Streaming"
            self._init_current = total
            print(f"  [{total}/{total}] Streaming started")
            print(f"{'=' * banner_w}\n")
            time.sleep(MIN_STEP_SEC * 2)
            # 최소 대기 후 RUNNING 전환
            self._init_stage = ""
            self._init_current = 0
            self._status = STATUS_RUNNING

            # ── 검사 루프 ────────────────────────────────────────────
            while not self._stop_event.is_set():
                loop_start = time.time()

                # 일별 통계 카운터 리셋 (자정 경과 시)
                today = date.today()
                if today != self._reset_date:
                    print(f"[Worker:{c.line_name}] Daily stats reset "
                          f"({self._reset_date} -> {today}, "
                          f"total={self._total_count}, defect={self._defect_count})")
                    self._total_count = 0
                    self._defect_count = 0
                    self._reset_date = today

                frame, cropped, triggered = self._camera.grab()
                if not triggered or frame is None:
                    continue

                if self._process_fn is not None:
                    annotated, is_defect = self._process_fn(
                        frame, cropped,
                        detector=self._detector,
                        rejecter=self._rejecter,
                        data_manager=self._data_manager,
                        config=self.config,
                    )
                else:
                    annotated, is_defect = self._default_process(frame, cropped)

                self._total_count += 1
                if is_defect:
                    self._defect_count += 1

                elapsed = time.time() - loop_start
                inst_fps = 1.0 / max(elapsed, 1e-6)
                # 지수 이동 평균 (EMA): alpha=0.1로 부드러운 FPS 계산
                alpha = 0.1
                self._fps = alpha * inst_fps + (1 - alpha) * self._fps

                self._push_frame(annotated, is_defect)

        except Exception as e:
            self._last_error = str(e)
            self._status = STATUS_ERROR
            # 초기화 도중 실패했으면 배너 닫기
            if self._init_current < total:
                print(f"{'=' * banner_w}")
            print(f"\n  [{c.line_name}] ERROR: {e}\n")
        finally:
            self._init_stage = ""
            self._init_current = 0
            self._cleanup()

    def _push_frame(self, image, is_defect: bool):
        """
        annotated 이미지를 JPEG bytes 로 인코딩하고, window meta 와 함께
        (jpeg_bytes, meta_dict) 튜플로 frame_queue 에 넣습니다.
        큐가 꽉 찼으면 오래진 프레임을 버리고 최신 프레임을 유지합니다.

        최적화:
        - 스트리밍용 해상도 축소 (너비 640px 이하)
        - JPEG 품질 50 (서버 대역폭 65% 이상 감소)
        """
        # 스트리밍용 해상도 축소 (너비 640px 이상이면 리사이징)
        h, w = image.shape[:2]
        if w > 640:
            scale = 640 / w
            new_w = 640
            new_h = int(h * scale)
            image = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_LINEAR)

        # JPEG 인코딩 (품질 50 → 대역폭 65% 감소, 시각적 품질은 충분)
        ok, buf = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 50])
        if not ok:
            return
        jpeg_bytes = buf.tobytes()

        # 리젝트 슬라이딩 윈도우 메타 (프레임과 동기화)
        if self._rejecter is not None:
            window = self._rejecter.window_state
            meta = {
                "reject_window_size":  self._rejecter.reject_delay_frames,
                "reject_window_marks": [i for i, v in enumerate(window) if v == 1],
            }
        else:
            meta = {"reject_window_size": 0, "reject_window_marks": []}

        item = (jpeg_bytes, meta)

        # 큐가 꽉 찼으면 오래된 프레임 버리기
        try:
            self.frame_queue.put_nowait(item)
        except Full:
            try:
                self.frame_queue.get_nowait()   # 오래된 것 제거
                self.frame_queue.put_nowait(item)
            except Exception:
                pass

    def manual_reject(self):
        """수동 리젝트 테스트: 다음 push 시 리젝트 신호 1회 발생."""
        if self._rejecter is not None:
            self._rejecter.push(is_defect=True)

    def _cleanup(self):
        """루프 종료 후 자원 해제."""
        if self._status != STATUS_ERROR:
            self._status = STATUS_STOPPED
        self._init_stage = ""
        self._init_current = 0
        if self._rejecter is not None:
            self._rejecter.reset()
        if self._camera is not None:
            self._camera.close()
        print(f"[Worker:{self.config.line_name}] Worker stopped.")
