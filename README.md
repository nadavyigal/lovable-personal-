## Monorepo (engine, ui, workspace)

### Prerequisites
- Node.js 20+

### Install
```bash
npm install
```

### Environment
Copy `engine/.env.example` to `engine/.env` and set your key.

```bash
cp engine/.env.example engine/.env  # on Windows, create the file manually
```

### Run (in separate terminals)
```bash
npm run dev:engine     # starts API on http://localhost:8787
npm run dev:ui         # starts UI on http://localhost:5174
npm run dev:workspace  # starts the workspace app on http://localhost:5173 (existing)
```

Notes:
- UI embeds the workspace at `http://localhost:5173` in an iframe.
- Engine expects `OPENAI_API_KEY` and `OPENAI_MODEL` (default `gpt-4.1`).

