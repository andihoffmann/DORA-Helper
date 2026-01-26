# DORA Lib4ri Assistant

The **DORA Lib4ri Assistant** is a browser extension designed to streamline the workflow for editing metadata in the DORA repository (Lib4ri). It provides automated metadata fetching, intelligent form validation, PDF analysis, and a powerful keyword manager.

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

### 1. Metadata Auto-Fetch
When you open an edit page in DORA, the assistant automatically scans for a DOI.

*   **Auto-Check**: If a DOI is found, the assistant fetches metadata from **Crossref**, **Unpaywall**, and **Scopus**.
*   **Result Box**: A floating panel appears on the right side displaying:
    *   **Open Access Status** (Gold, Green, Hybrid, Closed).
    *   **License Information** (e.g., CC-BY).
    *   **Version** (Published Version vs. Accepted Manuscript).
    *   **Corresponding Author Check**: Validates if the corresponding author is affiliated with Eawag, Empa, PSI, or WSL (using Scopus API).
*   **Quick Actions**:
    *   `#hybrid setzen`: Adds the `#hybrid` tag to the "Additional Information" field.
    *   `PDF ansehen`: Opens the full-text PDF (if available).
    *   `Policy prüfen`: Checks the journal policy via Jisc Open Policy Finder.
    *   `Metadaten importieren`: Import metadata for book chapters (Editors, Book Title, ISBN).
*   **Minimizable Panel**: Click the header to minimize/expand the result box.
*   **Info Tags**: Additional information is displayed as colored tags (e.g., Hybrid status, Corresponding Author).

---

### 2. PDF Analysis
Extract metadata (**Page Count** and **Keywords**) directly from PDF files without manual entry.

*   **Drag & Drop**: Drop a PDF file into the designated zone at the bottom of the result box.
*   **URL Analysis**: Click the lightning bolt (⚡) icon next to a PDF link to analyze it directly via the backend service.
*   **Passive Monitor**: The assistant automatically detects PDFs opened in other tabs or downloaded. The drop zone turns green ("⚡ PDF Detected") - click it to import.
*   **Backend Service**: PDF analysis is powered by a Hugging Face Space microservice that extracts:
    *   Page count
    *   Keywords from PDF metadata and content

---

### 3. Autocomplete for Form Fields
The assistant provides intelligent autocomplete suggestions from the DORA Solr index for faster data entry.

**Supported Fields:**
*   **Conference Name** (`edit-confinfo-confname`): Native browser datalist
*   **Proceedings Title** (`edit-host-titleinfo-title`): Custom dropdown for textarea
*   **Series Title** (`edit-host-series-titleinfo-title`): Custom dropdown for textarea

**How it works:**
*   Start typing (minimum 3 characters) to see suggestions from existing DORA records.
*   For input fields: Uses native HTML5 datalist.
*   For textarea fields: Uses a custom dropdown with keyboard navigation (↑/↓ to navigate, Enter to select, Escape to close).

---

### 4. Keyword Manager
The standard keyword input in DORA can be difficult to manage. The Assistant injects a **"Keyword Manager"** directly above the keyword field.

*   **Edit & Sort**: Click the button to load existing keywords into a clean list.
*   **Drag & Drop**: Reorder keywords by dragging the handle (☰).
*   **Auto-Formatting**: Keywords are automatically corrected (e.g., "dna" → "DNA", "ph" → "pH") based on your settings.
*   **Sync**: Any changes are immediately synced back to the DORA form.

---

### 5. Real-time Validation
The assistant validates form fields as you type, highlighting errors with a **red border** and providing tooltips.

**Validation Rules:**
*   **Volume**: Must be filled if "Publication Status" is "Published".
*   **Start Page**: Must include the page count (e.g., `(12 pp.)`) if the "End Page" is empty. Required if "Publication Status" is "Published".
*   **Sentence Case**: Detects Title Case usage (capitalized words) in:
    *   Article Title
    *   Conference Name
    *   Proceedings Title
    *   Series Title
*   **Author/Affiliation**:
    *   Flags "Standardized Form of Name" if it contains "nomatch" or "4RI".
    *   Requires an Affiliation/Department if an Author Name is entered.
    *   **PSI Affiliation Check**: Validates Group, Laboratory, and Division against historical PSI data for the publication year.
        *   **Group**: Must match the historical data.
        *   **Laboratory**: Must match the historical data.
        *   **Division**: Warns if it doesn't match (dotted line), as divisions are often renamed but valid for the record.
        *   **Author Not Found**: Warns if an author is not found in the historical data (only for publications older than 3 years).
    *   **Legacy Data**: For publications before 2006, checks for "0000 PSI" in the Group field instead of requiring Lab/Division.
    *   **Completeness**: If Group is filled, Laboratory and Division must also be filled.

---

### 6. Error Summary Panel
If validation errors are found, a summary panel appears at the **bottom right** of the screen.

*   **Overview**: Displays the total count of issues.
*   **Details**: Lists the specific errors to fix.
*   **Minimizable**: Click to minimize/expand the panel.
*   **Navigation**: Helps you find missing fields quickly.

---

## Configuration

You can customize the extension via the **Options** page (Right-click extension icon → Options).

1.  **Scopus API Key**: Enter your personal API Key to enable the Corresponding Author Affiliation Check.
2.  **Keyword Exceptions**: Edit the list of exceptions (Format: `lowercase -> Replacement`).
    *   *Example:* `dna -> DNA`
3.  **PSI Affiliation Data**: Upload a new `psi_data.js` file to update the historical affiliation database.

---

## HTTP Internal Server Configuration

The extension accesses an internal Solr server for autocomplete functionality via HTTP (not HTTPS) at `http://lib-dora-prod1.emp-eaw.ch:8080`.

### Browser-Specific Configuration

#### Firefox
Firefox typically handles HTTP requests to local/internal servers well. If you encounter issues:

1. Open `about:config` in Firefox
2. Search for `security.mixed_content.block_active_content`
3. Set to `false` (only if necessary and you trust the internal network)
4. Alternatively, add the server to exceptions in Firefox settings

#### Chrome/Edge
Chrome enforces stricter mixed content policies. If autocomplete fails:

1. **Enable "Insecure content" for DORA sites**:
   - Navigate to your DORA site (e.g., `https://dora.lib4ri.ch`)
   - Click the lock icon in the address bar
   - Go to **Site settings**
   - Find **Insecure content** and set to **Allow**

2. **Disable automatic HTTPS upgrades**:
   - Go to `chrome://settings/security`
   - Scroll to **Advanced**
   - Disable **"Always use secure connections"** (or add exception for `lib-dora-prod1.emp-eaw.ch`)

3. **Network Configuration**:
   - Ensure your firewall/network allows HTTP connections to port 8080
   - Test access: Open `http://lib-dora-prod1.emp-eaw.ch:8080/solr/collection1/select?q=*:*&rows=0&wt=json` in your browser

### Troubleshooting

If autocomplete still doesn't work:

1. **Check Browser Console**:
   - Right-click on DORA page → **Inspect** → **Console** tab
   - Look for errors mentioning "Mixed Content" or "CORS"
   - Look for "DORA Helper:" prefixed messages for debugging info

2. **Check Extension Console**:
   - Go to `chrome://extensions` (or `about:debugging` in Firefox)
   - Find "DORA Lib4ri Assistant"
   - Click **"Inspect views: background page"** (Chrome) or **"Inspect"** (Firefox)
   - Check console for detailed error messages

3. **Network Access**:
   - Verify you're on the internal network where the server is accessible
   - Try accessing the Solr URL directly in your browser
   - Check if VPN or proxy settings are blocking the connection

4. **Permission Issues**:
   - Ensure the extension has the necessary permissions in browser settings
   - Try removing and reinstalling the extension

---

## Technical Notes

### Mozilla Add-on Compatibility
The extension uses secure DOM manipulation methods to comply with Mozilla's add-on policies:
*   `textContent` instead of `innerHTML` for text content
*   `replaceChildren()` for clearing elements
*   `createElement`/`appendChild` for DOM construction

### Solr Field Mapping
The autocomplete uses the following Solr fields:
*   Conference Name: `mods_name_conference_ms`
*   Proceedings Title: `mods_relatedItem_host_titleInfo_title_ms`
*   Series Title: `mods_relatedItem_host_relatedItem_series_titleInfo_title_ms`

---

## Version History

See the commit history for detailed changes.
