// psi_data.js

const DEFAULT_PSI_HISTORY = {
}

let PSI_HISTORY = DEFAULT_PSI_HISTORY;

async function initPsiData() {
    return new Promise((resolve) => {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            chrome.storage.local.get(['psiData_meta', 'psiDataContent', 'psiData'], async function (result) {
                let jsonContent = null;

                // 1. Try Chunked Data (New Method)
                if (result.psiData_meta && result.psiData_meta.totalChunks) {
                    console.log(`[DORA Helper] Found ${result.psiData_meta.totalChunks} chunks of PSI Data.`);
                    try {
                        const keys = [];
                        for (let i = 0; i < result.psiData_meta.totalChunks; i++) {
                            keys.push(`psiData_chunk_${i}`);
                        }

                        // Fetch all chunks
                        const chunks = await new Promise(res => chrome.storage.local.get(keys, res));

                        // Reassemble
                        let fullString = "";
                        for (let i = 0; i < result.psiData_meta.totalChunks; i++) {
                            fullString += (chunks[`psiData_chunk_${i}`] || "");
                        }
                        jsonContent = fullString;
                        console.log("[DORA Helper] Successfully reassembled data.");
                    } catch (e) {
                        console.error("[DORA Helper] Chunk reassembly failed:", e);
                    }
                }

                // 2. Fallback: Legacy Single Key
                if (!jsonContent) {
                    jsonContent = result.psiDataContent || result.psiData;
                }

                if (jsonContent) {
                    console.log("[DORA Helper] Check for variable assignment...");
                    try {
                        // Check if it's "const PSI_HISTORY = {...}" or pure JSON
                        // The generated file usually has "const PSI_HISTORY = " prefix
                        let jsonString = jsonContent;
                        const match = jsonContent.match(/const\s+PSI_HISTORY\s*=\s*(\{[\s\S]*\})/);
                        if (match && match[1]) {
                            jsonString = match[1];
                            // Fix trailing commas if present (simple regex approach)
                            jsonString = jsonString.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
                        }

                        PSI_HISTORY = JSON.parse(jsonString);
                        console.log("[DORA Helper] PSI affiliation data loaded successfully.");
                    } catch (e) {
                        console.error("[DORA Helper] Failed to parse PSI data JSON.", e);
                        // Try parsing raw content if strict regex failed (maybe it's just pure JSON)
                        try {
                            if (jsonContent.trim().startsWith('{')) {
                                PSI_HISTORY = JSON.parse(jsonContent);
                                console.log("[DORA Helper] Parsed as raw JSON.");
                            }
                        } catch (e2) { console.error("Double failure parsing JSON.", e2); }
                    }
                } else {
                    console.warn("[DORA Helper] No PSI data found in storage.");
                }
                resolve();
            });
        } else {
            console.warn("[DORA Helper] Storage API not available.");
            resolve();
        }
    });
}
