# 수강생용 배포 안내

## 서비스 구조

- 선생님이 Flask 서버와 Supabase 프로젝트를 1개 운영합니다.
- 수강생은 Supabase에 직접 가입하지 않습니다.
- 수강생은 배포된 웹사이트에서 이메일/비밀번호로 회원가입 또는 로그인합니다.
- 경쟁사 목록, 재고 조회 기록, 스케줄 설정은 Supabase Auth `user_id` 기준으로 분리됩니다.

## Supabase 설정

1. 새 Supabase 프로젝트면 `supabase_schema.sql`을 실행합니다.
2. 기존 단일 관리자 DB를 업그레이드하는 경우 `supabase_auth_migration.sql`을 실행합니다.
3. Authentication > Providers에서 Email 로그인을 켭니다.
4. 필요하면 이메일 인증 여부를 수업 운영 방식에 맞게 설정합니다.
5. Project Settings > API에서 아래 값을 확인합니다.
   - `Project URL`
   - `anon public key`
   - `service_role key`

## 서버 환경변수

배포 서버(Railway 등)에 아래 환경변수를 설정합니다.

```text
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=anon_public_key
SUPABASE_KEY=service_role_key
SECRET_KEY=random_long_secret
PORT=5001
```

`SUPABASE_KEY`는 서버에서만 사용합니다. 크롬 확장이나 프론트에는 service role key가 내려가지 않습니다.
Auth 로그인/회원가입/토큰 갱신은 서버가 프록시하며, `SUPABASE_ANON_KEY`가 있으면 Auth 요청에는 anon key를 사용합니다.

## 수강생 사용 흐름

1. 배포된 웹사이트에 접속합니다.
2. 이메일/비밀번호로 회원가입합니다.
3. 로그인 후 경쟁사 상품 URL을 등록합니다.
4. 크롬 확장 프로그램을 설치합니다.
5. 확장 팝업에 배포 서버 주소와 같은 계정 정보를 입력해 로그인합니다.
6. 확장에서 전체 조회를 실행합니다.

## 크롬 확장

확장 팝업의 서버 주소에는 배포된 Flask 서버 주소를 입력합니다.

예:

```text
https://your-app.up.railway.app
```

Railway가 아닌 다른 도메인에 배포하는 경우 `chrome_extension/manifest.json`의 `host_permissions`에 해당 도메인을 추가해야 합니다.
