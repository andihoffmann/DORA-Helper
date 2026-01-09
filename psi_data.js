// psi_data.js

const DEFAULT_PSI_HISTORY = {
}

let PSI_HISTORY = DEFAULT_PSI_HISTORY;

async function initPsiData() {
    return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['psiDataContent'], function(result) {
                if (result.psiDataContent) {
                    console.log("[DORA Helper] Loading PSI affiliation data from local storage.");
                    try {
                        const match = result.psiDataContent.match(/const\s+PSI_HISTORY\s*=\s*(\{[\s\S]*\})/);
                        if (match && match[1]) {
                            let jsonString = match[1];
                            jsonString = jsonString.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');

                            PSI_HISTORY = JSON.parse(jsonString);
                            console.log("[DORA Helper] Custom PSI data loaded.");
                        }
                    } catch (e) {
                        console.error("[DORA Helper] Failed to parse custom PSI data. Using default.", e);
                    }
                }
                resolve();
            });
        } else {
            resolve();
        }
    });
}
