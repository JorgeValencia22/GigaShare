'use strict';

/* ============================================================
   GIGASHARE — demo de almacenamiento con enlaces compartibles
   El enlace compartido lleva la información del archivo en el
   hash (#/f/...), así que funciona en cualquier navegador sin
   servidor propio. El archivo se aloja en un servicio público
   gratuito (Gofile) mediante su API anónima.
   ============================================================ */

const API_SERVERS = 'https://api.gofile.io/servers';
const LS_KEY = 'gigashare.files.v1';
const PLAN_FREE = 1024 ** 4;        // 1 TB (demo)
const PLAN_PRO = 5 * 1024 ** 4;     // 5 TB (demo)

const $ = (s) => document.querySelector(s);
const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};

/* ---------------- utilidades ---------------- */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
function fmtSize(bytes) {
  if (!bytes && bytes !== 0) return '—';
  let i = 0, n = bytes;
  while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
  const dec = n >= 100 || i === 0 ? 0 : 1;
  return n.toFixed(dec).replace('.', ',') + ' ' + UNITS[i];
}
function fmtSpeed(bps) {
  if (!bps || bps < 1) return '—';
  return fmtSize(bps) + '/s';
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('es', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}
function extOf(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return m ? m[1].toUpperCase() : 'FILE';
}

/* base64url para guardar los datos del archivo en el enlace */
function encodeData(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodeData(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}
function shareLink(rec) {
  const hash = '#/f/' + encodeData({ n: rec.name, s: rec.size, i: rec.id, v: rec.server, c: rec.code || '', t: rec.mime || '' });
  return location.origin + location.pathname + hash;
}
function downloadPage(rec) {
  if (rec.page) return rec.page;
  if (rec.id) return `https://gofile.io/d/${rec.code || ''}`.replace(/\/$/, '');
  return 'https://gofile.io';
}

/* ---------------- mis archivos (localStorage) ---------------- */
function loadFiles() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
}
function saveFiles(list) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(list)); } catch { /* modo privado */ }
}
let files = loadFiles();

/* ---------------- toast / modal ---------------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2200);
}
function modal(title, body) {
  $('#modalTitle').textContent = title;
  $('#modalBody').textContent = body;
  $('#modal').classList.remove('hidden');
}
$('#modalOk').addEventListener('click', () => $('#modal').classList.add('hidden'));
$('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') $('#modal').classList.add('hidden');
});

/* ---------------- cupo ---------------- */
function usedBytes() {
  return files.reduce((a, f) => a + (f.size || 0), 0);
}
function renderQuota() {
  const used = usedBytes();
  const total = PLAN_FREE;
  const pct = Math.min(100, (used / total) * 100);
  $('#quotaUsed').textContent = fmtSize(used);
  $('#quotaTotal').textContent = '1 TB';
  $('#quotaPct').textContent = (pct < 0.1 && pct > 0 ? '<0,1' : pct.toFixed(pct < 10 ? 1 : 0).replace('.', ',')) + ' %';
  $('#quotaFill').style.width = Math.max(pct, used > 0 ? 1 : 0) + '%';
}

/* ---------------- subida ---------------- */
async function getServer() {
  const r = await fetch(API_SERVERS);
  if (!r.ok) throw new Error('servidor no disponible');
  const j = await r.json();
  const list = (j && j.data && j.data.servers) || [];
  if (!list.length) throw new Error('sin servidores');
  return list[0].name;
}

function uploadFile(server, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://${server}.gofile.io/contents/uploadfile`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total, e.loaded);
    };
    xhr.onload = () => {
      let j;
      try { j = JSON.parse(xhr.responseText); } catch { return reject(new Error('respuesta inválida del servidor')); }
      if (j && j.status === 'ok' && j.data) resolve(j.data);
      else reject(new Error((j && (j.status || j.error)) || 'error de subida'));
    };
    xhr.onerror = () => reject(new Error('fallo de red'));
    xhr.ontimeout = () => reject(new Error('tiempo agotado'));
    const fd = new FormData();
    fd.append('file', file, file.name);
    xhr.send(fd);
  });
}

const queue = [];   // { id, file, node, cancelled }

function queueCard(file) {
  const node = el('div', 'up');
  node.innerHTML = `
    <div class="up-ico">${extOf(file.name)}</div>
    <div>
      <div class="up-name"></div>
      <div class="up-meta"></div>
      <div class="up-bar"><span></span></div>
    </div>
    <div class="up-state">En espera</div>`;
  node.querySelector('.up-name').textContent = file.name;
  node.querySelector('.up-meta').textContent = fmtSize(file.size);
  $('#queue').prepend(node);
  return node;
}

async function handleFiles(fileList) {
  const arr = Array.from(fileList).filter((f) => f && f.size >= 0);
  if (!arr.length) return;

  const total = usedBytes() + arr.reduce((a, f) => a + f.size, 0);
  if (total > PLAN_FREE) {
    modal('Sin espacio en el plan Gratis',
      'La demo del plan Gratis tiene 1 TB. El plan Pro (5 USD al mes) sube el cupo a 5 TB. Los planes son solo de muestra: no se cobra nada.');
    return;
  }

  let server;
  try {
    server = await getServer();
  } catch (e) {
    modal('No se pudo conectar', 'No se pudo contactar con el servicio de alojamiento (' + e.message + '). Revisa tu conexión e inténtalo otra vez.');
    return;
  }

  for (const file of arr) {
    const entry = { id: crypto.randomUUID(), file, cancelled: false, node: queueCard(file) };
    queue.push(entry);
    await runUpload(entry, server);
  }
  renderQuota();
}

function runUpload(entry, server) {
  const { file, node } = entry;
  const bar = node.querySelector('.up-bar');
  const fill = node.querySelector('.up-bar span');
  const meta = node.querySelector('.up-meta');
  const state = node.querySelector('.up-state');
  const started = Date.now();

  state.textContent = 'Subiendo…';
  bar.classList.remove('done', 'fail');

  return uploadFile(server, file, (ratio, loaded) => {
    const pct = Math.round(ratio * 100);
    fill.style.width = pct + '%';
    const secs = Math.max((Date.now() - started) / 1000, 0.1);
    const speed = loaded / secs;
    meta.textContent = `${fmtSize(loaded)} de ${fmtSize(file.size)} · ${fmtSpeed(speed)} · ${pct} %`;
  }).then((data) => {
    const rec = {
      name: data.name || file.name,
      size: data.size || file.size,
      mime: data.mimetype || file.type || '',
      id: data.id,
      server: (data.servers && data.servers[0]) || server,
      page: data.downloadPage || '',
      code: data.code || '',
      at: Date.now(),
    };
    files.unshift(rec);
    saveFiles(files);

    bar.classList.add('done');
    fill.style.width = '100%';
    meta.textContent = fmtSize(rec.size) + ' · listo';
    state.classList.add('ok');
    state.textContent = 'Completado';

    const x = el('button', 'xbtn', '&times;');
    x.title = 'Quitar de la lista';
    x.addEventListener('click', () => node.remove());
    node.replaceChild(x, state);

    addResult(rec);
    renderFiles();
    renderQuota();
    toast('Archivo subido. Enlace listo para copiar.');
  }).catch((err) => {
    bar.classList.add('fail');
    fill.style.width = '100%';
    meta.textContent = 'Error: ' + err.message;
    state.classList.add('err');
    state.textContent = 'Falló';
    const retry = el('button', 'xbtn', '↻');
    retry.title = 'Reintentar';
    retry.addEventListener('click', () => { retry.remove(); runUpload(entry, server); });
    node.appendChild(retry);
  });
}

/* ---------------- tarjeta de resultado ---------------- */
function addResult(rec) {
  const link = shareLink(rec);
  const card = el('div', 'res');
  card.innerHTML = `
    <div class="res-head">
      <span class="res-check">✓</span>
      <div style="min-width:0">
        <div class="res-name"></div>
        <div class="res-meta"></div>
      </div>
    </div>
    <div class="linkrow">
      <input readonly>
      <button class="btn primary small" data-act="copy">Copiar</button>
    </div>
    <div class="res-actions">
      <button class="btn line small" data-act="open">Abrir página del archivo</button>
      <button class="btn ghost small" data-act="dl">Enlace de descarga directa</button>
      <button class="btn ghost small" data-act="share">Compartir…</button>
    </div>`;
  card.querySelector('.res-name').textContent = rec.name;
  card.querySelector('.res-meta').textContent = fmtSize(rec.size) + ' · ' + extOf(rec.name) +
    ' · ' + fmtDate(rec.at);
  const input = card.querySelector('input');
  input.value = link;
  input.addEventListener('focus', () => input.select());

  card.addEventListener('click', async (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    if (act === 'copy') {
      const ok = await copyText(link);
      toast(ok ? 'Enlace copiado' : 'Copia manual: selecciona el enlace');
      if (ok) input.select();
    }
    if (act === 'open') window.open(link, '_blank');
    if (act === 'dl') {
      const page = downloadPage(rec);
      const ok = await copyText(page);
      toast(ok ? 'Enlace de descarga copiado' : 'Copia manual el enlace');
    }
    if (act === 'share') {
      if (navigator.share) navigator.share({ title: rec.name, text: 'Te comparto este archivo', url: link }).catch(() => {});
      else { await copyText(link); toast('Enlace copiado para compartir'); }
    }
  });

  $('#results').prepend(card);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

/* ---------------- lista "mis archivos" ---------------- */
function renderFiles() {
  const box = $('#fileList');
  box.innerHTML = '';
  if (!files.length) {
    box.appendChild(el('div', 'empty', 'Todavía no has subido nada. Arrastra un archivo arriba y aparecerá aquí con su enlace.'));
    return;
  }
  files.forEach((rec, idx) => {
    const row = el('div', 'frow');
    row.innerHTML = `
      <div class="up-ico">${extOf(rec.name)}</div>
      <div style="min-width:0">
        <div class="fname"></div>
        <div class="fmeta"></div>
      </div>
      <div class="facts">
        <button class="btn line small" data-act="copy">Copiar enlace</button>
        <button class="btn ghost small" data-act="open">Abrir</button>
        <button class="btn ghost small" data-act="del">✕</button>
      </div>`;
    row.querySelector('.fname').textContent = rec.name;
    row.querySelector('.fmeta').textContent = fmtSize(rec.size) + ' · ' + fmtDate(rec.at);
    row.addEventListener('click', async (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      if (act === 'copy') {
        const ok = await copyText(shareLink(rec));
        toast(ok ? 'Enlace copiado' : 'No se pudo copiar');
      }
      if (act === 'open') window.open(shareLink(rec), '_blank');
      if (act === 'del') {
        files.splice(idx, 1);
        saveFiles(files);
        renderFiles();
        renderQuota();
        toast('Quitado de la lista. El archivo sigue en el enlace.');
      }
    });
    box.appendChild(row);
  });
}

/* ---------------- página de un archivo (#/f/...) ---------------- */
function showViewer(encoded) {
  let rec;
  try { rec = decodeData(encoded); } catch { rec = null; }

  $('#home').classList.add('hidden');
  $('#viewer').classList.remove('hidden');
  window.scrollTo({ top: 0 });

  const card = $('#viewerCard');
  if (!rec || !rec.i) {
    card.innerHTML = `
      <div class="v-ico">!</div>
      <div class="v-name">Este enlace no es válido</div>
      <div class="v-meta">Puede que se haya copiado incompleto. Pide que te envíen el enlace otra vez.</div>
      <div class="v-actions"><a class="btn primary" href="#/">Subir un archivo</a></div>`;
    return;
  }

  const page = rec.c
    ? `https://gofile.io/d/${rec.c}`
    : `https://${rec.v}.gofile.io/download/web/${rec.i}/${encodeURIComponent(rec.n || 'archivo')}`;
  card.innerHTML = `
    <div class="v-ico">${extOf(rec.n)}</div>
    <div class="v-name"></div>
    <div class="v-meta"></div>
    <div class="v-stats">
      <div class="v-stat"><b class="sz"></b>Tamaño</div>
      <div class="v-stat"><b class="ty"></b>Tipo</div>
      <div class="v-stat"><b>Público</b>Acceso</div>
    </div>
    <div class="v-actions">
      <button class="btn primary" data-act="dl">Descargar archivo</button>
      <button class="btn line" data-act="cp">Copiar este enlace</button>
    </div>`;
  card.querySelector('.v-name').textContent = rec.n || 'Archivo';
  card.querySelector('.v-meta').textContent = 'Compartido contigo desde GIGASHARE';
  card.querySelector('.sz').textContent = fmtSize(rec.s || 0);
  card.querySelector('.ty').textContent = extOf(rec.n);

  card.addEventListener('click', async (e) => {
    const act = e.target.dataset.act;
    if (act === 'dl') {
      if (page && page.startsWith('http')) window.open(page, '_blank', 'noopener');
      else modal('Sin enlace', 'Este enlace no tiene un archivo asociado. Pide uno nuevo a quien te lo envió.');
    }
    if (act === 'cp') {
      const ok = await copyText(location.href);
      toast(ok ? 'Enlace copiado' : 'No se pudo copiar');
    }
  });
}

function route() {
  const hash = location.hash || '';
  const m = /^#\/f\/(.+)$/.exec(hash);
  if (m) {
    showViewer(m[1]);
  } else {
    $('#viewer').classList.add('hidden');
    $('#home').classList.remove('hidden');
  }
}

/* ---------------- eventos ---------------- */
$('#pickBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#fileInput').click(); });
$('#fileInput').addEventListener('change', (e) => {
  handleFiles(e.target.files);
  e.target.value = '';
});

const drop = $('#subir');
drop.addEventListener('click', () => $('#fileInput').click());
drop.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); }
});
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.add('over');
}));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => {
  e.preventDefault(); drop.classList.remove('over');
}));
drop.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files.length) handleFiles(e.dataTransfer.files);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

$('#clearAll').addEventListener('click', () => {
  if (!files.length) return toast('La lista ya está vacía');
  files = [];
  saveFiles(files);
  renderFiles();
  renderQuota();
  toast('Lista vaciada');
});

document.querySelectorAll('[data-plan]').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.plan === 'free') {
    modal('Plan Gratis', 'Estás usando el plan de muestra de 1 TB. No se guarda ninguna tarjeta ni se cobra nada.');
  } else {
    modal('Plan Pro — 5 USD al mes',
      'Este es un botón de muestra: la demo no procesa pagos. El plan Pro daría 5 TB de espacio y archivos más grandes.');
  }
}));

window.addEventListener('hashchange', route);

/* ---------------- inicio ---------------- */
renderQuota();
renderFiles();
route();
