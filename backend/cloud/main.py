import asyncio
import json
import os
import time
import uuid
from datetime import date
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from groq import BadRequestError, Groq
from supabase import create_client, Client

# Local dev convenience only - Railway injects env vars directly, so this is a
# harmless no-op there (file just won't exist in the deployed container).
load_dotenv(Path(__file__).resolve().parent.parent.parent / ".env")

app = FastAPI()

# The Electron app loads the renderer via win.loadFile() (see electron/main.js),
# so it runs on a file:// origin. Chromium sends the literal "Origin: null" header
# for fetch() calls made from a file:// document - that's the actual origin this
# backend receives today, not a localhost URL.
#
# TODO before public launch: if the frontend ever moves off file:// (e.g. served
# from a hosted https:// origin), replace "null" with that exact origin. "null" is
# a broad match - any local file:// page, not just this app, can send it - so it
# should not stay once real user auth exists.
ALLOWED_ORIGINS = ["null"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    """Liveness check for Railway to poll - confirms the FastAPI process is
    up, not that Groq/Supabase are reachable, so a transient third-party
    outage doesn't get the whole service marked unhealthy and restarted."""
    return {"status": "ok"}


GROQ_MODEL = "openai/gpt-oss-120b"

MAX_STEPS = 5

SYSTEM_PROMPT = """You convert user tasks into Windows PC steps.
You are controlling a real Windows PC.
Be very specific about timing - apps need time to load.

STRICT RULE - READ FIRST:
Only generate steps that are explicitly and literally requested in the user
task, never assume additional steps, never add bonus actions, never open
unrelated apps or websites. If the user says open chrome, the only step is
opening chrome.
Maximum of 5 steps total, no exceptions.

Available actions:
- open_app: opens application. value = app name.
  Known apps: chrome, edge, notepad, calculator, spotify, file explorer.
  Use wait: 0.3-0.5 for this step. These are minimums, not comfortable
  defaults - do not pad them higher "to be safe".
- navigate: types URL in browser address bar then presses enter.
  value = full url like "youtube.com".
  ALWAYS add wait: 1.0 before and expect 3 seconds to load
- search_youtube: searches on YouTube using / shortcut.
  value = search query. Only use when YouTube is already open.
  Use wait: 0.5-0.8 before this step. These are minimums, not comfortable
  defaults - do not pad them higher "to be safe".
- search_google: searches Google directly.
  value = search query. Use wait: 0.5-0.8 before this step. These are
  minimums, not comfortable defaults - do not pad them higher "to be safe".
- new_tab: opens new browser tab
- click_target: finds and clicks something visible on screen.
  value = description of element like "YouTube search bar" or "profile icon".
  Use this instead of blind typing when possible.
- extract_search_results: reads the search results currently on screen via
  vision and captures their text. value not needed. Only use right after a
  search (search_google/search_youtube/navigate) has finished loading.
- type: types text. value = text. To type whatever extract_search_results
  just captured, use value: "{{extracted_results}}" instead of literal text.
- press: presses key. value = key name
- hotkey: keyboard shortcut. value = "ctrl+t" etc
- wait: waits. value = seconds as string

CRITICAL RULES:
1. open_app must always come first if app is not open
2. navigate must wait for app to open first
3. search_youtube only works after YouTube is fully loaded
4. Always add enough wait time between steps
5. For "open chrome and search youtube for X":
   Step 1: open_app chrome (wait: 0.4)
   Step 2: navigate to youtube.com (wait: 3.0)
   Step 3: search_youtube for X (wait: 0.6)
6. For "open chrome, search for best yc startups, and write the results in notepad":
   Step 1: open_app chrome (wait: 0.4)
   Step 2: search_google "best yc startups" (wait: 0.6)
   Step 3: extract_search_results (wait: 1.0)
   Step 4: open_app notepad (wait: 0.4)
   Step 5: type "{{extracted_results}}" (wait: 3.5)

Return JSON:
{
  "steps": [
    {"action": "open_app", "value": "chrome",
     "wait": 0.4, "message": "opening chrome!"},
    {"action": "navigate", "value": "youtube.com",
     "wait": 3.0, "message": "going to youtube!"},
    {"action": "search_youtube", "value": "AI tutorials",
     "wait": 0.6, "message": "searching for that!"}
  ],
  "summary": "I'll open Chrome, go to YouTube and search for AI tutorials"
}"""

groq_api_key = next(
    (key.strip() for key in os.getenv("GROQ_API_KEYS", "").split(",") if key.strip()),
    None,
)
groq_client = Groq(api_key=groq_api_key) if groq_api_key else None

if not groq_client:
    print("Warning: GROQ_API_KEYS is missing or empty. Chat will run in degraded mode.")

supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_KEY")
supabase_client: Client | None = (
    create_client(supabase_url, supabase_key) if supabase_url and supabase_key else None
)

if not supabase_client:
    print("Warning: SUPABASE_URL or SUPABASE_KEY is missing. Persistent memory is disabled.")
else:
    try:
        supabase_client.table("conversation_history").select("id").limit(1).execute()
        print("Supabase connected: conversation_history table reachable.")
    except Exception as error:
        print(f"Supabase connection test failed: {error}")

# Fallback for requests with no (or a malformed) X-User-Id header - keeps
# curl/dev testing working without a real Electron client attached.
TEST_USER_ID = "00000000-0000-0000-0000-000000000001"


def get_user_id(request: Request) -> str:
    """Reads the per-install user_id the Electron app generates once
    (crypto.randomUUID(), persisted in userData - see electron/main.js) and
    sends as X-User-Id on every request, so chat history/profile/usage stop
    colliding into one shared row across every install.

    SECURITY NOTE: this is a partitioning key, not authentication. Nothing
    here verifies the header actually came from the install that "owns" that
    id - a request with no header falls back to TEST_USER_ID below, and a
    request with any other well-formed UUID is accepted as-is and reads/
    writes that user's data. Do not treat a request validated by this
    function as authenticated until a real auth system (e.g. Supabase Auth)
    replaces it.
    """
    raw_user_id = request.headers.get("x-user-id", "")
    try:
        return str(uuid.UUID(raw_user_id))
    except ValueError:
        return TEST_USER_ID

# Kokoro (TTS) is disabled on this service for now - loading its model
# (pulls in PyTorch) was causing the whole process to be OOM-killed on
# Railway's 1GB tier, taking /chat and /plan down with it. A try/except
# around KPipeline() couldn't catch this: an OOM kill is the OS sending
# SIGKILL, not a raised Python exception, so no in-process handler runs.
# Re-add once either the Railway plan is upgraded or Kokoro runs as its
# own isolated service.
async def speak_text(text: str, emotion: str) -> str:
    """Voice generation is disabled - always returns "" so callers (just
    /chat) degrade to text-only rather than depend on audio being present."""
    return ""


DANGEROUS_WORDS = ["password", "bank", "payment", "credit card", "delete", "format"]

CHAT_SYSTEM_PROMPT = """You are Lyra, a friendly AI companion. Respond naturally
and conversationally to whatever the user says, including general questions.
Keep responses under 3 sentences unless asked for detail.

Always respond with a JSON object with exactly two fields:
- "text": your conversational reply, as plain text.
- "emotion": exactly one of "happy", "angry", "sad", "relaxed", "surprised", or
  "neutral" - whichever best matches the emotional tone of your reply itself.

Example: {"text": "That's wonderful, I'm so glad it worked out!", "emotion": "happy"}"""

VALID_CHAT_EMOTIONS = {"happy", "angry", "sad", "relaxed", "surprised", "neutral"}

DAILY_TOKEN_LIMIT = 50000


def today_str() -> str:
    return date.today().isoformat()


async def get_daily_token_usage(user_id: str) -> int:
    if not supabase_client:
        return 0
    try:
        response = await asyncio.to_thread(
            supabase_client.table("user_daily_usage")
            .select("tokens_used")
            .eq("user_id", user_id)
            .eq("date", today_str())
            .limit(1)
            .execute
        )
        if response.data:
            return response.data[0]["tokens_used"]
        return 0
    except Exception as error:
        print(f"Supabase daily usage fetch failed: {error}")
        return 0


async def add_daily_token_usage(user_id: str, tokens: int) -> int:
    if not supabase_client:
        return 0
    try:
        new_total = await get_daily_token_usage(user_id) + tokens
        await asyncio.to_thread(
            supabase_client.table("user_daily_usage")
            .upsert(
                {"user_id": user_id, "date": today_str(), "tokens_used": new_total},
                on_conflict="user_id,date",
            )
            .execute
        )
        return new_total
    except Exception as error:
        print(f"Supabase daily usage update failed: {error}")
        return 0


async def get_user_profile(user_id: str) -> dict | None:
    if not supabase_client:
        return None
    try:
        response = await asyncio.to_thread(
            supabase_client.table("user_profile")
            .select("name, primary_goal")
            .eq("user_id", user_id)
            .limit(1)
            .execute
        )
        return response.data[0] if response.data else None
    except Exception as error:
        print(f"Supabase profile fetch failed: {error}")
        return None


@app.get("/profile")
async def get_profile(request: Request):
    if not supabase_client:
        return {"exists": False}
    user_id = get_user_id(request)
    try:
        response = await asyncio.to_thread(
            supabase_client.table("user_profile")
            .select("name, primary_goal")
            .eq("user_id", user_id)
            .limit(1)
            .execute
        )
        if response.data:
            row = response.data[0]
            return {"exists": True, "name": row["name"], "goal": row["primary_goal"]}
        return {"exists": False}
    except Exception as error:
        print(f"Supabase profile fetch failed: {error}")
        return {"exists": False}


@app.put("/profile")
async def update_profile(request: Request, body: dict):
    name = (body.get("name") or "").strip()
    goal = (body.get("goal") or "").strip()
    if not name or not goal:
        return {"success": False, "reason": "name and goal are required"}
    if not supabase_client:
        return {"success": False, "reason": "database unavailable"}

    try:
        await asyncio.to_thread(
            supabase_client.table("user_profile")
            .update({"name": name, "primary_goal": goal})
            .eq("user_id", get_user_id(request))
            .execute
        )
        return {"success": True}
    except Exception as error:
        print(f"Supabase profile update failed: {error}")
        return {"success": False, "reason": "database error"}


@app.post("/profile")
async def create_profile(request: Request, body: dict):
    name = (body.get("name") or "").strip()
    goal = (body.get("goal") or "").strip()
    if not name or not goal:
        return {"success": False, "reason": "name and goal are required"}

    user_id = get_user_id(request)

    if supabase_client:
        try:
            await asyncio.to_thread(
                supabase_client.table("user_profile")
                .insert({"user_id": user_id, "name": name, "primary_goal": goal})
                .execute
            )
        except Exception as error:
            print(f"Supabase profile insert failed: {error}")
            return {"success": False, "reason": "database error"}

    reply_text = f"Hi {name}! I'm Lyra - I heard you're here to {goal}. I'm excited to help you with that!"
    emotion = "happy"

    if groq_client:
        try:
            response = await asyncio.to_thread(
                groq_client.chat.completions.create,
                model=GROQ_MODEL,
                messages=[
                    {"role": "system", "content": CHAT_SYSTEM_PROMPT},
                    {
                        "role": "user",
                        "content": (
                            f'This is the very first time meeting {name}. Their goal for using '
                            f'you is: "{goal}". Greet them warmly by name and briefly '
                            "acknowledge their goal."
                        ),
                    },
                ],
                response_format={"type": "json_object"},
            )
            result = json.loads(response.choices[0].message.content)
            candidate_text = (result.get("text") or "").strip()
            candidate_emotion = result.get("emotion")
            if candidate_text:
                reply_text = candidate_text
            if candidate_emotion in VALID_CHAT_EMOTIONS:
                emotion = candidate_emotion
        except Exception as error:
            print(f"Groq onboarding greeting call failed: {error}")

    if supabase_client:
        try:
            await asyncio.to_thread(
                supabase_client.table("conversation_history")
                .insert(
                    {
                        "user_id": user_id,
                        "role": "assistant",
                        "message": reply_text,
                        "emotion": emotion,
                    }
                )
                .execute
            )
        except Exception as error:
            print(f"Supabase conversation_history insert failed: {error}")

    return {"success": True, "text": reply_text, "emotion": emotion}


@app.get("/usage")
async def get_usage(request: Request):
    tokens_used = await get_daily_token_usage(get_user_id(request))
    return {"tokens_used": tokens_used, "token_limit": DAILY_TOKEN_LIMIT}


async def plan_steps(task: str) -> dict:
    fallback_steps = [{"action": "open_app", "value": task, "wait": 0.5}]

    if not groq_client:
        return {"steps": fallback_steps, "summary": ""}

    try:
        response = await asyncio.to_thread(
            groq_client.chat.completions.create,
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": task},
            ],
            response_format={"type": "json_object"},
        )
        raw_content = response.choices[0].message.content
        print("=" * 60)
        print(f"RAW GROQ RESPONSE for task {task!r}:")
        print(raw_content)
        print("=" * 60)

        result = json.loads(raw_content)
        steps = result.get("steps") or fallback_steps
        summary = result.get("summary", "")

        if len(steps) > MAX_STEPS:
            print(f"Groq returned {len(steps)} steps, truncating to MAX_STEPS={MAX_STEPS}")
            steps = steps[:MAX_STEPS]

        return {"steps": steps, "summary": summary}
    except Exception as error:
        print(f"Groq planning call failed: {error}")
        return {"steps": fallback_steps, "summary": ""}


@app.post("/plan")
async def handle_plan(body: dict):
    # Planning-only: this cloud backend has no local PyAutoGUI, so unlike
    # /task on the local backend, this endpoint returns the plan for the
    # caller to execute rather than executing it - see backend/main.py's
    # handle_task, which now sources its plan from here (see plan_steps
    # there) but still runs execute_steps() locally against this machine.
    task = body.get("task", "")
    if not task:
        return {"steps": [], "summary": ""}

    return await plan_steps(task)


@app.post("/chat")
async def handle_chat(request: Request, body: dict):
    message = body.get("message", "")
    if not message:
        return {"success": False, "reason": "empty message"}

    if any(word in message.lower() for word in DANGEROUS_WORDS):
        return {"success": False, "reason": "blocked"}

    user_id = get_user_id(request)

    history_start = time.perf_counter()
    history_messages = []
    if supabase_client:
        try:
            history_response = await asyncio.to_thread(
                supabase_client.table("conversation_history")
                .select("role, message")
                .eq("user_id", user_id)
                .order("created_at", desc=True)
                .limit(10)
                .execute
            )
            history_messages = [
                {"role": row["role"], "content": row["message"]}
                for row in reversed(history_response.data)
            ]
        except Exception as error:
            print(f"Supabase conversation_history fetch failed: {error}")
    history_duration = time.perf_counter() - history_start

    profile = await get_user_profile(user_id)
    system_prompt = CHAT_SYSTEM_PROMPT
    if profile:
        system_prompt += (
            f"\n\nThe user's name is {profile['name']}. Their goal for using you is: "
            f"\"{profile['primary_goal']}\". Use their name naturally and keep their "
            "goal in mind, without forcing either into every reply."
        )

    groq_start = time.perf_counter()
    tokens_used_this_call = 0
    if not groq_client:
        reply_text = "I can't chat right now, my brain (Groq) isn't connected."
        emotion = "neutral"
    else:
        groq_messages = [
            {"role": "system", "content": system_prompt},
            *history_messages,
            {"role": "user", "content": message},
        ]
        for attempt in range(2):
            try:
                response = await asyncio.to_thread(
                    groq_client.chat.completions.create,
                    model=GROQ_MODEL,
                    messages=groq_messages,
                    response_format={"type": "json_object"},
                )
                if response.usage:
                    tokens_used_this_call = response.usage.total_tokens
                result = json.loads(response.choices[0].message.content)
                reply_text = (result.get("text") or "").strip()
                emotion = result.get("emotion")
                if emotion not in VALID_CHAT_EMOTIONS:
                    emotion = "neutral"
                if not reply_text:
                    reply_text = "Sorry, I couldn't think of a reply just now."
                break
            except BadRequestError as error:
                is_parse_failure = (
                    isinstance(error.body, dict)
                    and error.body.get("error", {}).get("code") == "output_parse_failed"
                )
                if is_parse_failure and attempt == 0:
                    print(f"Groq chat call failed with output_parse_failed, retrying once: {error}")
                    continue
                print(f"Groq chat call failed: {error}")
                reply_text = "Sorry, I couldn't think of a reply just now."
                emotion = "neutral"
                break
            except Exception as error:
                print(f"Groq chat call failed: {error}")
                reply_text = "Sorry, I couldn't think of a reply just now."
                emotion = "neutral"
                break
    groq_duration = time.perf_counter() - groq_start

    tokens_used_today = await add_daily_token_usage(user_id, tokens_used_this_call)

    speak_start = time.perf_counter()
    audio_b64 = await speak_text(reply_text, emotion)
    speak_duration = time.perf_counter() - speak_start

    insert_start = time.perf_counter()
    if supabase_client:
        try:
            await asyncio.to_thread(
                supabase_client.table("conversation_history")
                .insert(
                    [
                        {"user_id": user_id, "role": "user", "message": message},
                        {
                            "user_id": user_id,
                            "role": "assistant",
                            "message": reply_text,
                            "emotion": emotion,
                        },
                    ]
                )
                .execute
            )
        except Exception as error:
            print(f"Supabase conversation_history insert failed: {error}")
    insert_duration = time.perf_counter() - insert_start

    print(
        f"CHAT TIMING: history_read={history_duration:.2f}s "
        f"groq_call={groq_duration:.2f}s "
        f"speak_text={speak_duration:.2f}s "
        f"history_insert={insert_duration:.2f}s "
        f"total={history_duration + groq_duration + speak_duration + insert_duration:.2f}s"
    )

    return {
        "success": True,
        "text": reply_text,
        "emotion": emotion,
        "audio": audio_b64,
        "tokens_used_today": tokens_used_today,
        "token_limit": DAILY_TOKEN_LIMIT,
    }
