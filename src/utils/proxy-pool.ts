import { Dispatcher, fetch, ProxyAgent } from 'undici';
import { BROWSER_UA } from './http';

/**
 * A route to a site that refuses this server's own connections: straight to the site when that
 * works, else through configured proxies, else through free public proxies found and tested on
 * demand. Every HTTPS request goes through the proxy as a CONNECT tunnel, so TLS stays end to end
 * with the site's certificate checked: a proxy only sees the host name and can neither read nor
 * change what is sent or received.
 */
export interface ProxyPoolOptions {
  /** Shown in errors and logs, e.g. "INEGI" */
  name: string;
  /** A small page of the site, fetched to test a route */
  testUrl: string;
  /** Text the test page must contain (a proxy's own error page doesn't count) */
  testMarker: string;
  /** Proxy URLs to use instead of free ones, e.g. "http://user:pass@host:8080" */
  fixed: string[];
  /** The env var that sets `fixed`, named in errors, e.g. "INEGI_PROXY" */
  fixedEnv: string;
  /** Look for free public proxies when the site can't be reached directly and none are fixed */
  useFree: boolean;
  /** Lists of free proxies, one "ip:port" per line */
  freeLists?: string[];
}

/** A route: undefined is a direct connection */
export interface Route {
  label: string;
  dispatcher?: Dispatcher;
  /** When it last loaded the test page or served a request (free proxies) */
  okAt?: number;
}

const DEFAULT_FREE_LISTS = [
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&country=mx',
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text&country=us&timeout=3000',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
];
/** Whether the site answers directly is checked again after this long */
const DIRECT_RECHECK_MS = 30 * 60 * 1000;
/** Free proxies looked for per search; a new search starts in the background when fewer than LOW are left */
const WANT = 12;
const LOW = 4;
/** Free proxies die within minutes: one not confirmed for this long is tested again before it is handed out */
const RECHECK_MS = 60_000;
const RECHECK_TIMEOUT_MS = 6_000;
const TEST_TIMEOUT_MS = 10_000;
const TEST_CONCURRENCY = 40;
/** Candidates tested per search (lists hold thousands; most are dead) */
const MAX_CANDIDATES = 1500;

export class ProxyPool {
  private direct?: { ok: boolean; at: number };
  private ready: Route[] = [];
  private searching?: Promise<void>;
  private next = 0;

  constructor(private readonly options: ProxyPoolOptions) {}

  /** A route to use now; throws when there is none */
  async route(signal?: AbortSignal): Promise<Route> {
    const { fixed, fixedEnv, useFree, name } = this.options;
    if (fixed.length) {
      if (!this.ready.length) this.ready = fixed.map((url) => ({ label: `proxy ${redact(url)}`, dispatcher: new ProxyAgent(url) }));
      return this.ready[this.next++ % this.ready.length];
    }
    if (!this.direct || Date.now() - this.direct.at > DIRECT_RECHECK_MS) {
      this.direct = { ok: await this.works(undefined, signal), at: Date.now() };
    }
    if (this.direct.ok) return { label: 'direct' };
    if (!useFree) throw new Error(`${name} can't be reached from this server and no proxy is set (${fixedEnv}), and free proxies are turned off`);
    for (let searches = 0; searches < 2; ) {
      if (!this.ready.length) {
        await this.search(signal);
        searches++;
        if (!this.ready.length) break;
      }
      // Refill in the background while there are still some left
      if (this.ready.length < LOW) void this.search(undefined).catch(() => {});
      const route = this.ready[this.next++ % this.ready.length];
      if (Date.now() - (route.okAt ?? 0) < RECHECK_MS || (await this.works(route.dispatcher, signal, RECHECK_TIMEOUT_MS))) {
        route.okAt = Date.now();
        return route;
      }
      if (signal?.aborted) throw signal.reason;
      this.failed(route);
    }
    throw new Error(`${name} can't be reached from this server, and no working free proxy was found`);
  }

  /** Marks a route as having just served a request, so it isn't tested again before the next one */
  succeeded(route: Route): void {
    route.okAt = Date.now();
  }

  /** Drops a route that failed (a free proxy; fixed ones and direct are kept) */
  failed(route: Route): void {
    if (this.options.fixed.length || !route.dispatcher) {
      if (!route.dispatcher) this.direct = undefined;
      return;
    }
    this.ready = this.ready.filter((r) => r !== route);
    route.dispatcher.close().catch(() => {});
  }

  /** Whether the site's test page loads through `dispatcher` (direct when undefined) */
  private async works(dispatcher: Dispatcher | undefined, signal?: AbortSignal, timeoutMs = TEST_TIMEOUT_MS): Promise<boolean> {
    try {
      const res = await fetch(this.options.testUrl, {
        dispatcher,
        headers: { 'User-Agent': BROWSER_UA },
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
      if (!res.ok) return false;
      return (await res.text()).includes(this.options.testMarker);
    } catch {
      return false;
    }
  }

  /** Finds working free proxies; one search at a time, shared by every caller */
  private search(signal?: AbortSignal): Promise<void> {
    this.searching ??= this.find(signal).finally(() => (this.searching = undefined));
    return this.searching;
  }

  private async find(signal?: AbortSignal): Promise<void> {
    const candidates = new Set<string>();
    for (const list of this.options.freeLists?.length ? this.options.freeLists : DEFAULT_FREE_LISTS) {
      try {
        const res = await fetch(list, { signal: AbortSignal.timeout(20_000) });
        for (const line of (await res.text()).split(/\s+/)) if (/^\d{1,3}(\.\d{1,3}){3}:\d{2,5}$/.test(line)) candidates.add(line);
      } catch {
        // A list that doesn't load is skipped
      }
    }
    const queue = shuffle([...candidates]).slice(0, MAX_CANDIDATES);
    let i = 0;
    const found: Route[] = [];
    await Promise.all(
      Array.from({ length: TEST_CONCURRENCY }, async () => {
        while (i < queue.length && found.length < WANT && !signal?.aborted) {
          const address = queue[i++];
          const dispatcher = new ProxyAgent(`http://${address}`);
          if (await this.works(dispatcher, signal)) found.push({ label: `free proxy ${address}`, dispatcher, okAt: Date.now() });
          else dispatcher.close().catch(() => {});
        }
      })
    );
    // A background search can find proxies already in the pool
    const have = new Set(this.ready.map((r) => r.label));
    this.ready.push(...found.filter((r) => !have.has(r.label)));
  }
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** A proxy URL without its password, for logs */
const redact = (url: string) => url.replace(/\/\/([^:@/]+):[^@/]*@/, '//$1:***@');
