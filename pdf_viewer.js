// PDF.js Multi-Page Viewer Logic
pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.js';

let pdfDoc = null;
let scale = 1.0;
const pagesContainer = document.getElementById('pages-container');
const pageCountEl = document.getElementById('page-count');
const zoomInBtn = document.getElementById('zoom-in-btn');
const zoomOutBtn = document.getElementById('zoom-out-btn');
const adobeBtn = document.getElementById('adobe-btn');
const loadingEl = document.getElementById('loading');

// Parse Query Parameters
const urlParams = new URLSearchParams(window.location.search);
const fileUrl = urlParams.get('file');

if (fileUrl) {
    adobeBtn.onclick = () => {
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
                    window.open(fileUrl, '_blank');
                }
            });
    };

    // Load PDF Document
    pdfjsLib.getDocument(fileUrl).promise.then(pdfDoc_ => {
        pdfDoc = pdfDoc_;
        pageCountEl.textContent = pdfDoc.numPages;
        loadingEl.style.display = 'none';

        // Render All Pages
        renderAllPages();
    }).catch(error => {
        console.error('Error loading PDF:', error);
        loadingEl.textContent = 'PDF konnte nicht geladen werden. Bitte nutzen Sie die Adobe-Schaltfläche.';
    });
} else {
    loadingEl.textContent = 'Keine PDF-Datei angegeben.';
}

function renderAllPages() {
    // Clear container
    pagesContainer.innerHTML = '';
    
    // Loop through all pages and render them
    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
        renderPage(pageNum);
    }
}

function renderPage(pageNum) {
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
        const viewport = page.getViewport({ scale: scale });
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
            textLayer.style.setProperty('--scale-factor', scale);
            
            try {
                if (typeof pdfjsLib.TextLayer === 'function') {
                    const layer = new pdfjsLib.TextLayer({
                        textContentSource: textContent,
                        container: textLayer,
                        viewport: viewport
                    });
                    layer.render();
                } else if (typeof pdfjsLib.renderTextLayer === 'function') {
                    pdfjsLib.renderTextLayer({
                        textContent: textContent,
                        textContentSource: textContent,
                        container: textLayer,
                        viewport: viewport,
                        textDivs: []
                    });
                }
            } catch (layerErr) {
                console.error(`Error rendering text layer for page ${pageNum}:`, layerErr);
            }
        });
    });
}

// Zoom Listeners
zoomInBtn.onclick = () => {
    scale += 0.25;
    if (pdfDoc) renderAllPages();
};

zoomOutBtn.onclick = () => {
    if (scale <= 0.5) return;
    scale -= 0.25;
    if (pdfDoc) renderAllPages();
};
