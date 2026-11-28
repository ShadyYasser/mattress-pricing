// Pushes prices from the pricing site to the Shopify store (owner only).
// Mattress variants are matched by SKU EMB-{prefix}-{width}-{height}; trader materials by product handle.
// Secrets (Supabase → Edge Functions → Secrets): SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET
// (Dev Dashboard app installed on the store, scopes read_products + write_products).
// Optional: SHOPIFY_SHOP (default r8d1p5-nu), SHOPIFY_ADMIN_TOKEN (legacy admin-created app token).
import { createClient } from "npm:@supabase/supabase-js@2";

const API_VERSION = "2026-10";
const SHOP = (Deno.env.get("SHOPIFY_SHOP") || "r8d1p5-nu").replace(/\.myshopify\.com$/, "");
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "sb_publishable_LN6iGi6CxEvm6HZHC6fIrQ_6iuhmfd9";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

type Mattress = { name: string; prefix: string; height: number; widths: number[]; mine: number[]; offer: number[] | null };
type Trader = { name: string; handle: string; price: number };
type Want = { price: number; compare?: number | null; label: string };

let cachedToken: { token: string; exp: number } | null = null;
async function shopToken(): Promise<string | null> {
  const legacy = Deno.env.get("SHOPIFY_ADMIN_TOKEN");
  if (legacy) return legacy;
  const id = Deno.env.get("SHOPIFY_CLIENT_ID"), secret = Deno.env.get("SHOPIFY_CLIENT_SECRET");
  if (!id || !secret) return null;
  if (cachedToken && cachedToken.exp > Date.now() + 60_000) return cachedToken.token;
  const r = await fetch(`https://${SHOP}.myshopify.com/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: id, client_secret: secret }),
  });
  if (!r.ok) throw new Error(`token_failed (${r.status}) ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  cachedToken = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cachedToken.token;
}

async function gql(token: string, query: string, variables: Record<string, unknown> = {}) {
  const r = await fetch(`https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (!r.ok) throw new Error(`shopify_http_${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  if (j.errors?.length) throw new Error("shopify: " + j.errors.map((e: { message: string }) => e.message).join("; "));
  return j.data;
}

const PRODUCTS_Q = `query($after:String){products(first:50,after:$after){pageInfo{hasNextPage endCursor}
  nodes{id title handle variants(first:100){nodes{id title sku price compareAtPrice}}}}}`;

async function allProducts(token: string) {
  const out: any[] = [];
  let after: string | null = null;
  for (let i = 0; i < 20; i++) {
    const d = await gql(token, PRODUCTS_Q, { after });
    out.push(...d.products.nodes);
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }
  return out;
}

const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const same = (a: string | null | undefined, b: number | null | undefined) =>
  (a == null || a === "" ? null : Number(a)) === (b == null ? null : Number(b));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  // Owner check with the caller's own session (RLS-backed my_role()).
  const auth = req.headers.get("Authorization") || "";
  if (!auth.startsWith("Bearer ")) return json({ error: "not_signed_in" }, 401);
  const sb = createClient(SB_URL, SB_KEY, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: u, error: ue } = await sb.auth.getUser(auth.slice(7));
  if (ue || !u?.user) return json({ error: "not_signed_in" }, 401);
  const { data: role } = await sb.rpc("my_role");
  if (role !== "owner") return json({ error: "not_owner" }, 403);

  let body: { action?: string; mattresses?: Mattress[]; traders?: Trader[]; compareAt?: boolean };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const action = body.action === "push" ? "push" : "preview";

  try {
    const token = await shopToken();
    if (!token) return json({ configured: false });

    // Wanted prices by SKU and by handle.
    const bySku = new Map<string, Want>();
    const dupSku: string[] = [];
    for (const m of body.mattresses || []) {
      if (!m.prefix) continue;
      m.widths.forEach((w, i) => {
        const sku = `EMB-${m.prefix}-${w}-${m.height}`;
        if (bySku.has(sku)) dupSku.push(`${sku} (${m.name})`);
        const want: Want = { price: m.mine[i], label: `${m.name} — ${w}` };
        if (body.compareAt) want.compare = m.offer && m.offer[i] > m.mine[i] ? m.offer[i] : null;
        bySku.set(sku, want);
      });
    }
    const byHandle = new Map<string, Trader>();
    for (const t of body.traders || []) if (t.handle) byHandle.set(t.handle, t);

    const products = await allProducts(token);
    const changes: any[] = [];
    const updates = new Map<string, { title: string; variants: any[] }>();
    const usedSku = new Set<string>(), usedHandle = new Set<string>(), unmatchedShop: string[] = [];
    let sameCount = 0;

    for (const p of products) {
      const trader = byHandle.get(p.handle);
      if (trader) usedHandle.add(p.handle);
      for (const v of p.variants.nodes) {
        let want: Want | undefined;
        if (trader) want = { price: trader.price, label: trader.name };
        else if (v.sku && bySku.has(v.sku)) { want = bySku.get(v.sku); usedSku.add(v.sku); }
        if (!want) {
          if (v.sku && v.sku.startsWith("EMB-")) unmatchedShop.push(`${p.title} — ${v.title} (${v.sku})`);
          continue;
        }
        const priceChanged = !same(v.price, want.price);
        const compareChanged = want.compare !== undefined && !same(v.compareAtPrice, want.compare);
        if (!priceChanged && !compareChanged) { sameCount++; continue; }
        changes.push({
          product: p.title, variant: v.title === "Default Title" ? "" : v.title, sku: v.sku,
          oldPrice: v.price, newPrice: want.price,
          compareChanged, oldCompare: v.compareAtPrice, newCompare: want.compare ?? null,
        });
        const input: Record<string, unknown> = { id: v.id, price: money(want.price) };
        if (want.compare !== undefined) input.compareAtPrice = want.compare == null ? null : money(want.compare);
        if (!updates.has(p.id)) updates.set(p.id, { title: p.title, variants: [] });
        updates.get(p.id)!.variants.push(input);
      }
    }
    const unmatchedSite = [
      ...[...bySku.entries()].filter(([s]) => !usedSku.has(s)).map(([s, w]) => `${w.label} (${s})`),
      ...[...byHandle.values()].filter((t) => !usedHandle.has(t.handle)).map((t) => `${t.name} (handle: ${t.handle})`),
      ...dupSku.map((d) => `مكرر: ${d}`),
    ];

    if (action === "preview") return json({ configured: true, changes, same: sameCount, unmatchedShop, unmatchedSite });

    let updated = 0;
    const failed: { product: string; message: string }[] = [];
    for (const [productId, u] of updates) {
      try {
        const d = await gql(token,
          `mutation($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants,allowPartialUpdates:true){productVariants{id} userErrors{field message}}}`,
          { productId, variants: u.variants });
        const r = d.productVariantsBulkUpdate;
        if (r.userErrors?.length) failed.push({ product: u.title, message: r.userErrors.map((e: { message: string }) => e.message).join("; ") });
        updated += r.productVariants?.length || 0;
      } catch (e) {
        failed.push({ product: u.title, message: String((e as Error).message || e) });
      }
    }
    return json({ configured: true, updated, failed, changes, same: sameCount, unmatchedShop, unmatchedSite });
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
