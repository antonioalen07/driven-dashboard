# Driven · Panel de Resultados

Dashboard gerencial del agente **Rolo**: tráfico enviado a la web, calidad de
atención y atribución de ventas.

Es un sitio **estático** (HTML + CSS + JS, sin frameworks ni build). Se puede abrir
como archivo local o servir con Docker en EasyPanel.

---

## Qué muestra

**Vista Gestión** — el desempeño conversacional del agente
- Conversaciones atendidas, enviadas a la web, tasa de resolución, leads, score
- Evolución semanal (barras + línea, una sola escala)
- Desenlace de las conversaciones
- Tasa de resolución con promedio del período
- Productos más consultados y problemas más frecuentes
- Detalle por semana, ordenable

**Vista Ventas** — la plata
- Facturación, ticket promedio, atribución a Rolo
- Facturación por día (apilada: atribuido vs. sin atribuir)
- Dona de atribución
- Detalle de cada venta con su estado

**Filtro por mes** en toda la aplicación, tema claro/oscuro y export CSV.

---

## Fuentes de datos

| Dato | Origen | Estado |
|---|---|---|
| Ventas y facturación | GoHighLevel (alimentado por TiendaNube) | ✅ Real |
| Histórico conversacional | Excel `RESUMEN SEMANAL` (mar–jun 2026) | ✅ Real |
| Atribución a Rolo | Flujo de tracking diario | ⏳ Pendiente: Rolo no está operativo |

> **Sobre la atribución:** hoy figura en 0% porque Rolo todavía no opera. Las ventas
> que se ven son reales, pero ninguna se le atribuye aún. Cuando el agente entre en
> operación y el flujo `Rolo - Tracking Diario v2` empiece a correr, el panel separa
> automáticamente qué ventas generó.

---

## Actualizar los datos

```bash
export GHL_TOKEN="pit-xxxxxxxx"     # token de la API de GoHighLevel
python3 scripts/actualizar_datos.py
```

Regenera `public/data.js`. Si el token falta o la API falla, **conserva los datos
anteriores** en vez de dejar el panel vacío.

Variables opcionales:

| Variable | Default |
|---|---|
| `GHL_LOCATION_ID` | `BMHsoyIJ3WBb6yfmh2LY` |
| `GHL_PIPELINE_ID` | `NbShXQHetl9uBaPOYt3N` |

Cuando Rolo entre en operación, poné `"rolo_operativo": true` en `data.js` para que
desaparezca el aviso del encabezado.

---

## Correr local

```bash
# Opción 1 — sin nada instalado
open public/index.html

# Opción 2 — con Docker
docker compose up --build      # http://localhost:8080
```

---

## Deploy en EasyPanel

1. Subir este repo a GitHub.
2. En EasyPanel: **Create Service → App**.
3. **Source:** el repositorio, rama `main`.
4. **Build:** Dockerfile (lo detecta solo).
5. **Port:** `80`.
6. Deploy y asignar dominio.

El `Caddyfile` sirve los estáticos con gzip y manda `no-store` en `data.js`, para que
al actualizar los datos no quede una versión vieja cacheada.

Para actualizar los números: correr el script, commitear el `data.js` nuevo y
redeployar. Si querés que se actualice solo, un cron de EasyPanel o de n8n que
ejecute el script y haga push alcanza.

---

## Estructura

```
dashboard-driven/
├── public/
│   ├── index.html      · estructura
│   ├── styles.css      · identidad Driven + tokens de tema
│   ├── app.js          · gráficos y lógica (sin dependencias)
│   └── data.js         · los datos (lo regenera el script)
├── scripts/
│   ├── actualizar_datos.py   · trae ventas de GHL y arma data.js
│   └── historico_semanal.json · histórico del Excel, ya procesado
├── Dockerfile · Caddyfile · docker-compose.yml
└── README.md
```

---

## Notas de diseño

**Identidad.** Colores y tipografías extraídos de driven.com.ar: rojo `#c80003`
(el de los precios), amarillo `#f5c518` (el de los CTA), negro `#1a1a1a`, y las
fuentes **Oswald** (títulos) + **Inter** (texto), que son las que carga el sitio.

**Colores de datos.** La paleta de gráficos se validó con un verificador de
contraste y daltonismo en modo claro y oscuro. El amarillo de marca es demasiado
claro para usarse como marca de dato, así que en gráficos se usa una versión más
oscura (`#b8860b`); el amarillo original quedó solo para elementos de interfaz.

**Sin dependencias.** Los gráficos son SVG dibujados a mano. Sin librerías, sin
CDN y sin build: el panel funciona incluso abriendo el archivo directamente.

**Accesibilidad.** Contraste AA, foco visible en teclado, `prefers-reduced-motion`
respetado, tablas como alternativa a los gráficos, y ningún dato codificado solo
por color.
