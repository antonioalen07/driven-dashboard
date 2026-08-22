/* ============================================================
   Driven · Panel de Resultados — lógica del dashboard
   Sin dependencias: SVG dibujado a mano, para que el panel
   funcione como archivo estático sin build ni CDN.
   ============================================================ */
(() => {
'use strict';

/* ============================================================
   FUENTE DE DATOS
   ------------------------------------------------------------
   El panel prefiere la API (Supabase vía backend). Si no está
   disponible — porque se abrió el archivo local, o el backend
   todavía no se desplegó — cae al data.js estático.
   Así el mismo archivo sirve para las dos etapas.
   ============================================================ */
let D = window.DRIVEN_DATA || { semanas_historico: [], dias_ventas: [], meses: [] };
let FUENTE = 'archivo';   // 'api' | 'archivo'

async function cargarDeApi() {
  const r = await fetch('/api/gestion', { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error('API ' + r.status);
  const gestion = await r.json();

  const rv = await fetch('/api/ventas?grano=dia');
  if (!rv.ok) throw new Error('API ventas ' + rv.status);
  const ventas = await rv.json();

  const informes = gestion.informes || [];
  const serie    = ventas.serie || [];

  // La API entrega informes DIARIOS; el data.js estático traía semanas.
  // Se normaliza a la misma forma para no duplicar la lógica de render.
  const semanas = informes.map(i => {
    let pay = {};
    try { pay = typeof i.payload === 'string' ? JSON.parse(i.payload) : (i.payload || {}); } catch (e) {}
    return {
      fecha: i.fecha,
      total_conversaciones: +i.total_conversaciones || 0,
      enviado_a_web:        +i.enviado_a_web || 0,
      lead_calificado:      +i.lead_calificado || 0,
      mala_experiencia:     +i.mala_experiencia || 0,
      inconclusa:           +i.inconclusa || 0,
      consulta_comercial:   +i.consulta_comercial || 0,
      tasa_resolucion_pct:  +i.tasa_resolucion_pct || 0,
      score_promedio:       +i.score_promedio || 0,
      // Las dos metodologías van en campos SEPARADOS: mezclarlas en uno
      // solo fue el bug que hacía desaparecer el histórico del v1.
      ventas_confirmadas: +i.ventas_web_confirmadas || 0,   // v2: CRM, monto real
      ventas_estimadas:   +i.ventas_estimadas_v1 || 0,      // v1: conteo por IA
      monto_estimado:     +i.monto_estimado_v1 || 0,
      // Campo unificado SOLO para graficar la serie histórica completa.
      // Nunca se usa para KPIs de facturación.
      ventas_rolo_v1: (+i.ventas_web_confirmadas || 0) + (+i.ventas_estimadas_v1 || 0),
      metodologia: i.metodologia || 'v2_confirmado',
      es_estimado: (i.metodologia || '') === 'v1_estimado',
      productos_top: pay.productos_top || [],
      problemas:     pay.problemas || [],
      _origen: pay.origen || 'tracking',
    };
  });

  const dias = serie.map(v => ({
    fecha: v.fecha,
    ventas_confirmadas:     +v.ventas_confirmadas || 0,
    monto:                  +v.monto_total || 0,
    ventas_atribuidas_rolo: +v.ventas_atribuidas || 0,
    monto_atribuido:        +v.monto_atribuido || 0,
    ventas_no_atribuibles:  +v.ventas_no_atribuibles || 0,
    monto_no_atribuible:    +v.monto_no_atribuible || 0,
    detalle: [],
  }));

  const meses = [...new Set([...semanas, ...dias].map(x => String(x.fecha).slice(0,7)))].sort();
  return {
    generado: new Date().toISOString(),
    meses, semanas_historico: semanas, dias_ventas: dias,
    tasas_corregidas: [],
    rolo_operativo: dias.some(d => d.ventas_atribuidas_rolo > 0),
  };
}
// Filtro de período: modo + rango efectivo [desde, hasta] en ISO.
// 'todos' = sin límites; 'mes' = un mes; 'dia' = un día; 'custom' = a medida.
let FILTRO = { modo: 'todos', desde: null, hasta: null, mes: null, dia: null };
let VIEW = 'gestion';
let SORT = { k: 'fecha', dir: -1 };
const OCULTAS = new Set();   // series apagadas desde la leyenda

/* ---------------- helpers ---------------- */
const css  = k => getComputedStyle(document.documentElement).getPropertyValue(k).trim();
const num  = n => (n == null || isNaN(n)) ? 0 : +n;
const fmt  = n => num(n).toLocaleString('es-AR');
const dec1 = n => num(n).toFixed(1).replace('.', ',');
const dec2 = n => num(n).toFixed(2).replace('.', ',');
const esc  = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));

const money = n => {
  const v = num(n);
  if (v >= 1e6) return '$' + (v/1e6).toFixed(v >= 1e7 ? 0 : 1).replace('.', ',') + 'M';
  if (v >= 1e3) return '$' + Math.round(v/1e3) + 'k';
  return '$' + fmt(Math.round(v));
};
const moneyFull = n => '$' + num(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });

const day   = f => { const [y,m,d] = String(f).slice(0,10).split('-').map(Number); return new Date(y, m-1, d); };
const dLab  = f => day(f).toLocaleDateString('es-AR', { day:'2-digit', month:'short' });
const dLong = f => day(f).toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'long' });
const mLab  = m => { const [y,mm] = m.split('-'); return new Date(+y, +mm-1, 1)
  .toLocaleDateString('es-AR', { month:'long', year:'numeric' }); };

/* Una sola función decide si una fecha entra en el período elegido.
   Así los dos datasets (semanas y días) filtran con el mismo criterio. */
function enRango(fecha) {
  const f = String(fecha).slice(0,10);
  if (FILTRO.modo === 'todos') return true;
  if (FILTRO.desde && f < FILTRO.desde) return false;
  if (FILTRO.hasta && f > FILTRO.hasta) return false;
  return true;
}
/* Una semana del histórico cubre 7 días: entra si su ventana se solapa
   con el período, no solo si su fecha de inicio cae adentro. */
function semanaEnRango(fechaIni) {
  if (FILTRO.modo === 'todos') return true;
  const ini = String(fechaIni).slice(0,10);
  const d = day(ini); d.setDate(d.getDate() + 6);
  const p = n => String(n).padStart(2,'0');
  const fin = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  if (FILTRO.hasta && ini > FILTRO.hasta) return false;
  if (FILTRO.desde && fin < FILTRO.desde) return false;
  return true;
}
const semanas = () => D.semanas_historico.filter(s => semanaEnRango(s.fecha));
const dias    = () => D.dias_ventas.filter(d => enRango(d.fecha));

/* Texto legible del período, para los subtítulos. */
function etiquetaPeriodo() {
  if (FILTRO.modo === 'todos')  return 'Todo el período';
  if (FILTRO.modo === 'mes')    return mLab(FILTRO.mes).replace(/^./, c => c.toUpperCase());
  if (FILTRO.modo === 'dia')    return dLong(FILTRO.dia).replace(/^./, c => c.toUpperCase());
  const d = FILTRO.desde ? dLab(FILTRO.desde) : '…';
  const h = FILTRO.hasta ? dLab(FILTRO.hasta) : '…';
  return `${d} — ${h}`;
}

const NS = 'http://www.w3.org/2000/svg';
const el = (t, a) => { const n = document.createElementNS(NS, t);
  for (const k in (a||{})) n.setAttribute(k, a[k]); return n; };

function tipFor(box) {
  const t = document.createElement('div');
  t.className = 'tip'; box.appendChild(t);
  return {
    show(html, x, y) { t.innerHTML = html; t.style.left = x+'px'; t.style.top = (y-10)+'px'; t.style.opacity = 1; },
    hide() { t.style.opacity = 0; }
  };
}
const tipRow = (c, l, v) =>
  `<div class="row"><span class="l">${c?`<span class="sw" style="background:${c}"></span>`:''}${esc(l)}</span><span class="v">${v}</span></div>`;

/* Eje Y "lindo": pasos de 1/2/5 × 10^n */
function niceMax(v, ticks = 4) {
  if (v <= 0) return ticks;
  const raw = v / ticks, mag = Math.pow(10, Math.floor(Math.log10(raw))), n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  return step * ticks;
}

/* ============================================================
   KPIs
   ============================================================ */
function kpi({lab, val, sub, delta, accent, pending, tip}) {
  return `<div class="kpi${pending?' pending':''}"${accent?` style="--accent:${accent}"`:''}${tip?` title="${esc(tip)}"`:''}>
    <div class="lab">${accent?`<span style="width:9px;height:9px;border-radius:2px;background:${accent};flex:none"></span>`:''}${esc(lab)}</div>
    <div class="val">${val}</div>
    ${sub?`<div class="sub">${sub}</div>`:''}
    ${delta?`<div class="delta">${delta}</div>`:''}
  </div>`;
}
function deltaHtml(cur, prev, {pct=false, inverse=false} = {}) {
  if (prev == null) return '<span class="flat">sin período previo</span>';
  const d = num(cur) - num(prev);
  if (Math.abs(d) < 0.05) return '<span class="flat">sin cambios</span>';
  const good = inverse ? d < 0 : d > 0;
  const txt = (d > 0 ? '▲ +' : '▼ ') + (pct ? dec1(Math.abs(d))+' pts' : fmt(Math.round(Math.abs(d))));
  return `<span class="${good?'up':'down'}">${txt}</span> <span class="flat">vs anterior</span>`;
}

function renderKpisGestion() {
  const s = semanas(), box = document.getElementById('kpis-gestion');
  if (!s.length) { box.innerHTML = `<div class="card" style="grid-column:1/-1"><p class="empty">Sin datos de conversaciones para este período.</p></div>`;
    document.getElementById('sub-gestion').textContent = '—'; return; }

  const sum = k => s.reduce((a,x) => a + num(x[k]), 0);
  const convs = sum('total_conversaciones'), web = sum('enviado_a_web');
  const tasa  = convs ? web/convs*100 : 0;
  const score = s.reduce((a,x) => a + num(x.score_promedio), 0) / s.length;

  // Período previo del mismo largo, para comparar
  const idx = D.semanas_historico.findIndex(x => x.fecha === s[0].fecha);
  const prev = idx > 0 ? D.semanas_historico.slice(Math.max(0, idx-s.length), idx) : [];
  const pSum = k => prev.reduce((a,x) => a + num(x[k]), 0);
  const pConvs = pSum('total_conversaciones'), pWeb = pSum('enviado_a_web');

  box.innerHTML = [
    kpi({lab:'Conversaciones', val:fmt(convs), accent:null,
         sub:`${s.length} semana${s.length>1?'s':''}`,
         delta: prev.length ? deltaHtml(convs, pConvs) : null}),
    kpi({lab:'Enviados a la web', val:fmt(web), accent:css('--s2'),
         sub:'el objetivo principal del bot',
         delta: prev.length ? deltaHtml(web, pWeb) : null}),
    kpi({lab:'Tasa de resolución', val:dec1(tasa)+'<small>%</small>', accent:css('--s2'),
         sub:'de las conversaciones',
         delta: prev.length && pConvs ? deltaHtml(tasa, pWeb/pConvs*100, {pct:true}) : null}),
    kpi({lab:'Leads calificados', val:fmt(sum('lead_calificado')), accent:css('--s3'),
         sub:'con interés de compra'}),
    (() => {
      // Se discriminan las dos épocas: confirmadas por CRM vs estimadas por IA.
      const conf = sum('ventas_confirmadas'), est = sum('ventas_estimadas');
      const hayEst = est > 0, hayConf = conf > 0;
      let val, sub, pend = false;
      if (hayConf && hayEst) {
        val = `${fmt(conf)}<small> + ${fmt(est)} est.</small>`;
        sub = 'confirmadas + estimadas (v1)';
        pend = true;
      } else if (hayEst) {
        val = fmt(est);
        sub = `estimadas · ${money(sum('monto_estimado'))}`;
        pend = true;
      } else {
        val = fmt(conf);
        sub = 'confirmadas por el CRM';
      }
      return kpi({lab:'Ventas de Rolo', val, sub, accent:css('--s1'), pending: pend,
        delta: prev.length && hayConf ? deltaHtml(conf, pSum('ventas_confirmadas')) : null,
        tip: hayEst
          ? 'Las estimadas vienen del Rolo v1: conteo que hizo la IA leyendo conversaciones, sin monto real. Nunca se suman a la facturación.'
          : 'Ventas confirmadas en el CRM y atribuidas a Rolo.'});
    })(),
    kpi({lab:'Malas experiencias', val:fmt(sum('mala_experiencia')), accent:css('--bad'),
         sub:'a revisar'}),
    kpi({lab:'Score de atención', val:dec2(score)+'<small>/5</small>',
         sub:'promedio del período'}),
  ].join('');

  document.getElementById('sub-gestion').textContent =
    `${etiquetaPeriodo()} · ${s.length} semana${s.length>1?'s':''} (${dLab(s[0].fecha)} — ${dLab(s.at(-1).fecha)})`;
}

function renderKpisVentas() {
  const v = dias(), box = document.getElementById('kpis-ventas');
  if (!v.length) { box.innerHTML = `<div class="card" style="grid-column:1/-1"><p class="empty">Sin ventas registradas en este período.</p></div>`;
    document.getElementById('sub-ventas').textContent = '—'; return; }

  const sum = k => v.reduce((a,x) => a + num(x[k]), 0);
  const n = sum('ventas_confirmadas'), monto = sum('monto');
  const atr = sum('ventas_atribuidas_rolo'), montoAtr = sum('monto_atribuido');
  const ticket = n ? monto/n : 0;
  const pctAtr = monto ? montoAtr/monto*100 : 0;

  box.innerHTML = [
    kpi({lab:'Facturación', val:money(monto), accent:css('--s4'),
         sub:`${fmt(n)} venta${n!==1?'s':''} confirmada${n!==1?'s':''}`}),
    kpi({lab:'Ticket promedio', val:money(ticket), sub:'por venta'}),
    kpi({lab:'Atribuido a Rolo', val:money(montoAtr), accent:css('--s1'),
         sub:`${dec1(pctAtr)}% de la facturación`,
         pending: atr === 0,
         tip:'Ventas donde Rolo asesoró antes de la compra. Se confirma cruzando el CRM con las conversaciones.'}),
    kpi({lab:'Ventas de Rolo', val:fmt(atr), accent:css('--s1'),
         sub: atr === 0 ? 'Rolo aún no está operativo' : 'asesoradas antes de comprar',
         pending: atr === 0}),
    kpi({lab:'Sin atribuir', val:fmt(n - atr), accent:css('--s5'),
         sub:'compras directas a la web'}),
    kpi({lab:'Días con ventas', val:fmt(v.length), sub:'en el período'}),
  ].join('');

  document.getElementById('sub-ventas').textContent =
    `${etiquetaPeriodo()} · ${fmt(n)} venta${n!==1?'s':''} · ${dLab(v[0].fecha)} — ${dLab(v.at(-1).fecha)}`;
}

/* ============================================================
   Gráfico 1 — Evolución: barras (a la web) + línea (total)
   Una sola escala: ambas series son "conversaciones".
   ============================================================ */
function renderEvo() {
  const s = semanas(), box = document.getElementById('ch-evo');
  box.innerHTML = '';
  const leg = document.getElementById('lg-evo');
  if (!s.length) { box.innerHTML = '<p class="empty">Sin datos en el período.</p>'; leg.innerHTML=''; return; }

  const SER = [
    { k:'enviado_a_web',        lab:'Enviados a la web', color: css('--s2'),    tipo:'bar' },
    { k:'total_conversaciones', lab:'Conversaciones',    color: css('--ink-3'), tipo:'line' },
  ];
  // Las ventas van en su propio panel debajo: su escala (1-18) es tan chica
  // frente a las conversaciones (60-180) que en el mismo eje serian una
  // linea plana pegada al piso. Dos escalas en un plot enganan; dos plots no.
  const VENTAS_SERIE = { k:'ventas_rolo_v1', lab:'Ventas de Rolo', color: css('--s1') };
  leg.innerHTML = SER.map(x => `
    <button class="it" data-serie="${x.k}" aria-pressed="${!OCULTAS.has(x.k)}">
      <span class="sw" style="background:${x.color};${x.tipo==='line'?'height:3px;width:16px;border-radius:999px':''}"></span>${esc(x.lab)}
    </button>`).join('');
  if (s.some(d => num(d.ventas_rolo_v1) > 0)) {
    const soloEst = s.every(d => num(d.ventas_rolo_v1) === 0 || d.es_estimado);
    leg.insertAdjacentHTML('beforeend',
      `<span class="it"><span class="sw" style="background:${css('--s1')}"></span>Ventas de Rolo${soloEst ? ' — estimadas (v1)' : ''} · escala propia</span>`);
  }
  leg.querySelectorAll('button').forEach(b => b.onclick = () => {
    const k = b.dataset.serie;
    OCULTAS.has(k) ? OCULTAS.delete(k) : OCULTAS.add(k);
    renderEvo();
  });

  const vis = SER.filter(x => !OCULTAS.has(x.k));
  const hayVentas = s.some(d => num(d[VENTAS_SERIE.k]) > 0);
  const HV = hayVentas ? 92 : 0;         // alto del panel de ventas (con aire)
  const W = 760, H = 280 + HV, m = { t:16, r:16, b:38 + HV, l:44 };
  const iw = W-m.l-m.r, ih = H-m.t-m.b;
  const maxV = Math.max(1, ...s.flatMap(d => vis.map(x => num(d[x.k]))));
  const top = niceMax(maxV);
  const bw = Math.max(6, Math.min(38, iw/s.length - 8));
  const cx = i => m.l + (iw/s.length)*(i+0.5);
  const y  = v => m.t + ih - (num(v)/top)*ih;

  const svg = el('svg', { class:'chart', viewBox:`0 0 ${W} ${H}`, role:'img',
    'aria-label':`Evolución semanal. Máximo ${top} conversaciones.` });

  for (let i=0;i<=4;i++) {
    const val = top/4*i, yy = y(val);
    svg.appendChild(el('line',{ class:'gridline', x1:m.l, x2:W-m.r, y1:yy, y2:yy }));
    const t = el('text',{ x:m.l-8, y:yy+4, 'text-anchor':'end' });
    t.textContent = Math.round(val); svg.appendChild(t);
  }

  const barra = vis.find(x => x.tipo === 'bar');
  if (barra) s.forEach((d,i) => {
    const h = ih - (y(d[barra.k]) - m.t);
    if (h <= 0) return;
    const r = Math.min(4, h), x0 = cx(i)-bw/2, y0 = y(d[barra.k]), b = m.t+ih;
    svg.appendChild(el('path',{ fill:barra.color,
      d:`M${x0},${b} L${x0},${y0+r} Q${x0},${y0} ${x0+r},${y0} L${x0+bw-r},${y0} Q${x0+bw},${y0} ${x0+bw},${y0+r} L${x0+bw},${b} Z` }));
  });

  const linea = vis.find(x => x.tipo === 'line');
  if (linea) {
    const pts = s.map((d,i) => [cx(i), y(d[linea.k])]);
    svg.appendChild(el('path',{ fill:'none', stroke:linea.color, 'stroke-width':2,
      'stroke-linejoin':'round','stroke-linecap':'round',
      d: pts.map((p,i)=>(i?'L':'M')+p[0]+','+p[1]).join(' ') }));
    const last = pts.at(-1);
    svg.appendChild(el('circle',{ cx:last[0], cy:last[1], r:4.5, fill:linea.color,
      stroke:css('--surface'), 'stroke-width':2 }));
  }

  const step = Math.max(1, Math.ceil(s.length/8));
  s.forEach((d,i) => {
    if ((s.length-1-i) % step !== 0) return;
    const t = el('text',{ x:cx(i), y:m.t+ih+17, 'text-anchor':'middle' });
    t.textContent = dLab(d.fecha); svg.appendChild(t);
  });
  svg.appendChild(el('line',{ class:'gridline', x1:m.l, x2:W-m.r, y1:m.t+ih, y2:m.t+ih }));

  // --- Panel inferior: ventas atribuidas a Rolo (escala propia) ---
  if (hayVentas) {
    const vTop = niceMax(Math.max(1, ...s.map(d => num(d[VENTAS_SERIE.k]))), 2);
    // 52px de aire: deja pasar las etiquetas del eje X del panel de arriba.
    const vBase = m.t + ih + 58;
    const vh = HV - 40;
    const vy = n => vBase + vh - (num(n)/vTop)*vh;

    const lb = el('text',{ x:m.l, y:vBase-8, fill:css('--ink-3') });
    lb.setAttribute('style','font-size:10.5px;letter-spacing:.06em;text-transform:uppercase');
    lb.textContent = s.every(d => num(d[VENTAS_SERIE.k]) === 0 || d.es_estimado)
      ? 'Ventas atribuidas a Rolo (estimadas · v1)'
      : 'Ventas atribuidas a Rolo';
    svg.appendChild(lb);

    svg.appendChild(el('line',{ class:'gridline', x1:m.l, x2:W-m.r, y1:vBase+vh, y2:vBase+vh }));
    const tMax = el('text',{ x:m.l-8, y:vBase+5, 'text-anchor':'end' });
    tMax.textContent = vTop; svg.appendChild(tMax);

    const bwv = Math.max(4, Math.min(26, iw/s.length - 10));
    s.forEach((d,i) => {
      const val = num(d[VENTAS_SERIE.k]);
      if (val <= 0) return;
      const h = (val/vTop)*vh;
      const r = Math.min(3, h), x0 = cx(i)-bwv/2, y0 = vy(val), b = vBase+vh;
      svg.appendChild(el('path',{ fill:VENTAS_SERIE.color,
        d:`M${x0},${b} L${x0},${y0+r} Q${x0},${y0} ${x0+r},${y0} L${x0+bwv-r},${y0} Q${x0+bwv},${y0} ${x0+bwv},${y0+r} L${x0+bwv},${b} Z` }));
    });
  }

  const tip = tipFor(box);
  const cross = el('line',{ class:'cross', y1:m.t, y2:m.t+ih });
  svg.appendChild(cross);
  s.forEach((d,i) => {
    const hz = el('rect',{ class:'hit', x:m.l+(iw/s.length)*i, y:m.t, width:iw/s.length, height:H-m.t-8 });
    hz.addEventListener('mouseenter', () => {
      cross.setAttribute('x1',cx(i)); cross.setAttribute('x2',cx(i)); cross.style.opacity=.3;
      const sc = box.getBoundingClientRect().width / W;
      tip.show(`<div class="tt">Semana del ${dLong(d.fecha)}</div>`+
        tipRow(css('--s2'),'A la web', fmt(d.enviado_a_web))+
        tipRow(css('--ink-3'),'Conversaciones', fmt(d.total_conversaciones))+
        tipRow(null,'Tasa', dec1(d.tasa_resolucion_pct)+'%')+
        tipRow(css('--s3'),'Leads', fmt(d.lead_calificado))+
        tipRow(css('--s1'),'Ventas de Rolo', fmt(d.ventas_rolo_v1)),
        cx(i)*sc, y(Math.max(num(d.total_conversaciones), num(d.enviado_a_web)))*sc);
    });
    hz.addEventListener('mouseleave', () => { tip.hide(); cross.style.opacity=0; });
    svg.appendChild(hz);
  });
  box.appendChild(svg);
}

/* ============================================================
   Gráfico 2 — Desenlace (barras horizontales)
   ============================================================ */
function renderMix() {
  const s = semanas(), box = document.getElementById('ch-mix');
  box.innerHTML = '';
  if (!s.length) { box.innerHTML = '<p class="empty">Sin datos.</p>'; return; }

  const sum = k => s.reduce((a,x) => a + num(x[k]), 0);
  const items = [
    { lab:'Enviados a la web',   v:sum('enviado_a_web'),      c:css('--s2') },
    { lab:'Leads calificados',   v:sum('lead_calificado'),    c:css('--s3') },
    { lab:'Consultas',           v:sum('consulta_comercial'), c:css('--s5') },
    { lab:'Inconclusas',         v:sum('inconclusa'),         c:css('--s5') },
    { lab:'Malas experiencias',  v:sum('mala_experiencia'),   c:css('--s1') },
  ].filter(x => x.v > 0).sort((a,b) => b.v - a.v);
  if (!items.length) { box.innerHTML = '<p class="empty">Sin desenlaces registrados.</p>'; return; }

  const total = sum('total_conversaciones') || 1;
  const max = Math.max(...items.map(x => x.v));
  const W = 420, rowH = 38, lw = 140, pr = 56;
  const H = items.length*rowH + 6;
  const svg = el('svg',{ class:'chart', viewBox:`0 0 ${W} ${H}`, role:'img',
    'aria-label':'Desenlace de las conversaciones del período' });
  const tip = tipFor(box);

  items.forEach((it,i) => {
    const yy = i*rowH + 8, bh = 16, tw = W-lw-pr;
    const t = el('text',{ x:0, y:yy+bh/2+4 }); t.textContent = it.lab; svg.appendChild(t);
    svg.appendChild(el('rect',{ x:lw, y:yy, width:tw, height:bh, rx:4, fill:css('--surface-3') }));
    const w = Math.max(3, (it.v/max)*tw);
    svg.appendChild(el('rect',{ x:lw, y:yy, width:w, height:bh, rx:4, fill:it.c }));
    const vt = el('text',{ x:lw+tw+8, y:yy+bh/2+4, fill:css('--ink-2') });
    vt.setAttribute('style','font-weight:700'); vt.textContent = fmt(it.v); svg.appendChild(vt);

    const hz = el('rect',{ class:'hit', x:0, y:yy-6, width:W, height:rowH });
    hz.addEventListener('mouseenter', () => {
      const sc = box.getBoundingClientRect().width / W;
      tip.show(`<div class="tt">${esc(it.lab)}</div>`+
        tipRow(it.c,'Cantidad', fmt(it.v))+
        tipRow(null,'Del total', dec1(it.v/total*100)+'%'),
        (lw+w/2)*sc, (yy+bh/2)*sc);
    });
    hz.addEventListener('mouseleave', tip.hide);
    svg.appendChild(hz);
  });
  box.appendChild(svg);
}

/* ============================================================
   Gráfico 3 — Tasa de resolución (área + línea + promedio)
   ============================================================ */
function renderTasa() {
  const s = semanas(), box = document.getElementById('ch-tasa');
  box.innerHTML = '';
  if (!s.length) { box.innerHTML = '<p class="empty">Sin datos.</p>'; return; }

  const W = 1180, H = 220, m = { t:18, r:20, b:34, l:46 };
  const iw = W-m.l-m.r, ih = H-m.t-m.b;
  const x = i => s.length === 1 ? m.l+iw/2 : m.l + (iw/(s.length-1))*i;
  const y = v => m.t + ih - (Math.max(0,Math.min(100,num(v)))/100)*ih;
  const avg = s.reduce((a,d) => a + num(d.tasa_resolucion_pct), 0) / s.length;

  const svg = el('svg',{ class:'chart', viewBox:`0 0 ${W} ${H}`, role:'img',
    'aria-label':`Tasa de resolución. Promedio ${dec1(avg)} por ciento.` });

  for (let i=0;i<=4;i++) {
    const v = 25*i, yy = y(v);
    svg.appendChild(el('line',{ class:'gridline', x1:m.l, x2:W-m.r, y1:yy, y2:yy }));
    const t = el('text',{ x:m.l-8, y:yy+4, 'text-anchor':'end' }); t.textContent = v+'%';
    svg.appendChild(t);
  }

  const pts = s.map((d,i) => [x(i), y(d.tasa_resolucion_pct)]);
  const line = pts.map((p,i)=>(i?'L':'M')+p[0]+','+p[1]).join(' ');

  const defs = el('defs'), lg = el('linearGradient',{ id:'gT', x1:0,y1:0,x2:0,y2:1 });
  lg.appendChild(el('stop',{ offset:'0%','stop-color':css('--s2'),'stop-opacity':'.26' }));
  lg.appendChild(el('stop',{ offset:'100%','stop-color':css('--s2'),'stop-opacity':'.02' }));
  defs.appendChild(lg); svg.appendChild(defs);
  svg.appendChild(el('path',{ fill:'url(#gT)',
    d:`${line} L${pts.at(-1)[0]},${m.t+ih} L${pts[0][0]},${m.t+ih} Z` }));

  const ya = y(avg);
  svg.appendChild(el('line',{ x1:m.l, x2:W-m.r, y1:ya, y2:ya, stroke:css('--ink-3'),
    'stroke-width':1.5, 'stroke-dasharray':'5 4', opacity:.72 }));
  const at = el('text',{ x:W-m.r, y:ya-7, 'text-anchor':'end', fill:css('--ink-2') });
  at.setAttribute('style','font-weight:700'); at.textContent = `promedio ${dec1(avg)}%`;
  svg.appendChild(at);

  svg.appendChild(el('path',{ fill:'none', stroke:css('--s2'), 'stroke-width':2,
    'stroke-linejoin':'round','stroke-linecap':'round', d:line }));

  const step = Math.max(1, Math.ceil(s.length/12));
  s.forEach((d,i) => {
    if ((s.length-1-i) % step !== 0) return;
    const t = el('text',{ x:x(i), y:H-10, 'text-anchor':'middle' });
    t.textContent = dLab(d.fecha); svg.appendChild(t);
  });

  const tip = tipFor(box);
  const cross = el('line',{ class:'cross', y1:m.t, y2:m.t+ih });
  const dot = el('circle',{ r:5, fill:css('--s2'), stroke:css('--surface'), 'stroke-width':2, opacity:0 });
  svg.appendChild(cross); svg.appendChild(dot);
  s.forEach((d,i) => {
    const half = s.length === 1 ? iw/2 : iw/(s.length-1)/2;
    const hz = el('rect',{ class:'hit', x:x(i)-half, y:m.t, width:half*2, height:ih });
    hz.addEventListener('mouseenter', () => {
      cross.setAttribute('x1',x(i)); cross.setAttribute('x2',x(i)); cross.style.opacity=.3;
      dot.setAttribute('cx',x(i)); dot.setAttribute('cy',y(d.tasa_resolucion_pct)); dot.setAttribute('opacity',1);
      const sc = box.getBoundingClientRect().width / W;
      tip.show(`<div class="tt">Semana del ${dLong(d.fecha)}</div>`+
        tipRow(css('--s2'),'Tasa', dec1(d.tasa_resolucion_pct)+'%')+
        tipRow(null,'A la web', `${fmt(d.enviado_a_web)} de ${fmt(d.total_conversaciones)}`),
        x(i)*sc, y(d.tasa_resolucion_pct)*sc);
    });
    hz.addEventListener('mouseleave', () => { tip.hide(); cross.style.opacity=0; dot.setAttribute('opacity',0); });
    svg.appendChild(hz);
  });
  box.appendChild(svg);
}

/* ============================================================
   Listas: productos y problemas (frecuencia en el período)
   ============================================================ */
/* Normaliza para agrupar variantes: "Carpa inflable" y "carpa inflable"
   son lo mismo; "Carpa inflable Alpina PRO" cuenta para "carpa inflable". */
function claveNorm(s) {
  return String(s).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .replace(/[()"']/g,' ')
    .replace(/\s+/g,' ')
    .trim();
}
/* Términos base que agrupan familias de producto. */
const FAMILIAS = ['carpa inflable','carpa','compresor','arrancador','calentador',
  'kit pala','kit supervivencia','bolso','termo','gato','carro','anafe','silla'];

function agrupar(items, usarFamilias) {
  const cont = new Map();   // clave -> {label, n}
  items.forEach(raw => {
    const k0 = claveNorm(raw);
    if (!k0) return;
    let k = k0, label = String(raw).trim();
    if (usarFamilias) {
      const fam = FAMILIAS.find(f => k0.includes(f));
      if (fam) { k = fam; label = fam.charAt(0).toUpperCase()+fam.slice(1); }
    }
    if (!cont.has(k)) cont.set(k, { label, n:0 });
    cont.get(k).n++;
  });
  return [...cont.values()].sort((a,b) => b.n - a.n);
}

function listaFrec(id, campo, color, usarFamilias) {
  const s = semanas(), box = document.getElementById(id);
  const todos = s.flatMap(w => w[campo] || []);
  const list = agrupar(todos, usarFamilias).slice(0, 8);
  if (!list.length) { box.innerHTML = '<p class="empty">Sin datos en el período.</p>'; return; }

  const max = list[0].n;
  const unaVez = list.every(x => x.n === 1);   // sin variación: la barra no aporta
  box.innerHTML = `<div style="display:grid;gap:${unaVez?'9px':'10px'}">` + list.map(x => {
    const txt = x.label.length > 64 ? x.label.slice(0,64)+'…' : x.label;
    if (unaVez) {
      // Todos aparecen una vez: se listan como viñetas, sin barra engañosa.
      return `<div style="display:flex;gap:9px;align-items:flex-start;font-size:13.5px">
        <span style="width:6px;height:6px;border-radius:999px;background:${color};flex:none;margin-top:7px"></span>
        <span style="color:var(--ink-2)">${esc(txt)}</span></div>`;
    }
    return `<div>
      <div style="display:flex;justify-content:space-between;gap:12px;font-size:13.5px;margin-bottom:4px">
        <span style="color:var(--ink-2)">${esc(txt)}</span>
        <b class="num" style="flex:none">${x.n}</b>
      </div>
      <div style="height:6px;background:var(--surface-3);border-radius:999px;overflow:hidden">
        <div style="height:100%;width:${(x.n/max*100).toFixed(1)}%;background:${color};border-radius:999px"></div>
      </div></div>`;
  }).join('') + `</div>` +
  (unaVez ? `<p class="hint" style="margin:12px 0 0">Cada uno apareció una vez en el período.</p>` : '');
}

/* ============================================================
   Tabla semanal
   ============================================================ */
function renderTablaSem() {
  const s = semanas().slice();
  s.sort((a,b) => {
    const k = SORT.k;
    const va = k === 'fecha' ? day(a.fecha).getTime() : num(a[k]);
    const vb = k === 'fecha' ? day(b.fecha).getTime() : num(b[k]);
    return (va-vb)*SORT.dir;
  });
  const tb = document.querySelector('#t-sem tbody');
  if (!s.length) { tb.innerHTML = '<tr><td colspan="7" class="empty">Sin datos.</td></tr>'; return; }
  tb.innerHTML = s.map(d => {
    const t = num(d.tasa_resolucion_pct);
    return `<tr>
      <td style="white-space:nowrap"><b>${dLab(d.fecha)}</b></td>
      <td class="n">${fmt(d.total_conversaciones)}</td>
      <td class="n" style="color:${css('--s2')};font-weight:700">${fmt(d.enviado_a_web)}</td>
      <td class="n"><span class="bar-mini">
        <span class="track"><span class="fill" style="width:${Math.min(100,t)}%;background:${css('--s2')}"></span></span>
        <b>${dec1(t)}%</b></span></td>
      <td class="n" style="${num(d.ventas_rolo_v1)>0?`color:${css('--s1')};font-weight:700`:'color:var(--ink-3)'}">${fmt(d.ventas_rolo_v1)}${d.es_estimado&&num(d.ventas_rolo_v1)>0?'<span title="Estimado por IA (Rolo v1), sin monto real" style="color:var(--warn);font-weight:400"> est.</span>':''}</td>
      <td class="n">${fmt(d.lead_calificado)}</td>
      <td class="n" style="${num(d.mala_experiencia)>0?`color:${css('--bad')};font-weight:700`:''}">${fmt(d.mala_experiencia)}</td>
      <td class="n">${dec2(d.score_promedio)}</td>
    </tr>`;
  }).join('');
  document.querySelectorAll('#t-sem th.sortable').forEach(th =>
    th.setAttribute('aria-sort', SORT.k===th.dataset.k ? (SORT.dir>0?'ascending':'descending') : 'none'));
}

/* ============================================================
   VENTAS — barras por día
   ============================================================ */
function renderVentas() {
  const v = dias(), box = document.getElementById('ch-vta');
  box.innerHTML = '';
  const leg = document.getElementById('lg-vta');
  if (!v.length) { box.innerHTML = '<p class="empty">Sin ventas en el período.</p>'; leg.innerHTML=''; return; }

  leg.innerHTML =
    `<span class="it"><span class="sw" style="background:${css('--s1')}"></span>Atribuido a Rolo</span>
     <span class="it"><span class="sw" style="background:${css('--s5')}"></span>Sin atribuir</span>`;

  const W = 760, H = 280, m = { t:16, r:16, b:38, l:56 };
  const iw = W-m.l-m.r, ih = H-m.t-m.b;
  const top = niceMax(Math.max(1, ...v.map(d => num(d.monto))));
  const bw = Math.max(8, Math.min(44, iw/v.length - 10));
  const cx = i => m.l + (iw/v.length)*(i+0.5);
  const y  = n => m.t + ih - (num(n)/top)*ih;

  const svg = el('svg',{ class:'chart', viewBox:`0 0 ${W} ${H}`, role:'img',
    'aria-label':'Facturación por día, separada entre atribuida a Rolo y sin atribuir.' });

  for (let i=0;i<=4;i++) {
    const val = top/4*i, yy = y(val);
    svg.appendChild(el('line',{ class:'gridline', x1:m.l, x2:W-m.r, y1:yy, y2:yy }));
    const t = el('text',{ x:m.l-8, y:yy+4, 'text-anchor':'end' }); t.textContent = money(val);
    svg.appendChild(t);
  }

  // Barra apilada: atribuido abajo, resto arriba. 2px de aire entre segmentos.
  v.forEach((d,i) => {
    const x0 = cx(i)-bw/2, base = m.t+ih;
    const hAtr = ih - (y(d.monto_atribuido) - m.t);
    const hTot = ih - (y(d.monto) - m.t);
    if (hTot <= 0) return;
    if (hAtr > 0) svg.appendChild(el('rect',{ x:x0, y:y(d.monto_atribuido), width:bw, height:hAtr, rx:3, fill:css('--s1') }));
    const restoH = hTot - hAtr - (hAtr>0 ? 2 : 0);
    if (restoH > 0) {
      const yTop = y(d.monto), r = Math.min(4, restoH);
      const yb = base - hTot + restoH;
      svg.appendChild(el('path',{ fill:css('--s5'),
        d:`M${x0},${yb} L${x0},${yTop+r} Q${x0},${yTop} ${x0+r},${yTop} L${x0+bw-r},${yTop} Q${x0+bw},${yTop} ${x0+bw},${yTop+r} L${x0+bw},${yb} Z` }));
    }
  });

  const step = Math.max(1, Math.ceil(v.length/8));
  v.forEach((d,i) => {
    if ((v.length-1-i) % step !== 0) return;
    const t = el('text',{ x:cx(i), y:H-12, 'text-anchor':'middle' });
    t.textContent = dLab(d.fecha); svg.appendChild(t);
  });
  svg.appendChild(el('line',{ class:'gridline', x1:m.l, x2:W-m.r, y1:m.t+ih, y2:m.t+ih }));

  // El eje muestra solo los dias CON ventas, no un calendario continuo.
  // Si hay saltos grandes se aclara, para no leer mal la tendencia.
  const dd = v.map(x => day(x.fecha).getTime());
  const salto = dd.some((t,i) => i && (t - dd[i-1]) > 3*864e5);
  if (salto) {
    const t = el('text',{ x:m.l, y:m.t-4, fill:css('--ink-3') });
    t.setAttribute('style','font-size:10.5px');
    t.textContent = 'Solo días con ventas — el eje no es un calendario continuo';
    svg.appendChild(t);
  }

  const tip = tipFor(box);
  v.forEach((d,i) => {
    const hz = el('rect',{ class:'hit', x:m.l+(iw/v.length)*i, y:m.t, width:iw/v.length, height:ih });
    hz.addEventListener('mouseenter', () => {
      const sc = box.getBoundingClientRect().width / W;
      tip.show(`<div class="tt">${dLong(d.fecha)}</div>`+
        tipRow(null,'Facturación', moneyFull(d.monto))+
        tipRow(null,'Ventas', fmt(d.ventas_confirmadas))+
        tipRow(css('--s1'),'De Rolo', d.ventas_atribuidas_rolo ? moneyFull(d.monto_atribuido) : '—')+
        tipRow(css('--s5'),'Sin atribuir', moneyFull(d.monto_no_atribuible)),
        cx(i)*sc, y(d.monto)*sc);
    });
    hz.addEventListener('mouseleave', tip.hide);
    svg.appendChild(hz);
  });
  box.appendChild(svg);
}

/* ============================================================
   VENTAS — dona de atribución
   ============================================================ */
function renderTorta() {
  const v = dias(), box = document.getElementById('ch-torta');
  const legBox = document.getElementById('torta-leg');
  box.innerHTML = ''; legBox.innerHTML = '';
  if (!v.length) { box.innerHTML = '<p class="empty">Sin datos.</p>'; return; }

  const atr = v.reduce((a,d) => a + num(d.monto_atribuido), 0);
  const tot = v.reduce((a,d) => a + num(d.monto), 0);
  const resto = Math.max(0, tot - atr);
  const partes = [
    { lab:'Atribuido a Rolo', v:atr,   c:css('--s1') },
    { lab:'Sin atribuir',     v:resto, c:css('--s5') },
  ].filter(p => p.v > 0);
  if (!partes.length) { box.innerHTML = '<p class="empty">Sin facturación.</p>'; return; }

  // Todavía no hay nada atribuido: una dona de un solo color no dice nada.
  // Se explica el estado y qué va a pasar cuando Rolo empiece a operar.
  if (atr === 0) {
    box.innerHTML = `
      <div style="text-align:center;padding:22px 8px 6px">
        <div style="font-family:Oswald,sans-serif;font-size:38px;font-weight:600;color:var(--ink-3);line-height:1">0%</div>
        <p style="margin:10px auto 0;max-width:34ch;font-size:13.5px;color:var(--ink-3);line-height:1.6">
          Ninguna venta está atribuida todavía porque <b style="color:var(--ink-2)">Rolo aún no está operativo</b>.
          Cuando entre en operación, acá vas a ver qué porcentaje de la facturación generó el agente.
        </p>
      </div>`;
    legBox.innerHTML = `<div style="display:grid;gap:8px;margin-top:var(--sp-4);padding-top:var(--sp-3);border-top:1px solid var(--line-soft)">
      <div style="display:flex;align-items:center;gap:9px;font-size:13px">
        <span style="width:11px;height:11px;border-radius:3px;background:${css('--s5')};flex:none"></span>
        <span style="color:var(--ink-2)">Facturación total del período</span>
        <b class="num" style="margin-left:auto">${moneyFull(tot)}</b>
      </div></div>`;
    return;
  }

  const W = 300, H = 210, cx = W/2, cy = H/2, R = 78, r = 50;
  const svg = el('svg',{ class:'chart', viewBox:`0 0 ${W} ${H}`, role:'img',
    'aria-label':`Atribución: ${dec1(atr/tot*100)} por ciento de la facturación es de Rolo.` });
  const tip = tipFor(box);

  let ang = -Math.PI/2;
  const total = partes.reduce((a,p) => a+p.v, 0);
  partes.forEach(p => {
    const frac = p.v/total, a2 = ang + frac*Math.PI*2;
    const gap = partes.length > 1 ? 0.018 : 0;   // 2px de aire entre segmentos
    const s0 = ang + gap, s1 = Math.max(s0, a2 - gap);
    const big = (s1-s0) > Math.PI ? 1 : 0;
    const P = (rad,a) => [cx + rad*Math.cos(a), cy + rad*Math.sin(a)];
    const [x1,y1] = P(R,s0), [x2,y2] = P(R,s1), [x3,y3] = P(r,s1), [x4,y4] = P(r,s0);
    const path = el('path',{ fill:p.c,
      d:`M${x1},${y1} A${R},${R} 0 ${big} 1 ${x2},${y2} L${x3},${y3} A${r},${r} 0 ${big} 0 ${x4},${y4} Z` });
    path.style.cursor = 'pointer';
    path.addEventListener('mouseenter', () => {
      const sc = box.getBoundingClientRect().width / W;
      const mid = (s0+s1)/2, [mx,my] = P((R+r)/2, mid);
      tip.show(`<div class="tt">${esc(p.lab)}</div>`+
        tipRow(p.c,'Monto', moneyFull(p.v))+
        tipRow(null,'Del total', dec1(p.v/total*100)+'%'), mx*sc, my*sc);
    });
    path.addEventListener('mouseleave', tip.hide);
    svg.appendChild(path);
    ang = a2;
  });

  const pct = tot ? atr/tot*100 : 0;
  const t1 = el('text',{ x:cx, y:cy-2, 'text-anchor':'middle', fill:css('--ink') });
  t1.setAttribute('style',`font-family:Oswald,sans-serif;font-size:27px;font-weight:600`);
  t1.textContent = dec1(pct)+'%';
  const t2 = el('text',{ x:cx, y:cy+16, 'text-anchor':'middle' });
  t2.setAttribute('style','font-size:11px;letter-spacing:.08em;text-transform:uppercase');
  t2.textContent = 'de Rolo';
  svg.appendChild(t1); svg.appendChild(t2);
  box.appendChild(svg);

  // Leyenda con valores: identidad no depende solo del color
  legBox.innerHTML = `<div style="display:grid;gap:8px;margin-top:var(--sp-3)">` +
    partes.map(p => `<div style="display:flex;align-items:center;gap:9px;font-size:13px">
      <span style="width:11px;height:11px;border-radius:3px;background:${p.c};flex:none"></span>
      <span style="color:var(--ink-2)">${esc(p.lab)}</span>
      <b class="num" style="margin-left:auto">${moneyFull(p.v)}</b>
    </div>`).join('') + `</div>`;
}

/* ============================================================
   VENTAS — tabla
   ============================================================ */
async function cargarDetalleVentas() {
  if (FUENTE !== 'api') return;
  const q = new URLSearchParams();
  if (FILTRO.desde) q.set('desde', FILTRO.desde);
  if (FILTRO.hasta) q.set('hasta', FILTRO.hasta);
  try {
    const r = await fetch('/api/ventas/detalle?' + q);
    if (!r.ok) return;
    const { ventas } = await r.json();
    const porDia = new Map();
    (ventas || []).forEach(x => {
      const f = String(x.fecha).slice(0,10);
      if (!porDia.has(f)) porDia.set(f, []);
      porDia.get(f).push({ cliente: x.cliente || '—', nombre: x.nombre || '—',
                           monto: +x.monto || 0, contact_id: x.contact_id,
                           atribuida: x.atribuida_rolo === true, motivo: x.motivo });
    });
    D.dias_ventas.forEach(d => { d.detalle = porDia.get(d.fecha) || []; });
    renderTablaVta();
  } catch (e) { /* la tabla queda vacía, el resto del panel funciona */ }
}

function renderTablaVta() {
  const v = dias(), tb = document.querySelector('#t-vta tbody');
  const filas = [];
  v.forEach(d => (d.detalle||[]).forEach(x => filas.push({ ...x, fecha: d.fecha })));
  filas.sort((a,b) => day(b.fecha) - day(a.fecha) || b.monto - a.monto);
  if (!filas.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">Sin ventas en el período.</td></tr>'; return; }

  tb.innerHTML = filas.slice(0, 60).map(f => {
    const atribuida = !!f.atribuida;
    const c = atribuida ? css('--s1') : css('--s5');
    return `<tr>
      <td style="white-space:nowrap">${dLab(f.fecha)}</td>
      <td><b>${esc(f.cliente || '—')}</b></td>
      <td style="color:var(--ink-2)">${esc(f.nombre || '—')}</td>
      <td class="n" style="font-weight:700">${moneyFull(f.monto)}</td>
      <td><span class="chip" style="background:color-mix(in srgb,${c} 13%,transparent);color:${c}">
        <span class="dot" style="background:${c}"></span>${atribuida ? 'Rolo' : 'Sin atribuir'}</span></td>
    </tr>`;
  }).join('');
}

/* ============================================================
   Avisos
   ============================================================ */
function renderAvisos() {
  const box = document.getElementById('avisos');
  const bits = [];
  const hayEstimadas = (D.semanas_historico || []).some(x => x.es_estimado);

  if (D.rolo_operativo === false) {
    bits.push(`<b>Rolo todavía no está operativo.</b> Las ventas que ves son reales y vienen del CRM, pero ninguna está atribuida al agente aún. Cuando Rolo entre en operación, el panel empieza a separar qué ventas generó él.`);
  }
  if (hayEstimadas) {
    bits.push(`El período <b>marzo–junio 2026</b> corresponde al <b>Rolo v1</b>: sus ventas son un conteo estimado por IA sobre las conversaciones, sin monto ni cliente reales. Se muestran aparte y <b>nunca se suman</b> a la facturación del CRM.`);
  }
  if ((D.tasas_corregidas||[]).length) {
    const n = D.tasas_corregidas.length;
    bits.push(`Se corrigieron <b>${n} tasas</b> del histórico que estaban mal calculadas en el Excel original (la peor decía 6,4% cuando era 65,7%). El panel muestra el valor recalculado desde los propios números.`);
  }
  box.innerHTML = bits.length ? `<div class="notice">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.5"/></svg>
    <div>${bits.map(b => `<p>${b}</p>`).join('')}</div></div>` : '';
}

/* ============================================================
   CSV
   ============================================================ */
function csv() {
  let cols, filas, nombre;
  if (VIEW === 'gestion') {
    cols = ['fecha','total_conversaciones','enviado_a_web','tasa_resolucion_pct',
            'ventas_rolo_v1','lead_calificado','consulta_comercial','inconclusa',
            'mala_experiencia','score_promedio'];
    filas = semanas(); nombre = 'driven_gestion';
  } else {
    cols = ['fecha','ventas_confirmadas','monto','ventas_atribuidas_rolo','monto_atribuido',
            'ventas_no_atribuibles','monto_no_atribuible'];
    filas = dias(); nombre = 'driven_ventas';
  }
  if (!filas.length) return;
  const txt = [cols.join(',')].concat(filas.map(f => cols.map(c => {
    const v = f[c] ?? '';
    return /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g,'""')}"` : v;
  }).join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([txt], { type:'text/csv;charset=utf-8' }));
  const suf = FILTRO.modo === 'todos' ? 'historico'
            : FILTRO.modo === 'mes' ? FILTRO.mes
            : FILTRO.modo === 'dia' ? FILTRO.dia
            : `${FILTRO.desde||'ini'}_a_${FILTRO.hasta||'fin'}`;
  a.download = `${nombre}_${suf}.csv`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/* ============================================================
   Render + eventos
   ============================================================ */
function render() {
  renderAvisos();
  document.getElementById('v-gestion').hidden = VIEW !== 'gestion';
  document.getElementById('v-ventas').hidden  = VIEW !== 'ventas';
  if (VIEW === 'gestion') {
    renderKpisGestion(); renderEvo(); renderMix(); renderTasa();
    listaFrec('prods','productos_top', css('--s4'), true);
    listaFrec('probs','problemas',     css('--s1'), false);
    renderTablaSem();
  } else {
    renderKpisVentas(); renderVentas(); renderTorta(); renderTablaVta();
    cargarDetalleVentas();   // el detalle se pide aparte, no bloquea el render
  }
}

async function init() {
  // Se intenta la API primero. Si falla, seguimos con el data.js incluido.
  try {
    const datos = await cargarDeApi();
    if (datos.semanas_historico.length || datos.dias_ventas.length) {
      D = datos; FUENTE = 'api';
    }
  } catch (e) {
    console.info('API no disponible, usando datos del archivo:', e.message);
  }

  // ---------- filtro de período ----------
  const elModo = document.getElementById('fModo');
  const elMes  = document.getElementById('fMes');
  const elDia  = document.getElementById('fDia');
  const elRango= document.getElementById('fRango');
  const elDesde= document.getElementById('fDesde');
  const elHasta= document.getElementById('fHasta');

  // Límites reales de los datos: evita elegir fechas donde no hay nada.
  const todasFechas = [
    ...D.semanas_historico.map(x => x.fecha),
    ...D.dias_ventas.map(x => x.fecha)
  ].sort();
  const MIN = todasFechas[0], MAX = todasFechas.at(-1);

  elMes.innerHTML = (D.meses||[])
    .map(m => `<option value="${m}">${mLab(m).replace(/^./,c=>c.toUpperCase())}</option>`).join('');
  [elDia, elDesde, elHasta].forEach(i => { i.min = MIN; i.max = MAX; });
  elMes.value  = (D.meses||[]).at(-1) || '';
  elDia.value  = MAX;
  elDesde.value = MIN; elHasta.value = MAX;

  function aplicarFiltro() {
    const modo = elModo.value;
    // 'hidden' pierde contra el display del .btn: se fuerza por style.
    const ver = (elm, on, disp) => {
      elm.hidden = !on;
      elm.style.display = on ? (disp || '') : 'none';
    };
    ver(elMes,   modo === 'mes');
    ver(elDia,   modo === 'dia');
    ver(elRango, modo === 'custom', 'inline-flex');

    if (modo === 'todos') {
      FILTRO = { modo, desde:null, hasta:null, mes:null, dia:null };
    } else if (modo === 'mes') {
      const m = elMes.value;
      // Último día del mes, sin depender de la longitud: día 0 del siguiente.
      const [y,mm] = m.split('-').map(Number);
      const fin = new Date(y, mm, 0);
      const p = n => String(n).padStart(2,'0');
      FILTRO = { modo, mes:m, dia:null,
                 desde:`${m}-01`,
                 hasta:`${fin.getFullYear()}-${p(fin.getMonth()+1)}-${p(fin.getDate())}` };
    } else if (modo === 'dia') {
      const d = elDia.value;
      FILTRO = { modo, dia:d, mes:null, desde:d, hasta:d };
    } else {
      let d = elDesde.value, h = elHasta.value;
      if (d && h && d > h) { [d,h] = [h,d]; elDesde.value = d; elHasta.value = h; }
      FILTRO = { modo, desde:d||null, hasta:h||null, mes:null, dia:null };
    }
    render();
  }
  [elModo, elMes, elDia, elDesde, elHasta].forEach(i => i.onchange = aplicarFiltro);
  aplicarFiltro();

  document.querySelectorAll('.seg button[data-view]').forEach(b => b.onclick = () => {
    VIEW = b.dataset.view;
    document.querySelectorAll('.seg button[data-view]').forEach(o =>
      o.setAttribute('aria-pressed', String(o === b)));
    render();
  });

  document.querySelectorAll('#t-sem th.sortable').forEach(th => th.onclick = () => {
    const k = th.dataset.k;
    SORT = { k, dir: SORT.k === k ? -SORT.dir : -1 };
    renderTablaSem();
  });

  document.getElementById('bCsv').onclick = csv;
  document.getElementById('bTema').onclick = () => {
    const cur = document.documentElement.getAttribute('data-theme');
    const dark = cur ? cur === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
    render();   // los SVG leen los colores desde CSS: hay que redibujar
  };
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (!document.documentElement.getAttribute('data-theme')) render();
  });
  addEventListener('resize', () => { clearTimeout(window.__rt); window.__rt = setTimeout(render, 180); });

  const g = document.getElementById('gen');
  if (g && D.generado) g.textContent = new Date(D.generado).toLocaleDateString('es-AR',
    { day:'2-digit', month:'2-digit', year:'numeric' });

  const f = document.getElementById('fuente');
  if (f) {
    f.textContent = FUENTE === 'api' ? 'en vivo desde Supabase' : 'datos precargados';
    f.title = FUENTE === 'api'
      ? 'El panel consulta la base de datos en cada carga.'
      : 'El backend no respondió: se muestran los datos del archivo incluido.';
    f.style.color = FUENTE === 'api' ? 'var(--ok)' : 'var(--ink-3)';
  }
}

document.readyState === 'loading'
  ? document.addEventListener('DOMContentLoaded', init)
  : init();
})();
