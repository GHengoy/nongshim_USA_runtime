"""
Worker-1 — Custom Inspection Logic (바이브 코딩 가이드)
========================================================

[역할]
이 파일은 Worker-1의 커스텀 검사 로직을 정의합니다.
백엔드가 시작할 때 get_worker()를 호출해 process_frame 함수를 InspectionWorker에 주입합니다.
다른 워커에 영향을 주지 않으므로 자유롭게 수정할 수 있습니다.

[핵심 개념]
1. process_frame() : 프레임당 1회 호출되는 검사 함수
2. _worker_state : 프레임 간 상태를 유지하는 딕셔너리
3. DetectionResult : AI 감지 결과 데이터 구조

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[process_frame 함수 시그니처]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

def process_frame(frame, cropped, *, detector, rejecter, data_manager, config):
    # 파라미터:
    # - frame       : 원본 이미지 (np.ndarray, BGR, 전체 화면)
    # - cropped     : crop_region 적용된 이미지 (crop이 없으면 frame과 동일)
    # - detector    : YoloDetector 등 AI 디텍터 (None이면 collection 모드)
    # - rejecter    : 리젝트 신호 제어 (None이면 collection 모드)
    # - data_manager: 불량 이미지/메타 저장 관리
    # - config      : 라인 설정 (InspectionConfig)

    # 반환값:
    # - annotated   : 시각화된 이미지 (bbox, 텍스트 등 추가)
    # - is_defect   : 불량 여부 (bool)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[DetectionResult 데이터 구조]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

detector.detect(cropped)가 반환하는 리스트:
[
    DetectionResult(
        label="defect",              # 클래스 이름 (str)
        confidence=0.85,             # 신뢰도 0.0~1.0 (float)
        bbox_xyxy=[x1, y1, x2, y2],  # 바운딩 박스 좌표 (List[int])
        is_defect=True,              # 불량 여부 (bool)
        class_threshold=0.70,        # 적용된 임계값 (float)
    ),
    # 여러 개의 감지 결과...
]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[상태 저장소 (_worker_state) 사용법]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

_worker_state 딕셔너리에 프레임 간에 유지할 상태를 저장합니다.

사용 예시:
    # 1. 상태 조회 (초기값 지정 가능)
    prev_center = _get_state("prev_center", None)

    # 2. 상태 업데이트
    _set_state("prev_center", (cx, cy))

    # 3. 상태 초기화 (필요시)
    _reset_state()

활용 예시:
    - 불량 위치 추적 (이전 center, bbox 저장)
    - 연속 불량 감지 (연속 불량 개수 카운트)
    - 불량 타이밍 (마지막 불량 시간 기록)
    - 통계 수집 (누적 불량 수, 신뢰도 변화)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[주의사항]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

❌ 금지 사항:
  - detector, rejecter, data_manager, config 객체 수정 금지
  - process_frame 함수 시그니처 변경 금지
  - 반환값 형태 변경 금지 (반드시 (annotated, is_defect) 튜플)
  - frame 원본 이미지 직접 수정 금지 (annotated에 시각화)

✅ 반드시 할 것:
  - 감지 결과를 항상 반환 (빈 배열이면 정상)
  - 불량 이미지는 data_manager.save_defect() 호출로 저장
  - 정상 이미지는 data_manager.save_normal() 호출로 저장 (선택)
  - 리젝트 신호는 rejecter.push(is_defect=...) 호출로 전송

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[코드 예제]
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

# 예제 1: 불량 위치 추적
if is_defect and detections:
    curr_center = ((detections[0].bbox_xyxy[0] + detections[0].bbox_xyxy[2]) // 2,
                   (detections[0].bbox_xyxy[1] + detections[0].bbox_xyxy[3]) // 2)
    prev_center = _get_state("prev_center")
    if prev_center:
        distance = ((curr_center[0] - prev_center[0])**2 + (curr_center[1] - prev_center[1])**2)**0.5
        print(f"불량 이동 거리: {distance:.1f}px")
    _set_state("prev_center", curr_center)

# 예제 2: 연속 불량 감지
if is_defect:
    consecutive = _get_state("consecutive_defects", 0) + 1
    _set_state("consecutive_defects", consecutive)
    if consecutive >= 5:
        print(f"⚠️ 연속 불량 감지: {consecutive}회")
else:
    _set_state("consecutive_defects", 0)

# 예제 3: 신뢰도 변화 추적
if is_defect and detections:
    curr_conf = detections[0].confidence
    prev_conf = _get_state("prev_confidence", 0.0)
    print(f"신뢰도: {prev_conf:.2f} → {curr_conf:.2f}")
    _set_state("prev_confidence", curr_conf)
"""
import sys
import os

_FW = os.path.join(os.path.dirname(__file__), '..', '..', 'inspection_framework')
if _FW not in sys.path:
    sys.path.insert(0, _FW)

from config import InspectionConfig

config = InspectionConfig.from_json(os.path.join(os.path.dirname(__file__), 'config.json'))


# ══════════════════════════════════════════════════════════════════════════════
#  Worker-1 상태 저장소 (프레임 간 데이터 유지)
#  아래 사전을 확장하여 프레임 간 상태를 유지합니다.
#  예시: 이전 불량 위치, 연속 카운트, 타임스탬프 등
# ══════════════════════════════════════════════════════════════════════════════

_worker_state = {
    # [템플릿] 불량 지점 추적
    # "prev_center": None,           # (x, y)
    # "prev_bbox": None,             # [x1, y1, x2, y2]
    # "distance_history": [],        # 이동 거리 이력

    # [템플릿] 연속 불량 감지
    # "consecutive_defects": 0,      # 연속 불량 개수
    # "max_consecutive": 0,          # 최대 연속 불량 기록

    # [템플릿] 시간/상태 추적
    # "last_defect_time": None,      # 마지막 불량 시각
    # "defect_count_frame": 0,       # 프레임 단위 불량 카운트
}

def _get_state(key, default=None):
    """상태 조회: state['key'] 대신 사용"""
    return _worker_state.get(key, default)

def _set_state(key, value):
    """상태 업데이트: state['key'] = value 대신 사용"""
    _worker_state[key] = value
    return value

def _reset_state():
    """상태 전체 초기화 (필요시 사용)"""
    _worker_state.clear()


# ══════════════════════════════════════════════════════════════════════════════
#  [CUSTOMIZE] Worker-1 전용 커스텀 로직
#  아래 process_frame 함수를 자유롭게 수정하세요. 다른 워커에 영향 없습니다.
# ══════════════════════════════════════════════════════════════════════════════

def process_frame(frame, cropped, *, detector, rejecter, data_manager, config):
    """
    이미지 획득 후 처리 로직.
    - frame        : 카메라 원본 이미지 (전체)
    - cropped      : crop_region 적용 이미지 (없으면 frame 과 동일)
    - detector     : YoloDetector 인스턴스 (collection 모드면 None)
    - rejecter     : Rejecter 인스턴스 (collection 모드면 None)
    - data_manager : DataManager 인스턴스
    - config       : InspectionConfig 인스턴스

    반드시 (annotated_image, is_defect) 튜플을 반환해야 합니다.
    """
    # ── AI 감지 ──────────────────────────────────────────────────────────────
    if detector is not None:
        detections = detector.detect(cropped)
        annotated  = detector.draw(frame, detections)
        is_defect  = detector.has_defect(detections)
    else:
        detections, annotated, is_defect = [], frame, False

    # ── [디버그] 불량 신뢰도 추적 및 출력 ──────────────────────────────────────
    # if is_defect and detections:
    #     curr_confidence = detections[0].confidence  # 현재 불량의 신뢰도
    #     prev_confidence = _get_state("prev_confidence", 0.0)  # 이전 신뢰도 (초기값: 0.0)

    #     # 신뢰도 변화 출력 (flush=True로 버퍼링 방지)
    #     print(f"[Worker-1] 이전 신뢰도: {prev_confidence:.4f} → 현재 신뢰도: {curr_confidence:.4f} "
    #           f"(차이: {curr_confidence - prev_confidence:+.4f})", flush=True)

    #     # 현재 신뢰도를 상태에 저장 (다음 프레임에서 "이전"이 됨)
    #     _set_state("prev_confidence", curr_confidence)
    # else:
    #     # 불량이 없으면 신뢰도를 초기화
    #     _set_state("prev_confidence", 0.0)

    # ── 리젝트 신호 ──────────────────────────────────────────────────────────
    if rejecter is not None:
        # 리젝트 타임을 별도로 계산 하지 않을 시 사용(첫번째 자리에 1을 넣기)
        rejecter.push(is_defect=is_defect)

        # [참고용 — 미사용] 감지 위치(y좌표) 기반 insert_position 계산 예시
        # 필요 시 위 한 줄을 주석 처리하고 아래 블록을 활성화하세요.
        #
        # insert_position = 0
        # if is_defect and detections:
        #     frame_h = frame.shape[0]
        #     y_center = (detections[0].xyxy[0][1] + detections[0].xyxy[0][3]) / 2
        #     y_ratio  = float(y_center) / frame_h           # 0.0 ~ 1.0
        #     insert_position = int(y_ratio * (config.reject_delay_frames - 1))
        # rejecter.push(is_defect=is_defect, insert_position=insert_position)

    # ── 저장 ─────────────────────────────────────────────────────────────────
    if is_defect:
        data_manager.save_defect(
            image=frame, annotated=annotated,
            detections=detections, line_name=config.line_name,
        )
    else:
        # DataManager.__init__ 이 self.save_normal(bool)로 속성을 덮어쓰므로
        # 클래스 메서드를 직접 호출해 우회
        type(data_manager).save_normal(data_manager, frame, config.line_name)

    return annotated, is_defect


# ══════════════════════════════════════════════════════════════════════════════
#  백엔드 인터페이스 — 수정 불필요
# ══════════════════════════════════════════════════════════════════════════════

def get_worker(cfg=None):
    """백엔드에서 호출: InspectionWorker를 반환합니다.
    커스텀 process_frame 함수가 주입됩니다.
    """
    from inspection_worker import InspectionWorker
    return InspectionWorker(cfg if cfg is not None else config, process_fn=process_frame)
