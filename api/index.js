const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');

// =====================
// STOCKAGE EN MÉMOIRE (POC)
// =====================
const store = { contracts: {} };

// Chemins des fichiers
function findFile(filename) {
  const candidates = [
    path.join(__dirname, '..', filename),
    path.join(__dirname, filename),
    path.join(process.cwd(), filename)
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

const MAPPING_FILE = findFile('mapping_complet_v2.json');
const CERFA_TEMPLATE = findFile('cerfa_ apprentissage_10103-14.pdf');

// =====================
// HELPERS
// =====================
function uuid() {
  return crypto.randomUUID();
}

function getBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body) return resolve(req.body);
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { resolve({}); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, data, status = 200) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(data));
}

function matchRoute(url, pattern) {
  // pattern like /api/contracts/:id/generate-pdf
  const patternParts = pattern.split('/');
  const urlParts = url.split('/');
  if (patternParts.length !== urlParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = urlParts[i];
    } else if (patternParts[i] !== urlParts[i]) {
      return null;
    }
  }
  return params;
}

function updateContractStatus(contract) {
  if (contract.etudiant && contract.entreprise) {
    contract.status = 'ready';
  } else if (contract.etudiant || contract.entreprise) {
    contract.status = 'partial';
  } else {
    contract.status = 'pending';
  }
}

function flattenObject(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, newKey));
    } else {
      result[newKey] = value;
    }
  }
  return result;
}

function flattenMapping(obj, prefix = '') {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('_')) continue;
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object') {
      Object.assign(result, flattenMapping(value, newKey));
    } else {
      result[newKey] = value;
    }
  }
  return result;
}

// =====================
// HANDLER PRINCIPAL (Vercel natif)
// =====================
module.exports = async function handler(req, res) {
  const url = req.url.split('?')[0];
  const method = req.method;

  try {
    // ---------- DEBUG ----------
    if (method === 'GET' && url === '/api/debug') {
      const dirnameFiles = fs.existsSync(__dirname) ? fs.readdirSync(__dirname) : [];
      const parentFiles = fs.existsSync(path.join(__dirname, '..')) ? fs.readdirSync(path.join(__dirname, '..')) : [];
      return sendJSON(res, {
        env: { __dirname, cwd: process.cwd(), VERCEL: process.env.VERCEL },
        files: { inDirname: dirnameFiles, inParent: parentFiles },
        paths: {
          MAPPING_FILE, MAPPING_EXISTS: fs.existsSync(MAPPING_FILE),
          CERFA_TEMPLATE, CERFA_EXISTS: fs.existsSync(CERFA_TEMPLATE)
        },
        store: { contractCount: Object.keys(store.contracts).length }
      });
    }

    // ---------- GET /api/contracts ----------
    if (method === 'GET' && url === '/api/contracts') {
      const baseUrl = getBaseUrl(req);
      const contracts = Object.values(store.contracts).map(c => ({
        id: c.id,
        createdAt: c.createdAt,
        status: c.status,
        etudiantComplete: !!c.etudiant,
        entrepriseComplete: !!c.entreprise,
        liens: {
          etudiant: `${baseUrl}/etudiant.html?token=${c.tokens.etudiant}`,
          entreprise: `${baseUrl}/entreprise.html?token=${c.tokens.entreprise}`
        }
      }));
      return sendJSON(res, contracts);
    }

    // ---------- POST /api/contracts ----------
    if (method === 'POST' && url === '/api/contracts') {
      const contractId = uuid();
      const etudiantToken = uuid();
      const entrepriseToken = uuid();
      const baseUrl = getBaseUrl(req);

      store.contracts[contractId] = {
        id: contractId,
        createdAt: new Date().toISOString(),
        status: 'pending',
        tokens: { etudiant: etudiantToken, entreprise: entrepriseToken },
        etudiant: null, entreprise: null, formation: null
      };

      return sendJSON(res, {
        success: true,
        contractId,
        liens: {
          etudiant: `${baseUrl}/etudiant.html?token=${etudiantToken}`,
          entreprise: `${baseUrl}/entreprise.html?token=${entrepriseToken}`
        }
      });
    }

    // ---------- GET /api/contract/by-token/:token ----------
    const tokenMatch = matchRoute(url, '/api/contract/by-token/:token');
    if (method === 'GET' && tokenMatch) {
      const { token } = tokenMatch;
      for (const contract of Object.values(store.contracts)) {
        if (contract.tokens.etudiant === token) {
          return sendJSON(res, { type: 'etudiant', contractId: contract.id, data: contract.etudiant, complete: !!contract.etudiant });
        }
        if (contract.tokens.entreprise === token) {
          return sendJSON(res, { type: 'entreprise', contractId: contract.id, data: contract.entreprise, complete: !!contract.entreprise });
        }
      }
      return sendJSON(res, { error: 'Token invalide' }, 404);
    }

    // ---------- POST /api/etudiant/:token ----------
    const etuMatch = matchRoute(url, '/api/etudiant/:token');
    if (method === 'POST' && etuMatch) {
      const body = await parseBody(req);
      for (const cid of Object.keys(store.contracts)) {
        if (store.contracts[cid].tokens.etudiant === etuMatch.token) {
          store.contracts[cid].etudiant = body;
          updateContractStatus(store.contracts[cid]);
          return sendJSON(res, { success: true, message: 'Données étudiant enregistrées' });
        }
      }
      return sendJSON(res, { error: 'Token invalide' }, 404);
    }

    // ---------- POST /api/entreprise/:token ----------
    const entMatch = matchRoute(url, '/api/entreprise/:token');
    if (method === 'POST' && entMatch) {
      const body = await parseBody(req);
      for (const cid of Object.keys(store.contracts)) {
        if (store.contracts[cid].tokens.entreprise === entMatch.token) {
          store.contracts[cid].entreprise = body;
          updateContractStatus(store.contracts[cid]);
          return sendJSON(res, { success: true, message: 'Données entreprise enregistrées' });
        }
      }
      return sendJSON(res, { error: 'Token invalide' }, 404);
    }

    // ---------- GET /api/contracts/:id/generate-pdf ----------
    const pdfMatch = matchRoute(url, '/api/contracts/:id/generate-pdf');
    if (method === 'GET' && pdfMatch) {
      const contract = store.contracts[pdfMatch.id];
      if (!contract) return sendJSON(res, { error: 'Contrat non trouvé' }, 404);
      if (contract.status !== 'ready') {
        return sendJSON(res, { error: 'Le contrat n\'est pas complet', etudiantComplete: !!contract.etudiant, entrepriseComplete: !!contract.entreprise }, 400);
      }

      const pdfBytes = fs.readFileSync(CERFA_TEMPLATE);
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const form = pdfDoc.getForm();
      const mapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
      const mergedData = { ...contract.entreprise, ...contract.etudiant };
      const flatData = flattenObject(mergedData);
      const flatMap = flattenMapping(mapping);
      let filledCount = 0;

      for (const [dataKey, pdfFieldName] of Object.entries(flatMap)) {
        const value = flatData[dataKey];
        if (value === undefined || value === null || value === '') continue;
        try {
          const field = form.getField(pdfFieldName);
          const type = field.constructor.name;
          if (type === 'PDFTextField') { field.setText(String(value)); filledCount++; }
          else if (type === 'PDFCheckBox') {
            if (value === true || value === 'true' || value === 'OUI' || value === 'on') { field.check(); filledCount++; }
          }
        } catch (e) { /* champ non trouvé */ }
      }

      const pdfOut = await pdfDoc.save();
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="cerfa_contrat_${pdfMatch.id.slice(0, 8)}.pdf"`);
      return res.end(Buffer.from(pdfOut));
    }

    // ---------- DELETE /api/contracts/:id ----------
    const delMatch = matchRoute(url, '/api/contracts/:id');
    if (method === 'DELETE' && delMatch) {
      if (store.contracts[delMatch.id]) {
        delete store.contracts[delMatch.id];
        return sendJSON(res, { success: true });
      }
      return sendJSON(res, { error: 'Contrat non trouvé' }, 404);
    }

    // ---------- 404 ----------
    return sendJSON(res, { error: 'Route non trouvée', url, method }, 404);

  } catch (error) {
    console.error('[API ERROR]', error);
    return sendJSON(res, { error: error.message }, 500);
  }
};
