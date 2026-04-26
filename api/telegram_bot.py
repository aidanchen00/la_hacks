"""
Prana Telegram bot.

Runs as a SEPARATE process from the FastAPI server (long-polling, no webhook).

Usage:
    python -m api.telegram_bot
or:
    python api/telegram_bot.py

Required env: TELEGRAM_BOT_TOKEN (from @BotFather).
"""
from __future__ import annotations

import asyncio
import logging
import os
import sys
import traceback
from datetime import datetime
from pathlib import Path
from uuid import uuid4

# Ensure repo root is on sys.path when run as `python api/telegram_bot.py`.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from dotenv import load_dotenv
# web/.env.local is the single source of truth (shared with the Next.js app);
# repo-root .env is kept as a fallback so existing setups don't break. Real
# shell env always wins (override=False).
load_dotenv(_REPO_ROOT / "web" / ".env.local", override=False)
load_dotenv(_REPO_ROOT / ".env", override=False)

from langdetect import DetectorFactory, LangDetectException, detect
from telegram import Update
from telegram.constants import ParseMode
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from api.db import (
    init_db,
    insert_agent_event,
    insert_telegram_run,
    upsert_routing_decision,
)
from api.routing import route_intake

# Deterministic langdetect output for reproducible demo behavior.
DetectorFactory.seed = 0

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("prana-telegram")
# Quiet down noisy upstream libs.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("telegram").setLevel(logging.WARNING)
logging.getLogger("apscheduler").setLevel(logging.WARNING)

TELEGRAM_MAX_LEN = 4096
SUPPORTED = {"en", "es", "zh"}

# ---------------------------------------------------------------------------
# Static replies
# ---------------------------------------------------------------------------

WELCOME_TEXT = (
    "👋 Hi, I'm Prana — your multilingual healthcare triage assistant.\n\n"
    "Just describe your symptoms in English, Spanish, or Chinese, and I'll help you understand:\n"
    "- How urgent it is\n"
    "- Where to get care (ER, urgent care, primary care, or self-care)\n"
    "- What it might cost\n\n"
    "Try: \"I've had a fever since yesterday\"\n\n"
    "—\n\n"
    "👋 Hola, soy Prana — tu asistente de triaje médico multilingüe.\n\n"
    "Describe tus síntomas en inglés, español o chino y te ayudaré a entender:\n"
    "- Qué tan urgente es\n"
    "- Dónde recibir atención\n"
    "- Cuánto podría costar\n\n"
    "Prueba: \"Tengo fiebre desde ayer\"\n\n"
    "—\n\n"
    "👋 你好,我是 Prana — 你的多语言医疗分诊助手。\n\n"
    "请用英语、西班牙语或中文描述你的症状,我会帮你了解:\n"
    "- 紧急程度\n"
    "- 应该去哪里就诊\n"
    "- 大概费用\n\n"
    "试试看:\"我从昨天开始发烧\""
)

HELP_TEXT = (
    "How to use Prana:\n"
    "- Just type your symptoms in a normal sentence\n"
    "- Be specific: how long, how severe, any other symptoms\n"
    "- I support English, Spanish, and Chinese\n\n"
    "Example: \"My 65-year-old mother has chest pain for 1 hour\"\n\n"
    "—\n\n"
    "Cómo usar Prana:\n"
    "- Escribe tus síntomas en una oración normal\n"
    "- Sé específico: cuánto tiempo, qué tan grave, otros síntomas\n"
    "- Apoyo inglés, español y chino\n\n"
    "Ejemplo: \"Mi madre de 65 años tiene dolor de pecho desde hace 1 hora\"\n\n"
    "—\n\n"
    "如何使用 Prana:\n"
    "- 用一句话描述你的症状\n"
    "- 请具体说明:持续多久、严重程度、其他症状\n"
    "- 支持英语、西班牙语和中文\n\n"
    "示例:\"我 65 岁的母亲胸痛 1 小时了\""
)

ABOUT_TEXT = (
    "About Prana — a multilingual healthcare triage assistant built for LA Hacks 2026. "
    "Prana helps you decide where to seek care for your symptoms in English, Spanish, or Chinese. "
    "It is a hackathon project and NOT a substitute for professional medical advice, diagnosis, or treatment. "
    "If this is a medical emergency, call 911 immediately.\n\n"
    "—\n\n"
    "Acerca de Prana — un asistente multilingüe de triaje médico hecho para LA Hacks 2026. "
    "Prana te ayuda a decidir dónde buscar atención para tus síntomas en inglés, español o chino. "
    "Es un proyecto de hackathon y NO sustituye el consejo, diagnóstico o tratamiento médico profesional. "
    "Si se trata de una emergencia médica, llama al 911 de inmediato.\n\n"
    "—\n\n"
    "关于 Prana — 这是为 LA Hacks 2026 打造的多语言医疗分诊助手,"
    "可用英语、西班牙语或中文帮助你判断该去哪里就诊。"
    "本项目仅为黑客松作品,不能替代专业的医疗建议、诊断或治疗。"
    "如遇紧急情况,请立即拨打 911。"
)

UNSUPPORTED_LANG_TEXT = (
    "⚠️ Prana currently supports English, Spanish, and Chinese only. "
    "Please try again in one of these languages.\n\n"
    "⚠️ Prana actualmente solo admite inglés, español y chino. "
    "Por favor, inténtalo en uno de estos idiomas.\n\n"
    "⚠️ Prana 目前仅支持英语、西班牙语和中文。请使用其中一种语言重试。"
)

GENERIC_ERROR = {
    "en": "Something went wrong, please try again",
    "es": "Algo salió mal, por favor inténtalo de nuevo",
    "zh": "出现错误,请重试",
}

# ---------------------------------------------------------------------------
# Localized labels for the formatted triage response
# ---------------------------------------------------------------------------

LABELS = {
    "en": {
        "emergency_banner": "🚨 EMERGENCY",
        "urgent_banner": "⚠️ URGENT",
        "routine_banner": "ℹ️ ROUTINE",
        "wellness_banner": "ℹ️ WELLNESS",
        "call_911": "Call 911 or go to the nearest emergency room immediately.",
        "care_path": "Care path",
        "cost": "Estimated cost",
        "next_steps": "Next steps",
        "disclaimer_prefix": "Note",
        "respond_instruction": "Please write the summary, next_actions, rationale, and disclaimers in English.",
    },
    "es": {
        "emergency_banner": "🚨 EMERGENCIA",
        "urgent_banner": "⚠️ URGENTE",
        "routine_banner": "ℹ️ RUTINARIO",
        "wellness_banner": "ℹ️ BIENESTAR",
        "call_911": "Llama al 911 o acude a la sala de emergencias más cercana de inmediato.",
        "care_path": "Atención recomendada",
        "cost": "Costo estimado",
        "next_steps": "Próximos pasos",
        "disclaimer_prefix": "Nota",
        "respond_instruction": "Por favor escribe summary, next_actions, rationale y disclaimers en español.",
    },
    "zh": {
        "emergency_banner": "🚨 紧急",
        "urgent_banner": "⚠️ 急需就医",
        "routine_banner": "ℹ️ 常规",
        "wellness_banner": "ℹ️ 健康咨询",
        "call_911": "请立即拨打 911 或前往最近的急诊室。",
        "care_path": "建议就医方式",
        "cost": "预计费用",
        "next_steps": "下一步",
        "disclaimer_prefix": "说明",
        "respond_instruction": "请用中文撰写 summary、next_actions、rationale 和 disclaimers。",
    },
}

CARE_PATH_LABELS = {
    "en": {
        "doctor": "Doctor visit",
        "pharmacy": "Pharmacy / OTC",
        "mental_health": "Mental health support",
        "alt_medicine": "Alternative medicine",
        "self_care": "Self-care",
    },
    "es": {
        "doctor": "Consulta médica",
        "pharmacy": "Farmacia / OTC",
        "mental_health": "Apoyo de salud mental",
        "alt_medicine": "Medicina alternativa",
        "self_care": "Autocuidado",
    },
    "zh": {
        "doctor": "看医生",
        "pharmacy": "药房 / 非处方药",
        "mental_health": "心理健康支持",
        "alt_medicine": "替代医学",
        "self_care": "自我护理",
    },
}

# Realistic out-of-pocket cost ranges by recommended path (USD).
COST_RANGES = {
    "doctor": {"emergency": (1500, 5000), "urgent": (150, 350),
               "routine": (100, 250), "wellness": (80, 200)},
    "pharmacy": {"emergency": (10, 50), "urgent": (10, 50),
                 "routine": (5, 30), "wellness": (5, 30)},
    "mental_health": {"emergency": (200, 500), "urgent": (100, 250),
                      "routine": (80, 200), "wellness": (0, 150)},
    "alt_medicine": {"emergency": (50, 200), "urgent": (50, 200),
                     "routine": (40, 150), "wellness": (20, 100)},
    "self_care": {"emergency": (0, 25), "urgent": (0, 25),
                  "routine": (0, 25), "wellness": (0, 25)},
}

# ---------------------------------------------------------------------------
# MarkdownV2 escaping
# ---------------------------------------------------------------------------

# Per Telegram MarkdownV2 spec.
_MD2_SPECIAL = r"_*[]()~`>#+-=|{}.!"


def md2_escape(text: str) -> str:
    """Escape MarkdownV2 special characters in dynamic text."""
    if text is None:
        return ""
    out = []
    for ch in str(text):
        if ch in _MD2_SPECIAL:
            out.append("\\" + ch)
        else:
            out.append(ch)
    return "".join(out)


# ---------------------------------------------------------------------------
# Language detection
# ---------------------------------------------------------------------------

def _has_han(text: str) -> bool:
    """True if the string contains any CJK Han ideograph.

    langdetect is unreliable on short CJK text — it routinely returns 'ko' or
    'ja' for plain Chinese sentences. The presence of any Han codepoint
    (U+4E00–U+9FFF, plus the common extension blocks) is a strong signal that
    we're looking at Chinese in the Prana use case.
    """
    for ch in text:
        cp = ord(ch)
        if 0x4E00 <= cp <= 0x9FFF:  # CJK Unified Ideographs
            return True
        if 0x3400 <= cp <= 0x4DBF:  # CJK Extension A
            return True
        if 0x20000 <= cp <= 0x2A6DF:  # CJK Extension B
            return True
    return False


def detect_lang(text: str) -> str:
    """Return one of 'en', 'es', 'zh', or 'other'.

    Defaults to 'en' on detection failure or for very short messages.
    """
    cleaned = (text or "").strip()
    if not cleaned:
        return "en"
    # Han characters dominate → treat as Chinese (overrides langdetect's
    # frequent ko/ja misclassification on short Chinese strings).
    if _has_han(cleaned):
        return "zh"
    if len(cleaned) < 4:
        return "en"
    try:
        raw = detect(cleaned)
    except LangDetectException:
        return "en"
    if raw.startswith("zh"):
        return "zh"
    if raw == "en":
        return "en"
    if raw == "es":
        return "es"
    return "other"


# ---------------------------------------------------------------------------
# Response formatting
# ---------------------------------------------------------------------------

def _truncate(text: str, limit: int = TELEGRAM_MAX_LEN) -> str:
    if len(text) <= limit:
        return text
    cut = text[: limit - 3]
    last_period = max(cut.rfind(". "), cut.rfind("。"), cut.rfind("\n"))
    if last_period > limit // 2:
        cut = cut[: last_period + 1]
    return cut + "..."


def _banner(urgency: str, lang: str) -> str:
    L = LABELS[lang]
    return {
        "emergency": L["emergency_banner"],
        "urgent": L["urgent_banner"],
        "routine": L["routine_banner"],
        "wellness": L["wellness_banner"],
    }.get(urgency, L["routine_banner"])


def _cost_range_text(path: str, urgency: str) -> str:
    lo, hi = COST_RANGES.get(path, {}).get(urgency, (0, 0))
    if lo == 0 and hi == 0:
        return "$0"
    return f"${lo}–${hi}"


def format_decision(decision: dict, lang: str) -> str:
    """Render a RoutingDecision dict as a MarkdownV2-formatted Telegram message."""
    L = LABELS[lang]
    urgency = (decision.get("urgency") or "routine").lower()
    path = (decision.get("recommended_path") or "self_care").lower()
    summary = decision.get("summary") or ""
    next_actions = decision.get("next_actions") or []
    disclaimers = decision.get("disclaimers") or []

    care_label = CARE_PATH_LABELS[lang].get(path, path.replace("_", " "))
    cost_text = _cost_range_text(path, urgency)

    lines = []
    # Banner — bold urgency level. The banner string already contains an emoji
    # plus a localized urgency word; escape the whole thing for MarkdownV2.
    lines.append(f"*{md2_escape(_banner(urgency, lang))}*")
    if urgency == "emergency":
        lines.append("")
        lines.append(f"*{md2_escape(L['call_911'])}*")
    lines.append("")

    if summary:
        lines.append(md2_escape(summary))
        lines.append("")

    # Care path — bold the path label.
    lines.append(f"*{md2_escape(L['care_path'])}*: {md2_escape(care_label)}")
    lines.append(f"*{md2_escape(L['cost'])}*: {md2_escape(cost_text)}")

    if next_actions:
        lines.append("")
        lines.append(f"*{md2_escape(L['next_steps'])}*:")
        for action in next_actions[:5]:
            lines.append(f"• {md2_escape(str(action))}")

    if disclaimers:
        lines.append("")
        for d in disclaimers[:3]:
            lines.append(f"_{md2_escape(str(d))}_")

    return _truncate("\n".join(lines))


# ---------------------------------------------------------------------------
# Handlers
# ---------------------------------------------------------------------------

async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message:
        await update.message.reply_text(WELCOME_TEXT)


async def cmd_help(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message:
        await update.message.reply_text(HELP_TEXT)


async def cmd_about(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.message:
        await update.message.reply_text(ABOUT_TEXT)


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    msg = update.message
    if not msg or not msg.text:
        return

    text = msg.text.strip()
    user_id = str(msg.from_user.id) if msg.from_user else ""
    chat_id = str(msg.chat_id)
    lang = detect_lang(text)

    logger.info(
        "incoming ts=%s tg_user=%s lang=%s len=%d",
        datetime.utcnow().isoformat(timespec="seconds"),
        user_id, lang, len(text),
    )

    if lang == "other":
        await msg.reply_text(UNSUPPORTED_LANG_TEXT)
        logger.info(
            "outgoing ts=%s urgency=unsupported_lang len=%d",
            datetime.utcnow().isoformat(timespec="seconds"),
            len(UNSUPPORTED_LANG_TEXT),
        )
        return

    try:
        run_id = str(uuid4())
        insert_telegram_run(run_id, text, text, user_id, chat_id)
        insert_agent_event(run_id, "telegram", "intake_received", {
            "telegram_user_id": user_id,
            "telegram_chat_id": chat_id,
            "detected_language": lang,
            "message_length": len(text),
        })

        # Nudge the LLM to respond in the user's language without changing
        # route_intake's signature: append a directive to the summary slot.
        directive = LABELS[lang]["respond_instruction"]
        decision = await route_intake(text, f"{text}\n\n[{directive}]")
        decision["run_id"] = run_id
        upsert_routing_decision(decision)
        insert_agent_event(run_id, "orchestrator", "routing_complete", decision)

        reply = format_decision(decision, lang)
        await msg.reply_text(reply, parse_mode=ParseMode.MARKDOWN_V2)

        logger.info(
            "outgoing ts=%s urgency=%s len=%d run=%s",
            datetime.utcnow().isoformat(timespec="seconds"),
            decision.get("urgency", "?"), len(reply), run_id[:8],
        )
    except Exception as e:
        logger.error("handler failed for tg_user=%s: %s", user_id, e)
        logger.error(traceback.format_exc())
        try:
            await msg.reply_text(GENERIC_ERROR.get(lang, GENERIC_ERROR["en"]))
        except Exception as inner:
            logger.error("failed to send error reply: %s", inner)


async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    """PTB-level error handler — keeps the dispatcher alive on unexpected errors."""
    logger.error("PTB error: %s", context.error)
    if context.error:
        logger.error("".join(traceback.format_exception(
            type(context.error), context.error, context.error.__traceback__
        )))


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    if not token:
        sys.stderr.write(
            "ERROR: TELEGRAM_BOT_TOKEN is not set.\n"
            "Get a token from @BotFather on Telegram, then add it to .env:\n"
            "    TELEGRAM_BOT_TOKEN=your_token_here\n"
        )
        sys.exit(1)

    init_db()  # ensure schema (incl. source / telegram_user_id columns) is in place

    app = Application.builder().token(token).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("about", cmd_about))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.add_error_handler(on_error)

    logger.info("Prana Telegram bot started — listening for messages.")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
