// PDF.js Multi-Page Viewer Logic
pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';

let pdfDoc = null;
// 'fit' = Seitenbreite folgt dem Fenster, 'manual' = feste Zoomstufe.
// Vorher war der Massstab fest auf 1.0 verdrahtet: das Fenster liess sich
// vergroessern, die Darstellung blieb aber unveraendert.
let zoomModus = 'fit';
let scale = 1.0;
let angewendeterMassstab = 1.0;
let renderLauf = 0; // verhindert, dass sich zwei Durchlaeufe vermischen
const pagesContainer = document.getElementById('pages-container');
const canvasContainer = document.getElementById('canvas-container');
const pageCountEl = document.getElementById('page-count');
const zoomInBtn = document.getElementById('zoom-in-btn');
const zoomOutBtn = document.getElementById('zoom-out-btn');
const fitBtn = document.getElementById('fit-btn');
const zoomInfoEl = document.getElementById('zoom-info');
const adobeBtn = document.getElementById('adobe-btn');
const saveBtn = document.getElementById('save-btn');
const loadingEl = document.getElementById('loading');

// Parse Query Parameters
const urlParams = new URLSearchParams(window.location.search);
const fileUrl = urlParams.get('file');
// Quellen mit Geheimnis in der Adresse (Elsevier-Schlüssel) werden nicht
// direkt geladen: das Hintergrundskript reicht die Bytes durch.
const elsevierDoi = urlParams.get('elsevier');
// Dateiname-Vorschlag (aus DOI oder PID), damit die Ablage nicht
// "view" oder "pdf" heisst.
const dateiName = urlParams.get('name') || '';

// Institut des Datensatzes als farbiges Schild in der Leiste. Die Zuordnung
// kommt aus der aufrufenden DORA-Seite (Pfad bzw. PID-Praefix).
const INSTITUTE = {
    eawag: 'Eawag', empa: 'Empa', wsl: 'WSL', psi: 'PSI'
};

function institutTagSetzen() {
    const schild = document.getElementById('institut-tag');
    if (!schild) return;
    const schluessel = (urlParams.get('inst') || '').toLowerCase();
    const name = INSTITUTE[schluessel];
    if (!name) { schild.hidden = true; return; }

    schild.textContent = name;
    schild.dataset.institut = schluessel;
    schild.title = `Datensatz aus ${name}`;
    schild.hidden = false;
}

institutTagSetzen();

// Das angezeigte PDF zusaetzlich ablegen. Laeuft im Hintergrundskript, damit
// auch Quellen mit Schluessel in der Adresse funktionieren.
let downloadLaeuft = false;
let downloadFertig = false;

function pdfAblegen(stillschweigend) {
    if (downloadLaeuft || downloadFertig) return;
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;

    downloadLaeuft = true;
    if (saveBtn && !stillschweigend) saveBtn.textContent = '⬇ speichert …';

    chrome.runtime.sendMessage({
        action: 'downloadPdf',
        url: elsevierDoi ? '' : fileUrl,
        elsevierDoi: elsevierDoi || '',
        filename: dateiName
    }, (antwort) => {
        downloadLaeuft = false;
        if (!saveBtn) return;
        if (antwort && antwort.success) {
            downloadFertig = true;
            saveBtn.textContent = '✓ gespeichert';
            saveBtn.title = 'Liegt im Download-Ordner: ' + (antwort.data && antwort.data.filename || '');
        } else {
            saveBtn.textContent = '⬇ Speichern';
            saveBtn.title = 'Download fehlgeschlagen: ' + ((antwort && antwort.error) || 'keine Antwort');
        }
    });
}

function ladeUeberHintergrund(auftrag) {
    return new Promise((erfuellen, ablehnen) => {
        chrome.runtime.sendMessage(Object.assign({ action: 'fetchPdfBytes' }, auftrag), (antwort) => {
            if (!antwort || !antwort.success) {
                ablehnen(new Error((antwort && antwort.error) || 'Kein Zugriff auf das Hintergrundskript'));
                return;
            }
            const roh = atob(antwort.data.base64);
            const bytes = new Uint8Array(roh.length);
            for (let i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i);
            erfuellen(bytes);
        });
    });
}

if (fileUrl || elsevierDoi) {
    if (saveBtn) saveBtn.onclick = () => pdfAblegen(false);

    // Auf Wunsch wandert jedes geöffnete PDF gleich in den Download-Ordner,
    // damit es für den Upload nach DORA bereitliegt.
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get({ autoDownloadPreview: true }, (e) => {
            if (e.autoDownloadPreview) pdfAblegen(true);
        });
    }

    // Wenn Firefox das automatische Starten abgelehnt hat, merkt sich der
    // Knopf die geladene Datei und startet sie beim naechsten Klick - dann
    // liegt eine echte Nutzeraktion vor.
    let geladeneDatei = null;

    adobeBtn.onclick = () => {
        if (geladeneDatei !== null && typeof chrome !== 'undefined' && chrome.downloads && chrome.downloads.open) {
            Promise.resolve(chrome.downloads.open(geladeneDatei))
                .then(() => { adobeBtn.textContent = '📥 In Adobe öffnen'; geladeneDatei = null; })
                .catch(err => {
                    console.log('DORA Helper: Start blockiert:', err && err.message);
                    adobeBtn.textContent = '⚠ Start blockiert';
                });
            return;
        }

        // Erster Weg: das Hintergrundskript laedt das PDF und startet es mit
        // der Systemanwendung. Nur wenn das nicht greift, bleibt der
        // Blob-Download als Rückfallebene.
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            adobeBtn.textContent = '📥 öffnet …';
            chrome.runtime.sendMessage({ action: 'openPdfExternally', url: fileUrl }, (antwort) => {
                const daten = antwort && antwort.success ? antwort.data : null;
                if (daten && daten.opened) {
                    adobeBtn.textContent = '📥 In Adobe öffnen';
                    return;
                }
                if (daten && daten.downloaded && daten.downloadId !== undefined) {
                    geladeneDatei = daten.downloadId;
                    adobeBtn.textContent = '📂 In Adobe starten';
                    adobeBtn.title = 'Datei ist geladen – Klick startet das zugeordnete Programm';
                    return;
                }
                adobeBtn.textContent = '📥 In Adobe öffnen';
                if (daten && daten.note) console.log('DORA Helper: Adobe-Öffnen unvollständig:', daten.note);
                adobeDownloadAlsRueckfall();
            });
            return;
        }
        adobeDownloadAlsRueckfall();
    };

    function adobeDownloadAlsRueckfall() {
        // PDF über Blob-Download erzwingen, um direkt Adobe Acrobat Pro aufzurufen
        fetch(fileUrl)
            .then(resp => resp.blob())
            .then(blob => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                let filename = 'document.pdf';
                try {
                    const parsedUrl = new URL(fileUrl);
                    const pathParts = parsedUrl.pathname.split('/');
                    const lastPart = pathParts[pathParts.length - 1];
                    if (lastPart && lastPart.toLowerCase().endsWith('.pdf')) {
                        filename = lastPart;
                    }
                } catch (e) {}
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(() => URL.revokeObjectURL(url), 100);
            })
            .catch(error => {
                console.error('Error fetching PDF for Adobe download:', error);
                if (typeof chrome !== 'undefined' && chrome.downloads) {
                    chrome.downloads.download({
                        url: fileUrl,
                        saveAs: false
                    });
                } else {
                    // Bewusst kein window.open: das landet im Browser-eigenen
                    // Betrachter statt in Adobe und verwirrt nur.
                    adobeBtn.textContent = '⚠ Download fehlgeschlagen';
                }
            });
    }

    // Load PDF Document. Bei Quellen mit Schluessel in der Adresse kommen
    // die Bytes ueber das Hintergrundskript, sonst laedt pdf.js direkt.
    const quelle = elsevierDoi
        ? ladeUeberHintergrund({ elsevierDoi: elsevierDoi }).then(bytes => ({ data: bytes }))
        : Promise.resolve(fileUrl);

    quelle
        .then(auftrag => pdfjsLib.getDocument(auftrag).promise)
        .then(pdfDoc_ => {
            pdfDoc = pdfDoc_;
            pageCountEl.textContent = pdfDoc.numPages;
            loadingEl.style.display = 'none';

            // Render All Pages
            renderAllPages();
        }).catch(error => {
            console.error('Error loading PDF:', error);
            loadingEl.textContent = 'PDF konnte nicht geladen werden: '
                + ((error && error.message) || 'unbekannter Fehler')
                + '. Bitte die Adobe-Schaltfläche oder eine andere Quelle versuchen.';
        });
} else {
    loadingEl.textContent = 'Keine PDF-Datei angegeben.';
}

// ---------------------------------------------------------------------------
// Marker: Lizenz-, Förder- und Schlagwort-Fundstellen im PDF hervorheben und
// unten in einer Leiste sammeln. Die Muster bilden ab, was in der QC zaehlt:
// CC-Lizenzen, SNF- und EU/ERC-Förderung sowie die Keyword-Angaben.
// ---------------------------------------------------------------------------
const MARKER_KATEGORIEN = [
    {
        key: 'lizenz', label: 'Lizenz', farbe: '#22c55e',
        muster: [
            // Die Versionsnummer gehoert zur Lizenz - sie wird deshalb
            // mitgenommen, wenn sie unmittelbar dahinter steht ("CC BY 4.0",
            // "Creative Commons Attribution 4.0 International").
            'creativecommons\\.org/(?:licenses|publicdomain)/[a-z\\-]+(?:/\\d\\.\\d)?',
            'creative\\s?commons'
            + '(?:\\s+(?:attribution|namensnennung))?'
            + '(?:[\\s\\-]*(?:non[\\s\\-]?commercial|no[\\s\\-]?deriv\\w*|share[\\s\\-]?alike|nc|nd|sa))*'
            + '(?:\\s+\\d\\.\\d)?(?:\\s+(?:international|unported|generic|igo))?',
            'CC[\\s\\-]?BY(?:[\\s\\-]?(?:NC|ND|SA)){0,2}(?:[\\s\\-]?\\d\\.\\d)?(?:\\s+(?:international|unported|generic|igo))?',
            'CC0(?:[\\s\\-]?1\\.0)?(?:\\s+universal)?',
            'public\\s+domain\\s+dedication',
            'open\\s+access\\s+article',
            'this\\s+article\\s+is\\s+licen[sc]ed\\s+under',
            'distributed\\s+under\\s+the\\s+terms'
        ]
    },
    {
        key: 'snf', label: 'SNF', farbe: '#3b82f6',
        muster: [
            'swiss\\s+national\\s+science\\s+foundation',
            'schweizerischer\\s+nationalfonds',
            'fonds\\s+national\\s+suisse',
            '\\bSNS?F\\b',
            'national\\s+centres?\\s+of\\s+competence\\s+in\\s+research',
            '\\bNCCR\\b',
            // SNF-Vergabenummern: zusammengesetzt (200021_203578) oder mit
            // Kontextwort. Ein nackter Sechsstelliger waere zu grob - in
            // Messtabellen wuerde damit halbe Seiten aufleuchten.
            '\\b\\d{5,6}[A-Z]?[_\\-]\\d{6}\\b',
            '(?:grant|project|Projekt|award|no\\.?|number|Nr\\.?)\\s*(?:no\\.?|number)?\\s*[:#]?\\s*\\d{6}\\b'
        ]
    },
    {
        key: 'eu', label: 'EU/ERC', farbe: '#a855f7',
        muster: [
            'european\\s+research\\s+council',
            '\\bERC\\b(?:\\s+(?:advanced|starting|consolidator|synergy)\\s+grant)?',
            'horizon\\s+(?:2020|europe)',
            '\\bH2020\\b', '\\bFP7\\b',
            'seventh\\s+framework\\s+programme',
            'marie\\s+sk[l\\u0142]odowska[\\-\\s]curie',
            'european\\s+union\\u2019?s?\\s+[a-z0-9\\s]{0,30}programme',
            'european\\s+commission',
            'grant\\s+agreement\\s+(?:no\\.?|number)?\\s*\\d{6,9}',
            '\\b1\\d{8}\\b' // Horizon-Nummernkreis, z.B. 101072180
        ]
    },
    {
        key: 'keywords', label: 'Keywords', farbe: '#f59e0b',
        muster: [
            'key\\s?words?\\s*[:\\u2013\\-]',
            'schlagw[o\\u00f6]rter\\s*[:\\u2013\\-]',
            'index\\s+terms\\s*[:\\u2013\\-]'
        ]
    },
    // Die vier Institute - Hausfarben wie beim Schild oben. Sie helfen beim
    // Prüfen der Affiliationen: man sieht auf einen Blick, wo im Text das
    // eigene Institut genannt ist.
    {
        key: 'eawag', label: 'Eawag', farbe: '#0069b4', nurBeiTreffer: true,
        muster: [
            '\\bEawag\\b',
            'swiss\\s+federal\\s+institute\\s+(?:of|for)\\s+aquatic\\s+science(?:\\s+and\\s+technology)?',
            'eidgen[o\\u00f6]ssische[sr]?\\s+wasserforschungs?[\\-\\s]?institut',
            'kastanienbaum'
        ]
    },
    {
        key: 'empa', label: 'Empa', farbe: '#e2001a', nurBeiTreffer: true,
        muster: [
            '\\bEmpa\\b',
            'swiss\\s+federal\\s+laboratories\\s+for\\s+materials\\s+science(?:\\s+and\\s+technology)?',
            'eidgen[o\\u00f6]ssische\\s+materialpr[u\\u00fc]fungs?[\\-\\s]?\\s?und\\s+forschungsanstalt'
        ]
    },
    {
        key: 'wsl', label: 'WSL', farbe: '#2d6a4f', nurBeiTreffer: true,
        muster: [
            'swiss\\s+federal\\s+institute\\s+for\\s+forest,?\\s+snow\\s+and\\s+landscape\\s+research',
            'eidgen[o\\u00f6]ssische\\s+forschungsanstalt\\s+f[u\\u00fc]r\\s+wald,?\\s+schnee\\s+und\\s+landschaft',
            'institut\\s+f[u\\u00fc]r\\s+schnee[\\-\\s]?\\s?und\\s+lawinenforschung',
            'birmensdorf'
        ],
        // Abkürzungen nur in Grossschreibung, sonst trifft es beliebige Silben
        musterExakt: ['\\bWSL\\b', '\\bSLF\\b']
    },
    {
        key: 'psi', label: 'PSI', farbe: '#002b5c', nurBeiTreffer: true,
        muster: [
            'paul\\s+scherrer\\s+institut(?:e|s)?',
            'villigen'
        ],
        // "PSI" ist auch eine Druckeinheit - direkt hinter einer Zahl zählt
        // es deshalb nicht als Institut.
        musterExakt: ['(?<![\\d.,]\\s?)\\bPSI\\b']
    },
    { key: 'eigene', label: 'Eigene', farbe: '#ec4899', muster: [] }
];

let eigeneBegriffe = [];
let markerAktiv = true;
let befunde = []; // { kategorie, text, seite }

function begriffZuMuster(begriff) {
    return begriff.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Ausdrücke je Kategorie; werden bei jedem Aufruf neu gebaut, damit kein
// lastIndex zwischen Durchläufen hängen bleibt. Abkürzungen wie WSL, SLF und
// PSI stehen in einem zweiten, gross-/kleinschreibungsempfindlichen Ausdruck.
function musterFuer(kategorie) {
    const teile = kategorie.key === 'eigene'
        ? eigeneBegriffe.map(begriffZuMuster)
        : (kategorie.muster || []);

    const ausdruecke = [];
    if (teile.length) ausdruecke.push(new RegExp('(' + teile.join(')|(') + ')', 'gi'));
    if ((kategorie.musterExakt || []).length) {
        ausdruecke.push(new RegExp('(' + kategorie.musterExakt.join(')|(') + ')', 'g'));
    }
    return ausdruecke;
}

// Alle Fundstellen in einem Text, überschneidungsfrei und nach Position
// sortiert. Die erste passende Kategorie gewinnt.
function trefferImText(text) {
    if (!text) return [];
    const roh = [];
    MARKER_KATEGORIEN.forEach(kategorie => {
        musterFuer(kategorie).forEach(regex => {
            let treffer;
            while ((treffer = regex.exec(text)) !== null) {
                if (!treffer[0]) { regex.lastIndex++; continue; }
                roh.push({
                    kategorie: kategorie.key, text: treffer[0],
                    start: treffer.index, ende: treffer.index + treffer[0].length
                });
            }
        });
    });

    roh.sort((a, b) => a.start - b.start || (b.ende - b.start) - (a.ende - a.start));
    const sauber = [];
    let bisher = -1;
    roh.forEach(t => {
        if (t.start < bisher) return; // Überschneidung verwerfen
        sauber.push(t);
        bisher = t.ende;
    });
    return sauber;
}

// Fundstellen markieren. Wichtig: die Spans des Textlayers bleiben
// unangetastet. PDF.js vermisst sie nach dem Rendern und legt eigene
// Transformationen darauf - schreibt man in die Spans hinein, sitzt die
// Hervorhebung je nach Zoomstufe daneben. Die Markierungen liegen deshalb
// als eigene Ebene über dem Canvas, positioniert über die tatsächlichen
// Rechtecke des Textbereichs.
function markiereTextlayer(textLayer, seitenNummer) {
    if (!textLayer) return;
    const wrapper = textLayer.closest ? textLayer.closest('.page-wrapper') : null;
    if (!wrapper) return;

    let ebene = wrapper.querySelector('.highlightLayer');
    if (!ebene) {
        ebene = document.createElement('div');
        ebene.className = 'highlightLayer';
        wrapper.insertBefore(ebene, textLayer);
    }
    ebene.textContent = '';

    const basis = wrapper.getBoundingClientRect();

    textLayer.querySelectorAll('span').forEach(span => {
        // Nur reine Textknoten: verschachtelte Elemente kommen im Textlayer
        // nicht vor, und Offsets blieben sonst unzuverlässig.
        const knoten = span.firstChild;
        if (!knoten || knoten.nodeType !== 3 || span.childNodes.length !== 1) return;

        trefferImText(knoten.nodeValue).forEach(t => {
            let rechtecke = [];
            try {
                const bereich = document.createRange();
                bereich.setStart(knoten, t.start);
                bereich.setEnd(knoten, t.ende);
                rechtecke = bereich.getClientRects ? Array.from(bereich.getClientRects()) : [];
            } catch (e) {
                return;
            }

            rechtecke.forEach(r => {
                if (!r.width || !r.height) return;
                const kasten = document.createElement('div');
                kasten.className = 'dora-marker';
                kasten.dataset.kategorie = t.kategorie;
                kasten.dataset.seite = String(seitenNummer);
                kasten.dataset.text = t.text;
                kasten.style.left = (r.left - basis.left) + 'px';
                kasten.style.top = (r.top - basis.top) + 'px';
                kasten.style.width = r.width + 'px';
                kasten.style.height = r.height + 'px';
                if (!sichtbareKategorien.has(t.kategorie)) kasten.style.display = 'none';
                ebene.appendChild(kasten);
            });
        });
    });
}

// Für die Leiste zaehlt der Seitentext als Ganzes: Fundstellen, die PDF.js
// über mehrere Spans verteilt, gehen sonst verloren.
function befundeSammeln(seitenText, seitenNummer) {
    trefferImText(seitenText).forEach(t => {
        const schluessel = t.kategorie + '|' + t.text.toLowerCase().replace(/\s+/g, ' ').trim();
        if (befunde.some(b => b.schluessel === schluessel)) return;
        befunde.push({
            schluessel: schluessel, kategorie: t.kategorie,
            text: t.text.replace(/\s+/g, ' ').trim(), seite: seitenNummer
        });
    });
}

// Kategorien, die gerade eingeblendet sind
const sichtbareKategorien = new Set(MARKER_KATEGORIEN.map(k => k.key));

function kategorieVon(key) {
    return MARKER_KATEGORIEN.find(k => k.key === key);
}

// Leiste am unteren Rand: je Kategorie ein Zaehl-Chip, darunter die
// Fundstellen zum Anspringen.
function markerLeisteZeichnen() {
    const bar = document.getElementById('marker-bar');
    const chips = document.getElementById('marker-chips');
    const liste = document.getElementById('marker-list');
    if (!bar || !chips || !liste) return;

    chips.textContent = '';
    liste.textContent = '';

    MARKER_KATEGORIEN.forEach(kategorie => {
        const anzahl = befunde.filter(b => b.kategorie === kategorie.key).length;
        // Institute und eigene Begriffe nur zeigen, wenn es sie im Text gibt -
        // sonst steht die Leiste voller Nullen.
        if (!anzahl && (kategorie.key === 'eigene' || kategorie.nurBeiTreffer)) return;

        const chip = document.createElement('button');
        chip.className = 'marker-chip';
        chip.type = 'button';
        chip.setAttribute('aria-pressed', sichtbareKategorien.has(kategorie.key) ? 'true' : 'false');
        chip.title = `${kategorie.label}: ${anzahl} Fundstelle(n) – klicken zum Aus-/Einblenden`;

        const punkt = document.createElement('span');
        punkt.className = 'punkt';
        punkt.style.backgroundColor = kategorie.farbe;
        chip.appendChild(punkt);
        chip.appendChild(document.createTextNode(`${kategorie.label} ${anzahl}`));

        chip.onclick = () => {
            if (sichtbareKategorien.has(kategorie.key)) sichtbareKategorien.delete(kategorie.key);
            else sichtbareKategorien.add(kategorie.key);
            kategorieSichtbarkeitAnwenden();
            markerLeisteZeichnen();
        };
        chips.appendChild(chip);
    });

    if (!befunde.length) {
        const hinweis = document.createElement('span');
        hinweis.id = 'marker-leer-hinweis';
        hinweis.textContent = markerAktiv
            ? 'Keine Lizenz-, Förder- oder Schlagwort-Angaben gefunden.'
            : 'Marker ausgeschaltet.';
        chips.appendChild(hinweis);
    }

    befunde
        .filter(b => sichtbareKategorien.has(b.kategorie))
        .sort((a, b) => a.seite - b.seite)
        .forEach(b => {
            const kategorie = kategorieVon(b.kategorie);
            const eintrag = document.createElement('button');
            eintrag.type = 'button';
            eintrag.className = 'marker-fund';
            eintrag.style.borderLeftColor = kategorie ? kategorie.farbe : '#94a3b8';
            eintrag.title = `${kategorie ? kategorie.label : ''}: ${b.text} (Seite ${b.seite})`;
            eintrag.appendChild(document.createTextNode(b.text));
            const seite = document.createElement('span');
            seite.className = 'seite';
            seite.textContent = `S. ${b.seite}`;
            eintrag.appendChild(seite);
            eintrag.onclick = () => zurFundstelle(b);
            liste.appendChild(eintrag);
        });
}

function normalisiereText(text) {
    return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Die Markierungen, die zu einer Fundstelle gehoeren. Der Text der Leiste
// stammt aus dem Seitentext, die Markierung aus einem einzelnen Span -
// deshalb genuegt Teilübereinstimmung in beide Richtungen.
function markenFuer(befund) {
    const seite = document.getElementById(`page-wrapper-${befund.seite}`);
    if (!seite) return [];

    const alle = Array.from(seite.querySelectorAll(`.dora-marker[data-kategorie="${befund.kategorie}"]`));
    const gesucht = normalisiereText(befund.text);
    const genau = alle.filter(kasten => {
        const t = normalisiereText(kasten.dataset.text);
        return t && (gesucht.indexOf(t) !== -1 || t.indexOf(gesucht) !== -1);
    });
    return genau.length ? genau : alle;
}

// Zur Fundstelle selbst scrollen - nicht nur zur Seite. Sonst tut sich
// nichts, wenn alles auf Seite 1 steht und die Seite schon oben liegt.
// Mehrfach klicken geht die Vorkommen der Reihe nach durch.
function zurFundstelle(befund) {
    const marken = markenFuer(befund);

    if (!marken.length) {
        // Ohne Markierung (z. B. über Spans verteilt) bleibt die Seite
        const seite = document.getElementById(`page-wrapper-${befund.seite}`);
        if (seite && seite.scrollIntoView) seite.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
    }

    const index = (befund.zeiger || 0) % marken.length;
    befund.zeiger = index + 1;
    const ziel = marken[index];

    // Ohne sanftes Scrollen: die Animation soll sofort am Ziel laufen und
    // nicht warten, bis das Bild langsam herangeglitten ist.
    if (ziel.scrollIntoView) {
        try {
            ziel.scrollIntoView({ behavior: 'instant', block: 'center' });
        } catch (e) {
            ziel.scrollIntoView({ block: 'center' });
        }
    }

    // Klasse kurz abnehmen und einen Reflow erzwingen, damit die Animation
    // auch beim zweiten Klick auf dieselbe Stelle neu startet.
    marken.forEach(m => m.classList.remove('dora-marker-blitz'));
    void ziel.offsetWidth;
    marken.forEach(m => m.classList.add('dora-marker-blitz'));
    setTimeout(() => marken.forEach(m => m.classList.remove('dora-marker-blitz')), 700);
}

function kategorieSichtbarkeitAnwenden() {
    document.querySelectorAll('.dora-marker').forEach(kasten => {
        const an = markerAktiv && sichtbareKategorien.has(kasten.dataset.kategorie);
        kasten.style.display = an ? '' : 'none';
    });
}

// Markierungen entfernen (fuer das Ausschalten und beim Wechsel der
// eigenen Begriffe). Die Textebene von PDF.js bleibt unberührt.
function markierungenEntfernen() {
    document.querySelectorAll('.highlightLayer').forEach(ebene => { ebene.textContent = ''; });
}

function markierungenNeuSetzen() {
    markierungenEntfernen();
    if (!markerAktiv) return;
    document.querySelectorAll('.textLayer').forEach(layer => {
        const nummer = parseInt((layer.id || '').replace('text-layer-', ''), 10) || 0;
        markiereTextlayer(layer, nummer);
    });
    kategorieSichtbarkeitAnwenden();
}

// Platz, der einer Seite in der Breite zur Verfuegung steht
// (20px Innenabstand je Seite plus Reserve fuer die Scrollleiste).
function verfuegbareBreite() {
    return Math.max(240, (canvasContainer.clientWidth || window.innerWidth) - 56);
}

// Massstab fuer eine Seite: im Fit-Modus aus der Fensterbreite abgeleitet,
// nach oben begrenzt, damit auf breiten Bildschirmen keine Riesen-Canvas
// entstehen.
function massstabFuer(page) {
    if (zoomModus === 'manual') return scale;
    const basis = page.getViewport({ scale: 1 });
    return Math.min(Math.max(verfuegbareBreite() / basis.width, 0.25), 3);
}

function zoomAnzeigeAktualisieren() {
    if (zoomInfoEl) zoomInfoEl.textContent = `${Math.round(angewendeterMassstab * 100)}%`;
    if (fitBtn) fitBtn.disabled = (zoomModus === 'fit');
}

function renderAllPages() {
    if (!pdfDoc) return;
    const lauf = ++renderLauf;

    // Clear container
    pagesContainer.innerHTML = '';

    // Loop through all pages and render them
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        renderPage(pageNum, lauf);
    }
}

function renderPage(pageNum, lauf) {
    if (lauf !== undefined && lauf !== renderLauf) return;

    // Create DOM elements for this page
    const pageWrapper = document.createElement('div');
    pageWrapper.className = 'page-wrapper';
    pageWrapper.id = `page-wrapper-${pageNum}`;
    
    const canvas = document.createElement('canvas');
    canvas.id = `canvas-${pageNum}`;
    pageWrapper.appendChild(canvas);
    
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.id = `text-layer-${pageNum}`;
    pageWrapper.appendChild(textLayer);
    
    pagesContainer.appendChild(pageWrapper);
    
    const ctx = canvas.getContext('2d');
    
    // Fetch and render page
    pdfDoc.getPage(pageNum).then(page => {
        if (lauf !== undefined && lauf !== renderLauf) return;

        const massstab = massstabFuer(page);
        angewendeterMassstab = massstab;
        zoomAnzeigeAktualisieren();

        const viewport = page.getViewport({ scale: massstab });
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        
        pageWrapper.style.width = viewport.width + 'px';
        pageWrapper.style.height = viewport.height + 'px';
        
        const renderContext = {
            canvasContext: ctx,
            viewport: viewport
        };
        
        const renderTask = page.render(renderContext);
        
        renderTask.promise.then(() => {
            return page.getTextContent();
        }).then(textContent => {
            textLayer.style.width = canvas.width + 'px';
            textLayer.style.height = canvas.height + 'px';
            textLayer.style.setProperty('--scale-factor', viewport.scale);
            
            // Das Markieren muss warten, bis PDF.js den Textlayer fertig
            // vermessen hat - vorher stimmen die Positionen nicht.
            let layerFertig = Promise.resolve();
            try {
                if (typeof pdfjsLib.TextLayer === 'function') {
                    const layer = new pdfjsLib.TextLayer({
                        textContentSource: textContent,
                        container: textLayer,
                        viewport: viewport
                    });
                    layerFertig = Promise.resolve(layer.render());
                } else if (typeof pdfjsLib.renderTextLayer === 'function') {
                    const aufgabe = pdfjsLib.renderTextLayer({
                        textContent: textContent,
                        textContentSource: textContent,
                        container: textLayer,
                        viewport: viewport,
                        textDivs: []
                    });
                    if (aufgabe && aufgabe.promise) layerFertig = aufgabe.promise;
                }
            } catch (layerErr) {
                console.error(`Error rendering text layer for page ${pageNum}:`, layerErr);
            }

            const seitenText = (textContent.items || []).map(i => i.str || '').join(' ');
            befundeSammeln(seitenText, pageNum);

            layerFertig.catch(() => { }).then(() => {
                setTimeout(() => {
                    if (lauf !== undefined && lauf !== renderLauf) return;
                    if (markerAktiv) markiereTextlayer(textLayer, pageNum);
                    markerLeisteZeichnen();
                }, 0);
            });
        });
    });
}

// Zoom Listeners: der erste Klick uebernimmt den aktuell sichtbaren
// Massstab, damit die Anzeige nicht springt.
zoomInBtn.onclick = () => {
    scale = Math.min(angewendeterMassstab + 0.25, 5);
    zoomModus = 'manual';
    renderAllPages();
};

zoomOutBtn.onclick = () => {
    scale = Math.max(angewendeterMassstab - 0.25, 0.25);
    zoomModus = 'manual';
    renderAllPages();
};

if (fitBtn) {
    fitBtn.onclick = () => {
        zoomModus = 'fit';
        renderAllPages();
    };
}

// Fenstergroesse aendern: im Fit-Modus die Seiten neu aufbauen, gebremst,
// damit das Ziehen am Fensterrand nicht hundert Durchlaeufe auslöst.
let resizeTimer = null;
window.addEventListener('resize', () => {
    if (zoomModus !== 'fit' || !pdfDoc) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderAllPages(), 200);
});

zoomAnzeigeAktualisieren();

// Marker ein-/ausschalten
const markerBtn = document.getElementById('marker-btn');
if (markerBtn) {
    const markerBtnStand = () => {
        markerBtn.textContent = markerAktiv ? '🖍 Marker' : '🖍 Marker aus';
        markerBtn.style.borderColor = markerAktiv ? '#f59e0b' : '#475569';
    };
    markerBtn.onclick = () => {
        markerAktiv = !markerAktiv;
        markerBtnStand();
        markierungenNeuSetzen();
        markerLeisteZeichnen();
    };
    markerBtnStand();
}

// Eigene Begriffe: bleiben gespeichert, damit sie beim naechsten PDF
// gleich wieder greifen.
const eigeneEingabe = document.getElementById('marker-own-input');
if (eigeneEingabe) {
    const uebernehmen = (roh) => {
        eigeneBegriffe = (roh || '').split(',').map(t => t.trim()).filter(t => t.length >= 2);
    };

    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get({ pdfHighlightTerms: '' }, (e) => {
            eigeneEingabe.value = e.pdfHighlightTerms || '';
            uebernehmen(eigeneEingabe.value);
            if (eigeneBegriffe.length) {
                befunde = befunde.filter(b => b.kategorie !== 'eigene');
                markierungenNeuSetzen();
                markerLeisteZeichnen();
            }
        });
    }

    let eingabeTimer = null;
    eigeneEingabe.addEventListener('input', () => {
        clearTimeout(eingabeTimer);
        eingabeTimer = setTimeout(() => {
            uebernehmen(eigeneEingabe.value);
            sichtbareKategorien.add('eigene');

            // Alte eigene Fundstellen verwerfen und aus dem Seitentext neu
            // bestimmen (der Textlayer allein verliert Umbrüche).
            befunde = befunde.filter(b => b.kategorie !== 'eigene');
            document.querySelectorAll('.textLayer').forEach(layer => {
                const nummer = parseInt((layer.id || '').replace('text-layer-', ''), 10) || 0;
                befundeSammeln(layer.textContent, nummer);
            });

            markierungenNeuSetzen();
            markerLeisteZeichnen();

            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
                chrome.storage.local.set({ pdfHighlightTerms: eigeneEingabe.value });
            }
        }, 350);
    });
}

markerLeisteZeichnen();

// Automatik "Immer Adobe": schaltet die gemeinsame Einstellung um, die auch
// der Vorschau-Button im Batch-QC-Dashboard auswertet. Ab dann geht das PDF
// direkt in Adobe Acrobat auf, statt hier gerendert zu werden.
const adobeDefaultCb = document.getElementById('adobe-default-cb');
if (adobeDefaultCb && typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get({ pdfOpenInAdobe: false }, (e) => {
        adobeDefaultCb.checked = !!e.pdfOpenInAdobe;
    });

    adobeDefaultCb.addEventListener('change', () => {
        chrome.storage.local.set({ pdfOpenInAdobe: adobeDefaultCb.checked }, () => {
            // Eingeschaltet heisst: dieses PDF gehoert direkt in Adobe.
            if (adobeDefaultCb.checked && adobeBtn) adobeBtn.click();
        });
    });
} else if (adobeDefaultCb) {
    const huelle = adobeDefaultCb.closest('#adobe-default');
    if (huelle) huelle.style.display = 'none';
}
