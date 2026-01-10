// background.js

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

        // Use 127.0.0.1 to avoid some localhost resolution issues
        const API_URL = "http://127.0.0.1:7860/analyze";

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

async function analyzePdfUrl(pdfUrl) {
    try {
        // Fetch the PDF from the URL
        let pdfRes;
        let usePythonDownload = false;

        try {
            pdfRes = await fetch(pdfUrl, { credentials: 'include' });
        } catch (e) {
            try {
                // Fallback 1: Ohne Credentials & ohne Referrer (hilft bei strikten CDNs)
                pdfRes = await fetch(pdfUrl, { credentials: 'omit', referrerPolicy: 'no-referrer' });
            } catch (e2) {
                // Fallback 2: Browser blockiert komplett (CORS) -> Python soll downloaden
                console.warn("Browser fetch failed (CORS), delegating to Python:", e2);
                usePythonDownload = true;
            }
        }

        // Wenn Browser-Fetch erfolgreich war, aber Status nicht OK ist
        if (!usePythonDownload && (!pdfRes || !pdfRes.ok)) {
             // Auch hier: Python probieren lassen, vielleicht ist es ein IP-Auth Problem
             usePythonDownload = true;
        }

        const formData = new FormData();

        if (usePythonDownload) {
            // Wir senden die URL an Python, damit Python sie herunterlädt
            formData.append("pdf_url", pdfUrl);
        } else {
            // Wir haben das PDF im Browser, senden es als Datei
            const blob = await pdfRes.blob();
            formData.append("file", blob, "downloaded.pdf");
        }

        const API_URL = "http://127.0.0.1:7860/analyze";

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
