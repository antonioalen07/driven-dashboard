#!/usr/bin/env python3
"""
Backend del panel de Driven.

Sirve los estáticos y expone una API que lee de Supabase. El navegador
nunca ve credenciales: todas las consultas pasan por acá.

    GET /api/salud                          estado de las conexiones
    GET /api/ventas?desde=&hasta=&grano=    serie de ventas (dia|mes)
    GET /api/ventas/detalle?desde=&hasta=   cada venta del rango
    GET /api/gestion?desde=&hasta=          informes diarios de Rolo
    GET /api/resumen?desde=&hasta=          KPIs + comparación con el período previo
    GET /api/versiones                      compara Rolo v1 vs v2 (normalizado por semana)
    GET /api/canales?desde=&hasta=          desglose por canal (rolo/asesor/web directa)

El tracking formal arranca el 2026-08-15 (INICIO_TRACKING): cuando TiendaNube
empieza a cargar las ventas en GHL. Lo anterior son cargas manuales sueltas que
se conservan como registro (computa = false) pero no entran en ningún KPI.

Rolo entra en operación el 2026-08-24 (INICIO_ROLO): antes de esa fecha el 0 %
de atribución es lo esperado, no un problema de medición.

Variables de entorno (todas del lado del servidor):
    SUPABASE_URL        https://xxxx.supabase.co
    SUPABASE_KEY        service_role key  (NUNCA se envía al navegador)
    PORT                8000 por defecto

Sin dependencias externas: solo la stdlib de Python.
"""
import os, json, urllib.request, urllib.parse, urllib.error, datetime, re, hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")
PORT         = int(os.environ.get("PORT", "8000"))
PUBLIC       = Path(__file__).resolve().parent.parent / "public"

MIME = {".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8",
        ".js":"application/javascript; charset=utf-8", ".json":"application/json; charset=utf-8",
        ".svg":"image/svg+xml", ".png":"image/png", ".ico":"image/x-icon"}

ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")

# Fecha desde la que el conteo es real: TiendaNube carga las ventas en GHL.
# Antes de esto solo hay cargas manuales sueltas, sin nº de orden.
INICIO_TRACKING = os.environ.get("INICIO_TRACKING", "2026-08-15")

# Día en que Rolo entra en operación. Antes de esto la atribución en 0 % es
# el resultado correcto: el agente estaba apagado, no falló la medición.
INICIO_ROLO = os.environ.get("INICIO_ROLO", "2026-08-24")


class ErrorSupabase(Exception):
    pass


def supabase(tabla, params=None, timeout=25):
    """GET contra PostgREST. Devuelve la lista de filas."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise ErrorSupabase("Faltan SUPABASE_URL o SUPABASE_KEY")
    url = f"{SUPABASE_URL}/rest/v1/{tabla}"
    if params:
        url += "?" + urllib.parse.urlencode(params, safe="().,*")
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_KEY,
        "Authorization": "Bearer " + SUPABASE_KEY,
        "Accept": "application/json",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detalle = e.read().decode()[:300]
        raise ErrorSupabase(f"Supabase {e.code}: {detalle}")
    except urllib.error.URLError as e:
        raise ErrorSupabase(f"No se pudo conectar a Supabase: {e.reason}")


def rango(qs):
    """Lee desde/hasta del querystring. Sin límites = todo el histórico."""
    d = (qs.get("desde") or [""])[0].strip()
    h = (qs.get("hasta") or [""])[0].strip()
    if d and not ISO.match(d): d = ""
    if h and not ISO.match(h): h = ""
    if d and h and d > h: d, h = h, d
    return d or None, h or None


def filtros_fecha(desde, hasta, campo="fecha"):
    f = []
    if desde: f.append((campo, f"gte.{desde}"))
    if hasta: f.append((campo, f"lte.{hasta}"))
    return f


def ventas_serie(desde, hasta, grano):
    """Serie de ventas agregada por día o por mes."""
    params = [("select", "*"), ("order", "fecha.asc")]
    params += filtros_fecha(desde, hasta)
    filas = supabase("rolo_ventas_por_dia", params)

    if grano != "mes":
        return filas

    # Agregado mensual: se hace acá para no depender de otra vista.
    por = {}
    for f in filas:
        m = str(f["fecha"])[:7]
        a = por.setdefault(m, {"fecha": m + "-01", "mes": m, "ventas_confirmadas": 0,
                               "monto_total": 0, "ventas_atribuidas": 0, "monto_atribuido": 0,
                               "ventas_asesor": 0, "monto_asesor": 0,
                               "ventas_web_directa": 0, "monto_web_directa": 0,
                               "ventas_no_atribuibles": 0, "monto_no_atribuible": 0})
        for k in ("ventas_confirmadas","monto_total","ventas_atribuidas","monto_atribuido",
                  "ventas_asesor","monto_asesor","ventas_web_directa","monto_web_directa",
                  "ventas_no_atribuibles","monto_no_atribuible"):
            a[k] += int(f.get(k) or 0)
    salida = sorted(por.values(), key=lambda x: x["mes"])
    for a in salida:
        a["ticket_promedio"] = round(a["monto_total"]/a["ventas_confirmadas"]) if a["ventas_confirmadas"] else 0
    return salida


def periodo_previo(desde, hasta):
    """Rango inmediatamente anterior, del mismo largo, para comparar."""
    if not desde or not hasta:
        return None, None
    d0 = datetime.date.fromisoformat(desde)
    h0 = datetime.date.fromisoformat(hasta)
    dias = (h0 - d0).days + 1
    return (d0 - datetime.timedelta(days=dias)).isoformat(), (d0 - datetime.timedelta(days=1)).isoformat()


def totales_ventas(desde, hasta):
    """Totales del período, desglosados por canal.

    Los tres canales son EXCLUYENTES y suman el total: cada venta cae en
    uno y solo uno. Por eso los porcentajes cierran en 100 y el panel puede
    mostrarlos como partes de una misma torta sin trampa.

        rolo        Rolo asesoró antes de la compra (ventana de 7 días)
        asesor      la cerró una persona del equipo (no vino de TiendaNube)
        web_directa el cliente compró solo en la tienda

    La vista rolo_ventas_por_dia ya filtra computa = false, así que lo
    anterior al inicio del tracking nunca llega hasta acá.
    """
    filas = ventas_serie(desde, hasta, "dia")
    t = {"ventas": 0, "monto": 0, "ventas_rolo": 0, "monto_rolo": 0,
         "ventas_asesor": 0, "monto_asesor": 0,
         "ventas_web": 0, "monto_web": 0, "dias": len(filas)}
    for f in filas:
        t["ventas"]        += int(f.get("ventas_confirmadas") or 0)
        t["monto"]         += int(f.get("monto_total") or 0)
        t["ventas_rolo"]   += int(f.get("ventas_atribuidas") or 0)
        t["monto_rolo"]    += int(f.get("monto_atribuido") or 0)
        t["ventas_asesor"] += int(f.get("ventas_asesor") or 0)
        t["monto_asesor"]  += int(f.get("monto_asesor") or 0)
        t["ventas_web"]    += int(f.get("ventas_web_directa") or 0)
        t["monto_web"]     += int(f.get("monto_web_directa") or 0)
    t["ticket"] = round(t["monto"]/t["ventas"]) if t["ventas"] else 0
    pct = lambda x: round(x / t["monto"] * 100, 1) if t["monto"] else 0.0
    t["pct_atribucion"] = pct(t["monto_rolo"])
    t["pct_asesor"]     = pct(t["monto_asesor"])
    t["pct_web"]        = pct(t["monto_web"])
    # Ticket por canal: responde "¿Rolo trae compras más grandes?"
    t["ticket_rolo"]   = round(t["monto_rolo"]/t["ventas_rolo"]) if t["ventas_rolo"] else 0
    t["ticket_asesor"] = round(t["monto_asesor"]/t["ventas_asesor"]) if t["ventas_asesor"] else 0
    t["ticket_web"]    = round(t["monto_web"]/t["ventas_web"]) if t["ventas_web"] else 0
    return t


def totales_gestion(desde, hasta, solo_v2=False):
    params = [("select", "*"), ("order", "fecha.asc")]
    params += filtros_fecha(desde, hasta)
    # Los KPIs de facturación nunca deben incluir estimaciones del v1.
    if solo_v2:
        params.append(("metodologia", "eq.v2_confirmado"))
    filas = supabase("rolo_informes_diarios", params)
    t = {"conversaciones": 0, "enviado_a_web": 0, "leads": 0, "b2b": 0,
         "mala_experiencia": 0, "dias": len(filas), "score": 0.0}
    scores = []
    for f in filas:
        t["conversaciones"]   += int(f.get("total_conversaciones") or 0)
        t["enviado_a_web"]    += int(f.get("enviado_a_web") or 0)
        t["leads"]            += int(f.get("lead_calificado") or 0)
        t["b2b"]              += int(f.get("lead_b2b") or 0)
        t["mala_experiencia"] += int(f.get("mala_experiencia") or 0)
        s = float(f.get("score_promedio") or 0)
        if s: scores.append(s)
    t["score"] = round(sum(scores)/len(scores), 2) if scores else 0.0
    t["tasa"] = round(t["enviado_a_web"]/t["conversaciones"]*100, 1) if t["conversaciones"] else 0.0
    return t, filas


def comparar_versiones():
    """Compara el Rolo v1 contra el v2, normalizado a base semanal.

    La comparación directa sería injusta: el v1 duró ~16 semanas y el v2
    lleva pocos días. Por eso todo se divide por las semanas cubiertas.

    Las ventas del v1 son ESTIMADAS (conteo por IA, valorizado con la
    mediana de las ventas reales). Se devuelven en campos separados y
    marcados, nunca sumadas a la facturación confirmada.
    """
    filas = supabase("rolo_informes_diarios",
                     [("select", "*"), ("order", "fecha.asc")])
    if not filas:
        return {"versiones": [], "aviso": "Sin datos cargados todavía."}

    grupos = {}
    for f in filas:
        met = f.get("metodologia") or "v2_confirmado"
        g = grupos.setdefault(met, {
            "metodologia": met, "fechas": [],
            "conversaciones": 0, "a_la_web": 0, "leads": 0, "mala_experiencia": 0,
            "ventas_confirmadas": 0, "monto_confirmado": 0,
            "ventas_estimadas": 0, "monto_estimado": 0, "scores": [],
        })
        g["fechas"].append(str(f["fecha"]))
        g["conversaciones"]     += int(f.get("total_conversaciones") or 0)
        g["a_la_web"]           += int(f.get("enviado_a_web") or 0)
        g["leads"]              += int(f.get("lead_calificado") or 0)
        g["mala_experiencia"]   += int(f.get("mala_experiencia") or 0)
        g["ventas_confirmadas"] += int(f.get("ventas_web_confirmadas") or 0)
        g["monto_confirmado"]   += int(f.get("monto_atribuido") or 0)
        g["ventas_estimadas"]   += int(f.get("ventas_estimadas_v1") or 0)
        g["monto_estimado"]     += int(f.get("monto_estimado_v1") or 0)
        sc = float(f.get("score_promedio") or 0)
        if sc: g["scores"].append(sc)

    salida = []
    for met, g in grupos.items():
        fechas = sorted(g["fechas"])
        d0 = datetime.date.fromisoformat(fechas[0])
        d1 = datetime.date.fromisoformat(fechas[-1])
        # El v1 es semanal: la última fila cubre 7 días más.
        span = (d1 - d0).days + (7 if met == "v1_estimado" else 1)
        semanas = max(1.0, span / 7.0)

        ventas = g["ventas_confirmadas"] + g["ventas_estimadas"]
        valor  = g["monto_confirmado"] + g["monto_estimado"]
        salida.append({
            "metodologia": met,
            "etiqueta": "IA v1 (estimado)" if met == "v1_estimado" else "IA v2 (confirmado)",
            "es_estimado": met == "v1_estimado",
            "desde": fechas[0], "hasta": fechas[-1],
            "semanas": round(semanas, 1),
            "conversaciones": g["conversaciones"],
            "convs_por_semana": round(g["conversaciones"] / semanas),
            "a_la_web": g["a_la_web"],
            "tasa_resolucion": round(100.0 * g["a_la_web"] / g["conversaciones"], 1) if g["conversaciones"] else 0.0,
            "leads": g["leads"],
            "mala_experiencia": g["mala_experiencia"],
            "ventas": ventas,
            "ventas_por_semana": round(ventas / semanas, 1),
            "valor": valor,
            "valor_por_semana": round(valor / semanas),
            "score": round(sum(g["scores"]) / len(g["scores"]), 2) if g["scores"] else 0.0,
            # Se explicita de dónde sale cada número
            "ventas_confirmadas": g["ventas_confirmadas"],
            "ventas_estimadas": g["ventas_estimadas"],
        })
    salida.sort(key=lambda x: x["desde"])
    return {"versiones": salida}


class Handler(BaseHTTPRequestHandler):
    server_version = "DrivenPanel"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)

    # ---------- helpers ----------
    def responder(self, obj, code=200):
        cuerpo = json.dumps(obj, ensure_ascii=False, default=str).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(cuerpo)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(cuerpo)

    def estatico(self, ruta):
        if ruta in ("", "/"):
            ruta = "/index.html"
        destino = (PUBLIC / ruta.lstrip("/")).resolve()
        # Nunca servir fuera de public/
        if not str(destino).startswith(str(PUBLIC.resolve())) or not destino.is_file():
            self.send_error(404, "No encontrado")
            return
        datos = destino.read_bytes()
        # ETag por contenido: el navegador revalida en cada carga y solo baja
        # el archivo si cambió. Antes app.js/styles.css iban con max-age=3600,
        # así que después de un deploy el panel seguía corriendo el JS viejo
        # durante una hora — el HTML nuevo con el JS anterior.
        etag = '"%s"' % hashlib.md5(datos).hexdigest()[:16]

        # 304: el archivo no cambió. Se responde sin cuerpo y se corta acá,
        # antes de escribir ninguna otra línea de estado.
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            return

        self.send_response(200)
        self.send_header("Content-Type", MIME.get(destino.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(datos)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(datos)

    # ---------- rutas ----------
    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        ruta = u.path

        if not ruta.startswith("/api/"):
            return self.estatico(ruta)

        try:
            desde, hasta = rango(qs)

            if ruta == "/api/salud":
                info = {"ok": True, "supabase_configurado": bool(SUPABASE_URL and SUPABASE_KEY)}
                try:
                    supabase("rolo_informes_diarios", [("select", "fecha"), ("limit", "1")])
                    info["informes"] = "ok"
                except ErrorSupabase as e:
                    info["informes"] = str(e); info["ok"] = False
                try:
                    supabase("rolo_ventas", [("select", "oportunidad_id"), ("limit", "1")])
                    info["ventas"] = "ok"
                except ErrorSupabase as e:
                    info["ventas"] = str(e); info["ok"] = False
                return self.responder(info)

            if ruta == "/api/ventas":
                grano = (qs.get("grano") or ["dia"])[0]
                return self.responder({"grano": grano, "desde": desde, "hasta": hasta,
                                       "serie": ventas_serie(desde, hasta, grano)})

            if ruta == "/api/ventas/detalle":
                params = [("select", "fecha,cliente,nombre,monto,atribuida_rolo,motivo,"
                                     "nro_orden,contact_id,canal,computa"),
                          # Más reciente primero y, dentro del día, por nº de
                          # orden: la #1265 va arriba de la #1264 aunque sea
                          # más chica. Por monto se leía como desorden.
                          ("order", "fecha.desc,nro_orden.desc"),
                          ("limit", (qs.get("limit") or ["500"])[0])]
                params += filtros_fecha(desde, hasta)
                # La tabla del panel muestra la facturación del período: lo que
                # no computa se consulta aparte, en /api/canales.
                params.append(("computa", "is.true"))
                return self.responder({"ventas": supabase("rolo_ventas", params)})

            if ruta == "/api/gestion":
                params = [("select", "*"), ("order", "fecha.asc")]
                params += filtros_fecha(desde, hasta)
                return self.responder({"informes": supabase("rolo_informes_diarios", params)})

            if ruta == "/api/canales":
                # Desglose por canal + el registro que quedó fuera del período.
                # Van juntos a propósito: el panel muestra el corte y lo previo
                # en el mismo lugar, para que nadie los sume por accidente.
                t = totales_ventas(desde, hasta)
                canales = [
                    {"canal": "rolo", "etiqueta": "IA de Driven",
                     "ventas": t["ventas_rolo"], "monto": t["monto_rolo"],
                     "pct": t["pct_atribucion"], "ticket": t["ticket_rolo"]},
                    {"canal": "asesor", "etiqueta": "Asesores",
                     "ventas": t["ventas_asesor"], "monto": t["monto_asesor"],
                     "pct": t["pct_asesor"], "ticket": t["ticket_asesor"]},
                    {"canal": "web_directa", "etiqueta": "Web directa",
                     "ventas": t["ventas_web"], "monto": t["monto_web"],
                     "pct": t["pct_web"], "ticket": t["ticket_web"]},
                ]
                try:
                    fuera = (supabase("rolo_ventas_fuera_de_periodo", [("select", "*")]) or [None])[0]
                except ErrorSupabase:
                    fuera = None
                return self.responder({
                    "desde": desde, "hasta": hasta,
                    "inicio_tracking": INICIO_TRACKING,
                    "inicio_rolo": INICIO_ROLO,
                    "total": {"ventas": t["ventas"], "monto": t["monto"], "ticket": t["ticket"]},
                    "canales": canales,
                    "fuera_de_periodo": fuera,
                })

            if ruta == "/api/versiones":
                return self.responder(comparar_versiones())

            if ruta == "/api/resumen":
                tv = totales_ventas(desde, hasta)
                tg, informes = totales_gestion(desde, hasta)
                pd, ph = periodo_previo(desde, hasta)
                previo = None
                if pd:
                    pv = totales_ventas(pd, ph)
                    pg, _ = totales_gestion(pd, ph)
                    previo = {"desde": pd, "hasta": ph, "ventas": pv, "gestion": pg}
                # Rango real disponible, para que el front arme los selectores.
                lim = supabase("rolo_ventas_por_dia", [("select", "fecha"), ("order", "fecha.asc")])
                try:
                    fuera = (supabase("rolo_ventas_fuera_de_periodo", [("select", "*")]) or [None])[0]
                except ErrorSupabase:
                    fuera = None
                return self.responder({
                    "desde": desde, "hasta": hasta,
                    "ventas": tv, "gestion": tg, "previo": previo,
                    "inicio_tracking": INICIO_TRACKING,
                    "inicio_rolo": INICIO_ROLO,
                    "fuera_de_periodo": fuera,
                    "cobertura": {"desde": lim[0]["fecha"] if lim else None,
                                  "hasta": lim[-1]["fecha"] if lim else None},
                })

            self.send_error(404, "Ruta desconocida")

        except ErrorSupabase as e:
            self.responder({"error": str(e)}, 502)
        except Exception as e:
            self.responder({"error": f"{type(e).__name__}: {e}"}, 500)


if __name__ == "__main__":
    faltan = [v for v in ("SUPABASE_URL", "SUPABASE_KEY") if not os.environ.get(v)]
    if faltan:
        print(f"AVISO: faltan {', '.join(faltan)} — la API va a responder 502.", flush=True)
    print(f"Panel de Driven escuchando en http://0.0.0.0:{PORT}", flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
