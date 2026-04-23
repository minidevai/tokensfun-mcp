# tokensfun mcp

Standalone stdio MCP server for deploying **tokens.fun tokens for existing apps** directly from Claude Code.

The primary tool is `tokensfun_tokenize_app` — one call that inspects the project, infers all metadata, and deploys. No back-and-forth needed unless `appUrl` truly can't be found.

The app must already have a live public URL. This server does not build apps.

## Included MCP Tools

Both `tokensfun_*` and `minidev_*` tool name prefixes are supported. `tokensfun_*` is preferred.

### Primary tool

- `*_tokenize_app` — **single-shot deploy**: inspects CWD, infers metadata, uploads image, deploys token. Start here.

### Supporting tools

- `*_inspect_existing_app` — read project metadata without deploying
- `*_prepare_existing_app_token` — resolve and normalize payload without deploying
- `*_validate_existing_app_token` — validate payload without uploading or deploying
- `*_upload_token_image` — upload a local image to IPFS
- `*_deploy_existing_app_token` — deploy with explicit payload
- `*_validate_vault` — validate vesting configuration
- `*_check_credits` — remaining MiniDev credits
- `*_get_config_status` — which config fields are set and where
- `*_show_creator_identity` — configured wallet and email
- `*_validate_api_key_connection` — test API key is valid
- `*_list_projects` — list MiniDev projects for the account
- `*_health_check` — full readiness check (config, auth, credits, upload endpoint)
- `*_explain_missing_setup` — explain what's missing for a given action

## Configuration

Preferred configuration is via environment variables in your Claude Code MCP entry:

```bash
MINIDEV_API_KEY=mk_your_key_here
MINIDEV_API_URL=https://app.minidev.fun
TOKENS_FUN_URL=https://tokens.fun
MINIDEV_CREATOR_WALLET=0xYourWalletAddress
MINIDEV_CREATOR_EMAIL=you@example.com
```

Fallback config locations supported by the server:

- `minidev/config.json` relative to the working directory
- `~/.clawdbot/skills/minidev/config.json`

Compatible JSON shape:

```json
{
  "apiKey": "mk_your_key_here",
  "apiUrl": "https://app.minidev.fun",
  "tokensFunUrl": "https://tokens.fun",
  "creatorWallet": "0xYourWalletAddress",
  "creatorEmail": "you@example.com"
}
```

If you prefer a local interactive wizard, run:

```bash
npx -y tokensfun-mcp --setup
```

The wizard stores these 3 main values in `~/.tokensfun-mcp/config.json`:

- `MINIDEV_API_KEY`
- `MINIDEV_CREATOR_WALLET`
- `MINIDEV_CREATOR_EMAIL`

## Claude Code MCP Example

Point Claude Code at the absolute path to `server.js`:

```json
{
  "mcpServers": {
    "tokensfun": {
      "command": "node",
      "args": [
        "/absolute/path/to/minidev-skills/claude-code-mcp/server.js"
      ],
      "env": {
        "MINIDEV_API_KEY": "mk_your_key_here",
        "MINIDEV_API_URL": "https://app.minidev.fun",
        "TOKENS_FUN_URL": "https://tokens.fun",
        "MINIDEV_CREATOR_WALLET": "0xYourWalletAddress",
        "MINIDEV_CREATOR_EMAIL": "you@example.com"
      }
    }
  }
}
```

## Local Commands

Run from the `claude-code-mcp/` directory:

```bash
npm test
npm run setup
npm run tools
npm start
```

`npm run tools` prints the exact tool metadata exposed by `tokensfun mcp`.
`npm start` runs the stdio MCP server and waits for a client connection.
It is not hanging when it stays open there; that is the normal Claude Code / MCP server behavior.

## Recommended Agent Flow

1. Call `tokensfun_tokenize_app` — no args needed for a basic deploy from CWD.
2. If it returns `missingRequiredFields`, ask the user only for those fields and retry.
3. On success, show the token page URL and BaseScan URL from the response.

For granular control: `inspect_existing_app` → `validate_vault` → `prepare_existing_app_token` → `deploy_existing_app_token`.

## Notes

- `appUrl` must be a live public `http` or `https` URL.
- `creatorWallet` can be passed directly or supplied by config.
- If `imagePath` is provided to `*_prepare_existing_app_token` or `*_deploy_existing_app_token`, the MCP uploads it automatically.
- `*_validate_existing_app_token` never uploads files or deploys.
- The server validates wallet format, image type and size, URL shape, and vault recipient splits before calling the API.
