# Kleines, schnelles Basis-Image
FROM python:3.9-slim

WORKDIR /app

# Dependencies installieren
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Code kopieren
COPY main.py .

# User anlegen (Hugging Face mag kein Root)
RUN useradd -m -u 1000 user
USER user
ENV PATH="/home/user/.local/bin:$PATH"

# Port 7860 für Hugging Face Spaces
EXPOSE 7860

# Server starten
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "7860"]