# 3D Travel Map

여행 사진/영상 묶음을 3D 지도 위에 시간순 여행 경로로 시각화.

## 동작 방식 (요구사항 그대로)
1. EXIF(사진) / ffprobe(영상)에서 촬영 시간 + GPS 추출
2. GPS+시간 있는 파일들로 경로 틀(anchor route) 구성
3. 시간만 있는 파일은 앞뒤 anchor 사이 시간 가중 보간으로 배치 (같은 장소 체류면 자동 스냅)
4. 한쪽에만 anchor가 있으면 가장 가까운 쪽에 배치, 시간 자체가 없으면 미배치
5. anchor들을 150m 기준으로 장소 클러스터링

## GPS 주의 (sample 실측)
- 정상 GPS(위경도 태그): 129개만 anchor로 사용
- 아이폰 썸네일 복사본(`UUID_1_105_c.jpg`)의 비표준 GPS 태그(0,5,31)는 좌표가 아니라서 **GPS 없음**으로 처리 → 시간 보간 대상
- 영상: `creation_time` + `location(+33.95+130.94/)` 태그 사용

## 실행
```bash
pip install -r backend/requirements.txt
# ffmpeg/ffprobe 필요 (영상 지원용)

python backend/extract.py sample frontend/data/items.json
python backend/build_path.py frontend/data/items.json frontend/data/timeline.json
python backend/thumbs.py frontend/data/items.json sample frontend/data/thumbs

cd frontend && python -m http.server 8000
# http://localhost:8000
```

## 구조
- `backend/extract.py` : 사진(EXIF)+영상(ffprobe) 메타 추출 → `items.json`
- `backend/build_path.py` : 시간 정렬 + anchor/보간 + 장소 클러스터 → `timeline.json`
- `backend/thumbs.py` : 팝업용 썸네일 생성 (사진 리사이즈 / 영상 1초 프레임)
- `frontend/` : CesiumJS(OSM, 토큰 불필요) 3D 지도 + 타임라인 재생 UI
- `sample/` : 테스트 원본 (git 제외, 로컬 전용)
