// Standard-Liste (falls noch nichts gespeichert ist)
const defaultExceptions = `
x-ray -> X-ray
x-rays -> X-rays
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

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);