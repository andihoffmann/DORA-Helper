from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from pypdf import PdfReader
from typing import Optional
import io
import re
import json
import os
import requests
import anthropic

app = FastAPI()

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allows all origins (for local dev/extension)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")


def extract_keywords_from_text(text):
    # Sucht nach "Keywords:" oder "Key words:" am Zeilenanfang
    match = re.search(r'(?:Keywords?|Key\s+words)\s*[:—](.*?)(?:\n\n|Introduction|Abstract|1\.\s)', text,
                      re.DOTALL | re.IGNORECASE)
    if match:
        raw_keywords = match.group(1)
        # Silbentrennung korrigieren (z.B. "Algo-\nrithm" -> "Algorithm")
        raw_keywords = re.sub(r'-\s*\n\s*', '', raw_keywords)
        raw_keywords = raw_keywords.replace('\n', ' ')
        return [k.strip() for k in re.split(r'[,;]', raw_keywords) if k.strip()]
    return []


def analyze_with_claude(text: str) -> dict:
    """Extract structured metadata from PDF text using Claude API."""
    if not ANTHROPIC_API_KEY:
        return {}

    try:
        client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

        prompt = (
            "Analyze the following scientific paper text and extract these four fields:\n\n"
            "1. keywords: The author-provided keywords (JSON array of strings, empty array if not found)\n"
            "2. abstract: The full abstract text (string, null if not found)\n"
            "3. funding: All funding sources, grant numbers, and acknowledgements relevant to funding "
            "(single string summarizing all funding info, null if not found)\n"
            "4. psi_beamlines: Any PSI (Paul Scherrer Institut) beamline or instrument names mentioned, "
            "including SLS beamlines (e.g. X10SA, X06SA, X12SA, cSAXS, TOMCAT, etc.), "
            "SINQ instruments, SμS instruments, SwissFEL beamlines "
            "(JSON array of strings, empty array if none found)\n\n"
            "Return ONLY a valid JSON object with exactly these keys: "
            "keywords, abstract, funding, psi_beamlines. No markdown, no explanation.\n\n"
            "Paper text:\n"
        ) + text[:20000]

        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}]
        )

        return json.loads(message.content[0].text)

    except Exception as e:
        return {"claude_error": str(e)}


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
            content = await file.read()
            pdf_file = io.BytesIO(content)
        else:
            return {"status": "error", "message": "No file or URL provided"}

        reader = PdfReader(pdf_file)

        # 1. SEITENANZAHL (Technisch exakt)
        num_pages = len(reader.pages)

        # 2. TEXT EXTRAHIEREN: erste 20 Seiten + letzte Seite (für Acknowledgements)
        max_extract = min(num_pages, 20)
        text_parts = []
        for i in range(max_extract):
            text_parts.append(reader.pages[i].extract_text() or "")
        if num_pages > max_extract:
            text_parts.append(reader.pages[num_pages - 1].extract_text() or "")
        full_text = "\n".join(text_parts)

        # 3. KEYWORDS: Regex-Fallback (Metadaten oder Seite 1)
        keywords = []
        if reader.metadata and reader.metadata.get("/Keywords"):
            raw_meta = reader.metadata.get("/Keywords")
            keywords = [k.strip() for k in re.split(r'[,;]', raw_meta) if k.strip()]
        if not keywords and num_pages > 0:
            keywords = extract_keywords_from_text(text_parts[0])

        # 4. CLAUDE ANALYSE
        claude_result = analyze_with_claude(full_text)

        # Claude-Ergebnisse haben Vorrang; Regex als Fallback für Keywords
        final_keywords = claude_result.get("keywords") or keywords

        result = {
            "page_count": num_pages,
            "keywords": final_keywords,
            "abstract": claude_result.get("abstract"),
            "funding": claude_result.get("funding"),
            "psi_beamlines": claude_result.get("psi_beamlines", []),
            "status": "success"
        }

        if "claude_error" in claude_result:
            result["claude_error"] = claude_result["claude_error"]

        return result

    except Exception as e:
        return {"status": "error", "message": str(e)}

# Startbefehl für lokale Tests (nicht im Docker nötig):
# uvicorn main:app --reload