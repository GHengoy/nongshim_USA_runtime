"""
config.py — 검사 라인 설정 통합 관리
======================================

[역할]
    카메라 1대(= 검사 라인 1개)에 필요한 모든 설정을
    InspectionConfig 하나에 담습니다.

[왜 이렇게 만들었나?]
    나중에 React 관리자 UI ↔ FastAPI 백엔드가
    JSON 한 덩어리로 설정을 주고받을 수 있어야 합니다.
    dataclass + to_dict/from_dict 로 JSON 직렬화를 지원합니다.

[사용법]
    # 파이썬 코드에서 직접 생성
    config = InspectionConfig(
        line_name="4-7-pouch-C",
        camera_ip="192.168.4.73",
        ...
    )

    # JSON 파일에서 불러오기
    config = InspectionConfig.from_json("configs/4-7-pouch-C.json")

    # JSON 파일로 저장
    config.to_json("configs/4-7-pouch-C.json")

    # 딕셔너리로 변환 (FastAPI 응답용)
    data = config.to_dict()
"""

import json
import os
from dataclasses import dataclass, field, asdict
from typing import Dict, List, Optional


# ──────────────────────────────────────────────────────────────────────
#  cv2.ROTATE_* 상수 ↔ 문자열 변환 테이블 (JSON 저장/불러오기용)
#  정수값: cv2.ROTATE_90_CLOCKWISE=0, cv2.ROTATE_180=1, cv2.ROTATE_90_COUNTERCLOCKWISE=2
# ──────────────────────────────────────────────────────────────────────
_ROTATION_STR_TO_CV2 = {
    "CLOCKWISE_90":        0,      # cv2.ROTATE_90_CLOCKWISE
    "COUNTERCLOCKWISE_90": 2,      # cv2.ROTATE_90_COUNTERCLOCKWISE
    "180":                 1,      # cv2.ROTATE_180
    "NONE":                None,
}
_ROTATION_CV2_TO_STR = {v: k for k, v in _ROTATION_STR_TO_CV2.items()}

# 제품 레벨 필드: 제품마다 개별 값을 가지는 설정 (라인 레벨 필드와 구분)
PRODUCT_LEVEL_FIELDS = {
    'mode', 'rotation', 'crop_region', 'model_path', 'class_thresholds',
    'save_thresholds', 'device', 'reject_delay_frames', 'reject_delay_seconds',
    'reject_positions', 'reject_mode', 'time_valve_on', 'pre_valve_delay',
    'trigger_delay_us', 'trigger_debounce_us', 'save_root', 'retention_days', 'max_preview',
    'save_normal', 'detector_type', 'detector_config', 'show_threshold',
    'data_yaml',
}


@dataclass
class InspectionConfig:
    """
    검사 라인 1개의 모든 설정을 담는 데이터 클래스.

    ── 카메라 설정 ────────────────────────────────────────────────────
    line_name     : 라인 이름 (파일명, 창 제목, 로그에 사용)
    camera_ip     : Basler 카메라 IP 주소
    pfs_file      : 카메라 파라미터 파일 경로 (.pfs)
    rotation      : 이미지 회전 (cv2.ROTATE_* 상수 또는 None)
    crop_region   : 검사 ROI [x1, y1, x2, y2]. None 이면 전체 이미지.

    ── AI 모델 설정 ───────────────────────────────────────────────────
    model_path        : YOLOv12 가중치 파일 경로 (.pt)
    class_thresholds  : 클래스별 threshold 딕셔너리 {"클래스명": 0.0~1.0}
                        None 이면 모든 클래스를 0.5 기준 불량 처리.
    save_thresholds   : 클래스별 저장 threshold {"클래스명": 0.0~1.0}
                        class_threshold 미만이지만 save_threshold 이상이면
                        borderline/ 폴더에 저장. None 이면 비활성.
    device            : 추론 장치 ('cuda' 또는 'cpu')

    ── 리젝트 설정 ────────────────────────────────────────────────────
    reject_delay_frames : 슬라이딩 윈도우 크기 (컨베이어 딜레이 보상)
    reject_positions    : window[-N:] 범위 크기.
                          1=맨 뒤 1칸만(기본, 1번 발사), 3=뒤 3칸(최대 3번 발사)
    time_valve_on       : 밸브 열림 지속 시간 [초] (예: 0.1, 0.2, 0.3)
    pre_valve_delay      : 리젝트 신호 ON 전 추가 대기 [초]

    ── 데이터 저장 설정 ───────────────────────────────────────────────
    save_root       : 이미지 저장 최상위 경로
    retention_days  : 보관 기간 (일). 워커 시작 시 오래된 날짜 폴더 자동 삭제.
                      0 = 삭제 안 함 (무제한 보관). 기본값 180 (≈ 6개월).
    max_preview     : (deprecated) 미사용 — 하위 호환용
    save_normal     : (deprecated) 미사용 — 하위 호환용
    """

    # 카메라
    line_name:    str = "inspection-line"   # 내부 ID (= 폴더명, 변경 불가)
    project_name: str = ""                   # 화면 표시명 + 저장 폴더명 (자유 변경)
    camera_type:  str = "basler"            # "basler" | "webcam"
    camera_ip:   str = "192.168.1.10"   # Basler: IP 주소 / Webcam: 인덱스 문자열("0","1",...)
    pfs_file:    str = "camera.pfs"
    collection_mode: str = "auto"           # auto | trigger | continuous (검사·수집 공용)
    rotation:    Optional[int]       = None          # cv2.ROTATE_* 또는 None
    crop_region: Optional[List[int]] = None          # [x1, y1, x2, y2]

    # 감지기 타입 (제품 레벨 — 제품마다 다른 디텍터 사용 가능)
    detector_type:   str = "yolo"                  # "yolo" | "paddleocr" | "cnn" | ...
    detector_config: Optional[Dict] = None         # 감지기별 추가 설정

    # AI 모델
    data_yaml:        str = "./weights/data.yaml"      # YOLO data.yaml 파일 경로
    model_path:       str = "./weights/best.pt"
    class_thresholds: Optional[Dict[str, float]] = None  # {"defect": 0.70, ...}
    save_thresholds:  Optional[Dict[str, float]] = None  # {"defect": 0.30, ...}
    show_threshold:   float = 0.3                       # 대시보드 표시 임계값 (리젝트 무관)
    device:           str = "cuda"

    # 리젝트
    reject_delay_frames:   int            = 10
    reject_delay_seconds:  Optional[float] = None   # 연속 카메라 모드 전용 (초 단위 딜레이)
    reject_positions:      int            = 1
    reject_mode:           str            = "individual"   # "individual" | "continuous"
    time_valve_on:         float          = 0.1
    pre_valve_delay:       float          = 0.25
    trigger_delay_us:      Optional[float] = None   # 트리거 모드 전용: 센서 인식 후 촬영 딜레이 [µs]
    trigger_debounce_us:   Optional[float] = None   # 트리거 노이즈 제거: LineDebouncerHighTime [µs]

    # 데이터 저장
    save_root:      str  = "./data"
    retention_days: int  = 180          # 보관 기간 (일). 0 = 무제한
    max_preview:    int  = 50
    save_normal:    bool = False

    # 제품별 설정
    active_product: Optional[str]  = None    # 현재 활성 제품명
    products:       Optional[Dict] = None    # {"제품명": {제품 레벨 필드...}, ...}

    # ──────────────────────────────────────────────────────────────────
    # JSON 직렬화 / 역직렬화
    # ──────────────────────────────────────────────────────────────────

    def to_dict(self) -> dict:
        """
        딕셔너리로 변환합니다.
        cv2.ROTATE_* 정수 상수는 문자열로 변환해 JSON 호환성을 보장합니다.
        products가 있으면 flat product 필드를 제거해 깨끗한 JSON을 생성합니다.
        """
        d = asdict(self)
        # rotation: int → 문자열 (JSON에서 정수 상수가 의미 불명확하므로)
        d["rotation"] = _ROTATION_CV2_TO_STR.get(self.rotation, "NONE")
        # products가 있으면 flat product 필드 제거 (products dict 안에만 보관)
        if d.get("products") and d.get("active_product"):
            for key in PRODUCT_LEVEL_FIELDS:
                d.pop(key, None)
        return d

    def to_json(self, path: str):
        """
        JSON 파일로 저장합니다.

        Parameters
        ----------
        path : 저장할 파일 경로 (디렉토리가 없으면 자동 생성)
        """
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.to_dict(), f, ensure_ascii=False, indent=2)
        print(f"[Config] 저장 완료: {path}")

    @classmethod
    def from_dict(cls, data: dict) -> "InspectionConfig":
        """
        딕셔너리에서 InspectionConfig 를 생성합니다.
        FastAPI 요청 수신, JSON 파일 불러오기 모두 이 메서드를 사용합니다.

        products + active_product 가 있으면 활성 제품의 필드를
        자동으로 flat 레벨에 병합합니다.
        → config.json에 flat product 필드가 없어도 정상 동작합니다.

        Parameters
        ----------
        data : to_dict() 로 만든 딕셔너리 또는 JSON 파싱 결과
        """
        from dataclasses import fields
        d = dict(data)  # 원본 변경 방지

        # [Backward compatibility] reject_pulse_count → time_valve_on
        if "reject_pulse_count" in d and "time_valve_on" not in d:
            if d["reject_pulse_count"] is not None:
                d["time_valve_on"] = d["reject_pulse_count"] * 0.1
            else:
                d["time_valve_on"] = 0.1  # 기본값
            d.pop("reject_pulse_count", None)

        # products 내 모든 제품도 마이그레이션
        products = d.get("products")
        if products:
            for product_name, product_config in products.items():
                if isinstance(product_config, dict):
                    if "reject_pulse_count" in product_config and "time_valve_on" not in product_config:
                        if product_config["reject_pulse_count"] is not None:
                            product_config["time_valve_on"] = product_config["reject_pulse_count"] * 0.1
                        else:
                            product_config["time_valve_on"] = 0.1  # 기본값
                        product_config.pop("reject_pulse_count", None)

        # [Backward compatibility] project_name 없으면 line_name으로 초기화
        if not d.get("project_name"):
            d["project_name"] = d.get("line_name", "")

        # products + active_product → 활성 제품 필드를 flat에 병합
        products = d.get("products")
        active = d.get("active_product")
        if products and active and active in products:
            d.update(products[active])
        valid_keys = {f.name for f in fields(cls)}
        d = {k: v for k, v in d.items() if k in valid_keys}
        # rotation: 문자열 → cv2 정수 상수
        rotation_str = d.get("rotation", "NONE")
        d["rotation"] = _ROTATION_STR_TO_CV2.get(rotation_str, None)
        return cls(**d)

    @classmethod
    def from_json(cls, path: str) -> "InspectionConfig":
        """
        JSON 파일에서 InspectionConfig 를 불러옵니다.

        Parameters
        ----------
        path : 불러올 파일 경로
        """
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        print(f"[Config] 불러오기 완료: {path}")
        return cls.from_dict(data)
