// content.js - Dora Lib4ri Helper
// Version: 2.58

let observerTimeout = null;
let dragSrcEl = null;
let lastAutoFetchedDoi = "";
let cachedExceptions = [];
let isMouseOverHandle = false;
let isSummaryMinimized = false; // Status für das Fehler-Panel
let lastErrorsHash = "";      // Zum Vergleichen der Fehlerliste
let lastMinimizedState = null; // Zum Vergleichen des Status

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
    // NEW: Check for Search Page for Batch QC feature
    if (isSearchPage()) {
        chrome.storage.local.get({ enableBatchQc: true }, function (result) {
            if (result.enableBatchQc) {
                injectBatchQcButton();
            } else {
                const btn = document.getElementById('dora-batch-qc-btn');
                if (btn) btn.remove();
            }
        });
        return;
    }

    // SECURITY / PERFORMANCE: Only run on Edit or Ingest Forms
    if (!isEditPage()) return;

    // 1. Check URL parameters for DOI (Ingest workflow)
    let urlParams = new URLSearchParams(window.location.search);
    let urlDoi = urlParams.get('doi');
    
    // Fallback: Check inline scripts (Drupal POSTs might hide URL params from the address bar)
    if (!urlDoi) {
        const scripts = document.querySelectorAll('script');
        for (let script of scripts) {
            if (script.textContent.includes('Drupal.settings') && script.textContent.includes('doi=')) {
                const match = script.textContent.match(/[?&]doi=(10\.\d{4,9}\/[^&_"'\\]+)/i);
                if (match) {
                    urlDoi = decodeURIComponent(match[1]);
                    break;
                }
            }
        }
    }

    if (urlDoi) {
        sessionStorage.setItem('dora_helper_current_doi', urlDoi);
    }

    const doiInput = document.getElementById('edit-identifiers-doi');
    if (doiInput) {
        if (!document.getElementById('dora-helper-btn')) {
            injectDOIButton(doiInput);
            doiInput.addEventListener('input', (e) => {
                const val = e.target.value.trim();
                if (val) sessionStorage.setItem('dora_helper_current_doi', val);
            });
        }
        const currentDoi = doiInput.value.trim();
        if (currentDoi) {
            sessionStorage.setItem('dora_helper_current_doi', currentDoi);
        }
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
    injectBulkDataTool();
    injectDoraAutocompletes();

    validateForm();
    if (typeof initAiMetadataCheck === 'function') {
        initAiMetadataCheck();
    }
    initPdfLicenseChecker();
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
        borderRadius: '5px', padding: '10px', boxShadow: '0 5px 20px rgba(0,0,0,0.15)'
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
        dropZone.textContent = '⏳ Analysiere...';
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
                dropZone.textContent = '📄 PDF hier ablegen'; // Reset
                dropZone.style.backgroundColor = '#f9f9f9';
            }
            confirmAndFillPdfData(data, 'file');
        } else {
            throw new Error(data.message || "Unbekannter Fehler");
        }

    } catch (error) {
        if (dropZone) {
            dropZone.textContent = '📄 PDF hier ablegen';
            dropZone.style.backgroundColor = '#f9f9f9';
        }
        renderErrorBox("PDF Analyse fehlgeschlagen: " + error.message + "\n\n(Hugging Face Space erreichbar?)");
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
        originalText = triggerBtn.textContent;
        triggerBtn.textContent = '⏳ Lade...';
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
                    if (triggerBtn) triggerBtn.textContent = originalText;
                    confirmAndFillPdfData(response.data, url.startsWith('blob:') ? 'monitor' : 'url');
                } else {
                    if (triggerBtn) {
                        triggerBtn.textContent = '❌ Fehler';
                        triggerBtn.title = response ? response.error : "Unbekannter Fehler";
                        setTimeout(() => {
                            triggerBtn.textContent = originalText;
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
                if (triggerBtn) triggerBtn.textContent = originalText;
                confirmAndFillPdfData(response.data, 'monitor');
            } else {
                if (triggerBtn) {
                    triggerBtn.textContent = '❌ Fehler';
                    triggerBtn.title = response ? response.error : "Unbekannter Fehler";
                    setTimeout(() => {
                        triggerBtn.textContent = originalText;
                        triggerBtn.title = '';
                    }, 3000);
                }
                renderErrorBox("PDF URL Analyse fehlgeschlagen: " + (response ? response.error : "Unbekannter Fehler"));
            }
        });
    } catch (error) {
        if (triggerBtn) {
            triggerBtn.disabled = false;
            triggerBtn.textContent = '❌ Fehler';
            setTimeout(() => {
                triggerBtn.textContent = originalText;
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
    box.replaceChildren(); // Clear old content
    const msg = createEl('div', '', '⏳ Metadaten werden abgerufen...');
    msg.style.cssText = 'text-align:center; color:#666; padding:20px; font-family:sans-serif;';
    box.appendChild(msg);
}

function renderErrorBox(msgText) {
    let box = createFloatingBox();
    box.replaceChildren();
    box.style.borderLeft = '5px solid #e53e3e';

    const closeBtn = createEl('div', 'dora-close-btn', '×');
    closeBtn.id = 'dora-box-close';
    closeBtn.style.cssText = 'position: absolute; top: 5px; right: 10px; cursor: pointer; font-size: 1.2em; color: #666;';
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

    // Hide the Bulk Data Tool by default when DOI results are shown
    const bulkTool = document.getElementById('dora-bulk-data-tool');
    if (bulkTool) {
        bulkTool.style.display = 'none';
        const b = bulkTool.querySelector('#dora-bulk-data-tool > div:nth-child(2)');
        if (b) b.style.display = 'none';
        const icon = document.getElementById('dora-bulk-toggle-icon');
        if (icon) icon.textContent = '▼';
        bulkTool.style.width = 'auto';
    }

    let box = createFloatingBox();
    box.replaceChildren(); // Reset

    // 1. Close Button
    const closeBtn = createEl('div', 'dora-close-btn', '×');
    closeBtn.id = 'dora-box-close';
    closeBtn.style.cssText = 'position: absolute; top: 5px; right: 10px; cursor: pointer; font-size: 1.2em; color: #666;';
    closeBtn.addEventListener('click', () => {
        box.remove();
        // Restore the Bulk Data Tool button so it's accessible without DOI box
        const bulkTool = document.getElementById('dora-bulk-data-tool');
        if (bulkTool) {
            bulkTool.style.display = 'block';
            const b = bulkTool.querySelector('#dora-bulk-data-tool > div:nth-child(2)');
            if (b) b.style.display = 'none';
            const icon = document.getElementById('dora-bulk-toggle-icon');
            if (icon) icon.textContent = '▼';
            bulkTool.style.width = 'auto';
        }
    });
    box.appendChild(closeBtn);

    // 2. Header
    const header = createEl('div', 'dora-meta-header');

    // Logo (Clickable to toggle Bulk tool)
    const logo = createEl('img');
    logo.id = 'dora-robot-logo';
    logo.src = chrome.runtime.getURL('icons/logo-48.png');
    logo.style.cssText = 'float:left; width:24px; height:24px; margin-right:8px; cursor:pointer;';
    logo.title = 'Klicken, um den Bulk Copy & Paste Assistenten anzuzeigen';
    logo.addEventListener('click', () => {
        if (typeof toggleBulkDataTool === 'function') {
            toggleBulkDataTool();
        }
    });
    header.appendChild(logo);

    // Title (Restored, smaller, stripped HTML)
    let titleText = meta.title ? meta.title[0] : 'Kein Titel';

    const title = createEl('div', 'dora-meta-title');
    // Safe decoding of HTML entities without executing scripts
    const parser = new DOMParser();
    const doc = parser.parseFromString(titleText, 'text/html');
    title.textContent = doc.body.textContent || "";

    title.style.fontSize = '0.85em';
    title.style.fontWeight = 'bold';
    title.style.marginBottom = '2px';
    title.style.lineHeight = '1.2';

    const containerTitle = meta['container-title'] ? meta['container-title'][0] : '';
    const pubDate = meta.created && meta.created['date-parts'] ? meta.created['date-parts'][0][0] : '-';
    const journalInfo = `${containerTitle} (${pubDate})`;
    const journal = createEl('div', 'dora-meta-journal', journalInfo);
    journal.style.fontSize = '0.75em';
    journal.style.color = '#666';

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
    badgesDiv.style.margin = '6px 0';

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

    // 5c. Data Quality Checker (Scopus / DOAJ / Crossref)
    if (data.scopus || data.doaj || data.crossrefLicense) {
        const checkerDiv = createEl('div', 'dora-checker-box');
        checkerDiv.style.cssText = 'margin-top:6px; padding:5px; background:#f8f9fa; border:1px solid #dee2e6; border-radius:4px; font-size:0.75em;';

        const headerRow = createEl('div', '', '🔍 Data Cross-Check');
        headerRow.style.fontWeight = 'bold';
        headerRow.style.marginBottom = '3px';
        headerRow.style.color = '#495057';
        checkerDiv.appendChild(headerRow);

        // --- SCOPUS CHECK ---
        if (data.scopus) {
            const scopus = data.scopus;
            if (scopus.error) {
                const err = createEl('div', '', `Scopus: Fehler (${scopus.error})`);
                err.style.color = '#e53e3e';
                checkerDiv.appendChild(err);
            } else {
                // A. Affiliation Check
                const affRow = createEl('div', '', '');
                const affInd = createEl('span', '', scopus.isLib4Ri ? '✅ ' : '⚠️ ');
                const affText = createEl('span', '', scopus.isLib4Ri ? 'Corr. Author: Lib4Ri' : 'Corr. Author: Extern/Möglicherweise nicht gefunden');
                if (!scopus.isLib4Ri) affText.title = scopus.affiliation || "Keine Info";
                affRow.appendChild(affInd);
                affRow.appendChild(affText);
                checkerDiv.appendChild(affRow);

                // B. OA Status Check (Refined)
                const oaRow = createEl('div', '', '');
                const scpIsHyrbid = scopus.oaType && scopus.oaType.toLowerCase().includes('hybrid');
                const scpIsOA = scopus.oaFlag === true; // OA=1

                // Conflict if: Unpaywall=Hybrid, Scopus=Closed (NOT OA)
                // Conflict if: Unpaywall=Closed, Scopus=OA
                // Note: Unpaywall=Hybrid & Scopus=OA is MATCH (Hybrid is a type of OA)

                let oaIcon = '✅ ';
                let oaMsg = `Scopus: ${scopus.oaType || (scpIsOA ? 'OA' : 'Closed')}`;
                let oaColor = '#28a745'; // Green

                if (isHybrid && !scpIsOA) { // Hybrid but Scopus says Closed
                    oaIcon = '⚠️ ';
                    oaMsg += ' (Unpaywall: Hybrid)';
                    oaColor = '#d69e2e'; // Orange
                } else if (!isHybrid && !oa.is_oa && scpIsOA) { // Closed but Scopus says OA
                    oaIcon = '⚠️ ';
                    oaMsg += ' (Unpaywall: Closed)';
                    oaColor = '#d69e2e';
                }

                const oaInd = createEl('span', '', oaIcon);
                const oaSpan = createEl('span', '', oaMsg);
                oaSpan.style.color = oaColor;

                oaRow.appendChild(oaInd);
                oaRow.appendChild(oaSpan);
                checkerDiv.appendChild(oaRow);
            }
        }

        // --- DOAJ CHECK ---
        if (data.doaj) {
            const doajRow = createEl('div', '', '');
            const inDoaj = data.doaj.in_doaj;

            // Logic:
            // Gold OA + Not in DOAJ -> Warning (Quality? New journal?)
            // Hybrid + In DOAJ -> Conflict (DOAJ journals are usually full OA, not Hybrid)

            let doajIcon = inDoaj ? '✅ ' : 'ℹ️ '; // Info icon for not in DOAJ (neutral usually)
            let doajMsg = inDoaj ? 'DOAJ: Gelistet' : 'DOAJ: Nicht gelistet';
            let doajColor = inDoaj ? '#28a745' : '#6c757d';

            if (oa.oa_status === 'gold' && !inDoaj) {
                doajIcon = '⚠️ ';
                doajMsg += ' (Gold OA aber nicht in DOAJ)';
                doajColor = '#d69e2e';
            } else if (isHybrid && inDoaj) {
                doajIcon = '⚠️ ';
                doajMsg += ' (Hybrid aber in DOAJ?)';
                doajColor = '#d69e2e';
            }

            const doajInd = createEl('span', '', doajIcon);
            const doajSpan = createEl('span', '', doajMsg);
            doajSpan.style.color = doajColor;
            doajRow.appendChild(doajInd);
            doajRow.appendChild(doajSpan);
            checkerDiv.appendChild(doajRow);
        }

        // --- LICENSE CHECK (Crossref) ---
        if (data.crossrefLicense) {
            const licRow = createEl('div', '', '');
            // Simple helper to clean URL to short code like "CC-BY"
            const getLicCode = (url) => {
                if (!url) return '';
                const parts = url.split('/');
                // e.g. creativecommons.org/licenses/by/4.0/ -> by 4.0
                if (url.includes('creativecommons.org')) {
                    const idx = parts.indexOf('licenses');
                    if (idx > -1 && parts[idx + 1]) return 'CC-' + parts[idx + 1].toUpperCase();
                }
                return 'License';
            };

            const crLic = getLicCode(data.crossrefLicense);
            const upLic = bestLoc.license ? bestLoc.license.toUpperCase() : null;

            let licIcon = '✅ ';
            let licMsg = `Crossref Lic: ${crLic}`;
            let licColor = '#28a745';

            // Conflict if Unpaywall has license but Crossref doesn't? Or types differ?
            // Usually Crossref is master.
            // If Unpaywall says CC-BY but Crossref has nothing -> Warning?
            // If Crossref says CC-BY but Unpaywall says CC-BY-NC -> Warning.

            if (upLic && crLic !== 'License' && !crLic.includes(upLic.replace('CC-', '').replace('-4.0', ''))) {
                // Very rough check. 'CC-BY' vs 'CC-BY-NC'. 
                // Allow partial match?
                if (upLic !== crLic) {
                    licIcon = '⚠️ ';
                    licMsg += ` (Unpaywall: ${upLic})`;
                    licColor = '#d69e2e';
                }
            }

            const licInd = createEl('span', '', licIcon);

            // Generate Link instead of Span
            const licSpan = createEl('a', '', licMsg);
            licSpan.href = data.crossrefLicense;
            licSpan.target = '_blank';
            licSpan.style.color = licColor;
            licSpan.style.textDecoration = 'none'; // Optional: keep it looking clean or add underline
            licSpan.style.borderBottom = '1px dotted ' + licColor; // Dotted underline to indicate interaction
            licSpan.title = data.crossrefLicense; // Tooltip with full URL

            licRow.appendChild(licInd);
            licRow.appendChild(licSpan);
            checkerDiv.appendChild(licRow);
        }

        box.appendChild(checkerDiv);
    } else {
        // Optional: Hint if Scopus Key missing
        // const hint = createEl('div', '', 'Scopus Check inaktiv (Kein API Key)');
        // hint.style.fontSize = '0.8em'; hint.style.color='#999';
        // box.appendChild(hint);
    }

    // 5. Buttons Container
    const btnContainer = createEl('div', 'dora-btn-container');
    btnContainer.style.display = 'flex';
    btnContainer.style.flexDirection = 'column';
    btnContainer.style.gap = '5px';
    btnContainer.style.marginTop = '8px';

    // Check if it is a Book Chapter
    const pubTypeEl = document.getElementById('edit-publication-type');
    const pubTypeVal = pubTypeEl ? pubTypeEl.value.toLowerCase() : '';
    const isHostType = pubTypeVal.includes('book chapter') || pubTypeVal.includes('proceedings paper') || pubTypeVal.includes('conference item');

    if (isHostType) {
        const importBtn = createEl('button', 'dora-box-btn btn-hybrid-action');
        importBtn.id = 'dora-import-book-chapter';

        const icon = createEl('span', '', '📚');
        icon.style.marginRight = '5px';
        importBtn.appendChild(icon);
        importBtn.appendChild(document.createTextNode(' Metadaten importieren'));

        importBtn.title = "Importiert Titel, Host-Titel (Buch/Proceedings), Seiten, Jahr, Verlag, Autoren, Editoren und Abstract";
        importBtn.addEventListener('click', async () => {
            importBtn.disabled = true;
            importBtn.textContent = '⏳ Import läuft...';
            try {
                await fillBookChapterMetadata(meta);
                importBtn.textContent = '✅ Importiert!';
                setTimeout(() => {
                    importBtn.disabled = false;
                    importBtn.replaceChildren(); // Clear
                    importBtn.appendChild(icon.cloneNode(true));
                    importBtn.appendChild(document.createTextNode(' Metadaten importieren'));
                }, 2000);
            } catch (e) {
                renderErrorBox(e.message);
                importBtn.disabled = false;
                importBtn.replaceChildren();
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
        pdfBtn.style.fontSize = '12px'; // Reduced
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
        policyBtn.style.fontSize = '12px'; // Reduced
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
    dropZone.style.cssText = 'border: 2px dashed #ccc; padding: 6px; border-radius: 4px; cursor: pointer; color: #666; font-size: 0.85em; background: #f9f9f9; margin-top: 8px; text-align: center; transition: all 0.2s;';

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
    // Loop to ensure we reach the required count
    // We use a safe limit (requiredCount + 2) to prevent infinite loops if something breaks
    let safetyLimit = requiredCount + 5;

    while (safetyLimit > 0) {
        safetyLimit--;

        // 1. FRESH QUERY: Always re-query the container because Drupal AJAX replaces it
        let container = document.querySelector(containerSelector + ' .islandora-form-fieldpanel-panel');
        let rowSelector = '.islandora-form-fieldpanel-pane';

        // Fallback for standard Drupal multi-value tables
        if (!container) {
            container = document.querySelector(containerSelector + ' table');
            if (container) {
                rowSelector = 'tbody tr:not(.tabledrag-hide)';
            } else {
                console.warn('DORA Helper: Container not found ' + containerSelector);
                return;
            }
        }

        // 2. CHECK COUNT
        const currentRows = container.querySelectorAll(rowSelector).length;
        if (currentRows >= requiredCount) {
            console.log("DORA Helper: All rows present (" + currentRows + ")");
            return; // Done!
        }

        // 3. FIND BUTTON
        // Look in the parent/wrapper since table add buttons are usually outside the table itself
        const wrapper = document.querySelector(containerSelector);
        let addButton = container.querySelector('.fieldpanel-add.form-submit');
        if (!addButton && wrapper) {
            addButton = wrapper.querySelector('.fieldpanel-add.form-submit, input[type="submit"][value="Add"], input[type="submit"][name$="[add]"]');
        }

        if (!addButton) {
            console.warn('DORA Helper: "Add" button missing in ' + containerSelector);
            return;
        }

        console.log(`DORA Helper: Adding row... (${currentRows} -> ${requiredCount})`);

        // 4. CLICK (Mousedown for Drupal)
        addButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));

        // 5. WAIT FOR AJAX
        await new Promise(resolve => {
            const observer = new MutationObserver((mutations, obs) => {
                let checkContainer = document.querySelector(containerSelector + ' .islandora-form-fieldpanel-panel');
                if (!checkContainer) checkContainer = document.querySelector(containerSelector + ' table');

                if (checkContainer) {
                    const newCount = checkContainer.querySelectorAll(rowSelector).length;
                    if (newCount > currentRows) {
                        obs.disconnect();
                        resolve();
                    }
                }
            });
            // Observer on the specific container (which might be replaced, but we observe the parent if possible or the container itself)
            // Ideally we'd observe the parent of the container, but the container itself usually mutates children.
            // If the container ITSELF is replaced, the observer might die. 
            // Better: Observe the wrapper if possible, or just accept the timeout fallback.
            const observeTarget = document.querySelector(containerSelector).parentNode || document.body;
            observer.observe(observeTarget, { childList: true, subtree: true });

            // Timeout: 2.5 seconds (AJAX should be faster)
            // If timeout occurs, loop continues and re-checks count.
            setTimeout(() => {
                observer.disconnect();
                resolve();
            }, 2500);
        });

        // Small delay to let JS event handlers finish binding to new elements
        await new Promise(r => setTimeout(r, 100));
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
                iframe.contentDocument.body.textContent = meta.title[0];
            }
        } else {
            titleEl.value = meta.title[0];
        }
    }

    // 2. Host Title (Book Title or Proceedings Title)
    const hostTitleEl = document.getElementById('edit-host-booktitle') || document.getElementById('edit-host-titleinfo-title');
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
        const authorContainer = document.querySelector('.form-item-authors');
        if (authorContainer) {
            let authorPanes = authorContainer.querySelectorAll('.islandora-form-fieldpanel-pane');
            if (authorPanes.length === 0) authorPanes = authorContainer.querySelectorAll('table tbody tr:not(.tabledrag-hide)');

            meta.author.forEach((auth, idx) => {
                if (authorPanes[idx]) {
                    const pane = authorPanes[idx];
                    const familyEl = pane.querySelector('input[name$="[family]"]');
                    const givenEl = pane.querySelector('input[name$="[given]"]');

                    if (familyEl) {
                        familyEl.value = auth.family || '';
                        familyEl.dispatchEvent(new Event('input', { bubbles: true }));
                        familyEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    if (givenEl) {
                        givenEl.value = auth.given || '';
                        givenEl.dispatchEvent(new Event('input', { bubbles: true }));
                        givenEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    // Trigger PSI Affiliation button removed because it is unreliable with just the name
                    // and often selects the wrong internal author object.
                }
            });
        }
    }

    // 8. Editors - Fill data
    if (meta.editor && meta.editor.length > 0) {
        const editorContainer = document.querySelector('.form-item-host-editor');
        if (editorContainer) {
            let editorPanes = editorContainer.querySelectorAll('.islandora-form-fieldpanel-pane');
            if (editorPanes.length === 0) editorPanes = editorContainer.querySelectorAll('table tbody tr:not(.tabledrag-hide)');

            meta.editor.forEach((ed, idx) => {
                if (editorPanes[idx]) {
                    const pane = editorPanes[idx];
                    // Note: Editor fields often have slightly different names, e.g. familyEditor vs family
                    // Based on your HTML: name="host[editor][0][familyEditor]"
                    const familyEl = pane.querySelector('input[name$="[familyEditor]"]');
                    const givenEl = pane.querySelector('input[name$="[givenEditor]"]');

                    if (familyEl) {
                        familyEl.value = ed.family || '';
                        familyEl.dispatchEvent(new Event('input', { bubbles: true }));
                        familyEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    if (givenEl) {
                        givenEl.value = ed.given || '';
                        givenEl.dispatchEvent(new Event('input', { bubbles: true }));
                        givenEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }

                    // Trigger PSI Affiliation button if available
                    const affilBtn = pane.querySelector('.lib4ri-author-fill');
                    if (affilBtn) {
                        affilBtn.click();
                    }
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
                // Use DOM manipulation for safe paragraph insertion
                const body = iframe.contentDocument.body;
                body.replaceChildren();
                cleanAbstract.trim().split(/\n\n+/).forEach((para, idx) => {
                    if (idx > 0) body.appendChild(iframe.contentDocument.createElement('br'));
                    body.appendChild(iframe.contentDocument.createTextNode(para));
                });
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
    list.replaceChildren();
    const loading = createEl('li', '', 'Lade Einstellungen...');
    loading.style.cssText = 'padding:10px; color:#666;';
    list.appendChild(loading);

    document.getElementById('dora-drag-hint').style.display = 'block';

    loadExceptionsFromStorage(() => {
        list.replaceChildren();
        const hiddenInputs = topicContainer.querySelectorAll('input[type="hidden"].form-tag, input[name^="topics"].form-tag');

        hiddenInputs.forEach((input) => {
            if (!input.value) return;
            const formattedValue = formatKeyword(input.value);
            const li = createEl('li', 'dora-keyword-item');

            // Input
            const inputField = createEl('input', 'dora-keyword-input');
            inputField.type = 'text';
            inputField.value = formattedValue;

            // Handle
            const handle = createEl('span', 'dora-drag-handle', '☰');
            handle.title = "Ziehen zum Sortieren";

            handle.setAttribute('draggable', 'true');

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

    handle.addEventListener('dragstart', function (e) {
        dragSrcEl = liItem;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
        liItem.classList.add('is-dragging');
    });

    handle.addEventListener('dragend', function () {
        liItem.classList.remove('is-dragging');
        document.querySelectorAll('.dora-keyword-item').forEach(col => {
            col.classList.remove('drop-target-top', 'drop-target-bottom');
        });
    });

    liItem.addEventListener('dragover', function (e) {
        if (e.preventDefault) e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (this === dragSrcEl) return;

        const rect = this.getBoundingClientRect();
        const relY = (e.clientY - rect.top) / rect.height;

        document.querySelectorAll('.dora-keyword-item').forEach(el => {
            if (el !== this) el.classList.remove('drop-target-top', 'drop-target-bottom');
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

    liItem.addEventListener('dragleave', function (e) {
        if (this.contains(e.relatedTarget)) return;
        this.classList.remove('drop-target-top', 'drop-target-bottom');
    });

    liItem.addEventListener('drop', function (e) {
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
        if (startPos > 0 && myField.value[startPos - 1] !== ' ' && myField.value[startPos - 1] !== '\n') {
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

// --- BULK DATA ENTRY TOOL ---
function toggleBulkDataTool(forceState) {
    const container = document.getElementById('dora-bulk-data-tool');
    if (!container) return;
    const body = container.querySelector('#dora-bulk-data-tool > div:nth-child(2)');
    const icon = document.getElementById('dora-bulk-toggle-icon');
    if (!body) return;

    // Check if it is currently expanded/open (body is displayed and container is visible)
    const isCurrentlyHidden = container.style.display === 'none' || body.style.display === 'none';
    const show = (forceState !== undefined) ? forceState : isCurrentlyHidden;

    const hasDoiBox = !!document.getElementById('dora-result-box');

    if (show) {
        container.style.display = 'block';
        body.style.display = 'block';
        if (icon) icon.textContent = '▲';
        container.style.width = '320px';
        container.style.right = hasDoiBox ? '350px' : '20px';
    } else {
        if (hasDoiBox) {
            container.style.display = 'none';
        } else {
            container.style.display = 'block';
            body.style.display = 'none';
            if (icon) icon.textContent = '▼';
            container.style.width = 'auto';
            container.style.right = '20px';
        }
    }
}

function injectBulkDataTool() {
    if (document.getElementById('dora-bulk-data-tool')) {
        // If it already exists, manage its visibility based on DOI box presence
        const hasDoiBox = !!document.getElementById('dora-result-box');
        const container = document.getElementById('dora-bulk-data-tool');
        const body = container.querySelector('#dora-bulk-data-tool > div:nth-child(2)');
        if (hasDoiBox && body && body.style.display === 'none') {
            container.style.display = 'none';
        } else {
            container.style.right = hasDoiBox ? '350px' : '20px';
        }
        return;
    }

    const authorContainer = document.querySelector('.form-item-authors');
    if (!authorContainer) return;

    const container = document.createElement('div');
    container.id = 'dora-bulk-data-tool';

    // Hide initially if DOI box is active, slide to 20px or 350px
    const hasDoiBox = !!document.getElementById('dora-result-box');
    container.style.cssText = 'position: fixed; right: ' + (hasDoiBox ? '350px' : '20px') + '; top: 110px; width: auto; z-index: 9999; margin: 15px 0; border: 1px solid #17a2b8; border-radius: 4px; background: #f8f9fa; font-size: 13px; font-family: sans-serif; box-shadow: 0 4px 6px rgba(0,0,0,0.2); transition: width 0.2s ease, right 0.2s ease;';
    if (hasDoiBox) {
        container.style.display = 'none';
    } else {
        container.style.display = 'block';
    }

    const header = document.createElement('div');
    header.style.cssText = 'padding: 8px 12px; background: #17a2b8; color: #fff; cursor: pointer; font-weight: bold; display: flex; justify-content: space-between; align-items: center; border-radius: 3px; gap: 10px; white-space: nowrap;';
    header.innerHTML = `<span>🚀 Bulk Copy & Paste</span><span id="dora-bulk-toggle-icon">▼</span>`;

    const body = document.createElement('div');
    body.style.cssText = 'padding: 15px; display: none;';

    header.addEventListener('click', () => {
        toggleBulkDataTool();
    });

    // Authors Section
    const authorSec = document.createElement('div');
    authorSec.style.cssText = 'margin-bottom: 20px;';
    authorSec.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 5px;">👥 Autoren Bulk-Input</div>
        <div style="display: flex; gap: 10px; margin-bottom: 5px; align-items: center;">
            <label style="font-size: 11px;">Trennen durch:</label>
            <select id="dora-bulk-author-sep" style="font-size: 11px; padding: 2px;">
                <option value="auto">Automatisch (Erraten)</option>
                <option value=";">Semikolon (;)</option>
                <option value=",">Komma (,)</option>
                <option value="\\n">Zeilenumbruch (Enter)</option>
                <option value="and">And / &</option>
            </select>
        </div>
        <textarea id="dora-bulk-author-text" placeholder="Beispiel: Müller, Thomas; Meier, Beat, Dr.; John Doe..." style="width: 100%; height: 60px; margin-bottom: 5px; padding: 5px; box-sizing: border-box;"></textarea>
        <div>
            <button id="dora-bulk-author-btn" type="button" class="form-submit" style="padding: 4px 10px; background: #28a745; border-color: #28a745; color: white;">Autoren einfügen</button>
            <span id="dora-bulk-author-status" style="margin-left: 10px; color: green; font-weight: bold;"></span>
        </div>
    `;

    // Keywords Section
    const keywordSec = document.createElement('div');
    keywordSec.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 5px;">🏷️ Keywords Bulk-Input</div>
        <div style="display: flex; gap: 10px; margin-bottom: 5px; align-items: center;">
            <label style="font-size: 11px;">Trennen durch:</label>
            <select id="dora-bulk-keyword-sep" style="font-size: 11px; padding: 2px;">
                <option value="auto">Automatisch (Erraten)</option>
                <option value=",">Komma (,)</option>
                <option value=";">Semikolon (;)</option>
                <option value="\\n">Zeilenumbruch (Enter)</option>
                <option value="-">Strich (-)</option>
            </select>
        </div>
        <textarea id="dora-bulk-keyword-text" placeholder="Beispiel: Climate change, hydrology, water quality..." style="width: 100%; height: 60px; margin-bottom: 5px; padding: 5px; box-sizing: border-box;"></textarea>
        <div>
            <button id="dora-bulk-keyword-btn" type="button" class="form-submit" style="padding: 4px 10px; background: #28a745; border-color: #28a745; color: white;">Keywords einfügen</button>
            <span id="dora-bulk-keyword-status" style="margin-left: 10px; color: green; font-weight: bold;"></span>
        </div>
    `;

    body.appendChild(authorSec);
    body.appendChild(keywordSec);
    container.appendChild(header);
    container.appendChild(body);

    document.body.appendChild(container);

    document.getElementById('dora-bulk-author-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        const text = document.getElementById('dora-bulk-author-text').value.trim();
        const sep = document.getElementById('dora-bulk-author-sep').value;
        if (!text) return;

        const btn = document.getElementById('dora-bulk-author-btn');
        const oldText = btn.textContent;
        btn.textContent = "Verarbeite...";
        btn.disabled = true;

        await processBulkAuthors(text, sep);

        btn.textContent = oldText;
        btn.disabled = false;
        const status = document.getElementById('dora-bulk-author-status');
        status.textContent = "Erledigt!";
        document.getElementById('dora-bulk-author-text').value = '';
        setTimeout(() => status.textContent = "", 3000);
    });

    document.getElementById('dora-bulk-keyword-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        const text = document.getElementById('dora-bulk-keyword-text').value.trim();
        const sep = document.getElementById('dora-bulk-keyword-sep').value;
        if (!text) return;

        const btn = document.getElementById('dora-bulk-keyword-btn');
        const oldText = btn.textContent;
        btn.textContent = "Verarbeite...";
        btn.disabled = true;

        await processBulkKeywords(text, sep);

        btn.textContent = oldText;
        btn.disabled = false;
        const status = document.getElementById('dora-bulk-keyword-status');
        status.textContent = "Erledigt!";
        document.getElementById('dora-bulk-keyword-text').value = '';
        setTimeout(() => status.textContent = "", 3000);
    });
}

async function processBulkAuthors(text, separatorMode) {
    let sep = separatorMode;
    if (sep === 'auto') {
        const counts = {
            ';': (text.match(/;/g) || []).length,
            '\\n': (text.match(/\n/g) || []).length,
            'and': (text.match(/\s+and\s+|\s+&\s+/gi) || []).length,
            ',': (text.match(/,/g) || []).length
        };

        // Prioritized detection: Semicolons and Newlines are stronger indicators of author separation than commas.
        if (counts[';'] > 0) sep = ';';
        else if (counts['\\n'] > 0) sep = '\\n';
        else if (counts['and'] > 0) sep = 'and';
        else if (counts[','] > 0) sep = ',';
        else sep = ';';
    }

    let rawList = [];
    if (sep === '\\n') {
        rawList = text.split(/\n/);
    } else if (sep === 'and') {
        rawList = text.split(/\s+and\s+|\s+&\s+/i);
    } else {
        rawList = text.split(sep);
    }

    const parsedAuthors = [];
    rawList.forEach(item => {
        let clean = item.trim();
        if (!clean) return;

        // Remove trailing affiliation markers (e.g., "a 1", "b,c", "*", "†", superscripts)
        // Matches trailing spaces/commas followed by single lowercase letters, digits, or common symbols
        clean = clean.replace(/(?:[\s,]*\b(?:[a-z]|\d+)\b|[\s,]*[*†‡¹²³⁴⁵⁶⁷⁸⁹⁰ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖ]+)+$/, '').trim();

        let family = '';
        let given = '';

        if (clean.includes(',')) {
            const parts = clean.split(',');
            family = parts.shift().trim();
            given = parts.join(',').trim();
        } else {
            const parts = clean.split(/\s+/);
            if (parts.length > 1) {
                family = parts.pop();
                given = parts.join(' ');
            } else {
                family = clean;
            }
        }
        parsedAuthors.push({ family, given });
    });

    if (parsedAuthors.length === 0) return;

    await addMissingRows('.form-item-authors', parsedAuthors.length);

    const authorContainer = document.querySelector('.form-item-authors');
    if (!authorContainer) return;

    let authorPanes = authorContainer.querySelectorAll('.islandora-form-fieldpanel-pane');
    if (authorPanes.length === 0) authorPanes = authorContainer.querySelectorAll('table tbody tr:not(.tabledrag-hide)');

    parsedAuthors.forEach((auth, idx) => {
        if (authorPanes[idx]) {
            const pane = authorPanes[idx];
            const familyEl = pane.querySelector('input[name$="[family]"]');
            const givenEl = pane.querySelector('input[name$="[given]"]');

            if (familyEl) {
                familyEl.value = auth.family;
                familyEl.dispatchEvent(new Event('input', { bubbles: true }));
                familyEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
            if (givenEl) {
                givenEl.value = auth.given;
                givenEl.dispatchEvent(new Event('input', { bubbles: true }));
                givenEl.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // Note: We intentionally skip triggering the .lib4ri-author-fill button 
            // to avoid false-positive matches on the internal author object.
        }
    });
}

async function processBulkKeywords(text, separatorMode) {
    let sep = separatorMode;
    if (sep === 'auto') {
        const counts = {
            ',': (text.match(/,/g) || []).length,
            ';': (text.match(/;/g) || []).length,
            '\\n': (text.match(/\n/g) || []).length,
            '-': (text.match(/-/g) || []).length
        };
        let maxCount = 0;
        sep = ',';
        for (const [key, count] of Object.entries(counts)) {
            if (count > maxCount) {
                maxCount = count;
                sep = key;
            }
        }
    }

    let rawList = [];
    if (sep === '\\n') {
        rawList = text.split(/\n/);
    } else {
        rawList = text.split(sep);
    }

    const keywords = rawList.map(k => k.trim()).filter(k => k.length > 0);
    if (keywords.length === 0) return;

    // We use an async loop and re-fetch elements because Drupal AJAX replaces the DOM!
    for (const kw of keywords) {
        const container = findKeywordContainer();
        if (!container) {
            console.warn("Keyword-Feld konnte nicht gefunden werden.");
            break;
        }

        const tagInput = container.querySelector('input[type="text"].form-text, input.tag-input');
        const addBtn = container.querySelector('input[type="image"][src*="add.png"]');

        if (tagInput && addBtn) {
            tagInput.value = kw;
            tagInput.dispatchEvent(new Event('input', { bubbles: true }));
            tagInput.dispatchEvent(new Event('change', { bubbles: true }));

            await new Promise(r => setTimeout(r, 100));

            // Trigger the Add button
            addBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));

            // Wait for the AJAX call to replace the DOM (tagInput will be detached)
            let waitLimit = 40; // max 2000ms
            while (waitLimit > 0 && document.body.contains(tagInput)) {
                await new Promise(r => setTimeout(r, 50));
                waitLimit--;
            }

            await new Promise(r => setTimeout(r, 200)); // Let the new DOM settle

        } else if (tagInput) {
            // Fallback for simple textareas or standard text inputs without an Add button
            let current = tagInput.value.trim();
            if (current && !current.endsWith(',')) current += ', ';
            tagInput.value = current + kw;
            tagInput.dispatchEvent(new Event('input', { bubbles: true }));
            tagInput.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            const textarea = container.querySelector('textarea');
            if (textarea) {
                let current = textarea.value.trim();
                if (current && !current.endsWith(',')) current += ', ';
                textarea.value = current + kw;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    }
}

function injectDoraAutocompletes() {
    const fields = [
        { id: 'edit-confinfo-confname', solrField: 'mods_name_conference_ms' },
        { id: 'edit-host-titleinfo-title', solrField: 'mods_relatedItem_host_titleInfo_title_ms' },
        { id: 'edit-host-series-titleinfo-title', solrField: 'mods_relatedItem_host_relatedItem_series_titleInfo_title_ms' },
        { id: 'edit-host-series-issn', solrField: 'mods_relatedItem_host_relatedItem_series_identifier_issn_ms' }
    ];

    // Conditionally add Publisher autocomplete if NOT a Journal Article
    const pubTypeEl = document.getElementById('edit-publication-type');
    const isJournalArticle = pubTypeEl && pubTypeEl.value === 'Journal Article';

    if (!isJournalArticle) {
        fields.push({ id: 'edit-host-origininfo1-0-publisher', solrField: 'mods_originInfo_publisher_ms' });
        fields.push({ id: 'edit-origininfo1-0-publisher', solrField: 'mods_originInfo_publisher_ms' });
        fields.push({ id: 'edit-host-origininfo-0-publisher', solrField: 'mods_originInfo_publisher_ms' });
        fields.push({ id: 'edit-origininfo-0-publisher', solrField: 'mods_originInfo_publisher_ms' });
    }

    fields.forEach(field => {
        let input = document.getElementById(field.id);

        // Fallback for Series ISSN or if the ID is not an input
        if (!input || (input.tagName !== 'INPUT' && input.tagName !== 'TEXTAREA')) {
            if (field.id.includes('issn')) input = findField('ISSN') || findField('Series ISSN') || input;
            else if (field.id.includes('confname')) input = findField('Conference Name') || input;
        }

        if (!input || input.dataset.doraAutocompleteAttached) return;
        if (input.tagName !== 'INPUT' && input.tagName !== 'TEXTAREA') return;

        console.log('DORA Helper: Attaching custom autocomplete to', field.id);
        input.dataset.doraAutocompleteAttached = "true";
        attachCustomAutocomplete(input, field);
    });
}


// Custom dropdown autocomplete for <input> and <textarea> elements
function attachCustomAutocomplete(inputEl, field) {
    const wrapper = inputEl.closest('.form-item') || inputEl.parentNode;
    wrapper.style.position = 'relative';

    const dropdownId = `dora-dropdown-${field.id}`;
    let dropdown = document.getElementById(dropdownId);
    if (!dropdown) {
        dropdown = createEl('div', 'dora-autocomplete-dropdown');
        dropdown.id = dropdownId;
        Object.assign(dropdown.style, {
            position: 'absolute',
            top: '100%',
            left: '0',
            minWidth: '100%',
            width: 'max-content',
            maxWidth: '1200px',
            maxHeight: '200px',
            overflowY: 'auto',
            overflowX: 'auto',
            backgroundColor: '#fff',
            border: '1px solid #ccc',
            borderTop: 'none',
            borderRadius: '0 0 4px 4px',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
            zIndex: '9999',
            display: 'none'
        });
        inputEl.insertAdjacentElement('afterend', dropdown);
    }

    inputEl.setAttribute('autocomplete', 'off');

    let debounceTimer;
    let selectedIndex = -1;

    inputEl.addEventListener('input', () => {
        const query = inputEl.value.trim();
        console.log('DORA Helper: Autocomplete input event', { fieldId: field.id, query, queryLength: query.length });
        if (query.length < 3) {
            dropdown.style.display = 'none';
            dropdown.replaceChildren();
            return;
        }

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            console.log('DORA Helper: Triggering fetch for', field.id);
            fetchSolrSuggestions(field.solrField, query, (results) => {
                console.log('DORA Helper: Got results for', field.id, ':', results.length, 'items');
                dropdown.replaceChildren();
                selectedIndex = -1;

                if (results.length === 0) {
                    dropdown.style.display = 'none';
                    return;
                }

                results.forEach((name, idx) => {
                    const item = createEl('div', 'dora-autocomplete-item', name.trim());
                    Object.assign(item.style, {
                        padding: '8px 12px',
                        cursor: 'pointer',
                        borderBottom: '1px solid #eee',
                        fontSize: '13px',
                        whiteSpace: 'nowrap'
                    });
                    item.addEventListener('mouseenter', () => {
                        item.style.backgroundColor = '#f0f0f0';
                    });
                    item.addEventListener('mouseleave', () => {
                        item.style.backgroundColor = '#fff';
                    });
                    item.addEventListener('click', () => {
                        inputEl.value = name.trim();
                        dropdown.style.display = 'none';
                        inputEl.focus();
                        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                        inputEl.dispatchEvent(new Event('change', { bubbles: true }));

                        // Trigger fetching if this is the conference field
                        if (field.id === 'edit-confinfo-confname') {
                            fetchConferenceDetails(name.trim());
                        }
                    });
                    dropdown.appendChild(item);
                });

                dropdown.style.display = 'block';
            });
        }, 400);
    });

    // Keyboard navigation
    inputEl.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.dora-autocomplete-item');
        if (items.length === 0 || dropdown.style.display === 'none') return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            updateSelection(items, selectedIndex);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            updateSelection(items, selectedIndex);
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            inputEl.value = items[selectedIndex].textContent;
            dropdown.style.display = 'none';
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));

            // Trigger fetching if this is the conference field
            if (field.id === 'edit-confinfo-confname') {
                fetchConferenceDetails(inputEl.value.trim());
            }
        } else if (e.key === 'Escape') {
            dropdown.style.display = 'none';
        }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!inputEl.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    });
}

function updateSelection(items, index) {
    items.forEach((item, i) => {
        item.style.backgroundColor = i === index ? '#e6f3ff' : '#fff';
    });
    if (items[index]) {
        items[index].scrollIntoView({ block: 'nearest' });
    }
}

// Shared Solr fetch function
function fetchSolrSuggestions(solrField, query, callback) {
    const solrUrl = `http://lib-dora-prod1.emp-eaw.ch:8080/solr/collection1/select?q=*:*&rows=0&facet=true&facet.limit=15&wt=json&facet.field=${solrField}&facet.prefix=${encodeURIComponent(query)}&_=${Date.now()}`;

    console.log('DORA Helper: Fetching Solr suggestions', { solrField, query, solrUrl });

    chrome.runtime.sendMessage({
        action: "searchAutocomplete",
        url: solrUrl
    }, (response) => {
        console.log('DORA Helper: Solr response', response);
        if (response && response.success && response.data) {
            const facetFields = response.data.facet_counts?.facet_fields;
            const facetData = facetFields ? facetFields[solrField] : null;
            console.log('DORA Helper: facetData for', solrField, ':', facetData);

            if (facetData && Array.isArray(facetData)) {
                // Solr returns [Value1, Count1, Value2, Count2, ...]
                const results = facetData.filter((_, i) => i % 2 === 0).filter(Boolean);
                callback(results);
                return;
            }
        }
        callback([]);
    });
}

function getDoraBaseUrl() {
    const path = window.location.pathname;
    const segments = path.split('/').filter(s => s.length > 0);
    // Erkennt psi, eawag, empa oder wsl aus der URL
    if (segments.length > 0 && ['psi', 'eawag', 'empa', 'wsl'].includes(segments[0].toLowerCase())) {
        return `${window.location.origin}/${segments[0]}`;
    }
    return window.location.origin;
}

function loadExceptionsFromStorage(callback) {
    chrome.storage.sync.get({
        exceptionList: `x-ray -> X-ray\nx-rays -> X-rays\ndna -> DNA\nrna -> RNA\nph -> pH\nnmr -> NMR\nhplc -> HPLC\nuv -> UV\nir -> IR\npcr -> PCR\ntem -> TEM\nsem -> SEM\nafm -> AFM\nxps -> XPS\nswitzerland -> Switzerland\nzurich -> Zurich`
    }, function (items) {
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
                mainBtn.replaceChildren();
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
                pubPdfBtn.style.fontSize = '12px'; // Reduced
                pubPdfBtn.style.padding = '6px 4px';

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
                statusDiv.replaceChildren(); // Clear
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
                statusDiv.replaceChildren(); // Clear
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
            dropZone.replaceChildren();
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
    const confNameEl = document.getElementById('edit-confinfo-confname') || document.getElementById('edit-conference-name') || getField('Conference Name');
    const procTitleEl = document.getElementById('edit-host-titleinfo-title') || getField('Title of the Conference Proceedings');
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

    // Rule 1: Volume required if Published (BUT NOT for Book Chapter or Conference Item)
    const pubTypeVal = pubTypeEl ? pubTypeEl.value.toLowerCase() : '';
    const isVolumeOptional = pubTypeVal.includes('book chapter') || pubTypeVal.includes('conference item');

    if (statusEl && volumeEl && !isVolumeOptional) {
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
            // Enhanced Stop Words (English + German)
            const stopWords = [
                'And', 'Or', 'But', 'The', 'A', 'An', 'In', 'On', 'Of', 'For', 'To', 'At', 'By', 'With', // EN
                'Und', 'Oder', 'Der', 'Die', 'Das', 'Ein', 'Eine', 'Auf', 'Aus', 'Von', 'Zu', 'Mit', 'Für', 'Im', 'Am' // DE (Capitalized = potential error)
            ];

            // Check middle words (exclude first)
            const middleWords = words.slice(1);

            // 0. Detect German Context
            // Look for special chars (ä, ö, ü, ß) OR common lowercase German particles
            const hasGermanChars = /[äöüßÄÖÜ]/.test(val);
            const germanParticles = ['und', 'oder', 'der', 'die', 'das', 'auf', 'aus', 'von', 'zu', 'mit', 'für', 'im', 'am'];
            const hasGermanParticles = middleWords.some(w => germanParticles.includes(w.toLowerCase().replace(/[^\w]/g, '')));

            const isGerman = hasGermanChars || hasGermanParticles;

            // 1. Check for capitalized stop words (strong indicator of Title Case)
            const hasCapStopWord = middleWords.some(w => {
                const cleanW = w.replace(/[^\wäöüß]/g, ''); // remove punctuation
                return stopWords.includes(cleanW);
            });

            // 2. Check ratio of capitalized words (excluding ALL CAPS acronyms)
            // SKIPPED if isGerman is true (because German Nouns are always capitalized)
            const mixedCaseCapWords = middleWords.filter(w => /^[A-ZÄÖÜ][a-zäöüß]+/.test(w));
            const ratio = mixedCaseCapWords.length / middleWords.length;

            if (hasCapStopWord) {
                markError(el, true, `${label} enthält grossgeschriebene Stoppwörter (bitte Sentence case verwenden).`);
                errors.push(`<b>${label}</b>: Enthält grossgeschriebene Stoppwörter (Sentence case verwenden).`);
            } else if (!isGerman && mixedCaseCapWords.length > 1 && ratio > 0.6) {
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
    // Check if we are in PSI context (URL contains /psi/)
    const isPsiContext = window.location.href.includes('/psi/');
    const isOldPsiPub = isPsiContext && !isNaN(pYearInt) && pYearInt < 2006;

    // 1. Specific Islandora Fieldpanel Logic
    const authorsContainer = document.querySelector('.form-item-authors');
    if (authorsContainer) {
        let panes = authorsContainer.querySelectorAll('.islandora-form-fieldpanel-pane');
        if (panes.length === 0) {
            panes = authorsContainer.querySelectorAll('table tbody tr:not(.tabledrag-hide)');
        }

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

                                    // Special Exception: If Group is "0000 PSI", do not flag Division errors
                                    const is0000PSI = groupInput && groupInput.value.includes('0000 PSI');

                                    if (!is0000PSI && divVal && !personData.units.some(u => divVal.includes(u) || u.includes(divVal))) {
                                        markError(divisionInput, true, `Warnung: "${divVal}" stimmt nicht mit den Stammdaten für ${pubYear} überein.`, true);
                                        errors.push(`<b>Author ${idx + 1} (Division)</b>: Die Division wurde mittlerweile umbenannt, hat aber Gültigkeit für den Eintrag.`);
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
                            // Special Rule: Division Heads (e.g. 1000-9000) or '0000 PSI' don't need a Lab
                            const isSpecialGroup = /^[1-9]000/.test(groupVal) || groupVal.includes('0000 PSI');

                            if (labInput) {
                                if (!labInput.value.trim() && !isSpecialGroup) {
                                    markError(labInput, true, 'Laboratory sollte ausgefüllt sein, wenn Group vorhanden ist.');
                                    errors.push(`<b>Author ${idx + 1} (Lab)</b>: Laboratory fehlt (Group ist gesetzt).`);
                                } else if (!labInput.title.includes('Stammdaten')) {
                                    markError(labInput, false);
                                }
                            }
                            
                            if (divisionInput) {
                                if (!divisionInput.value.trim() && !isSpecialGroup) {
                                    markError(divisionInput, true, 'Division sollte ausgefüllt sein, wenn Group vorhanden ist.');
                                    errors.push(`<b>Author ${idx + 1} (Division)</b>: Division fehlt (Group ist gesetzt).`);
                                } else if (!divisionInput.title.includes('Stammdaten') && !divisionInput.title.includes('umbenannt')) {
                                    markError(divisionInput, false);
                                }
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

    // Generate a simple hash of the errors to detect changes
    const currentErrorsHash = JSON.stringify(errors);

    // Skip re-render if nothing changed (unless panel was removed)
    if (panel && currentErrorsHash === lastErrorsHash && isSummaryMinimized === lastMinimizedState) {
        return;
    }

    lastErrorsHash = currentErrorsHash;
    lastMinimizedState = isSummaryMinimized;

    if (errors.length === 0) {
        if (panel) panel.remove();
        return;
    }

    // Capture current scroll position before re-rendering
    let savedScrollTop = 0;
    if (panel) {
        const oldList = panel.querySelector('ul');
        if (oldList) savedScrollTop = oldList.scrollTop;
    }

    if (!panel) {
        panel = createEl('div', 'dora-error-summary');
        panel.id = 'dora-error-summary';
        // Basis-Styling (Position & Z-Index)
        panel.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 9999; font-family: sans-serif; font-size: 13px; color: #333; transition: all 0.2s ease; box-shadow: 0 0 10px rgba(0,0,0,0.1); border-radius: 5px; background: white; border: 1px solid #ccc;';
        document.body.appendChild(panel);
    }

    panel.replaceChildren();

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
        panel.style.width = '256px';
        panel.style.maxHeight = '320px';
        panel.style.padding = '12px';
        panel.style.cursor = 'default';
        panel.style.backgroundColor = '#fff5f5';
        panel.style.borderColor = '#e53e3e';
        panel.style.borderLeft = '5px solid #e53e3e';
        panel.onclick = null;

        const header = createEl('div');
        header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid #e53e3e; padding-bottom:5px;';

        const title = createEl('span');
        const b = createEl('b', '', `${errors.length} Probleme:`);
        b.style.color = '#c53030';
        b.style.fontSize = '0.85em';
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
        list.id = 'dora-error-list';
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
                if (firstError) firstError.scrollIntoView({ behavior: "smooth", block: "center" });
            };

            list.appendChild(li);
        });

        panel.appendChild(list);

        // Restore scroll position
        if (savedScrollTop > 0) {
            list.scrollTop = savedScrollTop;
        }
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
            target.style.setProperty('border', '2px dotted #e53e3e', 'important');
        } else {
            target.style.setProperty('border', '2px solid #e53e3e', 'important');
        }
        if (target === el) target.style.setProperty('background-color', '#fff5f5', 'important'); // Only color bg if it's the input
        target.title = msg;
    } else {
        target.classList.remove('dora-error');
        target.style.removeProperty('border');
        if (target === el) target.style.removeProperty('background-color');
        target.title = '';
    }
}

// --- CONFERENCE AUTO-FILL ---
// --- CONFERENCE AUTO-FILL ---
function fetchConferenceDetails(confName) {
    console.log("DORA Helper: Fetching details for conference:", confName);
    // Escape quotes in Solr query
    const safeName = confName.replace(/"/g, '\\"');

    // Optimisation: Limit to only necessary fields (fl)
    // We request title, series, editors, PLACE, and DATE
    const fl = [
        'mods_relatedItem_host_titleInfo_title_ms',
        'mods_relatedItem_host_relatedItem_series_titleInfo_title_ms',
        'mods_relatedItem_host_relatedItem_series_identifier_issn_ms',
        'mods_relatedItem_host_name_personal_namePart_family_ms', // Editor Family Name (Specific)
        'mods_relatedItem_host_name_personal_namePart_given_ms',  // Editor Given Name (Specific)
        'mods_name_personal_editor_ms',
        'mods_name_personal_editor_mt',
        'mods_name_editor_ms',
        'mods_relatedItem_host_name_personal_editor_ms',
        '*editor*',
        'mods_originInfo_place_placeTerm_text_ms', // Place
        'mods_originInfo_dateOther_ms',            // Conference Date
        '*place*',                                 // Fuzzy fallback
        '*date*'                                   // Fuzzy fallback
    ].join(',');

    const solrUrl = `http://lib-dora-prod1.emp-eaw.ch:8080/solr/collection1/select?q=mods_name_conference_ms:"${encodeURIComponent(safeName)}"&fl=${encodeURIComponent(fl)}&rows=1&wt=json&_=${Date.now()}`;

    chrome.runtime.sendMessage({
        action: "searchAutocomplete",
        url: solrUrl
    }, (response) => {
        if (response && response.success && response.data) {
            const docs = response.data.response?.docs;
            if (docs && docs.length > 0) {
                const preparedData = prepareConferenceData(docs[0]);
                // Check if any data was found
                const hasData = Object.values(preparedData).some(v => v !== null && (Array.isArray(v) ? v.length > 0 : true));

                if (hasData) {
                    showConferenceConfirmation(preparedData, (selectedData) => {
                        applyConferenceData(selectedData);
                    });
                } else {
                    console.log("DORA Helper: No usable data found in conference doc.");
                }
            } else {
                console.log("DORA Helper: No conference details found for", confName);
            }
        }
    });
}

function prepareConferenceData(doc) {
    const data = {
        procTitle: null,
        seriesTitle: null,
        seriesIssn: null,
        editors: [],
        place: null,
        date: null
    };

    // 1. Proceedings Title
    if (doc.mods_relatedItem_host_titleInfo_title_ms && doc.mods_relatedItem_host_titleInfo_title_ms[0]) {
        data.procTitle = doc.mods_relatedItem_host_titleInfo_title_ms[0];
    }

    // 2. Series Title
    if (doc.mods_relatedItem_host_relatedItem_series_titleInfo_title_ms && doc.mods_relatedItem_host_relatedItem_series_titleInfo_title_ms[0]) {
        data.seriesTitle = doc.mods_relatedItem_host_relatedItem_series_titleInfo_title_ms[0];
    }
    if (doc.mods_relatedItem_host_relatedItem_series_identifier_issn_ms && doc.mods_relatedItem_host_relatedItem_series_identifier_issn_ms[0]) {
        data.seriesIssn = doc.mods_relatedItem_host_relatedItem_series_identifier_issn_ms[0];
    }

    // 3. Editors
    // 3. Editors
    // Priority: Specific Family/Given fields
    if (doc.mods_relatedItem_host_name_personal_namePart_family_ms &&
        doc.mods_relatedItem_host_name_personal_namePart_given_ms) {

        const families = doc.mods_relatedItem_host_name_personal_namePart_family_ms;
        const givens = doc.mods_relatedItem_host_name_personal_namePart_given_ms;

        // Pair them up if lengths match (assumption: Solr maintains order)
        if (families.length === givens.length) {
            data.editors = families.map((fam, idx) => ({
                family: fam,
                given: givens[idx]
            }));
        } else {
            // Fallback: If lengths mismatch, try to use just family names or fallback to other fields
            // For now, let's treat them as individual components if possible, or fallback
            console.warn("DORA Helper: Editor Family/Given count mismatch. Falling back to simple fields.");
        }
    }

    if (data.editors.length === 0) {
        // Fallback to previous logic
        const allKeys = Object.keys(doc);
        let editorField = null;
        const candidates = [
            'mods_name_personal_editor_ms',
            'mods_name_personal_editor_mt',
            'mods_name_editor_ms',
            'mods_relatedItem_host_name_personal_editor_ms'
        ];

        for (const c of candidates) {
            if (doc[c]) { editorField = c; break; }
        }
        if (!editorField) {
            const fuzzy = allKeys.find(k => k.includes('editor') && Array.isArray(doc[k]) && k !== 'score');
            if (fuzzy) editorField = fuzzy;
        }

        if (editorField && doc[editorField]) {
            data.editors = doc[editorField].map(name => {
                if (name.includes(',')) {
                    const parts = name.split(',');
                    if (parts.length >= 2) {
                        return { family: parts[0].trim(), given: parts.slice(1).join(',').trim() };
                    }
                }
                return { family: name, given: '' };
            });
        }
    }

    // 4. Place
    let place = doc.mods_originInfo_place_placeTerm_text_ms ? doc.mods_originInfo_place_placeTerm_text_ms[0] : null;
    if (!place) {
        const placeKey = allKeys.find(k => k.includes('place') && k.includes('Term') && Array.isArray(doc[k]));
        if (placeKey) place = doc[placeKey][0];
    }
    data.place = place;

    // 5. Conference Date
    let confDate = doc.mods_originInfo_dateOther_ms ? doc.mods_originInfo_dateOther_ms[0] : null;
    if (!confDate) {
        const dateKey = allKeys.find(k => k.includes('dateOther') && Array.isArray(doc[k]));
        if (dateKey) confDate = doc[dateKey][0];
    }
    data.date = confDate;

    return data;
}

async function applyConferenceData(data) {
    console.log("DORA Helper: Applying conference data", data);
    let msg = "Konferenz-Daten übernommen:\n";
    let hasChanges = false;

    // 1. Proceedings Title
    if (data.procTitle) {
        const procTitleEl = document.getElementById('edit-host-titleinfo-title') || findField('Conference Proceedings') || findField('Proceedings Title');
        if (procTitleEl) {
            procTitleEl.value = data.procTitle;
            procTitleEl.dispatchEvent(new Event('input', { bubbles: true }));
            msg += "- Proceedings Title\n";
            hasChanges = true;
        }
    }

    // 2. Series Title
    if (data.seriesTitle) {
        const seriesTitleEl = document.getElementById('edit-host-series-titleinfo-title') || findField('Series Title');
        if (seriesTitleEl) {
            seriesTitleEl.value = data.seriesTitle;
            seriesTitleEl.dispatchEvent(new Event('input', { bubbles: true }));
            msg += "- Series Title\n";
            hasChanges = true;
        }
    }

    // 2b. Series ISSN
    if (data.seriesIssn) {
        const seriesIssnEl = document.getElementById('edit-host-series-issn') || findField('ISSN') || findField('Series ISSN');
        if (seriesIssnEl) {
            seriesIssnEl.value = data.seriesIssn;
            seriesIssnEl.dispatchEvent(new Event('input', { bubbles: true }));
            seriesIssnEl.dispatchEvent(new Event('change', { bubbles: true }));
            msg += "- Series ISSN\n";
            hasChanges = true;
        }
    }

    // 3. Editors
    if (data.editors && data.editors.length > 0) {
        await addMissingRows('.form-item-host-editor', data.editors.length);

        const editorContainer = document.querySelector('.form-item-host-editor .islandora-form-fieldpanel-panel');
        if (editorContainer) {
            const editorPanes = editorContainer.querySelectorAll('.islandora-form-fieldpanel-pane');
            let filledCount = 0;

            data.editors.forEach((ed, idx) => {
                if (editorPanes[idx]) {
                    const pane = editorPanes[idx];
                    // Robust selector for Family Name (could be [family], [familyEditor], etc.)
                    const familyEl = pane.querySelector('input[name*="family" i]');
                    // Robust selector for Given Name
                    const givenEl = pane.querySelector('input[name*="given" i]');

                    let rowFilled = false;
                    if (familyEl) {
                        familyEl.value = ed.family;
                        familyEl.dispatchEvent(new Event('input', { bubbles: true }));
                        rowFilled = true;
                    }
                    if (givenEl && ed.given) {
                        givenEl.value = ed.given;
                        givenEl.dispatchEvent(new Event('input', { bubbles: true }));
                        rowFilled = true;
                    }
                    if (rowFilled) filledCount++;
                }
            });
            if (filledCount > 0) {
                msg += `- ${filledCount} Editor(s)\n`;
                hasChanges = true;
            }
        }
    }

    // 4. Place
    if (data.place) {
        const placeEl = document.getElementById('edit-confinfo-place') || document.getElementById('edit-origin-info-place') || findField('Place');
        if (placeEl) {
            placeEl.value = data.place;
            placeEl.dispatchEvent(new Event('input', { bubbles: true }));
            msg += `- Ort: ${data.place}\n`;
            hasChanges = true;
        }
    }

    // 5. Date
    if (data.date) {
        const dateEl = document.getElementById('edit-confinfo-dates') || document.getElementById('edit-origin-info-date-other') || findField('Date');
        if (dateEl) {
            dateEl.value = data.date;
            dateEl.dispatchEvent(new Event('input', { bubbles: true }));
            msg += `- Datum: ${data.date}\n`;
            hasChanges = true;
        }
    }

    if (hasChanges) {
        const toast = createEl('div', '', '✓ Daten eingefügt');
        toast.style.cssText = 'position:fixed; bottom:20px; right:20px; background:#48bb78; color:white; padding:10px 20px; border-radius:4px; z-index:10000; box-shadow:0 2px 5px rgba(0,0,0,0.2); animation: fadeOut 3s forwards; pointer-events:none;';

        if (!document.getElementById('dora-toast-style')) {
            const style = document.createElement('style');
            style.id = 'dora-toast-style';
            style.textContent = '@keyframes fadeOut { 0% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }';
            document.head.appendChild(style);
        }

        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }
}




// --- UTILS ---
function findField(labelPart) {
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
                if (input) return input; // Return the input element, not container
            }
        }
    }
    return null;
}

// --- CONFERENCE CONFIRMATION DIALOG ---
function showConferenceConfirmation(data, onConfirm) {
    // 0. Deduplication: Check if modal already exists
    if (document.querySelector('.dora-modal-overlay')) {
        console.log("DORA Helper: Modal already open, skipping.");
        return;
    }

    // 1. Create Overlay
    const overlay = createEl('div', 'dora-modal-overlay');
    overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:10001; display:flex; justify-content:center; align-items:center;';

    // 2. Create Modal Box on top of overlay
    const box = createEl('div', 'dora-modal-box');
    box.style.cssText = 'background:white; padding:20px; border-radius:8px; width:500px; max-width:90%; box-shadow:0 4px 6px rgba(0,0,0,0.1); display:flex; flex-direction:column; gap:15px; animation: popIn 0.3s ease-out;';

    // Animation for pop-in
    if (!document.getElementById('dora-modal-anim')) {
        const style = createEl('style', '', '@keyframes popIn { 0% { opacity: 0; transform: scale(0.9); } 100% { opacity: 1; transform: scale(1); } }');
        style.id = 'dora-modal-anim';
        document.head.appendChild(style);
    }

    // Header
    const header = createEl('div', '', '📋 Konferenz-Daten übernehmen?');
    header.style.cssText = 'font-weight:bold; font-size:1.2em; border-bottom:1px solid #eee; padding-bottom:10px; color:#2d3748;';
    box.appendChild(header);

    // Form Content
    const form = createEl('div');
    form.style.cssText = 'display:flex; flex-direction:column; gap:10px; max-height:60vh; overflow-y:auto; padding-right:5px;';

    const createCheckbox = (label, value, key, isChecked = true) => {
        if (!value) return null;

        const row = createEl('label');
        row.style.cssText = 'display:flex; align-items:start; gap:10px; cursor:pointer; padding:5px; border-radius:4px; transition:background 0.2s;';
        row.onmouseover = () => row.style.background = '#f7fafc';
        row.onmouseleave = () => row.style.background = 'transparent';

        const cb = createEl('input');
        cb.type = 'checkbox';
        cb.checked = isChecked;
        cb.dataset.key = key;
        cb.style.marginTop = '4px';

        const textDiv = createEl('div');
        textDiv.style.flex = '1';
        const b = createEl('b', '', label);
        b.style.display = 'block';
        b.style.marginBottom = '2px';
        b.style.color = '#4a5568';

        const span = createEl('div', '', value);
        span.style.color = '#718096';
        span.style.fontSize = '0.95em';
        span.style.wordBreak = 'break-word';

        textDiv.appendChild(b);
        textDiv.appendChild(span);

        row.appendChild(cb);
        row.appendChild(textDiv);
        return row;
    };

    if (data.procTitle) {
        const item = createCheckbox('Proceedings Title', data.procTitle, 'procTitle');
        if (item) form.appendChild(item);
    }
    if (data.seriesTitle) {
        const item = createCheckbox('Series Title', data.seriesTitle, 'seriesTitle');
        if (item) form.appendChild(item);
    }
    if (data.seriesIssn) {
        const item = createCheckbox('Series ISSN', data.seriesIssn, 'seriesIssn');
        if (item) form.appendChild(item);
    }
    if (data.place) {
        const item = createCheckbox('Ort', data.place, 'place');
        if (item) form.appendChild(item);
    }
    if (data.date) {
        const item = createCheckbox('Datum', data.date, 'date');
        if (item) form.appendChild(item);
    }
    if (data.editors && data.editors.length > 0) {
        const editorNames = data.editors.map(e => (e.family || '') + (e.given ? ', ' + e.given : '')).join('; ');
        const item = createCheckbox(`Editoren (${data.editors.length})`, editorNames, 'editors');
        if (item) form.appendChild(item);
    }

    if (form.children.length === 0) {
        const noData = createEl('div', '', 'Keine relevanten Daten gefunden.');
        noData.style.color = '#718096';
        form.appendChild(noData);
    }

    box.appendChild(form);

    // Actions
    const btnRow = createEl('div');
    btnRow.style.cssText = 'display:flex; justify-content:flex-end; gap:12px; margin-top:5px; padding-top:15px; border-top:1px solid #eee;';

    const closeAll = () => {
        overlay.remove();
    };

    const cancelBtn = createEl('button', '', 'Abbrechen');
    cancelBtn.style.cssText = 'background:white; border:1px solid #cbd5e0; color:#4a5568; padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:500; transition:all 0.2s;';
    cancelBtn.onmouseover = () => cancelBtn.style.background = '#f7fafc';
    cancelBtn.onmouseleave = () => cancelBtn.style.background = 'white';
    cancelBtn.onclick = closeAll;

    const confirmBtn = createEl('button', '', 'Daten übernehmen');
    confirmBtn.style.cssText = 'background:#3182ce; border:none; color:white; padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:600; box-shadow:0 2px 4px rgba(49,130,206,0.3); transition:all 0.2s;';
    confirmBtn.onmouseover = () => { confirmBtn.style.background = '#2b6cb0'; confirmBtn.style.transform = 'translateY(-1px)'; };
    confirmBtn.onmouseleave = () => { confirmBtn.style.background = '#3182ce'; confirmBtn.style.transform = 'translateY(0)'; };

    // Prevent default to avoid blur issues causing weird states
    const handleConfirm = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }

        const selectedKeys = [];
        form.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            selectedKeys.push(cb.dataset.key);
        });

        const filteredData = {};
        selectedKeys.forEach(key => {
            if (data[key]) filteredData[key] = data[key];
        });

        if (onConfirm) onConfirm(filteredData);
        closeAll();
    };

    // Use mousedown to trigger before blur events might interfere
    confirmBtn.addEventListener('mousedown', handleConfirm);
    // keep click just in case
    confirmBtn.onclick = handleConfirm;

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    box.appendChild(btnRow);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Close on click outside box
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeAll();
    });
}

// --- PDF LICENSE CHECKER (CROSSREF) ---
let cachedCrossrefLicenseUrl = null;
let cachedCrossrefMapped = null;

function initPdfLicenseChecker() {
    // Only run if there are PDF document-version selects
    const versionSelects = document.querySelectorAll('select[id*="-document-version"]');
    if (versionSelects.length === 0) {
        console.log("DORA-Helper: No PDF document-version dropdowns found on this page.");
        return;
    }
    console.log(`DORA-Helper: Found ${versionSelects.length} PDF(s).`);

    let doi = sessionStorage.getItem('dora_helper_current_doi');
    
    // Check if we are on the pdf management screen or ingest screen
    let objectIdMatch = window.location.href.match(/islandora\/object\/([^/]+)/);
    let pid = objectIdMatch ? objectIdMatch[1] : null;
    
    console.log(`DORA-Helper: initPdfLicenseChecker - Initial DOI: ${doi}, PID: ${pid}`);

    const checkLicenses = (resolvedDoi) => {
        if (!resolvedDoi) {
            console.log("DORA-Helper: checkLicenses called with empty DOI.");
            return;
        }
        
        console.log(`DORA-Helper: checkLicenses running for DOI: ${resolvedDoi}`);
        
        if (cachedCrossrefMapped) {
            console.log(`DORA-Helper: Using cached Crossref license: ${cachedCrossrefMapped}`);
            applyLicenseChecks(cachedCrossrefMapped, cachedCrossrefLicenseUrl);
            return;
        }

        console.log(`DORA-Helper: Fetching Crossref data from background for DOI: ${resolvedDoi}`);
        chrome.runtime.sendMessage({ action: "fetchData", doi: resolvedDoi }, (response) => {
            console.log("DORA-Helper: Crossref background response:", response);
            if (response && response.success && response.data.crossrefLicense) {
                cachedCrossrefLicenseUrl = response.data.crossrefLicense;
                cachedCrossrefMapped = mapCrossrefLicenseToDora(cachedCrossrefLicenseUrl);
                console.log(`DORA-Helper: Mapped Crossref License: ${cachedCrossrefMapped}`);
                applyLicenseChecks(cachedCrossrefMapped, cachedCrossrefLicenseUrl);
            } else {
                console.log("DORA-Helper: No valid license found in Crossref response.");
            }
        });
    };

    if (doi) {
        console.log(`DORA-Helper: Using DOI from sessionStorage: ${doi}`);
        checkLicenses(doi);
    } else if (pid && decodeURIComponent(pid).startsWith('psi:') && !decodeURIComponent(pid).includes('publications') && !decodeURIComponent(pid).includes('external')) {
        // Fetch MODS to find DOI if not in sessionStorage
        const inst = window.location.pathname.split('/')[1] || 'psi';
        const modsUrl = `/${inst}/islandora/object/${pid}/datastream/MODS`;
        console.log(`DORA-Helper: Fetching MODS XML from: ${modsUrl}`);
        fetch(modsUrl)
            .then(res => {
                console.log(`DORA-Helper: MODS fetch status: ${res.status}`);
                return res.ok ? res.text() : null;
            })
            .then(xmlStr => {
                if (!xmlStr) {
                    console.log("DORA-Helper: MODS fetch returned empty string.");
                    return;
                }
                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(xmlStr, "text/xml");
                const doiNodes = xmlDoc.querySelectorAll('identifier[type="doi"]');
                if (doiNodes.length > 0) {
                    doi = doiNodes[0].textContent.trim();
                    console.log(`DORA-Helper: Extracted DOI from MODS: ${doi}`);
                    sessionStorage.setItem('dora_helper_current_doi', doi);
                    checkLicenses(doi);
                } else {
                    console.log("DORA-Helper: No DOI identifier found in MODS XML.");
                }
            })
            .catch(e => console.error("DORA-Helper: Failed to fetch MODS for DOI.", e));
    } else {
        console.log("DORA-Helper: No DOI available and PID conditions not met for MODS fetch.");
    }

    function evaluateLicenseForVersionSelect(vs, mappedCrossref, fullUrl) {
        if (!vs) return;
        
        // Use regex to extract the base ID, since we now use *= which could match edit-files-0-document-version-xyz
        const match = vs.id.match(/^(.*?)-document-version/);
        if (!match) return;
        const baseId = match[1];
        
        const ls = document.getElementById(baseId + '-use-perm-manual') || document.getElementById(baseId + '-use-permission');
        const os = document.getElementById(baseId + '-use-permission');
        
        if (!ls) return;
        
        console.log(`[DORA-Helper] Checking PDF ${baseId}. Version: ${vs.value}`);
        
        const targetWrapper = (os || ls).closest('.form-item');
        if (!targetWrapper || !targetWrapper.parentNode) return;
        
        let warningDiv = targetWrapper.parentNode.querySelector('.dora-license-warning[data-for="' + baseId + '"]');
        
        if (vs.value.toLowerCase() === 'published version') {
            const selectedVal = (os && os.value) ? os.value : ls.value;
            console.log(`[DORA-Helper] Selected License: ${selectedVal}, Crossref: ${mappedCrossref}`);
            
            if (mappedCrossref && selectedVal !== mappedCrossref && !selectedVal.startsWith(mappedCrossref)) {
                if (!warningDiv || warningDiv.dataset.mapped !== mappedCrossref) {
                    if (!warningDiv) {
                        warningDiv = createEl('div', 'dora-license-warning');
                        warningDiv.dataset.for = baseId;
                        warningDiv.style.cssText = 'color: #9b1c1c; font-size: 0.95em; font-weight: 500; margin-top: 10px; padding: 12px 16px; background-color: #fdf2f2; border: 1px solid #f8b4b4; border-radius: 6px; display: flex; width: fit-content; max-width: 800px; align-items: center; gap: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); line-height: 1.4;';
                        targetWrapper.parentNode.insertBefore(warningDiv, targetWrapper.nextSibling);
                    }
                    warningDiv.dataset.mapped = mappedCrossref;
                    warningDiv.innerHTML = `
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; color: #e02424;">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                            <line x1="12" y1="9" x2="12" y2="13"></line>
                            <line x1="12" y1="17" x2="12.01" y2="17"></line>
                        </svg>
                        <div>Crossref gibt für diese Publikation abweichend die folgende Lizenz an: 
                            <a href="${fullUrl}" target="_blank" style="color: #9b1c1c; text-decoration: underline; font-weight: 700; margin-left: 4px;">${mappedCrossref}</a>
                        </div>`;
                }
                if (warningDiv.style.display !== 'flex') {
                    warningDiv.style.display = 'flex';
                }
                console.log(`[DORA-Helper] Warning shown for ${baseId}`);
            } else if (warningDiv) {
                warningDiv.style.display = 'none';
                console.log(`[DORA-Helper] Warning hidden (matched) for ${baseId}`);
            }
        } else if (warningDiv) {
            warningDiv.style.display = 'none';
            console.log(`[DORA-Helper] Warning hidden (not published version) for ${baseId}`);
        }
    }

    function applyLicenseChecks(mappedCrossref, fullUrl) {
        const selects = document.querySelectorAll('select[id*="-document-version"]');
        selects.forEach(vs => {
            setTimeout(() => evaluateLicenseForVersionSelect(vs, mappedCrossref, fullUrl), 500);
        });
    }

    // Bind a global capture-phase listener ONE TIME to catch all changes
    if (!window.doraLicenseCheckerGlobalBound) {
        window.doraLicenseCheckerGlobalBound = true;
        document.body.addEventListener('change', (e) => {
            if (cachedCrossrefMapped) {
                clearTimeout(window.doraLicenseCheckerThrottle);
                window.doraLicenseCheckerThrottle = setTimeout(() => {
                    applyLicenseChecks(cachedCrossrefMapped, cachedCrossrefLicenseUrl);
                }, 150);
            }
        }, true); // TRUE = Capture Phase
    }
}

function mapCrossrefLicenseToDora(url) {
    if (!url) return null;
    const lowerUrl = url.toLowerCase();
    
    if (lowerUrl.includes('creativecommons.org/licenses/by/4.0')) return 'CC BY 4.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by/3.0')) return 'CC BY 3.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by/2.5')) return 'CC BY 2.5';
    if (lowerUrl.includes('creativecommons.org/licenses/by/2.0')) return 'CC BY 2.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by/1.0')) return 'CC BY 1.0';
    
    if (lowerUrl.includes('creativecommons.org/licenses/by-sa/4.0')) return 'CC BY-SA 4.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-sa/3.0')) return 'CC BY-SA 3.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-sa/2.5')) return 'CC BY-SA 2.5';
    
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc/4.0')) return 'CC BY-NC 4.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc/3.0')) return 'CC BY-NC 3.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc/2.5')) return 'CC BY-NC 2.5';
    
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-nd/4.0')) return 'CC BY-NC-ND 4.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-nd/3.0')) return 'CC BY-NC-ND 3.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-nd/2.5')) return 'CC BY-NC-ND 2.5';
    
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-sa/4.0')) return 'CC BY-NC-SA 4.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-sa/3.0')) return 'CC BY-NC-SA 3.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-sa/2.5')) return 'CC BY-NC-SA 2.5';
    
    if (lowerUrl.includes('creativecommons.org/licenses/by-nd/4.0')) return 'CC BY-ND 4.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nd/3.0')) return 'CC BY-ND 3.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nd/2.5')) return 'CC BY-ND 2.5';
    
    if (lowerUrl.includes('creativecommons.org/publicdomain/zero/1.0')) return 'CC0';
    
    // Generic fallback for older/other versions
    if (lowerUrl.includes('creativecommons.org/licenses/by/')) return 'CC BY';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc/')) return 'CC BY-NC';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-nd/')) return 'CC BY-NC-ND';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-sa/')) return 'CC BY-NC-SA';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nd/')) return 'CC BY-ND';
    if (lowerUrl.includes('creativecommons.org/licenses/by-sa/')) return 'CC BY-SA';
    
    return null;
}
function isEditPage() {
    // Check for specific form IDs or Classes typical for DORA/Islandora Edit Forms
    if (document.getElementById('islandora-ingest-form')) return true;
    if (document.querySelector('.node-form')) return true;
    if (document.getElementById('edit-identifiers-doi')) return true; // Strong indicator

    // Check URL patterns
    const loc = window.location.href;
    if (loc.includes('/ingest') || loc.includes('/edit') || loc.includes('/manage') || loc.includes('lib4ridora_pdf_management')) return true;

    return false;
}

// --- BATCH QC DASHBOARD ---

function isSearchPage() {
    const loc = window.location.href.toLowerCase();
    const path = window.location.pathname.toLowerCase();
    return loc.includes('/islandora/search') || loc.includes('/solr/search') || path.includes('/search');
}

function injectBatchQcButton() {
    try {
        // Collect all visible PIDs on the page safely (with try-catch for URI components)
        const getPagePids = () => {
            const pids = new Set();
            document.querySelectorAll('a[href*="/islandora/object/"]').forEach(a => {
                try {
                    const hrefAttr = a.getAttribute('href');
                    if (!hrefAttr) return;
                    const href = decodeURIComponent(hrefAttr);
                    const match = href.match(/islandora\/object\/([a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+)/);
                    if (match) {
                        pids.add(match[1]);
                    }
                } catch (err) {
                    // Fallback to raw non-decoded match if decoding fails
                    const hrefAttr = a.getAttribute('href');
                    if (hrefAttr) {
                        const match = hrefAttr.match(/islandora\/object\/([a-zA-Z0-9_%-]+:[a-zA-Z0-9_%-]+)/);
                        if (match) {
                            try {
                                pids.add(decodeURIComponent(match[1]));
                            } catch (e) {
                                pids.add(match[1].replace(/%3A/gi, ':'));
                            }
                        }
                    }
                }
            });
            return Array.from(pids);
        };

        const allPids = getPagePids();
        const bookmarkTable = document.querySelector('table.islandora-bookmark-solr-results');

        // Check if button already exists
        let btn = document.getElementById('dora-batch-qc-btn');
        if (btn) {
            // Update counts for existing button
            if (bookmarkTable) {
                const checked = document.querySelectorAll('input.islandora-bookmark-solr-results:checked');
                btn.textContent = `Batch QC Dashboard (${checked.length} selected)`;
                btn.disabled = checked.length === 0;
                btn.style.opacity = checked.length === 0 ? '0.5' : '1';
                if (checked.length === 0) {
                    btn.style.background = '#94a3b8';
                    btn.style.borderColor = '#cbd5e1';
                    btn.style.boxShadow = 'none';
                } else {
                    btn.style.background = '#22c55e';
                    btn.style.borderColor = '#16a34a';
                    btn.style.boxShadow = '0 2px 4px rgba(34, 197, 94, 0.2)';
                }
            } else {
                btn.textContent = `Batch QC visible results (${allPids.length} items)`;
                btn.disabled = allPids.length === 0;
                btn.style.opacity = allPids.length === 0 ? '0.5' : '1';
                if (allPids.length === 0) {
                    btn.style.background = '#94a3b8';
                    btn.style.borderColor = '#cbd5e1';
                    btn.style.boxShadow = 'none';
                } else {
                    btn.style.background = '#22c55e';
                    btn.style.borderColor = '#16a34a';
                    btn.style.boxShadow = '0 2px 4px rgba(34, 197, 94, 0.2)';
                }
            }
            return; // Done updating existing button!
        }

        // Find insertion container
        const targetElement = document.querySelector('table.islandora-bookmark-solr-results') ||
            document.querySelector('div.islandora-solr-search-results') ||
            document.querySelector('.islandora-solr-search') ||
            document.querySelector('.block-islandora-solr') ||
            document.querySelector('div.islandora');

        const fallbackElement = document.querySelector('#content') ||
            document.querySelector('.region-content') ||
            document.querySelector('#main');

        if (!targetElement && !fallbackElement) return;

        const container = document.createElement('div');
        container.style.cssText = 'margin: 15px 0; display: flex; align-items: center; justify-content: flex-end; gap: 10px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;';

        btn = document.createElement('button');
        btn.id = 'dora-batch-qc-btn';
        btn.className = 'form-submit';
        btn.style.cssText = 'background-color: #22c55e; color: #fff; border: 1px solid #16a34a; padding: 8px 18px; font-size: 13px; font-weight: bold; border-radius: 6px; cursor: pointer; box-shadow: 0 2px 4px rgba(34, 197, 94, 0.2); transition: all 0.15s ease-in-out;';

        const updateCount = () => {
            const currentPids = getPagePids();
            if (bookmarkTable) {
                const checked = document.querySelectorAll('input.islandora-bookmark-solr-results:checked');
                btn.textContent = `Batch QC Dashboard (${checked.length} selected)`;
                btn.disabled = checked.length === 0;
                btn.style.opacity = checked.length === 0 ? '0.5' : '1';
                if (checked.length === 0) {
                    btn.style.background = '#94a3b8';
                    btn.style.borderColor = '#cbd5e1';
                    btn.style.boxShadow = 'none';
                } else {
                    btn.style.background = '#22c55e';
                    btn.style.borderColor = '#16a34a';
                    btn.style.boxShadow = '0 2px 4px rgba(34, 197, 94, 0.2)';
                }
            } else {
                btn.textContent = `Batch QC visible results (${currentPids.length} items)`;
                btn.disabled = currentPids.length === 0;
                btn.style.opacity = currentPids.length === 0 ? '0.5' : '1';
                if (currentPids.length === 0) {
                    btn.style.background = '#94a3b8';
                    btn.style.borderColor = '#cbd5e1';
                    btn.style.boxShadow = 'none';
                } else {
                    btn.style.background = '#22c55e';
                    btn.style.borderColor = '#16a34a';
                    btn.style.boxShadow = '0 2px 4px rgba(34, 197, 94, 0.2)';
                }
            }
        };

        // Hover animations
        btn.onmouseenter = () => {
            if (!btn.disabled) btn.style.background = '#16a34a';
        };
        btn.onmouseleave = () => {
            if (!btn.disabled) btn.style.background = '#22c55e';
        };

        // Attach listener if bookmark table is present
        if (bookmarkTable) {
            bookmarkTable.addEventListener('change', (e) => {
                if (e.target.classList.contains('islandora-bookmark-solr-results') || e.target.closest('.select-all')) {
                    updateCount();
                }
            });
        }

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            if (bookmarkTable) {
                const checked = document.querySelectorAll('input.islandora-bookmark-solr-results:checked');
                const pids = Array.from(checked).map(cb => cb.value);
                if (pids.length > 0) {
                    initBatchQcDashboard(pids);
                }
            } else {
                const currentPids = getPagePids();
                if (currentPids.length > 0) {
                    initBatchQcDashboard(currentPids);
                }
            }
        });

        updateCount();
        container.appendChild(btn);
        if (targetElement && targetElement.parentNode) {
            targetElement.parentNode.insertBefore(container, targetElement);
        } else if (fallbackElement) {
            fallbackElement.prepend(container);
        }
    } catch (e) {
        console.error("DORA Helper: Error injecting Batch QC button:", e);
    }
}

function initBatchQcDashboard(pids) {
    if (document.getElementById('dora-batch-qc-overlay')) return;

    // Session-basiertes Tracking bereits freigegebener PIDs
    let savedApproved = [];
    try {
        savedApproved = JSON.parse(sessionStorage.getItem('dora_approved_pids') || '[]');
    } catch (e) { }
    const approvedPids = new Set(savedApproved);

    const markPidAsApproved = (pid) => {
        approvedPids.add(pid);
        try {
            sessionStorage.setItem('dora_approved_pids', JSON.stringify(Array.from(approvedPids)));
        } catch (e) { }

        const item = document.getElementById(`batch-qc-item-${pid.replace(':', '-')}`);
        if (item) {
            item.classList.add('dora-approved-pid');
            item.style.borderRight = '5px solid #22c55e';
            if (currentPid !== pid) {
                item.style.background = '#f0fdf4';
                item.style.color = '#16a34a';
            }
            if (!item.querySelector('.dora-qc-yes-icon')) {
                const icon = document.createElement('span');
                icon.className = 'dora-qc-yes-icon';
                icon.textContent = ' (QC: Yes)';
                icon.style.cssText = 'color: #16a34a; font-size: 10px; font-weight: bold; margin-left: 4px;';
                item.appendChild(icon);
            }
        }
    };

    const getInstitutionPath = () => {
        const path = window.location.pathname;
        const segments = path.split('/').filter(s => s.length > 0);
        if (segments.length > 0 && ['psi', 'eawag', 'empa', 'wsl'].includes(segments[0].toLowerCase())) {
            return segments[0].toLowerCase();
        }
        return 'psi';
    };

    const overlay = document.createElement('div');
    overlay.id = 'dora-batch-qc-overlay';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: #f8fafc; z-index: 100000;
        display: flex; flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'padding: 12px 20px; background: #0f172a; color: #fff; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06); z-index: 10;';

    const title = document.createElement('h2');
    title.textContent = 'DORA Batch QC Dashboard';
    title.style.cssText = 'margin: 0; font-size: 16px; font-weight: 700; letter-spacing: 0.5px;';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Schließen';
    closeBtn.style.cssText = 'background: #ef4444; color: white; border: none; padding: 6px 16px; border-radius: 6px; font-weight: bold; cursor: pointer; transition: background 0.15s; font-size: 13px;';
    closeBtn.onmouseenter = () => closeBtn.style.background = '#dc2626';
    closeBtn.onmouseleave = () => closeBtn.style.background = '#ef4444';
    closeBtn.onclick = () => overlay.remove();
    header.appendChild(closeBtn);

    overlay.appendChild(header);

    // Body Grid
    const body = document.createElement('div');
    body.style.cssText = 'display: flex; flex: 1; overflow: hidden;';

    // Sidebar
    const sidebar = document.createElement('div');
    sidebar.style.cssText = 'width: 100px; background: #f1f5f9; border-right: 1px solid #e2e8f0; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 6px; font-size: 11px;';

    // Middle (Form)
    const middle = document.createElement('div');
    middle.style.cssText = 'flex: 2.8; border-right: 1px solid #e2e8f0; display: flex; flex-direction: column; background: #fff; position: relative;';

    const middleToolbar = document.createElement('div');
    middleToolbar.style.cssText = 'padding: 10px 16px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center;';

    const approveBtn = document.createElement('button');
    approveBtn.textContent = '✅ Schnell-Freigabe (QC = Yes)';
    approveBtn.style.cssText = 'background: #22c55e; color: white; border: none; padding: 8px 18px; border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 13px; box-shadow: 0 2px 4px rgba(34, 197, 94, 0.2); transition: background 0.15s;';
    approveBtn.onmouseenter = () => approveBtn.style.background = '#16a34a';
    approveBtn.onmouseleave = () => approveBtn.style.background = '#22c55e';
    approveBtn.onclick = () => approveCurrentForm();
    middleToolbar.appendChild(approveBtn);

    // Fetch actual initials for approveBtn label dynamically
    chrome.storage.local.get({ qcInitials: '' }, function (result) {
        const initials = result.qcInitials.trim();
        if (initials) {
            approveBtn.textContent = `✅ Schnell-Freigabe (QC = Yes, User = ${initials})`;
        }
    });

    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = '↻ Neu laden';
    reloadBtn.style.cssText = 'background: #64748b; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600; transition: background 0.15s;';
    reloadBtn.onmouseenter = () => reloadBtn.style.background = '#475569';
    reloadBtn.onmouseleave = () => reloadBtn.style.background = '#64748b';
    reloadBtn.onclick = () => { if (currentPid) loadRecord(currentPid); };
    middleToolbar.appendChild(reloadBtn);

    const middleIframe = document.createElement('iframe');
    middleIframe.style.cssText = 'flex: 1; border: none; width: 100%;';

    middle.appendChild(middleToolbar);
    middle.appendChild(middleIframe);

    // Right (PDF)
    const right = document.createElement('div');
    right.style.cssText = 'flex: 1.2; display: flex; flex-direction: column; background: #f8fafc; border-left: 1px solid #e2e8f0;';

    const rightToolbar = document.createElement('div');
    rightToolbar.style.cssText = 'padding: 10px 16px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; gap: 10px;';

    const rightTitle = document.createElement('span');
    rightTitle.textContent = '📄 PDF Vorschau (scrollbar)';
    rightTitle.style.cssText = 'font-weight: 600; font-size: 12px; color: #475569;';
    rightToolbar.appendChild(rightTitle);

    const rightIframe = document.createElement('iframe');
    rightIframe.style.cssText = 'flex: 1; border: none; width: 100%;';

    right.appendChild(rightToolbar);
    right.appendChild(rightIframe);

    body.appendChild(sidebar);
    body.appendChild(middle);
    body.appendChild(right);
    overlay.appendChild(body);

    let currentPid = null;

    // Load PIDs into sidebar
    pids.forEach((pid, idx) => {
        const item = document.createElement('div');
        item.style.cssText = 'padding: 10px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; user-select: none; transition: all 0.15s ease-in-out; word-break: break-all; font-weight: 500; color: #475569; box-shadow: 0 1px 2px rgba(0,0,0,0.02);';
        item.innerHTML = `<strong>${pid}</strong>`;
        item.id = `batch-qc-item-${pid.replace(':', '-')}`;

        // Falls bereits freigegeben, optischen Akzent setzen
        if (approvedPids.has(pid)) {
            item.classList.add('dora-approved-pid');
            item.style.borderRight = '5px solid #22c55e';
            item.style.background = '#f0fdf4';
            item.style.color = '#16a34a';
            const icon = document.createElement('span');
            icon.className = 'dora-qc-yes-icon';
            icon.textContent = ' (QC: Yes)';
            icon.style.cssText = 'color: #16a34a; font-size: 10px; font-weight: bold; margin-left: 4px;';
            item.appendChild(icon);
        }

        item.onmouseenter = () => {
            if (currentPid !== pid) {
                item.style.background = item.classList.contains('dora-approved-pid') ? '#e8f5e9' : '#f1f5f9';
                item.style.color = '#0f172a';
            }
        };
        item.onmouseleave = () => {
            if (currentPid !== pid) {
                item.style.background = item.classList.contains('dora-approved-pid') ? '#f0fdf4' : '#ffffff';
                item.style.color = item.classList.contains('dora-approved-pid') ? '#16a34a' : '#475569';
            }
        };

        item.onclick = () => {
            // Unhighlight all
            Array.from(sidebar.children).forEach(child => {
                const isApproved = child.classList.contains('dora-approved-pid');
                child.style.background = isApproved ? '#f0fdf4' : '#ffffff';
                child.style.borderLeft = '1px solid #e2e8f0';
                child.style.color = isApproved ? '#16a34a' : '#475569';
                child.style.boxShadow = '0 1px 2px rgba(0,0,0,0.02)';
            });
            // Highlight current
            item.style.background = '#eff6ff';
            item.style.borderLeft = '4px solid #3b82f6';
            item.style.color = '#1e3a8a';
            item.style.boxShadow = '0 2px 4px rgba(59, 130, 246, 0.05)';
            currentPid = pid;
            loadRecord(pid);
        };
        sidebar.appendChild(item);
    });

    document.body.appendChild(overlay);

    // Automatically load first
    if (pids.length > 0) {
        sidebar.children[0].click();
    }

    function loadRecord(pid) {
        // Reset des Freigabe-Buttons auf den Standard-Zustand für den neuen Datensatz
        chrome.storage.local.get({ qcInitials: '' }, function (result) {
            const initials = result.qcInitials.trim();
            if (initials) {
                approveBtn.textContent = `✅ Schnell-Freigabe (QC = Yes, User = ${initials})`;
            } else {
                approveBtn.textContent = '✅ Schnell-Freigabe (QC = Yes)';
            }
            approveBtn.style.background = '#22c55e';
            approveBtn.style.boxShadow = '0 2px 4px rgba(34, 197, 94, 0.2)';
        });

        const inst = getInstitutionPath();
        const pdfUrl = `/${inst}/islandora/object/${pid}/datastream/PDF/view`;

        // PDF Iframe (Uses locally bundled PDF.js viewer to bypass Adobe Acrobat browser settings)
        const viewerUrl = chrome.runtime.getURL('pdf_viewer.html');
        const absolutePdfUrl = window.location.origin + pdfUrl;
        rightIframe.src = `${viewerUrl}?file=${encodeURIComponent(absolutePdfUrl)}`;



        // Inject script into iframe to hide header/footer (Bound BEFORE setting src to avoid race conditions!)
        middleIframe.onload = () => {
            try {
                const doc = middleIframe.contentDocument || middleIframe.contentWindow.document;
                if (!doc) return;

                // Hide Drupal header/footer to save space
                const header = doc.getElementById('header');
                const footer = doc.getElementById('footer');
                const tabs = doc.querySelector('ul.tabs');
                const toolbar = doc.getElementById('toolbar');
                const branding = doc.getElementById('branding');
                const pageTitle = doc.getElementById('page-title');
                if (header) header.style.display = 'none';
                if (footer) footer.style.display = 'none';
                if (tabs) tabs.style.display = 'none';
                if (toolbar) toolbar.style.display = 'none';
                if (branding) branding.style.display = 'none';
                if (pageTitle) pageTitle.style.display = 'none';

                // Hide sidebars, navigation, breadcrumbs
                const sidebarFirst = doc.getElementById('sidebar-first') || doc.querySelector('.sidebar') || doc.querySelector('.region-sidebar-first');
                const sidebarSecond = doc.getElementById('sidebar-second') || doc.querySelector('.region-sidebar-second');
                const navigation = doc.getElementById('navigation') || doc.getElementById('nav');
                const breadcrumb = doc.getElementById('breadcrumb') || doc.querySelector('.breadcrumb');
                if (sidebarFirst) sidebarFirst.style.display = 'none';
                if (sidebarSecond) sidebarSecond.style.display = 'none';
                if (navigation) navigation.style.display = 'none';
                if (breadcrumb) breadcrumb.style.display = 'none';

                // Inject Compact & Modernized CSS
                const style = doc.createElement('style');
                style.textContent = `
                    /* Kompakte, moderne Darstellung des Formulars */
                    body { 
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important; 
                        background-color: #f8fafc !important; 
                        color: #1e293b !important;
                        padding: 12px !important;
                    }
                    body, label, input, select, textarea { font-size: 12px !important; line-height: 1.4 !important; }
                    
                    .form-item { margin: 8px 0 !important; padding: 0 !important; display: block !important; }
                    
                    .form-item label { 
                        display: block !important; 
                        margin: 0 0 3px 0 !important; 
                        font-weight: 600 !important; 
                        font-size: 11px !important; 
                        color: #475569 !important; 
                        text-transform: uppercase !important;
                        letter-spacing: 0.3px !important;
                    }
                    
                    input[type="text"], select, textarea { 
                        width: 100% !important; 
                        max-width: 100% !important; 
                        padding: 6px 10px !important; 
                        margin: 0 !important; 
                        box-sizing: border-box !important; 
                        border: 1px solid #cbd5e1 !important;
                        border-radius: 6px !important;
                        background-color: #ffffff !important;
                        color: #0f172a !important;
                        transition: all 0.15s ease-in-out !important;
                    }
                    
                    input[type="text"]:focus, select:focus, textarea:focus {
                        border-color: #3b82f6 !important;
                        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15) !important;
                        outline: none !important;
                    }
                    
                    textarea { min-height: 50px !important; resize: vertical !important; }
                    
                    fieldset { 
                        margin: 12px 0 !important; 
                        padding: 12px !important; 
                        border: 1px solid #e2e8f0 !important; 
                        border-radius: 8px !important;
                        background: #ffffff !important; 
                        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02) !important;
                    }
                    
                    legend { 
                        font-weight: 700 !important; 
                        font-size: 11px !important; 
                        text-transform: uppercase !important;
                        letter-spacing: 0.3px !important;
                        margin: 0 !important; 
                        padding: 3px 8px !important; 
                        background: #f1f5f9 !important; 
                        color: #475569 !important;
                        border: 1px solid #cbd5e1 !important; 
                        border-radius: 4px !important; 
                    }
                    
                    .fieldset-wrapper { margin-top: 2px !important; }
                    
                    /* Hilfstexte konsequenter ausblenden */
                    .description, .help-block, div.description, p.help, .form-item .description, .form-desc, div[class*="description"] { display: none !important; }
                    
                    .islandora-xml-form-builder-form { margin-top: 0 !important; }
                    
                    /* Generelle Tabellen-Anpassung */
                    table { width: 100% !important; border-collapse: collapse !important; margin: 8px 0 !important; }
                    table, tr, td { padding: 4px !important; margin: 0 !important; }
                    
                    /* Breitenkontrolle für die verschachtelten Tabellen (Autoren, Affiliationen) */
                    fieldset { overflow-x: auto !important; }
                    table td input[type="text"], table td select { max-width: 250px !important; }
                    
                    /* Ultra-Kompression für die Autorenliste */
                    .dora-authors-fieldset table {
                        margin: 2px 0 !important;
                    }
                    .dora-authors-fieldset table td {
                        padding: 2px 4px !important;
                        vertical-align: middle !important;
                    }
                    .dora-authors-fieldset .form-item {
                        margin: 0 !important;
                        padding: 0 !important;
                    }
                    .dora-authors-fieldset input[type="text"], 
                    .dora-authors-fieldset select {
                        padding: 3px 6px !important;
                        height: 24px !important;
                        font-size: 11px !important;
                    }
                    .dora-authors-fieldset input[type="image"], 
                    .dora-authors-fieldset input[type="submit"] {
                        padding: 2px !important;
                        margin: 0 !important;
                        height: 20px !important;
                        width: auto !important;
                    }
                    
                    .messages { padding: 8px !important; margin: 8px 0 !important; border-radius: 6px !important; }
                    
                    /* Hide Drupal Theme Sidebars, Navigation, Breadcrumbs */
                    #sidebar-first, #sidebar-second, .region-sidebar-first, .region-sidebar-second, 
                    #navigation, #nav, .sidebar, #breadcrumb, .breadcrumb, #admin-menu, #page-title {
                        display: none !important;
                        width: 0 !important;
                    }
                    
                    /* Force Main Content to 100% Width */
                    #main, #content, #main-wrapper, #content-wrapper, .main-content, .content, #center, #main-content {
                        width: 100% !important;
                        max-width: 100% !important;
                        margin: 0 !important;
                        padding: 0 !important;
                        float: none !important;
                    }
                    
                    /* Hilfsklasse zum erzwungenen Ausblenden (überschreibt display: block !important) */
                    .dora-hidden { display: none !important; }

                    /* Validierungsfehler-Hervorhebung */
                    .dora-error, input.dora-error, select.dora-error, textarea.dora-error {
                        border: 2px solid #e53e3e !important;
                        background-color: #fff5f5 !important;
                    }
                    
                    /* Neue QC-Highlight-Box am Formularanfang */
                    .dora-qc-highlight-box {
                        background: #f0fdf4 !important;
                        border: 1px solid #bbf7d0 !important;
                        border-left: 5px solid #22c55e !important;
                        border-radius: 8px !important;
                        padding: 12px !important;
                        margin-bottom: 16px !important;
                        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05) !important;
                    }
                    
                    .dora-qc-highlight-box h3 {
                        margin: 0 0 8px 0 !important;
                        font-size: 13px !important;
                        color: #15803d !important;
                        display: flex !important;
                        align-items: center !important;
                        gap: 6px !important;
                        text-transform: uppercase !important;
                        letter-spacing: 0.5px !important;
                    }
                `;
                doc.head.appendChild(style);

                // Spezifische Felder anhand ihrer Beschriftung & Element-Attribute ausblenden (Dual-Strategie für maximale Zuverlässigkeit)
                const hideSpecificFields = () => {
                    // Strategie 1: Text-basierte Übereinstimmung für Labels, Legenden und Tabellenköpfe
                    const textTargets = [
                        "corresponding author's e-mail",
                        "corresponding author e-mail",
                        "department descriptor",
                        "duo group info",
                        "duo laboratory info",
                        "duo division info"
                    ];

                    const matchesText = (text) => {
                        const cleanText = text.toLowerCase().trim().replace(/\s+/g, ' ');
                        return textTargets.some(t => cleanText === t || cleanText.startsWith(t) || cleanText.endsWith(t) || (cleanText.includes(t) && cleanText.length < 50));
                    };

                    // Strategie 2: Attribut-basierte Übereinstimmung (id, name, class) für Inputs/Textareas
                    const attributeTargets = [
                        "notes_group", "notes-group", "notes_lab", "notes-lab", "notes_div", "notes-div",
                        "dept_descriptor", "dept-descriptor",
                        "department_descriptor", "department-descriptor",
                        "corresponding_author_email", "corresponding-author-email", "corresponding_email", "corresponding-email"
                    ];

                    const matchesAttribute = (attr) => {
                        if (!attr) return false;
                        const cleanAttr = attr.toLowerCase();
                        return attributeTargets.some(t => cleanAttr.includes(t));
                    };

                    // A: Zuerst alle Formularfelder (input, textarea, select) nach ID/Name/Klasse durchsuchen
                    doc.querySelectorAll('input, textarea, select').forEach(el => {
                        if (matchesAttribute(el.id) || matchesAttribute(el.name) || matchesAttribute(el.className)) {
                            // Wrapper des Formularfelds ausblenden
                            const wrapper = el.closest('.form-item') || el.closest('.form-wrapper') || el.closest('td') || el.parentElement;
                            if (wrapper && !wrapper.classList.contains('dora-hidden')) {
                                wrapper.classList.add('dora-hidden');
                            }
                            // Dazugehörige Labels ebenfalls ausblenden (über das 'for'-Attribut)
                            if (el.id) {
                                doc.querySelectorAll(`label[for="${el.id}"]`).forEach(lbl => {
                                    lbl.classList.add('dora-hidden');
                                    const lblWrapper = lbl.closest('.form-item') || lbl.closest('.form-wrapper') || lbl.parentElement;
                                    if (lblWrapper && !lblWrapper.classList.contains('dora-hidden')) {
                                        lblWrapper.classList.add('dora-hidden');
                                    }
                                });
                            }
                        }
                    });

                    // B: Alle Labels nach Textinhalt oder 'for'-Attribut durchsuchen
                    doc.querySelectorAll('label').forEach(label => {
                        if (matchesText(label.textContent) || matchesAttribute(label.getAttribute('for'))) {
                            const wrapper = label.closest('.form-item') || label.closest('.form-wrapper') || label.closest('td') || label.parentElement;
                            if (wrapper && !wrapper.classList.contains('dora-hidden')) {
                                wrapper.classList.add('dora-hidden');
                            }
                        }
                    });

                    // C: Alle Fieldset-Legenden nach Textinhalt durchsuchen
                    doc.querySelectorAll('legend, .fieldset-legend').forEach(legend => {
                        if (matchesText(legend.textContent)) {
                            const fieldset = legend.closest('fieldset') || legend.closest('.form-wrapper');
                            if (fieldset && !fieldset.classList.contains('dora-hidden')) {
                                fieldset.classList.add('dora-hidden');
                            }
                        }
                    });

                    // D: Tabellenköpfe nach Textinhalt durchsuchen (für ganze Spalten wie in Autorentabellen)
                    doc.querySelectorAll('th').forEach(th => {
                        if (matchesText(th.textContent)) {
                            const index = Array.from(th.parentElement.children).indexOf(th);
                            const table = th.closest('table');
                            if (table && index !== -1) {
                                th.classList.add('dora-hidden');
                                table.querySelectorAll(`tr`).forEach(tr => {
                                    const cells = tr.children;
                                    if (cells[index]) {
                                        cells[index].classList.add('dora-hidden');
                                    }
                                });
                            }
                        }
                    });

                    // E: Hilfstexte und Beschreibungen extrem aggressiv ausblenden
                    doc.querySelectorAll('.description, .help-block, div.description, p.help, .form-desc, .fieldset-description, [class*="description"]').forEach(el => {
                        el.style.display = 'none';
                        el.classList.add('dora-hidden');
                    });

                    // F: Formular restrukturieren (QC-Felder an den Anfang)
                    restructureFormForQc();
                };

                const restructureFormForQc = () => {
                    const form = doc.getElementById('islandora-xml-form-builder-form') || doc.querySelector('form');
                    if (!form) return;

                    let qcFieldWrapper = null;
                    let initialsFieldWrapper = null;

                    const isValidQcWrapper = (el) => {
                        if (!el) return false;
                        const tag = el.tagName;
                        if (tag === 'FORM' || tag === 'FIELDSET' || tag === 'TABLE' || tag === 'BODY' || tag === 'HTML') return false;
                        if (el.querySelector('fieldset, table, input[type="submit"], button[type="submit"]')) return false;
                        return true;
                    };

                    // Robust alle Text-Träger durchsuchen um QC-Felder sprachunabhängig zu extrahieren
                    doc.querySelectorAll('label, legend, .fieldset-legend, span, div, th, td').forEach(el => {
                        if (el.children.length > 0 && el.tagName !== 'LABEL' && el.tagName !== 'LEGEND' && !el.classList.contains('fieldset-legend')) return;

                        const text = el.textContent.toLowerCase();
                        // Quality Control Status Feld (Yes/No Dropdown)
                        const isQcStatus = text.includes('quality control') || text.includes('qualitätskontrolle') || text.includes('freigabe') || (text.includes('qc') && !text.includes('id') && !text.includes('by') && !text.includes('kürzel'));
                        if (isQcStatus && !text.includes('id') && !text.includes('by') && !text.includes('kürzel') && !text.includes('reviewer')) {
                            const candidate = el.closest('.form-item') || el.closest('.form-wrapper') || el.parentElement;
                            if (isValidQcWrapper(candidate)) {
                                qcFieldWrapper = candidate;
                            }
                        }
                        // Reviewer / Initials / QC ID Feld
                        const isInitials = text.includes('quality control id') || text.includes('kürzel') || text.includes('reviewer') || text.includes('user') || text.includes('quality control by') || text.includes('qc id') || text.includes('qc-id') || text.includes('qc_id');
                        if (isInitials) {
                            const candidate = el.closest('.form-item') || el.closest('.form-wrapper') || el.parentElement;
                            if (isValidQcWrapper(candidate)) {
                                initialsFieldWrapper = candidate;
                            }
                        }
                    });

                    // Manage die grüne QC-Card (einmalig erzeugen, falls Felder vorhanden sind)
                    let qcCard = doc.getElementById('dora-qc-header-card');
                    try {
                        if (qcFieldWrapper || initialsFieldWrapper) {
                            if (!qcCard) {
                                qcCard = doc.createElement('div');
                                qcCard.id = 'dora-qc-header-card';
                                qcCard.className = 'dora-qc-highlight-box';
                                qcCard.style.cssText = 'margin-top: 24px !important; margin-bottom: 24px !important;';

                                const qcH3 = doc.createElement('h3');
                                qcH3.innerHTML = '⚡ QC Status &amp; Freigabe (Quality Control)';
                                qcCard.appendChild(qcH3);

                                const fieldsContainer = doc.createElement('div');
                                fieldsContainer.id = 'dora-qc-fields-container';
                                fieldsContainer.style.cssText = 'display: flex; gap: 15px;';
                                qcCard.appendChild(fieldsContainer);

                                // Positionieren am Formularende (neben den Aktionen)
                                const formSubmitBtn = doc.querySelector('input[type="submit"], button[type="submit"], .form-submit');
                                const actionsContainer = doc.getElementById('edit-actions') || doc.querySelector('.form-actions') || (formSubmitBtn ? formSubmitBtn.closest('.form-actions') || formSubmitBtn.parentElement : null);

                                if (actionsContainer && actionsContainer.parentElement) {
                                    actionsContainer.parentElement.insertBefore(qcCard, actionsContainer);
                                } else {
                                    form.appendChild(qcCard);
                                }
                            }

                            const fieldsContainer = doc.getElementById('dora-qc-fields-container');

                            // Spiegelungs-Klon für QC Status (falls noch nicht erzeugt)
                            if (qcFieldWrapper && !doc.getElementById('dora-mirrored-qc-status')) {
                                const originalSelect = qcFieldWrapper.querySelector('select');
                                const originalInput = qcFieldWrapper.querySelector('input');

                                const wrapper = doc.createElement('div');
                                wrapper.id = 'dora-mirrored-qc-status';
                                wrapper.style.cssText = 'flex: 1; display: flex; flex-direction: column; gap: 4px;';

                                const label = doc.createElement('label');
                                label.textContent = 'Quality Control';
                                label.style.cssText = 'font-weight: 600; font-size: 11px; color: #475569; text-transform: uppercase; margin-bottom: 2px !important;';
                                wrapper.appendChild(label);

                                let myInput;
                                if (originalSelect) {
                                    myInput = doc.createElement('select');
                                    Array.from(originalSelect.options).forEach(opt => {
                                        const myOpt = doc.createElement('option');
                                        myOpt.value = opt.value;
                                        myOpt.textContent = opt.textContent;
                                        myOpt.selected = opt.selected;
                                        myInput.appendChild(myOpt);
                                    });
                                } else {
                                    myInput = doc.createElement('input');
                                    myInput.type = originalInput ? originalInput.type : 'text';
                                    myInput.value = originalInput ? originalInput.value : '';
                                }
                                myInput.style.cssText = 'width: 100% !important; padding: 6px 10px !important; border: 1px solid #cbd5e1 !important; border-radius: 6px !important; box-sizing: border-box !important; background: white !important;';
                                wrapper.appendChild(myInput);
                                fieldsContainer.appendChild(wrapper);

                                // Sync Gespiegelt -> Original
                                const syncToOriginal = () => {
                                    const target = originalSelect || originalInput;
                                    if (target) {
                                        target.value = myInput.value;
                                        target.dispatchEvent(new Event('change', { bubbles: true }));
                                        target.dispatchEvent(new Event('input', { bubbles: true }));
                                    }
                                };
                                myInput.addEventListener('change', syncToOriginal);
                                if (!originalSelect) {
                                    myInput.addEventListener('input', syncToOriginal);
                                }

                                // Periodischer Sync Original -> Gespiegelt
                                setInterval(() => {
                                    const target = originalSelect || originalInput;
                                    if (target && myInput && doc.activeElement !== myInput) {
                                        if (myInput.value !== target.value) {
                                            myInput.value = target.value;
                                        }
                                    }
                                }, 250);
                            }

                            // Original-Feld sichtbar lassen und highlighten
                            if (qcFieldWrapper) {
                                qcFieldWrapper.style.borderLeft = '3px solid #22c55e';
                                qcFieldWrapper.style.paddingLeft = '8px';
                            }

                            // Spiegelungs-Klon für QC ID (falls noch nicht erzeugt)
                            if (initialsFieldWrapper && !doc.getElementById('dora-mirrored-qc-id')) {
                                const originalInitialsInput = initialsFieldWrapper.querySelector('input');

                                const wrapper = doc.createElement('div');
                                wrapper.id = 'dora-mirrored-qc-id';
                                wrapper.style.cssText = 'flex: 1; display: flex; flex-direction: column; gap: 4px;';

                                const label = doc.createElement('label');
                                label.textContent = 'Quality Control ID (Kürzel)';
                                label.style.cssText = 'font-weight: 600; font-size: 11px; color: #475569; text-transform: uppercase; margin-bottom: 2px !important;';
                                wrapper.appendChild(label);

                                const myInitialsInput = doc.createElement('input');
                                myInitialsInput.type = 'text';
                                myInitialsInput.value = originalInitialsInput ? originalInitialsInput.value : '';
                                myInitialsInput.placeholder = 'z.B. cro';
                                myInitialsInput.style.cssText = 'width: 100% !important; padding: 6px 10px !important; border: 1px solid #cbd5e1 !important; border-radius: 6px !important; box-sizing: border-box !important; background: white !important;';
                                wrapper.appendChild(myInitialsInput);
                                fieldsContainer.appendChild(wrapper);

                                // Sync Gespiegelt -> Original
                                myInitialsInput.addEventListener('input', () => {
                                    if (originalInitialsInput) {
                                        originalInitialsInput.value = myInitialsInput.value;
                                        originalInitialsInput.dispatchEvent(new Event('input', { bubbles: true }));
                                        originalInitialsInput.dispatchEvent(new Event('change', { bubbles: true }));
                                    }
                                });

                                // Periodischer Sync Original -> Gespiegelt
                                setInterval(() => {
                                    if (originalInitialsInput && myInitialsInput && doc.activeElement !== myInitialsInput) {
                                        if (myInitialsInput.value !== originalInitialsInput.value) {
                                            myInitialsInput.value = originalInitialsInput.value;
                                        }
                                    }
                                }, 250);
                            }

                            // Original-Feld sichtbar lassen und highlighten
                            if (initialsFieldWrapper) {
                                initialsFieldWrapper.style.borderLeft = '3px solid #22c55e';
                                initialsFieldWrapper.style.paddingLeft = '8px';
                            }
                        }
                    } catch (cardError) {
                        console.error('Error rendering DORA QC Card at bottom:', cardError);
                    }

                    // Wichtige Abschnitte suchen
                    let doiFieldset = null;
                    let titleFieldset = null;
                    let authorFieldset = null;

                    doc.querySelectorAll('legend, .fieldset-legend').forEach(legend => {
                        const text = legend.textContent.toLowerCase();
                        if (text.includes('identifier') || text.includes('identifikator') || text.includes('doi')) {
                            doiFieldset = legend.closest('fieldset') || legend.closest('.form-wrapper');
                        } else if (text.includes('title') || text.includes('titel')) {
                            titleFieldset = legend.closest('fieldset') || legend.closest('.form-wrapper');
                        } else if (text.includes('author') || text.includes('autoren')) {
                            authorFieldset = legend.closest('fieldset') || legend.closest('.form-wrapper');
                        }
                    });

                    // Physisches Umsortieren am Anfang des Formulars (einmalig markiert per Attribut)
                    const next = form.firstChild;

                    if (doiFieldset && doiFieldset.getAttribute('data-dora-moved') !== 'true') {
                        form.insertBefore(doiFieldset, next);
                        doiFieldset.style.borderLeft = '4px solid #3b82f6';
                        doiFieldset.style.paddingLeft = '12px';
                        doiFieldset.setAttribute('data-dora-moved', 'true');
                    }
                    if (titleFieldset && titleFieldset.getAttribute('data-dora-moved') !== 'true') {
                        form.insertBefore(titleFieldset, doiFieldset ? doiFieldset.nextSibling : next);
                        titleFieldset.style.borderLeft = '4px solid #3b82f6';
                        titleFieldset.style.paddingLeft = '12px';
                        titleFieldset.setAttribute('data-dora-moved', 'true');
                    }
                    if (authorFieldset && authorFieldset.getAttribute('data-dora-moved') !== 'true') {
                        form.insertBefore(authorFieldset, titleFieldset ? titleFieldset.nextSibling : (doiFieldset ? doiFieldset.nextSibling : next));
                        authorFieldset.style.borderLeft = '4px solid #3b82f6';
                        authorFieldset.style.paddingLeft = '12px';
                        authorFieldset.classList.add('dora-authors-fieldset');
                        authorFieldset.setAttribute('data-dora-moved', 'true');
                    }

                    // Highlight specific QC-critical micro-fields (Corresponding Author, Start Page, Peer Review, Publication Status)
                    const highlightField = (el, isFieldset = false) => {
                        if (!el || el.getAttribute('data-dora-highlighted') === 'true') return;
                        el.style.borderLeft = '3px solid #f59e0b'; // Amber Accent
                        el.style.background = '#fffbeb';          // Soft warm amber background
                        el.style.padding = isFieldset ? '10px 15px' : '6px 12px';
                        el.style.margin = isFieldset ? '12px 0 !important' : '8px 0 !important';
                        el.style.borderRadius = '0 6px 6px 0';
                        el.style.boxShadow = '0 1px 2px rgba(245, 158, 11, 0.05)';
                        el.setAttribute('data-dora-highlighted', 'true');
                    };

                    doc.querySelectorAll('label').forEach(label => {
                        const text = label.textContent.toLowerCase();
                        const isCorrespondingAuthor = text.includes('corresponding') && (text.includes('author') || text.includes('autor'));
                        const isStartPage = (text.includes('start') || text.includes('anfangs') || text.includes('erste')) && (text.includes('page') || text.includes('seite')) && !text.includes('range');
                        const isPeerReview = text.includes('peer') && (text.includes('review') || text.includes('reviewed') || text.includes('begutachtet'));
                        const isPubStatus = (text.includes('publication') || text.includes('publikation') || text.includes('publishing')) && text.includes('status');

                        if (isCorrespondingAuthor || isStartPage || isPeerReview || isPubStatus) {
                            const item = label.closest('.form-item') || label.parentElement;
                            if (item) highlightField(item, false);
                        }
                    });

                    doc.querySelectorAll('legend, .fieldset-legend').forEach(legend => {
                        const text = legend.textContent.toLowerCase();
                        const isCorrespondingAuthor = text.includes('corresponding') && (text.includes('author') || text.includes('autor'));
                        const isStartPage = (text.includes('start') || text.includes('anfangs') || text.includes('erste')) && (text.includes('page') || text.includes('seite')) && !text.includes('range');
                        const isPeerReview = text.includes('peer') && (text.includes('review') || text.includes('reviewed') || text.includes('begutachtet'));
                        const isPubStatus = (text.includes('publication') || text.includes('publikation') || text.includes('publishing')) && text.includes('status');

                        if (isCorrespondingAuthor || isStartPage || isPeerReview || isPubStatus) {
                            const fieldset = legend.closest('fieldset') || legend.closest('.form-wrapper');
                            if (fieldset) highlightField(fieldset, true);
                        }
                    });

                    // Speichern-Button stylen
                    const submitBtn = doc.getElementById('edit-submit') || doc.querySelector('input[type="submit"][value="Save"]') || doc.querySelector('input[type="submit"][value="Speichern"]');
                    if (submitBtn) {
                        submitBtn.style.cssText = 'background: #22c55e !important; color: white !important; border: 1px solid #16a34a !important; padding: 10px 20px !important; border-radius: 6px !important; font-weight: bold !important; font-size: 13px !important; cursor: pointer !important; margin-top: 15px !important; width: 100% !important; transition: background 0.15s !important;';
                    }
                };
                hideSpecificFields();
                const hideInterval = setInterval(hideSpecificFields, 500);
                setTimeout(() => clearInterval(hideInterval), 15000);

                // Prüfen, ob bereits freigegeben (QC = Yes) und ggf. in der Sidebar markieren
                try {
                    let isAlreadyApproved = false;
                    const docLabels = doc.querySelectorAll('label');
                    docLabels.forEach(l => {
                        const text = l.textContent.toLowerCase();
                        if (text.includes('quality control') && !text.includes('id') && !text.includes('by') && !text.includes('kürzel')) {
                            const inputId = l.getAttribute('for');
                            if (inputId) {
                                const el = doc.getElementById(inputId);
                                if (el) {
                                    if (el.tagName === 'SELECT' && el.value === 'Yes') {
                                        isAlreadyApproved = true;
                                    } else if (el.tagName === 'INPUT' && el.value.toLowerCase().includes('yes')) {
                                        isAlreadyApproved = true;
                                    }
                                }
                            }
                        }
                    });

                    if (!isAlreadyApproved) {
                        const select = doc.querySelector('select[name*="quality_control"]') || doc.querySelector('select[id*="quality_control"]');
                        if (select && select.value === 'Yes') {
                            isAlreadyApproved = true;
                        }
                    }

                    if (isAlreadyApproved) {
                        markPidAsApproved(pid);
                    }
                } catch (err) {
                    console.warn("Error scanning for pre-existing QC status:", err);
                }

                // We add a listener to the form inside the iframe to catch successful submits
                const form = doc.getElementById('islandora-ingest-form') || doc.querySelector('.node-form') || doc.getElementById('islandora-xml-form-builder-form');
                if (form) {
                    form.addEventListener('submit', () => {
                        // Optimistically mark as done
                        const item = document.getElementById(`batch-qc-item-${currentPid.replace(':', '-')}`);
                        if (item && !item.innerHTML.includes('✅')) {
                            item.innerHTML = `✅ <strong>${currentPid}</strong>`;
                        }
                    });
                }

            } catch (e) {
                console.log("Iframe cross-origin restriction or not ready:", e);
            }
        };
        // Form Iframe src set AFTER onload to ensure event triggers reliably!
        middleIframe.src = `/${inst}/islandora/object/${pid}/lib4ridora_edit_mods`;
    }

    function approveCurrentForm() {
        if (!currentPid) return;

        chrome.storage.local.get({ qcInitials: '' }, function (result) {
            const initials = result.qcInitials.trim();
            if (!initials) {
                alert("Bitte legen Sie zuerst Ihr Kürzel für die Qualitätskontrolle in den DORA Helper Einstellungen fest!");
                return;
            }

            // Sofortiges visuelles Feedback auf dem QC-Button
            approveBtn.textContent = '✓ QC auf Yes gesetzt!';
            approveBtn.style.background = '#15803d';
            approveBtn.style.boxShadow = '0 2px 4px rgba(21, 128, 61, 0.4)';

            // PID sofort in der Sidebar als freigegeben markieren
            markPidAsApproved(currentPid);

            try {
                const doc = middleIframe.contentDocument;
                if (!doc) {
                    alert("Kann nicht auf das Formular zugreifen. Möglicherweise noch nicht geladen.");
                    return;
                }

                let qcField = null;
                let initialsField = null;

                // 1. Suche nach Labels
                const labels = doc.querySelectorAll('label');
                labels.forEach(l => {
                    const text = l.textContent.toLowerCase();

                    // Quality Control Feld finden (Dropdown bevorzugt)
                    if (text.includes('quality control') && !text.includes('id') && !text.includes('by') && !text.includes('kürzel')) {
                        const inputId = l.getAttribute('for');
                        if (inputId) {
                            const el = doc.getElementById(inputId);
                            if (el && el.tagName === 'SELECT') {
                                qcField = el;
                            } else if (!qcField && el) {
                                qcField = el;
                            }
                        }
                    }

                    // Kürzel / User Feld finden (Quality Control ID Textfeld)
                    if (text.includes('quality control id') || text.includes('kürzel') || text.includes('reviewer') || text.includes('user') || text.includes('quality control by') || text.includes('qc id')) {
                        const inputId = l.getAttribute('for');
                        if (inputId) initialsField = doc.getElementById(inputId);
                    }
                });

                // Fallbacks für Quality Control (bevorzuge Dropdown!)
                if (!qcField) {
                    const select = doc.querySelector('select[name*="quality_control"]') || doc.querySelector('select[id*="quality_control"]');
                    if (select) qcField = select;
                }

                if (qcField) {
                    qcField.value = 'Yes';
                    qcField.dispatchEvent(new Event('change', { bubbles: true }));
                    qcField.dispatchEvent(new Event('input', { bubbles: true }));
                    qcField.style.backgroundColor = '#d4edda'; // Highlight
                } else {
                    console.warn("DORA Helper: Quality Control dropdown not found automatically.");
                }

                // Fallbacks für Kürzel
                if (!initialsField) {
                    // Das Textfeld für ID / Reviewer
                    initialsField = doc.querySelector('input[type="text"][name*="quality_control"]') || doc.querySelector('input[name*="reviewer"]') || doc.querySelector('input[name*="kuerzel"]') || doc.querySelector('input[name*="qc_id"]');
                }

                if (initialsField) {
                    let currentVal = initialsField.value || '';
                    if (currentVal && !currentVal.includes(initials)) {
                        // Append if not already there
                        initialsField.value = currentVal.trim() + ' ' + initials;
                    } else if (!currentVal) {
                        initialsField.value = initials;
                    }
                    initialsField.dispatchEvent(new Event('input', { bubbles: true }));
                    initialsField.style.backgroundColor = '#d4edda';
                } else {
                    console.warn("DORA Helper: Initials field not found automatically.");
                }

                if (!qcField && !initialsField) {
                    alert("Die Felder 'Quality control' und 'Kürzel' konnten im Formular nicht automatisch gefunden werden. Bitte füllen Sie sie manuell aus und teilen Sie dem Entwickler die exakten Feld-Namen mit.");
                }

                // Find submit button
                const submitBtn = doc.getElementById('edit-submit') || doc.querySelector('input[type="submit"][value="Save"]') || doc.querySelector('input[type="submit"][value="Speichern"]');

                if (submitBtn) {
                    // Opt-in Auto-Submit (hier scrollen wir nur hin, damit der User nochmal prüfen kann)
                    submitBtn.scrollIntoView({ behavior: "smooth", block: "center" });
                    submitBtn.style.border = "3px solid #28a745";
                } else {
                    alert("Speichern-Button nicht gefunden!");
                }

            } catch (e) {
                console.error(e);
                alert("Fehler beim Approve-Vorgang. " + e.message);
            }
        });
    }
}
