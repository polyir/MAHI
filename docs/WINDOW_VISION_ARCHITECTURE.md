# معماری اجرایی Window Vision در MAHI

## وضعیت

این معماری اکنون پیاده‌سازی شده است:

- Bridge بومی ScreenCaptureKit در `src-tauri/native/window_vision_bridge.m`
- مدیریت allowlist، Sessionها و Tauri commandها در `src-tauri/src/window_vision/`
- UI انتخاب Window/Display در `src/ide/WindowVisionSettings.tsx`
- ابزارهای Agent و راستی‌آزمایی خودکار Studio MCP در `src/agent.ts`
- تشخیص تغییر local، کشف Dialog، Group Capture و پاک‌سازی cache

مسیر استفاده: `تنظیمات چت → دید پنجره‌ای MAHI → دادن مجوز ضبط صفحه`؛ این مجوز فقط یک‌بار داده می‌شود و پس از آن پنجره‌های لازم خودکار پیدا می‌شوند. گزینه «مشاهده موقت نمایشگر» فقط fallback صریح کاربر است.

## تصمیم معماری

MAHI پس از مجوز یک‌باره macOS، پنجرهٔ لازم را خودکار پیدا می‌کند. برنامه‌های حساس و خود MAHI همیشه مسدودند. هر پنجره یک Observation Session مستقل دارد؛ Capture گروهی موقت و Desktop Capture فقط fallback صریح کاربر هستند.

```text
Agent Runtime
  ├── Studio MCPs (عمل)
  └── Observation Coordinator (راستی‌آزمایی)
         └── Tauri WindowVisionManager
                ├── Window Registry
                ├── Session Registry
                ├── Change Detector
                └── macOS Native Bridge
                       ├── ScreenCaptureKit
                       └── Accessibility metadata (اختیاری)
```

اصل مهم: MCP/API منبع اصلی state و Vision ابزار تأیید نتیجه است؛ Vision نباید جای API برنامه را بگیرد.

## مرز مسئولیت‌ها

### Agent Runtime — TypeScript

- انتخاب ابزار کنترل با اولویت `MCP → native API → Accessibility → mouse/keyboard`.
- ساخت Observation قبل از عملیات حساس و Capture بعد از Tool Call.
- ارسال فقط تصویر لازم به مدل Vision.
- توقف Sessionهای موقت پس از پایان عملیات.

### `WindowVisionManager` — Rust/Tauri

- مالک Registry و چرخه عمر Sessionها.
- اعمال allowlist حریم خصوصی.
- تبدیل eventهای native به Tauri event.
- نگهداری آخرین Frame و metadata؛ نه base64 در state فرانت‌اند.
- پاک‌سازی cache و recovery پس از بسته‌شدن/بازشدن پنجره.

### Native Bridge — macOS

- فهرست پنجره‌ها با `SCShareableContent`.
- Capture مستقل با `SCContentFilter(desktopIndependentWindow:)`.
- Capture گروهی با filter مبتنی بر Display و `includingWindows`.
- Stream callback، تشخیص frame ناقص و تغییر filter/configuration.
- نمایش `SCContentSharingPicker` در همان process برنامه.

پیاده‌سازی پیشنهادی Bridge یک لایه Objective-C کوچک با C ABI است که همراه binary اصلی Tauri لینک می‌شود. این روش permission را به خود MAHI نسبت می‌دهد و پشت `#[cfg(target_os = "macos")]` می‌ماند. استفاده از helper process مستقل توصیه نمی‌شود، چون permission و lifecycle جدا ایجاد می‌کند.

## ساختار فایل پیشنهادی

```text
src-tauri/
  build.rs
  native/window_vision_bridge.h
  native/window_vision_bridge.m
  src/window_vision/
    mod.rs          # public module + platform fallback
    types.rs        # DTOها و enumها
    manager.rs      # sessions, registry, cache
    commands.rs     # Tauri commands
    macos.rs        # FFI-safe wrapper

src/ide/
  windowVision.ts   # invoke/event client
  WindowVisionSettings.tsx

src/agent.ts        # tools + post-action verification hook
```

فایل فعلی `src-tauri/src/screenshot.rs` فقط برای Screenshot پنجره MAHI باقی بماند؛ Window Vision ماژول جدا باشد.

## مدل داده

شناسه `window_id` بین اجراهای برنامه پایدار نیست؛ Session باید selector قابل بازیابی هم داشته باشد.

```ts
type WindowSelector = {
  bundleId: string;
  titlePattern?: string;
  role?: "main" | "dialog" | "panel" | "unknown";
  ownerPid?: number;
};

type ObservationSession = {
  id: string;
  selector: WindowSelector;
  boundWindowId?: number;
  mode: "window" | "group";
  priority: "low" | "normal" | "high";
  status: "starting" | "active" | "stale" | "permission_denied" | "failed" | "stopped";
  lastFrameAt?: string;
  lastChangeAt?: string;
  lastFramePath?: string;
  error?: string;
};
```

`WindowRegistry` هر ۱ ثانیه هنگام عملیات فعال و هر ۵ ثانیه در حالت idle تازه شود. برای پنجره تازه، ابتدا `bundleId` و سپس role/title تطبیق داده شود.

## قرارداد ابزارها

نام ابزارهای مدل underscore داشته باشند تا با محدودیت نام functionها سازگار بمانند.

```text
window_list
window_observe
window_observe_group
window_capture
window_wait_for_change
window_detect_dialogs
window_sessions
window_stop
```

نمونه درخواست:

```json
{
  "bundleId": "com.adobe.PremierePro",
  "role": "main",
  "mode": "event_driven",
  "priority": "high",
  "includeCursor": false
}
```

نمونه خروجی `window_capture`:

```json
{
  "sessionId": "obs_01",
  "windowId": 4831,
  "capturedAt": "2026-07-14T12:00:00Z",
  "imagePath": "/private/.../mahi-window-vision/obs_01/latest.png",
  "width": 1920,
  "height": 1080,
  "changed": true,
  "changeScore": 0.18
}
```

مسیر فایل به MCP بینایی فعلی داده می‌شود؛ PNG چندمگابایتی از IPC به شکل base64 عبور نمی‌کند.

## جریان اجرای عملیات

```text
1. Agent پنجره برنامه را register می‌کند.
2. Coordinator یک baseline می‌گیرد.
3. Studio MCP عملیات را اجرا می‌کند.
4. wait_for_change تا timeout منتظر تغییر معنادار می‌ماند.
5. یک Screenshot تازه گرفته می‌شود.
6. فقط در عملیات حساس یا نتیجه مبهم، تصویر به Vision ارسال می‌شود.
7. نتیجه MCP و Vision با هم گزارش می‌شوند.
```

برای عملیات‌هایی مانند Export:

```text
EXPECT_DIALOG
  → registry scan سریع
  → ساخت session مستقل برای dialog جدید
  → انجام/تأیید عملیات
  → بسته‌شدن dialog
  → stop session موقت
```

App-level filter در ScreenCaptureKit به Display وابسته است؛ بنابراین راه اصلی Dialog discovery، ساخت Stream مستقل برای پنجره جدید است. Group/App capture فقط fallback موقت روی Display مشخص است.

## State machine

```text
starting → active → stale → active
    │         │        └── پنجره restore/rebind شد
    │         ├── window closed → stale
    │         └── permission revoked → permission_denied
    └── start error → failed

active/stale/failed → stopped
```

- اگر Frame کامل تا ۲ ثانیه نرسد: `stale`.
- اگر پنجره minimize/بسته شد: Registry تلاش به rebind می‌کند.
- اگر permission رد شد: retry خودکار انجام نشود؛ UI راهنمای کاربر نمایش دهد.
- timeout ابزار نباید Agent را قفل کند؛ خروجی structured با status برگردد.

## تشخیص تغییر

پردازش اولیه کاملاً local است:

1. Frame به thumbnail خاکستری 256px تبدیل شود.
2. hash سریع برای حذف Frame یکسان محاسبه شود.
3. اختلاف ناحیه‌ای برای تغییرهای کوچک UI محاسبه شود.
4. فقط اگر score از threshold گذشت، PNG کامل ذخیره و event منتشر شود.

پیش‌فرض‌ها:

```text
idle sampling:        1 FPS
after tool call:      immediate snapshot + تا 3 ثانیه polling
drag/animation burst: 8 FPS حداکثر 5 ثانیه
meaningful threshold: 0.03 (قابل تنظیم)
```

`SCStream` برای observation فعال استفاده شود؛ تک‌عکس‌های موردی می‌توانند با screenshot API یا گرفتن آخرین Frame انجام شوند. هیچ Frameای مستقیم و پیوسته به مدل فرستاده نشود.

## حریم خصوصی و نگهداری داده

- مجوز Screen Recording فقط با اقدام صریح و یک‌بارهٔ کاربر درخواست شود؛ هیچ command یا refresh پس‌زمینه‌ای نباید prompt ایجاد کند.
- Desktop Capture نیازمند consent جدا و یک‌باره برای همان عملیات است.
- Password manager، Messages و خود MAHI به‌صورت پیش‌فرض deny باشند.
- Frameها در app cache با permission `0700` ذخیره و پس از ۱۰ دقیقه یا پایان Session حذف شوند.
- تصویر، عنوان کامل پنجره و OCR در log نوشته نشود.
- telemetry فقط شامل زمان Capture، ابعاد، status و change score باشد.

## اتصال به Studio MCPها

نگاشت اولیه:

```text
studio-premiere  → com.adobe.PremierePro
studio-photoshop → com.adobe.Photoshop
studio-afterfx   → com.adobe.AfterEffects.application
studio-obs       → com.obsproject.obs-studio
```

در `agent.ts` یک hook بعد از MCP tool call اضافه شود. هر ابزار MCP metadata زیر را می‌تواند داشته باشد:

```ts
type VerificationPolicy = {
  bundleId: string;
  expectedChange: "none" | "window" | "dialog" | "render";
  vision: "never" | "on_ambiguity" | "always";
  timeoutMs: number;
};
```

## فازهای پیاده‌سازی

### فاز 0 — Spike native

- list پنجره‌ها، picker و Capture یک پنجره occluded.
- تست permission در build امضاشده.
- معیار پذیرش: Screenshot درست بدون focus گرفتن و بدون Desktop pixels.

### فاز 1 — MVP

- Registry، session مستقل، allowlist و چهار ابزار list/start/capture/stop.
- اتصال دستی تصویر به MCP Vision.
- معیار پذیرش: Premiere و Photoshop هم‌زمان observe شوند.

### فاز 2 — Event-driven verification

- Change detector، `wait_for_change` و post-MCP hook.
- معیار پذیرش: عملیات MCP بدون ارسال Frame تکراری تأیید شود.

### فاز 3 — Dialog و Group

- کشف پنجره جدید، rebind و group capture موقت.
- معیار پذیرش: Export/Save As بدون Desktop Capture کامل شود.

### فاز 4 — Hardening

- revoke permission، چند Display/Space، minimize/restore، crash recovery و cache cleanup.

## ماتریس تست ضروری

```text
پنجره پشت پنجره دیگر       → Capture ادامه دارد
تغییر Space                → Session مستقل ادامه دارد
انتقال میان Displayها      → Session مستقل ادامه دارد
minimize/restore           → stale سپس active
بازشدن dialog              → session موقت ساخته می‌شود
بسته‌شدن و بازشدن app      → selector دوباره bind می‌شود
permission denied/revoked  → خطای قابل فهم و بدون retry loop
دو app هم‌زمان             → Frameها/sessionها مخلوط نمی‌شوند
```

## خارج از محدوده MVP

- کنترل mouse/keyboard هم‌زمان با کاربر.
- OCR دائمی کل پنجره.
- Capture پیش‌فرض Desktop.
- ذخیره تاریخچه بلندمدت Frameها.
- پشتیبانی Windows/Linux؛ API فعلاً `unsupported_platform` برمی‌گرداند.

## معیار پایان MVP

MVP زمانی تمام است که MAHI بتواند دو پنجره مجاز از دو برنامه را بدون گرفتن focus مشاهده کند، پس از یک MCP Tool Call تغییر را محلی تشخیص دهد، فقط Screenshot مرتبط را برای Vision آماده کند و Dialog تازه را بدون دیدن باقی Desktop ثبت کند.

## منابع فنی

- [SCContentFilter](https://developer.apple.com/documentation/screencapturekit/sccontentfilter)
- [SCStream](https://developer.apple.com/documentation/screencapturekit/scstream)
- [SCContentSharingPicker](https://developer.apple.com/documentation/screencapturekit/sccontentsharingpicker)
