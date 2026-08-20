#!/usr/bin/env python3
"""
Regenera public/data.js con los datos actuales.

Fuentes:
  1. GoHighLevel  -> ventas ganadas (dato duro: monto y contacto)
  2. Supabase     -> informes diarios de Rolo, si la tabla ya existe
  3. Excel        -> histórico semanal del Rolo v1 (marzo-junio 2026)

Uso:
    export GHL_TOKEN="pit-..."            # token de la API de GHL
    export SUPABASE_URL="postgres://..."  # opcional
    python3 scripts/actualizar_datos.py

Sin GHL_TOKEN el script conserva las ventas que ya estaban en data.js,
así que nunca deja el panel vacío por un problema de credenciales.
"""
import json, os, sys, collections, datetime, pathlib, urllib.request, urllib.parse, urllib.error

RAIZ   = pathlib.Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "public" / "data.js"
EXCEL  = RAIZ / "scripts" / "historico_semanal.json"

GHL_TOKEN    = os.environ.get("GHL_TOKEN", "").strip()
GHL_LOCATION = os.environ.get("GHL_LOCATION_ID", "BMHsoyIJ3WBb6yfmh2LY")
GHL_PIPELINE = os.environ.get("GHL_PIPELINE_ID", "NbShXQHetl9uBaPOYt3N")

# Cloudflare rechaza user-agents de scripts: hace falta uno de navegador.
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")


def ghl(params):
    url = "https://services.leadconnectorhq.com/opportunities/search?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "Authorization": "Bearer " + GHL_TOKEN,
        "Version": "2021-07-28",
        "Accept": "application/json",
        "User-Agent": UA,
    })
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read().decode())


def traer_ventas():
    """Todas las oportunidades ganadas del pipeline, paginando."""
    todas, page = [], 1
    while True:
        d = ghl({"location_id": GHL_LOCATION, "pipeline_id": GHL_PIPELINE,
                 "status": "won", "limit": "100", "page": str(page)})
        ops = d.get("opportunities", [])
        todas += ops
        total = d.get("meta", {}).get("total", 0)
        if len(todas) >= total or not ops:
            break
        page += 1
    return todas


def agrupar_por_dia(ops):
    por = collections.defaultdict(lambda: {"n": 0, "monto": 0.0, "detalle": []})
    for o in ops:
        fecha = str(o.get("lastStatusChangeAt") or o.get("createdAt") or "")[:10]
        if not fecha:
            continue
        monto = float(o.get("monetaryValue") or 0)
        contacto = o.get("contact") or {}
        d = por[fecha]
        d["n"] += 1
        d["monto"] += monto
        d["detalle"].append({
            "cliente": contacto.get("name") or "—",
            "nombre": o.get("name") or "—",
            "monto": monto,
            "contact_id": o.get("contactId") or contacto.get("id"),
            # Rolo aún no opera: cuando lo haga, esto lo define el flujo de tracking.
            "atribuida": False,
        })

    dias = []
    for f in sorted(por):
        d = por[f]
        dias.append({
            "fecha": f,
            "ventas_confirmadas": d["n"],
            "monto": round(d["monto"]),
            "ventas_atribuidas_rolo": 0,
            "monto_atribuido": 0,
            "ventas_no_atribuibles": d["n"],
            "monto_no_atribuible": round(d["monto"]),
            "detalle": sorted(d["detalle"], key=lambda x: -x["monto"])[:12],
        })
    return dias


def cargar_previo():
    """Lee el data.js actual para no perder datos si una fuente falla."""
    if not SALIDA.exists():
        return {}
    txt = SALIDA.read_text(encoding="utf-8")
    i, j = txt.find("{"), txt.rfind("}")
    if i < 0 or j < 0:
        return {}
    try:
        return json.loads(txt[i:j+1])
    except json.JSONDecodeError:
        return {}


def main():
    previo = cargar_previo()

    # --- histórico semanal (se genera una vez desde el Excel) ---
    if EXCEL.exists():
        semanas = json.loads(EXCEL.read_text(encoding="utf-8"))
    else:
        semanas = previo.get("semanas_historico", [])
        if semanas:
            print("aviso: sin historico_semanal.json, se conserva el previo")

    # --- ventas de GHL ---
    if GHL_TOKEN:
        try:
            ops = traer_ventas()
            dias = agrupar_por_dia(ops)
            print(f"GHL: {len(ops)} ventas ganadas en {len(dias)} días")
        except urllib.error.HTTPError as e:
            print(f"ERROR GHL {e.code}: {e.read().decode()[:200]}", file=sys.stderr)
            dias = previo.get("dias_ventas", [])
            print("se conservan las ventas previas")
        except Exception as e:
            print(f"ERROR GHL: {e}", file=sys.stderr)
            dias = previo.get("dias_ventas", [])
    else:
        dias = previo.get("dias_ventas", [])
        print("sin GHL_TOKEN: se conservan las ventas previas")

    meses = sorted({s["fecha"][:7] for s in semanas} | {d["fecha"][:7] for d in dias})
    total_n = sum(d["ventas_confirmadas"] for d in dias)
    total_m = sum(d["monto"] for d in dias)

    data = {
        "generado": datetime.datetime.now().isoformat(timespec="seconds"),
        "meses": meses,
        "semanas_historico": semanas,
        "dias_ventas": dias,
        "totales_ventas": {
            "n": total_n,
            "monto": total_m,
            "desde": dias[0]["fecha"] if dias else None,
            "hasta": dias[-1]["fecha"] if dias else None,
        },
        "tasas_corregidas": previo.get("tasas_corregidas", []),
        # Poner en True cuando Rolo entre en operación y el tracking
        # empiece a atribuir ventas.
        "rolo_operativo": previo.get("rolo_operativo", False),
    }

    SALIDA.write_text("window.DRIVEN_DATA = " + json.dumps(data, ensure_ascii=False) + ";\n",
                      encoding="utf-8")
    print(f"OK -> {SALIDA.relative_to(RAIZ)}")
    print(f"   semanas: {len(semanas)} | días con ventas: {len(dias)}")
    print(f"   ventas: {total_n} | ${total_m:,}")
    print(f"   meses: {', '.join(meses)}")


if __name__ == "__main__":
    main()
