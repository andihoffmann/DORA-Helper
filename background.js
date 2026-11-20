// background.js

let activeDoraTabId = null;
let pdfReferrerMap = new Map(); // Speichert Referrer zu PDF-URLs
let pdfTabMap = new Map(); // Speichert Tab-IDs zu PDF-URLs (wichtig für Blobs)

// PDF-Auswertung: Claude Haiku direkt ueber die Anthropic-API. Schluessel und
// Modell stehen in den Einstellungen (chrome.storage.local).
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const HAIKU_MODEL_STANDARD = "claude-haiku-5-5";
// Die API nimmt hoechstens 32 MB je Anfrage; base64 blaeht um ein Drittel auf.
const HAIKU_PDF_BYTES_MAX = 22 * 1024 * 1024;

// Ein einziges Vorschaufenster fuer die Batch-QC: beim Blaettern durch die
// Trefferliste soll das bestehende Fenster dem Datensatz folgen statt sich zu
// vervielfachen. onlyIfOpen = nur aktualisieren, nie neu oeffnen.
let popupWindowId = null;

// ---------------------------------------------------------------------------
// PDF-Suche ueber Datenbanken statt ueber Verlagsseiten.
//
// Das Auslesen der Verlagsseite scheitert regelmaessig an Cloudflare & Co.
// Mehrere Nachweisdienste fuehren dagegen direkte Volltext-Links, und ein
// kurzer Bereichsabruf zeigt zuverlaessig, ob dahinter wirklich ein PDF
// liegt oder nur eine Sperrseite (gemessen: europepmc.org/...?pdf=render
// liefert PDF, pmc.ncbi.nlm.nih.gov und link.springer.com HTML).
// ---------------------------------------------------------------------------
const PDF_KONTAKT = 'dora@lib4ri.ch';
const PDF_LINK_CACHE_KEY = 'doraPdfLinkCache';
const PDF_LINK_TTL = 12 * 60 * 60 * 1000;
const PDF_LINK_TTL_MAGER = 20 * 60 * 1000; // ohne geprueften Treffer
const PDF_LINK_MAX = 200;
const PDF_PRUEF_LIMIT = 10; // so viele Kandidaten werden tatsaechlich angetestet

// Crossref sagt "vor"/"am", Unpaywall "publishedVersion"/"acceptedVersion" -
// in der Liste soll einheitlich dasselbe stehen.
function normalisiereVersion(wert) {
    const v = (wert || '').toString().trim().toLowerCase();
    if (!v) return '';
    if (v === 'vor' || v === 'publishedversion') return 'publishedVersion';
    if (v === 'am' || v === 'acceptedversion') return 'acceptedVersion';
    if (v === 'submittedversion' || v === 'preprint') return 'submittedVersion';
    return wert;
}

function pdfHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return ''; }
}

async function holeJson(url, timeoutMs) {
    const abbruch = new AbortController();
    const uhr = setTimeout(() => abbruch.abort(), timeoutMs || 9000);
    try {
        const antwort = await fetch(url, { signal: abbruch.signal, headers: { 'Accept': 'application/json' } });
        if (!antwort.ok) return null;
        return await antwort.json();
    } catch (e) {
        return null;
    } finally {
        clearTimeout(uhr);
    }
}

// Kandidaten je Quelle. Jede Quelle darf ausfallen, ohne die anderen zu stoeren.
async function pdfKandidatenUnpaywall(doi, sammeln, merkeSeite) {
    const daten = await holeJson(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}?email=${PDF_KONTAKT}`);
    if (!daten) return;
    (daten.oa_locations || []).forEach(ort => {
        if (merkeSeite && ort.url) merkeSeite(ort.url);
        const url = ort.url_for_pdf || (/\.pdf($|\?)/i.test(ort.url || '') ? ort.url : '');
        if (url) sammeln(url, 'Unpaywall', { host: ort.host_type, version: ort.version, license: ort.license });
    });
}

async function pdfKandidatenCrossref(doi, sammeln, merkeSeite) {
    const daten = await holeJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${PDF_KONTAKT}`);
    const werk = daten && daten.message;
    if (!werk) return '';

    // Die kanonische Artikelseite verraet den richtigen Verlags-Host
    // (bei Wiley z.B. advanced.onlinelibrary.wiley.com).
    if (merkeSeite) {
        if (werk.resource && werk.resource.primary && werk.resource.primary.URL) merkeSeite(werk.resource.primary.URL);
        (werk.link || []).forEach(e => { if (e.URL) merkeSeite(e.URL); });
    }

    // link[] enthaelt die vom Verlag gemeldeten Volltext-Links
    (werk.link || []).forEach(eintrag => {
        if ((eintrag['content-type'] || '').toLowerCase().includes('pdf') && eintrag.URL) {
            sammeln(eintrag.URL, 'Crossref', { host: 'publisher', version: eintrag['content-version'] });
        }
    });

    // arXiv-Ableger tauchen als alternative-id oder in der Relation auf
    const arxiv = pdfArxivId(JSON.stringify(werk.relation || {}) + ' ' + (werk['alternative-id'] || []).join(' '));
    if (arxiv) sammeln(`https://arxiv.org/pdf/${arxiv}`, 'arXiv', { host: 'repository', version: 'submittedVersion' });

    return { verlag: werk.publisher || '', titel: (werk.title || [])[0] || '' };
}

function pdfArxivId(text) {
    const treffer = /(?:arxiv[.:\/]|abs\/)\s*((?:\d{4}\.\d{4,5})(?:v\d+)?|[a-z\-]+\/\d{7}(?:v\d+)?)/i.exec(text || '');
    return treffer ? treffer[1] : '';
}

async function pdfKandidatenOpenAlex(doi, sammeln, merkeSeite) {
    const daten = await holeJson(`https://api.openalex.org/works/doi:${encodeURIComponent(doi)}?mailto=${PDF_KONTAKT}`);
    if (!daten) return;

    const orte = (daten.locations || []).slice();
    if (daten.best_oa_location) orte.unshift(daten.best_oa_location);
    orte.forEach(ort => {
        if (ort && merkeSeite && ort.landing_page_url) merkeSeite(ort.landing_page_url);
        if (!ort || !ort.pdf_url) return;
        sammeln(ort.pdf_url, 'OpenAlex', {
            host: ort.is_published || (ort.source && ort.source.type === 'journal') ? 'publisher' : 'repository',
            version: ort.version, license: ort.license,
            quellenName: ort.source && ort.source.display_name
        });
    });
    if (daten.open_access && daten.open_access.oa_url && /\.pdf($|\?)/i.test(daten.open_access.oa_url)) {
        sammeln(daten.open_access.oa_url, 'OpenAlex', { host: 'unbekannt' });
    }
    // arXiv steckt mal in den ids, mal nur in der Landing-Page eines Standorts
    let arxiv = pdfArxivId((daten.ids && daten.ids.arxiv) || '');
    if (!arxiv) {
        orte.forEach(ort => {
            if (arxiv || !ort) return;
            const kandidat = pdfArxivId(ort.landing_page_url || '');
            if (kandidat) arxiv = kandidat;
        });
    }
    if (arxiv) sammeln(`https://arxiv.org/pdf/${arxiv}`, 'arXiv', { host: 'repository', version: 'submittedVersion' });
}

async function pdfKandidatenEuropePmc(doi, sammeln) {
    const daten = await holeJson('https://www.ebi.ac.uk/europepmc/webservices/rest/search'
        + `?query=DOI:%22${encodeURIComponent(doi)}%22&resultType=core&format=json`);
    const treffer = daten && daten.resultList && (daten.resultList.result || [])[0];
    if (!treffer) return;

    const liste = (treffer.fullTextUrlList && treffer.fullTextUrlList.fullTextUrl) || [];
    liste.forEach(eintrag => {
        if ((eintrag.documentStyle || '').toLowerCase() !== 'pdf') return;
        if ((eintrag.availabilityCode || '') !== 'OA') return;
        sammeln(eintrag.url, 'Europe PMC', { host: eintrag.site === 'Europe_PMC' ? 'repository' : 'publisher' });
    });

    // Der Render-Endpunkt von Europe PMC liefert auch dann ein PDF, wenn der
    // PMC-Server selbst mit einer Sperrseite antwortet.
    if (treffer.pmcid) {
        sammeln(`https://europepmc.org/articles/${treffer.pmcid}?pdf=render`, 'Europe PMC',
            { host: 'repository', version: 'publishedVersion' });
    }
}

async function pdfKandidatenSemanticScholar(doi, sammeln) {
    const adresse = 'https://api.semanticscholar.org/graph/v1/paper/DOI:'
        + encodeURIComponent(doi) + '?fields=openAccessPdf,externalIds';

    // Der offene Endpunkt drosselt haeufig (HTTP 429). Da hier die arXiv-Kennung
    // haengt - oft die einzige frei zugaengliche Fassung - wird einmal nachgefasst.
    let daten = await holeJson(adresse);
    if (!daten) {
        await new Promise(r => setTimeout(r, 3000));
        daten = await holeJson(adresse);
    }
    if (!daten) return;
    if (daten.openAccessPdf && daten.openAccessPdf.url) {
        sammeln(daten.openAccessPdf.url, 'Semantic Scholar', { host: 'unbekannt', license: daten.openAccessPdf.license });
    }
    const arxivId = daten.externalIds && daten.externalIds.ArXiv;
    if (arxivId) sammeln(`https://arxiv.org/pdf/${arxivId}`, 'arXiv', { host: 'repository', version: 'submittedVersion' });
}

// Elsevier: mit dem hinterlegten Scopus-Schluessel liefert die Article-
// Retrieval-API das PDF direkt (httpAccept=application/pdf) - das umgeht die
// Sperre auf sciencedirect.com. Der Schluessel bleibt im Hintergrundskript;
// nach aussen wird nur die schluessellose Adresse gezeigt und beim Oeffnen
// werden die Bytes ueber fetchPdfBytes geholt.
async function elsevierSchluessel() {
    try {
        const gespeichert = await chrome.storage.local.get({ scopusApiKey: '' });
        return (gespeichert.scopusApiKey || '').trim();
    } catch (e) {
        return '';
    }
}

// Ohne Volltext-Berechtigung gibt Elsevier nur die Vorschauseite heraus.
// Freigeschaltet wird sie durch die Instituts-IP oder einen Insttoken, den
// Elsevier der Einrichtung ausstellt.
async function elsevierInsttoken() {
    try {
        const gespeichert = await chrome.storage.local.get({ elsevierInsttoken: '' });
        return (gespeichert.elsevierInsttoken || '').trim();
    } catch (e) {
        return '';
    }
}

function elsevierPdfUrl(doi, schluessel, insttoken) {
    return 'https://api.elsevier.com/content/article/doi/' + encodeURIComponent(doi)
        + '?apiKey=' + encodeURIComponent(schluessel)
        + (insttoken ? '&insttoken=' + encodeURIComponent(insttoken) : '')
        + '&httpAccept=application%2Fpdf';
}

// Nur fuer Elsevier-Inhalte anbieten: bei fremden Verlagen antwortet die API
// mit 404, und in der Liste stuende ein Kandidat, der nie funktionieren kann.
const ELSEVIER_PRAEFIXE = ['10.1016', '10.1006', '10.1053', '10.1054', '10.1067',
    '10.1078', '10.1157', '10.1197', '10.1367', '10.1510', '10.1532', '10.2353'];

function istElsevier(doi, verlag) {
    const praefix = (doi || '').split('/')[0];
    if (ELSEVIER_PRAEFIXE.indexOf(praefix) !== -1) return true;
    return /elsevier|sciencedirect|cell\s+press/i.test(verlag || '');
}

async function pdfKandidatenElsevier(doi, sammeln, verlag) {
    if (!istElsevier(doi, verlag)) return;
    const schluessel = await elsevierSchluessel();
    if (!schluessel) return;

    const insttoken = await elsevierInsttoken();
    sammeln('https://api.elsevier.com/content/article/doi/' + doi, 'Elsevier API', {
        host: 'publisher', version: 'publishedVersion', elsevierApi: true,
        nurVorschau: !insttoken, // ohne Freischaltung meist nur die erste Seite
        quellenName: 'Elsevier Article Retrieval'
    });
}

// arXiv ueber den Titel finden. Die arXiv-API kennt keine DOI-Suche, der
// Titelabgleich ist aber eindeutig genug, wenn er exakt uebereinstimmt.
function normalisiereTitel(t) {
    return (t || '').toLowerCase().replace(/&amp;/g, '&').replace(/[^a-z0-9]+/g, ' ').trim();
}

async function pdfKandidatenArxivTitel(titel, sammeln) {
    if (!titel || titel.length < 15) return;

    const adresse = 'http://export.arxiv.org/api/query?search_query='
        + encodeURIComponent('ti:"' + titel.replace(/"/g, '') + '"') + '&max_results=5';

    const abbruch = new AbortController();
    const uhr = setTimeout(() => abbruch.abort(), 12000);
    let xml = '';
    try {
        const antwort = await fetch(adresse, { signal: abbruch.signal });
        if (!antwort.ok) return;
        xml = await antwort.text();
    } catch (e) {
        return;
    } finally {
        clearTimeout(uhr);
    }

    const gesucht = normalisiereTitel(titel);
    const eintraege = xml.split('<entry>').slice(1);
    for (const eintrag of eintraege) {
        const idTreffer = /<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+)\s*<\/id>/i.exec(eintrag);
        const titelTreffer = /<title>([\s\S]*?)<\/title>/i.exec(eintrag);
        if (!idTreffer || !titelTreffer) continue;
        if (normalisiereTitel(titelTreffer[1]) !== gesucht) continue;

        const kennung = idTreffer[1].replace(/v\d+$/, '');
        sammeln('https://arxiv.org/pdf/' + kennung, 'arXiv (Titelsuche)',
            { host: 'repository', version: 'submittedVersion' });
        return;
    }
}

// Aus der Artikelseite die uebliche PDF-Adresse ableiten. Viele Verlage auf
// der Atypon-Plattform folgen dem Schema /doi/pdf/<doi>; Wiley liefert unter
// /doi/pdfdirect/<doi> die Datei ohne den Betrachter drumherum.
function pdfKandidatenMuster(doi, sammeln, landeSeiten) {
    const hosts = new Set();
    landeSeiten.forEach(seite => {
        const host = pdfHost(seite);
        if (host && host.indexOf('doi.org') === -1) hosts.add(host);
    });

    hosts.forEach(host => {
        const basis = 'https://' + host;
        const gemeinsam = { host: 'publisher', version: 'publishedVersion', abgeleitet: true, quellenName: host };

        if (/onlinelibrary\.wiley\.com$/.test(host)) {
            sammeln(`${basis}/doi/pdfdirect/${doi}?download=true`, 'Muster (Wiley)', gemeinsam);
            sammeln(`${basis}/doi/pdf/${doi}`, 'Muster (Wiley)', gemeinsam);
        } else if (/tandfonline\.com$|sagepub\.com$|pubs\.acs\.org$|journals\.ametsoc\.org$/.test(host)) {
            sammeln(`${basis}/doi/pdf/${doi}`, 'Muster (Verlag)', gemeinsam);
        } else if (/link\.springer\.com$/.test(host)) {
            sammeln(`${basis}/content/pdf/${doi}.pdf`, 'Muster (Springer)', gemeinsam);
        } else if (/frontiersin\.org$/.test(host)) {
            sammeln(`${basis}/articles/${doi}/pdf`, 'Muster (Frontiers)', gemeinsam);
        } else if (/iopscience\.iop\.org$/.test(host)) {
            sammeln(`${basis}/article/${doi}/pdf`, 'Muster (IOP)', gemeinsam);
        }
    });

    // Wiley auch ohne bekannte Artikelseite: der Hauptserver leitet auf die
    // richtige Zeitschriften-Subdomain um.
    if (/^10\.(1002|1111|1029|1046|1034)$/.test((doi || '').split('/')[0])
        && !Array.from(hosts).some(h => /wiley\.com$/.test(h))) {
        sammeln(`https://onlinelibrary.wiley.com/doi/pdfdirect/${doi}?download=true`, 'Muster (Wiley)',
            { host: 'publisher', version: 'publishedVersion', abgeleitet: true, quellenName: 'onlinelibrary.wiley.com' });
    }
}

// Seitenzahl aus den Rohbytes schaetzen. Klappt bei klassisch aufgebauten
// PDFs (Elseviers Vorschauseiten gehoeren dazu); bei komprimierten
// Objektstroemen liefert sie 0 - dann wird eben nichts behauptet.
function zaehlePdfSeiten(roh) {
    if (!roh) return 0;

    // Der Seitenbaum nennt die Gesamtzahl direkt
    let groesste = 0;
    const zaehler = /\/Type\s*\/Pages[^>]{0,400}?\/Count\s+(\d+)/g;
    let treffer;
    while ((treffer = zaehler.exec(roh)) !== null) {
        const wert = parseInt(treffer[1], 10);
        if (wert > groesste) groesste = wert;
    }
    if (groesste > 0) return groesste;

    // Sonst die Seitenobjekte zaehlen
    const seiten = roh.match(/\/Type\s*\/Page[^s]/g);
    return seiten ? seiten.length : 0;
}

// Der Elsevier-Volltext haengt an der Berechtigung der Einrichtung (IP oder
// Insttoken). Fehlt sie, kommt eine einseitige Vorschau - die sieht wie ein
// gueltiges PDF aus und muss deshalb an der Seitenzahl erkannt werden.
async function pruefeElsevierVolltext(url) {
    const abbruch = new AbortController();
    const uhr = setTimeout(() => abbruch.abort(), 15000);
    try {
        const antwort = await fetch(url, {
            method: 'GET', credentials: 'include', redirect: 'follow',
            headers: { 'Accept': 'application/pdf,*/*' }, signal: abbruch.signal
        });
        if (!antwort.ok) return { ok: false, status: antwort.status, grund: 'HTTP ' + antwort.status };

        const puffer = await antwort.arrayBuffer();
        const bytes = new Uint8Array(puffer);
        if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) !== '%PDF-') {
            return { ok: false, status: antwort.status, grund: 'kein PDF' };
        }

        let roh = '';
        const block = 0x8000;
        for (let i = 0; i < bytes.length; i += block) {
            roh += String.fromCharCode.apply(null, bytes.subarray(i, i + block));
        }
        const seiten = zaehlePdfSeiten(roh);
        return {
            ok: true, status: antwort.status, seiten: seiten,
            nurVorschau: seiten === 1,
            grund: seiten === 1 ? 'nur Vorschauseite (1 Seite)' : ''
        };
    } catch (e) {
        return { ok: false, grund: e.name === 'AbortError' ? 'Zeitüberschreitung' : e.message };
    } finally {
        clearTimeout(uhr);
    }
}

// Kurzer Bereichsabruf: liefert die Adresse wirklich ein PDF oder eine
// Sperrseite? Cookies werden mitgeschickt, damit institutionelle Zugaenge
// greifen.
async function pruefePdfUrl(url, referer) {
    const versuch = async (mitBereich) => {
        const abbruch = new AbortController();
        const uhr = setTimeout(() => abbruch.abort(), 12000);
        try {
            const kopf = { 'Accept': 'application/pdf,application/octet-stream;q=0.9,*/*;q=0.8' };
            if (mitBereich) kopf['Range'] = 'bytes=0-2047';
            // Ein Referer der Artikelseite laesst den Abruf wie ein Klick aus
            // dem Artikel aussehen - manche Verlage geben dann aus.
            if (referer) kopf['Referer'] = referer;

            const antwort = await fetch(url, {
                method: 'GET', credentials: 'include', redirect: 'follow',
                headers: kopf, signal: abbruch.signal
            });
            const typ = ((antwort.headers && antwort.headers.get('content-type')) || '').toLowerCase();
            if (!antwort.ok && antwort.status !== 206) {
                return { ok: false, status: antwort.status, typ: typ, grund: 'HTTP ' + antwort.status };
            }
            if (typ.includes('pdf')) return { ok: true, status: antwort.status, typ: typ };

            const anfang = (await antwort.text()).slice(0, 8);
            if (anfang.indexOf('%PDF-') === 0) return { ok: true, status: antwort.status, typ: typ || 'application/pdf' };
            return {
                ok: false, status: antwort.status, typ: typ,
                grund: typ.includes('html') ? 'Sperr- oder Landeseite' : 'kein PDF'
            };
        } catch (e) {
            return { ok: false, grund: e.name === 'AbortError' ? 'Zeitüberschreitung' : e.message };
        } finally {
            clearTimeout(uhr);
        }
    };

    const erster = await versuch(true);
    if (erster.ok) return erster;

    // Manche Server mögen keine Bereichsanfragen oder mustern den Abruf ab -
    // ein zweiter, unauffälligerer Versuch lohnt sich.
    if (erster.status === 403 || erster.status === 401 || erster.status === 416 || !erster.status) {
        const zweiter = await versuch(false);
        if (zweiter.ok) return zweiter;
        zweiter.blockiert = (zweiter.status === 403 || zweiter.status === 401);
        return zweiter;
    }
    erster.blockiert = (erster.status === 403 || erster.status === 401);
    return erster;
}

// Reihenfolge: bestaetigte zuerst, darunter Verlagsfassung vor Repositorium,
// publizierte Fassung vor Manuskript.
function pdfRang(kandidat) {
    let punkte = 0;
    if (kandidat.geprueft) punkte += 100;
    if (kandidat.abgeleitet) punkte -= 4; // geraten, nicht gemeldet
    if (kandidat.nurVorschau) punkte -= 60; // nur die erste Seite ist kein Volltext
    if (kandidat.version === 'publishedVersion' || kandidat.version === 'vor') punkte += 20;
    if (kandidat.version === 'acceptedVersion' || kandidat.version === 'am') punkte += 10;
    if (kandidat.host === 'publisher') punkte += 5;
    if (kandidat.host === 'repository') punkte += 3;
    return -punkte;
}

async function pdfLinkCacheLesen(doi) {
    try {
        const gespeichert = await chrome.storage.local.get({ [PDF_LINK_CACHE_KEY]: {} });
        const eintrag = (gespeichert[PDF_LINK_CACHE_KEY] || {})[doi];
        const frist = (eintrag && eintrag.ttl) || PDF_LINK_TTL;
        if (eintrag && eintrag.zeit && (Date.now() - eintrag.zeit) < frist) return eintrag.kandidaten;
    } catch (e) { }
    return null;
}

async function pdfLinkCacheSchreiben(doi, kandidaten, brauchbar) {
    try {
        const gespeichert = await chrome.storage.local.get({ [PDF_LINK_CACHE_KEY]: {} });
        const alle = gespeichert[PDF_LINK_CACHE_KEY] || {};
        // Ohne geprueften Treffer nur kurz merken: ein Aussetzer eines Dienstes
        // soll nicht 12 Stunden lang als "nichts gefunden" stehen bleiben.
        alle[doi] = {
            zeit: Date.now(), kandidaten: kandidaten,
            ttl: brauchbar ? PDF_LINK_TTL : PDF_LINK_TTL_MAGER
        };
        const behalten = Object.keys(alle)
            .filter(k => alle[k] && alle[k].zeit && (Date.now() - alle[k].zeit) < PDF_LINK_TTL)
            .sort((a, b) => alle[b].zeit - alle[a].zeit)
            .slice(0, PDF_LINK_MAX);
        const neu = {};
        behalten.forEach(k => { neu[k] = alle[k]; });
        await chrome.storage.local.set({ [PDF_LINK_CACHE_KEY]: neu });
    } catch (e) { }
}

// Ein in der Vorschau geoeffnetes PDF zusaetzlich ablegen, damit es fuer den
// Upload nach DORA gleich auf der Platte liegt.
function sichererDateiname(vorschlag) {
    let name = (vorschlag || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');
    if (!name) name = 'dora-pdf';
    if (!/\.pdf$/i.test(name)) name += '.pdf';
    return name.slice(-120);
}

async function downloadPdf(auftrag) {
    let url = auftrag.url;
    if (auftrag.elsevierDoi) {
        const schluessel = await elsevierSchluessel();
        if (!schluessel) throw new Error('Kein Scopus/Elsevier-Schlüssel hinterlegt.');
        url = elsevierPdfUrl(auftrag.elsevierDoi, schluessel, await elsevierInsttoken());
    }
    if (!url) throw new Error('Keine URL angegeben.');

    const downloadId = await chrome.downloads.download({
        url: url, filename: sichererDateiname(auftrag.filename), saveAs: false
    });
    return { downloadId: downloadId, filename: sichererDateiname(auftrag.filename) };
}

// Liefert ein PDF als base64 an die Betrachterseite. Gedacht fuer Quellen,
// deren Adresse ein Geheimnis enthaelt (Elsevier-Schluessel) - so bleibt der
// Schluessel im Hintergrundskript.
const PDF_BYTES_MAX = 60 * 1024 * 1024;

async function fetchPdfBytes(auftrag) {
    let url = auftrag.url;
    if (auftrag.elsevierDoi) {
        const schluessel = await elsevierSchluessel();
        if (!schluessel) throw new Error('Kein Scopus/Elsevier-Schlüssel hinterlegt.');
        url = elsevierPdfUrl(auftrag.elsevierDoi, schluessel, await elsevierInsttoken());
    }
    if (!url) throw new Error('Keine URL angegeben.');

    const antwort = await fetch(url, { credentials: 'include', redirect: 'follow' });
    if (!antwort.ok) throw new Error('HTTP ' + antwort.status);

    const puffer = await antwort.arrayBuffer();
    if (puffer.byteLength > PDF_BYTES_MAX) throw new Error('Datei zu groß für die Vorschau.');

    const bytes = new Uint8Array(puffer);
    if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) !== '%PDF-') {
        throw new Error('Die Antwort ist kein PDF (vermutlich eine Sperr- oder Fehlerseite).');
    }

    let roh = '';
    const block = 0x8000;
    for (let i = 0; i < bytes.length; i += block) {
        roh += String.fromCharCode.apply(null, bytes.subarray(i, i + block));
    }
    return { base64: btoa(roh), groesse: bytes.length };
}

async function findPdfLinks(doi, erneut) {
    if (!doi) return { doi: '', kandidaten: [] };

    if (!erneut) {
        const gespeichert = await pdfLinkCacheLesen(doi);
        if (gespeichert) return { doi: doi, kandidaten: gespeichert, ausCache: true };
    }

    const nachUrl = new Map();
    const sammeln = (url, quelle, zusatz) => {
        if (!url || !/^https?:/i.test(url)) return;
        const sauber = url.trim();
        // Der DOI-Resolver ist eine Weiterleitung auf die Artikelseite, kein
        // Volltext - manche Dienste melden ihn trotzdem als "OA-PDF".
        if (/^(dx\.)?doi\.org$/.test(pdfHost(sauber))) return;
        const vorhanden = nachUrl.get(sauber);
        if (vorhanden) {
            if (vorhanden.quellen.indexOf(quelle) === -1) vorhanden.quellen.push(quelle);
            // Fehlende Angaben aus der zweiten Quelle ergaenzen
            ['host', 'version', 'license', 'quellenName'].forEach(feld => {
                if (!vorhanden[feld] && zusatz && zusatz[feld]) {
                    vorhanden[feld] = feld === 'version' ? normalisiereVersion(zusatz[feld]) : zusatz[feld];
                }
            });
            return;
        }
        nachUrl.set(sauber, {
            url: sauber, quellen: [quelle], host: (zusatz && zusatz.host) || 'unbekannt',
            version: normalisiereVersion(zusatz && zusatz.version), license: (zusatz && zusatz.license) || '',
            quellenName: (zusatz && zusatz.quellenName) || pdfHost(sauber),
            elsevierApi: !!(zusatz && zusatz.elsevierApi),
            nurVorschau: !!(zusatz && zusatz.nurVorschau), seiten: 0,
            abgeleitet: !!(zusatz && zusatz.abgeleitet),
            geprueft: false, status: 0, grund: '', blockiert: false
        });
    };

    const landeSeiten = new Set();
    const merkeSeite = (url) => { if (url && /^https?:/i.test(url)) landeSeiten.add(url); };

    const laeufe = await Promise.allSettled([
        pdfKandidatenCrossref(doi, sammeln, merkeSeite),
        pdfKandidatenUnpaywall(doi, sammeln, merkeSeite),
        pdfKandidatenOpenAlex(doi, sammeln, merkeSeite),
        pdfKandidatenEuropePmc(doi, sammeln),
        pdfKandidatenSemanticScholar(doi, sammeln)
    ]);

    // Der Verlagsname aus Crossref entscheidet, ob die Elsevier-API überhaupt
    // in Frage kommt.
    const ausCrossref = laeufe[0].status === 'fulfilled' ? (laeufe[0].value || {}) : {};
    await pdfKandidatenElsevier(doi, sammeln, ausCrossref.verlag || '');

    // arXiv ist bei Physik oft die einzige freie Fassung. Steht die Kennung
    // nicht schon fest (Semantic Scholar drosselt haeufig), wird ueber den
    // Titel gesucht - die arXiv-API ist dafuer verlaesslich.
    if (!Array.from(nachUrl.keys()).some(u => /arxiv\.org/i.test(u))) {
        await pdfKandidatenArxivTitel(ausCrossref.titel || '', sammeln);
    }

    // Aus der Artikelseite abgeleitete Adressen - sie werden wie alle anderen
    // angetestet, kosten also nichts ausser einem Versuch.
    pdfKandidatenMuster(doi, sammeln, landeSeiten);

    const kandidaten = Array.from(nachUrl.values());

    // Vorsortieren, damit die aussichtsreichsten Adressen im Pruefbudget liegen
    kandidaten.sort((a, b) => pdfRang(a) - pdfRang(b));

    const schluessel = await elsevierSchluessel();
    const insttoken = await elsevierInsttoken();
    const zuPruefen = kandidaten.slice(0, PDF_PRUEF_LIMIT);
    const ergebnisse = await Promise.allSettled(zuPruefen.map(k => {
        // Bei Elsevier zaehlt nicht nur "ist ein PDF", sondern auch "ist der
        // ganze Artikel" - deshalb dort der ausfuehrliche Test.
        if (k.elsevierApi) return pruefeElsevierVolltext(elsevierPdfUrl(doi, schluessel, insttoken));
        const referer = Array.from(landeSeiten).find(seite => pdfHost(seite) === pdfHost(k.url)) || '';
        return pruefePdfUrl(k.url, referer);
    }));
    ergebnisse.forEach((e, i) => {
        const wert = e.status === 'fulfilled' ? e.value : { ok: false, grund: 'Prüfung fehlgeschlagen' };
        zuPruefen[i].geprueft = !!wert.ok;
        zuPruefen[i].status = wert.status || 0;
        zuPruefen[i].blockiert = !!wert.blockiert;
        if (wert.seiten) zuPruefen[i].seiten = wert.seiten;
        // Der gemessene Befund ersticht die Vermutung aus der Einstellung
        if (wert.ok && zuPruefen[i].elsevierApi) zuPruefen[i].nurVorschau = !!wert.nurVorschau;
        zuPruefen[i].grund = wert.ok ? (wert.grund || '') : (wert.grund || 'nicht abrufbar');
    });
    kandidaten.slice(PDF_PRUEF_LIMIT).forEach(k => { k.grund = 'nicht angetestet'; });

    kandidaten.sort((a, b) => pdfRang(a) - pdfRang(b));
    await pdfLinkCacheSchreiben(doi, kandidaten, kandidaten.some(k => k.geprueft));
    return { doi: doi, kandidaten: kandidaten };
}

chrome.windows.onRemoved.addListener(fensterId => {
    if (fensterId === popupWindowId) popupWindowId = null;
});

// PDF herunterladen und mit der zugeordneten Anwendung oeffnen. Welches
// Programm das ist, entscheidet die Dateizuordnung des Systems bzw. die
// Firefox-Einstellung unter "Anwendungen" - steht dort der eingebaute
// Betrachter, oeffnet Firefox einen Tab statt Adobe.
// Hinweis: Firefox erlaubt downloads.open() laut MDN nur aus dem Handler
// einer Nutzeraktion. Klappt es hier nicht, meldet die Funktion das zurueck,
// und der Aufrufer kann es aus einem Klick heraus erneut versuchen
// (openDownloadedFile).
async function openPdfExternally(auftrag) {
    // Aufruf mit einfacher URL oder mit einem Auftrag {url, elsevierDoi}
    const angabe = (typeof auftrag === 'string') ? { url: auftrag } : (auftrag || {});
    let url = angabe.url;
    if (angabe.elsevierDoi) {
        const schluessel = await elsevierSchluessel();
        if (!schluessel) throw new Error('Kein Scopus/Elsevier-Schlüssel hinterlegt.');
        url = elsevierPdfUrl(angabe.elsevierDoi, schluessel, await elsevierInsttoken());
    }
    if (!url) throw new Error('Keine URL angegeben.');

    const downloadId = await chrome.downloads.download({ url: url, saveAs: false });

    return new Promise(resolve => {
        let abgeschlossen = false;
        const fertig = (geoeffnet, geladen, hinweis) => {
            if (abgeschlossen) return;
            abgeschlossen = true;
            chrome.downloads.onChanged.removeListener(zuhoerer);
            resolve({
                downloadId: downloadId, opened: geoeffnet,
                downloaded: geladen, note: hinweis || ''
            });
        };

        const zuhoerer = (delta) => {
            if (delta.id !== downloadId) return;
            if (delta.state && delta.state.current === 'interrupted') {
                fertig(false, false, 'Download abgebrochen');
                return;
            }
            if (!delta.state || delta.state.current !== 'complete') return;

            Promise.resolve(chrome.downloads.open(downloadId))
                .then(() => fertig(true, true))
                .catch(err => fertig(false, true, err && err.message ? err.message : 'Öffnen nicht möglich'));
        };

        chrome.downloads.onChanged.addListener(zuhoerer);
        // Sicherheitsnetz, damit der Aufrufer nicht ewig wartet
        setTimeout(() => fertig(false, false, 'Zeitüberschreitung beim Download'), 60000);
    });
}

// Startet eine bereits geladene Datei - gedacht fuer den Klick-Wiederholer,
// falls Firefox das automatische Oeffnen abgelehnt hat.
async function openDownloadedFile(downloadId) {
    if (downloadId === undefined || downloadId === null) throw new Error('Keine Download-ID angegeben.');
    await chrome.downloads.open(downloadId);
    return { downloadId: downloadId, opened: true };
}

async function openPopupWindow(request) {
    const url = request.url;
    if (!url) throw new Error('Keine URL angegeben.');

    const uebernehmen = async (tabId, windowId) => {
        await chrome.tabs.update(tabId, { url: url });
        if (!request.onlyIfOpen && windowId !== undefined) {
            try { await chrome.windows.update(windowId, { focused: true }); } catch (e) { }
        }
        popupWindowId = windowId !== undefined ? windowId : popupWindowId;
        return { windowId: popupWindowId, reused: true };
    };

    if (popupWindowId !== null) {
        try {
            const fenster = await chrome.windows.get(popupWindowId, { populate: true });
            const tab = fenster && fenster.tabs && fenster.tabs[0];
            if (tab) return await uebernehmen(tab.id, popupWindowId);
        } catch (e) {
            popupWindowId = null; // Fenster wurde zwischenzeitlich geschlossen
        }
    }

    // Das Hintergrundskript ist eine Event-Page und wird zwischendurch
    // beendet - dann ist popupWindowId weg, obwohl das Fenster noch offen
    // ist. Deshalb zusaetzlich anhand der geoeffneten Seite suchen, sonst
    // folgt die Vorschau beim naechsten Datensatz nicht mehr.
    try {
        const basis = chrome.runtime.getURL('pdf_viewer.html');
        const tabs = await chrome.tabs.query({});
        const treffer = (tabs || []).find(t => t.url && t.url.indexOf(basis) === 0);
        if (treffer) return await uebernehmen(treffer.id, treffer.windowId);
    } catch (e) {
        // Ohne Tab-Zugriff bleibt es beim Neuöffnen
    }

    if (request.onlyIfOpen) return { windowId: null, reused: false, skipped: true };

    // Bewusst ein normales Fenster statt eines Popups: Firefox-Popups haben
    // keine Fensterknoepfe, laufen an Snap-Layouts vorbei und liessen sich
    // praktisch nicht groesser ziehen.
    const neu = await chrome.windows.create({
        url: url, type: 'normal',
        width: request.width || 900, height: request.height || 1050
    });
    popupWindowId = neu.id;
    return { windowId: neu.id, reused: false };
}

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

    if (request.action === "analyzePdf") {
        analyzePdf(request.fileData, request.institut)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "pdfAbgleichText") {
        pdfAbgleichText(request.fileData)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "pdfAbgleichCrossref") {
        pdfAbgleichCrossref(request.doi)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "analyzePdfUrl") {
        analyzePdfUrl(request.pdfUrl, request.institut)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "analyzePdfHaiku") {
        analysiereMitHaikuAusAuftrag(request)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "analyzePdfViaTab") {
        analyzePdfViaTab(request.pdfUrl, request.institut)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "fetchHtml") {
        fetch(request.url, { credentials: 'include' })
            .then(response => {
                const finalUrl = response.url;
                // Status mitgeben: Verlage wie ACS antworten mit 403 und einer
                // Sperrseite - ohne diese Angabe sieht das aus wie "nichts da".
                return response.text().then(text => ({ text, finalUrl, status: response.status, ok: response.ok }));
            })
            .then(result => sendResponse({
                success: true, data: result.text, finalUrl: result.finalUrl,
                status: result.status, ok: result.ok
            }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "registerDoraTab") {
        activeDoraTabId = sender.tab.id;
        sendResponse({ success: true });
        return true;
    }

    if (request.action === "verifyPdfUrl") {
        pruefePdfUrl(request.url)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "findPdfLinks") {
        findPdfLinks(request.doi, request.erneut)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "downloadPdf") {
        downloadPdf(request)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "fetchPdfBytes") {
        fetchPdfBytes(request)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "openDownloadedFile") {
        openDownloadedFile(request.downloadId)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "openPdfExternally") {
        openPdfExternally(request)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "openPopupWindow") {
        openPopupWindow(request)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }


    if (request.action === "searchAutocomplete") {
        fetchDoraAutocomplete(request.url)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "fetchFunding") {
        fetchFundingSuggestions(request.doi)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "fetchSupplements") {
        fetchSupplements(request.doi)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "resolveRepository") {
        (async () => {
            const repo = repositoryFromId(request.url);
            if (!repo) return { repository: null, files: [] };
            const inhalt = await fetchRepositoryFiles(repo);
            return {
                repository: repo.name, title: inhalt.title || '',
                license: inhalt.license || null, files: inhalt.files || []
            };
        })()
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (request.action === "kiCheckDatensatz") {
        kiCheckDatensatz(request)
            .then(data => sendResponse({ success: true, data: data }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }
});

// Monitor Tabs for PDF URLs (Passive Scan)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo.url || tab.url;
    // Reagiere auf .pdf UND blob: URLs (für PDF.js)
    if (activeDoraTabId && url && (url.toLowerCase().endsWith('.pdf') || url.startsWith('blob:'))) {
        console.log(`PDF/Blob detected: ${url} in tab ${tabId}`);
        pdfTabMap.set(url, tabId); // Merke Tab-ID für spätere Injection

        chrome.tabs.sendMessage(activeDoraTabId, {
            action: "pdfDetected",
            url: url,
            filename: url.startsWith('blob:') ? "document.pdf" : url.split('/').pop()
        }).catch((err) => {
            console.warn('Failed to notify DORA tab:', err);
        });
    }
});

// Download Monitor Listener
chrome.downloads.onChanged.addListener((delta) => {
    if (activeDoraTabId && delta.state && delta.state.current === 'complete') {
        chrome.downloads.search({ id: delta.id }, (results) => {
            if (results && results.length > 0) {
                const item = results[0];
                // Check if it looks like a PDF
                if (item.mime === "application/pdf" || item.filename.toLowerCase().endsWith(".pdf") || item.url.toLowerCase().endsWith(".pdf")) {
                    // Speichere den Referrer (die Artikelseite), um später den Kontext für den Download zu finden
                    if (item.referrer) {
                        pdfReferrerMap.set(item.url, item.referrer);
                    }

                    chrome.tabs.sendMessage(activeDoraTabId, {
                        action: "pdfDetected",
                        url: item.url,
                        filename: item.filename.split(/[/\\]/).pop()
                    }).catch(() => { /* Tab closed */ });
                }
            }
        });
    }
});

async function fetchMetadata(doi) {
    // BITTE E-MAIL EINTRAGEN (Pflicht für Unpaywall):
    const email = "dora@lib4ri.ch";

    try {
        // Get Scopus Key first
        const storage = await new Promise(resolve => chrome.storage.local.get('scopusApiKey', resolve));
        const scopusKey = storage.scopusApiKey;

        // 1. Initial Fetch: Unpaywall + Crossref + Scopus
        const promises = [
            fetch(`https://api.unpaywall.org/v2/${doi}?email=${email}`),
            fetch(`https://api.crossref.org/works/${doi}`)
        ];

        if (scopusKey) {
            promises.push(fetchScopusMetadata(doi, scopusKey));
        }

        const results = await Promise.all(promises);

        const unpaywallRes = results[0];
        const crossrefRes = results[1];
        const scopusData = scopusKey && results[2] ? results[2] : null;

        const unpaywallData = unpaywallRes.ok ? await unpaywallRes.json() : { is_oa: false };

        let crossrefData = {};
        if (crossrefRes.ok) {
            const json = await crossrefRes.json();
            crossrefData = json.message || {};
        }

        // 2. Extract ISSNs for DOAJ Check
        let issns = [];
        if (crossrefData.ISSN && Array.isArray(crossrefData.ISSN)) {
            issns = crossrefData.ISSN;
        } else if (unpaywallData.journal_issns) {
            issns = unpaywallData.journal_issns.split(',');
        }

        // 3. Fetch DOAJ status (from Unpaywall directly instead of DOAJ API due to Cloudflare bot protection)
        let doajData = { in_doaj: unpaywallData.journal_is_in_doaj === true };

        // 4. Extract Crossref License
        // Crossref licenses are in message.license [ { URL: "...", start: ... } ]
        // We usually want the most recent one or the one that indicates OA
        let crossrefLicense = null;
        if (crossrefData.license && Array.isArray(crossrefData.license)) {
            // Sort by start date descending (if available) or just take the first with a valid URL
            // Simply taking the first one is often enough, but let's try to find a creative commons one
            const licenses = crossrefData.license;
            const ccLicense = licenses.find(l => l.URL && l.URL.includes('creativecommons.org'));
            crossrefLicense = ccLicense ? ccLicense.URL : (licenses[0] ? licenses[0].URL : null);
        }

        return {
            unpaywall: unpaywallData,
            crossref: crossrefData,
            scopus: scopusData,
            doaj: doajData,
            crossrefLicense: crossrefLicense
        };
    } catch (error) {
        throw new Error("Netzwerkfehler oder ungültige DOI");
    }
}

async function fetchDoajMetadata(issns) {
    if (!issns || issns.length === 0) return null;

    // Check availability of each ISSN until one matches or all fail
    // API: https://doaj.org/api/search/journals/issn:{issn}
    // Note: DOAJ API allows searching by ISSN. We can just check the first one that returns a hit.

    for (const issn of issns) {
        try {
            const cleanIssn = issn.trim();
            const res = await fetch(`https://doaj.org/api/search/journals/issn:${cleanIssn}`);
            if (res.ok) {
                const data = await res.json();
                if (data.total > 0 && data.results && data.results.length > 0) {
                    // Found in DOAJ
                    const journal = data.results[0].bibjson;
                    return {
                        in_doaj: true,
                        title: journal.title,
                        license: journal.license ? journal.license.map(l => l.type).join(', ') : null,
                        oa_start: journal.oa_start ? journal.oa_start.year : null
                    };
                }
            }
        } catch (e) {
            console.warn(`DOAJ fetch failed for ${issn}:`, e);
        }
    }

    return { in_doaj: false };
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

// ---------------------------------------------------------------------------
// PDF-Auswertung mit Haiku. Das PDF geht als Dokument-Block an die API (Text
// und Layout), die Antwort kommt ueber einen erzwungenen Tool-Aufruf als
// strukturiertes JSON. Die Seitenzahl zaehlt der Helper selbst - ein Modell
// zaehlt Seiten nicht verlaesslich.
// ---------------------------------------------------------------------------
function nurText(wert) {
    const t = typeof wert === 'string' ? wert.replace(/\s+/g, ' ').trim() : '';
    return t || null;
}

// Facilities und ihre Beamlines, wie DORA sie fuehrt (Dialog "Add Info about a PSI
// Facility", Stand 2026-10). Aendert DORA die Listen, muss das hier nachgezogen
// werden; das Formular lehnt Werte ausserhalb der Liste ohnehin ab.
const PSI_FACILITY_BEAMLINES = {"SLS": ["Accelerator Physics", "ADDAMS", "ADRESS-RIXS", "ADRESS-SX-ARPES", "CF", "cSAXS", "DEBYE", "Diagnostics", "DISCO", "I-TOMCAT", "In Situ Spectroscopy", "IR", "ISS", "LUCIA", "Micro-XAS", "Micro-XAS-FEMTO", "MS-Powder", "MS-Surf-Diffr", "MS-Tomo", "NanoXAS", "NEMO", "Optics", "PEARL", "Phoenix", "PolLux", "PX", "PXII", "PXIII", "QUEST", "S-TOMCAT", "SIM", "SIS-Cophee", "SIS-HRPES", "SIS-ULTRA", "SIS-User", "SLS 2.0", "Super-XAS", "TOMCAT", "VUV", "XIL-II", "XTreme"], "SINQ": ["AMOR", "BOA", "CAMEA", "DMC", "EIGER", "FALCON", "FOCUS", "HRPT", "ICON", "MARS", "Morpheus", "MUPAD", "NARZISS", "NEUTRA", "Neutron-Microscope", "ORION", "PNA-NAA", "POLDI", "RITA-II", "SANS-I", "SANS-II", "SANS-LLB", "STIP", "TASP", "TriCS", "ZEBRA"], "SmuS": ["ALC", "Dolly", "FLAME", "GIANT/MIXE", "GPD", "GPS", "HAL-9500", "LEM", "LTF", "VMS"], "CHRISP": ["ALCAP", "CMS", "DetectorTests", "EDM", "FAST", "HIPA", "HyperMu", "LambShift", "MEG", "MEG-II", "Mu3e", "MuCool", "muEDM", "MuFuse", "MUH2", "MUH3", "muonCF", "Muonium", "MUSE", "MUSUN", "MuX", "PEN", "PIF", "PiHE", "PIONEER", "UCN"], "PROSCAN": ["Gantry1", "Gantry2", "Gantry3", "OPTIS"], "SwissFEL": ["Accel. Beamline Laser Sci. Technol.", "Accelerator Physics", "ARAMIS-Alvra", "ARAMIS-Bernina", "ARAMIS-Cristallina", "ATHOS-Furka", "ATHOS-Maloja"], "other PSI infrastructure": ["EMF", "PICO"], "non-PSI large scale facility (e.g. ESRF, ILL, etc.)": []};
const PSI_FACILITIES = Object.keys(PSI_FACILITY_BEAMLINES);

// Haiku liefert Paare Facility/Beamline. Hier wird gegen die Hierarchie
// geprueft: ein Paar, das nicht zusammenpasst, wird korrigiert, wenn die
// Beamline eindeutig zu einer anderen Facility gehoert, sonst bleibt nur die
// Facility stehen. Doppelte Paare fallen weg.
function normalisiereFacilities(liste) {
    const gesehen = new Set();
    const ergebnis = [];
    (Array.isArray(liste) ? liste : []).forEach(r => {
        if (!r) return;
        let facility = PSI_FACILITIES.indexOf(r.facility) !== -1 ? r.facility : null;
        let beamline = typeof r.beamline === 'string' ? r.beamline : null;

        if (beamline) {
            const eigene = facility ? PSI_FACILITY_BEAMLINES[facility] : [];
            if (eigene.indexOf(beamline) === -1) {
                const heimat = PSI_FACILITIES.filter(f => PSI_FACILITY_BEAMLINES[f].indexOf(beamline) !== -1);
                if (heimat.length === 1) facility = heimat[0];   // eindeutig: Facility berichtigen
                else beamline = null;                            // unbekannt oder mehrdeutig
            }
        }
        if (!facility) return;
        const schluessel = facility + '|' + (beamline || '');
        if (gesehen.has(schluessel)) return;
        gesehen.add(schluessel);
        ergebnis.push({ facility: facility, beamline: beamline });
    });
    return ergebnis;
}

const HAIKU_TOOL = {
    name: 'record_metadata',
    description: 'Gibt die aus dem Artikel gelesenen bibliografischen Angaben zurueck.',
    input_schema: {
        type: 'object',
        properties: {
            title: { type: ['string', 'null'], description: 'Titel des Artikels, wie im PDF gedruckt' },
            title_dora: { type: ['string', 'null'], description: 'Titel nach den DORA-Hausregeln (siehe Prompt), nur wenn der Artikel englisch ist; sonst null' },
            language: { type: 'string', enum: ['zho', 'bul', 'hrv', 'ces', 'dan', 'nld', 'eng', 'fin', 'fra', 'kat', 'deu', 'hun', 'ind', 'ita', 'jpn', 'lav', 'lit', 'fas', 'pol', 'por', 'ron', 'roh', 'swe', 'tur', 'ukr', 'rus', 'slv', 'spa', 'vie', 'other'], description: 'Sprache des Artikels als ISO-639-3-Code; bei zweisprachigen Artikeln die Sprache, mit der das Dokument beginnt; "other", wenn die Sprache nicht in der Liste steht' },
            volume: { type: ['string', 'null'], description: 'Volume/Band nur als Zahl ("Vol. 7" -> "7"); null, wenn keiner angegeben ist' },
            issue: { type: ['string', 'null'], description: 'Heftnummer nur als Zahl ("No. 35" -> "35"); Supplement als "Suppl. x", Special Issue als "Spec. Iss."; Bereiche mit Bindestrich ("05/06" -> "5-6"); null, wenn keine angegeben ist' },
            first_page: { type: ['string', 'null'], description: 'Erste Seite laut gedruckter Seitenzaehlung der publizierten Version (Kopf-/Fusszeile), nicht der Index im PDF; null, wenn das PDF keine solche Zaehlung traegt' },
            last_page: { type: ['string', 'null'], description: 'Letzte Seite laut gedruckter Seitenzaehlung; null, wenn nicht ermittelbar' },
            article_number: { type: ['string', 'null'], description: 'Artikelnummer (z.B. "A08103", "033375", "e12345"), wenn die Zeitschrift statt Seitenzahlen eine Artikelnummer nutzt; sonst null' },
            container_title: { type: ['string', 'null'], description: 'Titel des Buches bzw. Konferenzbandes (nicht der Zeitschrift), in dem der Beitrag erschien; sonst null' },
            conference_name: { type: ['string', 'null'], description: 'Name der Konferenz, falls genannt; sonst null' },
            conference_place: { type: ['string', 'null'], description: 'Ort der Konferenz, falls genannt; sonst null' },
            conference_date: { type: ['string', 'null'], description: 'Datum bzw. Zeitraum der Konferenz wie gedruckt (z.B. "12-16 June 2023"), falls genannt; sonst null' },
            series_title: { type: ['string', 'null'], description: 'Titel der Buch- oder Berichtsreihe, falls genannt; bei unklaren Serientiteln wie "Berichte" oder "Richtlinien" die Institution davor mit Doppelpunkt ("Nagra: Report"); sonst null' },
            academic_title: { type: ['string', 'null'], description: 'Akademischer Grad der Abschlussarbeit wie gedruckt (z.B. "Doctor of Sciences of ETH Zurich", "Master of Science"), nur bei Dissertationen/Master-/Bachelorarbeiten; sonst null' },
            degree_granting_institution: { type: ['string', 'null'], description: 'Hochschule, die den Grad verleiht (z.B. "ETH Zurich"), nur bei Abschlussarbeiten; sonst null' },
            supervisors: {
                type: 'array',
                description: 'Betreuer/Referenten/Korreferenten einer Abschlussarbeit in gedruckter Reihenfolge; sonst leeres Array',
                items: {
                    type: 'object',
                    properties: { family: { type: 'string' }, given: { type: ['string', 'null'] } },
                    required: ['family', 'given']
                }
            },
            report_number: { type: ['string', 'null'], description: 'Nummer des Berichts (Report Number, z.B. "PSI Bericht 21-03", "NTB 19-04"), nur bei Berichten; sonst null' },
            sponsor: { type: ['string', 'null'], description: 'Auftraggeber bzw. foerdernde Organisation eines Berichts ("Sponsoring Organization"), nur bei Berichten; sonst null' },
            series_volume: { type: ['string', 'null'], description: 'Band/Nummer innerhalb der Reihe, nur die Zahl; sonst null' },
            series_issn: { type: ['string', 'null'], description: 'ISSN der Reihe, falls genannt (Format 1234-5678); sonst null' },
            publisher: { type: ['string', 'null'], description: 'Verlag (nur bei Buchkapiteln, Buechern, Berichten, Konferenzbaenden); bei Zeitschriftenartikeln null' },
            publication_place: { type: ['string', 'null'], description: 'Verlagsort, falls genannt; sonst null' },
            edition: { type: ['string', 'null'], description: 'Auflage (z.B. "2nd ed."), falls genannt; sonst null' },
            isbn: { type: ['string', 'null'], description: 'ISBN des Buches/Bandes wie gedruckt (mit Bindestrichen, wenn so gedruckt); sonst null' },
            year: { type: ['string', 'null'], description: 'Publikationsjahr der publizierten Version (vierstellig); sonst null' },
            editors: {
                type: 'array',
                description: 'Herausgeber des Buches/Bandes in gedruckter Reihenfolge; leeres Array, wenn keine genannt sind',
                items: {
                    type: 'object',
                    properties: { family: { type: 'string' }, given: { type: ['string', 'null'] } },
                    required: ['family', 'given']
                }
            },
            title_language: { type: 'string', enum: ['eng', 'deu', 'fra', 'ita', 'other'], description: 'Sprache des Artikeltitels' },
            funding_items: {
                type: 'array',
                description: 'Einzelne Projekte/Grants aus Funding bzw. Acknowledgements; leeres Array, wenn keine Nummern genannt sind',
                items: {
                    type: 'object',
                    properties: {
                        funder: { type: 'string', description: 'Foerderer im Wortlaut des PDF (z.B. "Swiss National Science Foundation", "SNSF", "European Union\'s Horizon 2020")' },
                        award_number: { type: 'string', description: 'Projekt-/Grant-Nummer im Wortlaut des PDF (z.B. "200021_203578", "grant agreement No 654360")' },
                        programme: { type: ['string', 'null'], description: 'Rahmenprogramm, falls genannt (z.B. "Horizon 2020", "FP7", "Horizon Europe"), sonst null' }
                    },
                    required: ['funder', 'award_number', 'programme']
                }
            },
            abstract: { type: ['string', 'null'], description: 'Vollstaendiger Abstract-Text ohne die Ueberschrift "Abstract"; null, wenn keiner vorhanden ist' },
            keywords: { type: 'array', items: { type: 'string' }, description: 'Vom Autor angegebene Schlagwoerter; leeres Array, wenn keine genannt sind. Nichts erfinden.' },
            funding: { type: ['string', 'null'], description: 'Foerderangaben (Foerderer, Grant-Nummern) aus Funding/Acknowledgements als ein Text; null, wenn keine vorhanden sind' },
            authors: {
                type: 'array',
                description: 'Alle Autoren in der gedruckten Reihenfolge, mit ihren Affiliationen laut PDF',
                items: {
                    type: 'object',
                    properties: {
                        family: { type: 'string', description: 'Nachname' },
                        given: { type: ['string', 'null'], description: 'Vorname(n) bzw. Initialen, wie gedruckt' },
                        affiliations: { type: 'array', items: { type: 'string' }, description: 'Die Affiliationen dieses Autors woertlich aus dem PDF (Fussnoten-Zeichen aufgeloest); leeres Array, wenn keine angegeben ist' },
                        department: { type: ['string', 'null'], description: 'Abteilung/Department/Group/Laboratory des Instituts im Wortlaut, falls die Affiliation eine solche Einheit nennt; sonst null' },
                        institute: { type: ['string', 'null'], enum: ['eawag', 'empa', 'wsl', 'psi', null], description: 'Zu welchem der vier Institute der Autor laut seinen Affiliationen gehoert; null, wenn zu keinem' },
                        corresponding: { type: 'boolean', description: 'true, wenn als Corresponding Author gekennzeichnet' }
                    },
                    required: ['family', 'given', 'affiliations', 'department', 'institute', 'corresponding']
                }
            },
            research_facilities: {
                type: 'array',
                description: 'Im Artikel genutzte PSI-Grossforschungsanlagen und Strahllinien/Instrumente (nur bei PSI-Datensaetzen); sonst leeres Array',
                items: {
                    type: 'object',
                    properties: {
                        facility: { type: 'string', enum: PSI_FACILITIES, description: 'Anlage, genau einer der erlaubten Werte' },
                        beamline: { type: ['string', 'null'], description: 'Strahllinie/Instrument, genau einer der unter der gewaehlten Facility erlaubten Werte; null, wenn keine zuordenbar ist oder die Facility keine Beamlines fuehrt' }
                    },
                    required: ['facility', 'beamline']
                }
            }
        },
        required: ['title', 'title_dora', 'title_language', 'language', 'volume', 'issue', 'first_page', 'last_page', 'article_number', 'container_title', 'conference_name', 'conference_place', 'conference_date', 'series_title', 'academic_title', 'degree_granting_institution', 'supervisors', 'report_number', 'sponsor', 'series_volume', 'series_issn', 'publisher', 'publication_place', 'edition', 'isbn', 'year', 'editors', 'abstract', 'keywords', 'funding', 'funding_items', 'authors', 'research_facilities']
    }
};

const HAIKU_PROMPT = 'Lies diesen wissenschaftlichen Artikel und liefere die bibliografischen Angaben '
    + 'ueber das Tool record_metadata. Uebernimm Texte woertlich aus dem PDF, ohne sie zu kuerzen oder '
    + 'umzuformulieren, und erfinde nichts: was im PDF nicht steht, bleibt null bzw. leer.';

// Die vier Institute des ETH-Bereichs, die DORA fuehrt. Haiku soll jedem Autor
// ansehen, zu welchem er gehoert - und der Datensatz wird immer fuer genau
// eines davon bearbeitet.
const HAIKU_INSTITUTE = {
    eawag: 'Eawag (Swiss Federal Institute of Aquatic Science and Technology; Dübendorf, Kastanienbaum)',
    empa: 'Empa (Swiss Federal Laboratories for Materials Science and Technology; Dübendorf, St. Gallen, Thun)',
    wsl: 'WSL (Swiss Federal Institute for Forest, Snow and Landscape Research; Birmensdorf, Davos mit dem SLF, Lausanne, Bellinzona, Cadenazzo, Sion)',
    psi: 'PSI (Paul Scherrer Institut / Paul Scherrer Institute; Villigen, Würenlingen)'
};

function haikuPromptFuer(institut) {
    let text = HAIKU_PROMPT
        + '\n\nZum Titel: title ist der Titel wie gedruckt. title_dora nur bei englischen Artikeln: derselbe Titel in Sentence case nach den DORA-Regeln - '
        + 'Grossbuchstabe nur am Satzanfang und bei Eigennamen (Personen, Orte, Institutionen, Verfahrens- und Gesetzesnamen), Abkuerzungen, Elementsymbolen '
        + 'und chemischen Formeln (z.B. "BiFeO3", "NaCl", "DNA", "X-ray" mit grossem X). Nach einem Doppelpunkt oder Bindestrich klein, ausser es folgt ein vollstaendiger Satz. '
        + 'Gattungsnamen gross, Artnamen klein. Kein Punkt am Ende (ein Fragezeichen ist erlaubt). Bestehende Hoch-/Tiefstellung und Kursivdruck bleiben als HTML erhalten '
        + '(nur <sub>, <sup>, <em>, <u>), z.B. "BiFeO<sub>3</sub>"; kein Fettdruck. Hat der Titel einen Untertitel ohne Trennzeichen auf einer eigenen Zeile, trenne beide mit einem Punkt. '
        + 'Aendere sonst kein Wort und keine Satzzeichen. Ist der Artikel nicht englisch, ist title_dora null.'
        + '\n\nZu Volume, Issue und Seiten (DORA-Regeln): volume nur als Zahl; issue nur als Zahl, bei Supplement "Suppl. x", bei Special Issue "Spec. Iss.", Erstreckungen mit Bindestrich. '
        + 'Seiten nur aus der gedruckten Seitenzaehlung der publizierten Version (Kopf- oder Fusszeile, Zitierzeile), nie aus der Position im PDF. '
        + 'Traegt das PDF keine solche Zaehlung (z.B. ein akzeptiertes Manuskript), sind first_page und last_page null. '
        + 'Nutzt die Zeitschrift Artikelnummern statt Seitenzahlen, gib article_number an und lasse first_page/last_page null. '
        + 'Nichts schaetzen: was nicht im PDF steht, bleibt null. container_title, conference_name, conference_place, conference_date, series_*, report_number, sponsor, academic_title, degree_granting_institution und supervisors (die drei letzten nur bei Dissertationen sowie Master- und Bachelorarbeiten), publisher, publication_place, edition, isbn und editors nur fuer Buchkapitel, Buecher, Konferenzbeitraege und Berichte; bei Zeitschriftenartikeln null bzw. leeres Array. year ist das Erscheinungsjahr der publizierten Version.'
        + '\n\nZum Funding: funding_items nennt jedes Projekt einzeln mit Foerderer und Nummer, genau wie im PDF geschrieben. Nur Angaben mit einer Projekt- oder Grant-Nummer; '
        + 'blosse Danksagungen ohne Nummer gehoeren nur in funding.'
        + '\n\nZu den Autoren: Gib alle Autoren in der gedruckten Reihenfolge an, je mit den Affiliationen aus dem PDF '
        + '(Fussnoten-Zeichen wie ¹, a, * aufloesen). Ordne jeden Autor, falls zutreffend, einem der vier Institute zu, '
        + 'die DORA fuehrt:\n- ' + Object.keys(HAIKU_INSTITUTE).map(k => k + ': ' + HAIKU_INSTITUTE[k]).join('\n- ')
        + '\nMassgeblich ist die Affiliation im PDF, nicht der Name. Eine andere Hochschule oder Firma ist kein Treffer '
        + '(z.B. ETH Zürich, EPFL, Universität Zürich: institute = null); ebenso kein Treffer: ein Kooperationspartner, der nur das Institut erwähnt.';
    if (institut === 'psi') {
        text += '\n\nZu research_facilities: Nenne jede im Artikel tatsaechlich genutzte PSI-Anlage (Methoden-/Experimentteil, '
            + 'Acknowledgements) mit ihrer Strahllinie bzw. ihrem Instrument. Erlaubt sind nur diese Facilities mit ihren Beamlines:\n'
            + PSI_FACILITIES.map(f => '- ' + f + (PSI_FACILITY_BEAMLINES[f].length ? ': ' + PSI_FACILITY_BEAMLINES[f].join(' | ') : ' (keine Beamlines)')).join('\n') + '\n'
            + 'Die Beamline muss zur gewaehlten Facility gehoeren (z.B. TOMCAT nur unter SLS).\n'
            + 'Nutze die Schreibweise der Liste (z.B. "Super-XAS", "cSAXS", "ARAMIS-Bernina"). Eine blosse Erwaehnung in der Literaturliste '
            + 'oder im Vergleich mit anderen Arbeiten zaehlt nicht. Anlagen anderer Einrichtungen (ESRF, ILL, Diamond, ...) sind '
            + 'facility "non-PSI large scale facility (e.g. ESRF, ILL, etc.)" mit beamline null. Passt eine Strahllinie nicht zur Liste, '
            + 'gib nur die Anlage an (beamline null). Wurde nichts davon genutzt: leeres Array.';
    } else {
        text += '\n\nresearch_facilities: leeres Array (nur bei PSI-Datensaetzen relevant).';
    }
    if (HAIKU_INSTITUTE[institut]) {
        text += '\n\nDer Datensatz wird gerade fuer das Institut ' + institut.toUpperCase() + ' bearbeitet. '
            + 'Achte bei den Affiliationen besonders genau auf Autoren dieses Instituts und gib deren Affiliation vollstaendig wieder.';
    }
    return text;
}

async function haikuEinstellungen() {
    const gespeichert = await chrome.storage.local.get({ anthropicApiKey: '', haikuModel: '' });
    return {
        schluessel: (gespeichert.anthropicApiKey || '').trim(),
        modell: (gespeichert.haikuModel || '').trim() || HAIKU_MODEL_STANDARD
    };
}

// Eine Anfrage an Haiku mit erzwungenem Tool-Aufruf; liefert dessen Eingabe
// (das strukturierte Ergebnis) zurueck.
async function haikuAnfrage(einstellungen, inhalt, tool, maxTokens) {
    let antwort;
    try {
        antwort = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-api-key': einstellungen.schluessel,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
            model: einstellungen.modell,
            max_tokens: maxTokens,
            tools: [tool],
            tool_choice: { type: 'tool', name: tool.name },
            messages: [{ role: 'user', content: inhalt }]
        })
        });
    } catch (e) {
        throw new Error('api.anthropic.com nicht erreichbar (' + e.message + '). '
            + 'Netzwerk/Proxy/Firewall prüfen und in Firefox unter about:addons > Berechtigungen den Zugriff auf alle Websites erlauben.');
    }

    if (!antwort.ok) {
        let detail = '';
        try { detail = (await antwort.json()).error.message; } catch (e) { /* kein JSON */ }
        if (antwort.status === 401) throw new Error('Anthropic lehnt den API-Schlüssel ab (401).');
        throw new Error('Anthropic-API ' + antwort.status + (detail ? ': ' + detail : ''));
    }

    const nachricht = await antwort.json();
    const aufruf = (nachricht.content || []).find(b => b.type === 'tool_use');
    if (!aufruf || !aufruf.input) throw new Error('Haiku lieferte keine strukturierte Antwort.');
    if (nachricht.stop_reason === 'max_tokens') throw new Error('Haiku-Antwort wurde abgeschnitten (zu lang).');
    aufruf.input.__modell = nachricht.model || einstellungen.modell;
    return aufruf.input;
}

// Ein PDF (Blob oder oeffentliche URL) von Haiku auswerten lassen.
// Rueckgabe im Format, das die Seite schon kennt (status/page_count/keywords/...).
async function analysiereMitHaiku(quelle, institut) {
    const einstellungen = await haikuEinstellungen();
    if (!einstellungen.schluessel) {
        throw new Error('Kein Anthropic-API-Schlüssel hinterlegt (Einstellungen des Helpers).');
    }

    let dokument;
    let seitenzahl = 0;
    if (quelle.blob) {
        const bytes = new Uint8Array(await quelle.blob.arrayBuffer());
        if (bytes.length > HAIKU_PDF_BYTES_MAX) {
            throw new Error('PDF zu groß für die Auswertung (' + Math.round(bytes.length / 1048576) + ' MB, erlaubt ca. 22 MB).');
        }
        if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4]) !== '%PDF-') {
            throw new Error('Die Datei ist kein PDF (vermutlich eine Sperr- oder Fehlerseite).');
        }
        let roh = '';
        const block = 0x8000;
        for (let i = 0; i < bytes.length; i += block) {
            roh += String.fromCharCode.apply(null, bytes.subarray(i, i + block));
        }
        seitenzahl = zaehlePdfSeiten(roh);
        dokument = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: btoa(roh) } };
    } else if (quelle.url) {
        // Fallback ohne eigenen Download: die API holt die Datei selbst
        dokument = { type: 'document', source: { type: 'url', url: quelle.url } };
    } else {
        throw new Error('Weder Datei noch URL zum Auswerten.');
    }

    const e = await haikuAnfrage(einstellungen, [dokument, { type: 'text', text: haikuPromptFuer(institut) }], HAIKU_TOOL, 8192);

    return {
        status: 'success',
        page_count: seitenzahl || null,
        title: e.title || null,
        abstract: e.abstract || null,
        keywords: Array.isArray(e.keywords) ? e.keywords.filter(k => typeof k === 'string' && k.trim()) : [],
        funding: e.funding || null,
        title_dora: (e.title_language === 'eng' && e.title_dora) ? String(e.title_dora).trim() : null,
        title_language: e.title_language || null,
        language: e.language && e.language !== 'other' ? e.language : null,
        volume: nurText(e.volume), issue: nurText(e.issue),
        first_page: nurText(e.first_page), last_page: nurText(e.last_page), article_number: nurText(e.article_number),
        container_title: nurText(e.container_title), conference_name: nurText(e.conference_name), conference_place: nurText(e.conference_place), conference_date: nurText(e.conference_date), series_title: nurText(e.series_title), report_number: nurText(e.report_number), sponsor: nurText(e.sponsor),
        academic_title: nurText(e.academic_title), degree_granting_institution: nurText(e.degree_granting_institution),
        supervisors: (Array.isArray(e.supervisors) ? e.supervisors : []).filter(x => x && nurText(x.family)).map(x => ({ family: nurText(x.family), given: nurText(x.given) || '' })),
        series_volume: nurText(e.series_volume), series_issn: nurText(e.series_issn), publisher: nurText(e.publisher),
        publication_place: nurText(e.publication_place), edition: nurText(e.edition), isbn: nurText(e.isbn),
        year: (nurText(e.year) || '').match(/^\d{4}$/) ? nurText(e.year) : null,
        editors: (Array.isArray(e.editors) ? e.editors : []).filter(x => x && nurText(x.family)).map(x => ({ family: nurText(x.family), given: nurText(x.given) || '' })),
        funding_projects: (await baueFundingItemsAusPdf(e.funding_items)),
        authors: Array.isArray(e.authors) ? e.authors.filter(a => a && a.family) : [],
        institut: HAIKU_INSTITUTE[institut] ? institut : '',
        research_facilities: normalisiereFacilities(e.research_facilities),
        model: e.__modell
    };
}

// PDF-Bytes aus der Adresse holen und auswerten (fuer die automatische
// Auswertung nach der PDF-Suche). Elsevier-Links laufen ueber den Schluessel
// im Hintergrund, deshalb dieselbe Abruflogik wie bei der Vorschau.
async function analysiereMitHaikuAusAuftrag(auftrag) {
    const institut = auftrag.institut || '';
    let url = auftrag.url;
    if (auftrag.elsevierDoi) {
        const schluessel = await elsevierSchluessel();
        if (!schluessel) throw new Error('Kein Scopus/Elsevier-Schlüssel hinterlegt.');
        url = elsevierPdfUrl(auftrag.elsevierDoi, schluessel, await elsevierInsttoken());
    }
    if (!url) throw new Error('Keine URL angegeben.');
    const antwort = await fetch(url, { credentials: 'include', redirect: 'follow' });
    if (!antwort.ok) throw new Error('HTTP ' + antwort.status);
    return analysiereMitHaiku({ blob: await antwort.blob() }, institut);
}

// data:-URL ohne fetch() in ein Blob wandeln: die CSP der Erweiterung
// (connect-src) erlaubt keine data:-Adressen, ein fetch() darauf scheitert
// mit "NetworkError".
function dataUrlZuBlob(dataUrl) {
    const komma = dataUrl.indexOf(',');
    if (komma < 0) throw new Error('Ungültige data-URL.');
    const kopf = dataUrl.slice(0, komma);
    const roh = atob(dataUrl.slice(komma + 1));
    const bytes = new Uint8Array(roh.length);
    for (let i = 0; i < roh.length; i++) bytes[i] = roh.charCodeAt(i);
    const typ = /^data:([^;,]+)/.exec(kopf);
    return new Blob([bytes], { type: typ ? typ[1] : 'application/pdf' });
}

// ---------------------------------------------------------------------------
// PDF-Abgleich beim Upload (pdf_abgleich.js): Text der ersten Seiten lokal
// mit pdf.js lesen. pdf.js wird erst bei Bedarf geladen.
// ---------------------------------------------------------------------------
let pdfJsLaden = null;

function ladePdfJs() {
    if (globalThis.pdfjsLib) return Promise.resolve(globalThis.pdfjsLib);
    if (!pdfJsLaden) {
        pdfJsLaden = new Promise((resolve, reject) => {
            const skript = document.createElement('script');
            skript.src = chrome.runtime.getURL('pdf.min.js');
            skript.onload = () => {
                globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.js');
                resolve(globalThis.pdfjsLib);
            };
            skript.onerror = () => { pdfJsLaden = null; reject(new Error('pdf.js konnte nicht geladen werden.')); };
            document.head.appendChild(skript);
        });
    }
    return pdfJsLaden;
}

async function pdfAbgleichText(dataUrl) {
    const pdfjs = await ladePdfJs();
    const bytes = new Uint8Array(await dataUrlZuBlob(dataUrl).arrayBuffer());
    const dokument = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    try {
        const seiten = dokument.numPages;
        const teile = [];
        for (let nr = 1; nr <= Math.min(3, seiten); nr++) {
            const seite = await dokument.getPage(nr);
            const inhalt = await seite.getTextContent();
            teile.push(inhalt.items.map(i => i.str + (i.hasEOL ? '\n' : ' ')).join(''));
        }
        let metaText = '';
        try {
            const meta = await dokument.getMetadata();
            const info = meta && meta.info ? meta.info : {};
            metaText = [info.Title, info.Subject, info.Author, info.Keywords].filter(Boolean).join('\n');
            if (meta && meta.metadata) {
                metaText += '\n' + (typeof meta.metadata.getRaw === 'function'
                    ? meta.metadata.getRaw()
                    : JSON.stringify(meta.metadata.getAll ? meta.metadata.getAll() : {}));
            }
        } catch (e) { /* Metadaten sind optional */ }
        return { seiten, text: teile.join('\n').slice(0, 30000), metaText: metaText.slice(0, 20000) };
    } finally {
        dokument.destroy();
    }
}

async function pdfAbgleichCrossref(doi) {
    const daten = await holeJson(`https://api.crossref.org/works/${encodeURIComponent(doi)}?mailto=${PDF_KONTAKT}`);
    const werk = daten && daten.message;
    if (!werk) return null;
    const titel = (werk.title || []).concat(werk['original-title'] || []);
    if (werk.title && werk.title[0] && werk.subtitle && werk.subtitle[0]) titel.push(werk.title[0] + ': ' + werk.subtitle[0]);
    return {
        titel: titel.filter(Boolean).slice(0, 4),
        autoren: (werk.author || []).map(a => a.family || a.name || '').filter(Boolean).slice(0, 10)
    };
}

async function analyzePdf(dataUrl, institut) {
    try {
        // Convert Data URL back to Blob
        const blob = dataUrlZuBlob(dataUrl);

        return await analysiereMitHaiku({ blob: blob }, institut);
    } catch (e) {
        throw new Error("PDF-Auswertung fehlgeschlagen: " + e.message);
    }
}

async function analyzePdfViaTab(pdfUrl, institut) {
    console.log('analyzePdfViaTab called with:', pdfUrl);

    try {
        const isBlob = pdfUrl.startsWith('blob:');

        // Check if there's already a tab with this URL
        const existingTabs = await chrome.tabs.query({});
        let targetTab = null;
        let shouldCloseTab = false;

        // Strategy 1: Exact URL match
        targetTab = existingTabs.find(t => t.url === pdfUrl);

        // Strategy 2: For blob URLs, try to find by tab ID from pdfTabMap
        if (!targetTab && isBlob && pdfTabMap.has(pdfUrl)) {
            const tabId = pdfTabMap.get(pdfUrl);
            targetTab = existingTabs.find(t => t.id === tabId);
            if (targetTab) {
                console.log('Found blob tab via pdfTabMap:', targetTab.id);
            }
        }

        // Strategy 3: For blob URLs, try matching by origin
        if (!targetTab && isBlob) {
            const blobOrigin = pdfUrl.split('/').slice(0, 3).join('/');
            targetTab = existingTabs.find(t => t.url && t.url.startsWith(blobOrigin));
            if (targetTab) {
                console.log('Found blob tab via origin match:', targetTab.id);
            }
        }

        // If no existing tab found
        if (!targetTab) {
            // Blob URLs cannot be loaded in a new tab - they are context-specific
            if (isBlob) {
                throw new Error('Blob URL detected but no matching tab found. The PDF tab may have been closed.');
            }

            // For regular URLs, create a new tab
            console.log('Creating new tab for PDF:', pdfUrl);
            shouldCloseTab = true; // Mark for closure
            targetTab = await chrome.tabs.create({
                url: pdfUrl,
                active: false // Open in background
            });

            // Wait for the tab to load
            await new Promise((resolve) => {
                const listener = (tabId, changeInfo) => {
                    if (tabId === targetTab.id && changeInfo.status === 'complete') {
                        chrome.tabs.onUpdated.removeListener(listener);
                        resolve();
                    }
                };
                chrome.tabs.onUpdated.addListener(listener);

                // Timeout after 15 seconds
                setTimeout(() => {
                    chrome.tabs.onUpdated.removeListener(listener);
                    resolve();
                }, 15000);
            });

            // Additional wait for PDF viewer to initialize
            await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
            console.log('Using existing tab:', targetTab.id);
        }

        console.log('Injecting script into tab:', targetTab.id);

        // Inject script to fetch PDF from same origin
        // For blob URLs, we need access to PDFViewerApplication (MAIN world)
        // For regular URLs, ISOLATED world is sufficient
        const results = await chrome.scripting.executeScript({
            target: { tabId: targetTab.id, allFrames: true },
            world: isBlob ? 'MAIN' : undefined, // MAIN world for blob URLs to access PDFViewerApplication
            func: async (isBlobUrl) => {
                try {
                    // Helper to convert blob to data URL
                    const blobToDataURL = (blob) => {
                        return new Promise((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result);
                            reader.onerror = reject;
                            reader.readAsDataURL(blob);
                        });
                    };

                    // Helper to wait for PDFViewerApplication
                    const waitForPdfViewer = (maxWait = 5000) => {
                        return new Promise((resolve) => {
                            if (typeof window.PDFViewerApplication !== 'undefined' && window.PDFViewerApplication.pdfDocument) {
                                resolve(true);
                                return;
                            }
                            const startTime = Date.now();
                            const checkInterval = setInterval(() => {
                                if (typeof window.PDFViewerApplication !== 'undefined' && window.PDFViewerApplication.pdfDocument) {
                                    clearInterval(checkInterval);
                                    resolve(true);
                                } else if (Date.now() - startTime > maxWait) {
                                    clearInterval(checkInterval);
                                    resolve(false);
                                }
                            }, 100);
                        });
                    };

                    let blob = null;

                    // Strategy 1: For blob URLs or Firefox PDF viewer - use PDFViewerApplication
                    if (isBlobUrl || typeof window.PDFViewerApplication !== 'undefined') {
                        console.log('Waiting for PDFViewerApplication...');
                        const pdfViewerReady = await waitForPdfViewer();

                        if (pdfViewerReady && window.PDFViewerApplication && window.PDFViewerApplication.pdfDocument) {
                            console.log('Using PDFViewerApplication.getData()');
                            const data = await window.PDFViewerApplication.pdfDocument.getData();
                            blob = new Blob([data], { type: 'application/pdf' });
                        }
                    }

                    // Strategy 2: Fetch the current URL (for regular PDF links)
                    if (!blob) {
                        console.log('Fetching PDF from current URL');
                        const response = await fetch(window.location.href, {
                            credentials: 'include',
                            cache: 'no-cache'
                        });

                        if (response.ok) {
                            const contentType = response.headers.get('content-type');
                            console.log('Response content-type:', contentType);

                            // Accept PDF or octet-stream
                            if (contentType && (contentType.includes('pdf') || contentType.includes('octet-stream'))) {
                                blob = await response.blob();
                            } else {
                                // Sometimes the content-type is missing, try anyway
                                blob = await response.blob();
                            }
                        }
                    }

                    if (blob && blob.size > 1000) {
                        console.log('PDF fetched successfully, size:', blob.size);
                        return await blobToDataURL(blob);
                    }

                    throw new Error('Could not extract PDF from page (blob too small or missing)');
                } catch (error) {
                    console.error('PDF extraction error:', error);
                    return { error: error.message };
                }
            },
            args: [isBlob]
        });

        // Close the tab if we created it
        if (shouldCloseTab) {
            console.log('Closing temporary tab');
            try {
                await chrome.tabs.remove(targetTab.id);
            } catch (e) {
                console.warn('Failed to close tab:', e);
            }
        }

        if (!results || !results[0] || !results[0].result) {
            throw new Error('Failed to extract PDF from tab - no result returned');
        }

        const result = results[0].result;

        // Check if result is an error object
        if (result && typeof result === 'object' && result.error) {
            throw new Error('PDF extraction failed: ' + result.error);
        }

        if (typeof result !== 'string' || !result.startsWith('data:')) {
            throw new Error('Invalid result format - expected data URL');
        }

        const dataUrl = result;
        console.log('PDF extracted, sending to analyzer');

        // Convert data URL back to blob and send to analyzer
        const blob = dataUrlZuBlob(dataUrl);

        return await analysiereMitHaiku({ blob: blob }, institut);
    } catch (e) {
        console.error('analyzePdfViaTab error:', e);

        // FALLBACK: die Anthropic-API die oeffentliche URL selbst holen lassen
        // (klappt nicht bei Blob-URLs und hinter Login)
        if (!pdfUrl.startsWith('blob:') && !/^Kein Anthropic/.test(e.message)) {
            try {
                return await analysiereMitHaiku({ url: pdfUrl }, institut);
            } catch (fallbackError) {
                console.error('Fallback also failed:', fallbackError);
            }
        }

        throw new Error("Failed to analyze PDF via tab: " + e.message);
    }
}

async function analyzePdfUrl(pdfUrl, institut) {
    try {
        let blob = null;
        let usePythonDownload = false;

        // 2. Versuch: Aus offenem Tab laden (Browser Cache / Session)
        // Dies umgeht Login-Probleme, da wir den Inhalt direkt aus dem Tab holen
        if (!blob && pdfUrl && !pdfUrl.startsWith('file:')) {
            try {
                const tabs = await chrome.tabs.query({});
                let targetTab = null;

                console.log(`Looking for PDF tab. Total tabs: ${tabs.length}, PDF URL: ${pdfUrl}`);

                // Strategie 1: Bekannte Tab-ID aus onUpdated (Beste Methode für Blobs)
                if (pdfTabMap.has(pdfUrl)) {
                    const id = pdfTabMap.get(pdfUrl);
                    targetTab = tabs.find(t => t.id === id);
                    if (targetTab) console.log(`Found tab via pdfTabMap: ${targetTab.id}`);
                }

                // Strategie 2: Exakter Match
                if (!targetTab) {
                    targetTab = tabs.find(t => t.url === pdfUrl);
                    if (targetTab) console.log(`Found tab via exact URL match: ${targetTab.id}`);
                }

                // Strategie 3: Blob URL - match by origin
                if (!targetTab && pdfUrl.startsWith('blob:')) {
                    // Extract origin from blob URL
                    const blobOrigin = pdfUrl.split('/').slice(0, 3).join('/');
                    targetTab = tabs.find(t => t.url && t.url.startsWith('blob:') && t.url.startsWith(blobOrigin));
                    if (targetTab) console.log(`Found tab via blob origin match: ${targetTab.id}`);
                }

                // 3. Versuch: Suche über den Referrer (Wichtig für Elsevier/ScienceDirect)
                if (!targetTab && pdfReferrerMap.has(pdfUrl)) {
                    const referrer = pdfReferrerMap.get(pdfUrl);
                    targetTab = tabs.find(t => t.url === referrer);
                }

                if (targetTab && targetTab.id) {
                    const results = await chrome.scripting.executeScript({
                        target: { tabId: targetTab.id, allFrames: true },
                        world: 'MAIN', // WICHTIG: Zugriff auf window.PDFViewerApplication der Seite
                        args: [pdfUrl],
                        func: async (targetUrl) => {
                            const readBlob = (b) => new Promise(resolve => {
                                const reader = new FileReader();
                                reader.onloadend = () => resolve(reader.result);
                                reader.readAsDataURL(b);
                            });

                            // Helper to wait for PDFViewerApplication
                            const waitForPdfViewer = (maxWait = 3000) => {
                                return new Promise((resolve) => {
                                    const startTime = Date.now();
                                    const checkInterval = setInterval(() => {
                                        if (window.PDFViewerApplication && window.PDFViewerApplication.pdfDocument) {
                                            clearInterval(checkInterval);
                                            resolve(true);
                                        } else if (Date.now() - startTime > maxWait) {
                                            clearInterval(checkInterval);
                                            resolve(false);
                                        }
                                    }, 100);
                                });
                            };

                            try {
                                // 1. Firefox / PDF.js Viewer (Direct Memory Access)
                                // Wait for PDFViewerApplication to be ready
                                const pdfViewerReady = await waitForPdfViewer();
                                if (pdfViewerReady && window.PDFViewerApplication && window.PDFViewerApplication.pdfDocument) {
                                    const data = await window.PDFViewerApplication.pdfDocument.getData();
                                    const blob = new Blob([data], { type: 'application/pdf' });
                                    return await readBlob(blob);
                                }

                                // 2. Versuch: Fetch der Ziel-URL (z.B. blob: oder session URL)
                                // Only try if it's a blob URL and matches current origin
                                if (targetUrl && targetUrl.startsWith('blob:')) {
                                    try {
                                        const res = await fetch(targetUrl);
                                        if (res.ok) {
                                            const blob = await res.blob();
                                            if (blob.type === 'application/pdf' || blob.size > 1000) {
                                                return await readBlob(blob);
                                            }
                                        }
                                    } catch (e) {
                                        console.warn('Blob fetch failed:', e);
                                    }
                                }

                                // 3. Fallback: Fetch window.location.href (falls der Tab das PDF direkt anzeigt)
                                if (window.location.href && window.location.href.startsWith('blob:')) {
                                    const res = await fetch(window.location.href);
                                    if (res.ok) {
                                        const blob = await res.blob();
                                        if (blob.type === 'application/pdf' || blob.size > 1000) {
                                            return await readBlob(blob);
                                        }
                                    }
                                }

                                return null;
                            } catch (e) {
                                console.error('PDF extraction error:', e);
                                return null;
                            }
                        }
                    });

                    const validResult = results.find(r => r.result);

                    if (validResult && validResult.result && validResult.result.error) {
                        throw new Error(validResult.result.error);
                    }

                    if (validResult) {
                        const res = await fetch(validResult.result);
                        blob = await res.blob();
                        console.log("PDF erfolgreich aus Tab-Kontext geladen.");
                    }
                }
            } catch (e) {
                console.warn("Tab-Injection fehlgeschlagen:", e);
            }
        }

        // 3. Versuch: Netzwerk-Fetch (Fallback)
        if (!blob) {
            // Blob-URLs können vom Background-Script nicht geladen werden -> Überspringen
            if (pdfUrl && pdfUrl.startsWith('blob:')) {
                console.warn("Blob-URL erkannt, Netzwerk-Fallback übersprungen (kein Zugriff möglich).");
            } else {
                let pdfRes;
                try {
                    pdfRes = await fetch(pdfUrl, { credentials: 'include' });
                } catch (e) {
                    try {
                        // Fallback 1: Ohne Credentials & ohne Referrer
                        pdfRes = await fetch(pdfUrl, { credentials: 'omit', referrerPolicy: 'no-referrer' });
                    } catch (e2) {
                        console.warn("Browser fetch failed (CORS), Anthropic holt die URL selbst:", e2);
                        usePythonDownload = true;
                    }
                }

                if (!usePythonDownload && (!pdfRes || !pdfRes.ok)) {
                    usePythonDownload = true;
                } else if (!usePythonDownload) {
                    // Check Content-Type (vermeide HTML Login-Seiten)
                    const cType = pdfRes.headers.get('Content-Type');
                    if (cType && !cType.toLowerCase().includes('pdf') && !cType.toLowerCase().includes('octet-stream')) {
                        console.warn("Background Fetch returned non-PDF (likely HTML):", cType);
                        usePythonDownload = true;
                    } else {
                        blob = await pdfRes.blob();
                        if (blob.size < 2000) { // < 2KB ist verdächtig klein
                            console.warn("Blob too small, delegating to Python.");
                            blob = null;
                            usePythonDownload = true;
                        }
                    }
                }
            }
        }

        if (blob) {
            // Wir haben das PDF (lokal oder via Netzwerk)
            return await analysiereMitHaiku({ blob: blob }, institut);
        }
        if (pdfUrl && pdfUrl.startsWith('blob:')) {
            throw new Error("Zugriff auf PDF-Tab fehlgeschlagen (Blob-URL) und lokaler Dateizugriff nicht möglich.");
        }
        return await analysiereMitHaiku({ url: pdfUrl }, institut);
    } catch (e) {
        throw new Error("Failed to analyze PDF URL: " + e.message);
    }
}

/**
 * Proxy-Funktion für DORA Autocomplete-Anfragen.
 * Gibt das rohe JSON zurück, damit die content.js (v2.59+) 
 * flexibel zwischen Solr- und Authority-Daten unterscheiden kann.
 */
async function fetchDoraAutocomplete(url) {
    try {
        console.log('Fetching DORA Autocomplete from:', url);
        const res = await fetch(url, {
            credentials: 'include',
            mode: 'cors',
            cache: 'no-cache'
        });
        if (!res.ok) {
            console.error(`DORA Error: ${res.status} ${res.statusText}`);
            throw new Error(`DORA Error: ${res.status} ${res.statusText}`);
        }
        const data = await res.json();
        console.log('Autocomplete fetch successful');
        return data;
    } catch (e) {
        console.error("Autocomplete fetch error:", e);
        console.error("URL was:", url);
        console.error("Error details:", {
            message: e.message,
            name: e.name,
            stack: e.stack
        });
        // Weiterwerfen, damit der Aufrufer einen Fehlschlag von einem leeren
        // Trefferset unterscheiden kann (sonst sieht ein Timeout aus wie
        // "nicht im Vokabular").
        throw e;
    }
}

async function fetchScopusMetadata(doi, apiKey) {
    if (!apiKey) return null;

    const url = `https://api.elsevier.com/content/abstract/doi/${doi}?apiKey=${apiKey}&httpAccept=application/json`;

    try {
        const res = await fetch(url);

        if (!res.ok) {
            console.warn(`Scopus API Error: ${res.status}`);
            return { error: `HTTP ${res.status}` };
        }

        const data = await res.json();
        const core = data['abstracts-retrieval-response']?.coredata;
        const bib = data['abstracts-retrieval-response']?.item?.bibrecord?.head?.correspondence;

        // 1. OA Status & License
        const oaFlag = core?.['openaccessFlag'] === 'true';
        const oaType = core?.['openaccessType']; // e.g. "Gold", "Hybrid Gold", "Green"
        const oaStatus = core?.['openaccess']; // Int flag

        // 2. Affiliation (Lib4Ri Check)
        let isLib4Ri = false;
        let affilText = "Keine Corresponding-Author Daten";

        const isLib4RiCheck = (str) => {
            if (!str) return false;
            const s = str.toLowerCase();
            return s.includes('paul scherrer') || s.includes('psi') ||
                s.includes('eawag') || s.includes('empa') ||
                s.includes('wsl') || s.includes('forest, snow and landscape');
        };

        if (bib) {
            affilText = "";
            const corrs = Array.isArray(bib) ? bib : [bib];

            for (const c of corrs) {
                if (c.affiliation) {
                    const aff = c.affiliation;
                    let orgs = [];
                    if (Array.isArray(aff.organization)) {
                        orgs = aff.organization.map(o => o['$'] || o);
                    } else if (aff.organization) {
                        orgs = [aff.organization];
                    }

                    const fullText = orgs.join(', ') + (aff.country ? `, ${aff.country}` : '');
                    if (isLib4RiCheck(fullText)) {
                        isLib4Ri = true;
                    }
                    affilText += fullText + "; ";
                }
            }
            affilText = affilText.replace(/; $/, '');
        }

        return {
            oaFlag: oaFlag,
            oaType: oaType,
            oaStatus: oaStatus, // Raw value given by Scopus
            isLib4Ri: isLib4Ri,
            affiliation: affilText,
            raw: core // Keep raw for debug if needed
        };

    } catch (e) {
        console.error("Scopus Fetch Error:", e);
        return { error: e.message };
    }
}

// ---------------------------------------------------------------------------
// KI-Check des Datensatzes (per Knopf). Der Prompt besteht aus drei Teilen:
// den Hausregeln aus dem Handbuch (nur zu den befuellten Feldern), dem Stand
// des Formulars und einer Belegquelle (Crossref bzw. das ausgewertete PDF).
// Haiku meldet Abweichungen ueber einen erzwungenen Tool-Aufruf; "ref" zeigt
// auf die Nummer des Formularwertes, damit die Seite das Feld markieren kann.
// ---------------------------------------------------------------------------
const KI_CHECK_TOOL = {
    name: 'report_findings',
    description: 'Meldet die Abweichungen des Datensatzes von den Handbuchregeln und der Belegquelle.',
    input_schema: {
        type: 'object',
        properties: {
            findings: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        ref: { type: ['string', 'null'], description: 'Nummer des betroffenen Formularwertes (z.B. "f12"); null, wenn sich der Befund auf keinen einzelnen Wert bezieht' },
                        severity: { type: 'string', enum: ['fehler', 'hinweis'], description: 'fehler = verstoesst eindeutig gegen Regel oder Beleg; hinweis = unsicher oder Ermessenssache' },
                        problem: { type: 'string', description: 'Was nicht stimmt, in einem Satz' },
                        suggestion: { type: ['string', 'null'], description: 'Korrigierter Wert bzw. konkrete Handlung; null, wenn keiner angebbar ist' },
                        rule: { type: ['string', 'null'], description: 'Die Handbuchregel in hoechstens 200 Zeichen, auf die sich der Befund stuetzt; null, wenn der Befund aus dem Vergleich mit der Belegquelle folgt' }
                    },
                    required: ['ref', 'severity', 'problem', 'suggestion', 'rule']
                }
            }
        },
        required: ['findings']
    }
};

const KI_CHECK_PROMPT = 'Du pruefst einen Publikationsdatensatz aus dem Repositorium DORA (Lib4ri) vor der Freigabe.\n'
    + 'Unten stehen (1) die Hausregeln aus dem DORA-Handbuch, (2) der aktuelle Stand des Edit-Formulars, jeder Wert mit einer Nummer, '
    + 'und (3) eine Belegquelle zum Vergleich.\n\n'
    + 'Vorgehen:\n'
    + '- Melde nur Abweichungen, die du an einer Regel oder an der Belegquelle festmachen kannst. Rate nicht, und melde keine Geschmacksfragen.\n'
    + '- Leere Felder sind nicht dein Thema, ebenso Pflichtfelder, das Seitenformat und die Lizenzlogik - das prueft der Helper selbst. '
    + 'Dir geht es um Schreibweise, Uebereinstimmung mit der Vorlage und Inhalt.\n'
    + '- Das Handbuch enthaelt auch Bedienungsanleitungen (Klickwege, Suchfelder). Die sind keine Pruefregeln; ignoriere sie.\n'
    + '- Weicht die Belegquelle vom Formular ab, ist das nur dann ein Befund, wenn die Regeln Uebereinstimmung mit der Vorlage verlangen. '
    + 'Stimmt etwas laut Regel ausdruecklich NICHT mit der Quelle ueberein (z.B. Gross-/Kleinschreibung im Titel), gilt die Regel.\n'
    + '- Ist alles in Ordnung, gib eine leere Liste zurueck.\n'
    + '- Antworte auf Deutsch, Werte aus dem Datensatz unveraendert in Originalschreibweise zitieren.';

function kiCheckPromptBauen(auftrag) {
    const teile = [KI_CHECK_PROMPT];
    if (HAIKU_INSTITUTE[auftrag.institut]) {
        teile.push('\n\nDer Datensatz wird fuer das Institut ' + auftrag.institut.toUpperCase() + ' bearbeitet ('
            + HAIKU_INSTITUTE[auftrag.institut] + '). Pruefe anhand der Affiliationen in der Belegquelle, ob Autoren dieses Instituts '
            + 'im Formular als solche erfasst sind, und wende dazu die Handbuchregeln zu Authors/Affiliation an. '
            + 'Autoren anderer Einrichtungen sind kein Befund.');
    }
    teile.push('\n\n=== 1. HANDBUCH-REGELN ===\n');
    (auftrag.regeln || []).forEach(r => {
        teile.push('--- Feld: ' + r.feld + ' ---\n' + r.text + '\n');
    });
    teile.push('\n=== 2. FORMULAR (Nummer | Feld | Wert) ===\n');
    (auftrag.formular || []).forEach(f => {
        teile.push(f.ref + ' | ' + f.label + ' | ' + f.wert + '\n');
    });
    teile.push('\n=== 3. BELEGQUELLE ===\n' + JSON.stringify(auftrag.referenz || {}, null, 1) + '\n');
    return teile.join('');
}

async function kiCheckDatensatz(auftrag) {
    const einstellungen = await haikuEinstellungen();
    if (!einstellungen.schluessel) {
        throw new Error('Kein Anthropic-API-Schlüssel hinterlegt (Einstellungen des Helpers).');
    }
    if (!auftrag.formular || !auftrag.formular.length) throw new Error('Im Formular steht noch nichts zum Prüfen.');

    const ergebnis = await haikuAnfrage(einstellungen,
        [{ type: 'text', text: kiCheckPromptBauen(auftrag) }], KI_CHECK_TOOL, 4096);
    return {
        findings: Array.isArray(ergebnis.findings) ? ergebnis.findings : [],
        model: ergebnis.__modell
    };
}

// =====================================================================
// FUNDING / PROJEKT-VERKNUEPFUNG (Crossref Funder Registry + OpenAIRE)
// ---------------------------------------------------------------------
// DORA speichert Foerderung als DataCite-artige fundingReferences:
//   funderName / funderIdentifier / fundingStream / awardNumber / awardTitle
// Im Bestand existieren ausschliesslich SNSF und European Commission,
// daher werden nur diese beiden Foerderer zum Eintragen vorgeschlagen.
// =====================================================================

const DORA_SOLR_SELECT = 'http://lib-dora-prod1.emp-eaw.ch:8080/solr/collection1/select';
const SOLR_FUNDING_PREFIX = 'mods_extension_fundingReferences_fundingReference_';

// Kanonische Schreibweisen, wie sie in DORA verwendet werden
const FUNDER_PROFILES = {
    SNSF: {
        key: 'SNSF',
        funderName: 'Swiss National Science Foundation',
        funderIdentifier: 'http://dx.doi.org/10.13039/501100001711',
        defaultStream: 'SNSF',
        // Crossref Funder-DOIs (ohne Praefix) -> ggf. direkter Stream
        crossrefIds: {
            '10.13039/501100001711': null
        }
    },
    EC: {
        key: 'EC',
        funderName: 'European Commission',
        funderIdentifier: 'http://dx.doi.org/10.13039/501100000780',
        defaultStream: null, // Stream haengt vom Rahmenprogramm ab
        crossrefIds: {
            '10.13039/501100000780': null,                              // European Commission
            '10.13039/100010661': 'Horizon 2020 Framework Programme',   // H2020
            '10.13039/501100007601': null,                              // "Horizon 2020" bei Crossref, faktisch auch fuer Horizon-Europe-Projekte
            '10.13039/100011102': 'Seventh Framework Programme',        // FP7
            '10.13039/100011103': null,                                 // FP6
            '10.13039/501100000781': null,                              // ERC
            // HORIZON EUROPE und seine Teilprogramme
            '10.13039/100018693': 'Horizon Europe Framework Programme',
            '10.13039/100018695': 'Horizon Europe Framework Programme', // Research Infrastructures
            '10.13039/100018703': 'Horizon Europe Framework Programme', // European Innovation Council
            '10.13039/100018704': 'Horizon Europe Framework Programme', // Innovation Ecosystems
            '10.13039/100018705': 'Horizon Europe Framework Programme', // EIT
            '10.13039/100019180': 'Horizon Europe Framework Programme', // ERC
            '10.13039/100019185': 'Horizon Europe Framework Programme', // Global Challenges
            '10.13039/100019186': 'Horizon Europe Framework Programme', // Innovative Europe
            // Exekutivagenturen der EU - Programm ergibt sich aus der Projektnummer
            '10.13039/501100000783': null,                              // REA
            '10.13039/501100021050': null,                              // CINEA
            '10.13039/100020631': null,                                 // EISMEA
            '10.13039/501100012290': null,                              // INEA
            '10.13039/100013284': null,                                 // EASME
            '10.13039/501100000785': null                               // EACEA
        }
    }
};

// OpenAIRE funding_level_0 -> DORA fundingStream
const OPENAIRE_STREAM_MAP = {
    'H2020': 'Horizon 2020 Framework Programme',
    'FP7': 'Seventh Framework Programme',
    'HE': 'Horizon Europe Framework Programme',
    'HORIZON': 'Horizon Europe Framework Programme'
};

function funderProfileFromCrossrefDoi(doi) {
    if (!doi) return null;
    const clean = String(doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').trim();
    for (const profile of Object.values(FUNDER_PROFILES)) {
        if (Object.prototype.hasOwnProperty.call(profile.crossrefIds, clean)) {
            return { profile: profile, stream: profile.crossrefIds[clean] || profile.defaultStream };
        }
    }
    return null;
}

function funderProfileFromName(name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    if (/schweizerischer nationalfonds|swiss national science|\bsnsf\b|\bsnf\b/.test(n)) return FUNDER_PROFILES.SNSF;
    if (/european commission|horizon 2020|horizon europe|\bh2020\b|\bfp7\b|seventh framework|european research council|\berc\b/.test(n)) return FUNDER_PROFILES.EC;
    // Crossref benennt EU-Foerderung uneinheitlich und oft ohne Funder-DOI
    if (/marie s?k?[łl]odowska|marie curie|\bmsca\b/.test(n)) return FUNDER_PROFILES.EC;
    if (/\b(7th|6th)\s*framework|framework program(me)?\b.*\beu\b|\beu\b.*framework program(me)?/.test(n)) return FUNDER_PROFILES.EC;
    if (/european union|\beuratom\b|\bec\b\s*research|\berc(ea)?\b/.test(n)) return FUNDER_PROFILES.EC;
    // EU-Exekutivagenturen und Teilprogramme zahlen die Projekte aus
    if (/executive agency/.test(n) && /european|innovation|research|climate|health|digital|networks|audiovisual|small and medium/.test(n)) return FUNDER_PROFILES.EC;
    if (/\b(rea|hadea|cinea|eismea|ercea|inea|easme|eacea)\b/.test(n)) return FUNDER_PROFILES.EC;
    if (/european institute of innovation|innovation council|research infrastructures|framework programme/.test(n)
        && !/national|swiss|deutsche|german/.test(n)) return FUNDER_PROFILES.EC;
    return null;
}

// Stream aus dem Foerdernamen, soweit eindeutig (sonst klaert ihn die
// Projektnummer ueber OpenAIRE bzw. den DORA-Bestand)
function streamFromFunderName(name) {
    const n = String(name || '').toLowerCase();
    if (/\b7th\s*framework|seventh framework|\bfp7\b/.test(n)) return 'Seventh Framework Programme';
    if (/horizon 2020|\bh2020\b/.test(n)) return 'Horizon 2020 Framework Programme';
    if (/horizon europe/.test(n)) return 'Horizon Europe Framework Programme';
    return null;
}

// SNSF-Nummern kommen bei Crossref oft als "200021E_203578", "PZ00P2_174192"
// oder "SNF 182124". In DORA steht immer nur der nackte Code.
function normalizeAwardNumber(raw, funderKey) {
    if (!raw) return null;
    let s = String(raw).trim();
    s = s.replace(/^(grant|award|project|no\.?|nr\.?|#)\s*/i, '');
    s = s.replace(/^(snsf|snf|sfn)[\s:_-]*/i, '');

    // Immer ganze Ziffernbloecke betrachten - ein Laengenfenster wuerde aus
    // "10003256" faelschlich "0003256" herausschneiden.
    const groups = s.match(/\d+/g) || [];
    const long = groups.filter(g => g.length >= 5);

    if (funderKey === 'SNSF') {
        // Praefixe stehen vorn ("200021E_203578"), die Nummer hinten
        if (long.length) return long[long.length - 1];
    }
    if (funderKey === 'EC') {
        // Grant Agreement Number steht vorn ("654360 NFFA-Europe")
        const ec = groups.find(g => g.length >= 6 && g.length <= 9);
        if (ec) return ec;
        if (long.length) return long[0];
    }
    if (long.length) return long[long.length - 1];
    const generic = groups.find(g => g.length >= 4);
    return generic || s;
}

// Prueft, ob die Award-Angabe wirklich diese Projektnummer meint und nicht
// Teil einer zusammengesetzten Kennung ist. CNPq meldet z.B. "#140439/2011-0",
// die DFG "510228793 / C04-CRC1633" - dort waere die herausgeloeste Zahl nur
// zufaellig identisch mit einer SNSF-/EC-Projektnummer.
function awardStringMatchesCode(rawAward, code) {
    let s = String(rawAward || '').trim();

    // Fuehrende Satzzeichen und Beschriftungen (auch Programmnamen)
    s = s.replace(/^[^0-9A-Za-z]+/, '');
    let previous;
    do {
        previous = s;
        s = s.replace(/^(grant|award|project|agreement|number|no|nr|snsf|snf|sfn|fp7|h2020|horizon\s*(2020|europe)|erc|msca)(?:[\s.:_-]+|\b)/i, '');
    } while (s !== previous);

    const idx = s.indexOf(code);
    if (idx < 0) return false;

    const head = s.slice(0, idx);
    const tail = s.slice(idx + code.length);
    const digitGroups = t => (String(t).match(/\d+/g) || []);

    // Hinter der Nummer folgt eine zweite Kennung = zusammengesetzter
    // Bezeichner eines anderen Systems: "#140439/2011-0" (CNPq),
    // "510228793 / C04-CRC1633", "248198858/GRK 2032" (DFG), "760010/2022".
    // Ausnahme: die SNSF-Fortsetzungsangabe "/1", "/3".
    const afterSlash = tail.match(/\/\s*(.*)$/);
    if (afterSlash && (afterSlash[1].match(/\d+/g) || []).some(g => g.length >= 3)) return false;

    const afterDash = tail.match(/^\s*[\-–—‐]\s*(\d+)/);
    if (afterDash && afterDash[1].length >= 3) return false;

    if (!head.trim()) return true;

    // Beschriftungen ohne Ziffern vor dem Instrumentenpraefix entfernen
    // ("Sinergia CRSII5_202296", "R'equip grant 206021-170731")
    const headCore = head.trim().split(/\s+/).filter(t => /\d/.test(t)).join(' ');
    if (!headCore) return true;

    // SNSF-Instrumentenpraefix: genau ein Token, optional mit Trennzeichen
    // ("200021E_", "31BD30 _", "CRSK-3_", "501100001711-", "PR00P3")
    if (/^[A-Za-z0-9]{2,14}\s*[_\-–—‐]?\s*$/.test(headCore)) return true;

    // Call-Kennungen enthalten hoechstens Jahreszahlen ("ERC-2020-StG ",
    // "H2020-MSCA-IF-2020 ", "10.3030/"), aber keine zweite Projektnummer.
    return !digitGroups(headCore).some(g => g.length >= 5);
}

// --- Crossref: message.funder ---
function extractCrossrefFunders(crossrefMessage) {
    const out = [];
    if (!crossrefMessage || !Array.isArray(crossrefMessage.funder)) return out;

    crossrefMessage.funder.forEach(f => {
        const byDoi = funderProfileFromCrossrefDoi(f.DOI);
        const profile = byDoi ? byDoi.profile : funderProfileFromName(f.name);
        const awards = Array.isArray(f.award) ? f.award : [];

        if (!profile) {
            // DORA kennt nur SNSF/EC - alles andere nur als Hinweis melden
            out.push({
                supported: false,
                rawFunderName: f.name || '',
                awards: awards.map(a => String(a))
            });
            return;
        }

        const base = {
            supported: true,
            funderKey: profile.key,
            funderName: profile.funderName,
            funderIdentifier: profile.funderIdentifier,
            fundingStream: (byDoi && byDoi.stream) || streamFromFunderName(f.name) || profile.defaultStream,
            rawFunderName: f.name || ''
        };

        if (awards.length === 0) {
            out.push(Object.assign({}, base, { awardNumber: null, rawAwardNumber: null }));
            return;
        }

        awards.forEach(a => {
            const number = normalizeAwardNumber(a, profile.key);
            // Award-Nummern sind bei SNSF/EC immer numerisch; Angaben wie
            // "PSIFELLOW" sind Akronyme des Projekts, keine eigene Foerderung.
            if (!/^\d{5,9}$/.test(String(number || ''))) return;
            // Zusammengesetzte Kennungen anderer Foerderer nicht als Projekt-
            // nummer interpretieren (z.B. CNPq "#140439/2011-0")
            if (!awardStringMatchesCode(a, number)) {
                console.warn('DORA Helper: Award-Angabe verworfen (keine reine Projektnummer):', a);
                return;
            }
            out.push(Object.assign({}, base, {
                awardNumber: number,
                rawAwardNumber: String(a)
            }));
        });
    });

    return out;
}

// --- OpenAIRE: verknuepfte Projekte zur DOI ---
// Der Graph-API-v1 bietet keinen Endpunkt fuer Projekt-Relationen eines
// Publikations-Records, deshalb der (weiterhin aktive) Legacy-Suchendpunkt.
async function fetchOpenAireProjects(doi) {
    const url = `https://api.openaire.eu/search/publications?doi=${encodeURIComponent(doi)}&format=json`;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`OpenAIRE HTTP ${res.status}`);
    const json = await res.json();

    const asArray = v => (v === undefined || v === null) ? [] : (Array.isArray(v) ? v : [v]);
    const val = v => (v && typeof v === 'object') ? (v['$'] || '') : (v || '');

    const results = asArray(json && json.response && json.response.results && json.response.results.result);
    if (results.length === 0) return [];

    const entity = results[0] && results[0].metadata && results[0].metadata['oaf:entity']
        && results[0].metadata['oaf:entity']['oaf:result'];
    const rels = asArray(entity && entity.rels && entity.rels.rel)
        .filter(r => r && r.to && r.to['@type'] === 'project');

    return rels.map(rel => {
        const funding = asArray(rel.funding)[0] || {};
        const funder = funding.funder || {};
        const shortName = funder['@shortname'] || '';
        const level0 = (funding.funding_level_0 && funding.funding_level_0['@name']) || '';
        const level1 = (funding.funding_level_1 && funding.funding_level_1['@name']) || '';

        let profile = null;
        if (/^SNSF$/i.test(shortName)) profile = FUNDER_PROFILES.SNSF;
        else if (/^EC$/i.test(shortName)) profile = FUNDER_PROFILES.EC;
        else profile = funderProfileFromName(funder['@name']);

        const code = val(rel.code);
        const acronym = val(rel.acronym);
        const title = val(rel.title);

        const hasCode = code && code !== 'unidentified';
        const hasTitle = title && title !== 'unidentified';

        return {
            supported: !!profile,
            funderKey: profile ? profile.key : null,
            funderName: profile ? profile.funderName : (funder['@name'] || ''),
            funderIdentifier: profile ? profile.funderIdentifier : null,
            // SNSF hat in DORA immer den Stream "SNSF", EC den Namen des Rahmenprogramms
            fundingStream: (profile && profile.key === 'SNSF')
                ? 'SNSF'
                : (OPENAIRE_STREAM_MAP[level0.toUpperCase()] || null),
            awardNumber: hasCode ? normalizeAwardNumber(code, profile ? profile.key : null) : null,
            rawAwardNumber: hasCode ? code : null,
            // DORA-Konvention fuer EU-Projekte: "AKRONYM - Titel"
            awardTitle: (acronym && hasTitle) ? `${acronym} - ${title}` : (hasTitle ? title : ''),
            acronym: acronym || null,
            projectTitle: hasTitle ? title : '',
            fundingSubStream: level1 || null,
            openaireId: rel.to['$'] || null,
            inferred: rel['@inferred'] === true || rel['@inferred'] === 'true',
            trust: parseFloat(rel['@trust'] || '0') || 0,
            rawFunderName: funder['@name'] || ''
        };
    }).filter(p => p.awardNumber || p.awardTitle);
}

// --- OpenAIRE-Projektregister ueber den Code (fuer Crossref-only Awards) ---
async function lookupOpenAireProjectByCode(code, funderShortName) {
    try {
        const url = `https://api.openaire.eu/graph/v1/projects?code=${encodeURIComponent(code)}`
            + (funderShortName ? `&fundingShortName=${encodeURIComponent(funderShortName)}` : '')
            + '&pageSize=5';
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) return null;
        const json = await res.json();
        const hit = (json.results || []).find(p => String(p.code) === String(code));
        if (!hit) return null;

        const funding = (hit.fundings && hit.fundings[0]) || {};
        const streamId = (funding.fundingStream && funding.fundingStream.id) || '';
        const level0 = streamId.split('::')[1] || '';

        return {
            awardTitle: hit.acronym ? `${hit.acronym} - ${hit.title}` : (hit.title || ''),
            acronym: hit.acronym || null,
            projectTitle: hit.title || '',
            fundingStream: /^SNSF$/i.test(funding.shortName || '')
                ? 'SNSF'
                : (OPENAIRE_STREAM_MAP[level0.toUpperCase()] || null),
            openaireId: hit.id || null
        };
    } catch (e) {
        console.warn('OpenAIRE project lookup failed:', e);
        return null;
    }
}

// --- DORA-Bestand: kanonische Schreibweise einer Award-Nummer ---
// Liefert Titel/Stream so, wie sie in DORA bereits verwendet werden.
const doraFundingLookupCache = new Map();   // "nummer::foerderer" -> Ergebnis

async function lookupDoraFunding(awardNumber, funderName) {
    // Dieselbe Nummer kommt über viele Datensätze hinweg vor; ein Treffer je
    // Sitzung genügt, damit Solr nicht wiederholt dieselbe Frage beantwortet.
    const cacheSchluessel = `${awardNumber}::${funderName || ''}`;
    if (doraFundingLookupCache.has(cacheSchluessel)) return doraFundingLookupCache.get(cacheSchluessel);

    try {
        const fields = ['funderName', 'funderIdentifier', 'fundingStream', 'awardNumber', 'awardTitle']
            .map(f => SOLR_FUNDING_PREFIX + f + '_ms');
        const q = `${SOLR_FUNDING_PREFIX}awardNumber_ms:"${awardNumber}"`;
        const url = `${DORA_SOLR_SELECT}?q=${encodeURIComponent(q)}&rows=5&wt=json&fl=${encodeURIComponent(fields.join(','))}`;

        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) return null;
        const json = await res.json();
        const docs = (json.response && json.response.docs) || [];

        for (const doc of docs) {
            const numbers = doc[SOLR_FUNDING_PREFIX + 'awardNumber_ms'] || [];
            // Die Multi-Value-Felder eines Records sind positionsgleich indexiert
            const idx = numbers.findIndex(n => String(n) === String(awardNumber));
            if (idx === -1) continue;

            const pick = f => {
                const arr = doc[SOLR_FUNDING_PREFIX + f + '_ms'] || [];
                return arr.length === numbers.length ? (arr[idx] || null) : (arr[0] || null);
            };

            const name = pick('funderName');
            if (funderName && name && name !== funderName) continue;

            const ergebnis = {
                funderName: name,
                funderIdentifier: pick('funderIdentifier'),
                fundingStream: pick('fundingStream'),
                awardTitle: pick('awardTitle'),
                occurrences: json.response.numFound
            };
            doraFundingLookupCache.set(cacheSchluessel, ergebnis);
            return ergebnis;
        }
        doraFundingLookupCache.set(cacheSchluessel, null);
        return null;
    } catch (e) {
        console.warn('DORA Solr funding lookup failed:', e);
        return null;   // Fehlschläge nicht merken, beim nächsten Mal erneut versuchen
    }
}

// Ergebnis-Cache: verhindert wiederholte Abfragen derselben DOI
// (Re-Render der Box, Batch-QC, Zurueckspringen) - OpenAIRE ist ratenbegrenzt.
const fundingCache = new Map();
const FUNDING_CACHE_MAX = 200;

async function fetchFundingSuggestions(doi) {
    const key = String(doi || '').trim().toLowerCase();
    if (fundingCache.has(key)) return fundingCache.get(key);

    const result = await computeFundingSuggestions(doi);
    if (fundingCache.size >= FUNDING_CACHE_MAX) {
        fundingCache.delete(fundingCache.keys().next().value);
    }
    fundingCache.set(key, result);
    return result;
}


// --- Beide Quellen zusammenfuehren ---
// Ergaenzt einen Foerderposten um Titel, Stream und Konfidenz (DORA-Bestand,
// OpenAIRE-Projektregister). Gemeinsam fuer Crossref/OpenAIRE-Vorschlaege und
// die Angaben aus dem PDF.
async function reichereFundingItemAn(item) {
        const dora = await lookupDoraFunding(item.awardNumber, item.funderName);
        if (dora) {
            item.doraOccurrences = dora.occurrences;
            if (!item.sources.includes('DORA')) item.sources.push('DORA');
            // Hauskonvention hat Vorrang
            if (dora.awardTitle) item.awardTitle = dora.awardTitle;
            if (dora.fundingStream) item.fundingStream = dora.fundingStream;
            if (dora.funderIdentifier) item.funderIdentifier = dora.funderIdentifier;
        }

        if (!item.awardTitle || !item.fundingStream) {
            const project = await lookupOpenAireProjectByCode(item.awardNumber, item.funderKey);
            if (project) {
                if (!item.awardTitle && project.awardTitle) item.awardTitle = project.awardTitle;
                if (!item.fundingStream && project.fundingStream) item.fundingStream = project.fundingStream;
                if (!item.acronym && project.acronym) item.acronym = project.acronym;
                if (!item.projectTitle && project.projectTitle) item.projectTitle = project.projectTitle;
                if (!item.openaireId && project.openaireId) item.openaireId = project.openaireId;
                if (!item.sources.includes('OpenAIRE')) item.sources.push('OpenAIRE');
            }
        }

        // Konfidenz: DORA bestaetigt nur die Schreibweise, nicht die Zugehoerigkeit
        // des Papers zum Projekt - deshalb zaehlt dafuer nur Crossref/OpenAIRE.
        const hasCrossref = item.sources.includes('Crossref');
        const hasOpenAire = item.sources.includes('OpenAIRE');
        // Rein aus dem Volltext gemined (OpenAIRE-Inferenz ohne Verlagsangabe)
        item.textMined = !!item.openaireInferred && !hasCrossref;

        if (!item.awardTitle) {
            item.confidence = 'low';
        } else if (hasCrossref || (hasOpenAire && !item.openaireInferred)) {
            item.confidence = 'high';
        } else {
            item.confidence = 'medium';
        }

        item.complete = !!(item.funderName && item.awardNumber && item.awardTitle && item.fundingStream);
        item.projectUrl = item.openaireId
            ? `https://explore.openaire.eu/search/project?projectId=${encodeURIComponent(item.openaireId)}`
            : null;
}

// Foerderangaben aus dem PDF (von Haiku gelesen) in dieselben Posten wie bei
// Crossref/OpenAIRE ueberfuehren: Foerderer erkennen, Nummer auf den nackten
// Code bringen, Stream ableiten. Eintragbar sind nur SNSF und EC; ob DORAs
// Auswahlliste das Projekt kennt, klaert erst der Lookup beim Eintragen.
async function baueFundingItemsAusPdf(liste) {
    const items = new Map();
    const nichtEintragbar = [];
    (Array.isArray(liste) ? liste : []).forEach(r => {
        if (!r || !r.award_number) return;
        const profil = funderProfileFromName(r.funder);
        if (!profil) { nichtEintragbar.push({ name: r.funder || '?', awards: [r.award_number] }); return; }
        const nummer = normalizeAwardNumber(r.award_number, profil.key);
        if (!nummer || !awardStringMatchesCode(r.award_number, nummer)) {
            nichtEintragbar.push({ name: (r.funder || profil.funderName) + ' (Nummer unklar)', awards: [r.award_number] });
            return;
        }
        const schluessel = profil.key + '::' + nummer;
        if (items.has(schluessel)) return;
        items.set(schluessel, {
            funderKey: profil.key,
            funderName: profil.funderName,
            funderIdentifier: profil.funderIdentifier,
            fundingStream: streamFromFunderName((r.funder || '') + ' ' + (r.programme || '')) || profil.defaultStream,
            awardNumber: nummer,
            awardTitle: '',
            acronym: null,
            projectTitle: '',
            openaireId: null,
            sources: ['PDF'],
            rawAwardNumbers: [r.award_number]
        });
    });
    const posten = Array.from(items.values());
    await Promise.all(posten.map(reichereFundingItemAn));
    return { items: posten, unsupported: nichtEintragbar };
}

async function computeFundingSuggestions(doi) {
    const [crossrefRes, openaireRes] = await Promise.allSettled([
        fetch(`https://api.crossref.org/works/${doi}`, { cache: 'no-cache' })
            .then(r => r.ok ? r.json() : null)
            .then(j => extractCrossrefFunders(j && j.message)),
        fetchOpenAireProjects(doi)
    ]);

    const crossrefItems = crossrefRes.status === 'fulfilled' ? (crossrefRes.value || []) : [];
    const openaireItems = openaireRes.status === 'fulfilled' ? (openaireRes.value || []) : [];

    const errors = [];
    if (crossrefRes.status === 'rejected') errors.push('Crossref: ' + (crossrefRes.reason && crossrefRes.reason.message));
    if (openaireRes.status === 'rejected') errors.push('OpenAIRE: ' + (openaireRes.reason && openaireRes.reason.message));

    // Nicht eintragbare Foerderer (alles ausser SNSF/EC) nur als Hinweis
    const unsupported = [];
    [].concat(crossrefItems, openaireItems).forEach(i => {
        if (i.supported) return;
        const label = (i.rawFunderName || i.funderName || '').trim();
        if (!label) return;
        const existing = unsupported.find(u => u.name === label);
        const awards = i.awards || (i.rawAwardNumber ? [i.rawAwardNumber] : []);
        if (existing) awards.forEach(a => { if (!existing.awards.includes(a)) existing.awards.push(a); });
        else unsupported.push({ name: label, awards: awards.slice() });
    });

    // Merge-Key: Foerderer + normalisierte Award-Nummer
    const merged = new Map();
    const keyOf = i => `${i.funderKey}::${i.awardNumber}`;

    openaireItems.filter(i => i.supported && i.awardNumber).forEach(i => {
        merged.set(keyOf(i), {
            funderKey: i.funderKey,
            funderName: i.funderName,
            funderIdentifier: i.funderIdentifier,
            fundingStream: i.fundingStream,
            awardNumber: i.awardNumber,
            awardTitle: i.awardTitle,
            acronym: i.acronym,
            projectTitle: i.projectTitle,
            openaireId: i.openaireId,
            sources: ['OpenAIRE'],
            openaireInferred: i.inferred,
            openaireTrust: i.trust,
            rawAwardNumbers: [i.rawAwardNumber].filter(Boolean)
        });
    });

    crossrefItems.filter(i => i.supported && i.awardNumber).forEach(i => {
        const existing = merged.get(keyOf(i));
        if (existing) {
            if (!existing.sources.includes('Crossref')) existing.sources.push('Crossref');
            if (!existing.fundingStream && i.fundingStream) existing.fundingStream = i.fundingStream;
            if (i.rawAwardNumber && !existing.rawAwardNumbers.includes(i.rawAwardNumber)) {
                existing.rawAwardNumbers.push(i.rawAwardNumber);
            }
        } else {
            merged.set(keyOf(i), {
                funderKey: i.funderKey,
                funderName: i.funderName,
                funderIdentifier: i.funderIdentifier,
                fundingStream: i.fundingStream,
                awardNumber: i.awardNumber,
                awardTitle: '',
                acronym: null,
                projectTitle: '',
                openaireId: null,
                sources: ['Crossref'],
                rawAwardNumbers: [i.rawAwardNumber].filter(Boolean)
            });
        }
    });

    const items = Array.from(merged.values());

    // Anreichern: fehlende Titel/Streams aus DORA-Bestand bzw. OpenAIRE-Projektregister
    await Promise.all(items.map(reichereFundingItemAn));

    const rank = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => (rank[a.confidence] - rank[b.confidence])
        || String(a.awardNumber).localeCompare(String(b.awardNumber)));

    return { items: items, unsupported: unsupported, errors: errors };
}


// =====================================================================
// SUPPLEMENTS ZU EINEM ARTIKEL (Crossref + OpenAIRE + Repositorien)
// ---------------------------------------------------------------------
// Zwei Arten von "Supplement" kommen vor:
//   1. Datenpublikationen (Zenodo, figshare, Dryad, ERIC ...) - stehen in
//      den Metadaten von OpenAIRE (rund 11 % der Artikel) und selten in
//      Crossref (rund 0.3 %).
//   2. Die eigentliche Supporting Information des Verlags - die findet der
//      Landing-Page-Scan im Content-Script.
// Hier geht es um Punkt 1; bei Zenodo/figshare werden zusaetzlich die
// einzelnen Dateien samt direkter Download-URL aufgeloest.
// =====================================================================

const supplementCache = new Map();
const SUPPLEMENT_CACHE_MAX = 200;

function repositoryFromId(id) {
    const s = String(id || '');
    if (/10\.5281\/zenodo\.(\d+)/i.test(s) || /zenodo\.org\/(records?|record)\/(\d+)/i.test(s)) {
        const m = s.match(/10\.5281\/zenodo\.(\d+)/i) || s.match(/zenodo\.org\/(?:records?|record)\/(\d+)/i);
        return { name: 'Zenodo', key: 'zenodo', id: m[1] };
    }
    if (/10\.6084\/m9\.figshare\.(\d+)/i.test(s)) {
        return { name: 'figshare', key: 'figshare', id: s.match(/10\.6084\/m9\.figshare\.(\d+)/i)[1] };
    }
    if (/figshare\.com\/articles\/[^/]+\/[^/]+\/(\d+)/i.test(s)) {
        return { name: 'figshare', key: 'figshare', id: s.match(/figshare\.com\/articles\/[^/]+\/[^/]+\/(\d+)/i)[1] };
    }
    if (/10\.5061\/dryad/i.test(s)) return { name: 'Dryad', key: 'dryad', id: null };
    if (/10\.25678\//i.test(s)) return { name: 'Eawag ERIC', key: 'eric', id: null };
    return null;
}

// Einzelne Dateien eines Repositoriums samt direkter URL
// Zenodo liefert nur eine Kennung ("cc-by-4.0"), figshare Name und URL.
function normalizeLicense(roh) {
    if (!roh) return null;
    if (typeof roh === 'object' && roh.name) {
        return { name: roh.name, url: roh.url || null };
    }
    const id = String((roh && roh.id) || roh || '').trim();
    if (!id) return null;

    const cc = id.match(/^cc-([a-z-]+?)-?(\d\.\d)?$/i);
    if (cc) {
        const teile = cc[1].toLowerCase();
        const istCC0 = teile === 'zero' || teile === '0';
        // CC0 gibt es nur in Version 1.0
        const version = cc[2] || (istCC0 ? '1.0' : '4.0');
        const name = istCC0 ? 'CC0 ' + version : 'CC ' + teile.toUpperCase() + ' ' + version;
        const pfad = istCC0 ? 'publicdomain/zero' : 'licenses/' + teile;
        return { name: name, url: `https://creativecommons.org/${pfad}/${version}/` };
    }
    return { name: id.toUpperCase(), url: null };
}

async function fetchRepositoryFiles(repo) {
    try {
        if (repo.key === 'zenodo' && repo.id) {
            const res = await fetch(`https://zenodo.org/api/records/${repo.id}`, { cache: 'no-cache' });
            if (!res.ok) return { files: [] };
            const json = await res.json();
            return {
                title: json.title || (json.metadata && json.metadata.title) || '',
                license: normalizeLicense((json.metadata && json.metadata.license) || json.license),
                files: (json.files || []).map(f => ({
                    name: f.key,
                    size: f.size || 0,
                    url: (f.links && (f.links.self || f.links.download)) || null
                })).filter(f => f.url)
            };
        }
        if (repo.key === 'figshare' && repo.id) {
            const [dateien, meta] = await Promise.all([
                fetch(`https://api.figshare.com/v2/articles/${repo.id}/files`, { cache: 'no-cache' }),
                fetch(`https://api.figshare.com/v2/articles/${repo.id}`, { cache: 'no-cache' })
            ]);
            const liste = dateien.ok ? await dateien.json() : [];
            const info = meta.ok ? await meta.json() : {};
            return {
                title: String(info.title || '').replace(/\s+/g, ' ').trim(),
                license: normalizeLicense(info.license),
                files: (liste || []).map(f => ({
                    name: f.name,
                    size: f.size || 0,
                    url: f.download_url || null
                })).filter(f => f.url)
            };
        }
    } catch (e) {
        console.warn('Repository-Dateien nicht abrufbar:', repo, e);
    }
    return { files: [] };
}

// --- Crossref: relation.is-supplemented-by / has-part ---
function extractCrossrefSupplements(message) {
    const out = [];
    const rel = (message && message.relation) || {};
    ['is-supplemented-by', 'has-part'].forEach(typ => {
        [].concat(rel[typ] || []).forEach(eintrag => {
            const id = String(eintrag.id || '').trim();
            if (!id) return;
            const istDoi = (eintrag['id-type'] || '').toLowerCase() === 'doi';
            out.push({
                source: 'Crossref',
                relation: typ,
                doi: istDoi ? id : null,
                url: istDoi ? `https://doi.org/${id}` : id,
                title: '',
                type: 'dataset'
            });
        });
    });
    return out;
}

// --- OpenAIRE: IsSupplementedBy (Titel, DOI und URL liegen in der Relation) ---
async function fetchOpenAireSupplements(doi) {
    const url = `https://api.openaire.eu/search/publications?doi=${encodeURIComponent(doi)}&format=json`;
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`OpenAIRE HTTP ${res.status}`);
    const json = await res.json();

    const asArray = v => (v === undefined || v === null) ? [] : (Array.isArray(v) ? v : [v]);
    const val = v => (v && typeof v === 'object') ? (v['$'] || '') : (v || '');

    const results = asArray(json && json.response && json.response.results && json.response.results.result);
    if (!results.length) return [];

    const entity = results[0] && results[0].metadata && results[0].metadata['oaf:entity']
        && results[0].metadata['oaf:entity']['oaf:result'];

    return asArray(entity && entity.rels && entity.rels.rel)
        .filter(r => r && r.to && /IsSupplementedBy/i.test(r.to['@class'] || ''))
        .map(r => {
            const pid = asArray(r.pid).find(p => (p['@classid'] || '').toLowerCase() === 'doi');
            const instanz = asArray(r.instance)[0] || {};
            const webUrl = val(instanz.webresource && instanz.webresource.url) || val(instanz.url);
            const supplementDoi = pid ? val(pid) : null;
            return {
                source: 'OpenAIRE',
                relation: 'IsSupplementedBy',
                doi: supplementDoi,
                url: supplementDoi ? `https://doi.org/${supplementDoi}` : (webUrl || null),
                title: val(r.title),
                creators: asArray(r.creator).map(c => val(c)).filter(Boolean).slice(0, 3),
                type: val(r.resulttype && r.resulttype['@classid']) || 'dataset'
            };
        })
        .filter(s => s.url);
}

// --- figshare kennt die Artikel-DOI als "resource_doi" ---
// ACS und andere Verlage legen ihre Supporting Information dort ab. Dieser
// Weg braucht die Verlagsseite nicht, die bei ACS ohnehin gesperrt ist.
async function fetchFigshareByArticleDoi(doi) {
    try {
        const res = await fetch('https://api.figshare.com/v2/articles/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ resource_doi: doi })
        });
        if (!res.ok) return [];
        const treffer = await res.json();
        return (treffer || []).slice(0, 5).map(a => ({
            source: 'figshare',
            relation: 'resource_doi',
            doi: a.doi || null,
            url: a.url_public_html || (a.doi ? `https://doi.org/${a.doi}` : null),
            title: String(a.title || '').replace(/\s+/g, ' ').trim(),
            type: 'dataset',
            figshareId: a.id
        })).filter(a => a.url);
    } catch (e) {
        console.warn('figshare-Suche fehlgeschlagen:', e);
        return [];
    }
}

// --- Elsevier: Supplements über die PII vom CDN ---
// ScienceDirect sperrt automatisierte Abrufe, der Auslieferungs-CDN
// (ars.els-cdn.com) ist dagegen offen. Die Dateien heissen dort
// "1-s2.0-<PII>-mmc<N>.<endung>" und lassen sich per HEAD prüfen.
const ELSEVIER_EXTENSIONS = ['pdf', 'docx', 'xlsx', 'zip', 'doc', 'xls', 'csv', 'txt'];
const ELSEVIER_MAX_INDEX = 8;

function elsevierPiiFromCrossref(message) {
    if (!message) return null;
    const kandidaten = [].concat(message['alternative-id'] || []);
    const treffer = kandidaten.find(id => /^S\d{15,17}$/i.test(String(id).trim()));
    if (treffer) return String(treffer).trim();

    const primaer = (message.resource && message.resource.primary && message.resource.primary.URL) || '';
    const ausUrl = primaer.match(/pii\/(S\d{15,17})/i);
    return ausUrl ? ausUrl[1] : null;
}

async function probeElsevierFile(pii, index, endung) {
    const url = `https://ars.els-cdn.com/content/image/1-s2.0-${pii}-mmc${index}.${endung}`;
    try {
        const res = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
        if (!res.ok) return null;
        const laenge = parseInt(res.headers.get('content-length') || '0', 10);
        return { url: url, name: `mmc${index}.${endung}`, size: laenge || 0 };
    } catch (e) {
        return null;
    }
}

async function fetchElsevierSupplements(pii) {
    if (!pii) return [];
    const gefunden = [];

    for (let index = 1; index <= ELSEVIER_MAX_INDEX; index++) {
        let treffer = null;
        for (const endung of ELSEVIER_EXTENSIONS) {
            treffer = await probeElsevierFile(pii, index, endung);
            if (treffer) break;
        }
        // Elsevier nummeriert lückenlos: beim ersten fehlenden Index aufhören
        if (!treffer) break;
        gefunden.push({
            source: 'Elsevier',
            relation: 'cdn',
            type: 'file',
            title: index === 1 ? 'Supplementary material' : `Supplementary material ${index}`,
            fileName: treffer.name,
            url: treffer.url,
            isFile: true,
            files: [{ name: treffer.name, size: treffer.size, url: treffer.url }]
        });
    }

    return gefunden;
}

async function fetchSupplements(doi) {
    const key = String(doi || '').trim().toLowerCase();
    if (supplementCache.has(key)) return supplementCache.get(key);

    const crossrefWerk = await fetch(`https://api.crossref.org/works/${doi}`, { cache: 'no-cache' })
        .then(r => r.ok ? r.json() : null)
        .then(j => (j && j.message) || null)
        .catch(() => null);

    const [crossrefRes, openaireRes, figshareRes, elsevierRes] = await Promise.allSettled([
        Promise.resolve(extractCrossrefSupplements(crossrefWerk)),
        fetchOpenAireSupplements(doi),
        fetchFigshareByArticleDoi(doi),
        fetchElsevierSupplements(elsevierPiiFromCrossref(crossrefWerk))
    ]);

    const errors = [];
    if (crossrefRes.status === 'rejected') errors.push('Crossref: ' + (crossrefRes.reason && crossrefRes.reason.message));
    if (openaireRes.status === 'rejected') errors.push('OpenAIRE: ' + (openaireRes.reason && openaireRes.reason.message));

    // Zusammenfuehren, Dubletten ueber DOI bzw. URL erkennen
    const items = [];
    const merge = eintrag => {
        const kennung = (eintrag.doi || eintrag.url || '').toLowerCase();
        const vorhanden = items.find(i => (i.doi || i.url || '').toLowerCase() === kennung);
        if (vorhanden) {
            if (!vorhanden.title && eintrag.title) vorhanden.title = eintrag.title;
            if (!vorhanden.sources.includes(eintrag.source)) vorhanden.sources.push(eintrag.source);
            return;
        }
        items.push(Object.assign({}, eintrag, { sources: [eintrag.source] }));
    };
    (openaireRes.status === 'fulfilled' ? openaireRes.value : []).forEach(merge);
    (crossrefRes.status === 'fulfilled' ? crossrefRes.value : []).forEach(merge);
    (figshareRes.status === 'fulfilled' ? figshareRes.value : []).forEach(merge);
    (elsevierRes.status === 'fulfilled' ? elsevierRes.value : []).forEach(merge);

    // Repositorien aufloesen: Dateiliste mit direkten Download-Links
    await Promise.all(items.map(async item => {
        const repo = item.figshareId
            ? { name: 'figshare', key: 'figshare', id: String(item.figshareId) }
            : repositoryFromId(item.doi || item.url);
        if (!repo) return;
        item.repository = repo.name;
        const inhalt = await fetchRepositoryFiles(repo);
        item.files = inhalt.files || [];
        if (!item.title && inhalt.title) item.title = inhalt.title;
        if (inhalt.license) item.license = inhalt.license;
    }));

    const result = { items: items, errors: errors };
    if (supplementCache.size >= SUPPLEMENT_CACHE_MAX) {
        supplementCache.delete(supplementCache.keys().next().value);
    }
    supplementCache.set(key, result);
    return result;
}
