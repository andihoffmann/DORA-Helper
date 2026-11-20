// Baut ltwa.json aus der LTWA-Liste des ISSN International Centre.
//
// Aufruf: node scripts/build-ltwa.js <LTWA.csv>
// Die CSV ist tabulatorgetrennt: WORD, ABBREVIATIONS, LANGUAGE CODES
// (erste Zeile Kopf). Quelle der aktuellen Fassung: pyiso4 0.1.6
// (LTWA_20210702.csv); neuere Fassungen gibt es bei https://www.issn.org/.
//
// Ergebnis: [[muster, ersatz, sprachen], ...]; muster ist wie in iso4.js
// normalisiert (ASCII, klein, Anmerkungen in Klammern entfernt).

const fs = require('fs');
const path = require('path');
const Iso4 = require('../iso4.js');

const quelle = process.argv[2];
if (!quelle) { console.error('Aufruf: node scripts/build-ltwa.js <LTWA.csv>'); process.exit(1); }

const zeilen = fs.readFileSync(quelle, 'utf8').split(/\r?\n/).slice(1).filter(z => z.trim());
const eintraege = [];
let verworfen = 0;
for (const zeile of zeilen) {
    const felder = zeile.split('\t');
    if (felder.length !== 3) { verworfen++; continue; }
    const muster = Iso4.normal(felder[0].replace(/\(.*\)/g, '').trim()).toLowerCase();
    let ersatz = felder[1].trim();
    if (['n.a.', 'n. a.', 'n.a'].includes(ersatz)) ersatz = '-';
    const sprachen = felder[2].trim().split(/[\s,]+/).filter(Boolean).join(' ');
    if (!muster) { verworfen++; continue; }
    eintraege.push(sprachen === 'mul' ? [muster, ersatz] : [muster, ersatz, sprachen]);
}

const ziel = path.join(__dirname, '..', 'ltwa.json');
fs.writeFileSync(ziel, JSON.stringify(eintraege));
console.log(`${eintraege.length} Einträge geschrieben (${verworfen} verworfen) -> ${ziel} (${fs.statSync(ziel).size} Bytes)`);
