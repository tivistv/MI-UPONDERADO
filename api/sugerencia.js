/* =====================================================================
   My PonderUP - api/sugerencia.js   (Funcion de Vercel, Node.js)
   Recibe el formulario "Comentarios o sugerencias", lo valida y lo reenvia.

   POR QUE EXISTE: todo lo que se valida en el navegador se puede saltar (cualquiera puede
   enviar peticiones directo a Formspree con la direccion que estaba en el HTML). Aqui las
   reglas se aplican en el servidor, y la direccion de Formspree queda escondida.

   VARIABLES DE ENTORNO (Vercel > Settings > Environment Variables)
     Destino (una de las dos):
       FORMSPREE_ENDPOINT   https://formspree.io/f/xxxxxxxx
       RESEND_API_KEY + CONTACT_TO   (opcional RESEND_FROM; por defecto onboarding@resend.dev, que solo envia al correo de tu cuenta)
     Opcionales:
       TURNSTILE_SECRET     clave secreta de Cloudflare Turnstile (si esta, el captcha es obligatorio)
       UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (o KV_REST_API_URL / KV_REST_API_TOKEN) para contadores fiables
       IP_COOLDOWN_SEC (45) | IP_DAILY_MAX (10) | GLOBAL_DAILY_CAP (20) | GLOBAL_MONTHLY_CAP (45)   (0 = sin limite)
       ALLOWED_ORIGINS      https://tudominio.com,https://www.tudominio.com  (si no esta, solo se acepta el mismo dominio)
       SITE_URL             https://tudominio.com  (para "Restringir dominio" de Formspree)
       RATE_SALT            texto cualquiera: se mezcla con la IP antes de guardarla (nunca se guarda la IP en claro)
   ===================================================================== */
'use strict';
const crypto = require('node:crypto');

const env = (k, d = '') => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const num = (k, d) => { const n = parseInt(env(k), 10); return Number.isFinite(n) && n >= 0 ? n : d; };
const limits = () => ({
  cooldown: num('IP_COOLDOWN_SEC', 45),
  ipDaily: num('IP_DAILY_MAX', 10),
  gDaily: num('GLOBAL_DAILY_CAP', 20),
  gMonthly: num('GLOBAL_MONTHLY_CAP', 45),
});

/* ---------- Contadores: Upstash Redis si esta configurado; si no, memoria de la instancia ---------- */
const mem = new Map();
const memLive = (k) => { const e = mem.get(k); if (e && e.exp <= Date.now()) { mem.delete(k); return null; } return e || null; };
const memPrune = () => { if (mem.size < 5000) return; const t = Date.now(); for (const [k, v] of mem) if (v.exp <= t) mem.delete(k); if (mem.size >= 5000) mem.clear(); };
const memStore = {
  async setNx(k, ttl) { if (memLive(k)) return false; mem.set(k, { n: 1, exp: Date.now() + ttl * 1000 }); memPrune(); return true; },
  async incr(k, ttl) { const e = memLive(k); if (e) return ++e.n; mem.set(k, { n: 1, exp: Date.now() + ttl * 1000 }); memPrune(); return 1; },
  async del(k) { mem.delete(k); },
};
function redisStore(url, token) {
  const call = async (cmds) => {
    const r = await fetch(url.replace(/\/$/, '') + '/pipeline', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds), signal: AbortSignal.timeout(2500),
    });
    if (!r.ok) throw new Error('redis ' + r.status);
    const out = await r.json();
    if (out[0] && out[0].error) throw new Error('redis ' + out[0].error);
    return out;
  };
  return {
    async setNx(k, ttl) { const [x] = await call([['SET', k, '1', 'EX', ttl, 'NX']]); return x.result === 'OK'; },
    async incr(k, ttl) { const [x] = await call([['INCR', k]]); if (x.result === 1) await call([['EXPIRE', k, ttl]]); return x.result; },
    async del(k) { await call([['DEL', k]]); },
  };
}
const store = () => {
  const url = env('UPSTASH_REDIS_REST_URL') || env('KV_REST_API_URL');
  const token = env('UPSTASH_REDIS_REST_TOKEN') || env('KV_REST_API_TOKEN');
  if (!url || !token) return memStore;
  const r = redisStore(url, token);
  /* Si Redis falla, NO se bloquea a la gente: se usa la memoria como respaldo */
  return {
    async setNx(k, t) { try { return await r.setNx(k, t); } catch (e) { console.error('redis->memoria:', e.message); return memStore.setNx(k, t); } },
    async incr(k, t) { try { return await r.incr(k, t); } catch (e) { console.error('redis->memoria:', e.message); return memStore.incr(k, t); } },
    async del(k) { try { await r.del(k); } catch (e) { console.error('redis->memoria:', e.message); } await memStore.del(k); },
  };
};

/* ---------- Utilidades ---------- */
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const clientIp = (req) => String(
  req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] ||
  (req.socket && req.socket.remoteAddress) || 'desconocida').trim();
const limaDate = () => new Date(Date.now() - 5 * 3600e3).toISOString(); /* Peru = UTC-5, sin horario de verano */

function json(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}
const fail = (res, status, error, headers) => json(res, status, { ok: false, error }, headers);

function requestOrigin(req) {
  let o = req.headers.origin;
  if (!o && req.headers.referer) { try { o = new URL(req.headers.referer).origin; } catch (_) { /* nada */ } }
  return o ? String(o).toLowerCase().replace(/\/$/, '') : '';
}
function originAllowed(req, origin) {
  if (!origin) return false;
  const list = env('ALLOWED_ORIGINS').split(',').map((x) => x.trim().toLowerCase().replace(/\/$/, '')).filter(Boolean);
  if (list.length) return list.includes(origin);
  let host; try { host = new URL(origin).host; } catch (_) { return false; }
  const mine = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  return host === mine;
}
function readBody(req) {
  let b; try { b = req.body; } catch (_) { return null; }
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { return null; } }
  return b && typeof b === 'object' && !Array.isArray(b) ? b : null;
}

async function verifyTurnstile(secret, token, ip) {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== 'desconocida') body.set('remoteip', ip);
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(5000) });
  const j = await r.json();
  return j.success === true;
}

async function deliver({ message, curso, seg, origin }) {
  const subject = 'Sugerencia de My PonderUP';
  if (env('RESEND_API_KEY')) {
    const to = env('CONTACT_TO');
    if (!to) throw new Error('config: falta CONTACT_TO');
    const text = [message, '', '---', 'Curso: ' + (curso || '(ninguno)'), 'Segundos escribiendo: ' + seg, 'Enviado: ' + new Date().toISOString()].join('\n');
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + env('RESEND_API_KEY'), 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env('RESEND_FROM', 'My PonderUP <onboarding@resend.dev>'), to: [to], subject, text }), signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('resend ' + r.status);
    return;
  }
  if (env('FORMSPREE_ENDPOINT')) {
    const site = env('SITE_URL') || origin;
    const r = await fetch(env('FORMSPREE_ENDPOINT'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: site, Referer: site + '/' },
      body: JSON.stringify({ message, curso, segundos_escribiendo: seg, _subject: subject }), signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error('formspree ' + r.status);
    return;
  }
  throw new Error('config: falta FORMSPREE_ENDPOINT o RESEND_API_KEY');
}

/* ---------- Manejador ---------- */
async function handler(req, res) {
  try {
    if (req.method !== 'POST') return fail(res, 405, 'metodo', { Allow: 'POST' });

    const origin = requestOrigin(req);
    if (!originAllowed(req, origin)) return fail(res, 403, 'origen');
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return fail(res, 415, 'tipo');
    if (parseInt(req.headers['content-length'] || '0', 10) > 8192) return fail(res, 413, 'grande');

    const b = readBody(req);
    if (!b) return fail(res, 400, 'invalido');

    /* Trampa para bots: un campo oculto que una persona nunca llena. Se responde "ok" para que el bot no aprenda nada. */
    if (typeof b._gotcha === 'string' && b._gotcha.trim() !== '') return json(res, 200, { ok: true });

    const message = typeof b.message === 'string' ? b.message.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim() : '';
    const curso = typeof b.curso === 'string' ? b.curso.replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const seg = Math.min(86400, Math.max(0, Math.round(Number(b.seg) || 0)));
    if (message.length < 5 || message.length > 1000) return fail(res, 400, 'invalido');
    if (/(https?:\/\/|www\.|\bt\.me\/|\bbit\.ly\b)/i.test(message)) return fail(res, 400, 'enlace');
    if (/(.)\1{19,}/u.test(message)) return fail(res, 400, 'invalido');

    const L = limits(), db = store();
    const ip = clientIp(req), who = sha(env('RATE_SALT', 'myponderup') + '|' + ip).slice(0, 24);
    const now = limaDate(), day = now.slice(0, 10), month = now.slice(0, 7);

    /* 1) Limite por IP: espera entre envios y maximo por dia */
    if (L.cooldown && !(await db.setNx(`mp:cd:${who}`, L.cooldown))) return fail(res, 429, 'espera', { 'Retry-After': String(L.cooldown) });
    if (L.ipDaily && (await db.incr(`mp:ip:${day}:${who}`, 90000)) > L.ipDaily) return fail(res, 429, 'limite_dia', { 'Retry-After': '3600' });

    /* 2) Captcha (solo si se configuro) */
    const secret = env('TURNSTILE_SECRET');
    if (secret && !(await verifyTurnstile(secret, b.token, ip))) return fail(res, 403, 'captcha');

    /* 3) Mensaje repetido (el mismo texto en las ultimas 24 h): se agradece pero no se reenvia */
    const norm = message.toLowerCase().replace(/\s+/g, ' ');
    const dupKey = 'mp:dup:' + sha(norm).slice(0, 32);
    if (!(await db.setNx(dupKey, 86400))) return json(res, 200, { ok: true, repetido: true });

    /* 4) Topes globales: protegen el limite mensual de Formspree (50 en el plan gratis) */
    if (L.gDaily && (await db.incr(`mp:g:${day}`, 90000)) > L.gDaily) return fail(res, 503, 'cupo', { 'Retry-After': '3600' });
    if (L.gMonthly && (await db.incr(`mp:m:${month}`, 3000000)) > L.gMonthly) return fail(res, 503, 'cupo', { 'Retry-After': '86400' });

    try { await deliver({ message, curso, seg, origin }); }
    catch (e) { await db.del(dupKey); throw e; } /* si falla el envio, el usuario puede reintentar el mismo texto */
    return json(res, 200, { ok: true });
  } catch (e) {
    console.error('sugerencia:', e && e.message);
    const cfg = e && /^config:/.test(e.message || '');
    return fail(res, cfg ? 500 : 502, cfg ? 'config' : 'envio');
  }
}

module.exports = handler;
module.exports.__resetMemory = () => mem.clear(); /* solo para pruebas */
