#!/usr/bin/env node

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const SERVER_NAME = "tokensfun-mcp";
const SERVER_VERSION = "1.1.0";
const DEFAULT_API_URL = "https://app.minidev.fun";
const DEFAULT_TOKENS_FUN_URL = "https://tokens.fun";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const URL_ENV_KEYS = [
  "APP_URL",
  "SITE_URL",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_SITE_URL",
  "NEXT_PUBLIC_URL",
  "PUBLIC_APP_URL",
  "PUBLIC_SITE_URL",
  "DEPLOY_URL",
  "PRODUCTION_URL",
  "VERCEL_URL",
  "VERCEL_PROJECT_PRODUCTION_URL"
];
const ENV_FILENAMES = [
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.example",
  ".env.sample"
];
const CONFIG_CANDIDATE_LABELS = [
  "MINIDEV_API_KEY environment",
  "minidev/config.json in cwd",
  "minidev/config.json in repo",
  "~/.clawdbot/skills/minidev/config.json"
];
const TOKENSFUN_TOOL_SUFFIXES = [
  "tokenize_app",
  "inspect_existing_app",
  "upload_token_image",
  "deploy_existing_app_token",
  "check_credits",
  "prepare_existing_app_token",
  "validate_existing_app_token",
  "validate_vault",
  "get_config_status",
  "show_creator_identity",
  "validate_api_key_connection",
  "list_projects",
  "health_check",
  "explain_missing_setup"
];
const ACTION_HINTS = {
  tokenize_app: {
    missing: [
      "MINIDEV_API_KEY",
      "MINIDEV_CREATOR_WALLET",
      "appUrl"
    ],
    warnings: [
      "A live public app URL is required. Set MINIDEV_API_KEY and MINIDEV_CREATOR_WALLET in env or config.json before running."
    ],
    nextSteps: [
      "Get an API key at https://tokens.fun/ → connect your wallet → click Skills → Generate API Key, then set MINIDEV_API_KEY in your MCP env or minidev/config.json.",
      "Set MINIDEV_CREATOR_WALLET in your MCP env or minidev/config.json.",
      "Provide a live public appUrl if it cannot be inferred from the project."
    ]
  },
  deploy_existing_app_token: {
    missing: [
      "MINIDEV_API_KEY",
      "MINIDEV_CREATOR_WALLET",
      "appUrl"
    ],
    warnings: [
      "A live public app URL is required before token deployment."
    ],
    nextSteps: [
      "Get an API key at https://tokens.fun/ → connect your wallet → click Skills → Generate API Key, then set MINIDEV_API_KEY or create minidev/config.json.",
      "Set MINIDEV_CREATOR_WALLET or pass creatorWallet directly.",
      "Provide a live public appUrl when preparing or deploying."
    ]
  },
  upload_token_image: {
    missing: [
      "MINIDEV_API_KEY"
    ],
    warnings: [
      "Image uploads require a valid MiniDev API key."
    ],
    nextSteps: [
      "Get an API key at https://tokens.fun/ → connect your wallet → click Skills → Generate API Key, then set MINIDEV_API_KEY or create minidev/config.json.",
      "Pass a JPG, PNG, GIF, or WebP file under 5 MB."
    ]
  },
  account_only: {
    missing: [
      "MINIDEV_API_KEY"
    ],
    warnings: [
        "API-backed account checks need a configured MiniDev API key."
    ],
    nextSteps: [
      "Get an API key at https://tokens.fun/ → connect your wallet → click Skills → Generate API Key, then set MINIDEV_API_KEY or create minidev/config.json."
    ]
  }
};

class ToolInputError extends Error {
  constructor(message, details = undefined) {
    super(message);
    this.name = "ToolInputError";
    this.details = details;
  }
}

class ApiError extends Error {
  constructor(message, status, details = undefined) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

function createDeployInputProperties() {
  return {
    projectDir: { type: "string" },
    name: { type: "string" },
    symbol: { type: "string" },
    description: { type: "string" },
    appUrl: { type: "string" },
    website: { type: "string" },
    creatorWallet: { type: "string" },
    imagePath: { type: "string" },
    imageUrl: { type: "string" },
    duneQueryId: {
      anyOf: [{ type: "string" }, { type: "integer" }, { type: "number" }]
    },
    twitter: { type: "string" },
    telegram: { type: "string" },
    farcaster: { type: "string" },
    vault: {
      type: "object",
      properties: {
        percentage: { type: "integer" },
        lockupDays: { type: "integer" },
        vestingDays: { type: "integer" },
        recipient: { type: "string" },
        recipients: {
          type: "array",
          items: {
            type: "object",
            properties: {
              address: { type: "string" },
              percentage: { type: "integer" }
            },
            required: ["address", "percentage"],
            additionalProperties: false
          }
        }
      },
      required: ["percentage", "lockupDays"],
      additionalProperties: false
    }
  };
}

function getToolDefinition(prefix, suffix) {
  const name = `${prefix}_${suffix}`;
  switch (suffix) {
    case "tokenize_app":
      return {
        name,
        description: [
          "Single-shot token deployment for the current project.",
          "Inspects the project directory (defaults to CWD), infers token name/symbol/description/appUrl, uploads an image if imagePath is provided, then deploys the token via tokens.fun.",
          "Requires MINIDEV_API_KEY and MINIDEV_CREATOR_WALLET to be configured in env or minidev/config.json.",
          "Only ask the user for input if appUrl cannot be inferred from the project AND was not provided.",
          "Returns tokenAddress, tokenPageUrl, baseScanUrl, and a plain-English summary on success.",
          "Returns missingRequiredFields on failure — surface those to the user directly."
        ].join(" "),
        inputSchema: {
          type: "object",
          properties: createDeployInputProperties(),
          additionalProperties: false
        }
      };
    case "inspect_existing_app":
      return {
        name,
        description: "Inspect a local app repo and infer existing-app token deployment metadata.",
        inputSchema: {
          type: "object",
          properties: {
            projectDir: {
              type: "string",
              description: "Absolute or relative path to the app project directory."
            }
          },
          additionalProperties: false
        }
      };
    case "upload_token_image":
      return {
        name,
        description: "Upload a local token image to tokens.fun and return the display URL, tokenURI, and IPFS CIDs.",
        inputSchema: {
          type: "object",
          properties: {
            imagePath: {
              type: "string",
              description: "Path to a local JPG, PNG, GIF, or WebP image under 5 MB."
            },
            tokenName: {
              type: "string",
              description: "Optional token name stored in uploaded metadata."
            },
            tokenSymbol: {
              type: "string",
              description: "Optional token symbol stored in uploaded metadata."
            }
          },
          required: ["imagePath"],
          additionalProperties: false
        }
      };
    case "deploy_existing_app_token":
      return {
        name,
        description: "Deploy a token for an already-live app using MiniDev's existing-app token API.",
        inputSchema: {
          type: "object",
          properties: createDeployInputProperties(),
          additionalProperties: false
        }
      };
    case "prepare_existing_app_token":
      return {
        name,
        description: "Resolve and normalize the final existing-app token payload without deploying it.",
        inputSchema: {
          type: "object",
          properties: createDeployInputProperties(),
          additionalProperties: false
        }
      };
    case "validate_existing_app_token":
      return {
        name,
        description: "Validate an existing-app token deployment request without deploying or uploading.",
        inputSchema: {
          type: "object",
          properties: createDeployInputProperties(),
          additionalProperties: false
        }
      };
    case "validate_vault":
      return {
        name,
        description: "Validate and normalize a vault configuration for token vesting.",
        inputSchema: {
          type: "object",
          properties: {
            vault: createDeployInputProperties().vault,
            defaultRecipient: { type: "string" }
          },
          required: ["vault"],
          additionalProperties: false
        }
      };
    case "check_credits":
      return {
        name,
        description: "Check the remaining MiniDev credits for the configured API key.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      };
    case "get_config_status":
      return {
        name,
        description: "Show which non-secret MiniDev/tokens.fun settings are configured and where they were loaded from.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      };
    case "show_creator_identity":
      return {
        name,
        description: "Show the configured creator wallet and creator email used by tokensfun mcp.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      };
    case "validate_api_key_connection":
      return {
        name,
        description: "Validate the configured MiniDev API key using a lightweight authenticated credits request.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      };
    case "list_projects":
      return {
        name,
        description: "List MiniDev projects for the configured account.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer" },
            offset: { type: "integer" }
          },
          additionalProperties: false
        }
      };
    case "health_check":
      return {
        name,
        description: "Run a compact readiness check for config, identity, auth, credits, and upload endpoint settings.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false
        }
      };
    case "explain_missing_setup":
      return {
        name,
        description: "Explain which setup items are missing for deploy, upload, or account-only use cases.",
        inputSchema: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["deploy_existing_app_token", "upload_token_image", "account_only"]
            }
          },
          additionalProperties: false
        }
      };
    default:
      throw new Error(`Unsupported tool suffix: ${suffix}`);
  }
}

function createToolDefinitions() {
  const prefixes = ["minidev", "tokensfun"];
  return prefixes.flatMap((prefix) =>
    TOKENSFUN_TOOL_SUFFIXES.map((suffix) => getToolDefinition(prefix, suffix))
  );
}

function canonicalizeToolName(name) {
  if (typeof name !== "string") {
    return "";
  }
  if (name.startsWith("minidev_")) {
    return name.slice("minidev_".length);
  }
  if (name.startsWith("tokensfun_")) {
    return name.slice("tokensfun_".length);
  }
  return name;
}

function toToolResult(payload, summary) {
  return {
    structuredContent: payload,
    content: [
      {
        type: "text",
        text: summary || JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function toToolErrorResult(error) {
  const payload = { error: error.message || "Unknown error" };
  if (error.details !== undefined) {
    payload.details = error.details;
  }
  if (error.status !== undefined) {
    payload.status = error.status;
  }
  return {
    isError: true,
    structuredContent: payload,
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function titleCaseWords(value) {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function deriveNameCandidate(raw) {
  if (!raw) {
    return "";
  }
  const cleaned = raw
    .replace(/^@[^/]+\//, "")
    .replace(/\.(app|web|site|xyz|fun|io)$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return "";
  }
  return titleCaseWords(cleaned.split(" ").slice(0, 3).join(" "));
}

function deriveSymbolCandidate(rawName) {
  if (!rawName) {
    return "";
  }
  const words = rawName
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length >= 3) {
    return words
      .slice(0, 5)
      .map((word) => word.charAt(0))
      .join("")
      .toUpperCase();
  }
  if (words.length === 2) {
    const combined = `${words[0]}${words[1]}`.replace(/[^a-zA-Z0-9]/g, "");
    return combined.slice(0, 4).toUpperCase();
  }
  const flattened = words.join("").replace(/[^a-zA-Z0-9]/g, "");
  return flattened.slice(0, Math.min(5, Math.max(3, flattened.length))).toUpperCase();
}

function isPublicHttpUrl(value) {
  try {
    const parsed = new URL(value);
    const protocolOk = parsed.protocol === "http:" || parsed.protocol === "https:";
    const host = parsed.hostname.toLowerCase();
    const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local");
    return protocolOk && !!host && !isLocal;
  } catch {
    return false;
  }
}

function normalizeUrlCandidate(value) {
  if (!value || typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed) {
    return null;
  }
  if (isPublicHttpUrl(trimmed)) {
    return trimmed;
  }
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(trimmed) && !trimmed.includes(" ")) {
    const withScheme = `https://${trimmed}`;
    if (isPublicHttpUrl(withScheme)) {
      return withScheme;
    }
  }
  return null;
}

function parseEnvLikeFile(contents) {
  const values = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) {
      continue;
    }
    values[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return values;
}

function extractFirstMeaningfulParagraph(readme) {
  const lines = readme.split(/\r?\n/);
  const paragraphs = [];
  let current = [];
  let inFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (!line) {
      if (current.length) {
        paragraphs.push(current.join(" ").trim());
        current = [];
      }
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    current.push(line);
  }
  if (current.length) {
    paragraphs.push(current.join(" ").trim());
  }
  return (
    paragraphs.find((paragraph) => paragraph.length >= 20 && !paragraph.startsWith("![") && /[A-Za-z]/.test(paragraph)) ||
    ""
  );
}

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readTextIfExists(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function pathExists(targetPath) {
  try {
    await fsp.access(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureObject(value, name) {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`${name} must be an object.`);
  }
  return value;
}

function pickDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return "";
}

function validateWallet(value, fieldName = "creatorWallet") {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new ToolInputError(`${fieldName} must be a valid Ethereum address.`);
  }
}

function validatePublicUrl(value, fieldName) {
  if (!isPublicHttpUrl(value)) {
    throw new ToolInputError(`${fieldName} must be a public http or https URL.`);
  }
}

function sanitizeConfigSource(source) {
  if (!source) {
    return "none";
  }
  if (source === "env") {
    return "env";
  }
  const homeDir = os.homedir();
  return source.startsWith(homeDir) ? source.replace(homeDir, "~") : source;
}

async function resolveConfig(options = {}) {
  const env = options.env || process.env;
  const cwd = path.resolve(options.cwd || process.cwd());
  const homeDir = options.homeDir || os.homedir();
  const serverDir = options.serverDir || __dirname;
  const repoRoot = path.resolve(serverDir, "..");

  const envConfig = {
    apiKey: env.MINIDEV_API_KEY || "",
    apiUrl: env.MINIDEV_API_URL || "",
    tokensFunUrl: env.TOKENS_FUN_URL || "",
    creatorWallet: env.MINIDEV_CREATOR_WALLET || "",
    creatorEmail: env.MINIDEV_CREATOR_EMAIL || ""
  };

  if (envConfig.apiKey) {
    return {
      apiKey: envConfig.apiKey,
      apiUrl: envConfig.apiUrl || DEFAULT_API_URL,
      tokensFunUrl: envConfig.tokensFunUrl || DEFAULT_TOKENS_FUN_URL,
      creatorWallet: envConfig.creatorWallet || "",
      creatorEmail: envConfig.creatorEmail || "",
      source: "env"
    };
  }

  const configCandidates = [
    path.join(cwd, "minidev", "config.json"),
    path.join(repoRoot, "minidev", "config.json"),
    path.join(homeDir, ".clawdbot", "skills", "minidev", "config.json")
  ];

  for (const filePath of configCandidates) {
    const config = await readJsonIfExists(filePath);
    if (!config) {
      continue;
    }
    if (!config.apiKey) {
      return {
        apiKey: "",
        apiUrl: config.apiUrl || DEFAULT_API_URL,
        tokensFunUrl: config.tokensFunUrl || config.crystalsUrl || DEFAULT_TOKENS_FUN_URL,
        creatorWallet: config.creatorWallet || "",
        creatorEmail: config.creatorEmail || "",
        source: filePath
      };
    }
    return {
      apiKey: config.apiKey,
      apiUrl: config.apiUrl || DEFAULT_API_URL,
      tokensFunUrl: config.tokensFunUrl || config.crystalsUrl || DEFAULT_TOKENS_FUN_URL,
      creatorWallet: config.creatorWallet || "",
      creatorEmail: config.creatorEmail || "",
      source: filePath
    };
  }

  return {
    apiKey: "",
    apiUrl: DEFAULT_API_URL,
    tokensFunUrl: DEFAULT_TOKENS_FUN_URL,
    creatorWallet: "",
    creatorEmail: "",
    source: "none"
  };
}

async function loadConfig(options = {}) {
  const config = await resolveConfig(options);
  if (!config.apiKey) {
    throw new ToolInputError("API key not configured. Go to https://tokens.fun/ → sign in → API Keys → Create a new key, then set MINIDEV_API_KEY in env or create minidev/config.json.", {
      checked: CONFIG_CANDIDATE_LABELS
    });
  }
  return config;
}

function summarizeConfig(config) {
  return {
    source: sanitizeConfigSource(config.source),
    apiUrl: config.apiUrl || DEFAULT_API_URL,
    tokensFunUrl: config.tokensFunUrl || DEFAULT_TOKENS_FUN_URL,
    hasApiKey: Boolean(config.apiKey),
    hasCreatorWallet: Boolean(config.creatorWallet),
    hasCreatorEmail: Boolean(config.creatorEmail)
  };
}

function validateVault(vault, options = {}) {
  if (vault === undefined) {
    return undefined;
  }
  const input = ensureObject(vault, "vault");
  const percentage = input.percentage;
  const lockupDays = input.lockupDays;
  const vestingDays = input.vestingDays;
  const defaultRecipient = options.defaultRecipient || "";

  if (!Number.isInteger(percentage) || percentage < 1 || percentage > 100) {
    throw new ToolInputError("vault.percentage must be an integer between 1 and 100.");
  }
  if (!Number.isInteger(lockupDays) || lockupDays < 7) {
    throw new ToolInputError("vault.lockupDays must be an integer of at least 7.");
  }
  if (vestingDays !== undefined && (!Number.isInteger(vestingDays) || vestingDays < 0)) {
    throw new ToolInputError("vault.vestingDays must be a non-negative integer when provided.");
  }

  const normalized = { percentage, lockupDays };
  if (vestingDays !== undefined) {
    normalized.vestingDays = vestingDays;
  }

  if (input.recipients !== undefined) {
    if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
      throw new ToolInputError("vault.recipients must be a non-empty array when provided.");
    }
    let total = 0;
    normalized.recipients = input.recipients.map((recipient, index) => {
      const entry = ensureObject(recipient, `vault.recipients[${index}]`);
      if (!Number.isInteger(entry.percentage) || entry.percentage < 1) {
        throw new ToolInputError(`vault.recipients[${index}].percentage must be a positive integer.`);
      }
      validateWallet(entry.address, `vault.recipients[${index}].address`);
      total += entry.percentage;
      return { address: entry.address, percentage: entry.percentage };
    });
    if (total !== percentage) {
      throw new ToolInputError("vault recipient percentages must sum exactly to vault.percentage.");
    }
  } else if (input.recipient !== undefined) {
    validateWallet(input.recipient, "vault.recipient");
    normalized.recipient = input.recipient;
  } else if (defaultRecipient) {
    validateWallet(defaultRecipient, "defaultRecipient");
    normalized.recipient = defaultRecipient;
  }

  return normalized;
}

async function inspectProject(projectDir) {
  const resolvedDir = path.resolve(projectDir || process.cwd());
  const packageJson = await readJsonIfExists(path.join(resolvedDir, "package.json"));
  const readme = await readTextIfExists(path.join(resolvedDir, "README.md"));
  const packageName = deriveNameCandidate(packageJson && packageJson.name);
  const readmeParagraph = readme ? extractFirstMeaningfulParagraph(readme) : "";
  const description =
    (packageJson && typeof packageJson.description === "string" && packageJson.description.trim()) || readmeParagraph || "";

  const urlCandidates = [];
  const addCandidate = (value, source, kind) => {
    const normalized = normalizeUrlCandidate(value);
    if (!normalized || urlCandidates.some((entry) => entry.url === normalized)) {
      return;
    }
    urlCandidates.push({ url: normalized, source, kind });
  };

  if (packageJson && typeof packageJson.homepage === "string") {
    addCandidate(packageJson.homepage, "package.json:homepage", "website");
  }

  const dirEntries = await fsp.readdir(resolvedDir, { withFileTypes: true });
  const envFiles = dirEntries
    .filter((entry) => entry.isFile() && (ENV_FILENAMES.includes(entry.name) || entry.name.startsWith(".env.")))
    .map((entry) => entry.name);

  for (const envFile of envFiles) {
    const contents = await readTextIfExists(path.join(resolvedDir, envFile));
    if (!contents) {
      continue;
    }
    const parsed = parseEnvLikeFile(contents);
    for (const key of URL_ENV_KEYS) {
      if (parsed[key]) {
        addCandidate(parsed[key], `${envFile}:${key}`, key.includes("APP") ? "app" : "website");
      }
    }
  }

  const appUrlCandidates = urlCandidates.filter((entry) => entry.kind === "app").map((entry) => entry.url);
  const websiteCandidates = urlCandidates.filter((entry) => entry.kind === "website").map((entry) => entry.url);
  const allCandidates = urlCandidates.map((entry) => entry.url);
  const name = packageName || deriveNameCandidate(path.basename(resolvedDir));
  const symbol = deriveSymbolCandidate(name);

  const missingRequiredFields = [];
  if (!name) missingRequiredFields.push("name");
  if (!symbol) missingRequiredFields.push("symbol");
  if (!appUrlCandidates[0]) missingRequiredFields.push("appUrl");

  return {
    projectDir: resolvedDir,
    inferred: {
      name,
      description,
      suggestedTokenName: name,
      suggestedTokenSymbol: symbol,
      appUrlCandidate: appUrlCandidates[0] || "",
      websiteCandidate: websiteCandidates[0] || allCandidates[0] || ""
    },
    urlCandidates,
    missingRequiredFields
  };
}

async function validateImageInput(imagePath) {
  if (!imagePath || typeof imagePath !== "string") {
    throw new ToolInputError("imagePath is required.");
  }
  const resolvedPath = path.resolve(imagePath);
  if (!(await pathExists(resolvedPath))) {
    throw new ToolInputError(`Image file not found: ${resolvedPath}`);
  }
  const stats = await fsp.stat(resolvedPath);
  if (stats.size > MAX_IMAGE_BYTES) {
    throw new ToolInputError("Image exceeds the 5 MB size limit.");
  }
  const ext = path.extname(resolvedPath).toLowerCase();
  const mimeTypes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp"
  };
  const mimeType = mimeTypes[ext];
  if (!mimeType) {
    throw new ToolInputError("Image must be a JPG, PNG, GIF, or WebP file.");
  }
  return { resolvedPath, mimeType, filename: path.basename(resolvedPath) };
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function apiRequest(fetchImpl, url, init, errorPrefix) {
  const response = await fetchImpl(url, init);
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new ApiError(payload.message || payload.error || `${errorPrefix} failed.`, response.status, payload);
  }
  return payload;
}

async function uploadImage(args, context = {}) {
  const input = ensureObject(args, "arguments");
  const config = await loadConfig(context.configOptions);
  const fetchImpl = context.fetchImpl || global.fetch;
  const image = await validateImageInput(input.imagePath);
  const bytes = await fsp.readFile(image.resolvedPath);
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: image.mimeType }), image.filename);
  if (input.tokenName) {
    form.append("name", input.tokenName);
  }
  if (input.tokenSymbol) {
    form.append("symbol", input.tokenSymbol);
  }

  const payload = await apiRequest(
    fetchImpl,
    `${config.tokensFunUrl}/api/upload-image`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}` },
      body: form
    },
    "Image upload"
  );

  return {
    imagePath: image.resolvedPath,
    imageUrl: payload.url || "",
    tokenURI: payload.tokenURI || "",
    imageCID: payload.imageCID || "",
    metadataCID: payload.metadataCID || "",
    raw: payload
  };
}

function buildSetupAdvice(action, configSummary) {
  const hints = ACTION_HINTS[action] || ACTION_HINTS.account_only;
  const missing = [];
  if (!configSummary.hasApiKey && hints.missing.includes("MINIDEV_API_KEY")) {
    missing.push("MINIDEV_API_KEY");
  }
  if (!configSummary.hasCreatorWallet && hints.missing.includes("MINIDEV_CREATOR_WALLET")) {
    missing.push("MINIDEV_CREATOR_WALLET");
  }
  if (action === "deploy_existing_app_token") {
    missing.push("appUrl");
  }
  return {
    action,
    missing,
    warnings: [...hints.warnings],
    recommendedNextSteps: [...hints.nextSteps]
  };
}

async function getConfigStatus(context = {}) {
  const config = await resolveConfig(context.configOptions);
  const summary = summarizeConfig(config);
  return {
    source: summary.source,
    apiUrl: summary.apiUrl,
    tokensFunUrl: summary.tokensFunUrl,
    hasApiKey: summary.hasApiKey,
    hasCreatorWallet: summary.hasCreatorWallet,
    hasCreatorEmail: summary.hasCreatorEmail,
    warnings: [
      ...(summary.hasApiKey ? [] : ["MiniDev API key is not configured."]),
      ...(summary.hasCreatorWallet ? [] : ["Creator wallet is not configured."]),
      ...(summary.hasCreatorEmail ? [] : ["Creator email is not configured."])
    ]
  };
}

async function showCreatorIdentity(context = {}) {
  const config = await resolveConfig(context.configOptions);
  return {
    creatorWallet: config.creatorWallet || "",
    creatorEmail: config.creatorEmail || "",
    source: sanitizeConfigSource(config.source),
    warnings: [
      ...(config.creatorWallet ? [] : ["Creator wallet is missing."]),
      ...(config.creatorEmail ? [] : ["Creator email is missing."])
    ]
  };
}

async function validateApiKeyConnection(context = {}) {
  try {
    const result = await checkCredits(context);
    return {
      valid: true,
      status: 200,
      message: "MiniDev API key is valid.",
      walletAddress: result.walletAddress,
      credits: result.credits,
      unlimited: result.unlimited
    };
  } catch (error) {
    if (error instanceof ToolInputError || error instanceof ApiError) {
      return {
        valid: false,
        status: error.status || null,
        message: error.message
      };
    }
    throw error;
  }
}

function normalizePositiveInteger(value, fieldName, defaultValue) {
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new ToolInputError(`${fieldName} must be a non-negative integer.`);
  }
  return value;
}

async function listProjects(args = {}, context = {}) {
  const input = ensureObject(args, "arguments");
  const limit = normalizePositiveInteger(input.limit, "limit", 10);
  const offset = normalizePositiveInteger(input.offset, "offset", 0);
  const config = await loadConfig(context.configOptions);
  const fetchImpl = context.fetchImpl || global.fetch;

  const payload = await apiRequest(
    fetchImpl,
    `${config.apiUrl}/api/v1/apps/projects?limit=${limit}&offset=${offset}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}` }
    },
    "Projects lookup"
  );

  return {
    projects: payload.projects || [],
    pagination: payload.pagination || { limit, offset }
  };
}

async function checkCredits(context = {}) {
  const config = await loadConfig(context.configOptions);
  const fetchImpl = context.fetchImpl || global.fetch;
  const payload = await apiRequest(
    fetchImpl,
    `${config.apiUrl}/api/v1/apps/credits`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${config.apiKey}` }
    },
    "Credits lookup"
  );
  return {
    credits: payload.credits,
    walletAddress: payload.walletAddress || "",
    unlimited: Boolean(payload.unlimited),
    raw: payload
  };
}

async function inspectExistingAppTool(args) {
  const input = ensureObject(args, "arguments");
  const inspection = await inspectProject(input.projectDir);
  return {
    projectDir: inspection.projectDir,
    projectName: inspection.inferred.name,
    description: inspection.inferred.description,
    suggestedTokenName: inspection.inferred.suggestedTokenName,
    suggestedTokenSymbol: inspection.inferred.suggestedTokenSymbol,
    appUrlCandidates: inspection.urlCandidates.filter((entry) => entry.kind === "app"),
    websiteCandidates: inspection.urlCandidates.filter((entry) => entry.kind === "website"),
    missingRequiredFields: inspection.missingRequiredFields
  };
}

async function normalizeExistingAppTokenInput(args, context = {}, options = {}) {
  const input = ensureObject(args, "arguments");
  const inspection = input.projectDir ? await inspectProject(input.projectDir) : null;
  const config = options.requireConfig === false ? await resolveConfig(context.configOptions) : await loadConfig(context.configOptions);
  const warnings = [];
  const errors = [];

  const name = pickDefined(input.name, inspection && inspection.inferred.suggestedTokenName);
  const symbol = pickDefined(input.symbol, inspection && inspection.inferred.suggestedTokenSymbol);
  const description = pickDefined(input.description, inspection && inspection.inferred.description);
  const appUrl = pickDefined(input.appUrl, inspection && inspection.inferred.appUrlCandidate);
  const website = pickDefined(input.website, inspection && inspection.inferred.websiteCandidate, appUrl);
  const creatorWallet = pickDefined(input.creatorWallet, config.creatorWallet);
  const duneQueryId =
    input.duneQueryId !== undefined && input.duneQueryId !== null && `${input.duneQueryId}`.trim() !== ""
      ? `${input.duneQueryId}`.trim()
      : "";

  const missingRequiredFields = [];
  if (!name) missingRequiredFields.push("name");
  if (!symbol) missingRequiredFields.push("symbol");
  if (!appUrl) missingRequiredFields.push("appUrl");
  if (!creatorWallet) missingRequiredFields.push("creatorWallet");

  if (!config.apiKey) {
    missingRequiredFields.push("MINIDEV_API_KEY");
  }
  if (!config.creatorWallet && !input.creatorWallet) {
    warnings.push("Creator wallet is not configured globally; pass creatorWallet directly or configure MINIDEV_CREATOR_WALLET.");
  }
  if (!config.creatorEmail) {
    warnings.push("Creator email is not configured.");
  }
  if (!input.website && website === appUrl && appUrl) {
    warnings.push("website was not provided, so appUrl will also be used as the website.");
  }

  const payload = {};
  if (name) payload.name = name;
  if (symbol) payload.symbol = symbol;
  if (creatorWallet) payload.creatorWallet = creatorWallet;
  if (appUrl) payload.appUrl = appUrl;
  if (description) payload.description = description;
  if (website) payload.website = website;
  if (duneQueryId) payload.duneQueryId = duneQueryId;
  for (const field of ["twitter", "telegram", "farcaster"]) {
    if (input[field]) {
      payload[field] = input[field];
    }
  }

  const validationChecks = [
    [creatorWallet, () => validateWallet(creatorWallet), "creatorWallet"],
    [appUrl, () => validatePublicUrl(appUrl, "appUrl"), "appUrl"],
    [website, () => validatePublicUrl(website, "website"), "website"],
    [input.imageUrl, () => validatePublicUrl(input.imageUrl, "imageUrl"), "imageUrl"],
    [input.twitter, () => validatePublicUrl(input.twitter, "twitter"), "twitter"],
    [input.telegram, () => validatePublicUrl(input.telegram, "telegram"), "telegram"],
    [input.farcaster, () => validatePublicUrl(input.farcaster, "farcaster"), "farcaster"]
  ];

  for (const [value, validator] of validationChecks) {
    if (!value) {
      continue;
    }
    try {
      validator();
    } catch (error) {
      errors.push(error.message);
    }
  }

  let normalizedVault;
  try {
    normalizedVault = validateVault(input.vault, { defaultRecipient: creatorWallet || "" });
    if (normalizedVault) {
      payload.vault = normalizedVault;
    }
  } catch (error) {
    errors.push(error.message);
  }

  if (input.imageUrl) {
    payload.imageUrl = input.imageUrl;
  }

  let uploadedImage = null;
  if (!options.skipUpload && !payload.imageUrl && input.imagePath) {
    uploadedImage = await uploadImage(
      {
        imagePath: input.imagePath,
        tokenName: name,
        tokenSymbol: symbol
      },
      context
    );
    payload.imageUrl = uploadedImage.imageUrl;
  }

  return {
    valid: missingRequiredFields.length === 0 && errors.length === 0,
    errors,
    warnings,
    missingRequiredFields: [...new Set(missingRequiredFields)],
    normalizedPayload: payload,
    uploadedImage,
    inferredFields: inspection
      ? {
          projectDir: inspection.projectDir,
          ...inspection.inferred
        }
      : {
          projectDir: "",
          name: "",
          description: "",
          suggestedTokenName: "",
          suggestedTokenSymbol: "",
          appUrlCandidate: "",
          websiteCandidate: ""
        },
    configSummary: summarizeConfig(config)
  };
}

async function prepareExistingAppToken(args, context = {}) {
  const normalized = await normalizeExistingAppTokenInput(args, context, { skipUpload: false });
  return {
    payload: normalized.normalizedPayload,
    missingRequiredFields: normalized.missingRequiredFields,
    warnings: normalized.warnings,
    errors: normalized.errors,
    uploadedImage: normalized.uploadedImage,
    inferredFields: normalized.inferredFields
  };
}

async function validateExistingAppToken(args, context = {}) {
  const normalized = await normalizeExistingAppTokenInput(args, context, { skipUpload: true });
  return {
    valid: normalized.valid,
    errors: normalized.errors,
    warnings: normalized.warnings,
    normalizedPayload: normalized.normalizedPayload,
    missingRequiredFields: normalized.missingRequiredFields
  };
}

async function deployExistingAppToken(args, context = {}) {
  const normalized = await normalizeExistingAppTokenInput(args, context, { skipUpload: false });
  if (!normalized.valid) {
    throw new ToolInputError("Existing-app token deployment payload is invalid.", {
      errors: normalized.errors,
      missingRequiredFields: normalized.missingRequiredFields,
      warnings: normalized.warnings
    });
  }
  const config = await loadConfig(context.configOptions);
  const fetchImpl = context.fetchImpl || global.fetch;
  const apiPayload = await apiRequest(
    fetchImpl,
    `${config.apiUrl}/api/v1/token/deploy`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(normalized.normalizedPayload)
    },
    "Token deployment"
  );

  return {
    tokenAddress: apiPayload.tokenAddress || "",
    txHash: apiPayload.txHash || "",
    tokenPageUrl:
      (apiPayload.urls && apiPayload.urls.tokenPage) ||
      (apiPayload.tokenAddress ? `${config.tokensFunUrl}/coin/${apiPayload.tokenAddress}` : ""),
    baseScanUrl:
      (apiPayload.urls && apiPayload.urls.basescan) ||
      (apiPayload.tokenAddress ? `https://basescan.org/token/${apiPayload.tokenAddress}` : ""),
    payloadUsed: normalized.normalizedPayload,
    uploadedImage: normalized.uploadedImage,
    raw: apiPayload
  };
}

async function validateVaultTool(args) {
  const input = ensureObject(args, "arguments");
  try {
    const normalizedVault = validateVault(input.vault, { defaultRecipient: input.defaultRecipient || "" });
    return {
      valid: true,
      errors: [],
      normalizedVault
    };
  } catch (error) {
    if (error instanceof ToolInputError) {
      return {
        valid: false,
        errors: [error.message],
        normalizedVault: null
      };
    }
    throw error;
  }
}

async function healthCheck(context = {}) {
  const config = await resolveConfig(context.configOptions);
  const checks = {
    configLoaded: {
      ok: Boolean(config.source && config.source !== "none"),
      message: config.source && config.source !== "none" ? "Configuration source resolved." : "No config source resolved."
    },
    apiKeyConfigured: {
      ok: Boolean(config.apiKey),
      message: config.apiKey ? "MiniDev API key configured." : "MiniDev API key missing."
    },
    creatorIdentity: {
      ok: Boolean(config.creatorWallet) && Boolean(config.creatorEmail),
      message:
        Boolean(config.creatorWallet) && Boolean(config.creatorEmail)
          ? "Creator wallet and email are configured."
          : "Creator wallet or creator email is missing."
    },
    uploadEndpointConfigured: {
      ok: Boolean(config.tokensFunUrl),
      message: config.tokensFunUrl ? "tokens.fun upload base URL configured." : "tokens.fun upload base URL missing."
    }
  };

  let auth = { valid: false, status: null, message: "MiniDev API key missing." };
  let credits = { ok: false, message: "Credits endpoint not checked." };
  if (config.apiKey) {
    auth = await validateApiKeyConnection(context);
    credits = {
      ok: auth.valid,
      message: auth.valid ? "Credits endpoint reachable." : auth.message
    };
  }

  return {
    source: sanitizeConfigSource(config.source),
    checks: {
      ...checks,
      auth: {
        ok: auth.valid,
        message: auth.message,
        status: auth.status
      },
      credits
    },
    ready: Object.values({
      ...checks,
      auth: { ok: auth.valid },
      credits
    }).every((entry) => entry.ok)
  };
}

async function explainMissingSetup(args = {}, context = {}) {
  const input = ensureObject(args, "arguments");
  const action = input.action || "account_only";
  const config = await resolveConfig(context.configOptions);
  const summary = summarizeConfig(config);
  const advice = buildSetupAdvice(action, summary);
  return {
    action,
    source: summary.source,
    missing: advice.missing,
    warnings: advice.warnings,
    recommendedNextSteps: advice.recommendedNextSteps
  };
}

async function tokenizeApp(args, context = {}) {
  const input = ensureObject(args, "arguments");
  const configOpts = context.configOptions || {};
  if (!input.projectDir) {
    input.projectDir = configOpts.cwd || process.cwd();
  }

  const result = await deployExistingAppToken(input, context);
  const config = await resolveConfig(context.configOptions);

  return {
    tokenAddress: result.tokenAddress,
    txHash: result.txHash,
    tokenPageUrl: result.tokenPageUrl,
    baseScanUrl: result.baseScanUrl,
    uploadedImage: result.uploadedImage || null,
    summary: result.tokenAddress
      ? [
          `Token deployed successfully.`,
          `Name:       ${result.payloadUsed.name || ""}  ($${result.payloadUsed.symbol || ""})`,
          `Token page: ${result.tokenPageUrl}`,
          `BaseScan:   ${result.baseScanUrl}`,
          result.uploadedImage ? `Image:      ${result.uploadedImage.imageUrl}` : null
        ]
          .filter(Boolean)
          .join("\n")
      : "Deployment did not return a token address.",
    payloadUsed: result.payloadUsed
  };
}

async function callTool(name, args, context = {}) {
  switch (canonicalizeToolName(name)) {
    case "tokenize_app":
      return tokenizeApp(args, context);
    case "inspect_existing_app":
      return inspectExistingAppTool(args, context);
    case "upload_token_image":
      return uploadImage(args, context);
    case "deploy_existing_app_token":
      return deployExistingAppToken(args, context);
    case "check_credits":
      return checkCredits(context);
    case "prepare_existing_app_token":
      return prepareExistingAppToken(args, context);
    case "validate_existing_app_token":
      return validateExistingAppToken(args, context);
    case "validate_vault":
      return validateVaultTool(args, context);
    case "get_config_status":
      return getConfigStatus(context);
    case "show_creator_identity":
      return showCreatorIdentity(context);
    case "validate_api_key_connection":
      return validateApiKeyConnection(context);
    case "list_projects":
      return listProjects(args, context);
    case "health_check":
      return healthCheck(context);
    case "explain_missing_setup":
      return explainMissingSetup(args, context);
    default:
      throw new ToolInputError(`Unknown tool: ${name}`);
  }
}

async function handleRpcRequest(message, context = {}) {
  if (!message || typeof message !== "object") {
    return { error: { code: -32600, message: "Invalid request" } };
  }

  const { id, method, params } = message;
  const hasId = Object.prototype.hasOwnProperty.call(message, "id");

  try {
    switch (method) {
      case "initialize":
        return {
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: {
              name: SERVER_NAME,
              version: SERVER_VERSION
            }
          }
        };
      case "notifications/initialized":
        return hasId ? { id, result: {} } : null;
      case "ping":
        return { id, result: {} };
      case "tools/list":
        return {
          id,
          result: {
            tools: createToolDefinitions()
          }
        };
      case "tools/call": {
        const toolName = params && params.name;
        const toolArgs = (params && params.arguments) || {};
        if (!toolName || typeof toolName !== "string") {
          throw new ToolInputError("tools/call requires a string params.name.");
        }
        try {
          const payload = await callTool(toolName, toolArgs, context);
          return { id, result: toToolResult(payload) };
        } catch (error) {
          if (error instanceof ToolInputError || error instanceof ApiError) {
            return { id, result: toToolErrorResult(error) };
          }
          throw error;
        }
      }
      default:
        return {
          id,
          error: {
            code: -32601,
            message: `Method not found: ${method}`
          }
        };
    }
  } catch (error) {
    return {
      id,
      error: {
        code: -32603,
        message: error.message || "Internal error"
      }
    };
  }
}

function writeRpcMessage(stream, message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  stream.write(`Content-Length: ${body.length}\r\n\r\n`);
  stream.write(body);
}

function startServer(context = {}) {
  let buffer = Buffer.alloc(0);
  process.stdin.on("data", async (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    while (true) {
      const separatorIndex = buffer.indexOf("\r\n\r\n");
      if (separatorIndex === -1) {
        break;
      }
      const header = buffer.slice(0, separatorIndex).toString("utf8");
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        buffer = Buffer.alloc(0);
        break;
      }
      const contentLength = Number.parseInt(match[1], 10);
      const frameLength = separatorIndex + 4 + contentLength;
      if (buffer.length < frameLength) {
        break;
      }
      const jsonBody = buffer.slice(separatorIndex + 4, frameLength).toString("utf8");
      buffer = buffer.slice(frameLength);

      let message;
      try {
        message = JSON.parse(jsonBody);
      } catch {
        writeRpcMessage(process.stdout, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error"
          }
        });
        continue;
      }

      const response = await handleRpcRequest(message, context);
      if (response && Object.prototype.hasOwnProperty.call(message, "id")) {
        writeRpcMessage(process.stdout, {
          jsonrpc: "2.0",
          ...response
        });
      }
    }
  });
}

function printTools() {
  process.stdout.write(`${JSON.stringify(createToolDefinitions(), null, 2)}\n`);
}

if (require.main === module) {
  const arg = process.argv[2];
  if (arg === "--tools") {
    printTools();
  } else {
    startServer({
      configOptions: {
        cwd: process.cwd(),
        serverDir: __dirname
      }
    });
  }
}

module.exports = {
  ACTION_HINTS,
  ApiError,
  ToolInputError,
  callTool,
  tokenizeApp,
  canonicalizeToolName,
  checkCredits,
  createToolDefinitions,
  deployExistingAppToken,
  explainMissingSetup,
  getConfigStatus,
  handleRpcRequest,
  healthCheck,
  inspectExistingAppTool,
  inspectProject,
  listProjects,
  loadConfig,
  normalizeExistingAppTokenInput,
  normalizeUrlCandidate,
  parseEnvLikeFile,
  prepareExistingAppToken,
  resolveConfig,
  showCreatorIdentity,
  startServer,
  toToolErrorResult,
  toToolResult,
  uploadImage,
  validateApiKeyConnection,
  validateExistingAppToken,
  validateImageInput,
  validateVault,
  validateVaultTool,
  writeRpcMessage
};
