import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const equal = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export class BridgeAuth {
  private sessions = new Map<string, number>();
  private attempts = new Map<string, { count: number; until: number }>();
  constructor(
    readonly apiToken: string,
    private readonly accessCode: string,
  ) {}

  private sessionId(request: IncomingMessage): string {
    return (
      (request.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("bridge_session="))
        ?.slice(15) ?? ""
    );
  }

  authorized(request: IncomingMessage): boolean {
    const bearer = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice(7)
      : "";
    const key = request.headers["x-api-key"];
    if (equal(bearer, this.apiToken) || (typeof key === "string" && equal(key, this.apiToken)))
      return true;
    const id = this.sessionId(request),
      expires = this.sessions.get(id);
    if (expires && expires > Date.now()) return true;
    if (expires) this.sessions.delete(id);
    return false;
  }

  login(request: IncomingMessage, response: ServerResponse, code: unknown): boolean {
    const now = Date.now(),
      address = request.socket.remoteAddress ?? "unknown";
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    const previous = this.attempts.get(address) ?? { count: 0, until: now + 60_000 };
    if (previous.count >= 5 || this.attempts.size > 1000) {
      response.setHeader("Retry-After", "60");
      response.statusCode = 429;
      return false;
    }
    previous.count++;
    this.attempts.set(address, previous);
    const normalized = typeof code === "string" ? code.replace(/[ -]/g, "").toLowerCase() : "";
    if (!equal(normalized, this.accessCode)) {
      response.statusCode = 401;
      return false;
    }
    this.attempts.delete(address);
    for (const [key, expires] of this.sessions) if (expires <= now) this.sessions.delete(key);
    if (this.sessions.size >= 100) this.sessions.delete(this.sessions.keys().next().value!);
    const session = randomBytes(32).toString("hex");
    this.sessions.set(session, now + 86400_000);
    // Local HTTP is supported. A TLS reverse proxy should also set Secure on this cookie.
    response.setHeader(
      "Set-Cookie",
      "bridge_session=" + session + "; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400",
    );
    return true;
  }

  logout(request: IncomingMessage, response: ServerResponse): void {
    this.sessions.delete(this.sessionId(request));
    response.setHeader(
      "Set-Cookie",
      "bridge_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
  }
}
