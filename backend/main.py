import asyncio
import base64
import io
import json
import logging
import os
import subprocess
import sys
import time
import urllib.request
import uuid
from datetime import date
from logging.handlers import RotatingFileHandler
from pathlib import Path

import pyautogui
import uvicorn
import websockets
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from groq import BadRequestError, Groq
from PIL import ImageGrab
from supabase import create_client, Client


async def take_screenshot_base64() -> str:
    screenshot = ImageGrab.grab()
    buffer = io.BytesIO()
    screenshot.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode()


async def find_and_click(target: str) -> bool:
    if not groq_client:
        return False

    img = await take_screenshot_base64()

    try:
        response = await asyncio.to_thread(
            groq_client.chat.completions.create,
            model="qwen/qwen3.6-27b",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{img}"},
                        },
                        {
                            "type": "text",
                            "text": (
                                f"Find '{target}' on screen. Return JSON only: "
                                '{"found": true/false, "x": number, "y": number}'
                            ),
                        },
                    ],
                }
            ],
            response_format={"type": "json_object"},
        )
        result = json.loads(response.choices[0].message.content)
    except Exception as error:
        print(f"find_and_click failed: {error}")
        return False

    if result.get("found"):
        pyautogui.click(result["x"], result["y"])
        await asyncio.sleep(0.5)
        return True

    return False


async def dismiss_chrome_profile_if_present() -> bool:
    """Chrome sometimes opens to a 'Who's using Chrome?' profile-selection
    screen instead of a usable browser window, which leaves every step after
    open_app typing/clicking into a screen that isn't ready for them. Checks
    for that screen via vision and, if present, clicks the first available
    profile to dismiss it."""
    if not groq_client:
        return False

    img = await take_screenshot_base64()

    try:
        response = await asyncio.to_thread(
            groq_client.chat.completions.create,
            model="qwen/qwen3.6-27b",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{img}"},
                        },
                        {
                            "type": "text",
                            "text": (
                                "Is this a Chrome 'Who's using Chrome?' profile selection "
                                "screen, as opposed to a normal loaded browser window? If "
                                "yes, return the screen pixel coordinates of the first "
                                "available profile icon to click through it. Return JSON "
                                'only: {"present": true/false, "x": number, "y": number}'
                            ),
                        },
                    ],
                }
            ],
            response_format={"type": "json_object"},
        )
        result = json.loads(response.choices[0].message.content)
    except Exception as error:
        print(f"dismiss_chrome_profile_if_present failed: {error}")
        return False

    if not result.get("present"):
        return False

    pyautogui.click(result["x"], result["y"])
    await asyncio.sleep(1.0)
    return True


EXTRACTED_RESULTS_PLACEHOLDER = "{{extracted_results}}"


async def extract_search_results_text() -> str:
    """Read whatever search results are currently on screen via the vision
    model and return their text content as a plain string (not JSON) - the
    caller (execute_steps) stashes this so a later 'type' step can use it."""
    if not groq_client:
        return ""

    img = await take_screenshot_base64()

    try:
        response = await asyncio.to_thread(
            groq_client.chat.completions.create,
            model="qwen/qwen3.6-27b",
            messages=[
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image_url",
                            "image_url": {"url": f"data:image/png;base64,{img}"},
                        },
                        {
                            "type": "text",
                            "text": (
                                "Read the visible search results on this screen and extract "
                                "their text content (titles, snippets, URLs) as plain text, "
                                "one result per line. Return only the extracted text, no "
                                "commentary or formatting."
                            ),
                        },
                    ],
                }
            ],
        )
        return response.choices[0].message.content.strip()
    except Exception as error:
        print(f"extract_search_results_text failed: {error}")
        return ""


# __file__-relative resolution only works running from source - a frozen
# PyInstaller exe's __file__ doesn't point at a real path next to the
# installed exe, so .env would silently fail to load there. When frozen,
# look next to the exe itself instead.
if getattr(sys, "frozen", False):
    ENV_PATH = Path(sys.executable).resolve().parent / ".env"
else:
    ENV_PATH = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(ENV_PATH)

LOG_DIR = Path(__file__).resolve().parent / "logs"
LOG_DIR.mkdir(exist_ok=True)

task_logger = logging.getLogger("boltmos.tasks")
task_logger.setLevel(logging.INFO)
_log_handler = RotatingFileHandler(
    LOG_DIR / "backend.log", maxBytes=1_000_000, backupCount=3
)
_log_handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
task_logger.addHandler(_log_handler)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health_check():
    """Liveness check for the Electron app (or any host) to poll -
    deliberately just confirms the FastAPI process itself is up and
    responding, not that Groq/Supabase are reachable, so a transient
    third-party outage doesn't get the whole service marked unhealthy."""
    return {"status": "ok"}


KNOWN_APPS = {
    "chrome": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "google chrome": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "edge": r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "microsoft edge": r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    "notepad": r"C:\Windows\System32\notepad.exe",
    "calculator": r"C:\Windows\System32\calc.exe",
    "spotify": os.path.expanduser(r"~\AppData\Roaming\Spotify\Spotify.exe"),
    "file explorer": r"C:\Windows\explorer.exe",
}


def match_fast_path_app(task: str) -> str | None:
    """Recognizes a bare 'open <app>' request with nothing else in it, e.g.
    'open notepad' or 'open chrome' - anything more (extra words, multiple
    apps, searches, typing) means the candidate after stripping 'open ' won't
    exactly equal a KNOWN_APPS key, so it falls through to the full Groq
    planner/vision pipeline instead."""
    normalized = task.strip().lower()
    if not normalized.startswith("open "):
        return None
    candidate = normalized[len("open "):].strip()
    return candidate if candidate in KNOWN_APPS else None


GROQ_MODEL = "openai/gpt-oss-120b"

MAX_STEPS = 5

# Task planning itself now lives on the cloud backend (see backend/cloud/main.py's
# /plan, which holds the actual system prompt) - this local backend no longer
# needs its own copy of that prompt or a local Groq call to get a plan. Step
# EXECUTION (PyAutoGUI) stays entirely local below, since only this machine
# has the real mouse/keyboard/screen to drive.
CLOUD_PLAN_URL = "https://boltmos.up.railway.app/plan"

groq_api_key = next(
    (key.strip() for key in os.getenv("GROQ_API_KEYS", "").split(",") if key.strip()),
    None,
)
groq_client = Groq(api_key=groq_api_key) if groq_api_key else None

if not groq_client:
    print("Warning: GROQ_API_KEYS is missing or empty in .env. Tasks will run as a single step.")

supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_KEY")
supabase_client: Client | None = (
    create_client(supabase_url, supabase_key) if supabase_url and supabase_key else None
)

if not supabase_client:
    print("Warning: SUPABASE_URL or SUPABASE_KEY is missing in .env. Persistent memory is disabled.")
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

async def plan_steps(task: str) -> dict:
    fallback_steps = [{"action": "open_app", "value": task, "wait": 0.5}]

    def call_cloud_plan() -> dict:
        request = urllib.request.Request(
            CLOUD_PLAN_URL,
            data=json.dumps({"task": task}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read())

    try:
        result = await asyncio.to_thread(call_cloud_plan)
        steps = result.get("steps") or fallback_steps
        summary = result.get("summary", "")

        if len(steps) > MAX_STEPS:
            print(f"Cloud /plan returned {len(steps)} steps, truncating to MAX_STEPS={MAX_STEPS}")
            steps = steps[:MAX_STEPS]

        task_logger.info(
            f"PLAN for task {task!r}: {json.dumps({'steps': steps, 'summary': summary})}"
        )
        return {"steps": steps, "summary": summary}
    except Exception as error:
        print(f"Cloud /plan call failed: {error}")
        task_logger.error(f"PLAN FAILED for task {task!r}: {error}")
        return {"steps": fallback_steps, "summary": ""}


def is_step_safe(step: dict) -> bool:
    """Lightweight safety net, not a relevance filter: blocks a step only if
    it matches an explicitly dangerous pattern (destructive actions,
    credentials, or system file paths). Otherwise trusts the planning
    model's step selection - it already has full context of the user's
    intent, unlike a naive keyword-overlap check against the raw task text."""
    step_text = f"{step.get('action', '')} {step.get('value', '')}".lower()
    dangerous_patterns = DANGEROUS_WORDS + ["system32", "\\windows\\", "regedit", "registry"]
    return not any(pattern in step_text for pattern in dangerous_patterns)


FOCUS_SENSITIVE_ACTIONS = {"navigate", "search_google", "search_youtube"}
# A cold app launch (subprocess.Popen -> window created -> window takes OS
# focus) routinely takes longer than open_app's own post-launch sleep, so a
# focus-sensitive step immediately after open_app risks sending its keystrokes
# to whatever window still has focus instead of the just-opened one. Extra
# settle time only applies to that one specific transition, on top of
# whatever "wait" the plan already assigned that step.
POST_OPEN_APP_FOCUS_DELAY_S = 1.0


async def execute_steps(steps: list, websocket_send) -> bool:
    """Runs every step and returns whether they all succeeded - callers (just
    handle_task below) use this to decide between the task_done/task_failed
    speech so a task that silently failed partway through no longer reports
    "all done" anyway."""
    last_extracted_text = ""
    previous_action = None
    all_succeeded = True

    for index, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            print(f"STEP {index}/{len(steps)}: {step!r} action=None value=None validation=FAILED (not a dict)")
            task_logger.error(f"STEP {index}/{len(steps)} step={step!r} -> FAILED: not a dict")
            all_succeeded = False
            continue

        action = step.get("action")
        value = step.get("value", "")
        is_safe = is_step_safe(step)

        print(
            f"STEP {index}/{len(steps)}: action={action!r} value={value!r} "
            f"safety_check={'PASSED' if is_safe else 'BLOCKED'}"
        )

        if not is_safe:
            print(f"BLOCKED step {index} as dangerous: {step}")
            task_logger.warning(f"STEP {index}/{len(steps)} action={action!r} value={value!r} -> BLOCKED (unsafe)")
            all_succeeded = False
            continue

        message = step.get("message", "")

        try:
            wait_before = float(step.get("wait", 1.0))
        except (TypeError, ValueError):
            wait_before = 1.0

        if previous_action == "open_app" and action in FOCUS_SENSITIVE_ACTIONS:
            wait_before += POST_OPEN_APP_FOCUS_DELAY_S

        # Always wait specified time before each step
        await asyncio.sleep(wait_before)

        if message:
            await websocket_send({"action": "speak", "text": message})
            await asyncio.sleep(0.2)

        step_outcome = "SUCCESS"

        try:
            if action == "open_app":
                app_lower = value.lower().strip()
                opened = False
                for app_name, app_path in KNOWN_APPS.items():
                    if app_name in app_lower:
                        if os.path.exists(app_path):
                            subprocess.Popen(app_path)
                            opened = True
                            # Wait longer for app to fully open and take OS
                            # focus - was 0.5s, which a cold launch can easily
                            # outlast, leaving the next step's keystrokes to
                            # land on whatever window still had focus.
                            await asyncio.sleep(1.5)
                            break
                if not opened:
                    pyautogui.hotkey("win", "s")
                    await asyncio.sleep(1.0)
                    pyautogui.write(value, interval=0.05)
                    await asyncio.sleep(0.8)
                    pyautogui.press("enter")
                    await asyncio.sleep(1.8)

                if "chrome" in app_lower:
                    await dismiss_chrome_profile_if_present()

            elif action == "new_tab":
                pyautogui.hotkey("ctrl", "t")
                await asyncio.sleep(1.0)

            elif action == "navigate":
                # Click address bar first then type URL
                pyautogui.hotkey("ctrl", "l")
                await asyncio.sleep(0.1)
                pyautogui.hotkey("ctrl", "a")
                await asyncio.sleep(0.1)
                pyautogui.write(value, interval=0.04)
                await asyncio.sleep(0.1)
                pyautogui.press("enter")
                # Wait for page to load
                await asyncio.sleep(0.5)

            elif action == "search_youtube":
                # Press / which focuses YouTube's search bar
                pyautogui.press("/")
                await asyncio.sleep(0.5)
                pyautogui.write(value, interval=0.04)
                await asyncio.sleep(0.3)
                pyautogui.press("enter")
                await asyncio.sleep(0.4)

            elif action == "search_google":
                pyautogui.hotkey("ctrl", "l")
                await asyncio.sleep(0.3)
                pyautogui.write(f"https://www.google.com/search?q={value}", interval=0.03)
                pyautogui.press("enter")
                await asyncio.sleep(0.3)

            elif action == "type":
                text_to_type = last_extracted_text if value == EXTRACTED_RESULTS_PLACEHOLDER else value
                pyautogui.write(text_to_type, interval=0.05)
                await asyncio.sleep(0.5)

            elif action == "press":
                pyautogui.press(value)
                await asyncio.sleep(0.3)

            elif action == "hotkey":
                keys = value.split("+")
                pyautogui.hotkey(*keys)
                await asyncio.sleep(0.5)

            elif action == "wait":
                try:
                    await asyncio.sleep(float(value))
                except (TypeError, ValueError):
                    pass

            elif action == "click_target":
                found = await find_and_click(value)
                if not found:
                    await websocket_send({"action": "speak", "text": f"I couldn't find {value} on screen"})
                    await asyncio.sleep(1.0)
                    step_outcome = "FAILED: target not found on screen"

            elif action == "extract_search_results":
                last_extracted_text = await extract_search_results_text()
                if not last_extracted_text:
                    await websocket_send({"action": "speak", "text": "I couldn't read the search results"})
                    await asyncio.sleep(0.6)
                    step_outcome = "FAILED: could not read search results"

            elif action == "dismiss_chrome_profile_if_present":
                await dismiss_chrome_profile_if_present()

            else:
                step_outcome = "FAILED: unknown action"
        except Exception as error:
            step_outcome = f"FAILED: {error}"

        task_logger.info(
            f"STEP {index}/{len(steps)} action={action!r} value={value!r} -> {step_outcome}"
        )
        if step_outcome.startswith("FAILED"):
            all_succeeded = False
        previous_action = action

    return all_succeeded


connected_clients = set()


async def ws_handler(websocket):
    connected_clients.add(websocket)
    try:
        async for _ in websocket:
            pass
    finally:
        connected_clients.discard(websocket)


async def run_websocket_server():
    async with websockets.serve(ws_handler, "localhost", 8001):
        await asyncio.Future()


async def send_to_lyra_raw(message: dict):
    payload = json.dumps(message)
    for client in list(connected_clients):
        try:
            await client.send(payload)
        except websockets.exceptions.ConnectionClosed:
            connected_clients.discard(client)


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


task_lock = asyncio.Lock()


@app.post("/task")
async def handle_task(body: dict):
    # PyAutoGUI drives the one real mouse/keyboard on the machine, so two
    # tasks can never safely run at once - reject immediately rather than
    # queuing, since a queued task would otherwise fire unattended
    # automation later with no way for the user to know it's about to start.
    if task_lock.locked():
        await send_to_lyra_raw({"action": "speak", "text": "hold on, I'm still doing the last thing - one sec!"})
        return {"success": False, "reason": "busy", "message": "A task is already in progress"}

    async with task_lock:
        task = body.get("task", "")
        task_logger.info(f"TASK RECEIVED: {task!r}")

        if any(word in task.lower() for word in DANGEROUS_WORDS):
            await send_to_lyra_raw({"action": "speak", "text": "I cannot do that safely"})
            return {"success": False, "reason": "blocked"}

        fast_path_app = match_fast_path_app(task)
        if fast_path_app:
            app_path = KNOWN_APPS[fast_path_app]
            if os.path.exists(app_path):
                subprocess.Popen(app_path)
                await asyncio.sleep(0.5)
                await send_to_lyra_raw({"action": "task_done", "text": f"opened {fast_path_app}! ✨"})
                return {"success": True, "steps": 1}
            # Path doesn't actually exist on this machine - fall through to
            # the full pipeline below, which has its own not-found handling
            # (win+s search) in execute_steps.

        await send_to_lyra_raw({"action": "thinking", "text": "let me figure that out..."})

        plan = await plan_steps(task)
        steps = plan["steps"][:MAX_STEPS]
        summary = plan["summary"]

        if summary:
            await send_to_lyra_raw({"action": "speak", "text": summary})
            await asyncio.sleep(1.5)

        task_succeeded = await execute_steps(steps, send_to_lyra_raw)

        if task_succeeded:
            await send_to_lyra_raw({"action": "task_done", "text": "all done! ✨"})
        else:
            await send_to_lyra_raw({
                "action": "task_failed",
                "text": "I couldn't quite get that done, want me to try again?",
            })

        return {"success": task_succeeded, "steps": len(steps)}


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


@app.get("/usage")
async def get_usage(request: Request):
    tokens_used = await get_daily_token_usage(get_user_id(request))
    return {"tokens_used": tokens_used, "token_limit": DAILY_TOKEN_LIMIT}


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

    await send_to_lyra_raw(
        {"action": "speak", "text": reply_text, "emotion": emotion}
    )

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


@app.post("/chat")
async def handle_chat(request: Request, body: dict):
    message = body.get("message", "")
    if not message:
        return {"success": False, "reason": "empty message"}

    if any(word in message.lower() for word in DANGEROUS_WORDS):
        await send_to_lyra_raw({"action": "speak", "text": "I cannot do that safely"})
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

    await send_to_lyra_raw(
        {"action": "speak", "text": reply_text, "emotion": emotion}
    )

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

    task_logger.info(
        f"CHAT TIMING: history_read={history_duration:.2f}s "
        f"groq_call={groq_duration:.2f}s "
        f"history_insert={insert_duration:.2f}s "
        f"total={history_duration + groq_duration + insert_duration:.2f}s"
    )

    return {
        "success": True,
        "text": reply_text,
        "emotion": emotion,
        "tokens_used_today": tokens_used_today,
        "token_limit": DAILY_TOKEN_LIMIT,
    }


async def main():
    # Railway assigns its own port at runtime via $PORT and routes external
    # traffic to whatever that is - a hardcoded 8000 would make the deployed
    # service unreachable. Falls back to 8000 for local dev, where nothing
    # sets PORT.
    port = int(os.getenv("PORT", 8000))
    config = uvicorn.Config(app, host="0.0.0.0", port=port, log_level="info")
    server = uvicorn.Server(config)

    await asyncio.gather(
        server.serve(),
        run_websocket_server(),
    )


if __name__ == "__main__":
    asyncio.run(main())

