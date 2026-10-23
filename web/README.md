# web: Echo Show 10 simulator

React 19 + Vite + TypeScript + Tailwind v4 + lucide-react. It runs on http://localhost:5173 and talks
to the server's `/agent` (the Alexa+ brain, an MCP client of `/mcp`) and `/api` (the idle screen's
"Coming up" widget). See "Echo Show simulator" in the root README for the demo script.

```
src/
├── App.tsx              state machine: idle → listening → thinking → speaking; push-to-talk, member switcher
├── voice.ts             Web Speech recognition (en-US), speechSynthesis, the listening earcon
├── api.ts               /agent/chat, /agent/action, /api/obligations/due, /api/gmail/status (X-Household-Member header)
├── format.ts            dates in the household time zone, money, labels
├── members.ts           Mom (Priya), Dad (Dan), Riya
└── components/
    ├── Device.tsx       bezel, fabric base, 1280×800 screen scaled to fit
    ├── IdleScreen.tsx   clock, date, rotating "Coming up"
    ├── LightBar.tsx     the Alexa light bar
    ├── Cards.tsx        due list, item (with action history), quoted source, ingest result, date confirmation,
    │                    choices, draft reply (editable, Send/Cancel), sent, renewal QR code
    ├── CameraSheet.tsx  getUserMedia snap or file upload, downscaled to JPEG
    └── Settings.tsx     the gear menu: Connect Gmail, its status, and "Reconnect to enable replies"
```

`npm run dev` from the repo root starts this and the server together. Settings (`web/.env`):
`VITE_API_URL` (default `http://127.0.0.1:3000`), `VITE_API_KEY` (only if the server sets `API_KEY`).
