// Lightweight i18n: a string table for 6 languages, a module-level current
// language with subscribers, and a useLang() hook so components re-render
// instantly when the user switches language in Settings. Persian is RTL;
// everything else is LTR.
import { useEffect, useReducer } from "react";

export type Lang = "fa" | "en" | "ru" | "ja" | "zh" | "tr";

export const LANGS: Record<Lang, string> = {
  fa: "فارسی",
  en: "English",
  ru: "Русский",
  ja: "日本語",
  zh: "中文",
  tr: "Türkçe",
};

const LANG_KEY = "mahi_lang";
const stored = localStorage.getItem(LANG_KEY);
let current: Lang = stored && stored in LANGS ? (stored as Lang) : "fa";

const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang) {
  current = l;
  localStorage.setItem(LANG_KEY, l);
  listeners.forEach((f) => f());
}

export function isRTL(): boolean {
  return current === "fa";
}

export function dir(): "rtl" | "ltr" {
  return isRTL() ? "rtl" : "ltr";
}

/// Subscribe a component to language changes.
export function useLang(): Lang {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const f = () => force();
    listeners.add(f);
    return () => {
      listeners.delete(f);
    };
  }, []);
  return current;
}

type Entry = Record<Lang, string>;

const S = {
  // ---- shell / welcome ----
  welcomeSub: {
    fa: "محیط توسعه‌ی ایجنتیک",
    en: "Agentic development environment",
    ru: "Агентная среда разработки",
    ja: "エージェント型開発環境",
    zh: "智能体开发环境",
    tr: "Ajan tabanlı geliştirme ortamı",
  },
  openFolder: {
    fa: "باز کردن پوشه پروژه",
    en: "Open project folder",
    ru: "Открыть папку проекта",
    ja: "プロジェクトフォルダを開く",
    zh: "打开项目文件夹",
    tr: "Proje klasörünü aç",
  },
  recentProjects: {
    fa: "پروژه‌های اخیر",
    en: "Recent projects",
    ru: "Недавние проекты",
    ja: "最近のプロジェクト",
    zh: "最近的项目",
    tr: "Son projeler",
  },
  files: { fa: "فایل‌ها", en: "Files", ru: "Файлы", ja: "ファイル", zh: "文件", tr: "Dosyalar" },
  searchInProject: {
    fa: "جستجو در پروژه",
    en: "Search in project",
    ru: "Поиск по проекту",
    ja: "プロジェクト内を検索",
    zh: "在项目中搜索",
    tr: "Projede ara",
  },
  terminal: { fa: "ترمینال", en: "Terminal", ru: "Терминал", ja: "ターミナル", zh: "终端", tr: "Terminal" },
  aiChat: { fa: "چت هوش مصنوعی", en: "AI chat", ru: "ИИ-чат", ja: "AIチャット", zh: "AI 聊天", tr: "Yapay zekâ sohbeti" },
  usageLimit: {
    fa: "مصرف و محدودیت",
    en: "Usage & limits",
    ru: "Использование и лимиты",
    ja: "使用量と制限",
    zh: "用量与限制",
    tr: "Kullanım ve limitler",
  },
  quickOpenTitle: {
    fa: "جستجوی فایل (⌘P)",
    en: "Quick open (⌘P)",
    ru: "Быстрое открытие (⌘P)",
    ja: "クイックオープン (⌘P)",
    zh: "快速打开 (⌘P)",
    tr: "Hızlı aç (⌘P)",
  },
  apiService: { fa: "سرویس API", en: "API provider", ru: "API-провайдер", ja: "APIプロバイダ", zh: "API 服务商", tr: "API sağlayıcı" },
  model: { fa: "مدل", en: "Model", ru: "Модель", ja: "モデル", zh: "模型", tr: "Model" },
  manageProviders: {
    fa: "مدیریت سرویس‌های API",
    en: "Manage API providers",
    ru: "Управление API-провайдерами",
    ja: "APIプロバイダの管理",
    zh: "管理 API 服务商",
    tr: "API sağlayıcılarını yönet",
  },
  noKey: { fa: "بدون کلید", en: "no key", ru: "нет ключа", ja: "キーなし", zh: "无密钥", tr: "anahtar yok" },
  noFolder: { fa: "بدون پوشه", en: "no folder", ru: "нет папки", ja: "フォルダなし", zh: "无文件夹", tr: "klasör yok" },
  tokens: { fa: "توکن", en: "tokens", ru: "токенов", ja: "トークン", zh: "令牌", tr: "jeton" },
  reset5h: { fa: "ریست ۵س", en: "5h reset", ru: "сброс 5ч", ja: "5h リセット", zh: "5小时重置", tr: "5s sıfırlama" },
  weekly: { fa: "هفتگی", en: "Weekly", ru: "Неделя", ja: "週間", zh: "每周", tr: "Haftalık" },
  saved: { fa: "ذخیره شد", en: "Saved", ru: "Сохранено", ja: "保存しました", zh: "已保存", tr: "Kaydedildi" },
  saveError: { fa: "خطا در ذخیره", en: "Save failed", ru: "Ошибка сохранения", ja: "保存に失敗", zh: "保存失败", tr: "Kaydetme hatası" },
  openError: { fa: "باز نشد", en: "Could not open", ru: "Не удалось открыть", ja: "開けません", zh: "无法打开", tr: "Açılamadı" },
  // ---- palette ----
  palOpenFolder: { fa: "باز کردن پوشه…", en: "Open folder…", ru: "Открыть папку…", ja: "フォルダを開く…", zh: "打开文件夹…", tr: "Klasör aç…" },
  palTerminal: {
    fa: "ترمینال: نمایش/مخفی",
    en: "Terminal: toggle",
    ru: "Терминал: показать/скрыть",
    ja: "ターミナル: 表示/非表示",
    zh: "终端：显示/隐藏",
    tr: "Terminal: göster/gizle",
  },
  palChat: {
    fa: "چت: نمایش/مخفی",
    en: "Chat: toggle",
    ru: "Чат: показать/скрыть",
    ja: "チャット: 表示/非表示",
    zh: "聊天：显示/隐藏",
    tr: "Sohbet: göster/gizle",
  },
  palSave: { fa: "ذخیره فایل فعال", en: "Save active file", ru: "Сохранить активный файл", ja: "現在のファイルを保存", zh: "保存当前文件", tr: "Etkin dosyayı kaydet" },
  palFilePlaceholder: { fa: "پرش به فایل…", en: "Go to file…", ru: "Перейти к файлу…", ja: "ファイルへ移動…", zh: "跳转到文件…", tr: "Dosyaya git…" },
  palActionPlaceholder: { fa: "اجرای دستور…", en: "Run command…", ru: "Выполнить команду…", ja: "コマンドを実行…", zh: "运行命令…", tr: "Komut çalıştır…" },
  noResults: { fa: "نتیجه‌ای نیست", en: "No results", ru: "Нет результатов", ja: "結果なし", zh: "无结果", tr: "Sonuç yok" },
  // ---- search panel ----
  searchPlaceholder: { fa: "عبارت جستجو…", en: "Search query…", ru: "Поисковый запрос…", ja: "検索語…", zh: "搜索词…", tr: "Arama ifadesi…" },
  searching: { fa: "در حال جستجو…", en: "Searching…", ru: "Поиск…", ja: "検索中…", zh: "搜索中…", tr: "Aranıyor…" },
  notFound: { fa: "نتیجه‌ای یافت نشد", en: "Nothing found", ru: "Ничего не найдено", ja: "見つかりません", zh: "未找到", tr: "Bulunamadı" },
  // ---- file tree / editor ----
  noFolderSelected: { fa: "پوشه‌ای انتخاب نشده", en: "No folder selected", ru: "Папка не выбрана", ja: "フォルダ未選択", zh: "未选择文件夹", tr: "Klasör seçilmedi" },
  loading: { fa: "در حال بارگذاری…", en: "Loading…", ru: "Загрузка…", ja: "読み込み中…", zh: "加载中…", tr: "Yükleniyor…" },
  editorEmpty: {
    fa: "فایلی از سایدبار باز کن (⌘P) یا از دستیار بخواه کاری انجام بده",
    en: "Open a file from the sidebar (⌘P) or ask the assistant to do something",
    ru: "Откройте файл из панели (⌘P) или попросите ассистента что-нибудь сделать",
    ja: "サイドバーからファイルを開く（⌘P）か、アシスタントに依頼してください",
    zh: "从侧边栏打开文件 (⌘P)，或让助手为你完成任务",
    tr: "Kenar çubuğundan bir dosya aç (⌘P) veya asistandan bir şey iste",
  },
  // ---- chat ----
  assistant: { fa: "دستیار", en: "Assistant", ru: "Ассистент", ja: "アシスタント", zh: "助手", tr: "Asistan" },
  newChat: { fa: "گفتگوی جدید", en: "New chat", ru: "Новый чат", ja: "新しいチャット", zh: "新对话", tr: "Yeni sohbet" },
  history: { fa: "تاریخچه", en: "History", ru: "История", ja: "履歴", zh: "历史", tr: "Geçmiş" },
  settings: { fa: "تنظیمات", en: "Settings", ru: "Настройки", ja: "設定", zh: "设置", tr: "Ayarlar" },
  inputPlaceholder: { fa: "چه کاری انجام بدم؟", en: "What should I do?", ru: "Что мне сделать?", ja: "何をしましょうか？", zh: "要我做什么？", tr: "Ne yapayım?" },
  openFolderFirst: { fa: "اول یک پوشه باز کن", en: "Open a folder first", ru: "Сначала откройте папку", ja: "まずフォルダを開いてください", zh: "请先打开一个文件夹", tr: "Önce bir klasör aç" },
  emptyChatHint: {
    fa: "یک درخواست بنویس تا شروع کنیم",
    en: "Write a request to get started",
    ru: "Напишите запрос, чтобы начать",
    ja: "リクエストを書いて始めましょう",
    zh: "写下请求即可开始",
    tr: "Başlamak için bir istek yaz",
  },
  mentionHint: {
    fa: "با @ می‌تونی فایل ضمیمه کنی",
    en: "Use @ to attach a file",
    ru: "Используйте @, чтобы прикрепить файл",
    ja: "@ でファイルを添付できます",
    zh: "使用 @ 可附加文件",
    tr: "@ ile dosya ekleyebilirsin",
  },
  working: { fa: "در حال کار…", en: "Working…", ru: "Работаю…", ja: "作業中…", zh: "处理中…", tr: "Çalışıyor…" },
  continueHere: { fa: "ادامه از همین‌جا", en: "Continue from here", ru: "Продолжить отсюда", ja: "ここから続行", zh: "从此处继续", tr: "Buradan devam et" },
  revertTurn: {
    fa: "برگرداندن تغییرات این نوبت",
    en: "Revert this turn's changes",
    ru: "Откатить изменения этого шага",
    ja: "このターンの変更を元に戻す",
    zh: "撤销本轮更改",
    tr: "Bu turun değişikliklerini geri al",
  },
  cachedCheap: { fa: "کش‌شده (ارزان)", en: "cached (cheap)", ru: "из кэша (дешевле)", ja: "キャッシュ済（低コスト）", zh: "已缓存（便宜）", tr: "önbellekten (ucuz)" },
  autoApproveOn: { fa: "⚠️ اجرای خودکار", en: "⚠️ auto-approve", ru: "⚠️ автоподтверждение", ja: "⚠️ 自動承認", zh: "⚠️ 自动批准", tr: "⚠️ otomatik onay" },
  stoppedMsg: {
    fa: "⏹ متوقف شد — با دکمه «ادامه» می‌توانی از همین‌جا ادامه بدهی.",
    en: "⏹ Stopped — use the Continue button to resume from here.",
    ru: "⏹ Остановлено — нажмите «Продолжить», чтобы возобновить.",
    ja: "⏹ 停止しました — 「続行」ボタンで再開できます。",
    zh: "⏹ 已停止 — 点击「继续」可从此处恢复。",
    tr: "⏹ Durduruldu — «Devam» düğmesiyle buradan sürdürebilirsin.",
  },
  disconnectedPrefix: { fa: "⚠️ قطع شد", en: "⚠️ Interrupted", ru: "⚠️ Прервано", ja: "⚠️ 中断されました", zh: "⚠️ 已中断", tr: "⚠️ Kesildi" },
  disconnectToast: {
    fa: "ارتباط قطع شد — با «ادامه» از همین‌جا ادامه بده",
    en: "Connection lost — use Continue to resume",
    ru: "Связь потеряна — нажмите «Продолжить»",
    ja: "接続が切れました — 「続行」で再開",
    zh: "连接中断 — 点击「继续」恢复",
    tr: "Bağlantı koptu — «Devam» ile sürdür",
  },
  enterApiKeyFor: {
    fa: "کلید API این سرویس را وارد کن (آیکون کلید در نوار بالا):",
    en: "Enter the API key for this provider (key icon in the top bar):",
    ru: "Введите API-ключ провайдера (значок ключа сверху):",
    ja: "このプロバイダのAPIキーを入力してください（上部のキーアイコン）:",
    zh: "请输入该服务商的 API 密钥（顶部钥匙图标）：",
    tr: "Bu sağlayıcının API anahtarını gir (üstteki anahtar simgesi):",
  },
  revertedN: { fa: "فایل برگردانده شد:", en: "file(s) reverted:", ru: "файл(ов) восстановлено:", ja: "個のファイルを復元:", zh: "个文件已恢复：", tr: "dosya geri alındı:" },
  nothingToRevert: { fa: "تغییری برای برگرداندن نبود", en: "Nothing to revert", ru: "Нечего откатывать", ja: "元に戻す変更なし", zh: "没有可撤销的更改", tr: "Geri alınacak değişiklik yok" },
  revertError: { fa: "خطا در برگرداندن", en: "Revert failed", ru: "Ошибка отката", ja: "復元に失敗", zh: "撤销失败", tr: "Geri alma hatası" },
  taskDoneTitle: { fa: "MAHI کارش تمام شد", en: "MAHI finished the task", ru: "MAHI завершил задачу", ja: "MAHI がタスクを完了", zh: "MAHI 已完成任务", tr: "MAHI görevi bitirdi" },
  taskDoneBody: { fa: "تسک به پایان رسید.", en: "The task is complete.", ru: "Задача выполнена.", ja: "タスクが完了しました。", zh: "任务已完成。", tr: "Görev tamamlandı." },
  attachFile: { fa: "ضمیمه فایل", en: "Attach file", ru: "Прикрепить файл", ja: "ファイルを添付", zh: "附加文件", tr: "Dosya ekle" },
  send: { fa: "ارسال", en: "Send", ru: "Отправить", ja: "送信", zh: "发送", tr: "Gönder" },
  stop: { fa: "توقف", en: "Stop", ru: "Стоп", ja: "停止", zh: "停止", tr: "Durdur" },
  withAttachment: { fa: "📎 با فایل ضمیمه", en: "📎 with attachment", ru: "📎 с вложением", ja: "📎 添付ファイルあり", zh: "📎 含附件", tr: "📎 ekli dosya var" },
  compacted: {
    fa: "تاریخچه برای صرفه‌جویی فشرده شد…",
    en: "History compacted to save tokens…",
    ru: "История сжата для экономии…",
    ja: "トークン節約のため履歴を圧縮…",
    zh: "已压缩历史以节省令牌…",
    tr: "Jeton tasarrufu için geçmiş sıkıştırıldı…",
  },
  iterCap: {
    fa: "⚠️ قطع شد: به سقف مرحله‌های یک نوبت رسید. با «ادامه از همین‌جا» می‌توانی کار را کامل کنی.",
    en: "⚠️ Interrupted: reached the per-turn step cap. Use “Continue from here” to finish the task.",
    ru: "⚠️ Прервано: достигнут лимит шагов. Нажмите «Продолжить отсюда».",
    ja: "⚠️ 中断: 1ターンのステップ上限に達しました。「ここから続行」で完了できます。",
    zh: "⚠️ 已中断：达到单轮步数上限。点击「从此处继续」完成任务。",
    tr: "⚠️ Kesildi: tur başına adım sınırına ulaşıldı. «Buradan devam et» ile bitirebilirsin.",
  },
  retrying: {
    fa: "اتصال/سهمیه با خطا مواجه شد — تلاش دوباره تا",
    en: "Connection/quota error — retrying in",
    ru: "Ошибка соединения/квоты — повтор через",
    ja: "接続/クォータエラー — 再試行まで",
    zh: "连接/配额错误 — 重试于",
    tr: "Bağlantı/kota hatası — yeniden deneme:",
  },
  seconds: { fa: "ثانیه…", en: "s…", ru: "с…", ja: "秒…", zh: "秒…", tr: "sn…" },
  // ---- settings modal ----
  chatSettings: { fa: "تنظیمات این چت", en: "Chat settings", ru: "Настройки чата", ja: "チャット設定", zh: "对话设置", tr: "Sohbet ayarları" },
  language: { fa: "زبان رابط کاربری", en: "Interface language", ru: "Язык интерфейса", ja: "表示言語", zh: "界面语言", tr: "Arayüz dili" },
  ctxBudget: {
    fa: "بودجه‌ی کانتکست (توکن تخمینی)",
    en: "Context budget (estimated tokens)",
    ru: "Бюджет контекста (оценка в токенах)",
    ja: "コンテキスト予算（推定トークン）",
    zh: "上下文预算（估算令牌）",
    tr: "Bağlam bütçesi (tahmini jeton)",
  },
  budgetNote: {
    fa: "با عبور تخمین تاریخچه از ۷۰٪ این بودجه، پیام‌های قدیمی خودکار فشرده می‌شوند.",
    en: "When history exceeds 70% of this budget, older messages are auto-compacted.",
    ru: "При превышении 70% бюджета старые сообщения автоматически сжимаются.",
    ja: "履歴がこの予算の70%を超えると、古いメッセージが自動圧縮されます。",
    zh: "当历史超过预算的 70% 时，旧消息将自动压缩。",
    tr: "Geçmiş bu bütçenin %70'ini aşınca eski mesajlar otomatik sıkıştırılır.",
  },
  budgetCheap: { fa: "کم‌هزینه", en: "low cost", ru: "экономно", ja: "低コスト", zh: "低成本", tr: "düşük maliyet" },
  budgetDefault: {
    fa: "پیش‌فرض (زیر پله‌ی قیمتی 272k)",
    en: "default (under the 272k price tier)",
    ru: "по умолчанию (ниже порога 272k)",
    ja: "既定（272k価格帯未満）",
    zh: "默认（低于 272k 价格档）",
    tr: "varsayılan (272k fiyat eşiğinin altı)",
  },
  budgetMaxCheap: {
    fa: "حداکثرِ تعرفه‌ی ارزان",
    en: "max of the cheap tier",
    ru: "максимум дешёвого тарифа",
    ja: "低価格帯の上限",
    zh: "低价档上限",
    tr: "ucuz tarifenin üst sınırı",
  },
  budget2x: {
    fa: "⚠️ ورودی ۲ برابر گران‌تر",
    en: "⚠️ input costs 2×",
    ru: "⚠️ ввод в 2 раза дороже",
    ja: "⚠️ 入力コスト2倍",
    zh: "⚠️ 输入价格翻倍",
    tr: "⚠️ girdi 2 kat pahalı",
  },
  budget1m: {
    fa: "⚠️⚠️ فقط برای کارهای خیلی بزرگ؛ هزینه بالا",
    en: "⚠️⚠️ only for very large tasks; expensive",
    ru: "⚠️⚠️ только для очень больших задач; дорого",
    ja: "⚠️⚠️ 特大タスク専用・高コスト",
    zh: "⚠️⚠️ 仅用于超大任务；成本高",
    tr: "⚠️⚠️ yalnızca çok büyük işler için; pahalı",
  },
  autoApprove: {
    fa: "اجرای خودکار دستورات/ویرایش فایل بدون تأیید (ریسک بالاتر)",
    en: "Auto-run commands/file edits without approval (riskier)",
    ru: "Выполнять команды/правки без подтверждения (рискованнее)",
    ja: "確認なしでコマンド/編集を自動実行（リスク高）",
    zh: "无需确认自动执行命令/编辑（风险更高）",
    tr: "Komut/düzenlemeleri onaysız çalıştır (daha riskli)",
  },
  cancel: { fa: "انصراف", en: "Cancel", ru: "Отмена", ja: "キャンセル", zh: "取消", tr: "İptal" },
  save: { fa: "ذخیره", en: "Save", ru: "Сохранить", ja: "保存", zh: "保存", tr: "Kaydet" },
  // ---- approval modal ----
  approvalShell: { fa: "⚠️ اجرای دستور shell", en: "⚠️ Run shell command", ru: "⚠️ Выполнить shell-команду", ja: "⚠️ シェルコマンドの実行", zh: "⚠️ 运行 shell 命令", tr: "⚠️ Shell komutu çalıştır" },
  approvalDelete: { fa: "🗑 حذف فایل", en: "🗑 Delete file", ru: "🗑 Удалить файл", ja: "🗑 ファイル削除", zh: "🗑 删除文件", tr: "🗑 Dosyayı sil" },
  approvalMove: { fa: "📦 جابجایی فایل", en: "📦 Move file", ru: "📦 Переместить файл", ja: "📦 ファイル移動", zh: "📦 移动文件", tr: "📦 Dosyayı taşı" },
  approvalEdit: { fa: "✏️ تغییر فایل", en: "✏️ Edit file", ru: "✏️ Изменить файл", ja: "✏️ ファイル編集", zh: "✏️ 修改文件", tr: "✏️ Dosyayı düzenle" },
  loadingCurrent: {
    fa: "در حال بارگذاری محتوای فعلی…",
    en: "Loading current content…",
    ru: "Загрузка текущего содержимого…",
    ja: "現在の内容を読み込み中…",
    zh: "正在加载当前内容…",
    tr: "Mevcut içerik yükleniyor…",
  },
  reject: { fa: "رد کن", en: "Reject", ru: "Отклонить", ja: "拒否", zh: "拒绝", tr: "Reddet" },
  approve: { fa: "تأیید و اجرا", en: "Approve & run", ru: "Одобрить и выполнить", ja: "承認して実行", zh: "批准并执行", tr: "Onayla ve çalıştır" },
  // ---- usage panel ----
  openConsoleBtn: {
    fa: "نمایش مصرف و محدودیت واقعی",
    en: "Show real usage & limits",
    ru: "Показать реальное использование",
    ja: "実際の使用量と制限を表示",
    zh: "查看真实用量与限制",
    tr: "Gerçek kullanım ve limitleri göster",
  },
  window5h: { fa: "پنجره ۵ ساعته", en: "5-hour window", ru: "Окно 5 часов", ja: "5時間ウィンドウ", zh: "5 小时窗口", tr: "5 saatlik pencere" },
  tokensLogged: {
    fa: "توکن ثبت‌شده در MAHI",
    en: "tokens logged in MAHI",
    ru: "токенов учтено в MAHI",
    ja: "MAHI記録のトークン",
    zh: "MAHI 记录的令牌",
    tr: "MAHI'de kaydedilen jeton",
  },
  resetLabel: { fa: "ریست", en: "Reset", ru: "Сброс", ja: "リセット", zh: "重置", tr: "Sıfırlama" },
  remaining: { fa: "مانده", en: "left", ru: "осталось", ja: "残り", zh: "剩余", tr: "kaldı" },
  exactFromApi: { fa: "دقیق از API", en: "exact from API", ru: "точно из API", ja: "APIから正確", zh: "来自 API（精确）", tr: "API'den kesin" },
  estimated: { fa: "تخمینی", en: "estimated", ru: "оценка", ja: "推定", zh: "估算", tr: "tahmini" },
  usageNote: {
    fa: "درصد دقیق را صفحه‌ی رسمی سرویس (دکمه‌ی بالا) نشان می‌دهد — یک‌بار وارد شوی، لاگین می‌ماند. شمارنده‌های بالا مصرف ثبت‌شده در خود MAHI هستند و زمان ریست ۵ساعته با اولین خطای 429 دقیق می‌شود.",
    en: "The provider's own page (button above) shows exact percentages — sign in once and it stays logged in. The counters above are MAHI-side usage; the 5h reset time becomes exact after the first 429 error.",
    ru: "Точные проценты — на странице провайдера (кнопка выше); вход сохраняется. Счётчики выше — учёт внутри MAHI; время сброса 5ч уточняется после первой ошибки 429.",
    ja: "正確な割合はプロバイダのページ（上のボタン）で確認できます。ログインは保持されます。上のカウンタはMAHI側の記録で、5hリセット時刻は最初の429エラーで正確になります。",
    zh: "精确百分比请见服务商页面（上方按钮）——登录一次即可保持。上方计数为 MAHI 侧记录；5 小时重置时间在首次 429 错误后变为精确。",
    tr: "Kesin yüzdeleri sağlayıcının sayfası (üstteki düğme) gösterir — bir kez giriş yap, oturum kalır. Üstteki sayaçlar MAHI tarafındaki kullanımdır; 5s sıfırlama süresi ilk 429 hatasından sonra kesinleşir.",
  },
  noRequestsYet: {
    fa: "هنوز درخواستی به API زده نشده. یک پیام در چت بفرست تا مقادیر واقعی محدودیت از پاسخ API خوانده شود.",
    en: "No API requests yet. Send a chat message so real limit data can be read from the response.",
    ru: "Запросов ещё не было. Отправьте сообщение, чтобы получить данные о лимитах из ответа.",
    ja: "まだAPIリクエストがありません。メッセージを送ると応答から制限情報を読み取れます。",
    zh: "尚未发起 API 请求。发送一条消息即可从响应中读取真实限制数据。",
    tr: "Henüz API isteği yok. Yanıttan gerçek limit verisini okumak için bir mesaj gönder.",
  },
  noHeadersInfo: {
    fa: "API در هدرهای پاسخ اطلاعات rate-limit برنگرداند؛ این داده فقط از صفحه‌ی وب سرویس در دسترس است (دکمه‌ی بالا).",
    en: "The API returned no rate-limit headers; this data is only available on the provider's web page (button above).",
    ru: "API не вернул заголовки rate-limit; данные доступны только на веб-странице провайдера (кнопка выше).",
    ja: "APIはrate-limitヘッダーを返しませんでした。このデータはプロバイダのウェブページでのみ確認できます（上のボタン）。",
    zh: "API 未返回限流响应头；该数据仅可在服务商网页查看（上方按钮）。",
    tr: "API rate-limit başlıkları döndürmedi; bu veri yalnızca sağlayıcının web sayfasında görülebilir (üstteki düğme).",
  },
  rawHeaders: {
    fa: "هدرهای خام rate-limit (داده واقعی از API)",
    en: "Raw rate-limit headers (real API data)",
    ru: "Сырые заголовки rate-limit (реальные данные API)",
    ja: "生のrate-limitヘッダー（API実データ）",
    zh: "原始限流响应头（真实 API 数据）",
    tr: "Ham rate-limit başlıkları (gerçek API verisi)",
  },
  // ---- providers modal ----
  providersTitle: { fa: "سرویس‌های API", en: "API providers", ru: "API-провайдеры", ja: "APIプロバイダ", zh: "API 服务商", tr: "API sağlayıcıları" },
  providersNote: {
    fa: "هر endpoint سازگار با OpenAI را می‌توانی اضافه کنی. هر گفتگو با سرویسی اجرا می‌شود که موقع ارسال در نوار بالا انتخاب شده — پس چند سرویس هم‌زمان در چت‌های مختلف قابل استفاده‌اند. کلیدها فقط روی همین دستگاه ذخیره می‌شوند.",
    en: "Add any OpenAI-compatible endpoint. Each turn uses whichever provider is selected in the top bar at send time — so different chats can use different providers. Keys are stored on this device only.",
    ru: "Добавьте любой OpenAI-совместимый endpoint. Каждый ход использует провайдера, выбранного сверху при отправке. Ключи хранятся только на этом устройстве.",
    ja: "OpenAI互換のエンドポイントを追加できます。各ターンは送信時に上部で選択中のプロバイダを使用します。キーはこの端末にのみ保存されます。",
    zh: "可添加任何兼容 OpenAI 的端点。每轮使用发送时顶部选中的服务商，不同对话可用不同服务商。密钥仅保存在本机。",
    tr: "OpenAI uyumlu herhangi bir endpoint ekleyebilirsin. Her tur, gönderim anında üstte seçili sağlayıcıyı kullanır. Anahtarlar yalnızca bu cihazda saklanır.",
  },
  name: { fa: "نام", en: "Name", ru: "Название", ja: "名前", zh: "名称", tr: "Ad" },
  modelsCsv: {
    fa: "مدل‌ها (با کاما جدا کن)",
    en: "Models (comma-separated)",
    ru: "Модели (через запятую)",
    ja: "モデル（カンマ区切り）",
    zh: "模型（逗号分隔）",
    tr: "Modeller (virgülle ayır)",
  },
  addProvider: { fa: "افزودن سرویس", en: "Add provider", ru: "Добавить провайдера", ja: "プロバイダを追加", zh: "添加服务商", tr: "Sağlayıcı ekle" },
  newProvider: { fa: "سرویس جدید", en: "New provider", ru: "Новый провайдер", ja: "新しいプロバイダ", zh: "新服务商", tr: "Yeni sağlayıcı" },
  del: { fa: "حذف", en: "Delete", ru: "Удалить", ja: "削除", zh: "删除", tr: "Sil" },
  fetchModels: {
    fa: "دریافت مدل‌ها از سرویس",
    en: "Fetch models from API",
    ru: "Получить модели из API",
    ja: "APIからモデル取得",
    zh: "从 API 获取模型",
    tr: "Modelleri API'den al",
  },
  fetchModelsFailed: {
    fa: "دریافت نشد — کلید یا Base URL را چک کن (برای پلن Coding زد.ای‌آی: /api/coding/paas/v4)",
    en: "Fetch failed — check the key or Base URL (Z.AI Coding plan uses /api/coding/paas/v4)",
    ru: "Не удалось — проверьте ключ или Base URL (Coding-план Z.AI: /api/coding/paas/v4)",
    ja: "取得失敗 — キーとBase URLを確認（Z.AI Codingプランは /api/coding/paas/v4）",
    zh: "获取失败 — 检查密钥或 Base URL（Z.AI Coding 套餐用 /api/coding/paas/v4）",
    tr: "Alınamadı — anahtarı veya Base URL'yi kontrol et (Z.AI Coding planı: /api/coding/paas/v4)",
  },
} satisfies Record<string, Entry>;

export type StrKey = keyof typeof S;

export function t(key: StrKey): string {
  const entry = S[key] as Entry;
  return entry[current] ?? entry.en;
}
