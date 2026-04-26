# Market Maker — Multiplayer Trading Game Server

A real-time multiplayer server for the Market Maker trading card game. One player hosts and runs the game engine; guests join from anywhere and see the live market.

## Quick Start (Glitch.com, 2 minutes)

1. Go to [glitch.com](https://glitch.com) and sign in with any account
2. Click **"New Project"** → **"Import from GitHub"**  
   - Paste this repo URL, OR
   - Use the **"glitch-hello-node"** template as a starting point
3. In the Glitch editor:
   - Delete the existing `server.js` and replace it with ours
   - Delete `package.json` and use ours
   - Create a `public/` folder and upload `index.html` into it
4. Glitch automatically installs dependencies and starts the server
5. Click **"Preview"** → **"Open in new tab"** to get your live URL
6. Share that URL with friends — they can play from anywhere!

## How It Works

### Room Setup
- **Host** opens the game URL and clicks **Host Room** → gets a 5-letter code (e.g., `AB2XY`)
- **Friends** visit the same URL, click **Join Room**, and enter the code
- Game state syncs in real-time using Socket.io

### Gameplay
- **Host's browser** runs the full game engine (card deals, bot trades, settlement logic)
- **Guests** see the live market and can trade when the trade window opens
- All trades, prices, and results broadcast to guests instantly
- When host disconnects, the room closes and guests are notified

## Architecture

```
market-maker-server/
├── server.js         # Node.js + Express + Socket.io server
├── package.json      # npm dependencies
├── public/
│   └── index.html    # Full game client (with Socket.io integration)
└── README.md         # This file
```

### Key Features
- **No database** — rooms are ephemeral (stored in server memory)
- **Room codes** — 5-character alphanumeric, no confusing letters (no I, O, 1, 0)
- **Relay architecture** — server just forwards events, no game logic on server
- **Graceful fallback** — game works fully offline if Socket.io unavailable
- **Estimated 200ms latency** on Glitch.com (acceptable for trading games)

## Deploy on Railway (Persistent Hosting)

Railway keeps your app running 24/7 (no sleep limits like Glitch).

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app)
3. Click **"New Project"** → **"Deploy from GitHub repo"**
4. Railway auto-detects Node.js and deploys
5. Get your URL from the Railway dashboard

## Run Locally

```bash
npm install
npm start
# Opens http://localhost:3000
```

## Socket.io Events

### Host → Server
- **`create_room`** — host creates a room, gets a code back
- **`game_state`** — host broadcasts game state to all guests
- **`host_response`** — host responds to a specific guest's action

### Guest → Server
- **`join_room`** — guest joins with code and display name
- **`guest_action`** — guest sends a trade or action

### Server → Players
- **`room_created`** — code assigned to host
- **`room_joined`** — guest connected and added to room
- **`room_updated`** — list of guests changed
- **`game_state`** — broadcast from host to all guests
- **`guest_action`** — guest's action relayed to host
- **`host_response`** — host's response to guest
- **`host_disconnected`** — host left, room deleted
- **`guest_left`** — a guest disconnected

## Game Modes

- **Card Game** — Trade on the sum of 6 hidden cards. Asymmetric info from your hand. 3 rounds, cards revealed gradually.
- **Estimathon** — Trade on real-world quantities (e.g., hotel rooms in Las Vegas). Hints unlock each round.

## Display Options

Players can configure:
- **Auto-calculated Fair Value** — shows estimated value based on cards/hints
- **Deck Remaining Count** — track card distribution
- **Manual FV Input** — override auto-calc with your own estimate
- **Theme** — Dark, Light, or System

## AI Question Generation

For Estimathon mode, paste an OpenAI or Anthropic API key to generate fresh questions each game. Otherwise, 50 built-in questions are used.

---

**Built for Glitch.com's free tier.** Enjoy trading!
