#!/usr/bin/env python3
"""
Sincroniza GoHighLevel -> Supabase.

Deja en `rolo_ventas` cada venta ganada del CRM, con su decisión de
atribución. Es idempotente: se puede correr cuantas veces haga falta,
porque hace UPSERT por `oportunidad_id`.

    python3 backend/sincronizar.py                    # últimos 30 días
    python3 backend/sincronizar.py --todo             # todo el histórico
    python3 backend/sincronizar.py --desde 2026-08-15 # desde una fecha
    python3 backend/sincronizar.py --historico        # + las semanas del Excel

Variables de entorno:
    GHL_TOKEN       token de la API de GoHighLevel   (pit-...)
    SUPABASE_URL    https://xxxx.supabase.co
    SUPABASE_KEY    service_role key
"""
import os, sys, json, datetime, urllib.request, urllib.parse, urllib.error
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
GHL_TOKEN    = os.environ.get("GHL_TOKEN", "").strip()
GHL_LOCATION = os.environ.get("GHL_LOCATION_ID", "BMHsoyIJ3WBb6yfmh2LY")
GHL_PIPELINE = os.environ.get("GHL_PIPELINE_ID", "NbShXQHetl9uBaPOYt3N")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY", "")

# Cloudflare bloquea user-agents de script.
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")


def ghl(params):
    url = "https://services.leadconnectorhq.com/opportunities/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + GHL_TOKEN, "Version": "2021-07-28",
        "Accept": "application/json", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read().decode())


def traer_ventas():
    todas, page = [], 1
    while True:
        d = ghl({"location_id": GHL_LOCATION, "pipeline_id": GHL_PIPELINE,
                 "status": "won", "limit": "100", "page": str(page)})
        ops = d.get("opportunities", [])
        todas += ops
        if len(todas) >= d.get("meta", {}).get("total", 0) or not ops:
            break
        page += 1
    return todas


def supabase_get(tabla, params=None):
    """GET contra PostgREST, para leer datos ya cargados."""
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise SystemExit("ERROR: faltan SUPABASE_URL o SUPABASE_KEY")
    url = f"{SUPABASE_URL}/rest/v1/{tabla}"
    if params:
        url += "?" + urllib.parse.urlencode(params, safe="().,*")
    req = urllib.request.Request(url, headers={
        "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY,
        "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode())


def upsert(tabla, filas, on_conflict):
    """UPSERT vía PostgREST. En lotes, para no mandar un payload gigante."""
    if not filas:
        return 0
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise SystemExit("ERROR: faltan SUPABASE_URL o SUPABASE_KEY")
    total = 0
    for i in range(0, len(filas), 200):
        lote = filas[i:i+200]
        url = f"{SUPABASE_URL}/rest/v1/{tabla}?on_conflict={on_conflict}"
        req = urllib.request.Request(
            url, data=json.dumps(lote, ensure_ascii=False, default=str).encode(),
            method="POST",
            headers={"apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY,
                     "Content-Type": "application/json",
                     # merge-duplicates = UPDATE si ya existe la clave
                     "Prefer": "resolution=merge-duplicates,return=minimal"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                r.read()
            total += len(lote)
        except urllib.error.HTTPError as e:
            raise SystemExit(f"ERROR Supabase {e.code}: {e.read().decode()[:400]}")
    return total


def dia_ar(iso):
    """Día calendario argentino (UTC-3) de un timestamp ISO."""
    if not iso:
        return None
    try:
        t = datetime.datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except ValueError:
        return None
    return (t - datetime.timedelta(hours=3)).date().isoformat()


def mapear(op):
    contacto = op.get("contact") or {}
    fh = op.get("lastStatusChangeAt") or op.get("createdAt")
    nombre = op.get("name") or ""
    nro = None
    if "#" in nombre:
        nro = nombre.split("#", 1)[1].strip() or None
    return {
        "oportunidad_id": op.get("id"),
        "fecha": dia_ar(fh),
        "fecha_hora": fh,
        "nombre": nombre or None,
        "monto": float(op.get("monetaryValue") or 0),
        "moneda": "ARS",
        "nro_orden": nro,
        "contact_id": op.get("contactId") or contacto.get("id"),
        "cliente": contacto.get("name"),
        "tags": contacto.get("tags") or [],
        # La atribución la decide el flujo de tracking, no este sincronizador.
        # Acá se preserva lo que ya haya: el UPSERT no pisa estas columnas
        # porque no se envían salvo que la venta sea nueva.
        "es_venta_web": "venta web" in nombre.lower()
                        or "compro-en-web" in [t.lower() for t in (contacto.get("tags") or [])],
        "origen": "ghl",
        "actualizado_en": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        # atribuida_rolo / motivo NO se envían: los decide el flujo de tracking.
        # Si se mandaran, un resync pisaría la atribución con el default (false).
    }


def ticket_referencia():
    """Mediana de las ventas reales del CRM.

    Se usa la MEDIANA y no el promedio: una sola venta muy grande
    (hay una de $1,5M) inflaría el promedio ~13% y sobreestimaría
    el valor del histórico. La mediana es más honesta.

    Devuelve 0 si todavía no hay ventas cargadas.
    """
    try:
        filas = supabase_get("rolo_ventas", [("select", "monto"), ("order", "monto.asc")])
    except Exception:
        return 0
    montos = sorted(float(f["monto"]) for f in filas if f.get("monto"))
    if not montos:
        return 0
    n = len(montos)
    return round(montos[n//2] if n % 2 else (montos[n//2-1] + montos[n//2]) / 2)


def cargar_historico_excel(ticket=None):
    """Las 16 semanas del Rolo v1 -> rolo_informes_diarios.

    Son SEMANAS (no días) y las ventas son un conteo que hizo la IA
    leyendo conversaciones: sin monto, sin cliente, sin nº de orden.

    Por eso NO van a ventas_web_confirmadas, que es exclusiva de ventas
    confirmadas por el CRM. Van a ventas_estimadas_v1, con metodologia
    = 'v1_estimado', para que ninguna consulta las mezcle por accidente.

    El monto estimado (ventas × ticket de referencia) sirve para
    dimensionar cuánto generó el v1 y compararlo con el v2.
    """
    f = RAIZ / "scripts" / "historico_semanal.json"
    if not f.exists():
        print("  (sin historico_semanal.json, se omite)")
        return 0
    semanas = json.loads(f.read_text(encoding="utf-8"))
    if ticket is None:
        ticket = ticket_referencia()
    filas = []
    for s in semanas:
        ventas_v1 = int(s.get("ventas_rolo_v1", 0) or 0)
        filas.append({
            "fecha": s["fecha"],
            "metodologia": "v1_estimado",
            "granularidad": "semanal",
            "ventas_estimadas_v1": ventas_v1,
            "monto_estimado_v1": int(ventas_v1 * ticket),
            "total_conversaciones": s.get("total_conversaciones", 0),
            "enviado_a_web": s.get("enviado_a_web", 0),
            "lead_calificado": s.get("lead_calificado", 0),
            "mala_experiencia": s.get("mala_experiencia", 0),
            "inconclusa": s.get("inconclusa", 0),
            "consulta_comercial": s.get("consulta_comercial", 0),
            "tasa_resolucion_pct": s.get("tasa_resolucion_pct", 0),
            "score_promedio": s.get("score_promedio", 0),
            # ventas_web_confirmadas queda en 0 a propósito: es exclusiva
            # de ventas confirmadas por el CRM.
            "informe_narrativo": None,
            "payload": json.dumps({
                "origen": "excel_rolo_v1",
                "advertencia": "Conteo estimado por IA sobre conversaciones. Sin monto ni cliente reales.",
                "ticket_referencia_usado": ticket,
                "productos_top": s.get("productos_top", []),
                "problemas": s.get("problemas", []),
            }, ensure_ascii=False),
        })
    n = upsert("rolo_informes_diarios", filas, "fecha")
    total_v1 = sum(f["ventas_estimadas_v1"] for f in filas)
    print(f"  ticket de referencia (mediana): ${ticket:,}")
    print(f"  {total_v1} ventas estimadas -> valor estimado ${total_v1*ticket:,}")
    return n


def main():
    args = sys.argv[1:]

    if not GHL_TOKEN:
        print("Sin GHL_TOKEN: no se sincronizan ventas de GHL.")
        if "--historico" in args:
            # Se puede cargar igual, pero sin ventas el ticket no se puede
            # calcular: se avisa en vez de inventar un número.
            print("Cargando histórico del Excel (Rolo v1)...")
            n = cargar_historico_excel()
            print(f"  {n} semanas cargadas")
        return

    print("Trayendo ventas de GoHighLevel...")
    ops = traer_ventas()
    filas = [mapear(o) for o in ops if o.get("id") and dia_ar(o.get("lastStatusChangeAt") or o.get("createdAt"))]

    # --desde YYYY-MM-DD acota el rango sin traer todo el histórico.
    desde = None
    if "--desde" in args:
        i = args.index("--desde")
        if i + 1 >= len(args):
            raise SystemExit("ERROR: --desde necesita una fecha (YYYY-MM-DD)")
        desde = args[i + 1]
        try:
            datetime.date.fromisoformat(desde)
        except ValueError:
            raise SystemExit(f"ERROR: fecha inválida '{desde}', se espera YYYY-MM-DD")

    if desde:
        filas = [f for f in filas if f["fecha"] >= desde]
        print(f"  (desde {desde})")
    elif "--todo" not in args and "--historico" not in args:
        corte = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
        filas = [f for f in filas if f["fecha"] >= corte]
        print(f"  (últimos 30 días; usá --todo para el histórico completo)")

    n = upsert("rolo_ventas", filas, "oportunidad_id")
    monto = sum(f["monto"] for f in filas)
    print(f"  {n} ventas sincronizadas | ${monto:,.0f}")
    if filas:
        print(f"  rango: {min(f['fecha'] for f in filas)} -> {max(f['fecha'] for f in filas)}")

    # El histórico va al final: necesita las ventas ya cargadas para
    # calcular el ticket de referencia con la mediana real.
    if "--historico" in args:
        print("\nCargando histórico del Excel (Rolo v1)...")
        n = cargar_historico_excel()
        print(f"  {n} semanas cargadas en rolo_informes_diarios")

    print("\nListo.")


if __name__ == "__main__":
    main()
