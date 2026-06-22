// Network-layer checks — dns, tcp, ping. Declarative, no browser, no external dep
// (Node's dns + net stdlib). Each reuses the SSL pattern: parse the host from the
// check's target_url, probe, and return { verdict, durationMs, message } that
// index.ts maps onto the run-status taxonomy and records (message -> error_message
// for visibility, on pass too).
//
// PING IS TCP-REACHABILITY, NOT ICMP. ACA Container Apps grants no CAP_NET_RAW (no
// privileged containers / capability adds), and raw or unprivileged ICMP needs it
// — so a real ICMP ping would EPERM in the runner. The 'ping' kind instead opens a
// TCP connection as a reachability proxy: a connect OR a refusal (RST) means the
// host responded => reachable; a timeout or host-unreachable means it didn't. This
// is the meaningful difference from 'tcp' (which cares whether the PORT is open).
import dns from 'node:dns';
import net from 'node:net';
import type { Check } from './db.js';

export interface NetResult {
  verdict: 'pass' | 'fail' | 'error';
  durationMs: number;
  message: string;
}

const DNS_RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as const;
type DnsRecordType = (typeof DNS_RECORD_TYPES)[number];

interface NetConfigShape {
  recordType?: string;
  expectedValue?: string;
  port?: number;
}

/** Parse host (+ optional port) from target_url. Bare "host" / "host:port" / URL all work. */
function parseTarget(target: string): { host: string; urlPort: number | null } | null {
  try {
    const u = new URL(target.includes('://') ? target : `tcp://${target}`);
    if (!u.hostname) return null;
    return { host: u.hostname, urlPort: u.port ? Number(u.port) : null };
  } catch {
    return null;
  }
}

const errResult = (start: number, message: string): NetResult => ({
  verdict: 'error',
  durationMs: Date.now() - start,
  message,
});
const failResult = (start: number, message: string): NetResult => ({
  verdict: 'fail',
  durationMs: Date.now() - start,
  message,
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => {
        const e = new Error('timed out') as NodeJS.ErrnoException;
        e.code = 'SW_TIMEOUT';
        reject(e);
      }, ms),
    ),
  ]);
}

// --- DNS ------------------------------------------------------------------
async function resolveByType(host: string, type: DnsRecordType): Promise<string[]> {
  switch (type) {
    case 'A':
      return dns.promises.resolve4(host);
    case 'AAAA':
      return dns.promises.resolve6(host);
    case 'CNAME':
      return dns.promises.resolveCname(host);
    case 'NS':
      return dns.promises.resolveNs(host);
    case 'MX':
      return (await dns.promises.resolveMx(host)).map((r) => `${r.priority} ${r.exchange}`);
    case 'TXT':
      return (await dns.promises.resolveTxt(host)).map((chunks) => chunks.join(''));
  }
}

export async function runDnsCheck(check: Check): Promise<NetResult> {
  const start = Date.now();
  const t = parseTarget(check.target_url);
  if (!t) return errResult(start, `invalid target for dns check: "${check.target_url}"`);

  const cfg = (check.net_config ?? {}) as NetConfigShape;
  const recordType = (cfg.recordType ?? 'A').toUpperCase() as DnsRecordType;
  if (!DNS_RECORD_TYPES.includes(recordType)) {
    return errResult(start, `unsupported dns record type "${recordType}"`);
  }

  try {
    const values = await withTimeout(resolveByType(t.host, recordType), check.timeout_ms);
    if (values.length === 0) return failResult(start, `${recordType} ${t.host}: no records`);

    if (cfg.expectedValue) {
      const want = cfg.expectedValue;
      const matched = values.some((v) => v === want || v.includes(want));
      if (!matched) {
        return failResult(
          start,
          `${recordType} ${t.host} did not match "${want}" — got ${values.join(', ')}`,
        );
      }
    }
    return { verdict: 'pass', durationMs: Date.now() - start, message: `${recordType} ${t.host}: ${values.join(', ')}` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return failResult(start, `${recordType} ${t.host}: ${code} (NXDOMAIN / no records)`);
    }
    if (code === 'SW_TIMEOUT') {
      return errResult(start, `dns resolve for ${t.host} timed out after ${check.timeout_ms}ms`);
    }
    return errResult(start, `dns resolve for ${t.host} failed: ${code ?? (err as Error).message}`);
  }
}

// --- TCP connect (shared by tcp + ping) -----------------------------------
type TcpOutcome =
  | { kind: 'connect'; latencyMs: number }
  | { kind: 'refused'; latencyMs: number }
  | { kind: 'timeout' }
  | { kind: 'error'; code: string };

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<TcpOutcome> {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const finish = (o: TcpOutcome): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(o);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ kind: 'connect', latencyMs: Date.now() - start }));
    socket.once('timeout', () => finish({ kind: 'timeout' }));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      const code = err.code ?? 'ERR';
      if (code === 'ECONNREFUSED') finish({ kind: 'refused', latencyMs: Date.now() - start });
      else finish({ kind: 'error', code });
    });
  });
}

function resolvePort(t: { urlPort: number | null }, cfg: NetConfigShape, fallback?: number): number | null {
  return t.urlPort ?? cfg.port ?? fallback ?? null;
}

export async function runTcpCheck(check: Check): Promise<NetResult> {
  const start = Date.now();
  const t = parseTarget(check.target_url);
  if (!t) return errResult(start, `invalid target for tcp check: "${check.target_url}"`);
  const cfg = (check.net_config ?? {}) as NetConfigShape;
  const port = resolvePort(t, cfg);
  if (!port) return errResult(start, 'tcp check requires a port (target_url host:port or net_config.port)');

  const o = await tcpConnect(t.host, port, check.timeout_ms);
  switch (o.kind) {
    case 'connect':
      return { verdict: 'pass', durationMs: Date.now() - start, message: `connected to ${t.host}:${port} in ${o.latencyMs}ms` };
    case 'refused':
      return failResult(start, `tcp ${t.host}:${port}: connection refused (port closed)`);
    case 'timeout':
      return errResult(start, `tcp ${t.host}:${port}: connect timed out after ${check.timeout_ms}ms`);
    case 'error':
      return errResult(start, `tcp ${t.host}:${port}: ${o.code}`);
  }
}

export async function runPingCheck(check: Check): Promise<NetResult> {
  const start = Date.now();
  const t = parseTarget(check.target_url);
  if (!t) return errResult(start, `invalid target for ping check: "${check.target_url}"`);
  const cfg = (check.net_config ?? {}) as NetConfigShape;
  const port = resolvePort(t, cfg, 443) as number; // default 443

  const o = await tcpConnect(t.host, port, check.timeout_ms);
  switch (o.kind) {
    // Reachable: the host responded — either accepted (connect) or refused (RST).
    case 'connect':
      return { verdict: 'pass', durationMs: Date.now() - start, message: `${t.host} reachable (TCP ${port} open) in ${o.latencyMs}ms` };
    case 'refused':
      return { verdict: 'pass', durationMs: Date.now() - start, message: `${t.host} reachable (TCP ${port} closed/RST) in ${o.latencyMs}ms` };
    // No response: unreachable.
    case 'timeout':
      return failResult(start, `${t.host} unreachable (no TCP response on ${port} within ${check.timeout_ms}ms)`);
    case 'error':
      // DNS resolution failure is a config/infra error, not "host down".
      if (o.code === 'ENOTFOUND') return errResult(start, `${t.host}: DNS resolution failed (ENOTFOUND)`);
      return failResult(start, `${t.host} unreachable: ${o.code}`);
  }
}
