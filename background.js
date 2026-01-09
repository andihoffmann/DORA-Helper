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
});

async function fetchMetadata(doi) {
    // BITTE E-MAIL EINTRAGEN (Pflicht für Unpaywall):
    const email = "dora@lib4ri.ch"; 
    
    try {
        const [unpaywallRes, crossrefRes] = await Promise.all([
            fetch(`https://api.unpaywall.org/v2/${doi}?email=${email}`),
            fetch(`https://api.crossref.org/works/${doi}`)
        ]);

        const unpaywallData = unpaywallRes.ok ? await unpaywallRes.json() : { is_oa: false };
        
        let crossrefData = {};
        if (crossrefRes.ok) {
            const json = await crossrefRes.json();
            crossrefData = json.message || {};
        }

        return {
            unpaywall: unpaywallData,
            crossref: crossrefData // Return full object to allow more flexible usage in content.js
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