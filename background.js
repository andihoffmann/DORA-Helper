// background.js

let activeDoraTabId = null;
let pdfReferrerMap = new Map(); // Speichert Referrer zu PDF-URLs
let pdfTabMap = new Map(); // Speichert Tab-IDs zu PDF-URLs (wichtig für Blobs)

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
        analyzePdfUrl(request.pdfUrl, request.localPath)
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
                return response.text().then(text => ({ text, finalUrl }));
            })
            .then(result => sendResponse({ success: true, data: result.text, finalUrl: result.finalUrl }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "registerDoraTab") {
        activeDoraTabId = sender.tab.id;
        sendResponse({ success: true });
        return true;
    }

    if (request.action === "checkScopus") {
        checkScopusAffiliation(request.doi)
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
                        filename: item.filename.split(/[/\\]/).pop(),
                        localPath: item.filename
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
        const [unpaywallRes, crossrefRes, openalexRes] = await Promise.all([
            fetch(`https://api.unpaywall.org/v2/${doi}?email=${email}`),
            fetch(`https://api.crossref.org/works/${doi}`),
            fetch(`https://api.openalex.org/works/doi:${doi}`)
        ]);

        const unpaywallData = unpaywallRes.ok ? await unpaywallRes.json() : { is_oa: false };
        
        let crossrefData = {};
        if (crossrefRes.ok) {
            const json = await crossrefRes.json();
            crossrefData = json.message || {};
        }

        let openalexData = {};
        if (openalexRes.ok) {
            openalexData = await openalexRes.json();
        }

        return {
            unpaywall: unpaywallData,
            crossref: crossrefData,
            openalex: openalexData
        };
    } catch (error) {
        throw new Error("Netzwerkfehler oder ungültige DOI");
    }
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

        // Hugging Face Space
        const API_URL = "https://andrehoffmann80-pdf-analyzer.hf.space/analyze";

        const response = await fetch(API_URL, {
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

        // Skip permission check for blob URLs (they don't have a requestable origin)
        if (!isBlob) {
            // Extract origin from PDF URL for permission request
            const urlObj = new URL(pdfUrl);
            const origin = urlObj.origin;
            const permissionPattern = `${urlObj.protocol}//${urlObj.hostname}/*`;

            console.log('Checking permissions for:', permissionPattern);

            // Check and request permissions if needed
            try {
                const hasPermission = await chrome.permissions.contains({
                    origins: [permissionPattern]
                });

                if (!hasPermission) {
                    console.log('Requesting permission for:', permissionPattern);
                    // Note: This will show a permission prompt to the user
                    const granted = await chrome.permissions.request({
                        origins: [permissionPattern]
                    });

                    if (!granted) {
                        throw new Error('User denied permission for ' + origin);
                    }
                    console.log('Permission granted for:', permissionPattern);
                } else {
                    console.log('Permission already granted for:', permissionPattern);
                }
            } catch (permError) {
                console.error('Permission check/request failed:', permError);
                // Continue anyway - the wildcard permission might still work
            }
        } else {
            console.log('Blob URL detected - skipping permission check');
        }

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
            target: { tabId: targetTab.id },
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

        const API_URL = "https://andrehoffmann80-pdf-analyzer.hf.space/analyze";
        const response = await fetch(API_URL, {
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

            const API_URL = "https://andrehoffmann80-pdf-analyzer.hf.space/analyze";
            const response = await fetch(API_URL, {
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

async function analyzePdfUrl(pdfUrl, localPath) {
    try {
        let blob = null;
        let usePythonDownload = false;

        // 1. Versuch: Lokale Datei laden (Cache/Download)
        // Erfordert "Zugriff auf Datei-URLs zulassen" in den Extension-Settings
        if (localPath) {
            try {
                // Pfad zu file-URL konvertieren
                let normalizedPath = localPath.replace(/\\/g, '/');
                if (!normalizedPath.startsWith('/')) normalizedPath = '/' + normalizedPath;
                // Sicherstellen, dass Sonderzeichen (Leerzeichen!) korrekt kodiert sind
                const fileUrl = new URL('file://' + normalizedPath).href;
                
                const res = await fetch(fileUrl);
                if (res.ok) {
                    blob = await res.blob();
                    console.log("PDF erfolgreich von lokaler Datei geladen:", fileUrl);
                }
            } catch (e) {
                console.warn("Lokaler Dateizugriff fehlgeschlagen (Fehlt 'Allow access to file URLs'?):", e);
            }
        }

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
                        target: { tabId: targetTab.id, allFrames: false },
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
                                    } catch(e) {
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
            if (localPath) {
                throw new Error("Automatischer Download-Zugriff blockiert (Firefox?). Bitte Datei manuell per Drag & Drop importieren.");
            }
            formData.append("pdf_url", pdfUrl);
        }

        const API_URL = "https://andrehoffmann80-pdf-analyzer.hf.space/analyze";

        const response = await fetch(API_URL, {
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

async function checkScopusAffiliation(doi) {
    // API Key sicher aus den Einstellungen laden
    const storage = await chrome.storage.sync.get('scopusApiKey');
    const apiKey = storage.scopusApiKey;

    if (!apiKey) {
        throw new Error("Scopus API Key fehlt. Bitte in den Erweiterungs-Einstellungen (Rechtsklick auf Icon -> Optionen) eintragen.");
    }

    const url = `https://api.elsevier.com/content/abstract/doi/${doi}?apiKey=${apiKey}&httpAccept=application/json`;
    
    const res = await fetch(url);

    if (!res.ok) {
        if (res.status === 404) throw new Error("DOI nicht in Scopus gefunden");
        if (res.status === 401) throw new Error("API Key ungültig");
        throw new Error(`Scopus API Fehler: ${res.status}`);
    }

    const data = await res.json();
    
    try {
        // Pfad zu den Korrespondenz-Daten
        const bib = data['abstracts-retrieval-response']?.item?.bibrecord?.head?.correspondence;
        
        if (!bib) return { isLib4Ri: false, text: "Keine Corresponding-Author Daten in Scopus" };

        // Helper: Prüft auf Lib4Ri Institute
        const isLib4Ri = (str) => {
            if (!str) return false;
            const s = str.toLowerCase();
            return s.includes('paul scherrer') || s.includes('psi') || 
                   s.includes('eawag') || s.includes('empa') || 
                   s.includes('wsl') || s.includes('forest, snow and landscape');
        };

        let affilText = "";
        const corrs = Array.isArray(bib) ? bib : [bib];
        
        for (const c of corrs) {
            if (c.affiliation) {
                const aff = c.affiliation;
                // Organization kann Array oder String sein
                let orgs = [];
                if (Array.isArray(aff.organization)) {
                    orgs = aff.organization.map(o => o['$'] || o);
                } else if (aff.organization) {
                    orgs = [aff.organization];
                }
                
                const fullText = orgs.join(', ') + (aff.country ? `, ${aff.country}` : '');
                if (isLib4Ri(fullText)) {
                    return { isLib4Ri: true, affiliation: fullText };
                }
                affilText += fullText + "; ";
            }
        }
        
        return { isLib4Ri: false, affiliation: affilText.replace(/; $/, '') };
    } catch (e) {
        console.error(e);
        throw new Error("Fehler beim Parsen der Scopus-Daten");
    }
}
