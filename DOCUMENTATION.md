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
    *   `#hybrid setzen`: Quickly adds the `#hybrid` tag to the "Additional Information" field.

---

### 2. Advanced PDF Analysis & Extraction
Extract **Page Count** and **Keywords** directly from PDFs and discover missing full-texts.

*   **Zotero-style Page Scanning**: If Unpaywall has no PDF, the assistant scans the publisher's page via meta-tags (`citation_pdf_url`) and JSON-LD to find direct links.
*   **Lightning Analysis (⚡)**: Click the lightning bolt next to any PDF link (even on publisher sites) to analyze it via our Hugging Face backend.
*   **Passive Monitor**: The assistant detects PDFs opened in other tabs or downloaded. The drop zone turns green ("⚡ PDF Detected") - click it to import immediately.
*   **Drag & Drop**: Analyze local files by dropping them into the result box.
*   **Smart Filling**: Automatically appends page counts (e.g., `(12 pp.)`) and populates the keyword manager.

---

### 3. Autocomplete for Form Fields
The assistant provides intelligent autocomplete suggestions from the DORA Solr index.

**Supported Fields:**
*   **Conference Name**: Pulls existing conferences; selecting one triggers a lookup for related proceedings and editors.
*   **Proceedings Title**, **Series Title**, **Series ISSN**, and **Publisher** (for non-journal items).

**How it works:**
*   Suggestions appear after 3 characters.
*   Uses a custom dropdown with keyboard navigation (↑/↓ to navigate, Enter to select, Escape to close).
*   Automatically refreshes with native Drupal AJAX handling.

---

### 4. Integrated Keyword Manager
Replaces the standard keyword input with a sophisticated management tool.

*   **Edit & Sort**: Click to load keywords into a draggable list.
*   **Drag & Drop**: Easily reorder keywords for the final record.
*   **Auto-Formatting**: Corrects case based on a customizable exception list (e.g., `dna -> DNA`, `ph -> pH`).
*   **Direct Sync**: Changes are instantly written back to the hidden DORA fields.

---

### 5. Smart Tags for "Additional Information"
Commonly used tags can be inserted with a single click below the "Additional Information" field.

*   **Available Tags**: `#other_journal_contribution`, `#present_address` (with name prompt), `#corporate`, `#green`, and `#CERC` (context-aware for WSL).
*   **Consistency**: Ensures tags are formatted correctly every time.

---

### 6. Real-time Validation & Error Summary
The assistant validates form fields as you type, highlighting issues with a **red border** (errors) or **dotted line** (warnings).

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
