// content.js - Dora Lib4ri Helper
// Version: 2.57

let observerTimeout = null;
let dragSrcEl = null;
let lastAutoFetchedDoi = ""; 
let cachedExceptions = []; 
let isMouseOverHandle = false; 

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
        alert("Bitte eine PDF-Datei auswählen.");
        return;
    }

    // Show loading state in the dropzone
    const dropZone = document.querySelector('.dora-pdf-drop');
    if (dropZone) {
        dropZone.innerHTML = '⏳ Analysiere...';
        dropZone.style.backgroundColor = '#fff3cd';
    }

    // Use 127.0.0.1 as requested
    const API_URL = "http://127.0.0.1:7860/analyze";
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
            confirmAndFillPdfData(data);
        } else {
            throw new Error(data.message || "Unbekannter Fehler");
        }

    } catch (error) {
        // Error handling: Show in dropzone only, no alert, no result box replacement
        if (dropZone) {
            dropZone.innerHTML = '❌ Fehler (Docker?)';
            dropZone.title = error.message; // Show full error on hover
            dropZone.style.backgroundColor = '#f8d7da';
            dropZone.style.color = '#721c24';

            setTimeout(() => {
                dropZone.innerHTML = '📄 PDF hier ablegen';
                dropZone.style.backgroundColor = '#f9f9f9';
                dropZone.style.color = '#666';
                dropZone.title = '';
            }, 3000);
        }
        console.error("PDF Analyse fehlgeschlagen:", error);
    }
}

async function handlePdfUrl(url) {
    // For URL analysis, we usually show the loading box because there is no dropzone to update
    // But user wants no error in result box.
    // We will use a temporary toast or just console log if it fails?
    // Or update the button text?

    // Let's try to find the button that triggered this
    const buttons = document.querySelectorAll('button');
    let triggerBtn = null;
    for (const btn of buttons) {
        if (btn.innerText.includes('PDF von URL')) {
            triggerBtn = btn;
            break;
        }
    }

    if (triggerBtn) {
        const originalText = triggerBtn.innerHTML;
        triggerBtn.innerHTML = '⏳ Lade...';
        triggerBtn.disabled = true;

        chrome.runtime.sendMessage({ action: "analyzePdfUrl", pdfUrl: url }, (response) => {
            triggerBtn.disabled = false;
            if (response && response.success) {
                triggerBtn.innerHTML = originalText;
                confirmAndFillPdfData(response.data);
            } else {
                triggerBtn.innerHTML = '❌ Fehler';
                triggerBtn.title = response ? response.error : "Unbekannter Fehler";
                setTimeout(() => {
                    triggerBtn.innerHTML = originalText;
                    triggerBtn.title = '';
                }, 3000);
                console.error("PDF URL Analyse fehlgeschlagen:", response ? response.error : "Unknown");
            }
        });
    } else {
        // Fallback if button not found (should not happen)
        chrome.runtime.sendMessage({ action: "analyzePdfUrl", pdfUrl: url }, (response) => {
            if (response && response.success) {
                confirmAndFillPdfData(response.data);
            } else {
                console.error("PDF URL Analyse fehlgeschlagen:", response ? response.error : "Unknown");
            }
        });
    }
}

function confirmAndFillPdfData(data) {
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
        // alert("Keine relevanten Daten im PDF gefunden."); // User might not want this alert either?
        // But this is a "success" case with no data.
        console.log("Keine relevanten Daten im PDF gefunden.");
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
    msgDiv.style.cssText = 'color:#e53e3e; padding:10px; font-weight:bold; font-family:sans-serif;';
    
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
    titleText = titleText.replace(/<[^>]*>?/gm, '');

    const title = createEl('div', 'dora-meta-title', titleText);
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
    badgesDiv.style.marginBottom = '15px';
    
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

    // OpenAlex Check
    if (openalex && openalex.authorships) {
        const targetInstitutions = [
            "Paul Scherrer Institute",
            "Swiss Federal Institute of Aquatic Science and Technology",
            "Swiss Federal Laboratories for Materials Science and Technology",
            "Swiss Federal Institute for Forest, Snow and Landscape Research"
        ];
        const targetRORs = [
            "https://ror.org/0207ad741", // PSI
            "https://ror.org/02j624c96", // Eawag
            "https://ror.org/0335b2t11", // Empa
            "https://ror.org/02d765t03"  // WSL
        ];
        const targetAcronyms = ["PSI", "Eawag", "Empa", "WSL"];

        let correspondingAuthorFound = false;
        let isAffiliated = false;
        let affiliatedInst = "";

        for (const authorship of openalex.authorships) {
            if (authorship.is_corresponding) {
                correspondingAuthorFound = true;
                for (const inst of authorship.institutions) {
                    // Check Name
                    let idx = targetInstitutions.indexOf(inst.display_name);

                    // Check ROR if name match failed
                    if (idx === -1 && inst.ror) {
                        idx = targetRORs.indexOf(inst.ror);
                    }

                    if (idx !== -1) {
                        isAffiliated = true;
                        affiliatedInst = targetAcronyms[idx];
                        break;
                    }
                }
                if (isAffiliated) break;
            }
        }

        if (correspondingAuthorFound) {
            const oaBadge = createEl('div', 'dora-oa-check');
            oaBadge.style.marginTop = '10px';
            oaBadge.style.padding = '5px';
            oaBadge.style.borderRadius = '4px';
            oaBadge.style.fontSize = '0.9em';
            oaBadge.title = "Vorschlag basierend auf OpenAlex-Daten. Bitte überprüfen."; // Tooltip

            if (isAffiliated) {
                oaBadge.style.backgroundColor = '#d4edda';
                oaBadge.style.color = '#155724';
                oaBadge.innerHTML = `✅ Corr. author <b>${affiliatedInst}</b> <span style="font-size:0.85em; opacity:0.7;">(OpenAlex)</span>`;
            } else {
                oaBadge.style.backgroundColor = '#f8d7da';
                oaBadge.style.color = '#721c24';
                oaBadge.innerHTML = `❌ Corr. author: <b>External</b> <span style="font-size:0.85em; opacity:0.7;">(OpenAlex)</span>`;
            }
            box.appendChild(oaBadge);
        }
    }

    // 5. Buttons Container
    const btnContainer = createEl('div', 'dora-btn-container');

    // Check if it is a Book Chapter
    const pubTypeEl = document.getElementById('edit-publication-type');
    const isBookChapter = pubTypeEl && pubTypeEl.value.toLowerCase().includes('book chapter');

    if (isBookChapter) {
        const importBtn = createEl('button', 'dora-box-btn btn-hybrid-action');
        importBtn.id = 'dora-import-book-chapter';
        importBtn.innerHTML = '<span style="margin-right:5px;">📚</span> Metadaten importieren';
        importBtn.title = "Importiert Titel, Buch-Titel, Seiten, Jahr, Verlag, Autoren, Editoren und Abstract aus Crossref";
        importBtn.addEventListener('click', async () => {
            importBtn.disabled = true;
            importBtn.innerHTML = '<span>⏳</span> Import läuft...';
            try {
                await fillBookChapterMetadata(meta);
                importBtn.innerHTML = '✅ Importiert!';
                setTimeout(() => {
                    importBtn.disabled = false;
                    importBtn.innerHTML = '<span style="margin-right:5px;">📚</span> Metadaten importieren';
                }, 2000);
            } catch (e) {
                renderErrorBox(e.message);
                importBtn.disabled = false;
                importBtn.innerHTML = '<span style="margin-right:5px;">📚</span> Metadaten importieren';
            }
        });
        btnContainer.appendChild(importBtn);
    }

    // Hybrid Button
    if (isHybrid) {
        const hybridBtn = createEl('button', 'dora-box-btn btn-hybrid-action');
        hybridBtn.id = 'dora-add-hybrid-btn';
        hybridBtn.title = "Fügt #hybrid in Additional Information ein";
        hybridBtn.innerHTML = '<span style="margin-right:5px;">📝</span> #hybrid setzen';
        hybridBtn.addEventListener('click', insertHybridTag);
        btnContainer.appendChild(hybridBtn);
    }

    // PDF Button
    const pdfUrl = bestLoc.url_for_pdf;
    if (pdfUrl) {
        const pdfBtn = createEl('a', 'dora-box-btn btn-secondary');
        pdfBtn.href = pdfUrl;
        pdfBtn.target = '_blank';
        pdfBtn.innerHTML = '<span style="margin-right:5px;">📄</span> PDF ansehen';
        btnContainer.appendChild(pdfBtn);
    }

    // Policy Button
    const issn = meta.ISSN ? meta.ISSN[0] : null;
    if (issn) {
        const policyBtn = createEl('a', 'dora-box-btn btn-secondary');
        policyBtn.href = `https://openpolicyfinder.jisc.ac.uk/search?search=${issn}`;
        policyBtn.target = '_blank';
        policyBtn.innerHTML = '<span style="margin-right:5px;">🛡️</span> Policy prüfen';
        btnContainer.appendChild(policyBtn);
    }

    // DOI Link
    const doiLink = createEl('a', 'dora-box-btn btn-secondary', '🌐 Zum Artikel');
    doiLink.href = `https://doi.org/${meta.DOI}`;
    doiLink.target = '_blank';
    doiLink.style.fontSize = '0.85em';
    doiLink.style.color = '#888';
    btnContainer.appendChild(doiLink);

    box.appendChild(btnContainer);

    // 5b. Parallel: Deep Scan on Publisher Site (Zotero/Meta-Tags)
    if (meta.DOI) {
        findPublisherPdf(meta.DOI, btnContainer, pdfUrl);
    }

    // 6. PDF Drop Zone (Moved to bottom of result box)
    const dropZone = createEl('div', 'dora-pdf-drop', '📄 PDF hier ablegen (Analyse)');
    dropZone.style.cssText = 'border: 2px dashed #ccc; padding: 10px; border-radius: 4px; cursor: pointer; color: #666; font-size: 0.9em; background: #f9f9f9; margin-top: 15px; text-align: center;';

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

    // Add PDF URL Button if available
    function appendPdfUrlBtn(box) {
        if (pdfUrl) {
            const pdfUrlBtn = createEl('button', 'dora-box-btn btn-secondary');
            pdfUrlBtn.innerHTML = '<span style="margin-right:5px;">⚡</span> PDF von URL analysieren';
            pdfUrlBtn.style.marginTop = '10px';
            pdfUrlBtn.style.width = '100%';
            pdfUrlBtn.addEventListener('click', () => handlePdfUrl(pdfUrl));
            box.appendChild(pdfUrlBtn);
        }
    }
    appendPdfUrlBtn(box);

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
    hint.innerHTML = '📝 Bearbeiten möglich. <b>☰ Griff ziehen</b> zum Sortieren.';
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
function findPublisherPdf(doi, btnContainer, existingPdfUrl) {
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
            // Prüfen, ob Button schon existiert (vermeidet Duplikate bei schnellen Re-Renders)
            if (document.getElementById('dora-publisher-pdf-btn')) return;

            const pubPdfBtn = createEl('a', 'dora-box-btn btn-secondary');
            pubPdfBtn.id = 'dora-publisher-pdf-btn';
            pubPdfBtn.href = foundPdfUrl;
            pubPdfBtn.target = '_blank';
            pubPdfBtn.innerHTML = '<span style="margin-right:5px;">📄</span> PDF (Verlag)';
            pubPdfBtn.title = "Gefunden via Meta-Tags auf der Verlagsseite";
            pubPdfBtn.style.border = "1px solid #2b6cb0"; // Leicht anderes Blau zur Unterscheidung
            pubPdfBtn.style.color = "#2b6cb0";

            // Optional: Analyze Button für diesen neuen Link hinzufügen
            const analyzeBtn = createEl('button', 'dora-box-btn btn-secondary');
            analyzeBtn.innerHTML = '⚡';
            analyzeBtn.title = "Dieses Verlags-PDF analysieren";
            analyzeBtn.style.marginLeft = '4px';
            analyzeBtn.style.padding = '5px 8px';
            analyzeBtn.onclick = () => handlePdfUrl(foundPdfUrl);

            // Button an passender Stelle einfügen (vor dem DOI Link, nach dem Unpaywall PDF)
            const doiLink = Array.from(btnContainer.children).find(el => el.innerText.includes('Zum Artikel'));
            if (doiLink) {
                btnContainer.insertBefore(pubPdfBtn, doiLink);
                btnContainer.insertBefore(analyzeBtn, doiLink);
            } else {
                btnContainer.appendChild(pubPdfBtn);
                btnContainer.appendChild(analyzeBtn);
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

                            if (!isNaN(pYear) && (currentYear - pYear >= 3)) {
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
                        if (labInput && !labInput.value.trim()) {
                             markError(labInput, true, 'Laboratory sollte ausgefüllt sein, wenn Group vorhanden ist.');
                             errors.push(`<b>Author ${idx + 1} (Lab)</b>: Laboratory fehlt (Group ist gesetzt).`);
                        }
                        if (divisionInput && !divisionInput.value.trim()) {
                             markError(divisionInput, true, 'Division sollte ausgefüllt sein, wenn Group vorhanden ist.');
                             errors.push(`<b>Author ${idx + 1} (Division)</b>: Division fehlt (Group ist gesetzt).`);
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
    let box = document.getElementById('dora-error-summary');

    if (errors.length === 0) {
        if (box) box.style.display = 'none';
        return;
    }

    if (!box) {
        box = createEl('div', 'dora-error-summary');
        box.id = 'dora-error-summary';
        document.body.appendChild(box);
        // Styles
        Object.assign(box.style, {
            position: 'fixed', bottom: '20px', right: '20px', width: '320px', zIndex: '9999',
            backgroundColor: '#fff5f5', border: '1px solid #e53e3e', borderLeft: '5px solid #e53e3e',
            borderRadius: '5px', padding: '15px', boxShadow: '0 5px 20px rgba(0,0,0,0.2)',
            fontFamily: 'sans-serif', fontSize: '13px', color: '#2d3748'
        });
    }

    box.style.display = 'block';
    box.innerHTML = '';

    // Header
    const header = createEl('div', '', '');
    header.style.cssText = "display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;";

    const title = createEl('strong', '', `⚠️ ${errors.length} Probleme gefunden:`);
    title.style.color = '#c53030';

    const closeBtn = createEl('span', '', '×');
    closeBtn.style.cssText = "cursor:pointer; font-size:18px; font-weight:bold; color:#c53030;";
    closeBtn.onclick = () => { box.style.display = 'none'; };

    header.appendChild(title);
    header.appendChild(closeBtn);
    box.appendChild(header);

    // List
    const ul = createEl('ul');
    ul.style.paddingLeft = '20px';
    ul.style.margin = '0';

    errors.forEach(err => {
        const li = createEl('li', '', '');
        li.innerHTML = err; // Allow bold tags
        li.style.marginBottom = '5px';
        ul.appendChild(li);
    });

    box.appendChild(ul);
}

function markError(el, isError, msg = '', isWarning = false) {
    let target = el;
    // Handle CKEditor visual target
    if (el.classList.contains('ckeditor-processed')) {
        const cke = document.getElementById('cke_' + el.id);
        if (cke) target = cke;
    }

    if (isError) {
        if (isWarning) {
            target.style.border = '2px dotted #e53e3e';
        } else {
            target.style.border = '2px solid #e53e3e';
        }
        if (target === el) target.style.backgroundColor = '#fff5f5'; // Only color bg if it's the input
        target.title = msg;
    } else {
        target.style.border = '';
        if (target === el) target.style.backgroundColor = '';
        target.title = '';
    }
}