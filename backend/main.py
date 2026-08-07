import asyncio
import base64
import io
import json
import os
import re
import subprocess
from pathlib import Path

import numpy as np
import pyautogui
import soundfile as sf
import uvicorn
import websockets
from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq
from kokoro import KPipeline
from PIL import ImageGrab


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
            model="meta-llama/llama-4-scout-17b-16e-instruct",
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


load_dotenv(Path(__file__).resolve().parent.parent / ".env")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

KNOWN_APPS = {
    "chrome": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "google chrome": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    "notepad": r"C:\Windows\System32\notepad.exe",
    "calculator": r"C:\Windows\System32\calc.exe",
    "spotify": os.path.expanduser(r"~\AppData\Roaming\Spotify\Spotify.exe"),
    "file explorer": r"C:\Windows\explorer.exe",
}


GROQ_MODEL = "llama-3.3-70b-versatile"

MAX_STEPS = 4

SYSTEM_PROMPT = """You convert user tasks into Windows PC steps.
You are controlling a real Windows PC.
Be very specific about timing - apps need time to load.

STRICT RULE - READ FIRST:
Only generate steps that are explicitly and literally requested in the user
task, never assume additional steps, never add bonus actions, never open
unrelated apps or websites. If the user says open chrome, the only step is
opening chrome.
Maximum of 4 steps total, no exceptions.

Available actions:
- open_app: opens application. value = app name.
  ALWAYS add wait: 3.0 for this step
- navigate: types URL in browser address bar then presses enter.
  value = full url like "youtube.com".
  ALWAYS add wait: 1.0 before and expect 3 seconds to load
- search_youtube: searches on YouTube using / shortcut.
  value = search query. Only use when YouTube is already open.
  ALWAYS add wait: 3.0 before this step
- search_google: searches Google directly.
  value = search query
- new_tab: opens new browser tab
- click_target: finds and clicks something visible on screen.
  value = description of element like "YouTube search bar" or "profile icon".
  Use this instead of blind typing when possible.
- type: types text. value = text
- press: presses key. value = key name
- hotkey: keyboard shortcut. value = "ctrl+t" etc
- wait: waits. value = seconds as string

CRITICAL RULES:
1. open_app must always come first if app is not open
2. navigate must wait for app to open first
3. search_youtube only works after YouTube is fully loaded
4. Always add enough wait time between steps
5. For "open chrome and search youtube for X":
   Step 1: open_app chrome (wait: 0.5)
   Step 2: navigate to youtube.com (wait: 3.0)
   Step 3: search_youtube for X (wait: 3.5)

Return JSON:
{
  "steps": [
    {"action": "open_app", "value": "chrome",
     "wait": 0.5, "message": "opening chrome!"},
    {"action": "navigate", "value": "youtube.com",
     "wait": 3.0, "message": "going to youtube!"},
    {"action": "search_youtube", "value": "AI tutorials",
     "wait": 3.5, "message": "searching for that!"}
  ],
  "summary": "I'll open Chrome, go to YouTube and search for AI tutorials"
}"""

groq_api_key = next(
    (key.strip() for key in os.getenv("GROQ_API_KEYS", "").split(",") if key.strip()),
    None,
)
groq_client = Groq(api_key=groq_api_key) if groq_api_key else None

if not groq_client:
    print("Warning: GROQ_API_KEYS is missing or empty in .env. Tasks will run as a single step.")

KOKORO_VOICE = "af_heart"
KOKORO_SAMPLE_RATE = 24000

try:
    kokoro_pipeline = KPipeline(lang_code="a")
except Exception as error:
    kokoro_pipeline = None
    print(f"Warning: Kokoro TTS failed to load, voice output disabled: {error}")


async def speak_text(text: str) -> None:
    """Generate speech audio for text with Kokoro and push it to the frontend
    over the websocket as base64-encoded WAV, action speak_audio."""
    if not kokoro_pipeline or not text:
        return

    def generate_audio_b64() -> str:
        chunks = [audio for _, _, audio in kokoro_pipeline(text, voice=KOKORO_VOICE)]
        full_audio = np.concatenate(chunks) if len(chunks) > 1 else chunks[0]
        buffer = io.BytesIO()
        sf.write(buffer, full_audio, KOKORO_SAMPLE_RATE, format="WAV")
        buffer.seek(0)
        return base64.b64encode(buffer.read()).decode()

    try:
        audio_b64 = await asyncio.to_thread(generate_audio_b64)
    except Exception as error:
        print(f"speak_text failed: {error}")
        return

    await send_to_lyra_raw({"action": "speak_audio", "audio": audio_b64})


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


def step_matches_task(step: dict, task: str) -> bool:
    """Simple keyword match: the step's action/value must share at least one
    word with the user's task text, or it's considered unrelated and skipped."""
    task_words = [word for word in re.findall(r"[a-z0-9]+", task.lower()) if len(word) >= 2]
    if not task_words:
        return True

    step_text = f"{step.get('action', '')} {step.get('value', '')}".lower()

    return any(word in step_text for word in task_words)


async def execute_steps(steps: list, websocket_send, task: str):
    for index, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            print(f"STEP {index}/{len(steps)}: {step!r} action=None value=None validation=FAILED (not a dict)")
            continue

        action = step.get("action")
        value = step.get("value", "")
        passed_validation = step_matches_task(step, task)

        print(
            f"STEP {index}/{len(steps)}: action={action!r} value={value!r} "
            f"validation={'PASSED' if passed_validation else 'FAILED'}"
        )

        if not passed_validation:
            print(f"SKIPPED step {index} as unrelated to user task {task!r}: {step}")
            continue

        message = step.get("message", "")

        try:
            wait_before = float(step.get("wait", 1.0))
        except (TypeError, ValueError):
            wait_before = 1.0

        # Always wait specified time before each step
        await asyncio.sleep(wait_before)

        if message:
            await websocket_send({"action": "speak", "text": message})
            await asyncio.sleep(0.5)

        if action == "open_app":
            app_lower = value.lower().strip()
            opened = False
            for app_name, app_path in KNOWN_APPS.items():
                if app_name in app_lower:
                    if os.path.exists(app_path):
                        subprocess.Popen(app_path)
                        opened = True
                        # Wait longer for app to fully open
                        await asyncio.sleep(3.0)
                        break
            if not opened:
                pyautogui.hotkey("win", "s")
                await asyncio.sleep(1.0)
                pyautogui.write(value, interval=0.05)
                await asyncio.sleep(0.8)
                pyautogui.press("enter")
                await asyncio.sleep(3.0)

        elif action == "new_tab":
            pyautogui.hotkey("ctrl", "t")
            await asyncio.sleep(1.0)

        elif action == "navigate":
            # Click address bar first then type URL
            pyautogui.hotkey("ctrl", "l")
            await asyncio.sleep(0.5)
            pyautogui.hotkey("ctrl", "a")
            await asyncio.sleep(0.2)
            pyautogui.write(value, interval=0.04)
            await asyncio.sleep(0.3)
            pyautogui.press("enter")
            # Wait for page to load
            await asyncio.sleep(3.5)

        elif action == "search_youtube":
            # Press / which focuses YouTube's search bar
            pyautogui.press("/")
            await asyncio.sleep(0.5)
            pyautogui.write(value, interval=0.04)
            await asyncio.sleep(0.3)
            pyautogui.press("enter")
            await asyncio.sleep(2.0)

        elif action == "search_google":
            pyautogui.hotkey("ctrl", "l")
            await asyncio.sleep(0.3)
            pyautogui.write(f"https://www.google.com/search?q={value}", interval=0.03)
            pyautogui.press("enter")
            await asyncio.sleep(2.0)

        elif action == "type":
            pyautogui.write(value, interval=0.05)
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


async def send_to_lyra(message: dict):
    """Broadcast a message to the frontend, and whenever it's a speak or
    task_done message carrying text, also generate and push voice audio."""
    await send_to_lyra_raw(message)

    if message.get("action") in ("speak", "task_done") and message.get("text"):
        await speak_text(message["text"])


DANGEROUS_WORDS = ["password", "bank", "payment", "credit card", "delete", "format"]

CHAT_SYSTEM_PROMPT = """You are Lyra, a friendly AI companion. Respond naturally
and conversationally to whatever the user says, including general questions.
Keep responses under 3 sentences unless asked for detail."""


@app.post("/task")
async def handle_task(body: dict):
    task = body.get("task", "")

    if any(word in task.lower() for word in DANGEROUS_WORDS):
        await send_to_lyra({"action": "speak", "text": "I cannot do that safely"})
        return {"success": False, "reason": "blocked"}

    await send_to_lyra({"action": "thinking", "text": "let me figure that out..."})

    plan = await plan_steps(task)
    steps = plan["steps"][:MAX_STEPS]
    summary = plan["summary"]

    if summary:
        await send_to_lyra({"action": "speak", "text": summary})
        await asyncio.sleep(1.5)

    await execute_steps(steps, send_to_lyra, task)

    await send_to_lyra({"action": "task_done", "text": "all done! ✨"})

    return {"success": True, "steps": len(steps)}


@app.post("/chat")
async def handle_chat(body: dict):
    message = body.get("message", "")
    if not message:
        return {"success": False, "reason": "empty message"}

    if any(word in message.lower() for word in DANGEROUS_WORDS):
        await send_to_lyra({"action": "speak", "text": "I cannot do that safely"})
        return {"success": False, "reason": "blocked"}

    if not groq_client:
        reply_text = "I can't chat right now, my brain (Groq) isn't connected."
    else:
        try:
            response = await asyncio.to_thread(
                groq_client.chat.completions.create,
                model=GROQ_MODEL,
                messages=[
                    {"role": "system", "content": CHAT_SYSTEM_PROMPT},
                    {"role": "user", "content": message},
                ],
            )
            reply_text = response.choices[0].message.content.strip()
        except Exception as error:
            print(f"Groq chat call failed: {error}")
            reply_text = "Sorry, I couldn't think of a reply just now."

    await send_to_lyra({"action": "speak", "text": reply_text})

    return {"success": True, "text": reply_text}


async def main():
    config = uvicorn.Config(app, host="0.0.0.0", port=8000, log_level="info")
    server = uvicorn.Server(config)

    await asyncio.gather(
        server.serve(),
        run_websocket_server(),
    )


if __name__ == "__main__":
    asyncio.run(main())

