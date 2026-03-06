"""
detector_yolo.py — YOLO Object Detection Plugin
=================================================

[Role]
    YOLOv12 model-based defect detection.
    Extracted from the original detector.py as a plugin.

[Usage]
    Automatically loaded by create_detector("yolo", ...).
    Can also be imported directly:
        from detector_yolo import YoloDetector
"""

import numpy as np
from typing import Dict, List, Optional

from detector import BaseDetector, DetectionResult, register_detector


@register_detector("yolo")
class YoloDetector(BaseDetector):
    """
    YOLOv12 (Ultralytics) real-time detector.

    Usage
    -----
    detector = YoloDetector(
        model_path='best.pt',
        class_thresholds={
            "defect":  0.70,
            "pinhole": 0.85,
            "scratch": 0.60,
        },
    )

    results = detector.detect(image_bgr)
    for r in results:
        print(r.label, r.confidence, r.is_defect, r.class_threshold)

    annotated = detector.draw(image_bgr, results)
    """

    def __init__(
        self,
        model_path: str,
        class_thresholds: Optional[Dict[str, float]] = None,
        device: str = 'cuda',
        detector_config: Optional[Dict] = None,
    ):
        """
        Parameters
        ----------
        model_path       : YOLOv12 weights file (.pt)
        class_thresholds : Per-class confidence thresholds.
                           {"class_name": threshold}
                           None = treat all detections as defects at 0.50.
        device           : 'cuda' or 'cpu'.
        detector_config  : (unused for YOLO)
        """
        # Lazy import — only load ultralytics when YOLO is actually used
        from ultralytics import YOLO
        from ultralytics.utils.torch_utils import select_device

        self.model_path = model_path
        self.class_thresholds = class_thresholds

        if class_thresholds:
            self._global_min_conf = min(class_thresholds.values())
        else:
            self._global_min_conf = 0.50

        # select_device must be called before model.to() to properly set
        # CUDA_VISIBLE_DEVICES. Without this, if another thread previously
        # called select_device("cpu") (which sets CUDA_VISIBLE_DEVICES=""),
        # model.to("cuda") raises "No CUDA GPUs are available".
        actual_device = select_device(device)
        self.device = str(actual_device)

        print(f"[Detector:YOLO] Loading model: {model_path}")
        self._model = YOLO(model_path)
        self._model.to(actual_device)
        if class_thresholds:
            print(f"[Detector:YOLO] Class thresholds: {class_thresholds}")
        print(f"[Detector:YOLO] Ready. Device: {device}")

    # ------------------------------------------------------------------
    # Public Methods
    # ------------------------------------------------------------------

    def detect(self, image_bgr: np.ndarray) -> List[DetectionResult]:
        """
        Run YOLO inference on image and return detection results.

        Parameters
        ----------
        image_bgr : OpenCV BGR image (np.ndarray)

        Returns
        -------
        List[DetectionResult]
        """
        if image_bgr is None:
            return []

        raw_results = self._model.predict(
            source=image_bgr,
            conf=self._global_min_conf,
            device=self.device,
            verbose=False,
        )

        detections: List[DetectionResult] = []

        for box in raw_results[0].boxes:
            label      = self._model.names[int(box.cls)]
            confidence = float(box.conf)
            x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]

            if self.class_thresholds is None:
                threshold = 0.50
                is_defect = confidence >= threshold
            elif label in self.class_thresholds:
                threshold = self.class_thresholds[label]
                is_defect = confidence >= threshold
            else:
                threshold = self._global_min_conf
                is_defect = False

            detections.append(
                DetectionResult(
                    label=label,
                    confidence=confidence,
                    bbox_xyxy=[x1, y1, x2, y2],
                    is_defect=is_defect,
                    class_threshold=threshold,
                )
            )

        return detections

    def set_class_thresholds(self, class_thresholds: Optional[Dict[str, float]]) -> None:
        """
        Update class thresholds at runtime.

        Parameters
        ----------
        class_thresholds : dict or None
            New class thresholds (e.g., {"defect": 0.70, "pinhole": 0.85})
        """
        self.class_thresholds = class_thresholds
        if class_thresholds:
            self._global_min_conf = min(class_thresholds.values())
            print(f"[Detector:YOLO] Updated class thresholds: {class_thresholds}")
        else:
            self._global_min_conf = 0.50
            print(f"[Detector:YOLO] Cleared class thresholds")
