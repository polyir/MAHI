<p align="center">
  <img src="src/assets/mahi.png" alt="MAHI" width="140" />
</p>

<h1 align="center">MAHI 🐟</h1>

<p align="center">
  <b>An agentic IDE for macOS — Persian-art inspired, token-frugal, provider-agnostic.</b><br/>
  <a href="#فارسی">فارسی</a> · English
</p>

---

MAHI is a native macOS desktop IDE (Tauri + React + Rust) with a built-in autonomous coding agent. Point it at any OpenAI-compatible API — Sakana Fugu and Z.AI (GLM) are preconfigured — open a project folder, and ask the agent to explore, edit, run, and verify code for you.

## Features

- **Full agentic loop** — 9 tools (read/write/edit/delete/move files, list, glob, grep-style search, shell commands) with streaming responses and per-action approval dialogs showing diffs
- **Checkpoints & revert** — every turn snapshots files before mutating them; one click restores everything the agent changed
- **Resume after interruption** — rate-limit exhausted or connection dropped mid-task? Smart backoff retries (it even parses the provider's reset timestamp), and a "Continue from here" button rebuilds the exact context
- **Aggressive token economy** — deterministic history compaction (start-of-turn and mid-turn), tool-result caps at the source, duplicate-read dedup, self-calibrating token estimator, configurable context budget, prompt-cache-friendly byte-stable prefixes
- **Multi-provider** — add any OpenAI-compatible endpoint; switch provider/model per chat; keys stay in local storage on your machine, never in the repo
- **Real IDE shell** — Monaco editor with tabs and go-to-line, file explorer, project-wide search, real PTY terminal (zsh), command palette (⌘P / ⌘K), resizable panels
- **Usage awareness** — per-chat token counters (with cached-token split), local 5-hour/weekly window tracking with reset countdown in the status bar, and an in-app browser for the provider's own billing page
- **6 UI languages** — فارسی, English, Русский, 日本語, 中文, Türkçe (switchable in Settings, full RTL support for Persian)
- **Persian-art design** — lapis/turquoise/gold palette and girih patterns inspired by traditional Iranian tilework, with a hand-drawn animated fish while the model thinks, plus a completion chime and native macOS notifications

## Getting started

Requirements: macOS (Apple Silicon), [Node.js](https://nodejs.org) ≥ 20, [Rust](https://rustup.rs)

```bash
git clone https://github.com/polyir/MAHI.git
cd MAHI
npm install
npm run tauri dev        # development
npm run tauri build      # production .app + .dmg
```

On first launch: click the key icon to add your API key(s), open a project folder, and start chatting.

## Security notes

- API keys and chat history live only in the app's local storage on your machine — sharing the app or this repo never shares your keys.
- Sensitive agent actions (shell commands, file writes/deletes) require your approval unless you explicitly enable auto-approve.
- The agent is sandboxed to the workspace folder you open.

## License

[Apache-2.0](LICENSE)

---

<div dir="rtl">

<a name="فارسی"></a>

# ماهی 🐟

**یک IDE ایجنتیک برای مک — با الهام از هنر ایرانی، صرفه‌جو در توکن، و سازگار با هر سرویس API.**

ماهی یک اپ دسکتاپ بومی macOS است (Tauri + React + Rust) با یک ایجنت کدنویسی خودکارِ داخلی. آن را به هر API سازگار با OpenAI وصل کنید — Sakana Fugu و Z.AI از پیش تنظیم شده‌اند — یک پوشه‌ی پروژه باز کنید و از ایجنت بخواهید کد را بررسی، ویرایش، اجرا و راستی‌آزمایی کند.

## امکانات

- **چرخه‌ی ایجنتیک کامل** — ۹ ابزار (خواندن/نوشتن/ویرایش/حذف/جابجایی فایل، جستجوی grep، اجرای دستور شل و…) با پاسخ streaming و دیالوگ تأیید همراه با diff برای هر عمل حساس
- **Checkpoint و برگردانی** — قبل از هر تغییر، از فایل‌ها عکس فوری گرفته می‌شود؛ با یک کلیک همه‌ی تغییرات یک نوبت برمی‌گردد
- **ادامه پس از قطع** — اگر سهمیه تمام شد یا اتصال قطع شد، retry هوشمند با خواندن زمان ریست از خطای سرویس، و دکمه‌ی «ادامه از همین‌جا» با بازسازی دقیق کانتکست
- **صرفه‌جویی جدی در توکن** — فشرده‌سازی قطعیِ تاریخچه (اول و وسط نوبت)، سقف نتیجه‌ی ابزارها در مبدأ، حذف خواندن‌های تکراری، تخمین‌گر خودکالیبره، بودجه‌ی کانتکست قابل تنظیم، و سازگاری با prompt cache
- **چند-سرویسه** — هر endpoint سازگار با OpenAI را اضافه کنید؛ سرویس/مدل برای هر چت قابل انتخاب است؛ کلیدها فقط روی دستگاه شما می‌مانند
- **پوسته‌ی IDE واقعی** — ادیتور Monaco با تب و پرش به خط، مرورگر فایل، جستجو در کل پروژه، ترمینال PTY واقعی، پالت فرمان (⌘P / ⌘K)
- **آگاهی از مصرف** — شمارنده‌ی توکن هر چت (با تفکیک کش‌شده)، ردیابی پنجره‌های ۵ساعته/هفتگی با شمارش معکوس ریست، و مرورگر داخلی برای صفحه‌ی رسمی مصرف سرویس
- **۶ زبان رابط کاربری** — فارسی، انگلیسی، روسی، ژاپنی، چینی و ترکی (از تنظیمات، با پشتیبانی کامل راست‌به‌چپ)
- **طراحی ایرانی** — پالت لاجورد/فیروزه/طلا و نقش گره الهام‌گرفته از کاشی‌کاری، با انیمیشن ماهی هنگام فکر کردن مدل، صدای پایان کار و نوتیفیکیشن بومی مک

## شروع

پیش‌نیازها: مک (Apple Silicon)، Node.js نسخه‌ی ۲۰ به بالا، و Rust

```bash
git clone https://github.com/polyir/MAHI.git
cd MAHI
npm install
npm run tauri dev        # حالت توسعه
npm run tauri build      # خروجی .app و .dmg
```

پس از اولین اجرا: روی آیکون کلید کلیک کنید و کلید API خود را وارد کنید، یک پوشه‌ی پروژه باز کنید و گفتگو را شروع کنید.

## نکات امنیتی

- کلیدهای API و تاریخچه‌ی چت فقط در حافظه‌ی محلی اپ روی دستگاه شما ذخیره می‌شوند — با اشتراک‌گذاری اپ یا این مخزن، کلیدهای شما منتقل نمی‌شوند.
- اعمال حساس ایجنت (دستور شل، نوشتن/حذف فایل) بدون تأیید شما اجرا نمی‌شوند، مگر خودتان اجرای خودکار را فعال کنید.
- دسترسی ایجنت به همان پوشه‌ی پروژه‌ای که باز کرده‌اید محدود است.

## لایسنس

[Apache-2.0](LICENSE)

</div>
