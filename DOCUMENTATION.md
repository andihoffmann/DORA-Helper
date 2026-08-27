# DORA Lib4ri Assistant

The **DORA Lib4ri Assistant** is a powerful browser extension designed to streamline the workflow for editing metadata in the DORA repository (Lib4ri). It provides automated metadata fetching, intelligent form validation, PDF analysis, and an integrated keyword manager.

---

## Installation

1.  **Download**: Get the latest `.xpi` file (for Firefox) or the unpacked extension folder (for Chrome/Edge).
2.  **Firefox**:
    *   Drag and drop the `.xpi` file into any open browser window.
    *   Alternatively, go to `about:addons`, click the gear icon, and select **"Install Add-on From File..."**.
3.  **Chrome/Edge**:
    *   Go to `chrome://extensions`.
    *   Enable **"Developer mode"** (toggle in the top right).
    *   Click **"Load unpacked"** and select the extension folder.

---

## Core Features

### 1. Metadata Auto-Fetch & Cross-Check
When an edit page is opened in DORA, the assistant automatically scans for a DOI and fetches data from **Crossref**, **Unpaywall**, **Scopus**, and **DOAJ**.

![Metadata Auto-Fetch Result Box](./images/metadata_autofetch_ui.png)


*   **Result Box**: A floating panel on the right displays:
    *   **Open Access Status** (Gold, Green, Hybrid, Bronze, Closed).
    *   **License Information** (e.g., CC-BY) with direct links.
    *   **Version Detection** (Published Version/VoR vs. Accepted Manuscript/AAM).
*   **🔍 Data Cross-Check**: An intelligent validation layer that compares sources:
    *   **Corresponding Author Check**: Validates if the corresponding author is affiliated with Eawag, Empa, PSI, or WSL (requires Scopus API key).
    *   **DOAJ Integration**: Warns if a "Gold OA" article is not listed in DOAJ or if a "Hybrid" article is listed.
    *   **License Match**: Flags discrepancies between Unpaywall and Crossref license data.
*   **Quick Actions**:
    *   `Metadaten importieren`: (Book Chapters/Proceedings) Imports title, host title, pages, year, publisher, authors, editors, and abstract.

---

### 2. Projekt- & Funding-Verknüpfung (Crossref + OpenAIRE)

Die Förderangaben aus Scopus hängen stark von der Formulierung im Acknowledgement ab. Der Assistent fragt deshalb über die DOI zusätzlich **Crossref** (Verlagsangabe aus der Funder Registry) und **OpenAIRE** (Projektregister von SNSF und EU) ab und gleicht die Treffer mit dem Formular ab.

*   **Panel "🔗 Projekte aus Crossref & OpenAIRE"**: sitzt direkt unter dem Formularbereich *Funding (only EC and SNSF Projects)* – im Arbeitskontext, nicht in der Result-Box. Die Kopfzeile zeigt „x von y fehlen" und lässt sich zuklappen; sind alle Projekte erfasst, startet es eingeklappt.
    *   `✅` bereits im Datensatz erfasst
    *   `➕` fehlt und ist belegt (Verlagsangabe oder registrierte Projektrelation) → Button **Eintragen**
    *   `❓` nur per OpenAIRE-Textmining abgeleitet oder ohne Projekttitel → bitte vor dem Übernehmen prüfen
    *   `🚫` DORA kennt das Projekt nicht → **kein Button**. Zwei Fälle, beide im Klartext benannt: „Nicht in DORAs Funding-Auswahlliste – kann nicht eingetragen werden" bzw. „Abgleich mit DORAs Auswahlliste fehlgeschlagen – kein Eintrag möglich" (mit *erneut prüfen*). Solche Projekte zählen nicht als „fehlend", sondern als „nicht eintragbar".
*   **Eintragen**: Nutzt eine leere Zeile im Bereich *Funding (only EC and SNSF Projects)* oder legt per Drupal-AJAX eine neue an und füllt sie in der Reihenfolge, die das Formular erwartet:
    1.  *Funder Name* (Select) – steuert die abhängigen Felder, danach kurze Wartezeit
    2.  *Funder* / Funding Stream (Select)
    3.  *Project Title and Number* – der Titel kommt aus DORAs eigener Auswahlliste (siehe unten), nicht aus OpenAIRE.
    4.  *Award Number* (readonly, wird sonst vom Autocomplete gefüllt) und das versteckte *funder_identifier*
    Jedes Feld wird nach dem Schreiben kontrolliert und – falls das Widget den Wert verworfen hat – ohne Events erneut gesetzt; was endgültig nicht durchgeht, meldet die Zeile im Klartext. Es wird nie etwas ohne Klick geschrieben und keine bestehende Zeile überschrieben.
*   **`Alle N fehlenden eintragen`**: Sammelaktion, nur für vollständige Treffer mit hoher Konfidenz.

**Datenkonventionen** (aus dem DORA-Bestand abgeleitet):

| Feld | SNSF | European Commission |
| --- | --- | --- |
| `funderName` | Swiss National Science Foundation | European Commission |
| `funderIdentifier` | `http://dx.doi.org/10.13039/501100001711` | `http://dx.doi.org/10.13039/501100000780` |
| `fundingStream` | SNSF | Horizon 2020 / Horizon Europe / Seventh Framework Programme |
| `awardNumber` | nackter Code (`200021E_203578` → `203578`) | Grant Agreement Number |
| `awardTitle` | Projekttitel | `AKRONYM - Titel` |

*   **Nur SNSF und EU**: In DORA existieren ausschliesslich diese beiden Förderer. Weitere in Crossref/OpenAIRE gefundene Geldgeber (z.B. DFG, BAFU) werden nur als Hinweiszeile angezeigt, nicht eingetragen.
*   **Förderer ohne Funder-DOI**: Crossref führt EU-Förderung oft als Freitext unter wechselnden Namen („Marie Skłodowska-Curie", „EU 7th Framework Program", „EU-H2020 Research and Innovation Program"). Diese Schreibweisen werden bei der Förderer-Erkennung mit abgedeckt. Eine Zuordnung allein über die Codegleichheit findet **nicht** statt – Projektnummern kollidieren zwischen Förderorganisationen (CNPq `#140439/2011-0` trifft z.B. auf SNSF 140439).
*   **Formatprüfung der Award-Angabe**: Übernommen wird nur, was tatsächlich eine SNSF-/EC-Projektnummer ist:
    *   erlaubt sind vorangestellte Beschriftungen ohne Ziffern („Grant agreement No 101002207"), nachgestellte Akronyme („654360 NFFA-Europe") und – bei SNSF üblich – das direkt angehängte **Instrumentenpräfix**: `200021E_203578`, `PZ00P2_174192`, `CRSII5_186422`, `CRSK-2_195953`, `IZSEZ0_180186`, `20FI21-189381`, `51NF40-205606`
    *   abgelehnt werden zusammengesetzte Kennungen fremder Förderer, bei denen **hinter** der Zahl eine weitere Zahl steht: `#140439/2011-0` (CNPq), `302760/2022-9`, `510228793 / C04-CRC1633` und `248198858/GRK 2032` (DFG)
    *   reine Akronyme ohne Nummer („PSIFELLOW") erzeugen keinen eigenen Eintrag
*   **Zwei gleichwertige Belege** – ohne einen davon wird weder ein Button angeboten noch ein Feld beschrieben:
    1.  **Treffer in DORAs Funding-Auswahlliste** (Autocomplete des Titelfelds) → Zeile zeigt „✓ In DORAs Funding-Auswahlliste"
    2.  **Die Nummer ist im DORA-Bestand bereits mit diesem Förderer in Gebrauch** (Solr) → „✓ In DORA bereits verwendet (n Datensätze)". Dieser zweite Beleg ist wichtig, weil der Autocomplete-Callback im eingeloggten Formular nicht immer dieselben Treffer liefert wie erwartet; die Werte stammen dann aus dem Produktivbestand.
*   **Abgleich mit der DORA-Auswahlliste**: Das Award-Title-Feld ist ein Autocomplete auf ein kontrolliertes Vokabular; ohne bestätigten Treffer wird kein einziges Feld beschrieben. Der Assistent fragt dessen Callback mit der **Award-Nummer** ab (die Suche greift auch auf Nummern) und liest den Eintrag im Format `nummer||titel||stream-index` (1 = Seventh Framework Programme, 2 = Horizon 2020, 3 = SNSF, 4 = Horizon Europe). Titel, Nummer und Stream werden daraus übernommen – dadurch steht exakt das im Formular, was auch die manuelle Auswahl erzeugt hätte. Die Liste wird direkt aus dem Seitenkontext geholt (Fallback: Hintergrunddienst), die Prüfung läuft vor dem Zeichnen des Panels, damit Zähler, Buttons und Sammelaktion von Anfang an stimmen; jede Zeile zeigt „✓ In DORA-Auswahlliste" bzw. den Hinweis, dass das Projekt dort fehlt und deshalb nicht erfasst wird.
*   **Hauskonvention gewinnt**: Ist die Award-Nummer bereits in DORA vergeben, werden Titel und Stream aus dem Bestand (Solr) übernommen, damit die Schreibweise über alle Datensätze identisch bleibt.
*   **Nummern-Abgleich**: SNSF-Nummern aus Crossref (`PZ00P2_174192`, `SNF 182124`, `200021E_203578`) werden auf den reinen Code normalisiert, damit Dubletten sicher erkannt werden. Dabei zählen immer **ganze Ziffernblöcke** – längere Nummern wie `10003256` bleiben unverändert und werden nicht auf die letzten Stellen gekürzt.

---

### 3. Supplements: Supporting Information & Datenpublikationen

Neben dem Volltext werden die **Zusatzmaterialien** eines Artikels gesucht und zum Download angeboten — als kompakte Schaltfläche `📎 n Supplements`, die bei Klick eine Liste ausklappt.

*   **Zwei Quellen**, deren Treffer zusammengeführt werden:
    *   **Verlagsseite**: Links, die als *Supporting Information*, *Supplementary material*, *Electronic Supplementary Material* o.ä. ausgewiesen sind — geprüft gegen die Schemata von ACS, Wiley, Elsevier, Springer, MDPI und Copernicus. Der Abruf läuft über die Sitzung des Nutzers, erreicht also auch Wiley und Elsevier. Erkannt werden auch Pfade **ohne Dateiendung** (ACS: `…/article-supplement/3756100/pdf/nn5c08710_si_001/`) und **Direktlinks ins Repositorium** — ACS verweist häufig nach figshare; solche Links werden über die figshare-/Zenodo-API in die einzelnen Dateien aufgelöst. Navigations-Links („supplement issue", Ausgaben-Archive) und das Artikel-PDF selbst bleiben draussen; nennt der Verlag dasselbe Supplement doppelt (als Datei und als blossen DOI-Link), bleibt die Datei.
    *   **Metadaten**: verknüpfte Datenpublikationen aus **OpenAIRE** (`IsSupplementedBy`, rund 11 % der Artikel) und **Crossref** (`is-supplemented-by`, `has-part`, rund 0.3 %).
    *   **Elsevier über die PII**: ScienceDirect sperrt automatisierte Abrufe, der Auslieferungs-CDN `ars.els-cdn.com` ist dagegen offen. Aus der PII (Crossref-Feld `alternative-id` bzw. die linkinghub-URL) werden die Dateien `1-s2.0-<PII>-mmc<N>.<endung>` per HEAD-Anfrage geprüft — Endungen in der Reihenfolge pdf, docx, xlsx, zip … , Abbruch beim ersten fehlenden Index. Beispiel `10.1016/j.fuel.2026.140882` → `mmc1.pdf` (1.6 MB).
    *   **figshare-Suche über die Artikel-DOI**: figshare führt die Artikel-DOI als `resource_doi`. ACS (und weitere Verlage) legen ihre Supporting Information dort ab — dieser Weg findet sie **ohne** die Verlagsseite, was bei ACS entscheidend ist, weil deren Seiten automatisierte Abrufe blockieren. Beispiel `10.1021/acsnano.5c08710` → SI-DOI `…s001` mit `nn5c08710_si_001.pdf`.
    *   Bei **Zenodo** und **figshare** werden zusätzlich die einzelnen Dateien samt Grösse und direkter Download-URL aufgelöst.
*   **Wo**: in der Result-Box neben den PDF-Aktionen und im **PDF-Upload-Dialog** direkt bei der Versionsauswahl, damit die Datei beim Hochladen greifbar ist.
*   **Lizenz**: Bei Zenodo und figshare wird die Lizenz der Datenpublikation als verlinktes Kürzel angezeigt (z.B. `CC BY-NC 4.0`).
*   **Ergebnislage wird unterschieden** — „nichts gefunden" ist nicht dasselbe wie „nicht nachgesehen":
    *   `📎 kein Supplement` — alle Quellen haben geantwortet und führen keines. Der Tooltip nennt die geprüften Quellen.
    *   `📎 nicht prüfbar` (orange) — es gibt keine strukturierten Angaben **und** die Verlagsseite war nicht lesbar, etwa weil sie den Abruf blockiert (ACS antwortet mit HTTP 403 oder einer Cloudflare-Seite mit HTTP 200). Ob Supporting Information existiert, ist damit offen; der Tooltip sagt das und verweist auf die Artikelseite.
    *   Werden Treffer gefunden, während die Verlagsseite blockiert war, steht über der Liste ein Hinweis, dass dort weitere Dateien liegen können.

---

### 4. Advanced PDF Analysis & Extraction
Extract **Page Count** and **Keywords** directly from PDFs and discover missing full-texts.

![PDF Analysis Tool](./images/pdf_analysis_ui.png)


*   **Zotero-style Page Scanning**: If Unpaywall has no PDF, the assistant scans the publisher's page via meta-tags (`citation_pdf_url`) and JSON-LD to find direct links.
*   **Lightning Analysis (⚡)**: Click the lightning bolt next to any PDF link (even on publisher sites) to analyze it via our Hugging Face backend.
*   **Passive Monitor**: The assistant detects PDFs opened in other tabs or downloaded. The drop zone turns green ("⚡ PDF Detected") - click it to import immediately.
*   **Drag & Drop**: Analyze local files by dropping them into the result box.
*   **Smart Filling**: Automatically appends page counts (e.g., `(12 pp.)`) and populates the keyword manager.

---

### 5. Autocomplete for Form Fields
The assistant provides intelligent autocomplete suggestions from the DORA Solr index.

**Supported Fields:**
*   **Conference Name**: Pulls existing conferences; selecting one triggers a lookup for related proceedings and editors.
*   **Proceedings Title**, **Series Title**, **Series ISSN**, and **Publisher** (for non-journal items).

**How it works:**
*   Suggestions appear after 3 characters.
*   Uses a custom dropdown with keyboard navigation (↑/↓ to navigate, Enter to select, Escape to close).
*   Automatically refreshes with native Drupal AJAX handling.

---

### 6. Integrated Keyword Manager
Replaces the standard keyword input with a sophisticated management tool.

![Integrated Keyword Manager](./images/keyword_manager_ui.png)


*   **Edit & Sort**: Click to load keywords into a draggable list.
*   **Drag & Drop**: Easily reorder keywords for the final record.
*   **Auto-Formatting**: Corrects case based on a customizable exception list (e.g., `dna -> DNA`, `ph -> pH`).
*   **Direct Sync**: Changes are instantly written back to the hidden DORA fields.

---

### 7. Smart Tags for "Additional Information"
Commonly used tags can be inserted with a single click below the "Additional Information" field.

*   **Available Tags**: `#hybrid` (orange), `#other_journal_contribution`, `#present_address` (with name prompt), `#corporate`, `#green`, and `#CERC` (context-aware for WSL).
*   **`#hybrid`**: steht bei den übrigen Tags unter dem Feld (nicht mehr in der Result-Box). Im Normalfall sieht er aus wie die anderen Tags; meldet der DOI-Abgleich Hybrid OA, färbt er sich orange und bekommt einen weichen Schein — die Farbe ist also das Signal, nicht Dekoration. Der Tag wird ans Ende des Feldes gesetzt und nie doppelt eingefügt.
*   **Consistency**: Ensures tags are formatted correctly every time.

---

### 8. Real-time Validation & Error Summary
The assistant validates form fields as you type, highlighting issues with a **red border** (errors) or **dotted line** (warnings).

![Real-time Validation and Errors](./images/validation_errors_ui.png)


*   **Validation Rules**:
    *   **Volume**: Mandatory for published journal articles (with exceptions for Book Chapters).
    *   **Start Page**: Validates required status and `(pp.)` format.
    *   **Sentence Case Check**: Intelligence to detect unwanted Title Case in titles and names (English vs. German aware).
    *   **Author Validation**: Flags "nomatch" entries and missing affiliations.
*   **PSI Affiliation Check**: Validates Group, Lab, and Division against historical data for the publication year.
*   **Error Summary Panel**: A minimizable panel at the bottom right provides a "to-do list" of issues to fix before saving.

---

## Configuration

Customization via the **Options** page:
1.  **Scopus API Key**: Required for Corresponding Author checks.
2.  **Keyword Exceptions**: Define your own formatting rules (`pattern -> replacement`).
3.  **PSI Affiliation Data**: Upload `psi_data.js` updates here.

---

## Technical Notes

### HTTP Internal Server Configuration
The extension accesses an internal Solr server at `http://lib-dora-prod1.emp-eaw.ch:8080`.
*   **Chrome/Edge**: Requires enabling "Insecure content" in Site Settings for DORA.
*   **Firefox**: Handled via standard mixed-content exceptions.

### Accessibility & Compatibility
*   Complies with Mozilla's secure DOM manipulation policies (`textContent`).
*   Compatible with Islandora/Drupal AJAX form updates.
