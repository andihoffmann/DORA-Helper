// pdf_abgleich.js
//
// Prueft beim Auswaehlen eines PDFs fuer den Upload, ob die Datei zum
// Datensatz passt: DOI, Titel und Autorennamen aus den Metadaten werden im
// Text der ersten Seiten gesucht. Die Datei wird nur lokal gelesen (pdf.js im
// Hintergrundskript); ins Netz geht hoechstens die DOI fuer Crossref.
//
// Das Ergebnis ist nur ein Hinweis (Ampel), der Upload wird nie blockiert.

// ---------------------------------------------------------------------------
// Reine Vergleichslogik (ohne DOM, damit sie sich mit node testen laesst)
// ---------------------------------------------------------------------------

const PDF_ABGLEICH_STOPPWOERTER = new Set((
    'the of and in on for to a an with by from at as or its their is are be into via using under between '
    + 'over after before during within without toward towards than this that these those new based case study '
    + 'der die das und in im am an auf fuer mit von zu zur zum bei aus ein eine einer eines den dem des ueber '
    + 'le la les de du des et en au aux un une pour par sur dans'
).split(/\s+/));

// Woerter, die in fast jedem lesbaren Fachtext vorkommen. Fehlen sie, ist die
// Textebene vermutlich unbrauchbar (Schrift ohne Zeichenzuordnung).
const PDF_ABGLEICH_HAEUFIG = new Set('the of and in to is der die und von le la et de'.split(' '));

function pdfAbgleichNorm(text) {
    return String(text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/ß/g, 'ss')
        .toLowerCase();
}

function pdfAbgleichWoerter(text) {
    return pdfAbgleichNorm(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function pdfAbgleichPaare(woerter) {
    const paare = [];
    for (let i = 0; i + 1 < woerter.length; i++) paare.push(woerter[i] + ' ' + woerter[i + 1]);
    return paare;
}

function pdfAbgleichDoiNorm(doi) {
    return String(doi || '').trim().toLowerCase()
        .replace(/^https?:\/\/(dx\.)?doi\.org\//, '').replace(/^doi:\s*/, '')
        .replace(/[.,;:)\]}>'"_]+$/, '');
}

// Alle DOIs im Text; Zeilenumbrueche mitten in der DOI werden mitbedacht.
function pdfAbgleichDoisImText(text) {
    const gefunden = new Set();
    const roh = String(text || '');
    (roh.match(/10\.\d{4,9}\/[^\s"<>]+/gi) || []).forEach(d => gefunden.add(pdfAbgleichDoiNorm(d)));
    return Array.from(gefunden).filter(d => d.length > 8);
}

// Bereitet den PDF-Text einmal auf: Woerter, Wortpaare, kompakte Fassung.
function pdfAbgleichTextIndex(text) {
    const roh = String(text || '');
    // Silbentrennung am Zeilenende ("communi- cation") zusaetzlich zusammenziehen
    const entTrennt = roh.replace(/(\p{L})-\s+(\p{Ll})/gu, '$1$2');
    const w1 = pdfAbgleichWoerter(roh);
    const w2 = pdfAbgleichWoerter(entTrennt);
    return {
        woerter: new Set(w1.concat(w2)),
        paare: new Set(pdfAbgleichPaare(w1).concat(pdfAbgleichPaare(w2))),
        kompakt: pdfAbgleichNorm(roh).replace(/\s+/g, ''),
        anzahl: w1.length,
        haeufigAnteil: w1.length ? w1.filter(w => PDF_ABGLEICH_HAEUFIG.has(w)).length / w1.length : 0
    };
}

function pdfAbgleichTitel(titel, index) {
    const woerter = pdfAbgleichWoerter(titel);
    const wichtig = Array.from(new Set(woerter.filter(w => w.length >= 3 && !PDF_ABGLEICH_STOPPWOERTER.has(w))));
    const paare = Array.from(new Set(pdfAbgleichPaare(woerter)));
    const wortAnteil = wichtig.length ? wichtig.filter(w => index.woerter.has(w)).length / wichtig.length : 0;
    const paarAnteil = paare.length ? paare.filter(p => index.paare.has(p)).length / paare.length : wortAnteil;
    let stufe = 'schwach';
    if ((paarAnteil >= 0.6 && wortAnteil >= 0.7) || (wortAnteil >= 0.9 && wichtig.length >= 4)) stufe = 'stark';
    else if (wortAnteil >= 0.5 || paarAnteil >= 0.3) stufe = 'teilweise';
    return { stufe, wortAnteil, paarAnteil, anzahlWoerter: wichtig.length };
}

function pdfAbgleichAutoren(nachnamen, index) {
    const liste = (nachnamen || []).filter(Boolean).slice(0, 10);
    const treffer = liste.map(n => {
        const teile = pdfAbgleichWoerter(n).filter(t => t.length >= 2);
        return teile.length > 0 && teile.every(t => index.woerter.has(t));
    });
    return {
        anzahl: liste.length,
        gefunden: treffer.filter(Boolean).length,
        erster: liste.length ? treffer[0] : null,
        ersterName: liste[0] || ''
    };
}

// referenz: { doi, titel:[...], autoren:[Nachnamen] }
// pdf: { text, metaText, seiten }
// Ergebnis: { ampel: gruen|gelb|rot|grau, kurz, gruende:[...] }
function pdfAbgleichBewerten(referenz, pdf) {
    const ref = referenz || {};
    const titelListe = (ref.titel || []).filter(t => t && t.trim());
    const eigeneDoi = pdfAbgleichDoiNorm(ref.doi);
    const autoren = (ref.autoren || []).filter(Boolean);
    const gruende = [];

    if (!titelListe.length && !eigeneDoi) {
        return { ampel: 'grau', kurz: 'Keine Metadaten zum Vergleich', gruende: ['Weder Titel noch DOI des Datensatzes bekannt.'] };
    }

    const alles = (pdf.text || '') + '\n' + (pdf.metaText || '');
    const index = pdfAbgleichTextIndex(alles);
    const textIndex = pdfAbgleichTextIndex(pdf.text || '');

    // DOI: eigene gefunden? Supplements haengen oft ".s001" o.ae. an.
    const doisImPdf = pdfAbgleichDoisImText(alles);
    const doiKompakt = eigeneDoi ? eigeneDoi.replace(/\s+/g, '') : '';
    const eigeneDoiDa = !!doiKompakt && (index.kompakt.includes(doiKompakt) || doisImPdf.some(d => d === eigeneDoi || d.startsWith(eigeneDoi)));
    const fremdeDois = doisImPdf.filter(d => !eigeneDoi || !(d === eigeneDoi || d.startsWith(eigeneDoi) || eigeneDoi.startsWith(d)));

    if (textIndex.anzahl < 40 && !eigeneDoiDa) {
        return { ampel: 'grau', kurz: 'Kein lesbarer Text im PDF', gruende: ['Das PDF hat keine oder kaum eine Textebene (eingescannt?). Bitte selbst ansehen.'] };
    }
    if (textIndex.haeufigAnteil < 0.02 && !eigeneDoiDa) {
        return { ampel: 'grau', kurz: 'Text im PDF nicht lesbar', gruende: ['Die Textebene enthaelt kaum normale Woerter (Schrift ohne Zeichenzuordnung?). Bitte selbst ansehen.'] };
    }

    // Bestes Ergebnis ueber alle Titelfassungen (DORA, Crossref)
    const stufenWert = { schwach: 0, teilweise: 1, stark: 2 };
    let titel = null;
    titelListe.forEach(t => {
        const e = pdfAbgleichTitel(t, index);
        if (!titel || stufenWert[e.stufe] > stufenWert[titel.stufe]
            || (e.stufe === titel.stufe && e.wortAnteil > titel.wortAnteil)) titel = e;
    });
    const aut = pdfAbgleichAutoren(autoren, index);

    if (eigeneDoiDa) gruende.push('DOI des Datensatzes steht im PDF.');
    else if (eigeneDoi) gruende.push('DOI des Datensatzes nicht im PDF gefunden.');
    if (titel) {
        const prozent = Math.round(titel.wortAnteil * 100);
        if (titel.stufe === 'stark') gruende.push('Titel gefunden.');
        else if (titel.stufe === 'teilweise') gruende.push(`Titel nur teilweise gefunden (${prozent} % der Titelwoerter).`);
        else gruende.push(`Titel nicht gefunden (${prozent} % der Titelwoerter).`);
    }
    if (aut.anzahl) {
        if (aut.erster) gruende.push(`Erstautor/in (${aut.ersterName}) gefunden.`);
        else gruende.push(`Erstautor/in (${aut.ersterName}) nicht gefunden.`);
        if (aut.anzahl > 1) gruende.push(`${aut.gefunden} von ${aut.anzahl} Autorennamen gefunden.`);
    }
    if (!eigeneDoiDa && fremdeDois.length) {
        gruende.push('Andere DOI im PDF: ' + fremdeDois.slice(0, 3).join(', ') + (fremdeDois.length > 3 ? ' …' : ''));
    }

    const autorenTeil = aut.anzahl ? aut.gefunden / aut.anzahl : 0;

    if (eigeneDoiDa) {
        return { ampel: 'gruen', kurz: 'Passt (DOI gefunden)', gruende };
    }
    if (titel && titel.stufe === 'stark') {
        return { ampel: 'gruen', kurz: 'Passt (Titel gefunden)', gruende };
    }
    if (titel && titel.stufe === 'teilweise') {
        if (aut.anzahl && aut.gefunden === 0) {
            gruende.push('Kein Autorenname des Datensatzes kommt vor – evtl. ein anderer Artikel zum selben Thema.');
            return { ampel: 'rot', kurz: 'Passt wahrscheinlich nicht', gruende };
        }
        return { ampel: 'gelb', kurz: 'Unsicher – bitte kurz ansehen', gruende };
    }
    if (!titel) {
        // Nur DOI als Vergleich und die fehlt
        return { ampel: fremdeDois.length ? 'rot' : 'gelb', kurz: fremdeDois.length ? 'Passt wahrscheinlich nicht' : 'Unsicher – bitte kurz ansehen', gruende };
    }
    // Titel nicht gefunden
    if (autorenTeil >= 0.5 || aut.erster) {
        gruende.push('Die Autorennamen kommen vor, der Titel aber nicht – evtl. ein anderer Artikel derselben Gruppe.');
    }
    return { ampel: 'rot', kurz: 'Passt wahrscheinlich nicht', gruende };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { pdfAbgleichBewerten, pdfAbgleichTitel, pdfAbgleichTextIndex, pdfAbgleichDoisImText, pdfAbgleichDoiNorm };
}

// ---------------------------------------------------------------------------
// Anbindung an die DORA-Seiten
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime) {
    (function () {
        const ERGEBNIS_KEY = 'dora_helper_pdfabgleich_ergebnisse';
        const INGEST_META_KEY = 'dora_helper_pdfabgleich_ingest';
        const MAX_BYTES = 80 * 1024 * 1024;
        const FARBEN = {
            gruen: { rand: '#2f855a', grund: '#f0fff4', zeichen: '🟢' },
            gelb: { rand: '#b7791f', grund: '#fffff0', zeichen: '🟡' },
            rot: { rand: '#c53030', grund: '#fff5f5', zeichen: '🔴' },
            grau: { rand: '#718096', grund: '#f7fafc', zeichen: '⚪' },
            laeuft: { rand: '#0073e6', grund: '#ebf8ff', zeichen: '⏳' }
        };

        function seitenSchluessel() {
            const m = window.location.pathname.match(/islandora\/object\/([^/]+)/);
            return m ? decodeURIComponent(m[1]) : 'ingest';
        }

        function istObjektPid(pid) {
            const p = (pid || '').toLowerCase();
            return /^(psi|empa|eawag|wsl):/.test(p) && !p.includes('publications') && !p.includes('external');
        }

        function sitzungLesen(key, standard) {
            try { return JSON.parse(sessionStorage.getItem(key)) || standard; } catch (e) { return standard; }
        }
        function sitzungSchreiben(key, wert) {
            try { sessionStorage.setItem(key, JSON.stringify(wert)); } catch (e) { /* voll oder gesperrt */ }
        }

        // --- Metadaten aus dem Formular merken (Ingest: der Upload ist ein spaeterer Schritt) ---

        function formularTitel() {
            const cke = document.getElementById('cke_edit-titleinfo-title-text-format-value');
            const iframe = cke && cke.querySelector('iframe');
            if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
                const t = iframe.contentDocument.body.textContent.trim();
                if (t) return t;
            }
            const feld = document.getElementById('edit-titleinfo-title-text-format-value');
            return feld ? feld.value.replace(/<[^>]+>/g, ' ').trim() : '';
        }

        function formularAutoren() {
            const namen = [];
            document.querySelectorAll('input[type="text"][name$="[valName]"]').forEach(feld => {
                if (feld.closest('.form-item-supervisor, .form-item-host-editor')) return;
                const pane = feld.closest('.islandora-form-fieldpanel-pane, tr') || feld.parentNode;
                const fam = pane && pane.querySelector('input[name$="[family]"]');
                const name = (fam && fam.value.trim()) || feld.value.split(',')[0].trim();
                if (name) namen.push(name);
            });
            return namen;
        }

        function formularMerken() {
            if (seitenSchluessel() !== 'ingest' || !document.getElementById('edit-titleinfo-title-text-format-value')) return;
            const titel = formularTitel();
            if (!titel) return;
            const doiFeld = document.getElementById('edit-identifiers-doi');
            sitzungSchreiben(INGEST_META_KEY, {
                titel, autoren: formularAutoren(),
                doi: doiFeld ? doiFeld.value.trim() : '',
                zeit: Date.now()
            });
        }

        document.addEventListener('click', e => {
            if (e.target && e.target.matches && e.target.matches('input[type="submit"], button[type="submit"]')) formularMerken();
        }, true);
        document.addEventListener('submit', formularMerken, true);

        // --- Vergleichsdaten zusammenstellen ---

        let referenzVersprechen = null;

        function modsLesen(xml) {
            const doc = new DOMParser().parseFromString(xml, 'text/xml');
            const titelKnoten = Array.from(doc.querySelectorAll('mods > titleInfo:not([type]) > title, titleInfo:not([type]) > title'));
            const titel = titelKnoten.length ? titelKnoten[0].textContent.trim() : '';
            const autoren = [];
            doc.querySelectorAll('mods > name').forEach(name => {
                const rolle = (name.querySelector('role > roleTerm') || {}).textContent || '';
                if (rolle && !/author/i.test(rolle)) return;
                const fam = name.querySelector('namePart[type="family"]');
                if (fam && fam.textContent.trim()) autoren.push(fam.textContent.trim());
            });
            const doiKnoten = doc.querySelector('identifier[type="doi"]');
            return { titel, autoren, doi: doiKnoten ? doiKnoten.textContent.trim() : '' };
        }

        async function referenzHolen() {
            const pid = seitenSchluessel();
            const ref = { titel: [], autoren: [], doi: '', quelle: [] };

            if (istObjektPid(pid)) {
                try {
                    const inst = window.location.pathname.split('/')[1] || 'psi';
                    const antwort = await fetch(`/${inst}/islandora/object/${encodeURIComponent(pid)}/datastream/MODS`);
                    if (antwort.ok) {
                        const m = modsLesen(await antwort.text());
                        if (m.titel) ref.titel.push(m.titel);
                        ref.autoren = m.autoren;
                        ref.doi = m.doi;
                        ref.quelle.push('DORA-Datensatz');
                    }
                } catch (e) { console.warn('DORA-Helper PDF-Abgleich: MODS nicht lesbar', e); }
            } else {
                const gemerkt = sitzungLesen(INGEST_META_KEY, null);
                if (gemerkt && Date.now() - gemerkt.zeit < 12 * 3600 * 1000) {
                    if (gemerkt.titel) ref.titel.push(gemerkt.titel);
                    ref.autoren = gemerkt.autoren || [];
                    ref.doi = gemerkt.doi || '';
                    ref.quelle.push('Formular');
                }
            }

            if (!ref.doi) {
                ref.doi = sessionStorage.getItem('dora_helper_current_doi_' + pid)
                    || new URLSearchParams(window.location.search).get('doi') || '';
            }
            ref.doi = pdfAbgleichDoiNorm(ref.doi);

            if (ref.doi) {
                const cr = await new Promise(resolve =>
                    chrome.runtime.sendMessage({ action: 'pdfAbgleichCrossref', doi: ref.doi }, resolve));
                if (cr && cr.success && cr.data) {
                    (cr.data.titel || []).forEach(t => { if (t && !ref.titel.includes(t)) ref.titel.push(t); });
                    if (!ref.autoren.length) ref.autoren = cr.data.autoren || [];
                    ref.quelle.push('Crossref');
                }
            }
            return ref;
        }

        function referenz() {
            if (!referenzVersprechen) referenzVersprechen = referenzHolen();
            return referenzVersprechen;
        }

        // --- PDF lesen und pruefen ---

        function alsDataUrl(datei) {
            return new Promise((resolve, reject) => {
                const leser = new FileReader();
                leser.onload = () => resolve(leser.result);
                leser.onerror = () => reject(new Error('Datei konnte nicht gelesen werden.'));
                leser.readAsDataURL(datei);
            });
        }

        function dateiKennung(datei) { return datei.name + '|' + datei.size; }

        function ergebnisse() {
            const alle = sitzungLesen(ERGEBNIS_KEY, {});
            const liste = alle[seitenSchluessel()] || [];
            return liste.filter(e => Date.now() - e.zeit < 6 * 3600 * 1000);
        }

        function ergebnisSetzen(eintrag) {
            const alle = sitzungLesen(ERGEBNIS_KEY, {});
            const key = seitenSchluessel();
            const liste = (alle[key] || []).filter(e => e.kennung !== eintrag.kennung);
            liste.push(eintrag);
            alle[key] = liste.slice(-20);
            sitzungSchreiben(ERGEBNIS_KEY, alle);
            anzeigen();
        }

        async function dateiPruefen(datei) {
            const basis = { kennung: dateiKennung(datei), name: datei.name, zeit: Date.now() };
            ergebnisSetzen(Object.assign({}, basis, { ampel: 'laeuft', kurz: 'Wird geprüft …', gruende: [] }));
            try {
                if (datei.size > MAX_BYTES) {
                    ergebnisSetzen(Object.assign({}, basis, { ampel: 'grau', kurz: 'Zu gross für die Prüfung', gruende: [] }));
                    return;
                }
                const [ref, dataUrl] = await Promise.all([referenz(), alsDataUrl(datei)]);
                const antwort = await new Promise(resolve =>
                    chrome.runtime.sendMessage({ action: 'pdfAbgleichText', fileData: dataUrl }, resolve));
                if (!antwort || !antwort.success) throw new Error((antwort && antwort.error) || 'Keine Antwort vom Hintergrundskript');
                const urteil = pdfAbgleichBewerten(ref, antwort.data);
                if (ref.quelle.length) urteil.gruende.push('Verglichen mit: ' + ref.quelle.join(', ') + '.');
                ergebnisSetzen(Object.assign({}, basis, urteil));
            } catch (e) {
                console.error('DORA-Helper PDF-Abgleich:', e);
                ergebnisSetzen(Object.assign({}, basis, { ampel: 'grau', kurz: 'Prüfung fehlgeschlagen', gruende: [e.message] }));
            }
        }

        function istPdf(datei) {
            return datei && (datei.type === 'application/pdf' || /\.pdf$/i.test(datei.name || ''));
        }

        function istUploadSeite() {
            const loc = window.location.href;
            return /\/(ingest|manage|edit)\b|pdf_management|pdf_upload|datastream/i.test(loc);
        }

        function dateienPruefen(dateien) {
            if (!istUploadSeite()) return;
            Array.from(dateien || []).filter(istPdf).forEach(dateiPruefen);
        }

        // Auswahl ueber den Dateidialog (Plupload legt sein eigenes <input> an).
        // Die Liste wird sofort kopiert, weil Plupload das Feld danach leert.
        document.addEventListener('change', e => {
            const feld = e.target;
            if (!feld || feld.tagName !== 'INPUT' || feld.type !== 'file') return;
            if (feld.closest('[class^="dora-"], [id^="dora-"]')) return;
            dateienPruefen(Array.from(feld.files || []));
        }, true);

        // Ablegen per Drag & Drop in die Plupload-Liste
        document.addEventListener('drop', e => {
            const ziel = e.target && e.target.closest ? e.target : null;
            if (!ziel || ziel.closest('.dora-pdf-drop, [id^="dora-"]')) return;
            if (!ziel.closest('.plupload, .plupload-element, form')) return;
            if (e.dataTransfer && e.dataTransfer.files) dateienPruefen(Array.from(e.dataTransfer.files));
        }, true);

        // --- Anzeige ---

        function zeile(eintrag) {
            const f = FARBEN[eintrag.ampel] || FARBEN.grau;
            const z = document.createElement('div');
            z.style.cssText = `border-left:4px solid ${f.rand}; background:${f.grund}; padding:6px 8px; margin:4px 0; border-radius:3px;`;
            const kopf = document.createElement('div');
            kopf.style.cssText = 'font-weight:600;';
            kopf.textContent = `${f.zeichen} ${eintrag.name} – ${eintrag.kurz}`;
            z.appendChild(kopf);
            if (eintrag.gruende && eintrag.gruende.length) {
                const ul = document.createElement('ul');
                ul.style.cssText = 'margin:3px 0 0 18px; padding:0; font-size:12px; color:#4a5568;';
                eintrag.gruende.forEach(g => {
                    const li = document.createElement('li');
                    li.textContent = g;
                    li.style.cssText = 'list-style:disc; margin:0;';
                    ul.appendChild(li);
                });
                z.appendChild(ul);
            }
            return z;
        }

        function ankerFinden() {
            return document.getElementById('lib4ridora-ingest-datastream-upload-wrapper')
                || document.querySelector('.plupload-element')
                || (() => {
                    const feld = Array.from(document.querySelectorAll('input[type="file"]'))
                        .find(f => !f.closest('[id^="dora-"]') && !f.closest('.plupload'));
                    return feld ? (feld.closest('.form-item') || feld) : null;
                })();
        }

        function badgesSetzen(liste) {
            const nachName = new Map(liste.map(e => [e.name, e]));
            const ziele = document.querySelectorAll('.plupload_file_name span, #edit-wrapper-table-wrapper-file td, fieldset[id^="edit-files-"] legend span');
            ziele.forEach(el => {
                if (el.querySelector('.dora-pdf-abgleich-badge')) return;
                const text = (el.firstChild && el.firstChild.nodeType === 3 ? el.firstChild.nodeValue : el.textContent || '').trim();
                const eintrag = nachName.get(text);
                if (!eintrag || eintrag.ampel === 'laeuft') return;
                const b = document.createElement('span');
                b.className = 'dora-pdf-abgleich-badge';
                b.textContent = ' ' + (FARBEN[eintrag.ampel] || FARBEN.grau).zeichen;
                b.title = eintrag.kurz + '\n' + (eintrag.gruende || []).join('\n');
                el.appendChild(b);
            });
        }

        let zeichnet = false;
        function anzeigen() {
            if (zeichnet) return;
            zeichnet = true;
            try {
                const liste = ergebnisse();
                let box = document.getElementById('dora-pdf-abgleich');
                if (!liste.length) { if (box) box.remove(); return; }
                const anker = ankerFinden();
                if (!anker) return;
                if (!box) {
                    box = document.createElement('div');
                    box.id = 'dora-pdf-abgleich';
                    box.style.cssText = 'margin:10px 0; padding:8px 10px; border:1px solid #cbd5e0; border-radius:4px; background:#fff; font-family:sans-serif; font-size:13px;';
                }
                if (box.nextSibling !== anker) anker.parentNode.insertBefore(box, anker);
                box.textContent = '';
                const titel = document.createElement('div');
                titel.style.cssText = 'display:flex; justify-content:space-between; align-items:center; font-weight:700; color:#2d3748; margin-bottom:2px;';
                titel.textContent = 'DORA-Helper: Passt das PDF zum Datensatz?';
                const leeren = document.createElement('a');
                leeren.href = '#';
                leeren.textContent = 'Liste leeren';
                leeren.style.cssText = 'font-weight:400; font-size:11px; color:#0073e6;';
                leeren.addEventListener('click', e => {
                    e.preventDefault();
                    const alle = sitzungLesen(ERGEBNIS_KEY, {});
                    delete alle[seitenSchluessel()];
                    sitzungSchreiben(ERGEBNIS_KEY, alle);
                    anzeigen();
                });
                titel.appendChild(leeren);
                box.appendChild(titel);
                liste.slice().reverse().forEach(e => box.appendChild(zeile(e)));
                badgesSetzen(liste);
            } finally {
                zeichnet = false;
            }
        }

        // Drupal ersetzt den Upload-Bereich per AJAX - danach neu einsetzen
        let uhr = null;
        new MutationObserver(muts => {
            if (muts.every(m => m.target && m.target.closest && m.target.closest('#dora-pdf-abgleich'))) return;
            clearTimeout(uhr);
            uhr = setTimeout(anzeigen, 300);
        }).observe(document.documentElement, { childList: true, subtree: true });

        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', anzeigen);
        else anzeigen();
    })();
}
