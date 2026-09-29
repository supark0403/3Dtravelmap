# 3D Travel Map

여행 사진 묶음을 3D 지도 위에 시간순 여행 경로로 시각화하는 프로그램.

## 로직
1. EXIF에서 촬영 날짜 + GPS 추출
2. GPS+시간 있는 사진들로 경로 틀 구성
3. GPS 없는 사진은 시간 보간으로 같은 장소 클러스터에 배치
4. 3D 지도(CesiumJS) 위에 시간순 재생

## 구조 (예정)
- `backend/` : EXIF 파서 + 경로 빌더 (Python)
- `frontend/` : CesiumJS 3D 지도 + 타임라인 UI
- `sample/` : 테스트 사진 (Git 추적 제외, 로컬 전용)
