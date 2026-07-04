# Changelog / تغییرات

## [Unreleased]

### English

**Embedded browser rebuilt on iframe**
- Replaced the native child-webview browser with a plain `<iframe>` — it no longer renders on top of modals/dialogs, and no longer needs Rust-side positioning code.
- Removed the Tauri `unstable` feature flag and the old `browser.rs` module.
- Agent tools: `browser_open`, `browser_navigate`, `browser_close`, `browser_screenshot` — view-and-navigate only (an iframe can't read or interact with cross-origin page content by browser design). Off by default; enable in Settings → Providers. Navigate/close still require approval.
- `browser_screenshot` captures the whole MAHI window (via `xcap`) rather than cropping to the browser tab, avoiding a class of coordinate-transform bugs.

**Independent per-chat projects**
- Each chat now targets its own project directory, completely independent of whatever folder is open in the IDE's file tree/editor.
- New project selector in the chat panel header: switch, add, or remove projects; each project keeps its own set of chats.

**Bug fixes**
- Fixed a crash where a screenshot's base64 payload was stored on the persisted message, causing it to be resent to the API on every subsequent call and written to `localStorage` on every save — could hang the UI or blank the whole window. Screenshots now live in memory only.
- Added a top-level `ErrorBoundary`: an uncaught render error now shows a recoverable message instead of blanking the entire app.
- Fixed long lines inside fenced code blocks overflowing the chat bubble edge (code blocks now scroll horizontally instead of spilling out).
- Fixed long unbroken words/tokens overflowing chat bubbles.

**New chat features**
- Paste a screenshot directly into the chat box (Cmd+V) — it's downscaled/compressed automatically and sent to the model as real vision input, not just a text attachment.
- Live elapsed-time counter (`mm:ss`) shown next to the "Working…" indicator.
- Context-window usage indicator: current context size vs. the chat's token budget, with a percentage and progress bar.

**Also in this cycle (previous commit)**
- Rendered previews for Markdown/JSON/CSV files with a raw/rendered toggle, per-file RTL/LTR auto-detection with manual override, and native image/audio/video/PDF preview (via the `asset://` protocol for large files).
- `generate_image` / `generate_audio` / `generate_video` agent tools, routable to a specific provider via a per-provider "role" system independent of the active chat provider.

---

### فارسی

**بازسازی مرورگر داخلی روی iframe**
- مرورگر تعبیه‌شده‌ی مبتنی بر وب‌ویوی بومی با یک `<iframe>` ساده جایگزین شد — دیگر روی مودال‌ها/دیالوگ‌ها رندر نمی‌شود و نیازی به کد پوزیشن‌دهی سمت Rust ندارد.
- فلگ `unstable` تاوری و ماژول قدیمی `browser.rs` حذف شدند.
- ابزارهای ایجنت: `browser_open`، `browser_navigate`، `browser_close`، `browser_screenshot` — فقط دیدن و ناوبری (به‌دلیل محدودیت امنیتی مرورگرها، iframe نمی‌تواند محتوای صفحات cross-origin را بخواند یا با آن‌ها تعامل کند). پیش‌فرض خاموش؛ از تنظیمات → Providers فعال می‌شود. ناوبری/بستن هنوز نیاز به تأیید دارند.
- `browser_screenshot` کل پنجره‌ی MAHI را (با `xcap`) می‌گیرد، نه فقط ناحیه‌ی مرورگر را، تا از دسته‌ای از باگ‌های تبدیل مختصات جلوگیری شود.

**پروژه‌های مستقل برای هر چت**
- هر چت حالا دایرکتوری پروژه‌ی خودش را دارد، کاملاً مستقل از پوشه‌ای که در درخت فایل/ادیتور IDE باز است.
- انتخاب‌گر پروژه‌ی جدید در بالای پنل چت: جابه‌جایی، افزودن یا حذف پروژه‌ها؛ هر پروژه چت‌های خودش را نگه می‌دارد.

**رفع باگ**
- رفع کرش ناشی از ذخیره‌ی تصویر base64 اسکرین‌شات روی پیام ذخیره‌شده که باعث می‌شد در هر فراخوانی بعدی به API دوباره فرستاده شود و در هر ذخیره‌سازی در `localStorage` نوشته شود — می‌توانست رابط کاربری را قفل یا کل پنجره را سیاه کند. اسکرین‌شات‌ها اکنون فقط در حافظه نگه داشته می‌شوند.
- افزودن `ErrorBoundary` سراسری: خطای گیرنشده در رندر حالا یک پیام قابل‌بازیابی نشان می‌دهد، نه سیاه‌شدن کل برنامه.
- رفع بیرون‌زدن خطوط طولانی داخل بلوک‌های کد از لبه‌ی حباب چت (بلوک‌های کد حالا به‌جای بیرون‌زدن، اسکرول افقی می‌گیرند).
- رفع بیرون‌زدن واژه‌های طولانی و بدون فاصله از حباب‌های چت.

**قابلیت‌های جدید چت**
- پیست مستقیم اسکرین‌شات در باکس چت (Cmd+V) — به‌صورت خودکار کوچک/فشرده می‌شود و به‌عنوان ورودی تصویری واقعی (vision) به مدل فرستاده می‌شود، نه فقط یک ضمیمه‌ی متنی.
- شمارنده‌ی زمان زنده (`mm:ss`) کنار نشانگر «در حال کار…».
- نشانگر مصرف پنجره‌ی کانتکست: اندازه‌ی فعلی کانتکست در برابر بودجه‌ی توکن آن چت، همراه با درصد و نوار پیشرفت.

**همچنین در این چرخه (کامیت قبلی)**
- پیش‌نمایش رندرشده برای فایل‌های Markdown/JSON/CSV با سوییچ خام/رندرشده، تشخیص خودکار راست‌به‌چپ/چپ‌به‌راست هر فایل با امکان تغییر دستی، و پیش‌نمایش بومی عکس/صدا/ویدیو/PDF (از طریق پروتکل `asset://` برای فایل‌های بزرگ).
- ابزارهای ایجنت `generate_image`/`generate_audio`/`generate_video`، قابل مسیردهی به یک سرویس مشخص از طریق سیستم «نقش» مستقل از سرویس فعال چت.
