// Standard-Liste (falls noch nichts gespeichert ist)
const defaultExceptions = `
x-ray -> X-ray
x-rays -> X-rays
3d -> 3D
dna -> DNA
rna -> RNA
ph -> pH
nmr -> NMR
hplc -> HPLC
uv -> UV
ir -> IR
pcr -> PCR
tem -> TEM
sem -> SEM
afm -> AFM
xps -> XPS
switzerland -> Switzerland
zurich -> Zurich
`.trim();

// 1. Optionen laden
function restoreOptions() {
  chrome.storage.sync.get({
    exceptionList: defaultExceptions
  }, function(items) {
    document.getElementById('exceptions').value = items.exceptionList;
  });

  // Load PSI Data status
  chrome.storage.local.get(['psiDataLastUpdated'], function(result) {
      const lastUpdated = result.psiDataLastUpdated;
      const statusDiv = document.getElementById('lastUpdated');
      if (lastUpdated) {
          statusDiv.textContent = 'Zuletzt aktualisiert: ' + new Date(lastUpdated).toLocaleString();
      } else {
          statusDiv.textContent = 'Noch keine benutzerdefinierten Daten geladen.';
      }
  });
}

// 2. Optionen speichern
function saveOptions() {
  const text = document.getElementById('exceptions').value;
  
  chrome.storage.sync.set({
    exceptionList: text
  }, function() {
    // Feedback zeigen
    const status = document.getElementById('status');
    status.style.display = 'inline';
    setTimeout(function() {
      status.style.display = 'none';
    }, 1500);
  });
}

// 3. PSI Data Upload
function handlePsiDataUpload() {
    const fileInput = document.getElementById('psiDataFile');
    const statusSpan = document.getElementById('uploadStatus');

    if (fileInput.files.length === 0) {
        statusSpan.textContent = 'Bitte wählen Sie eine Datei aus.';
        statusSpan.style.color = 'red';
        statusSpan.style.display = 'inline';
        return;
    }

    const file = fileInput.files[0];
    const reader = new FileReader();

    reader.onload = function(e) {
        const content = e.target.result;

        // Basic validation
        if (!content.includes('const PSI_HISTORY = {')) {
            statusSpan.textContent = 'Ungültiges Format. "const PSI_HISTORY = {" nicht gefunden.';
            statusSpan.style.color = 'red';
            statusSpan.style.display = 'inline';
            return;
        }

        // Try to extract JSON part
        const match = content.match(/const\s+PSI_HISTORY\s*=\s*(\{[\s\S]*\})/);
        if (match && match[1]) {
            // Validate if it is parseable JSON (requires quoted keys)
            try {
                // We try to parse it to ensure it's valid JSON.
                // If the user's JS file uses unquoted keys (standard JS), JSON.parse will fail.
                // We can try to be lenient or ask the user to provide JSON.
                // For now, we just store the text and let the content script handle the parsing/regex.
                // But to be safe, we should probably encourage JSON format.

                // Let's just store the whole content for now.
                chrome.storage.local.set({
                    psiDataContent: content,
                    psiDataLastUpdated: Date.now()
                }, function() {
                    if (chrome.runtime.lastError) {
                        statusSpan.textContent = 'Fehler beim Speichern: ' + chrome.runtime.lastError.message;
                        statusSpan.style.color = 'red';
                    } else {
                        statusSpan.textContent = 'Daten erfolgreich aktualisiert!';
                        statusSpan.style.color = 'green';
                        restoreOptions();
                    }
                    statusSpan.style.display = 'inline';
                });
            } catch (err) {
                 statusSpan.textContent = 'Fehler: ' + err.message;
                 statusSpan.style.color = 'red';
                 statusSpan.style.display = 'inline';
            }
        } else {
            statusSpan.textContent = 'Konnte Daten-Objekt nicht extrahieren.';
            statusSpan.style.color = 'red';
            statusSpan.style.display = 'inline';
        }
    };

    reader.readAsText(file);
}

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);
document.getElementById('uploadPsiData').addEventListener('click', handlePsiDataUpload);
