# 강사용 전달 체크리스트

수강생에게 전달하기 전에 아래 항목을 확인하세요.

## 1. 웹앱 배포 확인

- Railway 또는 배포 서버에서 앱이 열리는지 확인합니다.
- Supabase 환경변수가 설정되어 있는지 확인합니다.
- 회원가입과 로그인이 되는지 확인합니다.
- 테스트 계정으로 경쟁사 URL 등록이 되는지 확인합니다.
- `전체 조회` 버튼을 눌렀을 때 확장프로그램 조회 대기열이 등록되는지 확인합니다.

## 2. Supabase 설정 확인

Supabase에서 아래 SQL이 적용되어 있어야 합니다.

- `supabase_schema.sql`
- `supabase_auth_migration.sql`
- `supabase_fetch_key_migration.sql`
- `supabase_product_image_migration.sql`

Authentication 설정에서 Email provider가 켜져 있어야 합니다.

## 3. 수강생에게 전달할 파일

수강생에게 아래 3가지를 전달합니다.

- 웹앱 접속 URL
- `naver-monitor-extension.zip`
- `STUDENT_INSTALL_GUIDE.md` 또는 같은 내용의 안내문

## 4. 확장프로그램 전달 방식

현재는 Chrome Web Store 등록 전 단계이므로 개발자 모드 설치 방식으로 안내합니다.

수강생은 압축을 푼 뒤 `chrome_extension` 폴더를 선택해야 합니다. zip 파일 자체를 선택하면 설치되지 않습니다.

## 5. 수업 중 추천 진행 순서

1. 웹앱 접속과 회원가입을 먼저 진행합니다.
2. 경쟁사 URL 1개를 등록하게 합니다.
3. 확장프로그램을 설치하게 합니다.
4. 확장프로그램에 서버 주소와 계정을 입력해 로그인하게 합니다.
5. `경쟁사 재고 전체 조회`를 실행합니다.
6. 웹앱을 새로고침해서 결과가 저장되는지 확인합니다.

## 6. 수강생에게 강조할 점

- 매일 같은 시간에 조회해야 24시간 판매량 비교가 정확합니다.
- 네이버가 인증 화면을 띄우면 사람이 직접 통과해야 합니다.
- 조회 결과는 계정별로 분리됩니다.
- URL을 새로 추가한 직후 조회하면 그 시간의 스냅샷이 새로 저장됩니다.

## 7. 배포 URL이 바뀌는 경우

Railway 기본 도메인(`*.up.railway.app`, `*.railway.app`)은 확장프로그램 권한에 포함되어 있습니다.

커스텀 도메인을 쓰는 경우 `chrome_extension/manifest.json`의 `host_permissions`에 해당 도메인을 추가한 뒤 확장프로그램 zip을 다시 만들어야 합니다.

예시:

```json
"https://monitor.example.com/*"
```

