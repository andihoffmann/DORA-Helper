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
3-Nitrobenzanthrone -> 3-Nitrobenzanthrone
ABC transporter -> ABC transporter
Acetochlor -> Acetochlor
Acidianus -> Acidianus
Acyrthosiphon -> Acyrthosiphon
Adrien -> Adrien
AFFF -> AFFF
AFLP -> AFLP
Africa -> Africa
Ag-cloth -> Ag-cloth
Al13 -> Al13
Al30 -> Al30
Albania -> Albania
Alburnoides -> Alburnoides
Alcolapia -> Alcolapia
Alnus -> Alnus
Alopecurus -> Alopecurus
Alps -> Alps
AMPA -> AMPA
Amphipoda -> Amphipoda
Anostostomatidae -> Anostostomatidae
AOB -> AOB
AOC -> AOC
AOP -> AOP
AOX -> AOX
APEX -> APEX
Aphididae -> Aphididae
Aphidius -> Aphidius
Aphis -> Aphis
Aquifex -> Aquifex
Aranayake -> Aranayake
Archaea -> Archaea
Arl2/Arl3 -> Arl2/Arl3
Ascaris -> Ascaris
Asellus -> Asellus
Asia -> Asia
ATR-FTIR -> ATR-FTIR
Australia -> Australia
Austria -> Austria
B-TOF -> B-TOF
Baetis -> Baetis
BAMBI -> BAMBI
Bangladesh -> Bangladesh
BapA -> BapA
Bayer -> Bayer
Beijing -> Beijing
Bergmann -> Bergmann
Bistorta -> Bistorta
BMK -> BMK
BOP -> BOP
Brachypodietalia -> Brachypodietalia
Brazil -> Brazil
Brunei -> Brunei
BSAF -> BSAF
BSF -> BSF
BSM1 -> BSM1
Buddenbrockia -> Buddenbrockia
Bufo -> Bufo
Burkina Faso -> Burkina Faso
Bythotrephes -> Bythotrephes
C index -> C index
C/N-ratio -> C/N-ratio
C. parapsilosis -> C. parapsilosis
California -> California
CALUX -> CALUX
Campylomormyrus -> Campylomormyrus
Canis -> Canis
Capra -> Capra
Capreolus -> Capreolus
Caribbean -> Caribbean
Castanea -> Castanea
Castor -> Castor
CatBoost -> CatBoost
Caullerya -> Caullerya
CCT -> CCT
CDI -> CDI
CDK8 -> CDK8
CDNB -> CDNB
CE -> CE
CEN -> CEN
CeO2 -> CeO2
Cervus -> Cervus
CEX -> CEX
CFUs -> CFUs
Chad -> Chad
China -> China
Chironomus -> Chironomus
CLTS -> CLTS
CMS -> CMS
CNV -> CNV
COD -> COD
COI -> COI
Collins -> Collins
Colocasia -> Colocasia
Colombia -> Colombia
Compositae -> Compositae
Coregonus -> Coregonus
Costa Rica -> Costa Rica
Cottus -> Cottus
COVID-19 -> COVID-19
CRAN -> CRAN
CRISPR -> CRISPR
Cryphonectria -> Cryphonectria
CSD -> CSD
CSIA -> CSIA
CSRA -> CSRA
CSS -> CSS
CST -> CST
CUDA -> CUDA
Cyanobacteria -> Cyanobacteria
Cyclorhipidion -> Cyclorhipidion
Cylindrospermopsis -> Cylindrospermopsis
Cymatia -> Cymatia
Cyprinidae -> Cyprinidae
Danio -> Danio
Dansgaard -> Dansgaard
Danube -> Danube
DAPI -> DAPI
Daphnia -> Daphnia
DART -> DART
DAQ -> DAQ
ddRADseq -> ddRADseq
Dead Sea -> Dead Sea
Dehalococcoides -> Dehalococcoides
Delft3D -> Delft3D
DEM -> DEM
DET -> DET
DGT -> DGT
DIBH -> DIBH
Dikerogammarus -> Dikerogammarus
DIN -> DIN
Diptera -> Diptera
Dnieper -> Dnieper
DNA -> DNA
DOC -> DOC
DOE -> DOE
DOM -> DOM
Don -> Don
Dothistroma -> Dothistroma
DOXP -> DOXP
Dreissena -> Dreissena
DRIFT -> DRIFT
EBPR -> EBPR
Eca -> Eca
Ecology -> Ecology
Ectodysplasin -> Ectodysplasin
EDA -> EDA
EE2 -> EE2
EEQ -> EEQ
EFAS -> EFAS
EGFR -> EGFR
EHEC -> EHEC
Ellenberg -> Ellenberg
ENM -> ENM
Epic -> Epic
Ephippia -> Ephippia
EPS -> EPS
ERGM -> ERGM
ESBL -> ESBL
Escherichia -> Escherichia
Esox -> Esox
ESTROM -> ESTROM
ETSA -> ETSA
EU -> EU
Euglena -> Euglena
Europe -> Europe
EUNIS -> EUNIS
EVD -> EVD
EVI -> EVI
EXAFS -> EXAFS
EXPOSIT -> EXPOSIT
FAIR -> FAIR
Fagus -> Fagus
FAO -> FAO
FCM -> FCM
FISH -> FISH
FLEX -> FLEX
Fomes -> Fomes
FOSS4G -> FOSS4G
FPOM -> FPOM
Fredericella -> Fredericella
FST -> FST
FUNGuild -> FUNGuild
Fusarium -> Fusarium
GAC -> GAC
G-APD -> G-APD
GAO -> GAO
Gammarus -> Gammarus
GaN -> GaN
Gasterosteus -> Gasterosteus
GC-ECD -> GC-ECD
GC-FID -> GC-FID
GC-MS -> GC-MS
GCM -> GCM
GDM -> GDM
GDGT -> GDGT
GEE -> GEE
GEMI -> GEMI
GEMStat -> GEMStat
Geneva -> Geneva
Geobacter -> Geobacter
GEPIC -> GEPIC
Germany -> Germany
Ghana -> Ghana
GHG -> GHG
GIS -> GIS
GLEON -> GLEON
GLM -> GLM
GLUE -> GLUE
GST -> GST
GTAP -> GTAP
Guatemala -> Guatemala
Gulo -> Gulo
Gyrodactylus -> Gyrodactylus
H3 -> H3
H5N1 -> H5N1
Hamilton -> Hamilton
Hanoi -> Hanoi
HBCD -> HBCD
HCH -> HCH
HDAC -> HDAC
HEMT -> HEMT
HepaRG -> HepaRG
Hermetia -> Hermetia
HEWL -> HEWL
Hill -> Hill
HILIC -> HILIC
Hintereisferner -> Hintereisferner
HIRISE -> HIRISE
Histone -> Histone
HIV/AIDS -> HIV/AIDS
Holocene -> Holocene
Hölloch -> Hölloch
HOT1 -> HOT1
HPC -> HPC
HPSEC -> HPSEC
HR-like -> HR-like
HRMS -> HRMS
HTC -> HTC
Huangqihai -> Huangqihai
Hulu -> Hulu
Hyalella -> Hyalella
Hynobius -> Hynobius
HyPlant -> HyPlant
HYSPLIT -> HYSPLIT
IAD -> IAD
IBER -> IBER
IBRs -> IBRs
IC -> IC
ICDP -> ICDP
ICP-MS -> ICP-MS
ICPMS -> ICPMS
ILL -> ILL
InN -> InN
InVEST -> InVEST
IOC -> IOC
IPCC -> IPCC
Iquitos -> Iquitos
Iran -> Iran
Iranocichla -> Iranocichla
IRS -> IRS
ISIMIP2a -> ISIMIP2a
ISO -> ISO
Istanbul -> Istanbul
ITEX -> ITEX
ITS2 -> ITS2
IUCN -> IUCN
IWRM -> IWRM
Japan -> Japan
Jing-Jin-Ji -> Jing-Jin-Ji
Ka -> Ka
Karkheh -> Karkheh
Kenya -> Kenya
Kivu -> Kivu
Kla -> Kla
Klimisch -> Klimisch
KNN -> KNN
Kumasi -> Kumasi
LA ICP-MS -> LA ICP-MS
LABES -> LABES
LAI -> LAI
Lake -> Lake
Landsat -> Landsat
Laos -> Laos
Larix -> Larix
LC-HRMS -> LC-HRMS
LC-MS -> LC-MS
LC-NMR -> LC-NMR
LC-OCD-OND -> LC-OCD-OND
LC-QTOF-MS -> LC-QTOF-MS
LCA -> LCA
LCI -> LCI
LEDs -> LEDs
Legionella -> Legionella
Lepidoptera -> Lepidoptera
Leptospira -> Leptospira
Lepus -> Lepus
LEYP -> LEYP
LID -> LID
LiDAR -> LiDAR
Limnothrissa -> Limnothrissa
Limpopo -> Limpopo
LoRaWAN -> LoRaWAN
Lotka -> Lotka
LPM -> LPM
LPS -> LPS
LWS -> LWS
Lymnaea -> Lymnaea
Lynx -> Lynx
Lysiphlebus -> Lysiphlebus
MABR -> MABR
Madagascar -> Madagascar
Madeira -> Madeira
Malawi -> Malawi
MALDI -> MALDI
MAP -> MAP
MAPMT -> MAPMT
Markov -> Markov
Mars -> Mars
Marssi -> Marssi
MBR -> MBR
MCDA -> MCDA
MDMA -> MDMA
Mediterranean -> Mediterranean
Megaptera -> Megaptera
MEI -> MEI
Melainabacteria -> Melainabacteria
MEP -> MEP
MERIS -> MERIS
MetFrag -> MetFrag
MFA -> MFA
mHealth -> mHealth
Michaelis -> Michaelis
Microphallus -> Microphallus
Microthrix -> Microthrix
Milankovitch -> Milankovitch
ML635J-21 -> ML635J-21
MMFA -> MMFA
MMK -> MMK
MNV-1 -> MNV-1
MODIS -> MODIS
MODSIM -> MODSIM
MOFGP -> MOFGP
Molasse -> Molasse
Mongolia -> Mongolia
Monod -> Monod
Monte Carlo -> Monte Carlo
Mormyridae -> Mormyridae
MOS -> MOS
Mozambique -> Mozambique
MPI -> MPI
MRI -> MRI
MS -> MS
MS2 -> MS2
msPAF -> msPAF
Mt. Ontake -> Mt. Ontake
Mt. Smolikas -> Mt. Smolikas
MTBE -> MTBE
Müggelsee -> Müggelsee
MudPIT -> MudPIT
Mytilus -> Mytilus
Myxozoa -> Myxozoa
Myxosporea -> Myxosporea
Myzus -> Myzus
N losses -> N losses
NAQUA -> NAQUA
NDMA -> NDMA
NDVI -> NDVI
Nematocarcinus -> Nematocarcinus
Neolamprologus -> Neolamprologus
Nepal -> Nepal
NETSSAF -> NETSSAF
NFI -> NFI
NGO -> NGO
Nile Basin -> Nile Basin
Niphargus -> Niphargus
NMD -> NMD
NOB -> NOB
NOM -> NOM
NORMAN -> NORMAN
Norway -> Norway
NPS -> NPS
NSC -> NSC
O3 -> O3
OCPs -> OCPs
OCT -> OCT
ODA -> ODA
OGC -> OGC
Oncorhynchus -> Oncorhynchus
OpenDA -> OpenDA
OR -> OR
Orthoptera -> Orthoptera
OSL -> OSL
Ostracoda -> Ostracoda
OTC -> OTC
P matrix -> P matrix
P-balance -> P-balance
PAC -> PAC
PAH -> PAH
Palomares -> Palomares
Panta Rhei -> Panta Rhei
Pareto -> Pareto
Patagonia -> Patagonia
Pb -> Pb
PCBs -> PCBs
PCDD/F -> PCDD/F
PCR -> PCR
PDEδ -> PDEδ
PEPIC -> PEPIC
PET -> PET
PFASs -> PFASs
PFGE -> PFGE
PFOS
PHA -> PHA
PhosFate -> PhosFate
Phragmites -> Phragmites
PID -> PID
Pinus -> Pinus
PKD -> PKD
PLFA -> PLFA
PMF_ON -> PMF_ON
PMOC -> PMOC
Poecilia -> Poecilia
Potamopyrgus -> Potamopyrgus
PPCP -> PPCP
PRI -> PRI
Prosimulium -> Prosimulium
Pseudomonas -> Pseudomonas
PSS -> PSS
PST -> PST
PubMed -> PubMed
Pundamilia -> Pundamilia
Pungitius -> Pungitius
PyWPS -> PyWPS
QCA -> QCA
QCM-D -> QCM-D
QMRA -> QMRA
qPCR -> qPCR
QSAR -> QSAR
QTL -> QTL
QTOF -> QTOF
QUEST -> QUEST
Quickbird -> Quickbird
R -> R
RAD -> RAD
Radix -> Radix
RAMMS -> RAMMS
Rana -> Rana
RANAS -> RANAS
REACH -> REACH
Red List -> Red List
Red Queen -> Red Queen
REE -> REE
Regiella -> Regiella
Rhine -> Rhine
Rhizocarpon -> Rhizocarpon
Rhizopus -> Rhizopus
Rhone -> Rhone
RNA -> RNA
RpoS -> RpoS
RPGR -> RPGR
RSM -> RSM
RTC -> RTC
Rutilus -> Rutilus
S-N -> S-N
SAC -> SAC
Salmo -> Salmo
SARS-CoV-2 -> SARS-CoV-2
SAV -> SAV
SAXS -> SAXS
Schmidt -> Schmidt
Scrippsiella -> Scrippsiella
SDG -> SDG
SDM -> SDM
SEM -> SEM
Senecio -> Senecio
Sentinel -> Sentinel
SFD -> SFD
SIG -> SIG
SIF -> SIF
SIRM -> SIRM
Slovakia -> Slovakia
SM -> SM
SMAP -> SMAP
SMDR -> SMDR
SNP -> SNP
SOFC -> SOFC
Soppensee -> Soppensee
South Africa -> South Africa
SPAC -> SPAC
SPE -> SPE
SPEAR -> SPEAR
SPECT -> SPECT
Sphingobium -> Sphingobium
SPI -> SPI
SPM -> SPM
SPPS -> SPPS
Squalius -> Squalius
SSR -> SSR
STEER -> STEER
STXM -> STXM
SUFI -> SUFI
Sun -> Sun
SWAT -> SWAT
Sweden -> Sweden
Switzerland -> Switzerland
Symbiodinium -> Symbiodinium
Tajikistan -> Tajikistan
TEM -> TEM
Tetracapsuloides -> Tetracapsuloides
Tetrahymena -> Tetrahymena
Tetranychus -> Tetranychus
Thailand -> Thailand
Thau -> Thau
THM -> THM
THMFP -> THMFP
Thur -> Thur
Thymallus -> Thymallus
TIC -> TIC
Tilia -> Tilia
Tilapia -> Tilapia
Timema -> Timema
TiO2 -> TiO2
TME -> TME
TOC -> TOC
TOX -> TOX
TPAD -> TPAD
Trachylina -> Trachylina
Trichoderma -> Trichoderma
Trinidadian -> Trinidadian
TTR -> TTR
U-Th -> U-Th
UAV -> UAV
Uf -> Uf
UHV -> UHV
UK -> UK
UN -> UN
UNCSIM -> UNCSIM
UNESCO -> UNESCO
URI -> URI
USA -> USA
UV -> UV
VA -> VA
Vanuatu -> Vanuatu
VEGF -> VEGF
Venezuela -> Venezuela
VHR -> VHR
VIC -> VIC
Vietnam -> Vietnam
Viscum -> Viscum
VUNA -> VUNA
WASH -> WASH
Weyl -> Weyl
WFD -> WFD
WSUD -> WSUD
WTP -> WTP
WWTP -> WWTP
WWW -> WWW
X-ray -> X-ray
XANES -> XANES
XAS -> XAS
XRF -> XRF
Yponomeuta -> Yponomeuta
Zeiraphera -> Zeiraphera
ZNGI -> ZNGI
Zoanthus -> Zoanthus
Zurich -> Zurich
`.trim();

// 1. Optionen laden
function restoreOptions() {
  chrome.storage.sync.get({
    exceptionList: defaultExceptions,
    scopusApiKey: ''
  }, function(items) {
    if (document.getElementById('exceptions')) document.getElementById('exceptions').value = items.exceptionList;
    if (document.getElementById('scopusKey')) document.getElementById('scopusKey').value = items.scopusApiKey;
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
  const text = document.getElementById('exceptions') ? document.getElementById('exceptions').value : defaultExceptions;
  const scopusKey = document.getElementById('scopusKey') ? document.getElementById('scopusKey').value : '';
  
  chrome.storage.sync.set({
    exceptionList: text,
    scopusApiKey: scopusKey
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
