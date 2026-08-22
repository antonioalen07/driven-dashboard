# Panel de Driven: backend Python (stdlib) + estáticos.
# Sin dependencias externas: no hace falta pip install.
FROM python:3.12-slim

WORKDIR /app

COPY backend/ ./backend/
COPY public/  ./public/
COPY scripts/ ./scripts/

ENV PORT=8000 \
    PYTHONUNBUFFERED=1

EXPOSE 8000

# Chequeo de vida: si Supabase se cae, /api/salud responde igual
# (con ok:false), así el contenedor no se reinicia en loop.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8000')+'/api/salud',timeout=4)" || exit 1

CMD ["python3", "backend/server.py"]
