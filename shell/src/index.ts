// Haven shell Worker — Batch 2: Google-only login + household.
//
// Serves the SPA (static assets via the ASSETS binding) and the /api/*
// routes. Module API routes are dispatched from the modules' server route
// tables; they receive the shell auth context (user + household) and run
// no auth of their own (spec §2).
//
// Auth (spec §2, §8–9; Cook Board §9): Google sign-in only, auth-code
// flow, scopes openid / email / profile. No email/password form, no
// passwords stored, no reset flow. The shell issues its own 90-day
// sliding session after Google sign-in; every module route checks it.
// The Batch 0 temporary local-only bypass is removed here: every /api/*
// route except /api/health and /api/auth/google requires a session, and
// the module routes additionally require household membership —
// a non-member reaches none.
import { kitchenApiRoutes } from "../../modules/kitchen/server/routes.js";
import {
  GOOGLE_REDIRECT_URIS,
  authSession,
  bearerToken,
  googleUserFromCode,
  householdFor,
  inviteLink,
  issueSession,
  nowIso,
  sha256Hex,
  uid,
  type AuthContext,
} from "./auth.js";

const VERSION = "0.1.9"; // D1 batch() on the hot paths

export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  GOOGLE_CLIENT_SECRET?: string;
}

interface ApiRoute {
  method: string;
  path: string;
  handler: (request: Request, env: Env, ctx: AuthContext | null) => Promise<Response> | Response;
}

const moduleRoutes: ApiRoute[] = [...kitchenApiRoutes];

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function err(error: string, status: number): Response {
  return Response.json({ ok: false, error }, { status });
}

async function readBody(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/health") {
      return Response.json({ ok: true, service: "haven", version: VERSION });
    }

    if (url.pathname.startsWith("/api/")) {
      // ---- Google sign-in (no password, no Turnstile) ----
      // POST /api/auth/google { code, redirect_uri }
      // Google already verified the user (bot check + email ownership),
      // so no Turnstile and no email verification are needed here.
      // Exchanges the code, reads the verified email + Google ID from
      // userinfo, then: (1) a user with this google_sub signs in as
      // themselves; (2) otherwise a user with this email gets the
      // google_sub linked (existing account, name kept — Google only
      // proves identity, it does not rename); (3) otherwise a new user
      // is created with the Google name (or the email prefix), no
      // password. Issues a 90-day sliding session, same shape as the
      // Don't Ngiao flow. The redirect_uri must be one of the exact
      // values registered in Google Cloud Console.
      if (url.pathname === "/api/auth/google" && request.method === "POST") {
        const body = await readBody(request);
        const code = typeof body.code === "string" ? body.code : "";
        const redirectUri = typeof body.redirect_uri === "string" ? body.redirect_uri : "";
        if (!code || !GOOGLE_REDIRECT_URIS.includes(redirectUri as never)) {
          return err("google_sign_in_failed", 400);
        }
        let g: { sub: string; email: string; email_verified: boolean; name: string };
        try {
          g = await googleUserFromCode(env, code, redirectUri);
        } catch (e: any) {
          console.error("google sign-in failed", e?.message || e);
          return err("google_sign_in_failed", 400);
        }
        if (!g.email_verified) return err("google_email_unverified", 400);
        const email = g.email.toLowerCase();
        let u: any = await env.DB.prepare("SELECT * FROM users WHERE google_sub = ?")
          .bind(g.sub)
          .first();
        let id: string;
        let name: string;
        let createdAt: string;
        if (u) {
          id = String(u.id);
          name = String(u.name);
          createdAt = String(u.created_at);
        } else {
          u = await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first();
          if (u) {
            id = String(u.id);
            name = String(u.name);
            createdAt = String(u.created_at);
            await env.DB.prepare("UPDATE users SET google_sub = ? WHERE id = ?")
              .bind(g.sub, id)
              .run();
          } else {
            id = uid();
            name = g.name || email.split("@")[0];
            createdAt = nowIso();
            try {
              await env.DB.prepare(
                "INSERT INTO users (id, name, email, google_sub, created_at) VALUES (?, ?, ?, ?, ?)",
              )
                .bind(id, name, email, g.sub, createdAt)
                .run();
            } catch (e) {
              console.error("google sign-in user insert failed", e);
              return err("google_sign_in_failed", 400);
            }
          }
        }
        const { token } = await issueSession(env, id);
        const household = await householdFor(env, id);
        return json({
          ok: true,
          user: { id, name, email, created_at: createdAt },
          token,
          household,
        });
      }

      // POST /api/auth/logout — deletes the session row; always ok, so a
      // stale token cannot keep the sign-out button spinning.
      if (url.pathname === "/api/auth/logout" && request.method === "POST") {
        const token = bearerToken(request);
        if (token) {
          const hash = await sha256Hex(token);
          try {
            await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(hash).run();
          } catch {}
        }
        return json({ ok: true });
      }

      // Everything below needs a valid session.
      const ctx = await authSession(request, env);
      if (!ctx) return err("unauthorized", 401);

      // GET /api/me — the signed-in user and their household (null when
      // signed in but not in a household yet).
      if (url.pathname === "/api/me" && request.method === "GET") {
        return json({ ok: true, user: ctx.user, household: ctx.household });
      }

      // GET /api/household — roster + invite link (any member may share
      // the link; only the creator may revoke it, below). The two reads
      // are independent (both keyed by the household id, known from the
      // auth context), so they run as one D1 batch round-trip.
      if (url.pathname === "/api/household" && request.method === "GET") {
        if (!ctx.household) return err("no_household", 403);
        const [inviteRes, membersRes] = await env.DB.batch([
          env.DB.prepare("SELECT invite_token FROM households WHERE id = ?")
            .bind(ctx.household.id),
          env.DB.prepare(
            "SELECT u.id AS id, u.name AS name, u.email AS email, m.role AS role, m.joined_at AS joined_at " +
              "FROM household_members m JOIN users u ON u.id = m.user_id " +
              "WHERE m.household_id = ? ORDER BY m.joined_at",
          ).bind(ctx.household.id),
        ]);
        const row: any = inviteRes.results[0];
        const members = membersRes.results;
        return json({
          ok: true,
          household: {
            id: ctx.household.id,
            name: ctx.household.name,
            creator_id: ctx.household.creator_id,
          },
          invite_link: row ? inviteLink(url.origin, String(row.invite_token)) : null,
          members,
        });
      }

      // POST /api/household { name } — create the household; the caller
      // becomes its creator. One household per user in v1.
      if (url.pathname === "/api/household" && request.method === "POST") {
        if (ctx.household) return err("already_in_household", 400);
        const body = await readBody(request);
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name || name.length > 100) return err("household_name_required", 400);
        const id = uid();
        const inviteToken = uid();
        const createdAt = nowIso();
        // The two inserts are independent (both use ids generated above),
        // so they run as one D1 batch round-trip. A batch is all-or-nothing
        // under workerd — if the member insert failed, the household insert
        // rolls back too — so this is strictly safer than the sequential
        // version, which could leave an orphan household row.
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO households (id, name, creator_id, invite_token, created_at) VALUES (?, ?, ?, ?, ?)",
          ).bind(id, name, ctx.user.id, inviteToken, createdAt),
          env.DB.prepare(
            "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES (?, ?, 'creator', ?)",
          ).bind(id, ctx.user.id, createdAt),
        ]);
        return json({
          ok: true,
          household: { id, name, role: "creator", creator_id: ctx.user.id },
          invite_link: inviteLink(url.origin, inviteToken),
        });
      }

      // POST /api/household/join { invite } — a signed-in user opening
      // an invite link joins the household. Revoking stops new joins
      // without removing existing members.
      if (url.pathname === "/api/household/join" && request.method === "POST") {
        if (ctx.household) return err("already_in_household", 400);
        const body = await readBody(request);
        const invite = typeof body.invite === "string" ? body.invite.trim() : "";
        if (!invite) return err("invite_required", 400);
        const h: any = await env.DB.prepare("SELECT * FROM households WHERE invite_token = ?")
          .bind(invite)
          .first();
        if (!h) return err("invite_not_found", 404);
        try {
          await env.DB.prepare(
            "INSERT INTO household_members (household_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)",
          )
            .bind(String(h.id), ctx.user.id, nowIso())
            .run();
        } catch {
          return err("invite_not_found", 404);
        }
        return json({
          ok: true,
          household: { id: String(h.id), name: String(h.name), role: "member" },
        });
      }

      // POST /api/household/invite/revoke — creator only; the old link
      // stops working for new joins, existing members are unaffected.
      if (url.pathname === "/api/household/invite/revoke" && request.method === "POST") {
        if (!ctx.household) return err("no_household", 403);
        if (ctx.household.role !== "creator") return err("forbidden", 403);
        const inviteToken = uid();
        await env.DB.prepare("UPDATE households SET invite_token = ? WHERE id = ?")
          .bind(inviteToken, ctx.household.id)
          .run();
        return json({ ok: true, invite_link: inviteLink(url.origin, inviteToken) });
      }

      // POST /api/household/leave — any member can leave at any time.
      // If the creator leaves and members remain, creator transfers to
      // the earliest-joined remaining member (Don't Ngiao precedent). If
      // the last member leaves, the household goes with them — its
      // invite link dies and there is nobody left to own it.
      if (url.pathname === "/api/household/leave" && request.method === "POST") {
        if (!ctx.household) return err("no_household", 403);
        const { results } = await env.DB.prepare(
          "SELECT user_id FROM household_members WHERE household_id = ? AND user_id != ? ORDER BY joined_at",
        )
          .bind(ctx.household.id, ctx.user.id)
          .all();
        if (results.length > 0 && ctx.household.role === "creator") {
          const nextId = String((results[0] as any).user_id);
          // The two transfer writes are independent (same known ids), so
          // they run as one batch round-trip; a batch is all-or-nothing,
          // so a failure cannot leave the creator half-transferred.
          await env.DB.batch([
            env.DB.prepare("UPDATE households SET creator_id = ? WHERE id = ?")
              .bind(nextId, ctx.household.id),
            env.DB.prepare(
              "UPDATE household_members SET role = 'creator' WHERE household_id = ? AND user_id = ?",
            ).bind(ctx.household.id, nextId),
          ]);
        }
        if (results.length === 0) {
          // Last member leaving: the two deletes are independent (same
          // known ids), so they run as one batch round-trip; all-or-nothing
          // means a failure cannot leave an empty household behind.
          await env.DB.batch([
            env.DB.prepare("DELETE FROM household_members WHERE household_id = ? AND user_id = ?")
              .bind(ctx.household.id, ctx.user.id),
            env.DB.prepare("DELETE FROM households WHERE id = ?")
              .bind(ctx.household.id),
          ]);
        } else {
          await env.DB.prepare("DELETE FROM household_members WHERE household_id = ? AND user_id = ?")
            .bind(ctx.household.id, ctx.user.id)
            .run();
        }
        return json({ ok: true });
      }

      // POST /api/household/members/remove { user_id } — creator only,
      // never self (use leave), never the creator.
      if (url.pathname === "/api/household/members/remove" && request.method === "POST") {
        if (!ctx.household) return err("no_household", 403);
        if (ctx.household.role !== "creator") return err("forbidden", 403);
        const body = await readBody(request);
        const userId = typeof body.user_id === "string" ? body.user_id : "";
        if (!userId || userId === ctx.user.id) return err("invalid_member", 400);
        const target: any = await env.DB.prepare(
          "SELECT role FROM household_members WHERE household_id = ? AND user_id = ?",
        )
          .bind(ctx.household.id, userId)
          .first();
        if (!target) return err("member_not_found", 404);
        if (String(target.role) === "creator") return err("forbidden", 403);
        await env.DB.prepare("DELETE FROM household_members WHERE household_id = ? AND user_id = ?")
          .bind(ctx.household.id, userId)
          .run();
        return json({ ok: true });
      }

      // Everything below needs household membership: a non-member
      // reaches none of the app's routes (spec §13 acceptance).
      if (!ctx.household) return err("no_household", 403);

      if (url.pathname === "/api/modules" && request.method === "GET") {
        // Shell registry (spec §8): the home screen and router render from
        // this table. Batch 1.
        try {
          const { results } = await env.DB.prepare(
            "SELECT module_id, name, icon, route_prefix, widget_priority FROM modules WHERE enabled = 1 ORDER BY rowid",
          ).all();
          return Response.json({ ok: true, modules: results });
        } catch (err) {
          console.error("modules registry read failed", err);
          return Response.json({ ok: false, error: "modules_unavailable" }, { status: 500 });
        }
      }

      for (const route of moduleRoutes) {
        if (route.method === request.method && route.path === url.pathname) {
          return route.handler(request, env, ctx);
        }
      }
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }

    // SPA: serve the matching static asset for GET/HEAD; anything else is
    // not a page load. Only a 200 from the assets binding counts as a hit:
    // the binding answers unmatched paths — and /index.html itself — with
    // a 307 redirect to /, and that means "no asset" here. The fallback
    // therefore fetches "/" (which the binding serves with 200), not
    // "/index.html", and builds a fresh GET request so a POST body can
    // never reach the assets fetch disturbed.
    if (request.method !== "GET" && request.method !== "HEAD") {
      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    }
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 200) return asset;
    return env.ASSETS.fetch(new Request(new URL("/", url)));
  },
} satisfies ExportedHandler<Env>;
