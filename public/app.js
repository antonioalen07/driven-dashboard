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
let ERROR_API = null;     // por que fallo la API, si fallo

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
      informe_narrativo: i.informe_narrativo || '',
      productos_top: pay.productos_top || [],
      problemas:     pay.problemas || [],
      _origen: pay.origen || 'tracking',
    };
  });

  // Los tres canales son EXCLUYENTES: rolo + asesor + web_directa = total.
  // Por eso el panel puede mostrarlos como partes de una misma torta.
  const dias = serie.map(v => ({
    fecha: v.fecha,
    ventas_confirmadas:     +v.ventas_confirmadas || 0,
    monto:                  +v.monto_total || 0,
    ventas_atribuidas_rolo: +v.ventas_atribuidas || 0,
    monto_atribuido:        +v.monto_atribuido || 0,
    ventas_asesor:          +v.ventas_asesor || 0,
    monto_asesor:           +v.monto_asesor || 0,
    ventas_web_directa:     +v.ventas_web_directa || 0,
    monto_web_directa:      +v.monto_web_directa || 0,
    ventas_no_atribuibles:  +v.ventas_no_atribuibles || 0,
    monto_no_atribuible:    +v.monto_no_atribuible || 0,
    detalle: [],
  }));

  // Registro previo al inicio del tracking: existe, se muestra como nota,
  // pero no entra en ningún KPI. Si el endpoint no está, el panel sigue.
  let fueraDePeriodo = null, inicioTracking = null, inicioRolo = null;
  try {
    const rc = await fetch('/api/canales');
    if (rc.ok) {
      const c = await rc.json();
      fueraDePeriodo = c.fuera_de_periodo || null;
      inicioTracking = c.inicio_tracking || null;
      inicioRolo     = c.inicio_rolo || null;
    }
  } catch (e) { /* opcional: el resto del panel no depende de esto */ }

  const meses = [...new Set([...semanas, ...dias].map(x => String(x.fecha).slice(0,7)))].sort();
  return {
    generado: new Date().toISOString(),
    meses, semanas_historico: semanas, dias_ventas: dias,
    tasas_corregidas: [],
    fuera_de_periodo: fueraDePeriodo,
    inicio_tracking: inicioTracking,
    inicio_rolo: inicioRolo,
    rolo_operativo: dias.some(d => d.ventas_atribuidas_rolo > 0),
  };
}
// Filtro de período: modo + rango efectivo [desde, hasta] en ISO.
// 'todos' = sin límites; 'mes' = un mes; 'dia' = un día; 'custom' = a medida.
let FILTRO = { modo: 'todos', desde: null, hasta: null, mes: null, dia: null };
let VIEW = 'gestion';
let SORT = { k: 'fecha', dir: -1 };
// Grano del detalle de gestión: 'dia' | 'semana' | 'mes'.
// Arranca en 'dia' porque el v2 registra diario; el v1 (semanal) se
// muestra igual, sin partirse, para no inventar números por día.
let GRANO = 'dia';
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
/* Una fila entra en el rango si su período se solapa con el filtro.
   El "largo" de la fila depende de su granularidad: las del v1 son
   SEMANALES (cubren 7 días desde su fecha) y las del v2 son DIARIAS.
   Tratar a todas como semanales hacía que un informe diario apareciera
   en filtros de días que no le corresponden. */
function semanaEnRango(fechaIni, esSemanal) {
  if (FILTRO.modo === 'todos') return true;
  const ini = String(fechaIni).slice(0,10);
  const d = day(ini); d.setDate(d.getDate() + (esSemanal ? 6 : 0));
  const p = n => String(n).padStart(2,'0');
  const fin = `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
  if (FILTRO.hasta && ini > FILTRO.hasta) return false;
  if (FILTRO.desde && fin < FILTRO.desde) return false;
  return true;
}
const semanas = () => D.semanas_historico.filter(s => semanaEnRango(s.fecha, s.es_estimado));
const dias    = () => D.dias_ventas.filter(d => enRango(d.fecha));

/* Texto legible del período, para los subtítulos. */
function etiquetaPeriodo() {
  if (FILTRO.modo === 'todos')  return 'Todo el período';
  if (FILTRO.modo === 'mes')    return mLab(FILTRO.mes).replace(/^./, c => c.toUpperCase());
  if (FILTRO.modo === 'dia')    return dLong(FILTRO.dia).replace(/^./, c => c.toUpperCase());
  if (FILTRO.modo === 'semana' && FILTRO.desde)
    return `Semana del ${dLab(FILTRO.desde)} al ${dLab(FILTRO.hasta)}`;
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

/* Explica POR QUÉ no hay informe de gestión en el período elegido.
   "Sin datos" repetido cinco veces se lee como un panel roto; casi siempre
   la razón es que el flujo todavía no analizó ese día (corre a la mañana
   y analiza el día anterior). */
function motivoSinGestion() {
  const hoy = new Date().toISOString().slice(0,10);
  const p = n => String(n).padStart(2,'0');
  const ayerD = new Date(); ayerD.setDate(ayerD.getDate() - 1);
  const ayer = `${ayerD.getFullYear()}-${p(ayerD.getMonth()+1)}-${p(ayerD.getDate())}`;

  // ¿El rango pedido es hoy (o el futuro)? Todavía no puede haber informe.
  if (FILTRO.desde && FILTRO.desde >= hoy) {
    return `El informe de gestión de <b>hoy</b> se genera mañana a la mañana: el flujo analiza siempre el día anterior. Para ver el último disponible, elegí <b>${dLab(ayer)}</b> o "Todo el período".`;
  }
  // Hay ventas ese día pero no informe: el flujo no corrió para esa fecha.
  const hayVentas = (D.dias_ventas || []).some(d => enRango(d.fecha) && num(d.ventas_confirmadas) > 0);
  if (hayVentas) {
    return `No hay informe de conversaciones para este período, pero <b>sí hay ventas registradas</b> — mirálas en la pestaña <b>Ventas</b>. El informe de gestión se genera una vez por día, a la mañana siguiente.`;
  }
  return 'Sin conversaciones registradas en este período.';
}

function renderKpisGestion() {
  const s = semanas(), box = document.getElementById('kpis-gestion');
  // Sin informe: un solo mensaje que explica por qué, en vez de cinco
  // tarjetas repitiendo "Sin datos" (que se lee como panel roto).
  document.querySelectorAll('#v-gestion .solo-con-datos')
    .forEach(el => { el.hidden = !s.length; });

  if (!s.length) { box.innerHTML = `<div class="card" style="grid-column:1/-1"><p class="empty">${motivoSinGestion()}</p></div>`;
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

  // Los tres canales: cada venta cae en uno y solo uno.
  const ase = sum('ventas_asesor'), montoAse = sum('monto_asesor');
  // Si el backend todavía no expone los canales, todo lo no-Rolo cae
  // en web directa: es el default conservador, no inventa asesores.
  const hayCanales = v.some(d => d.ventas_asesor != null || d.ventas_web_directa != null);
  const web = hayCanales ? sum('ventas_web_directa') : (n - atr);
  const montoWeb = hayCanales ? sum('monto_web_directa') : (monto - montoAtr);
  const pct = x => monto ? x/monto*100 : 0;

  box.innerHTML = [
    kpi({lab:'Facturación total', val:money(monto), accent:css('--s4'),
         sub:`${fmt(n)} venta${n!==1?'s':''} de la tienda`,
         tip:'Todas las ventas ganadas en el CRM en el período. Es la suma de los tres canales.'}),
    kpi({lab:'Ventas de Rolo', val:money(montoAtr), accent:css('--s1'),
         sub:`${fmt(atr)} venta${atr!==1?'s':''} · ${dec1(pct(montoAtr))}% del total`,
         pending: atr === 0,
         tip:'Rolo asesoró (mandó link o buscó productos) antes de la compra, dentro de la ventana de 7 días.'}),
    kpi({lab:'Ventas de asesores', val:money(montoAse), accent:css('--s3'),
         sub:`${fmt(ase)} venta${ase!==1?'s':''} · ${dec1(pct(montoAse))}% del total`,
         tip:'Cerradas por una persona del equipo: ganadas en el CRM sin origen TiendaNube.'}),
    kpi({lab:'Web directa', val:money(montoWeb), accent:css('--s5'),
         sub:`${fmt(web)} venta${web!==1?'s':''} · ${dec1(pct(montoWeb))}% del total`,
         tip:'El cliente compró solo en la tienda, sin que Rolo ni un asesor intervinieran.'}),
    kpi({lab:'Ticket promedio', val:money(ticket), sub:'por venta del período'}),
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
/* ============================================================
   Agrupar el detalle por día / semana / mes
   ------------------------------------------------------------
   Las filas del v1 son SEMANALES y las del v2 son DIARIAS. Agrupar
   por día una fila semanal daría un número falso (mostraría 140
   conversaciones "del 9 de marzo" cuando son de toda esa semana).
   Por eso cada fila se ubica en el bucket que le corresponde y las
   semanales nunca se parten: se muestran tal cual en grano día.
   ============================================================ */
function lunesDe(f) {
  const d = day(f);
  const dow = (d.getDay() + 6) % 7;       // 0 = lunes
  d.setDate(d.getDate() - dow);
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

function agruparPorGrano(filas, grano) {
  // En grano día las filas pasan tal cual, pero la tasa se recalcula igual:
  // si la fila no la trae (o viene desactualizada), se deriva de sus propios
  // totales en vez de quedar en blanco.
  if (grano === 'dia') return filas.map(r => ({
    ...r,
    tasa_resolucion_pct: num(r.total_conversaciones)
      ? num(r.enviado_a_web) / num(r.total_conversaciones) * 100
      : num(r.tasa_resolucion_pct),
  }));

  const clave = f => grano === 'mes' ? String(f).slice(0,7) + '-01' : lunesDe(f);
  const por = new Map();
  filas.forEach(r => {
    const k = clave(r.fecha);
    if (!por.has(k)) {
      por.set(k, { fecha: k, total_conversaciones:0, enviado_a_web:0, lead_calificado:0,
                   mala_experiencia:0, inconclusa:0, consulta_comercial:0,
                   ventas_confirmadas:0, ventas_estimadas:0, monto_estimado:0,
                   ventas_rolo_v1:0, _scores:[], es_estimado:false, _filas:0 });
    }
    const a = por.get(k);
    ['total_conversaciones','enviado_a_web','lead_calificado','mala_experiencia',
     'inconclusa','consulta_comercial','ventas_confirmadas','ventas_estimadas',
     'monto_estimado','ventas_rolo_v1'].forEach(x => { a[x] += num(r[x]); });
    // El score es un promedio, no una suma: se promedia ponderando por fila.
    if (num(r.score_promedio)) a._scores.push(num(r.score_promedio));
    // Si alguna fila del bucket es estimada, el bucket entero se marca.
    if (r.es_estimado) a.es_estimado = true;
    a._filas++;
  });

  return [...por.values()].map(a => {
    a.score_promedio = a._scores.length
      ? a._scores.reduce((x,y) => x+y, 0) / a._scores.length : 0;
    // La tasa se RECALCULA sobre los totales del bucket. Promediar
    // porcentajes de días con volúmenes distintos da un número falso.
    a.tasa_resolucion_pct = a.total_conversaciones
      ? a.enviado_a_web / a.total_conversaciones * 100 : 0;
    return a;
  });
}

function renderTablaSem() {
  const s = agruparPorGrano(semanas(), GRANO);

  // El encabezado dice qué se está mirando.
  const LAB = { dia:'día', semana:'semana', mes:'mes' };
  const th = document.getElementById('th-periodo');
  const tit = document.getElementById('t-sem-titulo');
  if (th)  th.textContent  = GRANO === 'dia' ? 'Día' : (GRANO === 'semana' ? 'Semana' : 'Mes');
  if (tit) tit.textContent = `Detalle por ${LAB[GRANO]}`;

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
      <td style="white-space:nowrap"><b>${GRANO === 'mes' ? mLab(String(d.fecha).slice(0,7)) : dLab(d.fecha)}</b></td>
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

  const S = k => v.reduce((a,d) => a + num(d[k]), 0);
  const atr = S('monto_atribuido');
  const tot = S('monto');
  const hayCanales = v.some(d => d.monto_asesor != null || d.monto_web_directa != null);
  const ase = hayCanales ? S('monto_asesor') : 0;
  // Lo que no es Rolo ni asesor es compra autónoma. Se calcula por resta
  // para que los tres canales siempre cierren exactamente en el total.
  const web = Math.max(0, tot - atr - ase);
  const partes = [
    { lab:'Rolo (agente IA)', v:atr, c:css('--s1') },
    { lab:'Asesores',         v:ase, c:css('--s3') },
    { lab:'Web directa',      v:web, c:css('--s5') },
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
    // Aunque Rolo esté en 0, el resto SÍ se desglosa: asesores y web directa
    // son dos cosas distintas y el cliente necesita verlas separadas.
    legBox.innerHTML = `<div style="display:grid;gap:8px;margin-top:var(--sp-4);padding-top:var(--sp-3);border-top:1px solid var(--line-soft)">` +
      partes.map(p => `<div style="display:flex;align-items:center;gap:9px;font-size:13px">
        <span style="width:11px;height:11px;border-radius:3px;background:${p.c};flex:none"></span>
        <span style="color:var(--ink-2)">${esc(p.lab)}</span>
        <b class="num" style="margin-left:auto">${moneyFull(p.v)}</b>
      </div>`).join('') +
      `<div style="display:flex;align-items:center;gap:9px;font-size:13px;padding-top:8px;border-top:1px solid var(--line-soft)">
        <span style="color:var(--ink-2)">Facturación total</span>
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
                           atribuida: x.atribuida_rolo === true, motivo: x.motivo,
                           // Si el backend aún no manda canal, se deduce del
                           // nº de orden: con orden vino de la tienda.
                           nro_orden: x.nro_orden,
                           canal: x.canal || (x.atribuida_rolo === true ? 'rolo'
                                   : (x.nro_orden ? 'web_directa' : 'asesor')) });
    });
    D.dias_ventas.forEach(d => { d.detalle = porDia.get(d.fecha) || []; });
    renderTablaVta();
  } catch (e) { /* la tabla queda vacía, el resto del panel funciona */ }
}

function renderTablaVta() {
  const v = dias(), tb = document.querySelector('#t-vta tbody');
  const filas = [];
  v.forEach(d => (d.detalle||[]).forEach(x => filas.push({ ...x, fecha: d.fecha })));
  // Más reciente primero. Dentro del mismo día se ordena por Nº DE ORDEN
  // descendente, no por monto: la #1265 va arriba de la #1264 aunque sea
  // más chica. Ordenar por monto dentro del día se leía como desorden.
  const ord = f => {
    const m = String(f.nombre || '').match(/#\s*(\d+)/);
    return m ? +m[1] : (f.nro_orden ? +f.nro_orden : -1);
  };
  filas.sort((a,b) => day(b.fecha) - day(a.fecha) || ord(b) - ord(a) || b.monto - a.monto);
  if (!filas.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">Sin ventas en el período.</td></tr>'; return; }

  // Cada venta muestra su canal, no un binario. "Sin atribuir" mezclaba
  // dos cosas distintas: una venta que cerró un asesor y una compra sola.
  const CANAL = {
    rolo:        { lab:'Rolo',        c:'--s1' },
    asesor:      { lab:'Asesor',      c:'--s3' },
    web_directa: { lab:'Web directa', c:'--s5' },
  };
  tb.innerHTML = filas.slice(0, 60).map(f => {
    const k = CANAL[f.canal] || CANAL.web_directa;
    const c = css(k.c);
    return `<tr>
      <td style="white-space:nowrap">${dLab(f.fecha)}</td>
      <td><b>${esc(f.cliente || '—')}</b></td>
      <td style="color:var(--ink-2)">${esc(f.nombre || '—')}</td>
      <td class="n" style="font-weight:700">${moneyFull(f.monto)}</td>
      <td><span class="chip" title="${esc(f.motivo || '')}" style="background:color-mix(in srgb,${c} 13%,transparent);color:${c}">
        <span class="dot" style="background:${c}"></span>${k.lab}</span></td>
    </tr>`;
  }).join('');
}

/* ============================================================
   Narrativa de la IA
   ------------------------------------------------------------
   El flujo guarda un informe en prosa por día. Es lo único que
   explica el POR QUÉ detrás de los números, pero es texto largo:
   va en la columna angosta, debajo del gráfico, y colapsado
   cuando hay más de un día en el rango.
   ============================================================ */
function renderNarrativa() {
  const box = document.getElementById('narrativa');
  if (!box) return;

  // Solo los días que realmente tienen texto. El v1 no dejó narrativa.
  const dias = semanas()
    .filter(d => (d.informe_narrativo || '').trim())
    .sort((a,b) => day(b.fecha) - day(a.fecha));

  if (!dias.length) { box.innerHTML = ''; return; }

  const item = (d, abierto) => `
    <details class="narr" ${abierto ? 'open' : ''}>
      <summary>
        <span class="f">${dLab(d.fecha)}</span>
        <span class="p">${esc((d.informe_narrativo || '').slice(0, 60))}${(d.informe_narrativo||'').length > 60 ? '…' : ''}</span>
      </summary>
      <p>${esc(d.informe_narrativo)}</p>
    </details>`;

  // Un solo día: se muestra abierto, no tiene sentido esconderlo.
  box.innerHTML = `
    <div class="narr-box">
      <p class="narr-tit">Lectura del día${dias.length > 1 ? 's' : ''} · IA</p>
      ${dias.slice(0, 30).map(d => item(d, dias.length === 1)).join('')}
      ${dias.length > 30 ? `<p class="narr-mas">+${dias.length - 30} días más en el período</p>` : ''}
    </div>`;
}

/* ============================================================
   Avisos
   ============================================================ */
function renderAvisos() {
  const box = document.getElementById('avisos');
  const bits = [];
  const hayEstimadas = (D.semanas_historico || []).some(x => x.es_estimado);

  const ini = D.inicio_tracking || '2026-08-15';
  const iniRolo = D.inicio_rolo || '2026-08-24';
  const iniLab = dLong(ini);

  // El corte va primero: define qué significan todos los números de abajo.
  bits.push(`El conteo de ventas arranca el <b>${iniLab}</b>, cuando la tienda empezó a cargar cada venta en el CRM. Desde ahí cada venta se clasifica en uno de tres canales: <b>Rolo</b>, <b>asesores</b> o <b>web directa</b>.`);

  const fp = D.fuera_de_periodo;
  if (fp && +fp.ventas > 0) {
    bits.push(`Hay <b>${fmt(fp.ventas)} venta${+fp.ventas!==1?'s':''}</b> anterior${+fp.ventas!==1?'es':''} al inicio del tracking (${moneyFull(fp.monto)}, ${dLab(fp.desde)} — ${dLab(fp.hasta)}): cargas manuales sueltas en el CRM, sin nº de orden. Se conservan como registro pero <b>no computan</b> en la facturación.`);
  }

  if (D.rolo_operativo === false) {
    // Se nombra la fecha de arranque: sin eso, "0% atribuido" se lee como
    // que el agente no funciona, cuando en realidad todavía no encendió.
    const hoy = new Date().toISOString().slice(0,10);
    bits.push(hoy < iniRolo
      ? `<b>Rolo entra en operación el ${dLong(iniRolo)}.</b> Hasta esa fecha la atribución en 0 % es lo esperado: el agente todavía no está encendido. Las ventas que ves son reales y vienen del CRM.`
      : `<b>Rolo arrancó el ${dLong(iniRolo)}</b>, pero todavía no hay ventas atribuidas. Puede ser normal los primeros días: la atribución necesita que el cliente compre después de que Rolo lo asesore.`);
  }
  if (hayEstimadas) {
    bits.push(`El período <b>marzo–junio 2026</b> corresponde al <b>Rolo v1</b> — una versión <b>deprecada</b> del agente. Sus ventas son un conteo estimado por IA sobre las conversaciones, sin monto ni cliente reales. Se conservan solo para comparar contra el v2 y <b>nunca se suman</b> a la facturación.`);
  }
  if ((D.tasas_corregidas||[]).length) {
    const n = D.tasas_corregidas.length;
    bits.push(`Se corrigieron <b>${n} tasas</b> del histórico que estaban mal calculadas en el Excel original (la peor decía 6,4% cuando era 65,7%). El panel muestra el valor recalculado desde los propios números.`);
  }
  box.innerHTML = bits.length ? `<div class="notice">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16.5v.5"/></svg>
    <div style="flex:1">
      <p class="titulo">Cómo se cuenta</p>
      ${bits.map(b => `<p>${b}</p>`).join('')}
    </div></div>` : '';
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
    cols = ['fecha','ventas_confirmadas','monto',
            'ventas_atribuidas_rolo','monto_atribuido',
            'ventas_asesor','monto_asesor',
            'ventas_web_directa','monto_web_directa'];
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
    renderKpisGestion(); renderEvo(); renderMix(); renderTasa(); renderNarrativa();
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
    ERROR_API = e.message;
  }

  // ---------- filtro de período ----------
  const elModo = document.getElementById('fModo');
  const elMes  = document.getElementById('fMes');
  const elDia  = document.getElementById('fDia');
  const elSem  = document.getElementById('fSemana');
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
    ver(elSem,   modo === 'semana');
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
    } else if (modo === 'semana') {
      // <input type="week"> devuelve "2026-W34" (semana ISO, empieza lunes).
      const w = elSem.value;
      if (!w) { FILTRO = { modo, desde:null, hasta:null, mes:null, dia:null, semana:null }; }
      else {
        const [y, ns] = w.split('-W').map(Number);
        // Semana ISO 1 = la que contiene el 4 de enero.
        const ene4 = new Date(y, 0, 4);
        const lunSem1 = new Date(ene4);
        lunSem1.setDate(ene4.getDate() - ((ene4.getDay() + 6) % 7));
        const lun = new Date(lunSem1);
        lun.setDate(lunSem1.getDate() + (ns - 1) * 7);
        const dom = new Date(lun);
        dom.setDate(lun.getDate() + 6);
        const p = n => String(n).padStart(2,'0');
        const iso = d => `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
        FILTRO = { modo, semana:w, mes:null, dia:null, desde:iso(lun), hasta:iso(dom) };
      }
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
  [elModo, elMes, elSem, elDia, elDesde, elHasta].forEach(i => i.onchange = aplicarFiltro);
  aplicarFiltro();

  document.querySelectorAll('.seg button[data-view]').forEach(b => b.onclick = () => {
    VIEW = b.dataset.view;
    document.querySelectorAll('.seg button[data-view]').forEach(o =>
      o.setAttribute('aria-pressed', String(o === b)));
    render();
  });

  // Grano del detalle: solo re-renderiza esa tabla, no el panel entero.
  document.querySelectorAll('.seg button[data-grano]').forEach(b => b.onclick = () => {
    GRANO = b.dataset.grano;
    document.querySelectorAll('.seg button[data-grano]').forEach(o =>
      o.setAttribute('aria-pressed', String(o === b)));
    renderTablaSem();
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

  // Si el panel cayo al archivo estatico, hay que decirlo fuerte: los numeros
  // son de la ultima vez que se genero data.js, no de Supabase. Un aviso
  // discreto en el pie no alcanza para evitar decisiones sobre datos viejos.
  const avisos = document.getElementById('avisos');
  if (avisos && FUENTE !== 'api' && !avisos.querySelector('.aviso-fuente')) {
    const gen = (window.DRIVEN_DATA || {}).generado;
    const el = document.createElement('div');
    el.className = 'nota aviso-fuente';
    el.style.cssText = 'border-left:4px solid var(--brand);background:color-mix(in srgb,var(--brand) 8%,transparent);padding:var(--sp-2);margin-bottom:var(--sp-2)';
    el.innerHTML = '<b>Datos precargados, no en vivo.</b> El panel no pudo leer Supabase'
      + (ERROR_API ? ' (' + ERROR_API + ')' : '') + ', asi que muestra el respaldo del archivo'
      + (gen ? ' generado el ' + new Date(gen).toLocaleString('es-AR') : '')
      + '. Las ventas y conversaciones posteriores a esa fecha NO estan incluidas.';
    avisos.appendChild(el);
  }

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
