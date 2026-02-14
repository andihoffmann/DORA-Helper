// content.js - Dora Lib4ri Helper
// Version: 2.50 - internal: 2.62

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
    // SECURITY / PERFORMANCE: Only run on Edit or Ingest Forms
    if (!isEditPage()) return;

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
    injectDoraAutocompletes();

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
    let box = createFloatingBox();
    box.replaceChildren(); // Reset

    // 1. Close Button
    const closeBtn = createEl('div', 'dora-close-btn', '×');
    closeBtn.id = 'dora-box-close';
    closeBtn.style.cssText = 'position: absolute; top: 5px; right: 10px; cursor: pointer; font-size: 1.2em; color: #666;';
    closeBtn.addEventListener('click', () => box.remove());
    box.appendChild(closeBtn);

    // 2. Header
    const header = createEl('div', 'dora-meta-header');

    // Logo
    const logo = createEl('img');
    logo.src = chrome.runtime.getURL('icons/logo-48.png');
    logo.style.cssText = 'float:left; width:32px; height:32px; margin-right:10px;';
    header.appendChild(logo);

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

    // 5c. Data Quality Checker (Scopus / DOAJ / Crossref)
    if (data.scopus || data.doaj || data.crossrefLicense) {
        const checkerDiv = createEl('div', 'dora-checker-box');
        checkerDiv.style.cssText = 'margin-top:10px; padding:8px; background:#f8f9fa; border:1px solid #dee2e6; border-radius:4px; font-size:0.9em;';

        const headerRow = createEl('div', '', '🔍 Data Cross-Check');
        headerRow.style.fontWeight = 'bold';
        headerRow.style.marginBottom = '5px';
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
    btnContainer.style.gap = '8px';

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
    // Loop to ensure we reach the required count
    // We use a safe limit (requiredCount + 2) to prevent infinite loops if something breaks
    let safetyLimit = requiredCount + 5;

    while (safetyLimit > 0) {
        safetyLimit--;

        // 1. FRESH QUERY: Always re-query the container because Drupal AJAX replaces it
        const container = document.querySelector(containerSelector + ' .islandora-form-fieldpanel-panel');
        if (!container) {
            console.warn('DORA Helper: Container not found ' + containerSelector);
            return;
        }

        // 2. CHECK COUNT
        const currentRows = container.querySelectorAll('.islandora-form-fieldpanel-pane').length;
        if (currentRows >= requiredCount) {
            console.log("DORA Helper: All rows present (" + currentRows + ")");
            return; // Done!
        }

        // 3. FIND BUTTON
        const addButton = container.querySelector('.fieldpanel-add.form-submit');
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
                const newCount = document.querySelectorAll(containerSelector + ' .islandora-form-fieldpanel-pane').length;
                if (newCount > currentRows) {
                    obs.disconnect();
                    resolve();
                }
            });
            // Observer on the specific container (which might be replaced, but we observe the parent if possible or the container itself)
            // Ideally we'd observe the parent of the container, but the container itself usually mutates children.
            // If the container ITSELF is replaced, the observer might die. 
            // Better: Observe the wrapper if possible, or just accept the timeout fallback.
            observer.observe(container, { childList: true, subtree: true });

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

    liItem.addEventListener('dragstart', function (e) {
        if (!isMouseOverHandle) { e.preventDefault(); return false; }
        dragSrcEl = this;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
        this.classList.add('is-dragging');
    });

    liItem.addEventListener('dragend', function () {
        this.classList.remove('is-dragging');
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

// --- DORA AUTOCOMPLETE INJECTION (Direct Solr Access) ---
function injectDoraAutocompletes() {
    const fields = [
        { id: 'edit-confinfo-confname', solrField: 'mods_name_conference_ms' },
        { id: 'edit-host-titleinfo-title', solrField: 'mods_relatedItem_host_titleInfo_title_ms' },
        { id: 'edit-host-series-titleinfo-title', solrField: 'mods_relatedItem_host_relatedItem_series_titleInfo_title_ms' }
    ];

    fields.forEach(field => {
        const input = document.getElementById(field.id);
        if (!input || input.dataset.doraAutocompleteAttached) return;

        console.log('DORA Helper: Attaching autocomplete to', field.id, 'isTextarea:', input.tagName.toLowerCase() === 'textarea');
        input.dataset.doraAutocompleteAttached = "true";
        const isTextarea = input.tagName.toLowerCase() === 'textarea';

        if (isTextarea) {
            // Custom dropdown for textarea elements
            attachTextareaAutocomplete(input, field);
        } else {
            // Native datalist for input elements
            attachInputAutocomplete(input, field);
        }
    });
}

// Native datalist autocomplete for <input> elements
function attachInputAutocomplete(input, field) {
    const listId = `datalist-${field.id}`;
    let dataList = document.getElementById(listId);
    if (!dataList) {
        dataList = createEl('datalist');
        dataList.id = listId;
        input.parentNode.appendChild(dataList);
    }

    input.setAttribute('list', listId);
    input.setAttribute('autocomplete', 'off');

    let debounceTimer;
    let matchTimer; // Timer for exact match delay

    // Ensure we track last processed query on the element itself to persist across re-attachments (if any)
    if (typeof input.dataset.doraLastAutoQuery === 'undefined') {
        input.dataset.doraLastAutoQuery = '';
    }

    // Pass event 'e' to check inputType
    input.addEventListener('input', (e) => {
        const query = input.value.trim();
        if (query.length < 3) {
            dataList.replaceChildren();
            return;
        }

        // Check for immediate match ONLY if it looks like a specific selection (not normal typing)
        // 'insertReplacementText' is used by Chrome when selecting from a datalist
        // We also check !e.inputType for compatibility (some browsers or paste operations)
        const isSelection = !e.inputType || e.inputType === 'insertReplacementText';

        if (field.id === 'edit-confinfo-confname' && isSelection) {
            const options = Array.from(dataList.options).map(o => o.value);
            if (options.includes(query)) {
                // Exact match found via SELECTION!
                if (matchTimer) clearTimeout(matchTimer);

                // We can use a shorter delay here because the user explicitly selected it
                console.log("DORA Helper: List selection detected. Triggering in 200ms...", query);
                matchTimer = setTimeout(() => {
                    if (query !== input.dataset.doraLastAutoQuery) {
                        fetchConferenceDetails(query);
                        input.dataset.doraLastAutoQuery = query;
                    }
                    matchTimer = null;
                }, 200);

                return;
            }
        }

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            fetchSolrSuggestions(field.solrField, query, (results) => {
                dataList.replaceChildren();
                results.forEach(name => {
                    const option = document.createElement('option');
                    option.value = name.trim();
                    dataList.appendChild(option);
                });
                // UI Refresh Hack
                input.removeAttribute('list');
                input.setAttribute('list', listId);

                // REMOVED: Do not check for exact match in async results. 
                // This prevents the modal from popping up while typing just because a prefix matched.
                // The user must select from the list or hit enter/tab (change event).
            });
        }, 400);
    });

    // Keep change event as fallback (Enter key or Blur)
    input.addEventListener('change', () => {
        const val = input.value.trim();
        if (val.length > 3) {
            // Check if it's the conference field
            if (field.id === 'edit-confinfo-confname') {
                // Rely on deduplication in showConferenceConfirmation to handle overlaps
                // AND check dataset to avoid re-opening on blur if already handled
                if (!matchTimer && val !== input.dataset.doraLastAutoQuery) {
                    console.log("DORA Helper: Change event triggering fetch for:", val);
                    fetchConferenceDetails(val);
                    input.dataset.doraLastAutoQuery = val;
                } else {
                    console.log("DORA Helper: Change event skipped (timer active or already processed):", val);
                }
            }
        }
    });
}

// Custom dropdown autocomplete for <textarea> elements
function attachTextareaAutocomplete(textarea, field) {
    const wrapper = textarea.closest('.form-textarea-wrapper') || textarea.parentNode;
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
            right: '0',
            maxHeight: '200px',
            overflowY: 'auto',
            backgroundColor: '#fff',
            border: '1px solid #ccc',
            borderTop: 'none',
            borderRadius: '0 0 4px 4px',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
            zIndex: '9999',
            display: 'none'
        });
        wrapper.appendChild(dropdown);
    }

    let debounceTimer;
    let selectedIndex = -1;

    textarea.addEventListener('input', () => {
        const query = textarea.value.trim();
        console.log('DORA Helper: Textarea input event', { fieldId: field.id, query, queryLength: query.length });
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
                        fontSize: '13px'
                    });
                    item.addEventListener('mouseenter', () => {
                        item.style.backgroundColor = '#f0f0f0';
                    });
                    item.addEventListener('mouseleave', () => {
                        item.style.backgroundColor = '#fff';
                    });
                    item.addEventListener('click', () => {
                        textarea.value = name.trim();
                        dropdown.style.display = 'none';
                        textarea.focus();
                        textarea.dispatchEvent(new Event('change', { bubbles: true }));

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
    textarea.addEventListener('keydown', (e) => {
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
            textarea.value = items[selectedIndex].textContent;
            dropdown.style.display = 'none';
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (e.key === 'Escape') {
            dropdown.style.display = 'none';
        }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!wrapper.contains(e.target)) {
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

                            if (labInput && !labInput.value.trim() && !isSpecialGroup) {
                                markError(labInput, true, 'Laboratory sollte ausgefüllt sein, wenn Group vorhanden ist.');
                                errors.push(`<b>Author ${idx + 1} (Lab)</b>: Laboratory fehlt (Group ist gesetzt).`);
                            }
                            // FIXED: Also apply isSpecialGroup exception to Division
                            if (divisionInput && !divisionInput.value.trim() && !isSpecialGroup) {
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
                if (firstError) firstError.scrollIntoView({ behavior: "smooth", block: "center" });
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
function isEditPage() {
    // Check for specific form IDs or Classes typical for DORA/Islandora Edit Forms
    if (document.getElementById('islandora-ingest-form')) return true;
    if (document.querySelector('.node-form')) return true;
    if (document.getElementById('edit-identifiers-doi')) return true; // Strong indicator
    
    // Check URL patterns
    const loc = window.location.href;
    if (loc.includes('/ingest') || loc.includes('/edit') || loc.includes('/manage')) return true;

    return false;
}
