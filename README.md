# 3D Travel Map

여행 사진/영상 묶음을 실제 3D 지도 위에 시간순 여행 경로로 시각화.

## 바로 쓰기 (배포 주소, 서버 불필요)
**https://supark0403.github.io/3Dtravelmap/**
1. 홈에서 **📂 내 폴더 열기** → 로컬 `travel` 폴더 선택
2. 하위 폴더 1개 = 1개 여행으로 자동 인식, 브라우저가 EXIF를 직접 읽어 경로 구성
3. 사진은 업로드되지 않고 로컬에서만 처리됨 (남이 들어가도 내 사진 안 보임)

> 영상 GPS·HEIC 미리보기는 브라우저 한계로 미지원 (영상은 시간 기준 배치, HEIC는 원본 다운로드 제공)

## 배치 규칙 (step-hold, 보간 없음)
1. EXIF(사진) / ffprobe(영상)에서 촬영 시간 + GPS 추출
2. GPS+시간 파일 = 앵커. 경로선은 앵커끼리만 연결
3. 시간만 있는 사진은 **직전 앵커 위치에 그대로 쌓음** (경로 중간에 배치하지 않음)
4. 첫 앵커보다 이른 사진은 첫 앵커 위치에, 시간이 없으면 미배치
5. 앵커들을 150m 기준으로 장소 클러스터링

## 여행(폴더) 단위
- 입력 폴더의 **하위 폴더 1개 = 1개 여행**. 폴더 안에 넣은 사진들이 그 여행의 경로가 됨
- 하위 폴더가 없으면 폴더 전체가 1개 여행
- 실행하면 여행 목록(홈) → 여행 선택 → 경로/재생 화면

## 실행
```bash
pip install -r backend/requirements.txt
# ffmpeg/ffprobe 필요 (영상 지원용)

python backend/server.py
# http://localhost:8000 — 앱 + 사진/영상 서빙 + 폴더 관리 API
```
서버가 리빌드(스캔→썸네일→경로)를 대신 수행. 썸네일 파일명은 내용 기반 해시라 폴더 이름 변경·재스캔에도 유지됨.
수동 파이프라인도 가능:
```bash
python backend/extract.py travel frontend/data/items.json
python backend/build_path.py frontend/data/items.json frontend/data/trips
python backend/thumbs.py frontend/data/items.json travel frontend/data/thumbs
```

## 프론트엔드 기능
- 홈에서 여행 폴더 추가(+ 새 폴더)/이름 변경(✏️)/삭제(🗑️). 직접지정 위치는 이름 변경 시 자동 이전

## 프론트엔드 기능
- 진짜 3D 지도 (MapLibre, 키 불필요): 건물 돌출 + DEM 지형 + 지구본 뷰
- 지도 3단: 🗺 일반+3D건물 / 🛰 위성+3D건물 / ⛰ 지형(고도×2+음영)
- 재생/정지, 0.5x~4x 속도, 처음 사진으로(⏮), 홈(⌂)
- 구간 속도 기반 이동 아이콘: 🚶 도보/체류, 🚇 탈것, ✈️ 비행기 (🚢는 trip JSON에 `transport:"ship"` 지정 시)
- GPS확정/같은장소/직접지정 배지, 사진 클릭·재생 바 스크럽, 따라가기 토글
- 📍 위치지정: GPS 없는 시작 구간 등을 장소 검색(Nominatim)으로 직접 지정. GPS는 절대 안 건드리고, 브라우저에 저장 + JSON 내보내기/가져오기

## 구조
- `backend/extract.py` : 사진(EXIF)+영상(ffprobe) 추출 → `items.json`
- `backend/build_path.py` : 시간 정렬 + step-hold 배치 → `trips/<여행>.json` + `trips.json`
- `backend/thumbs.py` : 팝업 썸네일 (사진 리사이즈 / 영상 1초 프레임)
- `frontend/` : MapLibre 3D 지도 + 여행/타임라인 UI (OpenFreeMap 벡터, AWS DEM 지형 — 전부 키 불필요)
- `travel/` : 여행 원본 폴더 (하위 폴더 1개 = 1개 여행, git 제외, 로컬 전용)
