// SSL/TLS certificate-expiry check — declarative, no browser, no external dep.
//
// Opens a TLS handshake to the target host:port, reads the leaf certificate, and
// maps days-until-notAfter to the run-status taxonomy:
//   - valid & > cert_expiry_warn_days remaining  -> pass
//   - valid & within the warn window (>= 0 days)  -> warn  (degraded-but-available)
//   - expired (notAfter in the past)              -> fail
//   - invalid (self-signed / untrusted / hostname mismatch) -> fail
//   - unreachable / handshake error / timeout     -> error
//
// We connect with rejectUnauthorized:false so the handshake COMPLETES even for a
// bad cert — that lets us read notAfter (to report days-remaining) AND the
// validation verdict (socket.authorized / authorizationError) and classify
// precisely. The days-remaining is returned in `message` so it's recorded on the
// run (error_message) for the dashboard, regardless of pass/warn/fail.
import tls from 'node:tls';
import net from 'node:net';
import type { Check } from './db.js';

export interface SslResult {
  verdict: 'pass' | 'warn' | 'fail' | 'error';
  durationMs: number;
  daysRemaining: number | null;
  message: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse host + port from the check's target_url (https:// optional; default 443). */
function hostPort(target: string): { host: string; port: number } | null {
  try {
    const u = new URL(target.includes('://') ? target : `https://${target}`);
    if (!u.hostname) return null;
    return { host: u.hostname, port: u.port ? Number(u.port) : 443 };
  } catch {
    return null;
  }
}

/** Extract a short, stable code from a TLS authorization error. */
function authErrorCode(err: unknown): string {
  if (!err) return 'cert not authorized';
  if (typeof err === 'string') return err;
  const e = err as { code?: string; message?: string };
  return e.code ?? e.message ?? 'cert not authorized';
}

export function runSslCheck(check: Check): Promise<SslResult> {
  const start = Date.now();
  const hp = hostPort(check.target_url);
  if (!hp) {
    return Promise.resolve({
      verdict: 'error',
      durationMs: Date.now() - start,
      daysRemaining: null,
      message: `invalid target_url for ssl check: "${check.target_url}"`,
    });
  }
  const warnDays = check.cert_expiry_warn_days ?? 30;

  return new Promise<SslResult>((resolve) => {
    let settled = false;
    const finish = (r: SslResult): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already closed */
      }
      resolve(r);
    };

    const socket = tls.connect({
      host: hp.host,
      port: hp.port,
      // SNI — required for vhosts / most modern endpoints. Omit for IP literals
      // (SNI with an IP is invalid per RFC 6066 and warns).
      ...(net.isIP(hp.host) === 0 ? { servername: hp.host } : {}),
      rejectUnauthorized: false, // complete handshake even for bad certs, then classify
      timeout: check.timeout_ms,
    });

    socket.once('secureConnect', () => {
      const durationMs = Date.now() - start;
      const cert = socket.getPeerCertificate();
      if (!cert || Object.keys(cert).length === 0 || !cert.valid_to) {
        return finish({
          verdict: 'error',
          durationMs,
          daysRemaining: null,
          message: 'no peer certificate presented',
        });
      }

      const notAfter = new Date(cert.valid_to);
      const daysRemaining = Math.floor((notAfter.getTime() - Date.now()) / DAY_MS);
      const expires = `expires ${cert.valid_to} (${daysRemaining}d)`;

      // Expired first (clearest message), regardless of other validation errors.
      if (daysRemaining < 0) {
        return finish({
          verdict: 'fail',
          durationMs,
          daysRemaining,
          message: `cert EXPIRED ${-daysRemaining}d ago — ${cert.valid_to}`,
        });
      }

      // Not-yet-expired but failed validation (self-signed, untrusted chain,
      // hostname mismatch, …) -> the cert is bad => fail.
      if (!socket.authorized) {
        return finish({
          verdict: 'fail',
          durationMs,
          daysRemaining,
          message: `cert invalid: ${authErrorCode(socket.authorizationError)} — ${expires}`,
        });
      }

      // Valid cert: warn if inside the expiry window, else pass. Either way the
      // message carries the days-remaining for the dashboard.
      if (daysRemaining <= warnDays) {
        return finish({
          verdict: 'warn',
          durationMs,
          daysRemaining,
          message: `cert ${expires} — within ${warnDays}d warn window`,
        });
      }
      return finish({
        verdict: 'pass',
        durationMs,
        daysRemaining,
        message: `cert valid, ${expires}`,
      });
    });

    socket.once('timeout', () =>
      finish({
        verdict: 'error',
        durationMs: Date.now() - start,
        daysRemaining: null,
        message: `TLS connect timed out after ${check.timeout_ms}ms`,
      }),
    );

    socket.once('error', (err: NodeJS.ErrnoException) =>
      finish({
        verdict: 'error',
        durationMs: Date.now() - start,
        daysRemaining: null,
        message: `TLS connect failed: ${err.code ?? err.message}`,
      }),
    );
  });
}
