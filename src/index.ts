/*
 * GiraPurge — personal message cleanup plugin source.
 *
 * Safety boundary:
 * - Deletes only messages authored by the current account.
 * - Operates only on the channel or DM selected by the user.
 * - Uses in-app Discord actions; no token, direct REST client, or rate-limit bypass.
 * - This plugin never reads, saves, or asks for an account token.
 * - Preview/Dry Run never deletes anything.
 * - Historic loading is best-effort because Discord internals change between builds.
 */

import { findByProps } from "@vendetta/metro";
import { common, components, assets } from "@vendetta/metro/common";
import { before, after } from "@vendetta/patcher";
import { findInReactTree } from "@vendetta/utils";
import { getAssetIDByName } from "@vendetta/ui/assets";

const React = common.React;
const RN = common.ReactNative;
const Forms = components.Forms;

type Filter = {
    after?: number;
    before?: number;
    keyword?: string;
    excludeKeyword?: string;
    attachmentsOnly?: boolean;
    linksOnly?: boolean;
    textOnly?: boolean;
    skipPinned?: boolean;
};

type TargetKind = "channel" | "dm" | "server-link" | "server";
type TargetSelection = {
    kind: TargetKind;
    channelId?: string;
    userId?: string;
    serverId?: string;
    label?: string;
    source?: "current" | "manual" | "link" | "picker";
    verified?: boolean;
};
type ContentScope = "all" | "messages" | "images" | "links" | "files";
type DateMode = "none" | "before" | "after" | "range";
type DeletionRules = {
    contentScopes: ContentScope[];
    includeKeywords: string[];
    excludeKeywords: string[];
    includeKeywordsEnabled: boolean;
    excludeKeywordsEnabled: boolean;
    keywordMatchMode: "partial" | "exact";
    protectPinned: boolean;
    protectFiles: boolean;
    protectLinks: boolean;
    dateMode: DateMode;
    dateBefore?: number;
    dateAfter?: number;
};

type CleanupSettings = {
    language: "en" | "ar";
    targetChannelId?: string;
    targetLabel?: string;
    target?: TargetSelection;
    deletionRules: DeletionRules;
    deepHistory: boolean;
    previewRequired: boolean;
    autoResume: boolean;
    maxPerRun: number;
    deleteDelayMs: number;
    filter: Filter;
};

type CleanupStats = {
    startedAt: number;
    endedAt?: number;
    scanned: number;
    matched: number;
    deleted: number;
    skipped: number;
    failed: number;
    historyPages: number;
    rateLimitWaits: number;
    totalWaitMs: number;
    pausedMs: number;
    pausedAt?: number;
    completion: "running" | "paused" | "finished" | "stopped" | "unsupported" | "preview";
    lastError?: string;
};

type ProgressPoint = {
    index: number;
    timestamp: number;
    scanned: number;
    matched: number;
    deleted: number;
    failed: number;
};

type JobSnapshot = {
    capturedAt: number;
    channelId: string;
    ownerId: string;
    targetKind?: TargetKind;
    rules: DeletionRules;
    filter: Filter;
    maxPerRun: number;
    deleteDelayMs: number;
};

type PendingDelete = {
    id: string;
    channelId: string;
    ownerId: string;
    markedAt: number;
};

type AuditEntry = {
    timestamp: number;
    action: string;
    reason: string;
    messageId?: string;
    channelId?: string;
    detail?: string;
};

type VerificationResult = {
    ok: boolean;
    reason: string;
    detail?: string;
};

type CleanupJob = {
    schema: 3 | 4 | 5;
    active: boolean;
    channelId: string;
    ownerId: string;
    startedAt: number;
    cursor?: string;
    historyCursor?: string;
    historyNoProgress?: number;
    historyOwnerMissPages?: number;
    historyOwnerFound?: boolean;
    historyLastPageSignature?: string;
    historyHasMore?: boolean;
    historyStarted?: boolean;
    historyBatch?: any[];
    historyLastRequestAt?: number;
    historyRestDisabled?: boolean;
    authorSearchEscalated?: boolean;
    authorSearchUnsupported?: boolean;
    authorSearchStartedAt?: number;
    authorSearchEscalationFailed?: boolean;
    seenIds: string[];
    deletedIds?: string[];
    resumePoint?: string;
    pendingDelete?: PendingDelete;
    snapshot?: JobSnapshot;
    consecutiveErrors?: number;
    consecutiveRateLimits?: number;
    unexpectedResponses?: number;
    circuitOpen?: boolean;
    circuitReason?: string;
    auditLog?: AuditEntry[];
    options: CleanupSettings;
    stats: CleanupStats;
    progressHistory: ProgressPoint[];
    executionId?: number;
    checkpointSeeded?: boolean;
    checkpointLatestPrimed?: boolean;
    recentOnly?: boolean;
    recentFrontierId?: string;
    recentFrontierReached?: boolean;
};

type DMCheckpoint = {
    channelId: string;
    ownerId: string;
    scopeFingerprint: string;
    historyCursor?: string;
    historyHasMore?: boolean;
    historyNoProgress?: number;
    historyLastPageSignature?: string;
    pendingMessages?: any[];
    recentFrontierId?: string;
    pageCount: number;
    updatedAt: number;
};

interface PreviewCandidate { id: string; channelId: string; ts: number; }
interface PreviewPlan {
    channelId: string;
    ownerId: string;
    fingerprint: string;
    scanUpperBoundId: string;
    nextCursor?: string;
    seenIds?: string[];
    candidates: PreviewCandidate[];
    scanned: number;
    matched: number;
    skipped: number;
    pages: number;
    createdAt: number;
    expiresAt: number;
    complete: boolean;
    stopped?: boolean;
    lastError?: string;
}

type HistoryEntry = {
    endedAt: number;
    channelId: string;
    targetLabel?: string;
    targetImageUrl?: string;
    completion: CleanupStats["completion"];
    scanned: number;
    matched: number;
    deleted: number;
    skipped: number;
    failed: number;
    historyPages: number;
    elapsedMs: number;
    progressHistory?: ProgressPoint[];
    auditCount?: number;
    circuitReason?: string;
};

const PATCHES: Array<() => void> = [];
const STORAGE_KEY = "girapurge-storage-v4";
const PLUGIN_VERSION = "1.0.0";
const LEGACY_STORAGE_KEYS = ["deep-personal-message-cleanup-v3"];
const DM_CHECKPOINTS_KEY = "dm_checkpoints_v2";
const PREVIEW_PLAN_KEY = "girapurge_preview_plan_v2";
const PREVIEW_BUDGET_MS = 30_000;
const PREVIEW_MAX_PAGES = 25;
const PREVIEW_EXPIRY_MS = 30 * 60 * 1000;
const PREVIEW_MAX_CANDIDATES = 20_000;
const MAX_DM_CHECKPOINTS = 64;
const DM_SOFT_EXHAUSTION_TTL_MS = 15 * 60 * 1000;
const MIN_DELETE_DELAY_MS = 3_000;
const MAX_DELETE_DELAY_MS = 60_000;
const MAX_MESSAGES_PER_RUN = 10_000;
const HISTORY_PAGE_SIZE = 100;
const MAX_EMPTY_PAGES = 3;
const MAX_HISTORY_PAGE_RETRIES = 5;
const HISTORY_SETTLE_MS = 250;
const HISTORY_PAGE_GAP_MS = 350;
const HISTORY_REQUEST_TIMEOUT_MS = 12_000;
const HISTORY_NO_PROGRESS_LIMIT = 3;
const AUTHOR_SEARCH_PAGE_SIZE = 25;
const AUTHOR_SEARCH_MAX_OFFSET = 9_975;
const AUTHOR_SEARCH_WINDOW_RESULT_LIMIT = 9_000;
const AUTHOR_SEARCH_INDEX_RETRIES = 3;
const AUTHOR_SEARCH_MAX_SPLIT_DEPTH = 0;
const AUTHOR_SEARCH_WORKERS = 1;
const AUTHOR_SEARCH_GAP_MS = 1500;
const AUTHOR_SEARCH_TIMEOUT_MS = 5_000;
const AUTHOR_SEARCH_BUDGET_MS = 20_000;
const MAX_SEEN_IDS = 200_000;
const MAX_HISTORY_ENTRIES = 12;
const MAX_AUDIT_ENTRIES = 240;
const CIRCUIT_ERROR_LIMIT = 5;
const CIRCUIT_RATE_LIMIT_LIMIT = 3;
const CIRCUIT_UNEXPECTED_LIMIT = 3;
const GLOBAL_DELETE_GAP_MS = 350;
const GLOBAL_DELETE_MAX_WAIT_MS = 120_000;

let store: any | undefined;
let currentJob: CleanupJob | undefined;
let running = false;
let runningEpoch = 0;
let lifecycleEpoch = 0;
let cancelled = false;
let pauseRequested = false;
let stopRequested = false;
let clearRequested = false;
let previewRunning = false;
let previewCancelled = false;
let globalDeleteTail: Promise<void> = Promise.resolve();
const EXECUTION_INTERRUPTED_MESSAGE = "GiraPurge execution interrupted";
let globalDeleteNextAt = 0;
let globalDeleteBlockedUntil = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => Date.now();

function executionCanContinue(job: CleanupJob, executionId?: number) {
    if (cancelled || pauseRequested || !job.active || job.stats.completion !== "running") return false;
    if (executionId !== undefined && Number(job.executionId || 0) !== executionId) return false;
    return true;
}

function interruptedError() {
    const error: any = new Error(EXECUTION_INTERRUPTED_MESSAGE);
    error.girapurgeInterrupted = true;
    return error;
}

function isInterruptedError(error: unknown) {
    return Boolean((error as any)?.girapurgeInterrupted) || safeError(error) === EXECUTION_INTERRUPTED_MESSAGE;
}

async function interruptibleSleep(ms: number, job: CleanupJob, executionId?: number) {
    let remaining = Math.max(0, Number(ms) || 0);
    while (remaining > 0) {
        if (!executionCanContinue(job, executionId)) return false;
        const slice = Math.min(remaining, 250);
        await sleep(slice);
        remaining -= slice;
    }
    return executionCanContinue(job, executionId);
}

function activeElapsedMs(stats: CleanupStats, at = now()) {
    const startedAt = Number(stats.startedAt) || at;
    const endAt = Number(stats.endedAt) || at;
    const pausedMs = Math.max(0, Number(stats.pausedMs) || 0);
    const openPauseMs = stats.pausedAt ? Math.max(0, at - Number(stats.pausedAt)) : 0;
    return Math.max(0, endAt - startedAt - pausedMs - openPauseMs);
}

function markPaused(job: CleanupJob, action: string, reason: string) {
    if (job.stats.completion !== "running") return;
    job.active = false;
    job.stats.pausedAt = job.stats.pausedAt || now();
    job.stats.completion = "paused";
    audit(job, action, reason);
}

function resumeTiming(job: CleanupJob) {
    if (job.stats.completion !== "paused") return;
    const pausedAt = Number(job.stats.pausedAt) || 0;
    if (pausedAt > 0) job.stats.pausedMs = Math.max(0, Number(job.stats.pausedMs) || 0) + Math.max(0, now() - pausedAt);
    job.stats.pausedAt = undefined;
    job.stats.endedAt = undefined;
}

function finishTiming(job: CleanupJob) {
    const pausedAt = Number(job.stats.pausedAt) || 0;
    if (pausedAt > 0) job.stats.pausedMs = Math.max(0, Number(job.stats.pausedMs) || 0) + Math.max(0, now() - pausedAt);
    job.stats.pausedAt = undefined;
    job.stats.endedAt = now();
}

function parseChannelId(value: string): string | undefined {
    const raw = String(value || "").trim();
    const match = raw.match(/(?:channels\/(?:@me|\d+)\/)(\d{5,})/i);
    const candidate = match?.[1] || (/^\d{5,}$/.test(raw) ? raw : "");
    return candidate || undefined;
}

function retryAfterMs(error: unknown) {
    try {
        const source: any = error as any;
        const headers = source?.headers || source?.response?.headers || source?.response?.data?.headers;
        let headerValue: any;
        if (headers?.get && typeof headers.get === "function") headerValue = headers.get("retry-after") || headers.get("Retry-After");
        if (headerValue === undefined && headers && typeof headers === "object") headerValue = headers["retry-after"] ?? headers["Retry-After"];
        const value = source?.retry_after ?? source?.retryAfter ?? source?.body?.retry_after ?? source?.body?.retryAfter ?? source?.data?.retry_after ?? source?.response?.data?.retry_after ?? headerValue;
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) return Math.min(GLOBAL_DELETE_MAX_WAIT_MS, Math.max(250, Math.round(numeric * 1000)));
        const status = Number(source?.status ?? source?.statusCode ?? source?.response?.status);
        if (status === 429) return 2_000;
    } catch {
        // Some Discord errors are non-serializable host objects.
    }
    return 0;
}

function isAuthorSearchUnsupportedError(error: unknown) {
    try {
        const source: any = error as any;
        const body = source?.body ?? source?.data ?? source?.response?.data;
        return Number(source?.code ?? body?.code ?? source?.response?.data?.code) === 50024;
    } catch {
        return false;
    }
}
function isRateLimitError(error: unknown) {
    try {
        const source: any = error as any;
        return Number(source?.status ?? source?.statusCode ?? source?.response?.status) === 429 || retryAfterMs(error) > 0 && /429|rate.?limit|retry/i.test(safeError(error));
    } catch {
        return false;
    }
}

function tripCircuit(job: CleanupJob, reason: string) {
    ensureSafetyFields(job);
    if (job.circuitOpen) return;
    job.circuitOpen = true;
    job.circuitReason = String(reason).slice(0, 220);
    job.active = false;
    job.stats.lastError = `Circuit breaker: ${job.circuitReason}`;
    stopRequested = true;
    cancelled = true;
    audit(job, "circuit-open", job.circuitReason);
    saveJob(job);
}

function noteDeleteSuccess(job: CleanupJob) {
    job.consecutiveErrors = 0;
    job.consecutiveRateLimits = 0;
    job.unexpectedResponses = 0;
}

function noteFailure(job: CleanupJob, error: unknown, context: string) {
    ensureSafetyFields(job);
    job.consecutiveErrors = Number(job.consecutiveErrors || 0) + 1;
    if (isRateLimitError(error)) job.consecutiveRateLimits = Number(job.consecutiveRateLimits || 0) + 1;
    audit(job, "request-error", `${context}: ${safeError(error)}`);
    if (Number(job.consecutiveRateLimits || 0) >= CIRCUIT_RATE_LIMIT_LIMIT) tripCircuit(job, `consecutive rate limits (${job.consecutiveRateLimits})`);
    else if (Number(job.consecutiveErrors || 0) >= CIRCUIT_ERROR_LIMIT) tripCircuit(job, `consecutive errors (${job.consecutiveErrors})`);
}

function noteUnexpectedResponse(job: CleanupJob, reason: string) {
    ensureSafetyFields(job);
    job.unexpectedResponses = Number(job.unexpectedResponses || 0) + 1;
    audit(job, "unexpected-response", reason);
    if (Number(job.unexpectedResponses || 0) >= CIRCUIT_UNEXPECTED_LIMIT) tripCircuit(job, `unexpected responses (${job.unexpectedResponses})`);
}

async function waitGlobalDeleteSlot(job: CleanupJob, executionId?: number) {
    let waitFor = Math.max(0, globalDeleteNextAt - now(), globalDeleteBlockedUntil - now());
    while (waitFor > 0) {
        if (!executionCanContinue(job, executionId)) return false;
        const slice = Math.min(waitFor, 250);
        job.stats.totalWaitMs += slice;
        await sleep(slice);
        waitFor = Math.max(0, globalDeleteNextAt - now(), globalDeleteBlockedUntil - now());
    }
    if (!executionCanContinue(job, executionId)) return false;
    globalDeleteNextAt = now() + GLOBAL_DELETE_GAP_MS;
    return true;
}

function withGlobalDeleteRateLimiter<T>(job: CleanupJob, task: () => Promise<T>, executionId?: number): Promise<T> {
    const run = globalDeleteTail.then(async () => {
        const slotReady = await waitGlobalDeleteSlot(job, executionId);
        if (!slotReady || !executionCanContinue(job, executionId)) throw interruptedError();
        try {
            return await task();
        } catch (error) {
            const retry = retryAfterMs(error);
            if (retry > 0) {
                globalDeleteBlockedUntil = Math.max(globalDeleteBlockedUntil, now() + retry);
                job.stats.rateLimitWaits += 1;
                job.stats.totalWaitMs += retry;
                audit(job, "rate-limit", `Global limiter blocked for ${retry}ms`, undefined, "delete");
            }
            throw error;
        }
    });
    globalDeleteTail = run.then(() => undefined, () => undefined);
    return run;
}

function safeError(error: unknown) {
    try {
        const source: any = error as any;
        const status = source?.status ?? source?.statusCode ?? source?.response?.status;
        const body = source?.body ?? source?.data ?? source?.response?.data;
        const detail = body && typeof body === "object" ? JSON.stringify(body) : body ? String(body) : "";
        if (status || detail) return `${status ? `HTTP ${status}` : "REST error"}${detail ? `: ${detail}` : ""}`.slice(0, 240);
        if (error && typeof source?.message === "string" && source.message) return String(source.message).slice(0, 240);
        if (typeof error === "string" && error) return error.slice(0, 240);
        const serialized = error && typeof error === "object" ? JSON.stringify(error) : String(error || "");
        return (serialized && serialized !== "{}" ? serialized : "Unknown error").slice(0, 240);
    } catch {
        return "Unknown error";
    }
}

function persistentStore(): any | undefined {
    try {
        const host = (globalThis as any).vendetta;
        const storage = host?.storage;
        if (!storage?.createMMKVBackend || !storage?.createStorage || !storage?.wrapSync) return undefined;
        return storage.wrapSync(storage.createStorage(storage.createMMKVBackend(STORAGE_KEY)));
    } catch {
        return undefined;
    }
}

function getStore() {
    store ??= persistentStore();
    return store;
}

function defaultSettings(): CleanupSettings {
    return {
        language: "en",
        targetChannelId: undefined,
        targetLabel: undefined,
        target: undefined,
        deletionRules: { contentScopes: ["all"], includeKeywords: [], excludeKeywords: [], includeKeywordsEnabled: false, excludeKeywordsEnabled: false, keywordMatchMode: "partial", protectPinned: false, protectFiles: false, protectLinks: false, dateMode: "none" },
        deepHistory: true,
        previewRequired: false,
        autoResume: true,
        maxPerRun: MAX_MESSAGES_PER_RUN,
        deleteDelayMs: MIN_DELETE_DELAY_MS,
        filter: { skipPinned: false },
    };
}

function loadSettings(): CleanupSettings {
    try {
        const value = getStore()?.settings;
        if (!value) return defaultSettings();
        const base = defaultSettings();
        const legacyFilter = { ...base.filter, ...(value.filter && typeof value.filter === "object" ? value.filter : {}) };
        const rawRules = value.deletionRules && typeof value.deletionRules === "object" ? value.deletionRules : undefined;
        const rules = rawRules ? normalizeDeletionRules(rawRules, legacyFilter) : legacyRules(legacyFilter);
        const storedTargetId = parseChannelId(String(value.target?.channelId || value.targetChannelId || ""));
        const target = storedTargetId ? { kind: (["channel", "dm", "server-link", "server"].includes(value.target?.kind) ? value.target.kind : "channel") as TargetKind, channelId: storedTargetId, label: String(value.target?.label || value.targetLabel || "").slice(0, 120) || undefined, source: value.target?.source || "manual", verified: Boolean(value.target?.verified) } : undefined;
        const migratedLimit = Math.min(MAX_MESSAGES_PER_RUN, Math.max(1, Number(value.maxPerRun) || base.maxPerRun));
        const migratedDelay = Math.min(MAX_DELETE_DELAY_MS, Math.max(MIN_DELETE_DELAY_MS, Number(value.deleteDelayMs) || base.deleteDelayMs));
        return { ...base, ...value, language: value.language === "ar" ? "ar" : "en", deepHistory: true, previewRequired: false, autoResume: true, target, targetChannelId: target?.channelId, targetLabel: target?.label, maxPerRun: migratedLimit, deleteDelayMs: migratedDelay, filter: { ...base.filter, ...legacyFilter, after: rules.dateAfter, before: rules.dateBefore, keyword: rules.includeKeywords[0] || undefined, excludeKeyword: rules.excludeKeywords[0] || undefined, skipPinned: rules.protectPinned }, deletionRules: rules };

    } catch {
        return defaultSettings();
    }
}

const runtimeText = {
    en: {
        reportTitle: "Personal purge report", noReport: "No purge report", noReportBody: "No purge job has run in this app session.", copy: "Copy report", close: "Close", historyTitle: "Purge session history", noHistory: "No completed purge sessions are saved yet.", unsupported: "Unsupported version", unsupportedBody: "Nothing was deleted. This build does not expose the required in-app action.", previewTitle: "Safe preview — nothing deleted", previewLoaded: "Loaded own messages", previewMatch: "Would match", previewSkip: "Would skip", previewFilter: "Filter", previewLimit: "Session limit", previewHistory: "Older history is loaded page by page after starting, with resumable progress.", historyDisabled: "Deep history is disabled.", accountUnavailable: "Account unavailable", accountUnavailableBody: "The current account could not be read. Nothing was deleted.", finalTitle: "Final confirmation", finalBody: "This deletes only your own messages.", keepOpen: "Keep Discord open. If Android stops the app, open the same DM and choose Resume.", startTitle: "Start purge?", resumeTitle: "Resume purge?", confirmBody: "Safe preview is optional. No token or external request is used.", cancel: "Cancel", continue: "Continue", start: "Start purge", resume: "Resume", saved: "Purge settings saved", textInputUnavailable: "Text input unavailable", textInputBody: "This Android build does not expose a native prompt.", stopped: "Purge stopped", paused: "Purge paused", finished: "Purge finished", ready: "READY", setup: "SETUP", copied: "Report copied", clearHistory: "Clear all plugin data", historyCleared: "All plugin data cleared", reportHeader: "Personal purge report", channelDm: "Channel / DM", status: "Status", rules: "Rules", dateMode: "Date mode", protectFiles: "protect files", protectLinks: "protect links", filter: "Filter", scanned: "Scanned", matched: "Matched", deleted: "Deleted", skipped: "Skipped", failed: "Failed", historyPages: "History pages", rateLimitWaits: "Rate-limit waits", waitTime: "Wait time", elapsed: "Elapsed", started: "Started", ended: "Ended", sessionLimit: "Session limit", lastNote: "Last note", after: "after", before: "before", contains: "contains", excludes: "excludes", attachments: "attachments/embeds", links: "links", textOnly: "text only", skipPinned: "skip pinned", allOwnMessages: "all own messages", settingHistory: "History", settingPreview: "Preview", settingLimit: "Limit", settingDelay: "Delay", settingFilter: "Filter", enabled: "enabled", disabled: "disabled", completionRunning: "running", completionPaused: "paused", completionFinished: "finished", completionStopped: "stopped", completionUnsupported: "unsupported", completionPreview: "preview"
    },
    ar: {
        reportTitle: "تقرير تطهير الرسائل", noReport: "ماكو تقرير", noReportBody: "ماكو مهمة تطهير اشتغلت بهذا التطبيق بعد.", copy: "نسخ التقرير", close: "إغلاق", historyTitle: "سجل جلسات التطهير", noHistory: "ماكو جلسات مكتملة محفوظة بعد.", unsupported: "الإصدار غير مدعوم", unsupportedBody: "ما انحذفت أي رسالة. هذا الإصدار ما يوفر إجراء Discord المطلوب داخل التطبيق.", previewTitle: "معاينة آمنة — بدون حذف", previewLoaded: "رسائلي المحمّلة", previewMatch: "راح تطابق", previewSkip: "راح تنستثنى", previewFilter: "الفلاتر", previewLimit: "حد الجلسة", previewHistory: "بعد البدء ينحمّل التاريخ القديم صفحةً صفحة مع حفظ التقدم والاستئناف.", historyDisabled: "تحميل التاريخ القديم متوقف.", accountUnavailable: "الحساب غير متاح", accountUnavailableBody: "ما كدرت أقرأ الحساب الحالي. ما انحذفت أي رسالة.", finalTitle: "التأكيد النهائي", finalBody: "هذه العملية تحذف رسائلك أنت فقط.", keepOpen: "خلي Discord مفتوح. إذا أندرويد أوقف التطبيق، افتح نفس الـDM واختار استئناف.", startTitle: "تبدأ التطهير؟", resumeTitle: "تستأنف التطهير؟", confirmBody: "المعاينة الآمنة اختيارية. ماكو token ولا طلب خارجي.", cancel: "إلغاء", continue: "متابعة", start: "بدء التطهير", resume: "استئناف", saved: "تم حفظ إعدادات التطهير", textInputUnavailable: "الإدخال النصي غير متاح", textInputBody: "هذا الإصدار من أندرويد ما يوفر نافذة إدخال أصلية.", stopped: "توقف التطهير", paused: "توقف مؤقتاً", finished: "اكتمل التطهير", ready: "جاهز", setup: "إعداد", copied: "تم نسخ التقرير", clearHistory: "مسح كل بيانات البلوقن", historyCleared: "تم مسح كل بيانات البلوقن", reportHeader: "تقرير تطهير الرسائل", channelDm: "القناة / الخاص", status: "الحالة", rules: "قواعد الحذف", dateMode: "وضع التاريخ", protectFiles: "حماية الملفات", protectLinks: "حماية الروابط", filter: "الفلاتر", scanned: "تم فحصها", matched: "مطابقة", deleted: "محذوفة", skipped: "متروكة", failed: "فاشلة", historyPages: "صفحات التاريخ", rateLimitWaits: "انتظارات حد المعدل", waitTime: "وقت الانتظار", elapsed: "المدة", started: "بدأت", ended: "انتهت", sessionLimit: "حد الجلسة", lastNote: "آخر ملاحظة", after: "بعد", before: "قبل", contains: "تحتوي", excludes: "تستثني", attachments: "المرفقات/التضمينات", links: "الروابط", textOnly: "نص فقط", skipPinned: "تخطي المثبتة", allOwnMessages: "كل رسائلي", settingHistory: "التاريخ القديم", settingPreview: "المعاينة", settingLimit: "الحد", settingDelay: "التأخير", settingFilter: "الفلاتر", enabled: "مفعّل", disabled: "متوقف", completionRunning: "قيد التشغيل", completionPaused: "متوقفة مؤقتاً", completionFinished: "مكتملة", completionStopped: "متوقفة", completionUnsupported: "غير مدعومة", completionPreview: "معاينة"
    }
};
function runtimeLanguage() { return loadSettings().language === "ar" ? "ar" : "en"; }
function rt(key: keyof typeof runtimeText.en) { return runtimeText[runtimeLanguage()][key] || key; }
function completionText(value: CleanupStats["completion"]) {
    const key = `completion${value.charAt(0).toUpperCase()}${value.slice(1)}` as keyof typeof runtimeText.en;
    return rt(key);
}

function saveSettings(settings: CleanupSettings) {
    try {
        const target = getStore();
        if (target) target.settings = settings;
    } catch {
        // Persistence is optional and must never break the plugin.
    }
}

function stableChecksum(value: any): string {
    try {
        const text = JSON.stringify(value);
        let hash = 2166136261;
        for (let index = 0; index < text.length; index += 1) {
            hash ^= text.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }
        return (hash >>> 0).toString(16);
    } catch {
        return "invalid";
    }
}

function atomicEnvelope(payload: any) {
    const copy = cloneJson(payload);
    return { version: 1, writtenAt: now(), checksum: stableChecksum(copy), payload: copy };
}

function readAtomicPayload(target: any, key: string): any | undefined {
    try {
        const active = String(target?.[`${key}_active`] || "");
        const slots = active === "a" || active === "b" ? [active, active === "a" ? "b" : "a"] : ["a", "b"];
        for (const slot of slots) {
            const envelope = target?.[`${key}_${slot}`];
            if (!envelope?.payload || stableChecksum(envelope.payload) !== String(envelope.checksum || "")) continue;
            return cloneJson(envelope.payload);
        }
    } catch {
        return undefined;
    }
    return undefined;
}

function atomicWrite(target: any, key: string, payload: any) {
    const active = String(target?.[`${key}_active`] || "");
    const slot = active === "a" ? "b" : "a";
    const envelope = atomicEnvelope(payload);
    target[`${key}_${slot}`] = envelope;
    target[`${key}_active`] = slot;
}

function previewFingerprint(channelId: string, ownerId: string, settings: CleanupSettings): string {
    const rules = normalizeDeletionRules(settings.deletionRules, settings.filter);
    return stableChecksum({ channelId: String(channelId), ownerId: String(ownerId), rules, filter: cloneJson(settings.filter), targetKind: settings.target?.kind || "unknown" });
}

function loadPreviewPlan(): PreviewPlan | null {
    try {
        const target = getStore();
        const stored = readAtomicPayload(target, PREVIEW_PLAN_KEY) || target?.[PREVIEW_PLAN_KEY];
        if (!stored?.channelId || !stored?.ownerId || !Array.isArray(stored.candidates)) return null;
        const candidates = stored.candidates.filter((item: any) => item && item.id && item.channelId).map((item: any) => ({ id: String(item.id), channelId: String(item.channelId), ts: Number(item.ts) || 0 }));
        const seenIds = Array.isArray(stored.seenIds) ? stored.seenIds.map((id: any) => String(id || "")).filter(Boolean).slice(-MAX_SEEN_IDS) : [];
        return { ...stored, candidates, seenIds } as PreviewPlan;
    } catch {
        return null;
    }
}

function savePreviewPlan(plan: PreviewPlan) {
    try {
        const target = getStore();
        if (!target) return;
        const copy = cloneJson(plan);
        atomicWrite(target, PREVIEW_PLAN_KEY, copy);
        target[PREVIEW_PLAN_KEY] = copy;
    } catch {
        // Preview persistence is optional, but deletion never proceeds without re-verification.
    }
}

function clearPreviewPlan() {
    try {
        const target = getStore();
        if (!target) return;
        target[`${PREVIEW_PLAN_KEY}_a`] = undefined;
        target[`${PREVIEW_PLAN_KEY}_b`] = undefined;
        target[`${PREVIEW_PLAN_KEY}_active`] = undefined;
        target[PREVIEW_PLAN_KEY] = undefined;
    } catch {
        // Optional storage cleanup.
    }
}

function isPreviewPlanValid(plan: PreviewPlan | null, channelId: string, ownerId: string, settings: CleanupSettings): boolean {
    if (!plan || !plan.channelId || !plan.ownerId || !plan.fingerprint) return false;
    if (now() > Number(plan.expiresAt || 0)) return false;
    return String(plan.channelId) === String(channelId) && String(plan.ownerId) === String(ownerId) && plan.fingerprint === previewFingerprint(channelId, ownerId, settings);
}

function saveJob(job = currentJob) {
    try {
        if (!job) return;
        ensureSafetyFields(job);
        const target = getStore();
        if (!target) return;
        const copy = cloneJson(job);
        atomicWrite(target, "job_v5", copy);
        target.job = copy;
    } catch {
        // Ignore unavailable storage.
    }
}

function loadJob(): CleanupJob | undefined {
    try {
        const target = getStore();
        const candidate = readAtomicPayload(target, "job_v5") || target?.job;
        if ((candidate?.schema === 3 || candidate?.schema === 4 || candidate?.schema === 5) && candidate?.channelId && candidate?.ownerId && candidate?.stats && Array.isArray(candidate.seenIds)) {
            const job = candidate as CleanupJob;
            const normalized: CleanupJob = { ...job, schema: 5, historyCursor: job.historyCursor || undefined, historyNoProgress: Number(job.historyNoProgress || 0), historyOwnerMissPages: Number(job.historyOwnerMissPages || 0), historyOwnerFound: Boolean(job.historyOwnerFound), historyLastPageSignature: job.historyLastPageSignature || undefined, historyHasMore: typeof job.historyHasMore === "boolean" ? job.historyHasMore : undefined, historyStarted: Boolean(job.historyStarted || job.historyCursor || job.stats.historyPages), recentOnly: Boolean(job.recentOnly), recentFrontierId: job.recentFrontierId || undefined, recentFrontierReached: Boolean(job.recentFrontierReached), options: { ...defaultSettings(), ...(job.options || {}), deepHistory: true, previewRequired: false, autoResume: true }, stats: { ...job.stats, pausedMs: Math.max(0, Number(job.stats.pausedMs) || 0), pausedAt: Number(job.stats.pausedAt) > 0 ? Number(job.stats.pausedAt) : undefined }, progressHistory: normalizeProgressHistory(job.progressHistory) };
            // A persisted "running" flag can survive a force-stop or Discord restart. It must
            // never lock the UI or make destructive controls appear active after reload.
            if (normalized.stats.completion === "running" || normalized.active) {
                normalized.active = false;
                normalized.stats.completion = "paused";
                normalized.stats.pausedAt = normalized.stats.pausedAt || now();
                normalized.stats.endedAt = undefined;
                audit(normalized, "stale-runtime-recovered", "Recovered a persisted running job as paused after plugin reload");
            }
            ensureSafetyFields(normalized);
            return normalized;
        }
    } catch {
        // Ignore corrupt or unavailable state.
    }
    return undefined;
}

function checkpointScopeFingerprint(job: CleanupJob): string {
    const snapshot = job.snapshot || snapshotSettings(job.options || defaultSettings(), job.channelId, job.ownerId);
    return stableChecksum({ targetKind: snapshot.targetKind || job.options?.target?.kind || "unknown", rules: snapshot.rules, filter: snapshot.filter });
}

function loadDMCheckpoints(): DMCheckpoint[] {
    try {
        const target = getStore();
        const stored = readAtomicPayload(target, DM_CHECKPOINTS_KEY) || target?.[DM_CHECKPOINTS_KEY];
        if (!Array.isArray(stored)) return [];
        return stored.filter((entry: any) => entry && entry.channelId && entry.ownerId && entry.scopeFingerprint).slice(0, MAX_DM_CHECKPOINTS) as DMCheckpoint[];
    } catch {
        return [];
    }
}

function findDMCheckpoint(job: CleanupJob): DMCheckpoint | undefined {
    if (!isDirectMessageJob(job)) return undefined;
    const fingerprint = checkpointScopeFingerprint(job);
    return loadDMCheckpoints().find((entry) => String(entry.channelId) === String(job.channelId) && String(entry.ownerId) === String(job.ownerId) && String(entry.scopeFingerprint) === fingerprint);
}

function saveDMCheckpoint(job: CleanupJob, pendingMessages?: any[]) {
    if (!isDirectMessageJob(job)) return;
    try {
        const target = getStore();
        if (!target) return;
        const fingerprint = checkpointScopeFingerprint(job);
        const existing = loadDMCheckpoints();
        const pending = Array.isArray(pendingMessages) && pendingMessages.length ? pendingMessages.slice(0, HISTORY_PAGE_SIZE).map((message) => cloneJson(message)) : undefined;
        const entry: DMCheckpoint = {
            channelId: String(job.channelId),
            ownerId: String(job.ownerId),
            scopeFingerprint: fingerprint,
            historyCursor: job.recentOnly && job.recentFrontierId ? String(job.recentFrontierId) : job.historyCursor || undefined,
            historyHasMore: job.recentOnly ? true : job.historyHasMore,
            historyNoProgress: Math.max(0, Number(job.historyNoProgress || 0)),
            historyLastPageSignature: job.historyLastPageSignature || undefined,
            pendingMessages: pending,
            recentFrontierId: job.recentFrontierId || undefined,
            pageCount: Math.max(0, Number(job.stats.historyPages || 0)),
            updatedAt: now(),
        };
        const next = [entry, ...existing.filter((item) => !(String(item.channelId) === String(entry.channelId) && String(item.ownerId) === String(entry.ownerId) && String(item.scopeFingerprint) === String(entry.scopeFingerprint)))].slice(0, MAX_DM_CHECKPOINTS);
        atomicWrite(target, DM_CHECKPOINTS_KEY, next);
        target[DM_CHECKPOINTS_KEY] = next;
    } catch {
        // Checkpoint persistence is an optimization; deletion safety never depends on it.
    }
}

function seedDMCheckpoint(job: CleanupJob): boolean {
    if (!isDirectMessageJob(job) || job.checkpointSeeded) return false;
    const rules = job.snapshot?.rules || job.options.deletionRules;
    const reusableUpperBound = (rules.dateMode === "before" || rules.dateMode === "range") && Number(rules.dateBefore) > 0;
    job.checkpointSeeded = true;
    const checkpoint = findDMCheckpoint(job);
    if (!reusableUpperBound && rules.dateMode === "none" && checkpoint?.historyCursor) {
        job.recentOnly = true;
        job.recentFrontierId = String(checkpoint.recentFrontierId || checkpoint.historyCursor);
        job.recentFrontierReached = false;
        job.historyCursor = undefined;
        job.historyHasMore = undefined;
        job.historyStarted = false;
        job.historyBatch = [];
        audit(job, "history-recent-only", "Started from newest DM messages and will stop at the previous safe frontier", job.recentFrontierId);
        return true;
    }
    job.recentOnly = false;
    if (!reusableUpperBound) return false;
    if (!checkpoint) return false;
    if (checkpoint.historyHasMore === false && !checkpoint.pendingMessages?.length) {
        job.historyHasMore = false;
        job.historyStarted = true;
        audit(job, "history-checkpoint-exhausted", "The persisted DM date window was already exhausted", checkpoint.historyCursor);
        return true;
    }
    if (checkpoint.historyCursor) job.historyCursor = String(checkpoint.historyCursor);
    job.historyNoProgress = Math.max(0, Number(checkpoint.historyNoProgress || 0));
    job.historyLastPageSignature = checkpoint.historyLastPageSignature || undefined;
    job.historyHasMore = checkpoint.historyHasMore;
    job.historyStarted = Boolean(job.historyCursor);
    if (Array.isArray(checkpoint.pendingMessages) && checkpoint.pendingMessages.length) job.historyBatch = cloneJson(checkpoint.pendingMessages);
    audit(job, "history-checkpoint-resume", "Started DM history from the last persisted safe frontier", job.historyCursor);
    return true;
}

function loadHistory(): HistoryEntry[] {
    try {
        const history = getStore()?.history;
        return Array.isArray(history) ? history.slice(0, MAX_HISTORY_ENTRIES) : [];
    } catch {
        return [];
    }
}

function saveHistory(entry: HistoryEntry) {
    try {
        const target = getStore();
        if (!target) return;
        target.history = [entry, ...loadHistory()].slice(0, MAX_HISTORY_ENTRIES);
    } catch {
        // Optional feature.
    }
}

function finalizeCompletedJob() {
    try {
        const target = getStore();
        if (target) {
            target.job = undefined;
            target.job_v5_a = undefined;
            target.job_v5_b = undefined;
            target.job_v5_active = undefined;
        }
    } catch {
        // Optional storage cleanup.
    }
}

function clearStorageScope(target: any) {
    if (!target) return;
    const keys = ["settings", "history", "job", "job_v5", "job_v5_a", "job_v5_b", "job_v5_active", DM_CHECKPOINTS_KEY, `${DM_CHECKPOINTS_KEY}_a`, `${DM_CHECKPOINTS_KEY}_b`, `${DM_CHECKPOINTS_KEY}_active`, PREVIEW_PLAN_KEY, `${PREVIEW_PLAN_KEY}_a`, `${PREVIEW_PLAN_KEY}_b`, `${PREVIEW_PLAN_KEY}_active`, "job_v4", "job_v4_a", "job_v4_b", "job_v4_active", "job_v3", "job_v3_a", "job_v3_b", "job_v3_active", "history_v1", "history_v2"];
    for (const key of keys) {
        try { target[key] = undefined; } catch {}
        try { delete target[key]; } catch {}
    }
}
function clearAllPluginData() {
    try {
        clearStorageScope(getStore());
        const storage = (globalThis as any).vendetta?.storage;
        if (storage?.createMMKVBackend && storage?.createStorage && storage?.wrapSync) {
            for (const legacyKey of LEGACY_STORAGE_KEYS) {
                try { clearStorageScope(storage.wrapSync(storage.createStorage(storage.createMMKVBackend(legacyKey)))); } catch {}
            }
        }
    } catch {
        // Data cleanup is best-effort across Revenge storage implementations.
    }
    currentJob = undefined;
    running = false;
    cancelled = true;
    pauseRequested = false;
    stopRequested = false;
    clearRequested = false;
    globalDeleteNextAt = 0;
    globalDeleteBlockedUntil = 0;
}
function clearHistory() {
    clearAllPluginData();
}

function messageChannelId(message: any): string {
    return String(message?.channel_id ?? message?.channelId ?? message?.channel?.id ?? "");
}

function messageAuthorId(message: any): string {
    return String(message?.author_id ?? message?.author?.id ?? message?.authorId ?? message?.author?.user?.id ?? message?.user_id ?? message?.userId ?? "");
}

function loadedChannelMessages(channelId: string): any[] {
    const messageStore = findByProps("getMessages");
    return messageArray(messageStore?.getMessages?.(channelId))
        .filter((message) => message?.id)
        .map((message) => messageChannelId(message) === channelId ? message : { ...message, channel_id: channelId })
        .filter((message) => messageChannelId(message) === channelId)
        .sort(isEarlierMessage);
}

function objectValues(record: any): any[] {
    if (!record || typeof record !== "object") return [];
    const values: any[] = [];
    for (const key in record) if (Object.prototype.hasOwnProperty.call(record, key)) values.push(record[key]);
    return values;
}

function messageArray(record: any): any[] {
    if (!record) return [];
    if (Array.isArray(record)) return record;
    if (Array.isArray(record._array)) return record._array;
    if (record._map && typeof record._map === "object") return objectValues(record._map);
    if (record.messages && typeof record.messages === "object") return objectValues(record.messages);
    if (record.body && typeof record.body === "object") return messageArray(record.body);
    return [];
}

function uniqueChannelMessages(messages: any[], channelId: string) {
    const byId: { [key: string]: any } = {};
    for (const message of messages) {
        const id = String(message?.id || "");
        if (!id || messageChannelId(message) !== channelId) continue;
        byId[id] = message;
    }
    return objectValues(byId).sort(isEarlierMessage);
}

function jobMessages(job: CleanupJob) {
    const loaded = loadedChannelMessages(job.channelId);
    const fetched = Array.isArray(job.historyBatch) ? job.historyBatch : [];
    return uniqueChannelMessages(loaded.concat(fetched), job.channelId);
}

function consumeJobMessages(job: CleanupJob) {
    const rules = job.snapshot?.rules || job.options.deletionRules;
    const hasUpperBound = (rules.dateMode === "before" || rules.dateMode === "range") && Number.isFinite(Number(rules.dateBefore)) && Number(rules.dateBefore) > 0;
    const hasLowerBound = (rules.dateMode === "after" || rules.dateMode === "range") && Number.isFinite(Number(rules.dateAfter)) && Number(rules.dateAfter) > 0;
    const sourceMessages = jobMessages(job);
    if (job.recentOnly && job.recentFrontierId) {
        const frontier = String(job.recentFrontierId);
        if (sourceMessages.some((message) => {
            const id = String(message?.id || "");
            return Boolean(id) && compareMessageIds(id, frontier) <= 0;
        })) job.recentFrontierReached = true;
    }
    const all = sourceMessages
        .filter((message) => {
            if (!job.recentOnly || !job.recentFrontierId) return true;
            const id = String(message?.id || "");
            return Boolean(id) && compareMessageIds(id, String(job.recentFrontierId)) > 0;
        })
        .filter((message) => messageAuthorId(message) === String(job.ownerId))
        .filter((message) => {
            const timestamp = messageTime(message) || snowflakeTimestamp(String(message?.id || ""));
            if (!timestamp) return true;
            if (hasUpperBound && timestamp > Number(rules.dateBefore)) return false;
            if (hasLowerBound && timestamp < Number(rules.dateAfter)) return false;
            return true;
        });
    job.historyBatch = [];
    const pending: any[] = [];
    const seen = new Set(job.seenIds || []);
    const deleted = new Set(job.deletedIds || []);
    for (const message of all) {
        const id = String(message?.id || "");
        if (!id || seen.has(id) || deleted.has(id)) continue;
        pending.push(message);
    }
    return pending;
}

function messageTime(message: any) {
    const value = message?.timestamp ?? message?.edited_timestamp ?? message?.createdAt;
    const parsed = typeof value === "number" ? value : Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : 0;
}

function compareMessageIds(left: string, right: string): number {
    try {
        const a = BigInt(String(left || "0"));
        const b = BigInt(String(right || "0"));
        return a < b ? -1 : a > b ? 1 : 0;
    } catch {
        return String(left || "").localeCompare(String(right || ""));
    }
}

function isEarlierMessage(a: any, b: any) {
    const aTime = messageTime(a);
    const bTime = messageTime(b);
    if (aTime && bTime) return aTime - bTime;
    return compareMessageIds(String(a?.id || ""), String(b?.id || ""));
}

function hasLink(message: any) {
    return /https?:\/\/|www\./i.test(String(message?.content || ""));
}

function normalizeDeletionRules(raw: any, fallbackFilter: Filter = {}): DeletionRules {
    const legacy = legacyRules(fallbackFilter);
    const allowedScopes: ContentScope[] = ["all", "messages", "images", "links", "files"];
    const scopes = Array.isArray(raw?.contentScopes) ? raw.contentScopes.filter((value: any) => allowedScopes.includes(value)).slice(0, 4) as ContentScope[] : legacy.contentScopes;
    const includeKeywords = Array.isArray(raw?.includeKeywords) ? raw.includeKeywords.map((value: any) => String(value).trim()).filter(Boolean).slice(0, 32) : legacy.includeKeywords;
    const excludeKeywords = Array.isArray(raw?.excludeKeywords) ? raw.excludeKeywords.map((value: any) => String(value).trim()).filter(Boolean).slice(0, 32) : legacy.excludeKeywords;
    const includeKeywordsEnabled = raw?.includeKeywordsEnabled === undefined ? includeKeywords.length > 0 : Boolean(raw.includeKeywordsEnabled);
    const excludeKeywordsEnabled = raw?.excludeKeywordsEnabled === undefined ? excludeKeywords.length > 0 : Boolean(raw.excludeKeywordsEnabled);
    const keywordMatchMode = raw?.keywordMatchMode === "exact" ? "exact" : "partial";
    const dateMode: DateMode = ["none", "before", "after", "range"].includes(raw?.dateMode) ? raw.dateMode : legacy.dateMode;
    const dateBefore = Number.isFinite(Number(raw?.dateBefore)) ? Number(raw.dateBefore) : legacy.dateBefore;
    const dateAfter = Number.isFinite(Number(raw?.dateAfter)) ? Number(raw.dateAfter) : legacy.dateAfter;
    return { contentScopes: scopes.length ? scopes : ["all"], includeKeywords, excludeKeywords, includeKeywordsEnabled, excludeKeywordsEnabled, keywordMatchMode, protectPinned: raw?.protectPinned === undefined ? legacy.protectPinned : Boolean(raw.protectPinned), protectFiles: Boolean(raw?.protectFiles), protectLinks: Boolean(raw?.protectLinks), dateMode, dateBefore, dateAfter };
}

function legacyRules(filter: Filter): DeletionRules {
    const scopes: ContentScope[] = [];
    if (filter.attachmentsOnly) scopes.push("files");
    if (filter.linksOnly) scopes.push("links");
    if (filter.textOnly) scopes.push("all");
    return {
        contentScopes: scopes.length ? scopes : ["all"],
        includeKeywords: filter.keyword ? [filter.keyword] : [],
        excludeKeywords: filter.excludeKeyword ? [filter.excludeKeyword] : [],
        protectPinned: Boolean(filter.skipPinned),
        protectFiles: false,
        protectLinks: false,
        dateMode: filter.after && filter.before ? "range" : filter.before ? "before" : filter.after ? "after" : "none",
        dateBefore: filter.before,
        dateAfter: filter.after,
    };
}

function isImageAttachment(attachment: any) {
    const type = String(attachment?.content_type || attachment?.contentType || "").toLowerCase();
    const name = String(attachment?.filename || attachment?.name || "").toLowerCase();
    return type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(name);
}

function keywordMatches(haystack: string, keyword: string, mode: "partial" | "exact") {
    const normalized = String(keyword || "").trim().toLocaleLowerCase();
    if (!normalized) return false;
    if (mode === "partial") return haystack.includes(normalized);
    try { return new RegExp(`(?:^|[^\p{L}\p{N}_])${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^\p{L}\p{N}_])`, "iu").test(haystack); } catch { return haystack === normalized; }
}

function matchesFilter(message: any, filter: Filter, rules?: DeletionRules) {
    const active = rules || legacyRules(filter);
    const timestamp = messageTime(message);
    if (active.dateMode === "before" && active.dateBefore && timestamp > active.dateBefore) return false;
    if (active.dateMode === "after" && active.dateAfter && timestamp < active.dateAfter) return false;
    if (active.dateMode === "range" && ((active.dateAfter && timestamp < active.dateAfter) || (active.dateBefore && timestamp > active.dateBefore))) return false;
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    const hasAttachment = Boolean(attachments.length || message?.embeds?.length);
    const hasImage = attachments.some(isImageAttachment);
    const hasFile = attachments.some((attachment: any) => !isImageAttachment(attachment));
    const hasMessageLink = hasLink(message);
    const scopes = active.contentScopes?.length ? active.contentScopes : ["all"];
    const hasPlainMessage = Boolean(String(message?.content || "").trim()) && !hasImage && !hasFile && !hasMessageLink;
    const scopeMatches = scopes.includes("all") || (scopes.includes("messages") && hasPlainMessage) || (scopes.includes("images") && hasImage) || (scopes.includes("links") && hasMessageLink) || (scopes.includes("files") && hasFile);
    if (!scopeMatches) return false;
    if (active.protectPinned && message?.pinned) return false;
    if (active.protectFiles && hasFile) return false;
    if (active.protectLinks && hasMessageLink) return false;
    const haystack = `${message?.content || ""} ${message?.embeds?.map((embed: any) => `${embed?.title || ""} ${embed?.description || ""}`).join(" ") || ""}`.toLocaleLowerCase();
    if (active.includeKeywordsEnabled && active.includeKeywords?.length && !active.includeKeywords.some((keyword) => keywordMatches(haystack, keyword, active.keywordMatchMode))) return false;
    if (active.excludeKeywordsEnabled && active.excludeKeywords?.some((keyword) => keywordMatches(haystack, keyword, "partial"))) return false;
    return true;
}

function cloneJson<T>(value: T): T {
    try {
        return JSON.parse(JSON.stringify(value)) as T;
    } catch {
        return value;
    }
}

function snapshotSettings(settings: CleanupSettings, channelId: string, ownerId: string): JobSnapshot {
    const frozen = cloneJson(settings);
    return {
        capturedAt: now(),
        channelId: String(channelId),
        ownerId: String(ownerId),
        targetKind: frozen.target?.kind,
        rules: cloneJson(frozen.deletionRules),
        filter: cloneJson(frozen.filter),
        maxPerRun: Math.max(1, Math.min(MAX_MESSAGES_PER_RUN, Number(frozen.maxPerRun) || MAX_MESSAGES_PER_RUN)),
        deleteDelayMs: Math.max(MIN_DELETE_DELAY_MS, Math.min(MAX_DELETE_DELAY_MS, Number(frozen.deleteDelayMs) || MIN_DELETE_DELAY_MS)),
    };
}

function audit(job: CleanupJob, action: string, reason: string, messageId?: string, detail?: string) {
    if (!Array.isArray(job.auditLog)) job.auditLog = [];
    const entry: AuditEntry = { timestamp: now(), action: String(action).slice(0, 48), reason: String(reason).slice(0, 220) };
    if (messageId) entry.messageId = String(messageId);
    if (job.channelId) entry.channelId = String(job.channelId);
    if (detail) entry.detail = String(detail).slice(0, 220);
    job.auditLog.push(entry);
    if (job.auditLog.length > MAX_AUDIT_ENTRIES) job.auditLog = job.auditLog.slice(-MAX_AUDIT_ENTRIES);
}

function ensureSafetyFields(job: CleanupJob) {
    if (!Array.isArray(job.seenIds)) job.seenIds = [];
    if (!Array.isArray(job.deletedIds)) job.deletedIds = [];
    if (!Array.isArray(job.auditLog)) job.auditLog = [];
    if (!Number.isFinite(Number(job.consecutiveErrors))) job.consecutiveErrors = 0;
    if (!Number.isFinite(Number(job.consecutiveRateLimits))) job.consecutiveRateLimits = 0;
    if (!Number.isFinite(Number(job.unexpectedResponses))) job.unexpectedResponses = 0;
    if (!job.snapshot || job.snapshot.channelId !== job.channelId || job.snapshot.ownerId !== job.ownerId) {
        job.snapshot = snapshotSettings(job.options || defaultSettings(), job.channelId, job.ownerId);
        audit(job, "snapshot-created", "Created a fixed safety snapshot for this job");
    } else {
        job.snapshot = { ...job.snapshot, rules: cloneJson(job.snapshot.rules), filter: cloneJson(job.snapshot.filter) };
    }
}

function currentAccountId(): string | undefined {
    try {
        const user = findByProps("getCurrentUser")?.getCurrentUser?.();
        return user?.id ? String(user.id) : undefined;
    } catch {
        return undefined;
    }
}

function dateMatchesSnapshot(message: any, snapshot: JobSnapshot): boolean {
    const rules = snapshot.rules;
    if (rules.dateMode === "none") return true;
    const timestamp = messageTime(message);
    if (!timestamp) return false;
    if (rules.dateMode === "before" && rules.dateBefore && timestamp > rules.dateBefore) return false;
    if (rules.dateMode === "after" && rules.dateAfter && timestamp < rules.dateAfter) return false;
    if (rules.dateMode === "range" && ((rules.dateAfter && timestamp < rules.dateAfter) || (rules.dateBefore && timestamp > rules.dateBefore))) return false;
    return true;
}

function verifyMessageSafe(job: CleanupJob, message: any): VerificationResult {
    ensureSafetyFields(job);
    const snapshot = job.snapshot;
    const id = String(message?.id || "");
    if (job.circuitOpen) return { ok: false, reason: "circuit-open" };
    if (!snapshot) return { ok: false, reason: "missing-snapshot" };
    if (!id) return { ok: false, reason: "missing-message-id" };
    if (String(job.channelId) !== String(snapshot.channelId)) return { ok: false, reason: "job-channel-mismatch" };
    if (String(job.ownerId) !== String(snapshot.ownerId)) return { ok: false, reason: "job-author-mismatch" };
    if (messageChannelId(message) !== String(snapshot.channelId)) return { ok: false, reason: "message-channel-mismatch", detail: `message=${messageChannelId(message) || "missing"} expected=${snapshot.channelId}` };
    const authorId = messageAuthorId(message);
    if (!authorId) return { ok: false, reason: "author-unavailable", detail: `message=missing expected=${snapshot.ownerId}` };
    if (authorId !== String(snapshot.ownerId)) return { ok: false, reason: "message-author-mismatch", detail: `message=${authorId} expected=${snapshot.ownerId}` };
    if ((job.seenIds || []).includes(id) || (job.deletedIds || []).includes(id)) return { ok: false, reason: "already-processed" };
    const accountId = currentAccountId();
    if (accountId && accountId !== String(snapshot.ownerId)) return { ok: false, reason: "account-changed" };
    try {
        const settings = loadSettings();
        if (String(settings.targetChannelId || "") !== String(snapshot.channelId)) return { ok: false, reason: "target-changed" };
    } catch {
        return { ok: false, reason: "settings-unavailable" };
    }
    if (!dateMatchesSnapshot(message, snapshot)) return { ok: false, reason: "outside-date-rule" };
    if (!matchesFilter(message, snapshot.filter, snapshot.rules)) return { ok: false, reason: "rules-rejected" };
    return { ok: true, reason: "verified" };
}

function createStats(completion: CleanupStats["completion"] = "running"): CleanupStats {
    return { startedAt: now(), scanned: 0, matched: 0, deleted: 0, skipped: 0, failed: 0, historyPages: 0, rateLimitWaits: 0, totalWaitMs: 0, pausedMs: 0, completion };
}

function normalizeProgressHistory(value: unknown): ProgressPoint[] {
    if (!Array.isArray(value)) return [];
    return value.filter((point: any) => point && Number.isFinite(Number(point.timestamp))).slice(-200).map((point: any, index: number) => ({
        index,
        timestamp: Number(point.timestamp),
        scanned: Math.max(0, Number(point.scanned) || 0),
        matched: Math.max(0, Number(point.matched) || 0),
        deleted: Math.max(0, Number(point.deleted) || 0),
        failed: Math.max(0, Number(point.failed) || 0),
    }));
}

function recordProgressPoint(job: CleanupJob) {
    if (!Array.isArray(job.progressHistory)) job.progressHistory = [];
    const previous = job.progressHistory[job.progressHistory.length - 1];
    const point = { index: job.progressHistory.length, timestamp: now(), scanned: job.stats.scanned, matched: job.stats.matched, deleted: job.stats.deleted, failed: job.stats.failed };
    if (previous && previous.scanned === point.scanned && previous.matched === point.matched && previous.deleted === point.deleted && previous.failed === point.failed) return;
    job.progressHistory.push(point);
    if (job.progressHistory.length > 200) job.progressHistory = job.progressHistory.slice(-200).map((item, index) => ({ ...item, index }));
}

function defaultJob(channelId: string, ownerId: string): CleanupJob {
    const settings = cloneJson(loadSettings());
    const job: CleanupJob = { schema: 5, active: true, channelId, ownerId, startedAt: now(), cursor: undefined, historyCursor: undefined, historyNoProgress: 0, historyOwnerMissPages: 0, historyOwnerFound: false, historyLastPageSignature: undefined, historyHasMore: undefined, historyStarted: false, historyBatch: [], historyLastRequestAt: 0, historyRestDisabled: false, authorSearchEscalated: false, seenIds: [], deletedIds: [], resumePoint: undefined, pendingDelete: undefined, snapshot: snapshotSettings(settings, channelId, ownerId), consecutiveErrors: 0, consecutiveRateLimits: 0, unexpectedResponses: 0, circuitOpen: false, circuitReason: undefined, auditLog: [], options: settings, stats: createStats(), progressHistory: [], checkpointSeeded: false, checkpointLatestPrimed: false, recentOnly: false, recentFrontierId: undefined, recentFrontierReached: false };
    audit(job, "job-start", "Captured fixed target, account, rules, and limits");
    return job;
}

function retainSeen(job: CleanupJob, id: string) {
    const normalizedId = String(id);
    if (job.seenIds.includes(normalizedId)) return;
    job.seenIds.push(normalizedId);
    if (job.seenIds.length > MAX_SEEN_IDS) job.seenIds.splice(0, job.seenIds.length - MAX_SEEN_IDS);
}

function visibleOwnMessages(channelId: string, ownerId: string, job?: CleanupJob) {
    const seen = new Set(job?.seenIds || []);
    return loadedChannelMessages(channelId)
        .filter((message) => messageAuthorId(message) === ownerId)
        .filter((message) => !seen.has(String(message.id)));
}

function findHistoryActions() {
    const names = ["fetchMessages", "loadMessages", "getMessagesAround"];
    for (const name of names) {
        try {
            const candidate = findByProps(name);
            if (candidate && typeof candidate[name] === "function") return candidate;
        } catch {
            // Metro exports can disappear between Discord builds.
        }
    }
    return undefined;
}

function historyResult(value: any) {
    const messages = messageArray(value?.messages || value?.items || value?.data || value?.body || value);
    const rawHasMore = value?.hasMore ?? value?.has_more ?? value?.more ?? value?.mightHaveMore;
    const hasMore = typeof rawHasMore === "boolean" ? rawHasMore : undefined;
    return { messages, hasMore };
}

function withTimeout<T>(promiseLike: Promise<T>, timeoutMs: number) {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`History request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        Promise.resolve(promiseLike).then((value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
    });
}

function findRestApi() {
    try {
        const candidate = findByProps("getAPIBaseURL", "get");
        return candidate && typeof candidate.get === "function" ? candidate : undefined;
    } catch {
        return undefined;
    }
}

async function restGet(api: any, url: string, query: any, timeoutMs = HISTORY_REQUEST_TIMEOUT_MS): Promise<any> {
    const read = async (call: Promise<any>) => {
        const response = await withTimeout(call, timeoutMs);
        if (response?.ok === false || response?.response?.ok === false) throw response;
        return response;
    };
    try {
        return await read(Promise.resolve(api.get({ url, query })));
    } catch (error: any) {
        const httpFailure = error?.ok === false || Number(error?.status || error?.statusCode) >= 400 || error?.response?.ok === false;
        if (httpFailure) throw error;
        return await read(Promise.resolve(api.get(url, query)));
    }
}
function channelGuildId(channelId: string): string | undefined {
    try {
        const stores = [storeWithMethods(["getChannel"]), storeWithMethods(["getChannelById"]), storeWithMethods(["getCachedChannel"])];
        for (const channelStore of stores) {
            const channel = channelStore?.getChannel?.(channelId) || channelStore?.getChannelById?.(channelId) || channelStore?.getCachedChannel?.(channelId);
            const guildId = channel?.guild_id || channel?.guildId || channel?.serverId || channel?.guild?.id || channel?.server?.id;
            if (guildId) return String(guildId);
        }
    } catch {
        // DMs and partially loaded channels do not have a guild id.
    }
    return undefined;
}

function snowflakeFromTimestamp(timestamp: number): string | undefined {
    try {
        if (!Number.isFinite(timestamp)) return undefined;
        const discordEpoch = BigInt("1420070400000");
        const value = BigInt(Math.max(0, Math.floor(timestamp))) - discordEpoch;
        return String((value > BigInt(0) ? value : BigInt(0)) << BigInt(22));
    } catch {
        return undefined;
    }
}

function snowflakeTimestamp(id: string | undefined): number {
    try {
        if (!id) return 0;
        return Number(BigInt(id) >> BigInt(22)) + 1420070400000;
    } catch {
        return 0;
    }
}

function authorSearchMessageArray(value: any): any[] {
    const body = value?.body && typeof value.body === "object" ? value.body : value;
    const raw = body?.messages ?? body?.items ?? body?.data?.messages;
    const messages: any[] = [];
    const append = (entry: any) => {
        if (Array.isArray(entry)) {
            for (const item of entry) append(item);
            return;
        }
        if (entry?.messages && Array.isArray(entry.messages)) {
            append(entry.messages);
            return;
        }
        if (entry?.id) messages.push(entry);
    };
    append(raw);
    return messages;
}

let authorSearchNextAt = 0;
let authorSearchActive = 0;
const authorSearchWaiters: Array<() => void> = [];

async function withAuthorSearchWorker<T>(task: () => Promise<T>): Promise<T> {
    if (authorSearchActive >= AUTHOR_SEARCH_WORKERS) await new Promise<void>((resolve) => authorSearchWaiters.push(resolve));
    authorSearchActive += 1;
    try {
        return await task();
    } finally {
        authorSearchActive -= 1;
        const next = authorSearchWaiters.shift();
        if (next) next();
    }
}

async function reserveAuthorSearchRequest(job: CleanupJob) {
    const waitForGap = Math.max(0, authorSearchNextAt - now());
    if (waitForGap) {
        job.stats.totalWaitMs += waitForGap;
        await sleep(waitForGap);
    }
    authorSearchNextAt = now() + AUTHOR_SEARCH_GAP_MS;
    job.historyLastRequestAt = now();
}

function authorSearchResult(value: any) {
    const body = value?.body && typeof value.body === "object" ? value.body : value;
    const messages = authorSearchMessageArray(value);
    const rawTotal = body?.total_results ?? body?.totalResults;
    const totalResults = rawTotal === undefined ? undefined : Number(rawTotal);
    const retryAfter = Number(body?.retry_after ?? body?.retryAfter ?? 0);
    const doingDeepHistoricalIndex = Boolean(body?.doing_deep_historical_index ?? body?.doingDeepHistoricalIndex);
    const indexNotReady = body?.documents_indexed !== undefined && !messages.length;
    const recognized = Array.isArray(body) || Array.isArray(body?.messages) || Array.isArray(body?.items) || Array.isArray(body?.data?.messages) || body?.documents_indexed !== undefined || body?.retry_after !== undefined;
    return { messages, totalResults: Number.isFinite(totalResults as number) ? totalResults : undefined, retryAfter: Number.isFinite(retryAfter) ? retryAfter : 0, doingDeepHistoricalIndex, indexNotReady, recognized };
}

function snowflakeAsBigInt(value: string | undefined) {
    try {
        return value ? BigInt(value) : BigInt(0);
    } catch {
        return BigInt(0);
    }
}

type AuthorSearchWindow = { minId?: string; maxId?: string };

function authorSearchQuery(job: CleanupJob, offset: number, window: AuthorSearchWindow) {
    const query: any = { author_id: job.ownerId, channel_id: job.channelId, limit: AUTHOR_SEARCH_PAGE_SIZE, offset };
    if (window.minId) query.min_id = window.minId;
    if (window.maxId) query.max_id = window.maxId;
    return query;
}

async function requestAuthorSearchPage(api: any, guildId: string | undefined, job: CleanupJob, offset: number, window: AuthorSearchWindow) {
    const query = authorSearchQuery(job, offset, window);
    const paths = guildId ? [`/guilds/${guildId}/messages/search`, `/channels/${job.channelId}/messages/search`] : [`/channels/${job.channelId}/messages/search`];
    let firstError: unknown;
    for (const path of paths) {
        try {
            return await restGet(api, path, query, AUTHOR_SEARCH_TIMEOUT_MS);
        } catch (error) {
            if (isRateLimitError(error)) throw error;
            firstError ||= error;
        }
    }
    throw firstError || new Error("Author search endpoint unavailable");
}
async function searchAuthorWindow(api: any, guildId: string | undefined, job: CleanupJob, window: AuthorSearchWindow) {
    let offset = 0;
    let totalResults: number | undefined;
    let collected: any[] = [];
    let indexRetries = 0;
    let rateLimitRetries = 0;
    while (offset <= AUTHOR_SEARCH_MAX_OFFSET && !cancelled && now() - Number(job.authorSearchStartedAt || now()) < AUTHOR_SEARCH_BUDGET_MS) {
        let response: any;
        try {
            await reserveAuthorSearchRequest(job);
            response = await requestAuthorSearchPage(api, guildId, job, offset, window);
                } catch (error) {
            if (isAuthorSearchUnsupportedError(error)) {
                job.authorSearchUnsupported = true;
                job.stats.lastError = "Discord does not support indexed message search for this channel type; using guarded history pagination.";
                audit(job, "author-search-unsupported", job.stats.lastError);
                saveJob(job);
                return { requested: false, tooLarge: false, messages: [] as any[] };
            }
            if (isRateLimitError(error) && rateLimitRetries < 3) {
                rateLimitRetries += 1;
                const retryDelay = Math.min(15_000, Math.max(1_250, retryAfterMs(error) + 250));
                job.stats.rateLimitWaits += 1;
                job.stats.totalWaitMs += retryDelay;
                job.stats.lastError = `Author search rate limited; retrying in ${Math.ceil(retryDelay / 1000)}s (${rateLimitRetries}/3)`;
                audit(job, "author-search-rate-limit", job.stats.lastError);
                saveJob(job);
                await sleep(retryDelay);
                continue;
            }
            noteFailure(job, error, "author search");
            job.stats.lastError = `Author search unavailable: ${safeError(error)}`;
            saveJob(job);
            return { requested: false, tooLarge: false, messages: [] as any[] };
        }
        rateLimitRetries = 0;
        const result = authorSearchResult(response);
        if (!result.recognized) {
            noteUnexpectedResponse(job, "author search response shape was not recognized");
            return { requested: false, tooLarge: false, messages: [] as any[] };
        }
        if (result.doingDeepHistoricalIndex || result.indexNotReady) {
            indexRetries += 1;
            if (indexRetries > AUTHOR_SEARCH_INDEX_RETRIES) {
                job.stats.lastError = "Author search index is still being built; using channel history fallback.";
                return { requested: false, tooLarge: false, messages: [] as any[] };
            }
            const retryDelay = Math.min(15_000, Math.max(1_000, result.retryAfter > 0 ? Math.round(result.retryAfter * 1000) : 2_000));
            job.stats.totalWaitMs += retryDelay;
            job.stats.rateLimitWaits += 1;
            saveJob(job);
            await sleep(retryDelay);
            continue;
        }
        indexRetries = 0;
        if (result.totalResults !== undefined) {
            totalResults = result.totalResults;
            if (totalResults > AUTHOR_SEARCH_WINDOW_RESULT_LIMIT) return { requested: true, tooLarge: true, messages: [] as any[] };
        }
        const pageMessages = result.messages.filter((message) => messageChannelId(message) === job.channelId && messageAuthorId(message) === job.ownerId);
        collected = collected.concat(pageMessages);
        job.stats.historyPages += 1;
        recordProgressPoint(job);
        saveJob(job);
        if (totalResults === 0 || (totalResults !== undefined && offset + result.messages.length >= totalResults) || (totalResults === undefined && result.messages.length < AUTHOR_SEARCH_PAGE_SIZE)) {
            return { requested: true, tooLarge: false, messages: uniqueChannelMessages(collected, job.channelId) };
        }
        if (!result.messages.length) return { requested: false, tooLarge: false, messages: [] as any[] };
        offset += result.messages.length;
    }
    return { requested: false, tooLarge: false, messages: [] as any[] };
}

async function collectAuthorSearchWindow(api: any, guildId: string, job: CleanupJob, window: AuthorSearchWindow, depth: number): Promise<any[] | undefined> {
    if (now() - Number(job.authorSearchStartedAt || now()) >= AUTHOR_SEARCH_BUDGET_MS) return undefined;
    const result = await withAuthorSearchWorker(() => searchAuthorWindow(api, guildId, job, window));
    if (!result.requested) return undefined;
    if (!result.tooLarge) return result.messages;
    if (depth >= AUTHOR_SEARCH_MAX_SPLIT_DEPTH) return undefined;
    const low = snowflakeAsBigInt(window.minId);
    const high = snowflakeAsBigInt(window.maxId || snowflakeFromTimestamp(now() + 60_000));
    if (high <= low + BigInt(1)) return undefined;
    const middle = (low + high) / BigInt(2);
    const left: AuthorSearchWindow = { ...(window.minId ? { minId: window.minId } : {}), maxId: String(middle) };
    const right: AuthorSearchWindow = { minId: String(middle), ...(window.maxId ? { maxId: window.maxId } : {}) };
    const leftPart = await collectAuthorSearchWindow(api, guildId, job, left, depth + 1);
    const rightPart = await collectAuthorSearchWindow(api, guildId, job, right, depth + 1);
    const parts = [leftPart, rightPart];
    if (!parts[0] || !parts[1]) return undefined;
    return uniqueChannelMessages(parts[0].concat(parts[1]), job.channelId);
}

async function requestAuthorSearchHistory(job: CleanupJob) {
    const api = findRestApi();
    const guildId = channelGuildId(job.channelId);
    if (!api) {
        job.stats.lastError = "Indexed author search API was not exposed by this Revenge build.";
        audit(job, "author-search-unavailable", job.stats.lastError);
        saveJob(job);
        return { requested: false, complete: false, messages: [] as any[] };
    }
    audit(job, "author-search-start", `Searching indexed messages for account ${job.ownerId} in channel ${job.channelId}`);
    const rules = job.options.deletionRules;
    job.authorSearchStartedAt = now();
    const minId = rules.dateMode === "after" || rules.dateMode === "range" ? snowflakeFromTimestamp(Number(rules.dateAfter)) : undefined;
    const dateMaxId = rules.dateMode === "before" || rules.dateMode === "range" ? snowflakeFromTimestamp(Number(rules.dateBefore)) : snowflakeFromTimestamp(now() + 60_000);
    const cursorMaxId = job.historyCursor ? String(job.historyCursor) : undefined;
    const maxId = dateMaxId && cursorMaxId ? (snowflakeAsBigInt(cursorMaxId) < snowflakeAsBigInt(dateMaxId) ? cursorMaxId : dateMaxId) : cursorMaxId || dateMaxId;
    const messages = await collectAuthorSearchWindow(api, guildId, job, { ...(minId ? { minId } : {}), ...(maxId ? { maxId } : {}) }, 0);
    if (!messages) return { requested: false, complete: false, messages: [] as any[] };
    return { requested: true, complete: true, messages: uniqueChannelMessages(messages, job.channelId) };
}

async function requestRestHistoryPage(api: any, channelId: string, before: string | undefined) {
    const response = await api.get({
        url: `/channels/${channelId}/messages`,
        query: { limit: HISTORY_PAGE_SIZE, ...(before ? { before } : {}) },
    });
    const result = historyResult(response);
    const hasRecognizedPayload = Array.isArray(response) || Array.isArray(response?.messages) || Array.isArray(response?.items) || Array.isArray(response?.data) || Array.isArray(response?.body);
    if (!result.messages.length && typeof result.hasMore !== "boolean" && !hasRecognizedPayload) return { requested: false, messages: [], hasMore: undefined };
    return { requested: true, messages: result.messages, hasMore: typeof result.hasMore === "boolean" ? result.hasMore : result.messages.length >= HISTORY_PAGE_SIZE };
}

async function requestInternalHistoryPage(actions: any, channelId: string, before: string | undefined) {
    const fetcher = actions?.fetchMessages || actions?.loadMessages || actions?.getMessagesAround;
    if (!fetcher) return { requested: false, messages: [], hasMore: undefined };
    const request = { channelId, limit: HISTORY_PAGE_SIZE, ...(before ? { before } : {}) };
    const calls: Array<() => Promise<any>> = [
        () => Promise.resolve(fetcher.call(actions, request)),
        () => Promise.resolve(fetcher.call(actions, channelId, request)),
        () => Promise.resolve(fetcher.call(actions, channelId, HISTORY_PAGE_SIZE, before)),
    ];
    let firstError: unknown;
    for (let index = 0; index < calls.length; index += 1) {
        try {
            const result = historyResult(await withTimeout(calls[index](), HISTORY_REQUEST_TIMEOUT_MS));
            if (result.messages.length || result.hasMore === false) {
                return { requested: true, messages: result.messages, hasMore: typeof result.hasMore === "boolean" ? result.hasMore : result.messages.length >= HISTORY_PAGE_SIZE };
            }
        } catch (error) {
            firstError ||= error;
        }
    }
    if (firstError) throw firstError;
    return { requested: true, messages: [], hasMore: undefined };
}

function messageSignature(messages: any[]) {
    return messages.map((message) => String(message?.id || "")).filter(Boolean).join(",");
}

function countNewMessages(before: any[], after: any[]) {
    const existing = new Set(before.map((message) => String(message?.id || "")).filter(Boolean));
    return after.reduce((count, message) => count + (existing.has(String(message?.id || "")) ? 0 : 1), 0);
}

async function requestOlderMessages(channelId: string, before: string | undefined, job?: CleanupJob) {
    const api = findRestApi();
    const actions = findHistoryActions();
    const sources: Array<() => Promise<any>> = [];
    if (api && !job?.historyRestDisabled) sources.push(() => requestRestHistoryPage(api, channelId, before));
    if (actions) sources.push(() => requestInternalHistoryPage(actions, channelId, before));
    if (!sources.length) return { requested: false, messages: [], hasMore: undefined };
    let firstError: unknown;
    let retryDelayOverride = 0;
    let serviceUnavailableSeen = false;
    for (let attempt = 0; attempt < MAX_HISTORY_PAGE_RETRIES; attempt += 1) {
        const lastRequestAt = Number(job?.historyLastRequestAt || 0);
        const waitForGap = Math.max(0, HISTORY_PAGE_GAP_MS - (now() - lastRequestAt));
        if (waitForGap) await sleep(waitForGap);
        for (let index = 0; index < sources.length; index += 1) {
            try {
                if (job) job.historyLastRequestAt = now();
                const result = await withTimeout(sources[index](), HISTORY_REQUEST_TIMEOUT_MS);
                if (result.requested === false) {
                    if (index === 0 && job) job.historyRestDisabled = true;
                    continue;
                }
                if (job) job.historyStarted = true;
                if (result.messages.length || result.hasMore === false) return { requested: true, messages: result.messages, hasMore: result.hasMore };
            } catch (error) {
                firstError ||= error;
                serviceUnavailableSeen ||= /\b503\b|service unavailable/i.test(safeError(error));
                retryDelayOverride = Math.max(retryDelayOverride, retryAfterMs(error));
                if (job) noteFailure(job, error, `history source ${index + 1}`);
                if (index === 0 && job && /timed out|unavailable|not a function|invalid/i.test(safeError(error))) job.historyRestDisabled = true;
                if (job) job.stats.lastError = `History source ${index + 1} unavailable: ${safeError(error)}`;
            }
        }
        if (serviceUnavailableSeen && attempt >= 1) break;
        if (job) {
            job.stats.rateLimitWaits += 1;
            const delay = serviceUnavailableSeen ? Math.min(2_000, Math.max(750, retryDelayOverride)) : Math.min(15_000, Math.max(750 * 2 ** attempt, retryDelayOverride));
            job.stats.totalWaitMs += delay;
            job.stats.lastError = `History page retry ${attempt + 1}/${MAX_HISTORY_PAGE_RETRIES}: ${safeError(firstError)}`;
            saveJob(job);
        }
        await sleep(serviceUnavailableSeen ? Math.min(2_000, Math.max(750, retryDelayOverride)) : Math.min(15_000, Math.max(750 * 2 ** attempt, retryDelayOverride)));
        retryDelayOverride = 0;
    }
    if (job) {
        job.stats.lastError = firstError ? `History loading unavailable: ${safeError(firstError)}` : "History loading is unavailable in this Discord build.";
        noteUnexpectedResponse(job, job.stats.lastError);
    }
    return { requested: false, messages: [], hasMore: undefined };
}

function isDirectMessageJob(job: CleanupJob) {
    return job.snapshot?.targetKind === "dm" || job.options.target?.kind === "dm";
}

function initializeOwnerCursor(job: CleanupJob) {
    if (isDirectMessageJob(job) || job.historyStarted || job.historyCursor) return false;
    const latestOwn = visibleOwnMessages(job.channelId, job.ownerId, job).sort((a, b) => snowflakeAsBigInt(String(b.id)) > snowflakeAsBigInt(String(a.id)) ? 1 : -1)[0];
    if (!latestOwn?.id) return false;
    job.historyCursor = String(latestOwn.id);
    job.historyStarted = true;
    job.authorSearchEscalated = false;
    job.historyOwnerFound = true;
    audit(job, "owner-cursor-jump", "Started history before the latest loaded message belonging to the current user", String(latestOwn.id));
    return true;
}

function initializeHistoricalCursor(job: CleanupJob) {
    if (!isDirectMessageJob(job) || job.historyStarted || job.historyCursor) return false;
    const rules = job.snapshot?.rules || job.options.deletionRules;
    if (rules.dateMode !== "before" && rules.dateMode !== "range") return false;
    const dateBefore = Number(rules.dateBefore);
    const cursor = snowflakeFromTimestamp(dateBefore);
    if (!cursor) return false;
    job.historyCursor = cursor;
    audit(job, "history-date-jump", "Started DM history at the Snowflake boundary for the selected upper date", cursor);
    return true;
}

function historyReachedLowerBound(job: CleanupJob, messages: any[]) {
    const rules = job.snapshot?.rules || job.options.deletionRules;
    if (rules.dateMode !== "after" && rules.dateMode !== "range") return false;
    const dateAfter = Number(rules.dateAfter);
    if (!Number.isFinite(dateAfter) || dateAfter <= 0 || !messages.length) return false;
    const oldestMessage = messages[0];
    const oldestTimestamp = messageTime(oldestMessage) || snowflakeTimestamp(String(oldestMessage?.id || ""));
    return oldestTimestamp > 0 && oldestTimestamp < dateAfter;
}

function formatDuration(ms: number) {
    const seconds = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const rest = seconds % 60;
    return hours ? `${hours}h ${minutes}m` : `${minutes}m ${rest}s`;
}

function formatDate(value?: number) {
    return value ? new Date(value).toLocaleString() : "—";
}

function filterText(filter: Filter) {
    const parts: string[] = [];
    if (filter.after) parts.push(`${rt("after")} ${formatDate(filter.after)}`);
    if (filter.before) parts.push(`${rt("before")} ${formatDate(filter.before)}`);
    if (filter.keyword) parts.push(`${rt("contains")} "${filter.keyword}"`);
    if (filter.excludeKeyword) parts.push(`${rt("excludes")} "${filter.excludeKeyword}"`);
    if (filter.attachmentsOnly) parts.push(rt("attachments"));
    if (filter.linksOnly) parts.push(rt("links"));
    if (filter.textOnly) parts.push(rt("textOnly"));
    if (filter.skipPinned) parts.push(rt("skipPinned"));
    return parts.length ? parts.join(", ") : rt("allOwnMessages");
}

function deletionRulesText(rules: DeletionRules) {
    const parts: string[] = [];
    const scopes = rules.contentScopes.includes("all") ? rt("allOwnMessages") : rules.contentScopes.map((scope) => rt(scope as keyof typeof runtimeText.en)).join(", ");
    parts.push(scopes || rt("allOwnMessages"));
    if (rules.includeKeywords.length) parts.push(`${rt("contains")}: ${rules.includeKeywords.join(", ")}`);
    if (rules.excludeKeywords.length) parts.push(`${rt("excludes")}: ${rules.excludeKeywords.join(", ")}`);
    if (rules.protectPinned) parts.push(rt("skipPinned"));
    if (rules.protectFiles) parts.push(`${rt("protectFiles")}`);
    if (rules.protectLinks) parts.push(`${rt("protectLinks")}`);
    if (rules.dateMode !== "none") parts.push(`${rt("dateMode")}: ${rules.dateMode}`);
    return parts.join(", ");
}

function reportText(job: CleanupJob) {
    const stats = job.stats;
    const elapsed = activeElapsedMs(stats);
    const limitLine = stats.deleted >= job.options.maxPerRun ? `\n${rt("sessionLimit")}: ${job.options.maxPerRun}` : "";
    const errorLine = stats.lastError ? `\n${rt("lastNote")}: ${stats.lastError}` : "";
    return [
        rt("reportHeader"),
        `${rt("status")}: ${completionText(stats.completion)}`,
        `${rt("deleted")}: ${stats.deleted} · ${rt("matched")}: ${stats.matched} · ${rt("failed")}: ${stats.failed}`,
        `${rt("scanned")}: ${stats.scanned} · ${rt("skipped")}: ${stats.skipped}`,
        `${rt("elapsed")}: ${formatDuration(elapsed)} · ${rt("historyPages")}: ${stats.historyPages}`,
    ].join("\n") + limitLine + errorLine;
}

function copyText(text: string) {
    try {
        const clipboard = findByProps("setString") || findByProps("setText");
        clipboard?.setString?.(text);
        clipboard?.setText?.(text);
        common.ReactNative.ToastAndroid?.show?.(rt("copied"), common.ReactNative.ToastAndroid.SHORT);
    } catch {
        // Clipboard is optional.
    }
}

function previewUpperBoundId(channelId: string): string {
    const loaded = loadedChannelMessages(channelId);
    return String(loaded[loaded.length - 1]?.id || snowflakeFromTimestamp(now() + 60_000) || "0");
}

function previewCandidateFromMessage(message: any, channelId: string): PreviewCandidate | null {
    const id = String(message?.id || "");
    if (!id || messageChannelId(message) !== String(channelId)) return null;
    return { id, channelId: String(channelId), ts: messageTime(message) || snowflakeTimestamp(id) };
}

function previewStats(plan: PreviewPlan): CleanupStats {
    return { ...createStats("preview"), scanned: plan.scanned, matched: plan.matched, skipped: plan.skipped, historyPages: plan.pages, startedAt: plan.createdAt };
}

function previewPlanFor(channelId: string, ownerId: string, settings: CleanupSettings): PreviewPlan {
    const existing = loadPreviewPlan();
    if (isPreviewPlanValid(existing, channelId, ownerId, settings)) return existing!;
    const createdAt = now();
    const scanUpperBoundId = previewUpperBoundId(channelId);
    return { channelId: String(channelId), ownerId: String(ownerId), fingerprint: previewFingerprint(channelId, ownerId, settings), scanUpperBoundId, nextCursor: scanUpperBoundId, seenIds: [], candidates: [], scanned: 0, matched: 0, skipped: 0, pages: 0, createdAt, expiresAt: createdAt + PREVIEW_EXPIRY_MS, complete: false };
}

function previewAddPage(plan: PreviewPlan, messages: any[], settings: CleanupSettings) {
    const known = new Set(plan.candidates.map((candidate) => String(candidate.id)));
    const seen = new Set((plan.seenIds || []).map((id) => String(id)));
    const pageIds = new Set<string>();
    const snapshot = snapshotSettings(settings, plan.channelId, plan.ownerId);
    for (const message of uniqueChannelMessages(messages, plan.channelId)) {
        const id = String(message?.id || "");
        if (!id || pageIds.has(id)) continue;
        pageIds.add(id);
        if (compareMessageIds(id, plan.scanUpperBoundId) > 0) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        if (messageAuthorId(message) !== String(plan.ownerId)) continue;
        plan.scanned += 1;
        if (matchesFilter(message, snapshot.filter, snapshot.rules)) {
            plan.matched += 1;
            if (!known.has(id) && plan.candidates.length < PREVIEW_MAX_CANDIDATES) {
                const candidate = previewCandidateFromMessage(message, plan.channelId);
                if (candidate) { plan.candidates.push(candidate); known.add(id); }
            }
        } else plan.skipped += 1;
    }
    plan.seenIds = Array.from(seen).slice(-MAX_SEEN_IDS);
}

async function startPreviewSession(channelId: string, ownerId: string, onProgress?: (plan: PreviewPlan) => void, onComplete?: (plan: PreviewPlan) => void) {
    if (previewRunning) return;
    const settings = cloneJson(loadSettings());
    const existing = loadPreviewPlan();
    const plan = isPreviewPlanValid(existing, channelId, ownerId, settings) ? existing! : previewPlanFor(channelId, ownerId, settings);
    if (plan.complete && isPreviewPlanValid(plan, channelId, ownerId, settings)) { onComplete?.(plan); return; }
    previewRunning = true;
    previewCancelled = false;
    const scanJob = defaultJob(channelId, ownerId);
    scanJob.active = true;
    scanJob.stats = previewStats(plan);
    scanJob.snapshot = snapshotSettings(settings, channelId, ownerId);
    scanJob.historyCursor = plan.nextCursor || plan.scanUpperBoundId;
    scanJob.historyStarted = true;
    const startedAt = now();
    try {
        if (!plan.pages && !plan.candidates.length) {
            const loaded = loadedChannelMessages(channelId).filter((message) => compareMessageIds(String(message?.id || ""), plan.scanUpperBoundId) <= 0);
            previewAddPage(plan, loaded, settings);
            savePreviewPlan(plan);
            onProgress?.(cloneJson(plan));
        }
        while (!previewCancelled && now() - startedAt < PREVIEW_BUDGET_MS && plan.pages < PREVIEW_MAX_PAGES && plan.candidates.length < PREVIEW_MAX_CANDIDATES) {
            const page = await requestOlderMessages(channelId, plan.nextCursor || plan.scanUpperBoundId, scanJob);
            if (!page.requested) { plan.lastError = scanJob.stats.lastError || "History loading is unavailable in this Discord build."; break; }
            plan.pages += 1;
            previewAddPage(plan, page.messages || [], settings);
            const pageMessages = uniqueChannelMessages(page.messages || [], channelId);
            plan.nextCursor = pageMessages[0]?.id || plan.nextCursor;
            if (!pageMessages.length || page.hasMore === false) { plan.complete = true; break; }
            if (historyReachedLowerBound(scanJob, pageMessages)) { plan.complete = true; break; }
            if (scanJob.recentOnly && scanJob.recentFrontierId && pageMessages.some((message) => compareMessageIds(String(message?.id || ""), String(scanJob.recentFrontierId)) <= 0)) { plan.complete = true; break; }
            savePreviewPlan(plan);
            onProgress?.(cloneJson(plan));
            if (now() - startedAt >= PREVIEW_BUDGET_MS || plan.pages >= PREVIEW_MAX_PAGES) break;
        }
        plan.stopped = previewCancelled;
        if (previewCancelled) plan.lastError = undefined;
        if (!previewCancelled && !plan.complete && now() - startedAt >= PREVIEW_BUDGET_MS) plan.lastError = "Preview time budget reached; resume to continue.";
        savePreviewPlan(plan);
        onComplete?.(cloneJson(plan));
    } catch (error) {
        plan.lastError = safeError(error);
        savePreviewPlan(plan);
        onComplete?.(cloneJson(plan));
    } finally {
        previewRunning = false;
        previewCancelled = false;
    }
}

function stopPreviewSession() {
    previewCancelled = true;
}

function previewMessageForCandidate(candidate: PreviewCandidate, plan: PreviewPlan): any | null {
    const loaded = loadedChannelMessages(plan.channelId);
    for (const message of loaded) if (String(message?.id || "") === String(candidate.id)) return message;
    return { id: String(candidate.id), channel_id: String(candidate.channelId), author_id: String(plan.ownerId), timestamp: candidate.ts ? new Date(candidate.ts).toISOString() : undefined };
}

async function runCleanupFromPreview(plan: PreviewPlan, onProgress?: (plan: PreviewPlan, job: CleanupJob) => void, onComplete?: (job: CleanupJob) => void) {
    if (running || !isPreviewPlanValid(plan, plan.channelId, plan.ownerId, loadSettings())) return;
    const settings = cloneJson(loadSettings());
    const job = defaultJob(plan.channelId, plan.ownerId);
    job.options = settings;
    job.snapshot = snapshotSettings(settings, plan.channelId, plan.ownerId);
    job.stats = createStats("running");
    job.active = true;
    currentJob = job;
    running = true;
    cancelled = false;
    pauseRequested = false;
    stopRequested = false;
    const executionId = Number(job.executionId || 0) + 1;
    job.executionId = executionId;
    const messageActions = findByProps("deleteMessage");
    if (!messageActions?.deleteMessage || currentAccountId() !== String(plan.ownerId)) {
        job.active = false;
        job.stats.completion = "unsupported";
        job.stats.endedAt = now();
        job.stats.lastError = "Required in-app message actions were not found, or the account changed.";
        running = false;
        saveJob(job);
        onComplete?.(job);
        return;
    }
    saveJob(job);
    try {
        let index = 0;
        while (index < plan.candidates.length && executionCanContinue(job, executionId) && job.stats.deleted < job.options.maxPerRun) {
            const candidate = plan.candidates[index];
            if (String(candidate.channelId) !== String(plan.channelId) || !candidate.id) { plan.candidates.splice(index, 1); savePreviewPlan(plan); continue; }
            const message = previewMessageForCandidate(candidate, plan);
            if (!message) { plan.candidates.splice(index, 1); savePreviewPlan(plan); continue; }
            job.stats.scanned += 1;
            const verification = verifyMessageSafe(job, message);
            let interrupted = false;
            if (verification.ok) {
                job.stats.matched += 1;
                await deleteCandidate(job, message, messageActions, executionId);
                interrupted = !executionCanContinue(job, executionId);
            } else {
                job.stats.skipped += 1;
                audit(job, "preview-delete-rejected", verification.reason, candidate.id, "Candidate was re-verified before deletion");
            }
            if (interrupted) {
                savePreviewPlan(plan);
                saveJob(job);
                break;
            }
            plan.candidates.splice(index, 1);
            plan.nextCursor = candidate.id;
            savePreviewPlan(plan);
            recordProgressPoint(job);
            saveJob(job);
            onProgress?.(cloneJson(plan), job);
        }
        const paused = pauseRequested && !stopRequested && !cancelled;
        job.stats.completion = stopRequested || cancelled ? "stopped" : paused ? "paused" : "finished";
        if (job.stats.completion === "paused") job.stats.endedAt = undefined;
        else finishTiming(job);
        if (job.stats.completion !== "paused") saveFinishedHistory(job);
        if (job.stats.completion !== "paused" && plan.candidates.length === 0) clearPreviewPlan();
        else savePreviewPlan(plan);
    } catch (error) {
        const paused = pauseRequested && !stopRequested && !cancelled && (isInterruptedError(error) || !executionCanContinue(job, executionId));
        job.stats.completion = paused ? "paused" : "stopped";
        if (paused) {
            job.stats.lastError = undefined;
            job.stats.endedAt = undefined;
        } else {
            job.stats.lastError = safeError(error);
            audit(job, "preview-purge-error", job.stats.lastError);
            finishTiming(job);
        }
        if (job.stats.completion !== "paused" && plan.candidates.length === 0) clearPreviewPlan();
        else savePreviewPlan(plan);
    } finally {
        job.active = false;
        running = false;
        currentJob = job;
        saveJob(job);
        onComplete?.(job);
    }
}

async function backoff(job: CleanupJob, reason: string, attempt: number, executionId?: number) {
    const delay = Math.min(60_000, 5_000 * Math.max(1, attempt));
    job.stats.rateLimitWaits += 1;
    job.stats.totalWaitMs += delay;
    job.stats.lastError = reason;
    saveJob(job);
    return interruptibleSleep(delay, job, executionId);
}

async function deleteCandidate(job: CleanupJob, message: any, messageActions: any, executionId?: number) {
    if (!executionCanContinue(job, executionId)) return false;
    const verification = verifyMessageSafe(job, message);
    const messageId = String(message?.id || "");
    if (!verification.ok) {
        job.stats.skipped += 1;
        audit(job, "delete-rejected", verification.reason, messageId);
        retainSeen(job, messageId);
        saveJob(job);
        return false;
    }
    const delay = Math.max(MIN_DELETE_DELAY_MS, job.options.deleteDelayMs || MIN_DELETE_DELAY_MS);
    let attempt = 0;
    while (executionCanContinue(job, executionId) && attempt < 3) {
        const beforeDelete = verifyMessageSafe(job, message);
        if (!beforeDelete.ok) {
            job.stats.skipped += 1;
            audit(job, "delete-rejected", beforeDelete.reason, messageId);
            retainSeen(job, messageId);
            saveJob(job);
            return false;
        }
        try {
            job.pendingDelete = { id: messageId, channelId: String(job.channelId), ownerId: String(job.ownerId), markedAt: now() };
            audit(job, "delete-intent", "Persisted pending deletion before invoking Discord action", messageId);
            saveJob(job);
            await withGlobalDeleteRateLimiter(job, () => messageActions.deleteMessage(job.channelId, messageId), executionId);
            job.stats.deleted += 1;
            noteDeleteSuccess(job);
            job.cursor = messageId;
            job.resumePoint = messageId;
            retainSeen(job, messageId);
            rememberDeleted(job, messageId);
            job.pendingDelete = undefined;
            audit(job, "delete-success", "Verified author, channel, rules, and date before deletion", messageId);
            saveJob(job);
            await interruptibleSleep(delay, job, executionId);
            return true;
        } catch (error) {
            if (isInterruptedError(error) || !executionCanContinue(job, executionId)) {
                job.pendingDelete = undefined;
                saveJob(job);
                return false;
            }
            attempt += 1;
            job.stats.failed += 1;
            noteFailure(job, error, `delete attempt ${attempt}`);
            audit(job, "delete-error", safeError(error), messageId, `attempt=${attempt}`);
            if (job.circuitOpen) break;
            const resumed = await backoff(job, safeError(error), attempt, executionId);
            if (!resumed) return false;
        }
    }
    if (!executionCanContinue(job, executionId)) return false;
    retainSeen(job, messageId);
    audit(job, "delete-abandoned", "Delete attempts exhausted", messageId);
    saveJob(job);
    return false;
}

function rememberDeleted(job: CleanupJob, id: string) {
    if (!id) return;
    if (!Array.isArray(job.deletedIds)) job.deletedIds = [];
    if (!job.deletedIds.includes(id)) job.deletedIds.push(id);
    if (job.deletedIds.length > MAX_SEEN_IDS) job.deletedIds = job.deletedIds.slice(-MAX_SEEN_IDS);
}

function recoverPendingDelete(job: CleanupJob) {
    const pending = job.pendingDelete;
    if (!pending) return;
    if (String(pending.channelId) !== String(job.channelId) || String(pending.ownerId) !== String(job.ownerId)) {
        audit(job, "pending-rejected", "Pending deletion does not match the fixed job snapshot", pending.id);
        job.pendingDelete = undefined;
        saveJob(job);
        return;
    }
    const loaded = loadedChannelMessages(job.channelId).concat(Array.isArray(job.historyBatch) ? job.historyBatch : []);
    const stillPresent = loaded.some((message: any) => String(message?.id || "") === String(pending.id));
    if (!stillPresent) {
        audit(job, "pending-unresolved", "Message is not currently loaded; keep the pending marker until it can be re-verified", pending.id);
    } else {
        audit(job, "pending-retry", "Pending deletion found in cache and will be re-verified before retry", pending.id);
    }
    saveJob(job);
}

function saveFinishedHistory(job: CleanupJob) {
    saveHistory({
        endedAt: job.stats.endedAt || now(),
        channelId: job.channelId,
        targetLabel: channelLabel(job.channelId) || undefined,
        targetImageUrl: channelAvatarUrl(job.channelId),
        completion: job.stats.completion,
        scanned: job.stats.scanned,
        matched: job.stats.matched,
        deleted: job.stats.deleted,
        skipped: job.stats.skipped,
        failed: job.stats.failed,
        historyPages: job.stats.historyPages,
        elapsedMs: activeElapsedMs(job.stats, job.stats.endedAt || now()),
        progressHistory: normalizeProgressHistory(job.progressHistory).slice(-100),
        auditCount: Array.isArray(job.auditLog) ? job.auditLog.length : 0,
        circuitReason: job.circuitReason,
    });
}

async function runCleanup(job: CleanupJob, closeSheet?: () => void, onComplete?: (finishedJob: CleanupJob) => void, onProgress?: (job: CleanupJob) => void) {
    if (running) return;
    const runEpoch = lifecycleEpoch;
    const executionId = Number(job.executionId || 0) + 1;
    job.executionId = executionId;
    const { getCurrentUser } = findByProps("getCurrentUser");
    const messageActions = findByProps("deleteMessage");
    const user = getCurrentUser?.();
    if (!user?.id || user.id !== job.ownerId || !messageActions?.deleteMessage) {
        job.active = false;
        job.stats.completion = "unsupported";
        job.stats.endedAt = now();
        job.stats.lastError = "Required in-app message actions were not found, or the account changed.";
        currentJob = job;
        saveJob(job);
        onComplete?.(job);
        RN.Alert.alert(rt("unsupported"), rt("unsupportedBody"));
        return;
    }

    ensureSafetyFields(job);
    recoverPendingDelete(job);
    running = true;
    runningEpoch = runEpoch;
    cancelled = false;
    pauseRequested = false;
    stopRequested = false;
    resumeTiming(job);
    job.active = true;
    job.stats.completion = "running";
    currentJob = job;
    closeSheet?.();
    saveJob(job);

    try {
        const ownerCursorJumped = initializeOwnerCursor(job);
        const shouldSearchInitially = !isDirectMessageJob(job) || !ownerCursorJumped;
        if (shouldSearchInitially) {
            job.authorSearchEscalated = true;
            audit(job, "author-search-initial", ownerCursorJumped ? "Searching for older messages after the current owner cursor" : "Searching Discord for the newest message belonging to the current user");
            const authorSearch = await withTimeout(requestAuthorSearchHistory(job), 15_000);
            if (authorSearch.requested && authorSearch.complete && authorSearch.messages.length) {
                job.historyBatch = authorSearch.messages;
                job.historyHasMore = false;
                job.historyStarted = true;
                job.historyCursor = authorSearch.messages[0]?.id || job.historyCursor;
                audit(job, "owner-search-jump", `Found ${authorSearch.messages.length} messages and jumped to the owner history window`, job.historyCursor);
                saveJob(job);
                onProgress?.(job);
            } else {
                audit(job, "author-search-initial-fallback", "Indexed search did not return a usable owner cursor; continuing with guarded history pagination");
                saveJob(job);
                onProgress?.(job);
            }
        } else {
            audit(job, "owner-cursor-ready", "Using the latest locally loaded owner message as the starting cursor");
            saveJob(job);
            onProgress?.(job);
        }
    } catch (error) {
        job.stats.lastError = `Author search fallback: ${safeError(error)}`;
        saveJob(job);
    }

    const checkpointSeeded = seedDMCheckpoint(job);
    if (checkpointSeeded) {
        saveJob(job);
        onProgress?.(job);
    } else if (initializeHistoricalCursor(job)) {
        saveJob(job);
        onProgress?.(job);
    }

    let emptyPages = Number(job.historyNoProgress || 0);
    const deferredVerificationIds = new Set<string>();
    let fatalError = false;
    try {
        while (executionCanContinue(job, executionId) && runEpoch === lifecycleEpoch && job.stats.deleted < job.options.maxPerRun) {
            const loadedBefore = loadedChannelMessages(job.channelId);
            const hadHistoryBatch = Array.isArray(job.historyBatch) && job.historyBatch.length > 0;
            const candidates = consumeJobMessages(job).filter((message) => !deferredVerificationIds.has(String(message?.id || "")));
            if (candidates.length) {
                emptyPages = 0;
                job.historyNoProgress = 0;
                const oldestLoaded = loadedBefore[0]?.id;
                if (oldestLoaded && !hadHistoryBatch && !job.historyCursor) job.historyCursor = String(oldestLoaded);
                let processedCandidates = 0;
                for (const message of candidates) {
                    if (!executionCanContinue(job, executionId) || job.stats.deleted >= job.options.maxPerRun) break;
                    job.stats.scanned += 1;
                    if (messageAuthorId(message) === String(job.ownerId)) job.historyOwnerFound = true;
                    const verification = verifyMessageSafe(job, message);
                    if (verification.ok) {
                        job.stats.matched += 1;
                        await deleteCandidate(job, message, messageActions, executionId);
                    } else {
                        job.stats.skipped += 1;
                        audit(job, "message-skipped", verification.reason, String(message?.id || ""), verification.detail);
                        if (verification.reason === "author-unavailable") deferredVerificationIds.add(String(message?.id || ""));
                        else retainSeen(job, String(message?.id || ""));
                    }
                    processedCandidates += 1;
                    recordProgressPoint(job);
                    saveJob(job);
                    onProgress?.(job);
                }
                if (isDirectMessageJob(job)) saveDMCheckpoint(job, processedCandidates < candidates.length ? candidates.slice(processedCandidates) : undefined);
                if (job.recentOnly && job.recentFrontierReached) {
                    job.historyHasMore = false;
                    audit(job, "history-recent-only-stop", "Reached the previous safe DM frontier after processing newer messages", job.recentFrontierId);
                    saveDMCheckpoint(job);
                    recordProgressPoint(job);
                    saveJob(job);
                    onProgress?.(job);
                    break;
                }
                recordProgressPoint(job);
                saveJob(job);
                onProgress?.(job);
                continue;
            }

            if (isDirectMessageJob(job)) saveDMCheckpoint(job);
            if (job.recentOnly && job.recentFrontierReached) {
                job.historyHasMore = false;
                audit(job, "history-recent-only-stop", "Reached the previous safe DM frontier before loading another page", job.recentFrontierId);
                saveDMCheckpoint(job);
                saveJob(job);
                onProgress?.(job);
                break;
            }
            if (!job.options.deepHistory || job.historyHasMore === false) break;
            const beforeMessages = loadedChannelMessages(job.channelId);
            if (historyReachedLowerBound(job, beforeMessages)) {
                job.historyHasMore = false;
                audit(job, "history-early-stop", "Stopped history pagination after crossing the selected lower date boundary");
                if (isDirectMessageJob(job)) saveDMCheckpoint(job);
                saveJob(job);
                onProgress?.(job);
                break;
            }
            const beforeSignature = messageSignature(beforeMessages);
            const oldest = beforeMessages[0];
            const nextCursor = job.historyCursor || oldest?.id || job.cursor;
            if (!nextCursor && job.historyStarted) {
                job.stats.lastError ||= "No forward history cursor is available for the selected channel.";
                break;
            }
            const page = await requestOlderMessages(job.channelId, nextCursor ? String(nextCursor) : undefined, job);
            if (!page.requested) {
                job.stats.lastError ||= "Automatic history loading is unavailable in this build. The job can be resumed after the target channel loads older messages.";
                saveJob(job);
                break;
            }
            job.stats.historyPages += 1;
            await sleep(HISTORY_SETTLE_MS);
            const afterMessages = loadedChannelMessages(job.channelId);
            const beforeIds = new Set(beforeMessages.map((message) => String(message?.id || "")).filter(Boolean));
            const newlyLoadedMessages = afterMessages.filter((message) => !beforeIds.has(String(message?.id || "")));
            const pageMessages = uniqueChannelMessages((page.messages || []).concat(afterMessages), job.channelId);
            const currentPageMessages = uniqueChannelMessages((page.messages || []).concat(newlyLoadedMessages), job.channelId);
            const ownerMessagesInPage = currentPageMessages.filter((message) => messageAuthorId(message) === String(job.ownerId));
            if (!isDirectMessageJob(job) && ownerMessagesInPage.length === 0) {
                job.historyOwnerMissPages = Math.max(0, Number(job.historyOwnerMissPages || 0)) + 1;
            } else if (ownerMessagesInPage.length > 0) {
                job.historyOwnerFound = true;
                job.historyOwnerMissPages = 0;
            }
            const afterSignature = messageSignature(afterMessages);
            const added = Math.max(page.messages.length ? countNewMessages(beforeMessages, page.messages) : 0, countNewMessages(beforeMessages, afterMessages));
            const progressed = added > 0 || afterSignature !== beforeSignature || page.messages.length > 0;
            job.historyNoProgress = progressed ? 0 : emptyPages + 1;
            emptyPages = job.historyNoProgress;
            job.historyBatch = pageMessages;
            job.historyCursor = pageMessages[0]?.id || afterMessages[0]?.id || String(nextCursor);
            if (job.recentOnly && job.recentFrontierId && pageMessages.some((message) => {
                const id = String(message?.id || "");
                return Boolean(id) && compareMessageIds(id, String(job.recentFrontierId)) <= 0;
            })) job.recentFrontierReached = true;
            if (typeof page.hasMore === "boolean") {
                job.historyHasMore = page.hasMore;
                if (page.hasMore === false) job.historyNoProgress = 0;
            }
            if (historyReachedLowerBound(job, pageMessages)) {
                job.historyHasMore = false;
                audit(job, "history-early-stop", "Stopped history pagination after crossing the selected lower date boundary");
            }
            job.historyLastPageSignature = afterSignature;
            if (!isDirectMessageJob(job) && !job.authorSearchUnsupported && !job.historyOwnerFound && Number(job.historyOwnerMissPages || 0) >= 3) {
                job.authorSearchEscalated = true;
                audit(job, "author-search-escalation", "Three consecutive history pages had no messages from the current user; switching to indexed author search");
                const targeted = await requestAuthorSearchHistory(job);
                if (targeted.requested && targeted.complete) {
                    job.historyBatch = targeted.messages;
                    job.historyHasMore = false;
                    job.historyStarted = true;
                    job.historyCursor = targeted.messages[0]?.id || job.historyCursor;
                    job.historyOwnerMissPages = 0;
                    audit(job, "author-search-complete", `Indexed author search returned ${targeted.messages.length} messages for this channel`);
                    saveJob(job);
                    onProgress?.(job);
                    continue;
                }
                job.authorSearchEscalationFailed = true;
                job.historyOwnerMissPages = 0;
                if (job.authorSearchUnsupported) {
                    job.stats.lastError = "Indexed search is not supported for this channel type; continuing guarded history pagination.";
                    audit(job, "history-pagination-fallback", job.stats.lastError);
                } else {
                    job.stats.lastError = "Indexed author search was unavailable after retries; continuing guarded history pagination.";
                    audit(job, "author-search-fallback-continue", job.stats.lastError);
                }
                saveJob(job);
                onProgress?.(job);
            }
            if (isDirectMessageJob(job)) saveDMCheckpoint(job, pageMessages);
            recordProgressPoint(job);
            saveJob(job);
            onProgress?.(job);
            if (job.recentOnly && job.recentFrontierReached) {
                job.historyHasMore = false;
                audit(job, "history-recent-only-stop", "Reached the previous safe DM frontier while loading history", job.recentFrontierId);
                saveDMCheckpoint(job);
                saveJob(job);
                onProgress?.(job);
                break;
            }
            if (job.historyHasMore === false && !job.historyBatch.length) break;
            if (emptyPages >= Math.max(MAX_EMPTY_PAGES, HISTORY_NO_PROGRESS_LIMIT)) break;
        }
    } catch (error) {
        fatalError = true;
        noteFailure(job, error, "cleanup loop");
        job.stats.lastError = safeError(error);
        audit(job, "cleanup-error", job.stats.lastError);
    } finally {
        const staleRun = runEpoch !== lifecycleEpoch;
        if (runningEpoch === runEpoch) running = false;
        if (staleRun) return;
        job.active = false;
        if (job.stats.completion !== "stopped") job.stats.completion = fatalError || stopRequested ? "stopped" : pauseRequested || cancelled ? "paused" : "finished";
        if (job.stats.completion === "paused") job.stats.endedAt = undefined;
        else finishTiming(job);
        currentJob = job;
        saveJob(job);
        if (job.stats.completion !== "paused") {
            if (isDirectMessageJob(job) && !job.historyBatch?.length && job.historyCursor) saveDMCheckpoint(job);
            saveFinishedHistory(job);
        }
        if (clearRequested) {
            finalizeCompletedJob();
            clearRequested = false;
        } else {
            saveJob(job);
        }
        onComplete?.(job);
    }
}

function confirmStart(channelId: string, closeSheet: () => void, onComplete?: (finishedJob: CleanupJob) => void) {
    const { getCurrentUser } = findByProps("getCurrentUser");
    const user = getCurrentUser?.();
    if (!user?.id) {
        RN.Alert.alert(rt("accountUnavailable"), rt("accountUnavailableBody"));
        return;
    }
    const existing = loadJob();
    const canResume = existing?.channelId === channelId && existing?.ownerId === user.id && existing?.stats?.completion === "paused";
    const job = canResume ? existing! : defaultJob(channelId, user.id);
    const start = () => {
        if (job.options.previewRequired) void startPreviewSession(channelId, String(user.id));
        RN.Alert.alert(rt("finalTitle"), [
            rt("finalBody"),
            `${rt("previewFilter")}: ${filterText(job.options.filter)}`,
            `${rt("previewLimit")}: ${job.options.maxPerRun}`,
            rt("keepOpen"),
        ].join("\n\n"), [
            { text: rt("cancel"), style: "cancel" },
            { text: canResume ? rt("resume") : rt("start"), style: "destructive", onPress: () => void runCleanup(job, closeSheet, onComplete) },
        ]);
    };
    RN.Alert.alert(canResume ? rt("resumeTitle") : rt("startTitle"), rt("confirmBody"), [
        { text: rt("cancel"), style: "cancel" },

        { text: canResume ? rt("resume") : rt("continue"), style: "destructive", onPress: start },
    ]);
}

function updateSettings(mutator: (settings: CleanupSettings) => CleanupSettings) {
    const next = mutator(loadSettings());
    saveSettings(next);
    RN.Alert.alert(rt("saved"), [
        `${rt("settingLimit")}: ${next.maxPerRun}`,
        `${rt("settingDelay")}: ${Math.round(next.deleteDelayMs / 1000)} s`,
        `${rt("settingFilter")}: ${filterText(next.filter)}`,
    ].join("\n"));
}

function promptText(title: string, message: string, current: string, done: (value: string) => void) {
    const prompt = RN.Alert?.prompt;
    if (typeof prompt !== "function") {
        RN.Alert.alert(rt("textInputUnavailable"), rt("textInputBody"));
        return;
    }
    prompt(title, message, [{ text: rt("cancel"), style: "cancel" }, { text: rt("saved"), onPress: (value: string) => done(String(value || "").trim()) }], "plain-text", current);
}

function promptNumber(title: string, message: string, current: number, minimum: number, maximum: number, done: (value: number) => void) {
    const prompt = RN.Alert?.prompt;
    if (typeof prompt !== "function") {
        RN.Alert.alert(rt("textInputUnavailable"), rt("textInputBody"));
        return;
    }
    prompt(title, message, [{ text: rt("cancel"), style: "cancel" }, { text: rt("continue"), onPress: (value: string) => {
        const parsed = Number(String(value || "").trim());
        if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
            RN.Alert.alert(rt("invalidNumber"), message);
            return;
        }
        done(Math.round(parsed));
    } }], "numeric", String(current));
}

function currentChannelId(): string | undefined {
    const stores = [
        findByProps("getCurrentlySelectedChannelId"),
        findByProps("getCurrentChannelId"),
        findByProps("getLastSelectedChannelId"),
        findByProps("getChannelId"),
    ];
    const methods = ["getCurrentlySelectedChannelId", "getCurrentChannelId", "getLastSelectedChannelId", "getChannelId"];
    for (const store of stores) {
        for (const method of methods) {
            try {
                const value = store?.[method]?.();
                if (value !== undefined && value !== null && String(value).length > 4) return String(value);
            } catch {
                continue;
            }
        }
    }
    return undefined;
}

function userLabel(user: any): string {
    if (!user) return "";
    return String(user.global_name || user.globalName || user.displayName || user.username || user.nick || "").trim();
}

function storeWithMethods(methods: string[]): any {
    for (const method of methods) {
        try {
            const store = findByProps(method);
            if (store?.[method]) return store;
        } catch {
            continue;
        }
    }
    return undefined;
}

function readUserFromStores(id: string): any {
    const stores = [
        storeWithMethods(["getUser"]),
        storeWithMethods(["getUserById"]),
        storeWithMethods(["getUsers"]),
    ];
    for (const store of stores) {
        try {
            const user = store?.getUser?.(id) || store?.getUserById?.(id) || store?.getUsers?.()?.[id];
            if (user) return user;
        } catch {
            continue;
        }
    }
    return undefined;
}

function channelLabel(channelId?: string): string {
    if (!channelId) return "";
    try {
        const stores = [
            storeWithMethods(["getChannel"]),
            storeWithMethods(["getChannelById"]),
            storeWithMethods(["getCachedChannel"]),
        ];
        let channel: any;
        for (const store of stores) {
            try {
                channel = store?.getChannel?.(channelId) || store?.getChannelById?.(channelId) || store?.getCachedChannel?.(channelId);
                if (channel) break;
            } catch {
                continue;
            }
        }
        if (!channel) {
            const selectedStore = storeWithMethods(["getCurrentlySelectedChannelId", "getChannel"]);
            channel = selectedStore?.getChannel?.(channelId);
        }
        const channelName = String(channel?.name || channel?.subject || channel?.title || channel?.displayName || "").trim();
        const serverId = channel?.guild_id || channel?.guildId || channel?.serverId || channel?.guild?.id || channel?.server?.id;
        let serverName = String(channel?.guild?.name || channel?.server?.name || channel?.guildName || channel?.serverName || "").trim();
        if (!serverName && serverId) {
            const guildStores = [storeWithMethods(["getGuild"]), storeWithMethods(["getGuildById"]), storeWithMethods(["getServer"]), storeWithMethods(["getServerById"])];
            for (const guildStore of guildStores) {
                try {
                    const guild = guildStore?.getGuild?.(String(serverId)) || guildStore?.getGuildById?.(String(serverId)) || guildStore?.getServer?.(String(serverId)) || guildStore?.getServerById?.(String(serverId));
                    serverName = String(guild?.name || guild?.displayName || "").trim();
                    if (serverName) break;
                } catch {
                    continue;
                }
            }
        }
        if (channelName) return serverName ? `${serverName} - ${channelName}` : channelName;
        const recipientObjects = [
            ...(Array.isArray(channel?.recipients) ? channel.recipients : []),
            ...(Array.isArray(channel?.rawRecipients) ? channel.rawRecipients : []),
            ...(Array.isArray(channel?.participants) ? channel.participants : []),
            ...(Array.isArray(channel?.recipientUsers) ? channel.recipientUsers : []),
        ];
        const recipientNames = recipientObjects.map(userLabel).filter(Boolean);
        if (recipientNames.length) return Array.from(new Set(recipientNames)).join(", ");
        const recipientIds = [
            ...(Array.isArray(channel?.recipient_ids) ? channel.recipient_ids : []),
            ...(Array.isArray(channel?.recipientIds) ? channel.recipientIds : []),
            ...(Array.isArray(channel?.userIds) ? channel.userIds : []),
            ...(Array.isArray(channel?.participantIds) ? channel.participantIds : []),
        ].map(String);
        const directRecipientId = channel?.recipient_id || channel?.recipientId || channel?.userId || channel?.ownerId;
        const ids = Array.from(new Set(recipientIds.length ? recipientIds : directRecipientId ? [String(directRecipientId)] : []));
        const names = ids.map((id: string) => userLabel(readUserFromStores(id))).filter(Boolean);
        if (names.length) return Array.from(new Set(names)).join(", ");
        const directUser = userLabel(channel?.user || channel?.recipient || channel?.owner || channel?.recipientUser || channel?.recipientProfile);
        if (directUser) return directUser;
        const dmStore = storeWithMethods(["getDMFromUserId", "getChannelForUser"]);
        for (const id of ids) {
            try {
                const dm = dmStore?.getDMFromUserId?.(id) || dmStore?.getChannelForUser?.(id);
                const dmName = String(dm?.name || dm?.subject || dm?.displayName || "").trim();
                if (dmName) return dmName;
                const dmUser = userLabel(dm?.recipient || dm?.user || readUserFromStores(id));
                if (dmUser) return dmUser;
            } catch {
                continue;
            }
        }
    } catch {
        return "";
    }
    return "";
}

function channelAvatarUrl(channelId?: string): string | undefined {
    if (!channelId) return undefined;
    try {
        const channel = (() => {
            const stores = [storeWithMethods(["getChannel"]), storeWithMethods(["getChannelById"]), storeWithMethods(["getCachedChannel"])];
            for (const store of stores) {
                try {
                    const value = store?.getChannel?.(channelId) || store?.getChannelById?.(channelId) || store?.getCachedChannel?.(channelId);
                    if (value) return value;
                } catch {
                    continue;
                }
            }
            return undefined;
        })();
        if (!channel) return undefined;
        const directChannelImage = String(channel?.iconURL || channel?.iconUrl || channel?.icon_url || channel?.imageUrl || "").trim();
        if (/^https?:\/\//i.test(directChannelImage)) return directChannelImage;
        const serverId = channel?.guild_id || channel?.guildId || channel?.serverId || channel?.guild?.id || channel?.server?.id;
        if (serverId) {
            const guildStores = [storeWithMethods(["getGuild"]), storeWithMethods(["getGuildById"]), storeWithMethods(["getServer"]), storeWithMethods(["getServerById"])];
            let guild: any;
            for (const store of guildStores) {
                try {
                    guild = store?.getGuild?.(String(serverId)) || store?.getGuildById?.(String(serverId)) || store?.getServer?.(String(serverId)) || store?.getServerById?.(String(serverId));
                    if (guild) break;
                } catch {
                    continue;
                }
            }
            const directGuildImage = String(guild?.iconURL || guild?.iconUrl || guild?.icon_url || guild?.imageUrl || "").trim();
            if (/^https?:\/\//i.test(directGuildImage)) return directGuildImage;
            const iconHash = String(guild?.icon || guild?.icon_hash || guild?.iconHash || "").trim();
            if (iconHash) return `https://cdn.discordapp.com/icons/${String(serverId)}/${iconHash}.${iconHash.indexOf("a_") === 0 ? "gif" : "png"}?size=64`;
        }
        const recipientObjects = []
            .concat(Array.isArray(channel?.recipients) ? channel.recipients : [])
            .concat(Array.isArray(channel?.rawRecipients) ? channel.rawRecipients : [])
            .concat(Array.isArray(channel?.participants) ? channel.participants : [])
            .concat(Array.isArray(channel?.recipientUsers) ? channel.recipientUsers : []);
        const recipientIds = []
            .concat(Array.isArray(channel?.recipient_ids) ? channel.recipient_ids : [])
            .concat(Array.isArray(channel?.recipientIds) ? channel.recipientIds : [])
            .concat(Array.isArray(channel?.userIds) ? channel.userIds : [])
            .concat(Array.isArray(channel?.participantIds) ? channel.participantIds : []);
        const recipient = recipientObjects.length ? recipientObjects[0] : undefined;
        const recipientId = (typeof recipient === "string" || typeof recipient === "number" ? recipient : recipient?.id) || recipientIds[0] || channel?.recipient_id || channel?.recipientId || channel?.userId || channel?.ownerId;
        const user = (recipient && typeof recipient === "object" ? recipient : undefined) || (recipientId ? readUserFromStores(String(recipientId)) : undefined);
        const userId = String(user?.id || recipientId || "").trim();
        const directUserImage = String(user?.avatarURL || user?.avatarUrl || user?.avatar_url || user?.imageUrl || "").trim();
        if (/^https?:\/\//i.test(directUserImage)) return directUserImage;
        const avatarHash = String(user?.avatar || user?.avatar_hash || user?.avatarHash || "").trim();
        if (userId && avatarHash) return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${avatarHash.indexOf("a_") === 0 ? "gif" : "png"}?size=64`;
    } catch {
        return undefined;
    }
    return undefined;
}

function settingsComponent() {
    const [settings, setSettings] = React.useState(loadSettings());
    const [targetEditorOpen, setTargetEditorOpen] = React.useState(false);
    const [targetDraft, setTargetDraft] = React.useState(settings.targetChannelId || "");
    const [targetLinkDraft, setTargetLinkDraft] = React.useState("");
    const [targetMode, setTargetMode] = React.useState<"saved" | "current" | "id" | "link">("current");
    const [reportModal, setReportModal] = React.useState<"current" | "history" | null>(null);
    const [activePage, setActivePage] = React.useState<"home" | "rules" | "run" | "reports">("home");
    const [keywordEditor, setKeywordEditor] = React.useState<"includeKeywords" | "excludeKeywords" | null>(null);
    const [keywordDraft, setKeywordDraft] = React.useState("");
    const [rulesEditorOpen, setRulesEditorOpen] = React.useState(false);
    const [drawerOpen, setDrawerOpen] = React.useState(false);
    const [numberEditor, setNumberEditor] = React.useState<"limit" | "delay" | null>(null);
    const [numberDraft, setNumberDraft] = React.useState("");
    const steppedLimitValues = [1, ...Array.from({ length: 100 }, (_value, index) => (index + 1) * 100)];
    const [dateEditor, setDateEditor] = React.useState<"before" | "after" | null>(null);
    const [dateModeOpen, setDateModeOpen] = React.useState(false);
    const [dateDraft, setDateDraft] = React.useState("");
    const [dialog, setDialog] = React.useState<null | { title: string; body: string; confirmLabel?: string; cancelLabel?: string; color?: string; onConfirm?: () => void }>(null);
    const [previewPlan, setPreviewPlan] = React.useState<PreviewPlan | null>(loadPreviewPlan());
    const [previewOpen, setPreviewOpen] = React.useState(false);
    const [, setRefresh] = React.useState(0);
    React.useEffect(() => {
        const timer = setInterval(() => { const job = currentJob || loadJob(); if (running || job?.stats?.completion === "running") setRefresh((value: number) => value + 1); }, 1_000);
        return () => clearInterval(timer);
    }, []);

    const language = settings.language === "ar" ? "ar" : "en";
    const windowSize = typeof RN.useWindowDimensions === "function" ? RN.useWindowDimensions() : { width: 360, height: 720 };
    const viewportWidth = Math.max(320, Number(windowSize?.width) || 360);
    const isTablet = viewportWidth >= 600;
    const isWideTablet = viewportWidth >= 900;
    const horizontalInset = isTablet ? Math.max(24, Math.min(40, Math.round(viewportWidth * 0.045))) : 16;
    const contentMaxWidth = isTablet ? 1120 : 720;
    const contentWidth = Math.max(288, Math.min(contentMaxWidth, viewportWidth - horizontalInset * 2));
    const contentGutter = horizontalInset;
    const drawerWidth = Math.min(Math.round(viewportWidth * (isTablet ? 0.42 : 0.86)), isTablet ? 430 : 360);
    const colors = { background: "#252429", panel: "#2e2d32", raised: "#38373f", sidebar: "#2e2d32", text: "#ffffff", muted: "#949397", faint: "#72717a", divider: "#1f1e24", accent: "#5865f2", accentPressed: "#4752c4", green: "#5865f2", amber: "#949397", red: "#ed4245", glow: "#00000000" };
    const View = RN.View || (() => null);
    const Text = RN.Text || (() => null);
    const Image = RN.Image;
    const Scroll = RN.ScrollView || View;
    const SafeArea = RN.SafeAreaView || View;
    const pressableType = RN.Pressable || RN.TouchableOpacity || RN.TouchableHighlight || View;
    const modalType = RN.Modal || View;
    const inputType = RN.TextInput || View;
    const sliderType = RN.Slider || findByProps("Slider")?.Slider || View;

    const copy = language === "ar" ? {
        title: "تطهير الرسائل",
        subtitle: "حذف رسائلك فقط من DM أو قناة محددة",
        home: "الرئيسية",
        pageRules: "القواعد",
        pageRun: "التشغيل",
        pageReports: "التقارير",
        target: "الهدف",
        noTarget: "لا يوجد",
        setTarget: "تحديد الهدف",
        targetReady: "الهدف محفوظ وجاهز",
        targetId: "معرّف القناة",
        ready: "جاهز",
        setup: "إعداد",
        close: "إغلاق",
        back: "رجوع",
        editRules: "تعديل قواعد الحذف",
        saveContinue: "حفظ ومتابعة",
        resetRules: "إعادة ضبط القواعد",
        addKeyword: "إضافة كلمة",
        targetMissing: "حدد DM قبل التشغيل",
        run: "التشغيل",
        dryRun: "معاينة آمنة",
        previewStart: "بدء المعاينة",
        previewResume: "متابعة المعاينة",
        previewReady: "المعاينة جاهزة",
        previewRunning: "المعاينة قيد التشغيل",
        previewKeep: "إيقاف والاحتفاظ بالنتائج",
        previewPurge: "بدء التطهير",
        previewRefresh: "استمرار الفحص",
        previewExpired: "انتهت صلاحية المعاينة؛ أعد تشغيلها.",
        previewPages: "الصفحات",
        previewCandidates: "المرشحون",
        previewCursor: "المؤشر",
        start: "بدء التطهير",
        resume: "استئناف المهمة",
        pause: "إيقاف مؤقت",
        stop: "إيقاف وحفظ",
        idle: "ماكو مهمة قيد التشغيل",
        running: "التطهير قيد التشغيل",
        paused: "المهمة متوقفة مؤقتاً",
        finished: "اكتمل التطهير",
        progress: "التقدم المباشر",
        scanned: "تم فحصها",
        matched: "مطابقة",
        deleted: "محذوفة",
        failed: "فاشلة",
        pages: "صفحات التاريخ",
        rules: "قواعد الحذف",
        rulesSummary: "المحتوى والحماية والكلمات والتاريخ",
        scope: "نطاق المحتوى",
        allContent: "كل المحتوى",
        messages: "الرسائل",
        minimumLimit: "الحد الأدنى 1",
        maximumLimit: "الحد الأقصى 10000",
        minimumDelay: "الحد الأدنى 3 ثوانٍ",
        maximumDelay: "الحد الأقصى 60 ثانية",
        images: "الصور",
        links: "الروابط",
        files: "الملفات",
        includeKeywords: "كلمات التضمين",
        excludeKeywords: "كلمات الاستثناء",
        protectFiles: "حماية الملفات",
        protectLinks: "حماية الروابط",
        dateMode: "وضع التاريخ",
        dateModeHint: "اختر نطاق البحث، ثم حدّد التاريخ من الحقول التي تظهر أسفل الخيار.",
        none: "بدون حد",
        before: "قبل تاريخ",
        after: "بعد تاريخ",
        range: "نطاق تاريخ",
        rulesSaved: "تم حفظ قواعد الحذف",
        datePrompt: "أدخل التاريخ بصيغة YYYY-MM-DD أو اتركه فارغاً لإلغاء الحد.",
        rulesNote: "القواعد تُطبّق مع حماية رسائلك فقط.",
        date: "حد التاريخ",
        mode: "نوع الرسائل",
        include: "كلمة التضمين",
        exclude: "كلمة الاستثناء",
        pinned: "الرسائل المثبتة",
        noFilter: "بدون فلتر",
        notSet: "غير محددة",
        included: "مشمولة",
        protected: "محمية",
        safety: "الأمان والتحكم",
        limit: "حد الجلسة",
        limitPrompt: "أدخل رقماً بين 1 و10000.",
        delay: "تأخير الحذف",
        delayPrompt: "أدخل التأخير بالثواني بين 3 و60.",
        invalidNumber: "قيمة رقمية غير صحيحة",
        skipped: "متروكة",
        finalBody: "هذه العملية تحذف رسائلك أنت فقط.",
        keepOpen: "خلي Discord مفتوح. إذا أندرويد أوقف التطبيق، افتح نفس الـDM واختار استئناف.",

        reports: "التقارير والسجل",
        clearHistory: "مسح كل بيانات البلوقن",
        clearHistoryHint: "ينمسح كلشي: الإعدادات، الجلسات، الإحصائيات، المعاينات وبيانات الاستئناف. الرسائل ما تتأثر.",
        currentReport: "التقرير الحالي",
        history: "سجل الجلسات",
        language: "اللغة",
        setChannelTitle: "تحديد الهدف",
        setChannelMessage: "اختر طريقة تحديد الهدف. لا يتم حفظ أي رمز أو بيانات تسجيل دخول.",
        currentTab: "الحالية",
        idTab: "المعرّف",
        linkTab: "الرابط",
        currentTarget: "القناة المفتوحة حالياً",
        currentTargetBody: "استخدم الخاص أو القناة المفتوحة حالياً في Discord؛ المعاينة اختيارية.",
        detectCurrent: "التقاط القناة الحالية",
        idTarget: "معرّف القناة",
        idTargetBody: "أدخل معرّف قناة Discord مكوّناً من أرقام.",
        linkTarget: "رابط Discord",
        linkTargetBody: "الصق رابط الرسالة أو القناة وسيتم استخراج Channel ID منه.",
        parseLink: "تحليل الرابط",
        linkInvalid: "الرابط لا يحتوي Channel ID صالحاً.",
        currentPreview: "لم يتم اكتشاف قناة حالياً",
        save: "حفظ",
        cancel: "إلغاء",
        continue: "متابعة",
        currentUnavailable: "ما كدرت أتعرف على القناة الحالية. افتح الـDM المطلوب وحاول مرة ثانية، أو استخدم تحديد الهدف.",
        invalidTarget: "أدخل Channel ID صحيح.",
        targetSaved: "تم حفظ الهدف",
        noTargetAlert: "حدد DM أو قناة أولاً من بطاقة الهدف.",
        safetyNote: "GiraPurge يحذف رسائلك فقط باستخدام إجراءات Discord الداخلية، بدون token أو طلبات خارجية.",
        english: "English",
        arabic: "العربية",
        on: "مفعّل",
        off: "متوقف",
        saved: "محفوظ",
        empty: "ماكو تقرير بعد",
        historyCount: "جلسات محفوظة",
        auditLog: "سجل التدقيق", auditCount: "قرارات مسجلة", copyAudit: "نسخ سجل التدقيق", noAudit: "لا توجد قرارات تدقيق بعد", reportModalTitle: "تفاصيل التقرير", historyModalTitle: "تفاصيل سجل الجلسات", copyReport: "نسخ التقرير", noReport: "ماكو تقرير متاح", noSessions: "ماكو جلسات محفوظة بعد.", channelDm: "القناة / الخاص", status: "الحالة", elapsed: "المدة", ended: "انتهت", sessionDetails: "تفاصيل الجلسة", keywordEditorTitle: "تحرير الكلمات", includeKeywordsEnabled: "تفعيل مطابقة الكلمات", partialMatch: "مطابقة جزئية", exactMatch: "مطابقة دقيقة", savedTab: "محفوظ", savedTarget: "الهدف المحفوظ", targetName: "الاسم", targetId: "المعرّف", targetSource: "المصدر", editTarget: "تغيير الهدف", manual: "يدوي", steppedValues: "الدرجات المتاحة", keywordEditorHint: "اكتب كل كلمة بسطر، أو افصلها بفواصل. اضغط حفظ حتى تتطبق.", keywordPlaceholder: "كلمة جديدة أو قائمة كلمات", saveKeywords: "حفظ الكلمات", addKeyword: "إضافة وتطبيق", removeKeyword: "حذف", keywordLimit: "الحد الأعلى 32 كلمة.",
    } : {
        title: "Message Purge",
        subtitle: "Delete only your messages from one DM or channel",
        home: "Home",
        pageRules: "Rules",
        pageRun: "Run",
        pageReports: "Reports",
        target: "Target",
        noTarget: "None",
        setTarget: "Set target",
        targetReady: "Target saved and ready",
        targetId: "Channel ID",
        ready: "Ready",
        setup: "Setup",
        close: "Close",
        back: "Back",
        editRules: "Edit deletion rules",
        saveContinue: "Save and continue",
        resetRules: "Reset rules",
        addKeyword: "Add keyword",
        includeKeywordsEnabled: "Keyword matching", partialMatch: "Partial matching", exactMatch: "Exact matching", savedTab: "Saved", savedTarget: "Saved target", targetName: "Name", targetId: "ID", targetSource: "Source", editTarget: "Change target", manual: "Manual", steppedValues: "Available steps",
        targetMissing: "Select a DM before running",
        run: "Run control",
        dryRun: "Safe preview",
        previewStart: "Start preview",
        previewResume: "Continue preview",
        previewReady: "Preview ready",
        previewRunning: "Preview is running",
        previewKeep: "Stop and keep results",
        previewPurge: "Start Purge",
        previewRefresh: "Continue scan",
        previewExpired: "Preview expired; run it again.",
        previewPages: "Pages",
        previewCandidates: "Candidates",
        previewCursor: "Cursor",
        start: "Start purge",
        resume: "Resume job",
        pause: "Pause",
        stop: "Stop and save",
        idle: "No purge is running",
        running: "Purge is running",
        paused: "Job is paused",
        finished: "Purge finished",
        progress: "Live progress",
        scanned: "Scanned",
        matched: "Matched",
        deleted: "Deleted",
        failed: "Failed",
        pages: "History pages",
        rules: "Deletion rules",
        rulesSummary: "Content, protection, keywords and dates",
        scope: "Content scope",
        allContent: "All content",
        messages: "Messages",
        minimumLimit: "Minimum 1",
        maximumLimit: "Maximum 10000",
        minimumDelay: "Minimum 3 seconds",
        maximumDelay: "Maximum 60 seconds",
        images: "Images",
        links: "Links",
        files: "Files",
        includeKeywords: "Include keywords",
        excludeKeywords: "Exclude keywords",
        protectFiles: "Protect files",
        protectLinks: "Protect links",
        dateMode: "Date mode",
        dateModeHint: "Choose a search boundary, then set the date in the fields shown below.",
        none: "No limit",
        before: "Before date",
        after: "After date",
        range: "Date range",
        rulesSaved: "Deletion rules saved",
        datePrompt: "Enter a date as YYYY-MM-DD, or leave empty to clear the boundary.",
        rulesNote: "Rules always run with your own-message protection.",
        date: "Date boundary",
        mode: "Message type",
        include: "Include keyword",
        exclude: "Exclude keyword",
        pinned: "Pinned messages",
        noFilter: "No filter",
        notSet: "Not set",
        included: "Included",
        protected: "Protected",
        safety: "Safety and limits",
        limit: "Session limit",
        limitPrompt: "Enter a number between 1 and 10000.",
        delay: "Delete delay",
        delayPrompt: "Enter a delay in seconds between 3 and 60.",
        invalidNumber: "Invalid numeric value",
        skipped: "Skipped",
        finalBody: "This deletes only your own messages.",
        keepOpen: "Keep Discord open. If Android stops the app, open the same DM and choose Resume.",

        reports: "Reports and history",
        clearHistory: "Clear all plugin data",
        clearHistoryHint: "This removes settings, jobs, checkpoints, previews, reports, and statistics. Messages are unaffected.",
        currentReport: "Current report",
        history: "Session history",
        language: "Language",
        setChannelTitle: "Set target",
        setChannelMessage: "Choose how to identify the target. No token or login data is stored.",
        currentTab: "Current",
        idTab: "Channel ID",
        linkTab: "Discord link",
        currentTarget: "Currently open channel",
        currentTargetBody: "Use the currently open Discord DM or channel. Preview is optional.",
        detectCurrent: "Use current channel",
        idTarget: "Channel ID",
        idTargetBody: "Enter a numeric Discord channel ID.",
        linkTarget: "Discord link",
        linkTargetBody: "Paste a message or channel link and extract its Channel ID.",
        parseLink: "Parse link",
        linkInvalid: "The link does not contain a valid Channel ID.",
        currentPreview: "No current channel detected",
        save: "Save",
        cancel: "Cancel",
        continue: "Continue",
        currentUnavailable: "The current channel could not be detected. Open the target DM and try again, or set the target manually.",
        invalidTarget: "Enter a valid Channel ID.",
        targetSaved: "Target saved",
        noTargetAlert: "Set a DM or channel in the Target card first.",
        safetyNote: "GiraPurge deletes only your own messages through Discord in-app actions. No token or external request is used.",
        english: "English",
        arabic: "العربية",
        on: "On",
        off: "Off",
        saved: "Saved",
        empty: "No report yet",
        historyCount: "saved sessions",
        auditLog: "Audit log", auditCount: "recorded decisions", copyAudit: "Copy audit log", noAudit: "No audit decisions yet", reportModalTitle: "Report details", historyModalTitle: "Session history details", copyReport: "Copy report", noReport: "No report available", noSessions: "No saved sessions yet.", channelDm: "Channel / DM", status: "Status", elapsed: "Elapsed", ended: "Ended", sessionDetails: "Session details", keywordEditorTitle: "Edit keywords", keywordEditorHint: "Enter one keyword per line, or separate them with commas. Save to apply.", keywordPlaceholder: "New keyword or keyword list", saveKeywords: "Save keywords", addKeyword: "Add and apply", removeKeyword: "Remove", keywordLimit: "Maximum 32 keywords.",
    };


    const t = (key: keyof typeof copy) => copy[key];
    const savedJob = currentJob || loadJob();
    const stats = savedJob?.stats;
    const targetId = settings.targetChannelId;
    const targetVerified = Boolean(settings.target?.verified);
    const liveTargetLabel = channelLabel(targetId);
    const storedTargetLabel = settings.targetLabel && !/^Channel \d+$/.test(settings.targetLabel) ? settings.targetLabel : "";
    const targetName = liveTargetLabel || storedTargetLabel || (targetId ? (language === "ar" ? "الهدف المحدد" : "Selected target") : t("noTarget"));
    const targetDisplayName = targetName.replace(/^GiraPurge\s*[-–—:]\s*/i, "").trim() || targetName;
    const targetDisplayText = language === "ar" ? `\u2067${t("target")}: \u2066${targetDisplayName}\u2069\u2069` : `${t("target")}: ${targetDisplayName}`;
    const isRunning = Boolean(running && currentJob?.active && currentJob?.stats?.completion === "running");
    const canResume = Boolean(savedJob?.stats?.completion === "paused" && savedJob?.channelId === targetId);
    const elapsed = stats ? formatDuration(activeElapsedMs(stats)) : "0s";
    const statusColor = stats?.completion === "stopped" ? colors.red : colors.accent;
    const previewOwnerId = String(findByProps("getCurrentUser")?.getCurrentUser?.()?.id || "");
    const storedPreviewPlan = previewPlan || loadPreviewPlan();
    const previewValid = Boolean(targetId && previewOwnerId && isPreviewPlanValid(storedPreviewPlan, targetId, previewOwnerId, settings));
    const previewExpired = Boolean(storedPreviewPlan && !previewValid);
    const previewBusy = previewRunning;
    const previewHasCandidates = Boolean(previewValid && storedPreviewPlan && storedPreviewPlan.candidates.length > 0);
    const previewCanContinue = Boolean(storedPreviewPlan && previewValid && !storedPreviewPlan.complete && storedPreviewPlan.pages < PREVIEW_MAX_PAGES);
    const previewActionLabel = t("dryRun");
    const previewActionSubtitle = previewBusy ? t("previewRunning") : previewCanContinue ? `${t("previewRefresh")} · ${t("previewPages")}: ${storedPreviewPlan?.pages || 0}/${PREVIEW_MAX_PAGES}` : previewHasCandidates ? `${t("previewReady")} · ${t("matched")}: ${storedPreviewPlan?.matched || 0}` : language === "ar" ? "استكشاف رسائلك فقط دون حذف" : "Explore your messages only; no deletion";
    const startActionSubtitle = canResume ? t("paused") : previewHasCandidates && !previewCanContinue ? (language === "ar" ? "تطهير نتائج المعاينة المحفوظة" : "Purge saved preview results") : language === "ar" ? "تطهير شامل · فحص تاريخ كامل" : "Full purge · historical scan";
    const showingPreviewProgress = Boolean(!isRunning && previewValid && (previewBusy || storedPreviewPlan?.pages));
    const progressStats = showingPreviewProgress ? { scanned: storedPreviewPlan?.scanned || 0, matched: storedPreviewPlan?.matched || 0, deleted: 0, skipped: storedPreviewPlan?.skipped || 0, failed: 0, startedAt: storedPreviewPlan?.createdAt || now(), endedAt: previewBusy ? undefined : now() } : stats;
    const sessionLimit = Math.max(1, Number(settings.maxPerRun) || 1);
    const deletedNow = Math.max(0, Number(progressStats?.deleted) || 0);
    const progress = Math.min(100, Math.round((deletedNow / sessionLimit) * 100));

    const setSettingsValue = (mutator: (value: CleanupSettings) => CleanupSettings) => {
        const next = mutator({ ...loadSettings(), ...settings, filter: { ...loadSettings().filter, ...settings.filter } });
        saveSettings(next);
        setSettings(next);
    };
    const openDialog = (title: string, body: string, onConfirm?: () => void, confirmLabel = t("continue"), color = colors.accent) => setDialog({ title, body, onConfirm, confirmLabel, cancelLabel: t("cancel"), color });
    const pressProps = (onPress: () => void, style: any = {}) => { const directionalStyle = { direction: "ltr", ...style }; return pressableType === View ? { style: directionalStyle, onStartShouldSetResponder: () => true, onResponderRelease: onPress, accessibilityRole: "button" } : { style: directionalStyle, onPress, onClick: onPress, activeOpacity: 0.72, accessible: true, accessibilityRole: "button" }; };
    const ensureTarget = () => {
        if (!settings.targetChannelId) { openDialog(t("target"), t("noTargetAlert"), undefined, t("close"), colors.red); return false; }
        return true;
    };
    const saveTarget = (value: string, label?: string, source: TargetSelection["source"] = "manual") => {
        const clean = parseChannelId(value);
        if (!clean) { openDialog(t("target"), t("invalidTarget"), undefined, t("close"), colors.red); return; }
        setTargetDraft(clean);
        setTargetLinkDraft("");
        const resolvedLabel = label || channelLabel(clean) || (language === "ar" ? "الهدف المحدد" : "Selected target");
        setSettingsValue((current) => ({ ...current, targetChannelId: clean, targetLabel: resolvedLabel, target: { kind: "channel", channelId: clean, label: resolvedLabel, source, verified: false } }));
        setTargetEditorOpen(false);
        setTargetMode("saved");
        openDialog(t("target"), t("targetSaved"), undefined, t("close"), colors.accent);
    };
    const openTargetEditor = () => { setTargetDraft(targetId || ""); setTargetLinkDraft(""); setTargetMode("current"); setTargetEditorOpen(true); };
    const saveTargetLink = () => { const id = parseChannelId(targetLinkDraft); if (!id) { openDialog(t("linkTab"), t("linkInvalid"), undefined, t("close"), colors.red); return; } saveTarget(id, channelLabel(id) || undefined, "link"); };
    const useCurrent = () => { const id = currentChannelId(); if (!id) { openDialog(t("target"), t("currentUnavailable"), undefined, t("close"), colors.red); return; } saveTarget(id, channelLabel(id) || undefined, "current"); };
    const previewTarget = () => {
        if (!ensureTarget()) return;
        const user = findByProps("getCurrentUser")?.getCurrentUser?.();
        if (!user?.id) { openDialog(t("target"), t("currentUnavailable"), undefined, t("close"), colors.red); return; }
        setPreviewOpen(true);
        setRefresh((value: number) => value + 1);
        const existingPlan = loadPreviewPlan();
        const validExistingPlan = isPreviewPlanValid(existingPlan, targetId!, String(user.id), loadSettings());
        if (validExistingPlan && existingPlan && (existingPlan.complete || existingPlan.pages >= PREVIEW_MAX_PAGES)) return;
        void startPreviewSession(targetId!, String(user.id), (plan) => { setPreviewPlan(plan); setRefresh((value: number) => value + 1); }, (plan) => { setPreviewPlan(plan); setRefresh((value: number) => value + 1); });
    };
    const stopPreview = () => { stopPreviewSession(); setRefresh((value: number) => value + 1); };
    const purgePreview = () => {
        const user = findByProps("getCurrentUser")?.getCurrentUser?.();
        const plan = loadPreviewPlan();
        if (!user?.id || !targetId || !isPreviewPlanValid(plan, targetId, String(user.id), loadSettings())) { setPreviewPlan(null); return; }
        setPreviewOpen(false);
        void runCleanupFromPreview(plan!, (nextPlan, job) => { setPreviewPlan(nextPlan); currentJob = job; setRefresh((value: number) => value + 1); }, (job) => { currentJob = job; setPreviewPlan(loadPreviewPlan()); setRefresh((value: number) => value + 1); if (job.stats.completion === "stopped" || job.stats.completion === "finished") setReportModal("current"); });
    };
    const previewAction = () => {
        if (previewBusy || isRunning) return;
        previewTarget();
    };
    const startTarget = () => {
        if (!ensureTarget()) return;
        const user = findByProps("getCurrentUser")?.getCurrentUser?.();
        if (!user?.id) { openDialog(t("target"), t("currentUnavailable"), undefined, t("close"), colors.red); return; }
        const previewForTarget = loadPreviewPlan();
        const previewReadyForPurge = Boolean(previewForTarget && isPreviewPlanValid(previewForTarget, targetId!, String(user.id), loadSettings()) && previewForTarget.complete && previewForTarget.candidates.length > 0);
        if (!canResume && previewReadyForPurge) {
            openDialog(t("start"), language === "ar" ? "سيتم تطهير المرشحين المحفوظين من المعاينة دون إعادة فحص التاريخ." : "Saved preview candidates will be purged without scanning history again.", () => { setDialog(null); purgePreview(); }, t("start"), colors.accent);
            return;
        }
        const existing = loadJob();
        const resume = Boolean(existing?.channelId === targetId && existing?.ownerId === user.id && existing?.stats?.completion === "paused");
        const job = resume ? existing! : defaultJob(targetId!, user.id);
        openDialog(resume ? t("resume") : t("start"), `${t("finalBody")}\n\n${t("keepOpen")}`, () => { setDialog(null); void runCleanup(job, () => undefined, (finishedJob) => { setRefresh((value: number) => value + 1); if (finishedJob.stats.completion === "stopped" || finishedJob.stats.completion === "finished") setReportModal("current"); }, () => setRefresh((value: number) => value + 1)); }, resume ? t("resume") : t("start"), colors.accent);
    };
    const pauseTarget = () => { if (!currentJob || !running || currentJob.stats.completion !== "running") return; stopRequested = false; pauseRequested = true; cancelled = false; markPaused(currentJob, "manual-pause", "User paused the job; deletion loop and timer will stop"); saveJob(currentJob); setRefresh((value: number) => value + 1); };
    const stopTarget = () => { if (!currentJob || !running || currentJob.stats.completion !== "running") return; stopRequested = true; pauseRequested = false; cancelled = true; currentJob.active = false; currentJob.stats.completion = "stopped"; finishTiming(currentJob); audit(currentJob, "manual-stop", "User stopped and saved the job"); saveJob(currentJob); setRefresh((value: number) => value + 1); };

    const press = (children: any[], onPress: () => void, style: any = {}) => React.createElement(pressableType, pressProps(onPress, style), ...children);
    const text = (value: any, style: any = {}) => React.createElement(Text, { style: [{ fontFamily: "Alexandria", writingDirection: language === "ar" ? "rtl" : "ltr", textAlign: language === "ar" ? "right" : "left" }, style] }, value);
    const blockText = (value: any, style: any = {}) => text(value, { width: "100%", flexGrow: 1, alignSelf: "stretch", textAlign: language === "ar" ? "right" : "left", ...style });
    const targetLabelValue = (label: string, value: string, color = colors.text, fontSize = 16, fontWeight: any = "700", extraStyle: any = {}) => React.createElement(View, { style: { width: "100%", flex: 1, flexDirection: "row", alignItems: "center", justifyContent: language === "ar" ? "flex-end" : "flex-start", direction: "ltr", ...extraStyle } }, ...(language === "ar" ? [text(value, { color, fontSize, fontWeight, direction: "ltr", writingDirection: "ltr", textAlign: "left", flexShrink: 1, marginRight: 0 }), text(`${label}: `, { color, fontSize, fontWeight, direction: "rtl", writingDirection: "rtl", textAlign: "right", flexShrink: 0, marginLeft: 0 })] : [text(`${label}:`, { color, fontSize, fontWeight, direction: "ltr", writingDirection: "ltr", textAlign: "left", flexShrink: 0, marginRight: 4 }), text(value, { color, fontSize, fontWeight, direction: "ltr", writingDirection: "ltr", textAlign: "left", flexShrink: 1 })]));
    const targetTitle = targetLabelValue(t("target"), targetDisplayName);
    const pill = (value: string, color: string) => React.createElement(View, { style: { backgroundColor: colors.raised, borderColor: colors.divider, borderWidth: 1, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 5 } }, text(value, { color, fontSize: 11, fontWeight: "700" }));
    const icon = (value: string, color = colors.accent) => React.createElement(View, { style: { width: 30, height: 30, borderRadius: 8, backgroundColor: "transparent", borderColor: colors.divider, borderWidth: 1, alignItems: "center", justifyContent: "center" } }, text(value, { color: color === colors.red ? colors.red : colors.accent, fontSize: 16, fontWeight: "700", textAlign: "center" }));
    const mirroredPair = (leading: any, trailing: any) => language === "ar" ? [trailing, leading] : [leading, trailing];
    const sectionTitle = (value: string, right?: any, extraOffset = 0, shiftLeft = 6, fullWidth = false) => React.createElement(View, { style: { width: contentWidth, maxWidth: contentWidth, alignSelf: "center", alignItems: language === "ar" ? "flex-end" : "flex-start", justifyContent: "center", marginTop: 18, marginBottom: 8, direction: "ltr", paddingLeft: language === "ar" ? 0 : 3 + extraOffset, paddingRight: language === "ar" ? 3 + extraOffset : 0 } }, text(value, { color: colors.muted, fontSize: 12, fontWeight: "700", width: fullWidth ? "100%" : "auto", flex: 0, alignSelf: fullWidth ? "stretch" : language === "ar" ? "flex-end" : "flex-start", textAlign: language === "ar" ? "right" : "left", direction: language === "ar" ? "rtl" : "ltr", writingDirection: language === "ar" ? "rtl" : "ltr", transform: [{ translateX: language === "ar" ? -shiftLeft : shiftLeft }] }), right || null);
    const card = (children: any[], style: any = {}) => React.createElement(View, { style: [{ marginHorizontal: 0, width: contentWidth, maxWidth: contentWidth, alignSelf: "center", borderRadius: 10, overflow: "hidden", backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.divider }, style] }, ...children);
    const divider = (key: string) => React.createElement(View, { key, style: { height: 1, backgroundColor: colors.divider, marginLeft: language === "ar" ? 0 : 58, marginRight: language === "ar" ? 58 : 0 } });
    const row = (title: string, subtitle: string, value: string, color: string, onPress: () => void, key: string, trailing?: any) => { const rowIcon = icon(key === "scope" ? "▦" : key === "include" ? "A" : key === "exclude" ? "!" : key === "date-mode" ? "◷" : key === "rule-pinned" ? "⌖" : key === "rule-protect-files" ? "□" : key === "rule-protect-links" ? "↗" : key === "report" ? "▤" : key === "history" ? "◴" : key === "clear-history" ? "×" : "≡", color); const rowBody = React.createElement(View, { style: { flex: 1, paddingHorizontal: 0, marginHorizontal: 10 } }, text(title, { color: colors.text, fontSize: 14, fontWeight: "700", textAlign: language === "ar" ? "right" : "left" }), text(subtitle, { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 3, textAlign: language === "ar" ? "right" : "left" }), text(value, { color, fontSize: 12, fontWeight: "700", marginTop: 4, textAlign: language === "ar" ? "right" : "left" })); const rowTrailing = trailing || text(language === "ar" ? "‹" : "›", { color: colors.faint, fontSize: 24, fontWeight: "300" }); return press(language === "ar" ? [rowTrailing, rowBody, rowIcon] : [rowIcon, rowBody, rowTrailing], onPress, { minHeight: 70, paddingHorizontal: 14, paddingVertical: 10, flexDirection: "row", alignItems: "center", backgroundColor: colors.panel }); };
    const toggleRow = (title: string, subtitle: string, enabled: boolean, color: string, onPress: () => void, key: string) => row(title, subtitle, enabled ? t("on") : t("off"), color, onPress, key, React.createElement(View, { style: { width: 22, height: 22, borderRadius: 5, borderWidth: 2, borderColor: enabled ? colors.accent : colors.muted, backgroundColor: enabled ? colors.accent : "transparent", alignItems: "center", justifyContent: "center" } }, enabled ? text("✓", { color: colors.text, fontSize: 15, lineHeight: 18, fontWeight: "900" }) : null));
    const section = (title: string, children: any[], key: string, right?: any, shiftLeft = 6, fullWidth = false) => {
        const separated: any[] = [];
        children.forEach((child, index) => { if (index) separated.push(divider(`${key}-divider-${index}`)); separated.push(child); });
        return React.createElement(View, { key }, sectionTitle(title, right, 0, shiftLeft, fullWidth), card(separated));
    };
    const actionButton = (label: string, subtitle: string, color: string, onPress: () => void, key: string, disabled = false) => { const actionIcon = icon(key === "run-limit" ? "#" : key === "run-delay" ? "◷" : key === "dry-run" ? "✓" : key === "start" ? "▶" : key === "pause" ? "Ⅱ" : "■", disabled ? colors.faint : color); const actionBody = React.createElement(View, { style: { flex: 1, paddingHorizontal: 0, marginHorizontal: 10 } }, text(label, { color: disabled ? colors.faint : colors.text, fontSize: 13, fontWeight: "700", textAlign: language === "ar" ? "right" : "left" }), text(subtitle, { color: disabled ? colors.faint : colors.muted, fontSize: 10, marginTop: 3, textAlign: language === "ar" ? "right" : "left" })); return press(language === "ar" ? [actionBody, actionIcon] : [actionIcon, actionBody], disabled ? () => undefined : onPress, { width: isWideTablet ? "31.5%" : "48%", minHeight: isTablet ? 68 : 62, margin: isTablet ? "0.75%" : "1%", borderRadius: 8, borderWidth: 1, borderColor: colors.divider, backgroundColor: disabled ? colors.panel : colors.raised, justifyContent: "center", paddingHorizontal: isTablet ? 16 : 14, flexDirection: "row", alignItems: "center" }); };
    const primaryButton = (label: string, subtitle: string, onPress: () => void, disabled = false) => { const primaryIcon = icon("⌖", disabled ? colors.faint : colors.accent); const primaryBody = React.createElement(View, { style: { flex: 1, paddingHorizontal: 0, marginHorizontal: 10 } }, text(label, { color: disabled ? colors.faint : colors.text, fontSize: 14, fontWeight: "700", textAlign: language === "ar" ? "right" : "left" }), text(subtitle, { color: disabled ? colors.faint : colors.muted, fontSize: 11, marginTop: 3, textAlign: language === "ar" ? "right" : "left" })); return press(language === "ar" ? [primaryBody, primaryIcon] : [primaryIcon, primaryBody], disabled ? () => undefined : onPress, { width: "100%", minHeight: 52, marginTop: 14, borderRadius: 8, borderWidth: 1, borderColor: colors.divider, backgroundColor: colors.raised, justifyContent: "center", paddingHorizontal: 16, flexDirection: "row", alignItems: "center" }); };
    const rules = normalizeDeletionRules(settings.deletionRules, settings.filter);
    const updateRules = (mutator: (value: DeletionRules) => DeletionRules) => setSettingsValue((current) => {
        const nextRules = normalizeDeletionRules(mutator({ ...rules, contentScopes: [...rules.contentScopes], includeKeywords: [...rules.includeKeywords], excludeKeywords: [...rules.excludeKeywords] }), current.filter);
        const nextFilter: Filter = { ...current.filter, skipPinned: nextRules.protectPinned, keyword: nextRules.includeKeywordsEnabled ? nextRules.includeKeywords[0] || undefined : undefined, excludeKeyword: nextRules.excludeKeywords[0] || undefined, after: nextRules.dateAfter, before: nextRules.dateBefore, attachmentsOnly: nextRules.contentScopes.length === 1 && nextRules.contentScopes[0] === "files", linksOnly: nextRules.contentScopes.length === 1 && nextRules.contentScopes[0] === "links", textOnly: false };
        return { ...current, deletionRules: nextRules, filter: nextFilter };
    });
    const toggleScope = (scope: ContentScope) => updateRules((current) => {
        if (scope === "all") return { ...current, contentScopes: ["all"] };
        const existing = current.contentScopes.filter((item) => item !== "all");
        const next = existing.includes(scope) ? existing.filter((item) => item !== scope) : [...existing, scope];
        return { ...current, contentScopes: next.length ? next : ["all"] };
    });
    const openKeywordEditor = (field: "includeKeywords" | "excludeKeywords") => { setKeywordEditor(field); setKeywordDraft((rules[field] || []).join("\n")); };
    const parseKeywordDraft = (value: string) => {
        const parts: string[] = [];
        value.split(/[,|]/).forEach((part) => part.split(String.fromCharCode(10)).forEach((item) => parts.push(item)));
        return parts.map((item) => item.trim()).filter(Boolean).slice(0, 32);
    };
    const saveKeywordDraft = () => { if (!keywordEditor) return; updateRules((current) => ({ ...current, [keywordEditor]: parseKeywordDraft(keywordDraft) })); setKeywordEditor(null); setKeywordDraft(""); };
    const removeKeyword = (field: "includeKeywords" | "excludeKeywords", index: number) => updateRules((current) => ({ ...current, [field]: current[field].filter((_value, itemIndex) => itemIndex !== index) }));
    const dateSummary = rules.dateMode === "none" ? t("notSet") : `${t(rules.dateMode)}${rules.dateMode === "range" ? ` · ${rules.dateAfter ? formatDate(rules.dateAfter) : "?"} → ${rules.dateBefore ? formatDate(rules.dateBefore) : "?"}` : ` · ${formatDate(rules.dateMode === "before" ? rules.dateBefore : rules.dateAfter)}`}`;
    const chooseDateMode = (mode: DateMode) => { updateRules((current) => ({ ...current, dateMode: mode })); setDateModeOpen(false); };
    const openDateEditor = (side: "before" | "after") => { setDateEditor(side); setDateDraft(formatDate(side === "before" ? rules.dateBefore : rules.dateAfter)); };
    const saveDateDraft = () => { const parsed = Date.parse(dateDraft); if (!Number.isFinite(parsed)) { openDialog(t("dateMode"), t("invalidTarget"), undefined, t("close"), colors.red); return; } updateRules((current) => ({ ...current, [dateEditor === "before" ? "dateBefore" : "dateAfter"]: parsed })); setDateEditor(null); };
    const openNumberEditor = (kind: "limit" | "delay") => { setNumberEditor(kind); setNumberDraft(String(kind === "limit" ? settings.maxPerRun : Math.round(settings.deleteDelayMs / 1000))); };
    const setNumberValue = (value: string) => setNumberDraft(String(value || "").replace(/[^0-9]/g, ""));
    const commitNumber = () => { if (!numberEditor) return; const value = Number(numberDraft); const minimum = numberEditor === "limit" ? 1 : 3; const maximum = numberEditor === "limit" ? MAX_MESSAGES_PER_RUN : 60; if (!Number.isFinite(value) || value < minimum || value > maximum) { openDialog(t("settings"), language === "ar" ? `أدخل رقماً بين ${minimum} و${maximum}.` : `Enter a number between ${minimum} and ${maximum}.`, undefined, t("close"), colors.red); return; } setSettingsValue((current) => numberEditor === "limit" ? { ...current, maxPerRun: Math.round(value) } : { ...current, deleteDelayMs: Math.round(value) * 1000 }); setNumberEditor(null); };
    const toggleLanguage = () => setSettingsValue((current) => ({ ...current, language: current.language === "ar" ? "en" : "ar" }));
    const statusLabel = isRunning ? t("running") : stats?.completion === "finished" ? t("finished") : stats?.completion === "stopped" ? t("stopped") : stats?.completion === "paused" ? t("paused") : t("ready");
    const targetCard = card([
        React.createElement(View, { style: { padding: 16, backgroundColor: colors.raised } },
            (() => { const targetIcon = icon("⌖", colors.accent); const targetBody = React.createElement(View, { style: { flex: 1, marginHorizontal: 10, alignItems: "stretch", justifyContent: "center" } }, targetTitle); return React.createElement(View, { style: { flexDirection: "row", alignItems: "center", direction: "ltr" } }, ...(language === "ar" ? [targetBody, targetIcon] : [targetIcon, targetBody])); })(),
            text(language === "ar" ? "حدد الهدف فقط؛ المعاينة اختيارية ويمكن بدء التطهير مباشرة." : "Select a target; preview is optional and purge can start immediately.", { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: 13, textAlign: language === "ar" ? "right" : "left", alignSelf: language === "ar" ? "stretch" : "stretch" }),
            primaryButton(t("setTarget"), language === "ar" ? "القناة الحالية أو المعرّف أو رابط Discord" : "Current channel, ID, or Discord link", openTargetEditor),
        ),
    ]);
    const rulesCard = section(t("rules"), [
        row(t("scope"), t("rulesSummary"), rules.contentScopes.includes("all") ? t("allContent") : rules.contentScopes.map((item) => t(item as keyof typeof copy)).join(", "), colors.accent, () => setActivePage("rules"), "scope"),
        row(t("includeKeywords"), language === "ar" ? (rules.keywordMatchMode === "exact" ? "مطابقة الكلمة كحد مستقل" : "تطابق الكلمة داخل نص الرسالة") : (rules.keywordMatchMode === "exact" ? "Match the standalone word" : "Match text inside the message"), rules.includeKeywords.length ? rules.includeKeywords.join(", ") : t("notSet"), colors.red, () => openKeywordEditor("includeKeywords"), "include"),
        row(t("excludeKeywords"), language === "ar" ? "أي كلمة تمنع الحذف" : "Any keyword protects the message", rules.excludeKeywords.length ? rules.excludeKeywords.join(", ") : t("notSet"), colors.red, () => openKeywordEditor("excludeKeywords"), "exclude"),
        toggleRow(t("pinned"), language === "ar" ? "حماية الرسائل المثبتة" : "Protect pinned messages", rules.protectPinned, colors.accent, () => updateRules((current) => ({ ...current, protectPinned: !current.protectPinned })), "pinned"),
        toggleRow(t("protectFiles"), language === "ar" ? "حماية الرسائل التي تحتوي ملفات" : "Protect messages with files", rules.protectFiles, colors.accent, () => updateRules((current) => ({ ...current, protectFiles: !current.protectFiles })), "protect-files"),
        toggleRow(t("protectLinks"), language === "ar" ? "حماية الرسائل التي تحتوي روابط" : "Protect messages with links", rules.protectLinks, colors.accent, () => updateRules((current) => ({ ...current, protectLinks: !current.protectLinks })), "protect-links"),
        row(t("dateMode"), t("datePrompt"), dateSummary, colors.accent, () => setDateModeOpen(true), "date-mode"),
    ], "rules");
    const runCard = section(t("run"), [
        React.createElement(View, { style: { flexDirection: "row", flexWrap: "wrap", padding: isTablet ? 12 : 5, justifyContent: isWideTablet ? "flex-start" : "space-between" } },
            actionButton(t("limit"), `${settings.maxPerRun.toLocaleString()} · 1–10000`, colors.accent, () => openNumberEditor("limit"), "run-limit"),
            actionButton(t("delay"), `${Math.round(settings.deleteDelayMs / 1000)} s · 3–60`, colors.accent, () => openNumberEditor("delay"), "run-delay"),
            actionButton(previewActionLabel, previewActionSubtitle, colors.accent, previewAction, "dry-run", !targetId || isRunning || previewBusy),
            actionButton(canResume ? t("resume") : t("start"), startActionSubtitle, colors.accent, startTarget, "start", !targetId || isRunning),
            actionButton(t("pause"), language === "ar" ? "استئناف لاحقاً" : "Resume later", colors.accent, pauseTarget, "pause", !isRunning),
            actionButton(t("stop"), language === "ar" ? "حفظ الإحصائيات" : "Keep statistics", colors.red, stopTarget, "stop", !isRunning),
        ),
    ], "run");
    const statBar = (label: string, value: number, total: number, color: string) => {
        const safeValue = Math.max(0, Number(value) || 0);
        const safeTotal = Math.max(1, Number(total) || 1);
        const ratio = Math.min(100, Math.max(0, (safeValue / safeTotal) * 100));
        const percent = Math.round(ratio);
        return React.createElement(View, { style: { width: "100%", marginHorizontal: 0, marginBottom: 14 } },
            React.createElement(View, { style: { flexDirection: language === "ar" ? "row-reverse" : "row", justifyContent: "space-between", alignItems: "center", marginBottom: 6, direction: "ltr" } },
                text(label, { color: colors.text, fontSize: 11, fontWeight: "800", textAlign: language === "ar" ? "right" : "left", flex: 1 }),
                React.createElement(View, { style: { flexDirection: "row", alignItems: "center", justifyContent: language === "ar" ? "flex-start" : "flex-end", minWidth: 82, direction: "ltr" } },
                    text(`${safeValue}/${safeTotal}`, { color: colors.muted, fontSize: 10, fontWeight: "800", textAlign: language === "ar" ? "left" : "right", marginRight: 8 }),
                    text(`${percent}%`, { color: color, fontSize: 10, fontWeight: "900", textAlign: language === "ar" ? "left" : "right" }),
                ),
            ),
            React.createElement(View, { style: { width: "100%", height: 13, borderRadius: 7, backgroundColor: colors.sidebar, overflow: "hidden", borderWidth: 1, borderColor: colors.divider, padding: 1 } },
                React.createElement(View, { style: { width: `${ratio}%`, minWidth: ratio > 0 ? 3 : 0, height: 9, borderRadius: 5, backgroundColor: color } }),
            ),
        );
    };
    const lineChart = (rawPoints: ProgressPoint[] | undefined, compact = false, fallbackStats?: Partial<CleanupStats>, previewMode = false) => {
        let points = normalizeProgressHistory(rawPoints);
        if (points.length < 2 && fallbackStats && ((fallbackStats.scanned || 0) > 0 || (fallbackStats.matched || 0) > 0 || (fallbackStats.deleted || 0) > 0 || (fallbackStats.failed || 0) > 0)) {
            const startedAt = Number(fallbackStats.startedAt) || now();
            const endedAt = Number(fallbackStats.endedAt) || now();
            points = [
                { index: 0, timestamp: startedAt, scanned: 0, matched: 0, deleted: 0, failed: 0 },
                { index: 1, timestamp: endedAt, scanned: Number(fallbackStats.scanned) || 0, matched: Number(fallbackStats.matched) || 0, deleted: Number(fallbackStats.deleted) || 0, failed: Number(fallbackStats.failed) || 0 },
            ];
        }
        if (points.length < 2) return null;
        const chartWidth = Math.max(220, contentWidth - 32);
        const chartHeight = compact ? 118 : 148;
        const plotLeft = 7;
        const plotTop = 12;
        const plotWidth = chartWidth - 14;
        const plotHeight = chartHeight - 28;
        const series = previewMode ? [
            { key: "scanned", color: colors.muted, label: t("scanned") },
            { key: "matched", color: colors.accent, label: t("matched") },
            { key: "skipped", color: colors.text, label: t("skipped") },
        ] : [
            { key: "deleted", color: colors.accent, label: t("deleted") },
            { key: "scanned", color: colors.muted, label: t("scanned") },
            { key: "failed", color: colors.red, label: t("failed") },
        ];
        const pointValue = (point: ProgressPoint, key: string) => key === "skipped" ? Math.max(0, Number(point.scanned || 0) - Number(point.matched || 0)) : Number((point as any)[key] || 0);
        const maxValue = Math.max(1, ...points.map((point) => Math.max(pointValue(point, series[0].key), pointValue(point, series[1].key), pointValue(point, series[2].key))));
        const xFor = (index: number) => {
            const ratio = points.length === 1 ? 0 : index / (points.length - 1);
            return language === "ar" ? plotLeft + plotWidth - ratio * plotWidth : plotLeft + ratio * plotWidth;
        };
        const yFor = (value: number) => plotTop + plotHeight - (Math.max(0, value) / maxValue) * plotHeight;
        const lines: any[] = [];
        series.forEach((item) => {
            points.slice(1).forEach((point, index) => {
                const previous = points[index];
                const x1 = xFor(index);
                const y1 = yFor(pointValue(previous, item.key));
                const x2 = xFor(index + 1);
                const y2 = yFor(pointValue(point, item.key));
                const width = Math.max(1, Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2));
                const angle = Math.atan2(y2 - y1, x2 - x1) * 180 / Math.PI;
                lines.push(React.createElement(View, { key: `${item.key}-${index}`, pointerEvents: "none", style: { position: "absolute", left: (x1 + x2) / 2 - width / 2, top: (y1 + y2) / 2 - 1, width, height: item.key === "failed" ? 2.5 : 2, backgroundColor: item.color, transform: [{ rotate: `${angle}deg` }] } }));
            });
        });
        const latest = points[points.length - 1];
        const markers = series.map((item) => React.createElement(View, { key: `${item.key}-marker`, pointerEvents: "none", style: { position: "absolute", left: xFor(points.length - 1) - 3.5, top: yFor(pointValue(latest, item.key)) - 3.5, width: 7, height: 7, borderRadius: 4, backgroundColor: item.color, borderWidth: 1, borderColor: colors.panel } }));
        const grid = [0.25, 0.5, 0.75].map((ratio) => React.createElement(View, { key: `grid-${ratio}`, pointerEvents: "none", style: { position: "absolute", left: plotLeft, top: plotTop + plotHeight * (1 - ratio), width: plotWidth, height: 1, backgroundColor: colors.divider } }));
        const legend = React.createElement(View, { style: { flexDirection: language === "ar" ? "row-reverse" : "row", flexWrap: "wrap", justifyContent: language === "ar" ? "flex-start" : "flex-start", marginTop: 8 } }, ...series.map((item) => React.createElement(View, { key: `${item.key}-legend`, style: { flexDirection: language === "ar" ? "row-reverse" : "row", alignItems: "center", marginRight: language === "ar" ? 0 : 14, marginLeft: language === "ar" ? 14 : 0, marginBottom: 4 } }, React.createElement(View, { style: { width: 7, height: 7, borderRadius: 4, backgroundColor: item.color, marginRight: language === "ar" ? 0 : 5, marginLeft: language === "ar" ? 5 : 0 } }), text(item.label, { color: item.color, fontSize: 10, textAlign: language === "ar" ? "right" : "left" }))));
        return React.createElement(View, { style: { marginTop: compact ? 12 : 16, paddingTop: compact ? 0 : 2 } },
            React.createElement(View, { style: { height: chartHeight, width: chartWidth, alignSelf: "center", position: "relative", backgroundColor: colors.sidebar, borderWidth: 1, borderColor: colors.divider, borderRadius: 7, overflow: "hidden" } }, ...grid, ...lines, ...markers,
                text(String(maxValue), { color: colors.faint, fontSize: 9, position: "absolute", top: 2, ...(language === "ar" ? { right: 5 } : { left: 5 }) }),
                text("0", { color: colors.faint, fontSize: 9, position: "absolute", bottom: 2, ...(language === "ar" ? { right: 5 } : { left: 5 }) }),
            ),
            legend,
        );
    };
    const progressCard = section(t("progress"), [
        React.createElement(View, { style: { padding: 16 } },
            text(`${language === "ar" ? "الوقت" : "Time"}: ${showingPreviewProgress ? formatDuration(Math.max(0, now() - Number(progressStats?.startedAt || now()))) : elapsed}`, { color: colors.muted, fontSize: 11, marginBottom: 11, textAlign: language === "ar" ? "right" : "left" }),
            React.createElement(View, { style: { height: 14, borderRadius: 7, backgroundColor: colors.sidebar, overflow: "hidden", borderWidth: 1, borderColor: colors.divider, padding: 1 } }, React.createElement(View, { style: { width: `${progress}%`, minWidth: progress > 0 ? 3 : 0, height: 10, borderRadius: 5, backgroundColor: colors.accent } })),
            React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8, marginBottom: 15, direction: "ltr" } }, text(`${progress}%`, { color: colors.accent, fontSize: 12, fontWeight: "900", textAlign: "left" }), text(showingPreviewProgress ? `${t("deleted")}: ${deletedNow}/${sessionLimit} · ${t("previewPages")}: ${storedPreviewPlan?.pages || 0}/${PREVIEW_MAX_PAGES}` : `${t("deleted")}: ${deletedNow}/${sessionLimit}`, { color: colors.accent, fontSize: 12, fontWeight: "800", textAlign: "right" })),
            lineChart(showingPreviewProgress ? undefined : savedJob?.progressHistory, false, progressStats, showingPreviewProgress),
            React.createElement(View, { style: { width: "100%", marginTop: 14 } },
                statBar(t("failed"), progressStats?.failed || 0, Math.max(progressStats?.scanned || 0, 1), colors.red),
                statBar(t("skipped"), progressStats?.skipped || 0, Math.max(progressStats?.scanned || 0, 1), colors.muted),
            ),
        ),
    ], "progress", undefined, language === "ar" ? -36 : 6);
    const showReport = () => setReportModal("current");
    const showHistory = () => setReportModal("history");
    const reportCard = section(t("reports"), [
        row(t("currentReport"), language === "ar" ? "إحصائيات المهمة الحالية أو الأخيرة" : "Current or last job statistics", stats ? statusLabel : t("empty"), colors.accent, showReport, "report"),
        row(t("history"), language === "ar" ? "آخر الجلسات المحفوظة" : "Latest saved sessions", `${loadHistory().length}`, colors.accent, showHistory, "history"),
        row(t("clearHistory"), t("clearHistoryHint"), `${loadHistory().length} ${t("historyCount")}`, colors.red, () => openDialog(t("clearHistory"), t("clearHistoryHint"), () => { clearAllPluginData(); setDialog(null); setRefresh((value: number) => value + 1); }, t("clearHistory"), colors.red), "clear-history"),
    ], "reports");
    const currentReportText = savedJob ? reportText(savedJob) : "";
    const auditEntries = savedJob && Array.isArray(savedJob.auditLog) ? savedJob.auditLog.slice(-24) : [];
    const auditText = auditEntries.length ? auditEntries.map((entry, index) => `${index + 1}. ${formatDate(entry.timestamp)} · ${entry.action} · ${entry.reason}${entry.messageId ? ` · id=${entry.messageId}` : ""}${entry.detail ? ` · ${entry.detail}` : ""}`).join("\n") : t("noAudit");
    const historyEntries = loadHistory();
    const historyTargetName = (entry: HistoryEntry) => entry.targetLabel || channelLabel(entry.channelId) || entry.channelId;
    const historyTargetImage = (entry: HistoryEntry) => entry.targetImageUrl || channelAvatarUrl(entry.channelId);
    const historyEntryText = (entry: HistoryEntry, index: number) => [`#${index + 1} ${formatDate(entry.endedAt)}`, `${t("channelDm")}: ${historyTargetName(entry)}`, `${t("status")}: ${completionText(entry.completion)}`, `${t("deleted")}: ${entry.deleted} · ${t("failed")}: ${entry.failed}`, `${t("scanned")}: ${entry.scanned} · ${t("matched")}: ${entry.matched} · ${t("elapsed")}: ${formatDuration(entry.elapsedMs)}`, `${t("auditLog")}: ${entry.auditCount || 0} ${t("auditCount")}`].join("\n");
    const currentReportBody = savedJob ? card([
        text(currentReportText, { color: colors.text, fontSize: 13, lineHeight: 21, textAlign: language === "ar" ? "right" : "left" }),
        press([text(t("copyReport"), { color: colors.text, fontWeight: "900", textAlign: "center" })], () => copyText(currentReportText), { minHeight: 46, borderRadius: 12, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", marginTop: 16 }),
        press([text(t("copyAudit"), { color: colors.text, fontWeight: "900", textAlign: "center" })], () => copyText(auditText), { minHeight: 42, borderRadius: 10, backgroundColor: colors.raised, alignItems: "center", justifyContent: "center", marginTop: 12 }),
    ], { padding: 16 }) : card([text(t("noReport"), { color: colors.muted, fontSize: 14, textAlign: "center", padding: 22 })]);
    const historyCards = historyEntries.length ? historyEntries.map((entry, index) => {
        const details = historyEntryText(entry, index);
        const targetName = historyTargetName(entry);
        const targetImage = historyTargetImage(entry);
        const targetFallback = text((targetName || "?").trim().charAt(0).toUpperCase(), { color: colors.text, fontSize: 19, fontWeight: "900", textAlign: "center" });
        const targetVisual = React.createElement(View, { style: { width: 72, height: 72, borderRadius: 12, backgroundColor: colors.sidebar, borderWidth: 2, borderColor: colors.accent, padding: 3, marginTop: 5, alignItems: "center", justifyContent: "center", overflow: "hidden" } }, React.createElement(View, { style: { width: 62, height: 62, borderRadius: 8, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", overflow: "hidden" } }, targetFallback, targetImage && Image ? React.createElement(Image, { source: { uri: targetImage }, style: { position: "absolute", left: 0, top: 0, width: 62, height: 62, borderRadius: 8, backgroundColor: colors.raised }, resizeMode: "cover", onError: () => undefined }) : null));
        const infoAlign = language === "ar" ? "right" : "left";
        const targetHeader = text(`${t("channelDm")}: ${targetName}`, { color: colors.text, fontSize: 13, lineHeight: 18, fontWeight: "900", marginTop: 8, textAlign: infoAlign });
        const targetInfo = React.createElement(View, { style: { flex: 1, marginHorizontal: 12, minWidth: 0, justifyContent: "flex-start", paddingTop: 1 } },
            text(`${t("deleted")}: ${entry.deleted} · ${t("failed")}: ${entry.failed}`, { color: colors.muted, fontSize: 12, lineHeight: 17, textAlign: infoAlign }),
            text(`${t("scanned")}: ${entry.scanned} · ${t("matched")}: ${entry.matched} · ${t("elapsed")}: ${formatDuration(entry.elapsedMs)}`, { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 3, textAlign: infoAlign }),
            text(`${t("ended")}: ${formatDate(entry.endedAt)}`, { color: colors.faint, fontSize: 11, lineHeight: 16, marginTop: 5, textAlign: infoAlign }),
            text(`${t("auditLog")}: ${entry.auditCount || 0} ${t("auditCount")}`, { color: colors.faint, fontSize: 11, lineHeight: 16, marginTop: 3, textAlign: infoAlign }),
        );
        const targetRow = React.createElement(View, { style: { flexDirection: "row", alignItems: "flex-start", marginTop: 4 } }, ...(language === "ar" ? [targetInfo, targetVisual] : [targetVisual, targetInfo]));
        return card([
            React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" } }, text(`#${index + 1}`, { color: colors.accent, fontSize: 15, fontWeight: "900" }), pill(completionText(entry.completion), entry.completion === "finished" ? colors.accent : colors.muted)),
            targetHeader,
            targetRow,
            lineChart(entry.progressHistory, true, { scanned: entry.scanned, matched: entry.matched, deleted: entry.deleted, failed: entry.failed, startedAt: entry.endedAt - entry.elapsedMs, endedAt: entry.endedAt }),
        ], { marginBottom: 10, padding: 15 });
    }) : [card([text(t("noSessions"), { color: colors.muted, fontSize: 14, textAlign: "center", padding: 22 })])];
    const reportModalContent = reportModal ? React.createElement(
        modalType,
        { visible: true, transparent: true, animationType: "slide", onRequestClose: () => setReportModal(null) },
        React.createElement(
            View,
            { style: { flex: 1, backgroundColor: colors.background, paddingTop: 28 } },
            React.createElement(View, { style: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: colors.divider } }, ...(language === "ar" ? [press([text(t("close"), { color: colors.accent, fontSize: 13, fontWeight: "900" })], () => setReportModal(null), { paddingHorizontal: 10, paddingVertical: 8 }), text(reportModal === "current" ? t("reportModalTitle") : t("historyModalTitle"), { color: colors.text, fontSize: 20, fontWeight: "900", textAlign: "right" })] : [text(reportModal === "current" ? t("reportModalTitle") : t("historyModalTitle"), { color: colors.text, fontSize: 20, fontWeight: "900", textAlign: "left" }), press([text(t("close"), { color: colors.accent, fontSize: 13, fontWeight: "900" })], () => setReportModal(null), { paddingHorizontal: 10, paddingVertical: 8 })])),
            React.createElement(Scroll, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 30, paddingTop: 12 } }, reportModal === "current" ? currentReportBody : historyCards),
        ),
    ) : null;
    const keywordValues = keywordEditor ? parseKeywordDraft(keywordDraft) : [];
    const keywordList = keywordValues.length ? card(keywordValues.map((value, index) => React.createElement(View, { key: `${value}-${index}`, style: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 14, paddingVertical: 11, borderBottomWidth: index === keywordValues.length - 1 ? 0 : 1, borderBottomColor: colors.divider } }, text(value, { color: colors.text, fontSize: 13, flex: 1 }), press([text(t("removeKeyword"), { color: colors.red, fontSize: 11, fontWeight: "900" })], () => setKeywordDraft(keywordValues.filter((_item, itemIndex) => itemIndex !== index).join("\n")), { paddingHorizontal: 8, paddingVertical: 5 })))) : card([text(t("notSet"), { color: colors.muted, fontSize: 13, textAlign: "center", padding: 18 })]);
    const keywordModalBody = [
        card([
            toggleRow(keywordEditor === "includeKeywords" ? t("includeKeywordsEnabled") : t("excludeKeywords"), keywordEditor === "includeKeywords" ? (language === "ar" ? "إذا مفعّلة يحذف فقط الرسائل التي تحتوي إحدى الكلمات" : "When enabled, only messages containing one of these words are purged") : (language === "ar" ? "إذا مفعّلة تمنع الكلمات الموجودة هنا حذف الرسالة" : "When enabled, these words protect matching messages"), keywordEditor === "includeKeywords" ? rules.includeKeywordsEnabled : rules.excludeKeywordsEnabled, colors.accent, () => updateRules((current) => keywordEditor === "includeKeywords" ? { ...current, includeKeywordsEnabled: !current.includeKeywordsEnabled } : { ...current, excludeKeywordsEnabled: !current.excludeKeywordsEnabled }), "keyword-enabled"),
            keywordEditor === "includeKeywords" ? React.createElement(View, { style: { marginTop: 10 } }, toggleRow(rules.keywordMatchMode === "exact" ? t("exactMatch") : t("partialMatch"), language === "ar" ? "مطابقة الكلمة كحد مستقل أو داخل نص الرسالة" : "Match a standalone word or text inside the message", rules.keywordMatchMode === "exact", colors.accent, () => updateRules((current) => ({ ...current, keywordMatchMode: current.keywordMatchMode === "exact" ? "partial" : "exact" })), "keyword-mode")) : null,
            text(t("keywordEditorHint"), { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 12, marginBottom: 12 }),
            React.createElement(inputType, { value: keywordDraft, onChangeText: setKeywordDraft, placeholder: t("keywordPlaceholder"), placeholderTextColor: colors.faint, multiline: true, numberOfLines: 7, textAlignVertical: "top", style: { minHeight: 130, color: colors.text, backgroundColor: colors.sidebar, borderColor: colors.divider, borderWidth: 1, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 12, fontSize: 14, fontFamily: "Alexandria", textAlign: language === "ar" ? "right" : "left" } }),
            text(`${keywordValues.length}/32`, { color: keywordValues.length >= 32 ? colors.muted : colors.faint, fontSize: 11, textAlign: "right", marginTop: 7 }),
        ], { padding: 16 }),
        sectionTitle(t("sessionDetails")),
        keywordList,
        press([text(t("saveKeywords"), { color: colors.text, fontWeight: "900", textAlign: "center" })], saveKeywordDraft, { marginHorizontal: 18, marginTop: 16, minHeight: 48, borderRadius: 12, backgroundColor: colors.accent, justifyContent: "center" }),
    ];
    const keywordModalContent = keywordEditor ? React.createElement(
        modalType,
        { visible: true, transparent: true, animationType: "slide", onRequestClose: () => setKeywordEditor(null) },
        React.createElement(
            View,
            { style: { flex: 1, backgroundColor: colors.background, paddingTop: 28 } },
            React.createElement(View, { style: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, paddingBottom: 14, borderBottomWidth: 1, borderBottomColor: colors.divider } }, ...(language === "ar" ? [press([text(t("close"), { color: colors.accent, fontSize: 13, fontWeight: "900" })], () => setKeywordEditor(null), { paddingHorizontal: 10, paddingVertical: 8 }), text(`${t("keywordEditorTitle")} · ${keywordEditor === "includeKeywords" ? t("includeKeywords") : t("excludeKeywords")}`, { color: colors.text, fontSize: 19, fontWeight: "900", textAlign: "right" })] : [text(`${t("keywordEditorTitle")} · ${keywordEditor === "includeKeywords" ? t("includeKeywords") : t("excludeKeywords")}`, { color: colors.text, fontSize: 19, fontWeight: "900", textAlign: "left" }), press([text(t("close"), { color: colors.accent, fontSize: 13, fontWeight: "900" })], () => setKeywordEditor(null), { paddingHorizontal: 10, paddingVertical: 8 })])),
            React.createElement(Scroll, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 30, paddingTop: 12 } }, keywordModalBody),
        ),
    ) : null;
    const rulesScopeCard = card([
        toggleRow(t("allContent"), language === "ar" ? "يشمل كل أنواع المحتوى" : "Include every content type", rules.contentScopes.includes("all"), colors.accent, () => toggleScope("all"), "rule-all"),
        divider("rule-scope-divider-1"),
        toggleRow(t("messages"), language === "ar" ? "رسائل نصية بدون صور أو روابط أو ملفات" : "Plain messages without images, links, or files", rules.contentScopes.includes("messages"), colors.accent, () => toggleScope("messages"), "rule-messages"),
        divider("rule-scope-divider-2"),
        toggleRow(t("images"), language === "ar" ? "رسائل تحتوي صوراً" : "Messages containing images", rules.contentScopes.includes("images"), colors.accent, () => toggleScope("images"), "rule-images"),
        divider("rule-scope-divider-3"),
        toggleRow(t("links"), language === "ar" ? "رسائل تحتوي روابط" : "Messages containing links", rules.contentScopes.includes("links"), colors.accent, () => toggleScope("links"), "rule-links"),
        divider("rule-scope-divider-4"),
        toggleRow(t("files"), language === "ar" ? "ملفات غير الصور" : "Non-image attachments", rules.contentScopes.includes("files"), colors.accent, () => toggleScope("files"), "rule-files"),
    ]);
    const rulesKeywordCard = card([
        row(t("includeKeywords"), language === "ar" ? (rules.keywordMatchMode === "exact" ? "مطابقة الكلمة كحد مستقل" : "تطابق الكلمة داخل نص الرسالة") : (rules.keywordMatchMode === "exact" ? "Match the standalone word" : "Match text inside the message"), rules.includeKeywords.length ? rules.includeKeywords.join(", ") : t("notSet"), colors.red, () => openKeywordEditor("includeKeywords"), "rule-include"),
        divider("rule-keyword-divider"),
        row(t("excludeKeywords"), language === "ar" ? "أي كلمة تمنع الحذف" : "Any keyword protects the message", rules.excludeKeywords.length ? rules.excludeKeywords.join(", ") : t("notSet"), colors.red, () => openKeywordEditor("excludeKeywords"), "rule-exclude"),
    ]);
    const rulesSafetyCard = card([
        toggleRow(t("pinned"), language === "ar" ? "حماية الرسائل المثبتة" : "Protect pinned messages", rules.protectPinned, colors.accent, () => updateRules((current) => ({ ...current, protectPinned: !current.protectPinned })), "rule-pinned"),
        divider("rule-protect-divider-1"),
        toggleRow(t("protectFiles"), language === "ar" ? "حماية الرسائل التي تحتوي ملفات" : "Protect messages with files", rules.protectFiles, colors.accent, () => updateRules((current) => ({ ...current, protectFiles: !current.protectFiles })), "rule-protect-files"),
        divider("rule-protect-divider-2"),
        toggleRow(t("protectLinks"), language === "ar" ? "حماية الرسائل التي تحتوي روابط" : "Protect messages with links", rules.protectLinks, colors.accent, () => updateRules((current) => ({ ...current, protectLinks: !current.protectLinks })), "rule-protect-links"),
    ]);
    const rulesDateItems = [
        row(t("dateMode"), t("datePrompt"), dateSummary, colors.accent, () => setDateModeOpen(true), "rule-date-mode"),
        rules.dateMode === "before" || rules.dateMode === "range" ? row(t("before"), language === "ar" ? "آخر يوم مسموح به" : "Latest allowed day", rules.dateBefore ? formatDate(rules.dateBefore) : t("notSet"), colors.accent, () => openDateEditor("before"), "rule-date-before") : null,
        rules.dateMode === "after" || rules.dateMode === "range" ? row(t("after"), language === "ar" ? "أقدم يوم مسموح به" : "Earliest allowed day", rules.dateAfter ? formatDate(rules.dateAfter) : t("notSet"), colors.accent, () => openDateEditor("after"), "rule-date-after") : null,
    ].filter(Boolean);
    const rulesDateCard = card(rulesDateItems as any[]);
    const resetRules = () => updateRules(() => ({ ...defaultSettings().deletionRules }));
    const rulesPage = React.createElement(
        Scroll,
        { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 34 } },
        sectionTitle(t("scope")), rulesScopeCard,
        sectionTitle(t("includeKeywords")), rulesKeywordCard,
        sectionTitle(t("safety")), rulesSafetyCard,
        sectionTitle(t("dateMode")), rulesDateCard,
        text(t("rulesNote"), { color: colors.faint, fontSize: 11, lineHeight: 16, marginHorizontal: 22, marginTop: 18, textAlign: "center" }),
        React.createElement(
            View,
            { style: { flexDirection: "row", marginTop: 16 } },
            ...(language === "ar" ? [press([text(t("saveContinue"), { color: colors.text, fontSize: 12, fontWeight: "900", textAlign: "center" })], () => { setActivePage("home"); openDialog(t("rulesSaved"), language === "ar" ? "رجعت للرئيسية. موارد الحذف محفوظة." : "Returned to Home. Deletion resources are saved.", undefined, t("close"), colors.accent); }, { flex: 1.35, minHeight: 48, marginRight: 12, borderRadius: 12, backgroundColor: colors.accent, justifyContent: "center" }), press([text(t("resetRules"), { color: colors.red, fontSize: 12, fontWeight: "900", textAlign: "center" })], resetRules, { flex: 1, minHeight: 48, marginHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: `${colors.red}70`, justifyContent: "center" }),] : [press([text(t("resetRules"), { color: colors.red, fontSize: 12, fontWeight: "900", textAlign: "center" })], resetRules, { flex: 1, minHeight: 48, marginHorizontal: 12, borderRadius: 12, borderWidth: 1, borderColor: `${colors.red}70`, justifyContent: "center" }), press([text(t("saveContinue"), { color: colors.text, fontSize: 12, fontWeight: "900", textAlign: "center" })], () => { setActivePage("home"); openDialog(t("rulesSaved"), language === "ar" ? "رجعت للرئيسية. موارد الحذف محفوظة." : "Returned to Home. Deletion resources are saved.", undefined, t("close"), colors.accent); }, { flex: 1.35, minHeight: 48, marginRight: 12, borderRadius: 12, backgroundColor: colors.accent, justifyContent: "center" }),]),
        ),
    );
    const rulesContent = null;
    const targetTabButton = (key: "saved" | "current" | "id" | "link", label: string) => press([text(label, { color: targetMode === key ? colors.text : colors.muted, fontSize: 12, fontWeight: "900", textAlign: "center", width: "100%", alignSelf: "stretch" })], () => setTargetMode(key), { flex: 1, minHeight: 40, borderRadius: 9, backgroundColor: targetMode === key ? `${colors.accent}35` : "transparent", borderWidth: 1, borderColor: targetMode === key ? `${colors.accent}90` : "transparent", alignItems: "center", justifyContent: "center", paddingHorizontal: 10, marginHorizontal: 3 });
    const targetTabs = language === "ar" ? [targetTabButton("link", t("linkTab")), targetTabButton("id", t("idTab")), targetTabButton("current", t("currentTab"))] : [targetTabButton("current", t("currentTab")), targetTabButton("id", t("idTab")), targetTabButton("link", t("linkTab"))];
    const detectedId = currentChannelId();
    const detectedLabel = detectedId ? channelLabel(detectedId) || (language === "ar" ? "القناة الحالية" : "Current channel") : t("currentPreview");
    const targetTextStyle = { width: "100%", alignSelf: "stretch", flexShrink: 1, textAlign: language === "ar" ? "right" : "left" } as any;
    const targetBody = targetMode === "saved" ? React.createElement(View, { style: { width: "100%", alignSelf: "stretch", marginTop: 15, backgroundColor: colors.panel, borderRadius: 12, padding: 14, alignItems: "stretch" } }, blockText(t("savedTarget"), { color: colors.text, fontSize: 15, fontWeight: "900", width: "100%", alignSelf: "stretch", ...targetTextStyle }), targetLabelValue(t("targetName"), targetName, colors.accent, 13, "400", { marginTop: 10 }), targetLabelValue(t("targetId"), targetId || t("noTarget"), colors.muted, 12, "400", { marginTop: 6 }), targetLabelValue(t("targetSource"), settings.target?.source || t("manual"), colors.faint, 11, "400", { marginTop: 6 }), press([text(t("editTarget"), { color: colors.text, fontWeight: "900", textAlign: "center" })], () => setTargetMode("current"), { minHeight: 44, borderRadius: 10, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", marginTop: 13 })) : targetMode === "current" ? React.createElement(View, { style: { width: "100%", alignSelf: "stretch", marginTop: 15, backgroundColor: colors.panel, borderRadius: 12, padding: 14, alignItems: "stretch" } }, blockText(t("currentTarget"), { color: colors.text, fontSize: 15, fontWeight: "900", width: "100%", alignSelf: "stretch", ...targetTextStyle }), blockText(t("currentTargetBody"), { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 5, ...targetTextStyle }), blockText(detectedLabel, { color: detectedId ? colors.accent : colors.faint, fontSize: 12, lineHeight: 17, marginTop: 13, ...targetTextStyle }), press([text(t("detectCurrent"), { color: colors.text, fontWeight: "900", textAlign: "center" })], useCurrent, { minHeight: 44, borderRadius: 10, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", marginTop: 13 })) : targetMode === "id" ? React.createElement(View, { style: { width: "100%", alignSelf: "stretch", marginTop: 15, alignItems: "stretch" } }, blockText(t("idTarget"), { color: colors.text, fontSize: 15, fontWeight: "900", width: "100%", alignSelf: "stretch", ...targetTextStyle }), blockText(t("idTargetBody"), { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 5, ...targetTextStyle }), React.createElement(inputType, { value: targetDraft, onChangeText: setTargetDraft, placeholder: "123456789012345678", placeholderTextColor: colors.faint, keyboardType: "number-pad", autoFocus: true, style: { color: colors.text, backgroundColor: colors.panel, borderColor: colors.divider, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, marginTop: 13, fontSize: 14, fontFamily: "Alexandria", textAlign: language === "ar" ? "right" : "left" } }), press([text(t("save"), { color: colors.text, fontWeight: "900", textAlign: "center" })], () => saveTarget(targetDraft), { minHeight: 44, borderRadius: 10, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", marginTop: 13 })) : React.createElement(View, { style: { width: "100%", alignSelf: "stretch", marginTop: 15, alignItems: "stretch" } }, blockText(t("linkTarget"), { color: colors.text, fontSize: 15, fontWeight: "900", width: "100%", alignSelf: "stretch", ...targetTextStyle }), blockText(t("linkTargetBody"), { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 5, ...targetTextStyle }), React.createElement(inputType, { value: targetLinkDraft, onChangeText: setTargetLinkDraft, placeholder: "https://discord.com/channels/...", placeholderTextColor: colors.faint, autoCapitalize: "none", autoCorrect: false, style: { color: colors.text, backgroundColor: colors.panel, borderColor: colors.divider, borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 12, marginTop: 13, fontSize: 14, fontFamily: "Alexandria", textAlign: language === "ar" ? "right" : "left" } }), press([text(t("parseLink"), { color: colors.text, fontWeight: "900", textAlign: "center" })], saveTargetLink, { minHeight: 44, borderRadius: 10, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", marginTop: 13 }));

    const modalContent = targetEditorOpen ? React.createElement(modalType, { visible: true, transparent: true, animationType: "fade", onRequestClose: () => setTargetEditorOpen(false) }, React.createElement(View, { style: { flex: 1, backgroundColor: "#00000099", justifyContent: "center", padding: 22 } }, React.createElement(View, { style: { backgroundColor: colors.raised, borderRadius: 19, padding: 18, borderWidth: 1, borderColor: colors.divider, elevation: 0, alignItems: "stretch" } }, blockText(t("setChannelTitle"), { color: colors.text, fontSize: 19, fontWeight: "900", width: "100%", alignSelf: "stretch", textAlign: language === "ar" ? "right" : "left" }), blockText(t("setChannelMessage"), { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 7, width: "100%", alignSelf: "stretch", textAlign: language === "ar" ? "right" : "left" }), React.createElement(View, { style: { width: "100%", alignSelf: "stretch", flexDirection: "row", marginTop: 16, backgroundColor: colors.panel, borderRadius: 11, padding: 3, direction: "ltr", alignItems: "stretch" } }, ...targetTabs), targetBody, press([text(t("cancel"), { color: colors.muted, fontWeight: "800", textAlign: "center" })], () => setTargetEditorOpen(false), { minHeight: 42, alignItems: "center", justifyContent: "center", marginTop: 10 })))) : null;
    const modalFrame = (content: any, onClose: () => void, animationType: "fade" | "slide" = "fade") => React.createElement(
        modalType,
        { visible: true, transparent: true, animationType, onRequestClose: onClose },
        React.createElement(View, { style: { flex: 1, backgroundColor: "#00000099", justifyContent: "center", padding: 22, direction: "ltr" } }, content),
    );
    const numberModalBody = numberEditor ? React.createElement(View, { style: { backgroundColor: colors.raised, borderRadius: 19, padding: 18, borderWidth: 1, borderColor: colors.divider } },
        text(numberEditor === "limit" ? t("limit") : t("delay"), { color: colors.text, fontSize: 19, fontWeight: "900", textAlign: language === "ar" ? "right" : "left" }),
        text(numberEditor === "limit" ? t("limitPrompt") : t("delayPrompt"), { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 7, textAlign: language === "ar" ? "right" : "left" }),
        React.createElement(inputType, { value: numberDraft, onChangeText: setNumberValue, keyboardType: "number-pad", selectTextOnFocus: true, style: { color: colors.text, backgroundColor: colors.sidebar, borderColor: colors.accent, borderWidth: 1, borderRadius: 11, paddingHorizontal: 14, paddingVertical: 12, marginTop: 17, fontSize: 21, fontWeight: "900", textAlign: "center", fontFamily: "Alexandria" } }),
        React.createElement(View, { style: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 16 } }, text(numberEditor === "limit" ? t("minimumLimit") : t("minimumDelay"), { color: colors.muted, fontSize: 11 }), text(`${numberEditor === "limit" ? t("maximumLimit") : t("maximumDelay")}`, { color: colors.muted, fontSize: 11 })),
        React.createElement(sliderType, { minimumValue: numberEditor === "limit" ? 0 : 3, maximumValue: numberEditor === "limit" ? steppedLimitValues.length - 1 : 60, step: 1, value: numberEditor === "limit" ? Math.max(0, steppedLimitValues.indexOf(Number(numberDraft) || settings.maxPerRun)) : Number(numberDraft) || 3, minimumTrackTintColor: colors.accent, maximumTrackTintColor: colors.divider, thumbTintColor: colors.accent, onValueChange: (value: number) => setNumberDraft(String(numberEditor === "limit" ? steppedLimitValues[Math.round(value)] : Math.round(value))), style: { marginTop: 8, height: 40 } }),
        press([text(t("save"), { color: colors.text, fontWeight: "900", textAlign: "center" })], commitNumber, { minHeight: 46, borderRadius: 12, backgroundColor: colors.accent, justifyContent: "center", marginTop: 15 }),
        press([text(t("cancel"), { color: colors.muted, fontWeight: "800", textAlign: "center" })], () => setNumberEditor(null), { minHeight: 40, justifyContent: "center", marginTop: 4 }),
    ) : null;
    const numberModal = numberEditor ? modalFrame(numberModalBody, () => setNumberEditor(null)) : null;
    const dateModalBody = dateEditor ? React.createElement(View, { style: { backgroundColor: colors.raised, borderRadius: 19, padding: 18, borderWidth: 1, borderColor: colors.divider } },
        text(dateEditor === "before" ? t("before") : t("after"), { color: colors.text, fontSize: 19, fontWeight: "900", textAlign: language === "ar" ? "right" : "left" }),
        text(t("datePrompt"), { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 7, textAlign: language === "ar" ? "right" : "left" }),
        React.createElement(inputType, { value: dateDraft, onChangeText: setDateDraft, placeholder: "YYYY-MM-DD", placeholderTextColor: colors.faint, style: { color: colors.text, backgroundColor: colors.sidebar, borderColor: colors.divider, borderWidth: 1, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 12, marginTop: 16, fontSize: 14, fontFamily: "Alexandria", textAlign: language === "ar" ? "right" : "left" } }), press([text(t("save"), { color: colors.text, fontWeight: "900", textAlign: "center" })], saveDateDraft, { minHeight: 46, borderRadius: 12, backgroundColor: colors.accent, justifyContent: "center", marginTop: 15 }),
        press([text(t("cancel"), { color: colors.muted, fontWeight: "800", textAlign: "center" })], () => setDateEditor(null), { minHeight: 40, justifyContent: "center", marginTop: 4 }),
    ) : null;
    const dateModal = dateEditor ? modalFrame(dateModalBody, () => setDateEditor(null)) : null;
    const dateModeChoices = (["range", "before", "after"] as DateMode[]).map((mode) => {
        const modeLabel = text(t(mode), { color: colors.text, fontSize: 14, fontWeight: "800", flex: 1, textAlign: language === "ar" ? "right" : "left" });
        const modeCheck = text(mode === rules.dateMode ? "✓" : "", { color: colors.accent, fontSize: 18, fontWeight: "900", textAlign: "center", marginHorizontal: 10 });
        return press(language === "ar" ? [modeLabel, modeCheck] : [modeCheck, modeLabel], () => chooseDateMode(mode), { minHeight: 48, borderRadius: 8, marginTop: 8, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", justifyContent: "space-between", backgroundColor: mode === rules.dateMode ? `${colors.accent}22` : colors.panel });
    });
    const dateModeModalBody = React.createElement(View, { style: { backgroundColor: colors.raised, borderRadius: 12, padding: 18, borderWidth: 1, borderColor: colors.divider } }, text(t("dateMode"), { color: colors.text, fontSize: 19, fontWeight: "900", textAlign: language === "ar" ? "right" : "left" }), text(t("dateModeHint"), { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 7, textAlign: language === "ar" ? "right" : "left" }), dateModeChoices);
    const dateModeModal = dateModeOpen ? modalFrame(dateModeModalBody, () => setDateModeOpen(false)) : null;
    const previewModal = previewOpen ? modalFrame(card([
        text(t("dryRun"), { color: colors.text, fontSize: 19, fontWeight: "900", textAlign: language === "ar" ? "right" : "left" }),
        text(previewBusy ? t("previewRunning") : storedPreviewPlan?.complete ? t("previewReady") : storedPreviewPlan?.lastError || t("previewResume"), { color: previewBusy ? colors.accent : colors.muted, fontSize: 12, lineHeight: 18, marginTop: 7, textAlign: language === "ar" ? "right" : "left" }),
        React.createElement(View, { style: { marginTop: 15, backgroundColor: colors.sidebar, borderRadius: 10, padding: 13, borderWidth: 1, borderColor: colors.divider } },
            text(`${t("scanned")}: ${storedPreviewPlan?.scanned || 0}`, { color: colors.text, fontSize: 13, marginBottom: 7 }),
            text(`${t("matched")}: ${storedPreviewPlan?.matched || 0}`, { color: colors.accent, fontSize: 13, marginBottom: 7 }),
            text(`${t("skipped")}: ${storedPreviewPlan?.skipped || 0}`, { color: colors.muted, fontSize: 13, marginBottom: 7 }),
            text(`${t("previewPages")}: ${storedPreviewPlan?.pages || 0}`, { color: colors.muted, fontSize: 13, marginBottom: 7 }),
            text(`${t("previewCursor")}: ${storedPreviewPlan?.nextCursor || storedPreviewPlan?.scanUpperBoundId || "—"}`, { color: colors.faint, fontSize: 10, numberOfLines: 1 }),
        ),
        text(t("safetyNote"), { color: colors.faint, fontSize: 11, lineHeight: 16, marginTop: 12, textAlign: language === "ar" ? "right" : "left" }),
        previewBusy ? press([text(t("previewKeep"), { color: colors.text, fontWeight: "900", textAlign: "center" })], stopPreview, { minHeight: 46, borderRadius: 10, backgroundColor: colors.accent, justifyContent: "center", marginTop: 15 }) : null,
        !previewBusy && storedPreviewPlan && previewValid && (storedPreviewPlan.complete || storedPreviewPlan.pages >= PREVIEW_MAX_PAGES) ? press([text(t("previewPurge"), { color: colors.text, fontWeight: "900", textAlign: "center" })], purgePreview, { minHeight: 46, borderRadius: 10, backgroundColor: colors.accent, justifyContent: "center", marginTop: 15 }) : null,
        !previewBusy && (previewCanContinue || !storedPreviewPlan || previewExpired) ? press([text(previewCanContinue ? t("previewRefresh") : t("previewStart"), { color: colors.text, fontWeight: "900", textAlign: "center" })], previewAction, { minHeight: 46, borderRadius: 10, backgroundColor: colors.raised, justifyContent: "center", marginTop: 10 }) : null,
        !previewBusy ? press([text(t("close"), { color: colors.muted, fontWeight: "900", textAlign: "center" })], () => setPreviewOpen(false), { minHeight: 42, justifyContent: "center", marginTop: 5 }) : null,
    ], { padding: 17 }), () => { if (!previewBusy) setPreviewOpen(false); }) : null;
    const dialogBody = dialog ? React.createElement(View, { style: { backgroundColor: colors.raised, borderRadius: 19, padding: 19, borderWidth: 1, borderColor: `${dialog.color || colors.accent}A0`, elevation: 0 } },
        text(dialog.title, { color: colors.text, fontSize: 19, fontWeight: "900" }),
        text(dialog.body, { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 10 }),
        React.createElement(View, { style: { flexDirection: "row", justifyContent: "flex-end", marginTop: 18 } },
            ...(language === "ar" ? [
                press([text(dialog.cancelLabel || t("close"), { color: colors.muted, fontWeight: "800", textAlign: "center" })], () => setDialog(null), { minHeight: 42, paddingHorizontal: 13, justifyContent: "center" }),
                dialog.onConfirm ? press([text(dialog.confirmLabel || t("continue"), { color: colors.text, fontWeight: "900", textAlign: "center" })], () => dialog.onConfirm?.(), { minHeight: 42, paddingHorizontal: 15, borderRadius: 10, backgroundColor: dialog.color || colors.accent, justifyContent: "center", marginRight: 7 }) : null,
            ].filter(Boolean) : [
                dialog.onConfirm ? press([text(dialog.confirmLabel || t("continue"), { color: colors.text, fontWeight: "900", textAlign: "center" })], () => dialog.onConfirm?.(), { minHeight: 42, paddingHorizontal: 15, borderRadius: 10, backgroundColor: dialog.color || colors.accent, justifyContent: "center", marginLeft: 7 }) : null,
                press([text(dialog.cancelLabel || t("close"), { color: colors.muted, fontWeight: "800", textAlign: "center" })], () => setDialog(null), { minHeight: 42, paddingHorizontal: 13, justifyContent: "center" }),
            ].filter(Boolean)),
        ),
    ) : null;
    const dialogContent = dialog ? modalFrame(dialogBody, () => setDialog(null)) : null;
    const menuButton = press([text("☰", { color: colors.text, fontSize: 21, fontWeight: "700" })], () => setDrawerOpen(true), { width: 42, height: 42, borderRadius: 8, backgroundColor: colors.sidebar, borderWidth: 1, borderColor: colors.divider, alignItems: "center", justifyContent: "center" });
    const languageButton = press([text(language === "ar" ? "EN" : "AR", { color: colors.text, fontSize: 12, fontWeight: "900" }), text(language === "ar" ? t("english") : t("arabic"), { color: colors.muted, fontSize: 9, marginTop: 2 })], toggleLanguage, { minWidth: 53, minHeight: 43, borderRadius: 11, borderWidth: 1, borderColor: colors.divider, backgroundColor: colors.raised, alignItems: "center", justifyContent: "center" });
    const headerTitle = React.createElement(View, { style: { flex: 1, marginHorizontal: 10 } }, text(t("title"), { color: colors.text, fontSize: 22, fontWeight: "700", textAlign: language === "ar" ? "right" : "left" }), text(t("subtitle"), { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 3, textAlign: language === "ar" ? "right" : "left" }));
    const headerTop = React.createElement(View, { style: { flexDirection: "row", alignItems: "center", direction: "ltr" } }, ...(language === "ar" ? [languageButton, headerTitle, menuButton] : [menuButton, headerTitle, languageButton]));
    const headerStatusPill = pill(statusLabel, statusColor);
    const header = React.createElement(View, { style: { paddingHorizontal: isTablet ? contentGutter : 16, paddingTop: 18, paddingBottom: 13, backgroundColor: colors.background } }, React.createElement(View, { style: { width: "100%", maxWidth: contentMaxWidth, alignSelf: "center" } }, headerTop));
    const navItem = (page: "home" | "rules" | "run" | "reports", label: string, symbol: string) => { const navSymbol = text(symbol, { color: activePage === page ? colors.text : colors.muted, fontSize: 17, width: 30, textAlign: "center" }); const navLabel = text(label, { color: activePage === page ? colors.text : colors.muted, fontSize: 14, fontWeight: "700", flex: 1, marginHorizontal: 10, textAlign: language === "ar" ? "right" : "left" }); const navCheck = activePage === page ? text("✓", { color: colors.accent, fontSize: 14, fontWeight: "700" }) : null; return press(language === "ar" ? [navCheck, navLabel, navSymbol] : [navSymbol, navLabel, navCheck], () => { setActivePage(page); setDrawerOpen(false); }, { minHeight: 50, borderRadius: 8, backgroundColor: activePage === page ? colors.raised : "transparent", borderWidth: 1, borderColor: activePage === page ? colors.divider : "transparent", flexDirection: "row", alignItems: "center", paddingHorizontal: 12, marginBottom: 6 }); };
    const drawerPanel = React.createElement(View, { style: { width: drawerWidth, maxWidth: 430, backgroundColor: colors.sidebar, paddingTop: 32, paddingHorizontal: 15, borderRightWidth: language === "ar" ? 0 : 1, borderLeftWidth: language === "ar" ? 1 : 0, borderColor: colors.divider, elevation: 0 } }, (() => { const drawerTitle = text(language === "ar" ? `\u2067${t("target")}: \u2066${targetDisplayName}\u2069\u2069` : `${t("target")}: ${targetDisplayName}`, { color: colors.text, fontSize: 16, fontWeight: "900", textAlign: language === "ar" ? "right" : "left" }); const drawerSubtitle = text(language === "ar" ? "تطهير شخصي آمن" : "Personal purge", { color: colors.muted, fontSize: 10, marginTop: 3, textAlign: language === "ar" ? "right" : "left" }); const drawerHeading = React.createElement(View, { style: { flex: 1, marginHorizontal: 10 } }, drawerTitle, drawerSubtitle); const drawerClose = press([text("×", { color: colors.muted, fontSize: 23 })], () => setDrawerOpen(false), { padding: 8 }); const drawerMark = icon("Y", colors.accent); return React.createElement(View, { style: { flexDirection: "row", alignItems: "center", marginBottom: 22, direction: "ltr" } }, ...(language === "ar" ? [drawerClose, drawerHeading, drawerMark] : [drawerMark, drawerHeading, drawerClose])); })(), navItem("home", t("home"), "⌂"), navItem("rules", t("pageRules"), "☷"), navItem("run", t("pageRun"), "▶"), navItem("reports", t("pageReports"), "▤"), text(PLUGIN_VERSION, { color: colors.accent, fontSize: 10, textAlign: "center", marginTop: 18 }));
    const drawerBackdrop = React.createElement(View, { style: { flex: 1 } }, press([], () => setDrawerOpen(false), { flex: 1 }));
    const drawerContent = drawerOpen ? React.createElement(modalType, { visible: true, transparent: true, animationType: "fade", onRequestClose: () => setDrawerOpen(false) }, React.createElement(View, { style: { flex: 1, backgroundColor: "#00000099", flexDirection: "row", direction: "ltr" } }, ...(language === "ar" ? [drawerBackdrop, drawerPanel] : [drawerPanel, drawerBackdrop]))) : null;
    const rawPageContent = activePage === "home" ? React.createElement(Scroll, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 34 } }, sectionTitle(t("target")), targetCard, sectionTitle(t("editRules"), undefined, 3, 12), press((() => { const homeIcon = icon("☷", colors.accent); const homeBody = React.createElement(View, { style: { flex: 1, marginHorizontal: 10 } }, text(t("editRules"), { color: colors.text, fontSize: 14, fontWeight: "900", textAlign: language === "ar" ? "right" : "left" }), text(t("rulesSummary"), { color: colors.muted, fontSize: 11, marginTop: 3, textAlign: language === "ar" ? "right" : "left" })); const homeArrow = text(language === "ar" ? "‹" : "›", { color: colors.faint, fontSize: 24 }); return language === "ar" ? [homeArrow, homeBody, homeIcon] : [homeIcon, homeBody, homeArrow]; })(), () => setActivePage("rules"), { marginHorizontal: 12, minHeight: 65, borderRadius: 8, borderWidth: 1, borderColor: colors.divider, backgroundColor: colors.panel, flexDirection: "row", alignItems: "center", paddingHorizontal: 15 }), runCard, progressCard, reportCard):activePage==="rules" ? rulesPage : activePage === "run" ? React.createElement(Scroll, { style: { flex: 1 }, contentContainerStyle:{paddingBottom:34}},runCard,progressCard): React.createElement(Scroll, { style: { flex: 1 }, contentContainerStyle: { paddingBottom: 34 } }, reportCard);
    const pageContent = React.createElement(View, { style: { flex: 1, width: contentWidth, maxWidth: contentWidth, alignSelf: "center" } }, rawPageContent);
    const screen = React.createElement(View, { style: { flex: 1, paddingBottom: 20 } }, header, pageContent, text(PLUGIN_VERSION, { color: colors.faint, fontSize: 10, textAlign: "center", marginTop: 18 }));
    return React.createElement(SafeArea, { style: { flex: 1, backgroundColor: colors.background } }, screen, modalContent, rulesContent, reportModalContent, keywordModalContent, numberModal, dateModal, dateModeModal, previewModal, dialogContent, drawerContent);
}
export const Settings = settingsComponent;

const NavigationNative = (common as any).NavigationNative;
const SettingsForms = components.Forms;
const SettingsFormSection = SettingsForms?.FormSection;
const SettingsFormRow = SettingsForms?.FormRow;
const TableRowIcon = findByProps("TableRowIcon")?.TableRowIcon;
const bunny = (globalThis as any).bunny;
const tabsNavigationRef = bunny?.metro?.findByPropsLazy("getRootNavigationRef");
const settingConstants = bunny?.metro?.findByPropsLazy("SETTING_RENDERER_CONFIG");
const SettingsOverviewScreen = bunny?.metro?.findByNameLazy("SettingsOverviewScreen", false);
const createListModule = bunny?.metro?.findByPropsLazy("createList");
let unpatchSidebar: (() => void) | null = null;

const GIRAPURGE_ICON_URI = "data:image/png;base64,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";

function GiraPurgeIcon() {
    const Image = RN.Image;
    if (Image) return React.createElement(Image, { source: { uri: GIRAPURGE_ICON_URI }, style: { width: 28, height: 28, borderRadius: 9 } });
    return React.createElement(RN.View, { style: { width: 28, height: 28, borderRadius: 9, backgroundColor: "#5865f2", alignItems: "center", justifyContent: "center" } }, text("✦", { color: "#ffffff", fontSize: 18, fontWeight: "900" }));
}

function SettingsSidebarSection({ tabs }: { tabs: any }) {
    const navigation = NavigationNative?.useNavigation?.();
    if (!SettingsFormRow) return null;
    return React.createElement(SettingsFormRow, {
        label: tabs.title(),
        leading: React.createElement(GiraPurgeIcon),
        trailing: React.createElement(React.Fragment, {}, [
            tabs.trailing ? tabs.trailing() : null,
            SettingsFormRow.Arrow ? React.createElement(SettingsFormRow.Arrow, { key: "arrow" }) : null,
        ]),
        onPress: () => {
            const Component = tabs.page;
            navigation?.navigate?.("VendettaCustomPage", {
                title: tabs.title(),
                render: () => React.createElement(Component),
            });
        },
    });
}

function patchPanelUI(tabs: any, patches: Array<() => void>) {
    if (!SettingsFormSection || !SettingsFormRow) return;
    try {
        const wrapper = bunny?.metro?.findByNameLazy("UserSettingsOverviewWrapper", false);
        patches.push(after("default", wrapper, (_args: any, ret: any) => {
            const overview = findInReactTree(ret?.props?.children, (node: any) => node?.type?.name === "UserSettingsOverview");
            if (!overview?.type?.prototype) return;
            patches.push(after("render", overview.type.prototype, (_renderArgs: any, result: any) => {
                const sections = findInReactTree(result?.props?.children, (node: any) => node?.children?.[1]?.type === SettingsFormSection)?.children;
                if (!sections || !Array.isArray(sections)) return;
                if (sections.some((section: any) => section?.key === tabs.key || section?.props?.children?.key === tabs.key)) return;
                let index = sections.findIndex((section: any) => ["BILLING_SETTINGS", "PREMIUM_SETTINGS"].includes(section?.props?.label));
                if (index < 0) index = 3;
                sections.splice(index + 1, 0, React.createElement(SettingsSidebarSection, { key: tabs.key, tabs }));
            }));
        }, true));
    } catch {}
}

function patchTabsUI(tabs: any, patches: Array<() => void>) {
    if (!settingConstants || !SettingsOverviewScreen || !tabsNavigationRef) return;

    const row: any = {};
    row[tabs.key] = {
        type: "pressable",
        title: tabs.title,
        useTitle: tabs.title,
        icon: tabs.icon,
        IconComponent: () => {
            const source = typeof tabs.icon === "object" && tabs.icon?.uri !== undefined ? tabs.icon.uri : tabs.icon;
            return source && TableRowIcon ? React.createElement(TableRowIcon, { source }) : React.createElement(GiraPurgeIcon);
        },
        usePredicate: tabs.predicate,
        useTrailing: tabs.trailing,
        onPress: () => {
            const navigation = tabsNavigationRef.getRootNavigationRef?.();
            const Component = tabs.page;
            navigation?.navigate?.("VendettaCustomPage", {
                title: tabs.title(),
                render: () => React.createElement(Component),
            });
        },
        withArrow: true,
    };

    let rendererConfigValue = settingConstants.SETTING_RENDERER_CONFIG;
    Object.defineProperty(settingConstants, "SETTING_RENDERER_CONFIG", {
        enumerable: true,
        configurable: true,
        get: () => ({ ...rendererConfigValue, ...row }),
        set: (value: any) => { rendererConfigValue = value; },
    });

    const firstRender = Symbol("GiraPurge-pinToSettings");
    const appendToRevenge = (config: any) => {
        if (!config || config[firstRender]) return;
        config[firstRender] = true;
        const sections = config.sections;
        if (!Array.isArray(sections)) return;
        let section = sections.find((item: any) => ["Bunny", "Kettu", "Revenge"].includes(item?.label));
        if (!section) {
            const isMainSettings = sections.find((item: any) => Array.isArray(item?.settings) && item.settings.includes("ACCOUNT"));
            if (isMainSettings) {
                section = { label: "Revenge", title: "Revenge", settings: [] };
                sections.unshift(section);
            }
        }
        if (section?.settings && !section.settings.includes(tabs.key)) section.settings.push(tabs.key);
    };

    try {
        if (createListModule) {
            patches.push(after("createList", createListModule, (args: any[]) => appendToRevenge(args?.[0])));
        } else {
            patches.push(after("default", SettingsOverviewScreen, (_args: any, ret: any) => {
                const sections = findInReactTree(ret, (node: any) => node?.props?.sections)?.props?.sections;
                appendToRevenge({ sections });
            }));
        }
    } catch {
        try {
            patches.push(after("default", SettingsOverviewScreen, (_args: any, ret: any) => {
                const sections = findInReactTree(ret, (node: any) => node?.props?.sections)?.props?.sections;
                appendToRevenge({ sections });
            }));
        } catch {}
    }
}

function patchSettingsPin(tabs: any) {
    const patches: Array<() => void> = [];
    let disabled = false;
    const realPredicate = tabs.predicate || (() => true);
    tabs.predicate = () => (disabled ? false : realPredicate());
    patchPanelUI(tabs, patches);
    try { patchTabsUI(tabs, patches); } catch {}
    patches.push(() => { disabled = true; });
    return () => {
        for (const unpatch of patches) {
            try { unpatch(); } catch {}
        }
    };
}

function patchSidebar() {
    try {
        return patchSettingsPin({
            key: "GiraPurge",
            icon: null,
            title: () => "GiraPurge Plugin",
            predicate: () => true,
            page: settingsComponent,
        });
    } catch {
        return () => {};
    }
}

export const onLoad = () => {
    lifecycleEpoch += 1;
    cancelled = false;
    stopRequested = false;
    clearRequested = false;
    currentJob = loadJob();
    if (currentJob?.stats?.completion === "paused" && currentJob.stats.pausedAt) saveJob(currentJob);
    unpatchSidebar?.();
    unpatchSidebar = patchSidebar();
};

export const onUnload = () => {
    lifecycleEpoch += 1;
    cancelled = true;
    if (currentJob?.stats?.completion === "running") {
        markPaused(currentJob, "lifecycle-pause", "Plugin unloaded while the job was running; state saved for resume");
        clearRequested = false;
        if (!clearRequested) saveJob(currentJob);
    }
    running = false;
    while (PATCHES.length) PATCHES.pop()?.();
    unpatchSidebar?.();
    unpatchSidebar = null;
};
