// journal_neu.js
//
// Neuerfassung von Journals (MADS-Objekte in journals:collection):
//  1. Im Journal-Formular: Daten ueber ISSN oder Artikel-DOI holen
//     (Crossref, OpenAlex, NLM) und eintragen.
//  2. Dubletten-Check ueber die Journal-Autovervollstaendigung der Artikel-
//     formulare (Titel, fruehere Titel, ISSN).
//  3. Pruefung der Eingaben (ISSN-Pruefziffer, vertauschte ISSN, Titel).
//  4. Im Artikelformular: Knopf "Journal neu anlegen", der das Journal-
//     Formular in einem neuen Tab vorbefuellt oeffnet.

// ---------------------------------------------------------------------------
// Reine Hilfsfunktionen (ohne DOM, mit node testbar)
// ---------------------------------------------------------------------------

// "12345678", "1234 567x" -> "1234-567X"; sonst unveraendert (getrimmt)
function issnNormalisieren(wert) {
    const roh = String(wert || '').trim().toUpperCase();
    const ziffern = roh.replace(/[^0-9X]/g, '');
    return ziffern.length === 8 ? ziffern.slice(0, 4) + '-' + ziffern.slice(4) : roh;
}

// ISSN-Pruefziffer (Modulo 11, Gewichte 8..2)
function issnGueltig(wert) {
    const issn = issnNormalisieren(wert);
    if (!/^\d{4}-\d{3}[\dX]$/.test(issn)) return false;
    const z = issn.replace('-', '');
    let summe = 0;
    for (let i = 0; i < 7; i++) summe += Number(z[i]) * (8 - i);
    const rest = (11 - (summe % 11)) % 11;
    return z[7] === (rest === 10 ? 'X' : String(rest));
}

// Findet sich eine ISSN-Angabe oder DOI in einem freien Eingabetext?
function journalSucheDeuten(text) {
    const t = String(text || '').trim();
    const doi = t.match(/10\.\d{4,9}\/\S+/);
    if (doi) return { doi: doi[0].replace(/[.,;)]+$/, '') };
    const issn = t.match(/\b\d{4}\s*-?\s*\d{3}[\dxX]\b/);
    if (issn) return { issn: issnNormalisieren(issn[0]) };
    return {};
}

// Hinweise zu den Formularwerten. werte: {titel, abk, publisher, print, online}
// quelle (optional): {print, online} aus Crossref, um Vertauschungen zu sehen.
// Ergebnis: { fehler:[{feld, text}], hinweise:[{feld, text}] } - feld ist der
// Schluessel des Formularfeldes, unter dem die Meldung erscheint.
function journalPruefen(werte, quelle) {
    const fehler = [];
    const hinweise = [];
    const F = (feld, text) => fehler.push({ feld, text });
    const H = (feld, text) => hinweise.push({ feld, text });
    const titel = String(werte.titel || '');
    const abk = String(werte.abk || '');

    if (!titel.trim()) F('titel', 'Titel fehlt (Pflichtfeld).');
    else {
        if (titel !== titel.trim() || /\s{2,}/.test(titel)) H('titel', 'Leerzeichen am Rand oder doppelte Leerzeichen.');
        if (/[.;,:]$/.test(titel.trim())) H('titel', 'Titel endet mit einem Satzzeichen.');
        if (titel.length > 6 && titel === titel.toUpperCase() && /[A-Z]/.test(titel)) H('titel', 'Titel steht ganz in Grossbuchstaben.');
    }
    if (abk && titel && abk.trim().toLowerCase() === titel.trim().toLowerCase() && /\s/.test(titel.trim())) {
        H('abk', 'Abkürzung ist gleich dem vollen Titel.');
    }

    [['print', 'ISSN'], ['online', 'E-ISSN']].forEach(([k, name]) => {
        const v = String(werte[k] || '').trim();
        if (!v) return;
        if (!/^\d{4}-\d{3}[\dX]$/.test(v)) F(k, `${name} „${v}“ hat nicht die Form 1234-567X.`);
        else if (!issnGueltig(v)) F(k, `${name} „${v}“: Prüfziffer stimmt nicht (Tippfehler?).`);
    });
    if (!werte.print && !werte.online) H('print', 'Weder ISSN noch E-ISSN eingetragen.');
    if (werte.print && werte.online && werte.print.trim() === werte.online.trim()) {
        F('online', 'ISSN und E-ISSN sind identisch.');
    }
    if (quelle) {
        const p = String(werte.print || '').trim(), o = String(werte.online || '').trim();
        if (p && quelle.online === p && quelle.print !== p) F('print', `${p} ist laut Crossref die E-ISSN, nicht die Print-ISSN.`);
        if (o && quelle.print === o && quelle.online !== o) F('online', `${o} ist laut Crossref die Print-ISSN, nicht die E-ISSN.`);
    }
    return { fehler, hinweise };
}

function journalTitelVergleich(text) {
    return String(text || '').replace(/<[^>]+>/g, ' ').toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/&/g, ' and ').replace(/^the\s+/, '')
        .replace(/[^a-z0-9]+/g, ' ').trim();
}

// --- Publisher in DORA-Schreibweise ---------------------------------------------
//
// Externe Quellen nennen Verlage je nach Imprint, Rechtsform und Jahr anders
// ("Springer Science and Business Media LLC", "Wiley-Blackwell"). In DORA gilt
// je Verlag ein Hausname. Die gueltigen Namen kommen aus DORA selbst (Liste der
// Journal-Publisher); diese Regeln bilden bekannte Varianten darauf ab. Ziel
// wird nur genommen, wenn es in der DORA-Liste vorkommt.
const PUBLISHER_REGELN = [
    [/\bspringer\b(?!-vdi)|nature publishing|nature portfolio|^nature research\b|biomed ?central|\bbmc\b|palgrave|apress\b|\badis\b/i, 'Springer Nature', /ringier|axel springer/i],
    // AGU- und ESA-Journals erscheinen bei Wiley und stehen in DORA so (Ausnahme: Eos)
    [/wiley|blackwell|hindawi|american geophysical union|\bagu\b|ecological society of america/i, 'Wiley'],
    [/elsevier|pergamon|academic press|cell press|north[- ]holland|excerpta medica|saunders|mosby/i, 'Elsevier'],
    [/taylor\s*(&|and)\s*francis|informa uk|routledge|crc press|tandf/i, 'Taylor & Francis'],
    [/oxford university press|\boup\b/i, 'Oxford University Press'],
    [/cambridge university press|\bcup\b/i, 'Cambridge University Press'],
    [/\bsage\b/i, 'Sage'],
    [/gruyter/i, 'de Gruyter', /brill/i],
    [/\bmdpi\b|multidisciplinary digital publishing/i, 'MDPI'],
    [/\biop\b|^institute of physics( publishing)?\s*$/i, 'IOP Publishing'],
    [/\baip\b|american institute of physics/i, 'American Institute of Physics'],
    [/frontiers media|^frontiers\b/i, 'Frontiers Media'],
    [/\bieee\b|institute of electrical and electronics/i, 'IEEE'],
    [/royal society of chemistry|\brsc\b/i, 'Royal Society of Chemistry'],
    [/american chemical society|\bacs\b/i, 'American Chemical Society'],
    [/copernicus/i, 'Copernicus'],
    [/emerald/i, 'Emerald'],
    [/\bedp\b/i, 'EDP Sciences'],
    [/^american society of civil engineers|^asce\b|\(asce\)/i, 'American Society of Civil Engineers ASCE'],
    [/american society of mechanical engineers|\basme\b/i, 'American Society of Mechanical Engineers ASME'],
    [/lippincott|ovid technologies/i, 'Lippincott Williams & Wilkins'],
    [/american physical society/i, 'American Physical Society'],
    [/world scientific/i, 'World Scientific'],
    [/annual reviews/i, 'Annual Reviews'],
    [/\biwa\b|international water association/i, 'IWA Publishing', /wald und landschaft/i],
    [/inderscience/i, 'Inderscience'],
    [/thieme/i, 'Thieme'],
    [/bentham/i, 'Bentham'],
    [/karger/i, 'Karger'],
    [/canadian science publishing|nrc research press/i, 'Canadian Science Publishing'],
    [/mary ann liebert/i, 'Mary Ann Liebert'],
    [/pensoft/i, 'Pensoft'],
    [/schweizerbart|borntraeger/i, 'Schweizerbart'],
    [/american meteorological society/i, 'American Meteorological Society'],
    [/\bspie\b/i, 'SPIE'],
    [/optica publishing|^optica\b|optical society of america|^the optical society/i, 'Optica Publishing Group'],
    [/public library of science|\bplos\b/i, 'Public Library of Science'],
    [/\bbmj\b/i, 'BMJ Publishing Group'],
    [/american association for the advancement of science|\baaas\b/i, 'American Association for the Advancement of Science'],
    [/\bcsiro\b/i, 'CSIRO'],
    [/hogrefe/i, 'Hogrefe'],
    [/inter-research/i, 'Inter-Research Science Publishing'],
    [/ubiquity press/i, 'Ubiquity Press']
];

// Rechtsformen und Fuellwoerter weglassen: "Walter de Gruyter GmbH" -> "walter de gruyter"
function publisherKern(name) {
    return String(name || '').toLowerCase()
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\b(the|gmbh|ltd|limited|inc|llc|lp|b ?v|n ?v|ag|sa|s ?a|s ?l|srl|spa|co|kg|kgaa|plc|pty|corp|corporation|company|publishing|publishers?|publications?|group|media|verlag|verlagsgesellschaft|editions?)\b/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

// liste: [[Name, Anzahl Journals], ...] aus DORA. Ergebnis: {name, grund} oder null
function publisherZuordnen(extern, liste) {
    const name = String(extern || '').trim();
    if (!name || !liste || !liste.length) return null;
    const bekannt = new Map(liste.map(([n, z]) => [n, z]));

    // Regeln zuerst: sonst setzt sich ein einzelner Altfall ("Pergamon") gegen
    // den Hausnamen ("Elsevier") durch
    for (const [muster, ziel, ausser] of PUBLISHER_REGELN) {
        if (muster.test(name) && !(ausser && ausser.test(name)) && bekannt.has(ziel)) {
            return { name: ziel, grund: ziel === name ? 'gleich' : 'regel' };
        }
    }

    if (bekannt.has(name)) return { name, grund: 'gleich' };
    const klein = name.toLowerCase();
    for (const [n] of liste) if (n.toLowerCase() === klein) return { name: n, grund: 'gleich' };

    const kern = publisherKern(name);
    if (kern) {
        const passend = liste.filter(([n]) => publisherKern(n) === kern).sort((a, b) => b[1] - a[1]);
        if (passend.length) return { name: passend[0][0], grund: 'kern' };
    }
    return null;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { issnNormalisieren, issnGueltig, journalSucheDeuten, journalPruefen, journalTitelVergleich, publisherZuordnen, publisherKern };
}

// ---------------------------------------------------------------------------
// Anbindung an die DORA-Seiten
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
    (function () {
        // Im Journal-Formular sind die internen Feldnamen vertauscht, die
        // Beschriftungen aber richtig: identifiers[eissn] heisst "ISSN" und
        // wird als Print-ISSN gespeichert (Solr: mods_identifier_issn_ms),
        // identifiers[issn] heisst "E-ISSN" (mods_identifier_e-issn_ms).
        // Geprueft 2026-11-20 an journals:2964 (Water Research, 0043-1354).
        const FELD_PRINT = 'identifiers[eissn]';   // beschriftet "ISSN"
        const FELD_ONLINE = 'identifiers[issn]';   // beschriftet "E-ISSN"

        const HASH_PRAEFIX = '#dora-journal=';

        const JOURNAL_FORM_URL = '/islandora/object/journals%3Acollection/manage/overview/ingest';

        function el(tag, stil, text) {
            const e = document.createElement(tag);
            if (stil) e.style.cssText = stil;
            if (text != null) e.textContent = text;
            return e;
        }

        function nachricht(daten) {
            return new Promise(resolve => chrome.runtime.sendMessage(daten, resolve));
        }

        // =====================================================================
        // Teil A: Journal-Formular
        // =====================================================================

        function journalFormularFelder() {
            const q = n => document.querySelector('[name="' + n + '"]');
            const f = {
                titel: q('titleInfo[title]'),
                abk: q('abbreviatedTitleInfo[title]'),
                publisher: q('originInfo[publisher]'),
                print: q(FELD_PRINT),
                online: q(FELD_ONLINE)
            };
            return f.titel && f.print && f.online ? f : null;
        }

        function istJournalFormular() {
            return /journals(%3A|:)/i.test(window.location.pathname) && !!journalFormularFelder();
        }

        function werteLesen(f) {
            return {
                titel: f.titel.value, abk: f.abk ? f.abk.value : '', publisher: f.publisher ? f.publisher.value : '',
                print: issnNormalisieren(f.print.value), online: issnNormalisieren(f.online.value)
            };
        }

        let geholt = null; // letzte Daten aus den Quellen

        // Publisher-Namen aus DORA (Hintergrundskript, 7 Tage zwischengespeichert)
        let publisherListeCache = null;
        async function publisherListe() {
            if (publisherListeCache) return publisherListeCache;
            const antwort = await nachricht({ action: 'doraPublisher' });
            publisherListeCache = antwort && antwort.success ? antwort.data : [];
            return publisherListeCache;
        }

        // Treffer aus Solr einstufen: gleiche ISSN, gleicher oder frueherer Titel = vorhanden
        function dublettenEinstufen(daten, titel, issns, fruehere) {
            const eigenerTitel = journalTitelVergleich(titel);
            const fruehereNorm = (fruehere || []).map(journalTitelVergleich);
            return (daten || []).map(d => {
                const gleicheIssn = d.issn.concat(d.eissn).filter(i => issns.includes(i));
                const t = journalTitelVergleich(d.titel);
                const gleicherTitel = !!t && t === eigenerTitel;
                const frueherTitel = !!t && fruehereNorm.includes(t);
                return { ...d, gleicheIssn, gleicherTitel, frueherTitel, stark: gleicheIssn.length > 0 || gleicherTitel || frueherTitel };
            }).sort((a, b) => (b.stark - a.stark) || (b.gleicheIssn.length - a.gleicheIssn.length));
        }

        // --- Meldungen direkt am Feld ---------------------------------------------
        // Jedes Feld bekommt unter dem Eingabefeld einen Bereich mit festen Plaetzen,
        // damit Meldungen verschiedener Herkunft sich nicht gegenseitig loeschen.
        const PLAETZE = ['dublette', 'pruefung', 'vorschlag', 'quelle', 'iso4'];
        const ARTEN = {
            fehler: { rand: '#c53030', grund: '#fff5f5', farbe: '#9b2c2c', zeichen: '✖' },
            hinweis: { rand: '#d69e2e', grund: '#fffbeb', farbe: '#744210', zeichen: '⚠' },
            vorschlag: { rand: '#3182ce', grund: '#ebf8ff', farbe: '#2a4365', zeichen: '➜' },
            ok: { rand: '#38a169', grund: '#f0fff4', farbe: '#22543d', zeichen: '✓' },
            info: { rand: '#a0aec0', grund: '#f7fafc', farbe: '#4a5568', zeichen: 'ℹ' }
        };

        function feldPlatz(feld, platz) {
            const huelle = feld.closest('.form-item') || feld.parentNode;
            let bereich = huelle.querySelector(':scope > .dora-feld-hinweise');
            if (!bereich) {
                bereich = el('div', 'max-width:640px;');
                bereich.className = 'dora-feld-hinweise';
                PLAETZE.forEach(p => { const d = el('div', ''); d.dataset.platz = p; bereich.appendChild(d); });
                const anker = feld.closest('.form-textarea-wrapper') || feld;
                anker.insertAdjacentElement('afterend', bereich);
            }
            return bereich.querySelector(`[data-platz="${platz}"]`);
        }

        // Eine gut lesbare Meldungszeile; teile: Text oder Elemente
        function meldung(art, ...teile) {
            const a = ARTEN[art] || ARTEN.info;
            const z = el('div', `margin:4px 0 0; padding:5px 9px; border-left:4px solid ${a.rand}; background:${a.grund}; `
                + `color:${a.farbe}; border-radius:3px; font-family:sans-serif; font-size:13px; line-height:1.45;`);
            z.appendChild(el('span', 'font-weight:700; margin-right:6px;', a.zeichen));
            teile.forEach(t => z.appendChild(typeof t === 'string' ? document.createTextNode(t) : t));
            return z;
        }

        function uebernehmenKnopf(feld, wert, danach) {
            const k = el('button', 'margin-left:8px; font-size:12px; padding:1px 8px; cursor:pointer;', 'übernehmen');
            k.type = 'button';
            k.addEventListener('click', () => { feld.value = wert; hervorheben(feld); if (danach) danach(); pruefungZeigen(); });
            return k;
        }

        function hervorheben(feld) {
            // Pruefung und ISO-4-Zeile sollen den neuen Wert sehen
            feld.dispatchEvent(new Event('input', { bubbles: true }));
            feld.style.transition = 'background-color 0.4s';
            feld.style.backgroundColor = '#e6fffa';
            setTimeout(() => { feld.style.backgroundColor = ''; }, 2500);
        }

        // Leere Felder fuellen, bei abweichenden Werten einen Vorschlag am Feld zeigen
        function eintragen(f, daten) {
            const zuordnung = [
                ['titel', daten.titel, true],
                ['abk', daten.abk, !!daten.abkSicher],
                ['publisher', daten.publisher, true],
                ['print', daten.print, true],
                ['online', daten.online, true]
            ];
            zuordnung.forEach(([k, neu, direkt]) => {
                const feld = f[k];
                if (!feld) return;
                const platz = feldPlatz(feld, 'vorschlag');
                platz.replaceChildren();
                if (!neu) return;
                const alt = feld.value.trim();
                if (alt === neu) return;
                if (!alt && direkt) {
                    feld.value = neu;
                    hervorheben(feld);
                    return;
                }
                const teile = [`Quelle schlägt vor: `, el('strong', '', neu)];
                if (k === 'abk' && daten.abkQuelle) teile.push(` (${daten.abkQuelle})`);
                const z = meldung('vorschlag', ...teile);
                z.appendChild(uebernehmenKnopf(feld, neu, () => platz.replaceChildren()));
                platz.appendChild(z);
            });
        }

        let pruefBox = null, dublettenBox = null, statusZeile = null;

        function pruefungZeigen() {
            const f = journalFormularFelder();
            if (!f || !pruefBox) return { fehler: [], hinweise: [] };
            const erg = journalPruefen(werteLesen(f), geholt ? { print: geholt.print, online: geholt.online } : null);

            // Publisher muss der DORA-Schreibweise entsprechen
            const pub = f.publisher ? f.publisher.value.trim() : '';
            let publisherVorschlag = null;
            if (pub && publisherListeCache && publisherListeCache.length && !publisherListeCache.some(([n]) => n === pub)) {
                const z = publisherZuordnen(pub, publisherListeCache);
                if (z && z.name !== pub) {
                    publisherVorschlag = z.name;
                    erg.hinweise.push({ feld: 'publisher', text: `In DORA heisst dieser Verlag „${z.name}“.` });
                } else {
                    erg.hinweise.push({ feld: 'publisher', text: `„${pub}“ kommt bei DORA-Journals noch nicht vor – Schreibweise prüfen oder einen Namen aus der Liste wählen.` });
                }
            }

            Object.keys(f).forEach(k => { if (f[k]) feldPlatz(f[k], 'pruefung').replaceChildren(); });
            const zeigen = (art, m) => {
                const feld = f[m.feld] || f.titel;
                const z = meldung(art, m.text);
                if (m.feld === 'publisher' && publisherVorschlag && art === 'hinweis') z.appendChild(uebernehmenKnopf(feld, publisherVorschlag));
                feldPlatz(feld, 'pruefung').appendChild(z);
            };
            erg.fehler.forEach(m => zeigen('fehler', m));
            erg.hinweise.forEach(m => zeigen('hinweis', m));

            // Oben nur eine Zusammenfassung
            pruefBox.replaceChildren();
            if (!erg.fehler.length && !erg.hinweise.length) {
                pruefBox.appendChild(el('div', 'color:#2f855a;', '✓ Keine Auffälligkeiten in den Eingaben.'));
            } else {
                const teile = [];
                if (erg.fehler.length) teile.push(`${erg.fehler.length} Fehler`);
                if (erg.hinweise.length) teile.push(`${erg.hinweise.length} Hinweis${erg.hinweise.length === 1 ? '' : 'e'}`);
                pruefBox.appendChild(el('div', `color:${erg.fehler.length ? '#c53030' : '#975a16'}; font-weight:600;`,
                    `${teile.join(', ')} – siehe Meldungen direkt an den Feldern.`));
            }
            return erg;
        }

        // Dubletten-Check: eine Solr-Abfrage auf die Journal-Objekte (im
        // Hintergrundskript), nach ISSN und Titel inkl. frueherer Titel.
        let dublettenLauf = 0;
        async function dublettenPruefen() {
            const f = journalFormularFelder();
            if (!f || !dublettenBox) return;
            const w = werteLesen(f);
            const issns = [w.print, w.online].filter(i => issnGueltig(i));
            const fruehere = (geholt && geholt.fruehereTitel) || [];
            if (!w.titel.trim() && !issns.length) { dublettenBox.replaceChildren(); return; }

            const lauf = ++dublettenLauf;
            dublettenBox.replaceChildren(el('div', 'color:#4a5568;', '⏳ Suche nach vorhandenen Journals in DORA …'));
            const antwort = await nachricht({ action: 'journalDubletten', titel: w.titel.trim(), fruehereTitel: fruehere, issns });
            if (lauf !== dublettenLauf) return; // inzwischen neu angestossen
            dublettenBox.replaceChildren();

            if (!antwort || !antwort.success) {
                dublettenBox.appendChild(el('div', 'color:#c53030;',
                    'Dubletten-Check fehlgeschlagen: ' + ((antwort && antwort.error) || 'keine Antwort') + '.'));
                return;
            }

            const treffer = dublettenEinstufen(antwort.data, w.titel, issns, fruehere);

            const starke = treffer.filter(t => t.stark);
            const aehnliche = treffer.filter(t => !t.stark);

            // Am Feld: unter dem Titel bzw. unter der ISSN, die schon vergeben ist
            [f.titel, f.print, f.online].forEach(e => feldPlatz(e, 'dublette').replaceChildren());
            starke.forEach(t => {
                const link = el('a', 'color:#9b2c2c; font-weight:700;', `${t.titel} (${t.pid})`);
                link.href = window.location.origin + '/islandora/object/' + encodeURIComponent(t.pid);
                link.target = '_blank';
                link.rel = 'noopener';
                const ziele = [];
                if (t.gleicherTitel || t.frueherTitel) ziele.push([f.titel, t.gleicherTitel ? 'Gleicher Titel' : 'Früherer Titel']);
                t.gleicheIssn.forEach(i => {
                    const feld = w.print === i ? f.print : f.online;
                    ziele.push([feld, `ISSN ${i} vergeben`]);
                });
                ziele.forEach(([feld, grund]) => {
                    feldPlatz(feld, 'dublette').appendChild(meldung('fehler', `Schon in DORA vorhanden – ${grund}: `, link.cloneNode(true)));
                });
            });

            if (!starke.length) {
                dublettenBox.appendChild(el('div', 'color:#2f855a;', '✓ Kein Journal mit diesem Titel'
                    + (fruehere.length ? ', früheren Titeln' : '') + (issns.length ? ' oder dieser ISSN' : '') + ' in DORA.'));
            } else {
                dublettenBox.appendChild(el('div', 'font-weight:600; color:#c53030;', '⚠ Schon in DORA vorhanden:'));
                dublettenBox.appendChild(trefferListe(starke));
            }
            if (aehnliche.length) {
                dublettenBox.appendChild(el('div', 'color:#4a5568; margin-top:4px;', 'Ähnliche Titel (zur Kontrolle):'));
                dublettenBox.appendChild(trefferListe(aehnliche.slice(0, 6)));
            }
        }

        function trefferListe(treffer) {
            const ul = el('ul', 'margin:2px 0 0 18px; padding:0;');
            treffer.forEach(t => {
                const li = el('li', 'list-style:disc;');
                const link = el('a', 'color:#2b6cb0;', t.titel || t.pid);
                link.href = window.location.origin + '/islandora/object/' + encodeURIComponent(t.pid);
                link.target = '_blank';
                link.rel = 'noopener';
                li.appendChild(link);
                const info = [t.pid, t.abk, t.publisher, t.issn.length ? 'ISSN ' + t.issn.join(', ') : '', t.eissn.length ? 'E-ISSN ' + t.eissn.join(', ') : '']
                    .filter(Boolean).join(' · ');
                li.appendChild(el('span', 'color:#718096;', ' – ' + info));
                const grund = [];
                if (t.gleicheIssn.length) grund.push('gleiche ISSN ' + t.gleicheIssn.join(', '));
                if (t.gleicherTitel) grund.push('gleicher Titel');
                if (t.frueherTitel) grund.push('früherer Titel des Journals');
                if (grund.length) li.appendChild(el('strong', 'color:#c53030;', ' (' + grund.join(', ') + ')'));
                ul.appendChild(li);
            });
            return ul;
        }

        async function datenHolen(eingabe, f) {
            const anfrage = journalSucheDeuten(eingabe);
            if (!anfrage.doi && !anfrage.issn) {
                statusZeile.textContent = 'Bitte eine ISSN (1234-5678) oder eine Artikel-DOI (10.xxxx/…) eingeben.';
                statusZeile.style.color = '#c53030';
                return;
            }
            statusZeile.textContent = '⏳ Hole Daten …';
            statusZeile.style.color = '#4a5568';
            const antwort = await nachricht({ action: 'journalDaten', ...anfrage });
            if (!antwort || !antwort.success || !antwort.data) {
                statusZeile.textContent = 'Nichts gefunden' + (antwort && antwort.error ? ': ' + antwort.error : '.');
                statusZeile.style.color = '#c53030';
                return;
            }
            geholt = antwort.data;
            // Publisher nie aus der Quelle uebernehmen, sondern in DORA-Schreibweise
            const extern = geholt.publisher || '';
            const zuordnung = publisherZuordnen(extern, await publisherListe());
            geholt.publisherExtern = extern;
            geholt.publisher = zuordnung ? zuordnung.name : '';
            publisherHinweisZeigen(f, extern, zuordnung);
            statusZeile.textContent = '✓ Daten von ' + geholt.quellen.join(', ') + '. Leere Felder sind ausgefüllt, Abweichungen stehen an den Feldern.'
                + (geholt.abkQuelle ? ` Abkürzung: ${geholt.abkQuelle}.` : '');
            statusZeile.style.color = '#2f855a';
            eintragen(f, geholt);
            pruefungZeigen();
            dublettenPruefen();
        }

        function iso4VorschlagEinrichten(f) {
            const zeile = feldPlatz(f.abk, 'iso4');

            let uhr = null, letzterTitel = null;
            const aktualisieren = async () => {
                const titel = f.titel.value.trim();
                if (!titel) { zeile.replaceChildren(); letzterTitel = ''; return; }
                let vorschlag = zeile.dataset.vorschlag || '';
                if (titel !== letzterTitel) {
                    letzterTitel = titel;
                    const antwort = await nachricht({ action: 'iso4Abkuerzen', titel });
                    if (titel !== f.titel.value.trim()) return; // inzwischen weitergetippt
                    vorschlag = antwort && antwort.success ? antwort.data : '';
                    zeile.dataset.vorschlag = vorschlag;
                }
                zeile.replaceChildren();
                if (!vorschlag) return;
                const eingetragen = f.abk.value.trim();
                if (eingetragen === vorschlag) {
                    zeile.appendChild(meldung('ok', 'Entspricht ISO 4.'));
                    return;
                }
                const z = meldung(eingetragen ? 'hinweis' : 'vorschlag',
                    eingetragen ? 'Weicht von ISO 4 ab. Vorschlag: ' : 'Vorschlag nach ISO 4: ', el('strong', '', vorschlag));
                z.appendChild(uebernehmenKnopf(f.abk, vorschlag, aktualisieren));
                z.appendChild(el('div', 'font-size:12px; color:#718096; margin-top:2px;',
                    'Automatisch aus der ISSN-Liste der Titelwort-Abkürzungen (LTWA) berechnet – bitte prüfen.'));
                zeile.appendChild(z);
            };
            const spaeter = () => { clearTimeout(uhr); uhr = setTimeout(aktualisieren, 300); };
            f.titel.addEventListener('input', spaeter);
            f.titel.addEventListener('change', spaeter);
            f.abk.addEventListener('input', spaeter);
            aktualisieren();
        }

        function publisherHinweisZeigen(f, extern, zuordnung) {
            if (!f.publisher) return;
            const platz = feldPlatz(f.publisher, 'quelle');
            platz.replaceChildren();
            if (!extern) return;
            if (zuordnung && zuordnung.name === extern) {
                platz.appendChild(meldung('ok', `„${extern}“ ist die DORA-Schreibweise.`));
            } else if (zuordnung) {
                platz.appendChild(meldung('ok', 'DORA-Schreibweise: ', el('strong', '', zuordnung.name), ` – die Quelle nennt „${extern}“.`));
            } else {
                platz.appendChild(meldung('hinweis', 'Die Quelle nennt ', el('strong', '', `„${extern}“`),
                    '. Diesen Verlag gibt es bei DORA-Journals noch nicht. Das Feld bleibt deshalb leer – bitte einen Namen aus der Liste wählen '
                    + '(ins Feld klicken) oder bewusst neu eintragen.'));
            }
        }

        async function publisherVorschlagsliste(f) {
            if (!f.publisher || document.getElementById('dora-publisher-liste')) return;
            const liste = await publisherListe();
            if (!liste.length) return;
            const datalist = document.createElement('datalist');
            datalist.id = 'dora-publisher-liste';
            liste.forEach(([name, anzahl]) => {
                const o = document.createElement('option');
                o.value = name;
                o.label = `${anzahl} Journal${anzahl === 1 ? '' : 's'}`;
                datalist.appendChild(o);
            });
            document.body.appendChild(datalist);
            f.publisher.setAttribute('list', datalist.id);
            f.publisher.setAttribute('autocomplete', 'off');
            pruefungZeigen();
        }

        function hashDatenLesen() {
            if (!window.location.hash.startsWith(HASH_PRAEFIX)) return null;
            try { return JSON.parse(decodeURIComponent(window.location.hash.slice(HASH_PRAEFIX.length))); } catch (e) { return null; }
        }

        function journalFormularAufbauen() {
            if (document.getElementById('dora-journal-neu')) return;
            const f = journalFormularFelder();
            const formular = f.titel.closest('form');

            const box = el('div', 'margin:0 0 14px; padding:10px 12px; border:1px solid #90cdf4; border-radius:4px; background:#f7fbff; font-family:sans-serif; font-size:13px; max-width:780px;');
            box.id = 'dora-journal-neu';
            box.appendChild(el('div', 'font-weight:700; color:#2a4365; margin-bottom:6px;', 'DORA-Helper: Journal neu erfassen'));

            const zeile = el('div', 'display:flex; gap:6px; align-items:center; flex-wrap:wrap;');
            const eingabe = el('input', 'flex:1; min-width:260px; padding:4px 6px;');
            eingabe.type = 'text';
            eingabe.placeholder = 'ISSN oder DOI eines Artikels aus dem Journal';
            const knopf = el('button', 'padding:4px 10px; font-weight:600; cursor:pointer;', 'Daten holen');
            knopf.type = 'button';
            zeile.append(eingabe, knopf);
            box.appendChild(zeile);

            statusZeile = el('div', 'margin-top:5px; font-size:12px;');
            dublettenBox = el('div', 'margin-top:8px; font-size:12px;');
            pruefBox = el('div', 'margin-top:8px; font-size:12px;');
            box.append(statusZeile, dublettenBox, pruefBox);
            formular.insertBefore(box, formular.firstChild);

            const los = () => datenHolen(eingabe.value, f);
            knopf.addEventListener('click', los);
            eingabe.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); los(); } });

            // ISO-4-Vorschlag unter dem Abkuerzungsfeld, rechnet beim Tippen mit
            if (f.abk) iso4VorschlagEinrichten(f);
            publisherVorschlagsliste(f);

            // Eingaben laufend pruefen; ISSN beim Verlassen in Form bringen
            [f.print, f.online].forEach(feld => feld.addEventListener('blur', () => {
                const n = issnNormalisieren(feld.value);
                if (n !== feld.value) feld.value = n;
            }));
            Object.values(f).filter(Boolean).forEach(feld => {
                feld.addEventListener('input', pruefungZeigen);
                feld.addEventListener('blur', pruefungZeigen);
            });
            let dublettenUhr = null;
            [f.titel, f.print, f.online].forEach(feld => feld.addEventListener('change', () => {
                clearTimeout(dublettenUhr);
                dublettenUhr = setTimeout(dublettenPruefen, 400);
            }));

            // Beim Speichern: echte Fehler einmal bestaetigen lassen
            formular.addEventListener('submit', e => {
                [f.print, f.online].forEach(feld => { feld.value = issnNormalisieren(feld.value); });
                const erg = pruefungZeigen();
                if (erg.fehler.length && !window.confirm('DORA-Helper hat Fehler gefunden:\n\n- ' + erg.fehler.map(m => m.text).join('\n- ') + '\n\nTrotzdem speichern?')) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                }
            }, true);

            // Aus dem Artikelformular uebergebene Angaben
            const mitgegeben = hashDatenLesen();
            if (mitgegeben) {
                const vorbelegt = { titel: mitgegeben.titel, publisher: '', abk: mitgegeben.abk,
                    print: issnNormalisieren(mitgegeben.issn), online: issnNormalisieren(mitgegeben.eissn), abkSicher: true };
                eintragen(f, vorbelegt);
                // Publisher aus dem Artikel nur in DORA-Schreibweise uebernehmen
                if (mitgegeben.publisher) {
                    publisherListe().then(l => {
                        const z = publisherZuordnen(mitgegeben.publisher, l);
                        if (z && f.publisher && !f.publisher.value.trim()) { f.publisher.value = z.name; hervorheben(f.publisher); }
                    });
                }
                const suche = mitgegeben.issn || mitgegeben.eissn || mitgegeben.doi || '';
                eingabe.value = mitgegeben.doi || suche;
                if (eingabe.value) los();
                else dublettenPruefen();
            }
            pruefungZeigen();
        }

        // =====================================================================
        // Teil B: Knopf im Artikelformular
        // =====================================================================

        // Der Knopf passt sich an: ist das Journal schon mit dem Artikel
        // verknuepft oder in DORA vorhanden, wird nichts neu angelegt.
        function artikelJournalFelder() {
            const q = n => document.querySelector('input[name="' + n + '"]');
            return {
                titel: q('host[titleInfo][title]'), abk: q('host[titleInfo][abbr_title]'), publisher: q('host[titleInfo][publisher]'),
                issn: q('host[titleInfo][issn]'), eissn: q('host[titleInfo][e-issn]'), pid: q('host[titleInfo][pid]')
            };
        }

        const KNOPF_STIL = 'margin:5px 0 0 6px; padding:4px 9px; font-size:12px; font-weight:600; cursor:pointer; '
            + 'border-radius:4px; border:1px solid #cbd5e0; background:#f8fafc; color:#475569;';

        function journalFormularOeffnen(af) {
            const doiFeld = document.getElementById('edit-identifiers-doi');
            const daten = {
                titel: af.titel.value.trim(),
                abk: af.abk ? af.abk.value.trim() : '',
                publisher: af.publisher ? af.publisher.value.trim() : '',
                issn: af.issn ? af.issn.value.trim() : '',
                eissn: af.eissn ? af.eissn.value.trim() : '',
                doi: doiFeld ? doiFeld.value.trim() : ''
            };
            window.open(window.location.origin + JOURNAL_FORM_URL + HASH_PRAEFIX + encodeURIComponent(JSON.stringify(daten)), '_blank');
        }

        // Vorhandenes Journal uebernehmen: Titel in DORA-Schreibweise setzen und die
        // bestehende Abfrage ("Journal neu abfragen") anstossen, die alle Felder fuellt.
        function journalUebernehmen(af, treffer) {
            af.titel.value = treffer.titel;
            af.titel.dispatchEvent(new Event('input', { bubbles: true }));
            const neuAbfragen = (af.titel.closest('.form-item') || document).querySelector('.dora-journal-knopf');
            if (neuAbfragen) neuAbfragen.click();
            else af.titel.focus();
        }

        let artikelStand = { schluessel: null, lauf: 0, doiVersucht: '' };

        async function artikelKnopfAktualisieren(halter, af) {
            const titel = af.titel.value.trim();
            const pid = af.pid ? af.pid.value.trim() : '';
            const issns = [af.issn, af.eissn].filter(Boolean).map(e => issnNormalisieren(e.value)).filter(issnGueltig);
            // Waehrend jemand im Titel tippt, nicht bei jeder Pause Solr fragen;
            // die Pruefung folgt beim Verlassen des Feldes (blur)
            if (document.activeElement === af.titel && !/^journals:/i.test(pid) && artikelStand.schluessel !== null) return;
            const schluessel = [titel, pid, issns.join(',')].join('|');
            if (schluessel === artikelStand.schluessel) return;
            artikelStand.schluessel = schluessel;
            const lauf = ++artikelStand.lauf;

            const zeigen = (...teile) => { if (lauf === artikelStand.lauf) halter.replaceChildren(...teile); };
            const neuKnopf = () => {
                const k = el('button', KNOPF_STIL, '＋ Journal neu anlegen');
                k.type = 'button';
                k.title = 'In DORA wurde kein Journal mit diesem Titel oder dieser ISSN gefunden. Öffnet das Formular für ein neues '
                    + 'Journal in einem neuen Tab, vorbefüllt mit den Angaben dieses Artikels.';
                k.addEventListener('click', () => journalFormularOeffnen(af));
                return k;
            };
            const objektLink = (p, text) => {
                const a = el('a', 'color:#2b6cb0;', text);
                a.href = window.location.origin + '/islandora/object/' + encodeURIComponent(p);
                a.target = '_blank';
                a.rel = 'noopener';
                return a;
            };

            // 1. Schon verknuepft
            if (/^journals:/i.test(pid)) {
                const info = el('span', 'margin-left:8px; font-size:12px; color:#2f855a;', '✓ Journal in DORA: ');
                info.appendChild(objektLink(pid, pid));
                zeigen(info);
                return;
            }
            if (!titel && !issns.length) { zeigen(neuKnopf()); return; }

            // 2. In DORA vorhanden? (Solr, nach ISSN und Titel)
            zeigen(el('span', 'margin-left:8px; font-size:12px; color:#718096;', '⏳ prüfe, ob das Journal in DORA existiert …'));
            let antwort = await nachricht({ action: 'journalDubletten', titel, issns });
            let treffer = antwort && antwort.success ? dublettenEinstufen(antwort.data, titel, issns, []).filter(t => t.stark) : [];

            // Ohne Treffer und ohne ISSN: ISSN ueber die DOI des Artikels nachschlagen (einmal je DOI)
            const doiFeld = document.getElementById('edit-identifiers-doi');
            const doi = doiFeld ? doiFeld.value.trim() : '';
            if (!treffer.length && !issns.length && doi && artikelStand.doiVersucht !== doi) {
                artikelStand.doiVersucht = doi;
                const daten = await nachricht({ action: 'journalDaten', doi });
                const d = daten && daten.success && daten.data;
                const crIssns = d ? [d.print, d.online].filter(issnGueltig) : [];
                if (crIssns.length) {
                    antwort = await nachricht({ action: 'journalDubletten', titel: d.titel || titel, issns: crIssns });
                    treffer = antwort && antwort.success ? dublettenEinstufen(antwort.data, d.titel || titel, crIssns, []).filter(t => t.stark) : [];
                }
            }
            if (lauf !== artikelStand.lauf) return;

            if (!antwort || !antwort.success) {
                // Solr nicht erreichbar: neu anlegen bleibt moeglich, das Journal-Formular prueft selbst
                const k = neuKnopf();
                k.title += ' (Prüfung in DORA nicht möglich: ' + ((antwort && antwort.error) || 'keine Antwort') + ')';
                zeigen(k);
                return;
            }
            if (!treffer.length) { zeigen(neuKnopf()); return; }

            const t = treffer[0];
            const k = el('button', KNOPF_STIL + ' background:#f0fff4; color:#276749; border-color:#9ae6b4;', '↪ Vorhandenes Journal übernehmen');
            k.type = 'button';
            k.title = `„${t.titel}“ (${t.pid}) gibt es schon in DORA. Setzt den Titel in DORA-Schreibweise und holt die Journalangaben.`;
            k.addEventListener('click', () => journalUebernehmen(af, t));
            const info = el('span', 'margin-left:8px; font-size:12px; color:#4a5568;', 'In DORA vorhanden: ');
            info.appendChild(objektLink(t.pid, t.titel));
            const grund = t.gleicheIssn.length ? 'gleiche ISSN' : 'gleicher Titel';
            info.appendChild(el('span', 'color:#718096;', ` (${t.pid}, ${grund})`));
            zeigen(k, info);
        }

        function artikelKnopfSetzen() {
            const af = artikelJournalFelder();
            if (!af.titel) return;
            // Nur bei echten Journalfeldern (nicht beim Proceedings-Titel)
            if (typeof feldIstJournalname === 'function' && !feldIstJournalname(af.titel)) return;
            const huelle = af.titel.closest('.form-item') || af.titel.parentNode;
            if (!huelle) return;

            let halter = huelle.querySelector('.dora-journal-neu-halter');
            if (!halter) {
                halter = el('span', '');
                halter.className = 'dora-journal-neu-halter';
                const leiste = huelle.querySelector('.dora-journal-leiste');
                const alt = leiste && leiste.querySelector('.dora-journal-knopf');
                if (alt) alt.insertAdjacentElement('afterend', halter);
                else (leiste || huelle).appendChild(halter);
                [af.titel, af.issn, af.eissn].filter(Boolean).forEach(e => {
                    e.addEventListener('change', () => artikelKnopfAktualisieren(halter, af));
                    e.addEventListener('blur', () => setTimeout(() => artikelKnopfAktualisieren(halter, af), 300));
                });
            }
            // Wird bei jeder Seitenaenderung aufgerufen; laeuft nur, wenn sich Titel, PID oder ISSN geaendert haben
            artikelKnopfAktualisieren(halter, af);
        }

        // =====================================================================

        function pruefen() {
            if (istJournalFormular()) journalFormularAufbauen();
            else artikelKnopfSetzen();
        }

        let uhr = null;
        new MutationObserver(() => { clearTimeout(uhr); uhr = setTimeout(pruefen, 500); })
            .observe(document.documentElement, { childList: true, subtree: true });
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pruefen);
        else pruefen();
    })();
}
