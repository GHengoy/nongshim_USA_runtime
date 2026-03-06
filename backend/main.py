"""
backend/main.py — Ansung Vision Inspection FastAPI 서버
=======================================================

[실행 방법]
    cd /Users/nongshim/Desktop/Ansung_code
    uv run uvicorn backend.main:app --reload --port 8000

[현재 구현된 API]
    GET  /api/lines              — 등록된 검사 라인 목록
    POST /api/lines              — 새 라인 추가 (InspectionConfig JSON)
    GET  /api/lines/{name}       — 특정 라인 조회
    PUT  /api/lines/{name}       — 라인 설정 수정
    DELETE /api/lines/{name}     — 라인 삭제
    POST /api/lines/{name}/start — 워커 시작
    POST /api/lines/{name}/stop  — 워커 정지
    GET  /api/lines/{name}/stats — 실시간 통계
    WS   /ws/{name}              — MJPEG 프레임 스트리밍 (WebSocket)

    GET  /api/collection/lines   — 수집 가능한 라인 목록
    POST /api/collection/start   — 수집 세션 시작
    POST /api/collection/stop    — 수집 세션 종료
    POST /api/collection/save    — 저장 상태 토글 (스페이스바)
    GET  /api/collection/status  — 수집 세션 상태
    WS   /ws/collection/{name}   — 수집 라이브 프리뷰

[설계 원칙]
    API 레이어는 cv2 / numpy 에 의존하지 않습니다.
    inspection_framework 모듈은 워커 시작 시점에만 lazy import 합니다.
    덕분에 카메라 드라이버 없는 환경(개발 PC)에서도 서버가 정상 기동됩니다.

[설정 파일]
    workers/{폴더명}/config.json 에 워커별 설정이 저장됩니다.
    새 라인 추가 시 workers/{sanitized-name}/ 폴더가 자동 생성됩니다.
    로컬 독립 실행: workers/{폴더명}/run_local.py
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import logging
import os
import re
import secrets
import sys
import threading
import time

# PaddlePaddle 플래그: paddle이 import되기 전 가장 먼저 설정해야 효과가 있음
os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')
os.environ.setdefault('FLAGS_use_mkldnn', '0')      # oneDNN 비활성 (PIR 미구현 연산 회피)
os.environ.setdefault('FLAGS_enable_pir_api', '0')  # 새 PIR 실행기 비활성
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from queue import Empty

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from backend.collection import CollectionSession
from backend.history_db import HistoryDB
from backend.storage import S3SyncWorker

# uvicorn 액세스 로그 비활성화 (INFO: 127.0.0.1 - "GET /api/lines ..." 제거)
logging.getLogger("uvicorn.access").setLevel(logging.WARNING)

# ── 경로 ────────────────────────────────────────────────────────────────────
_FRAMEWORK_PATH = os.path.join(os.path.dirname(__file__), '..', 'inspection_framework')
_WORKERS_DIR = os.path.join(os.path.dirname(__file__), '..', 'workers')
_CONFIGS_DIR = os.path.join(os.path.dirname(__file__), '..', 'configs')
_SETTINGS_PATH = os.path.join(_CONFIGS_DIR, 'global_settings.json')

# ── S3 동기화 싱글톤 ─────────────────────────────────────────────────────────
_s3_sync: Optional[S3SyncWorker] = None

# ── 제품별 설정 필드 ─────────────────────────────────────────────────────────
# 라인 레벨(하드웨어): line_name, enabled, camera_type, camera_ip, pfs_file
# 제품 레벨(검사 설정): 아래 목록 — 제품마다 개별 값을 가짐
PRODUCT_FIELDS = [
    'mode', 'rotation', 'crop_region', 'model_path', 'class_thresholds',
    'save_thresholds', 'device', 'reject_delay_frames', 'reject_positions',
    'time_valve_on', 'pre_valve_delay', 'save_root', 'retention_days',
    'max_preview', 'save_normal', 'detector_type', 'detector_config',
]


def _expand_product_fields(config: dict):
    """활성 제품의 필드를 flat top-level에 복사합니다 (API 응답용 인메모리 확장).
    config.json에는 flat product 필드가 저장되지 않으므로,
    디스크에서 읽은 뒤 이 함수로 인메모리 dict에 flat 필드를 채웁니다.
    """
    active = config.get("active_product")
    products = config.get("products")
    if not active or not products or active not in products:
        return
    for field in PRODUCT_FIELDS:
        if field in products[active]:
            config[field] = products[active][field]


def _migrate_config(config: dict):
    """구버전 호환:
    products dict가 없으면 flat 필드로 'Default' 제품을 생성합니다.
    (reject_pulse_count 마이그레이션은 config.py의 from_dict()에서 처리)
    """
    if config.get("products"):
        config.setdefault("active_product", next(iter(config["products"]), "Default"))
        return

    product_data = {}
    for field in PRODUCT_FIELDS:
        if field in config:
            product_data[field] = config[field]
    if product_data:
        config["products"] = {"Default": product_data}
        config["active_product"] = "Default"


# ── Pydantic 스키마 ──────────────────────────────────────────────────────────

class LineConfig(BaseModel):
    line_name: str
    project_name: str = ""            # 화면 표시명 + 저장 폴더명 (자유 변경)
    enabled: bool = True              # True: 대시보드 표시 + 실행 가능 / False: 비활성화
    camera_type: str = "basler"       # basler | webcam
    mode: str = 'inspection'          # inspection | collection
    camera_ip: str = "192.168.1.10"   # Basler: IP 주소 / Webcam: 인덱스("0","1",...)
    pfs_file: str = "camera.pfs"
    collection_mode: str = "auto"             # auto | trigger | continuous (검사·수집 공용)
    rotation: str = "NONE"           # NONE | CLOCKWISE_90 | COUNTERCLOCKWISE_90 | 180
    crop_region: Optional[list] = None
    model_path: str = "./weights/best.pt"
    class_thresholds: Optional[Dict[str, float]] = None
    save_thresholds: Optional[Dict[str, float]] = None
    device: str = "cuda"
    reject_delay_frames: int = 10
    reject_positions: int = 1
    time_valve_on: float = 0.1           # 밸브 열림 지속 시간 (초)
    reject_pulse_count: Optional[int] = None  # deprecated: 마이그레이션용, time_valve_on으로 대체
    pre_valve_delay: float = 0.25
    save_root: str = "./data"
    retention_days: int = 180
    max_preview: int = 50
    save_normal: bool = False
    detector_type: str = "yolo"              # yolo | paddleocr | cnn | ...
    detector_config: Optional[dict] = None   # detector-specific extra settings
    active_product: Optional[str] = None
    products: Optional[Dict[str, dict]] = None


# ── 인메모리 저장소 ──────────────────────────────────────────────────────────
# config: LineConfig dict, worker: InspectionWorker | None, folder: str
_registry: Dict[str, Dict[str, Any]] = {}
# 데이터 수집 세션 (검사 워커와 별도 관리)
_collection_sessions: Dict[str, CollectionSession] = {}
# 히스토리 메타데이터 인덱서 (서버 startup 시 초기화)
_history_db: Optional[HistoryDB] = None


# ── 글로벌 설정 (S3 등) ───────────────────────────────────────────────────────

_DEFAULT_STORAGE = {
    "local_retention_days": 180,
    "storage_type": "local",
    "s3_bucket": "",
    "s3_region": "us-east-1",
    "s3_access_key": "",
    "s3_secret_key": "",
    "s3_prefix": "",
    "s3_retention_days": 365,
    "s3_cleanup_interval_hours": 6,
}

_DEFAULT_ADMIN = {
    "password": "1234",
}


# ── 비밀번호 검증 함수 ────────────────────────────────────────────────────────────
def _verify_password(plain: str, stored: str) -> bool:
    """저장된 평문 비밀번호와 입력 비밀번호를 비교합니다."""
    return secrets.compare_digest(plain, stored)


def _load_global_settings() -> dict:
    """configs/global_settings.json 에서 글로벌 설정을 읽어옵니다."""
    if not os.path.isfile(_SETTINGS_PATH):
        return {"storage": dict(_DEFAULT_STORAGE), "admin": dict(_DEFAULT_ADMIN)}
    try:
        with open(_SETTINGS_PATH, 'r', encoding='utf-8') as f:
            data = json.load(f)
        storage = data.get("storage", {})
        merged_storage = {**_DEFAULT_STORAGE, **storage}
        admin = data.get("admin", {})
        merged_admin = {**_DEFAULT_ADMIN, **admin}
        return {"storage": merged_storage, "admin": merged_admin}
    except Exception:
        return {"storage": dict(_DEFAULT_STORAGE), "admin": dict(_DEFAULT_ADMIN)}


def _save_global_settings(settings: dict):
    """글로벌 설정을 configs/global_settings.json 에 atomic write 합니다."""
    os.makedirs(os.path.dirname(_SETTINGS_PATH), exist_ok=True)
    tmp_path = _SETTINGS_PATH + '.tmp'
    try:
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, _SETTINGS_PATH)
    except Exception as e:
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        raise e


def _mask_secret(key: str) -> str:
    """시크릿 키를 마스킹합니다 — 마지막 4자만 표시."""
    if not key or len(key) <= 4:
        return "****"
    return "****" + key[-4:]


def _start_s3_sync(storage: dict):
    """S3SyncWorker 싱글톤을 시작합니다."""
    global _s3_sync
    if _s3_sync is not None:
        _stop_s3_sync()
    bucket = storage.get("s3_bucket", "")
    if not bucket:
        return
    _s3_sync = S3SyncWorker(
        bucket=bucket,
        region=storage.get("s3_region", "us-east-1"),
        prefix=storage.get("s3_prefix", ""),
        access_key=storage.get("s3_access_key", ""),
        secret_key=storage.get("s3_secret_key", ""),
    )
    _s3_sync.start()
    print(f"[S3] Sync worker started (bucket: {bucket})")


def _stop_s3_sync():
    """S3SyncWorker 싱글톤을 정지합니다."""
    global _s3_sync
    if _s3_sync is not None:
        _s3_sync.stop()
        _s3_sync = None
        print("[S3] Sync worker stopped")


def _save_callback_dispatcher(category, save_root, line_name, detections=None, **kw):
    """모든 워커에 주입되는 콜백 래퍼. S3 활성 시 enqueue를 호출합니다."""
    if _s3_sync is not None:
        _s3_sync.enqueue(
            category=category, save_root=save_root,
            line_name=line_name, detections=detections, **kw,
        )


# ── 헬퍼: 빈 워커 슬롯 탐색 ────────────────────────────────────────────────

def _next_worker_slot() -> Optional[str]:
    """workers/worker-01 ~ worker-10 중 config.json이 없는 첫 번째 빈 슬롯명을 반환합니다.
    최대 슬롯(10)을 초과하면 None을 반환합니다.
    """
    for i in range(1, 11):
        folder_name = f"worker-{i:02d}"
        config_path = os.path.join(_WORKERS_DIR, folder_name, 'config.json')
        if not os.path.exists(config_path):
            return folder_name
    return None


# ── workers/ 폴더 영속성 ──────────────────────────────────────────────────────

def _load_registry():
    """서버 시작 시 workers/*/config.json 을 스캔해 라인 설정을 불러옵니다."""
    if not os.path.isdir(_WORKERS_DIR):
        return
    loaded = 0
    for folder_name in sorted(os.listdir(_WORKERS_DIR)):
        folder_path = os.path.join(_WORKERS_DIR, folder_name)
        if not os.path.isdir(folder_path):
            continue
        config_path = os.path.join(folder_path, 'config.json')
        if not os.path.isfile(config_path):
            continue
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
            # 구버전 호환: 신규 필드 기본값 채우기
            config.setdefault('camera_type', 'basler')
            config.setdefault('mode', 'inspection')
            config.setdefault('enabled', True)
            config.setdefault('reject_positions', 1)
            config.setdefault('reject_mode', 'individual')
            config.setdefault('reject_delay_seconds', None)
            config.setdefault('trigger_delay_us', None)
            config.setdefault('save_thresholds', None)
            config.setdefault('detector_type', 'yolo')
            config.setdefault('show_threshold', 0.3)
            config.setdefault('data_yaml', './weights/data.yaml')
            _migrate_config(config)
            _expand_product_fields(config)
            # line_name이 없으면 폴더 이름으로 초기화 (내부 ID, 변경 불가)
            config.setdefault('line_name', folder_name)
            # project_name 없으면 line_name으로 초기화 (화면 표시명, 자유 변경)
            config.setdefault('project_name', config.get('line_name', folder_name))
            name = folder_name
            _registry[name] = {
                'config': config,
                'worker': None,
                'folder': folder_path,
            }
            loaded += 1
        except Exception as e:
            print(f'[Config] {config_path} 불러오기 실패: {e}')
    print(f'[Config] {loaded}개 워커 불러오기 완료 (workers/ 폴더)')


def _save_line(name: str):
    """특정 라인의 설정을 해당 워커 폴더의 config.json 에 저장합니다."""
    entry = _registry.get(name)
    if entry is None:
        return
    folder = entry.get('folder')
    if not folder:
        print(f'[Config] {name} 저장 실패: 폴더 경로 없음')
        return
    os.makedirs(folder, exist_ok=True)
    config = entry['config']
    # products가 있으면 flat product 필드를 제거한 깨끗한 복사본 저장
    if config.get('products') and config.get('active_product'):
        save_data = {k: v for k, v in config.items() if k not in PRODUCT_FIELDS}
    else:
        save_data = config
    config_path = os.path.join(folder, 'config.json')
    tmp_path = config_path + '.tmp'
    try:
        with open(tmp_path, 'w', encoding='utf-8') as f:
            json.dump(save_data, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, config_path)  # atomic write
    except Exception as e:
        # 임시 파일 정리
        if os.path.exists(tmp_path):
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        print(f'[Config] {name} 저장 실패: {e}')


def _create_run_local_script(folder_path: str, line_name: str, folder_name: str):
    """워커 폴더에 run_local.py 독립 실행 스크립트를 생성합니다. 이미 있으면 덮어쓰지 않습니다."""
    script_path = os.path.join(folder_path, 'run_local.py')
    if os.path.exists(script_path):
        return
    # Compute project root dynamically
    project_root = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    script = f'''\
"""
{folder_name.upper()} — Local Standalone Runner
=====================================
Standalone runner for {folder_name}.
Edit config.json in this folder to configure, then run directly without the FastAPI server.

Usage:
    cd {project_root}
    uv run python workers/{folder_name}/run_local.py

Press 'q' to quit.

---
[Custom logic for this worker goes below]
You can add pre-processing hooks, post-processing callbacks, or
any worker-specific logic here without affecting other workers.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'inspection_framework'))

from config import InspectionConfig
from inspection_runtime import run_local

# ── Load config ──────────────────────────────────────────────────────────────
config_path = os.path.join(os.path.dirname(__file__), 'config.json')
config = InspectionConfig.from_json(config_path)

# ── [Optional] Custom defect callback ────────────────────────────────────────
# Uncomment and implement to add worker-specific behavior on defect detection.
# def on_defect(detections):
#     """Called each time a defect is detected."""
#     pass

# ── Run ──────────────────────────────────────────────────────────────────────
run_local(config)
'''
    try:
        with open(script_path, 'w', encoding='utf-8') as f:
            f.write(script)
    except Exception as e:
        print(f'[Config] run_local.py 생성 실패: {e}')


# 서버 시작 시 파일에서 로드
_load_registry()


# ── 헬퍼 ────────────────────────────────────────────────────────────────────

def _get_entry(name: str) -> Dict[str, Any]:
    # 폴더 이름으로만 조회 (line_name = folder_name으로 통일됨)
    if name in _registry:
        return _registry[name]
    raise HTTPException(status_code=404, detail=f"라인 '{name}'을 찾을 수 없습니다.")


def _make_worker(config_dict: dict, folder: str = None):
    """워커 폴더의 run_local.py에 get_worker()가 있으면 그것을 사용하고,
    없으면 기본 InspectionWorker를 생성합니다.
    `enabled` 는 관리 전용 필드이므로 InspectionConfig 에 전달하지 않습니다.
    """
    if _FRAMEWORK_PATH not in sys.path:
        sys.path.insert(0, _FRAMEWORK_PATH)
    from config import InspectionConfig          # noqa: PLC0415
    from inspection_worker import InspectionWorker  # noqa: PLC0415
    d = {k: v for k, v in config_dict.items() if k != 'enabled'}
    # 상대 경로 → 워커 폴더 기준 절대 경로로 변환
    if folder:
        def _abs(p):
            return os.path.join(folder, p) if p and not os.path.isabs(p) else p
        d['pfs_file'] = _abs(d.get('pfs_file', ''))
        for prod in d.get('products', {}).values():
            prod['model_path'] = _abs(prod.get('model_path', ''))
            prod['save_root']   = _abs(prod.get('save_root', ''))
    cfg = InspectionConfig.from_dict(d)

    if folder:
        run_local_path = os.path.join(folder, 'run_local.py')
        if os.path.exists(run_local_path):
            try:
                spec = importlib.util.spec_from_file_location("run_local", run_local_path)
                mod = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(mod)
                if hasattr(mod, 'get_worker'):
                    print(f'[Worker] {os.path.basename(folder)}/run_local.py 커스텀 훅 로드 완료')
                    worker = mod.get_worker(cfg)
                    worker._on_save_callback = _save_callback_dispatcher
                    return worker
            except Exception as e:
                import traceback as _tb
                print(f'[Worker] run_local.py 로드 실패, 기본 워커 사용:')
                _tb.print_exc()

    return InspectionWorker(cfg, on_save_callback=_save_callback_dispatcher)


def _worker_stats(name: str) -> dict:
    entry = _registry[name]
    config = entry.get("config", {})
    w = entry.get("worker")
    folder = entry.get("folder")
    # worker 폴더명 추출 (예: /path/to/workers/worker-03 → worker-03)
    worker_folder = os.path.basename(folder) if folder else ""

    if w is None:
        return {
            "line_name": name,
            "project_name": config.get("project_name", name),
            "worker_folder": worker_folder,
            "status": "stopped",
            "fps": 0.0,
            "total_count": 0,
            "defect_count": 0,
            "defect_rate": "0.00%",
            "last_error": "",
            "init_stage": "",
            "init_current": 0,
            "init_total": 0,
        }
    stats = w.stats.copy()
    stats["worker_folder"] = worker_folder
    stats["project_name"] = config.get("project_name", name)
    return stats


# ── FastAPI 앱 ───────────────────────────────────────────────────────────────

app = FastAPI(title="Ansung Vision Inspection API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://localhost:3000",
        "http://127.0.0.1:5173",
        "*",  # 개발: 모든 origin 허용 (외부 IP 지원)
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── 라인 관리 API ────────────────────────────────────────────────────────────

@app.get("/api/lines")
def list_lines():
    # 인메모리 캐시 사용 — 매번 디스크 재읽기를 하지 않아 3초 폴링에도 안정적
    # 외부에서 config.json을 직접 수정한 경우 POST /api/lines/reload 호출 필요
    return [
        {"config": entry["config"], "stats": _worker_stats(name)}
        for name, entry in _registry.items()
    ]


@app.post("/api/lines/reload")
def reload_lines():
    """디스크에서 config.json을 다시 읽어 인메모리 설정을 갱신합니다.
    외부에서 config.json을 직접 수정한 경우 이 엔드포인트를 호출하세요.
    """
    reloaded = 0
    for name, entry in _registry.items():
        folder = entry.get('folder')
        if not folder:
            continue
        config_path = os.path.join(folder, 'config.json')
        if not os.path.isfile(config_path):
            continue
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                disk_cfg = json.load(f)
            disk_cfg.setdefault('camera_type', 'basler')
            disk_cfg.setdefault('mode', 'inspection')
            disk_cfg.setdefault('enabled', True)
            disk_cfg.setdefault('reject_positions', 1)
            disk_cfg.setdefault('reject_mode', 'individual')
            disk_cfg.setdefault('reject_delay_seconds', None)
            disk_cfg.setdefault('trigger_delay_us', None)
            disk_cfg.setdefault('detector_type', 'yolo')
            disk_cfg.setdefault('show_threshold', 0.3)
            disk_cfg.setdefault('data_yaml', './weights/data.yaml')
            _migrate_config(disk_cfg)
            _expand_product_fields(disk_cfg)
            entry['config'] = disk_cfg
            reloaded += 1
        except Exception:
            pass
    return {"reloaded": reloaded}


@app.post("/api/lines", status_code=201)
def add_line(body: LineConfig):
    # 빈 워커 슬롯 확보
    folder_name = _next_worker_slot()
    if folder_name is None:
        raise HTTPException(status_code=507, detail="워커 슬롯이 가득 찼습니다 (최대 8개). 기존 라인을 삭제한 후 추가하세요.")
    folder_path = os.path.join(_WORKERS_DIR, folder_name)
    os.makedirs(folder_path, exist_ok=True)
    config = body.model_dump()
    _migrate_config(config)
    _expand_product_fields(config)
    # line_name을 항상 폴더명(worker-01 형식)으로 강제 동기화
    config["line_name"] = folder_name
    # project_name이 비어있으면 사용자가 입력한 body.line_name을 project_name에 보존
    if not config.get("project_name"):
        config["project_name"] = body.line_name
    # _registry 키는 항상 folder_name으로 통일
    _registry[folder_name] = {
        "config": config,
        "worker": None,
        "folder": folder_path,
    }
    _save_line(folder_name)
    _create_run_local_script(folder_path, folder_name, folder_name)
    return {"message": f"라인 등록 완료.", "folder": folder_name, "line_name": folder_name}


@app.get("/api/lines/{name}")
def get_line(name: str):
    entry = _get_entry(name)
    return {"config": entry["config"], "stats": _worker_stats(name)}


@app.put("/api/lines/{name}")
def update_line(name: str, body: LineConfig):
    entry = _get_entry(name)
    w = entry.get("worker")
    was_running = w is not None and w.status in ("running", "initializing")
    # 실행 중이면 자동 정지 후 새 설정으로 재시작
    if was_running:
        w.stop()
        w.join(timeout=5.0)
        entry["worker"] = None
    new_config = body.model_dump()
    # line_name은 항상 폴더명(= name)으로 고정 — 사용자가 바꿔도 무시
    new_config["line_name"] = name
    # products가 없으면 구버전 호환 마이그레이션
    if not (new_config.get("products") and new_config.get("active_product")):
        _migrate_config(new_config)
    # 활성 제품 필드를 flat에 확장 (API 응답 / 워커용)
    _expand_product_fields(new_config)
    entry["config"] = new_config
    _save_line(name)
    if was_running:
        try:
            new_w = _make_worker(entry["config"], folder=entry.get("folder"))
            new_w.start()
            entry["worker"] = new_w
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"워커 재시작 실패: {e}")
    return {"message": f"라인 '{name}' 설정 업데이트 완료."}


@app.delete("/api/lines/{name}")
def delete_line(name: str):
    entry = _get_entry(name)
    # 수집 세션이 활성 중이면 먼저 종료
    if name in _collection_sessions and _collection_sessions[name].status == "running":
        _collection_sessions[name].stop()
        _collection_sessions[name].join(timeout=3.0)
        del _collection_sessions[name]
    w = entry.get("worker")
    if w and w.status in ("running", "initializing"):
        w.stop()
        w.join(timeout=3.0)
    folder = entry.get('folder')
    del _registry[name]
    # config.json 삭제 (폴더와 run_local.py는 유지)
    if folder:
        config_path = os.path.join(folder, 'config.json')
        if os.path.exists(config_path):
            os.remove(config_path)
    return {"message": f"라인 '{name}' 삭제 완료."}


@app.post("/api/lines/{name}/start")
def start_line(name: str):
    entry = _get_entry(name)
    # 수집 세션이 활성 중이면 시작 거부
    if name in _collection_sessions and _collection_sessions[name].status == "running":
        raise HTTPException(409, "Collection session is active on this line. Stop it first.")
    w = entry.get("worker")
    if w and w.status in ("running", "initializing"):
        return {"status": w.status}
    # 이전 워커 정리 (error / stopped 상태 — 스레드 join 후 참조 해제)
    if w is not None:
        w.stop()
        w.join(timeout=3.0)
        entry["worker"] = None
    try:
        w = _make_worker(entry["config"], folder=entry.get("folder"))
        w.start()
        entry["worker"] = w
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"워커 시작 실패: {e}")
    return {"status": w.status}


@app.post("/api/lines/{name}/stop")
def stop_line(name: str):
    entry = _get_entry(name)
    w = entry.get("worker")
    if w:
        w.stop()
        w.join(timeout=5.0)
        entry["worker"] = None
    return {"status": "stopped"}


@app.post("/api/lines/start-all")
def start_all_lines():
    """활성화(enabled=True)된 모든 라인을 일괄 시작합니다."""
    results = []
    for name, entry in _registry.items():
        if not entry["config"].get("enabled", True):
            continue
        w = entry.get("worker")
        if w and w.status in ("running", "initializing"):
            results.append({"name": name, "status": "already_running"})
            continue
        try:
            w = _make_worker(entry["config"], folder=entry.get("folder"))
            w.start()
            entry["worker"] = w
            results.append({"name": name, "status": "started"})
        except Exception as e:
            results.append({"name": name, "status": "error", "detail": str(e)})
    return {"results": results}


@app.post("/api/lines/stop-all")
def stop_all_lines():
    """실행 중인 모든 라인을 일괄 정지합니다."""
    results = []
    for name, entry in _registry.items():
        w = entry.get("worker")
        if w and w.status in ("running", "initializing"):
            w.stop()
            results.append({"name": name, "status": "stopping"})
    return {"results": results}


@app.post("/api/lines/{name}/enable")
def enable_line(name: str):
    """라인을 활성화합니다. 대시보드에 표시되고 Start/Stop 가능 상태가 됩니다."""
    entry = _get_entry(name)
    entry["config"]["enabled"] = True
    _save_line(name)
    return {"enabled": True}


@app.post("/api/lines/{name}/disable")
def disable_line(name: str):
    """라인을 비활성화합니다. enabled 필드만 False로 설정하고 라인 데이터는 유지합니다."""
    entry = _get_entry(name)
    # 실행 중이면 자동 정지
    w = entry.get("worker")
    if w and w.status in ("running", "initializing"):
        w.stop()
        w.join(timeout=5.0)
    # enabled 필드만 False로 설정
    entry["config"]["enabled"] = False
    _save_line(name)
    return {"enabled": False}


@app.post("/api/lines/{name}/reset")
def reset_line(name: str):
    """라인의 설정과 통계를 초기화합니다. (표준 템플릿으로 덮어씀)"""
    entry = _get_entry(name)
    # 실행 중이면 자동 정지
    w = entry.get("worker")
    if w and w.status in ("running", "initializing"):
        w.stop()
        w.join(timeout=5.0)

    # 설정값 초기화: configs/default_config.json 템플릿 로드 후 line_name 보존
    default_config_path = os.path.join(_CONFIGS_DIR, 'default_config.json')
    if os.path.isfile(default_config_path):
        try:
            with open(default_config_path, 'r', encoding='utf-8') as f:
                config = json.load(f)
            # line_name은 원래 값 보존
            config['line_name'] = name
            # 기본값 채우기 (구버전 호환)
            config.setdefault('camera_type', 'basler')
            config.setdefault('mode', 'inspection')
            config.setdefault('enabled', True)
            config.setdefault('reject_positions', 1)
            config.setdefault('reject_mode', 'individual')
            config.setdefault('reject_delay_seconds', None)
            config.setdefault('trigger_delay_us', None)
            config.setdefault('save_thresholds', None)
            config.setdefault('detector_type', 'yolo')
            config.setdefault('show_threshold', 0.3)
            config.setdefault('data_yaml', './weights/data.yaml')
            _migrate_config(config)
            _expand_product_fields(config)
            entry["config"] = config
            # 템플릿도 worker 폴더에 덮어쓰기
            _save_line(name)
        except Exception as e:
            return {"error": f"템플릿 로드 실패: {e}"}

    # 통계 초기화 (worker stats 초기화)
    entry["stats"] = {
        "line_name": name,
        "status": "stopped",
        "fps": 0,
        "total_count": 0,
        "defect_count": 0,
        "defect_rate": "0.00%",
        "last_error": "",
    }
    return {"message": f"라인 '{name}' 초기화 완료. (표준 템플릿으로 리셋됨)", "stats": entry["stats"]}


@app.get("/api/lines/{name}/stats")
def get_stats(name: str):
    _get_entry(name)
    return _worker_stats(name)


@app.get("/api/lines/{name}/capture-frame")
def capture_frame(name: str):
    """실행 중인 워커에서 프레임 한 장을 캡처하여 JPEG로 반환합니다."""
    entry = _get_entry(name)
    w = entry.get("worker")
    if not w or w.status != "running":
        raise HTTPException(409, "Worker is not running")
    try:
        item = w.frame_queue.get(timeout=2.0)
    except Empty:
        raise HTTPException(504, "No frame available (timeout)")
    jpeg = item[0] if isinstance(item, tuple) else item
    return StreamingResponse(
        iter([jpeg]),
        media_type="image/jpeg",
        headers={"Cache-Control": "no-cache"},
    )


@app.patch("/api/lines/{name}/thresholds")
def update_thresholds(name: str, body: dict):
    """실행 중 워커의 class_thresholds를 재시작 없이 업데이트합니다."""
    entry = _get_entry(name)
    product_name = body.get("product")
    new_thresholds = body.get("class_thresholds")
    if not product_name or new_thresholds is None:
        raise HTTPException(400, "Missing 'product' or 'class_thresholds'")
    config = entry["config"]
    products = config.get("products", {})
    if product_name not in products:
        raise HTTPException(404, f"Product '{product_name}' not found")
    # config 업데이트
    products[product_name]["class_thresholds"] = new_thresholds
    if config.get("active_product") == product_name:
        config["class_thresholds"] = new_thresholds
    _save_line(name)
    # 실행 중이면 detector에 즉시 반영 (재시작 없음)
    w = entry.get("worker")
    if w and w.status == "running" and config.get("active_product") == product_name:
        w.update_class_thresholds(new_thresholds)
    return {"status": "ok"}


@app.post("/api/lines/{name}/manual-reject")
def manual_reject(name: str):
    """수동 리젝트 테스트: 리젝트 신호를 1회 발생시킵니다."""
    entry = _get_entry(name)
    w = entry.get("worker")
    if not w or w.status != "running":
        raise HTTPException(409, "Worker is not running")
    w.manual_reject()
    return {"status": "ok"}


@app.post("/api/lines/{name}/product")
def switch_product(name: str, body: dict):
    """활성 제품을 전환합니다. 실행 중이면 자동 재시작합니다."""
    product_name = body.get("product")
    if not product_name:
        raise HTTPException(400, "Missing 'product' field")

    entry = _get_entry(name)
    config = entry["config"]
    products = config.get("products", {})

    if product_name not in products:
        raise HTTPException(404, f"Product '{product_name}' not found")

    if config.get("active_product") == product_name:
        return {"active_product": product_name, "message": "Already active"}

    # 1. 활성 제품 변경
    config["active_product"] = product_name
    # 2. 새 제품 필드를 flat에 확장
    _expand_product_fields(config)
    # 3. 디스크 저장 (flat 필드는 strip됨)
    _save_line(name)

    # 4. 실행 중이면 자동 재시작
    w = entry.get("worker")
    if w and w.status in ("running", "initializing"):
        w.stop()
        w.join(timeout=5)
        try:
            new_w = _make_worker(config, folder=entry.get("folder"))
            new_w.start()
            entry["worker"] = new_w
        except Exception as e:
            entry["worker"] = None
            raise HTTPException(500, f"Worker restart failed after product switch: {e}")

    return {"active_product": product_name}


# ── WebSocket 스트리밍 ────────────────────────────────────────────────────────

@app.websocket("/ws/{name}")
async def ws_stream(websocket: WebSocket, name: str):
    await websocket.accept()
    if name not in _registry:
        await websocket.close(code=4004)
        return
    entry = _registry[name]
    w = entry.get("worker")
    if w is None:
        await websocket.close(code=4004)
        return
    try:
        while True:
            try:
                item = await asyncio.get_running_loop().run_in_executor(
                    None, lambda: w.frame_queue.get(timeout=1.0)  # 1초: 워커 상태 변경 즉시 감지
                )
            except Empty:
                # 워커가 교체됐으면 WebSocket 닫기 (클라이언트가 재연결)
                if entry.get("worker") is not w:
                    break
                # initializing / running 상태면 대기 계속
                if w.status in ("running", "initializing"):
                    continue
                # stopped / error 상태면 종료
                break
            # (jpeg_bytes, meta) 튜플 또는 레거시 bytes 둘 다 지원
            if isinstance(item, tuple):
                jpeg, meta = item
                await websocket.send_bytes(jpeg)
                await websocket.send_json(meta)
            else:
                await websocket.send_bytes(item)
    except (WebSocketDisconnect, Exception):
        pass


# ── 웹캠 장치 스캔 ──────────────────────────────────────────────────────────

@app.get("/api/webcams")
def list_webcams():
    """
    사용 가능한 웹캠 목록을 반환합니다.
    인덱스 0~5 범위를 순차 검색해 실제로 프레임을 읽을 수 있는 장치만 반환합니다.
    """
    import cv2
    result = []
    for i in range(6):
        cap = cv2.VideoCapture(i)
        if cap.isOpened():
            ret, _ = cap.read()
            cap.release()
            if ret:
                result.append({"index": str(i), "name": f"Camera {i}"})
        else:
            cap.release()
    return result


# ── 디텍터 타입 조회 ──────────────────────────────────────────────────────────

@app.get("/api/detector-types")
def get_detector_types():
    """프론트엔드 드롭다운용: 사용 가능한 디텍터 타입 목록을 반환합니다."""
    if _FRAMEWORK_PATH not in sys.path:
        sys.path.insert(0, _FRAMEWORK_PATH)
    try:
        from detector import list_detector_types   # noqa: PLC0415
        return {"types": list_detector_types()}
    except Exception:
        return {"types": ["yolo", "paddleocr", "cnn"]}


# ── Defect History API ────────────────────────────────────────────────────────

def _collect_save_roots() -> List[str]:
    """등록된 라인들의 save_root 목록(중복 제거)을 반환합니다."""
    roots = set()
    for entry in _registry.values():
        cfg = entry["config"]
        folder = entry.get("folder", "")

        def _abs_root(p: str) -> str:
            if not p:
                p = "./data"
            if os.path.isabs(p):
                return os.path.normpath(p)
            if folder:
                return os.path.normpath(os.path.join(folder, p))
            return os.path.abspath(p)

        products = cfg.get("products", {})
        for prod in products.values():
            roots.add(_abs_root(prod.get("save_root", "./data")))
        roots.add(_abs_root(cfg.get("save_root", "./data")))
    if not roots:
        roots.add(os.path.abspath("./data"))
    return list(roots)


@app.get("/api/history")
def get_history(
    category: str = Query("all", pattern="^(all|defect|borderline)$"),
    line: Optional[str] = Query(None),
    class_name: Optional[str] = Query(None),
    date: Optional[str] = Query(None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(60, ge=1, le=200),
    sort: str = Query("newest", pattern="^(newest|oldest|confidence_high|confidence_low)$"),
):
    """defect/borderline 이미지 이력을 조회합니다. (SQLite 인덱스 기반)"""
    if _history_db is None:
        return {"records": [], "total": 0, "page": page, "page_size": page_size, "total_pages": 0}
    return _history_db.query_history(
        category=category, line=line, class_name=class_name,
        date=date, page=page, page_size=page_size, sort=sort,
    )


@app.get("/api/history/image")
def get_history_image(path: str = Query(...)):
    """저장된 이미지 파일을 서빙합니다."""
    abspath = os.path.abspath(path)
    # 보안: save_root 하위 경로인지 검증
    roots = _collect_save_roots()
    allowed = any(abspath.startswith(r) for r in roots)
    if not allowed:
        raise HTTPException(403, "Access denied")
    if not os.path.isfile(abspath):
        raise HTTPException(404, "Image not found")
    return FileResponse(abspath, media_type="image/jpeg")


@app.post("/api/history/rescan")
def rescan_history():
    """히스토리 DB를 즉시 전체 재스캔합니다."""
    global _history_db
    roots = _collect_save_roots()
    print(f"[History] Rescan requested. Roots: {roots}")
    if _history_db is None:
        db_dir = roots[0] if roots else os.path.abspath("./data")
        db_path = os.path.join(db_dir, "history_index.db")
        _history_db = HistoryDB(db_path)
        _history_db.start(save_roots=roots)
    else:
        _history_db._save_roots = roots
        threading.Thread(
            target=_history_db._full_scan,
            name="history-rescan",
            daemon=True,
        ).start()
    return {"status": "rescanning", "roots": roots}


@app.get("/api/history/filters")
def get_history_filters():
    """히스토리 필터 UI용 라인명/클래스명/날짜 목록. (SQLite 인덱스 기반)"""
    if _history_db is None:
        return {"lines": [], "classes": [], "dates": []}
    return _history_db.query_filters()


# ── 데이터 수집 API ──────────────────────────────────────────────────────────

class CollectionStartRequest(BaseModel):
    line_name: str


class CollectionStopRequest(BaseModel):
    line_name: str


class CollectionSaveRequest(BaseModel):
    line_name: str


@app.get("/api/collection/lines")
def collection_lines():
    """수집 가능한 라인 목록을 반환합니다."""
    result = []
    for name, entry in _registry.items():
        cfg = entry["config"]
        w = entry.get("worker")
        is_busy = w is not None and w.status in ("running", "initializing")
        session = _collection_sessions.get(name)
        result.append({
            "line_name": name,
            "camera_type": cfg.get("camera_type", "basler"),
            "camera_ip": cfg.get("camera_ip", ""),
            "worker_running": is_busy,
            "collection_active": session is not None and session.status == "running",
        })
    return result


@app.post("/api/collection/start")
def start_collection(body: CollectionStartRequest):
    """수집 세션을 시작합니다. 카메라를 열고 모드를 자동 감지합니다."""
    name = body.line_name
    if name not in _registry:
        raise HTTPException(404, f"Line '{name}' not found")

    entry = _registry[name]
    w = entry.get("worker")
    if w and w.status in ("running", "initializing"):
        raise HTTPException(409, "Inspection worker is running on this line. Stop it first.")

    if name in _collection_sessions and _collection_sessions[name].status == "running":
        raise HTTPException(409, "Collection session already active on this line.")

    cfg = entry["config"]
    folder = entry.get("folder", "")
    save_dir = os.path.join(os.path.dirname(__file__), '..', 'only_image', name)

    def _abs(p: str) -> str:
        return os.path.join(folder, p) if p and not os.path.isabs(p) and folder else p

    session = CollectionSession(
        line_name=name,
        camera_type=cfg.get("camera_type", "basler"),
        camera_ip=cfg.get("camera_ip", ""),
        pfs_file=_abs(cfg.get("pfs_file", "camera.pfs")),
        rotation=cfg.get("rotation", "NONE"),
        crop_region=cfg.get("crop_region"),
        save_dir=save_dir,
        force_mode=cfg.get("collection_mode", "auto") or "auto",
    )
    session.start()
    _collection_sessions[name] = session

    # 모드 감지 완료까지 대기 (최대 3초)
    for _ in range(30):
        if session.status != "running":
            break
        if session._mode_detected:
            break
        time.sleep(0.1)

    return {
        "status": session.status,
        "detected_mode": session.detected_mode,
        "save_dir": save_dir,
    }


@app.post("/api/collection/stop")
def stop_collection(body: CollectionStopRequest):
    """수집 세션을 종료합니다."""
    name = body.line_name
    session = _collection_sessions.get(name)
    if not session or session.status not in ("running",):
        raise HTTPException(404, "No active collection session for this line")
    saved = session.stats["saved_count"]
    session.stop()
    session.join(timeout=5.0)
    del _collection_sessions[name]
    return {"status": "stopped", "saved_count": saved}


@app.post("/api/collection/save")
def collection_save(body: CollectionSaveRequest):
    """1프레임 저장 요청 (스페이스바 1회 = 1장)."""
    name = body.line_name
    session = _collection_sessions.get(name)
    if not session or session.status != "running":
        raise HTTPException(404, "No active collection session")
    session.request_save()
    return {"saved_count": session.stats["saved_count"]}


@app.get("/api/collection/status")
def collection_status(line_name: str = Query(...)):
    """수집 세션의 현재 상태를 반환합니다."""
    session = _collection_sessions.get(line_name)
    if not session:
        return {"status": "inactive", "line_name": line_name}
    return session.stats


@app.websocket("/ws/collection/{name}")
async def ws_collection_stream(websocket: WebSocket, name: str):
    """수집 세션의 라이브 프리뷰를 WebSocket으로 스트리밍합니다."""
    await websocket.accept()
    session = _collection_sessions.get(name)
    if not session or session.status != "running":
        await websocket.close(code=4004)
        return
    try:
        while True:
            try:
                jpeg = await asyncio.get_running_loop().run_in_executor(
                    None, lambda: session.frame_queue.get(timeout=1.0)
                )
            except Empty:
                if session.status != "running":
                    break
                continue
            await websocket.send_bytes(jpeg)
    except (WebSocketDisconnect, Exception):
        pass


# ── 관리자 인증 API ──────────────────────────────────────────────────────────

class AdminVerifyRequest(BaseModel):
    password: str


class AdminPasswordUpdate(BaseModel):
    current_password: str
    new_password: str


@app.post("/api/auth/verify")
def verify_admin(body: AdminVerifyRequest):
    """관리자 비밀번호를 검증합니다. 인증 실패 시 401 반환."""
    settings = _load_global_settings()
    admin = settings.get("admin", _DEFAULT_ADMIN)
    stored_password = admin.get("password", "")

    if not _verify_password(body.password, stored_password):
        raise HTTPException(status_code=401, detail="Incorrect password")

    return {"success": True}


@app.put("/api/settings/admin")
def update_admin_password(body: AdminPasswordUpdate):
    """관리자 비밀번호를 변경합니다. 새 비밀번호는 해싱되어 저장됩니다."""
    settings = _load_global_settings()
    admin = settings.get("admin", _DEFAULT_ADMIN)
    stored_password = admin.get("password", "")

    if not _verify_password(body.current_password, stored_password):
        raise HTTPException(status_code=403, detail="Current password is incorrect")

    # 새 비밀번호를 평문으로 저장
    settings["admin"] = {"password": body.new_password}
    _save_global_settings(settings)
    return {"message": "Admin password updated"}


# ── 스토리지 설정 API ────────────────────────────────────────────────────────

class StorageSettings(BaseModel):
    local_retention_days: int = 180  # 로컬 데이터 보관 기간 (일). 0 = 무제한
    storage_type: str = "local"      # "local" | "s3"
    s3_bucket: str = ""
    s3_region: str = "us-east-1"
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_prefix: str = ""
    s3_retention_days: int = 365
    s3_cleanup_interval_hours: int = 6


@app.get("/api/settings/storage")
def get_storage_settings():
    """현재 스토리지 설정을 조회합니다. secret_key는 마스킹됩니다."""
    settings = _load_global_settings()
    storage = settings.get("storage", dict(_DEFAULT_STORAGE))
    result = {
        "local_retention_days": storage.get("local_retention_days", 180),
        "storage_type": storage.get("storage_type", "local"),
        "s3_bucket": storage.get("s3_bucket", ""),
        "s3_region": storage.get("s3_region", "us-east-1"),
        "s3_access_key": storage.get("s3_access_key", ""),
        "s3_secret_key": storage.get("s3_secret_key", ""),
        "s3_prefix": storage.get("s3_prefix", ""),
        "s3_retention_days": storage.get("s3_retention_days", 365),
        "s3_cleanup_interval_hours": storage.get("s3_cleanup_interval_hours", 6),
    }
    if _s3_sync is not None:
        result["s3_sync_stats"] = _s3_sync.stats
    return result


@app.put("/api/settings/storage")
def update_storage_settings(body: StorageSettings):
    """스토리지 설정을 저장하고, S3 모드 전환 시 SyncWorker를 시작/중지합니다."""
    current = _load_global_settings()
    current_storage = current.get("storage", dict(_DEFAULT_STORAGE))

    new_storage = body.model_dump()

    _save_global_settings({"storage": new_storage})

    # S3 모드 전환 처리
    if new_storage["storage_type"] == "s3":
        if not new_storage["s3_bucket"]:
            raise HTTPException(400, "S3 bucket name is required")
        try:
            _start_s3_sync(new_storage)
        except ImportError:
            raise HTTPException(400, "boto3 is not installed. Run: uv add boto3")
    else:
        _stop_s3_sync()

    return {"message": "Storage settings saved"}


@app.post("/api/settings/storage/test")
def test_storage_connection(body: StorageSettings):
    """S3 연결 테스트를 수행합니다 (head_bucket 호출)."""
    secret = body.s3_secret_key
    if secret.startswith("****"):
        current = _load_global_settings()
        secret = current.get("storage", {}).get("s3_secret_key", "")

    if not body.s3_bucket:
        return {"success": False, "message": "Bucket name is required"}

    try:
        import boto3  # noqa: PLC0415
        kwargs = {"region_name": body.s3_region}
        if body.s3_access_key and secret:
            kwargs["aws_access_key_id"] = body.s3_access_key
            kwargs["aws_secret_access_key"] = secret
        client = boto3.client("s3", **kwargs)
        client.head_bucket(Bucket=body.s3_bucket)
        return {"success": True, "message": f"Connected to '{body.s3_bucket}' in {body.s3_region}"}
    except ImportError:
        return {"success": False, "message": "boto3 is not installed. Run: uv add boto3"}
    except Exception as e:
        return {"success": False, "message": str(e)}


# ── 레이아웃 설정 API ─────────────────────────────────────────────────────────

@app.get("/api/settings/layout")
def get_layout_settings():
    """저장된 레이아웃 설정을 조회합니다."""
    try:
        with open(_SETTINGS_PATH) as f:
            data = json.load(f)
        return data.get("layout", {})
    except FileNotFoundError:
        return {}


@app.put("/api/settings/layout")
def update_layout_settings(body: dict):
    """레이아웃 설정을 저장합니다."""
    try:
        with open(_SETTINGS_PATH) as f:
            data = json.load(f)
        data["layout"] = body
        with open(_SETTINGS_PATH, "w") as f:
            json.dump(data, f, indent=2)
        return {"success": True}
    except Exception as e:
        return {"success": False, "message": str(e)}


# ── 스토리지 브라우저 API ──────────────────────────────────────────────────────

_HIDDEN_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini", "history_index.db"}
_IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".tiff", ".webp"}
_BROWSE_LIMIT = 1000


def _validate_local_path(path: str) -> str:
    """로컬 경로가 save_roots 하위인지 검증하고 절대 경로를 반환합니다."""
    abspath = os.path.realpath(os.path.abspath(path))
    roots = _collect_save_roots()
    if not any(abspath == r or abspath.startswith(r + os.sep) for r in roots):
        raise HTTPException(403, "Access denied")
    return abspath


def _get_s3_storage():
    """현재 설정으로 S3Storage 인스턴스를 생성합니다."""
    from backend.storage import S3Storage  # noqa: PLC0415
    gs = _load_global_settings()
    storage = gs.get("storage", {})
    if not storage.get("s3_bucket"):
        raise HTTPException(400, "S3 is not configured")
    return S3Storage(
        bucket=storage["s3_bucket"],
        region=storage.get("s3_region", "us-east-1"),
        prefix=storage.get("s3_prefix", ""),
        access_key=storage.get("s3_access_key", ""),
        secret_key=storage.get("s3_secret_key", ""),
    )


@app.get("/api/storage/local/browse")
def browse_local(path: str = Query("")):
    """로컬 디렉토리의 파일/폴더 목록을 반환합니다."""
    # 빈 경로면 save_roots 최상위 표시
    if not path:
        roots = _collect_save_roots()
        items = []
        for r in sorted(roots):
            if not os.path.isdir(r):
                continue
            # worker-02/data 형식으로 표시 (마지막 2 세그먼트)
            parts = r.replace("\\", "/").split("/")
            parts = [p for p in parts if p]
            display_name = "/".join(parts[-2:]) if len(parts) >= 2 else (parts[-1] if parts else r)
            items.append({
                "name": display_name,
                "type": "folder",
                "size": None,
                "modified": datetime.fromtimestamp(os.path.getmtime(r)).isoformat() if os.path.exists(r) else None,
                "path": r,
            })
        return {
            "items": items,
            "current_path": "",
            "parent_path": None,
            "save_root": None,
            "storage_type": "local",
            "truncated": False,
        }

    abspath = _validate_local_path(path)
    if not os.path.isdir(abspath):
        raise HTTPException(404, "Directory not found")

    items = []
    try:
        with os.scandir(abspath) as it:
            for entry in it:
                if entry.name in _HIDDEN_NAMES or entry.name.startswith("."):
                    continue
                try:
                    stat = entry.stat()
                    item = {
                        "name": entry.name,
                        "type": "folder" if entry.is_dir() else "file",
                        "size": stat.st_size if entry.is_file() else None,
                        "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(),
                        "path": entry.path,
                    }
                    items.append(item)
                except OSError:
                    continue
                if len(items) >= _BROWSE_LIMIT:
                    break
    except PermissionError:
        raise HTTPException(403, "Permission denied")

    # 폴더 먼저, 이름 순 정렬
    items.sort(key=lambda x: (0 if x["type"] == "folder" else 1, x["name"].lower()))

    # 부모 경로 계산
    roots = _collect_save_roots()
    parent = os.path.dirname(abspath)
    is_root = abspath in roots
    # save_root 수준에서는 "" (루트 목록으로 복귀), 그 하위는 부모 폴더, 범위 외는 ""
    parent_path = "" if is_root else (parent if any(parent == r or parent.startswith(r + os.sep) for r in roots) else "")

    # 현재 경로가 속한 save_root 찾기
    save_root = next((r for r in roots if abspath == r or abspath.startswith(r + os.sep)), None)

    return {
        "items": items,
        "current_path": abspath,
        "parent_path": parent_path,
        "save_root": save_root,
        "storage_type": "local",
        "truncated": len(items) >= _BROWSE_LIMIT,
    }


@app.get("/api/storage/s3/browse")
def browse_s3(prefix: str = Query("")):
    """S3 버킷의 폴더/파일 목록을 반환합니다."""
    s3 = _get_s3_storage()
    client = s3._get_client()
    full_prefix = s3._make_key(prefix) if prefix else (s3.prefix.rstrip("/") + "/" if s3.prefix else "")

    items = []
    try:
        paginator = client.get_paginator("list_objects_v2")
        page_iter = paginator.paginate(
            Bucket=s3.bucket, Prefix=full_prefix, Delimiter="/",
            PaginationConfig={"MaxItems": _BROWSE_LIMIT},
        )
        for page in page_iter:
            # 폴더 (CommonPrefixes)
            for cp in page.get("CommonPrefixes", []):
                p = cp["Prefix"]
                display = p[len(full_prefix):].rstrip("/")
                if not display:
                    continue
                items.append({
                    "name": display,
                    "type": "folder",
                    "size": None,
                    "modified": None,
                    "path": p,
                })
            # 파일 (Contents)
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if key == full_prefix:
                    continue
                display = key[len(full_prefix):]
                if not display or "/" in display:
                    continue
                items.append({
                    "name": display,
                    "type": "file",
                    "size": obj.get("Size"),
                    "modified": obj["LastModified"].isoformat() if obj.get("LastModified") else None,
                    "path": key,
                })
    except Exception as e:
        raise HTTPException(500, f"S3 browse error: {e}")

    items.sort(key=lambda x: (0 if x["type"] == "folder" else 1, x["name"].lower()))

    # 부모 prefix 계산
    parent_prefix = None
    if prefix:
        parts = prefix.rstrip("/").rsplit("/", 1)
        parent_prefix = (parts[0] + "/") if len(parts) > 1 else ""

    return {
        "items": items,
        "current_path": prefix,
        "parent_path": parent_prefix,
        "storage_type": "s3",
        "truncated": len(items) >= _BROWSE_LIMIT,
    }


@app.get("/api/storage/s3/image")
def get_s3_image(key: str = Query(...)):
    """S3 오브젝트를 스트리밍으로 서빙합니다."""
    if ".." in key:
        raise HTTPException(400, "Invalid key")
    s3 = _get_s3_storage()
    client = s3._get_client()
    real_key = s3._make_key(key) if s3.prefix else key
    try:
        resp = client.get_object(Bucket=s3.bucket, Key=real_key)
    except Exception as e:
        raise HTTPException(404, f"S3 object not found: {e}")

    ext = os.path.splitext(key)[1].lower()
    ct_map = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
              ".bmp": "image/bmp", ".txt": "text/plain", ".webp": "image/webp"}
    content_type = ct_map.get(ext, "application/octet-stream")
    return StreamingResponse(resp["Body"], media_type=content_type,
                             headers={"Cache-Control": "public, max-age=3600"})


@app.delete("/api/storage/local/file")
def delete_local_file(path: str = Query(...)):
    """로컬 파일을 삭제합니다."""
    abspath = _validate_local_path(path)
    if not os.path.isfile(abspath):
        raise HTTPException(404, "File not found")
    os.remove(abspath)
    return {"deleted": True, "path": abspath}


@app.delete("/api/storage/local/folder")
def delete_local_folder(path: str = Query(...)):
    """로컬 폴더를 삭제합니다."""
    import shutil  # noqa: PLC0415
    abspath = _validate_local_path(path)
    if not os.path.isdir(abspath):
        raise HTTPException(404, "Directory not found")
    # save_root 자체는 삭제 불가
    roots = _collect_save_roots()
    if abspath in roots:
        raise HTTPException(400, "Cannot delete a save root directory")
    count = sum(len(files) for _, _, files in os.walk(abspath))
    shutil.rmtree(abspath)
    return {"deleted": True, "path": abspath, "files_removed": count}


@app.delete("/api/storage/s3/file")
def delete_s3_file(key: str = Query(...)):
    """S3 오브젝트를 삭제합니다."""
    if ".." in key or not key.strip("/"):
        raise HTTPException(400, "Invalid key")
    s3 = _get_s3_storage()
    client = s3._get_client()
    # browse 응답의 path는 이미 풀 S3 키이므로 _make_key 없이 직접 삭제
    try:
        client.delete_object(Bucket=s3.bucket, Key=key)
    except Exception as e:
        raise HTTPException(500, f"Failed to delete S3 object: {e}")
    return {"deleted": True, "key": key}


@app.delete("/api/storage/s3/folder")
def delete_s3_folder(prefix: str = Query(...)):
    """S3 prefix 아래 모든 오브젝트를 일괄 삭제합니다. 삭제 후 상위 폴더를 보존합니다."""
    if ".." in prefix:
        raise HTTPException(400, "Invalid prefix")
    if not prefix or not prefix.strip("/"):
        raise HTTPException(400, "Cannot delete root — prefix is required")
    if not prefix.endswith("/"):
        prefix += "/"

    s3 = _get_s3_storage()
    client = s3._get_client()
    target_prefix = prefix

    # 1) 삭제 전: 직속 상위 prefix 계산
    parent_prefix = None
    stripped = prefix.rstrip("/")
    if "/" in stripped:
        parent_prefix = stripped.rsplit("/", 1)[0] + "/"

    # 2) 대상 prefix 하위 객체 삭제
    deleted_count = 0
    try:
        paginator = client.get_paginator("list_objects_v2")
        for page in paginator.paginate(Bucket=s3.bucket, Prefix=target_prefix):
            keys = []
            for obj in page.get("Contents", []):
                key = obj["Key"]
                if key.startswith(target_prefix):
                    keys.append({"Key": key})
            if keys:
                client.delete_objects(Bucket=s3.bucket, Delete={"Objects": keys})
                deleted_count += len(keys)
    except Exception as e:
        raise HTTPException(500, f"S3 folder delete failed: {e}")

    # 3) 삭제 후: 상위 폴더가 비었으면 0-byte placeholder 생성하여 폴더 구조 보존
    #    (S3에는 실제 폴더가 없으므로, 하위 객체가 모두 삭제되면 상위 "폴더"도 사라짐.
    #     0-byte placeholder를 생성하면 상위 계층 전체가 browse에서 유지됨.)
    if parent_prefix and deleted_count > 0:
        try:
            resp = client.list_objects_v2(
                Bucket=s3.bucket, Prefix=parent_prefix, MaxKeys=1,
            )
            if resp.get("KeyCount", 0) == 0:
                client.put_object(Bucket=s3.bucket, Key=parent_prefix, Body=b"")
        except Exception:
            pass  # placeholder 실패는 치명적이지 않으므로 무시

    return {"deleted": True, "prefix": prefix, "files_removed": deleted_count}


# ── 헬스 체크 ────────────────────────────────────────────────────────────────

@app.get("/api/health")
def health():
    running = sum(
        1 for e in _registry.values()
        if e.get("worker") and e["worker"].status == "running"
    )
    return {"status": "ok", "lines": len(_registry), "running": running}


@app.get("/api/system/browse-files")
def browse_files(path: str = Query(""), extensions: str = Query("")):
    """파일 시스템 탐색 - 디렉토리와 특정 확장자 파일만 반환."""
    import os
    target = path or os.path.expanduser("~")
    target = os.path.abspath(target)
    if not os.path.isdir(target):
        raise HTTPException(400, f"Not a directory: {target}")
    items = []
    try:
        ext_list = [e.strip().lower() for e in extensions.split(",") if e.strip()] if extensions else []
        for entry in sorted(os.scandir(target), key=lambda e: (not e.is_dir(), e.name.lower())):
            if entry.name.startswith('.'):
                continue
            if entry.is_dir():
                items.append({"name": entry.name, "path": entry.path, "is_dir": True})
            elif ext_list:
                if any(entry.name.lower().endswith(ext) for ext in ext_list):
                    items.append({"name": entry.name, "path": entry.path, "is_dir": False})
            else:
                items.append({"name": entry.name, "path": entry.path, "is_dir": False})
    except PermissionError:
        raise HTTPException(403, f"Permission denied: {target}")
    return {"current": target, "parent": os.path.dirname(target), "items": items[:500]}


@app.post("/api/system/parse-yaml")
def parse_yaml(body: dict):
    """YAML 파일을 파싱하여 클래스 이름 목록을 반환."""
    import yaml as _yaml
    file_path = body.get("path", "")
    line_name = body.get("line_name", "")
    if not file_path:
        raise HTTPException(400, "No path provided")
    # 상대경로면 워커 디렉토리 기준으로 해석
    if not os.path.isabs(file_path) and line_name:
        worker_dir = os.path.join(_WORKERS_DIR, line_name)
        file_path = os.path.normpath(os.path.join(worker_dir, file_path))
    if not os.path.isfile(file_path):
        raise HTTPException(400, f"File not found: {file_path}")
    try:
        with open(file_path) as f:
            data = _yaml.safe_load(f)
        names = {}
        if isinstance(data, dict):
            raw = data.get("names", {})
            if isinstance(raw, dict):
                names = {str(k): str(v) for k, v in raw.items()}
            elif isinstance(raw, list):
                names = {str(i): str(v) for i, v in enumerate(raw)}
        return {"names": names, "nc": data.get("nc", len(names))}
    except Exception as e:
        raise HTTPException(400, f"YAML parse error: {e}")


@app.get("/api/system/gpus")
def get_gpus():
    """사용 가능한 GPU 목록을 반환합니다."""
    try:
        import torch
        if not torch.cuda.is_available():
            return {"gpus": []}
        gpus = []
        for i in range(torch.cuda.device_count()):
            props = torch.cuda.get_device_properties(i)
            total_mb = props.total_memory // (1024 * 1024)
            gpus.append({
                "index": i,
                "device": f"cuda:{i}",
                "name": props.name,
                "total_mb": total_mb,
            })
        return {"gpus": gpus}
    except Exception as e:
        return {"gpus": [], "error": str(e)}


# ── 서버 수명주기: 히스토리 인덱서 + 주기적 클린업 ────────────────────────────


def _s3_cleanup_old_data(retention_days: int):
    """S3 버킷 전체에서 retention_days보다 오래된 날짜 폴더의 객체를 일괄 삭제합니다.

    S3 키 구조: {line_name}/{category}/{class_name}/{YYYY-MM-DD}/{HH}/{filename}
    키 경로에서 YYYY-MM-DD 패턴을 찾아 cutoff 이전 객체를 삭제합니다.
    """
    try:
        s3 = _get_s3_storage()
    except Exception:
        return 0
    client = s3._get_client()
    cutoff = (datetime.now() - timedelta(days=retention_days)).strftime("%Y-%m-%d")
    bucket_prefix = (s3.prefix + "/") if s3.prefix else ""

    deleted_count = 0
    try:
        paginator = client.get_paginator("list_objects_v2")
        to_delete = []
        for page in paginator.paginate(Bucket=s3.bucket, Prefix=bucket_prefix):
            for obj in page.get("Contents", []):
                key = obj["Key"]
                # 키에서 YYYY-MM-DD 패턴 찾기
                parts = key.split("/")
                date_str = None
                for part in parts:
                    if len(part) == 10 and part[4:5] == "-" and part[7:8] == "-":
                        try:
                            datetime.strptime(part, "%Y-%m-%d")
                            date_str = part
                            break
                        except ValueError:
                            continue
                if date_str and date_str < cutoff:
                    to_delete.append({"Key": key})
                    if len(to_delete) >= 1000:
                        client.delete_objects(Bucket=s3.bucket, Delete={"Objects": to_delete})
                        deleted_count += len(to_delete)
                        to_delete = []
        if to_delete:
            client.delete_objects(Bucket=s3.bucket, Delete={"Objects": to_delete})
            deleted_count += len(to_delete)
    except Exception as e:
        print(f"[S3 Cleanup] Error: {e}")

    if deleted_count > 0:
        print(f"[S3 Cleanup] Deleted {deleted_count} objects older than {cutoff} "
              f"(retention: {retention_days} days)")
    return deleted_count


def _run_cleanup():
    """로컬 + S3 + SQLite 클린업을 1회 실행합니다."""
    if _FRAMEWORK_PATH not in sys.path:
        sys.path.insert(0, _FRAMEWORK_PATH)
    from datamanager import DataManager  # noqa: PLC0415

    gs = _load_global_settings()
    local_retention = gs.get("storage", {}).get("local_retention_days", 180)

    if local_retention > 0:
        for save_root in _collect_save_roots():
            try:
                dm = DataManager(save_root=save_root)
                dm.cleanup_old_data(local_retention)
            except Exception as e:
                print(f"[Cleanup] ({save_root}) local cleanup failed: {e}")

    # S3 정리 (글로벌 s3_retention_days 사용)
    try:
        st = gs.get("storage", {})
        s3_retention = st.get("s3_retention_days", 365)
        if (st.get("storage_type") == "s3"
                and st.get("s3_bucket")
                and s3_retention > 0):
            _s3_cleanup_old_data(s3_retention)
    except Exception as e:
        print(f"[Cleanup] S3 cleanup failed: {e}")

    # SQLite에서도 글로벌 로컬 보관 기간으로 오래된 레코드 삭제
    if _history_db is not None and local_retention > 0:
        cutoff = (datetime.now() - timedelta(days=local_retention)).strftime("%Y-%m-%d")
        _history_db.delete_before_date(cutoff)

    print(f"[Cleanup] Cleanup done at {datetime.now().isoformat()}")


@app.post("/api/settings/storage/cleanup")
def trigger_cleanup_now():
    """수동으로 클린업을 즉시 1회 실행합니다."""
    try:
        _run_cleanup()
        return {"message": "Cleanup completed successfully"}
    except Exception as e:
        raise HTTPException(500, f"Cleanup failed: {e}")


def _periodic_cleanup_loop(stop_event: threading.Event):
    """설정된 주기(s3_cleanup_interval_hours)마다 오래된 데이터를 정리하는 백그라운드 루프."""
    while not stop_event.is_set():
        # 매 사이클마다 최신 설정에서 interval 읽기
        try:
            gs = _load_global_settings()
            interval_hours = gs.get("storage", {}).get("s3_cleanup_interval_hours", 6)
        except Exception:
            interval_hours = 6
        interval_hours = max(1, interval_hours)  # 최소 1시간
        stop_event.wait(timeout=interval_hours * 3600)
        if stop_event.is_set():
            break
        try:
            _run_cleanup()
        except Exception as e:
            print(f"[Cleanup] Error: {e}")


_cleanup_stop_event = threading.Event()


@app.on_event("startup")
def on_startup():
    """서버 시작 시 히스토리 인덱서와 주기적 클린업 스레드를 기동합니다."""
    global _history_db

    # 1. 히스토리 SQLite 인덱서 시작
    roots = _collect_save_roots()
    db_dir = roots[0] if roots else os.path.abspath("./data")
    db_path = os.path.join(db_dir, "history_index.db")
    _history_db = HistoryDB(db_path)
    _history_db.start(save_roots=roots)
    print(f"[Startup] History indexer started (DB: {db_path})")

    # 2. 주기적 클린업 스레드 시작
    _cleanup_stop_event.clear()
    threading.Thread(
        target=_periodic_cleanup_loop,
        args=(_cleanup_stop_event,),
        name="periodic-cleanup",
        daemon=True,
    ).start()
    print("[Startup] Periodic cleanup thread started (every 6h)")

    # 3. S3 동기화 (설정이 s3이면 SyncWorker 시작)
    try:
        gs = _load_global_settings()
        storage = gs.get("storage", {})
        if storage.get("storage_type") == "s3" and storage.get("s3_bucket"):
            _start_s3_sync(storage)
    except Exception as e:
        print(f"[Startup] S3 sync init failed (will run local-only): {e}")


@app.on_event("shutdown")
def on_shutdown():
    """서버 종료 시 백그라운드 스레드를 정리합니다."""
    _cleanup_stop_event.set()
    _stop_s3_sync()
    if _history_db is not None:
        _history_db.stop()
