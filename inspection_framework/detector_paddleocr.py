"""
detector_paddleocr.py — PaddleOCR Text Detection Plugin (v2: Pattern-Based OCR)
================================================================================

[Role]
    Detects text regions and recognizes characters using PaddleOCR.
    NEW: Pattern existence-based decision (not confidence-based).
    - Scans ALL recognized texts on the screen.
    - If expected_text pattern is found ANYWHERE → is_defect = False (정상)
    - If expected_text pattern is NOT found → is_defect = True (불량)
    - Confidence values are recorded but not used for defect decision.

[Install]
    uv add paddleocr paddlepaddle  (or paddlepaddle-gpu)

[detector_config keys]
    lang               : str  = "en"     — PaddleOCR language code
    change_date        : str  = None     — Expected date pattern (e.g., "2026\\.02\\.\\d{2}")
                                           Only defect if this pattern is NOT found
    class_name         : str  = "date_check" — Folder name for saving defects

    [Performance Tuning]
    gpu_mem            : int  = None     — GPU memory limit in MB (e.g., 500). Auto if None.
    use_angle_cls      : bool = True     — Detect rotated text (False = faster for horizontal text)
    det_limit_side_len : int  = 960      — Image size limit for detection (smaller = faster)
                                           480 (fast), 960 (balanced), 1280 (accurate)
    rec_batch_num      : int  = 6        — Recognition batch size (larger = faster but more memory)
    use_dilation       : bool = False    — Dilate detection regions (better accuracy)

    [Custom Models]
    text_recognition_model_dir : str = None — Custom recognition model path
    text_detection_model_dir   : str = None — Custom detection model path

[Example Config — Speed Optimized]
    {
        "detector_config": {
            "lang": "en",
            "change_date": "2026\\.02\\.\\d{2}",
            "class_name": "date_check",
            "use_angle_cls": false,               # 회전 감지 OFF (날짜는 수평)
            "det_limit_side_len": 480,            # 빠른 감지
            "rec_batch_num": 10                   # 큰 배치 = 빠름
        }
    }

[Example Config — Balanced (Recommended)]
    {
        "detector_config": {
            "lang": "en",
            "change_date": "2026\\.02\\.\\d{2}",
            "class_name": "date_check",
            "use_angle_cls": true,
            "det_limit_side_len": 960,
            "rec_batch_num": 6
        }
    }

[Example Config — High Accuracy]
    {
        "detector_config": {
            "lang": "en",
            "change_date": "2026\\.02\\.\\d{2}",
            "class_name": "date_check",
            "use_angle_cls": true,
            "det_limit_side_len": 1280,
            "rec_batch_num": 3,
            "use_dilation": true
        }
    }

[Usage]
    Automatically loaded by create_detector("paddleocr", ...).
"""

import os
import re
import cv2
import numpy as np
from typing import Dict, List, Optional

# PaddlePaddle 플래그는 paddle이 import되기 전 모듈 레벨에서 설정해야 효과가 있음
os.environ.setdefault('PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK', 'True')
os.environ.setdefault('FLAGS_use_mkldnn', '0')        # oneDNN 비활성 (PIR 미구현 연산 회피)
os.environ.setdefault('FLAGS_enable_pir_api', '0')    # 새 PIR 실행기 비활성

from detector import BaseDetector, DetectionResult, register_detector


@register_detector("paddleocr")
class PaddleOcrDetector(BaseDetector):
    """PaddleOCR-based text detection and recognition (v2.x API)."""

    def __init__(
        self,
        model_path: str,
        class_thresholds: Optional[Dict[str, float]] = None,
        device: str = 'cuda',
        detector_config: Optional[Dict] = None,
    ):
        from paddleocr import PaddleOCR

        dc = detector_config or {}
        self.class_thresholds = class_thresholds
        self.change_date = dc.get("change_date")  # 검사할 날짜 패턴 (정규식)
        self.class_name = dc.get("class_name", "date_check")  # 저장 폴더명 (고정)
        lang = dc.get("lang", "en")

        # PaddleOCR constructor parameters
        # NOTE: use_gpu / gpu_mem were removed in PaddleOCR 3.x (GPU auto-detected)
        # device 매핑: 'cuda' / 'cuda:0' → 'GPU:0', 'cpu' → 'CPU'
        if device and device.lower() != 'cpu':
            gpu_id = device.split(':')[1] if ':' in device else '0'
            paddle_device = f"GPU:{gpu_id}"
        else:
            paddle_device = "CPU"
        ocr_kwargs: dict = {"lang": lang, "device": paddle_device}

        # Performance tuning parameters (3.x compatible only)
        if "use_angle_cls" in dc:
            ocr_kwargs["use_angle_cls"] = dc["use_angle_cls"]
        if "det_limit_side_len" in dc:
            ocr_kwargs["det_limit_side_len"] = dc["det_limit_side_len"]
        if "rec_batch_num" in dc:
            ocr_kwargs["rec_batch_num"] = dc["rec_batch_num"]
        if "use_dilation" in dc:
            ocr_kwargs["use_dilation"] = dc["use_dilation"]

        # Custom model paths
        if dc.get("text_recognition_model_dir"):
            ocr_kwargs["rec_model_dir"] = dc["text_recognition_model_dir"]
        if dc.get("text_detection_model_dir"):
            ocr_kwargs["det_model_dir"] = dc["text_detection_model_dir"]

        print(f"[Detector:PaddleOCR] Initializing (lang={lang}, change_date={self.change_date}, class_name={self.class_name})")
        print(f"[Detector:PaddleOCR]   det_limit_side_len={ocr_kwargs.get('det_limit_side_len', 960)} | rec_batch_num={ocr_kwargs.get('rec_batch_num', 6)} | use_angle_cls={ocr_kwargs.get('use_angle_cls', True)}")
        self._ocr = PaddleOCR(**ocr_kwargs)
        print(f"[Detector:PaddleOCR] Ready.")

    def detect(self, image_bgr: np.ndarray) -> List[DetectionResult]:
        if image_bgr is None:
            return []

        result = self._ocr.ocr(image_bgr)
        detections: List[DetectionResult] = []

        if not result or not result[0]:
            return detections

        # PaddleOCR 3.x returns: [{ 'rec_texts': [...], 'rec_scores': [...],
        #                           'rec_polys': [...] or 'dt_polys': [...] }]
        page = result[0]

        # Step 1: 모든 인식된 텍스트 수집 및 패턴 매칭
        pattern_found = False
        all_text_data = []

        # 3.x dict format
        if isinstance(page, dict):
            texts = page.get("rec_texts", [])
            scores = page.get("rec_scores", [])
            polys = page.get("rec_polys", page.get("dt_polys", []))

            for text, confidence, poly in zip(texts, scores, polys):
                confidence = float(confidence)
                poly = np.array(poly)
                x1, y1 = int(poly[:, 0].min()), int(poly[:, 1].min())
                x2, y2 = int(poly[:, 0].max()), int(poly[:, 1].max())

                all_text_data.append({
                    "text": text,
                    "confidence": confidence,
                    "bbox": [x1, y1, x2, y2]
                })

                # 패턴 검색: 이 텍스트에 expected_text 패턴이 있는가?
                if self.change_date and not pattern_found:
                    text_normalized = text.replace(" ", "")
                    if re.search(self.change_date, text_normalized):
                        pattern_found = True
        else:
            # Legacy 2.x format fallback: [[box_points, (text, confidence)], ...]
            for line in result[0]:
                box_points, (text, confidence) = line
                confidence = float(confidence)
                xs = [p[0] for p in box_points]
                ys = [p[1] for p in box_points]
                x1, y1 = int(min(xs)), int(min(ys))
                x2, y2 = int(max(xs)), int(max(ys))

                all_text_data.append({
                    "text": text,
                    "confidence": confidence,
                    "bbox": [x1, y1, x2, y2]
                })

                # 패턴 검색
                if self.change_date and not pattern_found:
                    text_normalized = text.replace(" ", "")
                    if re.search(self.change_date, text_normalized):
                        pattern_found = True

        # Step 2: 최종 불량 판정 (패턴 존재 유무만으로)
        is_defect = not pattern_found if self.change_date else False

        # Step 3: 모든 인식된 텍스트마다 DetectionResult 생성 (시각화용)
        #         단, label은 모두 self.class_name으로 통일
        for data in all_text_data:
            detections.append(DetectionResult(
                label=f"text:{self.class_name}",  # 고정된 클래스명 (저장 폴더명)
                confidence=data["confidence"],    # 신뢰도는 기록
                bbox_xyxy=data["bbox"],
                is_defect=is_defect,              # 패턴 존재 여부로 모두 동일
                class_threshold=1.0,              # 의미 없음 (사용 안 함)
            ))

        # Step 4: 텍스트를 못 인식했는데 패턴을 찾고 있으면 → 불량 반환
        #         (all_text_data가 비어있으면 DetectionResult가 없어서
        #          has_defect([])가 False가 되는 문제 방지)
        if not all_text_data and self.change_date:
            detections.append(DetectionResult(
                label=f"text:{self.class_name}",
                confidence=0.0,
                bbox_xyxy=[0, 0, 100, 100],     # 시각화용 더미 박스
                is_defect=True,                  # 텍스트 못 인식 → 불량!
                class_threshold=1.0,
            ))

        return detections

    def draw(
        self,
        image_bgr: np.ndarray,
        detections: List[DetectionResult],
    ) -> np.ndarray:
        """
        Draw OCR results with all recognized texts.
        - Green box: Pattern found (정상) → is_defect=False
        - Red box: Pattern not found (불량) → is_defect=True
        """
        annotated = image_bgr.copy()

        for det in detections:
            x1, y1, x2, y2 = det.bbox_xyxy
            color = (0, 0, 255) if det.is_defect else (0, 200, 0)

            cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)

            # 인식된 텍스트와 신뢰도 표시
            # (label은 이제 class_name으로 통일되어 있음)
            text_from_label = det.label.replace("text:", "")
            display = f"{text_from_label} ({det.confidence:.2f})"
            cv2.putText(
                annotated, display,
                (x1, max(y1 - 8, 0)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1,
            )

        return annotated

    def set_change_date(self, change_date: Optional[str]) -> None:
        """
        Update expected date pattern at runtime.

        Parameters
        ----------
        change_date : str or None
            New date pattern (regex), e.g., "2026\\.02\\.\\d{2}"
        """
        self.change_date = change_date
        if change_date:
            print(f"[Detector:PaddleOCR] Updated change_date pattern: {change_date}")
        else:
            print(f"[Detector:PaddleOCR] Cleared change_date pattern")
