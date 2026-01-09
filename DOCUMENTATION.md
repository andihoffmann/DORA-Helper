# DORA Lib4ri Assistant

The **DORA Lib4ri Assistant** is a browser extension designed to streamline the workflow for editing metadata in the DORA repository (Lib4ri). It provides automated metadata fetching, intelligent form validation, and a powerful keyword manager.

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

*   **Auto-Check**: If a DOI is found, the assistant fetches metadata from **Crossref** and **Unpaywall**.
*   **Result Box**: A floating panel appears on the right side displaying:
    *   **Open Access Status** (Gold, Green, Hybrid, Closed).
    *   **License Information** (e.g., CC-BY).
    *   **Version** (Published Version vs. Accepted Manuscript).
*   **Quick Actions**:
    *   `#hybrid setzen`: Adds the `#hybrid` tag to the "Additional Information" field.
    *   `PDF ansehen`: Opens the full-text PDF (if available).
    *   `Policy prüfen`: Checks the journal policy via Jisc Open Policy Finder.

> **[Screenshot: Place a screenshot here showing the floating result box with OA status and buttons]**

---

### 2. Keyword Manager
The standard keyword input in DORA can be difficult to manage. The Assistant injects a **"Keyword Manager"** directly above the keyword field.

*   **Edit & Sort**: Click the button to load existing keywords into a clean list.
*   **Drag & Drop**: Reorder keywords by dragging the handle (☰).
*   **Auto-Formatting**: Keywords are automatically corrected (e.g., "dna" &rarr; "DNA", "ph" &rarr; "pH") based on your settings.
*   **Sync**: Any changes are immediately synced back to the DORA form.

> **[Screenshot: Place a screenshot here showing the Keyword Manager with the sortable list]**

---

### 3. Real-time Validation
The assistant validates form fields as you type, highlighting errors with a **red border** and providing tooltips.

**Validation Rules:**
*   **Volume**: Must be filled if "Publication Status" is "Published".
*   **Start Page**: Must include the page count (e.g., `(12 pp.)`) if the "End Page" is empty.
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
    *   **Completeness**: If Group is filled, Laboratory and Division must also be filled.

> **[Screenshot: Place a screenshot here showing a form field with a red error border]**

---

### 4. Error Summary Panel
If validation errors are found, a summary panel appears at the **bottom right** of the screen.

*   **Overview**: Displays the total count of issues.
*   **Details**: Lists the specific errors to fix.
*   **Navigation**: Helps you find missing fields quickly.

> **[Screenshot: Place a screenshot here showing the Error Summary panel at the bottom right]**

---

## Configuration

You can customize the keyword formatting rules and update the PSI affiliation data.

1.  Open your browser's extension menu.
2.  Click **DORA Lib4ri Assistant** &rarr; **Options**.
3.  **Keyword Exceptions**: Edit the list of exceptions (Format: `lowercase -> Replacement`).
    *   *Example:* `dna -> DNA`
4.  **PSI Affiliation Data**: Upload a new `psi_data.js` file to update the historical affiliation database.

> **[Screenshot: Place a screenshot here of the Options page]**
