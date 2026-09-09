#!/usr/bin/env node
/**
 * Erzeugt handbuch.json fuer den DORA Helper aus dem Wiki-Export des
 * Projekts DORA-MCP-Checker (docs/kb/wiki, Confluence-Space "DORA_Handbuch").
 *
 * Warum ein Auszug und keine Abfrage zur Laufzeit:
 * Die Wissensbasis dort ist eine Chroma-SQLite mit lokalem ONNX-Modell. Eine
 * Browser-Erweiterung kann weder SQLite lesen noch Vektoren rechnen, und ein
 * lokaler Dienst soll nicht laufen muessen. Der Export ist deshalb ein
 * statischer, nach Formularfeldern geordneter Auszug - offline, ohne Dienst,
 * ohne Kosten. Er ist zugleich der Kontext, den eine spaetere LLM-Pruefung
 * mitschicken kann.
 *
 * Aufruf:
 *   node scripts/handbuch/erzeuge_handbuch.js [pfad-zum-wiki-export] [ziel.json]
 *
 * Ohne Argumente: ../DORA-MCP-Checker/docs/kb/wiki -> ./handbuch.json
 */

const fs = require('fs');
const path = require('path');

const STANDARD_QUELLE = path.resolve(__dirname, '..', '..', '..', '..',
    'DORA-MCP-Checker', 'docs', 'kb', 'wiki');
const STANDARD_ZIEL = path.resolve(__dirname, '..', '..', 'handbuch.json');

// Formularfeld -> Wiki-Thema. Links steht, wie der Helper das Feld nennt
// (dieselben Bezeichnungen wie in der Validierung), rechts die Themen im
// Handbuch, in der Reihenfolge ihrer Zustaendigkeit.
const FELD_THEMEN = {
    'Article Title': ['Article Title', 'Title'],
    'Title': ['Title', 'Article Title'],
    'Keywords': ['Keywords'],
    'Abstract': ['Abstract'],
    'Authors': ['Authors and Editors', 'Authors', 'Autorenobjekte', 'Autor neu erfassen'],
    'Editors': ['Authors and Editors', 'Authors'],
    'Conference Name': ['Conference Name'],
    'Proceedings Title': ['Proceedings Paper / Conference Item', 'Conference Name'],
    'Series Title': ['Series Title', 'Series_Title'],
    'Book Title': ['Book / Book Chapter', 'Book', 'Title'],
    'Journal Title': ['Journal Title', 'Zeitschriftenobjekte',
        'Finden, editieren und neu erfassen von Zeitschriften-Objekten'],
    'Publisher': ['Publisher'],
    'Publication Status': ['Publication Status'],
    'Publication Type': ['Publication Type'],
    'Volume': ['Volume'],
    'Issue': ['Issue'],
    'Pages': ['Pages'],
    'Language': ['Language'],
    'Funding': ['Funding'],
    'Quality Control': ['Quality Control und Quality Control ID'],
    'Identifiers': ['Identifiers'],
    'Affiliation': ['Abteilungen', 'Abteilungsobjekte'],
    'Document Availability': ['Accepted Versions', 'Handhabung von Accepted Versions in DORA'],
    'Conditions of Reuse': ['Accepted Versions', 'Handhabung von Accepted Versions in DORA'],
    'PDF': ['PDFs hochladen', 'PDF hochladen', 'PDFs austauschen'],
    'Tags': ['Bearbeitungs-Tags'],
    'Spezialfälle': ['Spezialfälle beim Erfassen', 'Spezialfälle']
};

// Entwurfsfassungen erkennen - im Wiki liegen Arbeitsstaende neben der
// gueltigen Seite ("Keywords_neu", "Volume_in Abklärung", "Kopie von ...").
const ENTWURF_RE = /(_neu|_besprochen|_alt|_old|_kopie|_v\d+|_in Abkl|^Kopie von )/i;

function grundthema(titel) {
    return titel
        .replace(/^Kopie von\s+/i, '')
        .replace(/_(neu|besprochen|alt|old|kopie|v\d+|in Abkl\w*)\s*$/i, '')
        .trim();
}

function leseSeiten(quelle) {
    return fs.readdirSync(quelle)
        .filter(f => f.endsWith('.md'))
        .map(datei => {
            const roh = fs.readFileSync(path.join(quelle, datei), 'utf8');
            const kopf = /^---\r?\n([\s\S]*?)\r?\n---/.exec(roh);
            const kopfText = kopf ? kopf[1] : '';
            const titel = ((/title:\s*'?(.+?)'?\s*$/m.exec(kopfText) || [])[1] || '').trim();
            const seitenId = (/page_id:\s*(\d+)/.exec(kopfText) || [])[1] || '';
            const text = roh.replace(/^---[\s\S]*?---\r?\n/, '').trim();
            return {
                datei, titel, seitenId: Number(seitenId) || 0, text,
                thema: grundthema(titel),
                entwurf: ENTWURF_RE.test(titel)
            };
        })
        .filter(p => p.titel && p.text);
}

// Aus einer Seite die eigentlichen Regeln ziehen: die Aufzaehlungspunkte.
// Fliesstext bleibt im Volltext erhalten, aber fuer die Anzeige im Formular
// sind die Punkte das Brauchbare.
function regelnAusText(text) {
    const zeilen = text.split(/\r?\n/);
    const regeln = [];
    let letzteEbene1 = -1;

    zeilen.forEach(zeile => {
        const punkt = /^\s*(?:[*+-]|\d+\.)\s+(.*\S)\s*$/.exec(zeile);
        if (!punkt) return;

        const einzug = (/^\s*/.exec(zeile) || [''])[0].length;
        const istUnterpunkt = einzug >= 2 || /^\s*\+/.test(zeile);
        const inhalt = punkt[1]
            .replace(/\*\*(.+?)\*\*/g, '$1')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/\s+/g, ' ')
            .trim();
        if (inhalt.length < 8) return;

        // Unterpunkte an den vorherigen Punkt haengen, damit Ausnahmen nicht
        // ohne ihre Regel dastehen ("Ausnahme: ausser Eigennamen ...").
        if (istUnterpunkt && letzteEbene1 >= 0) {
            regeln[letzteEbene1] += ' — ' + inhalt;
            return;
        }
        regeln.push(inhalt);
        letzteEbene1 = regeln.length - 1;
    });

    return regeln;
}

function baueAuszug(quelle) {
    const seiten = leseSeiten(quelle);

    // Je Thema die maßgebliche Fassung: keine Entwurfsfassung, dann die
    // hoechste Seiten-ID (in Confluence die jüngere Seite).
    const nachThema = new Map();
    seiten.forEach(p => {
        const bisher = nachThema.get(p.thema);
        if (!bisher) { nachThema.set(p.thema, p); return; }

        const besser =
            (bisher.entwurf && !p.entwurf) ||
            (bisher.entwurf === p.entwurf && p.seitenId > bisher.seitenId);
        if (besser) nachThema.set(p.thema, p);
    });

    const fassungen = new Map();
    seiten.forEach(p => fassungen.set(p.thema, (fassungen.get(p.thema) || 0) + 1));

    const felder = {};
    let uebernommen = 0;

    Object.keys(FELD_THEMEN).forEach(feld => {
        const abschnitte = [];
        FELD_THEMEN[feld].forEach(thema => {
            const seite = nachThema.get(thema);
            if (!seite) return;
            abschnitte.push({
                thema: thema,
                seitenId: seite.seitenId,
                fassungen: fassungen.get(thema) || 1,
                regeln: regelnAusText(seite.text),
                volltext: seite.text.length > 2500 ? seite.text.slice(0, 2500) + ' […]' : seite.text
            });
        });
        if (abschnitte.length) {
            felder[feld] = abschnitte;
            uebernommen += abschnitte.length;
        }
    });

    const fehlend = Object.keys(FELD_THEMEN).filter(f => !felder[f]);

    return {
        auszug: {
            erzeugt: new Date().toISOString().slice(0, 10),
            quelle: 'DORA_Handbuch (Confluence-Space TD), Export im Projekt DORA-MCP-Checker',
            seitenImExport: seiten.length,
            themen: nachThema.size,
            felder: Object.keys(felder).length,
            abschnitte: uebernommen
        },
        felder: felder,
        fehlendeFelder: fehlend
    };
}

function main() {
    const quelle = process.argv[2] || STANDARD_QUELLE;
    const ziel = process.argv[3] || STANDARD_ZIEL;

    if (!fs.existsSync(quelle)) {
        console.error('Wiki-Export nicht gefunden: ' + quelle);
        console.error('Aufruf: node scripts/handbuch/erzeuge_handbuch.js <wiki-export> [ziel.json]');
        process.exit(1);
    }

    const auszug = baueAuszug(quelle);
    fs.writeFileSync(ziel, JSON.stringify(auszug, null, 1), 'utf8');

    const groesse = Math.round(fs.statSync(ziel).size / 1024);
    console.log('Handbuch-Auszug geschrieben: ' + ziel + ' (' + groesse + ' KB)');
    console.log('  ' + auszug.auszug.seitenImExport + ' Seiten im Export -> '
        + auszug.auszug.themen + ' Themen -> ' + auszug.auszug.felder + ' Felder');
    if (auszug.fehlendeFelder.length) {
        console.log('  ohne Handbuch-Abschnitt: ' + auszug.fehlendeFelder.join(', '));
    }
    Object.keys(auszug.felder).forEach(f => {
        const a = auszug.felder[f];
        console.log('  ' + f.padEnd(24) + a.reduce((s, x) => s + x.regeln.length, 0)
            + ' Regeln aus ' + a.map(x => x.thema).join(', '));
    });
}

if (require.main === module) main();
module.exports = { baueAuszug, regelnAusText, grundthema };
