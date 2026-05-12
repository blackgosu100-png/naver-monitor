# 네이버 경쟁사 모니터링 — CLAUDE.md

## 실행
```
run.bat  # 서버 시작 + 크롬 자동 실행 (http://localhost:5001)
```

## 구조
- `app.py` — Flask 서버 (포트 5001, Supabase REST 직접 호출)
- `templates/index.html` — 대시보드 SPA (vanilla JS)
- `chrome_extension/` — 크롬 확장프로그램
  - `background.js` — 서비스 워커 (조회 메인 로직, 팝업 닫혀도 실행)
  - `content.js` — MAIN world, fetch/XHR 후킹으로 재고 캐싱
  - `popup.js` — UI, 백그라운드 상태 폴링

## 환경변수 (run.bat에 포함)
- `SUPABASE_URL` — https://itarmufbqvkmdkxhrkfy.supabase.co
- `SUPABASE_ANON_KEY` — Auth 프록시용 anon public JWT
- `SUPABASE_KEY` — service_role JWT
- `PORT` — 5001

## Supabase 테이블
- `competitors` — id, user_id, name, url, created_at
- `stock_history` — user_id, competitor_id, fetch_date, total, options(json), error, fetched_at
- `app_settings` — user_id, key, value (스케줄 설정)

## 크롬 확장프로그램 작동 방식
1. popup에서 버튼 클릭 → background.js에 START_FETCH 메시지
2. background.js가 각 경쟁사 탭을 열고 content.js가 캐싱한 재고 데이터 읽음
3. 결과를 /api/stock-data로 서버에 저장
4. chrome.storage.local로 진행 상태 공유 → popup이 폴링으로 표시

## 주의사항
- `table-wrap`에 `overflow-x:auto` → sticky 컨텍스트 분리됨 (`.m-row.m-head`는 `top:0` 사용)
- 네이버 상품 탭은 반드시 `active:true`로 열어야 데이터 로드됨
- 포트 5000은 로켓그로스 대시보드가 사용 중

## 커밋 규칙
- 기능 단위로 커밋 (완성 즉시)
- `git push`까지 한 번에
