import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { withDeadline } from "./deadline.js";

interface CrawlerResolver {
  reverse(ip: string): Promise<string[]>;
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  cancel(): void;
}

export interface VerifiedCrawlerOptions {
  getClientIp: (request: Request) => string | null | undefined;
  resolver?: () => CrawlerResolver;
}

export function createVerifiedCrawlerVerifier(options: VerifiedCrawlerOptions) {
  if (typeof options.getClientIp !== "function") throw new TypeError("getClientIp must be a function");
  if (options.resolver !== undefined && typeof options.resolver !== "function") throw new TypeError("resolver must be a function");
  const cache = new Map<string, { verified: boolean; expiresAt: number }>();

  return async function verifyCrawler(request: Request, signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    const agent = request.headers.get("user-agent") ?? "";
    const suffix = /\bGooglebot(?:-(?:Image|Video|News))?(?:\/|\b)/i.test(agent) ? ".googlebot.com"
      : /\bbingbot(?:\/|\b)/i.test(agent) ? ".search.msn.com" : null;
    if (!suffix) return false;
    const ip = options.getClientIp(request)?.trim();
    if (!ip || !isIP(ip)) return false;
    const address = canonicalIp(ip);
    const key = `${suffix}:${address}`;
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.verified;

    const resolver = options.resolver?.() ?? new Resolver({ timeout: 1000, tries: 1 });
    let verified = false;
    try {
      verified = await withDeadline(async operationSignal => {
        const cancel = () => resolver.cancel();
        operationSignal.addEventListener("abort", cancel, { once: true });
        try {
          const hosts = await resolver.reverse(ip);
          for (const name of hosts.slice(0, 8)) {
            const host = name.toLowerCase().replace(/\.$/, "");
            if (!host.endsWith(suffix) || !/^[a-z0-9.-]+$/.test(host)) continue;
            operationSignal.throwIfAborted();
            const addresses = isIP(ip) === 4 ? await resolver.resolve4(host) : await resolver.resolve6(host);
            if (addresses.some(value => isIP(value) && canonicalIp(value) === address)) return true;
          }
          return false;
        } finally {
          operationSignal.removeEventListener("abort", cancel);
        }
      }, 1500, signal);
    } catch {
      signal.throwIfAborted();
    }
    // Bound positive and negative entries so fake crawler IPs cannot grow memory without limit.
    cache.delete(key);
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
    cache.set(key, { verified, expiresAt: Date.now() + (verified ? 300000 : 30000) });
    return verified;
  };
}

function canonicalIp(ip: string): string {
  return isIP(ip) === 6 ? new URL(`http://[${ip}]/`).hostname : ip;
}
