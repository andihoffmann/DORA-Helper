// content.js - Dora Lib4ri Helper
// Version: 2.13 (Mozilla Validator Safe: No innerHTML)

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
    const btn = createEl('button', 'dora-helper-button', '↻ Neu prüfen');
    btn.id = 'dora-helper-btn';
    btn.type = 'button';
    btn.addEventListener('click', () => {
        const currentDoi = doiInput.value.trim();
        if (!currentDoi) { alert("Keine DOI vorhanden."); return; }
        lastAutoFetchedDoi = currentDoi; 
        showLoadingBox();
        performFetch(currentDoi);
    });
    doiInput.parentNode.appendChild(btn);
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
    let box = createFloatingBox();
    box.innerHTML = ''; // Reset

    // 1. Close Button
    const closeBtn = createEl('div', 'dora-close-btn', '×');
    closeBtn.id = 'dora-box-close';
    closeBtn.addEventListener('click', () => box.remove());
    box.appendChild(closeBtn);

    // 2. Header
    const header = createEl('div', 'dora-meta-header');
    const title = createEl('div', 'dora-meta-title', meta.title || 'Kein Titel');
    const journalInfo = `${meta.containerTitle || ''} (${meta.published || '-'})`;
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

    // 5. Buttons Container
    const btnContainer = createEl('div', 'dora-btn-container');

    // Hybrid Button
    if (isHybrid) {
        const hybridBtn = createEl('button', 'dora-box-btn btn-hybrid-action');
        hybridBtn.id = 'dora-add-hybrid-btn';
        hybridBtn.title = "Fügt #hybrid in Additional Information ein";
        hybridBtn.innerHTML = '<span style="margin-right:5px;">📝</span> #hybrid setzen'; // Icon ist okay hier
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
    let out = text.toLowerCase().trim();
    cachedExceptions.forEach(ex => { out = out.replace(ex.regex, ex.replacement); });
    return out;
}

// --- VALIDATION ---
function validateForm() {
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

    [statusEl, volumeEl, startPageEl, endPageEl, titleEl].forEach(el => attachListener(el));

    // Rule 1: Volume required if Published
    if (statusEl && volumeEl) {
        let statusText = statusEl.value;
        if (statusEl.tagName === 'SELECT') {
             statusText = statusEl.options[statusEl.selectedIndex]?.text || '';
        }

        if (statusText.toLowerCase().includes('published')) {
            if (!volumeEl.value.trim()) {
                markError(volumeEl, true, 'Volume ist bei "Published" Pflicht.');
            } else {
                markError(volumeEl, false);
            }
        } else {
            markError(volumeEl, false);
        }
    }

    // Rule 2: Start Page needs (X pp.) if End Page empty
    if (startPageEl && endPageEl) {
        const startVal = startPageEl.value.trim();
        const endVal = endPageEl.value.trim();

        if (startVal && !endVal) {
            const ppPattern = /\(\d+\s*pp\.?\)/i;
            if (!ppPattern.test(startVal)) {
                markError(startPageEl, true, 'Wenn End Page leer ist, muss hier die Seitenzahl stehen (z.B. "12 (5 pp.)").');
            } else {
                markError(startPageEl, false);
            }
        } else {
            markError(startPageEl, false);
        }
    }

    // Rule 3: Title should be Sentence case
    if (titleEl) {
        let val = titleEl.value.trim();

        // Try reading from CKEditor if available
        if (titleEl.classList.contains('ckeditor-processed')) {
             const cke = document.getElementById('cke_' + titleEl.id);
             if (cke) {
                 const iframe = cke.querySelector('iframe');
                 if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
                     // Use text content from editor for validation
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
                    markError(titleEl, true, 'Titel enthält großgeschriebene Stoppwörter (bitte Sentence case verwenden).');
                } else if (mixedCaseCapWords.length > 1 && ratio > 0.6) {
                    markError(titleEl, true, 'Titel scheint Title Case zu sein (bitte Sentence case verwenden).');
                } else {
                    markError(titleEl, false);
                }
            } else {
                markError(titleEl, false);
            }
        } else {
            markError(titleEl, false);
        }
    }

    // Rule 4: Author Table Validation
    validateAuthorRows();
}

function validateAuthorRows() {
    // 1. Specific Islandora Fieldpanel Logic
    const authorsContainer = document.querySelector('.form-item-authors');
    if (authorsContainer) {
        const panes = authorsContainer.querySelectorAll('.islandora-form-fieldpanel-pane');
        panes.forEach(pane => {
            const nameInput = pane.querySelector('input[type="text"][name$="[valName]"]');
            const deptInput = pane.querySelector('input[type="text"][name$="[affiliation]"]');

            if (nameInput && deptInput) {
                // Attach listeners
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

                // Rule 4a: Check Name content
                if (/nomatch/i.test(nameVal) || /4ri/i.test(nameVal)) {
                    markError(nameInput, true, 'Darf nicht "nomatch" oder "4RI" enthalten.');
                } else {
                    markError(nameInput, false);
                }

                // Rule 4b: Dependency
                if (nameVal) {
                    if (!deptVal || deptVal === '_none' || deptVal === '- Select -') {
                        markError(deptInput, true, 'Affiliation/Department ist erforderlich.');
                    } else {
                        markError(deptInput, false);
                    }
                } else {
                    markError(deptInput, false);
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
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells.length > Math.max(nameIdx, deptIdx)) {
                    const nameInput = cells[nameIdx].querySelector('input[type="text"]');
                    const deptInput = cells[deptIdx].querySelector('input, select');

                    if (nameInput && deptInput && !nameInput.dataset.doraValidatorAttached) {
                         // Avoid double binding if handled by specific logic above
                         // (Though specific logic targets panes, this targets generic tables)
                         // We can just re-bind or check.
                         // For safety, we just run the logic.

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
                        } else {
                            markError(nameInput, false);
                        }

                        if (nameVal) {
                            if (!deptVal || deptVal === '_none' || deptVal === '- Select -') {
                                markError(deptInput, true, 'Affiliation/Department ist erforderlich.');
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

function markError(el, isError, msg = '') {
    let target = el;
    // Handle CKEditor visual target
    if (el.classList.contains('ckeditor-processed')) {
        const cke = document.getElementById('cke_' + el.id);
        if (cke) target = cke;
    }

    if (isError) {
        target.style.border = '2px solid #e53e3e';
        if (target === el) target.style.backgroundColor = '#fff5f5'; // Only color bg if it's the input
        target.title = msg;
    } else {
        target.style.border = '';
        if (target === el) target.style.backgroundColor = '';
        target.title = '';
    }
}