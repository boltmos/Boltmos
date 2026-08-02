# BOLTMOS — Claude Code Context

## Project Overview
AI desktop companion. Lyra (VRoid 3D anime girl) lives as transparent
always-on-top Electron window. She moves across screen, speaks with
real emotions, controls PC visually, remembers user forever, delivers
interactive spoken ads. Tagline: "Your screen just got a soul."

## My PC
OS: Windows 10
Username: kartikey123
Project: C:\Users\kartikey123\Desktop\boltmos
Always run from project root.

## Tech Stack
Electron — transparent desktop window
Python FastAPI — backend on port 8000
WebSocket — port 8001 for real-time character movement
Groq API — llama-3.3-70b-versatile, multiple keys rotating
Kokoro TTS — local voice for FREE plan (no cost)
Fish Audio API — voice for PRO/ULTRA/ELITE plans
Web Speech API — voice input (listening)
Supabase — database and auth
SQLite — local speed cache
PyAutoGUI — mouse and keyboard execution
PIL ImageGrab — screenshots for agent
MediaPipe — camera face and emotion detection
Three.js + three-vrm — renders VRoid 3D character
difflib — spoken ad fuzzy matching (built-in Python)
tiktoken — token counting per message
Razorpay — India payments
Lemon Squeezy — global payments and marketplace payouts

## Environment Variables (.env)
GROQ_API_KEYS=key1,key2,key3,key4,key5,key6,key7,key8,key9,key10
FISH_AUDIO_API_KEY=
FISH_AUDIO_VOICE_ID_LYRA=
SUPABASE_URL=
SUPABASE_KEY=
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
LEMONSQUEEZY_API_KEY=
JWT_SECRET=generate_a_random_string_here
VOICE_FREE=kokoro
VOICE_PAID=fish_audio
BACKEND_PORT=8000
WEBSOCKET_PORT=8001

## File Structure
boltmos/
├── electron/
│   ├── main.js
│   └── preload.js
├── renderer/
│   └── index.html
├── backend/
│   ├── main.py
│   ├── groq_client.py
│   ├── voice.py
│   ├── memory.py
│   ├── agent.py
│   ├── ads.py
│   ├── auth.py
│   ├── tokens.py
│   └── marketplace.py
├── assets/
│   ├── lyra.vrm
│   └── tray.png
├── CLAUDE.md
├── .env
├── .gitignore
└── package.json

## Electron Window
frame: false
transparent: true
alwaysOnTop: true
resizable: true (min 280x400)
backgroundColor: #00000000
contextIsolation: true
nodeIntegration: false
Body: -webkit-app-region drag
Buttons and inputs: -webkit-app-region no-drag

## Character (Lyra)
VRoid 3D model (.vrm) rendered via Three.js + three-vrm
Eye tracking: eyes follow cursor at all times
Breathing: automatic via spring bones
Blinking: random every 4-8 seconds
Hair physics: automatic via VRM spring bones
All emotions driven by Groq JSON response

AI ALWAYS returns JSON, never plain text:
{
  "text": "response here",
  "emotion": "happy",
  "blush": 0.0,
  "animation": "excited",
  "action_type": "chat"
}

Emotions mapped to VRoid expressions:
happy, sad, angry, surprised, thinking, embarrassed,
bored, excited, disappointed, proud, confused, caring
Smooth 600ms transitions between all emotion states
Blush parameter: 0.0 to 1.0 (cheek redness)

Idle behaviors (random every 30 seconds of silence):
look_around, examine_hands, stretch, head_tilt
After 5 minutes idle: sleep animation with zzz bubble
Any keypress or click wakes her with startled then happy

## Personality
NO mode selection by user.
AI reads how user speaks and adapts automatically.
Mirrors user communication style within 2-3 messages.
Relationship deepens over time:
  Day 1-7: polite, learning patterns
  Day 8-30: casual, references past conversations
  Day 31-90: notices subtleties, teases gently
  Day 90+: deeply knows user, anticipates patterns

## Token Limits Per Plan (daily, resets midnight local time)
free:  10,000 tokens/day — 2 agent tasks/day
pro:   80,000 tokens/day — 15 agent tasks/day
ultra: 400,000 tokens/day — 50 agent tasks/day
elite: 1,000,000 tokens/day — 100 agent tasks/day

Count with tiktoken before every AI call.
When limit hit: Lyra reacts IN CHARACTER, never a popup.

## Groq Key Rotation
Load all keys from GROQ_API_KEYS env var (comma separated)
Rotate automatically on each request
On 429 rate limit error: switch to next key immediately
Prefer less recently used keys

## Voice System
Free plan users: Kokoro TTS (runs locally, zero cost)
Pro/Ultra/Elite users: Fish Audio API
Function: speak(text, emotion, user_plan)
Routes to correct provider based on plan automatically
Fish Audio emotion settings vary per emotion type
Kokoro supports English and Indian languages

## Agent System (Core Innovation)
User requests task → visual bridge activates:
1. PIL ImageGrab captures full screen
2. Compress to 800px width before sending
3. Groq vision returns {action, x, y, confidence}
4. If confidence below 0.85: confirm with user first
5. Send coordinates to Electron via WebSocket BEFORE clicking
6. Lyra walks to coordinates (5px per 16ms, smooth)
7. Tap animation fires with PyAutoGUI click simultaneously
8. New screenshot verifies success
9. Lyra reacts emotionally (excited if success, confused if fail)
10. Returns to home position bottom-right corner

Task memory: save successful paths to SQLite
Reuse saved paths on repeat tasks (instant, zero AI cost)
Max 10 action loops per task

BLOCKED FOREVER (never execute):
delete files, banking apps, system passwords,
system32 access, send messages without user reading first,
install or uninstall software, registry edits

## Spoken Ad System
Trigger: dynamic based on active campaigns with budget
Minimum gap: 5 messages between any ads
Free: dynamic frequency based on campaign pressure
Pro: max 3-5 per day total
Ultra: max 2 per day
Elite: ZERO ads ever
Never trigger during: agent task, sad conversation

Ad flow:
Lyra exits left → pulls branded vehicle from off-screen
→ climbs roof → brand-relevant prop appears
→ speaks tagline in personality-appropriate style
→ SpeechRecognition listens 6 seconds
→ difflib fuzzy match threshold 0.65
→ real-time word highlighting (green = matched)
→ success: brand effect 7 days + token reward
→ fail: one retry then graceful skip

## Plans and Pricing
free:  ₹0 / $0 — Kokoro voice, 10K tokens, 2 agent tasks
pro:   ₹799 / $9.99 — Fish Audio, 80K tokens, 15 agent tasks
ultra: ₹2,499 / $34.99 — Fish Audio premium, 400K tokens, 50 tasks, can SELL on marketplace
elite: ₹7,499 / $99 — Max everything, zero ads, 5 voice clones

Marketplace: all plans can BUY, only Ultra and Elite can SELL
Marketplace commission: 33% Boltmos, 67% creator
Minimum listing price: $1

## Cost Per User Per Month (real numbers)
free user: ₹4-5/month (Groq + Kokoro free + hosting share)
pro user:  ₹32/month (Groq + Fish Audio + hosting)
ultra user: ₹87/month
elite user: ₹251/month

## Database Tables (Supabase)
user_profile: id, email, name, plan, primary_goal,
  wake_time, sleep_time, study_start_time
user_daily_usage: user_id, date, tokens_used, agent_tasks_used
conversation_history: id, user_id, role, message, emotion, created_at
streaks: user_id, current_streak, longest_streak, last_active_date
campaigns: id, brand_name, tagline, audio_url, budget_remaining,
  daily_cap, bid_price, brand_effect, active
ad_completions: id, user_id, campaign_id, success, completed_at
task_log: id, user_id, task_desc, success, path_cache, created_at
marketplace_items: id, creator_id, type, name, price, downloads
purchases: id, user_id, item_id, amount, created_at

Enable Row Level Security on ALL tables.
Policy on every user table: auth.uid() = user_id

## Security
All API keys in .env only, never in code
Rate limit: 30 requests/minute/user in FastAPI middleware
Sanitize all input: detect prompt injection, max 1000 chars
JWT authentication required on all endpoints
RLS on all Supabase tables
Spend limits set on all API dashboards (Groq $10/mo, Fish $20/mo, Railway $30/mo)

## Languages
Free plan: English + all Indian languages (Hindi, Punjabi, Tamil,
  Telugu, Bengali, Gujarati, Marathi, Malayalam) via Kokoro
Paid plans: All languages via Fish Audio

## Running The App
Terminal 1 (backend): cd backend && python main.py
Terminal 2 (frontend): npm start
Build installer: npm run build

## Rules — Never Break These
Never hardcode any API key
Never use fixed screen coordinates for agent tasks
Never show raw error messages to users (always in-character)
Never let agent delete files without explicit confirmation
Never commit .env to git
Never skip token counting before AI calls
Never block UI thread during agent tasks (use async)
