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


*   **Einklappen statt schließen**: Neben dem **×** sitzt ein **–**. Damit
    schrumpft die Box auf eine schmale Leiste mit Logo und DOI; ein Klick auf
    die Leiste (oder auf **▢**) holt sie zurück. Der Zustand bleibt über
    weitere Abfragen erhalten – die Box springt beim Durcharbeiten also nicht
    ständig wieder auf. **×** entfernt sie wie bisher ganz; beim nächsten
    Abruf startet sie dann wieder offen.
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
*   **Formulierung** — die Aussage lautet immer `📎 Kein Supplement gefunden`, nie „es gibt keines": gefunden wurde keines, ausgeschlossen ist damit nichts. Der Unterschied steckt in der Kennzeichnung:
    *   `📎 Kein Supplement gefunden` (blass) — alle Quellen haben geantwortet und führen keines. Der Tooltip nennt die geprüften Quellen.
    *   `📎 Kein Supplement gefunden ⚠` (orange) — die Prüfung blieb unvollständig: die Verlagsseite war nicht lesbar (ACS antwortet mit HTTP 403 oder einer Cloudflare-Seite mit HTTP 200) oder eine Metadatenquelle hat geschwiegen. Der Tooltip sagt, welche Quelle fehlt, und verweist auf die Artikelseite.
    *   **Ein Klick prüft erneut** — sinnvoll, wenn ein Verlag beim ersten Versuch gesperrt hat.
    *   Werden Treffer gefunden, während die Verlagsseite blockiert war, steht über der Liste ein Hinweis, dass dort weitere Dateien liegen können.
*   **Konsistent über die Seiten hinweg**: Das Prüfergebnis wird je DOI 12 Stunden in `chrome.storage.local` gemerkt. Edit-Formular und PDF-Verwaltung zeigen dadurch dieselbe Aussage – vorher konnte derselbe Artikel hier „gefunden" und dort „nicht prüfbar" sein, weil der Verlagsabruf mal durchkam und mal nicht.

---

### 4. Advanced PDF Analysis & Extraction

#### PDF-Quellen aus Nachweisdiensten
Das Auslesen der Verlagsseite scheitert regelmässig an Bot-Sperren. Der Helper
fragt deshalb **parallel mehrere Nachweisdienste** nach direkten Volltext-Links
und **testet jeden Kandidaten mit einem kurzen Bereichsabruf an** – „geprüft ✓"
heisst, dass dahinter wirklich ein PDF liegt und keine Sperrseite:

| Quelle | Feld |
|---|---|
| Unpaywall | **alle** `oa_locations[].url_for_pdf` (bisher nur `best_oa_location`) – bringt Repositoriumskopien (ZORA, DORA, institutionelle Server) |
| Crossref | `link[]` mit `content-type: application/pdf` (die vom Verlag gemeldeten Volltext-Links) |
| OpenAlex | `best_oa_location.pdf_url`, `locations[].pdf_url`, `open_access.oa_url` |
| Europe PMC | `fullTextUrlList` (nur `availabilityCode: OA`) plus der Render-Endpunkt `europepmc.org/articles/<PMCID>?pdf=render` |
| Semantic Scholar | `openAccessPdf.url`, dazu `externalIds.ArXiv` → `arxiv.org/pdf/<id>` |
| Elsevier Article Retrieval | mit dem hinterlegten **Scopus-Schlüssel**: `api.elsevier.com/content/article/doi/<doi>?httpAccept=application/pdf` – umgeht die ScienceDirect-Sperre |

Messwerte aus der Praxis: `europepmc.org/…?pdf=render` liefert PDF,
`pmc.ncbi.nlm.nih.gov/…/pdf/…` und `link.springer.com/content/pdf/…` dagegen
HTML-Sperrseiten – genau deshalb wird angetestet statt vertraut.

*   **Bedienung**: In der Ergebnisbox steht **📚 n PDF-Quellen ✓**; die Liste
    zeigt jede Quelle mit Herkunft, Fassung, Lizenz und Prüfergebnis, jede
    einzeln zu öffnen. Der beste geprüfte Treffer wandert automatisch in den
    Haupt-PDF-Schalter und verdrängt den aus der Verlagsseite geratenen Link.
*   **Schlüssel bleibt geheim**: Die Elsevier-Adresse wird ohne `apiKey`
    angezeigt; geprüft und geladen wird im Hintergrundskript, das die Bytes an
    den Betrachter durchreicht (`fetchPdfBytes`).
*   **Elsevier-Volltext braucht eine Freigabe**: Ohne sie gibt die API nur die
    **Vorschauseite** heraus – ein gültiges PDF mit genau einer Seite. Der
    Helper misst deshalb bei dieser Quelle die **Seitenzahl** (der Kandidat
    wird ganz geladen und der Seitenbaum ausgewertet) und schreibt das
    Ergebnis an: `nur Vorschauseite – kein Volltext` bzw. `14 Seiten`. Eine
    Vorschauseite rutscht in der Rangfolge ganz nach hinten und wird nicht in
    den Haupt-Knopf übernommen, solange es eine andere geprüfte Quelle gibt;
    im Betrachter erscheint zusätzlich eine Hinweisleiste (die automatisch
    abgelegte Datei enthält dann ebenfalls nur diese Seite).
    Freigeschaltet wird der Volltext über die **Instituts-IP** oder einen
    **Insttoken**, der in den Einstellungen neben dem Scopus-Key hinterlegt
    werden kann (`elsevierInsttoken`, wird an Prüfung, Download und Vorschau
    angehängt). Läuft der Zugang rein über die IP und kommt trotzdem nur die
    Vorschau, fehlt der Lizenz die Volltext-Freigabe für die API – das ist
    eine Frage ans Elsevier-Konto, nicht am Helper zu lösen.
*   **Elsevier nur bei Elsevier**: Der API-Kandidat entsteht nur, wenn DOI-Präfix
    oder Crossref-Verlagsangabe auf Elsevier deuten – sonst stünde bei jedem
    fremden Verlag ein Kandidat in der Liste, der nie funktionieren kann.
*   **arXiv**: Kennung aus Semantic Scholar (mit einem Wiederholversuch, der
    offene Endpunkt drosselt oft), aus den Crossref-Relationen oder aus der
    Landing-Page eines OpenAlex-Standorts. Bei Physik-Artikeln ist das häufig
    die einzige frei zugängliche Fassung – Beispiel `10.1103/fjjf-xspp`:
    Verlagsseite gesperrt, `arxiv.org/pdf/2512.18831` ✓.
*   **Last**: Ergebnis je DOI 12 Stunden zwischengespeichert – **ohne
    geprüften Treffer nur 20 Minuten**, damit ein Aussetzer eines Dienstes
    nicht einen halben Tag als „nichts gefunden" stehen bleibt. Höchstens acht
    Kandidaten werden angetestet.
*   **Auch der Verlags-Scan wird angetestet**: Der aus der Verlagsseite
    gelesene Link bekommt ein ✓ oder ein ⚠ mit dem Grund – vorher wurde ein
    Angebot gemacht, das der Verlag gar nicht ausliefert.
*   **Abgeleitete Adressen**: Aus der Artikelseite (Crossref
    `resource.primary.URL`) wird der richtige Verlags-Host gezogen und das
    übliche Schema angehängt – **Wiley** `/doi/pdfdirect/<doi>` und
    `/doi/pdf/<doi>` (auch auf Zeitschriften-Subdomains wie
    `advanced.onlinelibrary.wiley.com`), dazu Springer, Frontiers, IOP und die
    Atypon-Plattformen. Geraten wird nur die Adresse – ob etwas dahinter
    liegt, entscheidet wie immer der Test.
*   **Blockiert ≠ nicht vorhanden**: Antwortet ein Verlag mit 403/401, wird der
    Kandidat als **blockiert** markiert; sein Knopf heisst dann **„im Tab"**
    und öffnet die Adresse in einem normalen Browser-Tab, wo Session und
    Cloudflare-Freigabe greifen. Der Helper versucht es vor dem Aufgeben ein
    zweites Mal ohne Bereichsanfrage und mit Referer der Artikelseite.

Der PDF-Schalter der Ergebnisbox (**📄 PDF ansehen (Unpaywall)** bzw.
**📄 PDF (Verlag)**, sobald der Verlags-Scan einen direkten Link findet)
öffnet das gefundene PDF im mitgelieferten Betrachter – eigenes Fenster,
Breite folgt dem Fenster, Marker für Lizenz, Förderung und Keywords.
**Strg-, Umschalt- oder Mittelklick** öffnet weiterhin den Originallink,
falls ein Verlag die Datei nicht direkt ausliefert.

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
*   **Direct Sync**: Changes are instantly written back to the hidden DORA fields.

#### Schreibweise: DORAs eigener Bestand statt fester Liste
Früher entschied allein eine Ausnahmeliste, was gross geschrieben wird — neue
Schlagworte fielen durch und landeten klein. Jetzt greifen drei Stufen, in
dieser Reihenfolge:

1.  **Manuelle Ausnahmeliste** (Optionen) — behält Vorrang, wird aber nur noch
    für echte Sonderfälle gebraucht.
2.  **Hausschreibweise aus DORA** (Solr): Gesucht wird im analysierten Feld
    `mods_subject_topic_mt` (kleingeschrieben, tokenisiert), gezählt werden die
    Original-Schreibweisen der Treffer in `mods_subject_topic_ms`. Die
    Mehrheitsvariante gewinnt — verlangt werden mindestens **3 Belege** und
    **60 % Anteil**, sonst gilt der Befund als Zufall. Ergebnis 30 Tage
    zwischengespeichert (Fehlanzeigen 3 Tage), höchstens 800 Begriffe.
    Das wächst mit dem Bestand mit und trifft auch, was keine Regel wüsste:
    `lidar` → **LiDAR** (56 Belege), `edna` → **eDNA**, `qpcr` → **qPCR**.
3.  **Regeln** für alles, was DORA noch nicht kennt:
    *   **Chemische Formeln** über das Periodensystem: `nh4` → `NH4`,
        `tio2` → `TiO2`, `al2o3` → `Al2O3`, `h2so4` → `H2SO4`. Nur mit Ziffer
        im Token (sonst würde jedes „as" zu Arsen) und nur bei **eindeutiger**
        Zerlegung — `co2` (C+O oder Co) und `sio2` (Si+O oder S+I+O) sind
        mehrdeutig und bleiben dem Bestand überlassen, der sie kennt.
    *   **Abkürzungen** ohne Vokal, auch mit Ziffern: `nmr` → `NMR`,
        `hplc` → `HPLC`, `pm10` → `PM10`.
    *   **Bereits gewollte Schreibweisen bleiben stehen** — Binnenmajuskeln
        (`pH`, `mRNA`, `SARS-CoV-2`) und getippte Kürzel (`HPLC`, `ERA5`).
        Das war der eigentliche Bruch: vorher wurde alles erst kleingeschrieben.
    *   **Länder und Regionen** (ISO 3166 plus Grossräume), auch mehrwortig:
        `united kingdom` → `United Kingdom`, `south africa` → `South Africa`.
    *   Gebrüllte Exporte werden entschärft: `WATER QUALITY` → `water quality`.
    *   Alles andere bleibt klein — DORAs Konvention für Schlagworte.

Im Keyword-Manager erscheint die Regelform sofort, die DORA-Form zieht nach,
sobald der Lookup antwortet; das Feld blitzt kurz auf und der Tooltip nennt die
Herkunft samt Belegzahl. Wer selbst getippt hat, wird nicht überschrieben.
Beim Bulk-Einfügen wird schon der eingetragene Wert normalisiert (mit 2,5 s
Zeitfenster, damit der Lookup das Einfügen nicht aufhält).

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

### 9. Batch QC Dashboard
Auf Suchergebnisseiten erscheint der Button **Batch QC** – entweder für die
angehakten Treffer oder für alle sichtbaren Ergebnisse. Das Dashboard legt sich
als Vollbild über die Seite und arbeitet die Liste ohne Seitenwechsel ab.

*   **Links** die Trefferliste; freigegebene PIDs bleiben pro Sitzung grün
    markiert (`sessionStorage`).
*   **Mitte** das MODS-Formular des Datensatzes im Iframe, kompakt gestylt.
    Drupal-Kopf, Fusszeile, Menü und Hilfstexte sind ausgeblendet.
    **Identifikatoren (DOI, ISBN/ISSN, PMID, WoS, Scopus …) bleiben an ihrer
    Stelle im Formular, werden aber immer aufgeklappt und sichtbar gehalten**
    (Schutzmarke `data-dora-keep`) – sie sind für die QC unverzichtbar und
    dürfen der Ausblend-Logik nicht zum Opfer fallen. Nach oben gezogen werden
    nur Titel und Autorenliste. Bewusst verborgen bleiben Felder wie
    *Corresponding author's e-mail* und die DUO-Notizfelder.
*   **Rechts** die **PDF-Verwaltung** des Objekts
    (`…/islandora/object/<pid>/lib4ridora_pdf_management`), damit sichtbar ist,
    welche Dateien mit welchen Rechten am Datensatz hängen.
*   **PDF-Vorschau ↗** öffnet das PDF im gebündelten PDF.js-Viewer in einem
    eigenen, frei skalierbaren Fenster (normales Browserfenster, also
    maximierbar und Snap-fähig). Der Viewer richtet die Seitenbreite am
    Fenster aus und rendert beim Ziehen neu; **🔎-/🔎+** schalten auf eine
    feste Stufe um, **↔ Fensterbreite** zurück auf automatisch.
    Es wird genau ein Fenster verwaltet:
    beim Blättern folgt es dem Datensatz, ohne den Fokus zu stehlen; wurde es
    geschlossen, bleibt es geschlossen, bis man erneut klickt.
*   **Adobe-Automatik**: Mit der Einstellung *PDFs direkt in Adobe Acrobat
    öffnen* (Optionen, oder Schalter **Immer Adobe** im Betrachter) wird der
    Knopf zu **📥 In Adobe öffnen** – der Helper lädt die Datei und übergibt
    sie an das System-Standardprogramm für PDFs. Heruntergeladen wird nur auf
    Klick – beim Blättern würde sonst jeder Datensatz einen Download auslösen.
    Ein bereits offenes Vorschaufenster folgt dem Datensatz trotzdem weiter.
    Welches Programm startet, entscheidet Firefox unter *Einstellungen →
    Allgemein → Anwendungen → Portable Document Format (PDF)*: steht dort
    „In Firefox öffnen", erscheint der eingebaute Betrachter statt Adobe.
    Lehnt Firefox das automatische Starten ab (`downloads.open()` ist nur aus
    einer Nutzeraktion erlaubt), wird der Knopf zu **📂 In Adobe starten** –
    ein Klick holt es nach.
*   **Institutsschild**: Links in der Betrachter-Leiste steht, zu welchem
    Institut der Datensatz gehört – **Eawag** (blau `#0069b4`), **Empa**
    (rot `#e2001a`), **WSL** (waldgrün `#2d6a4f`), **PSI** (dunkelblau
    `#002b5c`). Die Zuordnung kommt aus dem Pfad der DORA-Seite
    (`/eawag/islandora/…`), ersatzweise aus dem PID-Präfix (`wsl:44194`);
    ohne Anhaltspunkt bleibt das Schild verborgen.
*   **Marker im Betrachter**: **🖍 Marker** hebt im PDF hervor, worauf es in
    der QC ankommt, und sammelt die Fundstellen in einer Leiste am unteren
    Rand – je Kategorie ein Zähler zum Aus-/Einblenden, darunter die
    Fundstellen mit Seitenzahl. Ein Klick scrollt die Fundstelle selbst
    mittig ins Bild (nicht nur die Seite) und lässt sie aufblitzen;
    mehrfaches Klicken geht weitere Vorkommen der Reihe nach durch:
    *   🟩 **Lizenz** – Creative Commons in Lang- und Kurzform (CC BY, CC0,
        Lizenz-URLs, „distributed under the terms"). Die **Version gehört zum
        Tag**, sofern sie unmittelbar dabeisteht: `CC BY-NC-ND 4.0`,
        `Creative Commons Attribution 4.0 International`,
        `creativecommons.org/licenses/by-nc/4.0`, `CC0 1.0 Universal`.
    *   🟦 **SNF** – Swiss National Science Foundation / Nationalfonds, SNSF,
        NCCR sowie Vergabenummern (`200021_203578`, „grant 203578"). Nackte
        Sechsstellige zählen bewusst nicht, sonst leuchten Messtabellen auf.
    *   🟪 **EU/ERC** – ERC, Horizon 2020/Europe, FP7, Marie
        Skłodowska-Curie, „grant agreement No …", Horizon-Projektnummern.
    *   🟨 **Keywords** – Keyword-/Schlagwörter-Abschnitte.
    *   **Institute** in ihren Hausfarben – 🔵 **Eawag**, 🔴 **Empa**,
        🟢 **WSL**, 🔷 **PSI**: Kurzform, ausgeschriebener Name (deutsch und
        englisch) und Standorte (Kastanienbaum, Birmensdorf, Villigen), bei
        der WSL auch das SLF. Abkürzungen zählen nur in Grossschreibung, und
        `50 PSI` als Druckangabe wird nicht als Institut gewertet. Diese
        Kategorien erscheinen in der Leiste nur, wenn es im Text Treffer gibt.
    *   🟥 **Eigene** – frei eingetragene Begriffe (kommagetrennt, bleiben
        gespeichert). Deckt sich ein Begriff mit einer der Kategorien oben,
        gewinnt die Kategorie – „Eawag" bleibt also Eawag-blau.
*   **Schnell-Freigabe** setzt `Quality control = Yes` samt Kürzel aus den
    Einstellungen und speichert.

---

## Configuration

Customization via the **Options** page:
1.  **Scopus API Key**: Required for Corresponding Author checks.
1.  **PDFs öffnen**: Eingebauter Betrachter (Standard) oder direkt Adobe
    Acrobat (`pdfOpenInAdobe`).
1.  **Geöffnete PDFs automatisch ablegen** (`autoDownloadPreview`, Standard
    **an**): Was in der Vorschau erscheint, landet zugleich im
    Download-Ordner – benannt nach DOI bzw. PID, ohne Speichern-Dialog, damit
    es für den Upload nach DORA bereitliegt. Im Betrachter erledigt das sonst
    der Knopf **⬇ Speichern**.
1.  **PDF-Analyse anzeigen** (`showPdfAnalysis`, Standard **aus**): Der
    ⚡-Knopf und das Ablagefeld sind derzeit aus der Ergebnisbox
    ausgeblendet. Die Analyse selbst ist unverändert vorhanden – die
    Schaltflächen werden nur verborgen und kommen mit dieser Option sofort
    zurück, ohne Neuladen.
2.  **Keyword Exceptions**: Nur noch Sonderfälle (`pattern -> replacement`) –
    die Schreibweise kommt jetzt aus DORAs Bestand und den Regeln (§6). Die
    Liste behält Vorrang, wenn beides daneben liegt.
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
