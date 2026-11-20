// Entfernt eval / new Function aus dem mitgelieferten pdf.js (2.16.105).
//
// Alle Stellen sind in pdf.js hinter der Pruefung "isEvalSupported" versteckt
// bzw. nur unter Node aktiv. Im Add-on verbietet die Sicherheitsrichtlinie
// (script-src 'self') eval ohnehin, pdf.js nimmt dort also schon heute die
// Ausweichwege. Der Patch macht das ausdruecklich und raeumt die
// DANGEROUS_EVAL-Warnungen von web-ext lint ab.
//
// Aufruf: node scripts/patch-pdfjs.js   (mehrfaches Ausfuehren ist harmlos)

const fs = require('fs');
const path = require('path');

const WURZEL = path.join(__dirname, '..');

// [Datei, Suchtext, Ersatz, Erklaerung]
const ERSETZUNGEN = [
    ['pdf.min.js',
        'function isEvalSupported(){try{new Function("");return!0}catch(t){return!1}}',
        'function isEvalSupported(){return!1}',
        'Funktionstest meldet immer "kein eval"'],
    ['pdf.min.js',
        'return this.compiledGlyphs[e]=new Function("c","size",t.join(""))',
        'return this.compiledGlyphs[e]=null',
        'Glyphen-Compiler (nur bei isEvalSupported erreichbar)'],
    ['pdf.min.js',
        'const worker=eval("require")(this.workerSrc)',
        'const worker=require(this.workerSrc)',
        'Worker-Laden unter Node'],
    ['pdf.worker.min.js',
        'function isEvalSupported(){try{new Function("");return!0}catch(e){return!1}}',
        'function isEvalSupported(){return!1}',
        'Funktionstest meldet immer "kein eval"'],
    ['pdf.worker.min.js',
        'if(e)return new Function("src","srcOffset","dest","destOffset",e)',
        'if(e)return null',
        'PostScript-Compiler (nur bei isEvalSupported erreichbar)']
];

let geaendert = 0;
const inhalte = new Map();

for (const [datei, alt, neu, zweck] of ERSETZUNGEN) {
    const pfad = path.join(WURZEL, datei);
    let text = inhalte.has(pfad) ? inhalte.get(pfad) : fs.readFileSync(pfad, 'utf8');
    const anzahl = text.split(alt).length - 1;
    if (anzahl === 1) {
        text = text.replace(alt, neu);
        geaendert++;
        console.log(`gepatcht   ${datei}: ${zweck}`);
    } else if (anzahl === 0 && text.includes(neu)) {
        console.log(`bereits ok ${datei}: ${zweck}`);
    } else {
        console.error(`FEHLER     ${datei}: "${zweck}" ${anzahl}x gefunden - andere pdf.js-Version? Nichts geschrieben.`);
        process.exit(1);
    }
    inhalte.set(pfad, text);
}

for (const [pfad, text] of inhalte) {
    if (/\beval\(|new Function\b/.test(text)) {
        console.error(`FEHLER     ${path.basename(pfad)}: enthaelt noch eval/new Function. Nichts geschrieben.`);
        process.exit(1);
    }
}

if (geaendert) {
    for (const [pfad, text] of inhalte) fs.writeFileSync(pfad, text, 'utf8');
}
console.log(geaendert ? `${geaendert} Stelle(n) ersetzt.` : 'Nichts zu tun.');
