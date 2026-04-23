const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

const {
  callTool,
  createSetupConfig,
  createToolDefinitions,
  deployExistingAppToken,
  getStartupBanner,
  getConfigStatus,
  handleRpcRequest,
  healthCheck,
  inspectProject,
  listProjects,
  printHelp,
  prepareExistingAppToken,
  showCreatorIdentity,
  startServer,
  uploadImage,
  validateApiKeyConnection,
  validateExistingAppToken,
  validateVaultTool,
  writeRpcMessage
} = require("./server");

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "tokensfun-mcp-test-"));
}

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents);
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

function createFetchStub(handler) {
  return async (url, init = {}) => handler(String(url), init);
}

function createEnv(overrides = {}) {
  return {
    MINIDEV_API_KEY: "mk_test",
    MINIDEV_API_URL: "https://app.minidev.fun",
    TOKENS_FUN_URL: "https://tokens.fun",
    MINIDEV_CREATOR_WALLET: "0x1234567890123456789012345678901234567890",
    MINIDEV_CREATOR_EMAIL: "hello@example.com",
    ...overrides
  };
}

test("tools/list exposes legacy and tokensfun aliases", async () => {
  const names = createToolDefinitions().map((tool) => tool.name);
  assert.equal(names.length, 28);
  assert.ok(names.includes("minidev_inspect_existing_app"));
  assert.ok(names.includes("tokensfun_inspect_existing_app"));
  assert.ok(names.includes("minidev_prepare_existing_app_token"));
  assert.ok(names.includes("tokensfun_prepare_existing_app_token"));
  assert.ok(names.includes("minidev_health_check"));
  assert.ok(names.includes("tokensfun_health_check"));
});

test("inspectExistingApp infers metadata from package.json", async () => {
  const dir = await makeTempDir();
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "swap-flow",
        description: "A DEX aggregator on Base",
        homepage: "https://swapflow.xyz"
      },
      null,
      2
    )
  );

  const result = await inspectProject(dir);
  assert.equal(result.inferred.suggestedTokenName, "Swap Flow");
  assert.equal(result.inferred.suggestedTokenSymbol, "SWAP");
  assert.equal(result.inferred.websiteCandidate, "https://swapflow.xyz");
});

test("inspectExistingApp falls back to README paragraph", async () => {
  const dir = await makeTempDir();
  await writeFile(path.join(dir, "README.md"), "# My App\n\nA simple app that helps creators track campaign revenue.\n");

  const result = await inspectProject(dir);
  assert.match(result.inferred.description, /helps creators track campaign revenue/i);
});

test("inspectExistingApp extracts app URL candidates from env files", async () => {
  const dir = await makeTempDir();
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "agentpad" }));
  await writeFile(path.join(dir, ".env.production"), "NEXT_PUBLIC_APP_URL=https://agentpad.app\n");

  const result = await inspectProject(dir);
  assert.equal(result.inferred.appUrlCandidate, "https://agentpad.app");
  assert.equal(result.missingRequiredFields.includes("appUrl"), false);
});

test("prepareExistingAppToken returns normalized payload without deploy call", async () => {
  const dir = await makeTempDir();
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "swap-flow", homepage: "https://swapflow.xyz" }));
  await writeFile(path.join(dir, ".env"), "APP_URL=https://app.swapflow.xyz\n");

  let calledDeploy = false;
  const result = await prepareExistingAppToken(
    { projectDir: dir },
    {
      fetchImpl: createFetchStub((url) => {
        if (url.endsWith("/api/v1/token/deploy")) {
          calledDeploy = true;
        }
        throw new Error(`Unexpected URL: ${url}`);
      }),
      configOptions: {
        env: createEnv(),
        cwd: dir
      }
    }
  );

  assert.equal(calledDeploy, false);
  assert.equal(result.payload.name, "Swap Flow");
  assert.equal(result.payload.appUrl, "https://app.swapflow.xyz");
  assert.equal(result.payload.website, "https://swapflow.xyz");
});

test("validateExistingAppToken reports missing appUrl without upload or deploy", async () => {
  const dir = await makeTempDir();
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "swap-flow" }));

  const result = await validateExistingAppToken(
    { projectDir: dir },
    {
      fetchImpl: async () => {
        throw new Error("should not call fetch");
      },
      configOptions: {
        env: createEnv(),
        cwd: dir
      }
    }
  );

  assert.equal(result.valid, false);
  assert.ok(result.missingRequiredFields.includes("appUrl"));
});

test("deployExistingAppToken lets explicit args override inferred values", async () => {
  const dir = await makeTempDir();
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "agentpad", description: "Original description" }));
  await writeFile(path.join(dir, ".env"), "APP_URL=https://agentpad.app\n");

  let capturedPayload = null;
  const fetchStub = createFetchStub((url, init) => {
    if (url.endsWith("/api/v1/token/deploy")) {
      capturedPayload = JSON.parse(init.body);
      return jsonResponse(200, {
        success: true,
        tokenAddress: "0x1234567890abcdef1234567890abcdef12345678",
        txHash: "0xtx",
        urls: {
          tokenPage: "https://tokens.fun/coin/0x1234567890abcdef1234567890abcdef12345678",
          basescan: "https://basescan.org/token/0x1234567890abcdef1234567890abcdef12345678"
        }
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  const result = await deployExistingAppToken(
    {
      projectDir: dir,
      name: "Override Name",
      symbol: "OVRD",
      description: "Override description",
      creatorWallet: "0x1234567890123456789012345678901234567890"
    },
    {
      fetchImpl: fetchStub,
      configOptions: {
        env: createEnv(),
        cwd: dir
      }
    }
  );

  assert.equal(capturedPayload.name, "Override Name");
  assert.equal(capturedPayload.symbol, "OVRD");
  assert.equal(capturedPayload.description, "Override description");
  assert.equal(result.tokenPageUrl, "https://tokens.fun/coin/0x1234567890abcdef1234567890abcdef12345678");
});

test("existing-app validation falls back website to appUrl", async () => {
  const result = await validateExistingAppToken(
    {
      name: "Swap Flow",
      symbol: "SWAP",
      appUrl: "https://app.swapflow.xyz",
      creatorWallet: "0x1234567890123456789012345678901234567890"
    },
    {
      configOptions: {
        env: createEnv()
      }
    }
  );

  assert.equal(result.valid, true);
  assert.equal(result.normalizedPayload.website, "https://app.swapflow.xyz");
});

test("upload_token_image rejects invalid file types", async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, "logo.txt");
  await writeFile(file, "not an image");

  await assert.rejects(
    uploadImage(
      { imagePath: file },
      {
        configOptions: {
          env: createEnv(),
          cwd: dir
        },
        fetchImpl: async () => {
          throw new Error("should not call fetch");
        }
      }
    ),
    /JPG, PNG, GIF, or WebP/
  );
});

test("deploy_existing_app_token requires appUrl after inference", async () => {
  const dir = await makeTempDir();
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "no-url-app" }));

  await assert.rejects(
    deployExistingAppToken(
      {
        projectDir: dir,
        creatorWallet: "0x1234567890123456789012345678901234567890"
      },
      {
        fetchImpl: async () => {
          throw new Error("should not call fetch");
        },
        configOptions: {
          env: createEnv(),
          cwd: dir
        }
      }
    ),
    /payload is invalid/
  );
});

test("deploy_existing_app_token rejects invalid wallet", async () => {
  const result = await validateExistingAppToken(
    {
      name: "Swap Flow",
      symbol: "SWAP",
      appUrl: "https://swapflow.xyz",
      creatorWallet: "0x123"
    },
    {
      configOptions: {
        env: createEnv({ MINIDEV_CREATOR_WALLET: "" })
      }
    }
  );

  assert.equal(result.valid, false);
  assert.match(result.errors[0], /valid Ethereum address/);
});

test("upload_token_image rejects oversized files", async () => {
  const dir = await makeTempDir();
  const file = path.join(dir, "logo.png");
  await fs.writeFile(file, Buffer.alloc(5 * 1024 * 1024 + 1));

  await assert.rejects(
    uploadImage(
      { imagePath: file },
      {
        configOptions: {
          env: createEnv()
        },
        fetchImpl: async () => {
          throw new Error("should not call fetch");
        }
      }
    ),
    /5 MB/
  );
});

test("validateVaultTool handles valid single and multi recipient configs", async () => {
  const single = await validateVaultTool({
    vault: {
      percentage: 10,
      lockupDays: 30,
      recipient: "0x1234567890123456789012345678901234567890"
    }
  });
  const multi = await validateVaultTool({
    vault: {
      percentage: 15,
      lockupDays: 30,
      recipients: [
        { address: "0x1234567890123456789012345678901234567890", percentage: 10 },
        { address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", percentage: 5 }
      ]
    }
  });

  assert.equal(single.valid, true);
  assert.equal(single.normalizedVault.percentage, 10);
  assert.equal(multi.valid, true);
  assert.equal(multi.normalizedVault.recipients.length, 2);
});

test("validateVaultTool catches invalid vault shapes", async () => {
  const badRange = await validateVaultTool({
    vault: {
      percentage: 101,
      lockupDays: 30,
      recipient: "0x1234567890123456789012345678901234567890"
    }
  });
  const badLockup = await validateVaultTool({
    vault: {
      percentage: 10,
      lockupDays: 3,
      recipient: "0x1234567890123456789012345678901234567890"
    }
  });
  const badWallet = await validateVaultTool({
    vault: {
      percentage: 10,
      lockupDays: 30,
      recipient: "0x123"
    }
  });
  const mismatch = await validateVaultTool({
    vault: {
      percentage: 10,
      lockupDays: 30,
      recipients: [{ address: "0x1234567890123456789012345678901234567890", percentage: 9 }]
    }
  });

  assert.equal(badRange.valid, false);
  assert.equal(badLockup.valid, false);
  assert.equal(badWallet.valid, false);
  assert.equal(mismatch.valid, false);
});

test("getConfigStatus reports env-backed config without secrets", async () => {
  const result = await getConfigStatus({
    configOptions: {
      env: createEnv()
    }
  });

  assert.equal(result.source, "env");
  assert.equal(result.hasApiKey, true);
  assert.equal(Object.prototype.hasOwnProperty.call(result, "apiKey"), false);
});

test("getConfigStatus falls back to config file", async () => {
  const dir = await makeTempDir();
  await writeFile(
    path.join(dir, "minidev", "config.json"),
    JSON.stringify({
      apiKey: "mk_file",
      creatorWallet: "0x1234567890123456789012345678901234567890",
      creatorEmail: "file@example.com"
    })
  );

  const result = await getConfigStatus({
    configOptions: {
      env: {},
      cwd: dir,
      serverDir: __dirname
    }
  });

  assert.match(result.source, /config\.json/);
  assert.equal(result.hasApiKey, true);
  assert.equal(result.hasCreatorEmail, true);
});

test("showCreatorIdentity warns when wallet or email is missing", async () => {
  const result = await showCreatorIdentity({
    configOptions: {
      env: createEnv({ MINIDEV_CREATOR_WALLET: "", MINIDEV_CREATOR_EMAIL: "" })
    }
  });

  assert.equal(result.creatorWallet, "");
  assert.equal(result.creatorEmail, "");
  assert.equal(result.warnings.length, 2);
});

test("validate_api_key_connection reports success and auth failure", async () => {
  const good = await validateApiKeyConnection({
    fetchImpl: createFetchStub(() =>
      jsonResponse(200, {
        success: true,
        credits: 50,
        walletAddress: "0x1234567890123456789012345678901234567890",
        unlimited: false
      })
    ),
    configOptions: {
      env: createEnv()
    }
  });

  const bad = await validateApiKeyConnection({
    fetchImpl: createFetchStub(() =>
      jsonResponse(401, { error: "Invalid API key", message: "The provided API key is invalid" })
    ),
    configOptions: {
      env: createEnv()
    }
  });

  assert.equal(good.valid, true);
  assert.equal(bad.valid, false);
  assert.match(bad.message, /invalid/i);
});

test("listProjects returns projects and pagination", async () => {
  const result = await listProjects(
    { limit: 5, offset: 10 },
    {
      fetchImpl: createFetchStub(() =>
        jsonResponse(200, {
          success: true,
          projects: [{ id: "p1", name: "Swap Flow" }],
          pagination: { total: 1, limit: 5, offset: 10, hasMore: false }
        })
      ),
      configOptions: {
        env: createEnv()
      }
    }
  );

  assert.equal(result.projects.length, 1);
  assert.equal(result.pagination.offset, 10);
});

test("healthCheck reports mixed readiness states", async () => {
  const result = await healthCheck({
    fetchImpl: createFetchStub(() =>
      jsonResponse(401, { error: "Invalid API key", message: "The provided API key is invalid" })
    ),
    configOptions: {
      env: createEnv({ MINIDEV_CREATOR_EMAIL: "" })
    }
  });

  assert.equal(result.checks.apiKeyConfigured.ok, true);
  assert.equal(result.checks.creatorIdentity.ok, false);
  assert.equal(result.checks.auth.ok, false);
  assert.equal(result.ready, false);
});

test("explain_missing_setup distinguishes deploy and upload actions", async () => {
  const dir = await makeTempDir();
  const deploy = await callTool(
    "tokensfun_explain_missing_setup",
    { action: "deploy_existing_app_token" },
    {
      configOptions: {
        env: {},
        cwd: dir,
        homeDir: dir
      }
    }
  );
  const upload = await callTool(
    "tokensfun_explain_missing_setup",
    { action: "upload_token_image" },
    {
      configOptions: {
        env: {},
        cwd: dir,
        homeDir: dir
      }
    }
  );

  assert.ok(deploy.missing.includes("appUrl"));
  assert.ok(upload.missing.includes("MINIDEV_API_KEY"));
});

test("network errors are surfaced as readable MCP tool errors", async () => {
  const response = await handleRpcRequest(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "tokensfun_check_credits",
        arguments: {}
      }
    },
    {
      fetchImpl: createFetchStub(() =>
        jsonResponse(401, { error: "Invalid API key", message: "The provided API key is invalid" })
      ),
      configOptions: {
        env: createEnv()
      }
    }
  );

  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /invalid/i);
});

test("end-to-end existing app flow returns token page and basescan URLs", async () => {
  const dir = await makeTempDir();
  const imagePath = path.join(dir, "logo.png");
  await writeFile(
    path.join(dir, "package.json"),
    JSON.stringify(
      {
        name: "swap-flow",
        description: "A DEX aggregator for Base",
        homepage: "https://swapflow.xyz"
      },
      null,
      2
    )
  );
  await writeFile(path.join(dir, ".env.production"), "APP_URL=https://app.swapflow.xyz\n");
  await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const fetchStub = createFetchStub((url, init) => {
    if (url.endsWith("/api/upload-image")) {
      return jsonResponse(200, {
        success: true,
        url: "https://gateway.pinata.cloud/ipfs/QmImage",
        tokenURI: "ipfs://QmMetadata",
        imageCID: "QmImage",
        metadataCID: "QmMetadata"
      });
    }
    if (url.endsWith("/api/v1/token/deploy")) {
      const payload = JSON.parse(init.body);
      assert.equal(payload.appUrl, "https://app.swapflow.xyz");
      assert.equal(payload.website, "https://swapflow.xyz");
      assert.equal(payload.imageUrl, "https://gateway.pinata.cloud/ipfs/QmImage");
      return jsonResponse(200, {
        success: true,
        tokenAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        txHash: "0xtxhash",
        urls: {
          tokenPage: "https://tokens.fun/coin/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          basescan: "https://basescan.org/token/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd"
        }
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  const result = await callTool(
    "tokensfun_deploy_existing_app_token",
    {
      projectDir: dir,
      creatorWallet: "0x1234567890123456789012345678901234567890",
      imagePath
    },
    {
      fetchImpl: fetchStub,
      configOptions: {
        env: createEnv(),
        cwd: dir
      }
    }
  );

  assert.equal(result.tokenPageUrl, "https://tokens.fun/coin/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  assert.equal(result.baseScanUrl, "https://basescan.org/token/0xabcdefabcdefabcdefabcdefabcdefabcdefabcd");
  assert.equal(result.payloadUsed.symbol, "SWAP");
});

test("legacy and tokensfun aliases resolve to the same behavior", async () => {
  const inspectLegacy = await callTool("minidev_inspect_existing_app", {}, {});
  const inspectNew = await callTool("tokensfun_inspect_existing_app", {}, {});

  assert.equal(typeof inspectLegacy.projectDir, "string");
  assert.equal(typeof inspectNew.projectDir, "string");
});

test("protocol smoke test covers initialize, tools/list, and legacy plus tokensfun tool calls", async () => {
  const initializeResponse = await handleRpcRequest({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0.0" }
    }
  });
  const toolsResponse = await handleRpcRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  });
  const legacyCall = await handleRpcRequest(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "minidev_get_config_status",
        arguments: {}
      }
    },
    {
      configOptions: {
        env: createEnv()
      }
    }
  );
  const tokensfunCall = await handleRpcRequest(
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "tokensfun_show_creator_identity",
        arguments: {}
      }
    },
    {
      configOptions: {
        env: createEnv()
      }
    }
  );

  assert.equal(initializeResponse.result.serverInfo.name, "tokensfun-mcp");
  assert.equal(toolsResponse.result.tools.length, 28);
  assert.equal(legacyCall.result.structuredContent.hasApiKey, true);
  assert.equal(tokensfunCall.result.structuredContent.creatorEmail, "hello@example.com");

  const chunks = [];
  const fakeStream = {
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
    }
  };
  writeRpcMessage(fakeStream, {
    jsonrpc: "2.0",
    id: 99,
    result: { ok: true }
  });
  const wirePayload = Buffer.concat(chunks).toString("utf8");
  assert.match(wirePayload, /^Content-Length: \d+\r\n\r\n/);
  assert.match(wirePayload, /"id":99/);
});

test("setup helpers build config, help output, and startup banner for Claude Code usage", async () => {
  assert.deepEqual(
    createSetupConfig({
      apiKey: " mk_test ",
      creatorWallet: " 0x1234567890123456789012345678901234567890 ",
      creatorEmail: " hello@example.com "
    }),
    {
      apiKey: "mk_test",
      creatorWallet: "0x1234567890123456789012345678901234567890",
      creatorEmail: "hello@example.com"
    }
  );

  assert.deepEqual(
    createSetupConfig({
      apiKey: "mk_test",
      creatorWallet: "0x1234567890123456789012345678901234567890",
      creatorEmail: ""
    }),
    {
      apiKey: "mk_test",
      creatorWallet: "0x1234567890123456789012345678901234567890"
    }
  );

  const helpChunks = [];
  printHelp({
    write(chunk) {
      helpChunks.push(String(chunk));
    }
  });
  const helpText = helpChunks.join("");
  assert.match(helpText, /--setup/);
  assert.match(helpText, /MINIDEV_API_KEY/);
  assert.match(helpText, /MINIDEV_CREATOR_WALLET/);
  assert.match(helpText, /MINIDEV_CREATOR_EMAIL/);

  const banner = getStartupBanner();
  assert.match(banner, /Claude Code/i);
  assert.match(banner, /--setup/);
});

test("startServer announces stdio mode and emits parse errors on invalid JSON frames", async () => {
  const input = new EventEmitter();
  const stdoutChunks = [];
  const stderrChunks = [];

  startServer(
    {},
    {
      input,
      output: {
        write(chunk) {
          stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8"));
        }
      },
      error: {
        write(chunk) {
          stderrChunks.push(String(chunk));
        }
      }
    }
  );

  const banner = stderrChunks.join("");
  assert.match(banner, /listening on stdio for MCP requests/i);
  assert.match(banner, /This is normal/i);
  assert.match(banner, /--setup/);

  input.emit("data", Buffer.from("Content-Length: 3\r\n\r\nbad", "utf8"));
  await new Promise((resolve) => setImmediate(resolve));

  const wirePayload = Buffer.concat(stdoutChunks).toString("utf8");
  assert.match(wirePayload, /^Content-Length: \d+\r\n\r\n/);
  assert.match(wirePayload, /"code":-32700/);
});
