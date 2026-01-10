from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pypdf import PdfReader
from typing import Optional
import io
import re
import requests

app = FastAPI()

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins (for local dev/extension)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def extract_keywords_from_text(text):
    # Sucht nach "Keywords:" oder "Key words:" am Zeilenanfang
    # Stoppt bei doppelten Zeilenumbrüchen oder expliziten Sektions-Titeln.
    # \n[A-Z] wurde entfernt, da Keywords oft großgeschrieben auf einer neuen Zeile beginnen.
    match = re.search(r'(?:Keywords?|Key\s+words)\s*[:—](.*?)(?:\n\n|Introduction|Abstract|1\.\s)', text,
                      re.DOTALL | re.IGNORECASE)
    if match:
        # Bereinigen und Splitten
        raw_keywords = match.group(1)
        # Silbentrennung korrigieren (z.B. "Algo-\nrithm" -> "Algorithm")
        raw_keywords = re.sub(r'-\s*\n\s*', '', raw_keywords)
        # Normale Zeilenumbrüche durch Leerzeichen ersetzen
        raw_keywords = raw_keywords.replace('\n', ' ')
        
        # Split bei Komma oder Semikolon
        return [k.strip() for k in re.split(r'[,;]', raw_keywords) if k.strip()]
    return []


@app.post("/analyze")
async def analyze_pdf(
    file: Optional[UploadFile] = File(None),
    pdf_url: Optional[str] = Form(None)
):
    try:
        if pdf_url:
            # Download via Python (bypassing CORS)
            headers = {"User-Agent": "Mozilla/5.0"}
            resp = requests.get(pdf_url, headers=headers, timeout=60)
            resp.raise_for_status()
            pdf_file = io.BytesIO(resp.content)
        elif file:
            # Datei in den Speicher laden
            content = await file.read()
            pdf_file = io.BytesIO(content)
        else:
            return {"status": "error", "message": "No file or URL provided"}

        reader = PdfReader(pdf_file)

        # 1. SEITENANZAHL (Technisch exakt)
        num_pages = len(reader.pages)

        # 2. KEYWORDS (Reihenfolge bleibt erhalten)
        keywords = []

        # A) Versuch über PDF Metadaten (Properties)
        if reader.metadata and reader.metadata.get("/Keywords"):
            raw_meta = reader.metadata.get("/Keywords")
            # Metadaten sind oft Strings wie "K1, K2, K3" -> Reihenfolge bleibt
            keywords = [k.strip() for k in re.split(r'[,;]', raw_meta) if k.strip()]

        # B) Fallback: Text auf Seite 1 scannen
        if not keywords and num_pages > 0:
            first_page_text = reader.pages[0].extract_text()
            keywords = extract_keywords_from_text(first_page_text)

        return {
            "page_count": num_pages,
            "keywords": keywords,
            "status": "success"
        }

    except Exception as e:
        return {"status": "error", "message": str(e)}

# Startbefehl für lokale Tests (nicht im Docker nötig):
# uvicorn main:app --reload