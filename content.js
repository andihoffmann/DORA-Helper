// content.js - Dora Lib4ri Helper
// Version: 2.48

let observerTimeout = null;
let dragSrcEl = null;
let lastAutoFetchedDoi = ""; 
let cachedExceptions = []; 
let isMouseOverHandle = false; 
let isSummaryMinimized = false; // Status für das Fehler-Panel

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
} else {
    startObserver();
}

function startObserver() {
    // Initialize PSI Data (async)
    if (typeof initPsiData === 'function') {
        initPsiData().then(() => {
            // Re-validate once data is loaded
            validateForm();
        }).catch(e => console.warn("DORA Helper: PSI Data Init failed", e));
    }

    scanAndInject();
    const observer = new MutationObserver((mutations) => {
        if (observerTimeout) clearTimeout(observerTimeout);
        observerTimeout = setTimeout(() => { scanAndInject(); }, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function scanAndInject() {
    const doiInput = document.getElementById('edit-identifiers-doi');
    if (doiInput) {
        if (!document.getElementById('dora-helper-btn')) injectDOIButton(doiInput);
        const currentDoi = doiInput.value.trim();
        if (currentDoi && currentDoi !== lastAutoFetchedDoi) {
            lastAutoFetchedDoi = currentDoi; 
            showLoadingBox();
            performFetch(currentDoi);
        }
    }
    const topicContainer = findKeywordContainer();
    if (topicContainer && !document.getElementById('dora-keyword-manager')) {
        injectKeywordManager(topicContainer);
    }
    injectTagButtons();

    validateForm();
}

function findKeywordContainer() {
    let el = document.querySelector('.form-item-topics');
    if (el) return el;
    const labels = document.querySelectorAll('label');
    for (const label of labels) {
        if (label.innerText.toLowerCase().includes('keywords') || label.innerText.toLowerCase().includes('topics')) {
            return label.closest('.form-item') || label.parentNode;
        }
    }
    const inputByName = document.querySelector('input[name^="topics"]');
    if (inputByName) return inputByName.closest('.form-item') || inputByName.parentNode.parentNode;
    return null;
}

// --- DOM HELPER (Sicherer als innerHTML) ---
function createEl(tag, className, text = null) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
}

function createFloatingBox() {
    let box = document.getElementById('dora-result-box');
    if (!box) {
        box = createEl('div', '');
        box.id = 'dora-result-box';
        document.body.appendChild(box);
    }
    // Styles
    Object.assign(box.style, {
        position: 'fixed', top: '110px', right: '20px', width: '320px', zIndex: '10000',
        backgroundColor: '#ffffff', border: '1px solid #ccc', borderLeft: '5px solid #0073e6',
        borderRadius: '5px', padding: '15px', boxShadow: '0 5px 20px rgba(0,0,0,0.15)'
    });
    return box;
}

// --- FETCHING ---
function performFetch(doi) {
    chrome.runtime.sendMessage({ action: "fetchData", doi: doi }, (response) => {
        if (response && response.success) renderResultBox(response.data);
        else renderErrorBox(response ? response.error : "Verbindungsfehler");
    });
}

function injectDOIButton(doiInput) {
    const container = createEl('div', 'dora-action-container');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.gap = '10px';
    container.id = 'dora-helper-btn'; // Keep ID for check

    const btn = createEl('button', 'dora-helper-button', '↻ Neu prüfen');
    btn.type = 'button';
    btn.addEventListener('click', () => {
        const currentDoi = doiInput.value.trim();
        if (!currentDoi) { renderErrorBox("Keine DOI im Feld gefunden."); return; }
        lastAutoFetchedDoi = currentDoi; 
        showLoadingBox();
        performFetch(currentDoi);
    });

    container.appendChild(btn);

    doiInput.parentNode.appendChild(container);
}

async function handlePdfFile(file) {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        renderErrorBox("Bitte eine PDF-Datei auswählen.");
        return;
    }

    // Show loading state in the dropzone
    const dropZone = document.querySelector('.dora-pdf-drop');
    if (dropZone) {
        dropZone.innerHTML = '⏳ Analysiere...';
        dropZone.style.backgroundColor = '#fff3cd';
    }

    // Hugging Face Space
    const API_URL = "https://andrehoffmann80-pdf-analyzer.hf.space/analyze";
    const formData = new FormData();
    formData.append("file", file);

    try {
        const response = await fetch(API_URL, {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
             throw new Error(`Server Fehler: ${response.status}`);
        }

        const data = await response.json();

        if (data.status === "success") {
            if (dropZone) {
                dropZone.innerHTML = '📄 PDF hier ablegen'; // Reset
                dropZone.style.backgroundColor = '#f9f9f9';
            }
            confirmAndFillPdfData(data, 'file');
        } else {
            throw new Error(data.message || "Unbekannter Fehler");
        }

    } catch (error) {
        if (dropZone) {
            dropZone.innerHTML = '📄 PDF hier ablegen';
            dropZone.style.backgroundColor = '#f9f9f9';
        }
        renderErrorBox("PDF Analyse fehlgeschlagen: " + error.message + "\n\n(Läuft der Docker Container auf Port 7860?)");
        console.error("PDF Analyse fehlgeschlagen:", error);
    }
}

async function handlePdfUrl(url, triggerBtn = null, localPath = null) {
    // Fallback: Try to find the standard "PDF von URL" button if no button passed
    if (!triggerBtn) {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            if (btn.innerText.includes('PDF von URL')) {
                triggerBtn = btn;
                break;
            }
        }
    }

    let originalText = '';
    if (triggerBtn) {
        originalText = triggerBtn.innerHTML;
        triggerBtn.innerHTML = '⏳ Lade...';
        triggerBtn.disabled = true;
    }

    try {
        // Strategy: Use new tab-based method for all URLs (including blob:)
        if (url && !localPath) {
            console.log('Requesting background script to fetch PDF via tab:', url);

            chrome.runtime.sendMessage({
                action: "analyzePdfViaTab",
                pdfUrl: url
            }, (response) => {
                if (triggerBtn) triggerBtn.disabled = false;
                if (response && response.success) {
                    if (triggerBtn) triggerBtn.innerHTML = originalText;
                    confirmAndFillPdfData(response.data, url.startsWith('blob:') ? 'monitor' : 'url');
                } else {
                    if (triggerBtn) {
                        triggerBtn.innerHTML = '❌ Fehler';
                        triggerBtn.title = response ? response.error : "Unbekannter Fehler";
                        setTimeout(() => {
                            triggerBtn.innerHTML = originalText;
                            triggerBtn.title = '';
                        }, 3000);
                    }
                    renderErrorBox("PDF Analyse fehlgeschlagen: " + (response ? response.error : "Unbekannter Fehler"));
                }
            });
            return;
        }

        // FALLBACK: Use old method only for localPath (downloaded files)
        chrome.runtime.sendMessage({ action: "analyzePdfUrl", pdfUrl: url, localPath: localPath }, (response) => {
            if (triggerBtn) triggerBtn.disabled = false;
            if (response && response.success) {
                if (triggerBtn) triggerBtn.innerHTML = originalText;
                confirmAndFillPdfData(response.data, 'monitor');
            } else {
                if (triggerBtn) {
                    triggerBtn.innerHTML = '❌ Fehler';
                    triggerBtn.title = response ? response.error : "Unbekannter Fehler";
                    setTimeout(() => {
                        triggerBtn.innerHTML = originalText;
                        triggerBtn.title = '';
                    }, 3000);
                }
                renderErrorBox("PDF URL Analyse fehlgeschlagen: " + (response ? response.error : "Unbekannter Fehler"));
            }
        });
    } catch (error) {
        if (triggerBtn) {
            triggerBtn.disabled = false;
            triggerBtn.innerHTML = '❌ Fehler';
            setTimeout(() => {
                triggerBtn.innerHTML = originalText;
            }, 3000);
        }
        renderErrorBox("PDF Analyse fehlgeschlagen: " + error.message);
    }
}

function confirmAndFillPdfData(data, sourceType = 'url') {
    let message = "PDF Analyse erfolgreich.\n\nMöchten Sie folgende Daten übernehmen?\n\n";

    let hasChanges = false;

    // Check Page Count
    if (data.page_count) {
        message += `- Seitenanzahl: ${data.page_count}\n`;
        hasChanges = true;
    }

    // Check Keywords
    if (data.keywords && data.keywords.length > 0) {
        message += `- ${data.keywords.length} Keywords gefunden: ${data.keywords.slice(0, 5).join(', ')}${data.keywords.length > 5 ? '...' : ''}\n`;
        hasChanges = true;
    }

    if (!hasChanges) {
        let errorMsg = "Analyse lieferte keine Daten.\n\n";
        
        if (sourceType === 'file') {
             errorMsg += "Ursache: Das PDF enthält keinen extrahierbaren Text (z.B. reiner Bild-Scan) oder ist leer.";
        } else if (sourceType === 'monitor') {
             errorMsg += "Ursache: Der Zugriff auf die heruntergeladene Datei ist fehlgeschlagen.\n";
             errorMsg += "Mögliche Gründe:\n";
             errorMsg += "1. 'Zugriff auf Datei-URLs zulassen' ist in den Erweiterungs-Einstellungen deaktiviert (Chrome).\n";
             errorMsg += "2. Der Fallback-Download wurde durch Login/Redirect blockiert.";
        } else {
             errorMsg += "Ursache: Wahrscheinlich konnte das PDF nicht direkt abgerufen werden (Login/Redirect).";
        }
        errorMsg += "\n\nLösung: Bitte PDF manuell herunterladen und per Drag & Drop analysieren.";
        renderErrorBox(errorMsg);
        return;
    }

    if (confirm(message)) {
        fillFormFromPdfData(data);
    }
}

function fillFormFromPdfData(data) {
    let msg = "Daten wurden übernommen.\n";

    // 1. Page Count
    if (data.page_count) {
        const startPageEl = document.getElementById('edit-host-part-pages-start') || document.querySelector('input[name$="[pages][start]"]');
        const endPageEl = document.getElementById('edit-host-part-pages-end') || document.querySelector('input[name$="[pages][end]"]');

        if (startPageEl && endPageEl) {
             const startVal = startPageEl.value.trim();
             const endVal = endPageEl.value.trim();

             // Only if End Page is empty
             if (!endVal) {
                 // Check if already has (XX pp.)
                 if (!startVal.includes('(')) {
                     const newVal = startVal ? `${startVal} (${data.page_count} pp.)` : `(${data.page_count} pp.)`;
                     startPageEl.value = newVal;
                     startPageEl.dispatchEvent(new Event('input', { bubbles: true }));
                     msg += `- Start Page aktualisiert: ${newVal}\n`;
                 }
             }
        }
    }

    // 2. Keywords
    if (data.keywords && data.keywords.length > 0) {
        // Add to Keyword Manager if available
        const list = document.getElementById('dora-keyword-list');
        if (list) {
            data.keywords.forEach(kw => {
                // Clean up newlines/spaces from PDF extraction
                const cleanKw = kw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
                // Check if already exists
                const exists = Array.from(list.querySelectorAll('input')).some(i => i.value.toLowerCase() === cleanKw.toLowerCase());
                if (!exists) {
                    const li = createEl('li', 'dora-keyword-item');
                    li.setAttribute('draggable', 'true');

                    const inputField = createEl('input', 'dora-keyword-input');
                    inputField.type = 'text';
                    inputField.value = cleanKw;

                    const handle = createEl('span', 'dora-drag-handle', '☰');

                    li.appendChild(inputField);
                    li.appendChild(handle);

                    // Bind events
                    const topicContainer = findKeywordContainer();
                    if (topicContainer) bindItemEvents(li, topicContainer);

                    list.appendChild(li);
                }
            });
            // Sync back
            const topicContainer = findKeywordContainer();
            if (topicContainer) {
                syncKeywordsBackToDora(topicContainer);
                msg += `- ${data.keywords.length} Keywords hinzugefügt.\n`;
            }
        } else {
             console.log("Keywords found but Manager not ready:", data.keywords);
        }
    }

    // Optional: Show success message or just rely on visual update
    // alert(msg);
}

function showLoadingBox() {
    let box = createFloatingBox();
    box.innerHTML = ''; // Clear old content
    const msg = createEl('div', '', '⏳ Metadaten werden abgerufen...');
    msg.style.cssText = 'text-align:center; color:#666; padding:20px; font-family:sans-serif;';
    box.appendChild(msg);
}

function renderErrorBox(msgText) {
    let box = createFloatingBox();
    box.innerHTML = ''; 
    box.style.borderLeft = '5px solid #e53e3e'; 
    
    const closeBtn = createEl('div', 'dora-close-btn', '×');
    closeBtn.id = 'dora-box-close';
    closeBtn.addEventListener('click', () => box.remove());
    
    const msgDiv = createEl('div', '', `❌ Fehler: ${msgText}`);
    msgDiv.style.cssText = 'color:#e53e3e; padding:10px; font-weight:bold; font-family:sans-serif; white-space: pre-wrap;';
    
    box.appendChild(closeBtn);
    box.appendChild(msgDiv);
}

// --- RESULT BOX (Secure Render) ---
function renderResultBox(data) {
    const oa = data.unpaywall;
    const meta = data.crossref;
    const openalex = data.openalex;
    let box = createFloatingBox();
    box.innerHTML = ''; // Reset

    // 1. Close Button
    const closeBtn = createEl('div', 'dora-close-btn', '×');
    closeBtn.id = 'dora-box-close';
    closeBtn.addEventListener('click', () => box.remove());
    box.appendChild(closeBtn);

    // 2. Header
    const header = createEl('div', 'dora-meta-header');

    // Title (Restored, smaller, stripped HTML)
    let titleText = meta.title ? meta.title[0] : 'Kein Titel';
    
    const title = createEl('div', 'dora-meta-title');
    // Safe decoding of HTML entities without executing scripts
    const parser = new DOMParser();
    const doc = parser.parseFromString(titleText, 'text/html');
    title.textContent = doc.body.textContent || "";

    title.style.fontSize = '0.9em'; // Reduced by ~20-30% from 1.1em
    title.style.fontWeight = 'bold';
    title.style.marginBottom = '5px';
    title.style.lineHeight = '1.3';

    const containerTitle = meta['container-title'] ? meta['container-title'][0] : '';
    const pubDate = meta.created && meta.created['date-parts'] ? meta.created['date-parts'][0][0] : '-';
    const journalInfo = `${containerTitle} (${pubDate})`;
    const journal = createEl('div', 'dora-meta-journal', journalInfo);

    header.appendChild(title);
    header.appendChild(journal);
    box.appendChild(header);

    // 3. Status Logic
    let statusText = 'Closed Access';
    let statusClass = 'badge-red';
    let isHybrid = false; 
    
    if (oa.is_oa) {
        switch (oa.oa_status) {
            case 'hybrid': statusText = 'Hybrid OA'; statusClass = 'badge-hybrid'; isHybrid = true; break;
            case 'gold': statusText = 'Gold OA'; statusClass = 'badge-gold'; break;
            case 'green': statusText = 'Green OA'; statusClass = 'badge-green'; break;
            case 'bronze': statusText = 'Bronze'; statusClass = 'badge-gold'; break;
            default: statusText = 'Open Access'; statusClass = 'badge-green';
        }
    }

    // 4. Badges Container
    const badgesDiv = createEl('div');
    badgesDiv.style.marginBottom = '10px';
    
    const statusBadge = createEl('span', `dora-badge ${statusClass}`, statusText);
    badgesDiv.appendChild(statusBadge);

    const bestLoc = oa.best_oa_location || {};
    if (bestLoc.license) {
        const licBadge = createEl('span', 'dora-badge badge-blue', bestLoc.license.toUpperCase());
        badgesDiv.appendChild(licBadge);
    }

    let versionText = '';
    if (bestLoc.version === 'publishedVersion') versionText = 'Verlags-PDF (VoR)';
    if (bestLoc.version === 'acceptedVersion') versionText = 'Manuskript (AAM)';
    if (versionText) {
        const verBadge = createEl('span', 'dora-badge badge-gray', versionText);
        badgesDiv.appendChild(verBadge);
    }
    box.appendChild(badgesDiv);

    // 5c. Parallel: Scopus Affiliation Check (Corresponding Author) - MOVED UP
    if (meta.DOI) {
        checkScopusAffiliation(meta.DOI, box);
    }

    // 5. Buttons Container
    const btnContainer = createEl('div', 'dora-btn-container');
    btnContainer.style.display = 'flex';
    btnContainer.style.flexDirection = 'column';
    btnContainer.style.gap = '8px';

    // Check if it is a Book Chapter
    const pubTypeEl = document.getElementById('edit-publication-type');
    const isBookChapter = pubTypeEl && pubTypeEl.value.toLowerCase().includes('book chapter');

    if (isBookChapter) {
        const importBtn = createEl('button', 'dora-box-btn btn-hybrid-action');
        importBtn.id = 'dora-import-book-chapter';
        
        const icon = createEl('span', '', '📚');
        icon.style.marginRight = '5px';
        importBtn.appendChild(icon);
        importBtn.appendChild(document.createTextNode(' Metadaten importieren'));
        
        importBtn.title = "Importiert Titel, Buch-Titel, Seiten, Jahr, Verlag, Autoren, Editoren und Abstract aus Crossref";
        importBtn.addEventListener('click', async () => {
            importBtn.disabled = true;
            importBtn.textContent = '⏳ Import läuft...';
            try {
                await fillBookChapterMetadata(meta);
                importBtn.textContent = '✅ Importiert!';
                setTimeout(() => {
                    importBtn.disabled = false;
                    importBtn.innerHTML = ''; // Clear
                    importBtn.appendChild(icon.cloneNode(true));
                    importBtn.appendChild(document.createTextNode(' Metadaten importieren'));
                }, 2000);
            } catch (e) {
                renderErrorBox(e.message);
                importBtn.disabled = false;
                importBtn.innerHTML = '';
                importBtn.appendChild(icon.cloneNode(true));
                importBtn.appendChild(document.createTextNode(' Metadaten importieren'));
            }
        });
        btnContainer.appendChild(importBtn);
    }

    // Hybrid Button
    if (isHybrid) {
        const hybridBtn = createEl('button', 'dora-box-btn btn-hybrid-action');
        hybridBtn.id = 'dora-add-hybrid-btn';
        hybridBtn.title = "Fügt #hybrid in Additional Information ein";
        const icon = createEl('span', '', '📝');
        icon.style.marginRight = '5px';
        hybridBtn.appendChild(icon);
        hybridBtn.appendChild(document.createTextNode(' #hybrid setzen'));
        hybridBtn.addEventListener('click', insertHybridTag);
        btnContainer.appendChild(hybridBtn);
    }

    // NEW: PDF Action Row (Zeile für PDF-Aktionen)
    const pdfActionRow = createEl('div', '', '');
    pdfActionRow.style.cssText = 'display:flex; gap:5px; align-items:center; flex-wrap:wrap;';

    // PDF Button (Unpaywall)
    const pdfUrl = bestLoc.url_for_pdf;
    if (pdfUrl) {
        const pdfBtn = createEl('a', 'dora-box-btn btn-secondary');
        pdfBtn.id = 'dora-main-pdf-btn';
        pdfBtn.href = pdfUrl;
        pdfBtn.target = '_blank';
        const icon = createEl('span', '', '📄');
        icon.style.marginRight = '5px';
        pdfBtn.appendChild(icon);
        pdfBtn.appendChild(document.createTextNode(' PDF ansehen (Unpaywall)'));
        pdfBtn.style.flex = '1';
        pdfActionRow.appendChild(pdfBtn);

        const analyzeBtn = createEl('button', 'dora-box-btn btn-secondary');
        analyzeBtn.textContent = '⚡';
        analyzeBtn.title = "Dieses PDF analysieren";
        analyzeBtn.style.width = 'auto';
        analyzeBtn.style.padding = '6px 10px';
        analyzeBtn.onclick = () => handlePdfUrl(pdfUrl, analyzeBtn);
        pdfActionRow.appendChild(analyzeBtn);
    }
    
    btnContainer.appendChild(pdfActionRow);

    // Policy Button
    const issn = meta.ISSN ? meta.ISSN[0] : null;
    if (issn) {
        const policyBtn = createEl('a', 'dora-box-btn btn-secondary');
        policyBtn.href = `https://openpolicyfinder.jisc.ac.uk/search?search=${issn}`;
        policyBtn.target = '_blank';
        const icon = createEl('span', '', '🛡️');
        icon.style.marginRight = '5px';
        policyBtn.appendChild(icon);
        policyBtn.appendChild(document.createTextNode(' Policy prüfen'));
        btnContainer.appendChild(policyBtn);
    }

    // DOI Link
    const doiLink = createEl('a', 'dora-box-link', '🔗 Zum Artikel (Verlagsseite)');
    doiLink.href = `https://doi.org/${meta.DOI}`;
    doiLink.target = '_blank';
    doiLink.style.display = 'block';
    doiLink.style.marginTop = '5px';
    doiLink.style.textAlign = 'center';
    doiLink.style.fontSize = '0.9em';
    doiLink.style.color = '#666';
    btnContainer.appendChild(doiLink);

    box.appendChild(btnContainer);

    // 5b. Parallel: Deep Scan on Publisher Site (Zotero/Meta-Tags)
    if (meta.DOI) {
        findPublisherPdf(meta.DOI, pdfActionRow, pdfUrl);
    }

    // 6. PDF Drop Zone (Moved to bottom of result box)
    const dropZone = createEl('div', 'dora-pdf-drop', '📄 PDF hier ablegen oder öffnen');
    dropZone.style.cssText = 'border: 2px dashed #ccc; padding: 10px; border-radius: 4px; cursor: pointer; color: #666; font-size: 0.9em; background: #f9f9f9; margin-top: 10px; text-align: center; transition: all 0.2s;';

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#0073e6';
        dropZone.style.backgroundColor = '#e6f7ff';
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#ccc';
        dropZone.style.backgroundColor = '#f9f9f9';
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#ccc';
        dropZone.style.backgroundColor = '#f9f9f9';

        if (e.dataTransfer.files.length > 0) {
            handlePdfFile(e.dataTransfer.files[0]);
        }
    });

    dropZone.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf';
        input.onchange = (e) => {
            if (e.target.files.length > 0) handlePdfFile(e.target.files[0]);
        };
        input.click();
    });

    // Register for passive monitoring
    chrome.runtime.sendMessage({ action: "registerDoraTab" });

    box.appendChild(dropZone);
}

async function addMissingRows(containerSelector, requiredCount) {
    const container = document.querySelector(containerSelector + ' .islandora-form-fieldpanel-panel');
    if (!container) return;

    const addButton = container.querySelector('.fieldpanel-add.form-submit');
    if (!addButton) {
        console.warn('DORA Helper: Could not find the "Add" button in ' + containerSelector);
        return;
    }

    let existingRows = container.querySelectorAll('.islandora-form-fieldpanel-pane').length;
    const rowsToAdd = requiredCount - existingRows;

    if (rowsToAdd <= 0) {
        return; // No rows needed
    }

    for (let i = 0; i < rowsToAdd; i++) {
        existingRows = container.querySelectorAll('.islandora-form-fieldpanel-pane').length; // update count

        // Trigger mousedown instead of click, as Drupal AJAX often binds to mousedown
        addButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));

        // Wait for the new row to be added
        await new Promise(resolve => {
            const observer = new MutationObserver((mutations, obs) => {
                const newRowCount = container.querySelectorAll('.islandora-form-fieldpanel-pane').length;
                if (newRowCount > existingRows) {
                    obs.disconnect(); // Clean up the observer
                    resolve();
                }
            });
            observer.observe(container, { childList: true });

            // Add a timeout to prevent infinite waiting
            setTimeout(() => {
                observer.disconnect();
                resolve(); // Resolve anyway to avoid getting stuck
            }, 3000); // 3-second timeout
        });
    }
}

async function fillBookChapterMetadata(meta) {
    if (!meta) throw new Error("Keine Metadaten verfügbar.");

    // 7. Authors - Add rows first
    if (meta.author && meta.author.length > 0) {
        await addMissingRows('.form-item-authors', meta.author.length);
    }

    // 8. Editors - Add rows first (if editors exist in metadata)
    if (meta.editor && meta.editor.length > 0) {
        await addMissingRows('.form-item-host-editor', meta.editor.length);
    }

    // 1. Article Title (Chapter Title)
    const titleEl = document.getElementById('edit-titleinfo-title-text-format-value'); // CKEditor field
    if (titleEl && meta.title && meta.title[0]) {
        // Check if CKEditor is active
        const cke = document.getElementById('cke_edit-titleinfo-title-text-format-value');
        if (cke) {
             const iframe = cke.querySelector('iframe');
             if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
                 iframe.contentDocument.body.innerHTML = meta.title[0];
             }
        } else {
            titleEl.value = meta.title[0];
        }
    }

    // 2. Host Title (Book Title)
    const hostTitleEl = document.getElementById('edit-host-booktitle'); // Corrected ID from HTML
    if (hostTitleEl && meta['container-title'] && meta['container-title'][0]) {
        hostTitleEl.value = meta['container-title'][0];
    }

    // 3. Pages (Start & End)
    if (meta.page) {
        const parts = meta.page.split('-');
        const startEl = document.getElementById('edit-host-part-pages-start'); // Corrected ID from HTML
        const endEl = document.getElementById('edit-host-part-pages-end');     // Corrected ID from HTML

        if (startEl && parts[0]) startEl.value = parts[0];
        if (endEl && parts[1]) endEl.value = parts[1];
    }

    // 4. Publication Year
    if (meta.published && meta.published['date-parts']) {
        const year = meta.published['date-parts'][0][0];
        const dateEl = document.getElementById('edit-origininfodate-0-dateissued'); // Corrected ID from HTML
        if (dateEl) dateEl.value = year;
    }

    // 5. Publisher
    if (meta.publisher) {
        const pubEl = document.getElementById('edit-host-origininfo1-0-publisher'); // Corrected ID from HTML
        if (pubEl) pubEl.value = meta.publisher;
    }

    // 6. ISBN
    if (meta.ISBN && meta.ISBN.length > 0) {
        const isbnEl = document.getElementById('edit-identifiers-isbn');
        if (isbnEl) isbnEl.value = meta.ISBN[0];
    }

    // 7. Authors - Fill data
    if (meta.author && meta.author.length > 0) {
        const authorContainer = document.querySelector('.form-item-authors .islandora-form-fieldpanel-panel');
        if (authorContainer) {
            const authorPanes = authorContainer.querySelectorAll('.islandora-form-fieldpanel-pane');
            meta.author.forEach((auth, idx) => {
                if (authorPanes[idx]) {
                    const pane = authorPanes[idx];
                    const familyEl = pane.querySelector('input[name$="[family]"]');
                    const givenEl = pane.querySelector('input[name$="[given]"]');

                    if (familyEl) familyEl.value = auth.family || '';
                    if (givenEl) givenEl.value = auth.given || '';
                }
            });
        }
    }

    // 8. Editors - Fill data
    if (meta.editor && meta.editor.length > 0) {
        const editorContainer = document.querySelector('.form-item-host-editor .islandora-form-fieldpanel-panel');
        if (editorContainer) {
            const editorPanes = editorContainer.querySelectorAll('.islandora-form-fieldpanel-pane');
            meta.editor.forEach((ed, idx) => {
                if (editorPanes[idx]) {
                    const pane = editorPanes[idx];
                    // Note: Editor fields often have slightly different names, e.g. familyEditor vs family
                    // Based on your HTML: name="host[editor][0][familyEditor]"
                    const familyEl = pane.querySelector('input[name$="[familyEditor]"]');
                    const givenEl = pane.querySelector('input[name$="[givenEditor]"]');

                    if (familyEl) familyEl.value = ed.family || '';
                    if (givenEl) givenEl.value = ed.given || '';
                }
            });
        }
    }

    // 9. Series Title
    const seriesTitleEl = document.getElementById('edit-host-series-titleinfo-title');
    if (seriesTitleEl && meta['container-title'] && meta['container-title'].length > 1) {
         // Assume the second one is the series title if available
         seriesTitleEl.value = meta['container-title'][1];
    }

    // 10. Abstract
    const abstractEl = document.getElementById('edit-abstract0-abstract-text-format-value');
    if (abstractEl && meta.abstract) {
        // Crossref abstract is often XML/HTML (e.g. <jats:p>...</jats:p>)
        // We should strip tags or clean it up if necessary, but CKEditor might handle it.
        // Let's try to strip basic JATS tags if present.
        let cleanAbstract = meta.abstract.replace(/<jats:p>/g, '').replace(/<\/jats:p>/g, '\n\n').replace(/<[^>]+>/g, '');

        // Check if CKEditor is active
        const cke = document.getElementById('cke_edit-abstract0-abstract-text-format-value');
        if (cke) {
             const iframe = cke.querySelector('iframe');
             if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
                 iframe.contentDocument.body.innerHTML = cleanAbstract.trim();
             }
        } else {
            abstractEl.value = cleanAbstract.trim();
        }
    }

    // Success is handled by the caller (button UI update)
}

function insertHybridTag() {
    let noteField = document.getElementById('edit-notes');
    if (!noteField) {
        const labels = document.querySelectorAll('label');
        for (const label of labels) {
            if (label.innerText.includes('Additional Information')) {
                const id = label.getAttribute('for');
                if (id) noteField = document.getElementById(id); break;
            }
        }
    }
    if (noteField) {
        const currentVal = noteField.value;
        if (!currentVal.includes('#hybrid')) {
            const newVal = currentVal ? currentVal.trim() + " #hybrid" : "#hybrid";
            noteField.value = newVal;
            noteField.dispatchEvent(new Event('input', { bubbles: true }));
            noteField.dispatchEvent(new Event('change', { bubbles: true }));
        }
        noteField.focus();
        noteField.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else { alert("Feld 'Additional Information' nicht gefunden."); }
}

// --- KEYWORD MANAGER (Secure) ---
function injectKeywordManager(topicContainer) {
    const toolHeader = createEl('div');
    toolHeader.id = 'dora-keyword-manager';
    
    // Header Row
    const headRow = createEl('div');
    headRow.style.cssText = "display:flex; justify-content:space-between; align-items:center;";
    
    const title = createEl('strong', '', '⚡ Keyword Manager');
    const sortBtn = createEl('button', 'dora-helper-button', 'Edit & Sort');
    sortBtn.id = 'dora-enable-sort';
    sortBtn.type = 'button';
    sortBtn.style.cssText = "padding:2px 8px; font-size:0.8em;";
    
    headRow.appendChild(title);
    headRow.appendChild(sortBtn);
    toolHeader.appendChild(headRow);

    // List
    const ul = createEl('ul');
    ul.id = 'dora-keyword-list';
    toolHeader.appendChild(ul);

    // Hint
    const hint = createEl('div', '', '');
    hint.id = 'dora-drag-hint';
    hint.style.cssText = "display:none; font-size:0.8em; color:#666; margin-top:5px;";
    hint.appendChild(document.createTextNode('📝 Bearbeiten möglich. '));
    const b = createEl('b', '', '☰ Griff ziehen');
    hint.appendChild(b);
    hint.appendChild(document.createTextNode(' zum Sortieren.'));
    toolHeader.appendChild(hint);

    const tagList = topicContainer.querySelector('.tag-list') || topicContainer.querySelector('.xml-form-elements-tags') || topicContainer.querySelector('div[class*="tags"]');
    if (tagList) tagList.insertAdjacentElement('beforebegin', toolHeader);
    else topicContainer.appendChild(toolHeader);
        
    sortBtn.addEventListener('click', () => loadKeywordsIntoManager(topicContainer));
}

function loadKeywordsIntoManager(topicContainer) {
    const list = document.getElementById('dora-keyword-list');
    list.innerHTML = ''; 
    const loading = createEl('li', '', 'Lade Einstellungen...');
    loading.style.cssText = 'padding:10px; color:#666;';
    list.appendChild(loading);
    
    document.getElementById('dora-drag-hint').style.display = 'block';

    loadExceptionsFromStorage(() => {
        list.innerHTML = ''; 
        const hiddenInputs = topicContainer.querySelectorAll('input[type="hidden"].form-tag, input[name^="topics"].form-tag');
        
        hiddenInputs.forEach((input) => {
            if(!input.value) return;
            const formattedValue = formatKeyword(input.value);
            const li = createEl('li', 'dora-keyword-item');
            li.setAttribute('draggable', 'true'); 
            
            // Input
            const inputField = createEl('input', 'dora-keyword-input');
            inputField.type = 'text';
            inputField.value = formattedValue;
            
            // Handle
            const handle = createEl('span', 'dora-drag-handle', '☰');
            handle.title = "Ziehen zum Sortieren";
            
            li.appendChild(inputField);
            li.appendChild(handle);
            
            bindItemEvents(li, topicContainer);
            list.appendChild(li);
        });
        topicContainer.classList.add('original-keywords-hidden');
        syncKeywordsBackToDora(topicContainer);
    });
}

function bindItemEvents(liItem, topicContainer) {
    const handle = liItem.querySelector('.dora-drag-handle');
    const input = liItem.querySelector('input');

    handle.addEventListener('mouseenter', () => { isMouseOverHandle = true; });
    handle.addEventListener('mouseleave', () => { isMouseOverHandle = false; });
    input.addEventListener('mouseenter', () => { isMouseOverHandle = false; });
    input.addEventListener('input', () => syncKeywordsBackToDora(topicContainer));
    input.addEventListener('mousedown', (e) => e.stopPropagation());

    liItem.addEventListener('dragstart', function(e) {
        if (!isMouseOverHandle) { e.preventDefault(); return false; }
        dragSrcEl = this;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', ''); 
        this.classList.add('is-dragging'); 
    });

    liItem.addEventListener('dragend', function() {
        this.classList.remove('is-dragging');
        document.querySelectorAll('.dora-keyword-item').forEach(col => {
            col.classList.remove('drop-target-top', 'drop-target-bottom');
        });
    });

    liItem.addEventListener('dragover', function(e) {
        if (e.preventDefault) e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (this === dragSrcEl) return; 

        const rect = this.getBoundingClientRect();
        const relY = (e.clientY - rect.top) / rect.height;

        document.querySelectorAll('.dora-keyword-item').forEach(el => {
            if(el !== this) el.classList.remove('drop-target-top', 'drop-target-bottom');
        });

        if (relY < 0.5) {
            this.classList.add('drop-target-top');
            this.classList.remove('drop-target-bottom');
        } else {
            this.classList.add('drop-target-bottom');
            this.classList.remove('drop-target-top');
        }
        return false;
    });

    liItem.addEventListener('dragleave', function(e) {
        if (this.contains(e.relatedTarget)) return;
        this.classList.remove('drop-target-top', 'drop-target-bottom');
    });

    liItem.addEventListener('drop', function(e) {
        if (e.stopPropagation) e.stopPropagation();
        this.classList.remove('drop-target-top', 'drop-target-bottom');

        if (dragSrcEl !== this) {
            const rect = this.getBoundingClientRect();
            const relY = (e.clientY - rect.top) / rect.height;
            if (relY < 0.5) this.parentNode.insertBefore(dragSrcEl, this);
            else this.parentNode.insertBefore(dragSrcEl, this.nextSibling);
            syncKeywordsBackToDora(topicContainer);
        }
        return false;
    });
}

function syncKeywordsBackToDora(topicContainer) {
    const newValues = [];
    document.querySelectorAll('#dora-keyword-list li input').forEach(input => {
        newValues.push(input.value);
    });
    const hiddenInputs = topicContainer.querySelectorAll('input[type="hidden"].form-tag');
    const visibleSpans = topicContainer.querySelectorAll('.tag-list > span, .xml-form-elements-tags > span');
    for (let i = 0; i < hiddenInputs.length; i++) {
        if (newValues[i] !== undefined) {
            hiddenInputs[i].value = newValues[i];
            if (visibleSpans[i]) {
                visibleSpans[i].title = newValues[i];
                const textSpan = visibleSpans[i].querySelector('.edit-tag');
                if (textSpan) textSpan.innerText = newValues[i];
            }
        }
    }
}

// --- TAG BUTTONS FOR ADDITIONAL INFORMATION ---
function injectTagButtons() {
    // Suche nach dem Additional Information Textarea
    let addInfoArea = document.querySelector('textarea[name*="additional_information"]');
    
    // Fallback: Suche über Label
    if (!addInfoArea) {
        const labels = Array.from(document.querySelectorAll('label'));
        const targetLabel = labels.find(l => l.innerText.includes('Additional Information') || l.innerText.includes('Additional information'));
        if (targetLabel) {
            const id = targetLabel.getAttribute('for');
            if (id) addInfoArea = document.getElementById(id);
        }
    }

    if (!addInfoArea || addInfoArea.dataset.hasTagButtons) return;
    addInfoArea.dataset.hasTagButtons = "true";

    const container = createEl('div');
    container.style.cssText = 'display:flex; gap:5px; flex-wrap:wrap; margin-top:5px;';

    // Check context (WSL only for #CERC)
    const isWSL = window.location.href.toLowerCase().includes('/wsl');

    const tags = [
        { label: '#other_journal_contribution', title: 'Editorials, Letters, Introductions, Commentary, Book Reviews, etc. (nur Journal Articles). Bei Unsicherheiten lieber taggen! Short communication nicht taggen.' },
        { label: '#present_address', title: 'Keine 4RI-Affiliation, aber "Present address" vorhanden. Bitte mit Initialen und Nachnamen angeben.', prompt: true },
        { label: '#corporate', title: 'Unter den Autoren befindet sich eine Körperschaft.' },
        { label: '#green', title: 'Artikel darf gemäss Policy des Verlags in der Published Version Open Access gemacht werden; ggfs. ist ein Embargo einzuhalten; Tag wird nur von JHB verwendet.', customStyle: 'background-color: #f0fff4; border-color: #c6f6d5; color: #22543d;' },
        { label: '#CERC', title: 'CERC-Publikationen (ab 2021). Journal Articles (ab 2022) nur wenn Affiliation auf Paper. Auch bei Meldung durch Autor/Admin (Notiz in Lib4RI-Notes).', show: isWSL }
    ];

    tags.forEach(tag => {
        if (tag.hasOwnProperty('show') && !tag.show) return;

        const btn = createEl('button', 'dora-box-btn btn-secondary');
        btn.innerText = tag.label;
        btn.title = tag.title;
        let baseStyle = 'padding: 2px 8px; font-size: 0.85em; background: #e2e8f0; border: 1px solid #cbd5e0; border-radius: 3px; cursor: pointer; color: #2d3748; width: auto;';
        if (tag.customStyle) baseStyle += tag.customStyle;
        btn.style.cssText = baseStyle;
        
        btn.onclick = (e) => {
            e.preventDefault();
            let valueToInsert = tag.label;
            
            if (tag.prompt) {
                const name = prompt('Bitte Initialen und Nachnamen eingeben (z.B. A.B. Dennis):');
                if (!name) return;
                valueToInsert = `${tag.label}: ${name}`;
            }

            insertAtCursor(addInfoArea, valueToInsert);
            addInfoArea.dispatchEvent(new Event('input', { bubbles: true }));
            addInfoArea.dispatchEvent(new Event('change', { bubbles: true }));
        };
        container.appendChild(btn);
    });

    addInfoArea.parentNode.appendChild(container);
}

function insertAtCursor(myField, myValue) {
    if (myField.selectionStart || myField.selectionStart == '0') {
        var startPos = myField.selectionStart;
        var endPos = myField.selectionEnd;
        
        let prefix = "";
        if (startPos > 0 && myField.value[startPos-1] !== ' ' && myField.value[startPos-1] !== '\n') {
            prefix = " ";
        }
        
        myField.value = myField.value.substring(0, startPos)
            + prefix + myValue
            + myField.value.substring(endPos, myField.value.length);
            
        myField.selectionStart = startPos + myValue.length + prefix.length;
        myField.selectionEnd = startPos + myValue.length + prefix.length;
        myField.focus();
    } else {
        myField.value += (myField.value.length > 0 ? " " : "") + myValue;
    }
}

function loadExceptionsFromStorage(callback) {
    chrome.storage.sync.get({
        exceptionList: `x-ray -> X-ray\nx-rays -> X-rays\ndna -> DNA\nrna -> RNA\nph -> pH\nnmr -> NMR\nhplc -> HPLC\nuv -> UV\nir -> IR\npcr -> PCR\ntem -> TEM\nsem -> SEM\nafm -> AFM\nxps -> XPS\nswitzerland -> Switzerland\nzurich -> Zurich`
    }, function(items) {
        cachedExceptions = [];
        const lines = items.exceptionList.split('\n');
        lines.forEach(line => {
            if (!line.includes('->')) return;
            const parts = line.split('->');
            const pat = parts[0].trim();
            const rep = parts[1].trim();
            if (pat && rep) {
                const esc = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                try { cachedExceptions.push({ regex: new RegExp('\\b' + esc + '\\b', 'gi'), replacement: rep }); } catch (e) { }
            }
        });
        if (callback) callback();
    });
}

function formatKeyword(text) {
    if (!text) return "";
    let out = text.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').toLowerCase().trim();
    cachedExceptions.forEach(ex => { out = out.replace(ex.regex, ex.replacement); });
    return out;
}

// --- PUBLISHER PAGE SCANNER (Zotero-style) ---
function findPublisherPdf(doi, rowContainer, existingPdfUrl) {
    const url = `https://doi.org/${doi}`;
    
    // Wir senden eine Nachricht an den Background-Worker, um HTML zu fetchen (CORS-Bypass)
    // Hinweis: Ihr Background-Script muss auf { action: "fetchHtml", url: ... } reagieren
    // und { success: true, data: "<html>..." } zurückgeben.
    chrome.runtime.sendMessage({ action: "fetchHtml", url: url }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
            // Still fail silently, as this is an enhancement
            return;
        }

        const htmlContent = response.data;
        const finalUrl = response.finalUrl || url; // URL nach Redirects (wichtig für relative Links)
        const foundPdfUrl = extractPdfFromHtml(htmlContent, finalUrl);

        if (foundPdfUrl && foundPdfUrl !== existingPdfUrl) {
            // Wir haben einen besseren/anderen Link gefunden!
            
            // Prüfen ob wir schon einen Haupt-Button haben
            const mainBtn = document.getElementById('dora-main-pdf-btn');
            
            if (mainBtn) {
                // Update existing button
                mainBtn.href = foundPdfUrl;
                mainBtn.innerHTML = '';
                const icon = createEl('span', '', '📄');
                icon.style.marginRight = '5px';
                mainBtn.appendChild(icon);
                mainBtn.appendChild(document.createTextNode(' PDF (Verlag)'));
                mainBtn.title = "Direkter Link via Verlags-Metadaten gefunden";
                mainBtn.style.border = "1px solid #2b6cb0";
                mainBtn.style.color = "#2b6cb0";
                
                // Update the analyze action next to it
                const analyzeBtn = rowContainer.querySelector('button');
                if (analyzeBtn) {
                    analyzeBtn.onclick = () => handlePdfUrl(foundPdfUrl, analyzeBtn, null);
                }
            } else {
                // Create new if none existed
                const pubPdfBtn = createEl('a', 'dora-box-btn btn-secondary');
                pubPdfBtn.id = 'dora-main-pdf-btn';
                pubPdfBtn.href = foundPdfUrl;
                pubPdfBtn.target = '_blank';
                const icon = createEl('span', '', '📄');
                icon.style.marginRight = '5px';
                pubPdfBtn.appendChild(icon);
                pubPdfBtn.appendChild(document.createTextNode(' PDF (Verlag)'));
                pubPdfBtn.style.flex = '1';
                
                const analyzeBtn = createEl('button', 'dora-box-btn btn-secondary');
                analyzeBtn.textContent = '⚡';
                analyzeBtn.title = "Dieses Verlags-PDF analysieren";
                analyzeBtn.style.width = 'auto';
                analyzeBtn.style.padding = '6px 10px';
                analyzeBtn.onclick = () => handlePdfUrl(foundPdfUrl, analyzeBtn, null);

                rowContainer.appendChild(pubPdfBtn);
                rowContainer.appendChild(analyzeBtn);
            }
        }
    });
}

function extractPdfFromHtml(html, baseUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    
    // Helper um relative URLs aufzulösen
    const resolveUrl = (href) => {
        try { return new URL(href, baseUrl).href; } catch (e) { return href; }
    };

    // --- STRATEGIE 1: Highwire Press Tags (Der "Gold Standard" für Zotero) ---
    // Wird von fast allen großen Verlagen genutzt (Elsevier, Springer, Wiley, Taylor&Francis)
    const citationPdf = doc.querySelector('meta[name="citation_pdf_url"]');
    if (citationPdf && citationPdf.content) {
        return resolveUrl(citationPdf.content);
    }

    // --- STRATEGIE 2: JSON-LD (Schema.org) ---
    // Modernes Format, das oft versteckte PDF-Links in "encoding" oder "distribution" enthält
    const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const script of jsonLdScripts) {
        try {
            const json = JSON.parse(script.textContent);
            // Wir suchen nach Objekten, die ScholarlyArticle sind oder encoding haben
            const objects = Array.isArray(json) ? json : [json];
            
            for (const obj of objects) {
                // Suche nach "encoding" (oft bei Springer/Nature)
                if (obj.encoding) {
                    const encodings = Array.isArray(obj.encoding) ? obj.encoding : [obj.encoding];
                    for (const enc of encodings) {
                        if (enc.encodingFormat === 'application/pdf' && enc.contentUrl) {
                            return resolveUrl(enc.contentUrl);
                        }
                    }
                }
                // Suche nach "distribution"
                if (obj.distribution) {
                    const dists = Array.isArray(obj.distribution) ? obj.distribution : [obj.distribution];
                    for (const dist of dists) {
                        if ((dist.encodingFormat === 'application/pdf' || dist.fileFormat === 'application/pdf') && dist.contentUrl) {
                            return resolveUrl(dist.contentUrl);
                        }
                    }
                }
            }
        } catch (e) { /* Ignore JSON parse errors */ }
    }

    // --- STRATEGIE 3: Eprints & Bepress Tags (Repositories) ---
    const eprintsPdf = doc.querySelector('meta[name="eprints.document_url"]');
    if (eprintsPdf && eprintsPdf.content) {
        return resolveUrl(eprintsPdf.content);
    }

    const bepressPdf = doc.querySelector('meta[name="bepress_citation_pdf_url"]');
    if (bepressPdf && bepressPdf.content) {
        return resolveUrl(bepressPdf.content);
    }

    // --- STRATEGIE 4: Dublin Core (Fallback) ---
    const dcId = doc.querySelector('meta[name="DC.identifier"]');
    if (dcId && dcId.content && dcId.content.toLowerCase().endsWith('.pdf')) {
        return resolveUrl(dcId.content);
    }

    // --- STRATEGIE 5: COinS (ContextObjects in Spans) ---
    // Zotero nutzt dies oft als Fallback. Wir suchen im title-Attribut nach rft_id, die auf pdf endet.
    const coins = doc.querySelectorAll('span.Z3988');
    for (const coin of coins) {
        const title = coin.getAttribute('title');
        if (title && title.includes('rft_id=')) {
            const matches = title.match(/rft_id=([^&]+)/);
            if (matches && matches[1]) {
                const decoded = decodeURIComponent(matches[1]);
                if (decoded.toLowerCase().endsWith('.pdf')) return resolveUrl(decoded);
            }
        }
    }

    // --- STRATEGIE 6: Heuristik (Intelligente Link-Suche) ---
    // Wenn alles andere fehlschlägt, suchen wir nach echten Links im DOM
    const anchorTags = Array.from(doc.querySelectorAll('a'));
    for (const a of anchorTags) {
        const href = a.getAttribute('href');
        if (!href) continue;
        
        const hrefLower = href.toLowerCase();
        const textLower = a.innerText.toLowerCase();
        const titleLower = (a.getAttribute('title') || '').toLowerCase();
        const classLower = (a.getAttribute('class') || '').toLowerCase();

        // Muss auf .pdf enden ODER explizit "pdf" im Text/Klasse haben UND "download" oder "view" implizieren
        const looksLikePdf = hrefLower.endsWith('.pdf') || hrefLower.includes('/pdf/');
        const isPdfButton = textLower.includes('pdf') || classLower.includes('pdf') || titleLower.includes('pdf');
        
        // Filter: Vermeide "Help with PDF" oder "About PDF" Links
        const isHelpLink = textLower.includes('help') || textLower.includes('reader');

        if (looksLikePdf && isPdfButton && !isHelpLink) {
            return resolveUrl(href);
        }
    }

    return null;
}

function checkScopusAffiliation(doi, container) {
    const statusDiv = createEl('div', 'dora-affiliation-status', '');
    const icon = createEl('span', '', '✉️');
    icon.style.cssText = 'font-size: 1.2em; margin-right: 4px;';
    statusDiv.appendChild(icon);
    statusDiv.appendChild(document.createTextNode(' ⏳ Scopus...'));
    statusDiv.style.cssText = 'margin-bottom: 10px; font-size: 0.8em; color: #666; padding: 3px 8px; background: #f8f9fa; border-radius: 4px; border: 1px solid #eee; width: fit-content; display: flex; align-items: center;';
    container.appendChild(statusDiv);

    chrome.runtime.sendMessage({ action: "checkScopus", doi: doi }, (response) => {
        if (response && response.success) {
            const data = response.data;
            if (data.isLib4Ri) {
                let displayAffil = data.affiliation;
                if (displayAffil.length > 35) displayAffil = displayAffil.substring(0, 32) + '...';
                statusDiv.innerHTML = ''; // Clear
                statusDiv.appendChild(icon.cloneNode(true));
                statusDiv.appendChild(document.createTextNode(' ✅ '));
                const b = createEl('b', '', 'Scopus: ');
                statusDiv.appendChild(b);
                statusDiv.appendChild(document.createTextNode(displayAffil));
                statusDiv.title = "Corresponding Author ist Lib4Ri affiliiert: " + data.affiliation;
                statusDiv.style.backgroundColor = '#f0fff4';
                statusDiv.style.borderColor = '#c6f6d5';
                statusDiv.style.color = '#22543d';
            } else {
                statusDiv.innerHTML = ''; // Clear
                statusDiv.appendChild(icon.cloneNode(true));
                const b = createEl('b', '', 'Scopus: ');
                statusDiv.appendChild(b);
                statusDiv.appendChild(document.createTextNode(' Extern'));
                statusDiv.title = "Keine Lib4Ri-Affiliation gefunden. Gefunden: " + (data.affiliation || "Keine Daten");
                statusDiv.style.backgroundColor = '#fffaf0';
                statusDiv.style.borderColor = '#fbd38d';
                statusDiv.style.color = '#9c4221';
            }
        } else {
            statusDiv.style.display = 'none'; // Optional: Ausblenden bei Fehler
        }
    });
}

// --- LISTENERS ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "pdfDetected") {
        // Statt Button zu ändern, nutzen wir die Dropzone als Benachrichtigungsfläche
        const dropZone = document.querySelector('.dora-pdf-drop');
        if (dropZone) {
            dropZone.innerHTML = '';
            dropZone.appendChild(document.createTextNode('⚡ '));
            const b = createEl('b', '', 'PDF Erkannt!');
            dropZone.appendChild(b);
            dropZone.appendChild(document.createElement('br'));
            const small = createEl('small', '', request.filename.substring(0, 25) + '...');
            dropZone.appendChild(small);
            
            dropZone.style.backgroundColor = '#e6fffa';
            dropZone.style.borderColor = '#38b2ac';
            dropZone.style.color = '#2c7a7b';
            
            // Klick auf Dropzone startet nun den Import dieses PDFs
            dropZone.onclick = (e) => {
                e.preventDefault(); // Kein File-Dialog
                dropZone.textContent = '⏳ Analysiere...';
                handlePdfUrl(request.url, null, request.localPath);
            };
        }
    }
});

// --- VALIDATION ---
function validateForm() {
    const errors = []; // Collect errors for summary

    const getField = (labelPart) => {
        const labels = document.querySelectorAll('label');
        for (const l of labels) {
            if (l.innerText.toLowerCase().includes(labelPart.toLowerCase())) {
                const id = l.getAttribute('for');
                if (id) {
                    const el = document.getElementById(id);
                    if (el) return el;
                }
                // Try finding input in the same form-item container
                const container = l.closest('.form-item') || l.parentNode;
                if (container) {
                    const input = container.querySelector('input:not([type="hidden"]), select, textarea');
                    if (input) return input;
                }
            }
        }
        return null;
    };

    const statusEl = getField('Publication Status');
    const volumeEl = getField('Volume');
    const startPageEl = getField('Start Page');
    const endPageEl = getField('End Page');
    const titleEl = getField('Article Title') || getField('Title');
    const confNameEl = getField('Conference Name');
    const procTitleEl = getField('Title of the Conference Proceedings');
    const seriesTitleEl = document.getElementById('edit-host-series-titleinfo-title');
    const pubTypeEl = document.getElementById('edit-publication-type');
    const bookTitleEl = document.getElementById('edit-host-booktitle'); // Book Title

    // Improved Year Selector: Try multiple IDs
    let pubYearEl = document.getElementById('edit-origininfodate-0-dateissued') ||
                      document.getElementById('edit-dateissued');
    if (!pubYearEl) {
         pubYearEl = document.querySelector('input[name*="dateIssued"]');
    }
    if (!pubYearEl) {
         pubYearEl = getField('Publication Year');
    }

    // Attach listeners for real-time validation
    const attachListener = (el) => {
        if (!el) return;
        if (!el.dataset.doraValidatorAttached) {
            el.addEventListener('input', validateForm);
            el.addEventListener('change', validateForm);
            el.dataset.doraValidatorAttached = "true";
        }
        // Special handling for CKEditor
        if (el.classList.contains('ckeditor-processed')) {
            const ckeId = 'cke_' + el.id;
            const cke = document.getElementById(ckeId);
            if (cke) {
                const iframe = cke.querySelector('iframe');
                if (iframe && iframe.contentDocument) {
                    if (!iframe.dataset.doraValidatorAttached) {
                        const body = iframe.contentDocument.body;
                        if (body) {
                            body.addEventListener('input', validateForm);
                            body.addEventListener('keyup', validateForm);
                            body.addEventListener('blur', validateForm);
                            iframe.dataset.doraValidatorAttached = "true";
                        }
                    }
                }
            }
        }
    };

    [statusEl, volumeEl, startPageEl, endPageEl, titleEl, confNameEl, procTitleEl, seriesTitleEl, bookTitleEl, pubYearEl].forEach(el => attachListener(el));

    // Rule 1: Volume required if Published (BUT NOT for Book Chapter)
    let isBookChapter = false;
    if (pubTypeEl && pubTypeEl.value.toLowerCase().includes('book chapter')) {
        isBookChapter = true;
    }

    if (statusEl && volumeEl && !isBookChapter) {
        let statusText = statusEl.value;
        if (statusEl.tagName === 'SELECT') {
             statusText = statusEl.options[statusEl.selectedIndex]?.text || '';
        }

        if (statusText.toLowerCase().includes('published')) {
            if (!volumeEl.value.trim()) {
                markError(volumeEl, true, 'Volume ist bei Status "Published" Pflicht.');
                errors.push('<b>Volume</b>: Pflichtfeld bei Status "Published".');
            } else {
                markError(volumeEl, false);
            }
        } else {
            markError(volumeEl, false);
        }
    } else if (volumeEl) {
        // Clear error if it was previously set but now ignored
        markError(volumeEl, false);
    }

    // Start Page Validation
    if (startPageEl) {
        const startVal = startPageEl.value.trim();
        let startPageError = null;

        // 1. Required if Published
        if (statusEl) {
             let statusText = statusEl.value;
             if (statusEl.tagName === 'SELECT') statusText = statusEl.options[statusEl.selectedIndex]?.text || '';

             if (statusText.toLowerCase().includes('published') && !startVal) {
                 startPageError = 'Start Page ist bei Status "Published" Pflicht.';
                 errors.push('<b>Start Page</b>: Pflichtfeld bei Status "Published".');
             }
        }

        // 2. Format check if End Page is empty
        if (!startPageError && startVal && endPageEl) {
            const endVal = endPageEl.value.trim();
            if (!endVal) {
                const ppPattern = /\(\d+\s*pp\.?\)/i;
                if (!ppPattern.test(startVal)) {
                    startPageError = 'Wenn End Page leer ist, muss hier die Seitenzahl stehen (z.B. "12 (5 pp.)").';
                    errors.push('<b>Start Page</b>: Format "X (Y pp.)" erforderlich wenn End Page leer.');
                }
            }
        }

        markError(startPageEl, !!startPageError, startPageError || '');
    }

    // Rule 3: Sentence Case Checks
    checkSentenceCase(titleEl, 'Article Title', errors);
    checkSentenceCase(confNameEl, 'Conference Name', errors);
    checkSentenceCase(procTitleEl, 'Proceedings Title', errors);
    checkSentenceCase(seriesTitleEl, 'Series Title', errors);
    checkSentenceCase(bookTitleEl, 'Book Title', errors);

    // Rule 4: Author Table Validation (including PSI Affiliation check)
    const pubYear = pubYearEl ? pubYearEl.value.trim() : null;
    validateAuthorRows(errors, pubYear);

    // Render Summary
    renderErrorSummary(errors);
}

function checkSentenceCase(el, label, errors) {
    if (!el) return;

    let val = el.value.trim();

    // CKEditor handling
    if (el.classList.contains('ckeditor-processed')) {
         const cke = document.getElementById('cke_' + el.id);
         if (cke) {
             const iframe = cke.querySelector('iframe');
             if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
                 const editorText = iframe.contentDocument.body.innerText.trim();
                 if (editorText) val = editorText;
             }
         }
    }

    if (val) {
        const words = val.split(/\s+/);
        if (words.length > 1) {
            const stopWords = ['And', 'Or', 'But', 'The', 'A', 'An', 'In', 'On', 'Of', 'For', 'To', 'At', 'By', 'With'];
            // Check middle words (exclude first)
            const middleWords = words.slice(1);

            // 1. Check for capitalized stop words (strong indicator of Title Case)
            const hasCapStopWord = middleWords.some(w => {
                const cleanW = w.replace(/[^\w]/g, ''); // remove punctuation
                return stopWords.includes(cleanW);
            });

            // 2. Check ratio of capitalized words (excluding ALL CAPS acronyms)
            const mixedCaseCapWords = middleWords.filter(w => /^[A-Z][a-z]+/.test(w));
            const ratio = mixedCaseCapWords.length / middleWords.length;

            if (hasCapStopWord) {
                markError(el, true, `${label} enthält großgeschriebene Stoppwörter (bitte Sentence case verwenden).`);
                errors.push(`<b>${label}</b>: Enthält großgeschriebene Stoppwörter (Sentence case verwenden).`);
            } else if (mixedCaseCapWords.length > 1 && ratio > 0.6) {
                markError(el, true, `${label} scheint Title Case zu sein (bitte Sentence case verwenden).`);
                errors.push(`<b>${label}</b>: Scheint Title Case zu sein (Sentence case verwenden).`);
            } else {
                markError(el, false);
            }
        } else {
            markError(el, false);
        }
    } else {
        markError(el, false);
    }
}

function validateAuthorRows(errors, pubYear) {
    const pYearInt = parseInt(pubYear, 10);
    const isOldPsiPub = !isNaN(pYearInt) && pYearInt < 2006;

    // 1. Specific Islandora Fieldpanel Logic
    const authorsContainer = document.querySelector('.form-item-authors');
    if (authorsContainer) {
        const panes = authorsContainer.querySelectorAll('.islandora-form-fieldpanel-pane');
        panes.forEach((pane, idx) => {
            const nameInput = pane.querySelector('input[type="text"][name$="[valName]"]');

            // Corrected selectors based on HTML structure
            const groupInput = pane.querySelector('input[type="text"][name$="[affiliation]"]'); // "Group" field
            const sectionInput = pane.querySelector('input[type="text"][name$="[section_name]"]');
            const labInput = pane.querySelector('input[type="text"][name$="[department_name]"]'); // "Laboratory" field
            const divisionInput = pane.querySelector('input[type="text"][name$="[division_name]"]');

            // Get First and Last Name for lookup
            const familyInput = pane.querySelector('input[name$="[family]"]');
            const givenInput = pane.querySelector('input[name$="[given]"]');

            if (nameInput) {
                // Attach listeners
                const inputs = [nameInput, groupInput, sectionInput, labInput, divisionInput, familyInput, givenInput];
                inputs.forEach(inp => {
                    if (inp && !inp.dataset.doraValidatorAttached) {
                        inp.addEventListener('input', validateForm);
                        inp.addEventListener('change', validateForm);
                        inp.dataset.doraValidatorAttached = "true";
                    }
                });

                const nameVal = nameInput.value.trim();

                // Rule 4a: Check Name content
                if (/nomatch/i.test(nameVal) || /4ri/i.test(nameVal)) {
                    markError(nameInput, true, 'Darf nicht "nomatch" oder "4RI" enthalten.');
                    errors.push(`<b>Author ${idx + 1} (Name)</b>: Darf nicht "nomatch" oder "4RI" enthalten.`);
                } else {
                    markError(nameInput, false);
                }
                // Rule 4b: Dependency (If name is present, at least Group or Lab should be present)
                if (nameVal) {
                    const hasAffiliation = (groupInput && groupInput.value.trim()) || (labInput && labInput.value.trim());
                    if (!hasAffiliation) {
                        // Mark Group as the primary missing field
                        if (groupInput) markError(groupInput, true, 'Affiliation (Group/Lab) ist erforderlich.');
                        errors.push(`<b>Author ${idx + 1}</b>: Affiliation fehlt.`);
                    } else {
                        if (groupInput) markError(groupInput, false);
                    }

                    // Rule 4c: Historical Affiliation Check (Only for PSI)
                    // Check if URL contains /psi/
                    if (window.location.href.includes('/psi/') && typeof findPersonAffiliation === 'function' && familyInput) {
                        const lastname = familyInput.value.trim();
                        const firstname = givenInput ? givenInput.value.trim() : "";

                        console.log(`Checking affiliation for: ${lastname}, ${firstname} (${pubYear})`);

                        const personData = findPersonAffiliation(lastname, firstname, pubYear, nameVal);
                        console.log("Person Data:", personData);

                        if (personData) {
                            if (personData.year) {
                                // Check if current deptVal matches any of the valid units
                                // Use looser matching: check if validName is contained in deptVal OR deptVal is contained in validName

                                // Check Group
                                if (groupInput) {
                                    const groupVal = groupInput.value.trim();
                                    if (groupVal && !personData.units.some(u => groupVal.includes(u) || u.includes(groupVal))) {
                                         markError(groupInput, true, `Warnung: "${groupVal}" stimmt nicht mit den Stammdaten für ${pubYear} überein.`);
                                         errors.push(`<b>Author ${idx + 1} (Group)</b>: "${groupVal}" stimmt nicht mit den Stammdaten für ${pubYear} überein. <br>Erwartet: ${personData.expectedGroup || 'N/A'}`);
                                    } else {
                                         markError(groupInput, false);
                                    }
                                }

                                // Check Laboratory
                                if (labInput) {
                                    const labVal = labInput.value.trim();
                                    if (labVal && !personData.units.some(u => labVal.includes(u) || u.includes(labVal))) {
                                         markError(labInput, true, `Warnung: "${labVal}" stimmt nicht mit den Stammdaten für ${pubYear} überein.`);
                                         errors.push(`<b>Author ${idx + 1} (Lab)</b>: "${labVal}" stimmt nicht mit den Stammdaten für ${pubYear} überein. <br>Erwartet: ${personData.expectedLab || 'N/A'}`);
                                    } else {
                                         markError(labInput, false);
                                    }
                                }

                                // Check Division
                                if (divisionInput) {
                                    const divVal = divisionInput.value.trim();
                                    if (divVal && !personData.units.some(u => divVal.includes(u) || u.includes(divVal))) {
                                         markError(divisionInput, true, `Warnung: "${divVal}" stimmt nicht mit den Stammdaten für ${pubYear} überein.`, true);
                                         errors.push(`<b>Author ${idx + 1} (Division)</b>: Die Division wurde wahrscheinlich mitllerweile angepasst, hat aber Gültigkeit für den Eintrag.`);
                                    } else {
                                         markError(divisionInput, false);
                                    }
                                }

                            } else {
                                // Person found but not for this year
                                console.log("Person found but not for year " + pubYear);
                                if (groupInput) markError(groupInput, false);
                                if (labInput) markError(labInput, false);
                                if (divisionInput) markError(divisionInput, false);
                            }
                        } else {
                            // Person not found in DB
                            console.log("Person not found in DB");

                            const currentYear = new Date().getFullYear();
                            const pYear = parseInt(pubYear, 10);

                            if (!isNaN(pYear) && pYear >= 2006 && (currentYear - pYear >= 3)) {
                                errors.push(`<b>Author ${idx + 1}</b>: Person "${lastname}, ${firstname}" nicht in den Stammdaten gefunden.`);
                            }
                            if (groupInput) markError(groupInput, false);
                            if (labInput) markError(labInput, false);
                            if (divisionInput) markError(divisionInput, false);
                        }
                    } else {
                        if (groupInput) markError(groupInput, false);
                        if (labInput) markError(labInput, false);
                        if (divisionInput) markError(divisionInput, false);
                    }

                    // Rule 4d: Completeness (If Group is set, Lab and Division should be set)
                    if (groupInput && groupInput.value.trim()) {
                        if (isOldPsiPub) {
                            const groupVal = groupInput.value.trim();
                            if (!groupVal.includes('0000 PSI')) {
                                markError(groupInput, true, 'Für Publikationen vor 2006 wird "0000 PSI" erwartet.');
                                errors.push(`<b>Author ${idx + 1} (Group)</b>: Für Publikationen vor 2006 wird "0000 PSI" erwartet.`);
                            }
                        } else {
                            const groupVal = groupInput.value.trim();
                            // Special Rule: Division Heads (e.g. 1000-9000) don't need a Lab
                            const isSpecialGroup = /^[1-9]000/.test(groupVal);

                            if (labInput && !labInput.value.trim() && !isSpecialGroup) {
                                 markError(labInput, true, 'Laboratory sollte ausgefüllt sein, wenn Group vorhanden ist.');
                                 errors.push(`<b>Author ${idx + 1} (Lab)</b>: Laboratory fehlt (Group ist gesetzt).`);
                            }
                            if (divisionInput && !divisionInput.value.trim()) {
                                 markError(divisionInput, true, 'Division sollte ausgefüllt sein, wenn Group vorhanden ist.');
                                 errors.push(`<b>Author ${idx + 1} (Division)</b>: Division fehlt (Group ist gesetzt).`);
                            }
                        }
                    }
                } else {
                    // Reset if no name
                    if (groupInput) markError(groupInput, false);
                }
            }
        });
    }

    // 2. Fallback / Generic Table Logic (for other forms)
    const tables = document.querySelectorAll('table');
    tables.forEach(table => {
        // Find headers
        const headers = Array.from(table.querySelectorAll('thead th, tr th')).map(th => th.innerText.trim().toLowerCase());

        // Locate columns
        const nameIdx = headers.findIndex(h => h.includes('standardized form of name'));
        const deptIdx = headers.findIndex(h => h.includes('department') || h.includes('affiliation'));

        if (nameIdx !== -1 && deptIdx !== -1) {
            const rows = table.querySelectorAll('tbody tr');
            rows.forEach((row, idx) => {
                const cells = row.querySelectorAll('td');
                if (cells.length > Math.max(nameIdx, deptIdx)) {
                    const nameInput = cells[nameIdx].querySelector('input[type="text"]');
                    const deptInput = cells[deptIdx].querySelector('input, select');

                    if (nameInput && deptInput && !nameInput.dataset.doraValidatorAttached) {
                         if (!nameInput.dataset.doraValidatorAttached) {
                            nameInput.addEventListener('input', validateForm);
                            nameInput.dataset.doraValidatorAttached = "true";
                        }
                        if (!deptInput.dataset.doraValidatorAttached) {
                            deptInput.addEventListener('input', validateForm);
                            deptInput.addEventListener('change', validateForm);
                            deptInput.dataset.doraValidatorAttached = "true";
                        }

                        const nameVal = nameInput.value.trim();
                        const deptVal = deptInput.value.trim();

                        if (/nomatch/i.test(nameVal) || /4ri/i.test(nameVal)) {
                            markError(nameInput, true, 'Darf nicht "nomatch" oder "4RI" enthalten.');
                            errors.push(`<b>Author Row ${idx + 1} (Name)</b>: Invalid content.`);
                        } else {
                            markError(nameInput, false);
                        }

                        if (nameVal) {
                            if (!deptVal || deptVal === '_none' || deptVal === '- Select -') {
                                markError(deptInput, true, 'Affiliation/Department ist erforderlich.');
                                errors.push(`<b>Author Row ${idx + 1} (Dept)</b>: Missing Department.`);
                            } else {
                                markError(deptInput, false);
                            }
                        } else {
                            markError(deptInput, false);
                        }
                    }
                }
            });
        }
    });
}

function renderErrorSummary(errors) {
    let panel = document.getElementById('dora-error-summary');

    if (errors.length === 0) {
        if (panel) panel.remove();
        return;
    }

    if (!panel) {
        panel = createEl('div', 'dora-error-summary');
        panel.id = 'dora-error-summary';
        // Basis-Styling (Position & Z-Index)
        panel.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 9999; font-family: sans-serif; font-size: 13px; color: #333; transition: all 0.2s ease; box-shadow: 0 0 10px rgba(0,0,0,0.1); border-radius: 5px; background: white; border: 1px solid #ccc;';
        document.body.appendChild(panel);
    }

    panel.innerHTML = '';

    if (isSummaryMinimized) {
        // --- MINIMIERTE ANSICHT ---
        panel.style.width = 'auto';
        panel.style.height = 'auto';
        panel.style.padding = '8px 12px';
        panel.style.cursor = 'pointer';
        panel.style.backgroundColor = '#fff5f5';
        panel.style.borderColor = '#fc8181';
        panel.style.borderLeft = '1px solid #fc8181';
        panel.title = "Klicken, um Fehlerdetails anzuzeigen";
        
        const icon = createEl('span', '', '⚠️');
        icon.style.fontSize = '1.2em';
        icon.style.marginRight = '5px';
        panel.appendChild(icon);
        const b = createEl('b', '', errors.length.toString());
        panel.appendChild(b);
        
        panel.onclick = () => {
            isSummaryMinimized = false;
            renderErrorSummary(errors); // Neu rendern (maximiert)
        };

    } else {
        // --- MAXIMIERTE ANSICHT ---
        panel.style.width = '320px';
        panel.style.maxHeight = '400px';
        panel.style.padding = '15px';
        panel.style.cursor = 'default';
        panel.style.backgroundColor = '#fff5f5';
        panel.style.borderColor = '#e53e3e';
        panel.style.borderLeft = '5px solid #e53e3e';
        panel.onclick = null;

        const header = createEl('div');
        header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid #e53e3e; padding-bottom:5px;';
        
        const title = createEl('span');
        const b = createEl('b', '', `${errors.length} Probleme gefunden:`);
        b.style.color = '#c53030';
        title.appendChild(b);
        
        const minBtn = createEl('span', '', '➖');
        minBtn.title = "Minimieren";
        minBtn.style.cssText = 'cursor:pointer; font-weight:bold; color:#c53030; padding: 0 5px; font-size: 1.2em;';
        minBtn.onclick = (e) => {
            e.stopPropagation();
            isSummaryMinimized = true;
            renderErrorSummary(errors); // Neu rendern (minimiert)
        };
        
        header.appendChild(title);
        header.appendChild(minBtn);
        panel.appendChild(header);

        const list = createEl('ul');
        list.style.cssText = 'padding-left:20px; margin:0; overflow-y:auto; max-height:300px;';
        
        errors.forEach(err => {
            const li = createEl('li');
            li.style.marginBottom = '5px';
            
            // Safe rendering of error message (allows <b> and <br> but escapes user input)
            // Error string format: "<b>Label</b>: Message" or similar
            const parts = err.split(/(<br\s*\/?>|<b>|<\/b>)/i);
            let isBold = false;
            parts.forEach(part => {
                if (part.toLowerCase() === '<b>') { isBold = true; return; }
                if (part.toLowerCase() === '</b>') { isBold = false; return; }
                if (part.toLowerCase().startsWith('<br')) { li.appendChild(document.createElement('br')); return; }
                
                if (part) {
                    const node = isBold ? createEl('b', '', part) : document.createTextNode(part);
                    li.appendChild(node);
                }
            });
            
            // Scroll-Logik
            li.style.cursor = 'pointer';
            li.title = "Klicken, um zum ersten Fehler zu springen";
            li.onclick = () => {
                 const firstError = document.querySelector('.dora-error');
                 if (firstError) firstError.scrollIntoView({behavior: "smooth", block: "center"});
            };

            list.appendChild(li);
        });
        
        panel.appendChild(list);
    }
}

function markError(el, isError, msg = '', isWarning = false) {
    let target = el;
    // Handle CKEditor visual target
    if (el.classList.contains('ckeditor-processed')) {
        const cke = document.getElementById('cke_' + el.id);
        if (cke) target = cke;
    }

    if (isError) {
        target.classList.add('dora-error');
        if (isWarning) {
            target.style.border = '2px dotted #e53e3e';
        } else {
            target.style.border = '2px solid #e53e3e';
        }
        if (target === el) target.style.backgroundColor = '#fff5f5'; // Only color bg if it's the input
        target.title = msg;
    } else {
        target.classList.remove('dora-error');
        target.style.border = '';
        if (target === el) target.style.backgroundColor = '';
        target.title = '';
    }
}