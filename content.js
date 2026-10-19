// content.js - Dora Lib4ri Helper
// Version: 2.80

let observerTimeout = null;
let dragSrcEl = null;
let lastAutoFetchedDoi = "";
let cachedExceptions = [];
let isMouseOverHandle = false;
let isSummaryMinimized = false; // Status für das Fehler-Panel
let lastErrorsHash = "";      // Zum Vergleichen der Fehlerliste
let lastMinimizedState = null; // Zum Vergleichen des Status
let cachedCrossrefLicenseUrl = null;
let cachedCrossrefMapped = null;
let cachedCrossrefDoi = null;
let isKeywordManagerOpen = false;

// Erkennt Eingabefelder des Funding-Bereichs (Drupal/Islandora-Formular)
const FUNDING_FIELD_HINT = /fund|award|grant|f(oe|ö)rder|atitle|anumber|fstream/i;

// Der Funding-Bereich in DORA: "Funding (only EC and SNSF Projects)"
// funder_name/funding_stream sind <select>, funder_identifier ist hidden,
// award_number ist readonly und wird sonst vom Autocomplete gefuellt.
const FUNDING_CONTAINER_SELECTORS = [
    '.form-item-extension-funding-references',
    '[class*="funding-references"]',
    '[class*="form-item-extension-funding"]'
];

// Rollen-Erkennung pro Zeile: spezifische Muster zuerst
const FUNDING_ROLE_PATTERNS = {
    awardNumber: [/\banumber\b/i, /award[\s_-]?number/i, /grant[\s_-]?number/i, /project[\s_-]?number/i, /\[number\]/i, /\bcode\b/i],
    funderIdentifier: [/\bfid\b/i, /funder[\s_-]?identifier/i, /funder[\s_-]?id\b/i, /\bidentifier\b/i],
    fundingStream: [/\bfstream\b/i, /funding[\s_-]?stream/i, /\bstream\b/i, /programme?\b/i],
    funderName: [/\bfname\b/i, /funder[\s_-]?name/i, /\bfunder\b/i, /\bagency\b/i, /f(oe|ö)rder(er|organisation)/i],
    awardTitle: [/\batitle\b/i, /award[\s_-]?title/i, /project[\s_-]?title/i, /\btitle\b/i]
};

let cachedFundingSuggestions = null;
let fundingPanelRender = null;   // Re-Render des Formular-Panels (Sammel-Eintrag)
let fundingPanelLastState = null; // Diagnose: nur bei Zustandswechsel loggen
let lastOaIsHybrid = null;       // Ergebnis des OA-Abgleichs für den #hybrid-Tag

const SUPPLEMENT_TEXT_RE = /supplement|supporting[\s_-]?information|electronic[\s_-]?supplementary|zusatzmaterial|\besm\b|supp?[\s_-]?mat|_si_\d|\bsi[_-]\d{3}/i;
// Nur echte Navigationsziele ausschliessen - "/journal" darf nicht auf
// figshares Pfad "/journal_contribution/..." zutreffen.
const SUPPLEMENT_SKIP_RE = /supplement(ary)?[\s_-]?(issue|series)|\/journals?(\/|$)|\/issues?(\/|$)/i;
const SUPPLEMENT_EXT_RE = /\.(pdf|docx?|xlsx?|csv|zip|txt|pptx?|tif{1,2}|mp4|xml)(\?|$)/i;
// Verlage verlinken Zusatzmaterial oft direkt ins Repositorium (ACS z.B. nach
// figshare). Solche Links tragen das Wort "supplement" nicht im Pfad.
const SUPPLEMENT_REPO_RE = /(figshare\.com|zenodo\.org|datadryad\.org|dryad|osf\.io|pangaea\.de|dataverse\.|researchdata\.|opendata\.eawag|eric\.eawag|envidat\.ch)/i;

// Verlage antworten auf automatisierte Abrufe teils mit einer Sperrseite
// (HTTP 403 oder eine Challenge mit HTTP 200) - das ist etwas anderes als
// "es gibt kein Supplement".
const SUPPLEMENT_BLOCK_RE = /just a moment|attention required|access denied|are you a robot|captcha|cf-browser-verification|cloudflare|request unsuccessful|403 forbidden/i;

let supplementCacheByDoi = new Map();   // doi -> { items, quellen }

// Die PDF-Analyse ist vorerst aus der Ergebnisbox ausgeblendet. Der Code
// bleibt vollstaendig erhalten - die Schaltflaechen werden nur verborgen und
// lassen sich in den Einstellungen wieder einblenden.
let pdfAnalyseSichtbar = false;

function markierePdfAnalyse(el) {
    if (!el) return el;
    el.classList.add('dora-pdf-analyse');
    el.style.display = pdfAnalyseSichtbar ? '' : 'none';
    return el;
}

function pdfAnalyseSichtbarkeitAnwenden() {
    document.querySelectorAll('.dora-pdf-analyse').forEach(el => {
        el.style.display = pdfAnalyseSichtbar ? '' : 'none';
    });
}

try {
    chrome.storage.local.get({ showPdfAnalysis: false }, (e) => {
        pdfAnalyseSichtbar = !!e.showPdfAnalysis;
        pdfAnalyseSichtbarkeitAnwenden();
    });
    if (chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((aenderungen, bereich) => {
            if (bereich !== 'local' || !aenderungen.showPdfAnalysis) return;
            pdfAnalyseSichtbar = !!aenderungen.showPdfAnalysis.newValue;
            pdfAnalyseSichtbarkeitAnwenden();
        });
    }
} catch (e) { /* ausserhalb der Erweiterung: bleibt ausgeblendet */ }

// Damit Edit-Formular und PDF-Verwaltung dieselbe Aussage zeigen, wird das
// Prüfergebnis seitenübergreifend gemerkt (der Verlagsabruf gelingt nicht
// jedes Mal gleich). Ein Klick auf die Schaltfläche prüft trotzdem neu.
const SUPPLEMENT_CACHE_KEY = 'doraSupplementBefunde';
const SUPPLEMENT_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 Stunden
const SUPPLEMENT_CACHE_MAX = 200;

function supplementCacheLesen(doi, callback) {
    if (supplementCacheByDoi.has(doi)) { callback(supplementCacheByDoi.get(doi)); return; }
    try {
        chrome.storage.local.get({ [SUPPLEMENT_CACHE_KEY]: {} }, (gespeichert) => {
            const alle = gespeichert[SUPPLEMENT_CACHE_KEY] || {};
            const eintrag = alle[doi];
            if (eintrag && eintrag.zeit && (Date.now() - eintrag.zeit) < SUPPLEMENT_CACHE_TTL) {
                supplementCacheByDoi.set(doi, eintrag.ergebnis);
                callback(eintrag.ergebnis);
            } else {
                callback(null);
            }
        });
    } catch (e) {
        callback(null);
    }
}

function supplementCacheSchreiben(doi, ergebnis) {
    supplementCacheByDoi.set(doi, ergebnis);
    try {
        chrome.storage.local.get({ [SUPPLEMENT_CACHE_KEY]: {} }, (gespeichert) => {
            const alle = gespeichert[SUPPLEMENT_CACHE_KEY] || {};
            alle[doi] = { zeit: Date.now(), ergebnis: ergebnis };

            // Abgelaufenes verwerfen und die Ablage begrenzt halten
            const schluessel = Object.keys(alle)
                .filter(k => alle[k] && alle[k].zeit && (Date.now() - alle[k].zeit) < SUPPLEMENT_CACHE_TTL)
                .sort((a, b) => alle[b].zeit - alle[a].zeit)
                .slice(0, SUPPLEMENT_CACHE_MAX);
            const neu = {};
            schluessel.forEach(k => { neu[k] = alle[k]; });
            chrome.storage.local.set({ [SUPPLEMENT_CACHE_KEY]: neu });
        });
    } catch (e) { /* Ablage nicht verfügbar - der Speicher im Tab genügt */ }
}

function supplementCacheEntfernen(doi) {
    supplementCacheByDoi.delete(doi);
    try {
        chrome.storage.local.get({ [SUPPLEMENT_CACHE_KEY]: {} }, (gespeichert) => {
            const alle = gespeichert[SUPPLEMENT_CACHE_KEY] || {};
            delete alle[doi];
            chrome.storage.local.set({ [SUPPLEMENT_CACHE_KEY]: alle });
        });
    } catch (e) { }
}

// Schont die DORA-Instanz: die einmal erfolgreiche Basis-URL wird gemerkt,
// Vokabular-Antworten werden sitzungsübergreifend zwischengespeichert.
let fundingAutocompleteBaseWorking = null;
const VOCAB_STORE_KEY = 'doraVocabCache';
const VOCAB_STORE_TTL = 7 * 24 * 60 * 60 * 1000;        // Treffer: eine Woche
// Fehlanzeigen kürzer halten: DORAs Auswahlliste wächst, ein heute unbekanntes
// Projekt kann morgen darin stehen.
const VOCAB_STORE_TTL_NEGATIV = 24 * 60 * 60 * 1000;
const VOCAB_STORE_MAX = 400;
let vocabStoreMemory = null;

function vocabStoreLaden() {
    if (vocabStoreMemory) return Promise.resolve(vocabStoreMemory);
    return new Promise(resolve => {
        try {
            chrome.storage.local.get({ [VOCAB_STORE_KEY]: {} }, (items) => {
                vocabStoreMemory = (items && items[VOCAB_STORE_KEY]) || {};
                resolve(vocabStoreMemory);
            });
        } catch (e) {
            vocabStoreMemory = {};
            resolve(vocabStoreMemory);
        }
    });
}

function vocabStoreSchreiben(schluessel, wert) {
    if (!vocabStoreMemory) vocabStoreMemory = {};
    vocabStoreMemory[schluessel] = { wert: wert, zeit: Date.now() };

    // Älteste Einträge verwerfen, damit der Speicher nicht wächst
    const schluesselListe = Object.keys(vocabStoreMemory);
    if (schluesselListe.length > VOCAB_STORE_MAX) {
        schluesselListe
            .sort((a, b) => (vocabStoreMemory[a].zeit || 0) - (vocabStoreMemory[b].zeit || 0))
            .slice(0, schluesselListe.length - VOCAB_STORE_MAX)
            .forEach(k => delete vocabStoreMemory[k]);
    }

    try {
        chrome.storage.local.set({ [VOCAB_STORE_KEY]: vocabStoreMemory });
    } catch (e) { /* ohne Speicher weiterarbeiten */ }
}
// #hybrid-Tag: neutral wie die übrigen Tags, orange mit Schein nur dann,
// wenn der DOI-Abgleich Hybrid Open Access gemeldet hat.
const HYBRID_STYLE_NEUTRAL = 'background: #e2e8f0; border: 1px solid #cbd5e0; border-radius: 3px; color: #2d3748; font-weight: 400; box-shadow: none;';
const HYBRID_STYLE_AKTIV = 'background: #f97316; border: 1px solid transparent; border-radius: 3px; color: #ffffff; font-weight: 600; '
    + 'box-shadow: 0 0 0 5px rgba(249, 115, 22, .30), 0 2px 6px rgba(124, 45, 18, .5);';

// Drupals Autocomplete-Callback des Award-Title-Feldes liefert Schluessel im
// Format "641939||HypoTRAIN - Hyporheic Zone Processes …||2" und findet auch
// ueber die Award-Nummer. Der dritte Teil ist der Funding-Stream (Reihenfolge
// der Select-Optionen). Damit laesst sich exakt der DORA-Eintrag uebernehmen.
const DORA_FUNDING_STREAM_BY_INDEX = {
    '1': 'Seventh Framework Programme',
    '2': 'Horizon 2020 Framework Programme',
    '3': 'SNSF',
    '4': 'Horizon Europe Framework Programme'
};

// Die folgenden Bloecke stehen bewusst VOR startObserver(): auf einer
// bereits geladenen Seite laeuft der Beobachter sofort los und prueft das
// Formular. Weiter unten deklarierte const/let waeren dann noch nicht
// initialisiert (ReferenceError: can't access lexical declaration).

// --- SCHREIBWEISE VON SCHLAGWORTEN ----------------------------------------
// Frueher entschied allein eine feste Ausnahmeliste, was gross geschrieben
// wird - neue Schlagworte fielen durch und wurden klein geschrieben. Jetzt
// greifen drei Stufen:
//   1. die manuelle Ausnahmeliste (hat Vorrang, fuer echte Sonderfaelle)
//   2. die Hausschreibweise aus DORA selbst (Solr: welche Variante desselben
//      Begriffs im Bestand ueberwiegt) - das waechst mit dem Bestand mit
//   3. Regeln: chemische Formeln, Abkuerzungen, Laendernamen
// ---------------------------------------------------------------------------

// Alle Elementsymbole - Grundlage fuer das Erkennen chemischer Formeln
const ELEMENTSYMBOLE = ['H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
    'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V',
    'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br',
    'Kr', 'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Tc', 'Ru', 'Rh', 'Pd', 'Ag',
    'Cd', 'In', 'Sn', 'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Pr',
    'Nd', 'Pm', 'Sm', 'Eu', 'Gd', 'Tb', 'Dy', 'Ho', 'Er', 'Tm', 'Yb', 'Lu',
    'Hf', 'Ta', 'W', 'Re', 'Os', 'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi',
    'Po', 'At', 'Rn', 'Fr', 'Ra', 'Ac', 'Th', 'Pa', 'U', 'Np', 'Pu', 'Am',
    'Cm', 'Bk', 'Cf', 'Es', 'Fm', 'Md', 'No', 'Lr', 'Rf', 'Db', 'Sg', 'Bh',
    'Hs', 'Mt', 'Ds', 'Rg', 'Cn', 'Nh', 'Fl', 'Mc', 'Lv', 'Ts', 'Og'];
// Fuer das Zerlegen von Formeln zaehlen nur Elemente, die in Umwelt- und
// Materialforschung wirklich vorkommen. Sonst waere "nh4" mehrdeutig, weil
// es auch als Nihonium (Nh) gelesen werden koennte.
const FORMEL_ELEMENTE = ['H', 'He', 'Li', 'Be', 'B', 'C', 'N', 'O', 'F', 'Ne',
    'Na', 'Mg', 'Al', 'Si', 'P', 'S', 'Cl', 'Ar', 'K', 'Ca', 'Sc', 'Ti', 'V',
    'Cr', 'Mn', 'Fe', 'Co', 'Ni', 'Cu', 'Zn', 'Ga', 'Ge', 'As', 'Se', 'Br',
    'Kr', 'Rb', 'Sr', 'Y', 'Zr', 'Nb', 'Mo', 'Ru', 'Rh', 'Pd', 'Ag', 'Cd',
    'In', 'Sn', 'Sb', 'Te', 'I', 'Xe', 'Cs', 'Ba', 'La', 'Ce', 'Nd', 'Sm',
    'Eu', 'Gd', 'Tb', 'Dy', 'Er', 'Yb', 'Lu', 'Hf', 'Ta', 'W', 'Re', 'Os',
    'Ir', 'Pt', 'Au', 'Hg', 'Tl', 'Pb', 'Bi', 'Th', 'U'];
const ELEMENT_NACH_KLEIN = new Map(FORMEL_ELEMENTE.map(e => [e.toLowerCase(), e]));

// Laender- und Regionennamen (ISO 3166 plus gaengige Grossraeume). Anders als
// die Ausnahmeliste ist das eine feststehende Groesse, die nicht mit jedem
// neuen Schlagwort waechst.
const GEO_NAMEN = ['Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola',
    'Argentina', 'Armenia', 'Australia', 'Austria', 'Azerbaijan', 'Bahrain',
    'Bangladesh', 'Belarus', 'Belgium', 'Belize', 'Benin', 'Bhutan', 'Bolivia',
    'Bosnia and Herzegovina', 'Botswana', 'Brazil', 'Brunei', 'Bulgaria',
    'Burkina Faso', 'Burundi', 'Cambodia', 'Cameroon', 'Canada', 'Chad',
    'Chile', 'China', 'Colombia', 'Congo', 'Costa Rica', 'Croatia', 'Cuba',
    'Cyprus', 'Czech Republic', 'Czechia', 'Denmark', 'Djibouti',
    'Dominican Republic', 'Ecuador', 'Egypt', 'El Salvador', 'Eritrea',
    'Estonia', 'Eswatini', 'Ethiopia', 'Fiji', 'Finland', 'France', 'Gabon',
    'Gambia', 'Georgia', 'Germany', 'Ghana', 'Greece', 'Greenland',
    'Guatemala', 'Guinea', 'Guyana', 'Haiti', 'Honduras', 'Hungary',
    'Iceland', 'India', 'Indonesia', 'Iran', 'Iraq', 'Ireland', 'Israel',
    'Italy', 'Ivory Coast', 'Jamaica', 'Japan', 'Jordan', 'Kazakhstan',
    'Kenya', 'Kosovo', 'Kuwait', 'Kyrgyzstan', 'Laos', 'Latvia', 'Lebanon',
    'Lesotho', 'Liberia', 'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg',
    'Madagascar', 'Malawi', 'Malaysia', 'Maldives', 'Mali', 'Malta',
    'Mauritania', 'Mauritius', 'Mexico', 'Moldova', 'Monaco', 'Mongolia',
    'Montenegro', 'Morocco', 'Mozambique', 'Myanmar', 'Namibia', 'Nepal',
    'Netherlands', 'New Zealand', 'Nicaragua', 'Niger', 'Nigeria',
    'North Macedonia', 'Norway', 'Oman', 'Pakistan', 'Palestine', 'Panama',
    'Papua New Guinea', 'Paraguay', 'Peru', 'Philippines', 'Poland',
    'Portugal', 'Qatar', 'Romania', 'Russia', 'Rwanda', 'Saudi Arabia',
    'Senegal', 'Serbia', 'Sierra Leone', 'Singapore', 'Slovakia', 'Slovenia',
    'Somalia', 'South Africa', 'South Korea', 'South Sudan', 'Spain',
    'Sri Lanka', 'Sudan', 'Suriname', 'Sweden', 'Switzerland', 'Syria',
    'Taiwan', 'Tajikistan', 'Tanzania', 'Thailand', 'Togo', 'Tunisia',
    'Turkey', 'Turkmenistan', 'Uganda', 'Ukraine', 'United Arab Emirates',
    'United Kingdom', 'United States', 'Uruguay', 'Uzbekistan', 'Venezuela',
    'Vietnam', 'Yemen', 'Zambia', 'Zimbabwe',
    // Grossraeume, Meere und Gebirge
    'Africa', 'Antarctica', 'Arctic', 'Asia', 'Atlantic', 'Alps', 'Amazon',
    'Baltic', 'Caribbean', 'Europe', 'Himalaya', 'Mediterranean',
    'North America', 'Pacific', 'Sahara', 'Scandinavia', 'South America',
    'Southeast Asia', 'Siberia', 'Tibet',
    // Schweizer Bezuege, die haeufig als Schlagwort auftauchen
    'Basel', 'Bern', 'Geneva', 'Graubünden', 'Jura', 'Lausanne', 'Lucerne',
    'Ticino', 'Valais', 'Zurich',
    // Deutsche, franzoesische und italienische Formen - DORA fuehrt vier Sprachen
    'Schweiz', 'Suisse', 'Svizzera', 'Alpen', 'Alpes', 'Alpi', 'Deutschland',
    'Allemagne', 'Germania', 'Italia', 'Italie', 'Italien', 'Frankreich',
    'Österreich', 'Autriche', 'Europa', 'Afrika', 'Afrique', 'Asien', 'Asie',
    'Tessin', 'Wallis', 'Grisons', 'Grigioni', 'Genf', 'Genève', 'Ginevra',
    'Zürich', 'Berna', 'Basilea', 'Lugano', 'Locarno', 'Davos', 'Engadin',
    'Karpaten', 'Carpathians', 'Pyrenees', 'Pyrenäen', 'Vosges', 'Balkan'];
const GEO_NACH_KLEIN = new Map(GEO_NAMEN.map(n => [n.toLowerCase(), n]));

const VOKAL_RE = /[aeiouyäöüàáâãéèêíìóôõúùü]/i;

// Alle moeglichen Zerlegungen eines Buchstabenlaufs in Elementsymbole.
// Nur wenn alle Zerlegungen dieselbe Schreibweise ergeben, ist die Formel
// eindeutig - "co2" waere sonst Co2 (Cobalt) oder CO2 (Kohlendioxid).
function elementZerlegungen(lauf) {
    if (!lauf) return [''];
    const ergebnisse = [];

    [2, 1].forEach(laenge => {
        if (lauf.length < laenge) return;
        const symbol = ELEMENT_NACH_KLEIN.get(lauf.slice(0, laenge).toLowerCase());
        if (!symbol) return;
        elementZerlegungen(lauf.slice(laenge)).forEach(rest => {
            if (rest !== null) ergebnisse.push(symbol + rest);
        });
    });

    return ergebnisse;
}

// Chemische Formel in kanonische Schreibweise bringen - nur bei Ziffern oder
// Ladungsangaben, sonst waere jedes "as" plötzlich Arsen.
function chemischeFormel(token) {
    if (!token || !/\d/.test(token)) return '';
    if (!/^[A-Za-z0-9().·+\-\u2212]+$/.test(token)) return '';
    if (!/[A-Za-z]/.test(token)) return '';

    let ergebnis = '';
    let position = 0;
    while (position < token.length) {
        const lauf = (/^[A-Za-z]+/.exec(token.slice(position)) || [''])[0];
        if (!lauf) {
            ergebnis += token[position];
            position += 1;
            continue;
        }

        const varianten = new Set(elementZerlegungen(lauf));
        if (varianten.size !== 1) return ''; // mehrdeutig - DORA entscheidet
        ergebnis += Array.from(varianten)[0];
        position += lauf.length;
    }
    return ergebnis;
}

// Schreibweise, die der Nutzer offensichtlich absichtlich gewaehlt hat:
// Binnenmajuskel (pH, TiO2, mRNA) oder eine Abkuerzung in Grossbuchstaben.
function istGewollteSchreibweise(token) {
    const kern = token.replace(/[^A-Za-zÄÖÜäöü0-9]/g, '');
    if (kern.length < 2) return false;
    if (/[a-zäöü][A-ZÄÖÜ]/.test(kern)) return true;              // pH, TiO2, mRNA
    if (/^[A-ZÄÖÜ]{2,8}[0-9]*$/.test(kern)) return true;         // DNA, HPLC, ERA5
    return false;
}

// Schreit die ganze Eingabe in Grossbuchstaben (typisch fuer Scopus-Exporte),
// zaehlt das nicht als gewollte Schreibweise.
function istGeschrien(text) {
    if (text !== text.toUpperCase()) return false;
    return text.split(/[\s\-\/,]+/).some(w => w.length > 4 && VOKAL_RE.test(w));
}

function tokenSchreibweise(token, geschrien) {
    // Satzzeichen am Rand unangetastet lassen
    const rand = /^([^A-Za-z0-9ÄÖÜäöü]*)(.*?)([^A-Za-z0-9ÄÖÜäöü]*)$/.exec(token);
    const vorn = rand[1], kern = rand[2], hinten = rand[3];
    if (!kern) return token;

    if (!geschrien && istGewollteSchreibweise(kern)) return vorn + kern + hinten;

    const geo = GEO_NACH_KLEIN.get(kern.toLowerCase());
    if (geo) return vorn + geo + hinten;

    const formel = chemischeFormel(kern);
    if (formel) return vorn + formel + hinten;

    // Abkuerzung ohne Vokal - auch mit Ziffern dahinter (nmr, hplc, pm10)
    const buchstaben = kern.replace(/[^A-Za-zÄÖÜäöü]/g, '');
    if (buchstaben.length >= 2 && buchstaben.length <= 6 && !VOKAL_RE.test(buchstaben)) {
        return vorn + kern.toUpperCase() + hinten;
    }

    return vorn + kern.toLowerCase() + hinten;
}

// Regelbasierte Schreibweise - laeuft sofort, ohne Netz.
function keywordRegeln(text) {
    const sauber = (text || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!sauber) return '';

    const geschrien = istGeschrien(sauber);

    // Mehrwortige Namen zuerst: "united kingdom", "south africa",
    // "north america" wuerden Wort fuer Wort auseinanderfallen.
    const alsGanzes = GEO_NACH_KLEIN.get(sauber.toLowerCase());
    if (alsGanzes) return alsGanzes;

    return sauber.split(' ').map(wort =>
        // Bindestrich-Verbindungen Teil fuer Teil (x-ray, SARS-CoV-2)
        wort.split(/(-|\/)/).map(teil =>
            (teil === '-' || teil === '/') ? teil : tokenSchreibweise(teil, geschrien)
        ).join('')
    ).join(' ');
}

// --- Hausschreibweise aus DORA (Solr) --------------------------------------
const KEYWORD_CACHE_KEY = 'doraKeywordSchreibweisen';
const KEYWORD_CACHE_TTL = 30 * 24 * 60 * 60 * 1000;      // gefundene Formen
const KEYWORD_CACHE_TTL_LEER = 3 * 24 * 60 * 60 * 1000;  // Fehlanzeigen
const KEYWORD_CACHE_MAX = 800;
const KEYWORD_MIN_BELEGE = 3;      // darunter ist die Mehrheit Zufall
const KEYWORD_MIN_ANTEIL = 0.6;    // klare Mehrheit verlangt
const keywordSpeicher = new Map(); // Zwischenspeicher im Tab

function keywordCacheLesen(begriff, callback) {
    const schluessel = begriff.toLowerCase();
    if (keywordSpeicher.has(schluessel)) { callback(keywordSpeicher.get(schluessel)); return; }
    try {
        chrome.storage.local.get({ [KEYWORD_CACHE_KEY]: {} }, (gespeichert) => {
            const eintrag = (gespeichert[KEYWORD_CACHE_KEY] || {})[schluessel];
            const frist = eintrag && eintrag.form ? KEYWORD_CACHE_TTL : KEYWORD_CACHE_TTL_LEER;
            if (eintrag && eintrag.zeit && (Date.now() - eintrag.zeit) < frist) {
                keywordSpeicher.set(schluessel, eintrag);
                callback(eintrag);
            } else {
                callback(null);
            }
        });
    } catch (e) {
        callback(null);
    }
}

function keywordCacheSchreiben(begriff, eintrag) {
    const schluessel = begriff.toLowerCase();
    keywordSpeicher.set(schluessel, eintrag);
    try {
        chrome.storage.local.get({ [KEYWORD_CACHE_KEY]: {} }, (gespeichert) => {
            const alle = gespeichert[KEYWORD_CACHE_KEY] || {};
            alle[schluessel] = eintrag;
            const behalten = Object.keys(alle)
                .sort((a, b) => (alle[b].zeit || 0) - (alle[a].zeit || 0))
                .slice(0, KEYWORD_CACHE_MAX);
            const neu = {};
            behalten.forEach(k => { neu[k] = alle[k]; });
            chrome.storage.local.set({ [KEYWORD_CACHE_KEY]: neu });
        });
    } catch (e) { /* ohne Ablage genuegt der Tab-Speicher */ }
}

// Wie schreibt DORA diesen Begriff? Gesucht wird im analysierten Feld
// (kleingeschrieben, tokenisiert), gezaehlt werden die Original-Schreibweisen
// der Treffer. Das alte Solr kennt weder facet.contains noch ignoreCase.
function keywordSchreibweiseAusDora(begriff, callback) {
    const gesucht = (begriff || '').trim();
    if (gesucht.length < 2 || !/[A-Za-zÄÖÜäöü]/.test(gesucht)) { callback(null); return; }

    keywordCacheLesen(gesucht, (gespeichert) => {
        if (gespeichert) { callback(gespeichert.form ? gespeichert : null); return; }

        const phrase = gesucht.replace(/["\\]/g, ' ');
        const url = 'http://lib-dora-prod1.emp-eaw.ch:8080/solr/collection1/select'
            + '?q=' + encodeURIComponent('mods_subject_topic_mt:"' + phrase + '"')
            + '&rows=120&wt=json&fl=mods_subject_topic_ms';

        chrome.runtime.sendMessage({ action: 'searchAutocomplete', url: url }, (antwort) => {
            if (!antwort || !antwort.success || !antwort.data || !antwort.data.response) {
                callback(null);
                return;
            }

            const zaehler = new Map();
            (antwort.data.response.docs || []).forEach(doc => {
                (doc.mods_subject_topic_ms || []).forEach(wert => {
                    if (String(wert).toLowerCase().trim() !== gesucht.toLowerCase()) return;
                    zaehler.set(wert, (zaehler.get(wert) || 0) + 1);
                });
            });

            const sortiert = Array.from(zaehler.entries()).sort((a, b) => b[1] - a[1]);
            const gesamt = sortiert.reduce((summe, e) => summe + e[1], 0);
            const bester = sortiert[0];

            const belastbar = !!bester
                && bester[1] >= KEYWORD_MIN_BELEGE
                && (bester[1] / gesamt) >= KEYWORD_MIN_ANTEIL;

            const eintrag = {
                zeit: Date.now(),
                form: belastbar ? bester[0] : '',
                belege: belastbar ? bester[1] : 0,
                gesamt: gesamt
            };
            keywordCacheSchreiben(gesucht, eintrag);
            callback(belastbar ? eintrag : null);
        });
    });
}

// Regeln jetzt, Hausschreibweise sobald sie da ist. Der Rueckruf bekommt
// { text, quelle, belege } - quelle ist 'liste', 'dora' oder 'regel'.
function formatKeywordSmart(text, callback) {
    const ausListe = keywordAusAusnahmeliste(text);
    if (ausListe) {
        if (callback) callback({ text: ausListe, quelle: 'liste' });
        return ausListe;
    }

    const nachRegeln = keywordRegeln(text);
    if (!callback) return nachRegeln;

    const roh = (text || '').replace(/\s+/g, ' ').trim();
    keywordSchreibweiseAusDora(roh, (befund) => {
        if (befund && befund.form && befund.form !== nachRegeln) {
            callback({ text: befund.form, quelle: 'dora', belege: befund.belege });
        } else {
            callback({ text: nachRegeln, quelle: befund ? 'dora' : 'regel', belege: befund ? befund.belege : 0 });
        }
    });
    return nachRegeln;
}

// Manuelle Ausnahmeliste: gilt nur, wenn sie den ganzen Begriff trifft oder
// einzelne Woerter darin ersetzt. Sie behaelt Vorrang vor allem anderen.
function keywordAusAusnahmeliste(text) {
    if (!cachedExceptions.length) return '';
    const sauber = (text || '').replace(/\s+/g, ' ').trim();
    if (!sauber) return '';

    let out = sauber;
    let getroffen = false;
    cachedExceptions.forEach(ex => {
        ex.regex.lastIndex = 0;
        if (ex.regex.test(out)) {
            ex.regex.lastIndex = 0;
            out = out.replace(ex.regex, ex.replacement);
            getroffen = true;
        }
    });
    return getroffen ? out : '';
}

function formatKeyword(text) {
    const ausListe = keywordAusAusnahmeliste(text);
    if (ausListe) return ausListe;
    return keywordRegeln(text);
}
// Dasselbe als Versprechen - fuer Abläufe, die ohnehin warten (Bulk-Einfügen).
function keywordSchreibweiseVersprochen(text) {
    return new Promise(erfuellen => {
        let erledigt = false;
        const antwort = (befund) => {
            if (erledigt) return;
            erledigt = true;
            erfuellen((befund && befund.text) || formatKeyword(text));
        };
        formatKeywordSmart(text, antwort);
        // Der Lookup darf das Einfügen nicht aufhalten
        setTimeout(() => antwort(null), 2500);
    });
}

// Schreibweise eines Eingabefelds an DORA ausrichten, sobald der Lookup
// antwortet. Der Nutzer soll dabei nicht ueberfahren werden: hat er das Feld
// schon selbst angefasst, bleibt seine Fassung stehen.
function keywordSchreibweiseNachziehen(feld, rohwert) {
    if (!feld || !rohwert) return;
    const vorher = feld.value;

    formatKeywordSmart(rohwert, (befund) => {
        if (!befund || !befund.text) return;
        if (feld.value !== vorher) return;          // inzwischen selbst bearbeitet
        if (befund.text === feld.value) {
            if (befund.quelle === 'dora') {
                feld.title = `Schreibweise wie in DORA (${befund.belege} Belege)`;
            }
            return;
        }

        feld.value = befund.text;
        feld.title = befund.quelle === 'dora'
            ? `Schreibweise aus DORA übernommen (${befund.belege} Belege)`
            : 'Schreibweise automatisch angepasst';

        // Kurz aufblitzen, damit die Änderung nicht unbemerkt bleibt
        const vorherigerGrund = feld.style.backgroundColor;
        feld.style.backgroundColor = befund.quelle === 'dora' ? '#e6f7ff' : '#f0fdf4';
        setTimeout(() => { feld.style.backgroundColor = vorherigerGrund; }, 1200);

        feld.dispatchEvent(new Event('input', { bubbles: true }));
    });
}



// --- SENTENCE CASE ---------------------------------------------------------
// Die alte Pruefung nahm eine feste Stoppwortliste, ignorierte Satzgrenzen und
// kannte nur Englisch/Deutsch. Sie schlug deshalb bei deutschen und
// franzoesischen Titeln Alarm ("Der Schneehase in den Alpen. Ein
// Ueberlebenskuenstler" - "Ein" steht nach einem Punkt und ist korrekt) und
// pruefte sogar Journaltitel, die als Eigennamen in Title Case gehoeren.
//
// Neu wird sprachbewusst geprueft:
//   - Text von HTML befreien (die Felder enthalten <em>, <u>, <sub>)
//   - in Segmente schneiden (Punkt, Doppelpunkt, Frage-/Ausrufezeichen,
//     Gedankenstrich, Klammer, Anfuehrung) - jedes Segment darf gross anfangen
//   - Sprache aus Funktionswoertern und Diakritika bestimmen
//   - gross geschriebene Funktionswoerter mitten im Segment sind der
//     verlaessliche Hinweis auf Title Case, in jeder Sprache
//   - die Quote gross geschriebener Woerter zaehlt nur in Sprachen, die
//     Substantive klein schreiben (also nicht im Deutschen)
// ---------------------------------------------------------------------------

const FUNKTIONSWOERTER = {
    de: ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines', 'einem', 'einen',
        'und', 'oder', 'aber', 'sondern', 'auch', 'wie', 'als', 'wenn', 'weil', 'dass', 'ob',
        'in', 'im', 'am', 'an', 'auf', 'aus', 'bei', 'bis', 'durch', 'für', 'gegen', 'mit', 'nach',
        'ohne', 'seit', 'über', 'um', 'unter', 'von', 'vom', 'vor', 'während', 'wegen', 'zu', 'zum',
        'zur', 'zwischen', 'sowie', 'nicht', 'kein', 'keine', 'ist', 'sind', 'war', 'waren', 'wird',
        'werden', 'wurde', 'wurden', 'sich', 'ihre', 'ihr', 'sein', 'seine', 'dieser', 'diese', 'dieses'],
    fr: ['le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'au', 'aux', 'et', 'ou', 'mais', 'donc',
        'car', 'que', 'qui', 'dont', 'dans', 'sur', 'sous', 'pour', 'par', 'avec', 'sans', 'entre',
        'chez', 'vers', 'depuis', 'pendant', 'selon', 'comme', 'en', 'à', 'ne', 'pas', 'plus',
        'est', 'sont', 'était', 'étaient', 'ses', 'son', 'sa', 'leur', 'leurs', 'ce', 'cet', 'cette', 'ces'],
    it: ['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una', 'del', 'della', 'dei', 'delle',
        'di', 'da', 'dal', 'dalla', 'e', 'ed', 'o', 'ma', 'che', 'chi', 'in', 'nel', 'nella',
        'con', 'per', 'su', 'sul', 'tra', 'fra', 'come', 'non', 'è', 'sono', 'era', 'erano', 'suo', 'sua'],
    es: ['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'del', 'de', 'al', 'y', 'o', 'pero',
        'que', 'quien', 'en', 'con', 'por', 'para', 'sobre', 'entre', 'desde', 'hasta', 'sin',
        'como', 'no', 'es', 'son', 'era', 'eran', 'su', 'sus', 'este', 'esta', 'estos'],
    en: ['the', 'a', 'an', 'and', 'or', 'but', 'nor', 'so', 'yet', 'of', 'in', 'on', 'at', 'to',
        'for', 'from', 'by', 'with', 'without', 'into', 'onto', 'over', 'under', 'above', 'below',
        'between', 'among', 'during', 'after', 'before', 'through', 'across', 'against', 'about',
        'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'its', 'their', 'his', 'her',
        'this', 'that', 'these', 'those', 'not', 'than', 'then', 'when', 'while', 'where', 'which',
        'who', 'whose', 'how', 'why', 'if', 'per', 'via', 'up', 'out', 'off', 'do', 'does', 'did']
};

// Nur Artikel bilden mit einem folgenden Namen einen Eigennamen
// ("Le Havre", "Die Grüne Reihe", "The Hague"). Praepositionen tun das nicht -
// "Of Nitrogen" ist immer Title Case.
const ARTIKEL = new Set([
    'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einer', 'eines',
    'le', 'la', 'les', 'un', 'une', 'l', 'il', 'lo', 'gli', 'i', 'el', 'los', 'las',
    'the', 'a', 'an'
]);

// Sprachen, die Substantive klein schreiben - nur dort sagt eine hohe Quote
// gross geschriebener Woerter etwas aus.
const KLEINSCHREIBENDE_SPRACHEN = ['en', 'fr', 'it', 'es'];

// Typische Wortendungen je Sprache - sie brechen Gleichstaende, wenn die
// Funktionswoerter in mehreren Sprachen vorkommen.
const MORPHOLOGIE = {
    de: /(ung|ungen|heit|keit|schaft|tum|nis|ische|ischen|lichen|liche|ischer|stellung|forschung)$/,
    fr: /(tion|tions|ment|ments|ité|eux|euse|aire|ance|ence)$/,
    it: /(zione|zioni|mento|menti|ità|ezza|aggio|ale|ali)$/,
    es: /(ción|ciones|miento|dad|mente|ales)$/,
    en: /(tion|tions|ment|ing|ness|ity|ship|ology|ical)$/
};
const DIAKRITIKA = {
    de: /[äöüßÄÖÜ]/,
    fr: /[àâçéèêëîïôùûüœÀÂÇÉÈÊËÎÏÔÙÛÜŒ]/,
    it: /[àèéìíòóùú]/,
    es: /[áéíóúñ¿¡]/
};

// Roemische Zahlen und typische Abkuerzungen, die gross bleiben duerfen
const ROEMISCH_RE = /^[IVXLCDM]+$/;
const ABKUERZUNG_RE = /^[A-ZÄÖÜ][a-zäöü]{0,3}\.$/;   // Abb., Nr., Bd., Vol.

function satzTextBereinigen(roh) {
    return (roh || '')
        // Kursives markiert in DORA Artnamen und fremdsprachige Begriffe
        // (<em>Armillaria tabescens</em>) - das ist von der Schreibweisen-
        // Pruefung ausgenommen und fliegt komplett heraus.
        .replace(/<(em|i)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')              // restliche Auszeichnung
        .replace(/&[a-z]+;|&#\d+;/gi, ' ')     // Entities
        .replace(/\s+/g, ' ')
        .trim();
}

function satzSpracheErkennen(text) {
    const woerter = text.toLowerCase().split(/[^a-zà-öø-ÿ']+/).filter(Boolean);
    const punkte = {};

    Object.keys(FUNKTIONSWOERTER).forEach(sprache => {
        const liste = FUNKTIONSWOERTER[sprache];
        punkte[sprache] = woerter.filter(w => liste.indexOf(w) !== -1).length;
    });

    // Diakritika sind ein starker Hinweis, aber kein Beweis
    Object.keys(DIAKRITIKA).forEach(sprache => {
        if (DIAKRITIKA[sprache].test(text)) punkte[sprache] += 2;
    });

    // Endungen entscheiden Gleichstaende: "in" zaehlt fuer Deutsch wie fuer
    // Englisch, "Genetische" und "Samenmischungen" nur fuer Deutsch.
    Object.keys(MORPHOLOGIE).forEach(sprache => {
        const treffer = woerter.filter(w => MORPHOLOGIE[sprache].test(w)).length;
        if (treffer) punkte[sprache] += Math.min(treffer, 3);
    });

    let beste = 'en';
    Object.keys(punkte).forEach(sprache => {
        if (punkte[sprache] > punkte[beste]) beste = sprache;
    });
    // Ohne jeden Beleg bleibt es bei Englisch - aber das wird vermerkt,
    // damit der Quotentest nicht auf Vermutungen losgeht.
    return { sprache: punkte[beste] > 0 ? beste : 'en', belege: punkte[beste] };
}

// Satzgrenzen: nach jedem davon darf gross weitergehen.
function satzSegmente(text) {
    return text
        .split(/(?:[.:;?!|\/]|\s[–—-]\s|\(|\)|"|«|»|„|“|”)+/)
        .map(s => s.trim())
        .filter(Boolean);
}

function satzWortKern(wort) {
    return wort.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}.]+$/u, '');
}

function istGrossGeschrieben(kern) {
    return /^[A-ZÄÖÜÀ-ÖØ-Þ]/.test(kern);
}

// Woerter, die als Bestandteil geografischer und institutioneller Eigennamen
// gross geschrieben werden - mehrsprachig, weil DORA vier Sprachen fuehrt.
const EIGENNAME_TEILE = new Set([
    'canton', 'kanton', 'cantone', 'national', 'nationale', 'nazionale',
    'park', 'parc', 'parco', 'reserve', 'réserve', 'riserva', 'reservat',
    'mountains', 'mountain', 'berge', 'monti', 'monte', 'montagne', 'montagnes',
    'lake', 'see', 'lac', 'lago', 'river', 'fluss', 'rivière', 'fiume',
    'valley', 'tal', 'vallée', 'vallee', 'valle', 'vallata', 'forest', 'wald',
    'forêt', 'foresta', 'university', 'universität', 'université', 'università',
    'institute', 'institut', 'istituto', 'station', 'sottostazione', 'stazione',
    'island', 'islands', 'insel', 'île', 'isola', 'sea', 'meer', 'mer', 'mare',
    'nord', 'süd', 'sud', 'ost', 'est', 'west', 'ovest', 'north', 'south',
    'eastern', 'western', 'northern', 'southern', 'central', 'zentral', 'centrale',
    'basin', 'becken', 'bassin', 'bacino', 'plateau', 'massif', 'massiv'
]);

// Woerter, ueber die nichts auszusagen ist: Abkuerzungen, Formeln, Zahlen,
// Eigennamen aus der Geo-Liste, Binnenmajuskeln.
function satzWortUebergehen(kern) {
    if (!kern || kern.length < 2) return true;
    if (/\d/.test(kern)) return true;                       // Sentinel-2, 1935
    if (kern === kern.toUpperCase()) return true;           // Akronyme
    if (/[a-zäöü][A-ZÄÖÜ]/.test(kern)) return true;         // McDonald, pH, TiO2
    if (ROEMISCH_RE.test(kern)) return true;
    if (ABKUERZUNG_RE.test(kern)) return true;
    if (typeof GEO_NACH_KLEIN !== 'undefined' && GEO_NACH_KLEIN.has(kern.toLowerCase())) return true;

    // Taxonomische Raenge sind gross geschrieben: Tingidae, Poaceae, Rosales
    if (/(?:idae|aceae|ales|inae|eae|opsida|phyta|mycota|viridae|bacteria|archaea)$/i.test(kern)) return true;
    return false;
}

// Ein generisches Wort wie "Mountains" oder "Park" gehoert zu einem
// Eigennamen, wenn daneben ein weiteres grosses Wort steht, das selbst kein
// solches Allerweltswort ist ("Rodnei Mountains National Park"). Alleine
// stehend ist es ein gewoehnliches Substantiv ("Forest Ecosystems").
// Ein Allerweltswort wie "Mountains" oder "Park" gehoert zu einem Eigennamen,
// wenn es in einer Kette grossgeschriebener Woerter steht, in der auch ein
// eigener Name vorkommt ("Rodnei Mountains National Park"). Alleine oder nur
// mit anderen Allerweltswoertern ist es ein gewoehnliches Substantiv
// ("Forest Ecosystems" ist Title Case, kein Ortsname).
function istTeilEinesOrtsnamens(woerter, index) {
    const kern = satzWortKern(woerter[index] || '');
    if (!EIGENNAME_TEILE.has(kern.toLowerCase())) return false;

    // Kette grossgeschriebener Woerter um diese Stelle herum abschreiten
    let von = index, bis = index;
    const grossAn = (i) => {
        const k = satzWortKern(woerter[i] || '');
        return k && istGrossGeschrieben(k) ? k : null;
    };
    while (von - 1 >= 0 && grossAn(von - 1)) von -= 1;
    while (bis + 1 < woerter.length && grossAn(bis + 1)) bis += 1;

    // Enthaelt die Kette einen echten Namen (kein Allerweltswort, keine
    // Abkuerzung)? Dann ist sie ein Eigenname.
    for (let i = von; i <= bis; i++) {
        const k = grossAn(i);
        if (!k) continue;
        if (EIGENNAME_TEILE.has(k.toLowerCase())) continue;
        if (satzWortUebergehen(k)) continue;   // Akronyme, Zahlen, Geo-Namen
        return true;
    }
    return false;
}

function pruefeSatzschreibung(rohtext, optionen) {
    const opt = optionen || {};
    const text = satzTextBereinigen(rohtext);
    const leer = { ok: true, sprache: '', art: null, woerter: [], meldung: '' };
    if (!text) return leer;

    const alleWoerter = text.split(' ').filter(Boolean);
    if (alleWoerter.length < 2) return leer;

    // 1. Durchgehende Grossschreibung - gilt fuer jedes Feld, auch Eigennamen
    const buchstaben = text.replace(/[^\p{L}]/gu, '');
    const grossAnteil = buchstaben ? (buchstaben.replace(/[^A-ZÄÖÜÀ-ÖØ-Þ]/g, '').length / buchstaben.length) : 0;
    if (alleWoerter.length >= 3 && grossAnteil > 0.9) {
        return {
            ok: false, sprache: '', art: 'grossbuchstaben', woerter: [],
            meldung: 'steht ganz in Grossbuchstaben (bitte Sentence case verwenden).'
        };
    }

    // Eigennamen-Felder (Journaltitel) werden nicht weiter geprueft
    if (opt.eigenname) return { ok: true, sprache: '', art: null, woerter: [], meldung: '' };

    // 2. Fehlender Grossbuchstabe am Anfang
    if (!/[A-ZÄÖÜÀ-ÖØ-Þ]/.test(text) && alleWoerter.length >= 3) {
        return {
            ok: false, sprache: '', art: 'kleinanfang', woerter: [],
            meldung: 'beginnt klein - der erste Buchstabe gehört gross.'
        };
    }

    const erkannt = satzSpracheErkennen(text);
    const sprache = erkannt.sprache;
    const funktionswoerter = FUNKTIONSWOERTER[sprache] || FUNKTIONSWOERTER.en;

    const verdaechtig = [];   // gross geschriebene Funktionswoerter
    let inFrage = 0;          // bewertbare Woerter (fuer die Quote)
    let grossGeschrieben = 0;

    satzSegmente(text).forEach(segment => {
        const woerter = segment.split(' ').filter(Boolean);

        woerter.forEach((wort, index) => {
            if (index === 0) return;             // Segmentanfang darf gross sein
            const kern = satzWortKern(wort);
            if (satzWortUebergehen(kern)) return;

            const gross = istGrossGeschrieben(kern);
            const istFunktionswort = funktionswoerter.indexOf(kern.toLowerCase()) !== -1;

            if (gross && istFunktionswort) {
                // "Le Havre", "Die Grüne Reihe", "The Hague": folgt ein weiteres
                // grosses Wort, ist es eher ein Eigenname als Title Case.
                const naechster = satzWortKern(woerter[index + 1] || '');
                const naechsterGross = naechster && istGrossGeschrieben(naechster)
                    && funktionswoerter.indexOf(naechster.toLowerCase()) === -1;
                const istArtikel = ARTIKEL.has(kern.toLowerCase());
                if (!(istArtikel && naechsterGross)) verdaechtig.push(kern);
                return;
            }

            if (istFunktionswort) return;        // klein und Funktionswort: korrekt
            if (istTeilEinesOrtsnamens(woerter, index)) return;
            inFrage += 1;
            if (gross) grossGeschrieben += 1;
        });
    });

    if (verdaechtig.length) {
        const liste = Array.from(new Set(verdaechtig)).slice(0, 4).map(w => '«' + w + '»').join(', ');
        return {
            ok: false, sprache: sprache, art: 'funktionswort', woerter: verdaechtig,
            meldung: `enthält gross geschriebene Funktionswörter (${liste}) – bitte Sentence case verwenden.`
        };
    }

    // 3. Quote gross geschriebener Woerter - nur wo Substantive klein sind
    // Nur wo Substantive klein geschrieben werden - und nur wenn die Sprache
    // wirklich belegt ist, sonst wuerde jeder titelartige Nominalsatz ohne
    // Funktionswoerter ("Bergsport Sommer. Technik, Taktik") aufschlagen.
    if (KLEINSCHREIBENDE_SPRACHEN.indexOf(sprache) !== -1
        && erkannt.belege >= 1 && !opt.nurFunktionswoerter) {
        const quote = inFrage ? grossGeschrieben / inFrage : 0;
        // Sind alle inhaltstragenden Woerter gross, ist es Title Case - auch
        // bei drei Woertern ("Water Quality Assessment"). Diese scharfe
        // Variante gilt nur fuer Englisch/Spanisch; im Franzoesischen und
        // Italienischen sind kurze Namensketten ("Grand Tetras") zu haeufig.
        const scharf = (sprache === 'en' || sprache === 'es')
            && quote === 1 && grossGeschrieben >= 2 && inFrage >= 2;
        if (scharf || (grossGeschrieben >= 3 && inFrage >= 4 && quote >= 0.6)) {
            return {
                ok: false, sprache: sprache, art: 'titlecase', woerter: [],
                meldung: `scheint Title Case zu sein (${grossGeschrieben} von ${inFrage} Wörtern gross) – bitte Sentence case verwenden.`
            };
        }
    }

    return { ok: true, sprache: sprache, art: null, woerter: [], meldung: '' };
}

// Traegt das Feld einen Journalnamen? Entscheidend ist die Beschriftung im
// Formular - dasselbe Eingabefeld heisst bei Aufsaetzen "Journal Title" und
// bei Tagungsbaenden "Title of the Conference Proceedings".

// --- JOURNAL NEU ABFRAGEN --------------------------------------------------
// Die Journalangaben (Abkuerzung, Publisher, ISSN, E-ISSN, PID) stammen aus
// einem MADS-Objekt in der Sammlung journals: und werden ueber den Titel
// gefunden. Aendert sich dort etwas - etwa weil ein Verlag uebernommen wurde -
// bleibt der Datensatz auf dem alten Stand.
//
// Warum nicht per Solr nachschlagen: die Abfrage soll dieselbe sein wie im
// Formular. Darum steuern wir die Autovervollständigung der Seite fern,
// statt eine eigene zu bauen: derselbe Authority-Endpunkt, dieselbe Sitzung,
// derselbe Code-Pfad - und was die Seite beim Auswaehlen in die Nachbarfelder
// schreibt, schreibt sie genauso wie bei einer Eingabe von Hand.
//
// Die Feldnamen sind ueber alle Formularfassungen stabil, die IDs nicht: im
// Ingest-Formular sind sie zufaellig ("form-fGroc...--00000000668c..."), im
// Edit-Formular sprechend ("edit-host-titleinfo-title"). Darum ueber name.
//
// Alle Funktionen hier nehmen Dokument und Fenster entgegen, damit derselbe
// Ablauf im eigenen Formular und in einem fremden iframe laeuft - die
// Stapelpruefung der Batch-QC oeffnet jeden Datensatz in einem solchen.
const JOURNAL_FELDER = [
    { schluessel: 'title', name: 'host[titleInfo][title]', label: 'Journal Title' },
    { schluessel: 'abbr', name: 'host[titleInfo][abbr_title]', label: 'Abkürzung' },
    { schluessel: 'publisher', name: 'host[titleInfo][publisher]', label: 'Publisher' },
    { schluessel: 'issn', name: 'host[titleInfo][issn]', label: 'ISSN' },
    { schluessel: 'eissn', name: 'host[titleInfo][e-issn]', label: 'E-ISSN' },
    { schluessel: 'pid', name: 'host[titleInfo][pid]', label: 'PID' }
];

function journalFelder(doc) {
    const d = doc || document;
    const gefunden = {};
    JOURNAL_FELDER.forEach(f => {
        const el = d.querySelector('input[name="' + f.name + '"]');
        if (el) gefunden[f.schluessel] = el;
    });
    return gefunden;
}

function journalStand(felder) {
    const stand = {};
    Object.keys(felder).forEach(k => { stand[k] = felder[k].value; });
    return stand;
}

// Titel vergleichbar machen: Gross-/Kleinschreibung, "&"/"and", Satzzeichen
// und Mehrfachleerzeichen sollen keinen Unterschied machen.
function journalTitelSchluessel(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9äöüàâçéèêëîïôûùüÿñæœ]+/gi, ' ')
        .trim()
        .replace(/\s+/g, ' ');
}

// Die Autovervollständigung der Seite anstossen und auf ihre Vorschlagsliste
// warten. Drupal haengt dazu <div id="autocomplete"> neben das Eingabefeld.
function journalVorschlaegeHolen(input, fenster, zeitlimit) {
    const f = fenster || window;
    const doc = f.document;
    const grenze = zeitlimit || 9000;

    return new Promise((fertig) => {
        // Drupal hoert auf keyup und ignoriert Steuertasten; ein Tastenereignis
        // ohne keyCode faellt in den Normalfall und loest die Suche aus. Die
        // Ereignisse muessen aus dem Fenster des Formulars stammen.
        try { input.focus(); } catch (e) { /* egal */ }
        ['keydown', 'keyup'].forEach(typ => {
            input.dispatchEvent(new f.KeyboardEvent(typ, { bubbles: true, key: 'a' }));
        });

        const start = Date.now();
        const schauen = () => {
            const popup = doc.getElementById('autocomplete');
            const posten = popup ? Array.from(popup.querySelectorAll('li')) : [];
            if (posten.length) { fertig(posten); return; }

            // "Keine Treffer" meldet Drupal mit einem leeren Popup
            if (popup && Date.now() - start > 2500) { fertig([]); return; }
            if (Date.now() - start > grenze) { fertig(null); return; }
            setTimeout(schauen, 120);
        };
        setTimeout(schauen, 150);
    });
}

// Einen Vorschlag auswaehlen wie ein Mausklick: Drupal haengt seinen Handler
// an mousedown des inneren <div>, und daran haengt auch, was die Seite in die
// Nachbarfelder schreibt.
function journalVorschlagWaehlen(li, input, fenster) {
    const f = fenster || window;
    const ziel = li.querySelector('div') || li;
    ['mouseover', 'mousedown'].forEach(typ => {
        ziel.dispatchEvent(new f.MouseEvent(typ, { bubbles: true, cancelable: true, view: f }));
    });
    // Nachklappern, damit auch Handler an change/blur greifen
    setTimeout(() => {
        input.dispatchEvent(new f.Event('change', { bubbles: true }));
        input.dispatchEvent(new f.Event('blur', { bubbles: true }));
    }, 50);
}

function journalPostenText(li) {
    return (li.textContent || '').replace(/\s+/g, ' ').trim();
}

function journalDiffText(geaendert, vorher, nachher) {
    return geaendert.map(f => {
        const alt = vorher[f.schluessel] || '(leer)';
        const neu = nachher[f.schluessel] || '(leer)';
        return f.label + ': ' + alt + ' → ' + neu;
    }).join('\n');
}

// Der gemeinsame Kern: im uebergebenen Formular den Titel nachschlagen und
// - wenn eindeutig - uebernehmen. Liefert, was dabei herauskam, ohne zu
// speichern. Einzelknopf und Stapellauf benutzen beide diesen Weg.
async function journalAbfrageAusfuehren(fenster) {
    const f = fenster || window;
    const doc = f.document;
    const felder = journalFelder(doc);

    if (!felder.title) return { art: 'keinjournal', text: 'Kein Journalfeld im Formular' };

    const suchtext = felder.title.value.trim();
    if (!suchtext) return { art: 'keinjournal', text: 'Journaltitel ist leer' };

    const vorher = journalStand(felder);
    const posten = await journalVorschlaegeHolen(felder.title, f);

    if (posten === null) {
        return { art: 'fehler', text: 'Autovervollständigung hat nicht geantwortet', vorher: vorher };
    }
    if (!posten.length) {
        return { art: 'keintreffer', text: 'Kein Journal mit diesem Titel gefunden', vorher: vorher };
    }

    const gesucht = journalTitelSchluessel(suchtext);
    const genau = posten.filter(li => journalTitelSchluessel(journalPostenText(li)) === gesucht);

    if (genau.length !== 1) {
        // Nicht raten: "Water Research" traefe sonst auch "Water Research X".
        return {
            art: 'mehrdeutig',
            text: genau.length > 1
                ? genau.length + ' Journals tragen genau diesen Titel'
                : 'Kein exakter Titeltreffer',
            kandidaten: posten.map(journalPostenText).slice(0, 25),
            posten: posten,
            felder: felder,
            vorher: vorher
        };
    }

    journalVorschlagWaehlen(genau[0], felder.title, f);
    // Warten, bis die Seite die Nachbarfelder gefuellt hat - aber nur so
    // lange wie noetig. Ein fester Puffer ist bei einem Stapel von
    // Datensaetzen schnell eine Minute Leerlauf.
    // 800 ms Obergrenze: aendert sich etwas, ist es meist nach ein paar
    // Dutzend Millisekunden da. Aendert sich nichts, wird die Grenze voll
    // ausgeschoepft - bei einem Stapel unveraenderter Datensaetze zaehlt
    // jede Zehntelsekunde.
    await journalAufAenderungWarten(felder, vorher, 800);

    const nachher = journalStand(felder);
    const geaendert = JOURNAL_FELDER.filter(x => felder[x.schluessel]
        && vorher[x.schluessel] !== nachher[x.schluessel]);

    if (!geaendert.length) {
        return { art: 'aktuell', text: 'Journal war bereits aktuell', vorher: vorher, felder: felder };
    }
    return {
        art: 'aenderung',
        text: journalDiffText(geaendert, vorher, nachher),
        geaendert: geaendert,
        vorher: vorher,
        nachher: nachher,
        felder: felder
    };
}

// Auf die Antwort der Seite warten, statt einen festen Puffer abzusitzen.
// Bricht ab, sobald sich ein Feld geruehrt hat; der Rest der Zeit ist nur
// noch Sicherheitsnetz fuer langsame Nachzuegler.
function journalAufAenderungWarten(felder, vorher, grenze) {
    const bis = Date.now() + (grenze || 1200);
    return new Promise((fertig) => {
        const schauen = () => {
            const jetzt = journalStand(felder);
            const geruehrt = Object.keys(vorher).some(k => vorher[k] !== jetzt[k]);
            if (geruehrt || Date.now() > bis) { fertig(geruehrt); return; }
            setTimeout(schauen, 60);
        };
        setTimeout(schauen, 60);
    });
}

// --- Einzelknopf am Formular -----------------------------------------------
async function journalNeuAbfragen(knopf, melde) {
    const felder = journalFelder(document);
    if (!felder.title) { melde('Kein Journal-Titelfeld im Formular gefunden.', 'fehler'); return; }
    if (!felder.title.value.trim()) { melde('Bitte zuerst einen Journaltitel eintragen.', 'fehler'); return; }

    knopf.disabled = true;
    melde('Frage «' + felder.title.value.trim() + '» ab …', 'laeuft');

    const ergebnis = await journalAbfrageAusfuehren(window);
    knopf.disabled = false;

    if (ergebnis.art === 'aenderung') {
        ergebnis.geaendert.forEach(x => journalFeldHervorheben(felder[x.schluessel]));
        melde(ergebnis.text, 'geaendert',
            () => journalZuruecknehmen(felder, ergebnis.vorher, melde));
        return;
    }
    if (ergebnis.art === 'aktuell') { melde('Journal war bereits aktuell – nichts geändert.', 'gleich'); return; }
    if (ergebnis.art === 'mehrdeutig') {
        journalAuswahlZeigen(ergebnis.posten, felder, ergebnis.vorher, knopf, melde,
            ergebnis.text + ' – bitte wählen:');
        return;
    }
    if (ergebnis.art === 'keintreffer') { melde('Kein Journal mit diesem Titel gefunden. Schreibweise prüfen.', 'fehler'); return; }
    melde(ergebnis.text + '. Steht der Cursor im Titelfeld und ist die Seite fertig geladen?', 'fehler');
}

function journalZuruecknehmen(felder, vorher, melde) {
    Object.keys(vorher).forEach(k => {
        if (felder[k]) {
            felder[k].value = vorher[k];
            felder[k].style.removeProperty('background-color');
        }
    });
    melde('Zurückgenommen – die alten Werte stehen wieder im Formular.', 'gleich');
}

function journalFeldHervorheben(el) {
    el.style.setProperty('background-color', '#fefcbf', 'important');
    setTimeout(() => el.style.removeProperty('background-color'), 6000);
}

// Auswahl, wenn der Titel nicht eindeutig trifft.
function journalAuswahlZeigen(posten, felder, vorher, knopf, melde, ueberschrift) {
    knopf.disabled = false;
    const kasten = createEl('div', 'dora-journal-auswahl');
    kasten.style.cssText = 'margin-top:6px; border:1px solid #cbd5e0; border-radius:4px; '
        + 'background:#fff; max-height:190px; overflow-y:auto; font-size:12px;';

    posten.slice(0, 25).forEach(li => {
        const zeile = createEl('div', '', journalPostenText(li));
        zeile.style.cssText = 'padding:6px 9px; cursor:pointer; border-bottom:1px solid #edf2f7;';
        zeile.addEventListener('mouseenter', () => zeile.style.background = '#ebf8ff');
        zeile.addEventListener('mouseleave', () => zeile.style.background = '#fff');
        zeile.addEventListener('click', () => {
            knopf.disabled = true;
            melde('Übernehme «' + journalPostenText(li) + '» …', 'laeuft');
            journalVorschlagWaehlen(li, felder.title, window);
            setTimeout(() => {
                const nachher = journalStand(felder);
                const geaendert = JOURNAL_FELDER.filter(x => felder[x.schluessel]
                    && vorher[x.schluessel] !== nachher[x.schluessel]);
                knopf.disabled = false;
                if (!geaendert.length) { melde('Journal war bereits aktuell – nichts geändert.', 'gleich'); return; }
                geaendert.forEach(x => journalFeldHervorheben(felder[x.schluessel]));
                melde(journalDiffText(geaendert, vorher, nachher), 'geaendert',
                    () => journalZuruecknehmen(felder, vorher, melde));
            }, 700);
        });
        kasten.appendChild(zeile);
    });

    melde(ueberschrift, 'auswahl', null, kasten);
}

// --- Knopf und Meldezeile am Formular --------------------------------------
function injectJournalReloadButton() {
    const felder = journalFelder(document);
    if (!felder.title) return;

    const huelle = felder.title.closest('.form-item') || felder.title.parentNode;
    if (!huelle || huelle.querySelector('.dora-journal-knopf')) return;

    // Nur bei echten Journalfeldern anbieten: bei Tagungsbaenden traegt
    // dasselbe Eingabefeld den Proceedings-Titel, dort gibt es kein MADS-Objekt.
    if (!feldIstJournalname(felder.title)) return;

    const leiste = createEl('div', 'dora-journal-leiste');
    leiste.style.cssText = 'margin-top:5px;';

    const knopf = createEl('button', 'dora-journal-knopf', '⟳ Journal neu abfragen');
    knopf.type = 'button';
    knopf.title = 'Fragt die Journalangaben über die Autovervollständigung des '
        + 'Formulars neu ab (Titel, Abkürzung, Publisher, ISSN, E-ISSN, PID)';
    knopf.style.cssText = 'padding:4px 9px; font-size:12px; font-weight:600; cursor:pointer; '
        + 'background:#f8fafc; color:#475569; border:1px solid #cbd5e0; border-radius:4px;';

    const meldung = createEl('div', 'dora-journal-meldung');
    meldung.style.cssText = 'display:none; margin-top:5px; padding:6px 9px; border-radius:4px; '
        + 'font-size:12px; line-height:1.45; white-space:pre-line;';

    const melde = (text, art, zuruecknehmen, anhang) => {
        meldung.replaceChildren();
        meldung.style.display = 'block';
        const farben = {
            laeuft: ['#edf2f7', '#2d3748', '#cbd5e0'],
            fehler: ['#fff5f5', '#9b2c2c', '#fc8181'],
            gleich: ['#f0fff4', '#276749', '#9ae6b4'],
            geaendert: ['#fffaf0', '#975a16', '#f6ad55'],
            auswahl: ['#ebf8ff', '#2a4365', '#90cdf4']
        }[art] || ['#edf2f7', '#2d3748', '#cbd5e0'];
        meldung.style.background = farben[0];
        meldung.style.color = farben[1];
        meldung.style.border = '1px solid ' + farben[2];

        meldung.appendChild(document.createTextNode(text));

        if (zuruecknehmen) {
            const rueck = createEl('span', '', '↩ Rückgängig');
            rueck.style.cssText = 'display:inline-block; margin-top:5px; cursor:pointer; '
                + 'text-decoration:underline; font-weight:600;';
            rueck.addEventListener('click', zuruecknehmen);
            meldung.appendChild(createEl('br'));
            meldung.appendChild(rueck);
        }
        if (anhang) meldung.appendChild(anhang);
    };

    knopf.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        journalNeuAbfragen(knopf, melde).catch(err => {
            console.error('DORA Helper: Journalabfrage abgebrochen.', err);
            melde('Abfrage fehlgeschlagen: ' + err.message, 'fehler');
            knopf.disabled = false;
        });
    });

    leiste.appendChild(knopf);
    leiste.appendChild(meldung);
    huelle.appendChild(leiste);
}

// --- Stapellauf fuer die Batch-QC ------------------------------------------
// Bewusst zweistufig. Erst wird nur geprueft - jeder Datensatz wird in einem
// verborgenen iframe geoeffnet, nachgeschlagen und wieder verworfen, ohne zu
// speichern. Erst danach entscheidet der Mensch, welche der gefundenen
// Aenderungen wirklich geschrieben werden. Ein Massenschreibzugriff auf echte
// Datensaetze soll nicht an einem einzigen Klick haengen.
//
// Der Lauf ist absichtlich seriell: der Server bekommt nicht 50 Formulare auf
// einmal, und der Fortschritt bleibt nachvollziehbar.
// Die Masse des Batch-QC-Knopfes inline mit "important" setzen.
//
// Ueber das Stylesheet ging es nicht: Regeln aus einem Content-Script werden
// VOR die Stylesheets der Seite gehaengt, und eine Theme-Regel wie
// "#content button { padding: 0 }" hat ohnehin die hoehere Spezifitaet als
// unsere Klasse. Dann faellt die Klickflaeche auf die Textbreite zusammen -
// und der Knopf reagiert nur noch ueber der Schrift. Inline mit "important"
// schlaegt jede Regel der Seite.
function setzeKnopfMasse(knopf) {
    const masse = {
        'display': 'inline-flex',
        'align-items': 'center',
        'justify-content': 'center',
        'box-sizing': 'border-box',
        'width': 'auto',
        'min-height': '38px',
        'padding': '8px 18px',
        'margin': '0',
        'line-height': '1.2',
        'background-image': 'none',
        // cursor bewusst NICHT hier: der gesperrte Zustand braucht
        // 'not-allowed', und inline mit important waere das nicht mehr
        // zu ueberschreiben. Das regelt styles.css je Zustand.
        'pointer-events': 'auto',
        'position': 'relative',
        'z-index': '1'
    };
    Object.keys(masse).forEach(eigenschaft => {
        knopf.style.setProperty(eigenschaft, masse[eigenschaft], 'important');
    });
}

// Nachsehen, ob die Klickflaeche wirklich der sichtbaren Flaeche entspricht.
// Weicht sie ab, liegt etwas darueber oder eine Regel hat doch gewonnen -
// dann steht es in der Konsole, statt dass man raten muss.
function pruefeKnopfFlaeche(knopf) {
    try {
        const kasten = knopf.getBoundingClientRect();
        if (!kasten.width || !kasten.height) return;
        const x = Math.round(kasten.left + kasten.width - 6);
        const y = Math.round(kasten.top + kasten.height / 2);
        const getroffen = document.elementFromPoint(x, y);
        if (getroffen && (getroffen === knopf || knopf.contains(getroffen))) return;
        console.warn('DORA Helper: Am Rand des Batch-QC-Knopfes liegt etwas anderes.',
            {
                knopf: Math.round(kasten.width) + '×' + Math.round(kasten.height),
                getroffen: getroffen ? (getroffen.tagName + '.' + getroffen.className) : '(nichts)',
                polsterung: window.getComputedStyle(knopf).padding,
                anzeige: window.getComputedStyle(knopf).display
            });
    } catch (e) { /* Diagnose darf nie stoeren */ }
}

// --- STILLE RAHMEN ---------------------------------------------------------
// Der Stapellauf oeffnet jeden Datensatz in einem verborgenen iframe. Weil
// das Content-Script mit "all_frames": true laeuft, startet es DORT NOCH
// EINMAL komplett: es holt die DOI, baut eine Ergebnisbox und kann ueber
// openPopupWindow sogar ein echtes Browserfenster aufziehen. Bei zwanzig
// Datensaetzen zwanzig Mal - das war der Grund fuer die uebereinander
// liegenden, grau bleibenden Fenster.
//
// Der Rahmen bekommt darum einen Namen, den seine eigene Instanz erkennt und
// daraufhin gar nichts tut. Gesteuert wird das Formular ohnehin von aussen.
const DORA_STILLER_RAHMEN = 'dora-journal-still';

function istStillerRahmen() {
    try {
        return window.name === DORA_STILLER_RAHMEN;
    } catch (e) {
        return false;
    }
}

// --- AUTORENZEILEN IN DER BATCH-QC KOMPAKT HALTEN --------------------------
// Die Zeilen tragen je nach DORA-Stand eine Tabelle, ein Raster oder Flexbox.
// Auf Klassennamen ist darum kein Verlass - wohl aber auf die Eingabefelder
// selbst. Gesucht wird der naechste gemeinsame Vorfahr von mindestens drei
// davon: das ist die Zeile eines Autors. Sie bekommt eine eigene Marke, und
// die Kompaktregeln greifen nur noch darin.
const AUTOR_FELDER = ['[valName]', '[family]', '[given]', '[affiliation]',
    '[section_name]', '[department_name]', '[division_name]'];

function autorFeldAnzahl(el) {
    if (!el || !el.querySelectorAll) return 0;
    let n = 0;
    AUTOR_FELDER.forEach(endung => {
        n += el.querySelectorAll('input[name$="' + endung + '"]').length;
    });
    return n;
}

function markiereAutorenzeilen(doc) {
    if (!doc) return 0;

    const anker = [];
    AUTOR_FELDER.forEach(endung => {
        doc.querySelectorAll('input[name$="' + endung + '"]').forEach(el => anker.push(el));
    });
    if (!anker.length) return 0;

    const zeilen = new Set();
    anker.forEach(feld => {
        // Hochsteigen, bis der Vorfahr die Felder eines ganzen Autors
        // umschliesst - aber nicht so weit, dass er mehrere Autoren fasst.
        let knoten = feld.parentElement;
        let zeile = null;
        let felderDerZeile = 0;
        for (let tiefe = 0; knoten && tiefe < 8; tiefe++) {
            const anzahl = autorFeldAnzahl(knoten);
            if (anzahl >= 3) { zeile = knoten; felderDerZeile = anzahl; break; }
            knoten = knoten.parentElement;
        }
        if (!zeile) return;

        // Weiter hoch, solange kein WEITERER Autor dazukommt: so landet die
        // Marke auf der ganzen Zeile (mitsamt Knopfleiste) statt auf einem
        // <tbody> tief darin - sonst bleibt deren Polsterung stehen.
        for (let tiefe = 0; tiefe < 6; tiefe++) {
            const eltern = zeile.parentElement;
            if (!eltern || eltern === doc.body) break;
            if (autorFeldAnzahl(eltern) !== felderDerZeile) break;
            zeile = eltern;
        }
        zeilen.add(zeile);
    });

    // Wenn ein gefundener Knoten einen anderen gefundenen enthaelt, ist er zu
    // weit oben (er fasst mehrere Autoren) - den lassen wir weg.
    const endgueltig = Array.from(zeilen).filter(a =>
        !Array.from(zeilen).some(b => b !== a && a.contains(b)));

    endgueltig.forEach(zeile => zeile.classList.add('dora-autorenzeile'));
    return endgueltig.length;
}

function journalFormularUrl(pid, instPfad) {
    return '/' + instPfad + '/islandora/object/' + encodeURIComponent(pid) + '/lib4ridora_edit_mods';
}

// Warten, bis das Formular im Rahmen wirklich steht.
//
// Beim Ladeereignis ist ein Drupal-Formular serverseitig schon fertig - kurz
// nachgefasst wird nur fuer Teile, die per AJAX nachkommen. Darum ein kleines
// Budget: es kostet im Normalfall nichts, weil das Journalfeld meist sofort
// da ist, und laesst einen Datensatz ohne Journalfeld nicht minutenlang
// haengen.
function journalAufFormularWarten(rahmen, grenze) {
    const bis = Date.now() + (grenze || 2500);
    return new Promise((fertig) => {
        const schauen = () => {
            let doc = null;
            try { doc = rahmen.contentDocument; } catch (e) { /* gleich behandelt */ }
            if (!doc) { fertig({ doc: null, grund: 'nicht lesbar' }); return; }

            if (doc.querySelector('input[name="host[titleInfo][title]"]')) {
                fertig({ doc: doc, grund: 'journal' }); return;
            }
            if (Date.now() > bis) {
                const formular = doc.getElementById('islandora-xml-form-builder-form')
                    || doc.getElementById('islandora-ingest-form')
                    || doc.querySelector('form.node-form');
                fertig({ doc: doc, grund: formular ? 'formular-ohne-journal' : 'kein-formular' });
                return;
            }
            setTimeout(schauen, 150);
        };
        schauen();
    });
}

// Beschreiben, was im Rahmen statt des Journalfeldes steht - sonst heisst es
// nur "kein Journalfeld" und man weiss nicht, ob es am Datensatz oder am
// Laden lag.
function journalLageBeschreiben(doc) {
    if (!doc) return 'Formular nicht lesbar';
    const titel = (doc.title || '').replace(/\s+/g, ' ').trim();
    if (/zugriff|access denied|anmelden|log in/i.test(titel)) {
        return 'Keine Berechtigung oder nicht angemeldet (Seite: ' + titel + ')';
    }
    const art = doc.getElementById('edit-publication-type');
    const artText = art ? (art.value || '') : '';
    if (artText) return 'Formular geladen, aber kein Journalfeld (Publication Type: ' + artText + ')';
    const formular = doc.getElementById('islandora-xml-form-builder-form')
        || doc.getElementById('islandora-ingest-form');
    if (!formular) return 'Kein Bearbeitungsformular auf der Seite (Seite: ' + (titel || '?') + ')';
    return 'Formular geladen, aber kein Journalfeld darin';
}

// Alles vom Stapellauf wegraeumen: das Fenster und jeden verborgenen Rahmen.
//
// Ein Rahmen ist eine voll gerenderte Drupal-Seite mit eigenem JS. Bleiben
// mehrere davon liegen - etwa weil die Batch-QC geschlossen wurde, waehrend
// ein Lauf noch lief - kostet das nicht nur Speicher, es bringt auch die
// Darstellung durcheinander.
function journalStapelAufraeumen() {
    document.querySelectorAll('iframe.dora-journal-rahmen').forEach(r => {
        try { r.src = 'about:blank'; } catch (e) { /* egal */ }
        try { r.remove(); } catch (e) { /* egal */ }
    });
    const fenster = document.getElementById('dora-journal-stapel');
    if (fenster) fenster.remove();
}

// Beim Verlassen der Seite sicher aufraeumen - ein haengender Rahmen haelt
// sonst eine ganze Seite am Leben.
window.addEventListener('pagehide', journalStapelAufraeumen);

// Einen Datensatz in einem verborgenen iframe oeffnen und dort etwas tun.
function journalImRahmen(pid, instPfad, arbeit, zeitlimit) {
    return new Promise((fertig) => {
        const rahmen = document.createElement('iframe');
        rahmen.className = 'dora-journal-rahmen';
        // Absolut statt fixiert: position:fixed zwingt den Browser zu einer
        // eigenen Zeichenebene, und das fuer ein Dokument, das nie zu sehen
        // ist. Klicks und Tabulator gehen ebenfalls daran vorbei.
        rahmen.style.cssText = 'position:absolute; left:-10000px; top:0; width:1100px; '
            + 'height:760px; border:0; visibility:hidden; pointer-events:none;';
        rahmen.setAttribute('aria-hidden', 'true');
        rahmen.setAttribute('tabindex', '-1');
        // VOR dem Setzen der Adresse: nur dann kennt die Instanz des
        // Content-Scripts im Rahmen ihren Namen schon beim Start.
        rahmen.name = DORA_STILLER_RAHMEN;
        let erledigt = false;

        const schliessen = (ergebnis) => {
            if (erledigt) return;
            erledigt = true;
            clearTimeout(wecker);
            if (ergebnis && ergebnis.behalten) {
                // Offen lassen: beim Speichern spart das ein komplettes
                // Neuladen samt zweiter Abfrage.
                ergebnis.rahmen = rahmen;
            } else {
                // Erst entladen, dann entfernen: sonst laeuft das Skript der
                // Seite im Rahmen unter Umstaenden noch weiter.
                try { rahmen.src = 'about:blank'; } catch (e) { /* egal */ }
                try { rahmen.remove(); } catch (e) { /* egal */ }
            }
            fertig(ergebnis);
        };

        const wecker = setTimeout(
            () => schliessen({ pid: pid, art: 'fehler', text: 'Zeitüberschreitung beim Laden' }),
            zeitlimit || 60000);

        rahmen.addEventListener('load', async () => {
            if (erledigt) return;

            // Das leere Startdokument meldet ebenfalls "load". Faellt der Lauf
            // darauf herein, sieht jeder Datensatz aus wie ein leeres Formular.
            let adresse = '';
            try { adresse = rahmen.contentWindow.location.href; } catch (e) { /* egal */ }
            if (!adresse || adresse === 'about:blank') return;

            const lage = await journalAufFormularWarten(rahmen);
            if (erledigt) return;

            if (lage.grund !== 'journal') {
                schliessen({
                    pid: pid,
                    art: lage.grund === 'nicht lesbar' ? 'fehler' : 'keinjournal',
                    text: journalLageBeschreiben(lage.doc)
                });
                return;
            }

            try {
                const erg = await arbeit(rahmen);
                schliessen(Object.assign({ pid: pid }, erg));
            } catch (err) {
                schliessen({ pid: pid, art: 'fehler', text: String(err && err.message || err) });
            }
        });

        // Erst die Adresse, dann einhaengen - so entsteht gar kein Ladeereignis
        // fuer das leere Startdokument.
        rahmen.src = journalFormularUrl(pid, instPfad);
        document.body.appendChild(rahmen);
    });
}

// Wie viele gepruefte Formulare offen bleiben duerfen.
//
// Zwanzig, weil die Trefferliste genau so viele Publikationen zeigt: mehr
// kann in einem Lauf gar nicht ausgewaehlt sein, und so landet kein
// Datensatz auf dem langsamen Weg (neu laden plus zweite Abfrage).
// Jedes offene Formular ist eine gerenderte Seite - wird der Browser bei
// zwanzig gleichzeitig geaenderten Datensaetzen zaeh, ist diese Zahl die
// einzige Stellschraube.
const JOURNAL_PARKPLAETZE = 20;

// Stufe 1: nachschlagen, nichts speichern.
//
// Datensaetze mit einer Aenderung bleiben offen stehen (bis zur Obergrenze).
// Beim Speichern ist dann nur noch ein Klick noetig statt Neuladen plus
// zweiter Abfrage - das halbiert die Wartezeit des ganzen Laufs.
async function journalStapelPruefen(pids, instPfad, fortschritt, abbruch) {
    const ergebnisse = [];
    let geparkt = 0;

    for (let i = 0; i < pids.length; i++) {
        if (abbruch && abbruch.abgebrochen) break;
        const pid = pids[i];
        fortschritt(i, pids.length, pid, null);

        const erg = await journalImRahmen(pid, instPfad, async (rahmen) => {
            const abfrage = await journalAbfrageAusfuehren(rahmen.contentWindow);
            if (abfrage.art === 'aenderung' && geparkt < JOURNAL_PARKPLAETZE) {
                abfrage.behalten = true;
                geparkt += 1;
            }
            return abfrage;
        });

        // Verweise auf Elemente im Rahmen nicht in der Liste festhalten -
        // ausser dem Rahmen selbst, den brauchen wir noch.
        delete erg.felder; delete erg.posten;
        ergebnisse.push(erg);
        fortschritt(i + 1, pids.length, pid, erg);
    }
    return ergebnisse;
}

// In einem offenen Formular speichern und die Navigation abwarten.
// In einem offenen Formular speichern.
//
// Nicht auf das "load" der Zielseite warten: das faellt erst, wenn auch noch
// jedes Bild und Skript der Objektansicht geladen ist - reine Wartezeit,
// nachdem laengst gespeichert wurde. Es genuegt, dass ein NEUES Dokument da
// ist; danach wird der Rahmen sofort leer geschaltet.
//
// Und wichtiger: "load" allein ist kein Beleg fuers Speichern. Lehnt Drupal
// das Formular ab, liefert es dasselbe Formular mit Fehlermeldungen erneut
// aus - das feuert ebenfalls "load".
//
// Woran es NICHT zu erkennen ist: daran, dass wieder ein Formular da steht.
// DORA fuehrt nach dem Speichern zur Bearbeitung zurueck, das Formular ist
// also auch im Erfolgsfall wieder da. Das verlaessliche Zeichen ist Drupals
// eigene Fehlermeldung.
function journalSpeichern(rahmen, grenze) {
    const vorher = rahmen.contentDocument;
    const knopf = vorher && (vorher.getElementById('edit-submit')
        || vorher.querySelector('input[type="submit"][value="Save"]')
        || vorher.querySelector('input[type="submit"][value="Speichern"]'));
    if (!knopf) return Promise.resolve({ art: 'fehler', text: 'Speichern-Knopf nicht gefunden' });

    return new Promise((fertig) => {
        const bis = Date.now() + (grenze || 90000);

        const schauen = () => {
            let jetzt = null;
            try { jetzt = rahmen.contentDocument; } catch (e) { /* mitten in der Navigation */ }

            // Erst reagieren, wenn die Antwort wirklich ein anderes Dokument ist
            if (jetzt && jetzt !== vorher && jetzt.readyState !== 'loading') {
                const meldung = jetzt.querySelector(
                    '.messages.error, .messages--error, .error.messages, div.error');

                if (meldung) {
                    const text = String(meldung.textContent || '')
                        .replace(/\s+/g, ' ').trim().slice(0, 200);
                    fertig({ art: 'fehler', text: 'Nicht gespeichert – ' + text });
                    return;
                }

                // Gespeichert. Den Rest der Zielseite gar nicht erst laden.
                try { rahmen.src = 'about:blank'; } catch (e) { /* egal */ }
                fertig({ art: 'gespeichert', text: '' });
                return;
            }

            if (Date.now() > bis) { fertig({ art: 'fehler', text: 'Speichern hat nicht geantwortet' }); return; }
            setTimeout(schauen, 120);
        };

        knopf.click();
        setTimeout(schauen, 120);
    });
}

// Stufe 2: speichern.
//
// Steht das Formular noch offen, wird nur gespeichert. Nur fuer Datensaetze
// ohne Parkplatz wird neu geladen - und dann nochmal nachgeschlagen, weil
// der alte Stand nicht mehr im Formular steht.
async function journalStapelSchreiben(eintraege, instPfad, fortschritt, abbruch) {
    const ergebnisse = [];

    for (let i = 0; i < eintraege.length; i++) {
        if (abbruch && abbruch.abgebrochen) break;
        const eintrag = eintraege[i];
        const pid = eintrag.pid;
        fortschritt(i, eintraege.length, pid, null);

        let erg;
        const rahmen = eintrag.rahmen;
        const nochDa = rahmen && rahmen.isConnected && rahmen.contentDocument
            && rahmen.contentDocument.querySelector('input[name="host[titleInfo][title]"]');

        if (nochDa) {
            const gespeichert = await journalSpeichern(rahmen);
            erg = {
                pid: pid,
                art: gespeichert.art,
                text: gespeichert.art === 'gespeichert' ? eintrag.text : gespeichert.text
            };
            try { rahmen.src = 'about:blank'; } catch (e) { /* egal */ }
            try { rahmen.remove(); } catch (e) { /* egal */ }
        } else {
            // Kein Parkplatz mehr gehabt: neu laden und nochmal nachschlagen.
            erg = await journalImRahmen(pid, instPfad, async (r) => {
                const abfrage = await journalAbfrageAusfuehren(r.contentWindow);
                if (abfrage.art !== 'aenderung') {
                    return { art: abfrage.art, text: abfrage.text };
                }
                const gespeichert = await journalSpeichern(r);
                return {
                    art: gespeichert.art,
                    text: gespeichert.art === 'gespeichert' ? abfrage.text : gespeichert.text
                };
            }, 90000);
        }

        ergebnisse.push(erg);
        fortschritt(i + 1, eintraege.length, pid, erg);
    }

    // Was nicht mehr drankam (Abbruch), nicht offen stehen lassen
    journalParkplaetzeRaeumen();
    return ergebnisse;
}

function journalParkplaetzeRaeumen() {
    document.querySelectorAll('iframe.dora-journal-rahmen').forEach(r => {
        try { r.src = 'about:blank'; } catch (e) { /* egal */ }
        try { r.remove(); } catch (e) { /* egal */ }
    });
}

// --- Fenster fuer den Stapellauf -------------------------------------------
const JOURNAL_ARTEN = {
    aenderung: { zeichen: '✱', farbe: '#975a16', hintergrund: '#fffaf0', wort: 'Änderung' },
    gespeichert: { zeichen: '✓', farbe: '#276749', hintergrund: '#f0fff4', wort: 'gespeichert' },
    aktuell: { zeichen: '=', farbe: '#4a5568', hintergrund: '#f7fafc', wort: 'aktuell' },
    mehrdeutig: { zeichen: '?', farbe: '#2a4365', hintergrund: '#ebf8ff', wort: 'mehrdeutig' },
    keintreffer: { zeichen: '–', farbe: '#9b2c2c', hintergrund: '#fff5f5', wort: 'kein Treffer' },
    keinjournal: { zeichen: '·', farbe: '#718096', hintergrund: '#f7fafc', wort: 'kein Journal' },
    fehler: { zeichen: '!', farbe: '#9b2c2c', hintergrund: '#fff5f5', wort: 'Fehler' }
};

function journalStapelFenster(pids, instPfad) {
    if (document.getElementById('dora-journal-stapel')) return;

    const schirm = createEl('div');
    schirm.id = 'dora-journal-stapel';
    schirm.style.cssText = 'position:fixed; inset:0; z-index:2147483000; background:rgba(15,23,42,.55); '
        + 'display:flex; align-items:center; justify-content:center; font-family:"Segoe UI",sans-serif;';

    const kasten = createEl('div');
    kasten.style.cssText = 'background:#fff; width:min(760px,92vw); max-height:86vh; border-radius:10px; '
        + 'display:flex; flex-direction:column; box-shadow:0 20px 50px rgba(0,0,0,.35); overflow:hidden;';

    const kopf = createEl('div');
    kopf.style.cssText = 'padding:14px 18px; border-bottom:1px solid #e2e8f0; display:flex; '
        + 'justify-content:space-between; align-items:center; background:#f8fafc;';
    const titel = createEl('div', '', '⟳ Journal für ' + pids.length + ' Datensätze prüfen');
    titel.style.cssText = 'font-weight:700; color:#1a202c;';
    const zu = createEl('span', '', '✕');
    zu.style.cssText = 'cursor:pointer; font-size:18px; color:#718096; padding:0 6px;';
    kopf.appendChild(titel);
    kopf.appendChild(zu);

    const hinweis = createEl('div');
    hinweis.style.cssText = 'padding:10px 18px; font-size:12px; color:#4a5568; background:#fffaf0; '
        + 'border-bottom:1px solid #f6e05e; line-height:1.5;';
    hinweis.textContent = 'Erst wird nur geprüft: jeder Datensatz wird kurz im Hintergrund geöffnet, '
        + 'das Journal über die Autovervollständigung des Formulars nachgeschlagen und wieder '
        + 'verworfen. Gespeichert wird nichts, bevor Sie es unten ausdrücklich auslösen.';

    const balkenHuelle = createEl('div');
    balkenHuelle.style.cssText = 'height:4px; background:#e2e8f0;';
    const balken = createEl('div');
    balken.style.cssText = 'height:100%; width:0%; background:#3182ce; transition:width .2s;';
    balkenHuelle.appendChild(balken);

    const stand = createEl('div');
    stand.style.cssText = 'padding:8px 18px; font-size:12px; color:#4a5568; border-bottom:1px solid #edf2f7;';
    stand.textContent = 'Bereit.';

    const liste = createEl('div');
    liste.style.cssText = 'flex:1; overflow-y:auto; padding:4px 0; font-size:12px;';

    const fuss = createEl('div');
    fuss.style.cssText = 'padding:12px 18px; border-top:1px solid #e2e8f0; display:flex; gap:8px; '
        + 'align-items:center; background:#f8fafc;';

    const knopfStil = (farbe) => 'padding:8px 16px; border:none; border-radius:6px; cursor:pointer; '
        + 'font-weight:600; font-size:13px; color:#fff; background:' + farbe + ';';

    const starten = createEl('button', '', 'Prüfung starten');
    starten.type = 'button';
    starten.style.cssText = knopfStil('#3182ce');

    const abbrechen = createEl('button', '', 'Abbrechen');
    abbrechen.type = 'button';
    abbrechen.style.cssText = knopfStil('#a0aec0');
    abbrechen.style.display = 'none';

    const schreiben = createEl('button', '', 'Ausgewählte speichern');
    schreiben.type = 'button';
    schreiben.style.cssText = knopfStil('#dd6b20');
    schreiben.style.display = 'none';

    const zusammen = createEl('div');
    zusammen.style.cssText = 'margin-left:auto; font-size:12px; color:#4a5568; text-align:right;';

    fuss.appendChild(starten);
    fuss.appendChild(abbrechen);
    fuss.appendChild(schreiben);
    fuss.appendChild(zusammen);

    kasten.appendChild(kopf);
    kasten.appendChild(hinweis);
    kasten.appendChild(balkenHuelle);
    kasten.appendChild(stand);
    kasten.appendChild(liste);
    kasten.appendChild(fuss);
    schirm.appendChild(kasten);
    document.body.appendChild(schirm);

    const abbruch = { abgebrochen: false };
    let ergebnisse = [];
    const haken = {};   // pid -> checkbox

    const schliessen = () => {
        abbruch.abgebrochen = true;
        journalStapelAufraeumen();
    };
    zu.addEventListener('click', schliessen);

    function zeileZeichen(erg, mitHaken) {
        const art = JOURNAL_ARTEN[erg.art] || JOURNAL_ARTEN.fehler;
        const zeile = createEl('div');
        zeile.style.cssText = 'display:flex; gap:9px; padding:7px 18px; border-bottom:1px solid #f7fafc; '
            + 'align-items:flex-start; background:' + art.hintergrund + ';';

        if (mitHaken) {
            const h = document.createElement('input');
            h.type = 'checkbox';
            h.checked = true;
            h.style.marginTop = '2px';
            haken[erg.pid] = h;
            zeile.appendChild(h);
        } else {
            const z = createEl('span', '', art.zeichen);
            z.style.cssText = 'width:13px; font-weight:700; color:' + art.farbe + ';';
            zeile.appendChild(z);
        }

        const rechts = createEl('div');
        rechts.style.cssText = 'min-width:0; flex:1;';
        const kopfzeile = createEl('div');
        kopfzeile.style.cssText = 'font-weight:600; color:#2d3748;';
        kopfzeile.textContent = erg.pid + ' · ' + art.wort;
        rechts.appendChild(kopfzeile);

        if (erg.text) {
            const detail = createEl('div', '', erg.text);
            detail.style.cssText = 'color:' + art.farbe + '; white-space:pre-line; margin-top:2px;';
            rechts.appendChild(detail);
        }
        if (erg.kandidaten && erg.kandidaten.length) {
            const k = createEl('div', '', 'Gefunden: ' + erg.kandidaten.slice(0, 5).join(' · ')
                + (erg.kandidaten.length > 5 ? ' …' : ''));
            k.style.cssText = 'color:#4a5568; margin-top:2px; font-style:italic;';
            rechts.appendChild(k);
        }

        zeile.appendChild(rechts);
        liste.appendChild(zeile);
    }

    function zaehlen(liste2) {
        const n = {};
        liste2.forEach(e => { n[e.art] = (n[e.art] || 0) + 1; });
        return Object.keys(n)
            .map(a => (JOURNAL_ARTEN[a] || JOURNAL_ARTEN.fehler).wort + ': ' + n[a])
            .join(' · ');
    }

    const fortschritt = (fertig, gesamt, pid, erg) => {
        balken.style.width = Math.round(fertig / gesamt * 100) + '%';
        stand.textContent = erg
            ? fertig + ' von ' + gesamt + ' geprüft'
            : fertig + 1 + ' von ' + gesamt + ': ' + pid + ' …';
    };

    starten.addEventListener('click', async () => {
        starten.style.display = 'none';
        abbrechen.style.display = '';
        liste.replaceChildren();
        abbruch.abgebrochen = false;
        // Ein zweiter Durchgang faengt bei null an: was vom ersten noch
        // offen steht, wird nicht mehr gebraucht.
        journalParkplaetzeRaeumen();

        ergebnisse = await journalStapelPruefen(pids, instPfad, (f, g, pid, erg) => {
            fortschritt(f, g, pid, erg);
            if (erg) zeileZeichen(erg, false);
        }, abbruch);

        abbrechen.style.display = 'none';
        const zuSchreiben = ergebnisse.filter(e => e.art === 'aenderung');
        zusammen.textContent = zaehlen(ergebnisse);
        stand.textContent = abbruch.abgebrochen
            ? 'Abgebrochen nach ' + ergebnisse.length + ' von ' + pids.length + '.'
            : 'Prüfung fertig.';

        if (!zuSchreiben.length) {
            starten.style.display = '';
            starten.textContent = 'Nochmal prüfen';
            return;
        }

        // Nur die Aenderungen erneut zeigen - diesmal zum Ankreuzen.
        liste.replaceChildren();
        const ueber = createEl('div', '', zuSchreiben.length
            + ' Datensätze würden geändert. Abwählen, was nicht geschrieben werden soll:');
        ueber.style.cssText = 'padding:9px 18px; font-weight:600; color:#975a16; background:#fffaf0;';
        liste.appendChild(ueber);
        zuSchreiben.forEach(e => zeileZeichen(e, true));

        schreiben.style.display = '';
        schreiben.textContent = 'Ausgewählte speichern (' + zuSchreiben.length + ')';
    });

    abbrechen.addEventListener('click', () => {
        abbruch.abgebrochen = true;
        abbrechen.textContent = 'Breche ab …';
    });

    schreiben.addEventListener('click', async () => {
        // Die ganzen Ergebnisse weiterreichen: darin steckt der offene
        // Rahmen, in dem nur noch gespeichert werden muss.
        const gewaehlt = ergebnisse
            .filter(e => e.art === 'aenderung' && haken[e.pid] && haken[e.pid].checked);
        if (!gewaehlt.length) { stand.textContent = 'Nichts ausgewählt.'; return; }

        schreiben.style.display = 'none';
        abbrechen.style.display = '';
        abbrechen.textContent = 'Abbrechen';
        liste.replaceChildren();
        hinweis.textContent = 'Es wird jetzt geschrieben. Die geprüften Formulare stehen '
            + 'noch offen – dort ist nur noch ein Klick nötig.';
        abbruch.abgebrochen = false;

        const geschrieben = await journalStapelSchreiben(gewaehlt, instPfad, (f, g, pid, erg) => {
            balken.style.width = Math.round(f / g * 100) + '%';
            stand.textContent = erg ? f + ' von ' + g + ' gespeichert' : (f + 1) + ' von ' + g + ': ' + pid + ' …';
            if (erg) zeileZeichen(erg, false);
        }, abbruch);

        abbrechen.style.display = 'none';
        starten.style.display = '';
        starten.textContent = 'Nochmal prüfen';
        zusammen.textContent = zaehlen(geschrieben);
        stand.textContent = abbruch.abgebrochen ? 'Abgebrochen.' : 'Fertig.';
    });
}

// --- HANDBUCH (WIKI) ------------------------------------------------------
// Die Hausregeln stehen im DORA-Handbuch (Confluence). Sie liegen hier als
// statischer, nach Formularfeldern geordneter Auszug (handbuch.json, erzeugt
// von scripts/handbuch/erzeuge_handbuch.js aus dem Wiki-Export des Projekts
// DORA-MCP-Checker).
//
// Warum als Auszug und nicht per Abfrage: Die Wissensbasis dort ist eine
// Chroma-SQLite mit lokalem Einbettungsmodell - eine Erweiterung kann weder
// SQLite lesen noch Vektoren rechnen, und es soll kein lokaler Dienst laufen
// muessen. So ist die Pruefung offline, ohne Kosten und ohne Infrastruktur;
// derselbe Auszug ist spaeter der Kontext fuer eine LLM-Beurteilung.
// ---------------------------------------------------------------------------

let handbuchDaten = null;
let handbuchLaedt = null;

// Beschriftungen der Validierung -> Themen im Handbuch-Auszug
const HANDBUCH_FELD_ALIASE = {
    'Start Page': 'Pages',
    'End Page': 'Pages',
    'Pages': 'Pages',
    'Article Title': 'Article Title',
    'Title': 'Title',
    'Conference Name': 'Conference Name',
    'Proceedings Title': 'Proceedings Title',
    'Journal Title': 'Journal Title',
    'Series Title': 'Series Title',
    'Book Title': 'Book Title',
    'Keywords': 'Keywords',
    'Abstract': 'Abstract',
    'Authors': 'Authors',
    'Author': 'Authors',
    'Editors': 'Editors',
    'Publisher': 'Publisher',
    'Publication Status': 'Publication Status',
    'Publication Type': 'Publication Type',
    'Volume': 'Volume',
    'Issue': 'Issue',
    'Language': 'Language',
    'Funding': 'Funding',
    'Quality Control': 'Quality Control',
    'Quality Control ID': 'Quality Control',
    'DOI': 'Identifiers',
    'ISBN': 'Identifiers',
    'ISSN': 'Identifiers',
    'Affiliation': 'Affiliation',
    'Document Availability': 'Document Availability',
    'Conditions of Reuse': 'Conditions of Reuse'
};

// Handbuch direkt am Feld: neben jeder bekannten Beschriftung sitzt ein
// kleines 📖. Das ist der Weg, der unabhaengig von Fehlern funktioniert -
// vorher hing das Handbuch nur unter Fehlermeldungen und war damit auf
// sauberen Datensaetzen unsichtbar.
function injectHandbuchButtons() {
    if (!isEditPage || typeof isEditPage !== 'function' || !isEditPage()) return;

    ladeHandbuch((daten) => {
        if (!daten || !daten.felder) return;

        document.querySelectorAll('label[for]').forEach(label => {
            if (label.dataset.doraHandbuch) return;

            const text = (label.innerText || label.textContent || '').trim();
            if (!text) return;

            const feld = handbuchFeldZuBeschriftung(text, daten);
            if (!feld) return;

            label.dataset.doraHandbuch = feld;
            label.appendChild(handbuchKnopf(label, feld, daten));
        });
    });
}

// Beschriftung im Formular -> Feld im Handbuch-Auszug. Erst die Aliase,
// dann der laengste passende Feldname (damit "Journal Title" nicht an
// "Title" haengen bleibt).
function handbuchFeldZuBeschriftung(beschriftung, daten) {
    const roh = beschriftung.replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim();
    const klein = roh.toLowerCase();

    const direkt = Object.keys(HANDBUCH_FELD_ALIASE)
        .filter(k => klein === k.toLowerCase())
        .map(k => HANDBUCH_FELD_ALIASE[k])[0];
    if (direkt && daten.felder[direkt]) return direkt;

    const kandidaten = Object.keys(HANDBUCH_FELD_ALIASE)
        .filter(k => klein.indexOf(k.toLowerCase()) !== -1)
        .sort((a, b) => b.length - a.length);
    for (const k of kandidaten) {
        const feld = HANDBUCH_FELD_ALIASE[k];
        if (daten.felder[feld]) return feld;
    }
    return '';
}

function handbuchKnopf(label, feld, daten) {
    // Aussehen kommt aus styles.css - damit die Alarm-Klasse es überschreiben
    // kann, wenn die Prüfung das Feld beanstandet.
    const knopf = createEl('span', 'dora-handbuch-knopf', '📖');
    knopf.title = `DORA-Handbuch zu «${feld}» anzeigen`;

    knopf.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        // Zweiter Klick schliesst wieder
        if (schliesseHandbuchAmFeld(feld)) return;
        oeffneHandbuchAmFeld(feld, daten, false);
    });

    return knopf;
}

// Handbuch zu einem Feld im Formular oeffnen und dorthin springen. Wird vom
// Symbol an der Beschriftung und vom Eintrag in der Fehlerliste benutzt -
// dort ist ein aufklappbarer Kasten im schmalen Panel unpraktisch.
function oeffneHandbuchAmFeld(feld, daten, mitSprung) {
    const label = document.querySelector('label[data-dora-handbuch="' + feld + '"]');
    if (!label) return false;

    const huelle = label.closest('.form-item') || label.parentElement;
    if (!huelle) return false;

    let kasten = huelle.querySelector('.dora-handbuch-kasten');
    if (!kasten) {
        kasten = handbuchKasten(feld, daten);
        huelle.appendChild(kasten);
    }

    if (mitSprung) {
        macheFeldSichtbar(huelle);
        if (typeof huelle.scrollIntoView === 'function') {
            try {
                huelle.scrollIntoView({ behavior: 'instant', block: 'center' });
            } catch (e) {
                huelle.scrollIntoView(true);
            }
        }

        // Kurz hervorheben, damit klar ist, wohin gesprungen wurde
        kasten.classList.remove('dora-handbuch-kasten-blitz');
        void kasten.offsetWidth;
        kasten.classList.add('dora-handbuch-kasten-blitz');
        setTimeout(() => kasten.classList.remove('dora-handbuch-kasten-blitz'), 1400);
    }

    return true;
}

// Zugeklappte Fieldsets und nicht gewaehlte Reiter oberhalb des Feldes
// oeffnen. Ohne das springt der Browser zu etwas Unsichtbarem und der Sprung
// aus der Fehlerliste wirkt wie ein Aussetzer.
//
// Der Aufstieg endet bewusst am Formular: ein Walk bis zum body hat frueher
// den Seitenrahmen mit aufgedeckt (Menue, versteckte Kopfzeilen). Und
// display:none wird nur an den Huellen aufgehoben, die Drupal selbst zum
// Zuklappen benutzt - nirgends sonst.
function macheFeldSichtbar(el) {
    const grenze = el.closest('form') || document.body;
    let knoten = el;

    while (knoten && knoten !== grenze) {
        if (knoten.classList && knoten.classList.contains('collapsed')) {
            // Drupal 7: fieldset.collapsible.collapsed versteckt .fieldset-wrapper
            knoten.classList.remove('collapsed');
            const inhalt = knoten.querySelector(':scope > .fieldset-wrapper');
            if (inhalt && inhalt.style.display === 'none') inhalt.style.removeProperty('display');
        }

        // Islandora-Fieldpanels / vertikale Reiter: den zugehoerigen Reiter waehlen
        if (knoten.id && knoten.classList
            && (knoten.classList.contains('vertical-tabs-pane')
                || knoten.classList.contains('horizontal-tabs-pane'))) {
            const reiter = document.querySelector('a[href="#' + knoten.id + '"]');
            if (reiter) { try { reiter.click(); } catch (e) { /* egal */ } }
        }

        knoten = knoten.parentElement;
    }
}

function schliesseHandbuchAmFeld(feld) {
    const label = document.querySelector('label[data-dora-handbuch="' + feld + '"]');
    const huelle = label ? (label.closest('.form-item') || label.parentElement) : null;
    const kasten = huelle ? huelle.querySelector('.dora-handbuch-kasten') : null;
    if (kasten) { kasten.remove(); return true; }
    return false;
}

function handbuchKasten(feld, daten) {
    const kasten = createEl('div', 'dora-handbuch-kasten');
    kasten.style.cssText = 'margin:6px 0 10px 0; padding:8px 10px; background:#ebf8ff; '
        + 'border-left:4px solid #2b6cb0; border-radius:4px; font-size:12px; '
        + 'line-height:1.45; color:#2a4365; max-height:260px; overflow-y:auto;';

    const abschnitte = daten.felder[feld] || [];
    abschnitte.forEach((abschnitt, index) => {
        const kopf = createEl('div', '', abschnitt.thema);
        kopf.style.cssText = 'font-weight:700; margin:' + (index ? '8px' : '0') + ' 0 4px 0;';
        kasten.appendChild(kopf);

        (abschnitt.regeln || []).slice(0, 12).forEach(regel => {
            const zeile = createEl('div', '', '• ' + regel);
            zeile.style.marginBottom = '3px';
            kasten.appendChild(zeile);
        });

        if ((abschnitt.regeln || []).length > 12) {
            const rest = createEl('div', '', `… ${abschnitt.regeln.length - 12} weitere Punkte im Wiki`);
            rest.style.cssText = 'font-style:italic; color:#4a5568;';
            kasten.appendChild(rest);
        }

        const quelle = createEl('div', '', `Handbuch-Seite ${abschnitt.seitenId}`
            + (abschnitt.fassungen > 1 ? ` · ${abschnitt.fassungen} Fassungen im Export` : ''));
        quelle.style.cssText = 'margin-top:4px; font-size:0.9em; color:#4a5568; font-style:italic;';
        kasten.appendChild(quelle);
    });

    const fuss = createEl('div', '', `Auszug vom ${(daten.auszug && daten.auszug.erzeugt) || '?'} · Klick auf 📖 schliesst wieder`);
    fuss.style.cssText = 'margin-top:6px; padding-top:4px; border-top:1px solid #bee3f8; '
        + 'font-size:0.85em; color:#4a5568;';
    kasten.appendChild(fuss);

    return kasten;
}

function ladeHandbuch(callback) {
    if (handbuchDaten) { callback(handbuchDaten); return; }
    if (handbuchLaedt) { handbuchLaedt.push(callback); return; }

    handbuchLaedt = [callback];
    const fertig = (daten) => {
        handbuchDaten = daten || { felder: {} };
        const warteschlange = handbuchLaedt || [];
        handbuchLaedt = null;
        warteschlange.forEach(cb => cb(handbuchDaten));
    };

    try {
        fetch(chrome.runtime.getURL('handbuch.json'))
            .then(antwort => antwort.ok ? antwort.json() : null)
            .then(fertig)
            .catch(() => fertig(null));
    } catch (e) {
        fertig(null);
    }
}

// Die Regeln eines Feldes, die zur Meldung passen. Sortiert nach Wortueber-
// lappung mit der Meldung, damit bei "Sentence case" auch die Regel zur
// Schreibweise oben steht und nicht die zur Bedienung des Feldes.
function handbuchRegelnFuer(feldBeschriftung, meldung, daten) {
    const felder = (daten && daten.felder) || {};
    const schluessel = HANDBUCH_FELD_ALIASE[feldBeschriftung]
        || Object.keys(felder).find(f => f.toLowerCase() === String(feldBeschriftung).toLowerCase());
    const abschnitte = schluessel ? felder[schluessel] : null;
    if (!abschnitte || !abschnitte.length) return null;

    const stoppwoerter = ['bitte', 'sollte', 'muss', 'ist', 'und', 'oder', 'der', 'die', 'das',
        'ein', 'eine', 'von', 'mit', 'für', 'nicht', 'wird', 'werden', 'enthält', 'scheint'];
    // Meldungen und Handbuchtext benutzen andere Woerter fuer dieselbe
    // Sache - ohne Bruecke gewinnt sonst eine zufaellige Regel.
    const SYNONYME = [
        [/title case|sentence case|gross geschrieben|grossbuchstaben|kleinanfang|funktionsw/i,
         ['sentence', 'case', 'gross', 'klein', 'schreibweise', 'eigennamen', 'akronyme']],
        [/schreibweise|formatierung/i, ['schreibweise', 'gross', 'klein', 'formatierung']],
        [/fehlt|leer|erforderlich/i, ['muss', 'immer', 'pflicht', 'erfasst', 'eingeben']],
        [/seite|page/i, ['seite', 'seitenzahl', 'bis', 'von']],
        [/sprache|language/i, ['sprache', 'hauptsprache']]
    ];
    const zusatz = [];
    SYNONYME.forEach(([muster, woerter]) => {
        if (muster.test(String(meldung || ''))) zusatz.push(...woerter);
    });

    const begriffe = zusatz.concat(String(meldung || '').toLowerCase()
        .split(/[^a-zà-öø-ÿ]+/)
        .filter(w => w.length > 3 && stoppwoerter.indexOf(w) === -1));

    const bewertet = [];
    abschnitte.forEach(abschnitt => {
        (abschnitt.regeln || []).forEach(regel => {
            const klein = regel.toLowerCase();
            const punkte = begriffe.reduce((summe, b) => summe + (klein.indexOf(b) !== -1 ? 1 : 0), 0);
            bewertet.push({ regel: regel, punkte: punkte, thema: abschnitt.thema, seitenId: abschnitt.seitenId });
        });
    });

    bewertet.sort((a, b) => b.punkte - a.punkte);
    return {
        feld: schluessel,
        thema: abschnitte[0].thema,
        seitenId: abschnitte[0].seitenId,
        regeln: bewertet.slice(0, 3),
        anzahl: bewertet.length
    };
}

// Unter eine Fehlermeldung das passende Handbuch-Zitat haengen (aufklappbar).
// Unter eine Fehlermeldung einen Verweis haengen, der zum Feld im Formular
// springt und dort das Handbuch aufschlaegt. Ein Kasten im schmalen
// Fehlerpanel war unpraktisch - die Regel gehoert an das Feld.
function haengeHandbuchAn(li, feldBeschriftung, meldung) {
    if (!li || !feldBeschriftung) return;

    ladeHandbuch((daten) => {
        const treffer = handbuchRegelnFuer(feldBeschriftung, meldung, daten);
        if (!treffer || !treffer.regeln.length) return;
        if (!document.body.contains(li)) return;

        const amFeld = !!document.querySelector('label[data-dora-handbuch="' + treffer.feld + '"]');

        const verweis = createEl('span', '', amFeld ? '📖 Regel am Feld zeigen' : '📖 Handbuch');
        verweis.style.cssText = 'cursor:pointer; font-size:0.8em; color:#2b6cb0; '
            + 'text-decoration:underline; margin-left:4px; white-space:nowrap;';
        verweis.title = amFeld
            ? 'Springt zum Feld und schlägt dort das Handbuch auf'
            : 'Was das DORA-Handbuch zu «' + treffer.feld + '» sagt';

        // Rückfall, wenn das Feld gerade nicht im Formular steht: die Regeln
        // direkt hier aufklappen.
        const kasten = createEl('div');
        kasten.style.cssText = 'display:none; margin:4px 0 2px 0; padding:5px 7px; '
            + 'background:#ebf8ff; border-left:3px solid #2b6cb0; border-radius:3px; '
            + 'font-size:0.8em; color:#2a4365; line-height:1.35;';
        treffer.regeln.forEach(r => {
            const zeile = createEl('div', '', '• ' + r.regel);
            zeile.style.marginBottom = '3px';
            kasten.appendChild(zeile);
        });
        const quelle = createEl('div', '',
            'Handbuch: ' + treffer.thema + (treffer.seitenId ? ' (Seite ' + treffer.seitenId + ')' : ''));
        quelle.style.cssText = 'margin-top:4px; font-size:0.92em; color:#4a5568; font-style:italic;';
        kasten.appendChild(quelle);

        verweis.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (oeffneHandbuchAmFeld(treffer.feld, daten, true)) return;
            kasten.style.display = kasten.style.display === 'none' ? 'block' : 'none';
        };

        li.appendChild(document.createTextNode(' '));
        li.appendChild(verweis);
        li.appendChild(kasten);
    });
}


if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserver);
} else {
    startObserver();
}

function startObserver() {
    // In einem stillen Rahmen des Stapellaufs bleibt alles aus: dort wird das
    // Formular von aussen gesteuert. Ohne das baut jede Kopie hier eine
    // Ergebnisbox, holt die DOI und zieht womoeglich ein Fenster auf.
    if (istStillerRahmen()) {
        console.log('DORA Helper: stiller Rahmen des Stapellaufs - keine Oberflaeche.');
        return;
    }

    // Initialize PSI Data (async)
    if (typeof initPsiData === 'function') {
        initPsiData().then(() => {
            // Re-validate once data is loaded
            validateForm();
        }).catch(e => console.warn("DORA Helper: PSI Data Init failed", e));
    }

    scanAndInject();
    const observer = new MutationObserver((mutations) => {
        if (observerTimeout) clearTimeout(observerTimeout);
        observerTimeout = setTimeout(() => { scanAndInject(); }, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

function scanAndInject() {
    // NEW: Check for Search Page for Batch QC feature
    if (isSearchPage()) {
        chrome.storage.local.get({ enableBatchQc: true }, function (result) {
            if (result.enableBatchQc) {
                injectBatchQcButton();
            } else {
                const btn = document.getElementById('dora-batch-qc-btn');
                if (btn) btn.remove();
            }
        });
        return;
    }

    // SECURITY / PERFORMANCE: Only run on Edit or Ingest Forms
    if (!isEditPage()) return;

    // Handbuch-Knöpfe an den Feldbeschriftungen - unabhängig davon, ob die
    // Prüfung etwas beanstandet.
    injectHandbuchButtons();

    // 1. Check URL parameters for DOI (Ingest workflow)
    let urlParams = new URLSearchParams(window.location.search);
    let urlDoi = urlParams.get('doi');

    // Fallback: Check inline scripts (Drupal POSTs might hide URL params from the address bar)
    if (!urlDoi) {
        const scripts = document.querySelectorAll('script');
        for (let script of scripts) {
            if (script.textContent.includes('Drupal.settings') && script.textContent.includes('doi=')) {
                const match = script.textContent.match(/[?&]doi=(10\.\d{4,9}\/[^&_"'\\]+)/i);
                if (match) {
                    urlDoi = decodeURIComponent(match[1]);
                    break;
                }
            }
        }
    }

    const currentPidForStorage = window.location.href.match(/islandora\/object\/([^/]+)/) ? decodeURIComponent(window.location.href.match(/islandora\/object\/([^/]+)/)[1]) : 'ingest';

    if (urlDoi) {
        sessionStorage.setItem('dora_helper_current_doi_' + currentPidForStorage, urlDoi);
    }

    const doiInput = document.getElementById('edit-identifiers-doi');
    if (doiInput) {
        if (!document.getElementById('dora-helper-btn')) {
            injectDOIButton(doiInput);
            doiInput.addEventListener('input', (e) => {
                const val = e.target.value.trim();
                if (val) sessionStorage.setItem('dora_helper_current_doi_' + currentPidForStorage, val);
            });
        }
        const currentDoi = doiInput.value.trim();
        if (currentDoi) {
            sessionStorage.setItem('dora_helper_current_doi_' + currentPidForStorage, currentDoi);
        }
    }

    if (doiInput && doiInput.value.trim() && doiInput.value.trim() !== lastAutoFetchedDoi) {
        const currentDoi = doiInput.value.trim();
        lastAutoFetchedDoi = currentDoi;
        showLoadingBox();
        performFetch(currentDoi);
    }

    const topicContainer = findKeywordContainer();
    if (topicContainer && !document.getElementById('dora-keyword-manager')) {
        injectKeywordManager(topicContainer);
    }
    injectTagButtons();
    injectBulkDataTool();
    injectDoraAutocompletes();
    injectJournalReloadButton();
    injectFundingFormPanel();

    validateForm();
    initPdfLicenseChecker();
}

function findKeywordContainer() {
    let el = document.querySelector('.form-item-topics');
    if (el) return el;
    const labels = document.querySelectorAll('label');
    for (const label of labels) {
        if (((label.innerText || label.textContent || '').toLowerCase()).includes('keywords') || ((label.innerText || label.textContent || '').toLowerCase()).includes('topics')) {
            return label.closest('.form-item') || label.parentNode;
        }
    }
    const inputByName = document.querySelector('input[name^="topics"]');
    if (inputByName) return inputByName.closest('.form-item') || inputByName.parentNode.parentNode;
    return null;
}

// --- DOM HELPER (Sicherer als innerHTML) ---
function createEl(tag, className, text = null) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
}

function createFloatingBox() {
    let box = document.getElementById('dora-result-box');
    if (!box) {
        box = createEl('div', '');
        box.id = 'dora-result-box';
        document.body.appendChild(box);
    }
    // Styles
    Object.assign(box.style, {
        position: 'fixed', top: '110px', right: '20px', width: '320px', zIndex: '10000',
        backgroundColor: '#ffffff', border: '1px solid #ccc', borderLeft: '5px solid #0073e6',
        borderRadius: '5px', padding: '10px', boxShadow: '0 5px 20px rgba(0,0,0,0.15)'
    });
    return box;
}

// --- ERGEBNISBOX: MINIMIEREN STATT SCHLIESSEN ---
// Wer die Box schliesst, muss sie ueber einen neuen Abruf zurueckholen.
// Eingeklappt bleibt sie als schmale Leiste stehen; der Zustand ueberlebt
// weitere Abfragen, damit die Box beim Durcharbeiten nicht staendig
// aufspringt.
let ergebnisBoxMinimiert = false;

function erzeugeBoxSteuerung(box, beimSchliessen, kurzText) {
    const leiste = createEl('div', '');
    leiste.dataset.doraSteuerung = 'ja';
    // Eigener heller Grund und Innenabstand: die Symbole bleiben lesbar,
    // auch wenn ein langer Titel bis dicht heranreicht.
    leiste.style.cssText = 'position: absolute; top: 2px; right: 4px; display: flex; gap: 10px; '
        + 'align-items: center; padding: 2px 6px; border-radius: 4px; '
        + 'background: rgba(255,255,255,.92); z-index: 2;';

    const minBtn = createEl('div', 'dora-min-btn', '–');
    minBtn.id = 'dora-box-minimize';
    minBtn.title = 'Box einklappen (bleibt als Leiste erreichbar)';
    minBtn.style.cssText = 'cursor: pointer; font-size: 1.2em; line-height: 1; color: #666; user-select: none;';
    minBtn.addEventListener('click', () => {
        if (box.dataset.doraMinimiert === 'ja') stelleBoxWiederHer(box);
        else minimiereBox(box, kurzText);
    });

    const closeBtn = createEl('div', 'dora-close-btn', '×');
    closeBtn.id = 'dora-box-close';
    closeBtn.title = 'Box schließen';
    closeBtn.style.cssText = 'cursor: pointer; font-size: 1.2em; line-height: 1; color: #666; user-select: none;';
    closeBtn.addEventListener('click', () => {
        ergebnisBoxMinimiert = false;
        if (typeof beimSchliessen === 'function') beimSchliessen();
        box.remove();
    });

    leiste.appendChild(minBtn);
    leiste.appendChild(closeBtn);
    return leiste;
}

// Mehrfach aufrufbar: bereits verborgene Kinder werden uebersprungen. Das
// ist wichtig, weil die Box nach jedem Abruf neu aufgebaut wird.
function minimiereBox(box, kurzText) {
    if (!box) return;
    box.dataset.doraMinimiert = 'ja';
    ergebnisBoxMinimiert = true;

    Array.from(box.children).forEach(kind => {
        if (!kind.dataset || kind.dataset.doraSteuerung === 'ja') return;
        if (kind.id === 'dora-box-min-label') return;
        if (kind.style.display === 'none') return; // war schon verborgen
        kind.dataset.doraEingeklappt = 'ja';
        kind.style.display = 'none';
    });

    let anzeige = box.querySelector('#dora-box-min-label');
    if (!anzeige) {
        anzeige = createEl('div', '');
        anzeige.id = 'dora-box-min-label';
        anzeige.style.cssText = 'display:flex; align-items:center; gap:6px; cursor:pointer; font-family:sans-serif; font-size:12px; font-weight:600; color:#0073e6; padding-right:52px; white-space:nowrap;';
        anzeige.title = 'Klicken, um die Box wieder zu öffnen';
        anzeige.addEventListener('click', () => stelleBoxWiederHer(box));
        box.appendChild(anzeige);
    }
    anzeige.replaceChildren();
    const logo = createEl('img');
    logo.src = chrome.runtime.getURL('icons/logo-48.png');
    logo.style.cssText = 'width:18px; height:18px;';
    anzeige.appendChild(logo);
    anzeige.appendChild(document.createTextNode(kurzText || 'DORA Helper – Ergebnis'));
    anzeige.style.display = 'flex';

    box.style.width = 'auto';
    box.style.padding = '6px 10px';
    const minBtn = box.querySelector('#dora-box-minimize');
    if (minBtn) {
        minBtn.textContent = '▢';
        minBtn.title = 'Box wieder aufklappen';
    }
}

function stelleBoxWiederHer(box) {
    if (!box) return;
    box.dataset.doraMinimiert = 'nein';
    ergebnisBoxMinimiert = false;

    const anzeige = box.querySelector('#dora-box-min-label');
    if (anzeige) anzeige.style.display = 'none';

    Array.from(box.children).forEach(kind => {
        if (kind.dataset && kind.dataset.doraEingeklappt === 'ja') {
            kind.style.display = '';
            delete kind.dataset.doraEingeklappt;
        }
    });

    box.style.width = '320px';
    box.style.padding = '10px';
    const minBtn = box.querySelector('#dora-box-minimize');
    if (minBtn) {
        minBtn.textContent = '–';
        minBtn.title = 'Box einklappen (bleibt als Leiste erreichbar)';
    }
}

// --- FETCHING ---
function performFetch(doi) {
    chrome.runtime.sendMessage({ action: "fetchData", doi: doi }, (response) => {
        if (response && response.success) {
            kiDoiDaten.set(doi.toLowerCase(), response.data);
            renderResultBox(response.data);
        }
        else renderErrorBox(response ? response.error : "Verbindungsfehler");
    });
}

// ---------------------------------------------------------------------------
// KI-Check (nur per Knopf). Das Formular wird als nummerierte Liste
// Feld/Wert erfasst, dazu kommen die Handbuchregeln der befuellten Felder und
// eine Belegquelle (Crossref, ggf. das schon ausgewertete PDF). Haiku meldet
// Abweichungen mit Verweis auf die Nummer; die Seite markiert das Feld und
// listet die Befunde in einem Panel. Es wird nichts ins Formular geschrieben.
// ---------------------------------------------------------------------------
const kiDoiDaten = new Map();        // doi (klein) -> Antwort von fetchData
const kiPdfErgebnisse = new Map();   // doi (klein) -> von Haiku gelesene PDF-Angaben
let kiElemente = {};                 // "f12" -> Formularelement des letzten Laufs

// Handbuch-Seiten, die Bedienung statt Pruefregeln beschreiben
const KI_THEMEN_AUSSCHLUSS = /neu erfassen|autorenobjekte/i;
const KI_REGELN_MAX_ZEICHEN = 20000;   // je Feld, begrenzt Prompt und Kosten
const KI_WERT_MAX_ZEICHEN = 3000;
const KI_HILFSBEREICHE = '#dora-keyword-manager, #dora-funding-panel, #dora-bulk-data-tool, '
    + '.dora-handbuch-kasten, .dora-action-container, #dora-haiku-popup, #dora-ki-panel';

function kiSaubererText(text) {
    return (text || '').replace(/📖/g, '').replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim();
}

function kiFeldBeschriftung(el, form) {
    let label = el.id ? form.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]') : null;
    let text = label ? kiSaubererText(label.innerText || label.textContent) : '';
    if (!text) text = el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || 'Feld';
    // Fieldset-Ueberschrift als Kontext (z.B. "Host" vor "Volume")
    const set = el.closest('fieldset');
    const legende = set ? set.querySelector(':scope > legend') : null;
    const kontext = legende ? kiSaubererText(legende.innerText || legende.textContent).slice(0, 60) : '';
    return { label: kontext && kontext !== text ? kontext + ' / ' + text : text, nurLabel: text };
}

function kiAutorenPanes(form) {
    const gesehen = new Set();
    return Array.from(form.querySelectorAll('.islandora-form-fieldpanel-pane, table tbody tr')).filter(pane => {
        // Betreuer und Herausgeber haben teils denselben Lookup, sind aber keine Autoren
        if (pane.closest('.form-item-supervisor, .form-item-host-editor')) return false;
        const name = pane.querySelector('input[type="text"][name$="[valName]"]');
        if (!name || gesehen.has(name)) return false;
        gesehen.add(name);
        return true;
    });
}

// Formular -> {formular:[{ref,label,wert}], felder:Set(Handbuchfelder)}
function kiFormularErfassen(form, daten) {
    const formular = [];
    const felder = new Set();
    kiElemente = {};
    let nr = 0;
    const neu = (el, label, wert, feld) => {
        const text = (wert || '').toString().replace(/\s+/g, ' ').trim();
        if (!text) return;
        const ref = 'f' + (++nr);
        kiElemente[ref] = el;
        formular.push({ ref: ref, label: label, wert: text.slice(0, KI_WERT_MAX_ZEICHEN) });
        if (feld) felder.add(feld);
    };

    const autorenPanes = kiAutorenPanes(form);
    const inAutorenPane = (el) => autorenPanes.some(p => p.contains(el));

    form.querySelectorAll('input, select, textarea').forEach(el => {
        const typ = (el.type || '').toLowerCase();
        if (['hidden', 'submit', 'button', 'file', 'image', 'password'].indexOf(typ) !== -1) return;
        if (el.closest(KI_HILFSBEREICHE) || inAutorenPane(el)) return;
        if ((typ === 'checkbox' || typ === 'radio') && !el.checked) return;

        const { label, nurLabel } = kiFeldBeschriftung(el, form);
        let wert;
        if (el.id === ABSTRACT_FELD_ID) wert = leseAbstractImFormular();
        else if (el.tagName === 'SELECT') {
            const opt = el.options[el.selectedIndex];
            wert = (opt && el.value && el.value !== '_none') ? opt.textContent : '';
        } else if (typ === 'checkbox' || typ === 'radio') wert = 'ja';
        else wert = el.value;

        neu(el.id === ABSTRACT_FELD_ID ? (document.getElementById('cke_' + el.id) || el) : el,
            label, wert, handbuchFeldZuBeschriftung(nurLabel, daten));
    });

    autorenPanes.forEach((pane, i) => {
        const wert = (sel) => { const e = pane.querySelector(sel); return e ? e.value.trim() : ''; };
        const familie = wert('input[name$="[family]"]'), vorname = wert('input[name$="[given]"]');
        const name = wert('input[type="text"][name$="[valName]"]') || [familie, vorname].filter(Boolean).join(', ');
        const teile = [name];
        [['Group', '[affiliation]'], ['Section', '[section_name]'], ['Laboratory', '[department_name]'], ['Division', '[division_name]']]
            .forEach(([titel, suffix]) => {
                const v = wert('input[type="text"][name$="' + suffix + '"]');
                if (v) teile.push(titel + ': ' + v);
            });
        neu(pane.querySelector('input[type="text"][name$="[valName]"]'), 'Autor ' + (i + 1), teile.join(' | '), 'Authors');
    });

    return { formular: formular, felder: felder };
}

// Handbuchregeln der betroffenen Felder als Text; gleiche Wiki-Seiten nur einmal
function kiRegelnSammeln(felder, daten) {
    const gesehen = new Set();
    const regeln = [];
    felder.forEach(feld => {
        const eintraege = (daten.felder && daten.felder[feld]) || [];
        const teile = [];
        eintraege.forEach(e => {
            if (KI_THEMEN_AUSSCHLUSS.test(e.thema || '') || gesehen.has(e.seitenId)) return;
            gesehen.add(e.seitenId);
            teile.push('[Seite: ' + e.thema + ']\n- ' + (e.regeln || []).join('\n- '));
        });
        const text = teile.join('\n').slice(0, KI_REGELN_MAX_ZEICHEN);
        if (text) regeln.push({ feld: feld, text: text });
    });
    return regeln;
}

// Crossref auf das reduzieren, was als Vorlage taugt
function kiReferenzAusCrossref(cr) {
    if (!cr) return null;
    const erster = (v) => Array.isArray(v) ? v[0] : v;
    const datum = cr.issued && cr.issued['date-parts'] && cr.issued['date-parts'][0];
    return {
        titel: erster(cr.title) || null,
        zeitschrift_oder_buch: erster(cr['container-title']) || null,
        band: cr.volume || null, heft: cr.issue || null, seiten: cr.page || null,
        jahr_monat_tag: datum ? datum.filter(Boolean).join('-') : null,
        verlag: cr.publisher || null, issn: cr.ISSN || null, typ: cr.type || null,
        sprache: cr.language || null, doi: cr.DOI || null,
        autoren: (cr.author || []).slice(0, 60).map(a => ({
            nachname: a.family || a.name || '', vorname: a.given || '',
            affiliation: (a.affiliation || []).map(x => x.name).filter(Boolean).join('; ') || undefined
        }))
    };
}

function kiMarkierungenEntfernen() {
    document.querySelectorAll('.dora-ki-fehler, .dora-ki-hinweis').forEach(el => {
        el.classList.remove('dora-ki-fehler', 'dora-ki-hinweis');
    });
}

function kiPanelOeffnen() {
    let panel = document.getElementById('dora-ki-panel');
    if (panel) panel.remove();
    panel = createEl('div');
    panel.id = 'dora-ki-panel';
    panel.style.cssText = 'position:fixed; top:70px; right:20px; z-index:9998; width:370px; max-height:72vh; '
        + 'display:flex; flex-direction:column; background:#fff; border:1px solid #cbd5e0; '
        + 'border-left:5px solid #6b46c1; border-radius:5px; box-shadow:0 4px 16px rgba(0,0,0,.2); '
        + 'font:13px sans-serif; color:#333;';

    const kopf = createEl('div');
    kopf.style.cssText = 'display:flex; justify-content:space-between; align-items:center; padding:8px 12px; border-bottom:1px solid #e2e8f0;';
    const titel = createEl('b', '', '🤖 KI-Check');
    kopf.appendChild(titel);
    const zu = createEl('span', '', '✕');
    zu.title = 'Schließen und Markierungen entfernen';
    zu.style.cssText = 'cursor:pointer; padding:0 4px; color:#718096;';
    zu.onclick = () => { panel.remove(); kiMarkierungenEntfernen(); };
    kopf.appendChild(zu);
    panel.appendChild(kopf);

    const koerper = createEl('div');
    koerper.style.cssText = 'padding:8px 12px; overflow:auto;';
    panel.appendChild(koerper);
    document.body.appendChild(panel);
    return { panel: panel, koerper: koerper, titel: titel };
}

function kiZeigeBefunde(ergebnis, quellen) {
    const { koerper, titel } = kiPanelOeffnen();
    kiMarkierungenEntfernen();
    const befunde = ergebnis.findings || [];
    titel.textContent = befunde.length ? `🤖 KI-Check: ${befunde.length} Befund${befunde.length > 1 ? 'e' : ''}` : '🤖 KI-Check';

    if (!befunde.length) {
        const ok = createEl('div', '', '✅ Keine Abweichungen von Handbuch und Belegquelle gefunden.');
        ok.style.cssText = 'padding:6px 0;';
        koerper.appendChild(ok);
    }

    befunde.forEach(b => {
        const el = b.ref ? kiElemente[b.ref] : null;
        const istFehler = b.severity === 'fehler';
        if (el) el.classList.add(istFehler ? 'dora-ki-fehler' : 'dora-ki-hinweis');

        const zeile = createEl('div');
        zeile.style.cssText = 'padding:7px 0; border-bottom:1px solid #edf2f7;' + (el ? ' cursor:pointer;' : '');

        const feldName = b.ref ? (kiFeldNamen[b.ref] || '') : '';
        const kopfzeile = createEl('div');
        kopfzeile.style.cssText = 'font-weight:600;';
        kopfzeile.appendChild(document.createTextNode((istFehler ? '❌ ' : '⚠️ ') + (feldName || 'Datensatz')));
        zeile.appendChild(kopfzeile);

        zeile.appendChild(createEl('div', '', b.problem || ''));

        if (b.suggestion) {
            const v = createEl('div', '', 'Vorschlag: ' + b.suggestion);
            v.style.cssText = 'margin-top:3px; padding:3px 6px; background:#f0fff4; border-radius:3px; white-space:pre-wrap;';
            zeile.appendChild(v);
        }
        if (b.rule) {
            const r = createEl('div', '', '📖 ' + b.rule);
            r.style.cssText = 'margin-top:3px; font-size:11px; color:#718096;';
            zeile.appendChild(r);
        }
        if (el) {
            zeile.title = 'Klicken, um zum Feld zu springen';
            zeile.onclick = () => {
                macheFeldSichtbar(el.closest('.form-item') || el);
                try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { el.scrollIntoView(true); }
            };
        }
        koerper.appendChild(zeile);
    });

    const fuss = createEl('div', '', 'Modell ' + (ergebnis.model || 'Haiku') + ' · Beleg: ' + quellen
        + ' · Vorschläge der KI bitte prüfen.');
    fuss.style.cssText = 'margin-top:8px; font-size:11px; color:#a0aec0;';
    koerper.appendChild(fuss);
}

function kiZeigeFehler(text) {
    const { koerper } = kiPanelOeffnen();
    const f = createEl('div', '', '❌ ' + text);
    f.style.cssText = 'color:#c53030; white-space:pre-wrap;';
    koerper.appendChild(f);
}

let kiFeldNamen = {};   // "f12" -> Beschriftung, fuer die Anzeige der Befunde

function erzeugeKiCheckKnopf(doiInput) {
    const knopf = createEl('button', 'dora-helper-button', '🤖 KI-Check');
    knopf.type = 'button';
    knopf.title = 'Prüft den Datensatz mit Claude Haiku gegen die Handbuchregeln und die Vorlage (kostet API-Guthaben)';

    knopf.addEventListener('click', () => {
        const doi = doiInput.value.trim();
        const form = doiInput.closest('form') || document.querySelector('form');
        if (!form) { kiZeigeFehler('Kein Formular gefunden.'); return; }

        const alterText = knopf.textContent;
        knopf.disabled = true;
        knopf.textContent = '⏳ prüft …';
        const fertig = () => { knopf.disabled = false; knopf.textContent = alterText; };

        ladeHandbuch((daten) => {
            const erfasst = kiFormularErfassen(form, daten);
            kiFeldNamen = {};
            erfasst.formular.forEach(f => { kiFeldNamen[f.ref] = f.label; });

            const senden = (crossref) => {
                const referenz = {};
                const quellen = [];
                const kr = kiReferenzAusCrossref(crossref);
                if (kr) { referenz.crossref = kr; quellen.push('Crossref'); }
                const pdf = doi && kiPdfErgebnisse.get(doi.toLowerCase());
                if (pdf) {
                    referenz.pdf = {
                        titel: pdf.title, abstract: pdf.abstract, keywords: pdf.keywords, seitenzahl: pdf.page_count,
                        autoren: (pdf.authors || []).map(a => ({ nachname: a.family, vorname: a.given, institut: a.institute, affiliationen: a.affiliations, corresponding: a.corresponding || undefined }))
                    };
                    quellen.push('PDF');
                }
                const regeln = kiRegelnSammeln(erfasst.felder, daten);
                if (!regeln.length) {
                    fertig();
                    kiZeigeFehler('Das Handbuch (handbuch.json) ließ sich nicht laden oder enthält keine Regeln zu den befüllten Feldern.');
                    return;
                }
                if (!quellen.length) referenz.hinweis = 'Keine Belegquelle verfügbar - nur interne Konsistenz und Regelform prüfen.';

                chrome.runtime.sendMessage({
                    action: 'kiCheckDatensatz',
                    formular: erfasst.formular,
                    institut: aktuellesInstitut(doi),
                    regeln: regeln,
                    referenz: referenz
                }, (antwort) => {
                    fertig();
                    if (chrome.runtime.lastError || !antwort || !antwort.success) {
                        kiZeigeFehler('KI-Check fehlgeschlagen: '
                            + ((antwort && antwort.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'keine Antwort'));
                        return;
                    }
                    kiZeigeBefunde(antwort.data, quellen.length ? quellen.join(' + ') : 'keiner');
                });
            };

            const bekannt = doi ? kiDoiDaten.get(doi.toLowerCase()) : null;
            if (bekannt || !doi) { senden(bekannt && bekannt.crossref); return; }
            chrome.runtime.sendMessage({ action: 'fetchData', doi: doi }, (r) => {
                if (r && r.success) kiDoiDaten.set(doi.toLowerCase(), r.data);
                senden(r && r.success ? r.data.crossref : null);
            });
        });
    });

    return knopf;
}

function injectDOIButton(doiInput) {
    const container = createEl('div', 'dora-action-container');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.gap = '10px';
    container.id = 'dora-helper-btn'; // Keep ID for check

    const btn = createEl('button', 'dora-helper-button', '↻ Neu prüfen');
    btn.type = 'button';
    btn.addEventListener('click', () => {
        const currentDoi = doiInput.value.trim();
        if (!currentDoi) { renderErrorBox("Keine DOI im Feld gefunden."); return; }
        lastAutoFetchedDoi = currentDoi;
        showLoadingBox();
        performFetch(currentDoi);
    });

    container.appendChild(btn);
    container.appendChild(erzeugeKiCheckKnopf(doiInput));

    doiInput.parentNode.appendChild(container);
}

// Fehler der PDF-Auswertung: eigene Meldung unten rechts. renderErrorBox
// wuerde die Ergebnisbox leeren und die DOI-Ergebnisse darin verdraengen.
function zeigePdfFehler(text) {
    const el = zeigeHaikuHinweis('');
    el.replaceChildren();
    el.style.background = '#fff5f5';
    el.style.borderColor = '#e53e3e';
    el.style.whiteSpace = 'pre-wrap';
    el.style.paddingRight = '28px';
    el.style.maxHeight = '50vh';
    el.style.overflow = 'auto';
    el.appendChild(document.createTextNode('❌ ' + text));
    const zu = createEl('span', '', '✕');
    zu.title = 'Schließen';
    zu.style.cssText = 'position:absolute; top:4px; right:8px; cursor:pointer; color:#718096;';
    zu.onclick = () => el.remove();
    el.appendChild(zu);
    clearTimeout(el._doraTimer);
    el._doraTimer = setTimeout(() => el.remove(), 15000);
    return el;
}

async function handlePdfFile(file) {
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        zeigePdfFehler("Bitte eine PDF-Datei auswählen.");
        return;
    }

    // Show loading state in the dropzone
    const dropZone = document.querySelector('.dora-pdf-drop');
    if (dropZone) {
        dropZone.textContent = '⏳ Analysiere...';
        dropZone.style.backgroundColor = '#fff3cd';
    }

    try {
        const dataUrl = await new Promise((resolve, reject) => {
            const leser = new FileReader();
            leser.onload = () => resolve(leser.result);
            leser.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
            leser.readAsDataURL(file);
        });

        const antwort = await new Promise(resolve =>
            chrome.runtime.sendMessage({ action: 'analyzePdf', fileData: dataUrl, institut: aktuellesInstitut('') }, resolve));
        if (!antwort || !antwort.success) {
            throw new Error((antwort && antwort.error) || 'Keine Antwort vom Hintergrundskript');
        }

        if (dropZone) {
            dropZone.textContent = '📄 PDF hier ablegen'; // Reset
            dropZone.style.backgroundColor = '#f9f9f9';
        }
        confirmAndFillPdfData(antwort.data, 'file');
    } catch (error) {
        if (dropZone) {
            dropZone.textContent = '📄 PDF hier ablegen';
            dropZone.style.backgroundColor = '#f9f9f9';
        }
        zeigePdfFehler("PDF Analyse fehlgeschlagen: " + error.message);
        console.error("PDF Analyse fehlgeschlagen:", error);
    }
}

async function handlePdfUrl(url, triggerBtn = null, localPath = null) {
    // Fallback: Try to find the standard "PDF von URL" button if no button passed
    if (!triggerBtn) {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
            if (((btn.innerText || btn.textContent || '')).includes('PDF von URL')) {
                triggerBtn = btn;
                break;
            }
        }
    }

    let originalText = '';
    if (triggerBtn) {
        originalText = triggerBtn.textContent;
        triggerBtn.textContent = '⏳ Lade...';
        triggerBtn.disabled = true;
    }

    try {
        // Strategy: Use new tab-based method for all URLs (including blob:)
        if (url && !localPath) {
            console.log('Requesting background script to fetch PDF via tab:', url);

            chrome.runtime.sendMessage({
                action: "analyzePdfViaTab",
                pdfUrl: url,
                institut: aktuellesInstitut('')
            }, (response) => {
                if (triggerBtn) triggerBtn.disabled = false;
                if (response && response.success) {
                    if (triggerBtn) triggerBtn.textContent = originalText;
                    confirmAndFillPdfData(response.data, url.startsWith('blob:') ? 'monitor' : 'url');
                } else {
                    if (triggerBtn) {
                        triggerBtn.textContent = '❌ Fehler';
                        triggerBtn.title = response ? response.error : "Unbekannter Fehler";
                        setTimeout(() => {
                            triggerBtn.textContent = originalText;
                            triggerBtn.title = '';
                        }, 3000);
                    }
                    zeigePdfFehler("PDF Analyse fehlgeschlagen: " + (response ? response.error : "Unbekannter Fehler"));
                }
            });
            return;
        }

        // FALLBACK: Use old method only for localPath (downloaded files)
        chrome.runtime.sendMessage({ action: "analyzePdfUrl", pdfUrl: url, localPath: localPath, institut: aktuellesInstitut('') }, (response) => {
            if (triggerBtn) triggerBtn.disabled = false;
            if (response && response.success) {
                if (triggerBtn) triggerBtn.textContent = originalText;
                confirmAndFillPdfData(response.data, 'monitor');
            } else {
                if (triggerBtn) {
                    triggerBtn.textContent = '❌ Fehler';
                    triggerBtn.title = response ? response.error : "Unbekannter Fehler";
                    setTimeout(() => {
                        triggerBtn.textContent = originalText;
                        triggerBtn.title = '';
                    }, 3000);
                }
                zeigePdfFehler("PDF URL Analyse fehlgeschlagen: " + (response ? response.error : "Unbekannter Fehler"));
            }
        });
    } catch (error) {
        if (triggerBtn) {
            triggerBtn.disabled = false;
            triggerBtn.textContent = '❌ Fehler';
            setTimeout(() => {
                triggerBtn.textContent = originalText;
            }, 3000);
        }
        zeigePdfFehler("PDF Analyse fehlgeschlagen: " + error.message);
    }
}

function confirmAndFillPdfData(data, sourceType = 'url') {
    const hasChanges = !!(data.page_count || data.abstract || (data.keywords && data.keywords.length));
    if (!hasChanges) {
        let errorMsg = "Analyse lieferte keine Daten.\n\n";

        if (sourceType === 'file') {
            errorMsg += "Ursache: Das PDF enthält keinen extrahierbaren Text (z.B. reiner Bild-Scan) oder ist leer.";
        } else if (sourceType === 'monitor') {
            errorMsg += "Ursache: Der Zugriff auf die heruntergeladene Datei ist fehlgeschlagen.\n";
            errorMsg += "Mögliche Gründe:\n";
            errorMsg += "1. 'Zugriff auf Datei-URLs zulassen' ist in den Erweiterungs-Einstellungen deaktiviert (Chrome).\n";
            errorMsg += "2. Der Fallback-Download wurde durch Login/Redirect blockiert.";
        } else {
            errorMsg += "Ursache: Wahrscheinlich konnte das PDF nicht direkt abgerufen werden (Login/Redirect).";
        }
        errorMsg += "\n\nLösung: Bitte PDF manuell herunterladen und per Drag & Drop analysieren.";
        zeigePdfFehler(errorMsg);
        return;
    }

    zeigeHaikuVorschlag(data, sourceType);
}

// ---------------------------------------------------------------------------
// Haiku-Vorschlag: Popup mit den aus dem PDF gelesenen Angaben. Jede Angabe
// laesst sich einzeln abwaehlen; uebernommen wird nur, was angehakt ist.
// Funding und Strahllinien stehen nur zur Ansicht da - Foerderung hat ihre
// eigene Pruefung (Panel "Funding"), und fuer Strahllinien gibt es kein Feld.
// ---------------------------------------------------------------------------
function zeigeHaikuVorschlag(data, sourceType) {
    const alt = document.getElementById('dora-haiku-popup');
    if (alt) alt.remove();

    const overlay = createEl('div');
    overlay.id = 'dora-haiku-popup';
    overlay.style.cssText = 'position:fixed; inset:0; z-index:2147483000; background:rgba(0,0,0,.35); '
        + 'display:flex; align-items:center; justify-content:center; font-family:sans-serif;';

    const dialog = createEl('div');
    dialog.style.cssText = 'background:#fff; border-radius:6px; box-shadow:0 8px 30px rgba(0,0,0,.3); '
        + 'width:min(680px, 94vw); max-height:88vh; display:flex; flex-direction:column; color:#222;';

    const kopf = createEl('div');
    kopf.style.cssText = 'padding:12px 16px; border-bottom:1px solid #e2e8f0; display:flex; align-items:baseline; gap:10px;';
    kopf.appendChild(createEl('b', '', '📄 Metadaten aus dem PDF'));
    const modell = createEl('span', '', 'Vorschlag von ' + (data.model || 'Haiku') + ' – bitte prüfen');
    modell.style.cssText = 'font-size:12px; color:#718096;';
    kopf.appendChild(modell);
    dialog.appendChild(kopf);

    const koerper = createEl('div');
    koerper.style.cssText = 'padding:10px 16px; overflow:auto; flex:1;';
    dialog.appendChild(koerper);

    const auswahl = {};   // feld -> Checkbox

    const abschnitt = (feld, titel, inhaltEl, vorgewaehlt, hinweis) => {
        const zeile = createEl('div');
        zeile.style.cssText = 'padding:8px 0; border-bottom:1px solid #edf2f7;';
        const label = createEl('label');
        label.style.cssText = 'display:flex; gap:8px; align-items:baseline; font-weight:600; cursor:pointer;';
        if (feld) {
            const cb = createEl('input');
            cb.type = 'checkbox';
            cb.checked = vorgewaehlt;
            auswahl[feld] = cb;
            label.appendChild(cb);
        }
        label.appendChild(document.createTextNode(titel));
        if (hinweis) {
            const h = createEl('span', '', hinweis);
            h.style.cssText = 'font-weight:400; font-size:11px; color:#b7791f;';
            label.appendChild(h);
        }
        zeile.appendChild(label);
        inhaltEl.style.margin = '4px 0 0 ' + (feld ? '24px' : '0');
        zeile.appendChild(inhaltEl);
        koerper.appendChild(zeile);
    };

    const textBlock = (text, hoehe) => {
        const el = createEl('div', '', text);
        el.style.cssText = 'font-size:13px; line-height:1.4; white-space:pre-wrap;'
            + (hoehe ? ` max-height:${hoehe}px; overflow:auto;` : '');
        return el;
    };

    if (data.title) {
        abschnitt(null, 'Titel im PDF', textBlock(data.title));
    }
    if (data.title_dora) {
        const vorhanden = leseTitelImFormular();
        const feldDa = vorhanden !== null;
        const leer = feldDa && !vorhanden;
        abschnitt(leer ? 'title_dora' : null,
            'Titel in Sentence case (DORA)' + (feldDa && !leer ? ' – Formular hat schon einen Titel, wird nicht überschrieben' : ''),
            textBlock(data.title_dora), true);
    } else if (data.title && data.title_language && data.title_language !== 'eng') {
        abschnitt(null, 'Titel nicht übernommen', textBlock('Der Artikel ist nicht englisch (' + data.title_language + ') – ein Titel in Sentence case wird nur für englische Artikel vorgeschlagen.'));
    }
    // Einfache Felder: leer -> vorangehakt; weicht ab -> nicht vorangehakt mit Hinweis; gleich -> nur Anzeige
    const feldAbschnitt = (schluessel, titel, vorschlag, aktuell, hinweisExtra) => {
        if (aktuell && pdfVergleichText(aktuell) === pdfVergleichText(vorschlag)) {
            abschnitt(null, titel + ' ✅', textBlock(vorschlag + '   (steht schon so im Formular)'));
            return;
        }
        const leer = !aktuell;
        abschnitt(schluessel, titel, textBlock(vorschlag + (hinweisExtra ? '\n' + hinweisExtra : '')), leer,
            leer ? '' : 'Formular: ' + aktuell);
    };

    const startEl = pdfSeitenElement('start');
    const endEl = pdfSeitenElement('end');
    const seiten = startEl ? seitenVorschlag(data) : null;
    if (seiten) {
        data.pages = { start: seiten.start, end: seiten.end };
        const aktuell = [pdfFeldAnzeige(startEl), pdfFeldAnzeige(endEl)].filter(Boolean).join(' – ');
        const gleich = pdfVergleichText(pdfFeldAnzeige(startEl)) === pdfVergleichText(seiten.start)
            && pdfVergleichText(pdfFeldAnzeige(endEl)) === pdfVergleichText(seiten.end);
        if (gleich) abschnitt(null, 'Seiten ✅', textBlock(seiten.anzeige + '   (steht schon so im Formular)'));
        else {
            const leer = !pdfFeldAnzeige(startEl) && !pdfFeldAnzeige(endEl);
            abschnitt('pages', 'Seiten (Start Page' + (seiten.end ? ' / End Page' : '') + ')',
                textBlock(seiten.anzeige + (seiten.nurAnzahl
                    ? '\nnur die Seitenzahl des PDFs – stimmt nur, wenn das PDF die publizierte Version ist' : '')),
                leer, leer ? '' : 'Formular: ' + aktuell);
        }
    }
    // Personenlisten (Herausgeber, Betreuer): nur Formulare mit dem jeweiligen Panel
    Object.keys(PDF_PERSONEN_PANELS).forEach(art => {
        const cfg = PDF_PERSONEN_PANELS[art];
        if (!findePersonenPanel(art) || !data[art] || !data[art].length) return;
        const vorschlag = data[art].map(x => [x.family, x.given].filter(Boolean).join(', '));
        const aktuell = lesePersonenImFormular(art);
        const gleich = aktuell.length === vorschlag.length && aktuell.every((a, i) => pdfVergleichText(a) === pdfVergleichText(vorschlag[i]));
        if (gleich) abschnitt(null, cfg.titel + ' ✅', textBlock(vorschlag.join('\n') + '\n(stehen schon so im Formular)'));
        else abschnitt(art, `${cfg.titel} (${vorschlag.length})`, textBlock(vorschlag.join('\n')), aktuell.length === 0,
            aktuell.length ? 'Formular: ' + aktuell.length + ' Eintrag/Einträge, werden überschrieben' : '');
    });
    // Berichte und Abschlussarbeiten haben nur ein Pages-Feld (Gesamtzahl der Seiten)
    const seitenGesamt = pdfGesamtSeitenElement();
    if (!startEl && seitenGesamt && data.page_count) {
        data.pages_total = String(data.page_count);   // Report/Thesis: nur die Zahl (Gesamtseitenzahl)
        feldAbschnitt('pages_total', 'Pages', data.pages_total, pdfFeldAnzeige(seitenGesamt),
            'Seitenzahl des PDFs – stimmt nur, wenn das PDF die publizierte Version ist');
    }
    if (data.language && pdfFeldElement('language')) {
        const sel = pdfFeldElement('language');
        const opt = Array.from(sel.options).find(o => o.value === data.language);
        if (opt) feldAbschnitt('language', 'Language', opt.textContent.trim(), pdfFeldAnzeige(sel));
    }
    PDF_FELD_REIHENFOLGE.filter(k => k !== 'language').forEach(k => {
        const el = pdfFeldElement(k);
        if (data[k] && el) feldAbschnitt(k, PDF_FELDER[k].titel, data[k], pdfFeldAnzeige(el));
    });
    if (data.abstract) {
        const vorhanden = leseAbstractImFormular();
        abschnitt('abstract', 'Abstract', textBlock(data.abstract, 220), !vorhanden,
            vorhanden ? 'ersetzt den vorhandenen Abstract' : '');
    }
    if (data.keywords && data.keywords.length) {
        const liste = textBlock(data.keywords.join(' · '));
        abschnitt('keywords', `Keywords (${data.keywords.length})`, liste, true);
    }
    if (data.authors && data.authors.length) {
        const ziel = data.institut || '';
        const eigene = data.authors.filter(a => ziel && a.institute === ziel).length;
        const liste = createEl('div');
        liste.style.cssText = 'max-height:220px; overflow:auto; font-size:13px; line-height:1.35;';
        data.authors.forEach(a => {
            const zeile = createEl('div');
            zeile.style.cssText = 'padding:2px 4px; border-radius:3px;'
                + (ziel && a.institute === ziel ? ' background:#e6fffa; border-left:3px solid #38b2ac;' : '');
            const name = [a.family, a.given].filter(Boolean).join(', ');
            const kopfTeile = [name];
            if (a.institute) kopfTeile.push('[' + a.institute.toUpperCase() + ']');
            if (a.corresponding) kopfTeile.push('✉');
            zeile.appendChild(createEl('b', '', kopfTeile.join(' ')));
            if (a.affiliations && a.affiliations.length) {
                const aff = createEl('div', '', a.affiliations.join(' · ') + (a.department ? '  ➜ Abteilung: ' + a.department : ''));
                aff.style.cssText = 'font-size:11px; color:#4a5568;';
                zeile.appendChild(aff);
            }
            liste.appendChild(zeile);
        });
        const titel = `Autoren und Affiliationen (${data.authors.length}${ziel ? ', davon ' + eigene + ' ' + ziel.toUpperCase() : ''}; nur Ansicht)`;
        abschnitt(null, titel, liste);

        // Uebernahme ins Formular: nur Autoren des bearbeiteten Instituts werden
        // ueber den Lookup verknuepft; das Corresponding-Tag gilt fuer alle vier
        if (ziel && eigene) {
            abschnitt('authors', `${eigene} ${ziel.toUpperCase()}-Autor${eigene > 1 ? 'en' : ''} verknüpfen (Lookup „Standardized Form of Name“)`,
                textBlock('Der Lookup liefert die Autorenobjekte zum Namen; du wählst je Autor aus. Die Einheit (Group/Department) setzt DORA bei der Auswahl.'), true);
        }
        // Nicht jedes Formular hat das Tag (z.B. das PSI-Buchkapitel): dann kein Angebot
        if (data.authors.some(a => a.corresponding) && findeCorrespondingFeld()) {
            const korrAutoren = data.authors.filter(a => a.corresponding);
            const wert = ziel && korrAutoren.some(a => a.institute === ziel) ? 'Yes' : 'No';
            const korr = korrAutoren.map(a => a.family + (a.institute ? ' [' + a.institute.toUpperCase() + ']' : ' [extern]')).join(', ');
            abschnitt('corresponding', ziel ? `Feld „${ziel.toUpperCase()} Corresponding Author“ auf ${wert} setzen` : 'Corresponding-Author-Tag setzen',
                textBlock('Corresponding Author laut PDF: ' + korr), !!ziel);
        }
    }
    const fp = data.funding_projects || { items: [], unsupported: [] };
    if (fp.items.length || fp.unsupported.length) {
        const vorhandene = new Set(readExistingFunding().filter(r => !r.isEmpty).map(r => fundingKey(r.funderName, r.awardNumber)));
        const feldDa = !!findFundingContainer();
        const neue = fp.items.filter(i => !vorhandene.has(fundingKey(i.funderName, i.awardNumber)));
        const liste = createEl('div');
        liste.style.cssText = 'font-size:13px; line-height:1.4;';
        fp.items.forEach(i => {
            const da = vorhandene.has(fundingKey(i.funderName, i.awardNumber));
            const z = createEl('div', '', (da ? '✅ ' : '➕ ') + (i.fundingStream || i.funderKey) + ' ' + i.awardNumber
                + (i.awardTitle ? ' – ' + i.awardTitle : '') + (da ? '  (steht schon im Formular)' : ''));
            liste.appendChild(z);
        });
        fp.unsupported.forEach(u => {
            const z = createEl('div', '', '🚫 ' + u.name + ' ' + u.awards.join(', ') + '  (nur SNSF und EC sind in DORA eintragbar)');
            z.style.color = '#718096';
            liste.appendChild(z);
        });
        abschnitt(feldDa && neue.length ? 'funding_projects' : null,
            `Funding-Projekte (${fp.items.length})` + (feldDa && neue.length ? ' eintragen' : ''),
            liste, true);
        if (feldDa && neue.length) {
            const h = createEl('div', '', 'Eingetragen wird nur, was DORAs Funding-Auswahlliste (Lookup) kennt; Titel und Stream kommen von dort.');
            h.style.cssText = 'font-size:11px; color:#718096; margin:2px 0 0 24px;';
            koerper.lastChild.appendChild(h);
        }
    }
    if (data.funding) {
        abschnitt(null, 'Funding / Acknowledgements (nur Ansicht)', textBlock(data.funding, 140));
    }
    if (data.research_facilities && data.research_facilities.length) {
        const feldDa = !!document.querySelector('select[name$="[facility]"]');
        const zeilen = data.research_facilities.map(r => r.facility + (r.beamline ? ' – ' + r.beamline : ''));
        abschnitt(feldDa ? 'facilities' : null,
            'Facilities & Beamlines' + (feldDa ? ` (${zeilen.length})` : ' (nur Ansicht – das Formular hat kein Panel dafür)'),
            textBlock(zeilen.join('\n')), true);
    }
    if (!Object.keys(auswahl).length) {
        koerper.appendChild(textBlock('Aus dem PDF ließ sich nichts zum Übernehmen lesen.'));
    }

    const fuss = createEl('div');
    fuss.style.cssText = 'padding:10px 16px; border-top:1px solid #e2e8f0; display:flex; gap:8px; justify-content:flex-end;';

    const schliessen = createEl('button', 'dora-box-btn btn-secondary', 'Schließen');
    schliessen.type = 'button';
    schliessen.style.width = 'auto';
    schliessen.onclick = () => overlay.remove();

    const uebernehmen = createEl('button', 'dora-box-btn', 'Ausgewählte übernehmen');
    uebernehmen.type = 'button';
    uebernehmen.style.width = 'auto';
    uebernehmen.disabled = !Object.keys(auswahl).length;
    uebernehmen.onclick = async () => {
        const gewaehlt = {};
        Object.keys(auswahl).forEach(feld => {
            if (auswahl[feld].checked && ['authors', 'corresponding', 'facilities', 'funding_projects', 'editors', 'supervisors'].indexOf(feld) === -1) gewaehlt[feld] = data[feld];
        });
        fillFormFromPdfData(gewaehlt);

        const autorenWahl = {
            autoren: !!(auswahl.authors && auswahl.authors.checked),
            corresponding: !!(auswahl.corresponding && auswahl.corresponding.checked),
            facilities: !!(auswahl.facilities && auswahl.facilities.checked),
            funding: !!(auswahl.funding_projects && auswahl.funding_projects.checked),
            editors: !!(auswahl.editors && auswahl.editors.checked),
            supervisors: !!(auswahl.supervisors && auswahl.supervisors.checked)
        };
        if (!autorenWahl.autoren && !autorenWahl.corresponding && !autorenWahl.facilities && !autorenWahl.funding && !autorenWahl.editors && !autorenWahl.supervisors) { overlay.remove(); return; }

        // Der Lookup braucht einige Sekunden: Popup bleibt offen und zeigt Fortschritt, dann den Bericht
        uebernehmen.disabled = true;
        schliessen.disabled = true;
        const status = createEl('div', '', '⏳ Übernahme läuft …');
        status.style.cssText = 'padding:8px 0;';
        koerper.replaceChildren(status);
        try {
            const bericht = await uebernehmeAutorenAusPdf(data, autorenWahl, (t) => { status.textContent = '⏳ ' + t; },
                (plan) => zeigeAutorAuswahl(koerper, plan, uebernehmen, schliessen, status));
            zeigeUebernahmeBericht(koerper, bericht);
        } catch (e) {
            koerper.replaceChildren(createEl('div', '', '❌ Übernahme abgebrochen: ' + e.message));
        }
        uebernehmen.style.display = 'none';
        schliessen.disabled = false;
        schliessen.textContent = 'Fertig';
    };

    fuss.appendChild(schliessen);
    fuss.appendChild(uebernehmen);
    dialog.appendChild(fuss);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function esc(e) {
        if (e.key !== 'Escape') return;
        overlay.remove();
        document.removeEventListener('keydown', esc);
    });
    document.body.appendChild(overlay);
}

// ---------------------------------------------------------------------------
// Autoren aus dem PDF ins Formular uebernehmen.
//
// Handbuch: jeder Autor des bearbeiteten Instituts muss ueber "Standardized
// Form of Name" mit seinem DORA-Autorenobjekt verknuepft sein; "Department"
// verlinkt auf die Abteilung. Darum wird nichts frei eingetippt, sondern der
// Lookup des Feldes benutzt (wie ein Klick auf einen Vorschlag der
// Autovervollstaendigung). Findet er den Autor nicht, bleibt das Feld leer und
// der Autor steht im Bericht - angelegt oder geraten wird nichts. Die
// Verknuepfung setzt DORA selbst: die Auswahl fuellt den pid-Wert und meist
// auch das Department.
// ---------------------------------------------------------------------------
function autorNormalisieren(text) {
    return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/[-\s]+/g, ' ').trim();
}

// Zahlenfolgen (z.B. Kennungen) gehoeren nicht in Berichte
function ohneNummern(text) {
    return String(text || '').replace(/\d{5,}/g, '********');
}

function autorPaneFelder(pane) {
    const q = (suffix) => pane.querySelector('input[type="text"][name$="' + suffix + '"]');
    const name = q('[valName]');
    const abteilung = q('[affiliation]');
    const pidVon = (el, suffix) => el ? pane.querySelector('input[name="' + el.name.replace(suffix, '[pid]') + '"]') : null;
    return {
        pane: pane,
        family: pane.querySelector('input[name$="[family]"]'),
        given: pane.querySelector('input[name$="[given]"]'),
        name: name, namePid: pidVon(name, '[valName]'),
        abteilung: abteilung, abteilungPid: pidVon(abteilung, '[affiliation]')
    };
}

// Zum PDF-Autor die Zeile im Formular suchen: Nachname (ohne Akzente, "von"
// u.ae. egal) und - falls beide da sind - der Anfangsbuchstabe des Vornamens
function findeAutorPane(autor, felder) {
    const fam = autorNormalisieren(autor.family);
    const vor = autorNormalisieren(autor.given).charAt(0);
    const passend = felder.filter(f => {
        const ff = autorNormalisieren(f.family && f.family.value);
        if (!ff || !fam) return false;
        const famGleich = ff === fam || ff.endsWith(' ' + fam) || fam.endsWith(' ' + ff);
        if (!famGleich) return false;
        const fv = autorNormalisieren(f.given && f.given.value).charAt(0);
        return !vor || !fv || vor === fv;
    });
    return passend.length === 1 ? passend[0] : (passend.length ? passend[0] : null);
}

function warteBis(bedingung, ms) {
    return new Promise(fertig => {
        const bis = Date.now() + ms;
        const pruefen = () => {
            let ok = false;
            try { ok = !!bedingung(); } catch (e) { /* weiter warten */ }
            if (ok) { fertig(true); return; }
            if (Date.now() > bis) { fertig(false); return; }
            setTimeout(pruefen, 100);
        };
        pruefen();
    });
}

// Suche im Autovervollstaendigungs-Feld; liefert die Vorschlagsliste
// ({li, text}) oder null, wenn das Feld nicht antwortet. Das Popup ist das
// gemeinsame Drupal-Element #autocomplete (wie bei der Journal-Abfrage).
async function autoLookup(input, suchtext) {
    const alt = document.getElementById('autocomplete');
    if (alt) alt.remove();
    input.value = suchtext;
    const posten = await journalVorschlaegeHolen(input, window, 7000);
    if (posten === null) return null;
    return posten.map(li => ({ li: li, text: journalPostenText(li) }));
}

// Passt ein Vorschlag zum Autor? Alle Nachnamen-Woerter und der Vornamen-
// Anfangsbuchstabe muessen im Text vorkommen.
function vorschlagPasstZuAutor(text, autor) {
    const t = ' ' + autorNormalisieren(text) + ' ';
    const famWoerter = autorNormalisieren(autor.family).split(' ').filter(w => w.length > 1 || autorNormalisieren(autor.family).length === 1);
    if (!famWoerter.every(w => t.indexOf(' ' + w) !== -1)) return false;
    const vor = autorNormalisieren(autor.given).split(' ').filter(Boolean);
    if (!vor.length) return true;
    return vor.some(w => t.indexOf(' ' + w.charAt(0)) !== -1);
}

// Phase 1: den Lookup des Feldes "Standardized Form of Name" befragen. Der
// Lookup liefert die Autorenobjekte zu einem Namen; welches das richtige ist,
// entscheidet der Benutzer. Vorbelegt wird nur, wenn genau ein Vorschlag zum
// Namen passt. Das Feld wird danach wieder auf seinen Ausgangswert gesetzt.
async function sucheAutorKandidaten(autor, f) {
    const eintrag = { autor: autor, felder: f, kandidaten: [], vorauswahl: -1, suchtext: '', status: 'kandidaten', hinweis: '' };
    if (!f.name) { eintrag.status = 'fehler'; eintrag.hinweis = 'Feld „Standardized Form of Name“ nicht gefunden'; return eintrag; }

    // Gespeichert ist die Form "Vorname Nachname"; je nach Suchindex trifft
    // aber auch "Nachname, Vorname" oder der Nachname allein
    const versuche = autor.given
        ? [autor.given + ' ' + autor.family, autor.family + ', ' + autor.given, autor.family]
        : [autor.family];

    const ausgang = f.name.value;
    let angetwortet = false;
    let roh = [];
    for (const suche of versuche) {
        const liste = await autoLookup(f.name, suche);
        if (liste === null) continue;
        angetwortet = true;
        const passend = liste.filter(p => vorschlagPasstZuAutor(p.text, autor));
        if (passend.length) {
            eintrag.kandidaten = passend.map(p => p.text);
            eintrag.suchtext = suche;
            eintrag.vorauswahl = passend.length === 1 ? 0 : -1;
            break;
        }
        if (!roh.length && liste.length) { roh = liste.map(p => p.text); eintrag.suchtext = suche; }
    }
    f.name.value = ausgang;
    const popup = document.getElementById('autocomplete');
    if (popup) popup.remove();

    if (!angetwortet) { eintrag.status = 'fehler'; eintrag.hinweis = 'Lookup hat nicht geantwortet'; return eintrag; }
    if (!eintrag.kandidaten.length) {
        // Nichts passt zum Namen: die Rohliste nur zur Ansicht, nicht zur Auswahl
        eintrag.status = 'keintreffer';
        eintrag.hinweis = roh.length
            ? 'kein Vorschlag passt zum Namen (Lookup lieferte: ' + roh.slice(0, 4).map(ohneNummern).join(' | ') + ') – Autor in DORA nicht angelegt?'
            : 'kein Treffer im Lookup – Autor in DORA nicht angelegt?';
    }
    return eintrag;
}

// Phase 2: den gewaehlten Vorschlag auswaehlen wie einen Klick in der Liste.
// Die Liste verschwindet beim Verlassen des Feldes, darum wird die Suche
// wiederholt und der Eintrag mit demselben Text gewaehlt.
async function uebernehmeAutorWahl(eintrag, gewaehlterText) {
    const { autor, felder: f } = eintrag;
    const bericht = { autor: [autor.family, autor.given].filter(Boolean).join(', '), schritte: [], status: 'ok' };
    const ausgang = f.name.value;

    const liste = await autoLookup(f.name, eintrag.suchtext);
    const treffer = (liste || []).find(p => p.text === gewaehlterText);
    if (!treffer) {
        f.name.value = ausgang;
        bericht.status = 'fehler';
        bericht.schritte.push('Der gewählte Vorschlag war bei der Wiederholung der Suche nicht mehr in der Liste');
        return bericht;
    }

    journalVorschlagWaehlen(treffer.li, f.name, window);
    const verknuepft = await warteBis(() => f.namePid && f.namePid.value.trim(), 3000);
    const popup = document.getElementById('autocomplete');
    if (popup) popup.remove();
    if (!verknuepft) {
        bericht.status = 'offen';
        bericht.schritte.push('ausgewählt, aber keine Verknüpfung entstanden: ' + ohneNummern(gewaehlterText));
        return bericht;
    }
    bericht.schritte.push('verknüpft: ' + ohneNummern(gewaehlterText));

    // Group/Department: DORA fuellt es bei der Auswahl meist selbst
    if (f.abteilung) {
        await warteBis(() => f.abteilung.value.trim() && f.abteilungPid && f.abteilungPid.value.trim(), 2500);
        const hat = f.abteilung.value.trim() && f.abteilungPid && f.abteilungPid.value.trim();
        if (hat) {
            bericht.schritte.push('Einheit: ' + ohneNummern(f.abteilung.value.trim()));
            if (autor.department) bericht.schritte.push('im PDF genannt: „' + autor.department + '“ (Handbuch: Angabe der Vorlage gilt – bitte vergleichen)');
        } else {
            bericht.status = 'offen';
            bericht.schritte.push('Einheit (Group/Department) nicht automatisch gefüllt'
                + (autor.department ? '; im PDF genannt: „' + autor.department + '“' : '') + ' – bitte im Feld selbst auswählen');
        }
    }
    return bericht;
}

// Das Corresponding-Author-Feld des Formulars: Beschriftung mit "corresponding",
// aber nicht die E-Mail-Adresse. Die Form des Feldes (Auswahl, Haken, Text)
// ist nicht fest - alle drei werden bedient.
function findeCorrespondingFeld() {
    // Bekanntes Feld: Select correspAuthor4RI ("<Institut> Corresponding Author", Yes/No)
    const bekannt = document.querySelector('select[name="correspAuthor4RI"]');
    if (bekannt) return { huelle: bekannt.closest('.form-item') || bekannt.parentElement, feld: bekannt, alle: [] };

    const labels = Array.from(document.querySelectorAll('label, legend'));
    for (const label of labels) {
        const text = (label.textContent || '').toLowerCase();
        if (!/corresponding/.test(text) || /mail/.test(text)) continue;
        const huelle = label.closest('.form-item') || label.closest('fieldset') || label.parentElement;
        const feld = huelle && huelle.querySelector('select, input[type="checkbox"], input[type="radio"], input[type="text"]');
        if (feld) return { huelle: huelle, feld: feld, alle: huelle.querySelectorAll('input[type="radio"]') };
    }
    return null;
}

function setzeCorrespondingFeld(ziel, ja) {
    const f = ziel.feld;
    const gewuenscht = ja ? /^(yes|ja|true|1)$/i : /^(no|nein|false|0)$/i;
    if (f.tagName === 'SELECT') {
        const opt = Array.from(f.options).find(o => gewuenscht.test((o.textContent || '').trim()) || gewuenscht.test(o.value));
        if (!opt) return false;
        f.value = opt.value;
    } else if (f.type === 'checkbox') {
        f.checked = ja;
    } else if (f.type === 'radio') {
        const r = Array.from(ziel.alle).find(x => {
            const l = ziel.huelle.querySelector('label[for="' + x.id + '"]');
            return gewuenscht.test(x.value) || (l && gewuenscht.test((l.textContent || '').trim()));
        });
        if (!r) return false;
        r.checked = true;
        r.dispatchEvent(new Event('input', { bubbles: true }));
        r.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    } else {
        f.value = ja ? 'Yes' : 'No';
    }
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

// Ziel und Ablauf: optionen = {autoren: bool, corresponding: bool}
// Facilities & Beamlines (PSI): je Eintrag eine Zeile im Fieldpanel. Haiku
// waehlt aus denselben Listen wie das Formular; geschrieben wird trotzdem nur,
// was das Select kennt, und danach wird nachgelesen (writeFundingField).
async function uebernehmeFacilities(items, bericht) {
    const behaelter = () => {
        const huelle = document.querySelector('.form-item-extension-research-facilities');
        return huelle ? (huelle.closest('.islandora-form-fieldpanel-container') || huelle.parentElement) : null;
    };
    if (!behaelter()) {
        bericht.push({ autor: 'Facilities & Beamlines', status: 'fehler', schritte: ['Panel im Formular nicht gefunden'] });
        return;
    }
    const zeilen = () => Array.from(behaelter().querySelectorAll('.islandora-form-fieldpanel-pane')).map(pane => ({
        pane: pane,
        facility: pane.querySelector('select[name$="[facility]"]'),
        beamline: pane.querySelector('select[name$="[beamline]"]')
    }));

    for (const item of items) {
        const name = item.facility + (item.beamline ? ' – ' + item.beamline : '');
        let rows = zeilen();
        if (rows.some(r => r.facility && r.facility.value === item.facility && (r.beamline ? r.beamline.value : '') === (item.beamline || ''))) {
            bericht.push({ autor: name, status: 'ok', schritte: ['steht bereits im Formular'] });
            continue;
        }

        let ziel = rows.find(r => r.facility && !r.facility.value && r.beamline && !r.beamline.value);
        if (!ziel) {
            await addMissingRows(behaelter, rows.length + 1);
            rows = zeilen();
            ziel = rows.find(r => r.facility && !r.facility.value && r.beamline && !r.beamline.value);
        }
        if (!ziel) {
            bericht.push({ autor: name, status: 'fehler', schritte: ['keine freie Zeile gefunden und keine neue angelegt'] });
            continue;
        }

        const fs = await writeFundingField(ziel.facility, item.facility);
        if (!/^(ok|repaired)/.test(fs)) {
            bericht.push({ autor: name, status: 'fehler', schritte: ['Facility „' + item.facility + '“ nicht setzbar (' + fs + ')'] });
            continue;
        }
        const schritte = ['Facility gesetzt'];
        let status = 'ok';
        if (item.beamline) {
            // Die Facility kann die Beamline-Liste neu laden
            await new Promise(r => setTimeout(r, 400));
            const bs = await writeFundingField(ziel.beamline, item.beamline);
            if (/^(ok|repaired)/.test(bs)) schritte.push('Beamline gesetzt');
            else { status = 'offen'; schritte.push('Beamline „' + item.beamline + '“ nicht setzbar (' + bs + ') – bitte selbst wählen'); }
        }
        bericht.push({ autor: name, status: status, schritte: schritte });
        await new Promise(r => setTimeout(r, 250));
    }
}

// Funding aus dem PDF: je Projekt derselbe Weg wie im Funding-Panel
// (applyFundingItem). Der Lookup in DORAs Auswahlliste entscheidet; ohne Beleg
// wird nichts geschrieben.
async function uebernehmeFundingAusPdf(items, bericht, meldung) {
    if (!findFundingContainer()) {
        bericht.push({ autor: 'Funding', status: 'fehler', schritte: ['Funding-Bereich im Formular nicht gefunden'] });
        return;
    }
    let nr = 0;
    for (const item of items) {
        const name = (item.fundingStream || item.funderKey) + ' ' + item.awardNumber;
        const vorhandene = new Set(readExistingFunding().filter(r => !r.isEmpty).map(r => fundingKey(r.funderName, r.awardNumber)));
        if (vorhandene.has(fundingKey(item.funderName, item.awardNumber))) {
            bericht.push({ autor: name, status: 'ok', schritte: ['steht bereits im Formular'] });
            continue;
        }
        meldung(`Funding ${++nr}: ${name} …`);
        try {
            item.doraEntry = await lookupDoraFundingEntry(item);
            const res = await applyFundingItem(item);
            if (res.blocked) {
                const e = item.doraEntry;
                bericht.push({
                    autor: name, status: 'offen',
                    schritte: [res.blocked === 'not-in-vocabulary'
                        ? (e && e.wrongFunder ? 'in DORAs Liste gehört die Nummer zu einem Projekt von ' + e.otherStream : 'nicht in DORAs Funding-Auswahlliste – nicht eintragbar')
                        : 'Abgleich mit DORAs Auswahlliste fehlgeschlagen – nichts geschrieben']
                });
                continue;
            }
            const sc = res.skipped && res.skipped.length ? 'nicht gesetzt: ' + res.skipped.join(', ') : '';
            bericht.push({
                autor: name, status: sc ? 'offen' : 'ok',
                schritte: ['eingetragen' + (item.awardTitle ? ': ' + item.awardTitle : '')].concat(sc ? [sc] : [])
            });
        } catch (e) {
            bericht.push({ autor: name, status: 'fehler', schritte: [e.message] });
        }
        await new Promise(r => setTimeout(r, 250));
    }
}

// Personenlisten ohne Lookup (Herausgeber, Betreuer): Fieldpanel mit je einer
// Zeile aus Nachname und Vorname. Die Formulare nennen die Felder verschieden.
const PDF_PERSONEN_PANELS = {
    editors: { selector: '.form-item-host-editor', family: ['[familyEditor]', '[family]'], given: ['[givenEditor]', '[given]'], titel: 'Editors', label: /^editor/i },
    supervisors: { selector: '.form-item-supervisor', family: ['[family]'], given: ['[given]'], titel: 'Supervisors', label: /^supervisor/i }
};

// Panel einer Personenliste: erst die bekannte Klasse, sonst ueber die Beschriftung
// ("Editor(s)", "Supervisor(s)") bei abweichenden Formularen
function findePersonenPanel(art) {
    const cfg = PDF_PERSONEN_PANELS[art];
    const direkt = document.querySelector(cfg.selector);
    if (direkt) return direkt;
    for (const label of document.querySelectorAll('label')) {
        if (cfg.label.test(pdfLabelText(label)) && label.closest('.form-item-fieldpanel, .form-type-fieldpanel')) {
            return label.closest('.form-item');
        }
    }
    return null;
}

function personenFeld(pane, namen) {
    for (const n of namen) {
        const el = pane.querySelector('input[name$="' + n + '"]');
        if (el) return el;
    }
    return null;
}

function lesePersonenImFormular(art) {
    const cfg = PDF_PERSONEN_PANELS[art];
    const huelle = cfg && findePersonenPanel(art);
    if (!huelle) return [];
    return Array.from(huelle.querySelectorAll('.islandora-form-fieldpanel-pane')).map(pane => {
        const f = personenFeld(pane, cfg.family);
        const g = personenFeld(pane, cfg.given);
        return [f ? f.value.trim() : '', g ? g.value.trim() : ''].filter(Boolean).join(', ');
    }).filter(Boolean);
}

async function uebernehmePersonen(art, personen, bericht) {
    const cfg = PDF_PERSONEN_PANELS[art];
    if (!findePersonenPanel(art)) {
        bericht.push({ autor: cfg.titel, status: 'fehler', schritte: ['Panel im Formular nicht gefunden'] });
        return;
    }
    await addMissingRows(() => findePersonenPanel(art), personen.length);
    const panes = Array.from(findePersonenPanel(art).querySelectorAll('.islandora-form-fieldpanel-pane'));
    let gesetzt = 0;
    personen.forEach((p, i) => {
        const pane = panes[i];
        if (!pane) return;
        const f = personenFeld(pane, cfg.family);
        const g = personenFeld(pane, cfg.given);
        if (!f) return;
        setzePdfFeld(f, p.family);
        if (g) { g.value = p.given || ''; g.dispatchEvent(new Event('input', { bubbles: true })); g.dispatchEvent(new Event('change', { bubbles: true })); }
        gesetzt++;
    });
    bericht.push({
        autor: cfg.titel, status: gesetzt === personen.length ? 'ok' : 'offen',
        schritte: [gesetzt + ' von ' + personen.length + ' eingetragen' + (gesetzt < personen.length ? ' – Zeilen fehlen, bitte „Add" prüfen' : '')]
    });
}

async function uebernehmeAutorenAusPdf(data, optionen, meldung, waehlen) {
    const bericht = [];
    const ziel = data.institut || '';
    const autoren = data.authors || [];

    if (optionen.autoren) {
        if (!ziel) {
            bericht.push({ autor: 'Autoren', status: 'fehler', schritte: ['Institut der Seite unbekannt (Pfad /eawag/, /empa/, /wsl/ oder /psi/ fehlt)'] });
        } else {
            const felder = kiAutorenPanes(document).map(autorPaneFelder);
            const eigene = autoren.filter(a => a.institute === ziel);
            const plan = [];
            let nr = 0;
            for (const autor of eigene) {
                meldung(`Lookup ${++nr} von ${eigene.length}: ${autor.family} …`);
                const name = [autor.family, autor.given].filter(Boolean).join(', ');
                const pane = findeAutorPane(autor, felder);
                if (!pane) {
                    bericht.push({ autor: name, status: 'offen', schritte: ['steht nicht im Formular (Autorenzeile fehlt)'] });
                    continue;
                }
                if (pane.namePid && pane.namePid.value.trim() && pane.name && pane.name.value.trim()) {
                    bericht.push({ autor: name, status: 'ok', schritte: ['bereits verknüpft: ' + ohneNummern(pane.name.value.trim())] });
                    continue;
                }
                const eintrag = await sucheAutorKandidaten(autor, pane);
                if (eintrag.status === 'kandidaten') plan.push(eintrag);
                else bericht.push({ autor: name, status: eintrag.status === 'fehler' ? 'fehler' : 'offen', schritte: [eintrag.hinweis] });
                await new Promise(r => setTimeout(r, 250));   // Server schonen
            }

            // Der Benutzer waehlt je Autor aus der Liste des Lookups
            if (plan.length) {
                const wahl = await waehlen(plan);
                if (plan.abgebrochen) return bericht;   // Abbruch: auch das Corresponding-Tag bleibt unberuehrt
                let n = 0;
                for (let i = 0; i < plan.length; i++) {
                    const name = [plan[i].autor.family, plan[i].autor.given].filter(Boolean).join(', ');
                    if (wahl[i] === null || wahl[i] === undefined) {
                        bericht.push({ autor: name, status: 'info', schritte: ['nicht verknüpft (keine Auswahl getroffen)'] });
                        continue;
                    }
                    meldung(`Verknüpfe ${++n}: ${plan[i].autor.family} …`);
                    bericht.push(await uebernehmeAutorWahl(plan[i], plan[i].kandidaten[wahl[i]]));
                    await new Promise(r => setTimeout(r, 250));
                }
            }

            autoren.filter(a => a.institute && a.institute !== ziel).forEach(a => {
                bericht.push({ autor: [a.family, a.given].filter(Boolean).join(', '), status: 'info', schritte: ['gehört laut PDF zur ' + a.institute.toUpperCase() + ' – nicht verknüpft'] });
            });
        }
    }

    if (optionen.corresponding) {
        const korr = autoren.filter(a => a.corresponding);
        const feld = findeCorrespondingFeld();
        if (!ziel) {
            bericht.push({ autor: 'Corresponding Author', status: 'fehler', schritte: ['Institut der Seite unbekannt – Tag nicht gesetzt'] });
        } else if (!korr.length) {
            bericht.push({ autor: 'Corresponding Author', status: 'info', schritte: ['im PDF nicht gekennzeichnet – Tag nicht gesetzt'] });
        } else if (!feld) {
            bericht.push({ autor: 'Corresponding Author', status: 'fehler', schritte: ['Feld im Formular nicht gefunden (Select correspAuthor4RI bzw. Beschriftung mit „corresponding“)'] });
        } else {
            // Das Feld sagt: "Der Corresponding Author ist ein Autor des Instituts" - nicht irgendeines der vier
            const ja = korr.some(a => a.institute === ziel);
            const vorher = feld.feld.tagName === 'SELECT' && feld.feld.selectedIndex >= 0
                ? (feld.feld.options[feld.feld.selectedIndex].textContent || '').trim() : '';
            const gewollt = ja ? 'Yes' : 'No';
            const namen = korr.map(a => a.family + (a.institute ? ' [' + a.institute.toUpperCase() + ']' : ' [extern]')).join(', ');
            if (vorher === gewollt) {
                bericht.push({ autor: 'Corresponding Author', status: 'ok', schritte: ['steht bereits auf ' + gewollt + ' (' + namen + ')'] });
            } else {
                const ok = setzeCorrespondingFeld(feld, ja);
                bericht.push({
                    autor: 'Corresponding Author', status: ok ? 'ok' : 'fehler',
                    schritte: [ok ? 'auf ' + gewollt + ' gesetzt' + (vorher && vorher !== '---' ? ' (vorher: ' + vorher + ')' : '') + ' – ' + namen
                        : 'Feld gefunden, aber Wert Yes/No nicht setzbar']
                });
            }
        }
    }

    if (optionen.facilities) {
        meldung('Facilities & Beamlines …');
        await uebernehmeFacilities(data.research_facilities || [], bericht);
    }

    for (const art of Object.keys(PDF_PERSONEN_PANELS)) {
        if (!optionen[art]) continue;
        meldung(PDF_PERSONEN_PANELS[art].titel + ' …');
        await uebernehmePersonen(art, data[art] || [], bericht);
    }

    if (optionen.funding) {
        const fp = data.funding_projects || { items: [] };
        await uebernehmeFundingAusPdf(fp.items, bericht, meldung);
    }

    try { validateForm(); } catch (e) { /* nur Auffrischen der Pruefung */ }
    return bericht;
}

// Auswahl der Autorenobjekte: je Autor die Vorschlaege des Lookups. Liefert ein
// Array mit dem gewaehlten Index je Plan-Eintrag (null = nicht verknuepfen).
function zeigeAutorAuswahl(koerper, plan, uebernehmen, schliessen, status) {
    return new Promise(fertig => {
        koerper.replaceChildren();
        const kopf = createEl('div', '', 'Der Lookup hat zu diesen Autoren Autorenobjekte gefunden – bitte auswählen:');
        kopf.style.cssText = 'padding:4px 0 8px; font-weight:600;';
        koerper.appendChild(kopf);

        const selects = plan.map(eintrag => {
            const zeile = createEl('div');
            zeile.style.cssText = 'padding:6px 0; border-bottom:1px solid #edf2f7;';
            const a = eintrag.autor;
            zeile.appendChild(createEl('div', '', [a.family, a.given].filter(Boolean).join(', ')
                + (a.affiliations && a.affiliations.length ? '  –  ' + a.affiliations.join(' · ') : '')));
            zeile.firstChild.style.cssText = 'font-weight:600; font-size:13px;';

            const sel = createEl('select');
            sel.style.cssText = 'margin-top:3px; max-width:100%; font-size:13px;';
            const leer = createEl('option', '', eintrag.vorauswahl < 0 ? '— bitte wählen / nicht verknüpfen —' : '— nicht verknüpfen —');
            leer.value = '';
            sel.appendChild(leer);
            eintrag.kandidaten.forEach((text, i) => {
                const o = createEl('option', '', ohneNummern(text));
                o.value = String(i);
                sel.appendChild(o);
            });
            if (eintrag.vorauswahl >= 0) sel.value = String(eintrag.vorauswahl);
            zeile.appendChild(sel);
            koerper.appendChild(zeile);
            return sel;
        });

        const los = createEl('button', 'dora-box-btn', 'Auswahl verknüpfen');
        los.type = 'button';
        los.style.cssText = 'width:auto; margin-top:10px;';
        koerper.appendChild(los);

        schliessen.disabled = false;
        schliessen.textContent = 'Abbrechen';
        const abbrechen = () => { plan.abgebrochen = true; fertig(plan.map(() => null)); };
        schliessen.addEventListener('click', abbrechen, { once: true });

        los.onclick = () => {
            schliessen.removeEventListener('click', abbrechen);
            schliessen.disabled = true;
            const wahl = selects.map(sel => sel.value === '' ? null : parseInt(sel.value, 10));
            koerper.replaceChildren(status);
            status.textContent = '⏳ Autoren werden verknüpft …';
            fertig(wahl);
        };
    });
}

function zeigeUebernahmeBericht(koerper, bericht) {
    koerper.replaceChildren();
    const farbe = { ok: '#2f855a', offen: '#b7791f', fehler: '#c53030', info: '#718096' };
    const symbol = { ok: '✅', offen: '⚠️', fehler: '❌', info: 'ℹ️' };
    if (!bericht.length) koerper.appendChild(createEl('div', '', 'Nichts zu übernehmen.'));
    bericht.forEach(b => {
        const zeile = createEl('div');
        zeile.style.cssText = 'padding:5px 0; border-bottom:1px solid #edf2f7; font-size:13px;';
        const kopf = createEl('b', '', (symbol[b.status] || '') + ' ' + b.autor);
        kopf.style.color = farbe[b.status] || '#333';
        zeile.appendChild(kopf);
        b.schritte.forEach(t => {
            const d = createEl('div', '', t);
            d.style.cssText = 'font-size:12px; color:#4a5568; margin-left:22px;';
            zeile.appendChild(d);
        });
        koerper.appendChild(zeile);
    });
}

// Nach der PDF-Suche: der beste geprueft erreichbare Volltext geht ohne
// weiteres Zutun an Haiku. Je DOI nur einmal pro Seitenaufruf (jede
// Auswertung kostet), nur mit hinterlegtem Schluessel und abschaltbar.
const haikuAutoGestartet = new Set();

// Kleine Statusmeldung unten rechts; die Dropzone ist standardmaessig verborgen
function zeigeHaikuHinweis(text) {
    let el = document.getElementById('dora-haiku-hinweis');
    if (!el) {
        el = createEl('div');
        el.id = 'dora-haiku-hinweis';
        el.style.cssText = 'position:fixed; left:16px; bottom:16px; z-index:2147482000; max-width:360px; '
            + 'padding:8px 12px; background:#fffbea; border:1px solid #d69e2e; border-radius:4px; '
            + 'font:13px sans-serif; color:#333; box-shadow:0 2px 8px rgba(0,0,0,.2);';
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.background = '#fffbea';
    el.style.borderColor = '#d69e2e';
    el.style.paddingRight = '12px';
    clearTimeout(el._doraTimer);
    return el;
}

function starteHaikuAuswertung(doi, kandidat) {
    if (!doi || !kandidat || haikuAutoGestartet.has(doi)) return;
    // Einseitige Vorschau-PDFs enthalten keinen Abstract
    if (kandidat.nurVorschau) return;
    chrome.storage.local.get({ anthropicApiKey: '', haikuAutoAnalyse: true }, (e) => {
        if (chrome.runtime.lastError || !e.anthropicApiKey || !e.haikuAutoAnalyse) return;
        if (haikuAutoGestartet.has(doi)) return;
        haikuAutoGestartet.add(doi);

        const hinweis = zeigeHaikuHinweis('⏳ Haiku liest das PDF …');

        const auftrag = { action: 'analyzePdfHaiku', institut: aktuellesInstitut(doi) };
        if (kandidat.elsevierApi) auftrag.elsevierDoi = doi; else auftrag.url = kandidat.url;
        chrome.runtime.sendMessage(auftrag, (antwort) => {
            if (chrome.runtime.lastError || !antwort || !antwort.success) {
                // Fehlschlag darf wiederholt werden (z.B. nach neuer Suche)
                haikuAutoGestartet.delete(doi);
                const grund = (antwort && antwort.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'keine Antwort';
                console.warn('Haiku-Auswertung fehlgeschlagen:', grund);
                hinweis.remove();
                zeigePdfFehler('PDF-Auswertung fehlgeschlagen: ' + grund);
                return;
            }
            hinweis.remove();
            kiPdfErgebnisse.set(doi.toLowerCase(), antwort.data);
            confirmAndFillPdfData(antwort.data, 'url');
        });
    });
}

// Einfache Bibliografiefelder, die Haiku aus dem PDF liest. Ein Abschnitt im
// Popup erscheint nur, wenn das aktuelle Formular das Feld hat - so zeigt jede
// Publikationsart nur ihre eigenen Felder (Buchtitel, Konferenz, Serie ...).
const PDF_FELDER = {
    language: { ids: ['edit-language-languageterm'], titel: 'Language', labels: ['Language'] },
    volume: { ids: ['edit-host-part-volume'], titel: 'Volume', labels: ['Volume'], nichtIn: /series/i },
    issue: { ids: ['edit-host-part-issue'], titel: 'Issue', labels: ['Issue'] },
    container_title: { ids: ['edit-host-booktitle', 'edit-host-titleinfo-title'], titel: 'Buch-/Proceedings-Titel', labels: ['Book Title', 'Title of the Conference Proceedings', 'Proceedings Title'] },
    conference_name: { ids: ['edit-confinfo-confname', 'edit-conference-name'], titel: 'Conference Name', labels: ['Conference Name'] },
    conference_place: { ids: ['edit-confinfo-confplace'], titel: 'Conference Place', labels: ['Conference Place'] },
    conference_date: { ids: ['edit-confinfo-start'], titel: 'Conference Date', labels: ['Conference Date'] },
    series_title: { ids: ['edit-host-series-titleinfo-title', 'edit-series-titleinfo-title'], titel: 'Series Title', labels: ['Title'], nurIn: /series/i },
    series_volume: { ids: ['edit-host-series-titleinfo-volume'], titel: 'Series Volume', labels: ['Volume'], nurIn: /series/i },
    series_issn: { ids: ['edit-host-series-issn', 'edit-host-series-titleinfo-issn', 'edit-series-issn'], titel: 'Series ISSN', labels: ['ISSN'], nurIn: /series/i },
    publisher: { ids: ['edit-host-origininfo1-0-publisher', 'edit-host-origininfo-0-publisher', 'edit-origininfo-publisher'], titel: 'Publisher', labels: ['Publisher'] },
    publication_place: { ids: ['edit-host-origininfo1-0-place', 'edit-host-origininfo-0-place', 'edit-origininfo-place'], titel: 'Publication Place', labels: ['Publication Place'] },
    edition: { ids: ['edit-host-origininfo1-0-edition'], titel: 'Edition', labels: ['Edition'] },
    isbn: { ids: ['edit-identifiers-isbn'], titel: 'ISBN', labels: ['ISBN'] },
    report_number: { ids: ['edit-identifiers-reportnbr'], titel: 'Report Number', labels: ['Report Number'] },
    sponsor: { ids: ['edit-sponsor'], titel: 'Sponsoring Organization', labels: ['Sponsoring Organization'] },
    academic_title: { ids: ['edit-acatitle'], titel: 'Academic Title', labels: ['Academic title'] },
    degree_granting_institution: { ids: ['edit-deggraninst'], titel: 'Degree Granting Institution', labels: ['Degree Granting Institution'] },
    year: { ids: ['edit-origininfodate-0-dateissued', 'edit-origininfo-dateissued', 'edit-dateissued'], titel: 'Publication Year', labels: ['Publication Year'] }
};
// Reihenfolge im Popup und beim Eintragen (Language wird dabei gesondert angezeigt)
const PDF_FELD_REIHENFOLGE = ['language', 'volume', 'issue', 'container_title', 'conference_name', 'conference_place', 'conference_date', 'series_title',
    'series_volume', 'series_issn', 'publisher', 'publication_place', 'edition', 'isbn', 'report_number', 'sponsor', 'academic_title', 'degree_granting_institution', 'year'];
const PDF_SEITEN_IDS = { start: 'edit-host-part-pages-start', end: 'edit-host-part-pages-end' };

// Beschriftungstext eines Labels ohne Pflichtstern, Tooltips und Unterelemente
function pdfLabelText(label) {
    const eigener = Array.from(label.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' ');
    return eigener.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
}

// Rueckfall, wenn die bekannten IDs im Formular fehlen (z.B. PSI nutzt teils
// andere Namen): ein Feld ueber die Beschriftung finden. Der Treffer muss
// eindeutig sein; mit nurIn/nichtIn laesst sich nach der Fieldset-Ueberschrift
// unterscheiden ("Volume" der Zeitschrift gegen "Volume" der Serie).
function pdfFeldPerBeschriftung(spec) {
    const treffer = [];
    document.querySelectorAll('label').forEach(label => {
        if (label.closest('#dora-haiku-popup, #dora-ki-panel, .dora-handbuch-kasten')) return;
        const text = pdfLabelText(label);
        if (!spec.labels.some(l => l.toLowerCase() === text.toLowerCase())) return;

        let el = label.htmlFor ? document.getElementById(label.htmlFor) : null;
        if (!el) {
            const huelle = label.closest('.form-item');
            el = huelle && huelle.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea, select');
        }
        if (!el || el.disabled || el.type === 'hidden') return;

        const set = el.closest('fieldset');
        const legende = set && set.querySelector(':scope > legend');
        const kontext = legende ? legende.textContent : '';
        if (spec.nurIn && !spec.nurIn.test(kontext)) return;
        if (spec.nichtIn && spec.nichtIn.test(kontext)) return;
        if (treffer.indexOf(el) === -1) treffer.push(el);
    });
    return treffer.length === 1 ? treffer[0] : null;
}

function pdfFeldElement(schluessel) {
    const spec = PDF_FELDER[schluessel];
    if (!spec) return null;
    for (const id of spec.ids) {
        const el = document.getElementById(id);
        if (el) return el;
    }
    return spec.labels ? pdfFeldPerBeschriftung(spec) : null;
}

// Start-/End-Page und das einzelne Pages-Feld (Berichte, Abschlussarbeiten)
function pdfSeitenElement(art) {
    const el = document.getElementById(PDF_SEITEN_IDS[art]);
    if (el) return el;
    return pdfFeldPerBeschriftung({ labels: [art === 'start' ? 'Start Page' : 'End Page'] });
}

function pdfGesamtSeitenElement() {
    const el = document.getElementById('edit-pages');
    if (el) return el;
    const kandidat = pdfFeldPerBeschriftung({ labels: ['Pages'] });
    return kandidat && kandidat.tagName !== 'SELECT' ? kandidat : null;
}

function pdfVergleichText(t) {
    return String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Aktueller Wert eines Feldes als Anzeigetext (bei Auswahlfeldern der Optionstext)
function pdfFeldAnzeige(el) {
    if (!el) return '';
    if (el.tagName === 'SELECT') {
        const opt = el.options[el.selectedIndex];
        return el.value ? (opt ? opt.textContent.trim() : el.value) : '';
    }
    return (el.value || '').trim();
}

function setzePdfFeld(el, wert) {
    if (!el || wert === null || wert === undefined || wert === '') return false;
    if (el.tagName === 'SELECT') {
        const opt = Array.from(el.options).find(o => o.value === wert || o.textContent.trim() === wert);
        if (!opt) return false;
        el.value = opt.value;
    } else {
        el.value = wert;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

// Seitenangabe nach den DORA-Regeln: Start und End Page laut gedruckter Zaehlung,
// sonst "Artikelnummer (N pp.)", sonst nur die Seitenzahl "(N pp.)".
function seitenVorschlag(data) {
    const n = data.page_count;
    const von = data.first_page, bis = data.last_page, an = data.article_number;
    if (von && bis && von !== bis) return { start: von, end: bis, anzeige: `${von}–${bis}` };
    if (an) {
        const start = n ? `${an} (${n} pp.)` : an;
        return { start: start, end: '', anzeige: start };
    }
    if (von && von === bis) return { start: von, end: '', anzeige: von + ' (eine Seite)' };
    if (n) return { start: `(${n} pp.)`, end: '', anzeige: `(${n} pp.)`, nurAnzahl: true };
    return null;
}

const TITEL_FELD_ID = 'edit-titleinfo-title-text-format-value';
const TITEL_ERLAUBTE_TAGS = ['SUB', 'SUP', 'EM', 'U', 'BR'];

// Aktueller Titel im Formular als reiner Text (leer, wenn keiner eingetragen ist)
function leseTitelImFormular() {
    const feld = document.getElementById(TITEL_FELD_ID);
    if (!feld) return null;
    const cke = document.getElementById('cke_' + TITEL_FELD_ID);
    const iframe = cke && cke.querySelector('iframe');
    if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
        return (iframe.contentDocument.body.textContent || '').trim();
    }
    const doc = new DOMParser().parseFromString(feld.value || '', 'text/html');
    return (doc.body.textContent || '').trim();
}

// Titel mit den im DORA-Titelfeld erlaubten Auszeichnungen (Tief-/Hochstellung,
// Kursiv, Unterstrichen) ins Formular schreiben. Alles andere wird auf den Text
// reduziert; der Titel kommt vom Modell und wird nicht ungeprueft als HTML gesetzt.
function setzeTitelImFormular(html) {
    const feld = document.getElementById(TITEL_FELD_ID);
    if (!feld || !html) return false;

    const quelle = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html').body;
    const bauen = (von, ziel, ziel_doc) => {
        von.childNodes.forEach(k => {
            if (k.nodeType === 3) ziel.appendChild(ziel_doc.createTextNode(k.textContent));
            else if (k.nodeType === 1) {
                if (k.tagName === 'SCRIPT' || k.tagName === 'STYLE') return;
                if (TITEL_ERLAUBTE_TAGS.indexOf(k.tagName) !== -1) {
                    const el = ziel_doc.createElement(k.tagName.toLowerCase());
                    bauen(k, el, ziel_doc);
                    ziel.appendChild(el);
                } else bauen(k, ziel, ziel_doc);
            }
        });
    };

    const cke = document.getElementById('cke_' + TITEL_FELD_ID);
    const iframe = cke && cke.querySelector('iframe');
    if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
        const body = iframe.contentDocument.body;
        body.replaceChildren();
        bauen(quelle, body, iframe.contentDocument);
        return true;
    }
    const huelle = document.createElement('div');
    bauen(quelle, huelle, document);
    feld.value = huelle.innerHTML;
    feld.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}

const ABSTRACT_FELD_ID = 'edit-abstract0-abstract-text-format-value';

// Abstract ins Formular schreiben - mit CKEditor oder als einfaches Textfeld
function setzeAbstractImFormular(text) {
    const abstractEl = document.getElementById(ABSTRACT_FELD_ID);
    if (!abstractEl || !text) return false;
    const sauber = text.trim();

    // Check if CKEditor is active
    const cke = document.getElementById('cke_' + ABSTRACT_FELD_ID);
    if (cke) {
        const iframe = cke.querySelector('iframe');
        if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
            // Use DOM manipulation for safe paragraph insertion
            const body = iframe.contentDocument.body;
            body.replaceChildren();
            sauber.split(/\n\n+/).forEach((para, idx) => {
                if (idx > 0) body.appendChild(iframe.contentDocument.createElement('br'));
                body.appendChild(iframe.contentDocument.createTextNode(para));
            });
            return true;
        }
        return false;
    }
    abstractEl.value = sauber;
    abstractEl.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}

// Aktueller Abstract-Text im Formular (leer, wenn keiner eingetragen ist)
function leseAbstractImFormular() {
    const abstractEl = document.getElementById(ABSTRACT_FELD_ID);
    if (!abstractEl) return null;
    const cke = document.getElementById('cke_' + ABSTRACT_FELD_ID);
    const iframe = cke && cke.querySelector('iframe');
    if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
        return (iframe.contentDocument.body.textContent || '').trim();
    }
    return (abstractEl.value || '').trim();
}

function fillFormFromPdfData(data) {
    let msg = "Daten wurden übernommen.\n";

    // 1. Page Count
    if (data.page_count) {
        const startPageEl = document.getElementById('edit-host-part-pages-start') || document.querySelector('input[name$="[pages][start]"]');
        const endPageEl = document.getElementById('edit-host-part-pages-end') || document.querySelector('input[name$="[pages][end]"]');

        if (startPageEl && endPageEl) {
            const startVal = startPageEl.value.trim();
            const endVal = endPageEl.value.trim();

            // Only if End Page is empty
            if (!endVal) {
                // Check if already has (XX pp.)
                if (!startVal.includes('(')) {
                    const newVal = startVal ? `${startVal} (${data.page_count} pp.)` : `(${data.page_count} pp.)`;
                    startPageEl.value = newVal;
                    startPageEl.dispatchEvent(new Event('input', { bubbles: true }));
                    msg += `- Start Page aktualisiert: ${newVal}\n`;
                }
            }
        }
    }

    // 0. Einfache Felder aus dem Popup (nur die angehakten kommen hier an)
    if (data.pages) {
        const st = pdfSeitenElement('start');
        const en = pdfSeitenElement('end');
        if (st && setzePdfFeld(st, data.pages.start)) msg += '- Start Page: ' + data.pages.start + '\n';
        if (en) {
            if (data.pages.end) setzePdfFeld(en, data.pages.end);
            else if (en.value) { en.value = ''; en.dispatchEvent(new Event('input', { bubbles: true })); }
        }
    }
    if (data.pages_total && setzePdfFeld(pdfGesamtSeitenElement(), data.pages_total)) msg += '- Pages: ' + data.pages_total + '\n';
    PDF_FELD_REIHENFOLGE.forEach(k => {
        if (data[k] && setzePdfFeld(pdfFeldElement(k), data[k])) msg += '- ' + PDF_FELDER[k].titel + ' übernommen.\n';
    });

    // 1a. Titel: nur wenn das Formular noch keinen hat
    if (data.title_dora && !leseTitelImFormular() && setzeTitelImFormular(data.title_dora)) {
        msg += '- Titel übernommen.\n';
    }

    // 1b. Abstract
    if (data.abstract && setzeAbstractImFormular(data.abstract)) {
        msg += '- Abstract übernommen.\n';
    }

    // 2. Keywords
    if (data.keywords && data.keywords.length > 0) {
        // Add to Keyword Manager if available
        const list = document.getElementById('dora-keyword-list');
        if (list) {
            data.keywords.forEach(kw => {
                // Clean up newlines/spaces from PDF extraction
                const cleanKw = kw.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
                // Check if already exists
                const exists = Array.from(list.querySelectorAll('input')).some(i => i.value.toLowerCase() === cleanKw.toLowerCase());
                if (!exists) {
                    const li = createEl('li', 'dora-keyword-item');
                    li.setAttribute('draggable', 'true');

                    const inputField = createEl('input', 'dora-keyword-input');
                    inputField.type = 'text';
                    inputField.value = formatKeyword(cleanKw);
                    // Hausschreibweise aus DORA nachziehen, sobald sie da ist
                    keywordSchreibweiseNachziehen(inputField, cleanKw);

                    const handle = createEl('span', 'dora-drag-handle', '☰');

                    li.appendChild(inputField);
                    li.appendChild(handle);

                    // Bind events
                    const topicContainer = findKeywordContainer();
                    if (topicContainer) bindItemEvents(li, topicContainer);

                    list.appendChild(li);
                }
            });
            // Sync back
            const topicContainer = findKeywordContainer();
            if (topicContainer) {
                syncKeywordsBackToDora(topicContainer);
                msg += `- ${data.keywords.length} Keywords hinzugefügt.\n`;
            }
        } else {
            console.log("Keywords found but Manager not ready:", data.keywords);
        }
    }

    // Optional: Show success message or just rely on visual update
    // alert(msg);
}

function showLoadingBox() {
    let box = createFloatingBox();
    box.replaceChildren(); // Clear old content
    const msg = createEl('div', '', '⏳ Metadaten werden abgerufen...');
    msg.style.cssText = 'text-align:center; color:#666; padding:20px; font-family:sans-serif;';
    box.appendChild(msg);
}

function renderErrorBox(msgText) {
    let box = createFloatingBox();
    box.replaceChildren();
    box.dataset.doraMinimiert = 'nein'; // Inhalt ist neu, Zustand kommt unten
    box.style.borderLeft = '5px solid #e53e3e';

    const msgDiv = createEl('div', '', `❌ Fehler: ${msgText}`);
    msgDiv.style.cssText = 'color:#e53e3e; padding:10px 46px 10px 10px; font-weight:bold; '
        + 'font-family:sans-serif; white-space: pre-wrap;';

    box.appendChild(erzeugeBoxSteuerung(box, null, 'DORA Helper – Fehler'));
    box.appendChild(msgDiv);

    if (ergebnisBoxMinimiert) minimiereBox(box, 'DORA Helper – Fehler');
}

// --- RESULT BOX (Secure Render) ---
function renderResultBox(data) {
    const oa = data.unpaywall;
    const meta = data.crossref;

    // Hide the Bulk Data Tool by default when DOI results are shown
    const bulkTool = document.getElementById('dora-bulk-data-tool');
    if (bulkTool) {
        bulkTool.style.display = 'none';
        const b = bulkTool.querySelector('#dora-bulk-data-tool > div:nth-child(2)');
        if (b) b.style.display = 'none';
        const icon = document.getElementById('dora-bulk-toggle-icon');
        if (icon) icon.textContent = '▼';
        bulkTool.style.width = 'auto';
    }

    let box = createFloatingBox();
    box.replaceChildren(); // Reset
    box.dataset.doraMinimiert = 'nein'; // Inhalt ist neu, Zustand kommt unten

    // 1. Steuerung: einklappen oder schliessen
    const kurzText = meta && meta.DOI ? `DORA Helper – ${meta.DOI}` : 'DORA Helper – Ergebnis';
    box.appendChild(erzeugeBoxSteuerung(box, () => {
        // Restore the Bulk Data Tool button so it's accessible without DOI box
        const bulkTool = document.getElementById('dora-bulk-data-tool');
        if (bulkTool) {
            bulkTool.style.display = 'block';
            const b = bulkTool.querySelector('#dora-bulk-data-tool > div:nth-child(2)');
            if (b) b.style.display = 'none';
            const icon = document.getElementById('dora-bulk-toggle-icon');
            if (icon) icon.textContent = '▼';
            bulkTool.style.width = 'auto';
        }
    }, kurzText));

    // 2. Header
    const header = createEl('div', 'dora-meta-header');
    // Platz fuer die Knoepfe oben rechts freihalten - lange Titel liefen
    // sonst unter das Minus- und Schliessen-Symbol.
    header.style.paddingRight = '46px';

    // Logo (Clickable to toggle Bulk tool)
    const logo = createEl('img');
    logo.id = 'dora-robot-logo';
    logo.src = chrome.runtime.getURL('icons/logo-48.png');
    logo.style.cssText = 'float:left; width:24px; height:24px; margin-right:8px; cursor:pointer;';
    logo.title = 'Klicken, um den Bulk Copy & Paste Assistenten anzuzeigen';
    logo.addEventListener('click', () => {
        if (typeof toggleBulkDataTool === 'function') {
            toggleBulkDataTool();
        }
    });
    header.appendChild(logo);

    // Title (Restored, smaller, stripped HTML)
    let titleText = meta.title ? meta.title[0] : 'Kein Titel';

    const title = createEl('div', 'dora-meta-title');
    // Safe decoding of HTML entities without executing scripts
    const parser = new DOMParser();
    const doc = parser.parseFromString(titleText, 'text/html');
    title.textContent = doc.body.textContent || "";

    title.style.fontSize = '0.85em';
    title.style.fontWeight = 'bold';
    title.style.marginBottom = '2px';
    title.style.lineHeight = '1.2';

    const containerTitle = meta['container-title'] ? meta['container-title'][0] : '';
    const pubDate = meta.created && meta.created['date-parts'] ? meta.created['date-parts'][0][0] : '-';
    const journalInfo = `${containerTitle} (${pubDate})`;
    const journal = createEl('div', 'dora-meta-journal', journalInfo);
    journal.style.fontSize = '0.75em';
    journal.style.color = '#666';

    header.appendChild(title);
    header.appendChild(journal);
    box.appendChild(header);

    // 3. Status Logic
    let statusText = 'Closed Access';
    let statusClass = 'badge-red';
    let isHybrid = false;

    if (oa.is_oa) {
        switch (oa.oa_status) {
            case 'hybrid': statusText = 'Hybrid OA'; statusClass = 'badge-hybrid'; isHybrid = true; break;
            case 'gold': statusText = 'Gold OA'; statusClass = 'badge-gold'; break;
            case 'green': statusText = 'Green OA'; statusClass = 'badge-green'; break;
            case 'bronze': statusText = 'Bronze'; statusClass = 'badge-gold'; break;
            default: statusText = 'Open Access'; statusClass = 'badge-green';
        }
    }

    // 4. Badges Container
    const badgesDiv = createEl('div');
    badgesDiv.style.margin = '6px 0';

    const statusBadge = createEl('span', `dora-badge ${statusClass}`, statusText);
    badgesDiv.appendChild(statusBadge);

    const bestLoc = oa.best_oa_location || {};
    if (bestLoc.license) {
        const licBadge = createEl('span', 'dora-badge badge-blue', bestLoc.license.toUpperCase());
        badgesDiv.appendChild(licBadge);
    }

    let versionText = '';
    if (bestLoc.version === 'publishedVersion') versionText = 'Verlags-PDF (VoR)';
    if (bestLoc.version === 'acceptedVersion') versionText = 'Manuskript (AAM)';
    if (versionText) {
        const verBadge = createEl('span', 'dora-badge badge-gray', versionText);
        badgesDiv.appendChild(verBadge);
    }
    box.appendChild(badgesDiv);

    // 5c. Data Quality Checker (Scopus / DOAJ / Crossref)
    if (data.scopus || data.doaj || data.crossrefLicense) {
        const checkerDiv = createEl('div', 'dora-checker-box');
        checkerDiv.style.cssText = 'margin-top:6px; padding:5px; background:#f8f9fa; border:1px solid #dee2e6; border-radius:4px; font-size:0.75em;';

        const headerRow = createEl('div', '', '🔍 Data Cross-Check');
        headerRow.style.fontWeight = 'bold';
        headerRow.style.marginBottom = '3px';
        headerRow.style.color = '#495057';
        checkerDiv.appendChild(headerRow);

        // --- SCOPUS CHECK ---
        if (data.scopus) {
            const scopus = data.scopus;
            if (scopus.error) {
                const err = createEl('div', '', `Scopus: Fehler (${scopus.error})`);
                err.style.color = '#e53e3e';
                checkerDiv.appendChild(err);
            } else {
                // A. Affiliation Check
                const affRow = createEl('div', '', '');
                const affInd = createEl('span', '', scopus.isLib4Ri ? '✅ ' : '⚠️ ');
                const affText = createEl('span', '');
                if (scopus.isLib4Ri) {
                    affText.appendChild(document.createTextNode('Corr. Author: '));
                    affText.appendChild(createEl('b', '', '4RI'));
                } else {
                    affText.textContent = 'Corr. Author: Extern/Möglicherweise nicht gefunden';
                }
                if (!scopus.isLib4Ri) affText.title = scopus.affiliation || "Keine Info";
                affRow.appendChild(affInd);
                affRow.appendChild(affText);
                checkerDiv.appendChild(affRow);

                // B. OA Status Check (Refined)
                const oaRow = createEl('div', '', '');
                const scpIsHyrbid = scopus.oaType && scopus.oaType.toLowerCase().includes('hybrid');
                const scpIsOA = scopus.oaFlag === true; // OA=1

                // Conflict if: Unpaywall=Hybrid, Scopus=Closed (NOT OA)
                // Conflict if: Unpaywall=Closed, Scopus=OA
                // Note: Unpaywall=Hybrid & Scopus=OA is MATCH (Hybrid is a type of OA)

                let oaIcon = '✅ ';
                let oaMsg = `Scopus: ${scopus.oaType || (scpIsOA ? 'OA' : 'Closed')}`;
                let oaColor = '#28a745'; // Green

                if (isHybrid && !scpIsOA) { // Hybrid but Scopus says Closed
                    oaIcon = '⚠️ ';
                    oaMsg += ' (Unpaywall: Hybrid)';
                    oaColor = '#d69e2e'; // Orange
                } else if (!isHybrid && !oa.is_oa && scpIsOA) { // Closed but Scopus says OA
                    oaIcon = '⚠️ ';
                    oaMsg += ' (Unpaywall: Closed)';
                    oaColor = '#d69e2e';
                }

                const oaInd = createEl('span', '', oaIcon);
                const oaSpan = createEl('span', '', oaMsg);
                oaSpan.style.color = oaColor;

                oaRow.appendChild(oaInd);
                oaRow.appendChild(oaSpan);
                checkerDiv.appendChild(oaRow);
            }
        }

        // --- DOAJ CHECK ---
        if (data.doaj) {
            const doajRow = createEl('div', '', '');
            const inDoaj = data.doaj.in_doaj;

            // Logic:
            // Gold OA + Not in DOAJ -> Warning (Quality? New journal?)
            // Hybrid + In DOAJ -> Conflict (DOAJ journals are usually full OA, not Hybrid)

            let doajIcon = inDoaj ? '✅ ' : 'ℹ️ '; // Info icon for not in DOAJ (neutral usually)
            let doajMsg = inDoaj ? 'DOAJ: Gelistet' : 'DOAJ: Nicht gelistet';
            let doajColor = inDoaj ? '#28a745' : '#6c757d';

            if (oa.oa_status === 'gold' && !inDoaj) {
                doajIcon = '⚠️ ';
                doajMsg += ' (Gold OA aber nicht in DOAJ)';
                doajColor = '#d69e2e';
            } else if (isHybrid && inDoaj) {
                doajIcon = '⚠️ ';
                doajMsg += ' (Hybrid aber in DOAJ?)';
                doajColor = '#d69e2e';
            }

            const doajInd = createEl('span', '', doajIcon);
            const doajSpan = createEl('span', '', doajMsg);
            doajSpan.style.color = doajColor;
            doajRow.appendChild(doajInd);
            doajRow.appendChild(doajSpan);
            checkerDiv.appendChild(doajRow);
        }

        // --- LICENSE CHECK (Crossref) ---
        if (data.crossrefLicense) {
            const licRow = createEl('div', '', '');
            // Simple helper to clean URL to short code like "CC-BY"
            const getLicCode = (url) => {
                if (!url) return '';
                const parts = url.split('/');
                // e.g. creativecommons.org/licenses/by/4.0/ -> by 4.0
                if (url.includes('creativecommons.org')) {
                    const idx = parts.indexOf('licenses');
                    if (idx > -1 && parts[idx + 1]) return 'CC-' + parts[idx + 1].toUpperCase();
                }
                return 'License';
            };

            const crLic = getLicCode(data.crossrefLicense);
            const upLic = bestLoc.license ? bestLoc.license.toUpperCase() : null;

            let licIcon = '✅ ';
            let licMsg = `Crossref Lic: ${crLic}`;
            let licColor = '#28a745';

            // Conflict if Unpaywall has license but Crossref doesn't? Or types differ?
            // Usually Crossref is master.
            // If Unpaywall says CC-BY but Crossref has nothing -> Warning?
            // If Crossref says CC-BY but Unpaywall says CC-BY-NC -> Warning.

            if (upLic && crLic !== 'License' && !crLic.includes(upLic.replace('CC-', '').replace('-4.0', ''))) {
                // Very rough check. 'CC-BY' vs 'CC-BY-NC'. 
                // Allow partial match?
                if (upLic !== crLic) {
                    licIcon = '⚠️ ';
                    licMsg += ` (Unpaywall: ${upLic})`;
                    licColor = '#d69e2e';
                }
            }

            const licInd = createEl('span', '', licIcon);

            // Generate Link instead of Span
            const licSpan = createEl('a', '', licMsg);
            licSpan.href = data.crossrefLicense;
            licSpan.target = '_blank';
            licSpan.style.color = licColor;
            licSpan.style.textDecoration = 'none'; // Optional: keep it looking clean or add underline
            licSpan.style.borderBottom = '1px dotted ' + licColor; // Dotted underline to indicate interaction
            licSpan.title = data.crossrefLicense; // Tooltip with full URL

            licRow.appendChild(licInd);
            licRow.appendChild(licSpan);
            checkerDiv.appendChild(licRow);
        }

        box.appendChild(checkerDiv);
    } else {
        // Optional: Hint if Scopus Key missing
        // const hint = createEl('div', '', 'Scopus Check inaktiv (Kein API Key)');
        // hint.style.fontSize = '0.8em'; hint.style.color='#999';
        // box.appendChild(hint);
    }

    // 5. Buttons Container
    const btnContainer = createEl('div', 'dora-btn-container');
    btnContainer.style.display = 'flex';
    btnContainer.style.flexDirection = 'column';
    btnContainer.style.gap = '5px';
    btnContainer.style.marginTop = '8px';

    // Check if it is a Book Chapter
    const pubTypeEl = document.getElementById('edit-publication-type');
    const pubTypeVal = pubTypeEl ? pubTypeEl.value.toLowerCase() : '';
    const isHostType = pubTypeVal.includes('book chapter') || pubTypeVal.includes('proceedings paper') || pubTypeVal.includes('conference item');

    if (isHostType) {
        const importBtn = createEl('button', 'dora-box-btn btn-hybrid-action');
        importBtn.id = 'dora-import-book-chapter';

        const icon = createEl('span', '', '📚');
        icon.style.marginRight = '5px';
        importBtn.appendChild(icon);
        importBtn.appendChild(document.createTextNode(' Metadaten importieren'));

        importBtn.title = "Importiert Titel, Host-Titel (Buch/Proceedings), Seiten, Jahr, Verlag, Autoren, Editoren und Abstract";
        importBtn.addEventListener('click', async () => {
            importBtn.disabled = true;
            importBtn.textContent = '⏳ Import läuft...';
            try {
                await fillBookChapterMetadata(meta);
                importBtn.textContent = '✅ Importiert!';
                setTimeout(() => {
                    importBtn.disabled = false;
                    importBtn.replaceChildren(); // Clear
                    importBtn.appendChild(icon.cloneNode(true));
                    importBtn.appendChild(document.createTextNode(' Metadaten importieren'));
                }, 2000);
            } catch (e) {
                renderErrorBox(e.message);
                importBtn.disabled = false;
                importBtn.replaceChildren();
                importBtn.appendChild(icon.cloneNode(true));
                importBtn.appendChild(document.createTextNode(' Metadaten importieren'));
            }
        });
        btnContainer.appendChild(importBtn);
    }

    // Der #hybrid-Button sitzt bei den übrigen Tags unter "Additional
    // Information"; hier wird er nur als erkannt markiert.
    markHybridTagButton(isHybrid);

    // PDF-Zeile mit festen Plaetzen: oben der Haupt-Knopf ueber die ganze
    // Breite, darunter Quellen und Supplements je zur Haelfte. Die Knoepfe
    // aendern beim Nachladen nur ihre Beschriftung, nicht mehr Groesse oder
    // Position - vorher sprang die Zeile bei jedem Ergebnis um.
    const pdfActionRow = createEl('div', 'dora-pdf-aktionen');

    // Haupt-Knopf gibt es immer, auch bevor eine Quelle bekannt ist
    const pdfUrl = bestLoc.url_for_pdf;
    const pdfBtn = createEl('a', 'dora-box-btn btn-secondary dora-aktion-zeile');
    pdfBtn.id = 'dora-main-pdf-btn';
    const pdfIcon = createEl('span', '', '📄');
    pdfBtn.appendChild(pdfIcon);
    knopfBeschriftung(pdfBtn, pdfUrl ? 'PDF ansehen (Unpaywall)' : 'PDF wird gesucht …');
    pdfActionRow.appendChild(pdfBtn);

    // Vorschau und Zielfenster gelten von Anfang an - auch wenn die Adresse
    // erst später aus den Nachweisdiensten kommt. Sonst wäre der Knopf ein
    // gewöhnlicher Link und würde im selben Tab navigieren.
    pdfBtn.target = '_blank';
    verknuepfePdfVorschau(pdfBtn, 'Open-Access-PDF', meta.DOI);

    if (pdfUrl) {
        pdfBtn.href = pdfUrl;

        // Kleiner Knopf rechts neben dem PDF-Knopf, kein eigener Platz in der Zeile
        const analyzeBtn = createEl('button', 'dora-box-btn btn-secondary dora-blitz');
        analyzeBtn.type = 'button';
        analyzeBtn.textContent = '⚡';
        analyzeBtn.title = "Dieses PDF mit Haiku auswerten";
        analyzeBtn.onclick = () => handlePdfUrl(pdfUrl, analyzeBtn);
        pdfActionRow.classList.add('dora-mit-blitz');
        pdfActionRow.appendChild(markierePdfAnalyse(analyzeBtn));
    } else {
        pdfBtn.style.opacity = '.7';
        pdfBtn.title = 'Unpaywall kennt keinen freien Volltext – die Nachweisdienste werden noch abgefragt';
    }

    btnContainer.appendChild(pdfActionRow);

    // DOI Link - als Schaltfläche wie der Policy-Knopf und vor diesem, weil
    // der Sprung zum Artikel beim Prüfen häufiger gebraucht wird.
    const doiLink = createEl('a', 'dora-box-btn btn-secondary');
    doiLink.href = `https://doi.org/${meta.DOI}`;
    doiLink.target = '_blank';
    doiLink.title = 'Öffnet die Artikelseite beim Verlag';
    const doiIcon = createEl('span', '', '🔗');
    doiIcon.style.marginRight = '5px';
    doiLink.appendChild(doiIcon);
    doiLink.appendChild(document.createTextNode(' Zum Artikel (Verlagsseite)'));
    doiLink.style.fontSize = '12px';
    doiLink.style.padding = '6px 10px';
    doiLink.style.marginTop = '5px';
    btnContainer.appendChild(doiLink);

    // Policy Button
    const issn = meta.ISSN ? meta.ISSN[0] : null;
    if (issn) {
        const policyBtn = createEl('a', 'dora-box-btn btn-secondary');
        policyBtn.href = `https://openpolicyfinder.jisc.ac.uk/search?search=${issn}`;
        policyBtn.target = '_blank';
        policyBtn.title = 'Open Policy Finder (JISC): Selbstarchivierungs-Regeln der Zeitschrift';
        const icon = createEl('span', '', '🛡️');
        icon.style.marginRight = '5px';
        policyBtn.appendChild(icon);
        policyBtn.appendChild(document.createTextNode(' OA Policy Finder'));
        policyBtn.style.fontSize = '12px'; // Reduced
        policyBtn.style.padding = '4px 10px'; // flacher als der Artikel-Knopf
        policyBtn.style.marginTop = '4px';
        btnContainer.appendChild(policyBtn);
    }

    box.appendChild(btnContainer);

    // 5b. Parallel: Deep Scan on Publisher Site (Zotero/Meta-Tags)
    if (meta.DOI) {
        // Direkte Volltext-Links aus den Nachweisdiensten - zuverlässiger als
        // das Auslesen der Verlagsseite, das meist an Sperren scheitert.
        pdfActionRow.appendChild(createPdfSourceButton(meta.DOI, document.getElementById('dora-main-pdf-btn')));
        findPublisherPdf(meta.DOI, pdfActionRow, pdfUrl);
        // Supplements: Datenpublikationen und Supporting Information
        pdfActionRow.appendChild(createSupplementButton(meta.DOI, { fontSize: '12px' }));
    }

    // 6. PDF Drop Zone (Moved to bottom of result box)
    const dropZone = createEl('div', 'dora-pdf-drop', '📄 PDF hier ablegen oder öffnen');
    dropZone.style.cssText = 'border: 2px dashed #ccc; padding: 6px; border-radius: 4px; cursor: pointer; color: #666; font-size: 0.85em; background: #f9f9f9; margin-top: 8px; text-align: center; transition: all 0.2s;';

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#0073e6';
        dropZone.style.backgroundColor = '#e6f7ff';
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#ccc';
        dropZone.style.backgroundColor = '#f9f9f9';
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.style.borderColor = '#ccc';
        dropZone.style.backgroundColor = '#f9f9f9';

        if (e.dataTransfer.files.length > 0) {
            handlePdfFile(e.dataTransfer.files[0]);
        }
    });

    dropZone.addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf';
        input.onchange = (e) => {
            if (e.target.files.length > 0) handlePdfFile(e.target.files[0]);
        };
        input.click();
    });

    // Register for passive monitoring
    chrome.runtime.sendMessage({ action: "registerDoraTab" });

    box.appendChild(markierePdfAnalyse(dropZone));

    // War die Box eingeklappt, bleibt sie es auch beim naechsten Abruf -
    // sonst springt sie beim Durcharbeiten staendig wieder auf.
    if (ergebnisBoxMinimiert) minimiereBox(box, kurzText);
}

async function addMissingRows(containerRef, requiredCount) {
    // Loop to ensure we reach the required count
    // We use a safe limit (requiredCount + 2) to prevent infinite loops if something breaks
    let safetyLimit = requiredCount + 5;

    // containerRef is either a CSS selector or a resolver function (needed where
    // the wrapper itself has no stable selector, e.g. the funding fieldpanel).
    const resolveWrapper = () => typeof containerRef === 'function'
        ? containerRef()
        : document.querySelector(containerRef);

    while (safetyLimit > 0) {
        safetyLimit--;

        // 1. FRESH QUERY: Always re-query the container because Drupal AJAX replaces it
        const wrapperEl = resolveWrapper();
        if (!wrapperEl) {
            console.warn('DORA Helper: Container not found ' + containerRef);
            return;
        }

        let container = wrapperEl.querySelector('.islandora-form-fieldpanel-panel');
        let rowSelector = '.islandora-form-fieldpanel-pane';

        // Fallback for standard Drupal multi-value tables
        if (!container) {
            container = wrapperEl.querySelector('table');
            if (container) {
                rowSelector = 'tbody tr:not(.tabledrag-hide)';
            } else {
                console.warn('DORA Helper: No fieldpanel/table inside container', wrapperEl);
                return;
            }
        }

        // 2. CHECK COUNT
        const currentRows = container.querySelectorAll(rowSelector).length;
        if (currentRows >= requiredCount) {
            console.log("DORA Helper: All rows present (" + currentRows + ")");
            return; // Done!
        }

        // 3. FIND BUTTON
        // Look in the parent/wrapper since table add buttons are usually outside the table itself
        let addButton = container.querySelector('.fieldpanel-add.form-submit');
        if (!addButton) {
            addButton = wrapperEl.querySelector('.fieldpanel-add.form-submit, input[type="submit"][value="Add"], input[type="submit"][name$="[add]"]');
        }

        if (!addButton) {
            console.warn('DORA Helper: "Add" button missing in', wrapperEl);
            return;
        }

        console.log(`DORA Helper: Adding row... (${currentRows} -> ${requiredCount})`);

        // 4. CLICK (Mousedown for Drupal)
        addButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));

        // 5. WAIT FOR AJAX
        await new Promise(resolve => {
            const observer = new MutationObserver((mutations, obs) => {
                const currentWrapper = resolveWrapper();
                let checkContainer = currentWrapper && currentWrapper.querySelector('.islandora-form-fieldpanel-panel');
                if (!checkContainer && currentWrapper) checkContainer = currentWrapper.querySelector('table');

                if (checkContainer) {
                    const newCount = checkContainer.querySelectorAll(rowSelector).length;
                    if (newCount > currentRows) {
                        obs.disconnect();
                        resolve();
                    }
                }
            });
            // Observer on the specific container (which might be replaced, but we observe the parent if possible or the container itself)
            // Ideally we'd observe the parent of the container, but the container itself usually mutates children.
            // If the container ITSELF is replaced, the observer might die. 
            // Better: Observe the wrapper if possible, or just accept the timeout fallback.
            const observeTarget = wrapperEl.parentNode || document.body;
            observer.observe(observeTarget, { childList: true, subtree: true });

            // Timeout: 2.5 seconds (AJAX should be faster)
            // If timeout occurs, loop continues and re-checks count.
            setTimeout(() => {
                observer.disconnect();
                resolve();
            }, 2500);
        });

        // Small delay to let JS event handlers finish binding to new elements
        await new Promise(r => setTimeout(r, 100));
    }
}

async function fillBookChapterMetadata(meta) {
    if (!meta) throw new Error("Keine Metadaten verfügbar.");

    // 7. Authors - Add rows first
    if (meta.author && meta.author.length > 0) {
        await addMissingRows('.form-item-authors', meta.author.length);
    }

    // 8. Editors - Add rows first (if editors exist in metadata)
    if (meta.editor && meta.editor.length > 0) {
        await addMissingRows('.form-item-host-editor', meta.editor.length);
    }

    // 1. Article Title (Chapter Title)
    const titleEl = document.getElementById('edit-titleinfo-title-text-format-value'); // CKEditor field
    if (titleEl && meta.title && meta.title[0]) {
        // Check if CKEditor is active
        const cke = document.getElementById('cke_edit-titleinfo-title-text-format-value');
        if (cke) {
            const iframe = cke.querySelector('iframe');
            if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
                iframe.contentDocument.body.textContent = meta.title[0];
            }
        } else {
            titleEl.value = meta.title[0];
        }
    }

    // 2. Host Title (Book Title or Proceedings Title)
    const hostTitleEl = document.getElementById('edit-host-booktitle') || document.getElementById('edit-host-titleinfo-title');
    if (hostTitleEl && meta['container-title'] && meta['container-title'][0]) {
        hostTitleEl.value = meta['container-title'][0];
    }

    // 3. Pages (Start & End)
    if (meta.page) {
        const parts = meta.page.split('-');
        const startEl = document.getElementById('edit-host-part-pages-start'); // Corrected ID from HTML
        const endEl = document.getElementById('edit-host-part-pages-end');     // Corrected ID from HTML

        if (startEl && parts[0]) startEl.value = parts[0];
        if (endEl && parts[1]) endEl.value = parts[1];
    }

    // 4. Publication Year
    if (meta.published && meta.published['date-parts']) {
        const year = meta.published['date-parts'][0][0];
        const dateEl = document.getElementById('edit-origininfodate-0-dateissued'); // Corrected ID from HTML
        if (dateEl) dateEl.value = year;
    }

    // 5. Publisher
    if (meta.publisher) {
        const pubEl = document.getElementById('edit-host-origininfo1-0-publisher'); // Corrected ID from HTML
        if (pubEl) pubEl.value = meta.publisher;
    }

    // 6. ISBN
    if (meta.ISBN && meta.ISBN.length > 0) {
        const isbnEl = document.getElementById('edit-identifiers-isbn');
        if (isbnEl) isbnEl.value = meta.ISBN[0];
    }

    // 7. Authors - Fill data
    if (meta.author && meta.author.length > 0) {
        const authorContainer = document.querySelector('.form-item-authors');
        if (authorContainer) {
            let authorPanes = authorContainer.querySelectorAll('.islandora-form-fieldpanel-pane');
            if (authorPanes.length === 0) authorPanes = authorContainer.querySelectorAll('table tbody tr:not(.tabledrag-hide)');

            meta.author.forEach((auth, idx) => {
                if (authorPanes[idx]) {
                    const pane = authorPanes[idx];
                    const familyEl = pane.querySelector('input[name$="[family]"]');
                    const givenEl = pane.querySelector('input[name$="[given]"]');

                    if (familyEl) {
                        familyEl.value = auth.family || '';
                        familyEl.dispatchEvent(new Event('input', { bubbles: true }));
                        familyEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    if (givenEl) {
                        givenEl.value = auth.given || '';
                        givenEl.dispatchEvent(new Event('input', { bubbles: true }));
                        givenEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    // Trigger PSI Affiliation button removed because it is unreliable with just the name
                    // and often selects the wrong internal author object.
                }
            });
        }
    }

    // 8. Editors - Fill data
    if (meta.editor && meta.editor.length > 0) {
        const editorContainer = document.querySelector('.form-item-host-editor');
        if (editorContainer) {
            let editorPanes = editorContainer.querySelectorAll('.islandora-form-fieldpanel-pane');
            if (editorPanes.length === 0) editorPanes = editorContainer.querySelectorAll('table tbody tr:not(.tabledrag-hide)');

            meta.editor.forEach((ed, idx) => {
                if (editorPanes[idx]) {
                    const pane = editorPanes[idx];
                    // Note: Editor fields often have slightly different names, e.g. familyEditor vs family
                    // Based on your HTML: name="host[editor][0][familyEditor]"
                    const familyEl = pane.querySelector('input[name$="[familyEditor]"]');
                    const givenEl = pane.querySelector('input[name$="[givenEditor]"]');

                    if (familyEl) {
                        familyEl.value = ed.family || '';
                        familyEl.dispatchEvent(new Event('input', { bubbles: true }));
                        familyEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                    if (givenEl) {
                        givenEl.value = ed.given || '';
                        givenEl.dispatchEvent(new Event('input', { bubbles: true }));
                        givenEl.dispatchEvent(new Event('change', { bubbles: true }));
                    }

                    // Trigger PSI Affiliation button if available
                    const affilBtn = pane.querySelector('.lib4ri-author-fill');
                    if (affilBtn) {
                        affilBtn.click();
                    }
                }
            });
        }
    }

    // 9. Series Title
    const seriesTitleEl = document.getElementById('edit-host-series-titleinfo-title');
    if (seriesTitleEl && meta['container-title'] && meta['container-title'].length > 1) {
        // Assume the second one is the series title if available
        seriesTitleEl.value = meta['container-title'][1];
    }

    // 10. Abstract
    if (meta.abstract) {
        // Crossref abstract is often XML/HTML (e.g. <jats:p>...</jats:p>)
        // We should strip tags or clean it up if necessary, but CKEditor might handle it.
        // Let's try to strip basic JATS tags if present.
        const bereinigt = meta.abstract.replace(/<jats:p>/g, '').replace(/<\/jats:p>/g, '\n\n').replace(/<[^>]+>/g, '');
        setzeAbstractImFormular(bereinigt);
    }

    // Success is handled by the caller (button UI update)
}

function insertHybridTag() {
    let noteField = document.getElementById('edit-notes');
    if (!noteField) {
        const labels = document.querySelectorAll('label');
        for (const label of labels) {
            if (((label.innerText || label.textContent || '')).includes('Additional Information')) {
                const id = label.getAttribute('for');
                if (id) noteField = document.getElementById(id); break;
            }
        }
    }
    if (noteField) {
        const currentVal = noteField.value;
        if (!currentVal.includes('#hybrid')) {
            const newVal = currentVal ? currentVal.trim() + " #hybrid" : "#hybrid";
            noteField.value = newVal;
            noteField.dispatchEvent(new Event('input', { bubbles: true }));
            noteField.dispatchEvent(new Event('change', { bubbles: true }));
        }
        noteField.focus();
        noteField.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else { alert("Feld 'Additional Information' nicht gefunden."); }
}

// --- KEYWORD MANAGER (Secure) ---
function injectKeywordManager(topicContainer) {
    const toolHeader = createEl('div');
    toolHeader.id = 'dora-keyword-manager';
    toolHeader.style.maxWidth = 'max-content';
    toolHeader.style.minWidth = '300px';

    // Header Row
    const headRow = createEl('div');
    headRow.style.cssText = "display:flex; justify-content:space-between; align-items:center;";

    const title = createEl('strong', '', '⚡ Keyword Manager');
    const sortBtn = createEl('button', 'dora-helper-button', 'Edit & Sort');
    sortBtn.id = 'dora-enable-sort';
    sortBtn.type = 'button';
    sortBtn.style.cssText = "padding:2px 8px; font-size:0.8em;";

    headRow.appendChild(title);
    headRow.appendChild(sortBtn);
    toolHeader.appendChild(headRow);

    // List
    const ul = createEl('ul');
    ul.id = 'dora-keyword-list';
    toolHeader.appendChild(ul);

    // Hint
    const hint = createEl('div', '', '');
    hint.id = 'dora-drag-hint';
    hint.style.cssText = "display:none; font-size:0.8em; color:#666; margin-top:5px;";
    hint.appendChild(document.createTextNode('📝 Bearbeiten möglich. '));
    const b = createEl('b', '', '☰ Griff ziehen');
    hint.appendChild(b);
    hint.appendChild(document.createTextNode(' zum Sortieren.'));
    toolHeader.appendChild(hint);

    const tagList = topicContainer.querySelector('.tag-list') || topicContainer.querySelector('.xml-form-elements-tags') || topicContainer.querySelector('div[class*="tags"]');
    if (tagList) tagList.insertAdjacentElement('beforebegin', toolHeader);
    else topicContainer.appendChild(toolHeader);

    sortBtn.addEventListener('click', () => {
        isKeywordManagerOpen = true;
        loadKeywordsIntoManager(topicContainer);
    });

    if (isKeywordManagerOpen) {
        loadKeywordsIntoManager(topicContainer);
    }
}

function loadKeywordsIntoManager(topicContainer) {
    const list = document.getElementById('dora-keyword-list');
    list.replaceChildren();
    const loading = createEl('li', '', 'Lade Einstellungen...');
    loading.style.cssText = 'padding:10px; color:#666;';
    list.appendChild(loading);

    document.getElementById('dora-drag-hint').style.display = 'block';

    loadExceptionsFromStorage(() => {
        list.replaceChildren();
        const hiddenInputs = topicContainer.querySelectorAll('input[type="hidden"].form-tag, input[name^="topics"].form-tag');

        hiddenInputs.forEach((input) => {
            if (!input.value) return;
            const formattedValue = formatKeyword(input.value);
            const li = createEl('li', 'dora-keyword-item');

            // Input
            const inputField = createEl('input', 'dora-keyword-input');
            inputField.type = 'text';
            inputField.value = formattedValue;

            // Hausschreibweise aus DORA nachziehen, sobald sie vorliegt
            keywordSchreibweiseNachziehen(inputField, input.value);

            // Handle
            const handle = createEl('span', 'dora-drag-handle', '☰');
            handle.title = "Ziehen zum Sortieren";

            handle.setAttribute('draggable', 'true');

            li.appendChild(inputField);
            li.appendChild(handle);

            bindItemEvents(li, topicContainer);
            list.appendChild(li);
        });
        topicContainer.classList.add('original-keywords-hidden');
        syncKeywordsBackToDora(topicContainer);
    });
}

function bindItemEvents(liItem, topicContainer) {
    const handle = liItem.querySelector('.dora-drag-handle');
    const input = liItem.querySelector('input');

    handle.addEventListener('mouseenter', () => { isMouseOverHandle = true; });
    handle.addEventListener('mouseleave', () => { isMouseOverHandle = false; });
    input.addEventListener('mouseenter', () => { isMouseOverHandle = false; });
    input.addEventListener('input', () => syncKeywordsBackToDora(topicContainer));
    input.addEventListener('mousedown', (e) => e.stopPropagation());

    handle.addEventListener('dragstart', function (e) {
        dragSrcEl = liItem;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', '');
        liItem.classList.add('is-dragging');
    });

    handle.addEventListener('dragend', function () {
        liItem.classList.remove('is-dragging');
        document.querySelectorAll('.dora-keyword-item').forEach(col => {
            col.classList.remove('drop-target-top', 'drop-target-bottom');
        });
    });

    liItem.addEventListener('dragover', function (e) {
        if (e.preventDefault) e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (this === dragSrcEl) return;

        const rect = this.getBoundingClientRect();
        const relY = (e.clientY - rect.top) / rect.height;

        document.querySelectorAll('.dora-keyword-item').forEach(el => {
            if (el !== this) el.classList.remove('drop-target-top', 'drop-target-bottom');
        });

        if (relY < 0.5) {
            this.classList.add('drop-target-top');
            this.classList.remove('drop-target-bottom');
        } else {
            this.classList.add('drop-target-bottom');
            this.classList.remove('drop-target-top');
        }
        return false;
    });

    liItem.addEventListener('dragleave', function (e) {
        if (this.contains(e.relatedTarget)) return;
        this.classList.remove('drop-target-top', 'drop-target-bottom');
    });

    liItem.addEventListener('drop', function (e) {
        if (e.stopPropagation) e.stopPropagation();
        this.classList.remove('drop-target-top', 'drop-target-bottom');

        if (dragSrcEl !== this) {
            const rect = this.getBoundingClientRect();
            const relY = (e.clientY - rect.top) / rect.height;
            if (relY < 0.5) this.parentNode.insertBefore(dragSrcEl, this);
            else this.parentNode.insertBefore(dragSrcEl, this.nextSibling);
            syncKeywordsBackToDora(topicContainer);
        }
        return false;
    });
}

function syncKeywordsBackToDora(topicContainer) {
    const newValues = [];
    document.querySelectorAll('#dora-keyword-list li input').forEach(input => {
        newValues.push(input.value);
    });
    const hiddenInputs = topicContainer.querySelectorAll('input[type="hidden"].form-tag');
    const visibleSpans = topicContainer.querySelectorAll('.tag-list > span, .xml-form-elements-tags > span');
    for (let i = 0; i < hiddenInputs.length; i++) {
        if (newValues[i] !== undefined) {
            hiddenInputs[i].value = newValues[i];
            if (visibleSpans[i]) {
                visibleSpans[i].title = newValues[i];
                const textSpan = visibleSpans[i].querySelector('.edit-tag');
                if (textSpan) textSpan.innerText = newValues[i];
            }
        }
    }
}

// --- TAG BUTTONS FOR ADDITIONAL INFORMATION ---
function injectTagButtons() {
    // Suche nach dem Additional Information Textarea
    let addInfoArea = document.querySelector('textarea[name*="additional_information"]');

    // Fallback: Suche über Label
    if (!addInfoArea) {
        const labels = Array.from(document.querySelectorAll('label'));
        const targetLabel = labels.find(l => ((l.innerText || l.textContent || '')).includes('Additional Information') || ((l.innerText || l.textContent || '')).includes('Additional information'));
        if (targetLabel) {
            const id = targetLabel.getAttribute('for');
            if (id) addInfoArea = document.getElementById(id);
        }
    }

    if (!addInfoArea || addInfoArea.dataset.hasTagButtons) return;
    addInfoArea.dataset.hasTagButtons = "true";

    const container = createEl('div');
    container.style.cssText = 'display:flex; gap:5px; flex-wrap:wrap; margin-top:5px;';

    // Check context (WSL only for #CERC)
    const isWSL = window.location.href.toLowerCase().includes('/wsl');

    const tags = [
        {
            label: '#hybrid', id: 'dora-tag-hybrid',
            title: 'Hybrid Open Access: Artikel in einem Subskriptionsjournal, der einzeln OA gestellt wurde.',
            // Aussehen steuert markHybridTagButton (neutral bzw. orange)
            insert: insertHybridTag
        },
        { label: '#other_journal_contribution', title: 'Editorials, Letters, Introductions, Commentary, Book Reviews, etc. (nur Journal Articles). Bei Unsicherheiten lieber taggen! Short communication nicht taggen.' },
        { label: '#present_address', title: 'Keine 4RI-Affiliation, aber "Present address" vorhanden. Bitte mit Initialen und Nachnamen angeben.', prompt: true },
        { label: '#corporate', title: 'Unter den Autoren befindet sich eine Körperschaft.' },
        { label: '#green', title: 'Artikel darf gemäss Policy des Verlags in der Published Version Open Access gemacht werden; ggfs. ist ein Embargo einzuhalten; Tag wird nur von JHB verwendet.', customStyle: 'background-color: #f0fff4; border-color: #c6f6d5; color: #22543d;' },
        { label: '#CERC', title: 'CERC-Publikationen (ab 2021). Journal Articles (ab 2022) nur wenn Affiliation auf Paper. Auch bei Meldung durch Autor/Admin (Notiz in Lib4RI-Notes).', show: isWSL }
    ];

    tags.forEach(tag => {
        if (tag.hasOwnProperty('show') && !tag.show) return;

        const btn = createEl('button', 'dora-box-btn btn-secondary');
        btn.innerText = tag.label;
        btn.title = tag.title;
        if (tag.id) btn.id = tag.id;
        let baseStyle = 'padding: 2px 8px; font-size: 0.85em; background: #e2e8f0; border: 1px solid #cbd5e0; border-radius: 3px; cursor: pointer; color: #2d3748; width: auto;';
        if (tag.customStyle) baseStyle += tag.customStyle;
        btn.style.cssText = baseStyle;

        btn.onclick = (e) => {
            e.preventDefault();

            // Eigene Einfüge-Logik (z.B. #hybrid: ans Ende, ohne Dublette)
            if (tag.insert) { tag.insert(); return; }

            let valueToInsert = tag.label;

            if (tag.prompt) {
                const name = prompt('Bitte Initialen und Nachnamen eingeben (z.B. A.B. Dennis):');
                if (!name) return;
                valueToInsert = `${tag.label}: ${name}`;
            }

            insertAtCursor(addInfoArea, valueToInsert);
            addInfoArea.dispatchEvent(new Event('input', { bubbles: true }));
            addInfoArea.dispatchEvent(new Event('change', { bubbles: true }));
        };
        container.appendChild(btn);
    });

    addInfoArea.parentNode.appendChild(container);

    // Falls der DOI-Abgleich schon gelaufen ist, Markierung nachziehen
    if (lastOaIsHybrid !== null) markHybridTagButton(lastOaIsHybrid);
}

// Markiert den #hybrid-Tag, wenn der Abgleich Hybrid-OA erkannt hat
function markHybridTagButton(isHybrid) {
    lastOaIsHybrid = !!isHybrid;
    const btn = document.getElementById('dora-tag-hybrid');
    if (!btn) return;

    // Grundstil beibehalten, nur Farbgebung und Schein austauschen
    btn.style.cssText = btn.style.cssText.replace(/(background|border|color|font-weight|box-shadow)[^;]*;\s*/g, '')
        + (isHybrid ? HYBRID_STYLE_AKTIV : HYBRID_STYLE_NEUTRAL);

    btn.title = isHybrid
        ? 'Hybrid Open Access laut Abgleich (Unpaywall) – Tag setzen.'
        : 'Hybrid Open Access: Artikel in einem Subskriptionsjournal, der einzeln OA gestellt wurde.';
}

function insertAtCursor(myField, myValue) {
    if (myField.selectionStart || myField.selectionStart == '0') {
        var startPos = myField.selectionStart;
        var endPos = myField.selectionEnd;

        let prefix = "";
        if (startPos > 0 && myField.value[startPos - 1] !== ' ' && myField.value[startPos - 1] !== '\n') {
            prefix = " ";
        }

        myField.value = myField.value.substring(0, startPos)
            + prefix + myValue
            + myField.value.substring(endPos, myField.value.length);

        myField.selectionStart = startPos + myValue.length + prefix.length;
        myField.selectionEnd = startPos + myValue.length + prefix.length;
        myField.focus();
    } else {
        myField.value += (myField.value.length > 0 ? " " : "") + myValue;
    }
}

// --- BULK DATA ENTRY TOOL ---
function toggleBulkDataTool(forceState) {
    const container = document.getElementById('dora-bulk-data-tool');
    if (!container) return;
    const body = container.querySelector('#dora-bulk-data-tool > div:nth-child(2)');
    const icon = document.getElementById('dora-bulk-toggle-icon');
    if (!body) return;

    // Check if it is currently expanded/open (body is displayed and container is visible)
    const isCurrentlyHidden = container.style.display === 'none' || body.style.display === 'none';
    const show = (forceState !== undefined) ? forceState : isCurrentlyHidden;

    const hasDoiBox = !!document.getElementById('dora-result-box');

    if (show) {
        container.style.display = 'block';
        body.style.display = 'block';
        if (icon) icon.textContent = '▲';
        container.style.width = '320px';
        container.style.right = hasDoiBox ? '350px' : '20px';
    } else {
        if (hasDoiBox) {
            container.style.display = 'none';
        } else {
            container.style.display = 'block';
            body.style.display = 'none';
            if (icon) icon.textContent = '▼';
            container.style.width = 'auto';
            container.style.right = '20px';
        }
    }
}

function injectBulkDataTool() {
    if (document.getElementById('dora-bulk-data-tool')) {
        // If it already exists, manage its visibility based on DOI box presence
        const hasDoiBox = !!document.getElementById('dora-result-box');
        const container = document.getElementById('dora-bulk-data-tool');
        const body = container.querySelector('#dora-bulk-data-tool > div:nth-child(2)');
        if (hasDoiBox && body && body.style.display === 'none') {
            container.style.display = 'none';
        } else {
            container.style.right = hasDoiBox ? '350px' : '20px';
        }
        return;
    }

    const authorContainer = document.querySelector('.form-item-authors');
    if (!authorContainer) return;

    const container = document.createElement('div');
    container.id = 'dora-bulk-data-tool';

    // Hide initially if DOI box is active, slide to 20px or 350px
    const hasDoiBox = !!document.getElementById('dora-result-box');
    container.style.cssText = 'position: fixed; right: ' + (hasDoiBox ? '350px' : '20px') + '; top: 110px; width: auto; z-index: 9999; margin: 15px 0; border: 1px solid #17a2b8; border-radius: 4px; background: #f8f9fa; font-size: 13px; font-family: sans-serif; box-shadow: 0 4px 6px rgba(0,0,0,0.2); transition: width 0.2s ease, right 0.2s ease;';
    if (hasDoiBox) {
        container.style.display = 'none';
    } else {
        container.style.display = 'block';
    }

    const header = document.createElement('div');
    header.style.cssText = 'padding: 8px 12px; background: #17a2b8; color: #fff; cursor: pointer; font-weight: bold; display: flex; justify-content: space-between; align-items: center; border-radius: 3px; gap: 10px; white-space: nowrap;';
    header.innerHTML = `<span>🚀 Bulk Copy & Paste</span><span id="dora-bulk-toggle-icon">▼</span>`;

    const body = document.createElement('div');
    body.style.cssText = 'padding: 15px; display: none;';

    header.addEventListener('click', () => {
        toggleBulkDataTool();
    });

    // Authors Section
    const authorSec = document.createElement('div');
    authorSec.style.cssText = 'margin-bottom: 20px;';
    authorSec.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 5px;">👥 Autoren Bulk-Input</div>
        <div style="display: flex; gap: 10px; margin-bottom: 5px; align-items: center;">
            <label style="font-size: 11px;">Trennen durch:</label>
            <select id="dora-bulk-author-sep" style="font-size: 11px; padding: 2px;">
                <option value="auto">Automatisch (Erraten)</option>
                <option value=";">Semikolon (;)</option>
                <option value=",">Komma (,)</option>
                <option value="\\n">Zeilenumbruch (Enter)</option>
                <option value="and">And / &</option>
            </select>
        </div>
        <textarea id="dora-bulk-author-text" placeholder="Beispiel: Müller, Thomas; Meier, Beat, Dr.; John Doe..." style="width: 100%; height: 60px; margin-bottom: 5px; padding: 5px; box-sizing: border-box;"></textarea>
        <div>
            <button id="dora-bulk-author-btn" type="button" class="form-submit" style="padding: 4px 10px; background: #28a745; border-color: #28a745; color: white;">Autoren einfügen</button>
            <span id="dora-bulk-author-status" style="margin-left: 10px; color: green; font-weight: bold;"></span>
        </div>
    `;

    // Keywords Section
    const keywordSec = document.createElement('div');
    keywordSec.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 5px;">🏷️ Keywords Bulk-Input</div>
        <div style="display: flex; gap: 10px; margin-bottom: 5px; align-items: center;">
            <label style="font-size: 11px;">Trennen durch:</label>
            <select id="dora-bulk-keyword-sep" style="font-size: 11px; padding: 2px;">
                <option value="auto">Automatisch (Erraten)</option>
                <option value=",">Komma (,)</option>
                <option value=";">Semikolon (;)</option>
                <option value="\\n">Zeilenumbruch (Enter)</option>
                <option value="-">Strich (-)</option>
            </select>
        </div>
        <textarea id="dora-bulk-keyword-text" placeholder="Beispiel: Climate change, hydrology, water quality..." style="width: 100%; height: 60px; margin-bottom: 5px; padding: 5px; box-sizing: border-box;"></textarea>
        <div>
            <button id="dora-bulk-keyword-btn" type="button" class="form-submit" style="padding: 4px 10px; background: #28a745; border-color: #28a745; color: white;">Keywords einfügen</button>
            <span id="dora-bulk-keyword-status" style="margin-left: 10px; color: green; font-weight: bold;"></span>
        </div>
    `;

    body.appendChild(authorSec);
    body.appendChild(keywordSec);
    container.appendChild(header);
    container.appendChild(body);

    document.body.appendChild(container);

    document.getElementById('dora-bulk-author-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        const text = document.getElementById('dora-bulk-author-text').value.trim();
        const sep = document.getElementById('dora-bulk-author-sep').value;
        if (!text) return;

        const btn = document.getElementById('dora-bulk-author-btn');
        const oldText = btn.textContent;
        btn.textContent = "Verarbeite...";
        btn.disabled = true;

        await processBulkAuthors(text, sep);

        btn.textContent = oldText;
        btn.disabled = false;
        const status = document.getElementById('dora-bulk-author-status');
        status.textContent = "Erledigt!";
        document.getElementById('dora-bulk-author-text').value = '';
        setTimeout(() => status.textContent = "", 3000);
    });

    document.getElementById('dora-bulk-keyword-btn').addEventListener('click', async (e) => {
        e.preventDefault();
        const text = document.getElementById('dora-bulk-keyword-text').value.trim();
        const sep = document.getElementById('dora-bulk-keyword-sep').value;
        if (!text) return;

        const btn = document.getElementById('dora-bulk-keyword-btn');
        const oldText = btn.textContent;
        btn.textContent = "Verarbeite...";
        btn.disabled = true;

        await processBulkKeywords(text, sep);

        btn.textContent = oldText;
        btn.disabled = false;
        const status = document.getElementById('dora-bulk-keyword-status');
        status.textContent = "Erledigt!";
        document.getElementById('dora-bulk-keyword-text').value = '';
        setTimeout(() => status.textContent = "", 3000);
    });
}

async function processBulkAuthors(text, separatorMode) {
    let sep = separatorMode;
    if (sep === 'auto') {
        const counts = {
            ';': (text.match(/;/g) || []).length,
            '\\n': (text.match(/\n/g) || []).length,
            'and': (text.match(/\s+and\s+|\s+&\s+/gi) || []).length,
            ',': (text.match(/,/g) || []).length
        };

        // Prioritized detection: Semicolons and Newlines are stronger indicators of author separation than commas.
        if (counts[';'] > 0) sep = ';';
        else if (counts['\\n'] > 0) sep = '\\n';
        else if (counts['and'] > 0) sep = 'and';
        else if (counts[','] > 0) sep = ',';
        else sep = ';';
    }

    let rawList = [];
    if (sep === '\\n') {
        rawList = text.split(/\n/);
    } else if (sep === 'and') {
        rawList = text.split(/\s+and\s+|\s+&\s+/i);
    } else {
        rawList = text.split(sep);
    }

    const parsedAuthors = [];
    rawList.forEach(item => {
        let clean = item.trim();
        if (!clean) return;

        // Remove trailing affiliation markers (e.g., "a 1", "b,c", "*", "†", superscripts)
        // Matches trailing spaces/commas followed by single lowercase letters, digits, or common symbols
        clean = clean.replace(/(?:[\s,]*\b(?:[a-z]|\d+)\b|[\s,]*[*†‡¹²³⁴⁵⁶⁷⁸⁹⁰ᵃᵇᶜᵈᵉᶠᵍʰⁱʲᵏˡᵐⁿᵒᵖ]+)+$/, '').trim();

        let family = '';
        let given = '';

        if (clean.includes(',')) {
            const parts = clean.split(',');
            family = parts.shift().trim();
            given = parts.join(',').trim();
        } else {
            const parts = clean.split(/\s+/);
            if (parts.length > 1) {
                family = parts.pop();
                given = parts.join(' ');
            } else {
                family = clean;
            }
        }
        parsedAuthors.push({ family, given });
    });

    if (parsedAuthors.length === 0) return;

    await addMissingRows('.form-item-authors', parsedAuthors.length);

    const authorContainer = document.querySelector('.form-item-authors');
    if (!authorContainer) return;

    let authorPanes = authorContainer.querySelectorAll('.islandora-form-fieldpanel-pane');
    if (authorPanes.length === 0) authorPanes = authorContainer.querySelectorAll('table tbody tr:not(.tabledrag-hide)');

    parsedAuthors.forEach((auth, idx) => {
        if (authorPanes[idx]) {
            const pane = authorPanes[idx];
            const familyEl = pane.querySelector('input[name$="[family]"]');
            const givenEl = pane.querySelector('input[name$="[given]"]');

            if (familyEl) {
                familyEl.value = auth.family;
                familyEl.dispatchEvent(new Event('input', { bubbles: true }));
                familyEl.dispatchEvent(new Event('change', { bubbles: true }));
            }
            if (givenEl) {
                givenEl.value = auth.given;
                givenEl.dispatchEvent(new Event('input', { bubbles: true }));
                givenEl.dispatchEvent(new Event('change', { bubbles: true }));
            }

            // Note: We intentionally skip triggering the .lib4ri-author-fill button 
            // to avoid false-positive matches on the internal author object.
        }
    });
}

async function processBulkKeywords(text, separatorMode) {
    let sep = separatorMode;
    if (sep === 'auto') {
        const counts = {
            ',': (text.match(/,/g) || []).length,
            ';': (text.match(/;/g) || []).length,
            '\\n': (text.match(/\n/g) || []).length,
            '-': (text.match(/-/g) || []).length
        };
        let maxCount = 0;
        sep = ',';
        for (const [key, count] of Object.entries(counts)) {
            if (count > maxCount) {
                maxCount = count;
                sep = key;
            }
        }
    }

    let rawList = [];
    if (sep === '\\n') {
        rawList = text.split(/\n/);
    } else {
        rawList = text.split(sep);
    }

    const keywords = rawList.map(k => k.trim()).filter(k => k.length > 0);
    if (keywords.length === 0) return;

    // We use an async loop and re-fetch elements because Drupal AJAX replaces the DOM!
    for (const kw of keywords) {
        const container = findKeywordContainer();
        if (!container) {
            console.warn("Keyword-Feld konnte nicht gefunden werden.");
            break;
        }

        const tagInput = container.querySelector('input[type="text"].form-text, input.tag-input');
        const addBtn = container.querySelector('input[type="image"][src*="add.png"]');

        if (tagInput && addBtn) {
            // Schon beim Einfügen in DORAs Hausschreibweise bringen
            tagInput.value = await keywordSchreibweiseVersprochen(kw);
            tagInput.dispatchEvent(new Event('input', { bubbles: true }));
            tagInput.dispatchEvent(new Event('change', { bubbles: true }));

            await new Promise(r => setTimeout(r, 100));

            // Trigger the Add button
            addBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));

            // Wait for the AJAX call to replace the DOM (tagInput will be detached)
            let waitLimit = 40; // max 2000ms
            while (waitLimit > 0 && document.body.contains(tagInput)) {
                await new Promise(r => setTimeout(r, 50));
                waitLimit--;
            }

            await new Promise(r => setTimeout(r, 200)); // Let the new DOM settle

        } else if (tagInput) {
            // Fallback for simple textareas or standard text inputs without an Add button
            let current = tagInput.value.trim();
            if (current && !current.endsWith(',')) current += ', ';
            tagInput.value = current + kw;
            tagInput.dispatchEvent(new Event('input', { bubbles: true }));
            tagInput.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
            const textarea = container.querySelector('textarea');
            if (textarea) {
                let current = textarea.value.trim();
                if (current && !current.endsWith(',')) current += ', ';
                textarea.value = current + kw;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
                textarea.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    }
}

function injectDoraAutocompletes() {
    const fields = [
        { id: 'edit-confinfo-confname', solrField: 'mods_name_conference_ms' },
        { id: 'edit-host-titleinfo-title', solrField: 'mods_relatedItem_host_titleInfo_title_ms' },
        { id: 'edit-host-series-titleinfo-title', solrField: 'mods_relatedItem_host_relatedItem_series_titleInfo_title_ms' },
        { id: 'edit-host-series-issn', solrField: 'mods_relatedItem_host_relatedItem_series_identifier_issn_ms' }
    ];

    // Conditionally add Publisher autocomplete if NOT a Journal Article
    const pubTypeEl = document.getElementById('edit-publication-type');
    const isJournalArticle = pubTypeEl && pubTypeEl.value === 'Journal Article';

    if (!isJournalArticle) {
        fields.push({ id: 'edit-host-origininfo1-0-publisher', solrField: 'mods_originInfo_publisher_ms' });
        fields.push({ id: 'edit-origininfo1-0-publisher', solrField: 'mods_originInfo_publisher_ms' });
        fields.push({ id: 'edit-host-origininfo-0-publisher', solrField: 'mods_originInfo_publisher_ms' });
        fields.push({ id: 'edit-origininfo-0-publisher', solrField: 'mods_originInfo_publisher_ms' });
    }

    fields.forEach(field => {
        let input = document.getElementById(field.id);

        // Fallback for Series ISSN or if the ID is not an input
        if (!input || (input.tagName !== 'INPUT' && input.tagName !== 'TEXTAREA')) {
            if (field.id.includes('issn')) input = findField('ISSN') || findField('Series ISSN') || input;
            else if (field.id.includes('confname')) input = findField('Conference Name') || input;
        }

        if (!input || input.dataset.doraAutocompleteAttached) return;
        if (input.tagName !== 'INPUT' && input.tagName !== 'TEXTAREA') return;

        console.log('DORA Helper: Attaching custom autocomplete to', field.id);
        input.dataset.doraAutocompleteAttached = "true";
        attachCustomAutocomplete(input, field);
    });
}


// Custom dropdown autocomplete for <input> and <textarea> elements
function attachCustomAutocomplete(inputEl, field) {
    const wrapper = inputEl.closest('.form-item') || inputEl.parentNode;
    wrapper.style.position = 'relative';

    const dropdownId = `dora-dropdown-${field.id}`;
    let dropdown = document.getElementById(dropdownId);
    if (!dropdown) {
        dropdown = createEl('div', 'dora-autocomplete-dropdown');
        dropdown.id = dropdownId;
        Object.assign(dropdown.style, {
            position: 'absolute',
            top: '100%',
            left: '0',
            minWidth: '100%',
            width: 'max-content',
            maxWidth: '1200px',
            maxHeight: '200px',
            overflowY: 'auto',
            overflowX: 'auto',
            backgroundColor: '#fff',
            border: '1px solid #ccc',
            borderTop: 'none',
            borderRadius: '0 0 4px 4px',
            boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
            zIndex: '9999',
            display: 'none'
        });
        inputEl.insertAdjacentElement('afterend', dropdown);
    }

    inputEl.setAttribute('autocomplete', 'off');

    let debounceTimer;
    let selectedIndex = -1;

    inputEl.addEventListener('input', () => {
        const query = inputEl.value.trim();
        console.log('DORA Helper: Autocomplete input event', { fieldId: field.id, query, queryLength: query.length });
        if (query.length < 3) {
            dropdown.style.display = 'none';
            dropdown.replaceChildren();
            return;
        }

        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
            console.log('DORA Helper: Triggering fetch for', field.id);
            fetchSolrSuggestions(field.solrField, query, (results) => {
                console.log('DORA Helper: Got results for', field.id, ':', results.length, 'items');
                dropdown.replaceChildren();
                selectedIndex = -1;

                if (results.length === 0) {
                    dropdown.style.display = 'none';
                    return;
                }

                results.forEach((name, idx) => {
                    const item = createEl('div', 'dora-autocomplete-item', name.trim());
                    Object.assign(item.style, {
                        padding: '8px 12px',
                        cursor: 'pointer',
                        borderBottom: '1px solid #eee',
                        fontSize: '13px',
                        whiteSpace: 'nowrap'
                    });
                    item.addEventListener('mouseenter', () => {
                        item.style.backgroundColor = '#f0f0f0';
                    });
                    item.addEventListener('mouseleave', () => {
                        item.style.backgroundColor = '#fff';
                    });
                    item.addEventListener('click', () => {
                        inputEl.value = name.trim();
                        dropdown.style.display = 'none';
                        inputEl.focus();
                        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
                        inputEl.dispatchEvent(new Event('change', { bubbles: true }));

                        // Trigger fetching if this is the conference field
                        if (field.id === 'edit-confinfo-confname') {
                            fetchConferenceDetails(name.trim());
                        }
                    });
                    dropdown.appendChild(item);
                });

                dropdown.style.display = 'block';
            });
        }, 400);
    });

    // Keyboard navigation
    inputEl.addEventListener('keydown', (e) => {
        const items = dropdown.querySelectorAll('.dora-autocomplete-item');
        if (items.length === 0 || dropdown.style.display === 'none') return;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            updateSelection(items, selectedIndex);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, 0);
            updateSelection(items, selectedIndex);
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            inputEl.value = items[selectedIndex].textContent;
            dropdown.style.display = 'none';
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));

            // Trigger fetching if this is the conference field
            if (field.id === 'edit-confinfo-confname') {
                fetchConferenceDetails(inputEl.value.trim());
            }
        } else if (e.key === 'Escape') {
            dropdown.style.display = 'none';
        }
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
        if (!inputEl.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.style.display = 'none';
        }
    });
}

function updateSelection(items, index) {
    items.forEach((item, i) => {
        item.style.backgroundColor = i === index ? '#e6f3ff' : '#fff';
    });
    if (items[index]) {
        items[index].scrollIntoView({ block: 'nearest' });
    }
}

// Shared Solr fetch function
function fetchSolrSuggestions(solrField, query, callback) {
    const solrUrl = `http://lib-dora-prod1.emp-eaw.ch:8080/solr/collection1/select?q=*:*&rows=0&facet=true&facet.limit=15&wt=json&facet.field=${solrField}&facet.prefix=${encodeURIComponent(query)}&_=${Date.now()}`;

    console.log('DORA Helper: Fetching Solr suggestions', { solrField, query, solrUrl });

    chrome.runtime.sendMessage({
        action: "searchAutocomplete",
        url: solrUrl
    }, (response) => {
        console.log('DORA Helper: Solr response', response);
        if (response && response.success && response.data) {
            const facetFields = response.data.facet_counts?.facet_fields;
            const facetData = facetFields ? facetFields[solrField] : null;
            console.log('DORA Helper: facetData for', solrField, ':', facetData);

            if (facetData && Array.isArray(facetData)) {
                // Solr returns [Value1, Count1, Value2, Count2, ...]
                const results = facetData.filter((_, i) => i % 2 === 0).filter(Boolean);
                callback(results);
                return;
            }
        }
        callback([]);
    });
}

function getDoraBaseUrl() {
    const path = window.location.pathname;
    const segments = path.split('/').filter(s => s.length > 0);
    // Erkennt psi, eawag, empa oder wsl aus der URL
    if (segments.length > 0 && ['psi', 'eawag', 'empa', 'wsl'].includes(segments[0].toLowerCase())) {
        return `${window.location.origin}/${segments[0]}`;
    }
    return window.location.origin;
}

function loadExceptionsFromStorage(callback) {
    chrome.storage.sync.get({
        exceptionList: `x-ray -> X-ray\nx-rays -> X-rays\ndna -> DNA\nrna -> RNA\nph -> pH\nnmr -> NMR\nhplc -> HPLC\nuv -> UV\nir -> IR\npcr -> PCR\ntem -> TEM\nsem -> SEM\nafm -> AFM\nxps -> XPS\nswitzerland -> Switzerland\nzurich -> Zurich`
    }, function (items) {
        cachedExceptions = [];
        const lines = items.exceptionList.split('\n');
        lines.forEach(line => {
            if (!line.includes('->')) return;
            const parts = line.split('->');
            const pat = parts[0].trim();
            const rep = parts[1].trim();
            if (pat && rep) {
                const esc = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                try { cachedExceptions.push({ regex: new RegExp('\\b' + esc + '\\b', 'gi'), replacement: rep }); } catch (e) { }
            }
        });
        if (callback) callback();
    });
}

// --- PUBLISHER PAGE SCANNER (Zotero-style) ---
// PDF im mitgelieferten Betrachter oeffnen (eigenes Fenster, Marker fuer
// Lizenz/Foerderung/Keywords). Genutzt vom Batch-QC-Dashboard und von den
// PDF-Schaltern in der Ergebnisbox.
// Institut des aktuellen Datensatzes: erst der Pfad der DORA-Seite
// (/eawag/islandora/...), sonst das Praefix der PID (wsl:44194).
function aktuellesInstitut(kennung) {
    const bekannt = ['eawag', 'empa', 'wsl', 'psi'];

    const segmente = window.location.pathname.split('/').filter(Boolean);
    if (segmente.length && bekannt.indexOf(segmente[0].toLowerCase()) !== -1) {
        return segmente[0].toLowerCase();
    }

    const praefix = (kennung || '').split(':')[0].toLowerCase();
    if (bekannt.indexOf(praefix) !== -1) return praefix;

    return '';
}

// Beschriftung eines Knopfes setzen, ohne Symbol und Layout anzutasten.
// Der Text sitzt in einem eigenen Feld und wird bei Bedarf abgeschnitten,
// damit der Knopf seine Breite behaelt.
function knopfBeschriftung(btn, text) {
    if (!btn) return;
    let feld = btn.querySelector('.dora-knopf-text');
    if (!feld) {
        feld = createEl('span', 'dora-knopf-text');
        btn.appendChild(feld);
    }
    feld.textContent = text;
}

// Aus einer DOI oder PID einen brauchbaren Dateinamen machen - sonst heisst
// die abgelegte Datei "view" oder "pdf".
function pdfDateiname(kennung) {
    const roh = (kennung || '').trim();
    if (!roh) return '';
    return roh.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/[\\/:*?"<>|%]+/g, '_') + '.pdf';
}

function openPdfPreviewFenster(pdfUrl, nurWennOffen, kennung) {
    if (!pdfUrl) return;
    const name = pdfDateiname(kennung);
    const institut = aktuellesInstitut(kennung);
    const viewerUrl = `${chrome.runtime.getURL('pdf_viewer.html')}?file=${encodeURIComponent(pdfUrl)}`
        + (name ? `&name=${encodeURIComponent(name)}` : '')
        + (institut ? `&inst=${institut}` : '');
    try {
        chrome.runtime.sendMessage({
            action: 'openPopupWindow', url: viewerUrl,
            onlyIfOpen: !!nurWennOffen, width: 900, height: 1050
        }, (antwort) => {
            // Rückfall nur beim ausdruecklichen Klick, nicht beim Mitziehen
            if (nurWennOffen) return;
            if (!antwort || !antwort.success) window.open(viewerUrl, 'dora-qc-pdf');
        });
    } catch (e) {
        if (!nurWennOffen) window.open(viewerUrl, 'dora-qc-pdf');
    }
}

// Elsevier-Volltexte laufen über das Hintergrundskript, damit der
// Scopus-Schlüssel nicht in einer sichtbaren Adresse steht.
function openPdfPreviewElsevier(doi) {
    if (!doi) return;
    const institut = aktuellesInstitut(doi);
    const viewerUrl = `${chrome.runtime.getURL('pdf_viewer.html')}?elsevier=${encodeURIComponent(doi)}`
        + `&name=${encodeURIComponent(pdfDateiname(doi))}`
        + (institut ? `&inst=${institut}` : '');
    try {
        chrome.runtime.sendMessage({
            action: 'openPopupWindow', url: viewerUrl, onlyIfOpen: false, width: 900, height: 1050
        }, (antwort) => {
            if (!antwort || !antwort.success) window.open(viewerUrl, 'dora-qc-pdf');
        });
    } catch (e) {
        window.open(viewerUrl, 'dora-qc-pdf');
    }
}

// --- PDF-Quellen aus Nachweisdiensten ---
// Verlagsseiten sperren automatisierte Abrufe; Unpaywall, Crossref, OpenAlex,
// Europe PMC, Semantic Scholar und (mit Schlüssel) die Elsevier-API führen
// dagegen direkte Volltext-Links. Jeder Kandidat wird angetestet, damit
// "geprüft" auch wirklich heisst, dass ein PDF dahinter liegt.
function createPdfSourceButton(doi, hauptBtn) {
    const wrap = createEl('div', 'dora-aktion-zeile');
    wrap.style.position = 'relative';

    const btn = createEl('button', 'dora-box-btn btn-secondary');
    btn.type = 'button';
    btn.appendChild(createEl('span', '', '📚'));
    knopfBeschriftung(btn, 'Quellen …');
    btn.disabled = true;
    btn.title = 'Sucht direkte PDF-Links in Unpaywall, Crossref, OpenAlex, Europe PMC und Semantic Scholar';
    wrap.appendChild(btn);

    const liste = createEl('div');
    liste.style.cssText = 'display:none; position:absolute; right:0; z-index:10001; margin-top:4px; '
        + 'padding:6px 8px; background:#fff; border:1px solid #cbd5e0; border-radius:4px; '
        + 'box-shadow:0 4px 12px rgba(0,0,0,.12); font-size:12px; min-width:320px; max-width:440px; '
        + 'max-height:280px; overflow:auto;';
    wrap.appendChild(liste);

    btn.addEventListener('click', () => {
        if (btn.dataset.zustand === 'leer') { hole(true); return; }
        liste.style.display = liste.style.display === 'none' ? 'block' : 'none';
    });

    const oeffne = (kandidat) => {
        if (kandidat.elsevierApi) { openPdfPreviewElsevier(doi); return; }
        // Sperrt der Verlag den Helper aus, hilft der eigene Betrachter nicht -
        // im normalen Tab greifen Cookies und Cloudflare-Freigabe.
        if (!kandidat.geprueft && kandidat.blockiert) { window.open(kandidat.url, '_blank'); return; }
        openPdfPreviewFenster(kandidat.url, false, doi);
    };

    const zeige = (kandidaten) => {
        const geprueft = kandidaten.filter(k => k.geprueft);
        liste.replaceChildren();

        if (!kandidaten.length) {
            btn.dataset.zustand = 'leer';
            btn.disabled = false;
            knopfBeschriftung(btn, 'Keine PDF-Quelle gefunden');
            btn.style.opacity = '.6';
            btn.title = 'Unpaywall, Crossref, OpenAlex, Europe PMC und Semantic Scholar führen keinen Volltext-Link.'
                + '\nKlicken für eine erneute Suche.';
            return;
        }

        btn.dataset.zustand = geprueft.length ? 'treffer' : 'leer';
        btn.disabled = false;
        btn.style.opacity = '';
        if (geprueft.length) {
            knopfBeschriftung(btn, `${geprueft.length} PDF-Quelle${geprueft.length > 1 ? 'n' : ''} ✓`);
            btn.style.borderColor = '#2b6cb0';
            btn.style.color = '#2b6cb0';
            btn.title = 'Geprüfte direkte Links — anzeigen und öffnen';
        } else {
            knopfBeschriftung(btn, `${kandidaten.length} Quelle${kandidaten.length > 1 ? 'n' : ''}, keine geprüft ⚠`);
            btn.style.borderColor = '#d69e2e';
            btn.style.color = '#8a5a10';
            btn.title = 'Links gefunden, aber keiner lieferte ein PDF (Sperrseite oder Zugangsschranke).'
                + '\nKlicken für eine erneute Suche.';
        }

        // Bester geprüfter Treffer wandert in den Haupt-Button
        if (geprueft.length && hauptBtn) {
            const bester = geprueft[0];
            hauptBtn.dataset.doraGeprueft = 'ja';
            if (bester.elsevierApi) {
                hauptBtn.dataset.doraElsevier = doi;
                hauptBtn.removeAttribute('href');
                hauptBtn.style.cursor = 'pointer';
                hauptBtn.onclick = (e) => { e.preventDefault(); openPdfPreviewElsevier(doi); };
            } else {
                hauptBtn.href = bester.url;
            }
            hauptBtn.style.opacity = '';
            knopfBeschriftung(hauptBtn, `PDF (${bester.quellen[0]}) ✓`);
            starteHaikuAuswertung(doi, bester);
            hauptBtn.title = `Geprüfter Volltext über ${bester.quellen.join(', ')}`
                + (bester.version ? ` — ${bester.version}` : '')
                + (bester.nurVorschau
                    ? '\nAchtung: diese Quelle liefert nur die Vorschauseite, nicht den Volltext.'
                    : '')
                + '\nÖffnet die Helper-Vorschau (Strg-/Mittelklick: Originallink).';
        }

        kandidaten.forEach((k, i) => {
            const zeile = createEl('div');
            zeile.style.cssText = 'padding:5px 0; display:flex; gap:6px; align-items:baseline;'
                + (i ? ' border-top:1px solid #edf2f7;' : '');

            const marke = createEl('span', '', k.geprueft ? '✓' : '✗');
            marke.style.cssText = 'font-weight:bold; color:' + (k.geprueft ? '#2f855a' : '#a0aec0') + ';';
            zeile.appendChild(marke);

            const text = createEl('div');
            text.style.cssText = 'flex:1; min-width:0;';

            const kopf = createEl('div', '', k.quellenName || k.quellen[0]);
            kopf.style.cssText = 'font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            text.appendChild(kopf);

            const teile = [k.quellen.join(', ')];
            if (k.version) teile.push(k.version);
            if (k.license) teile.push(k.license);
            if (!k.geprueft && k.grund) teile.push(k.grund);
            if (!k.geprueft && k.blockiert) teile.push('im Browser meist erreichbar');
            if (k.nurVorschau) {
                teile.push(k.seiten === 1
                    ? 'nur Vorschauseite – kein Volltext'
                    : 'liefert oft nur die erste Seite');
            } else if (k.seiten > 1) {
                teile.push(`${k.seiten} Seiten`);
            }
            const unten = createEl('div', '', teile.join(' · '));
            unten.style.cssText = 'font-size:10px; color:#718096; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            unten.title = k.elsevierApi ? 'Elsevier Article Retrieval API (Schlüssel bleibt im Hintergrund)' : k.url;
            text.appendChild(unten);
            zeile.appendChild(text);

            const oeffnen = createEl('button', 'dora-box-btn btn-secondary');
            oeffnen.type = 'button';
            oeffnen.textContent = (!k.geprueft && k.blockiert) ? 'im Tab' : 'öffnen';
            oeffnen.title = (!k.geprueft && k.blockiert)
                ? 'Der Verlag blockiert den Helper – öffnet die Adresse in einem normalen Tab'
                : 'In der Helper-Vorschau öffnen';
            oeffnen.style.cssText = 'width:auto; padding:2px 8px; font-size:10px;';
            oeffnen.onclick = () => oeffne(k);
            zeile.appendChild(oeffnen);

            liste.appendChild(zeile);
        });
    };

    const hole = (erneut) => {
        btn.dataset.zustand = 'laeuft';
        btn.disabled = true;
        knopfBeschriftung(btn, erneut ? 'sucht erneut …' : 'PDF-Quellen …');
        chrome.runtime.sendMessage({ action: 'findPdfLinks', doi: doi, erneut: !!erneut }, (antwort) => {
            if (!antwort || !antwort.success) {
                btn.dataset.zustand = 'leer';
                btn.disabled = false;
                knopfBeschriftung(btn, 'PDF-Suche fehlgeschlagen');
                btn.title = ((antwort && antwort.error) || 'Keine Antwort') + '\nKlicken für einen neuen Versuch.';
                return;
            }
            zeige((antwort.data && antwort.data.kandidaten) || []);
        });
    };

    hole(false);
    return wrap;
}

// Einen PDF-Link der Ergebnisbox auf die Vorschau umbiegen. Der href bleibt
// erhalten: Strg-, Umschalt- und Mittelklick oeffnen weiterhin den Rohlink -
// wichtig, wenn ein Verlag die Datei nicht ausliefert.
function verknuepfePdfVorschau(anker, beschreibung, kennung) {
    if (!anker || anker.dataset.doraVorschau === 'ja') return;
    anker.dataset.doraVorschau = 'ja';
    anker.title = `${beschreibung || 'PDF'} in der Helper-Vorschau öffnen (mit Markern für Lizenz, Förderung, Keywords). Strg- oder Mittelklick öffnet den Originallink.`;
    anker.addEventListener('click', (e) => {
        if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        // Solange keine Adresse feststeht, passiert bewusst nichts
        if (!anker.getAttribute('href')) return;
        openPdfPreviewFenster(anker.href, false, kennung || anker.dataset.doraKennung || '');
    });
}

// Einen aus der Verlagsseite gelesenen PDF-Link antesten. Verlage liefern
// darauf oft nur eine Sperrseite; dann sagt der Knopf das, statt ein Angebot
// zu machen, das ins Leere läuft.
function pruefeVerlagsLink(btn, url) {
    if (!btn || !url) return;
    chrome.runtime.sendMessage({ action: 'verifyPdfUrl', url: url }, (antwort) => {
        const ergebnis = antwort && antwort.success ? antwort.data : null;
        const feld = btn.querySelector('.dora-knopf-text');
        const grundText = feld ? feld.textContent.replace(/ [✓⚠]$/, '') : '';
        if (ergebnis && ergebnis.ok) {
            btn.dataset.doraGeprueft = 'ja';
            if (feld) knopfBeschriftung(btn, grundText + ' ✓');
            btn.title = 'Geprüfter Verlags-Link – öffnet die Helper-Vorschau (Strg-/Mittelklick: Originallink)';
            return;
        }
        btn.dataset.doraGeprueft = 'nein';
        btn.style.borderColor = '#d69e2e';
        btn.style.color = '#8a5a10';
        if (feld) knopfBeschriftung(btn, grundText + ' ⚠');
        btn.title = 'Der Verlag liefert die Datei nicht an den Helper aus'
            + (ergebnis && ergebnis.grund ? ` (${ergebnis.grund})` : '')
            + '. Im normalen Tab (Strg- oder Mittelklick) klappt es meist trotzdem.';
    });
}

function findPublisherPdf(doi, rowContainer, existingPdfUrl) {
    const url = `https://doi.org/${doi}`;

    // Wir senden eine Nachricht an den Background-Worker, um HTML zu fetchen (CORS-Bypass)
    // Hinweis: Ihr Background-Script muss auf { action: "fetchHtml", url: ... } reagieren
    // und { success: true, data: "<html>..." } zurückgeben.
    chrome.runtime.sendMessage({ action: "fetchHtml", url: url }, (response) => {
        if (chrome.runtime.lastError || !response || !response.success) {
            // Still fail silently, as this is an enhancement
            return;
        }

        const htmlContent = response.data;
        const finalUrl = response.finalUrl || url; // URL nach Redirects (wichtig für relative Links)
        const foundPdfUrl = extractPdfFromHtml(htmlContent, finalUrl);

        if (foundPdfUrl && foundPdfUrl !== existingPdfUrl) {
            // Wir haben einen besseren/anderen Link gefunden!

            // Prüfen ob wir schon einen Haupt-Button haben
            const mainBtn = document.getElementById('dora-main-pdf-btn');

            // Ein bereits geprüfter Link aus den Nachweisdiensten ist besser
            // belegt als ein aus der Seite gelesener - der bleibt stehen.
            if (mainBtn && mainBtn.dataset.doraGeprueft === 'ja') return;

            if (mainBtn) {
                // Update existing button
                mainBtn.href = foundPdfUrl;
                mainBtn.style.opacity = '';
                knopfBeschriftung(mainBtn, 'PDF (Verlag)');
                mainBtn.title = "Direkter Link via Verlags-Metadaten gefunden – öffnet die Helper-Vorschau (Strg-/Mittelklick: Originallink)";
                // Aus der Seite geratene Links liefern oft nur eine Sperrseite -
                // deshalb antesten und das Ergebnis anschreiben.
                pruefeVerlagsLink(mainBtn, foundPdfUrl);
                mainBtn.style.border = "1px solid #2b6cb0";
                mainBtn.style.color = "#2b6cb0";

                // Update the analyze action next to it
                const analyzeBtn = rowContainer.querySelector('button.dora-blitz');
                if (analyzeBtn) {
                    analyzeBtn.onclick = () => handlePdfUrl(foundPdfUrl, analyzeBtn, null);
                }
            } else {
                // Create new if none existed
                const pubPdfBtn = createEl('a', 'dora-box-btn btn-secondary dora-aktion-zeile');
                pubPdfBtn.id = 'dora-main-pdf-btn';
                pubPdfBtn.href = foundPdfUrl;
                pubPdfBtn.target = '_blank';
                pubPdfBtn.appendChild(createEl('span', '', '📄'));
                knopfBeschriftung(pubPdfBtn, 'PDF (Verlag)');
                verknuepfePdfVorschau(pubPdfBtn, 'Verlags-PDF', doi);
                pruefeVerlagsLink(pubPdfBtn, foundPdfUrl);

                const analyzeBtn = createEl('button', 'dora-box-btn btn-secondary dora-blitz');
                analyzeBtn.type = 'button';
                analyzeBtn.textContent = '⚡';
                analyzeBtn.title = "Dieses Verlags-PDF mit Haiku auswerten";
                analyzeBtn.onclick = () => handlePdfUrl(foundPdfUrl, analyzeBtn, null);
                rowContainer.classList.add('dora-mit-blitz');

                rowContainer.appendChild(pubPdfBtn);
                rowContainer.appendChild(markierePdfAnalyse(analyzeBtn));
            }
        }
    });
}

function extractPdfFromHtml(html, baseUrl) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");

    // Helper um relative URLs aufzulösen
    const resolveUrl = (href) => {
        try { return new URL(href, baseUrl).href; } catch (e) { return href; }
    };

    // --- STRATEGIE 1: Highwire Press Tags (Der "Gold Standard" für Zotero) ---
    // Wird von fast allen großen Verlagen genutzt (Elsevier, Springer, Wiley, Taylor&Francis)
    const citationPdf = doc.querySelector('meta[name="citation_pdf_url"]');
    if (citationPdf && citationPdf.content) {
        return resolveUrl(citationPdf.content);
    }

    // --- STRATEGIE 2: JSON-LD (Schema.org) ---
    // Modernes Format, das oft versteckte PDF-Links in "encoding" oder "distribution" enthält
    const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const script of jsonLdScripts) {
        try {
            const json = JSON.parse(script.textContent);
            // Wir suchen nach Objekten, die ScholarlyArticle sind oder encoding haben
            const objects = Array.isArray(json) ? json : [json];

            for (const obj of objects) {
                // Suche nach "encoding" (oft bei Springer/Nature)
                if (obj.encoding) {
                    const encodings = Array.isArray(obj.encoding) ? obj.encoding : [obj.encoding];
                    for (const enc of encodings) {
                        if (enc.encodingFormat === 'application/pdf' && enc.contentUrl) {
                            return resolveUrl(enc.contentUrl);
                        }
                    }
                }
                // Suche nach "distribution"
                if (obj.distribution) {
                    const dists = Array.isArray(obj.distribution) ? obj.distribution : [obj.distribution];
                    for (const dist of dists) {
                        if ((dist.encodingFormat === 'application/pdf' || dist.fileFormat === 'application/pdf') && dist.contentUrl) {
                            return resolveUrl(dist.contentUrl);
                        }
                    }
                }
            }
        } catch (e) { /* Ignore JSON parse errors */ }
    }

    // --- STRATEGIE 3: Eprints & Bepress Tags (Repositories) ---
    const eprintsPdf = doc.querySelector('meta[name="eprints.document_url"]');
    if (eprintsPdf && eprintsPdf.content) {
        return resolveUrl(eprintsPdf.content);
    }

    const bepressPdf = doc.querySelector('meta[name="bepress_citation_pdf_url"]');
    if (bepressPdf && bepressPdf.content) {
        return resolveUrl(bepressPdf.content);
    }

    // --- STRATEGIE 4: Dublin Core (Fallback) ---
    const dcId = doc.querySelector('meta[name="DC.identifier"]');
    if (dcId && dcId.content && dcId.content.toLowerCase().endsWith('.pdf')) {
        return resolveUrl(dcId.content);
    }

    // --- STRATEGIE 5: COinS (ContextObjects in Spans) ---
    // Zotero nutzt dies oft als Fallback. Wir suchen im title-Attribut nach rft_id, die auf pdf endet.
    const coins = doc.querySelectorAll('span.Z3988');
    for (const coin of coins) {
        const title = coin.getAttribute('title');
        if (title && title.includes('rft_id=')) {
            const matches = title.match(/rft_id=([^&]+)/);
            if (matches && matches[1]) {
                const decoded = decodeURIComponent(matches[1]);
                if (decoded.toLowerCase().endsWith('.pdf')) return resolveUrl(decoded);
            }
        }
    }

    // --- STRATEGIE 6: Heuristik (Intelligente Link-Suche) ---
    // Wenn alles andere fehlschlägt, suchen wir nach echten Links im DOM
    const anchorTags = Array.from(doc.querySelectorAll('a'));
    for (const a of anchorTags) {
        const href = a.getAttribute('href');
        if (!href) continue;

        const hrefLower = href.toLowerCase();
        const textLower = ((a.innerText || a.textContent || '').toLowerCase());
        const titleLower = (a.getAttribute('title') || '').toLowerCase();
        const classLower = (a.getAttribute('class') || '').toLowerCase();

        // Muss auf .pdf enden ODER explizit "pdf" im Text/Klasse haben UND "download" oder "view" implizieren
        const looksLikePdf = hrefLower.endsWith('.pdf') || hrefLower.includes('/pdf/');
        const isPdfButton = textLower.includes('pdf') || classLower.includes('pdf') || titleLower.includes('pdf');

        // Filter: Vermeide "Help with PDF" oder "About PDF" Links
        const isHelpLink = textLower.includes('help') || textLower.includes('reader');

        if (looksLikePdf && isPdfButton && !isHelpLink) {
            return resolveUrl(href);
        }
    }

    return null;
}

function checkScopusAffiliation(doi, container) {
    const statusDiv = createEl('div', 'dora-affiliation-status', '');
    const icon = createEl('span', '', '✉️');
    icon.style.cssText = 'font-size: 1.2em; margin-right: 4px;';
    statusDiv.appendChild(icon);
    statusDiv.appendChild(document.createTextNode(' ⏳ Scopus...'));
    statusDiv.style.cssText = 'margin-bottom: 10px; font-size: 0.8em; color: #666; padding: 3px 8px; background: #f8f9fa; border-radius: 4px; border: 1px solid #eee; width: fit-content; display: flex; align-items: center;';
    container.appendChild(statusDiv);

    chrome.runtime.sendMessage({ action: "checkScopus", doi: doi }, (response) => {
        if (response && response.success) {
            const data = response.data;
            if (data.isLib4Ri) {
                let displayAffil = data.affiliation;
                if (displayAffil.length > 35) displayAffil = displayAffil.substring(0, 32) + '...';
                statusDiv.replaceChildren(); // Clear
                statusDiv.appendChild(icon.cloneNode(true));
                statusDiv.appendChild(document.createTextNode(' ✅ '));
                const b = createEl('b', '', 'Scopus: ');
                statusDiv.appendChild(b);
                statusDiv.appendChild(document.createTextNode(displayAffil));
                statusDiv.title = "Corresponding Author ist Lib4Ri affiliiert: " + data.affiliation;
                statusDiv.style.backgroundColor = '#f0fff4';
                statusDiv.style.borderColor = '#c6f6d5';
                statusDiv.style.color = '#22543d';
            } else {
                statusDiv.replaceChildren(); // Clear
                statusDiv.appendChild(icon.cloneNode(true));
                const b = createEl('b', '', 'Scopus: ');
                statusDiv.appendChild(b);
                statusDiv.appendChild(document.createTextNode(' Extern'));
                statusDiv.title = "Keine Lib4Ri-Affiliation gefunden. Gefunden: " + (data.affiliation || "Keine Daten");
                statusDiv.style.backgroundColor = '#fffaf0';
                statusDiv.style.borderColor = '#fbd38d';
                statusDiv.style.color = '#9c4221';
            }
        } else {
            statusDiv.style.display = 'none'; // Optional: Ausblenden bei Fehler
        }
    });
}

// --- LISTENERS ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "pdfDetected") {
        // Statt Button zu ändern, nutzen wir die Dropzone als Benachrichtigungsfläche
        const dropZone = document.querySelector('.dora-pdf-drop');
        if (dropZone) {
            dropZone.replaceChildren();
            dropZone.appendChild(document.createTextNode('⚡ '));
            const b = createEl('b', '', 'PDF Erkannt!');
            dropZone.appendChild(b);
            dropZone.appendChild(document.createElement('br'));
            const small = createEl('small', '', request.filename.substring(0, 25) + '...');
            dropZone.appendChild(small);

            dropZone.style.backgroundColor = '#e6fffa';
            dropZone.style.borderColor = '#38b2ac';
            dropZone.style.color = '#2c7a7b';

            // Klick auf Dropzone startet nun den Import dieses PDFs
            dropZone.onclick = (e) => {
                e.preventDefault(); // Kein File-Dialog
                dropZone.textContent = '⏳ Analysiere...';
                handlePdfUrl(request.url, null, request.localPath);
            };
        }
    }
});

// --- VALIDATION ---
function validateForm() {
    const errors = []; // Collect errors for summary

    const getField = (labelPart) => {
        const labels = document.querySelectorAll('label');
        for (const l of labels) {
            const beschriftung = (l.innerText || l.textContent || '');
            if (beschriftung.toLowerCase().includes(labelPart.toLowerCase())) {
                const id = l.getAttribute('for');
                if (id) {
                    const el = document.getElementById(id);
                    if (el) return el;
                }
                // Try finding input in the same form-item container
                const container = l.closest('.form-item') || l.parentNode;
                if (container) {
                    const input = container.querySelector('input:not([type="hidden"]), select, textarea');
                    if (input) return input;
                }
            }
        }
        return null;
    };

    const statusEl = getField('Publication Status');
    const volumeEl = getField('Volume');
    const startPageEl = getField('Start Page');
    const endPageEl = getField('End Page');
    const titleEl = getField('Article Title') || getField('Title');
    const confNameEl = document.getElementById('edit-confinfo-confname') || document.getElementById('edit-conference-name') || getField('Conference Name');
    const procTitleEl = document.getElementById('edit-host-titleinfo-title') || getField('Title of the Conference Proceedings');
    const seriesTitleEl = document.getElementById('edit-host-series-titleinfo-title');
    const pubTypeEl = document.getElementById('edit-publication-type');
    const bookTitleEl = document.getElementById('edit-host-booktitle'); // Book Title
    const docAvailabilityEl = getField('Document Availability');
    const conditionsReuseEl = getField('Conditions of Reuse');

    // Improved Year Selector: Try multiple IDs
    let pubYearEl = document.getElementById('edit-origininfodate-0-dateissued') ||
        document.getElementById('edit-dateissued');
    if (!pubYearEl) {
        pubYearEl = document.querySelector('input[name*="dateIssued"]');
    }
    if (!pubYearEl) {
        pubYearEl = getField('Publication Year');
    }

    // Attach listeners for real-time validation
    const attachListener = (el) => {
        if (!el) return;
        if (!el.dataset.doraValidatorAttached) {
            el.addEventListener('input', validateForm);
            el.addEventListener('change', validateForm);
            el.dataset.doraValidatorAttached = "true";
        }
        // Special handling for CKEditor
        if (el.classList.contains('ckeditor-processed')) {
            const ckeId = 'cke_' + el.id;
            const cke = document.getElementById(ckeId);
            if (cke) {
                const iframe = cke.querySelector('iframe');
                if (iframe && iframe.contentDocument) {
                    if (!iframe.dataset.doraValidatorAttached) {
                        const body = iframe.contentDocument.body;
                        if (body) {
                            body.addEventListener('input', validateForm);
                            body.addEventListener('keyup', validateForm);
                            body.addEventListener('blur', validateForm);
                            iframe.dataset.doraValidatorAttached = "true";
                        }
                    }
                }
            }
        }
    };

    [statusEl, volumeEl, startPageEl, endPageEl, titleEl, confNameEl, procTitleEl, seriesTitleEl, bookTitleEl, pubYearEl, docAvailabilityEl, conditionsReuseEl].forEach(el => attachListener(el));

    // Rule 1: Volume required if Published (BUT NOT for Book Chapter or Conference Item)
    const pubTypeVal = pubTypeEl ? pubTypeEl.value.toLowerCase() : '';
    const isVolumeOptional = pubTypeVal.includes('book chapter') || pubTypeVal.includes('conference item');

    if (statusEl && volumeEl && !isVolumeOptional) {
        let statusText = statusEl.value;
        if (statusEl.tagName === 'SELECT') {
            statusText = statusEl.options[statusEl.selectedIndex]?.text || '';
        }

        if (statusText.toLowerCase().includes('published')) {
            if (!volumeEl.value.trim()) {
                markError(volumeEl, true, 'Volume ist bei Status "Published" Pflicht.');
                errors.push('<b>Volume</b>: Pflichtfeld bei Status "Published".');
            } else {
                markError(volumeEl, false);
            }
        } else {
            markError(volumeEl, false);
        }
    } else if (volumeEl) {
        // Clear error if it was previously set but now ignored
        markError(volumeEl, false);
    }

    // Start Page Validation
    if (startPageEl) {
        const startVal = startPageEl.value.trim();
        let startPageError = null;

        // 1. Required if Published
        if (statusEl) {
            let statusText = statusEl.value;
            if (statusEl.tagName === 'SELECT') statusText = statusEl.options[statusEl.selectedIndex]?.text || '';

            if (statusText.toLowerCase().includes('published') && !startVal) {
                startPageError = 'Start Page ist bei Status "Published" Pflicht.';
                errors.push('<b>Start Page</b>: Pflichtfeld bei Status "Published".');
            }
        }

        // 2. Format check if End Page is empty
        if (!startPageError && startVal && endPageEl) {
            const endVal = endPageEl.value.trim();
            if (!endVal) {
                const ppPattern = /\(\d+\s*pp\.?\)/i;
                if (!ppPattern.test(startVal)) {
                    startPageError = 'Wenn End Page leer ist, muss hier die Seitenzahl stehen (z.B. "12 (5 pp.)").';
                    errors.push('<b>Start Page</b>: Format "X (Y pp.)" erforderlich wenn End Page leer.');
                }
            }
        }

        markError(startPageEl, !!startPageError, startPageError || '');
    }

    // Rule: Document Availability & Conditions of Reuse (Metadata Form)
    if (docAvailabilityEl && conditionsReuseEl) {
        let availText = docAvailabilityEl.value;
        if (docAvailabilityEl.tagName === 'SELECT') {
            availText = docAvailabilityEl.options[docAvailabilityEl.selectedIndex]?.text || '';
        }
        availText = availText.toLowerCase();

        let reuseText = '';
        if (conditionsReuseEl.tagName === 'SELECT') {
            reuseText = conditionsReuseEl.options[conditionsReuseEl.selectedIndex]?.text || '';
        } else {
            reuseText = conditionsReuseEl.value;
        }
        
        const reuseVal = conditionsReuseEl.value;
        const cleanReuseText = reuseText.trim().toLowerCase();
        
        const isLicenseSelected = reuseVal !== '' && 
                                  reuseVal !== '_none' && 
                                  reuseVal !== 'none' && 
                                  cleanReuseText !== '' && 
                                  !cleanReuseText.includes('- none -') && 
                                  !cleanReuseText.includes('select') &&
                                  !cleanReuseText.includes('unspecified');

        if (isLicenseSelected && (availText.includes('intranet') || availText.includes('private'))) {
            markError(docAvailabilityEl, true, 'Wenn eine Lizenz (Conditions of Reuse) ausgewählt ist, darf Document Availability nicht "Intranet" oder "Private" sein.');
            errors.push('<b>Document Availability</b>: Darf nicht "Intranet" oder "Private" sein, wenn eine Lizenz ausgewählt ist.');
        } else {
            markError(docAvailabilityEl, false);
        }
    } else if (docAvailabilityEl) {
        markError(docAvailabilityEl, false);
    }

    // Rule: Document Availability & Conditions of Reuse (PDF Upload Screen / Ingest)
    const pdfAvailSelects = document.querySelectorAll('select[id*="-availability"]');
    pdfAvailSelects.forEach(availSelect => {
        const match = availSelect.id.match(/^(.*?)-availability/);
        if (match) {
            const baseId = match[1];
            const licenseSelect = document.getElementById(baseId + '-use-perm-manual') || document.getElementById(baseId + '-use-permission');
            if (licenseSelect) {
                attachListener(availSelect);
                attachListener(licenseSelect);

                let availText = availSelect.options[availSelect.selectedIndex]?.text.toLowerCase() || '';
                
                let reuseText = licenseSelect.options[licenseSelect.selectedIndex]?.text || '';
                const reuseVal = licenseSelect.value;
                const cleanReuseText = reuseText.trim().toLowerCase();
                
                const isLicenseSelected = reuseVal !== '' && 
                                          reuseVal !== '_none' && 
                                          reuseVal !== 'none' && 
                                          cleanReuseText !== '' && 
                                          !cleanReuseText.includes('- none -') && 
                                          !cleanReuseText.includes('select') &&
                                          !cleanReuseText.includes('unspecified');

                if (isLicenseSelected && (availText.includes('intranet') || availText.includes('private'))) {
                    markError(availSelect, true, 'Wenn eine Lizenz ausgewählt ist, darf Document Availability nicht "Intranet" oder "Private" sein.');
                    errors.push(`<b>Document Availability (PDF)</b>: Darf nicht "Intranet" oder "Private" sein, wenn eine Lizenz ausgewählt ist.`);
                } else {
                    markError(availSelect, false);
                }
            }
        }
    });

    // Rule 3: Sentence Case Checks
    // Das Feld edit-host-titleinfo-title fuehrt bei Zeitschriftenaufsaetzen den
    // Journalnamen - der ist ein Eigenname und in DORA korrekt in Title Case
    // ("Physical Review B"). Nur bei Proceedings/Buechern gilt Sentence case.
    const hostIstJournal = feldIstJournalname(procTitleEl);

    // Jede Regelgruppe fuer sich: stolpert eine, werden die uebrigen Felder
    // trotzdem geprueft und die Zusammenfassung stimmt weiterhin.
    const regel = (name, fn) => {
        try { fn(); }
        catch (e) { console.error('DORA Helper: Regel «' + name + '» abgebrochen.', e); }
    };

    regel('Article Title', () => checkSentenceCase(titleEl, 'Article Title', errors));
    regel('Conference Name', () => checkSentenceCase(confNameEl, 'Conference Name', errors));
    regel('Host Title', () => checkSentenceCase(procTitleEl,
        hostIstJournal ? 'Journal Title' : 'Proceedings Title', errors,
        { eigenname: hostIstJournal }));
    // Serientitel sind haeufig Reihennamen ("WSL Berichte", "Proceedings of
    // SPIE") - dort zaehlt nur der harte Hinweis auf Title Case.
    regel('Series Title', () => checkSentenceCase(seriesTitleEl, 'Series Title', errors,
        { nurFunktionswoerter: true }));
    regel('Book Title', () => checkSentenceCase(bookTitleEl, 'Book Title', errors));

    // Rule 4: Author Table Validation (including PSI Affiliation check)
    const pubYear = pubYearEl ? pubYearEl.value.trim() : null;
    regel('Autorenzeilen', () => validateAuthorRows(errors, pubYear));

    // Render Summary - immer, damit nie ein veralteter Stand stehen bleibt
    renderErrorSummary(errors);
}

function feldIstJournalname(el) {
    if (!el) return false;

    let beschriftung = '';
    if (el.id) {
        const label = document.querySelector('label[for="' + el.id + '"]');
        if (label) beschriftung = label.innerText || label.textContent || '';
    }
    if (!beschriftung) {
        const huelle = el.closest('.form-item') || el.parentElement;
        const label = huelle ? huelle.querySelector('label') : null;
        if (label) beschriftung = label.innerText || label.textContent || '';
    }

    const text = beschriftung.toLowerCase();
    if (/proceeding|conference|book/.test(text)) return false;
    return /journal|periodical|zeitschrift/.test(text);
}

function checkSentenceCase(el, label, errors, optionen) {
    if (!el) return;

    let val = el.value.trim();

    // CKEditor handling
    if (el.classList.contains('ckeditor-processed')) {
        const cke = document.getElementById('cke_' + el.id);
        if (cke) {
            const iframe = cke.querySelector('iframe');
            if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
                const editorText = iframe.contentDocument.body.innerHTML.trim();
                if (editorText) val = editorText;
            }
        }
    }

    const befund = pruefeSatzschreibung(val, optionen || {});
    if (!befund.ok) {
        markError(el, true, label + ' ' + befund.meldung);
        errors.push('<b>' + label + '</b>: ' + befund.meldung);
    } else {
        markError(el, false);
    }
}

function validateAuthorRows(errors, pubYear) {
    const pYearInt = parseInt(pubYear, 10);
    // Check if we are in PSI context (URL contains /psi/)
    const isPsiContext = window.location.href.includes('/psi/');
    const isOldPsiPub = isPsiContext && !isNaN(pYearInt) && pYearInt < 2006;

    // 1. Specific Islandora Fieldpanel Logic
    // Find all author panes/rows anywhere on the page to support alternate forms like lib4ridora_pdf_upload
    let allPanes = document.querySelectorAll('.islandora-form-fieldpanel-pane, table tbody tr:not(.tabledrag-hide)');
    let processedNameInputs = new Set();
    let authorPanes = Array.from(allPanes).filter(pane => {
        const nameInput = pane.querySelector('input[type="text"][name$="[valName]"]');
        if (nameInput && !processedNameInputs.has(nameInput)) {
            processedNameInputs.add(nameInput);
            return true;
        }
        return false;
    });

    if (authorPanes.length > 0) {
        authorPanes.forEach((pane, idx) => {
            const nameInput = pane.querySelector('input[type="text"][name$="[valName]"]');

            // Corrected selectors based on HTML structure
            const groupInput = pane.querySelector('input[type="text"][name$="[affiliation]"]'); // "Group" field
            const sectionInput = pane.querySelector('input[type="text"][name$="[section_name]"]');
            const labInput = pane.querySelector('input[type="text"][name$="[department_name]"]'); // "Laboratory" field
            const divisionInput = pane.querySelector('input[type="text"][name$="[division_name]"]');

            // Get First and Last Name for lookup
            const familyInput = pane.querySelector('input[name$="[family]"]');
            const givenInput = pane.querySelector('input[name$="[given]"]');

            const authorDisplay = familyInput && familyInput.value.trim() ? familyInput.value.trim() : `Author ${idx + 1}`;

            if (nameInput) {
                // Attach listeners
                const inputs = [nameInput, groupInput, sectionInput, labInput, divisionInput, familyInput, givenInput];
                inputs.forEach(inp => {
                    if (inp && !inp.dataset.doraValidatorAttached) {
                        inp.addEventListener('input', validateForm);
                        inp.addEventListener('change', validateForm);
                        inp.dataset.doraValidatorAttached = "true";
                    }
                });

                const nameVal = nameInput.value.trim();

                // Rule 4a: Check Name content
                if (/nomatch/i.test(nameVal) || /4ri/i.test(nameVal)) {
                    markError(nameInput, true, 'Darf nicht "nomatch" oder "4RI" enthalten.');
                    errors.push(`<b>${authorDisplay} (Name)</b>: Darf nicht "nomatch" oder "4RI" enthalten.`);
                } else {
                    markError(nameInput, false);
                }
                    // Rule 4b: Dependency (If name is present, at least Group or Lab should be present)
                    if (nameVal) {
                        const hasAffiliation = (groupInput && groupInput.value.trim()) || (labInput && labInput.value.trim());
                        if (!hasAffiliation) {
                            // Check if author valName is linked. If so, autofill probably failed to resolve the unit.
                            let autofillFailed = false;
                            if (nameInput) {
                                const authorPidName = nameInput.name.replace('[valName]', '[pid]');
                                const authorPidInput = pane.querySelector(`input[name="${authorPidName}"]`);
                                if (authorPidInput && authorPidInput.value.trim()) {
                                    autofillFailed = true;
                                }
                            }

                            // Mark Group as the primary missing field
                            if (groupInput) {
                                if (autofillFailed) {
                                    markError(groupInput, true, '🦄 Affiliation Autofill fehlgeschlagen. Bitte Einheit manuell in das Feld eingeben und aus der Liste auswählen.');
                                    errors.push(`<b>${authorDisplay}</b>: 🦄 Affiliation Autofill fehlgeschlagen. Bitte Einheit manuell in das Feld eingeben und aus der Liste auswählen.`);
                                } else {
                                    markError(groupInput, true, 'Affiliation (Group/Lab) ist erforderlich.');
                                    errors.push(`<b>${authorDisplay}</b>: Affiliation fehlt.`);
                                }
                            } else {
                                errors.push(`<b>${authorDisplay}</b>: Affiliation fehlt.`);
                            }
                        } else {
                            if (groupInput) markError(groupInput, false);
                        }

                        // Rule 4b2: Check if unit inputs are properly linked (must have a pid)
                        const unlinkedFields = new Set();
                        [
                            { el: groupInput, name: 'Group', suffix: '[affiliation]' },
                            { el: sectionInput, name: 'Section', suffix: '[section_name]' },
                            { el: labInput, name: 'Laboratory', suffix: '[department_name]' },
                            { el: divisionInput, name: 'Division', suffix: '[division_name]' }
                        ].forEach(item => {
                            if (item.el && item.el.value.trim()) {
                                // Find corresponding hidden pid field
                                const pidName = item.el.name.replace(item.suffix, '[pid]');
                                // The pid field might be anywhere in the pane (usually in a preceding td)
                                const pidInput = pane.querySelector(`input[name="${pidName}"]`);
                                
                                if (pidInput && !pidInput.value.trim()) {
                                    markError(item.el, true, 'Eintrag ist nicht verlinkt. Bitte aus der Liste auswählen.', true);
                                    errors.push(`<b>${authorDisplay} (${item.name})</b>: "${item.el.value}" ist nicht verlinkt. Bitte aus der Liste auswählen.`);
                                    unlinkedFields.add(item.el);
                                }
                            }
                        });

                        // Rule 4c: Historical Affiliation Check (Only for PSI)
                        const clearStammdatenError = (el) => {
                            if (el && (!el.classList.contains('dora-error') || el.title.includes('Stammdaten'))) {
                                markError(el, false);
                            }
                        };

                        // Check if URL contains /psi/
                        if (window.location.href.includes('/psi/') && typeof findPersonAffiliation === 'function' && familyInput) {
                            const lastname = familyInput.value.trim();
                            const firstname = givenInput ? givenInput.value.trim() : "";

                            console.log(`Checking affiliation for: ${lastname}, ${firstname} (${pubYear})`);

                        const personData = findPersonAffiliation(lastname, firstname, pubYear, nameVal);
                        console.log("Person Data:", personData);

                        if (personData) {
                            if (personData.year) {
                                // Check if current deptVal matches any of the valid units
                                // Use looser matching: check if validName is contained in deptVal OR deptVal is contained in validName

                                // Check Group
                                if (groupInput && !unlinkedFields.has(groupInput)) {
                                    const groupVal = groupInput.value.trim();
                                    if (groupVal && !personData.units.some(u => groupVal.includes(u) || u.includes(groupVal))) {
                                        markError(groupInput, true, `Warnung: "${groupVal}" stimmt nicht mit den Stammdaten für ${pubYear} überein.`);
                                        errors.push(`<b>${authorDisplay} (Group)</b>: "${groupVal}" stimmt nicht mit den Stammdaten für ${pubYear} überein. <br>Erwartet: ${personData.expectedGroup || 'N/A'}`);
                                    } else {
                                        clearStammdatenError(groupInput);
                                    }
                                }

                                // Check Laboratory
                                if (labInput && !unlinkedFields.has(labInput)) {
                                    const labVal = labInput.value.trim();
                                    if (labVal && !personData.units.some(u => labVal.includes(u) || u.includes(labVal))) {
                                        markError(labInput, true, `Warnung: "${labVal}" stimmt nicht mit den Stammdaten für ${pubYear} überein.`);
                                        errors.push(`<b>${authorDisplay} (Lab)</b>: "${labVal}" stimmt nicht mit den Stammdaten für ${pubYear} überein. <br>Erwartet: ${personData.expectedLab || 'N/A'}`);
                                    } else {
                                        clearStammdatenError(labInput);
                                    }
                                }

                                // Check Division
                                if (divisionInput && !unlinkedFields.has(divisionInput)) {
                                    const divVal = divisionInput.value.trim();

                                    // Special Exception: If Group is "0000 PSI", do not flag Division errors
                                    const is0000PSI = groupInput && groupInput.value.includes('0000 PSI');

                                    if (!is0000PSI && divVal && !personData.units.some(u => divVal.includes(u) || u.includes(divVal))) {
                                        markError(divisionInput, true, `Warnung: "${divVal}" stimmt nicht mit den Stammdaten für ${pubYear} überein.`, true);
                                        errors.push(`<b>${authorDisplay} (Division)</b>: Die Division wurde mittlerweile umbenannt, hat aber Gültigkeit für den Eintrag.`);
                                    } else {
                                        clearStammdatenError(divisionInput);
                                    }
                                }

                            } else {
                                // Person found but not for this year
                                console.log("Person found but not for year " + pubYear);
                                if (groupInput && !unlinkedFields.has(groupInput)) clearStammdatenError(groupInput);
                                if (labInput && !unlinkedFields.has(labInput)) clearStammdatenError(labInput);
                                if (divisionInput && !unlinkedFields.has(divisionInput)) clearStammdatenError(divisionInput);
                            }
                        } else {
                            // Person not found in DB
                            console.log("Person not found in DB");

                            const currentYear = new Date().getFullYear();
                            const pYear = parseInt(pubYear, 10);

                            if (!isNaN(pYear) && pYear >= 2006 && (currentYear - pYear >= 3)) {
                                errors.push(`<b>${authorDisplay}</b>: Person "${lastname}, ${firstname}" nicht in den Stammdaten gefunden.`);
                            }
                            if (groupInput && !unlinkedFields.has(groupInput)) clearStammdatenError(groupInput);
                            if (labInput && !unlinkedFields.has(labInput)) clearStammdatenError(labInput);
                            if (divisionInput && !unlinkedFields.has(divisionInput)) clearStammdatenError(divisionInput);
                        }
                    } else {
                        if (groupInput && !unlinkedFields.has(groupInput)) clearStammdatenError(groupInput);
                        if (labInput && !unlinkedFields.has(labInput)) clearStammdatenError(labInput);
                        if (divisionInput && !unlinkedFields.has(divisionInput)) clearStammdatenError(divisionInput);
                    }

                    // Rule 4d: Completeness (If Group is set, Lab and Division should be set)
                    if (groupInput && groupInput.value.trim()) {
                        if (isOldPsiPub) {
                            const groupVal = groupInput.value.trim();
                            if (!groupVal.includes('0000 PSI') && !unlinkedFields.has(groupInput)) {
                                markError(groupInput, true, 'Für Publikationen vor 2006 wird "0000 PSI" erwartet.');
                                errors.push(`<b>${authorDisplay} (Group)</b>: Für Publikationen vor 2006 wird "0000 PSI" erwartet.`);
                            }
                        } else {
                            const groupVal = groupInput.value.trim();
                            // Special Rule: Division Heads (e.g. 1000-9000) or '0000 PSI' don't need a Lab
                            const isSpecialGroup = /^[1-9]000/.test(groupVal) || groupVal.includes('0000 PSI');

                            if (labInput) {
                                if (!labInput.value.trim() && !isSpecialGroup) {
                                    markError(labInput, true, 'Laboratory sollte ausgefüllt sein, wenn Group vorhanden ist.');
                                    errors.push(`<b>${authorDisplay} (Lab)</b>: Laboratory fehlt (Group ist gesetzt).`);
                                } else if (!labInput.title.includes('Stammdaten') && !unlinkedFields.has(labInput)) {
                                    markError(labInput, false);
                                }
                            }

                            if (divisionInput) {
                                if (!divisionInput.value.trim() && !isSpecialGroup) {
                                    markError(divisionInput, true, 'Division sollte ausgefüllt sein, wenn Group vorhanden ist.');
                                    errors.push(`<b>${authorDisplay} (Division)</b>: Division fehlt (Group ist gesetzt).`);
                                } else if (!divisionInput.title.includes('Stammdaten') && !divisionInput.title.includes('umbenannt') && !unlinkedFields.has(divisionInput)) {
                                    markError(divisionInput, false);
                                }
                            }
                        }
                    }
                } else {
                    // Reset if no name
                    if (groupInput) markError(groupInput, false);
                }

                // Highlight the entire pane if it contains any errors
                if (pane.querySelector('.dora-error')) {
                    pane.style.setProperty('outline', '2px solid #e53e3e', 'important');
                    pane.style.setProperty('background-color', '#fff5f5', 'important');
                } else {
                    pane.style.removeProperty('outline');
                    pane.style.removeProperty('background-color');
                }
            }
        });
    }

    // 2. Fallback / Generic Table Logic (for other forms)
    const tables = document.querySelectorAll('table');
    tables.forEach(table => {
        // Find headers
        const headers = Array.from(table.querySelectorAll('thead th, tr th')).map(th => ((th.innerText || th.textContent || '').trim()).toLowerCase());

        // Locate columns
        const nameIdx = headers.findIndex(h => h.includes('standardized form of name'));
        const deptIdx = headers.findIndex(h => h.includes('department') || h.includes('affiliation'));

        if (nameIdx !== -1 && deptIdx !== -1) {
            const rows = table.querySelectorAll('tbody tr');
            rows.forEach((row, idx) => {
                const cells = row.querySelectorAll('td');
                if (cells.length > Math.max(nameIdx, deptIdx)) {
                    const nameInput = cells[nameIdx].querySelector('input[type="text"]');
                    const deptInput = cells[deptIdx].querySelector('input, select');

                    if (nameInput && deptInput) {
                        if (!nameInput.dataset.doraValidatorAttached) {
                            nameInput.addEventListener('input', validateForm);
                            nameInput.dataset.doraValidatorAttached = "true";
                        }
                        if (!deptInput.dataset.doraValidatorAttached) {
                            deptInput.addEventListener('input', validateForm);
                            deptInput.addEventListener('change', validateForm);
                            deptInput.dataset.doraValidatorAttached = "true";
                        }

                        const nameVal = nameInput.value.trim();
                        const deptVal = deptInput.value.trim();

                        if (/nomatch/i.test(nameVal) || /4ri/i.test(nameVal)) {
                            markError(nameInput, true, 'Darf nicht "nomatch" oder "4RI" enthalten.');
                            errors.push(`<b>Author Row ${idx + 1} (Name)</b>: Invalid content.`);
                        } else {
                            markError(nameInput, false);
                        }

                        if (nameVal) {
                            if (!deptVal || deptVal === '_none' || deptVal === '- Select -') {
                                markError(deptInput, true, 'Affiliation/Department ist erforderlich.');
                                errors.push(`<b>Author Row ${idx + 1} (Dept)</b>: Missing Department.`);
                            } else {
                                markError(deptInput, false);
                            }
                        } else {
                            markError(deptInput, false);
                        }
                    }

                    // Highlight the entire row if it contains any errors
                    if (row.querySelector('.dora-error')) {
                        row.style.setProperty('outline', '2px solid #e53e3e', 'important');
                        row.style.setProperty('background-color', '#fff5f5', 'important');
                    } else {
                        row.style.removeProperty('outline');
                        row.style.removeProperty('background-color');
                    }
                }
            });
        }
    });
}

function renderErrorSummary(errors) {
    let panel = document.getElementById('dora-error-summary');

    // Generate a simple hash of the errors to detect changes
    const currentErrorsHash = JSON.stringify(errors);

    // Skip re-render if nothing changed (unless panel was removed)
    if (panel && currentErrorsHash === lastErrorsHash && isSummaryMinimized === lastMinimizedState) {
        return;
    }

    lastErrorsHash = currentErrorsHash;
    lastMinimizedState = isSummaryMinimized;

    if (errors.length === 0) {
        if (panel) panel.remove();
        return;
    }

    // Capture current scroll position before re-rendering
    let savedScrollTop = 0;
    if (panel) {
        const oldList = panel.querySelector('ul');
        if (oldList) savedScrollTop = oldList.scrollTop;
    }

    if (!panel) {
        panel = createEl('div', 'dora-error-summary');
        panel.id = 'dora-error-summary';
        // Basis-Styling (Position & Z-Index)
        panel.style.cssText = 'position: fixed; bottom: 20px; right: 20px; z-index: 9999; font-family: sans-serif; font-size: 13px; color: #333; transition: all 0.2s ease; box-shadow: 0 0 10px rgba(0,0,0,0.1); border-radius: 5px; background: white; border: 1px solid #ccc;';
        document.body.appendChild(panel);
    }

    panel.replaceChildren();

    if (isSummaryMinimized) {
        // --- MINIMIERTE ANSICHT ---
        panel.style.width = 'auto';
        panel.style.height = 'auto';
        panel.style.padding = '8px 12px';
        panel.style.cursor = 'pointer';
        panel.style.backgroundColor = '#fff5f5';
        panel.style.borderColor = '#fc8181';
        panel.style.borderLeft = '1px solid #fc8181';
        panel.title = "Klicken, um Fehlerdetails anzuzeigen";

        const icon = createEl('span', '', '⚠️');
        icon.style.fontSize = '1.2em';
        icon.style.marginRight = '5px';
        panel.appendChild(icon);
        const b = createEl('b', '', errors.length.toString());
        panel.appendChild(b);

        panel.onclick = () => {
            isSummaryMinimized = false;
            renderErrorSummary(errors); // Neu rendern (maximiert)
        };

    } else {
        // --- MAXIMIERTE ANSICHT ---
        panel.style.width = '256px';
        panel.style.maxHeight = '320px';
        panel.style.padding = '12px';
        panel.style.cursor = 'default';
        panel.style.backgroundColor = '#fff5f5';
        panel.style.borderColor = '#e53e3e';
        panel.style.borderLeft = '5px solid #e53e3e';
        panel.onclick = null;

        const header = createEl('div');
        header.style.cssText = 'display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; border-bottom:1px solid #e53e3e; padding-bottom:5px;';

        const title = createEl('span');
        const b = createEl('b', '', `${errors.length} Probleme:`);
        b.style.color = '#c53030';
        b.style.fontSize = '0.85em';
        title.appendChild(b);

        const minBtn = createEl('span', '', '➖');
        minBtn.title = "Minimieren";
        minBtn.style.cssText = 'cursor:pointer; font-weight:bold; color:#c53030; padding: 0 5px; font-size: 1.2em;';
        minBtn.onclick = (e) => {
            e.stopPropagation();
            isSummaryMinimized = true;
            renderErrorSummary(errors); // Neu rendern (minimiert)
        };

        header.appendChild(title);
        header.appendChild(minBtn);
        panel.appendChild(header);

        const list = createEl('ul');
        list.id = 'dora-error-list';
        list.style.cssText = 'padding-left:20px; margin:0; overflow-y:auto; max-height:300px;';

        errors.forEach(err => {
            const li = createEl('li');
            li.style.marginBottom = '5px';

            // Safe rendering of error message (allows <b> and <br> but escapes user input)
            // Error string format: "<b>Label</b>: Message" or similar
            const parts = err.split(/(<br\s*\/?>|<b>|<\/b>)/i);
            let isBold = false;
            parts.forEach(part => {
                if (part.toLowerCase() === '<b>') { isBold = true; return; }
                if (part.toLowerCase() === '</b>') { isBold = false; return; }
                if (part.toLowerCase().startsWith('<br')) { li.appendChild(document.createElement('br')); return; }

                if (part) {
                    const node = isBold ? createEl('b', '', part) : document.createTextNode(part);
                    li.appendChild(node);
                }
            });

            // Was sagt das DORA-Handbuch zu diesem Feld? Der Auszug haengt
            // aufklappbar unter der Meldung, damit die Regel dort steht, wo
            // sie gebraucht wird - statt "falsch" nur zu behaupten.
            const feldTreffer = /^<b>(.+?)<\/b>/i.exec(err);
            if (feldTreffer) {
                haengeHandbuchAn(li, feldTreffer[1].trim(), err.replace(/<[^>]*>/g, ' '));
            }

            // Scroll-Logik
            li.style.cursor = 'pointer';
            li.title = "Klicken, um zum ersten Fehler zu springen";
            li.onclick = () => {
                const firstError = document.querySelector('.dora-error');
                if (firstError) firstError.scrollIntoView({ behavior: "smooth", block: "center" });
            };

            list.appendChild(li);
        });

        panel.appendChild(list);

        // Restore scroll position
        if (savedScrollTop > 0) {
            list.scrollTop = savedScrollTop;
        }
    }
}

function markError(el, isError, msg = '', isWarning = false) {
    let target = el;
    // Handle CKEditor visual target
    if (el.classList.contains('ckeditor-processed')) {
        const cke = document.getElementById('cke_' + el.id);
        if (cke) target = cke;
    }

    if (isError) {
        target.classList.add('dora-error');
        if (isWarning) {
            target.style.setProperty('border', '2px dotted #e53e3e', 'important');
        } else {
            target.style.setProperty('border', '2px solid #e53e3e', 'important');
        }
        if (target === el) target.style.setProperty('background-color', '#fff5f5', 'important'); // Only color bg if it's the input
        target.title = msg;
    } else {
        target.classList.remove('dora-error');
        target.style.removeProperty('border');
        if (target === el) target.style.removeProperty('background-color');
        target.title = '';
    }

    // Das Handbuch-Symbol an der Beschriftung mitziehen: bei einer
    // Beanstandung leuchtet es auf, weil dann meist genau dort die Regel steht.
    // Nur Schmuck - ein Fehler darin darf die Pruefung der uebrigen Felder
    // nicht abbrechen, denn markError laeuft mitten in validateForm.
    try {
        handbuchSymbolAlarm(el, isError, msg);
    } catch (e) {
        console.warn('DORA Helper: Handbuch-Symbol konnte nicht mitgezogen werden.', e);
    }
}

// Das 📖 an der Beschriftung des Feldes hervorheben (oder beruhigen).
function handbuchSymbolAlarm(el, istFehler, meldung) {
    if (!el || !el.id) return;

    let label = document.querySelector('label[for="' + el.id + '"]');
    if (!label) {
        const huelle = el.closest ? (el.closest('.form-item') || el.parentElement) : null;
        label = huelle ? huelle.querySelector('label[data-dora-handbuch]') : null;
    }
    const knopf = label ? label.querySelector('.dora-handbuch-knopf') : null;
    if (!knopf) return;

    const feld = label.dataset.doraHandbuch || '';

    if (istFehler) {
        if (knopf.classList.contains('dora-handbuch-alarm')) return; // schon aktiv
        knopf.classList.add('dora-handbuch-alarm');
        knopf.title = `Beanstandet – im DORA-Handbuch zu «${feld}» nachlesen`
            + (meldung ? '\n' + String(meldung).replace(/<[^>]*>/g, '') : '');

        // Einmal kurz aufblitzen, damit der Wechsel auffällt
        knopf.classList.remove('dora-handbuch-blitz');
        void knopf.offsetWidth;
        knopf.classList.add('dora-handbuch-blitz');
        setTimeout(() => knopf.classList.remove('dora-handbuch-blitz'), 1500);
        return;
    }

    if (!knopf.classList.contains('dora-handbuch-alarm')) return;
    knopf.classList.remove('dora-handbuch-alarm', 'dora-handbuch-blitz');
    knopf.title = `DORA-Handbuch zu «${feld}» anzeigen`;
}

// --- CONFERENCE AUTO-FILL ---
// --- CONFERENCE AUTO-FILL ---
function fetchConferenceDetails(confName) {
    console.log("DORA Helper: Fetching details for conference:", confName);
    // Escape quotes in Solr query
    const safeName = confName.replace(/"/g, '\\"');

    // Optimisation: Limit to only necessary fields (fl)
    // We request title, series, editors, PLACE, and DATE
    const fl = [
        'mods_relatedItem_host_titleInfo_title_ms',
        'mods_relatedItem_host_relatedItem_series_titleInfo_title_ms',
        'mods_relatedItem_host_relatedItem_series_identifier_issn_ms',
        'mods_relatedItem_host_name_personal_namePart_family_ms', // Editor Family Name (Specific)
        'mods_relatedItem_host_name_personal_namePart_given_ms',  // Editor Given Name (Specific)
        'mods_name_personal_editor_ms',
        'mods_name_personal_editor_mt',
        'mods_name_editor_ms',
        'mods_relatedItem_host_name_personal_editor_ms',
        '*editor*',
        'mods_originInfo_place_placeTerm_text_ms', // Place
        'mods_originInfo_dateOther_ms',            // Conference Date
        '*place*',                                 // Fuzzy fallback
        '*date*'                                   // Fuzzy fallback
    ].join(',');

    const solrUrl = `http://lib-dora-prod1.emp-eaw.ch:8080/solr/collection1/select?q=mods_name_conference_ms:"${encodeURIComponent(safeName)}"&fl=${encodeURIComponent(fl)}&rows=1&wt=json&_=${Date.now()}`;

    chrome.runtime.sendMessage({
        action: "searchAutocomplete",
        url: solrUrl
    }, (response) => {
        if (response && response.success && response.data) {
            const docs = response.data.response?.docs;
            if (docs && docs.length > 0) {
                const preparedData = prepareConferenceData(docs[0]);
                // Check if any data was found
                const hasData = Object.values(preparedData).some(v => v !== null && (Array.isArray(v) ? v.length > 0 : true));

                if (hasData) {
                    showConferenceConfirmation(preparedData, (selectedData) => {
                        applyConferenceData(selectedData);
                    });
                } else {
                    console.log("DORA Helper: No usable data found in conference doc.");
                }
            } else {
                console.log("DORA Helper: No conference details found for", confName);
            }
        }
    });
}

function prepareConferenceData(doc) {
    const data = {
        procTitle: null,
        seriesTitle: null,
        seriesIssn: null,
        editors: [],
        place: null,
        date: null
    };

    // 1. Proceedings Title
    if (doc.mods_relatedItem_host_titleInfo_title_ms && doc.mods_relatedItem_host_titleInfo_title_ms[0]) {
        data.procTitle = doc.mods_relatedItem_host_titleInfo_title_ms[0];
    }

    // 2. Series Title
    if (doc.mods_relatedItem_host_relatedItem_series_titleInfo_title_ms && doc.mods_relatedItem_host_relatedItem_series_titleInfo_title_ms[0]) {
        data.seriesTitle = doc.mods_relatedItem_host_relatedItem_series_titleInfo_title_ms[0];
    }
    if (doc.mods_relatedItem_host_relatedItem_series_identifier_issn_ms && doc.mods_relatedItem_host_relatedItem_series_identifier_issn_ms[0]) {
        data.seriesIssn = doc.mods_relatedItem_host_relatedItem_series_identifier_issn_ms[0];
    }

    // 3. Editors
    // 3. Editors
    // Priority: Specific Family/Given fields
    if (doc.mods_relatedItem_host_name_personal_namePart_family_ms &&
        doc.mods_relatedItem_host_name_personal_namePart_given_ms) {

        const families = doc.mods_relatedItem_host_name_personal_namePart_family_ms;
        const givens = doc.mods_relatedItem_host_name_personal_namePart_given_ms;

        // Pair them up if lengths match (assumption: Solr maintains order)
        if (families.length === givens.length) {
            data.editors = families.map((fam, idx) => ({
                family: fam,
                given: givens[idx]
            }));
        } else {
            // Fallback: If lengths mismatch, try to use just family names or fallback to other fields
            // For now, let's treat them as individual components if possible, or fallback
            console.warn("DORA Helper: Editor Family/Given count mismatch. Falling back to simple fields.");
        }
    }

    if (data.editors.length === 0) {
        // Fallback to previous logic
        const allKeys = Object.keys(doc);
        let editorField = null;
        const candidates = [
            'mods_name_personal_editor_ms',
            'mods_name_personal_editor_mt',
            'mods_name_editor_ms',
            'mods_relatedItem_host_name_personal_editor_ms'
        ];

        for (const c of candidates) {
            if (doc[c]) { editorField = c; break; }
        }
        if (!editorField) {
            const fuzzy = allKeys.find(k => k.includes('editor') && Array.isArray(doc[k]) && k !== 'score');
            if (fuzzy) editorField = fuzzy;
        }

        if (editorField && doc[editorField]) {
            data.editors = doc[editorField].map(name => {
                if (name.includes(',')) {
                    const parts = name.split(',');
                    if (parts.length >= 2) {
                        return { family: parts[0].trim(), given: parts.slice(1).join(',').trim() };
                    }
                }
                return { family: name, given: '' };
            });
        }
    }

    // 4. Place
    let place = doc.mods_originInfo_place_placeTerm_text_ms ? doc.mods_originInfo_place_placeTerm_text_ms[0] : null;
    if (!place) {
        const placeKey = allKeys.find(k => k.includes('place') && k.includes('Term') && Array.isArray(doc[k]));
        if (placeKey) place = doc[placeKey][0];
    }
    data.place = place;

    // 5. Conference Date
    let confDate = doc.mods_originInfo_dateOther_ms ? doc.mods_originInfo_dateOther_ms[0] : null;
    if (!confDate) {
        const dateKey = allKeys.find(k => k.includes('dateOther') && Array.isArray(doc[k]));
        if (dateKey) confDate = doc[dateKey][0];
    }
    data.date = confDate;

    return data;
}

async function applyConferenceData(data) {
    console.log("DORA Helper: Applying conference data", data);
    let msg = "Konferenz-Daten übernommen:\n";
    let hasChanges = false;

    // 1. Proceedings Title
    if (data.procTitle) {
        const procTitleEl = document.getElementById('edit-host-titleinfo-title') || findField('Conference Proceedings') || findField('Proceedings Title');
        if (procTitleEl) {
            procTitleEl.value = data.procTitle;
            procTitleEl.dispatchEvent(new Event('input', { bubbles: true }));
            msg += "- Proceedings Title\n";
            hasChanges = true;
        }
    }

    // 2. Series Title
    if (data.seriesTitle) {
        const seriesTitleEl = document.getElementById('edit-host-series-titleinfo-title') || findField('Series Title');
        if (seriesTitleEl) {
            seriesTitleEl.value = data.seriesTitle;
            seriesTitleEl.dispatchEvent(new Event('input', { bubbles: true }));
            msg += "- Series Title\n";
            hasChanges = true;
        }
    }

    // 2b. Series ISSN
    if (data.seriesIssn) {
        const seriesIssnEl = document.getElementById('edit-host-series-issn') || findField('ISSN') || findField('Series ISSN');
        if (seriesIssnEl) {
            seriesIssnEl.value = data.seriesIssn;
            seriesIssnEl.dispatchEvent(new Event('input', { bubbles: true }));
            seriesIssnEl.dispatchEvent(new Event('change', { bubbles: true }));
            msg += "- Series ISSN\n";
            hasChanges = true;
        }
    }

    // 3. Editors
    if (data.editors && data.editors.length > 0) {
        await addMissingRows('.form-item-host-editor', data.editors.length);

        const editorContainer = document.querySelector('.form-item-host-editor .islandora-form-fieldpanel-panel');
        if (editorContainer) {
            const editorPanes = editorContainer.querySelectorAll('.islandora-form-fieldpanel-pane');
            let filledCount = 0;

            data.editors.forEach((ed, idx) => {
                if (editorPanes[idx]) {
                    const pane = editorPanes[idx];
                    // Robust selector for Family Name (could be [family], [familyEditor], etc.)
                    const familyEl = pane.querySelector('input[name*="family" i]');
                    // Robust selector for Given Name
                    const givenEl = pane.querySelector('input[name*="given" i]');

                    let rowFilled = false;
                    if (familyEl) {
                        familyEl.value = ed.family;
                        familyEl.dispatchEvent(new Event('input', { bubbles: true }));
                        rowFilled = true;
                    }
                    if (givenEl && ed.given) {
                        givenEl.value = ed.given;
                        givenEl.dispatchEvent(new Event('input', { bubbles: true }));
                        rowFilled = true;
                    }
                    if (rowFilled) filledCount++;
                }
            });
            if (filledCount > 0) {
                msg += `- ${filledCount} Editor(s)\n`;
                hasChanges = true;
            }
        }
    }

    // 4. Place
    if (data.place) {
        const placeEl = document.getElementById('edit-confinfo-place') || document.getElementById('edit-origin-info-place') || findField('Place');
        if (placeEl) {
            placeEl.value = data.place;
            placeEl.dispatchEvent(new Event('input', { bubbles: true }));
            msg += `- Ort: ${data.place}\n`;
            hasChanges = true;
        }
    }

    // 5. Date
    if (data.date) {
        const dateEl = document.getElementById('edit-confinfo-dates') || document.getElementById('edit-origin-info-date-other') || findField('Date');
        if (dateEl) {
            dateEl.value = data.date;
            dateEl.dispatchEvent(new Event('input', { bubbles: true }));
            msg += `- Datum: ${data.date}\n`;
            hasChanges = true;
        }
    }

    if (hasChanges) {
        const toast = createEl('div', '', '✓ Daten eingefügt');
        toast.style.cssText = 'position:fixed; bottom:20px; right:20px; background:#48bb78; color:white; padding:10px 20px; border-radius:4px; z-index:10000; box-shadow:0 2px 5px rgba(0,0,0,0.2); animation: fadeOut 3s forwards; pointer-events:none;';

        if (!document.getElementById('dora-toast-style')) {
            const style = document.createElement('style');
            style.id = 'dora-toast-style';
            style.textContent = '@keyframes fadeOut { 0% { opacity: 1; } 70% { opacity: 1; } 100% { opacity: 0; } }';
            document.head.appendChild(style);
        }

        document.body.appendChild(toast);
        setTimeout(() => toast.remove(), 3000);
    }
}


// --- UTILS ---
function findField(labelPart) {
    const labels = document.querySelectorAll('label');
    for (const l of labels) {
        if (((l.innerText || l.textContent || '').toLowerCase()).includes(labelPart.toLowerCase())) {
            const id = l.getAttribute('for');
            if (id) {
                const el = document.getElementById(id);
                if (el) return el;
            }
            // Try finding input in the same form-item container
            const container = l.closest('.form-item') || l.parentNode;
            if (container) {
                const input = container.querySelector('input:not([type="hidden"]), select, textarea');
                if (input) return input; // Return the input element, not container
            }
        }
    }
    return null;
}

// --- CONFERENCE CONFIRMATION DIALOG ---
function showConferenceConfirmation(data, onConfirm) {
    // 0. Deduplication: Check if modal already exists
    if (document.querySelector('.dora-modal-overlay')) {
        console.log("DORA Helper: Modal already open, skipping.");
        return;
    }

    // 1. Create Overlay
    const overlay = createEl('div', 'dora-modal-overlay');
    overlay.style.cssText = 'position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.5); z-index:10001; display:flex; justify-content:center; align-items:center;';

    // 2. Create Modal Box on top of overlay
    const box = createEl('div', 'dora-modal-box');
    box.style.cssText = 'background:white; padding:20px; border-radius:8px; width:500px; max-width:90%; box-shadow:0 4px 6px rgba(0,0,0,0.1); display:flex; flex-direction:column; gap:15px; animation: popIn 0.3s ease-out;';

    // Animation for pop-in
    if (!document.getElementById('dora-modal-anim')) {
        const style = createEl('style', '', '@keyframes popIn { 0% { opacity: 0; transform: scale(0.9); } 100% { opacity: 1; transform: scale(1); } }');
        style.id = 'dora-modal-anim';
        document.head.appendChild(style);
    }

    // Header
    const header = createEl('div', '', '📋 Konferenz-Daten übernehmen?');
    header.style.cssText = 'font-weight:bold; font-size:1.2em; border-bottom:1px solid #eee; padding-bottom:10px; color:#2d3748;';
    box.appendChild(header);

    // Form Content
    const form = createEl('div');
    form.style.cssText = 'display:flex; flex-direction:column; gap:10px; max-height:60vh; overflow-y:auto; padding-right:5px;';

    const createCheckbox = (label, value, key, isChecked = true) => {
        if (!value) return null;

        const row = createEl('label');
        row.style.cssText = 'display:flex; align-items:start; gap:10px; cursor:pointer; padding:5px; border-radius:4px; transition:background 0.2s;';
        row.onmouseover = () => row.style.background = '#f7fafc';
        row.onmouseleave = () => row.style.background = 'transparent';

        const cb = createEl('input');
        cb.type = 'checkbox';
        cb.checked = isChecked;
        cb.dataset.key = key;
        cb.style.marginTop = '4px';

        const textDiv = createEl('div');
        textDiv.style.flex = '1';
        const b = createEl('b', '', label);
        b.style.display = 'block';
        b.style.marginBottom = '2px';
        b.style.color = '#4a5568';

        const span = createEl('div', '', value);
        span.style.color = '#718096';
        span.style.fontSize = '0.95em';
        span.style.wordBreak = 'break-word';

        textDiv.appendChild(b);
        textDiv.appendChild(span);

        row.appendChild(cb);
        row.appendChild(textDiv);
        return row;
    };

    if (data.procTitle) {
        const item = createCheckbox('Proceedings Title', data.procTitle, 'procTitle');
        if (item) form.appendChild(item);
    }
    if (data.seriesTitle) {
        const item = createCheckbox('Series Title', data.seriesTitle, 'seriesTitle');
        if (item) form.appendChild(item);
    }
    if (data.seriesIssn) {
        const item = createCheckbox('Series ISSN', data.seriesIssn, 'seriesIssn');
        if (item) form.appendChild(item);
    }
    if (data.place) {
        const item = createCheckbox('Ort', data.place, 'place');
        if (item) form.appendChild(item);
    }
    if (data.date) {
        const item = createCheckbox('Datum', data.date, 'date');
        if (item) form.appendChild(item);
    }
    if (data.editors && data.editors.length > 0) {
        const editorNames = data.editors.map(e => (e.family || '') + (e.given ? ', ' + e.given : '')).join('; ');
        const item = createCheckbox(`Editoren (${data.editors.length})`, editorNames, 'editors');
        if (item) form.appendChild(item);
    }

    if (form.children.length === 0) {
        const noData = createEl('div', '', 'Keine relevanten Daten gefunden.');
        noData.style.color = '#718096';
        form.appendChild(noData);
    }

    box.appendChild(form);

    // Actions
    const btnRow = createEl('div');
    btnRow.style.cssText = 'display:flex; justify-content:flex-end; gap:12px; margin-top:5px; padding-top:15px; border-top:1px solid #eee;';

    const closeAll = () => {
        overlay.remove();
    };

    const cancelBtn = createEl('button', '', 'Abbrechen');
    cancelBtn.style.cssText = 'background:white; border:1px solid #cbd5e0; color:#4a5568; padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:500; transition:all 0.2s;';
    cancelBtn.onmouseover = () => cancelBtn.style.background = '#f7fafc';
    cancelBtn.onmouseleave = () => cancelBtn.style.background = 'white';
    cancelBtn.onclick = closeAll;

    const confirmBtn = createEl('button', '', 'Daten übernehmen');
    confirmBtn.style.cssText = 'background:#3182ce; border:none; color:white; padding:8px 16px; border-radius:6px; cursor:pointer; font-weight:600; box-shadow:0 2px 4px rgba(49,130,206,0.3); transition:all 0.2s;';
    confirmBtn.onmouseover = () => { confirmBtn.style.background = '#2b6cb0'; confirmBtn.style.transform = 'translateY(-1px)'; };
    confirmBtn.onmouseleave = () => { confirmBtn.style.background = '#3182ce'; confirmBtn.style.transform = 'translateY(0)'; };

    // Prevent default to avoid blur issues causing weird states
    const handleConfirm = (e) => {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }

        const selectedKeys = [];
        form.querySelectorAll('input[type="checkbox"]:checked').forEach(cb => {
            selectedKeys.push(cb.dataset.key);
        });

        const filteredData = {};
        selectedKeys.forEach(key => {
            if (data[key]) filteredData[key] = data[key];
        });

        if (onConfirm) onConfirm(filteredData);
        closeAll();
    };

    // Use mousedown to trigger before blur events might interfere
    confirmBtn.addEventListener('mousedown', handleConfirm);
    // keep click just in case
    confirmBtn.onclick = handleConfirm;

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(confirmBtn);
    box.appendChild(btnRow);

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    // Close on click outside box
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeAll();
    });
}

// --- PDF LICENSE CHECKER (CROSSREF) ---

function initPdfLicenseChecker() {
    // Only run if there are PDF document-version selects
    const versionSelects = document.querySelectorAll('select[id*="-document-version"]');
    if (versionSelects.length === 0) {
        console.log("DORA-Helper: No PDF document-version dropdowns found on this page.");
        return;
    }
    console.log(`DORA-Helper: Found ${versionSelects.length} PDF(s).`);

    // Check if we are on the pdf management screen or ingest screen
    let objectIdMatch = window.location.href.match(/islandora\/object\/([^/]+)/);
    let pid = objectIdMatch ? objectIdMatch[1] : null;
    let decodedPidForStorage = pid ? decodeURIComponent(pid) : 'ingest';

    let doi = sessionStorage.getItem('dora_helper_current_doi_' + decodedPidForStorage);

    console.log(`DORA-Helper: initPdfLicenseChecker - Initial DOI: ${doi}, PID: ${pid}`);

    const checkLicenses = (resolvedDoi) => {
        if (!resolvedDoi) {
            console.log("DORA-Helper: checkLicenses called with empty DOI.");
            return;
        }

        console.log(`DORA-Helper: checkLicenses running for DOI: ${resolvedDoi}`);

        if (cachedCrossrefMapped && cachedCrossrefDoi === resolvedDoi) {
            console.log(`DORA-Helper: Using cached Crossref license: ${cachedCrossrefMapped}`);
            applyLicenseChecks(cachedCrossrefMapped, cachedCrossrefLicenseUrl);
            return;
        }

        cachedCrossrefDoi = resolvedDoi;
        console.log(`DORA-Helper: Fetching Crossref data from background for DOI: ${resolvedDoi}`);
        chrome.runtime.sendMessage({ action: "fetchData", doi: resolvedDoi }, (response) => {
            console.log("DORA-Helper: Crossref background response:", response);
            if (response && response.success && response.data.crossrefLicense) {
                cachedCrossrefLicenseUrl = response.data.crossrefLicense;
                cachedCrossrefMapped = mapCrossrefLicenseToDora(cachedCrossrefLicenseUrl);
                console.log(`DORA-Helper: Mapped Crossref License: ${cachedCrossrefMapped}`);
                applyLicenseChecks(cachedCrossrefMapped, cachedCrossrefLicenseUrl);
            } else {
                console.log("DORA-Helper: No valid license found in Crossref response.");
            }
        });
    };

    const decodedPid = pid ? decodeURIComponent(pid).toLowerCase() : '';
    const isPubPid = decodedPid &&
        (decodedPid.startsWith('psi:') || decodedPid.startsWith('empa:') || decodedPid.startsWith('eawag:') || decodedPid.startsWith('wsl:')) &&
        !decodedPid.includes('publications') &&
        !decodedPid.includes('external');

    if (doi) {
        console.log(`DORA-Helper: Using DOI from sessionStorage: ${doi}`);
        checkLicenses(doi);
        injectSupplementButtonsIntoUploadForm(doi);
    } else if (isPubPid) {
        // Fetch MODS to find DOI if not in sessionStorage
        const inst = window.location.pathname.split('/')[1] || 'psi';
        const modsUrl = `/${inst}/islandora/object/${pid}/datastream/MODS`;
        console.log(`DORA-Helper: Fetching MODS XML from: ${modsUrl}`);
        fetch(modsUrl)
            .then(res => {
                console.log(`DORA-Helper: MODS fetch status: ${res.status}`);
                return res.ok ? res.text() : null;
            })
            .then(xmlStr => {
                if (!xmlStr) {
                    console.log("DORA-Helper: MODS fetch returned empty string.");
                    return;
                }
                const parser = new DOMParser();
                const xmlDoc = parser.parseFromString(xmlStr, "text/xml");
                const doiNodes = xmlDoc.querySelectorAll('identifier[type="doi"]');
                if (doiNodes.length > 0) {
                    doi = doiNodes[0].textContent.trim();
                    console.log(`DORA-Helper: Extracted DOI from MODS: ${doi}`);
                    sessionStorage.setItem('dora_helper_current_doi_' + decodedPidForStorage, doi);
                    checkLicenses(doi);
                    injectSupplementButtonsIntoUploadForm(doi);
                } else {
                    console.log("DORA-Helper: No DOI identifier found in MODS XML.");
                }
            })
            .catch(e => console.error("DORA-Helper: Failed to fetch MODS for DOI.", e));
    } else {
        console.log("DORA-Helper: No DOI available and PID conditions not met for MODS fetch.");
    }

    function evaluateLicenseForVersionSelect(vs, mappedCrossref, fullUrl) {
        if (!vs) return;

        // Use regex to extract the base ID, since we now use *= which could match edit-files-0-document-version-xyz
        const match = vs.id.match(/^(.*?)-document-version/);
        if (!match) return;
        const baseId = match[1];

        const ls = document.getElementById(baseId + '-use-perm-manual') || document.getElementById(baseId + '-use-permission');
        const os = document.getElementById(baseId + '-use-permission');

        if (!ls) return;

        console.log(`[DORA-Helper] Checking PDF ${baseId}. Version: ${vs.value}`);

        const targetWrapper = (os || ls).closest('.form-item');
        if (!targetWrapper || !targetWrapper.parentNode) return;

        let warningDiv = targetWrapper.parentNode.querySelector('.dora-license-warning[data-for="' + baseId + '"]');

        if (vs.value.toLowerCase() === 'published version') {
            const selectedVal = (os && os.value) ? os.value : ls.value;
            console.log(`[DORA-Helper] Selected License: ${selectedVal}, Crossref: ${mappedCrossref}`);

            if (mappedCrossref && selectedVal !== mappedCrossref && !selectedVal.startsWith(mappedCrossref)) {
                if (!warningDiv || warningDiv.dataset.mapped !== mappedCrossref) {
                    if (!warningDiv) {
                        warningDiv = createEl('div', 'dora-license-warning');
                        warningDiv.dataset.for = baseId;
                        warningDiv.style.cssText = 'color: #9b1c1c; font-size: 0.95em; font-weight: 500; margin-top: 10px; padding: 12px 16px; background-color: #fdf2f2; border: 1px solid #f8b4b4; border-radius: 6px; display: flex; width: fit-content; max-width: 800px; align-items: center; gap: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); line-height: 1.4;';
                        targetWrapper.parentNode.insertBefore(warningDiv, targetWrapper.nextSibling);
                    }
                    warningDiv.dataset.mapped = mappedCrossref;
                    warningDiv.innerHTML = `
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink: 0; color: #e02424;">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                            <line x1="12" y1="9" x2="12" y2="13"></line>
                            <line x1="12" y1="17" x2="12.01" y2="17"></line>
                        </svg>
                        <div>Crossref gibt für diese Publikation abweichend die folgende Lizenz an: 
                            <a href="${fullUrl}" target="_blank" style="color: #9b1c1c; text-decoration: underline; font-weight: 700; margin-left: 4px;">${mappedCrossref}</a>
                        </div>`;
                }
                if (warningDiv.style.display !== 'flex') {
                    warningDiv.style.display = 'flex';
                }
                console.log(`[DORA-Helper] Warning shown for ${baseId}`);
            } else if (warningDiv) {
                warningDiv.style.display = 'none';
                console.log(`[DORA-Helper] Warning hidden (matched) for ${baseId}`);
            }
        } else if (warningDiv) {
            warningDiv.style.display = 'none';
            console.log(`[DORA-Helper] Warning hidden (not published version) for ${baseId}`);
        }
    }

    function applyLicenseChecks(mappedCrossref, fullUrl) {
        const selects = document.querySelectorAll('select[id*="-document-version"]');
        selects.forEach(vs => {
            setTimeout(() => evaluateLicenseForVersionSelect(vs, mappedCrossref, fullUrl), 500);
        });
    }

    // Bind a global capture-phase listener ONE TIME to catch all changes
    if (!window.doraLicenseCheckerGlobalBound) {
        window.doraLicenseCheckerGlobalBound = true;
        document.body.addEventListener('change', (e) => {
            if (cachedCrossrefMapped) {
                clearTimeout(window.doraLicenseCheckerThrottle);
                window.doraLicenseCheckerThrottle = setTimeout(() => {
                    applyLicenseChecks(cachedCrossrefMapped, cachedCrossrefLicenseUrl);
                }, 150);
            }
        }, true); // TRUE = Capture Phase
    }
}

function mapCrossrefLicenseToDora(url) {
    if (!url) return null;
    const lowerUrl = url.toLowerCase();

    if (lowerUrl.includes('creativecommons.org/licenses/by/4.0')) return 'CC BY 4.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by/3.0')) return 'CC BY 3.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by/2.5')) return 'CC BY 2.5';
    if (lowerUrl.includes('creativecommons.org/licenses/by/2.0')) return 'CC BY 2.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by/1.0')) return 'CC BY 1.0';

    if (lowerUrl.includes('creativecommons.org/licenses/by-sa/4.0')) return 'CC BY-SA 4.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-sa/3.0')) return 'CC BY-SA 3.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-sa/2.5')) return 'CC BY-SA 2.5';

    if (lowerUrl.includes('creativecommons.org/licenses/by-nc/4.0')) return 'CC BY-NC 4.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc/3.0')) return 'CC BY-NC 3.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc/2.5')) return 'CC BY-NC 2.5';

    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-nd/4.0')) return 'CC BY-NC-ND 4.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-nd/3.0')) return 'CC BY-NC-ND 3.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-nd/2.5')) return 'CC BY-NC-ND 2.5';

    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-sa/4.0')) return 'CC BY-NC-SA 4.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-sa/3.0')) return 'CC BY-NC-SA 3.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-sa/2.5')) return 'CC BY-NC-SA 2.5';

    if (lowerUrl.includes('creativecommons.org/licenses/by-nd/4.0')) return 'CC BY-ND 4.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nd/3.0')) return 'CC BY-ND 3.0';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nd/2.5')) return 'CC BY-ND 2.5';

    if (lowerUrl.includes('creativecommons.org/publicdomain/zero/1.0')) return 'CC0';

    // Generic fallback for older/other versions
    if (lowerUrl.includes('creativecommons.org/licenses/by/')) return 'CC BY';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc/')) return 'CC BY-NC';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-nd/')) return 'CC BY-NC-ND';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nc-sa/')) return 'CC BY-NC-SA';
    if (lowerUrl.includes('creativecommons.org/licenses/by-nd/')) return 'CC BY-ND';
    if (lowerUrl.includes('creativecommons.org/licenses/by-sa/')) return 'CC BY-SA';

    return null;
}
function isEditPage() {
    // Check for specific form IDs or Classes typical for DORA/Islandora Edit Forms
    if (document.getElementById('islandora-ingest-form')) return true;
    if (document.querySelector('.node-form')) return true;
    if (document.getElementById('edit-identifiers-doi')) return true; // Strong indicator

    // Check URL patterns
    const loc = window.location.href;
    if (loc.includes('/ingest') || loc.includes('/edit') || loc.includes('/manage') || loc.includes('lib4ridora_pdf_management')) return true;

    return false;
}

// --- BATCH QC DASHBOARD ---

function isSearchPage() {
    const loc = window.location.href.toLowerCase();
    const path = window.location.pathname.toLowerCase();
    return loc.includes('/islandora/search') || loc.includes('/solr/search') || path.includes('/search');
}

function injectBatchQcButton() {
    try {
        // Collect all visible PIDs on the page safely (with try-catch for URI components)
        const getPagePids = () => {
            const pids = new Set();
            document.querySelectorAll('a[href*="/islandora/object/"]').forEach(a => {
                try {
                    const hrefAttr = a.getAttribute('href');
                    if (!hrefAttr) return;
                    const href = decodeURIComponent(hrefAttr);
                    const match = href.match(/islandora\/object\/([a-zA-Z0-9_-]+:[a-zA-Z0-9_-]+)/);
                    if (match) {
                        pids.add(match[1]);
                    }
                } catch (err) {
                    // Fallback to raw non-decoded match if decoding fails
                    const hrefAttr = a.getAttribute('href');
                    if (hrefAttr) {
                        const match = hrefAttr.match(/islandora\/object\/([a-zA-Z0-9_%-]+:[a-zA-Z0-9_%-]+)/);
                        if (match) {
                            try {
                                pids.add(decodeURIComponent(match[1]));
                            } catch (e) {
                                pids.add(match[1].replace(/%3A/gi, ':'));
                            }
                        }
                    }
                }
            });
            return Array.from(pids);
        };

        const allPids = getPagePids();
        const bookmarkTable = document.querySelector('table.islandora-bookmark-solr-results');

        // Check if button already exists
        let btn = document.getElementById('dora-batch-qc-btn');
        if (btn) {
            // Update counts for existing button
            if (bookmarkTable) {
                const checked = document.querySelectorAll('input.islandora-bookmark-solr-results:checked');
                btn.textContent = `Batch QC Dashboard (${checked.length} selected)`;
                btn.disabled = checked.length === 0;
                btn.style.opacity = checked.length === 0 ? '0.5' : '1';
                if (checked.length === 0) {
                    btn.style.background = '#94a3b8';
                    btn.style.borderColor = '#cbd5e1';
                    btn.style.boxShadow = 'none';
                } else {
                    btn.style.background = '#22c55e';
                    btn.style.borderColor = '#16a34a';
                    btn.style.boxShadow = '0 2px 4px rgba(34, 197, 94, 0.2)';
                }
            } else {
                btn.textContent = `Batch QC visible results (${allPids.length} items)`;
                btn.disabled = allPids.length === 0;
                btn.style.opacity = allPids.length === 0 ? '0.5' : '1';
                if (allPids.length === 0) {
                    btn.style.background = '#94a3b8';
                    btn.style.borderColor = '#cbd5e1';
                    btn.style.boxShadow = 'none';
                } else {
                    btn.style.background = '#22c55e';
                    btn.style.borderColor = '#16a34a';
                    btn.style.boxShadow = '0 2px 4px rgba(34, 197, 94, 0.2)';
                }
            }
            return; // Done updating existing button!
        }

        // Find insertion container
        const targetElement = document.querySelector('table.islandora-bookmark-solr-results') ||
            document.querySelector('div.islandora-solr-search-results') ||
            document.querySelector('.islandora-solr-search') ||
            document.querySelector('.block-islandora-solr') ||
            document.querySelector('div.islandora');

        const fallbackElement = document.querySelector('#content') ||
            document.querySelector('.region-content') ||
            document.querySelector('#main');

        if (!targetElement && !fallbackElement) return;

        const container = document.createElement('div');
        container.style.cssText = 'margin: 15px 0; display: flex; align-items: center; justify-content: flex-end; gap: 10px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;';

        btn = document.createElement('button');
        btn.id = 'dora-batch-qc-btn';
        // Bewusst NICHT die Theme-Klasse 'form-submit': der Knopf hat sich
        // damit die Regeln des Admin-Themas geborgt.
        btn.className = 'dora-batch-qc-button';
        btn.type = 'button';
        btn.style.cssText = 'background-color: #22c55e; color: #fff; border: 1px solid #16a34a; font-size: 13px; font-weight: bold; border-radius: 6px; box-shadow: 0 2px 4px rgba(34, 197, 94, 0.2); transition: background 0.15s ease-in-out, box-shadow 0.15s ease-in-out;';
        setzeKnopfMasse(btn);

        const updateCount = () => {
            const currentPids = getPagePids();
            if (bookmarkTable) {
                const checked = document.querySelectorAll('input.islandora-bookmark-solr-results:checked');
                btn.textContent = `Batch QC Dashboard (${checked.length} selected)`;
                btn.disabled = checked.length === 0;
                btn.style.opacity = checked.length === 0 ? '0.5' : '1';
                if (checked.length === 0) {
                    btn.style.background = '#94a3b8';
                    btn.style.borderColor = '#cbd5e1';
                    btn.style.boxShadow = 'none';
                } else {
                    btn.style.background = '#22c55e';
                    btn.style.borderColor = '#16a34a';
                    btn.style.boxShadow = '0 2px 4px rgba(34, 197, 94, 0.2)';
                }
            } else {
                btn.textContent = `Batch QC visible results (${currentPids.length} items)`;
                btn.disabled = currentPids.length === 0;
                btn.style.opacity = currentPids.length === 0 ? '0.5' : '1';
                if (currentPids.length === 0) {
                    btn.style.background = '#94a3b8';
                    btn.style.borderColor = '#cbd5e1';
                    btn.style.boxShadow = 'none';
                } else {
                    btn.style.background = '#22c55e';
                    btn.style.borderColor = '#16a34a';
                    btn.style.boxShadow = '0 2px 4px rgba(34, 197, 94, 0.2)';
                }
            }
        };

        // Hover steckt in styles.css (.dora-batch-qc-button:hover). Per JS
        // gesetzt hinge er an onmouseenter - das feuert nur ueber der
        // Elementflaeche und faerbte per Inline-Stil, der jede Regel schlaegt.

        // Attach listener if bookmark table is present
        if (bookmarkTable) {
            bookmarkTable.addEventListener('change', (e) => {
                if (e.target.classList.contains('islandora-bookmark-solr-results') || e.target.closest('.select-all')) {
                    updateCount();
                }
            });
        }

        btn.addEventListener('click', (e) => {
            e.preventDefault();
            if (bookmarkTable) {
                const checked = document.querySelectorAll('input.islandora-bookmark-solr-results:checked');
                const pids = Array.from(checked).map(cb => cb.value);
                if (pids.length > 0) {
                    initBatchQcDashboard(pids);
                }
            } else {
                const currentPids = getPagePids();
                if (currentPids.length > 0) {
                    initBatchQcDashboard(currentPids);
                }
            }
        });

        updateCount();
        container.appendChild(btn);
        setTimeout(() => pruefeKnopfFlaeche(btn), 400);
        if (targetElement && targetElement.parentNode) {
            targetElement.parentNode.insertBefore(container, targetElement);
        } else if (fallbackElement) {
            fallbackElement.prepend(container);
        }
    } catch (e) {
        console.error("DORA Helper: Error injecting Batch QC button:", e);
    }
}

function initBatchQcDashboard(pids) {
    if (document.getElementById('dora-batch-qc-overlay')) return;

    // Session-basiertes Tracking bereits freigegebener PIDs
    let savedApproved = [];
    try {
        savedApproved = JSON.parse(sessionStorage.getItem('dora_approved_pids') || '[]');
    } catch (e) { }
    const approvedPids = new Set(savedApproved);

    const markPidAsApproved = (pid) => {
        approvedPids.add(pid);
        try {
            sessionStorage.setItem('dora_approved_pids', JSON.stringify(Array.from(approvedPids)));
        } catch (e) { }

        const item = document.getElementById(`batch-qc-item-${pid.replace(':', '-')}`);
        if (item) {
            item.classList.add('dora-approved-pid');
            item.style.borderRight = '5px solid #22c55e';
            if (currentPid !== pid) {
                item.style.background = '#f0fdf4';
                item.style.color = '#16a34a';
            }
            if (!item.querySelector('.dora-qc-yes-icon')) {
                const icon = document.createElement('span');
                icon.className = 'dora-qc-yes-icon';
                icon.textContent = ' (QC: Yes)';
                icon.style.cssText = 'color: #16a34a; font-size: 10px; font-weight: bold; margin-left: 4px;';
                item.appendChild(icon);
            }
        }
    };

    const getInstitutionPath = () => {
        const path = window.location.pathname;
        const segments = path.split('/').filter(s => s.length > 0);
        if (segments.length > 0 && ['psi', 'eawag', 'empa', 'wsl'].includes(segments[0].toLowerCase())) {
            return segments[0].toLowerCase();
        }
        return 'psi';
    };

    const overlay = document.createElement('div');
    overlay.id = 'dora-batch-qc-overlay';
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: #f8fafc; z-index: 100000;
        display: flex; flex-direction: column;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    `;

    // Header
    const header = document.createElement('div');
    header.style.cssText = 'padding: 12px 20px; background: #0f172a; color: #fff; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06); z-index: 10;';

    const title = document.createElement('h2');
    title.textContent = 'DORA Batch QC Dashboard';
    title.style.cssText = 'margin: 0; font-size: 16px; font-weight: 700; letter-spacing: 0.5px;';
    header.appendChild(title);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'Schließen';
    closeBtn.style.cssText = 'background: #ef4444; color: white; border: none; padding: 6px 16px; border-radius: 6px; font-weight: bold; cursor: pointer; transition: background 0.15s; font-size: 13px;';
    closeBtn.onmouseenter = () => closeBtn.style.background = '#dc2626';
    closeBtn.onmouseleave = () => closeBtn.style.background = '#ef4444';
    closeBtn.onclick = () => {
        // Ein laufender Stapellauf haengt nicht am Ueberlagerungsfenster:
        // ohne das hier blieben seine verborgenen Rahmen im Hintergrund
        // stehen und rendern weiter.
        journalStapelAufraeumen();
        overlay.remove();
    };
    header.appendChild(closeBtn);

    overlay.appendChild(header);

    // Body Grid
    const body = document.createElement('div');
    body.style.cssText = 'display: flex; flex: 1; overflow: hidden;';

    // Sidebar
    const sidebar = document.createElement('div');
    sidebar.style.cssText = 'width: 100px; background: #f1f5f9; border-right: 1px solid #e2e8f0; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 6px; font-size: 11px;';

    // Middle (Form)
    const middle = document.createElement('div');
    middle.style.cssText = 'flex: 2.8; border-right: 1px solid #e2e8f0; display: flex; flex-direction: column; background: #fff; position: relative;';

    const middleToolbar = document.createElement('div');
    middleToolbar.style.cssText = 'padding: 10px 16px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: flex-end; align-items: center;';

    const approveBtn = document.createElement('button');
    approveBtn.textContent = '✅ Schnell-Freigabe (QC = Yes)';
    approveBtn.style.cssText = 'background: #22c55e; color: white; border: none; padding: 10px 24px; border-radius: 8px; cursor: pointer; font-weight: bold; font-size: 14px; box-shadow: 0 4px 6px rgba(34, 197, 94, 0.25); transition: background 0.15s, transform 0.1s;';
    approveBtn.onmouseenter = () => approveBtn.style.background = '#16a34a';
    approveBtn.onmouseleave = () => approveBtn.style.background = '#22c55e';
    approveBtn.onmousedown = () => approveBtn.style.transform = 'scale(0.97)';
    approveBtn.onmouseup = () => approveBtn.style.transform = 'scale(1)';
    approveBtn.onclick = () => approveCurrentForm();

    // Fetch actual initials for approveBtn label dynamically
    chrome.storage.local.get({ qcInitials: '' }, function (result) {
        const initials = result.qcInitials.trim();
        if (initials) {
            approveBtn.textContent = `✅ Schnell-Freigabe (QC = Yes, User = ${initials})`;
        }
    });

    const reloadBtn = document.createElement('button');
    reloadBtn.textContent = '↻ Neu laden';
    reloadBtn.style.cssText = 'background: #64748b; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600; transition: background 0.15s;';
    reloadBtn.onmouseenter = () => reloadBtn.style.background = '#475569';
    reloadBtn.onmouseleave = () => reloadBtn.style.background = '#64748b';
    reloadBtn.onclick = () => { if (currentPid) loadRecord(currentPid); };

    // Journal fuer alle ausgewaehlten Datensaetze nachschlagen. Oeffnet jeden
    // Datensatz kurz in einem verborgenen iframe - erst pruefend, nach
    // ausdruecklicher Freigabe schreibend.
    const journalBtn = document.createElement('button');
    journalBtn.textContent = `⟳ Journal für alle ${pids.length} prüfen`;
    journalBtn.title = 'Schlägt für jeden ausgewählten Datensatz das Journal neu nach. '
        + 'Zeigt erst, was sich ändern würde; gespeichert wird nur nach Freigabe.';
    journalBtn.style.cssText = 'background: #3182ce; color: white; border: none; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600; margin-right: 8px; transition: background 0.15s;';
    journalBtn.onmouseenter = () => journalBtn.style.background = '#2c5282';
    journalBtn.onmouseleave = () => journalBtn.style.background = '#3182ce';
    journalBtn.onclick = () => journalStapelFenster(pids, getInstitutionPath());

    middleToolbar.appendChild(journalBtn);
    middleToolbar.appendChild(reloadBtn);

    const middleIframe = document.createElement('iframe');
    middleIframe.style.cssText = 'flex: 1; border: none; width: 100%;';

    const middleBottomToolbar = document.createElement('div');
    middleBottomToolbar.style.cssText = 'padding: 12px 16px; background: #ffffff; border-top: 1px solid #e2e8f0; display: flex; justify-content: center; align-items: center; box-shadow: 0 -2px 10px rgba(0,0,0,0.05); z-index: 10;';
    middleBottomToolbar.appendChild(approveBtn);

    middle.appendChild(middleToolbar);
    middle.appendChild(middleIframe);
    middle.appendChild(middleBottomToolbar);

    // Rechte Spalte: PDF-Verwaltung des Datensatzes.
    // Die eingebettete PDF-Vorschau war hier zu starr (feste Breite, kein
    // Zoom, kein Blaettern nebenher). Die Vorschau laeuft deshalb in einem
    // eigenen Fenster; die Spalte zeigt stattdessen, welche PDFs am Objekt
    // haengen (lib4ridora_pdf_management).
    const right = document.createElement('div');
    right.style.cssText = 'flex: 1.2; display: flex; flex-direction: column; background: #f8fafc; border-left: 1px solid #e2e8f0; min-width: 320px;';

    const rightToolbar = document.createElement('div');
    rightToolbar.style.cssText = 'padding: 8px 12px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap;';

    const rightTitle = document.createElement('span');
    rightTitle.textContent = '📎 PDF-Verwaltung';
    rightTitle.style.cssText = 'font-weight: 600; font-size: 12px; color: #475569;';
    rightToolbar.appendChild(rightTitle);

    const rightButtons = document.createElement('div');
    rightButtons.style.cssText = 'display: flex; gap: 6px; align-items: center;';

    const kleinerButton = (text, farbe, hoverFarbe, titel) => {
        const b = document.createElement('button');
        b.textContent = text;
        b.title = titel || '';
        b.style.cssText = `background: ${farbe}; color: white; border: none; padding: 6px 10px; border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600; transition: background 0.15s;`;
        b.onmouseenter = () => b.style.background = hoverFarbe;
        b.onmouseleave = () => b.style.background = farbe;
        return b;
    };

    const pdfWindowBtn = kleinerButton('📄 PDF-Vorschau ↗', '#3b82f6', '#2563eb',
        'Oeffnet das PDF in einem eigenen, frei skalierbaren Fenster');
    const pdfTabBtn = kleinerButton('🗂 Verwaltung ↗', '#64748b', '#475569',
        'Oeffnet die PDF-Verwaltung in einem neuen Tab');
    const rightReloadBtn = kleinerButton('↻', '#64748b', '#475569', 'PDF-Verwaltung neu laden');

    rightButtons.appendChild(pdfWindowBtn);
    rightButtons.appendChild(pdfTabBtn);
    rightButtons.appendChild(rightReloadBtn);
    rightToolbar.appendChild(rightButtons);

    pdfWindowBtn.onclick = () => openPdfPreviewWindow(currentPid, false);
    pdfTabBtn.onclick = () => {
        if (currentPid) window.open(pdfManagementUrl(currentPid), '_blank');
    };
    rightReloadBtn.onclick = () => {
        if (currentPid) rightIframe.src = pdfManagementUrl(currentPid);
    };

    const rightIframe = document.createElement('iframe');
    rightIframe.style.cssText = 'flex: 1; border: none; width: 100%; background: #fff;';

    right.appendChild(rightToolbar);
    right.appendChild(rightIframe);

    // Ziehbare Trennlinie: die Breitenaufteilung war fest verdrahtet, je nach
    // Datensatz braucht man mal mehr Formular, mal mehr Dateiliste.
    const splitter = document.createElement('div');
    splitter.title = 'Breite der PDF-Spalte ziehen';
    splitter.style.cssText = 'width: 6px; cursor: col-resize; background: #e2e8f0; flex: 0 0 6px;';
    splitter.onmouseenter = () => splitter.style.background = '#94a3b8';
    splitter.onmouseleave = () => splitter.style.background = '#e2e8f0';
    splitter.onmousedown = (ev) => {
        ev.preventDefault();
        const ziehen = (e) => {
            const breite = Math.min(Math.max(window.innerWidth - e.clientX, 280), window.innerWidth * 0.7);
            right.style.flex = `0 0 ${Math.round(breite)}px`;
        };
        const beenden = () => {
            document.removeEventListener('mousemove', ziehen);
            document.removeEventListener('mouseup', beenden);
            // Iframes wieder klickbar machen
            middleIframe.style.pointerEvents = '';
            rightIframe.style.pointerEvents = '';
        };
        // Waehrend des Ziehens duerfen die Iframes die Maus nicht schlucken
        middleIframe.style.pointerEvents = 'none';
        rightIframe.style.pointerEvents = 'none';
        document.addEventListener('mousemove', ziehen);
        document.addEventListener('mouseup', beenden);
    };

    body.appendChild(sidebar);
    body.appendChild(middle);
    body.appendChild(splitter);
    body.appendChild(right);
    overlay.appendChild(body);

    let currentPid = null;

    // Load PIDs into sidebar
    pids.forEach((pid, idx) => {
        const item = document.createElement('div');
        item.style.cssText = 'padding: 10px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 6px; cursor: pointer; user-select: none; transition: all 0.15s ease-in-out; word-break: break-all; font-weight: 500; color: #475569; box-shadow: 0 1px 2px rgba(0,0,0,0.02);';
        item.innerHTML = `<strong>${pid}</strong>`;
        item.id = `batch-qc-item-${pid.replace(':', '-')}`;

        // Falls bereits freigegeben, optischen Akzent setzen
        if (approvedPids.has(pid)) {
            item.classList.add('dora-approved-pid');
            item.style.borderRight = '5px solid #22c55e';
            item.style.background = '#f0fdf4';
            item.style.color = '#16a34a';
            const icon = document.createElement('span');
            icon.className = 'dora-qc-yes-icon';
            icon.textContent = ' (QC: Yes)';
            icon.style.cssText = 'color: #16a34a; font-size: 10px; font-weight: bold; margin-left: 4px;';
            item.appendChild(icon);
        }

        item.onmouseenter = () => {
            if (currentPid !== pid) {
                item.style.background = item.classList.contains('dora-approved-pid') ? '#e8f5e9' : '#f1f5f9';
                item.style.color = '#0f172a';
            }
        };
        item.onmouseleave = () => {
            if (currentPid !== pid) {
                item.style.background = item.classList.contains('dora-approved-pid') ? '#f0fdf4' : '#ffffff';
                item.style.color = item.classList.contains('dora-approved-pid') ? '#16a34a' : '#475569';
            }
        };

        item.onclick = () => {
            // Unhighlight all
            Array.from(sidebar.children).forEach(child => {
                const isApproved = child.classList.contains('dora-approved-pid');
                child.style.background = isApproved ? '#f0fdf4' : '#ffffff';
                child.style.borderLeft = '1px solid #e2e8f0';
                child.style.color = isApproved ? '#16a34a' : '#475569';
                child.style.boxShadow = '0 1px 2px rgba(0,0,0,0.02)';
            });
            // Highlight current
            item.style.background = '#eff6ff';
            item.style.borderLeft = '4px solid #3b82f6';
            item.style.color = '#1e3a8a';
            item.style.boxShadow = '0 2px 4px rgba(59, 130, 246, 0.05)';
            currentPid = pid;
            loadRecord(pid);
        };
        sidebar.appendChild(item);
    });

    document.body.appendChild(overlay);

    function pdfManagementUrl(pid) {
        return `/${getInstitutionPath()}/islandora/object/${encodeURIComponent(pid)}/lib4ridora_pdf_management`;
    }

    function pdfDatastreamUrl(pid) {
        return `${window.location.origin}/${getInstitutionPath()}/islandora/object/${encodeURIComponent(pid)}/datastream/PDF/view`;
    }

    // Vorschau öffnen. Je nach Einstellung entweder im mitgelieferten
    // PDF.js-Fenster oder direkt in Adobe Acrobat (Einstellung
    // "pdfOpenInAdobe"). nurWennOffen = still folgen, nicht neu oeffnen -
    // im Adobe-Modus passiert dabei bewusst nichts, sonst würde beim
    // Blättern jeder Datensatz einen Download auslösen.
    function openPdfPreviewWindow(pid, nurWennOffen) {
        if (!pid) return;

        // Ein offenes Vorschaufenster folgt dem Datensatz immer - auch im
        // Adobe-Modus. Nur der ausdrueckliche Klick entscheidet anhand der
        // Einstellung, ob Adobe geladen wird; automatische Downloads beim
        // Blaettern soll es weiterhin nicht geben.
        if (nurWennOffen) {
            oeffneInViewer(pid, true);
            return;
        }

        chrome.storage.local.get({ pdfOpenInAdobe: false }, (einstellung) => {
            if (einstellung.pdfOpenInAdobe) oeffneInAdobe(pid);
            else oeffneInViewer(pid, false);
        });
    }

    function oeffneInAdobe(pid) {
        const url = pdfDatastreamUrl(pid);
        pdfWindowBtn.textContent = '📥 lädt für Adobe …';
        chrome.runtime.sendMessage({ action: 'openPdfExternally', url: url }, (antwort) => {
            const daten = antwort && antwort.success ? antwort.data : null;
            if (daten && daten.opened) {
                pdfButtonBeschriftungSetzen(true);
                return;
            }
            if (daten && daten.downloaded) {
                // Firefox hat das Starten abgelehnt (nur aus einem Klick
                // erlaubt) - der naechste Klick holt es nach.
                pdfWindowBtn.textContent = '📂 In Adobe starten';
                pdfWindowBtn.onclick = () => {
                    chrome.runtime.sendMessage(
                        { action: 'openDownloadedFile', downloadId: daten.downloadId },
                        () => {
                            pdfWindowBtn.onclick = () => openPdfPreviewWindow(currentPid, false);
                            pdfButtonBeschriftungSetzen(true);
                        });
                };
                return;
            }
            pdfWindowBtn.textContent = '⚠ Adobe-Start fehlgeschlagen';
            console.log('DORA Helper: Adobe-Öffnen fehlgeschlagen:',
                (antwort && antwort.error) || (daten && daten.note) || 'unbekannt');
            setTimeout(() => pdfButtonBeschriftungSetzen(true), 4000);
        });
    }

    function oeffneInViewer(pid, nurWennOffen) {
        openPdfPreviewFenster(pdfDatastreamUrl(pid), nurWennOffen, pid);
    }

    // Der Button sagt, was passiert - Vorschaufenster oder Adobe
    function pdfButtonBeschriftungSetzen(adobeModus) {
        pdfWindowBtn.textContent = adobeModus ? '📥 In Adobe öffnen' : '📄 PDF-Vorschau ↗';
        pdfWindowBtn.title = adobeModus
            ? 'Öffnet das PDF in Adobe Acrobat (Einstellung: PDFs in Adobe öffnen)'
            : 'Öffnet das PDF in einem eigenen, frei skalierbaren Fenster';
    }

    chrome.storage.local.get({ pdfOpenInAdobe: false }, (e) => pdfButtonBeschriftungSetzen(!!e.pdfOpenInAdobe));
    if (chrome.storage.onChanged) {
        chrome.storage.onChanged.addListener((aenderungen, bereich) => {
            if (!document.body.contains(pdfWindowBtn)) return; // Dashboard geschlossen
            if (bereich === 'local' && aenderungen.pdfOpenInAdobe) {
                pdfButtonBeschriftungSetzen(!!aenderungen.pdfOpenInAdobe.newValue);
            }
        });
    }

    // Die PDF-Verwaltung ist eine vollstaendige Drupal-Seite; in der
    // schmalen Spalte bleibt nur die Dateiliste interessant.
    function slimPdfManagementFrame() {
        try {
            const doc = rightIframe.contentDocument || rightIframe.contentWindow.document;
            if (!doc) return;

            ['header', 'footer', 'toolbar', 'branding', 'navigation', 'nav', 'breadcrumb',
                'sidebar-first', 'sidebar-second', 'admin-menu'].forEach(id => {
                    const el = doc.getElementById(id);
                    if (el) el.style.display = 'none';
                });
            const frameTabs = doc.querySelector('ul.tabs');
            if (frameTabs) frameTabs.style.display = 'none';

            if (doc.getElementById('dora-pdfmgmt-style')) return;
            const style = doc.createElement('style');
            style.id = 'dora-pdfmgmt-style';
            style.textContent = `
                body {
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
                    background: #ffffff !important; padding: 10px !important; font-size: 12px !important;
                }
                #sidebar-first, #sidebar-second, .region-sidebar-first, .region-sidebar-second,
                #navigation, #nav, .sidebar, #breadcrumb, .breadcrumb, #admin-menu {
                    display: none !important; width: 0 !important;
                }
                #main, #content, #main-wrapper, #content-wrapper, .main-content, .content, #center {
                    width: 100% !important; max-width: 100% !important; margin: 0 !important;
                    padding: 0 !important; float: none !important;
                }
                table { width: 100% !important; border-collapse: collapse !important; font-size: 11px !important; }
                table td, table th { padding: 4px 6px !important; vertical-align: middle !important; }
                input[type="text"], select { max-width: 100% !important; box-sizing: border-box !important; }
                fieldset { margin: 8px 0 !important; padding: 8px !important; border: 1px solid #e2e8f0 !important; border-radius: 6px !important; }
                legend { font-size: 11px !important; font-weight: 700 !important; text-transform: uppercase !important; }
            `;
            doc.head.appendChild(style);
        } catch (e) {
            console.log('DORA Helper: PDF-Verwaltung nicht anpassbar:', e);
        }
    }

    // Automatically load first
    if (pids.length > 0) {
        sidebar.children[0].click();
    }

    function loadRecord(pid) {
        // Reset des Freigabe-Buttons auf den Standard-Zustand für den neuen Datensatz
        chrome.storage.local.get({ qcInitials: '' }, function (result) {
            const initials = result.qcInitials.trim();
            if (initials) {
                approveBtn.textContent = `✅ Schnell-Freigabe (QC = Yes, User = ${initials})`;
            } else {
                approveBtn.textContent = '✅ Schnell-Freigabe (QC = Yes)';
            }
            approveBtn.style.background = '#22c55e';
            approveBtn.style.boxShadow = '0 2px 4px rgba(34, 197, 94, 0.2)';
        });

        const inst = getInstitutionPath();

        // Rechts die PDF-Verwaltung des Objekts laden: sie zeigt alle
        // angehaengten Dateien mitsamt Zugriffsrechten und Versionen.
        rightIframe.onload = () => slimPdfManagementFrame();
        rightIframe.src = pdfManagementUrl(pid);

        // Ein bereits geoeffnetes Vorschaufenster folgt dem Datensatz,
        // ohne dass beim Blaettern ein neues Fenster aufgeht.
        openPdfPreviewWindow(pid, true);


        // Inject script into iframe to hide header/footer (Bound BEFORE setting src to avoid race conditions!)
        middleIframe.onload = () => {
            try {
                const doc = middleIframe.contentDocument || middleIframe.contentWindow.document;
                if (!doc) return;

                // Hide Drupal header/footer to save space
                const header = doc.getElementById('header');
                const footer = doc.getElementById('footer');
                const tabs = doc.querySelector('ul.tabs');
                const toolbar = doc.getElementById('toolbar');
                const branding = doc.getElementById('branding');
                const pageTitle = doc.getElementById('page-title');
                if (header) header.style.display = 'none';
                if (footer) footer.style.display = 'none';
                if (tabs) tabs.style.display = 'none';
                if (toolbar) toolbar.style.display = 'none';
                if (branding) branding.style.display = 'none';
                if (pageTitle) pageTitle.style.display = 'none';

                // Hide sidebars, navigation, breadcrumbs
                const sidebarFirst = doc.getElementById('sidebar-first') || doc.querySelector('.sidebar') || doc.querySelector('.region-sidebar-first');
                const sidebarSecond = doc.getElementById('sidebar-second') || doc.querySelector('.region-sidebar-second');
                const navigation = doc.getElementById('navigation') || doc.getElementById('nav');
                const breadcrumb = doc.getElementById('breadcrumb') || doc.querySelector('.breadcrumb');
                if (sidebarFirst) sidebarFirst.style.display = 'none';
                if (sidebarSecond) sidebarSecond.style.display = 'none';
                if (navigation) navigation.style.display = 'none';
                if (breadcrumb) breadcrumb.style.display = 'none';

                // Autorenzeilen markieren, bevor das Kompakt-CSS greift -
                // ohne die Marke ziehen die generischen Abstaende sie
                // auseinander. Nach kurzer Pause nochmal, falls Drupal Zeilen
                // per AJAX nachlaedt.
                markiereAutorenzeilen(doc);
                setTimeout(() => { try { markiereAutorenzeilen(doc); } catch (e) { /* egal */ } }, 1200);

                // Inject Compact & Modernized CSS
                const style = doc.createElement('style');
                style.textContent = `
                    /* Kompakte, moderne Darstellung des Formulars */
                    body { 
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important; 
                        background-color: #f8fafc !important; 
                        color: #1e293b !important;
                        padding: 12px !important;
                    }
                    body, label, input, select, textarea { font-size: 12px !important; line-height: 1.4 !important; }
                    
                    .form-item { margin: 8px 0 !important; padding: 0 !important; display: block !important; }
                    
                    .form-item label { 
                        display: block !important; 
                        margin: 0 0 3px 0 !important; 
                        font-weight: 600 !important; 
                        font-size: 11px !important; 
                        color: #475569 !important; 
                        text-transform: uppercase !important;
                        letter-spacing: 0.3px !important;
                    }
                    
                    input[type="text"], select, textarea { 
                        width: 100% !important; 
                        max-width: 100% !important; 
                        padding: 6px 10px !important; 
                        margin: 0 !important; 
                        box-sizing: border-box !important; 
                        border: 1px solid #cbd5e1 !important;
                        border-radius: 6px !important;
                        background-color: #ffffff !important;
                        color: #0f172a !important;
                        transition: all 0.15s ease-in-out !important;
                    }
                    
                    input[type="text"]:focus, select:focus, textarea:focus {
                        border-color: #3b82f6 !important;
                        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15) !important;
                        outline: none !important;
                    }
                    
                    textarea { min-height: 50px !important; resize: vertical !important; }
                    
                    fieldset { 
                        margin: 12px 0 !important; 
                        padding: 12px !important; 
                        border: 1px solid #e2e8f0 !important; 
                        border-radius: 8px !important;
                        background: #ffffff !important; 
                        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02) !important;
                    }
                    
                    legend { 
                        font-weight: 700 !important; 
                        font-size: 11px !important; 
                        text-transform: uppercase !important;
                        letter-spacing: 0.3px !important;
                        margin: 0 !important; 
                        padding: 3px 8px !important; 
                        background: #f1f5f9 !important; 
                        color: #475569 !important;
                        border: 1px solid #cbd5e1 !important; 
                        border-radius: 4px !important; 
                    }
                    
                    .fieldset-wrapper { margin-top: 2px !important; }
                    
                    /* Hilfstexte konsequenter ausblenden */
                    .description, .help-block, div.description, p.help, .form-item .description, .form-desc, div[class*="description"] { display: none !important; }
                    
                    .islandora-xml-form-builder-form { margin-top: 0 !important; }
                    
                    /* Generelle Tabellen-Anpassung */
                    table { width: 100% !important; border-collapse: collapse !important; margin: 8px 0 !important; }
                    table, tr, td { padding: 4px !important; margin: 0 !important; }
                    
                    /* Breitenkontrolle für die verschachtelten Tabellen (Autoren, Affiliationen) */
                    fieldset { overflow-x: auto !important; }
                    table td input[type="text"], table td select { max-width: 250px !important; }
                    
                    /* Autorenzeilen: innerhalb der Marke wird jede vertikale
                       Luft weggenommen. Die Regeln nennen keine Klassennamen
                       von DORA - nur Elementarten - und ueberstehen darum
                       einen Umbau des Formulars. */
                    .dora-autorenzeile div,
                    .dora-autorenzeile p,
                    .dora-autorenzeile span,
                    .dora-autorenzeile td,
                    .dora-autorenzeile th,
                    .dora-autorenzeile fieldset {
                        margin-top: 0 !important;
                        margin-bottom: 0 !important;
                    }
                    .dora-autorenzeile .form-item {
                        margin: 0 0 3px 0 !important;
                        padding: 0 !important;
                    }
                    .dora-autorenzeile label {
                        margin: 0 0 1px 0 !important;
                        padding: 0 !important;
                        font-size: 10px !important;
                        line-height: 1.1 !important;
                        letter-spacing: 0 !important;
                    }
                    .dora-autorenzeile input[type="text"],
                    .dora-autorenzeile select {
                        height: 24px !important;
                        padding: 2px 6px !important;
                        margin: 0 !important;
                        font-size: 11px !important;
                    }
                    .dora-autorenzeile td,
                    .dora-autorenzeile th {
                        padding: 1px 6px !important;
                        vertical-align: top !important;
                    }
                    .dora-autorenzeile tr { height: auto !important; }
                    /* Drupal setzt gern <br> als Abstandshalter zwischen die
                       Felder - in einer Autorenzeile ist das reine Luft. */
                    .dora-autorenzeile br { display: none !important; }
                    /* Abstaende eines Raster-/Flexlayouts einfangen */
                    .dora-autorenzeile,
                    .dora-autorenzeile > div {
                        gap: 2px 10px !important;
                        row-gap: 2px !important;
                        margin: 0 !important;
                        padding: 2px 0 !important;
                    }
                    /* Leere Zellen und Huellen sollen keine Hoehe halten */
                    .dora-autorenzeile td:empty,
                    .dora-autorenzeile div:empty { display: none !important; }

                    /* Ultra-Kompression für die Autorenliste.
                       Bewusst nicht an <table> gebunden: die Zeilen liegen je
                       nach DORA-Stand in einer Tabelle, in Flexbox oder in
                       einem Raster. Was hier zaehlt, sind die Felder. */
                    .dora-authors-fieldset .form-item,
                    .islandora-form-fieldpanel-pane .form-item {
                        margin: 0 !important;
                        padding: 0 !important;
                    }
                    .dora-authors-fieldset .form-item label,
                    .islandora-form-fieldpanel-pane .form-item label {
                        margin: 0 0 1px 0 !important;
                        font-size: 10px !important;
                        letter-spacing: 0 !important;
                    }
                    /* Abstaende eines Flex-/Rasterlayouts einfangen */
                    .dora-authors-fieldset .islandora-form-fieldpanel-pane,
                    .dora-authors-fieldset .islandora-form-fieldpanel,
                    .dora-authors-fieldset .form-wrapper,
                    .islandora-form-fieldpanel-pane {
                        gap: 4px !important;
                        row-gap: 4px !important;
                        column-gap: 6px !important;
                        margin: 0 !important;
                        padding: 2px 4px !important;
                    }
                    .dora-authors-fieldset table {
                        margin: 2px 0 !important;
                    }
                    .dora-authors-fieldset table td {
                        padding: 2px 4px !important;
                        vertical-align: middle !important;
                    }
                    .dora-authors-fieldset .form-item {
                        margin: 0 !important;
                        padding: 0 !important;
                    }
                    .dora-authors-fieldset input[type="text"], 
                    .dora-authors-fieldset select {
                        padding: 3px 6px !important;
                        height: 24px !important;
                        font-size: 11px !important;
                    }
                    .dora-authors-fieldset input[type="image"], 
                    .dora-authors-fieldset input[type="submit"] {
                        padding: 2px !important;
                        margin: 0 !important;
                        height: 20px !important;
                        width: auto !important;
                    }
                    
                    .messages { padding: 8px !important; margin: 8px 0 !important; border-radius: 6px !important; }
                    
                    /* Hide Drupal Theme Sidebars, Navigation, Breadcrumbs */
                    #sidebar-first, #sidebar-second, .region-sidebar-first, .region-sidebar-second, 
                    #navigation, #nav, .sidebar, #breadcrumb, .breadcrumb, #admin-menu, #page-title {
                        display: none !important;
                        width: 0 !important;
                    }
                    
                    /* Force Main Content to 100% Width */
                    #main, #content, #main-wrapper, #content-wrapper, .main-content, .content, #center, #main-content {
                        width: 100% !important;
                        max-width: 100% !important;
                        margin: 0 !important;
                        padding: 0 !important;
                        float: none !important;
                    }
                    
                    /* Hilfsklasse zum erzwungenen Ausblenden (überschreibt display: block !important) */
                    .dora-hidden { display: none !important; }

                    /* IDs müssen in der QC immer sichtbar sein: Drupal klappt das
                       Identifier-Fieldset per Voreinstellung zu, und die
                       Ausblend-Logik darf es nicht mehr erwischen. */
                    fieldset[data-dora-keep] { display: block !important; }
                    fieldset[data-dora-keep] > .fieldset-wrapper,
                    [data-dora-keep] > .fieldset-wrapper { display: block !important; }
                    [data-dora-keep] { display: block !important; }
                    [data-dora-keep].dora-hidden { display: block !important; }
                    td[data-dora-keep], th[data-dora-keep] { display: table-cell !important; }


                    /* Validierungsfehler-Hervorhebung */
                    .dora-error, input.dora-error, select.dora-error, textarea.dora-error {
                        border: 2px solid #e53e3e !important;
                        background-color: #fff5f5 !important;
                    }
                    
                    /* Neue QC-Highlight-Box am Formularanfang */
                    .dora-qc-highlight-box {
                        background: #f0fdf4 !important;
                        border: 1px solid #bbf7d0 !important;
                        border-left: 5px solid #22c55e !important;
                        border-radius: 8px !important;
                        padding: 12px !important;
                        margin-bottom: 16px !important;
                        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05) !important;
                    }
                    
                    .dora-qc-highlight-box h3 {
                        margin: 0 0 8px 0 !important;
                        font-size: 13px !important;
                        color: #15803d !important;
                        display: flex !important;
                        align-items: center !important;
                        gap: 6px !important;
                        text-transform: uppercase !important;
                        letter-spacing: 0.5px !important;
                    }
                `;
                doc.head.appendChild(style);

                // DOI, ISBN, PMID & Co. sind für die Qualitätskontrolle
                // unverzichtbar. Sie waren aus zwei Gründen nicht zu sehen:
                // Drupal liefert das Identifier-Fieldset eingeklappt aus, und
                // die Ausblend-Logik unten hat Wrapper mitgenommen. Deshalb
                // werden diese Felder markiert (data-dora-keep), zwangsweise
                // aufgeklappt und von der Ausblendung ausgenommen.
                const ID_TEXT_RE = /(\bdoi\b|\bisbn\b|\bissn\b|\bpmid\b|pubmed|web of science|\bwos\b|\bisi\b|scopus|\beid\b|arxiv|\bhandle\b|\burn\b|accession|patent number|report number|identifier|identifikator)/;

                const istIdFeld = (el) => {
                    const attrs = `${el.id || ''} ${el.name || ''}`.toLowerCase();
                    if (/edit-identifiers|identifiers\[|identifier/.test(attrs)) return true;
                    if (/\b(doi|isbn|issn|pmid|wos|isi|scopus|eid|arxiv)\b/.test(attrs.replace(/[-_[\]]/g, ' '))) return true;
                    if (el.id) {
                        const label = doc.querySelector(`label[for="${el.id}"]`);
                        if (label && ID_TEXT_RE.test(label.textContent.toLowerCase())) return true;
                    }
                    return false;
                };

                // Drupal-Rahmen (Menü, Tabs, Kopf-/Fusszeile) bleibt verborgen -
                // der Aufwärts-Durchlauf unten darf ihn nicht wieder einschalten.
                const CHROME_IDS = ['header', 'footer', 'toolbar', 'branding', 'page-title',
                    'navigation', 'nav', 'breadcrumb', 'sidebar-first', 'sidebar-second', 'admin-menu'];
                const istSeitenrahmen = (el) => {
                    if (!el || el.nodeType !== 1) return false;
                    if (el.id && CHROME_IDS.includes(el.id)) return true;
                    if (el.classList && (el.classList.contains('tabs') || el.classList.contains('sidebar') ||
                        el.classList.contains('breadcrumb'))) return true;
                    return false;
                };

                // Vom Feld aufwärts alles wieder sichtbar machen und
                // eingeklappte Fieldsets öffnen - aber nur innerhalb des
                // Formulars, damit die Seitennavigation verborgen bleibt.
                const idFeldFreilegen = (el) => {
                    const grenze = doc.getElementById('islandora-xml-form-builder-form') || doc.querySelector('form');
                    let knoten = el;
                    while (knoten && knoten !== doc.body && knoten.nodeType === 1) {
                        if (istSeitenrahmen(knoten)) break;

                        knoten.classList.remove('dora-hidden');
                        if (knoten.style && knoten.style.display === 'none') knoten.style.display = '';

                        if (knoten.tagName === 'FIELDSET') {
                            knoten.classList.remove('collapsed');
                            knoten.setAttribute('data-dora-keep', 'true');
                            const wrapper = knoten.querySelector('.fieldset-wrapper');
                            if (wrapper) {
                                wrapper.style.display = 'block';
                                wrapper.classList.remove('dora-hidden');
                            }
                        } else if (knoten.tagName === 'DETAILS') {
                            knoten.open = true;
                        } else if (knoten.classList.contains('form-item') ||
                            knoten.classList.contains('form-wrapper') ||
                            knoten.tagName === 'TD' || knoten.tagName === 'TH') {
                            knoten.setAttribute('data-dora-keep', 'true');
                        }

                        if (knoten === grenze) break; // nicht über das Formular hinaus
                        knoten = knoten.parentElement;
                    }
                };

                const keepIdFieldsVisible = () => {
                    doc.querySelectorAll('input, textarea, select').forEach(el => {
                        if (el.type === 'hidden') return;
                        if (istIdFeld(el)) idFeldFreilegen(el);
                    });

                    // Legenden wie "Identifiers" zusätzlich aufklappen, auch
                    // wenn die Felder darin anders benannt sind.
                    doc.querySelectorAll('legend, .fieldset-legend').forEach(legend => {
                        if (!ID_TEXT_RE.test(legend.textContent.toLowerCase())) return;
                        const fieldset = legend.closest('fieldset') || legend.closest('.form-wrapper');
                        if (fieldset) idFeldFreilegen(fieldset.querySelector('input, select, textarea') || fieldset);
                    });
                };

                // Schutzprüfung für die Ausblend-Durchläufe unten
                const istGeschuetzt = (el) => {
                    if (!el || el.nodeType !== 1) return false;
                    if (el.hasAttribute('data-dora-keep')) return true;
                    if (el.closest && el.closest('[data-dora-keep]')) return true;
                    return !!(el.querySelector && el.querySelector('[data-dora-keep]'));
                };

                // Spezifische Felder anhand ihrer Beschriftung & Element-Attribute ausblenden (Dual-Strategie für maximale Zuverlässigkeit)
                const hideSpecificFields = () => {
                    // IDs zuerst freilegen, damit die Durchläufe sie erkennen
                    keepIdFieldsVisible();

                    // Strategie 1: Text-basierte Übereinstimmung für Labels, Legenden und Tabellenköpfe
                    const textTargets = [
                        "corresponding author's e-mail",
                        "corresponding author e-mail",
                        "department descriptor",
                        "duo group info",
                        "duo laboratory info",
                        "duo division info"
                    ];

                    const matchesText = (text) => {
                        const cleanText = text.toLowerCase().trim().replace(/\s+/g, ' ');
                        return textTargets.some(t => cleanText === t || cleanText.startsWith(t) || cleanText.endsWith(t) || (cleanText.includes(t) && cleanText.length < 50));
                    };

                    // Strategie 2: Attribut-basierte Übereinstimmung (id, name, class) für Inputs/Textareas
                    const attributeTargets = [
                        "notes_group", "notes-group", "notes_lab", "notes-lab", "notes_div", "notes-div",
                        "dept_descriptor", "dept-descriptor",
                        "department_descriptor", "department-descriptor",
                        "corresponding_author_email", "corresponding-author-email", "corresponding_email", "corresponding-email"
                    ];

                    const matchesAttribute = (attr) => {
                        if (!attr) return false;
                        const cleanAttr = attr.toLowerCase();
                        return attributeTargets.some(t => cleanAttr.includes(t));
                    };

                    // A: Zuerst alle Formularfelder (input, textarea, select) nach ID/Name/Klasse durchsuchen
                    doc.querySelectorAll('input, textarea, select').forEach(el => {
                        if (istGeschuetzt(el)) return;
                        if (matchesAttribute(el.id) || matchesAttribute(el.name) || matchesAttribute(el.className)) {
                            // Wrapper des Formularfelds ausblenden
                            const wrapper = el.closest('.form-item') || el.closest('.form-wrapper') || el.closest('td') || el.parentElement;
                            if (wrapper && !istGeschuetzt(wrapper) && !wrapper.classList.contains('dora-hidden')) {
                                wrapper.classList.add('dora-hidden');
                            }
                            // Dazugehörige Labels ebenfalls ausblenden (über das 'for'-Attribut)
                            if (el.id) {
                                doc.querySelectorAll(`label[for="${el.id}"]`).forEach(lbl => {
                                    lbl.classList.add('dora-hidden');
                                    const lblWrapper = lbl.closest('.form-item') || lbl.closest('.form-wrapper') || lbl.parentElement;
                                    if (lblWrapper && !lblWrapper.classList.contains('dora-hidden')) {
                                        lblWrapper.classList.add('dora-hidden');
                                    }
                                });
                            }
                        }
                    });

                    // B: Alle Labels nach Textinhalt oder 'for'-Attribut durchsuchen
                    doc.querySelectorAll('label').forEach(label => {
                        if (matchesText(label.textContent) || matchesAttribute(label.getAttribute('for'))) {
                            const wrapper = label.closest('.form-item') || label.closest('.form-wrapper') || label.closest('td') || label.parentElement;
                            if (wrapper && !istGeschuetzt(wrapper) && !wrapper.classList.contains('dora-hidden')) {
                                wrapper.classList.add('dora-hidden');
                            }
                        }
                    });

                    // C: Alle Fieldset-Legenden nach Textinhalt durchsuchen
                    doc.querySelectorAll('legend, .fieldset-legend').forEach(legend => {
                        if (matchesText(legend.textContent)) {
                            const fieldset = legend.closest('fieldset') || legend.closest('.form-wrapper');
                            if (fieldset && !istGeschuetzt(fieldset) && !fieldset.classList.contains('dora-hidden')) {
                                fieldset.classList.add('dora-hidden');
                            }
                        }
                    });

                    // D: Tabellenköpfe nach Textinhalt durchsuchen (für ganze Spalten wie in Autorentabellen)
                    doc.querySelectorAll('th').forEach(th => {
                        if (istGeschuetzt(th)) return;
                        if (matchesText(th.textContent)) {
                            const index = Array.from(th.parentElement.children).indexOf(th);
                            const table = th.closest('table');
                            if (table && index !== -1) {
                                th.classList.add('dora-hidden');
                                table.querySelectorAll(`tr`).forEach(tr => {
                                    const cells = tr.children;
                                    if (cells[index] && !istGeschuetzt(cells[index])) {
                                        cells[index].classList.add('dora-hidden');
                                    }
                                });
                            }
                        }
                    });

                    // E: Hilfstexte und Beschreibungen extrem aggressiv ausblenden
                    doc.querySelectorAll('.description, .help-block, div.description, p.help, .form-desc, .fieldset-description, [class*="description"]').forEach(el => {
                        // Nie etwas ausblenden, das selbst ein Eingabefeld trägt -
                        // sonst verschwinden Felder mit "description" im Klassennamen.
                        if (el.querySelector('input, select, textarea')) return;
                        el.style.display = 'none';
                        el.classList.add('dora-hidden');
                    });

                    // F: Formular restrukturieren (QC-Felder an den Anfang)
                    restructureFormForQc();

                    // Nach dem Umsortieren erneut sicherstellen, dass die IDs
                    // offen und sichtbar sind (Drupal klappt beim Verschieben
                    // gelegentlich wieder zu).
                    keepIdFieldsVisible();
                };

                const restructureFormForQc = () => {
                    const form = doc.getElementById('islandora-xml-form-builder-form') || doc.querySelector('form');
                    if (!form) return;

                    let qcFieldWrapper = null;
                    let initialsFieldWrapper = null;

                    const isValidQcWrapper = (el) => {
                        if (!el) return false;
                        const tag = el.tagName;
                        if (tag === 'FORM' || tag === 'FIELDSET' || tag === 'TABLE' || tag === 'BODY' || tag === 'HTML') return false;
                        if (el.querySelector('fieldset, table, input[type="submit"], button[type="submit"]')) return false;
                        return true;
                    };

                    // Robust alle Text-Träger durchsuchen um QC-Felder sprachunabhängig zu extrahieren
                    doc.querySelectorAll('label, legend, .fieldset-legend, span, div, th, td').forEach(el => {
                        if (el.children.length > 0 && el.tagName !== 'LABEL' && el.tagName !== 'LEGEND' && !el.classList.contains('fieldset-legend')) return;

                        const text = el.textContent.toLowerCase();
                        // Quality Control Status Feld (Yes/No Dropdown)
                        const isQcStatus = text.includes('quality control') || text.includes('qualitätskontrolle') || text.includes('freigabe') || (text.includes('qc') && !text.includes('id') && !text.includes('by') && !text.includes('kürzel'));
                        if (isQcStatus && !text.includes('id') && !text.includes('by') && !text.includes('kürzel') && !text.includes('reviewer')) {
                            const candidate = el.closest('.form-item') || el.closest('.form-wrapper') || el.parentElement;
                            if (isValidQcWrapper(candidate)) {
                                qcFieldWrapper = candidate;
                            }
                        }
                        // Reviewer / Initials / QC ID Feld
                        const isInitials = text.includes('quality control id') || text.includes('kürzel') || text.includes('reviewer') || text.includes('user') || text.includes('quality control by') || text.includes('qc id') || text.includes('qc-id') || text.includes('qc_id');
                        if (isInitials) {
                            const candidate = el.closest('.form-item') || el.closest('.form-wrapper') || el.parentElement;
                            if (isValidQcWrapper(candidate)) {
                                initialsFieldWrapper = candidate;
                            }
                        }
                    });

                    // Manage die grüne QC-Card (einmalig erzeugen, falls Felder vorhanden sind)
                    let qcCard = doc.getElementById('dora-qc-header-card');
                    try {
                        if (qcFieldWrapper || initialsFieldWrapper) {
                            if (!qcCard) {
                                qcCard = doc.createElement('div');
                                qcCard.id = 'dora-qc-header-card';
                                qcCard.className = 'dora-qc-highlight-box';
                                qcCard.style.cssText = 'margin-top: 24px !important; margin-bottom: 24px !important;';

                                const qcH3 = doc.createElement('h3');
                                qcH3.innerHTML = '⚡ QC Status &amp; Freigabe (Quality Control)';
                                qcCard.appendChild(qcH3);

                                const fieldsContainer = doc.createElement('div');
                                fieldsContainer.id = 'dora-qc-fields-container';
                                fieldsContainer.style.cssText = 'display: flex; gap: 15px;';
                                qcCard.appendChild(fieldsContainer);

                                // Positionieren am Formularende (neben den Aktionen)
                                const formSubmitBtn = doc.querySelector('input[type="submit"], button[type="submit"], .form-submit');
                                const actionsContainer = doc.getElementById('edit-actions') || doc.querySelector('.form-actions') || (formSubmitBtn ? formSubmitBtn.closest('.form-actions') || formSubmitBtn.parentElement : null);

                                if (actionsContainer && actionsContainer.parentElement) {
                                    actionsContainer.parentElement.insertBefore(qcCard, actionsContainer);
                                } else {
                                    form.appendChild(qcCard);
                                }
                            }

                            const fieldsContainer = doc.getElementById('dora-qc-fields-container');

                            // Spiegelungs-Klon für QC Status (falls noch nicht erzeugt)
                            if (qcFieldWrapper && !doc.getElementById('dora-mirrored-qc-status')) {
                                const originalSelect = qcFieldWrapper.querySelector('select');
                                const originalInput = qcFieldWrapper.querySelector('input');

                                const wrapper = doc.createElement('div');
                                wrapper.id = 'dora-mirrored-qc-status';
                                wrapper.style.cssText = 'flex: 1; display: flex; flex-direction: column; gap: 4px;';

                                const label = doc.createElement('label');
                                label.textContent = 'Quality Control';
                                label.style.cssText = 'font-weight: 600; font-size: 11px; color: #475569; text-transform: uppercase; margin-bottom: 2px !important;';
                                wrapper.appendChild(label);

                                let myInput;
                                if (originalSelect) {
                                    myInput = doc.createElement('select');
                                    Array.from(originalSelect.options).forEach(opt => {
                                        const myOpt = doc.createElement('option');
                                        myOpt.value = opt.value;
                                        myOpt.textContent = opt.textContent;
                                        myOpt.selected = opt.selected;
                                        myInput.appendChild(myOpt);
                                    });
                                } else {
                                    myInput = doc.createElement('input');
                                    myInput.type = originalInput ? originalInput.type : 'text';
                                    myInput.value = originalInput ? originalInput.value : '';
                                }
                                myInput.style.cssText = 'width: 100% !important; padding: 6px 10px !important; border: 1px solid #cbd5e1 !important; border-radius: 6px !important; box-sizing: border-box !important; background: white !important;';
                                wrapper.appendChild(myInput);
                                fieldsContainer.appendChild(wrapper);

                                // Sync Gespiegelt -> Original
                                const syncToOriginal = () => {
                                    const target = originalSelect || originalInput;
                                    if (target) {
                                        target.value = myInput.value;
                                        target.dispatchEvent(new Event('change', { bubbles: true }));
                                        target.dispatchEvent(new Event('input', { bubbles: true }));
                                    }
                                };
                                myInput.addEventListener('change', syncToOriginal);
                                if (!originalSelect) {
                                    myInput.addEventListener('input', syncToOriginal);
                                }

                                // Periodischer Sync Original -> Gespiegelt
                                setInterval(() => {
                                    const target = originalSelect || originalInput;
                                    if (target && myInput && doc.activeElement !== myInput) {
                                        if (myInput.value !== target.value) {
                                            myInput.value = target.value;
                                        }
                                    }
                                }, 250);
                            }

                            // Original-Feld sichtbar lassen und highlighten
                            if (qcFieldWrapper) {
                                qcFieldWrapper.style.borderLeft = '3px solid #22c55e';
                                qcFieldWrapper.style.paddingLeft = '8px';
                            }

                            // Spiegelungs-Klon für QC ID (falls noch nicht erzeugt)
                            if (initialsFieldWrapper && !doc.getElementById('dora-mirrored-qc-id')) {
                                const originalInitialsInput = initialsFieldWrapper.querySelector('input');

                                const wrapper = doc.createElement('div');
                                wrapper.id = 'dora-mirrored-qc-id';
                                wrapper.style.cssText = 'flex: 1; display: flex; flex-direction: column; gap: 4px;';

                                const label = doc.createElement('label');
                                label.textContent = 'Quality Control ID (Kürzel)';
                                label.style.cssText = 'font-weight: 600; font-size: 11px; color: #475569; text-transform: uppercase; margin-bottom: 2px !important;';
                                wrapper.appendChild(label);

                                const myInitialsInput = doc.createElement('input');
                                myInitialsInput.type = 'text';
                                myInitialsInput.value = originalInitialsInput ? originalInitialsInput.value : '';
                                myInitialsInput.placeholder = 'z.B. cro';
                                myInitialsInput.style.cssText = 'width: 100% !important; padding: 6px 10px !important; border: 1px solid #cbd5e1 !important; border-radius: 6px !important; box-sizing: border-box !important; background: white !important;';
                                wrapper.appendChild(myInitialsInput);
                                fieldsContainer.appendChild(wrapper);

                                // Sync Gespiegelt -> Original
                                myInitialsInput.addEventListener('input', () => {
                                    if (originalInitialsInput) {
                                        originalInitialsInput.value = myInitialsInput.value;
                                        originalInitialsInput.dispatchEvent(new Event('input', { bubbles: true }));
                                        originalInitialsInput.dispatchEvent(new Event('change', { bubbles: true }));
                                    }
                                });

                                // Periodischer Sync Original -> Gespiegelt
                                setInterval(() => {
                                    if (originalInitialsInput && myInitialsInput && doc.activeElement !== myInitialsInput) {
                                        if (myInitialsInput.value !== originalInitialsInput.value) {
                                            myInitialsInput.value = originalInitialsInput.value;
                                        }
                                    }
                                }, 250);
                            }

                            // Original-Feld sichtbar lassen und highlighten
                            if (initialsFieldWrapper) {
                                initialsFieldWrapper.style.borderLeft = '3px solid #22c55e';
                                initialsFieldWrapper.style.paddingLeft = '8px';
                            }
                        }
                    } catch (cardError) {
                        console.error('Error rendering DORA QC Card at bottom:', cardError);
                    }

                    // Wichtige Abschnitte suchen. Die ID-Abschnitte werden
                    // ausdrücklich NICHT verschoben: sie stecken im Formular
                    // teils in denselben Fieldsets wie die QC-Felder, das Ganze
                    // nach oben zu ziehen hat das Formular durcheinander
                    // gebracht. Sie bleiben unten und werden nur sichtbar
                    // gehalten (keepIdFieldsVisible).
                    let titleFieldset = null;
                    let authorFieldset = null;

                    doc.querySelectorAll('legend, .fieldset-legend').forEach(legend => {
                        const text = legend.textContent.toLowerCase();
                        if (text.includes('title') || text.includes('titel')) {
                            titleFieldset = legend.closest('fieldset') || legend.closest('.form-wrapper');
                        } else if (text.includes('author') || text.includes('autoren')) {
                            authorFieldset = legend.closest('fieldset') || legend.closest('.form-wrapper');
                        }
                    });

                    // Physisches Umsortieren am Anfang des Formulars (einmalig markiert per Attribut)
                    const next = form.firstChild;

                    if (titleFieldset && titleFieldset.getAttribute('data-dora-moved') !== 'true') {
                        form.insertBefore(titleFieldset, next);
                        titleFieldset.style.borderLeft = '4px solid #3b82f6';
                        titleFieldset.style.paddingLeft = '12px';
                        titleFieldset.setAttribute('data-dora-moved', 'true');
                    }
                    // Rueckfall: die Autorenzeilen sind an ihren Eingabefeldern
                    // zu erkennen (name endet auf [valName]). Das haelt auch,
                    // wenn die Legende anders heisst oder das Panel kein
                    // Fieldset mehr ist.
                    if (!authorFieldset) {
                        const namensfeld = doc.querySelector('input[name$="[valName]"]');
                        if (namensfeld) {
                            authorFieldset = namensfeld.closest('fieldset')
                                || namensfeld.closest('.form-wrapper')
                                || namensfeld.closest('.islandora-form-fieldpanel');
                        }
                    }

                    if (authorFieldset) {
                        // Die Kennzeichnung haengt NICHT am Verschieben: sonst
                        // bleibt das Panel unkompakt, sobald das Umsortieren
                        // einmal ausfaellt.
                        authorFieldset.classList.add('dora-authors-fieldset');
                    }

                    if (authorFieldset && authorFieldset.getAttribute('data-dora-moved') !== 'true') {
                        form.insertBefore(authorFieldset, titleFieldset ? titleFieldset.nextSibling : next);
                        authorFieldset.style.borderLeft = '4px solid #3b82f6';
                        authorFieldset.style.paddingLeft = '12px';
                        authorFieldset.setAttribute('data-dora-moved', 'true');
                    }

                    // Highlight specific QC-critical micro-fields (Corresponding Author, Start Page, Peer Review, Publication Status)
                    const highlightField = (el, isFieldset = false) => {
                        if (!el || el.getAttribute('data-dora-highlighted') === 'true') return;
                        el.style.borderLeft = '3px solid #f59e0b'; // Amber Accent
                        el.style.background = '#fffbeb';          // Soft warm amber background
                        el.style.padding = isFieldset ? '10px 15px' : '6px 12px';
                        el.style.margin = isFieldset ? '12px 0 !important' : '8px 0 !important';
                        el.style.borderRadius = '0 6px 6px 0';
                        el.style.boxShadow = '0 1px 2px rgba(245, 158, 11, 0.05)';
                        el.setAttribute('data-dora-highlighted', 'true');
                    };

                    doc.querySelectorAll('label').forEach(label => {
                        const text = label.textContent.toLowerCase();
                        const isCorrespondingAuthor = text.includes('corresponding') && (text.includes('author') || text.includes('autor'));
                        const isStartPage = (text.includes('start') || text.includes('anfangs') || text.includes('erste')) && (text.includes('page') || text.includes('seite')) && !text.includes('range');
                        const isPeerReview = text.includes('peer') && (text.includes('review') || text.includes('reviewed') || text.includes('begutachtet'));
                        const isPubStatus = (text.includes('publication') || text.includes('publikation') || text.includes('publishing')) && text.includes('status');

                        if (isCorrespondingAuthor || isStartPage || isPeerReview || isPubStatus) {
                            const item = label.closest('.form-item') || label.parentElement;
                            if (item) highlightField(item, false);
                        }
                    });

                    doc.querySelectorAll('legend, .fieldset-legend').forEach(legend => {
                        const text = legend.textContent.toLowerCase();
                        const isCorrespondingAuthor = text.includes('corresponding') && (text.includes('author') || text.includes('autor'));
                        const isStartPage = (text.includes('start') || text.includes('anfangs') || text.includes('erste')) && (text.includes('page') || text.includes('seite')) && !text.includes('range');
                        const isPeerReview = text.includes('peer') && (text.includes('review') || text.includes('reviewed') || text.includes('begutachtet'));
                        const isPubStatus = (text.includes('publication') || text.includes('publikation') || text.includes('publishing')) && text.includes('status');

                        if (isCorrespondingAuthor || isStartPage || isPeerReview || isPubStatus) {
                            const fieldset = legend.closest('fieldset') || legend.closest('.form-wrapper');
                            if (fieldset) highlightField(fieldset, true);
                        }
                    });

                    // Speichern-Button stylen
                    const submitBtn = doc.getElementById('edit-submit') || doc.querySelector('input[type="submit"][value="Save"]') || doc.querySelector('input[type="submit"][value="Speichern"]');
                    if (submitBtn) {
                        submitBtn.style.cssText = 'background: #22c55e !important; color: white !important; border: 1px solid #16a34a !important; padding: 10px 20px !important; border-radius: 6px !important; font-weight: bold !important; font-size: 13px !important; cursor: pointer !important; margin-top: 15px !important; width: 100% !important; transition: background 0.15s !important;';
                    }
                };
                hideSpecificFields();
                const hideInterval = setInterval(hideSpecificFields, 500);
                setTimeout(() => clearInterval(hideInterval), 15000);

                // Prüfen, ob bereits freigegeben (QC = Yes) und ggf. in der Sidebar markieren
                try {
                    let isAlreadyApproved = false;
                    const docLabels = doc.querySelectorAll('label');
                    docLabels.forEach(l => {
                        const text = l.textContent.toLowerCase();
                        if (text.includes('quality control') && !text.includes('id') && !text.includes('by') && !text.includes('kürzel')) {
                            const inputId = l.getAttribute('for');
                            if (inputId) {
                                const el = doc.getElementById(inputId);
                                if (el) {
                                    if (el.tagName === 'SELECT' && el.value === 'Yes') {
                                        isAlreadyApproved = true;
                                    } else if (el.tagName === 'INPUT' && el.value.toLowerCase().includes('yes')) {
                                        isAlreadyApproved = true;
                                    }
                                }
                            }
                        }
                    });

                    if (!isAlreadyApproved) {
                        const select = doc.querySelector('select[name*="quality_control"]') || doc.querySelector('select[id*="quality_control"]');
                        if (select && select.value === 'Yes') {
                            isAlreadyApproved = true;
                        }
                    }

                    if (isAlreadyApproved) {
                        markPidAsApproved(pid);
                    }
                } catch (err) {
                    console.warn("Error scanning for pre-existing QC status:", err);
                }

                // We add a listener to the form inside the iframe to catch successful submits
                const form = doc.getElementById('islandora-ingest-form') || doc.querySelector('.node-form') || doc.getElementById('islandora-xml-form-builder-form');
                if (form) {
                    form.addEventListener('submit', () => {
                        // Optimistically mark as done
                        const item = document.getElementById(`batch-qc-item-${currentPid.replace(':', '-')}`);
                        if (item && !item.innerHTML.includes('✅')) {
                            item.innerHTML = `✅ <strong>${currentPid}</strong>`;
                        }
                    });
                }

            } catch (e) {
                console.log("Iframe cross-origin restriction or not ready:", e);
            }
        };
        // Form Iframe src set AFTER onload to ensure event triggers reliably!
        middleIframe.src = `/${inst}/islandora/object/${pid}/lib4ridora_edit_mods`;
    }

    function approveCurrentForm() {
        if (!currentPid) return;

        chrome.storage.local.get({ qcInitials: '' }, function (result) {
            const initials = result.qcInitials.trim();
            if (!initials) {
                alert("Bitte legen Sie zuerst Ihr Kürzel für die Qualitätskontrolle in den DORA Helper Einstellungen fest!");
                return;
            }

            // Sofortiges visuelles Feedback auf dem QC-Button
            approveBtn.textContent = '✓ QC auf Yes gesetzt!';
            approveBtn.style.background = '#15803d';
            approveBtn.style.boxShadow = '0 2px 4px rgba(21, 128, 61, 0.4)';

            // PID sofort in der Sidebar als freigegeben markieren
            markPidAsApproved(currentPid);

            try {
                const doc = middleIframe.contentDocument;
                if (!doc) {
                    alert("Kann nicht auf das Formular zugreifen. Möglicherweise noch nicht geladen.");
                    return;
                }

                let qcField = null;
                let initialsField = null;

                // 1. Suche nach Labels
                const labels = doc.querySelectorAll('label');
                labels.forEach(l => {
                    const text = l.textContent.toLowerCase();

                    // Quality Control Feld finden (Dropdown bevorzugt)
                    if (text.includes('quality control') && !text.includes('id') && !text.includes('by') && !text.includes('kürzel')) {
                        const inputId = l.getAttribute('for');
                        if (inputId) {
                            const el = doc.getElementById(inputId);
                            if (el && el.tagName === 'SELECT') {
                                qcField = el;
                            } else if (!qcField && el) {
                                qcField = el;
                            }
                        }
                    }

                    // Kürzel / User Feld finden (Quality Control ID Textfeld)
                    if (text.includes('quality control id') || text.includes('kürzel') || text.includes('reviewer') || text.includes('user') || text.includes('quality control by') || text.includes('qc id')) {
                        const inputId = l.getAttribute('for');
                        if (inputId) initialsField = doc.getElementById(inputId);
                    }
                });

                // Fallbacks für Quality Control (bevorzuge Dropdown!)
                if (!qcField) {
                    const select = doc.querySelector('select[name*="quality_control"]') || doc.querySelector('select[id*="quality_control"]');
                    if (select) qcField = select;
                }

                if (qcField) {
                    qcField.value = 'Yes';
                    qcField.dispatchEvent(new Event('change', { bubbles: true }));
                    qcField.dispatchEvent(new Event('input', { bubbles: true }));
                    qcField.style.backgroundColor = '#d4edda'; // Highlight
                } else {
                    console.warn("DORA Helper: Quality Control dropdown not found automatically.");
                }

                // Fallbacks für Kürzel
                if (!initialsField) {
                    // Das Textfeld für ID / Reviewer
                    initialsField = doc.querySelector('input[type="text"][name*="quality_control"]') || doc.querySelector('input[name*="reviewer"]') || doc.querySelector('input[name*="kuerzel"]') || doc.querySelector('input[name*="qc_id"]');
                }

                if (initialsField) {
                    let currentVal = initialsField.value || '';
                    if (currentVal && !currentVal.includes(initials)) {
                        // Append if not already there
                        initialsField.value = currentVal.trim() + ' ' + initials;
                    } else if (!currentVal) {
                        initialsField.value = initials;
                    }
                    initialsField.dispatchEvent(new Event('input', { bubbles: true }));
                    initialsField.style.backgroundColor = '#d4edda';
                } else {
                    console.warn("DORA Helper: Initials field not found automatically.");
                }

                if (!qcField && !initialsField) {
                    alert("Die Felder 'Quality control' und 'Kürzel' konnten im Formular nicht automatisch gefunden werden. Bitte füllen Sie sie manuell aus und teilen Sie dem Entwickler die exakten Feld-Namen mit.");
                }

                // Find submit button
                const submitBtn = doc.getElementById('edit-submit') || doc.querySelector('input[type="submit"][value="Save"]') || doc.querySelector('input[type="submit"][value="Speichern"]');

                if (submitBtn) {
                    // Opt-in Auto-Submit (hier scrollen wir nur hin, damit der User nochmal prüfen kann)
                    submitBtn.scrollIntoView({ behavior: "smooth", block: "center" });
                    submitBtn.style.border = "3px solid #28a745";
                    
                    // Automatisch absenden nach kurzem Feedback
                    setTimeout(() => {
                        submitBtn.click();
                    }, 300);
                } else {
                    alert("Speichern-Button nicht gefunden!");
                }

            } catch (e) {
                console.error(e);
                alert("Fehler beim Approve-Vorgang. " + e.message);
            }
        });
    }
}


// =====================================================================
// PROJEKT- / FUNDING-VERKNUEPFUNG (Crossref + OpenAIRE -> DORA-Formular)
// ---------------------------------------------------------------------
// Scopus liefert Foerderangaben nur so gut, wie das Acknowledgement
// formuliert ist. Crossref (Verlagsangabe) und OpenAIRE (Projektregister
// von SNSF/EU) sind deutlich verlaesslicher und werden hier ueber die DOI
// abgefragt, mit dem Formularinhalt abgeglichen und auf Klick eingetragen.
// =====================================================================


// DOI aus dem Formular, sonst aus dem laufenden Abruf bzw. der Session
function getCurrentDoiForFunding() {
    const doiInput = document.getElementById('edit-identifiers-doi') || findField('DOI');
    const fromForm = doiInput && doiInput.value ? doiInput.value.trim() : '';
    if (fromForm) return fromForm;

    if (lastAutoFetchedDoi) return lastAutoFetchedDoi;

    const pidMatch = window.location.href.match(/islandora\/object\/([^/]+)/);
    const pid = pidMatch ? decodeURIComponent(pidMatch[1]) : 'ingest';
    return sessionStorage.getItem('dora_helper_current_doi_' + pid) || '';
}

function fundingLabelText(el) {
    let label = (el.labels && el.labels.length) ? el.labels[0] : null;
    if (!label) {
        const item = el.closest('.form-item');
        if (item) label = item.querySelector('label');
    }
    return label ? (label.textContent || '') : '';
}

// Container des Funding-Bereichs finden (ID/Klassen sind je nach Institut
// und Formularversion unterschiedlich, daher heuristisch statt hart kodiert)
function findFundingContainer() {
    const cached = document.querySelector('[data-dora-funding-container]');
    if (cached && document.body.contains(cached)) return cached;

    let container = null;

    // 1. Bekannte DORA-Struktur
    for (const selector of FUNDING_CONTAINER_SELECTORS) {
        const hit = document.querySelector(selector);
        if (hit) { container = hit; break; }
    }

    // 2. Ueber die Feldnamen des Funding-Bereichs zum umschliessenden Fieldpanel
    if (!container) {
        const anyField = document.querySelector('[name^="extension[funding_references]"], [id^="edit-extension-funding-references-"]');
        if (anyField) {
            let node = anyField.parentElement;
            while (node && node !== document.body) {
                if (node.querySelector('.islandora-form-fieldpanel-panel')) { container = node; break; }
                node = node.parentElement;
            }
            if (!container) container = anyField.closest('.form-item') || anyField.parentElement;
        }
    }

    // 3. Heuristik fuer abweichende Formularversionen
    const candidates = container ? [] : Array.from(document.querySelectorAll('input:not([type="hidden"]), select, textarea'))
        .filter(el => FUNDING_FIELD_HINT.test(`${el.name || ''} ${el.id || ''}`));

    if (!container && candidates.length) {
        let node = candidates[0].parentElement;
        while (node && node !== document.body) {
            const covered = candidates.filter(c => node.contains(c)).length;
            // Der Wrapper muss das gesamte Fieldpanel umfassen, nicht nur eine
            // einzelne Zeile - sonst fehlt der "Add"-Button beim Anlegen.
            const isWrapper = !!node.querySelector('.islandora-form-fieldpanel-panel')
                || node.matches('fieldset')
                || (node.matches('.form-item') && !!node.querySelector('table'));
            if (covered === candidates.length && isWrapper) { container = node; break; }
            node = node.parentElement;
        }
        if (!container) container = candidates[0].closest('.form-item, fieldset') || candidates[0].parentElement;
    }

    if (!container) {
        // Fallback: ueber Beschriftungen
        const labels = Array.from(document.querySelectorAll('label, legend, .fieldset-legend, summary'));
        const hit = labels.find(l => /funding|f(ö|oe)rder|grant|award/i.test(l.textContent || ''));
        if (hit) container = hit.closest('.form-item, fieldset, .islandora-form-fieldpanel') || hit.parentElement;
    }

    if (container) container.setAttribute('data-dora-funding-container', '1');
    return container;
}

function getFundingPanes(container) {
    if (!container) return [];
    let panes = Array.from(container.querySelectorAll('.islandora-form-fieldpanel-pane'));
    if (panes.length === 0) panes = Array.from(container.querySelectorAll('table tbody tr:not(.tabledrag-hide)'));
    if (panes.length === 0) panes = [container]; // Einzelzeiliges Formular
    return panes;
}

// Ordnet die Felder einer Zeile den MODS-Rollen zu (greedy, spezifisch zuerst)
function resolveFundingInputs(pane) {
    const inputs = Array.from(pane.querySelectorAll('input:not([type="submit"]):not([type="checkbox"]):not([disabled]), select, textarea'))
        .filter(el => !el.classList.contains('autocomplete')); // Drupals Hilfsfeld mit der Autocomplete-URL
    const scored = [];

    inputs.forEach(el => {
        const haystack = `${el.name || ''} ${el.id || ''} ${fundingLabelText(el)}`;
        Object.keys(FUNDING_ROLE_PATTERNS).forEach(role => {
            // Versteckte Felder nur fuer den Funder Identifier zulassen
            if (el.type === 'hidden' && role !== 'funderIdentifier') return;
            FUNDING_ROLE_PATTERNS[role].forEach((re, rank) => {
                if (re.test(haystack)) scored.push({ el, role, rank });
            });
        });
    });

    scored.sort((a, b) => a.rank - b.rank);

    const result = {};
    const usedEls = new Set();
    scored.forEach(s => {
        if (result[s.role] || usedEls.has(s.el)) return;
        result[s.role] = s.el;
        usedEls.add(s.el);
    });
    return result;
}

function setFundingValue(el, value) {
    if (!el || value === null || value === undefined || value === '') return false;
    if (el.tagName === 'SELECT') {
        const option = Array.from(el.options).find(o =>
            o.value === value || (o.textContent || '').trim() === value);
        if (!option) return false;
        el.value = option.value;
    } else {
        el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
}

// Bereits im Formular erfasste Foerderungen auslesen
function readExistingFunding() {
    const container = findFundingContainer();
    if (!container) return [];

    return getFundingPanes(container).map(pane => {
        const fields = resolveFundingInputs(pane);
        const value = role => (fields[role] && fields[role].value ? fields[role].value.trim() : '');
        return {
            pane: pane,
            fields: fields,
            awardNumber: value('awardNumber'),
            awardTitle: value('awardTitle'),
            funderName: value('funderName'),
            fundingStream: value('fundingStream'),
            isEmpty: !value('awardNumber') && !value('awardTitle') && !value('funderName')
        };
    });
}

// Vergleichsschluessel: im Formular steht die Nummer teils in Rohform
// ("200021E_203578"), in DORA/OpenAIRE aber immer als nackter Code ("203578").
function normalizeAwardNumberForKey(awardNumber) {
    const raw = String(awardNumber || '');
    const groups = raw.match(/\d+/g) || [];
    const long = groups.filter(g => g.length >= 5);
    if (long.length) return long[long.length - 1];
    return groups.join('');
}

function fundingKey(funderName, awardNumber) {
    return `${(funderName || '').toLowerCase().slice(0, 12)}::${normalizeAwardNumberForKey(awardNumber)}`;
}

// Traegt einen Vorschlag ins Formular ein (leere Zeile nutzen, sonst anlegen)
// Schreibt ein Feld und prueft nach, ob der Wert stehen geblieben ist.
// Das Award-Title-Feld haengt an einem Autocomplete-Widget, das Werte
// ausserhalb seines Vokabulars beim change-Event wieder verwirft.
async function writeFundingField(el, value) {
    if (!el) return 'missing';
    if (value === null || value === undefined || value === '') return 'empty';

    const matches = () => {
        if (el.tagName === 'SELECT') {
            const option = Array.from(el.options).find(o => o.value === el.value);
            return !!option && (el.value === value || (option.textContent || '').trim() === value);
        }
        return el.value === value;
    };

    if (!setFundingValue(el, value)) return 'no-option';
    await new Promise(r => setTimeout(r, 120));
    if (matches()) return 'ok';

    // Zweiter Versuch ohne change-Event
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    if (matches()) return 'repaired';

    // Letzter Versuch ganz ohne Events
    el.value = value;
    await new Promise(r => setTimeout(r, 120));
    return matches() ? 'repaired-silent' : 'rejected';
}

async function applyFundingItem(item) {
    let container = findFundingContainer();
    if (!container) throw new Error('Funding-Bereich im Formular nicht gefunden.');

    // Beleg holen, dass DORA das Projekt kennt (Auswahlliste oder Bestand).
    const vocabulary = item.doraEntry !== undefined ? item.doraEntry : await lookupDoraFundingEntry(item);
    item.doraEntry = vocabulary;

    const canonical = fundingCanonicalValues(item);
    if (!canonical) {
        // Ohne Beleg wird nichts geschrieben - das Titelfeld akzeptiert nur
        // bekannte Projekte, Teilzeilen waeren unbrauchbar.
        return {
            blocked: vocabulary ? 'not-in-vocabulary' : 'check-failed',
            vocabulary: vocabulary, written: [], skipped: [], results: {}
        };
    }

    let rows = readExistingFunding();
    let target = rows.find(r => r.isEmpty);

    if (!target) {
        await addMissingRows(() => findFundingContainer(), rows.length + 1);
        rows = readExistingFunding();
        target = rows.find(r => r.isEmpty) || rows[rows.length - 1];
    }
    if (!target) throw new Error('Keine Zeile zum Befuellen gefunden.');

    const results = {};
    const write = async (role, value) => {
        results[role] = target.fields[role]
            ? await writeFundingField(target.fields[role], value)
            : 'missing';
    };

    // Reihenfolge: Der Funder steuert Stream-Auswahl und Autocomplete-Liste
    await write('funderName', item.funderName);
    await new Promise(r => setTimeout(r, 120));

    await write('fundingStream', (canonical && canonical.stream) || item.fundingStream);
    await write('awardTitle', (canonical && canonical.title) || item.awardTitle);

    // award_number ist readonly (wird sonst durch die Autocomplete-Auswahl
    // gefuellt); per Skript gesetzte Werte werden trotzdem mit abgeschickt.
    await write('awardNumber', (canonical && canonical.number) || item.awardNumber);
    await write('funderIdentifier', item.funderIdentifier);

    // Nachkontrolle: Formular-JS kann Felder verzoegert zuruecksetzen
    await new Promise(r => setTimeout(r, 350));
    const recheck = {
        funderName: item.funderName,
        fundingStream: (canonical && canonical.stream) || item.fundingStream,
        awardTitle: (canonical && canonical.title) || item.awardTitle,
        awardNumber: (canonical && canonical.number) || item.awardNumber,
        funderIdentifier: item.funderIdentifier
    };
    for (const role of Object.keys(recheck)) {
        const el = target.fields[role];
        const value = recheck[role];
        if (!el || !value || results[role] === 'missing' || results[role] === 'empty') continue;
        if (el.value !== value && !(el.tagName === 'SELECT' && el.value === value)) {
            const status = await writeFundingField(el, value);
            results[role] = status === 'ok' ? 'repaired' : status;
        }
    }

    const written = Object.keys(results).filter(r => /^(ok|repaired)/.test(results[r]));
    const skipped = Object.keys(results).filter(r => results[r] === 'missing' || results[r] === 'no-option' || results[r] === 'rejected');

    console.log('DORA Helper: Funding eingetragen', item.awardNumber, results);

    return { written, skipped, results, vocabulary: vocabulary };
}
// Mögliche Basis-URLs des Autocomplete-Callbacks, in der Reihenfolge des
// Vertrauens: die URL aus dem Formular, danach die aus dem Seitenpfad
// abgeleitete. Beide werden probiert, falls die erste nichts liefert.
function fundingAutocompleteBaseUrls() {
    const urls = [];
    // Was schon einmal funktioniert hat, zuerst - spart die Fehlversuche
    if (fundingAutocompleteBaseWorking) urls.push(fundingAutocompleteBaseWorking);

    const helper = document.querySelector('input.autocomplete[id*="award-title-autocomplete"]');
    if (helper && helper.value) {
        const ausFormular = helper.value.replace(/\/\d+\/?$/, '/0');
        if (!urls.includes(ausFormular)) urls.push(ausFormular);
    }

    const derived = `${getDoraBaseUrl()}/islandora/funding/autocomplete/atitle/0`;
    if (!urls.includes(derived)) urls.push(derived);

    return urls;
}

// null  = Abfrage nicht moeglich/fehlgeschlagen
// found:false = Vokabular kennt die Nummer nicht
// Holt die Autocomplete-Antwort: zuerst direkt aus dem Seitenkontext (gleiche
// Origin und Session wie das Formular selbst), danach ueber den Hintergrund-
// dienst. Gibt null zurueck, wenn beide Wege scheitern.
async function fetchFundingAutocomplete(url) {
    try {
        const res = await fetch(url, { credentials: 'same-origin', cache: 'no-cache' });
        if (res.ok) {
            const text = await res.text();
            try {
                return JSON.parse(text);
            } catch (e) {
                console.warn('DORA Helper: Funding-Autocomplete lieferte kein JSON', url, text.slice(0, 120));
            }
        } else {
            console.warn('DORA Helper: Funding-Autocomplete HTTP ' + res.status, url);
        }
    } catch (e) {
        console.warn('DORA Helper: Funding-Autocomplete direkt fehlgeschlagen', e.message, url);
    }

    return new Promise(resolve => {
        const timeout = setTimeout(() => {
            console.warn('DORA Helper: Funding-Autocomplete Timeout (Hintergrunddienst)', url);
            resolve(null);
        }, 8000);
        chrome.runtime.sendMessage({ action: 'searchAutocomplete', url: url }, (response) => {
            clearTimeout(timeout);
            if (!response || !response.success) {
                console.warn('DORA Helper: Funding-Autocomplete über Hintergrunddienst fehlgeschlagen',
                    (response && response.error) || 'keine Antwort', url);
                return resolve(null);
            }
            resolve(response.data);
        });
    });
}

async function lookupDoraFundingEntry(item) {
    const number = String(item.awardNumber || '').trim();
    if (!number) return null;

    // 1. Zwischenspeicher: dieselbe Projektnummer taucht über viele Datensätze
    //    hinweg auf (NCCR, CMS-Publikationen ...). Das spart DORA die Anfrage.
    const speicherSchluessel = `${item.funderKey || '?'}::${number}`;
    const speicher = await vocabStoreLaden();
    const gemerkt = speicher[speicherSchluessel];
    if (gemerkt) {
        const gueltigkeit = (gemerkt.wert && gemerkt.wert.found) ? VOCAB_STORE_TTL : VOCAB_STORE_TTL_NEGATIV;
        if ((Date.now() - (gemerkt.zeit || 0)) < gueltigkeit) return gemerkt.wert;
    }

    // 2. Abfrage: Nummer zuerst; das Akronym nur, wenn die Liste leer blieb
    const terms = [number];
    if (item.acronym) terms.push(item.acronym);

    let keys = null;
    let url = '';
    let reachable = false;

    outer:
    for (const base of fundingAutocompleteBaseUrls()) {
        for (const term of terms) {
            url = `${base.replace(/\/$/, '')}/${encodeURIComponent(term)}`;
            const data = await fetchFundingAutocomplete(url);
            if (data === null || data === undefined || typeof data !== 'object') continue;

            reachable = true;
            const found = Array.isArray(data) ? data.map(String) : Object.keys(data);
            if (found.some(k => String(k).split('||')[0].trim() === number)) {
                keys = found;
                fundingAutocompleteBaseWorking = base;   // diese URL liefert
                break outer;
            }
            if (keys === null) keys = found;
            // Antwortete der Endpunkt mit Einträgen, ist die Nummer dort schlicht
            // nicht enthalten - dann bringt ein zweiter Suchbegriff nichts.
            if (found.length) break;
        }
    }

    // Diagnose fuer die Anzeige: was wurde abgefragt, was kam zurueck
    const debug = { url: url, count: keys ? keys.length : 0, sample: (keys || []).slice(0, 3).map(k => String(k).slice(0, 80)) };

    if (!reachable) return null;
    if (keys === null) keys = [];

    // Leere Antwort = Nummer ist im Vokabular nicht vorhanden
    if (keys.length === 0) {
        console.warn('DORA Helper: Funding-Autocomplete lieferte keine Treffer für ' + number, url);
        const ergebnis = { found: false, candidates: 0, debug: debug };
        vocabStoreSchreiben(speicherSchluessel, ergebnis);
        return ergebnis;
    }

    const parsed = keys.map(k => k.split('||')).filter(p => p.length >= 2);
    if (parsed.length === 0) {
        console.warn('DORA Helper: Funding-Autocomplete in unbekanntem Format', keys.slice(0, 3));
        return null;
    }

    const sameNumber = parsed.filter(p => p[0].trim() === number);
    if (!sameNumber.length) {
        console.warn(`DORA Helper: ${number} nicht in der Autocomplete-Antwort`, url,
            keys.slice(0, 3).map(k => k.slice(0, 60)));
        const ergebnis = { found: false, candidates: keys.length, debug: debug };
        vocabStoreSchreiben(speicherSchluessel, ergebnis);
        return ergebnis;
    }

    // Nummernkreise von SNSF und FP7 überlappen (SNSF 236711 vs. FP7-Projekt
    // 236711). Der Eintrag muss deshalb auch zum Foerderer passen.
    const expected = item.funderKey === 'SNSF' ? ['3'] : ['1', '2', '4'];
    const hit = sameNumber.find(p => expected.includes((p[2] || '').trim()));

    if (!hit) {
        const other = sameNumber[0];
        const otherStream = DORA_FUNDING_STREAM_BY_INDEX[(other[2] || '').trim()] || 'unbekanntes Programm';
        console.warn(`DORA Helper: ${number} steht in DORAs Liste als ${otherStream}, gesucht war ${item.funderName}`);
        return { found: false, wrongFunder: true, otherStream: otherStream, otherTitle: other[1].trim(), debug: debug };
    }

    const streamIndex = (hit[2] || '').trim();
    const ergebnis = {
        found: true,
        number: hit[0].trim(),
        title: hit[1].trim(),
        stream: DORA_FUNDING_STREAM_BY_INDEX[streamIndex] || null,
        streamIndex: streamIndex
    };
    vocabStoreSchreiben(speicherSchluessel, ergebnis);
    return ergebnis;
}

// Debug-Hilfe: Struktur des Funding-Bereichs in die Zwischenablage kopieren
function copyFundingStructure() {
    const container = findFundingContainer();
    if (!container) {
        const fieldsets = Array.from(document.querySelectorAll('fieldset legend, .form-item > label'))
            .map(l => (l.textContent || '').trim()).filter(Boolean).slice(0, 60);
        navigator.clipboard.writeText('KEIN FUNDING-CONTAINER GEFUNDEN\nVorhandene Beschriftungen:\n' + fieldsets.join('\n'));
        return false;
    }
    const skeleton = Array.from(container.querySelectorAll('input, select, textarea'))
        .map(el => `${el.tagName.toLowerCase()} name="${el.name || ''}" id="${el.id || ''}" type="${el.type || ''}" label="${fundingLabelText(el).trim()}"`)
        .join('\n');
    navigator.clipboard.writeText(`Container: ${container.id || container.className}\n${skeleton}`);
    return true;
}

// --- UI direkt am Funding-Feld des Formulars ---
// Das Panel haengt unter dem Funding-Fieldpanel, nicht in der Result-Box:
// dort steht es im Arbeitskontext und nimmt keinen Platz in der Box weg.
function injectFundingFormPanel() {
    const container = findFundingContainer();
    const doi = getCurrentDoiForFunding();

    // Diagnose: einmal pro Zustandswechsel melden, warum nichts erscheint
    const state = `${!!container}|${!!doi}`;
    if (fundingPanelLastState !== state) {
        fundingPanelLastState = state;
        if (!container) console.warn('DORA Helper: Funding-Panel - Funding-Bereich nicht gefunden (Selektoren: '
            + FUNDING_CONTAINER_SELECTORS.join(', ') + ')');
        else if (!doi) console.warn('DORA Helper: Funding-Panel - keine DOI im Formular gefunden.');
        else console.log('DORA Helper: Funding-Panel wird eingehängt an', container);
    }

    if (!container || !doi) return;

    // Ausserhalb des einklappbaren Fieldpanels einhaengen, damit das Panel
    // auch bei zugeklapptem Funding-Bereich sichtbar bleibt.
    const anchor = container.closest('.islandora-form-fieldpanel-container') || container;
    const parent = anchor.parentNode;
    if (!parent) return;

    let panel = document.getElementById('dora-funding-panel');

    // Drupal-AJAX ersetzt den Funding-Bereich - dann neu einhaengen
    if (panel && panel.dataset.doi === doi && document.body.contains(panel)) {
        if (panel.previousElementSibling !== anchor) {
            parent.insertBefore(panel, anchor.nextSibling);
        }
        return;
    }
    if (panel) panel.remove();

    panel = createEl('div');
    panel.id = 'dora-funding-panel';
    panel.dataset.doi = doi;
    panel.style.cssText = 'margin:4px 0 10px 0; padding:4px 8px; border:1px solid #dee2e6; '
        + 'border-left:3px solid #0073e6; border-radius:3px; background:#f8f9fa; font-size:12px; line-height:1.3;';

    const header = createEl('div');
    header.style.cssText = 'display:flex; align-items:center; gap:6px; cursor:pointer;';

    const caret = createEl('span', '', '▾');
    caret.style.color = '#6c757d';
    const title = createEl('span', '', '🔗 Projekte aus Crossref & OpenAIRE');
    title.style.cssText = 'font-weight:bold; color:#495057;';
    const summary = createEl('span', '', 'wird abgefragt …');
    summary.style.color = '#6c757d';

    header.appendChild(caret);
    header.appendChild(title);
    header.appendChild(summary);
    panel.appendChild(header);

    const body = createEl('div');
    body.style.cssText = 'margin-top:4px;';
    panel.appendChild(body);

    header.addEventListener('click', () => {
        const hidden = body.style.display === 'none';
        body.style.display = hidden ? '' : 'none';
        caret.textContent = hidden ? '▾' : '▸';
    });

    // Direkt unter den Funding-Bereich haengen
    parent.insertBefore(panel, anchor.nextSibling);

    const draw = (data) => {
        const items = data.items || [];
        const total = items.length;
        const existingKeys = new Set(readExistingFunding().filter(r => !r.isEmpty)
            .map(r => fundingKey(r.funderName, r.awardNumber)));
        const notRecordable = items.filter(i => !isFundingItemRecordable(i)).length;
        const missing = items.filter(i => !existingKeys.has(fundingKey(i.funderName, i.awardNumber))
            && isFundingItemRecordable(i));

        if (total === 0) summary.textContent = 'keine SNSF-/EU-Projekte gefunden';
        else if (missing.length === 0) summary.textContent = notRecordable
            ? `${total} Projekt(e) – ${notRecordable} nicht eintragbar`
            : `${total} Projekt(e), alle bereits erfasst`;
        else summary.textContent = `${missing.length} von ${total} fehlen`
            + (notRecordable ? ` · ${notRecordable} nicht eintragbar` : '');
        summary.style.color = missing.length ? '#d69e2e' : '#28a745';

        // Fehlende Projekte deutlich hervorheben
        panel.style.background = missing.length ? '#fffbea' : '#f8f9fa';
        panel.style.borderLeftColor = missing.length ? '#d69e2e' : '#0073e6';

        // Ohne fehlende Projekte eingeklappt starten
        if (missing.length === 0) {
            body.style.display = 'none';
            caret.textContent = '▸';
        }

        renderFundingSuggestions(body, data);
    };

    // Erst DORAs Auswahlliste prüfen, dann zeichnen - sonst stimmen Zähler,
    // Buttons und Sammelaktion für die ersten Sekunden nicht.
    const render = (data) => {
        const items = data.items || [];
        const pending = items.filter(i => i.doraEntry === undefined);
        if (pending.length === 0) return draw(data);

        summary.textContent = 'DORA-Auswahlliste wird geprüft …';
        summary.style.color = '#6c757d';

        // Nacheinander abfragen: gleichzeitige Requests auf dieselbe
        // Drupal-Session behindern sich gegenseitig.
        (async () => {
            for (const item of pending) {
                item.doraEntry = await lookupDoraFundingEntry(item);
            }
            draw(data);
        })();
    };
    fundingPanelRender = render;

    if (cachedFundingSuggestions && cachedFundingSuggestions.doi === doi) {
        render(cachedFundingSuggestions.data);
        return;
    }

    body.textContent = 'Crossref & OpenAIRE werden abgefragt …';
    body.style.color = '#6c757d';

    chrome.runtime.sendMessage({ action: 'fetchFunding', doi: doi }, (response) => {
        body.style.color = '';
        if (!response || !response.success) {
            summary.textContent = 'Abfrage fehlgeschlagen';
            summary.style.color = '#e53e3e';
            body.textContent = (response && response.error) || 'keine Antwort vom Hintergrunddienst';
            return;
        }
        cachedFundingSuggestions = { doi: doi, data: response.data };
        render(response.data);
    });
}

// Werte, die tatsaechlich ins Formular geschrieben werden - und zugleich der
// Nachweis, dass DORA das Projekt kennt. Zwei gleichwertige Belege:
//   1. Treffer in der Funding-Auswahlliste (Autocomplete des Titelfelds)
//   2. Die Nummer ist im DORA-Bestand bereits mit diesem Foerderer in Gebrauch
// Ohne einen der beiden Belege wird nichts angeboten und nichts geschrieben.
function fundingCanonicalValues(item) {
    const entry = item.doraEntry;
    if (entry && entry.found) {
        return {
            source: 'vocabulary',
            number: entry.number,
            title: entry.title,
            stream: entry.stream || item.fundingStream
        };
    }
    if (item.doraOccurrences > 0 && item.awardTitle && item.fundingStream) {
        // Aus dem Produktivindex uebernommen (Hauskonvention der bestehenden Datensaetze)
        return {
            source: 'index',
            number: item.awardNumber,
            title: item.awardTitle,
            stream: item.fundingStream,
            occurrences: item.doraOccurrences
        };
    }
    return null;
}

// Zeigt auf Wunsch, was tatsaechlich abgefragt wurde und was zurueckkam -
// damit sich ein unerwartetes "nicht gefunden" ohne Konsole klaeren laesst.
function appendLookupDetails(container, debug) {
    const toggle = createEl('a', '', ' Details');
    toggle.href = '#';
    toggle.style.cssText = 'color:#0073e6; margin-left:4px;';

    const box = createEl('div');
    box.style.cssText = 'display:none; margin-top:3px; padding:4px 6px; background:#fff; '
        + 'border:1px solid #dee2e6; border-radius:3px; font-family:monospace; font-size:11px; '
        + 'white-space:pre-wrap; word-break:break-all; color:#495057;';
    const zeilen = ['Abfrage: ' + debug.url, 'Treffer in der Antwort: ' + debug.count];
    if (debug.sample && debug.sample.length) zeilen.push(...debug.sample);
    box.textContent = zeilen.join('\n');

    toggle.addEventListener('click', (e) => {
        e.preventDefault();
        const hidden = box.style.display === 'none';
        box.style.display = hidden ? 'block' : 'none';
        toggle.textContent = hidden ? ' Details ausblenden' : ' Details';
    });

    container.appendChild(toggle);
    container.appendChild(box);
}

function isFundingItemRecordable(item) {
    return !!fundingCanonicalValues(item);
}

function renderFundingSuggestions(body, data) {
    body.replaceChildren();
    body.style.color = '';

    const existing = readExistingFunding().filter(r => !r.isEmpty);
    const existingKeys = new Set(existing.map(r => fundingKey(r.funderName, r.awardNumber)));
    const containerFound = !!findFundingContainer();

    const items = data.items || [];
    const missing = items.filter(i => !existingKeys.has(fundingKey(i.funderName, i.awardNumber)) && isFundingItemRecordable(i));

    if (items.length === 0) {
        const none = createEl('div', '', existing.length
            ? `Keine Projekte in Crossref/OpenAIRE gefunden (${existing.length} im Datensatz).`
            : 'Keine verknüpften SNSF-/EU-Projekte in Crossref oder OpenAIRE gefunden.');
        none.style.color = '#6c757d';
        body.appendChild(none);
    }

    const rowsWrap = createEl('div');
    rowsWrap.style.cssText = 'display:flex; flex-direction:column; gap:3px;';

    items.forEach(item => {
        const isPresent = existingKeys.has(fundingKey(item.funderName, item.awardNumber));
        const entry = item.doraEntry;                 // undefined = noch nicht geprüft
        const canonical = fundingCanonicalValues(item);
        const recordable = !!canonical;
        const notInVocabulary = !recordable && !!(entry && entry.found === false);
        const checkFailed = !recordable && entry === null;

        const row = createEl('div');
        row.style.cssText = 'display:flex; align-items:flex-start; gap:4px; line-height:1.25;';

        const icon = createEl('span', '', isPresent ? '✅' : (recordable ? (item.confidence === 'high' ? '➕' : '❓') : '🚫'));
        row.appendChild(icon);

        const textWrap = createEl('div');
        textWrap.style.flex = '1';

        const stream = (canonical && canonical.stream) || item.fundingStream || (item.funderKey === 'SNSF' ? 'SNSF' : 'EC');
        const head = createEl('div', '', `${stream} ${item.awardNumber}`);
        head.style.fontWeight = 'bold';
        head.style.color = (isPresent || notInVocabulary) ? '#6c757d' : '#212529';
        textWrap.appendChild(head);

        const titleText = (canonical && canonical.title) || item.awardTitle;
        const titleLine = createEl('div', '', titleText || '(kein Projekttitel ermittelbar)');
        titleLine.style.color = notInVocabulary ? '#6c757d' : '#495057';
        if (!titleText) titleLine.style.color = '#d69e2e';
        textWrap.appendChild(titleLine);

        const meta = createEl('div', '', '');
        meta.style.cssText = 'color:#6c757d; font-size:0.95em;';
        const parts = [item.sources.join(' + ')];
        if (item.textMined) parts.push('nur Text-Mining');
        if (item.rawAwardNumbers && item.rawAwardNumbers.some(r => r !== item.awardNumber)) {
            parts.push('Crossref: ' + item.rawAwardNumbers.join(', '));
        }
        if (item.promotedFrom) parts.push(`Crossref nennt: „${item.promotedFrom}"`);
        if (item.doraOccurrences) parts.push(`${item.doraOccurrences}× in DORA`);
        meta.textContent = parts.join(' · ');
        textWrap.appendChild(meta);

        // Status gegenüber DORAs Funding-Auswahlliste
        const vocabLine = createEl('div', '');
        vocabLine.style.cssText = 'font-size:0.95em;';
        if (canonical && canonical.source === 'vocabulary') {
            vocabLine.textContent = '✓ In DORAs Funding-Auswahlliste';
            vocabLine.style.color = '#28a745';
        } else if (canonical) {
            // Beleg aus dem Produktivindex statt aus der Auswahlliste
            vocabLine.textContent = `✓ In DORA bereits verwendet (${canonical.occurrences} Datensätze)`
                + (entry && entry.found === false ? ' – nicht in der Auswahlliste, Werte aus dem Bestand' : '');
            vocabLine.style.color = '#28a745';
        } else if (notInVocabulary) {
            vocabLine.textContent = (entry && entry.wrongFunder)
                ? `🚫 In DORAs Auswahlliste gehört ${item.awardNumber} zu einem Projekt von ${entry.otherStream} – nicht eintragbar`
                : '🚫 Nicht in DORAs Funding-Auswahlliste – kann nicht eingetragen werden';
            vocabLine.style.color = '#6c757d';
            if (entry && entry.wrongFunder) vocabLine.title = entry.otherTitle;
            if (entry && entry.debug) appendLookupDetails(vocabLine, entry.debug);
        } else if (checkFailed) {
            vocabLine.style.color = '#d69e2e';
            vocabLine.appendChild(document.createTextNode('🚫 Abgleich mit DORAs Auswahlliste fehlgeschlagen – kein Eintrag möglich. '));
            const retry = createEl('a', '', 'erneut prüfen');
            retry.href = '#';
            retry.style.color = '#0073e6';
            retry.addEventListener('click', async (e) => {
                e.preventDefault();
                retry.textContent = 'prüfe …';
                item.doraEntry = await lookupDoraFundingEntry(item);
                const cached = cachedFundingSuggestions && cachedFundingSuggestions.data;
                if (fundingPanelRender && cached) fundingPanelRender(cached);
                else renderFundingSuggestions(body, { items: items, unsupported: data.unsupported, errors: data.errors });
            });
            vocabLine.appendChild(retry);
        }
        if (vocabLine.textContent) textWrap.appendChild(vocabLine);

        if (item.projectUrl) {
            const link = createEl('a', '', 'OpenAIRE ↗');
            link.href = item.projectUrl;
            link.target = '_blank';
            link.style.cssText = 'color:#0073e6; font-size:0.95em;';
            textWrap.appendChild(link);
        }

        row.appendChild(textWrap);

        if (!isPresent && recordable && containerFound) {
            const btn = createEl('button', 'dora-box-btn btn-secondary', 'Eintragen');
            btn.style.cssText = 'width:auto; padding:2px 6px; font-size:11px; flex:0 0 auto;';
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                btn.textContent = '…';
                try {
                    const res = await applyFundingItem(item);

                    if (res.blocked) {
                        btn.remove();
                        icon.textContent = '🚫';
                        vocabLine.textContent = res.blocked === 'not-in-vocabulary'
                            ? '🚫 Nicht in DORAs Funding-Auswahlliste – kann nicht eingetragen werden'
                            : '🚫 Abgleich mit DORAs Auswahlliste fehlgeschlagen – kein Eintrag möglich';
                        vocabLine.style.color = '#d69e2e';
                        return;
                    }

                    btn.textContent = '✔';
                    icon.textContent = '✅';
                    head.style.color = '#6c757d';

                    // Felder, die das Formular verworfen oder nicht angeboten hat
                    const problems = Object.keys(res.results || {})
                        .filter(r => ['rejected', 'missing', 'no-option'].includes(res.results[r]));
                    if (problems.length) {
                        const warn = createEl('div', '', 'Vom Formular nicht übernommen: '
                            + problems.map(r => `${r} (${res.results[r]})`).join(', '));
                        warn.style.cssText = 'color:#d69e2e;';
                        textWrap.appendChild(warn);
                    }
                    if (!res.vocabulary) {
                        const warn = createEl('div', '', '⚠️ DORA-Auswahlliste nicht erreichbar – Titel aus OpenAIRE/Crossref eingetragen.');
                        warn.style.cssText = 'color:#d69e2e;';
                        textWrap.appendChild(warn);
                    }
                } catch (e) {
                    btn.disabled = false;
                    btn.textContent = 'Eintragen';
                    alert('Eintragen fehlgeschlagen: ' + e.message);
                }
            });
            row.appendChild(btn);
        }

        rowsWrap.appendChild(row);
    });

    body.appendChild(rowsWrap);

    // Sammel-Button nur fuer sichere, eintragbare Treffer
    const bulk = missing.filter(i => i.confidence === 'high' && i.complete);
    if (bulk.length > 1 && containerFound) {
        const allBtn = createEl('button', 'dora-box-btn btn-secondary', `Alle ${bulk.length} fehlenden eintragen`);
        allBtn.style.cssText = 'margin-top:4px; font-size:11px; padding:3px 6px;';
        allBtn.addEventListener('click', async () => {
            allBtn.disabled = true;
            allBtn.textContent = 'Wird eingetragen …';
            let ok = 0;
            for (const item of bulk) {
                try {
                    const res = await applyFundingItem(item);
                    if (!res.blocked) ok++;
                } catch (e) { console.warn('Funding-Eintrag fehlgeschlagen', e); }
            }
            allBtn.textContent = `${ok}/${bulk.length} eingetragen`;
            const cached = cachedFundingSuggestions && cachedFundingSuggestions.data;
            if (cached) {
                if (fundingPanelRender) fundingPanelRender(cached);
                else renderFundingSuggestions(body, cached);
            }
        });
        body.appendChild(allBtn);
    }

    if (!containerFound && missing.length) {
        const hint = createEl('div', '', '⚠️ Funding-Felder im Formular nicht erkannt – Eintragen nicht möglich.');
        hint.style.cssText = 'color:#d69e2e; margin-top:4px;';
        const dbg = createEl('button', 'dora-box-btn btn-secondary', 'Formularstruktur kopieren');
        dbg.style.cssText = 'margin-top:3px; font-size:11px; padding:2px 6px;';
        dbg.addEventListener('click', () => {
            dbg.textContent = copyFundingStructure() ? 'In Zwischenablage ✔' : 'Nichts gefunden – Labels kopiert';
        });
        body.appendChild(hint);
        body.appendChild(dbg);
    }

    if (data.unsupported && data.unsupported.length) {
        const note = createEl('div', '', 'Weitere Förderer (in DORA nicht erfasst): '
            + data.unsupported.map(u => u.name + (u.awards.length ? ` [${u.awards.join(', ')}]` : '')).join('; '));
        note.style.cssText = 'color:#6c757d; margin-top:4px; font-size:0.95em;';
        body.appendChild(note);
    }

    if (data.errors && data.errors.length) {
        const err = createEl('div', '', data.errors.join(' | '));
        err.style.cssText = 'color:#d69e2e; margin-top:3px;';
        body.appendChild(err);
    }
}


// =====================================================================
// SUPPLEMENTS: DATENPUBLIKATIONEN UND SUPPORTING INFORMATION
// ---------------------------------------------------------------------
// Zwei Quellen: die Metadaten (OpenAIRE/Crossref, via Hintergrunddienst)
// und die Verlagsseite, die im Browser des Nutzers mit dessen Sitzung
// gelesen wird - dort liegt die eigentliche Supporting Information.
// =====================================================================


function formatFileSize(bytes) {
    if (!bytes) return '';
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1).replace('.', ',') + ' MB';
}

// Supplement-Links aus dem HTML der Verlagsseite lesen
function extractSupplementsFromHtml(html, baseUrl) {
    const gefunden = [];
    const gesehen = new Set();

    let doc;
    try {
        doc = new DOMParser().parseFromString(html, 'text/html');
    } catch (e) {
        return gefunden;
    }

    doc.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href') || '';
        const text = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;

        const trefferHref = SUPPLEMENT_TEXT_RE.test(href);
        const trefferText = SUPPLEMENT_TEXT_RE.test(text);
        const istRepo = SUPPLEMENT_REPO_RE.test(href);
        if ((!trefferHref && !trefferText && !istRepo) || SUPPLEMENT_SKIP_RE.test(href + ' ' + text)) return;

        // Supplements kommen auch ohne Dateiendung, etwa ACS mit
        // ".../article-supplement/3756100/pdf/nn5c08710_si_001/".
        const istDatei = SUPPLEMENT_EXT_RE.test(href) || SUPPLEMENT_EXT_RE.test(text)
            || /\/(pdf|download|file)s?\//i.test(href);

        let absolut;
        try {
            absolut = new URL(href, baseUrl).href;
        } catch (e) {
            return;
        }
        if (gesehen.has(absolut)) return;
        gesehen.add(absolut);

        // Endet der Pfad auf einen Schrägstrich, steckt der Name im letzten Segment
        const segmente = absolut.split('?')[0].split('/').filter(Boolean);
        const dateiname = decodeURIComponent(segmente[segmente.length - 1] || '');

        gefunden.push({
            source: 'Verlag',
            type: istRepo ? 'dataset' : 'file',
            title: (text && text.length > 2) ? text : (dateiname || 'Supplement'),
            url: absolut,
            fileName: istDatei ? dateiname : '',
            isFile: istDatei,
            istRepo: istRepo
        });
    });

    // Dateien zuerst
    gefunden.sort((a, b) => (b.isFile ? 1 : 0) - (a.isFile ? 1 : 0));

    // Verlage nennen dasselbe Supplement oft zweimal: als Datei und als
    // blossen DOI-Link (Beschriftung = die URL selbst). Dann genügt die Datei.
    const hatDatei = gefunden.some(g => g.isFile);
    const gefiltert = gefunden.filter(g =>
        g.isFile || !(hatDatei && /doi\.org/.test(g.url) && g.title.replace(/\s/g, '') === g.url));

    return gefiltert.slice(0, 12);
}

// Metadaten und Verlagsseite zusammenführen (pro DOI nur einmal)
function loadSupplements(doi, callback, erneutPruefen) {
    if (!doi) { callback({ items: [], geprueft: true }); return; }

    if (erneutPruefen) {
        supplementCacheEntfernen(doi);
        pruefeSupplements(doi, callback);
        return;
    }

    supplementCacheLesen(doi, (gespeichert) => {
        if (gespeichert) callback(gespeichert);
        else pruefeSupplements(doi, callback);
    });
}

function pruefeSupplements(doi, callback) {
    const ergebnis = { items: [], geprueft: false, quellen: { meta: false, verlag: 'offen' } };
    let offen = 2;

    const fertig = () => {
        if (--offen > 0) return;
        ergebnis.geprueft = true;
        supplementCacheSchreiben(doi, ergebnis);
        callback(ergebnis);
    };

    // 1. Datenpublikationen aus den Metadaten
    chrome.runtime.sendMessage({ action: 'fetchSupplements', doi: doi }, (response) => {
        if (response && response.success && response.data) {
            ergebnis.quellen.meta = true;
            (response.data.items || []).forEach(i => ergebnis.items.push(i));
        }
        fertig();
    });

    // 2. Supporting Information von der Verlagsseite
    chrome.runtime.sendMessage({ action: 'fetchHtml', url: `https://doi.org/${doi}` }, (response) => {
        const html = (response && response.data) || '';
        const gesperrt = !!response && response.success
            && (response.ok === false || SUPPLEMENT_BLOCK_RE.test(html.slice(0, 4000)));

        if (!response || !response.success) {
            ergebnis.quellen.verlag = 'fehler';
            console.warn('DORA Helper: Verlagsseite nicht abrufbar', (response && response.error) || 'keine Antwort');
        } else if (gesperrt) {
            ergebnis.quellen.verlag = 'gesperrt';
            console.warn(`DORA Helper: Verlagsseite blockiert den Abruf (HTTP ${response.status || '?'}) – Supporting Information kann nicht gelesen werden.`);
        } else {
            ergebnis.quellen.verlag = 'ok';
        }

        if (response && response.success && html && !gesperrt) {
            const basis = response.finalUrl || `https://doi.org/${doi}`;
            const gefunden = extractSupplementsFromHtml(response.data, basis)
                .filter(i => !ergebnis.items.some(x => x.url === i.url));
            gefunden.forEach(i => ergebnis.items.push(i));

            // Verlinkte Repositorien (figshare, Zenodo …) in Dateilisten auflösen
            const repoLinks = gefunden.filter(i => i.istRepo).slice(0, 4);
            if (!repoLinks.length) { fertig(); return; }

            let offeneRepos = repoLinks.length;
            repoLinks.forEach(item => {
                chrome.runtime.sendMessage({ action: 'resolveRepository', url: item.url }, (antwort) => {
                    if (antwort && antwort.success && antwort.data) {
                        if (antwort.data.repository) item.repository = antwort.data.repository;
                        if (antwort.data.title && item.title.length < 4) item.title = antwort.data.title;
                        if (antwort.data.license) item.license = antwort.data.license;
                        if ((antwort.data.files || []).length) item.files = antwort.data.files;
                    }
                    if (--offeneRepos === 0) fertig();
                });
            });
            return;
        }
        fertig();
    });
}

// --- Kompakte Schaltfläche mit ausklappbarer Liste ---
function createSupplementButton(doi, optionen) {
    const opt = optionen || {};
    const wrap = createEl('div');
    wrap.className = 'dora-supplement-wrap dora-aktion-zeile';
    wrap.style.position = 'relative';

    const btn = createEl('button', 'dora-box-btn btn-secondary');
    btn.type = 'button';
    btn.appendChild(createEl('span', '', '📎'));
    knopfBeschriftung(btn, 'Supplement …');
    btn.disabled = true;
    btn.title = 'Sucht Supporting Information und verknüpfte Datenpublikationen';
    wrap.appendChild(btn);

    const liste = createEl('div');
    liste.style.cssText = 'display:none; margin-top:4px; padding:6px 8px; background:#ffffff; '
        + 'border:1px solid #cbd5e0; border-radius:4px; box-shadow:0 4px 12px rgba(0,0,0,.12); '
        + 'font-size:12px; max-width:420px; max-height:260px; overflow:auto;';
    if (opt.floating) {
        liste.style.position = 'absolute';
        liste.style.zIndex = '10001';
        liste.style.right = '0';
        liste.style.minWidth = '320px';
    }
    wrap.appendChild(liste);

    btn.addEventListener('click', () => {
        if (btn.dataset.zustand === 'leer') { erneutPruefen(); return; }
        if (btn.dataset.zustand !== 'treffer') return;
        const zu = liste.style.display === 'none';
        liste.style.display = zu ? 'block' : 'none';
    });

    // Die Aussage lautet immer "Kein Supplement gefunden" - gefunden wurde
    // nämlich keines, aber ausgeschlossen ist damit nichts. Blieb die Prüfung
    // unvollständig (Verlagsseite gesperrt, Quelle stumm), sagt das ⚠ das
    // ausdrücklich. Beides ist im Formular und in der PDF-Verwaltung gleich.
    const zeigeErgebnis = (ergebnis) => {
        const items = (ergebnis && ergebnis.items) || [];
        const verlag = (ergebnis && ergebnis.quellen && ergebnis.quellen.verlag) || 'offen';
        const metaOk = !!(ergebnis && ergebnis.quellen && ergebnis.quellen.meta);

        btn.style.opacity = '';
        btn.style.borderColor = '';
        btn.style.color = '';

        if (!items.length) {
            btn.dataset.zustand = 'leer';
            btn.disabled = false;

            let grund = '';
            if (verlag === 'gesperrt') {
                grund = 'Crossref, OpenAIRE und figshare führen keines — und die Verlagsseite hat den Abruf blockiert. '
                    + 'Ob es Supporting Information gibt, ist damit offen: bitte auf der Artikelseite selbst nachsehen.';
            } else if (verlag === 'fehler') {
                grund = 'Crossref, OpenAIRE und figshare führen keines, und die Verlagsseite war nicht erreichbar. '
                    + 'Ob es Supporting Information gibt, ist damit offen.';
            } else if (!metaOk) {
                grund = 'Die Metadatenquellen haben nicht geantwortet; nur die Verlagsseite konnte geprüft werden.';
            }

            if (grund) {
                knopfBeschriftung(btn, 'Kein Supplement gefunden ⚠');
                btn.style.borderColor = '#d69e2e';
                btn.style.color = '#8a5a10';
                btn.title = 'Prüfung unvollständig. ' + grund + '\nKlicken für eine erneute Prüfung.';
            } else {
                knopfBeschriftung(btn, 'Kein Supplement gefunden');
                btn.style.opacity = '.6';
                btn.title = 'Geprüft: Crossref, OpenAIRE, figshare und die Verlagsseite verzeichnen keines. '
                    + 'Ein Blick auf die Artikelseite kann sich trotzdem lohnen.\nKlicken für eine erneute Prüfung.';
            }
            return;
        }

        btn.dataset.zustand = 'treffer';
        btn.disabled = false;
        knopfBeschriftung(btn, `${items.length} Supplement${items.length > 1 ? 's' : ''}`);
        btn.title = 'Anzeigen und herunterladen';
        btn.style.borderColor = '#2b6cb0';
        btn.style.color = '#2b6cb0';

        renderSupplementList(liste, items, verlag);
    };

    const erneutPruefen = () => {
        btn.dataset.zustand = 'laeuft';
        btn.disabled = true;
        knopfBeschriftung(btn, 'prüft erneut …');
        btn.title = 'Die Quellen werden noch einmal abgefragt';
        loadSupplements(doi, zeigeErgebnis, true);
    };

    loadSupplements(doi, zeigeErgebnis);

    return wrap;
}

function renderSupplementList(container, items, verlagStatus) {
    container.replaceChildren();

    if (verlagStatus === 'gesperrt' || verlagStatus === 'fehler') {
        const hinweis = createEl('div', '', verlagStatus === 'gesperrt'
            ? '⚠️ Die Verlagsseite hat den Abruf blockiert — dort kann weitere Supporting Information liegen.'
            : '⚠️ Die Verlagsseite war nicht erreichbar — dort kann weitere Supporting Information liegen.');
        hinweis.style.cssText = 'margin-bottom:5px; padding:4px 6px; background:#fdf3e3; color:#8a5a10; '
            + 'border-radius:3px; font-size:11px;';
        container.appendChild(hinweis);
    }

    items.forEach((item, index) => {
        const block = createEl('div');
        block.style.cssText = 'padding:5px 0;' + (index ? ' border-top:1px solid #edf2f7;' : '');

        const kopf = createEl('div');
        kopf.style.cssText = 'display:flex; gap:6px; align-items:baseline;';

        const herkunft = createEl('span', '', item.source === 'Verlag' ? 'Verlag' : (item.repository || item.source));
        herkunft.style.cssText = 'font-size:10px; text-transform:uppercase; letter-spacing:.04em; '
            + 'color:#4a5568; background:#edf2f7; border-radius:3px; padding:1px 5px; white-space:nowrap;';
        kopf.appendChild(herkunft);

        // Repositorien liefern Titel teils mit Zeilenumbruechen
        const beschriftung = String(item.title || item.fileName || item.url).replace(/\s+/g, ' ').trim();
        const link = createEl('a', '', beschriftung);
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener';
        link.style.cssText = 'color:#2b6cb0; text-decoration:none; word-break:break-word;';
        kopf.appendChild(link);
        block.appendChild(kopf);

        if (item.doi || item.license) {
            const zeile = createEl('div');
            zeile.style.cssText = 'display:flex; gap:6px; align-items:baseline; margin-left:2px;';

            if (item.doi) {
                const doiText = createEl('span', '', item.doi);
                doiText.style.cssText = 'font-family:monospace; font-size:10.5px; color:#718096;';
                zeile.appendChild(doiText);
            }

            if (item.license && item.license.name) {
                const lizenz = item.license.url ? createEl('a', '', item.license.name) : createEl('span', '', item.license.name);
                if (item.license.url) {
                    lizenz.href = item.license.url;
                    lizenz.target = '_blank';
                    lizenz.rel = 'noopener';
                }
                lizenz.title = 'Lizenz der Datenpublikation';
                lizenz.style.cssText = 'font-size:10px; padding:1px 5px; border-radius:3px; white-space:nowrap; '
                    + 'text-decoration:none; background:#e6fffa; color:#234e52; border:1px solid #b2f5ea;';
                zeile.appendChild(lizenz);
            }

            block.appendChild(zeile);
        }

        // Einzeldateien eines Repositoriums mit direktem Download
        (item.files || []).slice(0, 8).forEach(f => {
            const zeile = createEl('div');
            zeile.style.cssText = 'margin:2px 0 0 10px; display:flex; gap:5px; align-items:baseline;';
            const dl = createEl('a', '', '⬇ ' + f.name);
            dl.href = f.url;
            dl.target = '_blank';
            dl.rel = 'noopener';
            dl.setAttribute('download', f.name);
            dl.style.cssText = 'color:#2b6cb0; text-decoration:none; word-break:break-all;';
            zeile.appendChild(dl);
            if (f.size) {
                const groesse = createEl('span', '', formatFileSize(f.size));
                groesse.style.cssText = 'color:#a0aec0; font-size:10.5px; white-space:nowrap;';
                zeile.appendChild(groesse);
            }
            block.appendChild(zeile);
        });

        if ((item.files || []).length > 8) {
            const rest = createEl('div', '', `… und ${item.files.length - 8} weitere Dateien`);
            rest.style.cssText = 'margin-left:10px; color:#a0aec0; font-size:10.5px;';
            block.appendChild(rest);
        }

        container.appendChild(block);
    });
}

// Schaltfläche neben den PDF-Upload-Feldern
function injectSupplementButtonsIntoUploadForm(doi) {
    if (!doi) return;
    const selects = document.querySelectorAll('select[id*="-document-version"]');
    if (!selects.length) return;

    const ersteZeile = selects[0].closest('tr, .islandora-form-fieldpanel-pane, .form-item') || selects[0].parentNode;
    // Die Schaltfläche sitzt als Geschwister hinter der Zeile, deshalb wird die
    // Zeile selbst markiert - sonst käme bei jedem Scan eine weitere dazu.
    if (!ersteZeile || ersteZeile.dataset.doraSupplement) return;
    ersteZeile.dataset.doraSupplement = '1';

    const halter = createEl('div');
    halter.style.cssText = 'margin:6px 0; display:flex; align-items:center; gap:6px;';
    const hinweis = createEl('span', '', 'Zum Artikel:');
    hinweis.style.cssText = 'font-size:11px; color:#718096;';
    halter.appendChild(hinweis);
    halter.appendChild(createSupplementButton(doi, { fontSize: '11px' }));

    ersteZeile.parentNode.insertBefore(halter, ersteZeile.nextSibling);
}
