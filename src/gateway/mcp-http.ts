import crypto from "node:crypto";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { loadConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logDebug, logWarn } from "../logger.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import {
  clearActiveMcpLoopbackRuntimeByOwnerToken,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  setActiveMcpLoopbackRuntime,
} from "./mcp-http.loopback-runtime.js";
import { jsonRpcError, type JsonRpcRequest } from "./mcp-http.protocol.js";
import {
  readMcpHttpBody,
  resolveMcpRequestContext,
  validateMcpLoopbackRequest,
} from "./mcp-http.request.js";
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";

export {
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  resolveMcpLoopbackBearerToken,
} from "./mcp-http.loopback-runtime.js";

type McpLoopbackServer = {
  port: number;
  close: () => Promise<void>;
};

let activeMcpLoopbackServer: McpLoopbackServer | undefined;
let activeMcpLoopbackServerPromise: Promise<McpLoopbackServer> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createMcpJsonParseError(error: unknown): Error & { code: "mcp_json_parse_error" } {
  return Object.assign(new Error("MCP JSON parse error"), {
    cause: error,
    code: "mcp_json_parse_error" as const,
  });
}

function isMcpJsonParseError(error: unknown): error is Error & { code: "mcp_json_parse_error" } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "mcp_json_parse_error"
  );
}

function parseMcpJsonBody(body: string): JsonRpcRequest | JsonRpcRequest[] {
  try {
    return JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
  } catch (error) {
    throw createMcpJsonParseError(error);
  }
}

function readJsonRpcRequestId(message: unknown) {
  if (!isRecord(message)) {
    return null;
  }
  const id = message.id;
  return typeof id === "string" || typeof id === "number" || id === null ? id : undefined;
}

function isJsonRpcRequest(message: unknown): message is JsonRpcRequest {
  return isRecord(message) && message.jsonrpc === "2.0" && typeof message.method === "string";
}

function jsonRpcInternalError(parsed: JsonRpcRequest | JsonRpcRequest[] | undefined) {
  if (Array.isArray(parsed)) {
    return parsed.map((message) =>
      jsonRpcError(readJsonRpcRequestId(message), -32603, "Internal error"),
    );
  }
  return jsonRpcError(readJsonRpcRequestId(parsed), -32603, "Internal error");
}

function createRequestAbortSignal(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  const abortIfRequestIncomplete = () => {
    if (!req.complete) {
      abort();
    }
  };
  const abortIfResponseStillOpen = () => {
    if (!res.writableEnded) {
      abort();
    }
  };
  req.once("close", abortIfRequestIncomplete);
  res.once("close", abortIfResponseStillOpen);
  if (req.destroyed && !req.complete) {
    abort();
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off("close", abortIfRequestIncomplete);
      res.off("close", abortIfResponseStillOpen);
    },
  };
}

export async function startMcpLoopbackServer(port = 0): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const ownerToken = crypto.randomBytes(32).toString("hex");
  const nonOwnerToken = crypto.randomBytes(32).toString("hex");
  const toolCache = new McpLoopbackToolCache();

  const httpServer = createHttpServer((req, res) => {
    const auth = validateMcpLoopbackRequest({ req, res, ownerToken, nonOwnerToken });
    if (!auth) {
      return;
    }

    const requestAbort = createRequestAbortSignal(req, res);
    void (async () => {
      let parsed: JsonRpcRequest | JsonRpcRequest[] | undefined;
      try {
        const body = await readMcpHttpBody(req);
        parsed = parseMcpJsonBody(body);
        const cfg = loadConfig();
        const requestContext = resolveMcpRequestContext(req, cfg, auth);
        const scopedTools = toolCache.resolve({
          cfg,
          sessionKey: requestContext.sessionKey,
          messageProvider: requestContext.messageProvider,
          accountId: requestContext.accountId,
          senderIsOwner: requestContext.senderIsOwner,
        });

        const messages = Array.isArray(parsed) ? parsed : [parsed];
        const responses: object[] = [];
        for (const message of messages) {
          if (!isJsonRpcRequest(message)) {
            responses.push(jsonRpcError(readJsonRpcRequestId(message), -32600, "Invalid Request"));
            continue;
          }
          const response = await handleMcpJsonRpc({
            message,
            tools: scopedTools.tools,
            toolSchema: scopedTools.toolSchema,
            hookContext: {
              agentId: scopedTools.agentId,
              sessionKey: requestContext.sessionKey,
            },
            signal: requestAbort.signal,
          });
          if (response !== null) {
            responses.push(response);
          }
        }

        if (responses.length === 0) {
          res.writeHead(202);
          res.end();
          return;
        }

        const payload = Array.isArray(parsed)
          ? JSON.stringify(responses)
          : JSON.stringify(responses[0]);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(payload);
      } catch (error) {
        logWarn(`mcp loopback: request handling failed: ${formatErrorMessage(error)}`);
        if (!res.headersSent) {
          if (isMcpJsonParseError(error)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify(jsonRpcError(null, -32700, "Parse error")));
          } else {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify(jsonRpcInternalError(parsed)));
          }
        }
      } finally {
        requestAbort.cleanup();
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("mcp loopback did not bind to a TCP port");
  }
  setActiveMcpLoopbackRuntime({ port: address.port, ownerToken, nonOwnerToken });
  logDebug(`mcp loopback listening on 127.0.0.1:${address.port}`);

  const server: McpLoopbackServer = {
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (!error) {
            clearActiveMcpLoopbackRuntimeByOwnerToken(ownerToken);
            if (activeMcpLoopbackServer === server) {
              activeMcpLoopbackServer = undefined;
            }
          }
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
  return server;
}

export async function ensureMcpLoopbackServer(port = 0): Promise<McpLoopbackServer> {
  if (activeMcpLoopbackServer) {
    return activeMcpLoopbackServer;
  }
  if (!activeMcpLoopbackServerPromise) {
    activeMcpLoopbackServerPromise = startMcpLoopbackServer(port)
      .then((server) => {
        activeMcpLoopbackServer = server;
        return server;
      })
      .finally(() => {
        activeMcpLoopbackServerPromise = null;
      });
  }
  return activeMcpLoopbackServerPromise;
}

export async function closeMcpLoopbackServer(): Promise<void> {
  const server =
    activeMcpLoopbackServer ??
    (activeMcpLoopbackServerPromise ? await activeMcpLoopbackServerPromise : undefined);
  if (!server) {
    return;
  }
  activeMcpLoopbackServer = undefined;
  await server.close();
}
