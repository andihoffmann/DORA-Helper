// background.js

let activeDoraTabId = null;
let pdfReferrerMap = new Map(); // Speichert Referrer zu PDF-URLs
let pdfTabMap = new Map(); // Speichert Tab-IDs zu PDF-URLs (wichtig für Blobs)

// Zentrale Konfiguration für den PDF-Analyzer
const ANALYZER_API_URL = "https://andrehoffmann80-pdf-analyzer.hf.space/analyze";

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "fetchData") {
        fetchMetadata(request.doi)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true; // Wichtig für asynchrone Antwort
    }

    if (request.action === "fetchPsiData") {
        fetchPsiAffiliations(request.url)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "analyzePdf") {
        analyzePdf(request.fileData)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "analyzePdfUrl") {
        analyzePdfUrl(request.pdfUrl)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "analyzePdfViaTab") {
        analyzePdfViaTab(request.pdfUrl)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "fetchHtml") {
        fetch(request.url, { credentials: 'include' })
            .then(response => {
                const finalUrl = response.url;
                // Status mitgeben: Verlage wie ACS antworten mit 403 und einer
                // Sperrseite - ohne diese Angabe sieht das aus wie "nichts da".
                return response.text().then(text => ({ text, finalUrl, status: response.status, ok: response.ok }));
            })
            .then(result => sendResponse({
                success: true, data: result.text, finalUrl: result.finalUrl,
                status: result.status, ok: result.ok
            }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "registerDoraTab") {
        activeDoraTabId = sender.tab.id;
        sendResponse({ success: true });
        return true;
    }


    if (request.action === "searchAutocomplete") {
        fetchDoraAutocomplete(request.url)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "fetchFunding") {
        fetchFundingSuggestions(request.doi)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "fetchSupplements") {
        fetchSupplements(request.doi)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "resolveRepository") {
        (async () => {
            const repo = repositoryFromId(request.url);
            if (!repo) return { repository: null, files: [] };
            const inhalt = await fetchRepositoryFiles(repo);
            return {
                repository: repo.name, title: inhalt.title || '',
                license: inhalt.license || null, files: inhalt.files || []
            };
        })()
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "performAiMetadataCheck") {
        performAiMetadataCheck(request.modsXml, request.formData)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }
});

// Monitor Tabs for PDF URLs (Passive Scan)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo.url || tab.url;
    // Reagiere auf .pdf UND blob: URLs (für PDF.js)
    if (activeDoraTabId && url && (url.toLowerCase().endsWith('.pdf') || url.startsWith('blob:'))) {
        console.log(`PDF/Blob detected: ${url} in tab ${tabId}`);
        pdfTabMap.set(url, tabId); // Merke Tab-ID für spätere Injection

        chrome.tabs.sendMessage(activeDoraTabId, {
            action: "pdfDetected",
            url: url,
            filename: url.startsWith('blob:') ? "document.pdf" : url.split('/').pop()
        }).catch((err) => {
            console.warn('Failed to notify DORA tab:', err);
        });
    }
});

// Download Monitor Listener
chrome.downloads.onChanged.addListener((delta) => {
    if (activeDoraTabId && delta.state && delta.state.current === 'complete') {
        chrome.downloads.search({ id: delta.id }, (results) => {
            if (results && results.length > 0) {
                const item = results[0];
                // Check if it looks like a PDF
                if (item.mime === "application/pdf" || item.filename.toLowerCase().endsWith(".pdf") || item.url.toLowerCase().endsWith(".pdf")) {
                    // Speichere den Referrer (die Artikelseite), um später den Kontext für den Download zu finden
                    if (item.referrer) {
                        pdfReferrerMap.set(item.url, item.referrer);
                    }

                    chrome.tabs.sendMessage(activeDoraTabId, {
                        action: "pdfDetected",
                        url: item.url,
                        filename: item.filename.split(/[/\\]/).pop()
                    }).catch(() => { /* Tab closed */ });
                }
            }
        });
    }
});

async function fetchMetadata(doi) {
    // BITTE E-MAIL EINTRAGEN (Pflicht für Unpaywall):
    const email = "dora@lib4ri.ch";

    try {
        // Get Scopus Key first
        const storage = await new Promise(resolve => chrome.storage.local.get('scopusApiKey', resolve));
        const scopusKey = storage.scopusApiKey;

        // 1. Initial Fetch: Unpaywall + Crossref + Scopus
        const promises = [
            fetch(`https://api.unpaywall.org/v2/${doi}?email=${email}`),
            fetch(`https://api.crossref.org/works/${doi}`)
        ];

        if (scopusKey) {
            promises.push(fetchScopusMetadata(doi, scopusKey));
        }

        const results = await Promise.all(promises);

        const unpaywallRes = results[0];
        const crossrefRes = results[1];
        const scopusData = scopusKey && results[2] ? results[2] : null;

        const unpaywallData = unpaywallRes.ok ? await unpaywallRes.json() : { is_oa: false };

        let crossrefData = {};
        if (crossrefRes.ok) {
            const json = await crossrefRes.json();
            crossrefData = json.message || {};
        }

        // 2. Extract ISSNs for DOAJ Check
        let issns = [];
        if (crossrefData.ISSN && Array.isArray(crossrefData.ISSN)) {
            issns = crossrefData.ISSN;
        } else if (unpaywallData.journal_issns) {
            issns = unpaywallData.journal_issns.split(',');
        }

        // 3. Fetch DOAJ status (from Unpaywall directly instead of DOAJ API due to Cloudflare bot protection)
        let doajData = { in_doaj: unpaywallData.journal_is_in_doaj === true };

        // 4. Extract Crossref License
        // Crossref licenses are in message.license [ { URL: "...", start: ... } ]
        // We usually want the most recent one or the one that indicates OA
        let crossrefLicense = null;
        if (crossrefData.license && Array.isArray(crossrefData.license)) {
            // Sort by start date descending (if available) or just take the first with a valid URL
            // Simply taking the first one is often enough, but let's try to find a creative commons one
            const licenses = crossrefData.license;
            const ccLicense = licenses.find(l => l.URL && l.URL.includes('creativecommons.org'));
            crossrefLicense = ccLicense ? ccLicense.URL : (licenses[0] ? licenses[0].URL : null);
        }

        return {
            unpaywall: unpaywallData,
            crossref: crossrefData,
            scopus: scopusData,
            doaj: doajData,
            crossrefLicense: crossrefLicense
        };
    } catch (error) {
        throw new Error("Netzwerkfehler oder ungültige DOI");
    }
}

async function fetchDoajMetadata(issns) {
    if (!issns || issns.length === 0) return null;

    // Check availability of each ISSN until one matches or all fail
    // API: https://doaj.org/api/search/journals/issn:{issn}
    // Note: DOAJ API allows searching by ISSN. We can just check the first one that returns a hit.

    for (const issn of issns) {
        try {
            const cleanIssn = issn.trim();
            const res = await fetch(`https://doaj.org/api/search/journals/issn:${cleanIssn}`);
            if (res.ok) {
                const data = await res.json();
                if (data.total > 0 && data.results && data.results.length > 0) {
                    // Found in DOAJ
                    const journal = data.results[0].bibjson;
                    return {
                        in_doaj: true,
                        title: journal.title,
                        license: journal.license ? journal.license.map(l => l.type).join(', ') : null,
                        oa_start: journal.oa_start ? journal.oa_start.year : null
                    };
                }
            }
        } catch (e) {
            console.warn(`DOAJ fetch failed for ${issn}:`, e);
        }
    }

    return { in_doaj: false };
}

async function fetchPsiAffiliations(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        return await response.json();
    } catch (error) {
        throw new Error("Failed to fetch PSI data: " + error.message);
    }
}

async function analyzePdf(dataUrl) {
    try {
        // Convert Data URL back to Blob
        const res = await fetch(dataUrl);
        const blob = await res.blob();

        const formData = new FormData();
        formData.append("file", blob, "upload.pdf");

        const response = await fetch(ANALYZER_API_URL, {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Server Error: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    } catch (e) {
        throw new Error("Failed to connect to PDF service: " + e.message);
    }
}

async function analyzePdfViaTab(pdfUrl) {
    console.log('analyzePdfViaTab called with:', pdfUrl);

    try {
        const isBlob = pdfUrl.startsWith('blob:');

        // Check if there's already a tab with this URL
        const existingTabs = await chrome.tabs.query({});
        let targetTab = null;
        let shouldCloseTab = false;

        // Strategy 1: Exact URL match
        targetTab = existingTabs.find(t => t.url === pdfUrl);

        // Strategy 2: For blob URLs, try to find by tab ID from pdfTabMap
        if (!targetTab && isBlob && pdfTabMap.has(pdfUrl)) {
            const tabId = pdfTabMap.get(pdfUrl);
            targetTab = existingTabs.find(t => t.id === tabId);
            if (targetTab) {
                console.log('Found blob tab via pdfTabMap:', targetTab.id);
            }
        }

        // Strategy 3: For blob URLs, try matching by origin
        if (!targetTab && isBlob) {
            const blobOrigin = pdfUrl.split('/').slice(0, 3).join('/');
            targetTab = existingTabs.find(t => t.url && t.url.startsWith(blobOrigin));
            if (targetTab) {
                console.log('Found blob tab via origin match:', targetTab.id);
            }
        }

        // If no existing tab found
        if (!targetTab) {
            // Blob URLs cannot be loaded in a new tab - they are context-specific
            if (isBlob) {
                throw new Error('Blob URL detected but no matching tab found. The PDF tab may have been closed.');
            }

            // For regular URLs, create a new tab
            console.log('Creating new tab for PDF:', pdfUrl);
            shouldCloseTab = true; // Mark for closure
            targetTab = await chrome.tabs.create({
                url: pdfUrl,
                active: false // Open in background
            });

            // Wait for the tab to load
            await new Promise((resolve) => {
                const listener = (tabId, changeInfo) => {
                    if (tabId === targetTab.id && changeInfo.status === 'complete') {
                        chrome.tabs.onUpdated.removeListener(listener);
                        resolve();
                    }
                };
                chrome.tabs.onUpdated.addListener(listener);

                // Timeout after 15 seconds
                setTimeout(() => {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }, 15000);
            });

            // Additional wait for PDF viewer to initialize
            await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
            console.log('Using existing tab:', targetTab.id);
        }

        console.log('Injecting script into tab:', targetTab.id);

        // Inject script to fetch PDF from same origin
        // For blob URLs, we need access to PDFViewerApplication (MAIN world)
        // For regular URLs, ISOLATED world is sufficient
        const results = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id, allFrames: true },
            world: isBlob ? 'MAIN' : undefined, // MAIN world for blob URLs to access PDFViewerApplication
            func: async (isBlobUrl) => {
                try {
                    // Helper to convert blob to data URL
                    const blobToDataURL = (blob) => {
                        return new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result);
                            reader.onerror = reject;
                            reader.readAsDataURL(blob);
                        });
                    };

                    // Helper to wait for PDFViewerApplication
                    const waitForPdfViewer = (maxWait = 5000) => {
                        return new Promise((resolve) => {
                            if (typeof window.PDFViewerApplication !== 'undefined' && window.PDFViewerApplication.pdfDocument) {
                                resolve(true);
                                return;
                            }
                            const startTime = Date.now();
                            const checkInterval = setInterval(() => {
                                if (typeof window.PDFViewerApplication !== 'undefined' && window.PDFViewerApplication.pdfDocument) {
                                    clearInterval(checkInterval);
                                    resolve(true);
                                } else if (Date.now() - startTime > maxWait) {
                                    clearInterval(checkInterval);
                                    resolve(false);
                                }
                            }, 100);
                        });
                    };

                    let blob = null;

                    // Strategy 1: For blob URLs or Firefox PDF viewer - use PDFViewerApplication
                    if (isBlobUrl || typeof window.PDFViewerApplication !== 'undefined') {
                        console.log('Waiting for PDFViewerApplication...');
                        const pdfViewerReady = await waitForPdfViewer();

                        if (pdfViewerReady && window.PDFViewerApplication && window.PDFViewerApplication.pdfDocument) {
                            console.log('Using PDFViewerApplication.getData()');
                            const data = await window.PDFViewerApplication.pdfDocument.getData();
                            blob = new Blob([data], { type: 'application/pdf' });
                        }
                    }

                    // Strategy 2: Fetch the current URL (for regular PDF links)
                    if (!blob) {
                        console.log('Fetching PDF from current URL');
                        const response = await fetch(window.location.href, {
                            credentials: 'include',
                            cache: 'no-cache'
                        });

                        if (response.ok) {
                            const contentType = response.headers.get('content-type');
                            console.log('Response content-type:', contentType);

                            // Accept PDF or octet-stream
                            if (contentType && (contentType.includes('pdf') || contentType.includes('octet-stream'))) {
                                blob = await response.blob();
                            } else {
                                // Sometimes the content-type is missing, try anyway
                                blob = await response.blob();
                            }
                        }
                    }

                    if (blob && blob.size > 1000) {
                        console.log('PDF fetched successfully, size:', blob.size);
                        return await blobToDataURL(blob);
                    }

                    throw new Error('Could not extract PDF from page (blob too small or missing)');
                } catch (error) {
                    console.error('PDF extraction error:', error);
                    return { error: error.message };
                }
            },
            args: [isBlob]
        });

        // Close the tab if we created it
        if (shouldCloseTab) {
            console.log('Closing temporary tab');
            try {
                await chrome.tabs.remove(targetTab.id);
            } catch (e) {
                console.warn('Failed to close tab:', e);
            }
        }

        if (!results || !results[0] || !results[0].result) {
            throw new Error('Failed to extract PDF from tab - no result returned');
        }

        const result = results[0].result;

        // Check if result is an error object
        if (result && typeof result === 'object' && result.error) {
            throw new Error('PDF extraction failed: ' + result.error);
        }

        if (typeof result !== 'string' || !result.startsWith('data:')) {
            throw new Error('Invalid result format - expected data URL');
        }

        const dataUrl = result;
        console.log('PDF extracted, sending to analyzer');

        // Convert data URL back to blob and send to analyzer
        const res = await fetch(dataUrl);
        const blob = await res.blob();

        const formData = new FormData();
        formData.append("file", blob, "downloaded.pdf");

        const response = await fetch(ANALYZER_API_URL, {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Server Error: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    } catch (e) {
        console.error('analyzePdfViaTab error:', e);

        // FALLBACK: Try to let the Python backend download it directly
        console.log('Falling back to direct URL analysis via Python backend');
        try {
            const formData = new FormData();
            formData.append("pdf_url", pdfUrl);

            const response = await fetch(ANALYZER_API_URL, {
                method: "POST",
                body: formData
            });

            if (response.ok) {
                return await response.json();
            }
        } catch (fallbackError) {
            console.error('Fallback also failed:', fallbackError);
        }

        throw new Error("Failed to analyze PDF via tab: " + e.message);
    }
}

async function analyzePdfUrl(pdfUrl) {
    try {
        let blob = null;
        let usePythonDownload = false;

        // 2. Versuch: Aus offenem Tab laden (Browser Cache / Session)
        // Dies umgeht Login-Probleme, da wir den Inhalt direkt aus dem Tab holen
        if (!blob && pdfUrl && !pdfUrl.startsWith('file:')) {
            try {
                const tabs = await chrome.tabs.query({});
                let targetTab = null;

                console.log(`Looking for PDF tab. Total tabs: ${tabs.length}, PDF URL: ${pdfUrl}`);

                // Strategie 1: Bekannte Tab-ID aus onUpdated (Beste Methode für Blobs)
                if (pdfTabMap.has(pdfUrl)) {
                    const id = pdfTabMap.get(pdfUrl);
                    targetTab = tabs.find(t => t.id === id);
                    if (targetTab) console.log(`Found tab via pdfTabMap: ${targetTab.id}`);
                }

                // Strategie 2: Exakter Match
                if (!targetTab) {
                    targetTab = tabs.find(t => t.url === pdfUrl);
                    if (targetTab) console.log(`Found tab via exact URL match: ${targetTab.id}`);
                }

                // Strategie 3: Blob URL - match by origin
                if (!targetTab && pdfUrl.startsWith('blob:')) {
                    // Extract origin from blob URL
                    const blobOrigin = pdfUrl.split('/').slice(0, 3).join('/');
                    targetTab = tabs.find(t => t.url && t.url.startsWith('blob:') && t.url.startsWith(blobOrigin));
                    if (targetTab) console.log(`Found tab via blob origin match: ${targetTab.id}`);
                }

                // 3. Versuch: Suche über den Referrer (Wichtig für Elsevier/ScienceDirect)
                if (!targetTab && pdfReferrerMap.has(pdfUrl)) {
                    const referrer = pdfReferrerMap.get(pdfUrl);
                    targetTab = tabs.find(t => t.url === referrer);
                }

                if (targetTab && targetTab.id) {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId: targetTab.id, allFrames: true },
                        world: 'MAIN', // WICHTIG: Zugriff auf window.PDFViewerApplication der Seite
                        args: [pdfUrl],
                        func: async (targetUrl) => {
                            const readBlob = (b) => new Promise(resolve => {
                                const reader = new FileReader();
                                reader.onloadend = () => resolve(reader.result);
                                reader.readAsDataURL(b);
                            });

                            // Helper to wait for PDFViewerApplication
                            const waitForPdfViewer = (maxWait = 3000) => {
                                return new Promise((resolve) => {
                                    const startTime = Date.now();
                                    const checkInterval = setInterval(() => {
                                        if (window.PDFViewerApplication && window.PDFViewerApplication.pdfDocument) {
                                            clearInterval(checkInterval);
                                            resolve(true);
                                        } else if (Date.now() - startTime > maxWait) {
                                            clearInterval(checkInterval);
                                            resolve(false);
                                        }
                                    }, 100);
                                });
                            };

                            try {
                                // 1. Firefox / PDF.js Viewer (Direct Memory Access)
                                // Wait for PDFViewerApplication to be ready
                                const pdfViewerReady = await waitForPdfViewer();
                                if (pdfViewerReady && window.PDFViewerApplication && window.PDFViewerApplication.pdfDocument) {
                                    const data = await window.PDFViewerApplication.pdfDocument.getData();
                                    const blob = new Blob([data], { type: 'application/pdf' });
                                    return await readBlob(blob);
                                }

                                // 2. Versuch: Fetch der Ziel-URL (z.B. blob: oder session URL)
                                // Only try if it's a blob URL and matches current origin
                                if (targetUrl && targetUrl.startsWith('blob:')) {
                                    try {
                                        const res = await fetch(targetUrl);
                                        if (res.ok) {
                                            const blob = await res.blob();
                                            if (blob.type === 'application/pdf' || blob.size > 1000) {
                                                return await readBlob(blob);
                                            }
                                        }
                                    } catch (e) {
                                        console.warn('Blob fetch failed:', e);
                                    }
                                }

                                // 3. Fallback: Fetch window.location.href (falls der Tab das PDF direkt anzeigt)
                                if (window.location.href && window.location.href.startsWith('blob:')) {
                                    const res = await fetch(window.location.href);
                                    if (res.ok) {
                                        const blob = await res.blob();
                                        if (blob.type === 'application/pdf' || blob.size > 1000) {
                                            return await readBlob(blob);
                                        }
                                    }
                                }

                                return null;
                            } catch (e) {
                                console.error('PDF extraction error:', e);
                                return null;
                            }
                        }
                    });

                    const validResult = results.find(r => r.result);

                    if (validResult && validResult.result && validResult.result.error) {
                        throw new Error(validResult.result.error);
                    }

                    if (validResult) {
                        const res = await fetch(validResult.result);
                        blob = await res.blob();
                        console.log("PDF erfolgreich aus Tab-Kontext geladen.");
                    }
                }
            } catch (e) {
                console.warn("Tab-Injection fehlgeschlagen:", e);
            }
        }

        // 3. Versuch: Netzwerk-Fetch (Fallback)
        if (!blob) {
            // Blob-URLs können vom Background-Script nicht geladen werden -> Überspringen
            if (pdfUrl && pdfUrl.startsWith('blob:')) {
                console.warn("Blob-URL erkannt, Netzwerk-Fallback übersprungen (kein Zugriff möglich).");
            } else {
                let pdfRes;
                try {
                    pdfRes = await fetch(pdfUrl, { credentials: 'include' });
                } catch (e) {
                    try {
                        // Fallback 1: Ohne Credentials & ohne Referrer
                        pdfRes = await fetch(pdfUrl, { credentials: 'omit', referrerPolicy: 'no-referrer' });
                    } catch (e2) {
                        console.warn("Browser fetch failed (CORS), delegating to Python:", e2);
                        usePythonDownload = true;
                    }
                }

                if (!usePythonDownload && (!pdfRes || !pdfRes.ok)) {
                    usePythonDownload = true;
                } else if (!usePythonDownload) {
                    // Check Content-Type (vermeide HTML Login-Seiten)
                    const cType = pdfRes.headers.get('Content-Type');
                    if (cType && !cType.toLowerCase().includes('pdf') && !cType.toLowerCase().includes('octet-stream')) {
                        console.warn("Background Fetch returned non-PDF (likely HTML):", cType);
                        usePythonDownload = true;
                    } else {
                        blob = await pdfRes.blob();
                        if (blob.size < 2000) { // < 2KB ist verdächtig klein
                            console.warn("Blob too small, delegating to Python.");
                            blob = null;
                            usePythonDownload = true;
                        }
                    }
                }
            }
        }

        const formData = new FormData();

        if (blob) {
            // Wir haben das PDF (lokal oder via Netzwerk)
            const file = new File([blob], "downloaded.pdf", { type: "application/pdf" });
            formData.append("file", file);
        } else {
            if (pdfUrl && pdfUrl.startsWith('blob:')) {
                throw new Error("Zugriff auf PDF-Tab fehlgeschlagen (Blob-URL) und lokaler Dateizugriff nicht möglich.");
            }
            formData.append("pdf_url", pdfUrl);
        }

        const response = await fetch(ANALYZER_API_URL, {
            method: "POST",
            body: formData
        });

        if (!response.ok) {
            throw new Error(`Server Error: ${response.status} ${response.statusText}`);
        }

        return await response.json();
    } catch (e) {
        throw new Error("Failed to analyze PDF URL: " + e.message);
    }
}

/**
 * Proxy-Funktion für DORA Autocomplete-Anfragen.
 * Gibt das rohe JSON zurück, damit die content.js (v2.59+) 
 * flexibel zwischen Solr- und Authority-Daten unterscheiden kann.
 */
async function fetchDoraAutocomplete(url) {
    try {
        console.log('Fetching DORA Autocomplete from:', url);
        const res = await fetch(url, {
            credentials: 'include',
            mode: 'cors',
            cache: 'no-cache'
        });
        if (!res.ok) {
            console.error(`DORA Error: ${res.status} ${res.statusText}`);
            throw new Error(`DORA Error: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        console.log('Autocomplete fetch successful');
        return data;
    } catch (e) {
        console.error("Autocomplete fetch error:", e);
        console.error("URL was:", url);
        console.error("Error details:", {
            message: e.message,
            name: e.name,
            stack: e.stack
        });
        // Weiterwerfen, damit der Aufrufer einen Fehlschlag von einem leeren
        // Trefferset unterscheiden kann (sonst sieht ein Timeout aus wie
        // "nicht im Vokabular").
        throw e;
    }
}

async function fetchScopusMetadata(doi, apiKey) {
    if (!apiKey) return null;

    const url = `https://api.elsevier.com/content/abstract/doi/${doi}?apiKey=${apiKey}&httpAccept=application/json`;

    try {
        const res = await fetch(url);

        if (!res.ok) {
            console.warn(`Scopus API Error: ${res.status}`);
            return { error: `HTTP ${res.status}` };
        }

        const data = await res.json();
        const core = data['abstracts-retrieval-response']?.coredata;
        const bib = data['abstracts-retrieval-response']?.item?.bibrecord?.head?.correspondence;

        // 1. OA Status & License
        const oaFlag = core?.['openaccessFlag'] === 'true';
        const oaType = core?.['openaccessType']; // e.g. "Gold", "Hybrid Gold", "Green"
        const oaStatus = core?.['openaccess']; // Int flag

        // 2. Affiliation (Lib4Ri Check)
        let isLib4Ri = false;
        let affilText = "Keine Corresponding-Author Daten";

        const isLib4RiCheck = (str) => {
            if (!str) return false;
            const s = str.toLowerCase();
            return s.includes('paul scherrer') || s.includes('psi') ||
                s.includes('eawag') || s.includes('empa') ||
                s.includes('wsl') || s.includes('forest, snow and landscape');
        };

        if (bib) {
            affilText = "";
            const corrs = Array.isArray(bib) ? bib : [bib];

            for (const c of corrs) {
                if (c.affiliation) {
                    const aff = c.affiliation;
                    let orgs = [];
                    if (Array.isArray(aff.organization)) {
                        orgs = aff.organization.map(o => o['$'] || o);
                    } else if (aff.organization) {
                        orgs = [aff.organization];
                    }

                    const fullText = orgs.join(', ') + (aff.country ? `, ${aff.country}` : '');
                    if (isLib4RiCheck(fullText)) {
                        isLib4Ri = true;
                    }
                    affilText += fullText + "; ";
                }
            }
            affilText = affilText.replace(/; $/, '');
        }

        return {
            oaFlag: oaFlag,
            oaType: oaType,
            oaStatus: oaStatus, // Raw value given by Scopus
            isLib4Ri: isLib4Ri,
            affiliation: affilText,
            raw: core // Keep raw for debug if needed
        };

    } catch (e) {
        console.error("Scopus Fetch Error:", e);
        return { error: e.message };
    }
}

async function performAiMetadataCheck(modsXml, formData) {
    try {
        const formDataPayload = new FormData();
        formDataPayload.append("mods_xml", modsXml);
        formDataPayload.append("form_data", JSON.stringify(formData));

        const AI_CHECK_API_URL = "https://andrehoffmann80-pdf-analyzer.hf.space/check_metadata";

        try {
            const response = await fetch(AI_CHECK_API_URL, {
                method: "POST",
                body: formDataPayload
            });

            if (!response.ok) {
                // Return a mock response if endpoint doesn't exist yet
                console.warn("AI Endpoint returned error. Returning mock response for demonstration.");
                return {
                    status: "success",
                    feedback: "I am your AI Assistant.\nThe MODS XML and Form Data have been received.\n\n- Title looks consistent.\n- Check the author list, there might be a discrepancy.",
                    problematic_fields: ["edit-title", "edit-authors"]
                };
            }
            return await response.json();
        } catch (fetchErr) {
            console.warn("AI Endpoint fetch failed. Returning mock response for demonstration.", fetchErr);
            return {
                status: "success",
                feedback: "I am your AI Assistant.\nThe MODS XML and Form Data have been received.\n\n- Title looks consistent.\n- Check the author list, there might be a discrepancy.",
                problematic_fields: ["edit-title", "edit-authors"]
            };
        }
    } catch (e) {
        throw new Error("Failed to perform AI check: " + e.message);
    }
}

// =====================================================================
// FUNDING / PROJEKT-VERKNUEPFUNG (Crossref Funder Registry + OpenAIRE)
// ---------------------------------------------------------------------
// DORA speichert Foerderung als DataCite-artige fundingReferences:
//   funderName / funderIdentifier / fundingStream / awardNumber / awardTitle
// Im Bestand existieren ausschliesslich SNSF und European Commission,
// daher werden nur diese beiden Foerderer zum Eintragen vorgeschlagen.
// =====================================================================

const DORA_SOLR_SELECT = 'http://lib-dora-prod1.emp-eaw.ch:8080/solr/collection1/select';
const SOLR_FUNDING_PREFIX = 'mods_extension_fundingReferences_fundingReference_';

// Kanonische Schreibweisen, wie sie in DORA verwendet werden
const FUNDER_PROFILES = {
    SNSF: {
        key: 'SNSF',
        funderName: 'Swiss National Science Foundation',
        funderIdentifier: 'http://dx.doi.org/10.13039/501100001711',
        defaultStream: 'SNSF',
        // Crossref Funder-DOIs (ohne Praefix) -> ggf. direkter Stream
        crossrefIds: {
            '10.13039/501100001711': null
        }
    },
    EC: {
        key: 'EC',
        funderName: 'European Commission',
        funderIdentifier: 'http://dx.doi.org/10.13039/501100000780',
        defaultStream: null, // Stream haengt vom Rahmenprogramm ab
        crossrefIds: {
            '10.13039/501100000780': null,                              // European Commission
            '10.13039/100010661': 'Horizon 2020 Framework Programme',   // H2020
            '10.13039/501100007601': null,                              // "Horizon 2020" bei Crossref, faktisch auch fuer Horizon-Europe-Projekte
            '10.13039/100011102': 'Seventh Framework Programme',        // FP7
            '10.13039/100011103': null,                                 // FP6
            '10.13039/501100000781': null,                              // ERC
            // HORIZON EUROPE und seine Teilprogramme
            '10.13039/100018693': 'Horizon Europe Framework Programme',
            '10.13039/100018695': 'Horizon Europe Framework Programme', // Research Infrastructures
            '10.13039/100018703': 'Horizon Europe Framework Programme', // European Innovation Council
            '10.13039/100018704': 'Horizon Europe Framework Programme', // Innovation Ecosystems
            '10.13039/100018705': 'Horizon Europe Framework Programme', // EIT
            '10.13039/100019180': 'Horizon Europe Framework Programme', // ERC
            '10.13039/100019185': 'Horizon Europe Framework Programme', // Global Challenges
            '10.13039/100019186': 'Horizon Europe Framework Programme', // Innovative Europe
            // Exekutivagenturen der EU - Programm ergibt sich aus der Projektnummer
            '10.13039/501100000783': null,                              // REA
            '10.13039/501100021050': null,                              // CINEA
            '10.13039/100020631': null,                                 // EISMEA
            '10.13039/501100012290': null,                              // INEA
            '10.13039/100013284': null,                                 // EASME
            '10.13039/501100000785': null                               // EACEA
        }
    }
};

// OpenAIRE funding_level_0 -> DORA fundingStream
const OPENAIRE_STREAM_MAP = {
    'H2020': 'Horizon 2020 Framework Programme',
    'FP7': 'Seventh Framework Programme',
    'HE': 'Horizon Europe Framework Programme',
    'HORIZON': 'Horizon Europe Framework Programme'
};

function funderProfileFromCrossrefDoi(doi) {
    if (!doi) return null;
    const clean = String(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
    for (const profile of Object.values(FUNDER_PROFILES)) {
        if (Object.prototype.hasOwnProperty.call(profile.crossrefIds, clean)) {
            return { profile: profile, stream: profile.crossrefIds[clean] || profile.defaultStream };
        }
    }
    return null;
}

function funderProfileFromName(name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    if (/schweizerischer nationalfonds|swiss national science|\bsnsf\b|\bsnf\b/.test(n)) return FUNDER_PROFILES.SNSF;
    if (/european commission|horizon 2020|horizon europe|\bh2020\b|\bfp7\b|seventh framework|european research council|\berc\b/.test(n)) return FUNDER_PROFILES.EC;
    // Crossref benennt EU-Foerderung uneinheitlich und oft ohne Funder-DOI
    if (/marie s?k?[łl]odowska|marie curie|\bmsca\b/.test(n)) return FUNDER_PROFILES.EC;
    if (/\b(7th|6th)\s*framework|framework program(me)?\b.*\beu\b|\beu\b.*framework program(me)?/.test(n)) return FUNDER_PROFILES.EC;
    if (/european union|\beuratom\b|\bec\b\s*research|\berc(ea)?\b/.test(n)) return FUNDER_PROFILES.EC;
    // EU-Exekutivagenturen und Teilprogramme zahlen die Projekte aus
    if (/executive agency/.test(n) && /european|innovation|research|climate|health|digital|networks|audiovisual|small and medium/.test(n)) return FUNDER_PROFILES.EC;
    if (/\b(rea|hadea|cinea|eismea|ercea|inea|easme|eacea)\b/.test(n)) return FUNDER_PROFILES.EC;
    if (/european institute of innovation|innovation council|research infrastructures|framework programme/.test(n)
        && !/national|swiss|deutsche|german/.test(n)) return FUNDER_PROFILES.EC;
    return null;
}

// Stream aus dem Foerdernamen, soweit eindeutig (sonst klaert ihn die
// Projektnummer ueber OpenAIRE bzw. den DORA-Bestand)
function streamFromFunderName(name) {
    const n = String(name || '').toLowerCase();
    if (/\b7th\s*framework|seventh framework|\bfp7\b/.test(n)) return 'Seventh Framework Programme';
    if (/horizon 2020|\bh2020\b/.test(n)) return 'Horizon 2020 Framework Programme';
    if (/horizon europe/.test(n)) return 'Horizon Europe Framework Programme';
    return null;
}

// SNSF-Nummern kommen bei Crossref oft als "200021E_203578", "PZ00P2_174192"
// oder "SNF 182124". In DORA steht immer nur der nackte Code.
function normalizeAwardNumber(raw, funderKey) {
    if (!raw) return null;
    let s = String(raw).trim();
    s = s.replace(/^(grant|award|project|no\.?|nr\.?|#)\s*/i, '');
    s = s.replace(/^(snsf|snf|sfn)[\s:_-]*/i, '');

    // Immer ganze Ziffernbloecke betrachten - ein Laengenfenster wuerde aus
    // "10003256" faelschlich "0003256" herausschneiden.
    const groups = s.match(/\d+/g) || [];
    const long = groups.filter(g => g.length >= 5);

    if (funderKey === 'SNSF') {
        // Praefixe stehen vorn ("200021E_203578"), die Nummer hinten
        if (long.length) return long[long.length - 1];
    }
    if (funderKey === 'EC') {
        // Grant Agreement Number steht vorn ("654360 NFFA-Europe")
        const ec = groups.find(g => g.length >= 6 && g.length <= 9);
        if (ec) return ec;
        if (long.length) return long[0];
    }
    if (long.length) return long[long.length - 1];
    const generic = groups.find(g => g.length >= 4);
    return generic || s;
}

// Prueft, ob die Award-Angabe wirklich diese Projektnummer meint und nicht
// Teil einer zusammengesetzten Kennung ist. CNPq meldet z.B. "#140439/2011-0",
// die DFG "510228793 / C04-CRC1633" - dort waere die herausgeloeste Zahl nur
// zufaellig identisch mit einer SNSF-/EC-Projektnummer.
function awardStringMatchesCode(rawAward, code) {
    let s = String(rawAward || '').trim();

    // Fuehrende Satzzeichen und Beschriftungen (auch Programmnamen)
    s = s.replace(/^[^0-9A-Za-z]+/, '');
    let previous;
    do {
        previous = s;
        s = s.replace(/^(grant|award|project|agreement|number|no|nr|snsf|snf|sfn|fp7|h2020|horizon\s*(2020|europe)|erc|msca)(?:[\s.:_-]+|\b)/i, '');
    } while (s !== previous);

    const idx = s.indexOf(code);
    if (idx < 0) return false;

    const head = s.slice(0, idx);
    const tail = s.slice(idx + code.length);
    const digitGroups = t => (String(t).match(/\d+/g) || []);

    // Hinter der Nummer folgt eine zweite Kennung = zusammengesetzter
    // Bezeichner eines anderen Systems: "#140439/2011-0" (CNPq),
    // "510228793 / C04-CRC1633", "248198858/GRK 2032" (DFG), "760010/2022".
    // Ausnahme: die SNSF-Fortsetzungsangabe "/1", "/3".
    const afterSlash = tail.match(/\/\s*(.*)$/);
    if (afterSlash && (afterSlash[1].match(/\d+/g) || []).some(g => g.length >= 3)) return false;

    const afterDash = tail.match(/^\s*[\-–—‐]\s*(\d+)/);
    if (afterDash && afterDash[1].length >= 3) return false;

    if (!head.trim()) return true;

    // Beschriftungen ohne Ziffern vor dem Instrumentenpraefix entfernen
    // ("Sinergia CRSII5_202296", "R'equip grant 206021-170731")
    const headCore = head.trim().split(/\s+/).filter(t => /\d/.test(t)).join(' ');
    if (!headCore) return true;

    // SNSF-Instrumentenpraefix: genau ein Token, optional mit Trennzeichen
    // ("200021E_", "31BD30 _", "CRSK-3_", "501100001711-", "PR00P3")
    if (/^[A-Za-z0-9]{2,14}\s*[_\-–—‐]?\s*$/.test(headCore)) return true;

    // Call-Kennungen enthalten hoechstens Jahreszahlen ("ERC-2020-StG ",
    // "H2020-MSCA-IF-2020 ", "10.3030/"), aber keine zweite Projektnummer.
    return !digitGroups(headCore).some(g => g.length >= 5);
}

// --- Crossref: message.funder ---
function extractCrossrefFunders(crossrefMessage) {
    const out = [];
    if (!crossrefMessage || !Array.isArray(crossrefMessage.funder)) return out;

    crossrefMessage.funder.forEach(f => {
        const byDoi = funderProfileFromCrossrefDoi(f.DOI);
        const profile = byDoi ? byDoi.profile : funderProfileFromName(f.name);
        const awards = Array.isArray(f.award) ? f.award : [];

        if (!profile) {
            // DORA kennt nur SNSF/EC - alles andere nur als Hinweis melden
            out.push({
                supported: false,
                rawFunderName: f.name || '',
                awards: awards.map(a => String(a))
            });
            return;
        }

        const base = {
            supported: true,
            funderKey: profile.key,
            funderName: profile.funderName,
            funderIdentifier: profile.funderIdentifier,
            fundingStream: (byDoi && byDoi.stream) || streamFromFunderName(f.name) || profile.defaultStream,
            rawFunderName: f.name || ''
        };

        if (awards.length === 0) {
            out.push(Object.assign({}, base, { awardNumber: null, rawAwardNumber: null }));
            return;
        }

        awards.forEach(a => {
            const number = normalizeAwardNumber(a, profile.key);
            // Award-Nummern sind bei SNSF/EC immer numerisch; Angaben wie
            // "PSIFELLOW" sind Akronyme des Projekts, keine eigene Foerderung.
            if (!/^\d{5,9}$/.test(String(number || ''))) return;
            // Zusammengesetzte Kennungen anderer Foerderer nicht als Projekt-
            // nummer interpretieren (z.B. CNPq "#140439/2011-0")
            if (!awardStringMatchesCode(a, number)) {
                console.warn('DORA Helper: Award-Angabe verworfen (keine reine Projektnummer):', a);
                return;
            }
            out.push(Object.assign({}, base, {
                awardNumber: number,
                rawAwardNumber: String(a)
            }));
        });
    });

    return out;
}

// --- OpenAIRE: verknuepfte Projekte zur DOI ---
// Der Graph-API-v1 bietet keinen Endpunkt fuer Projekt-Relationen eines
// Publikations-Records, deshalb der (weiterhin aktive) Legacy-Suchendpunkt.
async function fetchOpenAireProjects(doi) {
    const url = `https://api.openaire.eu/search/publications?doi=${encodeURIComponent(doi)}&format=json`;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`OpenAIRE HTTP ${res.status}`);
    const json = await res.json();

    const asArray = v => (v === undefined || v === null) ? [] : (Array.isArray(v) ? v : [v]);
    const val = v => (v && typeof v === 'object') ? (v['$'] || '') : (v || '');

    const results = asArray(json && json.response && json.response.results && json.response.results.result);
    if (results.length === 0) return [];

    const entity = results[0] && results[0].metadata && results[0].metadata['oaf:entity']
        && results[0].metadata['oaf:entity']['oaf:result'];
    const rels = asArray(entity && entity.rels && entity.rels.rel)
        .filter(r => r && r.to && r.to['@type'] === 'project');

    return rels.map(rel => {
        const funding = asArray(rel.funding)[0] || {};
        const funder = funding.funder || {};
        const shortName = funder['@shortname'] || '';
        const level0 = (funding.funding_level_0 && funding.funding_level_0['@name']) || '';
        const level1 = (funding.funding_level_1 && funding.funding_level_1['@name']) || '';

        let profile = null;
        if (/^SNSF$/i.test(shortName)) profile = FUNDER_PROFILES.SNSF;
        else if (/^EC$/i.test(shortName)) profile = FUNDER_PROFILES.EC;
        else profile = funderProfileFromName(funder['@name']);

        const code = val(rel.code);
        const acronym = val(rel.acronym);
        const title = val(rel.title);

        const hasCode = code && code !== 'unidentified';
        const hasTitle = title && title !== 'unidentified';

        return {
            supported: !!profile,
            funderKey: profile ? profile.key : null,
            funderName: profile ? profile.funderName : (funder['@name'] || ''),
            funderIdentifier: profile ? profile.funderIdentifier : null,
            // SNSF hat in DORA immer den Stream "SNSF", EC den Namen des Rahmenprogramms
            fundingStream: (profile && profile.key === 'SNSF')
                ? 'SNSF'
                : (OPENAIRE_STREAM_MAP[level0.toUpperCase()] || null),
            awardNumber: hasCode ? normalizeAwardNumber(code, profile ? profile.key : null) : null,
            rawAwardNumber: hasCode ? code : null,
            // DORA-Konvention fuer EU-Projekte: "AKRONYM - Titel"
            awardTitle: (acronym && hasTitle) ? `${acronym} - ${title}` : (hasTitle ? title : ''),
            acronym: acronym || null,
            projectTitle: hasTitle ? title : '',
            fundingSubStream: level1 || null,
            openaireId: rel.to['$'] || null,
            inferred: rel['@inferred'] === true || rel['@inferred'] === 'true',
            trust: parseFloat(rel['@trust'] || '0') || 0,
            rawFunderName: funder['@name'] || ''
        };
    }).filter(p => p.awardNumber || p.awardTitle);
}

// --- OpenAIRE-Projektregister ueber den Code (fuer Crossref-only Awards) ---
async function lookupOpenAireProjectByCode(code, funderShortName) {
    try {
        const url = `https://api.openaire.eu/graph/v1/projects?code=${encodeURIComponent(code)}`
            + (funderShortName ? `&fundingShortName=${encodeURIComponent(funderShortName)}` : '')
            + '&pageSize=5';
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) return null;
        const json = await res.json();
        const hit = (json.results || []).find(p => String(p.code) === String(code));
        if (!hit) return null;

        const funding = (hit.fundings && hit.fundings[0]) || {};
        const streamId = (funding.fundingStream && funding.fundingStream.id) || '';
        const level0 = streamId.split('::')[1] || '';

        return {
            awardTitle: hit.acronym ? `${hit.acronym} - ${hit.title}` : (hit.title || ''),
            acronym: hit.acronym || null,
            projectTitle: hit.title || '',
            fundingStream: /^SNSF$/i.test(funding.shortName || '')
                ? 'SNSF'
                : (OPENAIRE_STREAM_MAP[level0.toUpperCase()] || null),
            openaireId: hit.id || null
        };
    } catch (e) {
        console.warn('OpenAIRE project lookup failed:', e);
        return null;
    }
}

// --- DORA-Bestand: kanonische Schreibweise einer Award-Nummer ---
// Liefert Titel/Stream so, wie sie in DORA bereits verwendet werden.
async function lookupDoraFunding(awardNumber, funderName) {
    try {
        const fields = ['funderName', 'funderIdentifier', 'fundingStream', 'awardNumber', 'awardTitle']
            .map(f => SOLR_FUNDING_PREFIX + f + '_ms');
        const q = `${SOLR_FUNDING_PREFIX}awardNumber_ms:"${awardNumber}"`;
        const url = `${DORA_SOLR_SELECT}?q=${encodeURIComponent(q)}&rows=5&wt=json&fl=${encodeURIComponent(fields.join(','))}`;

        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) return null;
        const json = await res.json();
        const docs = (json.response && json.response.docs) || [];

        for (const doc of docs) {
            const numbers = doc[SOLR_FUNDING_PREFIX + 'awardNumber_ms'] || [];
            // Die Multi-Value-Felder eines Records sind positionsgleich indexiert
            const idx = numbers.findIndex(n => String(n) === String(awardNumber));
            if (idx === -1) continue;

            const pick = f => {
                const arr = doc[SOLR_FUNDING_PREFIX + f + '_ms'] || [];
                return arr.length === numbers.length ? (arr[idx] || null) : (arr[0] || null);
            };

            const name = pick('funderName');
            if (funderName && name && name !== funderName) continue;

            return {
                funderName: name,
                funderIdentifier: pick('funderIdentifier'),
                fundingStream: pick('fundingStream'),
                awardTitle: pick('awardTitle'),
                occurrences: json.response.numFound
            };
        }
        return null;
    } catch (e) {
        console.warn('DORA Solr funding lookup failed:', e);
        return null;
    }
}

// Ergebnis-Cache: verhindert wiederholte Abfragen derselben DOI
// (Re-Render der Box, Batch-QC, Zurueckspringen) - OpenAIRE ist ratenbegrenzt.
const fundingCache = new Map();
const FUNDING_CACHE_MAX = 200;

async function fetchFundingSuggestions(doi) {
    const key = String(doi || '').trim().toLowerCase();
    if (fundingCache.has(key)) return fundingCache.get(key);

    const result = await computeFundingSuggestions(doi);
    if (fundingCache.size >= FUNDING_CACHE_MAX) {
        fundingCache.delete(fundingCache.keys().next().value);
    }
    fundingCache.set(key, result);
    return result;
}


// --- Beide Quellen zusammenfuehren ---
async function computeFundingSuggestions(doi) {
    const [crossrefRes, openaireRes] = await Promise.allSettled([
        fetch(`https://api.crossref.org/works/${doi}`, { cache: 'no-cache' })
            .then(r => r.ok ? r.json() : null)
            .then(j => extractCrossrefFunders(j && j.message)),
        fetchOpenAireProjects(doi)
    ]);

    const crossrefItems = crossrefRes.status === 'fulfilled' ? (crossrefRes.value || []) : [];
    const openaireItems = openaireRes.status === 'fulfilled' ? (openaireRes.value || []) : [];

    const errors = [];
    if (crossrefRes.status === 'rejected') errors.push('Crossref: ' + (crossrefRes.reason && crossrefRes.reason.message));
    if (openaireRes.status === 'rejected') errors.push('OpenAIRE: ' + (openaireRes.reason && openaireRes.reason.message));

    // Nicht eintragbare Foerderer (alles ausser SNSF/EC) nur als Hinweis
    const unsupported = [];
    [].concat(crossrefItems, openaireItems).forEach(i => {
        if (i.supported) return;
        const label = (i.rawFunderName || i.funderName || '').trim();
        if (!label) return;
        const existing = unsupported.find(u => u.name === label);
        const awards = i.awards || (i.rawAwardNumber ? [i.rawAwardNumber] : []);
        if (existing) awards.forEach(a => { if (!existing.awards.includes(a)) existing.awards.push(a); });
        else unsupported.push({ name: label, awards: awards.slice() });
    });

    // Merge-Key: Foerderer + normalisierte Award-Nummer
    const merged = new Map();
    const keyOf = i => `${i.funderKey}::${i.awardNumber}`;

    openaireItems.filter(i => i.supported && i.awardNumber).forEach(i => {
        merged.set(keyOf(i), {
            funderKey: i.funderKey,
            funderName: i.funderName,
            funderIdentifier: i.funderIdentifier,
            fundingStream: i.fundingStream,
            awardNumber: i.awardNumber,
            awardTitle: i.awardTitle,
            acronym: i.acronym,
            projectTitle: i.projectTitle,
            openaireId: i.openaireId,
            sources: ['OpenAIRE'],
            openaireInferred: i.inferred,
            openaireTrust: i.trust,
            rawAwardNumbers: [i.rawAwardNumber].filter(Boolean)
        });
    });

    crossrefItems.filter(i => i.supported && i.awardNumber).forEach(i => {
        const existing = merged.get(keyOf(i));
        if (existing) {
            if (!existing.sources.includes('Crossref')) existing.sources.push('Crossref');
            if (!existing.fundingStream && i.fundingStream) existing.fundingStream = i.fundingStream;
            if (i.rawAwardNumber && !existing.rawAwardNumbers.includes(i.rawAwardNumber)) {
                existing.rawAwardNumbers.push(i.rawAwardNumber);
            }
        } else {
            merged.set(keyOf(i), {
                funderKey: i.funderKey,
                funderName: i.funderName,
                funderIdentifier: i.funderIdentifier,
                fundingStream: i.fundingStream,
                awardNumber: i.awardNumber,
                awardTitle: '',
                acronym: null,
                projectTitle: '',
                openaireId: null,
                sources: ['Crossref'],
                rawAwardNumbers: [i.rawAwardNumber].filter(Boolean)
            });
        }
    });

    const items = Array.from(merged.values());

    // Anreichern: fehlende Titel/Streams aus DORA-Bestand bzw. OpenAIRE-Projektregister
    await Promise.all(items.map(async item => {
        const dora = await lookupDoraFunding(item.awardNumber, item.funderName);
        if (dora) {
            item.doraOccurrences = dora.occurrences;
            if (!item.sources.includes('DORA')) item.sources.push('DORA');
            // Hauskonvention hat Vorrang
            if (dora.awardTitle) item.awardTitle = dora.awardTitle;
            if (dora.fundingStream) item.fundingStream = dora.fundingStream;
            if (dora.funderIdentifier) item.funderIdentifier = dora.funderIdentifier;
        }

        if (!item.awardTitle || !item.fundingStream) {
            const project = await lookupOpenAireProjectByCode(item.awardNumber, item.funderKey);
            if (project) {
                if (!item.awardTitle && project.awardTitle) item.awardTitle = project.awardTitle;
                if (!item.fundingStream && project.fundingStream) item.fundingStream = project.fundingStream;
                if (!item.acronym && project.acronym) item.acronym = project.acronym;
                if (!item.projectTitle && project.projectTitle) item.projectTitle = project.projectTitle;
                if (!item.openaireId && project.openaireId) item.openaireId = project.openaireId;
                if (!item.sources.includes('OpenAIRE')) item.sources.push('OpenAIRE');
            }
        }

        // Konfidenz: DORA bestaetigt nur die Schreibweise, nicht die Zugehoerigkeit
        // des Papers zum Projekt - deshalb zaehlt dafuer nur Crossref/OpenAIRE.
        const hasCrossref = item.sources.includes('Crossref');
        const hasOpenAire = item.sources.includes('OpenAIRE');
        // Rein aus dem Volltext gemined (OpenAIRE-Inferenz ohne Verlagsangabe)
        item.textMined = !!item.openaireInferred && !hasCrossref;

        if (!item.awardTitle) {
            item.confidence = 'low';
        } else if (hasCrossref || (hasOpenAire && !item.openaireInferred)) {
            item.confidence = 'high';
        } else {
            item.confidence = 'medium';
        }

        item.complete = !!(item.funderName && item.awardNumber && item.awardTitle && item.fundingStream);
        item.projectUrl = item.openaireId
            ? `https://explore.openaire.eu/search/project?projectId=${encodeURIComponent(item.openaireId)}`
            : null;
    }));

    const rank = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => (rank[a.confidence] - rank[b.confidence])
        || String(a.awardNumber).localeCompare(String(b.awardNumber)));

    return { items: items, unsupported: unsupported, errors: errors };
}


// =====================================================================
// SUPPLEMENTS ZU EINEM ARTIKEL (Crossref + OpenAIRE + Repositorien)
// ---------------------------------------------------------------------
// Zwei Arten von "Supplement" kommen vor:
//   1. Datenpublikationen (Zenodo, figshare, Dryad, ERIC ...) - stehen in
//      den Metadaten von OpenAIRE (rund 11 % der Artikel) und selten in
//      Crossref (rund 0.3 %).
//   2. Die eigentliche Supporting Information des Verlags - die findet der
//      Landing-Page-Scan im Content-Script.
// Hier geht es um Punkt 1; bei Zenodo/figshare werden zusaetzlich die
// einzelnen Dateien samt direkter Download-URL aufgeloest.
// =====================================================================

const supplementCache = new Map();
const SUPPLEMENT_CACHE_MAX = 200;

function repositoryFromId(id) {
    const s = String(id || '');
    if (/10\.5281\/zenodo\.(\d+)/i.test(s) || /zenodo\.org\/(records?|record)\/(\d+)/i.test(s)) {
        const m = s.match(/10\.5281\/zenodo\.(\d+)/i) || s.match(/zenodo\.org\/(?:records?|record)\/(\d+)/i);
        return { name: 'Zenodo', key: 'zenodo', id: m[1] };
    }
    if (/10\.6084\/m9\.figshare\.(\d+)/i.test(s)) {
        return { name: 'figshare', key: 'figshare', id: s.match(/10\.6084\/m9\.figshare\.(\d+)/i)[1] };
    }
    if (/figshare\.com\/articles\/[^/]+\/[^/]+\/(\d+)/i.test(s)) {
        return { name: 'figshare', key: 'figshare', id: s.match(/figshare\.com\/articles\/[^/]+\/[^/]+\/(\d+)/i)[1] };
    }
    if (/10\.5061\/dryad/i.test(s)) return { name: 'Dryad', key: 'dryad', id: null };
    if (/10\.25678\//i.test(s)) return { name: 'Eawag ERIC', key: 'eric', id: null };
    return null;
}

// Einzelne Dateien eines Repositoriums samt direkter URL
// Zenodo liefert nur eine Kennung ("cc-by-4.0"), figshare Name und URL.
function normalizeLicense(roh) {
    if (!roh) return null;
    if (typeof roh === 'object' && roh.name) {
        return { name: roh.name, url: roh.url || null };
    }
    const id = String((roh && roh.id) || roh || '').trim();
    if (!id) return null;

    const cc = id.match(/^cc-([a-z-]+?)-?(\d\.\d)?$/i);
    if (cc) {
        const teile = cc[1].toLowerCase();
        const istCC0 = teile === 'zero' || teile === '0';
        // CC0 gibt es nur in Version 1.0
        const version = cc[2] || (istCC0 ? '1.0' : '4.0');
        const name = istCC0 ? 'CC0 ' + version : 'CC ' + teile.toUpperCase() + ' ' + version;
        const pfad = istCC0 ? 'publicdomain/zero' : 'licenses/' + teile;
        return { name: name, url: `https://creativecommons.org/${pfad}/${version}/` };
    }
    return { name: id.toUpperCase(), url: null };
}

async function fetchRepositoryFiles(repo) {
    try {
        if (repo.key === 'zenodo' && repo.id) {
            const res = await fetch(`https://zenodo.org/api/records/${repo.id}`, { cache: 'no-cache' });
            if (!res.ok) return { files: [] };
            const json = await res.json();
            return {
                title: json.title || (json.metadata && json.metadata.title) || '',
                license: normalizeLicense((json.metadata && json.metadata.license) || json.license),
                files: (json.files || []).map(f => ({
                    name: f.key,
                    size: f.size || 0,
                    url: (f.links && (f.links.self || f.links.download)) || null
                })).filter(f => f.url)
            };
        }
        if (repo.key === 'figshare' && repo.id) {
            const [dateien, meta] = await Promise.all([
                fetch(`https://api.figshare.com/v2/articles/${repo.id}/files`, { cache: 'no-cache' }),
                fetch(`https://api.figshare.com/v2/articles/${repo.id}`, { cache: 'no-cache' })
            ]);
            const liste = dateien.ok ? await dateien.json() : [];
            const info = meta.ok ? await meta.json() : {};
            return {
                title: String(info.title || '').replace(/\s+/g, ' ').trim(),
                license: normalizeLicense(info.license),
                files: (liste || []).map(f => ({
                    name: f.name,
                    size: f.size || 0,
                    url: f.download_url || null
                })).filter(f => f.url)
            };
        }
    } catch (e) {
        console.warn('Repository-Dateien nicht abrufbar:', repo, e);
    }
    return { files: [] };
}

// --- Crossref: relation.is-supplemented-by / has-part ---
function extractCrossrefSupplements(message) {
    const out = [];
    const rel = (message && message.relation) || {};
    ['is-supplemented-by', 'has-part'].forEach(typ => {
        [].concat(rel[typ] || []).forEach(eintrag => {
            const id = String(eintrag.id || '').trim();
            if (!id) return;
            const istDoi = (eintrag['id-type'] || '').toLowerCase() === 'doi';
            out.push({
                source: 'Crossref',
                relation: typ,
                doi: istDoi ? id : null,
                url: istDoi ? `https://doi.org/${id}` : id,
                title: '',
                type: 'dataset'
            });
        });
    });
    return out;
}

// --- OpenAIRE: IsSupplementedBy (Titel, DOI und URL liegen in der Relation) ---
async function fetchOpenAireSupplements(doi) {
    const url = `https://api.openaire.eu/search/publications?doi=${encodeURIComponent(doi)}&format=json`;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`OpenAIRE HTTP ${res.status}`);
    const json = await res.json();

    const asArray = v => (v === undefined || v === null) ? [] : (Array.isArray(v) ? v : [v]);
    const val = v => (v && typeof v === 'object') ? (v['$'] || '') : (v || '');

    const results = asArray(json && json.response && json.response.results && json.response.results.result);
    if (!results.length) return [];

    const entity = results[0] && results[0].metadata && results[0].metadata['oaf:entity']
        && results[0].metadata['oaf:entity']['oaf:result'];

    return asArray(entity && entity.rels && entity.rels.rel)
        .filter(r => r && r.to && /IsSupplementedBy/i.test(r.to['@class'] || ''))
        .map(r => {
            const pid = asArray(r.pid).find(p => (p['@classid'] || '').toLowerCase() === 'doi');
            const instanz = asArray(r.instance)[0] || {};
            const webUrl = val(instanz.webresource && instanz.webresource.url) || val(instanz.url);
            const supplementDoi = pid ? val(pid) : null;
            return {
                source: 'OpenAIRE',
                relation: 'IsSupplementedBy',
                doi: supplementDoi,
                url: supplementDoi ? `https://doi.org/${supplementDoi}` : (webUrl || null),
                title: val(r.title),
                creators: asArray(r.creator).map(c => val(c)).filter(Boolean).slice(0, 3),
                type: val(r.resulttype && r.resulttype['@classid']) || 'dataset'
            };
        })
        .filter(s => s.url);
}

// --- figshare kennt die Artikel-DOI als "resource_doi" ---
// ACS und andere Verlage legen ihre Supporting Information dort ab. Dieser
// Weg braucht die Verlagsseite nicht, die bei ACS ohnehin gesperrt ist.
async function fetchFigshareByArticleDoi(doi) {
    try {
        const res = await fetch('https://api.figshare.com/v2/articles/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resource_doi: doi })
        });
        if (!res.ok) return [];
        const treffer = await res.json();
        return (treffer || []).slice(0, 5).map(a => ({
            source: 'figshare',
            relation: 'resource_doi',
            doi: a.doi || null,
            url: a.url_public_html || (a.doi ? `https://doi.org/${a.doi}` : null),
            title: String(a.title || '').replace(/\s+/g, ' ').trim(),
            type: 'dataset',
            figshareId: a.id
        })).filter(a => a.url);
    } catch (e) {
        console.warn('figshare-Suche fehlgeschlagen:', e);
        return [];
    }
}

// --- Elsevier: Supplements über die PII vom CDN ---
// ScienceDirect sperrt automatisierte Abrufe, der Auslieferungs-CDN
// (ars.els-cdn.com) ist dagegen offen. Die Dateien heissen dort
// "1-s2.0-<PII>-mmc<N>.<endung>" und lassen sich per HEAD prüfen.
const ELSEVIER_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'zip', 'doc', 'xls', 'csv', 'txt'];
const ELSEVIER_MAX_INDEX = 8;

function elsevierPiiFromCrossref(message) {
    if (!message) return null;
    const kandidaten = [].concat(message['alternative-id'] || []);
    const treffer = kandidaten.find(id => /^S\d{15,17}$/i.test(String(id).trim()));
    if (treffer) return String(treffer).trim();

    const primaer = (message.resource && message.resource.primary && message.resource.primary.URL) || '';
    const ausUrl = primaer.match(/pii\/(S\d{15,17})/i);
    return ausUrl ? ausUrl[1] : null;
}

async function probeElsevierFile(pii, index, endung) {
    const url = `https://ars.els-cdn.com/content/image/1-s2.0-${pii}-mmc${index}.${endung}`;
    try {
        const res = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
        if (!res.ok) return null;
        const laenge = parseInt(res.headers.get('content-length') || '0', 10);
        return { url: url, name: `mmc${index}.${endung}`, size: laenge || 0 };
    } catch (e) {
        return null;
    }
}

async function fetchElsevierSupplements(pii) {
    if (!pii) return [];
    const gefunden = [];

    for (let index = 1; index <= ELSEVIER_MAX_INDEX; index++) {
        let treffer = null;
        for (const endung of ELSEVIER_EXTENSIONS) {
            treffer = await probeElsevierFile(pii, index, endung);
            if (treffer) break;
        }
        // Elsevier nummeriert lückenlos: beim ersten fehlenden Index aufhören
        if (!treffer) break;
        gefunden.push({
            source: 'Elsevier',
            relation: 'cdn',
            type: 'file',
            title: index === 1 ? 'Supplementary material' : `Supplementary material ${index}`,
            fileName: treffer.name,
            url: treffer.url,
            isFile: true,
            files: [{ name: treffer.name, size: treffer.size, url: treffer.url }]
        });
    }

    return gefunden;
}

async function fetchSupplements(doi) {
    const key = String(doi || '').trim().toLowerCase();
    if (supplementCache.has(key)) return supplementCache.get(key);

    const crossrefWerk = await fetch(`https://api.crossref.org/works/${doi}`, { cache: 'no-cache' })
        .then(r => r.ok ? r.json() : null)
        .then(j => (j && j.message) || null)
        .catch(() => null);

    const [crossrefRes, openaireRes, figshareRes, elsevierRes] = await Promise.allSettled([
        Promise.resolve(extractCrossrefSupplements(crossrefWerk)),
        fetchOpenAireSupplements(doi),
        fetchFigshareByArticleDoi(doi),
        fetchElsevierSupplements(elsevierPiiFromCrossref(crossrefWerk))
    ]);

    const errors = [];
    if (crossrefRes.status === 'rejected') errors.push('Crossref: ' + (crossrefRes.reason && crossrefRes.reason.message));
    if (openaireRes.status === 'rejected') errors.push('OpenAIRE: ' + (openaireRes.reason && openaireRes.reason.message));

    // Zusammenfuehren, Dubletten ueber DOI bzw. URL erkennen
    const items = [];
    const merge = eintrag => {
        const kennung = (eintrag.doi || eintrag.url || '').toLowerCase();
        const vorhanden = items.find(i => (i.doi || i.url || '').toLowerCase() === kennung);
        if (vorhanden) {
            if (!vorhanden.title && eintrag.title) vorhanden.title = eintrag.title;
            if (!vorhanden.sources.includes(eintrag.source)) vorhanden.sources.push(eintrag.source);
            return;
        }
        items.push(Object.assign({}, eintrag, { sources: [eintrag.source] }));
    };
    (openaireRes.status === 'fulfilled' ? openaireRes.value : []).forEach(merge);
    (crossrefRes.status === 'fulfilled' ? crossrefRes.value : []).forEach(merge);
    (figshareRes.status === 'fulfilled' ? figshareRes.value : []).forEach(merge);
    (elsevierRes.status === 'fulfilled' ? elsevierRes.value : []).forEach(merge);

    // Repositorien aufloesen: Dateiliste mit direkten Download-Links
    await Promise.all(items.map(async item => {
        const repo = item.figshareId
            ? { name: 'figshare', key: 'figshare', id: String(item.figshareId) }
            : repositoryFromId(item.doi || item.url);
        if (!repo) return;
        item.repository = repo.name;
        const inhalt = await fetchRepositoryFiles(repo);
        item.files = inhalt.files || [];
        if (!item.title && inhalt.title) item.title = inhalt.title;
        if (inhalt.license) item.license = inhalt.license;
    }));

    const result = { items: items, errors: errors };
    if (supplementCache.size >= SUPPLEMENT_CACHE_MAX) {
        supplementCache.delete(supplementCache.keys().next().value);
    }
    supplementCache.set(key, result);
    return result;
}
