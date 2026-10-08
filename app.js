/* ============================================================================
 * Gerador de EVIDENCIA real para Meta App Review — roda 100% no navegador.
 *
 *   whatsapp_business_messaging   (enviar mensagem -> wamid real)
 *   whatsapp_business_management  (WABA, numeros, templates, perfil, webhooks)
 *   business_management           (Business Manager, WABAs, system users)
 *
 * Faz chamadas REAIS contra graph.facebook.com e emite um .txt no MESMO formato
 * das evidencias de docs/ (gerar-evidencia-waba-messaging-management.mjs).
 * NADA e inventado: status HTTP, x-fb-trace-id, x-fb-request-id e corpos das
 * respostas vem direto da Meta.
 *
 * ---------------------------------------------------------------------------
 * TRACE-ID NO NAVEGADOR (tudo aqui foi medido contra a Graph API, nao suposto):
 *
 * A Meta responde `Access-Control-Allow-Origin: *`, entao a chamada passa. Mas
 * `Access-Control-Expose-Headers` so vem em PARTE dos endpoints — e sem ele o
 * CORS esconde do JS todo header fora da safelist. Medido:
 *   GET /{waba}            -> expoe X-FB-Trace-ID e X-FB-Request-ID  (legiveis)
 *   GET /{waba}/phone_numbers, GET /{phone}, /me, ... -> nao expoe   (invisiveis)
 *
 * Duas alternativas foram testadas e descartadas: a Graph API Batch devolve os
 * headers da sub-chamada no corpo, mas o conjunto NAO inclui os x-fb-*; e
 * `?debug=all` nao acrescenta nada.
 *
 * Entao a captura e em cascata, sempre com o valor real ou nada:
 *   1. header x-fb-trace-id / x-fb-request-id, quando a Meta expoe;
 *   2. `fbtrace_id` do CORPO — presente em toda resposta de ERRO, e igual ao
 *      valor do header x-fb-request-id;
 *   3. nenhum dos dois -> o documento escreve que nao esta disponivel.
 * Nada e inventado em nenhum dos casos.
 *
 * Para x-fb-trace-id em TODA chamada (Node nao passa por CORS), use o script
 * equivalente: docs/gerar-evidencia-waba-messaging-management.mjs
 * ==========================================================================*/
'use strict';

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pretty = (o) => JSON.stringify(o, null, 2);
const mask = (t) => (t && t.length > 24 ? t.slice(0, 14) + '...' + t.slice(-6) : '[REDACTED]');
const NO_TRACE = '(nao exposto ao navegador — CORS)';

// nomes das secoes do log, por permissao
const PERM_NAMES = {
  ident: 'identidade do token',
  mgmt: 'whatsapp_business_management',
  msg: 'whatsapp_business_messaging',
  biz: 'business_management',
};

const S = {
  calls: [],        // registros da execucao corrente (viram a evidencia)
  running: false,
  abort: false,
  templates: [],    // templates da WABA, p/ a lista do campo Template
  cands: { wabas: [], phones: [], businesses: [] },   // opcoes achadas na descoberta
  hookPhones: [],   // numeros do ultimo Buscar numeros (modo Ativar)
  lastPerm: null,   // permissao da ultima linha do log — controla os cabecalhos de grupo
  doc: '',
  filename: '',
};

/* ==========================================================================
 * 1. CONFIG — leitura do formulario + persistencia
 * ========================================================================*/
const TEXT_FIELDS = ['appId', 'wabaId', 'phoneId', 'businessId', 'recipient',
  'tplName', 'tplLang', 'graphVersion', 'hookId', 'hookPhone'];
const CHK_FIELDS = ['bMgmt', 'bMsg', 'bBiz', 'oCreateTpl', 'oProfile', 'oSendTpl', 'oSendText', 'remember'];
const LS = 'wabaEvid.';

// Aceita "26", "v26" ou "v26.0" e normaliza p/ o formato da Graph API.
function normVersion(v) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return 'v24.0';
  const m = s.match(/^v?(\d{1,3})(?:\.(\d+))?$/);
  return m ? `v${m[1]}.${m[2] || '0'}` : s;
}

function cfg() {
  const g = (id) => $(id).value.trim();
  return {
    token: g('token'),
    appId: g('appId'),
    wabaId: g('wabaId'),
    phoneId: g('phoneId'),
    businessId: g('businessId'),
    hookId: g('hookId'),
    hookPhone: g('hookPhone'),
    hookPin: g('hookPin'),
    recipient: g('recipient') || '553588754197',
    tplName: g('tplName') || 'hello_world',
    tplLang: g('tplLang') || 'en_US',
    version: normVersion(g('graphVersion')),
    bMgmt: $('bMgmt').checked,
    bMsg: $('bMsg').checked,
    bBiz: $('bBiz').checked,
    oCreateTpl: $('oCreateTpl').checked,
    oProfile: $('oProfile').checked,
    oSendTpl: $('oSendTpl').checked,
    oSendText: $('oSendText').checked,
  };
}

function saveCfg() {
  try {
    TEXT_FIELDS.forEach((k) => localStorage.setItem(LS + k, $(k).value));
    CHK_FIELDS.forEach((k) => localStorage.setItem(LS + k, $(k).checked ? '1' : '0'));
    if ($('remember').checked) localStorage.setItem(LS + 'token', $('token').value);
    else localStorage.removeItem(LS + 'token');
  } catch (_) { /* modo privado */ }
  updateSteps();   // qualquer mudanca de campo pode avancar/regredir a trilha
}

function loadCfg() {
  try {
    TEXT_FIELDS.forEach((k) => { const v = localStorage.getItem(LS + k); if (v !== null) $(k).value = v; });
    CHK_FIELDS.forEach((k) => { const v = localStorage.getItem(LS + k); if (v !== null) $(k).checked = v === '1'; });
    const tok = localStorage.getItem(LS + 'token'); if (tok) $('token').value = tok;
    const th = localStorage.getItem(LS + 'theme'); if (th) document.documentElement.dataset.theme = th;
  } catch (_) { /* ignora */ }
}

/* ==========================================================================
 * 2. TRANSPORTE — fetch direto contra a Graph API
 * ========================================================================*/

// curl equivalente da chamada — reproduzivel por quem revisa.
function buildCurl(method, url, json, form) {
  if (method === 'GET' || method === 'DELETE') {
    return `curl -X ${method} "${url}" \\\n  -H "Authorization: Bearer {TOKEN}"`;
  }
  if (json) {
    return `curl -X ${method} "${url}" \\\n  -H "Authorization: Bearer {TOKEN}" \\\n` +
      `  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(json)}'`;
  }
  return `curl -X ${method} "${url}" \\\n  -H "Authorization: Bearer {TOKEN}" \\\n` +
    Object.entries(form || {}).map(([k, v]) => `  -d "${k}=${v}"`).join(' \\\n');
}

async function callDirect(spec, c) {
  const base = `https://graph.facebook.com/${c.version}`;
  const url = `${base}/${spec.path}`;
  const token = spec.token || c.token;
  const opt = { method: spec.method, headers: { Authorization: `Bearer ${token}` } };
  if (spec.method !== 'GET' && spec.method !== 'DELETE') {
    if (spec.json) {
      opt.body = JSON.stringify(spec.json);
      opt.headers['Content-Type'] = 'application/json';
    } else if (spec.form) {
      opt.body = new URLSearchParams(spec.form);
      opt.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
  }
  const res = await fetch(url, opt);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { json = null; }
  return {
    status: res.status,
    // Vem preenchido nos endpoints em que a Meta manda Access-Control-Expose-Headers
    // (ex. GET /{waba}); vazio nos demais, por bloqueio do CORS.
    traceId: res.headers.get('x-fb-trace-id') || '',
    requestId: res.headers.get('x-fb-request-id') || '',
    json, text,
  };
}


/** Executa uma chamada e devolve o registro completo p/ a evidencia. */
async function runCall(spec, c) {
  const base = `https://graph.facebook.com/${c.version}`;
  const token = spec.token || c.token;
  let out = null;

  try {
    out = await callDirect(spec, c);
  } catch (e) {
    out = { status: 0, traceId: '', requestId: '', json: null,
      text: 'FETCH ERROR: ' + e.message };
  }

  // Quando o CORS escondeu os headers, sobra o corpo: toda resposta de ERRO traz
  // fbtrace_id, e o valor e exatamente o do header x-fb-request-id (verificado
  // contra a Graph API). Marcado com idFromBody p/ o documento dizer a origem.
  const traceId = out.traceId || '';
  let requestId = out.requestId || '';
  let idFromBody = false;
  if (!requestId && out.json && out.json.error && out.json.error.fbtrace_id) {
    requestId = String(out.json.error.fbtrace_id);
    idFromBody = true;
  }

  const url = `${base}/${spec.path}`;
  const rec = {
    label: spec.label,
    perm: spec.perm,
    method: spec.method,
    endpoint: url.split('?')[0].split(token).join('{TOKEN}'),
    fullUrl: url.split(token).join('{TOKEN}'),
    status: out.status,
    traceId, requestId, idFromBody,
    reqBody: spec.json || spec.form || null,
    curl: buildCurl(spec.method, url.split(token).join('{TOKEN}'), spec.json, spec.form),
    json: out.json,
    text: out.text,
  };
  if (!spec.solo) S.calls.push(rec);   // modo Ativar nao entra na evidencia
  return rec;
}

/* ==========================================================================
 * 3. DESCOBERTA DE IDs — token -> app / WABA / phone / business
 * ========================================================================*/
async function quickGet(path, c, token) {
  const rec = await runCall({ label: '_discover', perm: 'discover', method: 'GET', path, token }, c);
  S.calls.pop(); // descoberta nao entra na evidencia
  return rec;
}

async function discover(c, log) {
  const found = { appId: c.appId, wabaId: c.wabaId, phoneId: c.phoneId, businessId: c.businessId };
  S.cands = { wabas: [], phones: [], businesses: [] };

  // Valida o token pelo /me — e nao pelo debug_token: este ultimo exige app
  // access token ou token de owner/developer do app, entao um System User token
  // comum recebe 400 (#100) mesmo estando perfeitamente valido.
  const me = await quickGet('me?fields=id,name', c);
  if (me.status !== 200) {
    const msg = (me.json && me.json.error && me.json.error.message) || `HTTP ${me.status}`;
    log(`token recusado pela Meta: ${msg}`, 'err');
    return found;
  }
  log(`token valido — ${(me.json && me.json.name) || 'ok'}`, 'ok');

  // Scopes concedidos (funciona com System User token, ao contrario do debug_token)
  const perms = await quickGet('me/permissions', c);
  if (perms.json && Array.isArray(perms.json.data)) {
    const granted = perms.json.data.filter((p) => p.status === 'granted').map((p) => p.permission);
    const alvo = ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management']
      .filter((p) => granted.includes(p));
    if (alvo.length) log(`permissions concedidas: ${alvo.join(', ')}`, 'ok');
    const falta = ['whatsapp_business_messaging', 'whatsapp_business_management']
      .filter((p) => !granted.includes(p));
    if (falta.length) log(`ATENCAO — nao concedidas neste token: ${falta.join(', ')}`, 'err');
  }

  // debug_token e best-effort: quando funciona, entrega App ID e granular_scopes.
  const dbg = await quickGet(`debug_token?input_token=${encodeURIComponent(c.token)}`, c);
  const d = dbg.json && dbg.json.data;
  if (!d) {
    log('App ID nao descoberto (debug_token exige app token) — preencha o campo App ID');
  } else {
    if (!found.appId && d.app_id) { found.appId = String(d.app_id); log(`App ID ${found.appId}`, 'ok'); }
    // WABA via granular_scopes (target_ids). System User token costuma vir sem.
    if (Array.isArray(d.granular_scopes)) {
      d.granular_scopes
        .filter((x) => /^whatsapp_business_(management|messaging)$/.test(x.scope) && Array.isArray(x.target_ids))
        .forEach((x) => x.target_ids.forEach((t) => addCand(S.cands.wabas, t)));
    }
  }

  // WABAs atribuidas ao token — a fonte mais rica (traz o nome) e a que funciona
  // p/ System User token. Roda SEMPRE, p/ montar a lista de escolha completa.
  const asg = await quickGet('me/assigned_whatsapp_business_accounts?fields=id,name,account_review_status&limit=25', c);
  if (asg.json && Array.isArray(asg.json.data)) {
    asg.json.data.forEach((w) => addCand(S.cands.wabas, w.id, w.name));
  }

  // Business -> WABAs proprias / de cliente
  if (found.businessId) {
    for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
      const r = await quickGet(`${found.businessId}/${edge}?fields=id,name&limit=25`, c);
      if (r.json && Array.isArray(r.json.data)) r.json.data.forEach((w) => addCand(S.cands.wabas, w.id, w.name));
    }
  }
  // Businesses do token; so varre as WABAs de cada um se ainda nao houver nenhuma
  if (!found.businessId || !S.cands.wabas.length) {
    const bs = await quickGet('me/businesses?fields=id,name&limit=25', c);
    const list = (bs.json && Array.isArray(bs.json.data)) ? bs.json.data : [];
    list.forEach((b) => addCand(S.cands.businesses, b.id, b.name));
    for (const b of list) {
      if (S.cands.wabas.length) break;
      const r = await quickGet(`${b.id}/owned_whatsapp_business_accounts?fields=id,name&limit=25`, c);
      if (r.json && Array.isArray(r.json.data)) r.json.data.forEach((w) => addCand(S.cands.wabas, w.id, w.name));
      if (S.cands.wabas.length && !found.businessId) found.businessId = String(b.id);
    }
  }

  if (!found.wabaId && S.cands.wabas.length) {
    const w = S.cands.wabas[0];
    found.wabaId = w.id;
    log(`WABA ID ${w.id}${w.label ? ' — ' + w.label : ''}`, 'ok');
  }
  if (S.cands.wabas.length > 1) log(`${S.cands.wabas.length} WABAs disponíveis — escolha na lista abaixo`, 'ok');

  // Business dono da WABA escolhida
  if (found.wabaId) {
    const r = await quickGet(`${found.wabaId}?fields=id,name,owner_business_info`, c);
    const owner = r.json && r.json.owner_business_info;
    if (owner && owner.id) {
      addCand(S.cands.businesses, owner.id, owner.name);
      if (!found.businessId) { found.businessId = String(owner.id); log(`Business ID ${found.businessId} (owner da WABA)`, 'ok'); }
    }
  }

  // Numeros + templates da WABA escolhida
  if (found.wabaId) await loadWaba(found.wabaId, c, found, log);

  renderPickers();
  return found;
}

// Junta candidatos sem duplicar; se o mesmo id vier depois com nome, guarda o nome.
function addCand(lista, id, label) {
  const v = String(id);
  const i = lista.findIndex((x) => x.id === v);
  if (i < 0) lista.push({ id: v, label: label || '' });
  else if (label && !lista[i].label) lista[i].label = label;
}

/** Números e templates de uma WABA. `found` opcional: preenche o phone se vazio. */
async function loadWaba(wabaId, c, found, log) {
  S.cands.phones = [];
  const ph = await quickGet(`${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name&limit=25`, c);
  if (ph.json && Array.isArray(ph.json.data)) {
    ph.json.data.forEach((p) => addCand(S.cands.phones, p.id,
      `${p.display_phone_number || ''} ${p.verified_name || ''}`.trim()));
  }
  if (found && !found.phoneId && S.cands.phones.length) {
    found.phoneId = S.cands.phones[0].id;
    if (log) log(`Phone Number ID ${found.phoneId} — ${S.cands.phones[0].label}`, 'ok');
  }
  if (log && S.cands.phones.length > 1) log(`${S.cands.phones.length} números nessa WABA — escolha na lista abaixo`, 'ok');

  const t = await quickGet(`${wabaId}/message_templates?fields=name,language,status,category&limit=100`, c);
  S.templates = (t.json && Array.isArray(t.json.data)) ? t.json.data : [];
  if (log && S.templates.length) {
    const aprov = S.templates.filter((x) => x.status === 'APPROVED').length;
    log(`${S.templates.length} templates na WABA (${aprov} aprovados) — lista no campo Template`, 'ok');
  }
}

/* ==========================================================================
 * 4. PLANO DE CHAMADAS
 * ========================================================================*/
function buildPlan(c) {
  const P = [];
  const has = { waba: !!c.wabaId, phone: !!c.phoneId, biz: !!c.businessId };

  // --- 0. identidade + scopes (prova que as permissions estao concedidas)
  P.push({ perm: 'ident', label: 'ident: GET /me', method: 'GET', path: 'me?fields=id,name' });
  P.push({ perm: 'ident', label: 'ident: GET /me/permissions (scopes do token)', method: 'GET', path: 'me/permissions' });
  P.push({ perm: 'ident', label: 'ident: GET /debug_token (scopes + granular do token)', method: 'GET',
    path: `debug_token?input_token=${encodeURIComponent(c.token)}` });

  // --- 1. whatsapp_business_management
  if (c.bMgmt) {
    if (has.waba) {
      P.push({ perm: 'mgmt', label: 'mgmt: GET /{waba} (dados da WABA)', method: 'GET',
        path: `${c.wabaId}?fields=id,name,currency,timezone_id,message_template_namespace,account_review_status,business_verification_status,owner_business_info,ownership_type` });
      P.push({ perm: 'mgmt', label: 'mgmt: GET /{waba}/phone_numbers', method: 'GET',
        path: `${c.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,platform_type,name_status,messaging_limit_tier` });
    }
    if (has.phone) {
      P.push({ perm: 'mgmt', label: 'mgmt: GET /{phone} (detalhes do numero)', method: 'GET',
        path: `${c.phoneId}?fields=verified_name,display_phone_number,quality_rating,messaging_limit_tier,platform_type,throughput,code_verification_status,name_status` });
    }
    if (has.waba) {
      P.push({ perm: 'mgmt', label: 'mgmt: GET /{waba}/message_templates (lista)', method: 'GET',
        path: `${c.wabaId}/message_templates?fields=id,name,status,category,language&limit=10` });

      if (c.oCreateTpl) {
        const ts = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14);
        const name = `evidencia_waba_mgmt_${ts}`;
        P.push({ perm: 'mgmt', label: 'mgmt: POST /{waba}/message_templates (cria UTILITY)', method: 'POST',
          path: `${c.wabaId}/message_templates`,
          json: {
            name,
            language: 'pt_BR',
            category: 'UTILITY',
            components: [{
              type: 'BODY',
              text: 'Ola {{1}}, recebemos a sua mensagem e o seu atendimento foi registrado com sucesso em nosso sistema. Em breve um de nossos atendentes respondera por aqui. Caso precise de algo antes disso, basta responder esta conversa.',
              example: { body_text: [['Pedro']] },
            }],
          } });
        P.push({ perm: 'mgmt', label: 'mgmt: GET /{waba}/message_templates?name=... (confirma criado)', method: 'GET',
          path: `${c.wabaId}/message_templates?name=${name}&fields=id,name,status,category,language,components` });
        P.push({ perm: 'mgmt', label: 'mgmt: DELETE /{waba}/message_templates?name=... (cleanup)', method: 'DELETE',
          path: `${c.wabaId}/message_templates?name=${name}` });
      }
    }
    if (has.phone) {
      P.push({ perm: 'mgmt', label: 'mgmt: GET /{phone}/whatsapp_business_profile (le perfil)', method: 'GET',
        path: `${c.phoneId}/whatsapp_business_profile?fields=about,address,description,email,profile_picture_url,websites,vertical`,
        tag: 'profileRead' });
      if (c.oProfile) {
        P.push({ perm: 'mgmt', label: 'mgmt: POST /{phone}/whatsapp_business_profile (restaura mesmo valor)', method: 'POST',
          path: `${c.phoneId}/whatsapp_business_profile`, tag: 'profileWrite' });
        P.push({ perm: 'mgmt', label: 'mgmt: GET /{phone}/whatsapp_business_profile (confirma update)', method: 'GET',
          path: `${c.phoneId}/whatsapp_business_profile?fields=about,description` });
      }
    }
    // GET /{waba}/subscribed_apps saiu do plano: responde erro de forma
    // consistente (500 "reduce the amount of data", #1/99) e deixaria uma falha
    // fixa na evidencia. O que ele provaria — o app inscrito no webhook — fica
    // melhor demonstrado no screencast, quando a mensagem do cliente cai na inbox.
  }

  // --- 2. whatsapp_business_messaging
  if (c.bMsg && has.phone) {
    if (c.oSendTpl) {
      P.push({ perm: 'msg', label: 'msg: POST /{phone}/messages (template)', method: 'POST',
        path: `${c.phoneId}/messages`, tag: 'sendTpl',
        json: {
          messaging_product: 'whatsapp',
          to: c.recipient,
          type: 'template',
          template: { name: c.tplName, language: { code: c.tplLang } },
        } });
    }
    if (c.oSendText) {
      P.push({ perm: 'msg', label: 'msg: POST /{phone}/messages (texto livre)', method: 'POST',
        path: `${c.phoneId}/messages`,
        json: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: c.recipient,
          type: 'text',
          text: { preview_url: false, body: `Evidencia App Review ${new Date().toISOString()} - whatsapp_business_messaging` },
        } });
    }
    // "marcar como lida" foi removida: exige o wamid de uma mensagem RECEBIDA,
    // que so chega pelo webhook (a Cloud API nao tem endpoint de historico), e
    // seria uma terceira variante do MESMO POST /{phone}/messages ja provado
    // pelos dois envios acima.
  }

  // --- 3. business_management
  if (c.bBiz) {
    if (has.waba) {
      P.push({ perm: 'biz', label: 'business_management: GET /{waba} (owner business)', method: 'GET',
        path: `${c.wabaId}?fields=id,name,owner_business_info,on_behalf_of_business_info` });
    }
    P.push({ perm: 'biz', label: 'business_management: GET /me/businesses', method: 'GET',
      path: 'me/businesses?fields=id,name,verification_status&limit=25' });
    if (has.biz) {
      P.push({ perm: 'biz', label: 'business_management: GET /{business}', method: 'GET',
        path: `${c.businessId}?fields=id,name,verification_status,created_time,vertical,primary_page,two_factor_type` });
      P.push({ perm: 'biz', label: 'business_management: GET /{business}/owned_whatsapp_business_accounts', method: 'GET',
        path: `${c.businessId}/owned_whatsapp_business_accounts?fields=id,name,currency,account_review_status&limit=25` });
      P.push({ perm: 'biz', label: 'business_management: GET /{business}/client_whatsapp_business_accounts', method: 'GET',
        path: `${c.businessId}/client_whatsapp_business_accounts?fields=id,name&limit=25` });
      P.push({ perm: 'biz', label: 'business_management: GET /{business}/system_users', method: 'GET',
        path: `${c.businessId}/system_users?fields=id,name,role&limit=25` });
    }
  }

  return P;
}

/* ==========================================================================
 * 5. RENDER DA EVIDENCIA (.txt) — mesmo formato de docs/evidencia-*.txt
 * ========================================================================*/
function scrubTokens(s, tokens) {
  for (const t of tokens) if (t) s = s.split(t).join(mask(t));
  s = s.replace(/(access_token=)[A-Za-z0-9_.-]+/g, '$1[REDACTED]');
  s = s.replace(/(input_token=)[A-Za-z0-9_.-]+/g, '$1[REDACTED]');
  s = s.replace(/("access_token"\s*:\s*")[^"]+(")/g, '$1[REDACTED]$2');
  s = s.replace(/(Bearer )[A-Za-z0-9_-]{24,}/g, '$1[REDACTED]');
  s = s.replace(/\b(EAA|IGAA)[A-Za-z0-9_-]{20,}\b/g, (m) => mask(m));
  return s;
}

function buildDoc(c, ctx) {
  const hr = '==============================================================';
  const sub = '--------------------------------------------------------------';
  const base = `https://graph.facebook.com/${c.version}`;
  const ran = (p) => S.calls.some((x) => x.perm === p);

  const perms = [];
  if (ran('msg')) perms.push('whatsapp_business_messaging');
  if (ran('mgmt')) perms.push('whatsapp_business_management');
  if (ran('biz')) perms.push('business_management');

  const L = [];
  L.push(hr);
  L.push(`EVIDENCIA: ${perms.join(' + ') || '(somente identidade do token)'}`);
  L.push('           (WhatsApp Business Cloud API / Meta Graph API)');
  L.push(hr, '');
  L.push(`App ID:          ${ctx.appId || 'UNKNOWN'}`);
  L.push(`WABA ID:         ${c.wabaId || '(nao identificada nesta execucao)'}`);
  L.push(`Phone Number ID: ${c.phoneId || '(nao identificado nesta execucao)'}`);
  if (ran('biz') || c.businessId) L.push(`Business ID:     ${c.businessId || '(nao identificado nesta execucao)'}`);
  if (ran('msg')) L.push(`Destino do envio: ${c.recipient}`);
  L.push(`Data:            ${new Date().toISOString()}`);
  L.push(`Endpoint base:   ${base}`);
  L.push('');
  L.push('Tokens usados (mascarados):');
  L.push(`  - access_token  ${mask(c.token)}`);
  L.push('');
  L.push('NADA neste arquivo foi editado a mao: status HTTP, x-fb-trace-id,');
  L.push('x-fb-request-id e corpos das respostas vieram direto da Meta.');
  L.push('');
  L.push('NOTA SOBRE OS IDENTIFICADORES DE REQUISICAO: estas chamadas partiram de um');
  L.push('cliente de navegador. A Graph API so envia Access-Control-Expose-Headers em');
  L.push('parte dos endpoints, e sem esse header o CORS impede o cliente de ler');
  L.push('x-fb-trace-id / x-fb-request-id. Onde a Meta expoe, o valor do header esta');
  L.push('abaixo; nas respostas de erro vale o fbtrace_id que ela manda no corpo (mesmo');
  L.push('valor de x-fb-request-id); onde nao ha nenhum dos dois, o campo diz isso.');
  L.push('Os status HTTP, os corpos e os identificadores emitidos pela Meta (wamid, ids');
  L.push('de template, dados da WABA) sao reais e nao foram editados.');
  L.push('');

  for (const rec of S.calls) {
    L.push(hr);
    L.push(`[${rec.label}]`);
    L.push(`${rec.method} ${rec.endpoint}`);
    const rq = rec.requestId
      ? (rec.idFromBody ? `${rec.requestId} (fbtrace_id do corpo da resposta)` : rec.requestId)
      : NO_TRACE;
    L.push(`HTTP ${rec.status}    x-fb-trace-id: ${rec.traceId || NO_TRACE}    x-fb-request-id: ${rq}`);
    L.push('');
    L.push('Request:');
    L.push(rec.curl);
    L.push('');
    L.push('Response:');
    L.push(rec.json ? pretty(rec.json) : (rec.text || '(corpo vazio)'));
    L.push('');
  }

  L.push(hr);
  L.push('CONCLUSAO');
  L.push(hr);
  L.push('');
  const okOf = (p) => S.calls.filter((x) => x.perm === p && x.status >= 200 && x.status < 300)
    .map((x) => {
      const id = x.traceId ? `, trace ${x.traceId}` : (x.requestId ? `, request-id ${x.requestId}` : '');
      return `${x.method} ${x.endpoint}  (HTTP ${x.status}${id})`;
    });

  if (ran('mgmt')) { L.push('whatsapp_business_management:'); okOf('mgmt').forEach((s) => L.push('  - ' + s)); L.push(''); }
  if (ran('msg')) {
    L.push('whatsapp_business_messaging:');
    okOf('msg').forEach((s) => L.push('  - ' + s));
    if (ctx.wamid) L.push(`  >>> Mensagem real enviada, wamid: ${ctx.wamid}`);
    L.push('');
  }
  if (ran('biz')) { L.push('business_management:'); okOf('biz').forEach((s) => L.push('  - ' + s)); L.push(''); }
  L.push(`App ID: ${ctx.appId || 'UNKNOWN'}   WABA: ${c.wabaId || '(n/a)'}   Phone: ${c.phoneId || '(n/a)'}`);
  L.push(sub);
  L.push('FIM');

  return scrubTokens(L.join('\n'), [c.token]);
}

function evidenceFilename(appId) {
  const ran = (p) => S.calls.some((x) => x.perm === p);
  const parts = [];
  if (ran('msg') && ran('mgmt')) parts.push('whatsapp-business-messaging-management');
  else if (ran('msg')) parts.push('whatsapp-business-messaging');
  else if (ran('mgmt')) parts.push('whatsapp-business-management');
  if (ran('biz')) parts.push('business-management');
  return `evidencia-app-${appId || 'UNKNOWN'}-${parts.join('-') || 'token'}.txt`;
}

/* ==========================================================================
 * 6. UI — log, kpis, execucao
 * ========================================================================*/
const UI = {
  // Filtro da lista pelos KPIs. Linha ainda em execucao nunca some.
  filtro: 'all',
  filtraLinha(tr) {
    if (tr.classList.contains('grp')) return;   // grupos seguem as proprias linhas (refreshGroups)
    if (tr.classList.contains('pending')) { tr.hidden = false; return; }
    const f = UI.filtro;
    tr.hidden = (f === 'ok' && tr.dataset.ok !== '1')
      || (f === 'err' && tr.dataset.ok !== '0')
      || (f === 'id' && tr.dataset.temId !== '1');
  },
  aplicaFiltro(f) {
    UI.filtro = (f === UI.filtro && f !== 'all') ? 'all' : f;   // reclicar volta p/ todas
    $('kpis').querySelectorAll('.kpi').forEach((k) => k.classList.toggle('on', k.dataset.filter === UI.filtro));
    $('logBody').querySelectorAll('tr').forEach(UI.filtraLinha);
    UI.refreshGroups();
  },
  // Cabecalho de grupo some quando o filtro esconde todas as linhas dele.
  refreshGroups() {
    const rows = [...$('logBody').children];
    rows.forEach((r, i) => {
      if (!r.classList.contains('grp')) return;
      let vis = false;
      for (let j = i + 1; j < rows.length && !rows[j].classList.contains('grp'); j++) {
        if (!rows[j].hidden) vis = true;
      }
      r.hidden = !vis;
    });
  },
  reset() {
    UI.aplicaFiltro('all');
    S.lastPerm = null;
    $('logBody').innerHTML = '';
    $('logEmpty').style.display = 'none';
    $('logTable').style.display = '';
    $('preview').style.display = 'none';
    $('preview').value = '';
    $('docEmpty').style.display = '';
    $('docHero').hidden = true;
    $('docBar').hidden = false;
    $('expandBtn').disabled = true;
    UI.kpi(0, 0, 0, 0);
    $('progBar').style.width = '0%';
  },
  kpi(t, ok, err, tr) {
    $('kTotal').textContent = t; $('kOk').textContent = ok;
    $('kErr').textContent = err; $('kTrace').textContent = tr;
  },
  refreshKpis() {
    const t = S.calls.length;
    const ok = S.calls.filter((x) => x.status >= 200 && x.status < 300).length;
    UI.kpi(t, ok, t - ok, S.calls.filter((x) => x.traceId || x.requestId).length);
  },
  status(text, cls) {
    const b = $('statusBadge');
    b.textContent = text;
    b.className = 'badge' + (cls ? ' ' + cls : '');
  },
  progress(done, total) {
    $('progBar').style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
  },
  row(spec) {
    // permissao mudou -> abre um cabecalho de secao no log
    if (spec.perm !== S.lastPerm) {
      S.lastPerm = spec.perm;
      const g = document.createElement('tr');
      g.className = 'grp';
      const td = document.createElement('td');
      td.colSpan = 3;
      const nome = document.createElement('span');
      nome.textContent = PERM_NAMES[spec.perm] || spec.perm;
      const cnt = document.createElement('span');
      cnt.className = 'g-count';
      cnt.dataset.perm = spec.perm;
      td.appendChild(nome);
      td.appendChild(cnt);
      g.appendChild(td);
      $('logBody').appendChild(g);
    }
    const tr = document.createElement('tr');
    tr.className = 'pending';
    tr.innerHTML =
      `<td><div class="t-label"><span class="meth"></span><span class="lb"></span></div>` +
      `<div class="t-ep"></div></td>` +
      `<td><span class="spin"></span></td>` +
      `<td class="t-trace">…</td>`;
    const m = tr.querySelector('.meth');
    m.textContent = spec.method;
    m.classList.add(spec.method);
    tr.querySelector('.lb').textContent = spec.label;
    tr.querySelector('.t-ep').textContent = `/${String(spec.path).split('?')[0]}`;
    $('logBody').appendChild(tr);
    $('logWrap').scrollTop = $('logWrap').scrollHeight;
    return tr;
  },
  fill(tr, rec) {
    tr.className = '';
    const ok = rec.status >= 200 && rec.status < 300;
    const badge = document.createElement('span');
    badge.className = 'badge ' + (ok ? 'ok' : 'err');
    badge.textContent = rec.status || 'falhou';
    const td = tr.children[1];
    td.innerHTML = '';
    td.appendChild(badge);
    tr.children[2].textContent = rec.traceId || rec.requestId || '—';

    // Motivo da recusa direto na linha: sem isso um 400 nao diz nada e obriga a
    // baixar o .txt so p/ descobrir que a Meta recusou o objeto.
    const err = rec.json && rec.json.error;
    if (err) {
      const cod = [err.code, err.error_subcode].filter((x) => x !== undefined && x !== null).join('/');
      const div = document.createElement('div');
      div.className = 't-err';
      div.textContent = (cod ? `#${cod} ` : '') + String(err.message || '').replace(/\s+/g, ' ');
      div.title = err.message || '';
      tr.children[0].appendChild(div);
    }

    tr.dataset.ok = ok ? '1' : '0';
    tr.dataset.temId = (rec.traceId || rec.requestId) ? '1' : '0';
    UI.filtraLinha(tr);
    UI.refreshGroups();

    // contador 2xx/total no cabecalho do grupo
    const cnt = $('logBody').querySelector(`.g-count[data-perm="${rec.perm}"]`);
    if (cnt) {
      const doGrupo = S.calls.filter((x) => x.perm === rec.perm);
      const ok2 = doGrupo.filter((x) => x.status >= 200 && x.status < 300).length;
      cnt.textContent = `${ok2}/${doGrupo.length} 2xx`;
    }
  },
  // Resumo mostrado no cabeçalho quando a Configuracao esta recolhida — assim da
  // p/ fechar a banda e ganhar altura sem perder de vista o que vai ser usado.
  summary(c) {
    const el = $('setupSum');
    el.innerHTML = '';
    const chip = (txt, cls) => {
      const s = document.createElement('span');
      s.className = 'badge' + (cls ? ' ' + cls : '');
      s.textContent = txt;
      el.appendChild(s);
    };
    // encurtado: o resumo fica visivel na tela recolhida, e os campos estao
    // mascarados justamente p/ poder mostrar a tela sem expor os IDs
    const curto = (v) => (v.length > 10 ? `${v.slice(0, 4)}…${v.slice(-4)}` : v);
    if (c.wabaId) chip('WABA ' + curto(c.wabaId), 'sig');
    if (c.phoneId) chip('phone ' + curto(c.phoneId));
    const blocos = [];
    if (c.bMgmt) blocos.push('management');
    if (c.bMsg) blocos.push('messaging');
    if (c.bBiz) blocos.push('business');
    if (blocos.length) chip(blocos.join(' + '), 'info');
  },
};

/**
 * Combobox: botao abre a lista INTEIRA, digitar filtra, e qualquer valor fora da
 * lista continua valendo. Substitui o <datalist> nativo, que no Chrome filtra
 * pelo valor ja preenchido e por isso nao mostrava nada com o campo preenchido.
 * itemsFn() -> [{ value, hint? }]
 * onPick(item) opcional: recebe o item inteiro (p/ quem precisa do id, nao do texto).
 */
const COMBOS = [];   // p/ abrir um fechar os outros

function makeCombo(id, itemsFn, onPick) {
  const input = $(id);
  const btn = input.closest('.combo').querySelector('.combo-btn');
  const pop = document.createElement('div');
  pop.className = 'combo-pop';
  pop.hidden = true;
  document.body.appendChild(pop);

  let filtro = '';
  let idx = -1;
  let itens = [];

  const place = () => {
    const r = input.getBoundingClientRect();
    pop.style.left = `${r.left}px`;
    pop.style.width = `${Math.max(r.width, 250)}px`;
    const abaixo = window.innerHeight - r.bottom;
    if (abaixo < 190 && r.top > abaixo) {          // sem espaco embaixo: abre p/ cima
      pop.style.top = 'auto';
      pop.style.bottom = `${window.innerHeight - r.top + 4}px`;
    } else {
      pop.style.bottom = 'auto';
      pop.style.top = `${r.bottom + 4}px`;
    }
  };

  const draw = () => {
    const q = filtro.trim().toLowerCase();
    // busca no rotulo E na dica (p/ achar tanto por nome quanto por id)
    itens = itemsFn().filter((it) => !q || `${it.value} ${it.hint || ''}`.toLowerCase().includes(q));
    pop.innerHTML = '';
    if (!itens.length) {
      const d = document.createElement('div');
      d.className = 'combo-empty';
      d.textContent = q ? 'nada na lista com esse texto — pode digitar o valor mesmo assim'
        : 'lista vazia — descubra os IDs ou digite o valor';
      pop.appendChild(d);
      return;
    }
    itens.forEach((it, i) => {
      const d = document.createElement('div');
      d.className = 'combo-item' + (i === idx ? ' on' : '');
      const v = document.createElement('span');
      v.textContent = it.value;
      d.appendChild(v);
      if (it.hint) {
        const s = document.createElement('i');
        s.textContent = it.hint;
        d.appendChild(s);
      }
      // mousedown (nao click): dispara antes do blur do input fechar o popup
      d.addEventListener('mousedown', (e) => { e.preventDefault(); pick(it); });
      pop.appendChild(d);
    });
  };

  // O fechamento por blur e adiado (p/ dar tempo do clique num item registrar).
  // Esse timer PRECISA ser cancelado ao abrir: senao o clique na setinha tira o
  // foco do input, agenda o fecha, abre o popup — e o timer fecha logo depois.
  let timerFecha = null;
  const close = () => { clearTimeout(timerFecha); pop.hidden = true; idx = -1; };
  const open = (q) => {
    clearTimeout(timerFecha);
    COMBOS.forEach((fecha) => { if (fecha !== close) fecha(); });
    filtro = q || ''; idx = -1; draw(); place(); pop.hidden = false;
  };
  const pick = (it) => {
    close();
    if (onPick) { onPick(it); return; }
    input.value = it.value;
    input.dispatchEvent(new Event('change'));
  };
  COMBOS.push(close);

  // preventDefault no mousedown: o foco nem chega a sair do input
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    if (pop.hidden) { open(''); input.focus(); } else close();
  });
  input.addEventListener('input', () => open(input.value));
  input.addEventListener('blur', () => { timerFecha = setTimeout(close, 130); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (pop.hidden) { open(''); return; }
      idx = e.key === 'ArrowDown' ? Math.min(idx + 1, itens.length - 1) : Math.max(idx - 1, 0);
      draw();
      const on = pop.querySelector('.combo-item.on');
      if (on) on.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter' && !pop.hidden && idx >= 0 && itens[idx]) {
      e.preventDefault();
      pick(itens[idx]);
    }
  });
  window.addEventListener('resize', () => { if (!pop.hidden) place(); });
  document.addEventListener('scroll', () => { if (!pop.hidden) place(); }, true);
}

// Campo mascarado com olhinho: permite gravar a tela / tirar print sem expor
// token nem os IDs do app.
function makeSecret(id) {
  const input = $(id);
  const wrap = input.closest('.secret');
  const btn = wrap.querySelector('.secret-btn');
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => {
    const visivel = input.type === 'text';
    input.type = visivel ? 'password' : 'text';
    wrap.classList.toggle('on', !visivel);
    btn.setAttribute('aria-label', visivel ? 'Mostrar' : 'Ocultar');
  });
}

const VERSOES = ['v26.0', 'v25.0', 'v24.0', 'v23.0', 'v22.0', 'v21.0', 'v20.0'];
const IDIOMAS = ['pt_BR', 'pt_PT', 'en_US', 'en_GB', 'en', 'es_ES', 'es_MX', 'es_AR', 'es',
  'fr', 'de', 'it', 'nl', 'ru', 'tr', 'ar', 'hi', 'id', 'ja', 'ko', 'zh_CN', 'zh_HK', 'zh_TW'];

// Templates da WABA: aprovados primeiro — sao os unicos que a Meta aceita enviar.
function templateItems() {
  const ordem = { APPROVED: 0, PENDING: 1, REJECTED: 2 };
  return [...S.templates]
    .sort((a, b) => (ordem[a.status] ?? 3) - (ordem[b.status] ?? 3) || String(a.name).localeCompare(b.name))
    .map((t) => ({ value: t.name, hint: `${t.language} · ${t.status}` }));
}

// Escolheu um template da lista: alinha o idioma com o que a Meta tem cadastrado
// (nome certo + idioma errado = 132001 na hora do envio).
function syncTemplateLang() {
  const nome = $('tplName').value.trim();
  if (!nome || !S.templates.length) return;
  const cand = S.templates.filter((t) => t.name === nome);
  if (!cand.length) return;
  const alvo = cand.find((t) => t.status === 'APPROVED') || cand[0];
  if (alvo.language && $('tplLang').value.trim() !== alvo.language) {
    $('tplLang').value = alvo.language;
    saveCfg();
  }
}

// Itens do dropdown de escolha. Sem nome (caso dos ids vindos de granular_scopes)
// o id vira o rotulo — senao apareceria duas vezes na mesma linha.
const candItems = (lista) => lista.map((x) => (x.label
  ? { value: x.label, hint: x.id, id: x.id }
  : { value: x.id, hint: '', id: x.id }));

/**
 * Mostra o seletor de cada grupo que tem mais de uma opcao — com uma so, o campo
 * ja foi preenchido e o seletor seria ruido. Sao dropdowns com busca: com 40+
 * WABAs uma lista de chips seria impraticavel.
 */
function renderPickers() {
  const grupo = (row, lbl, titulo, lista, campo, pick) => {
    const mostra = lista && lista.length > 1;
    $(row).hidden = !mostra;
    if (!mostra) return;
    $(lbl).textContent = `${titulo} (${lista.length})`;
    const atual = lista.find((x) => x.id === $(campo).value);
    $(pick).value = atual ? (atual.label || atual.id) : '';
    $(pick).title = atual ? `${atual.label || ''} ${atual.id}`.trim() : '';
  };
  grupo('rowWaba', 'lblWaba', 'WABAs disponíveis', S.cands.wabas, 'wabaId', 'pickWaba');
  grupo('rowPhone', 'lblPhone', 'Números da WABA', S.cands.phones, 'phoneId', 'pickPhone');
  grupo('rowBiz', 'lblBiz', 'Empresas', S.cands.businesses, 'businessId', 'pickBiz');
}

// Trocar de WABA invalida numero e templates: recarrega os dois p/ a escolhida.
async function escolherWaba(id) {
  $('wabaId').value = id;
  $('phoneId').value = '';
  S.templates = [];
  S.cands.phones = [];
  saveCfg(); renderPickers();
  $('rowWaba').classList.add('busy');   // 3 chamadas: trava a faixa enquanto recarrega
  $('rowPhone').classList.add('busy');
  const c = cfg();
  const found = { phoneId: '' };
  try {
    await loadWaba(id, c, found, null);
    if (found.phoneId) $('phoneId').value = found.phoneId;
    const w = await quickGet(`${id}?fields=id,name,owner_business_info`, c);
    const owner = w.json && w.json.owner_business_info;
    if (owner && owner.id) { addCand(S.cands.businesses, owner.id, owner.name); $('businessId').value = String(owner.id); }
    saveCfg();
    const nome = (S.cands.wabas.find((x) => x.id === id) || {}).label;
    logDiscover(`usando a WABA ${nome || id}${S.templates.length ? ` — ${S.templates.length} templates` : ''}`, 'ok');
  } catch (e) {
    logDiscover('falhou ao trocar de WABA: ' + e.message, 'err');
  } finally {
    $('rowWaba').classList.remove('busy');
    $('rowPhone').classList.remove('busy');
    renderPickers();
  }
}

// Cada linha vira um item da strip horizontal (o ponto colorido vem do CSS).
function logDiscover(msg, kind) {
  const line = document.createElement('div');
  if (kind) line.className = kind;
  line.textContent = msg;
  $('discoverOut').appendChild(line);
}

/**
 * Lê o resultado da execucao e traduz os padroes de recusa mais comuns da Meta.
 * Sem isso o usuario ve so uma coluna de 400 iguais e nao sabe o que corrigir.
 */
function diagnose(c) {
  const err = (x) => (x.json && x.json.error) || null;
  const semAcesso = S.calls.filter((x) => {
    const e = err(x);
    if (!e) return false;
    return Number(e.code) === 100 &&
      (Number(e.error_subcode) === 33 || /does not exist|cannot be loaded/i.test(e.message || ''));
  });
  const semScope = S.calls.filter((x) => {
    const e = err(x);
    return e && (Number(e.code) === 200 || /requires .* permission/i.test(e.message || ''));
  });
  const tokenRuim = S.calls.some((x) => {
    const e = err(x);
    return e && Number(e.code) === 190;
  });

  if (tokenRuim) {
    logDiscover('token invalido ou expirado (erro 190) — gere um novo', 'err');
    return;
  }
  if (semAcesso.length >= 2) {
    const alvos = [...new Set(semAcesso.map((x) => {
      const m = x.endpoint.match(/\/(\d{6,})(?:\/|$)/);
      return m ? m[1] : null;
    }).filter(Boolean))];
    logDiscover(
      `${semAcesso.length} chamadas recusadas com "#100 objeto nao existe / sem permissao"` +
      (alvos.length ? ` nos IDs ${alvos.join(' e ')}` : '') +
      ' — este token nao enxerga esses assets. Clique em Limpar IDs e depois Descobrir IDs.',
      'err',
    );
  }
  if (semScope.length) {
    const perms = [...new Set(semScope.map((x) => {
      const m = (err(x).message || '').match(/Requires ([a-z_]+) permission/i);
      return m ? m[1] : null;
    }).filter(Boolean))];
    logDiscover(
      `${semScope.length} chamadas recusadas por falta de permission` +
      (perms.length ? `: ${perms.join(', ')}` : '') +
      ' — a recusa foi gravada na evidencia como veio da Meta',
      'err',
    );
  }
}

/** Botao em estado ocupado: troca o conteudo por spinner + texto, e restaura. */
function busy(id, on, txt) {
  const b = $(id);
  if (on) {
    if (!b.dataset.html) b.dataset.html = b.innerHTML;
    b.classList.add('loading');
    b.disabled = true;
    b.innerHTML = '<span class="ldr"></span>';
    if (txt) b.append(txt);
  } else {
    b.classList.remove('loading');
    b.disabled = false;
    if (b.dataset.html) { b.innerHTML = b.dataset.html; delete b.dataset.html; }
  }
}

/* --------------------------- ações da UI ---------------------------------*/
async function onDiscover() {
  const c = cfg();
  $('discoverOut').innerHTML = '';
  if (!c.token) { logDiscover('informe o access token primeiro', 'err'); return; }
  busy('discoverBtn', true, 'Descobrindo…');
  try {
    const f = await discover(c, logDiscover);
    if (f.appId) $('appId').value = f.appId;
    if (f.wabaId) $('wabaId').value = f.wabaId;
    if (f.phoneId) $('phoneId').value = f.phoneId;
    if (f.businessId) $('businessId').value = f.businessId;
    if (!f.wabaId) logDiscover('WABA nao encontrada — preencha o WABA ID na mao (System User token nao expoe target_ids)', 'err');
    saveCfg();
  } catch (e) {
    logDiscover('falhou: ' + e.message, 'err');
  } finally {
    busy('discoverBtn', false);
  }
}

/** Carrega templates e números da WABA que está no campo (sem descoberta completa). */
async function onLoadTemplates() {
  const c = cfg();
  $('discoverOut').innerHTML = '';
  if (!c.token) { logDiscover('informe o access token primeiro', 'err'); return; }
  if (!c.wabaId) { logDiscover('preencha a Identificação da conta do WhatsApp Business (WABA ID)', 'err'); return; }
  // botao de icone dentro do campo: gira o proprio refresh em vez de trocar texto
  const b = $('tplBtn');
  b.classList.add('loading');
  b.disabled = true;
  try {
    const found = { phoneId: c.phoneId };
    await loadWaba(c.wabaId, c, found, logDiscover);
    if (found.phoneId) $('phoneId').value = found.phoneId;
    saveCfg();
    renderPickers();
    if (!S.templates.length) {
      logDiscover('nenhum template retornado — confira se o WABA ID é acessível por este token', 'err');
    }
  } catch (e) {
    logDiscover('falhou: ' + e.message, 'err');
  } finally {
    b.classList.remove('loading');
    b.disabled = false;
  }
}

async function onPing() {
  const c = cfg();
  $('discoverOut').innerHTML = '';
  if (!c.token) { logDiscover('informe o access token primeiro', 'err'); return; }
  busy('pingBtn', true, 'Testando…');
  try {
    const me = await quickGet('me?fields=id,name', c);
    if (me.status !== 200) {
      const msg = (me.json && me.json.error && me.json.error.message) || `HTTP ${me.status}`;
      logDiscover(`token recusado: ${msg}`, 'err');
      return;
    }
    logDiscover(`conectado — ${(me.json && me.json.name) || me.json.id} (id ${me.json.id})`, 'ok');

    const perms = await quickGet('me/permissions', c);
    const granted = (perms.json && Array.isArray(perms.json.data) ? perms.json.data : [])
      .filter((p) => p.status === 'granted').map((p) => p.permission);
    for (const p of ['whatsapp_business_messaging', 'whatsapp_business_management', 'business_management']) {
      logDiscover(`${p}: ${granted.includes(p) ? 'concedida' : 'NAO concedida'}`, granted.includes(p) ? 'ok' : 'err');
    }
  } catch (e) {
    logDiscover('falhou: ' + e.message, 'err');
  } finally {
    busy('pingBtn', false);
  }
}

async function onRun() {
  const c = cfg();
  if (!c.token) { alert('Informe o access token.'); $('token').focus(); return; }
  if (!c.bMgmt && !c.bMsg && !c.bBiz) { alert('Selecione ao menos um bloco de permissao.'); return; }
  saveCfg();

  S.calls = []; S.abort = false; S.running = true;
  UI.reset();
  updateSteps();
  UI.status('descobrindo IDs…', 'info');
  $('runBtn').disabled = true;
  $('stopBtn').style.display = '';
  $('downloadBtn').disabled = true; $('copyBtn').disabled = true;
  $('discoverOut').innerHTML = '';

  try {
    // Completa o que faltar sem sobrescrever o que o usuario digitou.
    const f = await discover(c, logDiscover);
    c.appId = c.appId || f.appId;
    c.wabaId = c.wabaId || f.wabaId;
    c.phoneId = c.phoneId || f.phoneId;
    c.businessId = c.businessId || f.businessId;
    ['appId', 'wabaId', 'phoneId', 'businessId'].forEach((k) => { if (c[k]) $(k).value = c[k]; });

    if (c.bMgmt && !c.wabaId && !c.phoneId) {
      logDiscover('management sem WABA e sem Phone Number ID: nada a executar nesse bloco', 'err');
    }
    if (c.bMsg && !c.phoneId) {
      logDiscover('messaging exige Phone Number ID — bloco sera pulado', 'err');
    }

    const plan = buildPlan(c);
    const ctx = { appId: c.appId, wamid: '' };
    UI.status(`executando 0/${plan.length}`, 'info');
    // IDs ja resolvidos: recolhe a Configuracao e devolve a altura ao workspace.
    UI.summary(c);
    $('setup').open = false;

    let profileAbout = '';
    for (let i = 0; i < plan.length; i++) {
      if (S.abort) { UI.status('interrompido', 'warn'); break; }
      const spec = plan[i];

      // Perfil business: regrava exatamente o valor lido (nao altera producao).
      if (spec.tag === 'profileWrite') {
        spec.json = { messaging_product: 'whatsapp', about: profileAbout || 'Atendimento via WhatsApp Business.' };
      }

      const tr = UI.row(spec);
      const rec = await runCall(spec, c);
      UI.fill(tr, rec);
      UI.refreshKpis();
      UI.progress(i + 1, plan.length);
      UI.status(`executando ${i + 1}/${plan.length}`, 'info');

      if (spec.tag === 'profileRead' && rec.json && Array.isArray(rec.json.data) && rec.json.data[0]) {
        profileAbout = rec.json.data[0].about || '';
      }
      if (spec.tag === 'sendTpl' && rec.json && Array.isArray(rec.json.messages) && rec.json.messages[0]) {
        ctx.wamid = rec.json.messages[0].id;
      }
      await sleep(220);
    }

    S.doc = buildDoc(c, ctx);
    S.filename = evidenceFilename(c.appId);
    $('preview').value = S.doc;
    $('docEmpty').style.display = 'none';
    $('preview').style.display = '';
    $('downloadBtn').disabled = false;
    $('copyBtn').disabled = false;

    const okCount = S.calls.filter((x) => x.status >= 200 && x.status < 300).length;
    UI.status(`${okCount}/${S.calls.length} em 2xx`, okCount === S.calls.length ? 'ok' : 'warn');
    diagnose(c);

    // hero de resultado: o download vira o destaque do painel
    const errN = S.calls.length - okCount;
    const kb = (new Blob([S.doc]).size / 1024).toFixed(1).replace('.', ',');
    $('dhTitle').textContent = errN
      ? `Evidência gerada — ${errN} recusa${errN > 1 ? 's' : ''} registrada${errN > 1 ? 's' : ''} como veio da Meta`
      : 'Evidência pronta — todas as chamadas em 2xx';
    $('dhFile').textContent = `${S.filename} · ${kb} KB`;
    $('dhStats').textContent = `${S.calls.length} chamadas · ${okCount} em 2xx` + (ctx.wamid ? ' · wamid capturado' : '');
    $('docHero').classList.toggle('warn', errN > 0);
    $('docHero').hidden = false;
    $('docBar').hidden = true;
    $('expandBtn').disabled = false;
  } catch (e) {
    UI.status('erro', 'err');
    logDiscover('execucao falhou: ' + e.message, 'err');
    console.error(e);
  } finally {
    S.running = false;
    $('runBtn').disabled = false;
    $('stopBtn').style.display = 'none';
    updateSteps();
  }
}

/* ==========================================================================
 * 7. MODO ATIVAR NUMERO — GET /{waba}/phone_numbers + POST /{phone}/register
 *    Usa token e versao da Configuracao. NAO entra no log nem no .txt da
 *    evidencia: e uma operacao de setup, com painel de Resultado proprio.
 * ========================================================================*/

// Abas da topbar: cada modo mostra so os blocos dele (CSS .ev-only / .at-only).
function setMode(m) {
  const modo = m === 'ativar' ? 'ativar' : 'evid';
  document.body.dataset.mode = modo;
  document.querySelectorAll('.mode').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.mode === modo)));
  try { localStorage.setItem(LS + 'mode', modo); } catch (_) { /* ignora */ }
  // a WABA da evidencia ja serve de ponto de partida p/ a ativacao
  if (modo === 'ativar' && !$('hookId').value.trim() && $('wabaId').value.trim()) {
    $('hookId').value = $('wabaId').value.trim();
  }
  updateAtivar();
}

// platform_type diz se o numero ja esta registrado na Cloud API:
// CLOUD_API = ativo; NOT_APPLICABLE = ainda nao registrado (precisa do /register).
function hookStatus(n) {
  if (n.platform_type === 'CLOUD_API') return { txt: 'ativo', cls: 'ok' };
  if (n.platform_type === 'ON_PREMISE') return { txt: 'On-Premises', cls: 'info' };
  if (n.platform_type === 'NOT_APPLICABLE') return { txt: 'não registrado', cls: 'warn' };
  return { txt: n.platform_type || 'status ?', cls: '' };
}

// Erros mais comuns do /register — a mensagem crua da Meta raramente diz o que fazer.
const REGISTER_HINTS = {
  133005: 'PIN não confere: este número já tem verificação em duas etapas com outro PIN',
  133006: 'o número precisa ser verificado de novo (código por SMS/voz) antes de registrar',
  133008: 'tentativas demais de PIN — aguarde antes de tentar de novo',
  133009: 'PIN enviado rápido demais — aguarde alguns segundos',
  133015: 'o número foi excluído há pouco — aguarde ~5 minutos e tente de novo',
  133016: 'limite de register/deregister atingido (10 em 72h) para este número',
};

/** Uma entrada no painel Resultado: titulo + status + mensagem + resposta crua. */
function atLog(kind, titulo, msg, rec) {
  $('atEmpty').hidden = true;
  const ev = document.createElement('div');
  ev.className = 'at-ev' + (kind ? ' ' + kind : '');
  const h = document.createElement('div');
  h.className = 'at-ev-h';
  if (rec) {
    const b = document.createElement('span');
    b.className = 'badge ' + (rec.status >= 200 && rec.status < 300 ? 'ok' : 'err');
    b.textContent = rec.status || 'falhou';
    h.appendChild(b);
  }
  const t = document.createElement('b');
  t.textContent = titulo;
  const tm = document.createElement('time');
  tm.textContent = new Date().toLocaleTimeString('pt-BR');
  h.append(t, tm);
  ev.appendChild(h);
  if (msg) {
    const p = document.createElement('p');
    p.textContent = msg;
    ev.appendChild(p);
  }
  if (rec) {
    const d = document.createElement('details');
    const sm = document.createElement('summary');
    sm.textContent = `${rec.method} ${rec.endpoint}` + (rec.requestId ? ` · request-id ${rec.requestId}` : '');
    const pre = document.createElement('pre');
    pre.textContent = rec.json ? pretty(rec.json) : (rec.text || '(corpo vazio)');
    d.append(sm, pre);
    ev.appendChild(d);
  }
  $('atOut').prepend(ev);   // mais recente no topo
}

function renderAtList() {
  const box = $('atList');
  box.innerHTML = '';
  if (!S.hookPhones.length) {
    const d = document.createElement('div');
    d.className = 'at-none';
    d.textContent = 'Busque os números da conta no passo 1.';
    box.appendChild(d);
    return;
  }
  const atual = $('hookPhone').value.trim();
  S.hookPhones.forEach((n) => {
    const st = hookStatus(n);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'at-num' + (n.id === atual ? ' on' : '');
    b.innerHTML = '<span class="rd"></span><span class="tx"><b></b><span></span></span><span class="badge"></span>';
    b.querySelector('.tx b').textContent = n.display_phone_number || n.id;
    b.querySelector('.tx span').textContent = [n.verified_name, `id ${n.id}`].filter(Boolean).join(' · ');
    const bd = b.querySelector('.badge');
    bd.textContent = st.txt;
    if (st.cls) bd.classList.add(st.cls);
    b.addEventListener('click', () => {
      $('hookPhone').value = n.id;
      saveCfg();
      renderAtList();
      updateAtivar();
      $('hookPin').focus();
    });
    box.appendChild(b);
  });
}

// Marca os passos concluidos e so libera o Ativar com numero + PIN validos.
function updateAtivar() {
  const phone = $('hookPhone').value.trim();
  const pin = $('hookPin').value.trim();
  const phoneOk = /^\d+$/.test(phone);
  const pinOk = /^\d{6}$/.test(pin);
  $('atC1').classList.toggle('done', S.hookPhones.length > 0);
  $('atC2').classList.toggle('done', phoneOk);
  $('atC3').classList.toggle('done', false);
  $('hookRegisterBtn').disabled = !(phoneOk && pinOk) || $('hookRegisterBtn').classList.contains('loading');
  let msg = 'Pronto para ativar.';
  if (!phone) msg = 'Escolha um número no passo 2.';
  else if (!phoneOk) msg = 'O Phone Number ID tem só dígitos — não é o telefone formatado.';
  else if (!pin) msg = 'Informe o PIN de 6 dígitos.';
  else if (!pinOk) msg = 'O PIN precisa ter exatamente 6 dígitos.';
  $('atReady').textContent = msg;
}

async function onHookPhones() {
  const c = cfg();
  if (!c.token) {
    atLog('err', 'Sem access token', 'Preencha o Access Token na Configuração acima.');
    $('setup').open = true; $('token').focus(); return;
  }
  if (!c.hookId) { atLog('err', 'Sem WABA ID', 'Informe o WABA ID no passo 1.'); $('hookId').focus(); return; }
  saveCfg();

  busy('hookPhonesBtn', true, 'Buscando…');
  try {
    const rec = await runCall({ label: 'GET /{waba}/phone_numbers', method: 'GET',
      path: `${c.hookId}/phone_numbers`, solo: true }, c);
    const lista = rec.json && Array.isArray(rec.json.data) ? rec.json.data : null;
    if (rec.status >= 200 && rec.status < 300 && lista) {
      S.hookPhones = lista;
      // um numero so, ou o escolhido antes nao e desta conta: ja deixa o primeiro marcado
      if (lista.length && !lista.some((n) => n.id === $('hookPhone').value.trim())) {
        $('hookPhone').value = lista[0].id;
        saveCfg();
      }
      const pend = lista.filter((n) => n.platform_type === 'NOT_APPLICABLE').length;
      atLog(lista.length ? 'ok' : 'err', 'Números da conta',
        lista.length
          ? `${lista.length} número${lista.length > 1 ? 's' : ''} encontrado${lista.length > 1 ? 's' : ''}` +
            (pend ? ` — ${pend} ainda não registrado${pend > 1 ? 's' : ''}` : '')
          : 'Nenhum número nesta conta.', rec);
    } else {
      S.hookPhones = [];
      const e = rec.json && rec.json.error;
      atLog('err', 'Não foi possível listar os números', (e && (e.error_user_msg || e.message)) || rec.text || `HTTP ${rec.status}`, rec);
    }
  } catch (e) {
    atLog('err', 'Falha na chamada', e.message);
  } finally {
    busy('hookPhonesBtn', false);
    renderAtList();
    updateAtivar();
  }
}

async function onHookRegister() {
  const c = cfg();
  if (!c.token) {
    atLog('err', 'Sem access token', 'Preencha o Access Token na Configuração acima.');
    $('setup').open = true; $('token').focus(); return;
  }
  if (!/^\d+$/.test(c.hookPhone) || !/^\d{6}$/.test(c.hookPin)) { updateAtivar(); return; }
  saveCfg();

  const n = S.hookPhones.find((x) => x.id === c.hookPhone);
  const nome = n ? `${n.display_phone_number || c.hookPhone}${n.verified_name ? ` (${n.verified_name})` : ''}` : c.hookPhone;
  busy('hookRegisterBtn', true, 'Ativando…');
  try {
    const rec = await runCall({ label: 'POST /{phone}/register', method: 'POST',
      path: `${c.hookPhone}/register`, solo: true,
      json: { messaging_product: 'whatsapp', pin: c.hookPin } }, c);
    // o PIN nao fica guardado no registro da chamada
    rec.reqBody = { messaging_product: 'whatsapp', pin: '******' };
    rec.curl = rec.curl.split(c.hookPin).join('******');

    if (rec.status >= 200 && rec.status < 300 && rec.json && rec.json.success) {
      atLog('ok', `WhatsApp ativado — ${nome}`,
        'Número registrado na Cloud API. O PIN informado agora é o PIN da verificação em duas etapas dele.', rec);
      $('hookPin').value = '';
      if (n) { n.platform_type = 'CLOUD_API'; renderAtList(); }
      $('atC3').classList.add('done');
    } else {
      const e = rec.json && rec.json.error;
      const cod = e && (e.error_subcode || e.code);
      const dica = e && (REGISTER_HINTS[e.code] || REGISTER_HINTS[e.error_subcode]);
      atLog('err', `Falhou ao ativar ${nome}`,
        (dica || (e && (e.error_user_msg || e.message)) || rec.text || `HTTP ${rec.status}`) + (cod ? ` (#${cod})` : ''), rec);
    }
  } catch (e) {
    atLog('err', 'Falha na chamada', e.message);
  } finally {
    busy('hookRegisterBtn', false);
    const ativou = $('atC3').classList.contains('done');
    updateAtivar();
    if (ativou) $('atC3').classList.add('done');
  }
}

function onDownload() {
  if (!S.doc) return;
  const blob = new Blob([S.doc], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = S.filename || 'evidencia.txt';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// Copia o documento; o feedback aparece no botao que foi clicado (docbar ou hero).
async function copyDoc(btn) {
  if (!S.doc) return;
  try {
    await navigator.clipboard.writeText(S.doc);
    btn.textContent = 'Copiado';
  } catch (_) {
    // clipboard API costuma ser bloqueada em file:// — seleciona p/ Ctrl+C.
    // Com o viewer aberto, a selecao tem que ser NELE (o preview esta atras do modal).
    if ($('viewer').open) {
      const r = document.createRange();
      r.selectNodeContents($('vwPre'));
      const sel = window.getSelection();
      sel.removeAllRanges(); sel.addRange(r);
    } else {
      $('preview').removeAttribute('readonly');
      $('preview').select();
      $('preview').setAttribute('readonly', '');
    }
    btn.textContent = 'Selecionado — Ctrl+C';
  }
  setTimeout(() => { btn.textContent = 'Copiar'; }, 1800);
}

/** Evidência em tela cheia — leitura confortável do .txt antes de submeter. */
function openViewer() {
  if (!S.doc) return;
  $('vwPre').textContent = S.doc;
  $('vwFile').textContent = S.filename;
  const ok = S.calls.filter((x) => x.status >= 200 && x.status < 300).length;
  const kb = (new Blob([S.doc]).size / 1024).toFixed(1).replace('.', ',');
  $('vwStats').textContent = `${S.calls.length} chamadas · ${ok} em 2xx · ${kb} KB`;
  $('viewer').showModal();
}

/**
 * Chamadas em tela cheia. Nao clona: MOVE os nos reais (badge de status, barra,
 * kpis e tabela) para dentro do dialog — filtros, contadores e linhas chegando
 * ao vivo continuam funcionando la dentro. O evento `close` devolve tudo ao
 * painel em qualquer fechamento (botao OU Esc).
 */
function openLogViewer() {
  $('lvStatusSlot').appendChild($('statusBadge'));
  $('lvBody').append($('progBar').parentElement, $('kpis'), $('logWrap'));
  $('logViewer').showModal();
}
function restoreLogViewer() {
  const pane = document.querySelector('.ws .pane');   // painel Chamadas (o primeiro)
  // ordem original do painel: .ph, barra, kpis, tabela — e o badge volta ao .ph
  pane.querySelector('.ph').appendChild($('statusBadge'));
  pane.append($('progBar').parentElement, $('kpis'), $('logWrap'));
}

/**
 * Trilha de etapas da topbar. Estados calculados do proprio formulario/execucao:
 * 1 Credenciais = token preenchido; 2 Contas = WABA + numero resolvidos;
 * 3 Execucao = ja rodou (pulsa enquanto roda); 4 Evidencia = .txt pronto.
 */
function updateSteps() {
  const s1 = !!$('token').value.trim();
  const s2 = !!$('wabaId').value.trim() && !!$('phoneId').value.trim();
  const s3 = S.calls.length > 0 && !S.running;
  const s4 = !!S.doc;
  // ativa = a primeira etapa ainda nao concluida (executando, e sempre a 3)
  const ativa = S.running ? 3 : (!s1 ? 1 : (!s2 ? 2 : (!s3 && !s4 ? 3 : 4)));
  [[1, s1], [2, s2], [3, s3], [4, s4]].forEach(([n, done]) => {
    const el = document.querySelector(`.step[data-step="${n}"]`);
    if (!el) return;
    el.classList.toggle('done', done);
    el.classList.toggle('on', ativa === n);
    el.classList.toggle('run', n === 3 && S.running);
  });
}

/* --------------------------------- init ----------------------------------*/
loadCfg();
$('discoverBtn').addEventListener('click', onDiscover);
$('pingBtn').addEventListener('click', onPing);
$('tplBtn').addEventListener('click', onLoadTemplates);
$('kpis').addEventListener('click', (e) => {
  const k = e.target.closest('.kpi');
  if (k) UI.aplicaFiltro(k.dataset.filter);
});
$('clearIdsBtn').addEventListener('click', () => {
  ['wabaId', 'phoneId', 'businessId'].forEach((k) => { $(k).value = ''; });
  saveCfg();
  $('discoverOut').innerHTML = '';
  logDiscover('IDs limpos — clique em Descobrir IDs para resolver pelo token');
});
$('runBtn').addEventListener('click', onRun);
$('hookPhonesBtn').addEventListener('click', onHookPhones);
$('hookRegisterBtn').addEventListener('click', onHookRegister);
$('hookPhone').addEventListener('input', () => { renderAtList(); updateAtivar(); });
$('hookPin').addEventListener('input', () => {
  $('hookPin').value = $('hookPin').value.replace(/\D/g, '').slice(0, 6);
  updateAtivar();
});
$('hookPin').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !$('hookRegisterBtn').disabled) onHookRegister();
});
$('hookId').addEventListener('keydown', (e) => { if (e.key === 'Enter') onHookPhones(); });
$('atClear').addEventListener('click', () => {
  $('atOut').querySelectorAll('.at-ev').forEach((x) => x.remove());
  $('atEmpty').hidden = false;
});
document.querySelectorAll('.mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('stopBtn').addEventListener('click', () => { S.abort = true; });
$('downloadBtn').addEventListener('click', onDownload);
$('dlBtn2').addEventListener('click', onDownload);
$('expandBtn').addEventListener('click', openViewer);
$('vwClose').addEventListener('click', () => $('viewer').close());
$('vwDl').addEventListener('click', onDownload);
$('vwCp').addEventListener('click', () => copyDoc($('vwCp')));
$('logExpandBtn').addEventListener('click', openLogViewer);
$('lvClose').addEventListener('click', () => $('logViewer').close());
$('logViewer').addEventListener('close', restoreLogViewer);
$('copyBtn').addEventListener('click', () => copyDoc($('copyBtn')));
$('cpBtn2').addEventListener('click', () => copyDoc($('cpBtn2')));
$('themeBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  // .theming liga transicoes por ~260ms — troca de tema deixa de "estalar"
  document.documentElement.classList.add('theming');
  document.documentElement.dataset.theme = next;
  setTimeout(() => document.documentElement.classList.remove('theming'), 260);
  try { localStorage.setItem(LS + 'theme', next); } catch (_) { /* ignora */ }
});
[...TEXT_FIELDS, ...CHK_FIELDS].forEach((k) => {
  const el = $(k);
  if (el) el.addEventListener('change', saveCfg);
});

/* trilha de etapas: estados vivos + navegacao (nunca dispara execucao) */
$('token').addEventListener('input', updateSteps);
document.querySelectorAll('.step').forEach((st) => st.addEventListener('click', () => {
  const n = +st.dataset.step;
  if (n === 1 || n === 2) {
    $('setup').open = true;
    const alvo = $(n === 1 ? 'token' : 'wabaId');
    alvo.focus();
    alvo.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } else if (n === 3) {
    document.querySelector('.band').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  } else if (n === 4 && S.doc) {
    document.querySelectorAll('.pane')[1].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}));
$('tplName').addEventListener('change', syncTemplateLang);
$('graphVersion').addEventListener('change', () => { $('graphVersion').value = normVersion($('graphVersion').value); });

makeCombo('graphVersion', () => VERSOES.map((v) => ({ value: v })));
makeCombo('tplLang', () => IDIOMAS.map((v) => ({ value: v })));
makeCombo('tplName', templateItems);
makeCombo('pickWaba', () => candItems(S.cands.wabas), (it) => escolherWaba(it.id));
makeCombo('pickPhone', () => candItems(S.cands.phones), (it) => {
  $('phoneId').value = it.id; saveCfg(); renderPickers();
  logDiscover(`usando o número ${it.value}`, 'ok');
});
makeCombo('pickBiz', () => candItems(S.cands.businesses), (it) => {
  $('businessId').value = it.id; saveCfg(); renderPickers();
  logDiscover(`usando a empresa ${it.value}`, 'ok');
});

updateSteps();   // estado inicial da trilha (considera o que veio do localStorage)
['token', 'appId', 'wabaId', 'phoneId', 'businessId', 'recipient', 'hookId', 'hookPin'].forEach(makeSecret);
setMode((() => { try { return localStorage.getItem(LS + 'mode'); } catch (_) { return null; } })());

/* --------------------- guia da submissão (modal) -------------------------*/
$('guideBtn').addEventListener('click', () => $('guide').showModal());
$('guideClose').addEventListener('click', () => $('guide').close());
$('guideNav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-sec]');
  if (!b) return;
  const sec = b.dataset.sec;
  $('guideNav').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  $('guideMain').querySelectorAll('section').forEach((s) => s.classList.toggle('on', s.dataset.sec === sec));
  $('guideMain').scrollTop = 0;
});
$('guideMain').addEventListener('click', async (e) => {
  const b = e.target.closest('.cp-btn');
  if (!b) return;
  const txt = b.parentElement.querySelector('pre').textContent;
  try {
    await navigator.clipboard.writeText(txt);
    b.textContent = 'Copiado';
  } catch (_) {
    // clipboard costuma ser bloqueada em file:// — seleciona p/ Ctrl+C
    const r = document.createRange();
    r.selectNodeContents(b.parentElement.querySelector('pre'));
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(r);
    b.textContent = 'Selecionado — Ctrl+C';
  }
  setTimeout(() => { b.textContent = 'Copiar'; }, 1800);
});
