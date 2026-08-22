# Driven · Panel de Resultados

Dashboard gerencial del agente **Rolo**: tráfico enviado a la web, calidad de
atención y atribución de ventas.

**Arquitectura:** backend en Python (solo stdlib) que lee de **Supabase** y sirve el
panel. Supabase es la fuente única del dashboard: ahí se acumula el histórico para
poder comparar meses y años.

Si el backend no está disponible, el panel cae automáticamente a un `data.js`
precargado — así el mismo archivo sirve para revisar el diseño sin infraestructura.

---

## Qué muestra

**Vista Gestión** — el desempeño conversacional del agente
- Conversaciones atendidas, enviadas a la web, tasa de resolución, leads, **ventas atribuidas a Rolo**, score
- Evolución semanal (barras + línea) con panel propio de ventas atribuidas
- Desenlace de las conversaciones
- Tasa de resolución con promedio del período
- Productos más consultados y problemas más frecuentes
- Detalle por semana, ordenable

**Vista Ventas** — la plata
- Facturación, ticket promedio, atribución a Rolo
- Facturación por día (apilada: atribuido vs. sin atribuir)
- Dona de atribución
- Detalle de cada venta con su estado

**Filtros de período** en toda la aplicación:
- **Todo el período** — el histórico completo
- **Por mes** — un mes puntual
- **Por día** — una fecha exacta
- **Personalizado** — rango libre entre dos fechas

Los KPIs comparan contra el período anterior del mismo largo. Tema claro/oscuro y
export CSV (respeta el filtro activo).

---

## Arquitectura

```
TiendaNube ──► GoHighLevel ──┐
                             ├──► sincronizar.py ──► SUPABASE ──► backend ──► panel
Supabase (chat_message) ─────┘         │                 ▲
                                       │          rolo_ventas
                          flujo n8n de tracking   rolo_informes_diarios
                          (decide la atribución)
```

**Quién es fuente de verdad de qué:**

| Pregunta | Fuente de verdad |
|---|---|
| ¿Hubo una venta? ¿de cuánto? | **GoHighLevel** (lo alimenta TiendaNube) |
| ¿Rolo conversó y asesoró? | **Supabase** (`chat_message`) |
| ¿Esa venta es de Rolo? | **`rolo_ventas`** — el cruce ya resuelto |

Supabase no *reemplaza* a GHL: guarda el **resultado del cruce** con fecha de corte,
que es lo que permite trazar resultados a 1 o 3 años sin depender de que el CRM
conserve el historial ni de recalcular la atribución cada vez.

### Tablas

| Tabla | Grano | Para qué |
|---|---|---|
| `rolo_informes_diarios` | 1 fila por día | Resumen de gestión + payload con el detalle |
| `rolo_ventas` | 1 fila por venta | Histórico de ventas, con monto y atribución |
| `rolo_ventas_por_dia` | vista | Agregado diario, se recalcula solo |

## Endpoints

| Ruta | Devuelve |
|---|---|
| `GET /api/salud` | Estado de las conexiones |
| `GET /api/ventas?desde=&hasta=&grano=dia\|mes` | Serie de ventas |
| `GET /api/ventas/detalle?desde=&hasta=` | Cada venta del rango |
| `GET /api/gestion?desde=&hasta=` | Informes diarios |
| `GET /api/resumen?desde=&hasta=` | KPIs + comparación con el período previo |

> **Sobre la atribución:** hoy figura en 0% porque Rolo todavía no opera. Las ventas
> que se ven son reales, pero ninguna se le atribuye aún. Cuando el agente entre en
> operación y el flujo `Rolo - Tracking Diario v2` empiece a correr, el panel separa
> automáticamente qué ventas generó.

---

## Puesta en marcha

### 1. Crear las tablas en Supabase
En el SQL Editor, ejecutar en orden:
1. `tracking-diario/02_tabla_informes.sql` — resumen diario (quizá ya lo hiciste)
2. `tracking-diario/04_tabla_ventas.sql` — histórico de ventas + vista

### 2. Cargar los datos
```bash
cp .env.example .env       # completar SUPABASE_URL, SUPABASE_KEY y GHL_TOKEN
set -a; source .env; set +a

python3 backend/sincronizar.py --historico --todo
```
- `--historico` carga las 16 semanas del Excel (Rolo v1)
- `--todo` trae todas las ventas de GHL; sin ese flag solo los últimos 30 días

Es **idempotente**: se puede correr las veces que haga falta, hace UPSERT.

### 3. Levantar el panel
```bash
docker compose up --build      # http://localhost:8080
```

### 4. Mantenerlo al día
Un cron diario con `python3 backend/sincronizar.py` alcanza. También puede
dispararlo el mismo flujo de n8n después de generar el informe del día.

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

1. Subir este repo a GitHub (**privado**: `data.js` tiene nombres de clientes).
2. En EasyPanel: **Create Service → App**.
3. **Source:** el repositorio, rama `main`. **Build:** Dockerfile.
4. **Port:** `8000`.
5. **Environment:** cargar `SUPABASE_URL`, `SUPABASE_KEY` y `GHL_TOKEN`.
6. Deploy y asignar dominio.

La `service_role` key vive **solo** en el servidor: el navegador nunca la ve, porque
todas las consultas pasan por el backend. Por eso no hace falta configurar RLS para
este panel (igual conviene tenerlo activado en la base).

Para que se actualice solo, agregar un cron en EasyPanel:
```
0 8 * * *  python3 /app/backend/sincronizar.py
```

---

## Estructura

```
dashboard-driven/
├── backend/
│   ├── server.py       · API + estáticos (stdlib, sin dependencias)
│   └── sincronizar.py  · GHL → Supabase (idempotente)
├── public/
│   ├── index.html      · estructura
│   ├── styles.css      · identidad Driven + tokens de tema
│   ├── app.js          · gráficos y lógica; API con fallback a data.js
│   └── data.js         · respaldo estático (para ver el panel sin backend)
├── scripts/
│   ├── actualizar_datos.py    · genera data.js (modo sin backend)
│   └── historico_semanal.json · histórico del Excel, ya procesado
├── Dockerfile · docker-compose.yml · .env.example
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

**Sin dependencias.** Los gráficos son SVG dibujados a mano y el backend usa solo
la stdlib de Python. Sin librerías, sin CDN y sin build: la imagen Docker es mínima
y el panel funciona incluso abriendo el archivo directamente.

**Accesibilidad.** Contraste AA, foco visible en teclado, `prefers-reduced-motion`
respetado, tablas como alternativa a los gráficos, y ningún dato codificado solo
por color.
