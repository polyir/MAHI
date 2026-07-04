# Changelog / تغییرات

## [Unreleased]

### English

**Rich file previews**
- Markdown/JSON/CSV/TSV files now render (with a raw/rendered toggle) instead of showing raw text.
- Per-file RTL/LTR direction is auto-detected, with a manual override that persists per file.
- Native image, audio, video, and PDF preview in the editor panel, streamed via Tauri's `asset://` protocol so large files (100+ MB) don't choke on base64-over-IPC.

**Embedded browser, now on iframe**
- The preview panel can hold multiple browser tabs alongside file tabs. Originally built on a native child webview; rebuilt on a plain `<iframe>` after the native version proved unfixable in one respect — it always painted above modals/dialogs regardless of z-index. iframe fixes that and drops all the Rust-side window-positioning code that came with it.
- Known trade-off: sites with `X-Frame-Options`/restrictive CSP (Google, banks, many login-gated apps) won't load in an iframe. Accepted knowingly in exchange for a far simpler, more correct implementation.

**Agent access to the browser**
- New tools: `browser_open`, `browser_navigate`, `browser_close`, `browser_screenshot`. View-and-navigate only — an iframe can't read or interact with cross-origin page content by browser security design, so there's no `browser_read`/click/type.
- Off by default; enable in Settings → Providers. Navigate/close require per-call approval.
- `browser_screenshot` captures the whole MAHI window (via `xcap`) rather than cropping to the tab's rect, sidestepping a class of coordinate-transform bugs across windowed/fullscreen modes.

**Media generation**
- `generate_image`, `generate_audio`, `generate_video` agent tools, each routable to a specific provider via a per-provider "role" system — independent of whichever provider is driving the chat itself.

**Independent per-chat projects**
- Each chat now targets its own project directory, completely separate from whatever folder is open in the IDE's file tree/editor.
- New project selector in the chat panel header: switch, add, or remove projects; each project keeps its own set of chats.

**Chat UI: new capabilities**
- Paste a screenshot directly into the chat box (Cmd+V) — downscaled/compressed automatically, shown as a thumbnail, and sent to the model as real vision input (not just a text attachment).
- Live elapsed-time counter (`mm:ss`) next to the "Working…" indicator.
- Context-window usage indicator: current context size (from the API's own reported token count) against the chat's token budget, with a percentage and progress bar.

**Bug fixes**
- Fixed a crash where a screenshot's base64 payload was stored on the persisted chat message — it was being resent to the API on every subsequent call and written to `localStorage` on every save, which could hang the UI or blank the whole window. Screenshots now live in memory only, never in saved history.
- Added a top-level `ErrorBoundary`: an uncaught render error anywhere now shows a recoverable message instead of blanking the entire app.
- Fixed long lines inside fenced code blocks overflowing the chat bubble edge (they now scroll horizontally instead of spilling out).
- Fixed long unbroken words/tokens (URLs, identifiers) overflowing chat bubbles.

---

### فارسی

**پیش‌نمایش غنی فایل‌ها**
- فایل‌های Markdown/JSON/CSV/TSV حالا به‌جای متن خام، رندر می‌شوند (با سوییچ خام/رندرشده).
- جهت راست‌به‌چپ/چپ‌به‌راست هر فایل به‌صورت خودکار تشخیص داده می‌شود، با امکان تغییر دستی که برای هر فایل ذخیره می‌ماند.
- پیش‌نمایش بومی عکس، صدا، ویدیو و PDF در پنل ادیتور، با استریم از طریق پروتکل `asset://` تاوری تا فایل‌های بزرگ (۱۰۰+ مگابایت) روی base64-over-IPC گیر نکنند.

**مرورگر تعبیه‌شده، حالا روی iframe**
- پنل پیش‌نمایش می‌تواند چند تب مرورگر کنار تب‌های فایل داشته باشد. ابتدا روی یک وب‌ویوی فرزند بومی ساخته شد؛ بعد از اینکه نسخه‌ی بومی در یک نکته غیرقابل‌رفع بود — همیشه بالای مودال‌ها/دیالوگ‌ها رندر می‌شد بدون توجه به z-index — با یک `<iframe>` ساده بازسازی شد. iframe این مشکل را حل می‌کند و تمام کد پوزیشن‌دهی سمت Rust را هم حذف می‌کند.
- محدودیت شناخته‌شده: سایت‌هایی با `X-Frame-Options`/CSP محدودکننده (گوگل، بانک‌ها، بسیاری اپ‌های نیازمند لاگین) داخل iframe باز نمی‌شوند. این محدودیت آگاهانه در ازای یک پیاده‌سازی بسیار ساده‌تر و درست‌تر پذیرفته شد.

**دسترسی ایجنت به مرورگر**
- ابزارهای جدید: `browser_open`، `browser_navigate`، `browser_close`، `browser_screenshot`. فقط دیدن و ناوبری — چون به‌دلیل محدودیت امنیتی مرورگرها، iframe نمی‌تواند محتوای صفحات cross-origin را بخواند یا با آن تعامل کند، بنابراین `browser_read`/کلیک/تایپ وجود ندارد.
- پیش‌فرض خاموش؛ از تنظیمات → Providers فعال می‌شود. ناوبری/بستن نیاز به تأیید در هر بار دارند.
- `browser_screenshot` کل پنجره‌ی MAHI را (با `xcap`) می‌گیرد، نه فقط ناحیه‌ی تب مرورگر را، تا از دسته‌ای باگ تبدیل مختصات بین حالت پنجره‌ای و تمام‌صفحه جلوگیری شود.

**تولید رسانه**
- ابزارهای ایجنت `generate_image`، `generate_audio`، `generate_video`، هرکدام قابل مسیردهی به یک سرویس مشخص از طریق سیستم «نقش» مخصوص هر provider — مستقل از سرویسی که خود چت را اداره می‌کند.

**پروژه‌های مستقل برای هر چت**
- هر چت حالا دایرکتوری پروژه‌ی خودش را دارد، کاملاً جدا از پوشه‌ای که در درخت فایل/ادیتور IDE باز است.
- انتخاب‌گر پروژه‌ی جدید در بالای پنل چت: جابه‌جایی، افزودن یا حذف پروژه‌ها؛ هر پروژه چت‌های خودش را نگه می‌دارد.

**رابط چت: قابلیت‌های جدید**
- پیست مستقیم اسکرین‌شات در باکس چت (Cmd+V) — به‌صورت خودکار کوچک/فشرده می‌شود، به‌عنوان thumbnail نشان داده می‌شود، و به‌عنوان ورودی تصویری واقعی (vision) به مدل فرستاده می‌شود، نه فقط یک ضمیمه‌ی متنی.
- شمارنده‌ی زمان زنده (`mm:ss`) کنار نشانگر «در حال کار…».
- نشانگر مصرف پنجره‌ی کانتکست: اندازه‌ی فعلی کانتکست (از تعداد توکن واقعی گزارش‌شده توسط API) در برابر بودجه‌ی توکن آن چت، همراه با درصد و نوار پیشرفت.

**رفع باگ**
- رفع کرش ناشی از ذخیره‌ی تصویر base64 اسکرین‌شات روی پیام ذخیره‌شده‌ی چت — باعث می‌شد در هر فراخوانی بعدی به API دوباره فرستاده شود و در هر ذخیره‌سازی در `localStorage` نوشته شود، که می‌توانست رابط کاربری را قفل یا کل پنجره را سیاه کند. اسکرین‌شات‌ها اکنون فقط در حافظه نگه داشته می‌شوند، هرگز در تاریخچه‌ی ذخیره‌شده.
- افزودن `ErrorBoundary` سراسری: خطای گیرنشده در رندر، هرجای برنامه، حالا یک پیام قابل‌بازیابی نشان می‌دهد، نه سیاه‌شدن کل برنامه.
- رفع بیرون‌زدن خطوط طولانی داخل بلوک‌های کد از لبه‌ی حباب چت (حالا به‌جای بیرون‌زدن، اسکرول افقی می‌گیرند).
- رفع بیرون‌زدن واژه‌های طولانی و بدون فاصله (مثل URL یا شناسه‌ها) از حباب‌های چت.
