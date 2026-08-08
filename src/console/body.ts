import type { IncomingMessage } from "node:http";

/** Body-read failure the router can map to a 4xx instead of a 500. */
export class BodyError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "BodyError";
  }
}

const DEFAULT_JSON_LIMIT = 1024 * 1024; // 1 MiB — API bodies are small

export async function readRawBody(
  req: IncomingMessage,
  options: { limitBytes: number },
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > options.limitBytes) {
      throw new BodyError(
        `request body exceeds ${options.limitBytes} bytes`,
        413,
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export async function readJsonBody(
  req: IncomingMessage,
  options?: { limitBytes?: number },
): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req, {
    limitBytes: options?.limitBytes ?? DEFAULT_JSON_LIMIT,
  });
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new BodyError("request body is not valid JSON", 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BodyError("request body must be a JSON object", 400);
  }
  return parsed as Record<string, unknown>;
}
