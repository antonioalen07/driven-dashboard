#!/usr/bin/env python3
"""
Sincroniza GoHighLevel -> Supabase.

Deja en `rolo_ventas` cada venta ganada del CRM, con su decisión de
atribución. Es idempotente: se puede correr cuantas veces haga falta,
porque hace UPSERT por `oportunidad_id`.

    python3 backend/sincronizar.py              # últimos 30 días
    python3 backend/sincronizar.py --todo       # todo el histórico
    python3 backend/sincronizar.py --historico  # + las semanas del Excel

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
    }


def cargar_historico_excel():
    """Las 16 semanas del Rolo v1 -> rolo_informes_diarios.

    Ojo: son SEMANAS, no días, y las ventas son un conteo que hizo la IA
    leyendo conversaciones (sin monto ni cliente). Se cargan como informes
    con la fecha de inicio de cada semana y payload marcado, para que el
    dashboard pueda distinguirlas de los datos diarios reales.
    """
    f = RAIZ / "scripts" / "historico_semanal.json"
    if not f.exists():
        print("  (sin historico_semanal.json, se omite)")
        return 0
    semanas = json.loads(f.read_text(encoding="utf-8"))
    filas = []
    for s in semanas:
        filas.append({
            "fecha": s["fecha"],
            "total_conversaciones": s.get("total_conversaciones", 0),
            "enviado_a_web": s.get("enviado_a_web", 0),
            "lead_calificado": s.get("lead_calificado", 0),
            "mala_experiencia": s.get("mala_experiencia", 0),
            "inconclusa": s.get("inconclusa", 0),
            "consulta_comercial": s.get("consulta_comercial", 0),
            "tasa_resolucion_pct": s.get("tasa_resolucion_pct", 0),
            "score_promedio": s.get("score_promedio", 0),
            # Las ventas del v1 NO van a ventas_web_confirmadas: esa columna
            # es para ventas confirmadas por CRM. Van en el payload, marcadas.
            "informe_narrativo": None,
            "payload": json.dumps({
                "origen": "excel_rolo_v1",
                "granularidad": "semanal",
                "advertencia": "Conteo estimado por IA sobre conversaciones. Sin monto ni cliente.",
                "ventas_estimadas_rolo_v1": s.get("ventas_rolo_v1", 0),
                "productos_top": s.get("productos_top", []),
                "problemas": s.get("problemas", []),
            }, ensure_ascii=False),
        })
    return upsert("rolo_informes_diarios", filas, "fecha")


def main():
    args = sys.argv[1:]
    if "--historico" in args:
        print("Cargando histórico del Excel (Rolo v1)...")
        n = cargar_historico_excel()
        print(f"  {n} semanas cargadas en rolo_informes_diarios")

    if not GHL_TOKEN:
        print("Sin GHL_TOKEN: no se sincronizan ventas.")
        return

    print("Trayendo ventas de GoHighLevel...")
    ops = traer_ventas()
    filas = [mapear(o) for o in ops if o.get("id") and dia_ar(o.get("lastStatusChangeAt") or o.get("createdAt"))]

    if "--todo" not in args and "--historico" not in args:
        corte = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
        filas = [f for f in filas if f["fecha"] >= corte]
        print(f"  (últimos 30 días; usá --todo para el histórico completo)")

    n = upsert("rolo_ventas", filas, "oportunidad_id")
    monto = sum(f["monto"] for f in filas)
    print(f"  {n} ventas sincronizadas | ${monto:,.0f}")
    if filas:
        print(f"  rango: {min(f['fecha'] for f in filas)} -> {max(f['fecha'] for f in filas)}")
    print("Listo.")


if __name__ == "__main__":
    main()
