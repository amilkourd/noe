// Aiven PostgreSQL access. Lazy: nothing connects (or throws) at import time.
import { Pool, types, type PoolConfig } from "pg";

// NUMERIC (1700) and INT8/bigserial (20) -> JS numbers; timestamptz (1184) / timestamp (1114) -> ISO strings
types.setTypeParser(1700, (v: string) => (v === null ? null : parseFloat(v)) as unknown as number);
types.setTypeParser(20, (v: string) => (v === null ? null : parseInt(v, 10)) as unknown as number);
types.setTypeParser(1184, (v: string) => (v === null ? null : new Date(v).toISOString()) as unknown as string);
types.setTypeParser(1114, (v: string) => (v === null ? null : new Date(v + "Z").toISOString()) as unknown as string);

const g = globalThis as unknown as { __noePool?: Pool };

export function hasDb(): boolean {
  return !!process.env.DATABASE_URL;
}

/** Connection config shared by the pool and the LISTEN client (lib/bus.ts). */
export function pgConfig(): PoolConfig {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error("DATABASE_URL is not set (fill .env.local)");
  // AIVEN_CA_CERT: PEM (local .env.local). PROJECT_CA_CERT: base64 PEM injected by Aiven Runtime.
  const ca = process.env.AIVEN_CA_CERT
    ? process.env.AIVEN_CA_CERT.replace(/\\n/g, "\n")
    : process.env.PROJECT_CA_CERT
      ? Buffer.from(process.env.PROJECT_CA_CERT, "base64").toString()
      : null;
  let connectionString = raw;
  let hadSslMode = false;
  try {
    // sslmode in the URL would override our ssl object inside pg: strip it and configure ssl ourselves
    const u = new URL(raw);
    hadSslMode = u.searchParams.has("sslmode");
    u.searchParams.delete("sslmode");
    connectionString = u.toString();
  } catch {
    /* keep raw */
  }
  const ssl = ca ? { ca, rejectUnauthorized: true } : hadSslMode ? { rejectUnauthorized: false } : undefined;
  return { connectionString, ssl };
}

export function pool(): Pool {
  if (!g.__noePool) {
    const p = new Pool({ ...pgConfig(), max: Number(process.env.PG_POOL_MAX ?? 4), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    p.on("error", (err) => console.error("[db] idle client error", err.message));
    g.__noePool = p;
  }
  return g.__noePool;
}

export async function query<T = any>(sql: string, params?: unknown[]): Promise<T[]> {
  const r = await pool().query(sql, params as any[]);
  return r.rows as T[];
}

export async function one<T = any>(sql: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows[0] ?? null;
}
