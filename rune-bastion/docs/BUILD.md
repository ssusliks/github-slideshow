# Сборка, запуск и публикация

## Требования

| Что | Версия |
|---|---|
| Node.js | 22 или новее |
| JDK | 21 (для Android) |
| Android SDK | платформа 36, build-tools 36 |
| macOS + Xcode | 16 или новее (только для iOS) |

## Запуск для разработки

```bash
cd rune-bastion/game
```

```bash
npm install
```

```bash
npm run dev
```

В режиме разработки включены тестовая реклама (экран с обратным отсчётом) и тестовый магазин
(окно подтверждения вместо оплаты).

## Тесты

Модульные и балансовые:

```bash
npm test
```

Только баланс, с отчётом:

```bash
npm run balance
```

Сквозные тесты (сами запускают сервер разработки и сервер игры; нужен Playwright с Chromium):

```bash
npm run e2e
```

Проверка релизной сборки:

```bash
npm run build
```

```bash
npx vite preview --port 4173
```

```bash
node e2e/release-check.mjs
```

Тесты сервера:

```bash
cd rune-bastion/server
```

```bash
npm test
```

## Сервер (необязателен)

Без сервера игра полностью играбельна; недоступны облачные сохранения, аккаунты и серверная
проверка покупок.

```bash
cd rune-bastion/server
```

```bash
PORT=8787 node src/main.mjs
```

Переменные окружения сервера:

| Переменная | Назначение |
|---|---|
| `PORT`, `DATA_FILE` | порт и файл данных |
| `GOOGLE_CLIENT_IDS`, `APPLE_CLIENT_IDS` | допустимые идентификаторы приложений для входа через Google / Apple (через запятую) |
| `GOOGLE_SERVICE_ACCOUNT_JSON`, `ANDROID_PACKAGE_NAME` | проверка покупок Google Play |
| `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`, `APPLE_BUNDLE_ID` | проверка покупок App Store |
| `ALLOW_SANDBOX_IAP=1` | только для разработки: принимать тестовые покупки |

Сервер должен работать по HTTPS (за обратным прокси).

## Настройка клиента

Параметры задаются переменными `VITE_*` при сборке (файл `game/.env.production`):

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `VITE_API_URL` | адрес сервера | пусто — облако выключено |
| `VITE_ADMOB_REWARDED_ANDROID`, `VITE_ADMOB_REWARDED_IOS` | рекламные блоки | тестовые блоки Google |
| `VITE_ADMOB_TESTING` | `0` — боевая реклама | тестовый режим |
| `VITE_GOOGLE_WEB_CLIENT_ID`, `VITE_GOOGLE_IOS_CLIENT_ID`, `VITE_APPLE_CLIENT_ID` | вход через Google / Apple | пусто |
| `VITE_SIGNING_CERT_SHA256` | отпечаток релизного сертификата Android для проверки целостности | пусто — проверка подписи выключена |
| `VITE_SUPPORT_EMAIL`, `VITE_PRIVACY_URL` | почта поддержки, ссылка на политику | заглушки |

Идентификатор приложения AdMob (не блока) задаётся в нативных проектах:
`android/app/src/main/res/values/strings.xml` (`admob_app_id`) и `ios/App/App/Info.plist`
(`GADApplicationIdentifier`). Сейчас там тестовые идентификаторы Google.

## Android

Сборка, которой получен `builds/rune-bastion-1.0.0-debug.apk`:

```bash
cd rune-bastion/game
```

```bash
npm run build
```

```bash
npx cap sync android
```

```bash
echo "sdk.dir=$ANDROID_HOME" > android/local.properties
```

```bash
cd android && gradle assembleDebug
```

Результат: `android/app/build/outputs/apk/debug/app-debug.apk`. Сборка выполнялась установленным
Gradle 8.14.3; обёртка `./gradlew` настроена на ту же версию, но здесь не запускалась.

Релиз для Google Play:

1. Создайте ключ подписи и пропишите `signingConfigs` в `android/app/build.gradle`.
2. Увеличьте `versionCode` и `versionName`.
3. Соберите пакет: `./gradlew bundleRelease` (файл `.aab`).
4. Получите отпечаток SHA-256 сертификата и задайте `VITE_SIGNING_CERT_SHA256`, пересоберите.

## iOS

Проект лежит в `game/ios` и здесь **не собирался**. На Mac:

```bash
cd rune-bastion/game
```

```bash
npm install && npm run build && npx cap sync ios
```

```bash
npx cap open ios
```

В Xcode: выберите команду разработчика (Signing & Capabilities), добавьте возможности
In-App Purchase и Sign in with Apple, соберите на устройство. Зависимости подключаются через
Swift Package Manager автоматически.

Нативная проверка подписи и температуры реализована только для Android; на iOS работает
проверка файлов сборки и оценка перегрева по падению частоты кадров.

## Публикация

Общее для обоих магазинов:

1. Замените тестовые идентификаторы AdMob на свои.
2. Создайте товары с идентификаторами `gems_small`, `gems_medium`, `gems_large` (расходуемые),
   `starter_pack`, `premium` (нерасходуемые).
3. Разверните сервер, задайте `VITE_API_URL` и ключи проверки покупок.
4. Разместите политику конфиденциальности (основа — [PRIVACY.md](PRIVACY.md)) и укажите ссылку.
5. Замените значок и заставку приложения (сейчас стандартные значки Capacitor).
6. Пройдите игру на реальных устройствах (см. список в [TEST_REPORT.md](TEST_REPORT.md)).

Google Play: заполните анкету «Безопасность данных» (рекламный идентификатор, покупки,
необязательный адрес почты), возрастной рейтинг, загрузите `.aab` во внутреннее тестирование.

App Store: заполните «Конфиденциальность приложения», настройте диалог отслеживания (текст уже
есть в `Info.plist`), загрузите сборку через Xcode в TestFlight. Требование Apple выполнено:
удаление аккаунта доступно из настроек игры.
