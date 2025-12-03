// --- CONFIGURATION ---
// ⚠️ PASTE YOUR APPS SCRIPT WEB APP URL HERE
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbw0aU-mrzCNxK_eYNU5NQb-ORjEScmLd_OVR4PWuk00MjWCrS1I-ev8Rv6N7A4rO9bHVw/exec"; 

// --- GLOBAL VARIABLES ---
let pdfFile = null;
let pdfBlobUrl = null;
let verificationPopup = null;
let billData = [];
let sheetHeaders = [];

// --- DOM ELEMENTS ---
const pdfUpload = document.getElementById('pdf-upload');
const getDataBtn = document.getElementById('get-data-btn');
const extractedTextOutput = document.getElementById('extracted-text-output');
const extractedTextSection = document.getElementById('extracted-text-section');
const statusArea = document.getElementById('status-area');
const loader = document.getElementById('loader');
const resultsDiv = document.getElementById('results');
const processNewBtn = document.getElementById('process-new-btn');

// --- 1. PDF HANDLING & TEXT EXTRACTION ---
pdfUpload.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    resetUIForNewBill();
    pdfFile = file;
    if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
    pdfBlobUrl = URL.createObjectURL(file);
    
    extractedTextSection.style.display = 'block';
    showStatus('info', 'Reading PDF file...');

    const fileReader = new FileReader();
    fileReader.onload = async function() {
        const typedarray = new Uint8Array(this.result);
        try {
            const extractedText = await extractTextFromPdf(typedarray);
            if (extractedText) {
                extractedTextOutput.value = extractedText;
                showStatus('success', 'Text extracted! Please fill manual details and click Get Data.');
                getDataBtn.disabled = false;
            } else {
                showStatus('error', 'Could not extract text.');
            }
        } catch (error) {
            console.error(error);
            showStatus('error', 'Error reading PDF.');
        }
    };
    fileReader.readAsArrayBuffer(file);
});

async function extractTextFromPdf(pdfData) {
    // PDF.js Logic
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    let combinedText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        if (textContent.items.length > 0) {
            combinedText += textContent.items.map(s => s.str).join(' ') + '\n';
        }
    }
    
    // Fallback to OCR if empty
    if (!combinedText.trim()) {
        showStatus('info', 'No text layer found. Starting OCR (this takes time)...');
        const worker = await Tesseract.createWorker('eng');
        for (let i = 1; i <= pdf.numPages; i++) {
            showStatus('info', `OCR processing page ${i}/${pdf.numPages}...`);
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 2.0 });
            const canvas = document.createElement('canvas');
            canvas.height = viewport.height;
            canvas.width = viewport.width;
            await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
            const { data: { text } } = await worker.recognize(canvas);
            combinedText += text + '\n';
        }
        await worker.terminate();
    }
    return combinedText.trim();
}

// --- 2. SEND TO BACKEND (APPS SCRIPT) ---
getDataBtn.addEventListener('click', async () => {
    const billSource = document.getElementById('bill-source').value;
    const billGivenBy = document.getElementById('bill-given-by').value;
    const addedBy = document.getElementById('added-by').value;
    
    if (!billGivenBy || !addedBy) { showStatus('error', 'Please fill all manual fields.'); return; }

    setLoading(true, "Fetching headers and processing with AI...");

    try {
        // Step A: Get Headers (Optional, but good for alignment)
        const headerRes = await fetch(APPS_SCRIPT_URL, {
            method: 'POST', body: JSON.stringify({ action: 'getHeaders' })
        });
        const headerJson = await headerRes.json();
        if(headerJson.status === 'success') sheetHeaders = headerJson.headers;

        // Step B: Analyze with Gemini
        const payload = {
            action: 'analyze',
            text: extractedTextOutput.value
        };

        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify(payload)
        });

        const result = await response.json();

        if (result.status === 'success') {
            const uniqueId = `BID-${Date.now()}`;
            const finalDataObject = {
                "Unique ID": uniqueId,
                ...result.data,
                "Bill Source": billSource,
                "Bill Given By": billGivenBy,
                "Added By": addedBy,
                "HOD Approval": document.getElementById('hod-approval').value,
                "Final Approval": document.getElementById('final-approval').value,
                'HOD Approval Status': 'Pending',
                'Final Approval Status': 'Pending'
            };
            openVerificationPopup(finalDataObject, sheetHeaders);
        } else {
            throw new Error(result.message || "Unknown error from backend");
        }

    } catch (error) {
        console.error(error);
        showStatus('error', `Error: ${error.message}`, true);
    } finally {
        setLoading(false);
    }
});

// --- 3. VERIFICATION POPUP ---
function openVerificationPopup(data, headers) {
    if (verificationPopup && !verificationPopup.closed) { verificationPopup.focus(); return; }
    verificationPopup = window.open('', '_blank');
    
    // Generate Form HTML
    let formHtml = '';
    for(const key in data){
        const value = String(data[key] || '').replace(/"/g, '&quot;');
        const isReadOnly = (key === "Unique ID" || key.includes("Status"));
        formHtml += `<div class="form-row" style="margin-bottom:10px;">
            <label style="font-weight:bold; display:block;">${key}</label>
            <input type="text" id="edit-${key}" value="${value}" ${isReadOnly ? 'readonly style="background:#eee;"' : 'style="width:100%; padding:5px;"'}>
        </div>`;
    }

    verificationPopup.document.write(`
        <html><head><title>Verify Data</title>
        <style>body{font-family:sans-serif; padding:20px; display:flex; gap:20px;} .col{flex:1;}</style>
        </head><body>
        <div class="col"><embed src="${pdfBlobUrl}" width="100%" height="100%"></div>
        <div class="col">
            <h2>Verify Data</h2>
            <div id="form">${formHtml}</div>
            <button id="confirm-btn" style="background:green; color:white; padding:15px; width:100%; margin-top:20px; cursor:pointer;">CONFIRM & SAVE</button>
        </div>
        <script>
            document.getElementById('confirm-btn').onclick = () => {
                const finalData = {};
                document.querySelectorAll('input').forEach(input => {
                    const key = input.id.replace('edit-', '');
                    finalData[key] = input.value;
                });
                window.opener.submitFinalData(finalData);
                window.close();
            };
        <\/script></body></html>
    `);
}

// --- 4. FINAL SUBMISSION (Save to Drive/Sheet via GAS) ---
window.submitFinalData = async (data) => {
    setLoading(true, "Uploading PDF and Saving to Sheets...");
    
    try {
        // Convert PDF file to Base64
        const base64File = await fileToBase64(pdfFile);
        
        const payload = {
            action: 'save',
            data: data,
            fileBase64: base64File,
            fileName: pdfFile.name
        };

        const response = await fetch(APPS_SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
        
        const result = await response.json();
        
        if (result.status === 'success') {
            showStatus('success', 'Bill Processed Successfully! saved to Google Sheet.', true);
            processNewBtn.style.display = 'block';
            getDataBtn.disabled = true;
        } else {
            throw new Error(result.message);
        }
    } catch (error) {
        showStatus('error', `Save Failed: ${error.message}`, true);
    } finally {
        setLoading(false);
    }
};

// --- UTILITIES ---
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result.split(',')[1]); // Remove "data:application/pdf;base64," header
        reader.onerror = error => reject(error);
    });
}

function resetUIForNewBill() {
    extractedTextOutput.value = "";
    document.getElementById('results').innerHTML = "";
    document.getElementById('status-area').innerHTML = "";
    extractedTextSection.style.display = 'none';
    getDataBtn.disabled = true;
    processNewBtn.style.display = 'none';
}

function showStatus(type, msg, isResult = false) {
    const div = isResult ? resultsDiv : statusArea;
    div.innerHTML = `<div class="${type}">${msg}</div>`;
}

function setLoading(isLoading, msg) {
    loader.style.display = isLoading ? 'block' : 'none';
    loader.innerText = msg;
}

processNewBtn.onclick = () => {
    resetUIForNewBill();
    pdfUpload.value = "";
};
