const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { PDFDocument } = require('pdf-lib');
const { createClient } = require('redis');

// =====================
// REDIS (persistance via Upstash TCP)
// =====================
let redisClient = null;

async function getRedis() {
  if (redisClient && redisClient.isOpen) return redisClient;
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (err) => console.error('[REDIS ERROR]', err));
  await redisClient.connect();
  return redisClient;
}

// Clés Redis
const CONTRACTS_KEY = 'contracts'; // Hash: contractId -> JSON
const TOKENS_KEY = 'tokens';       // Hash: token -> { contractId, type }

// =====================
// REDIS HELPERS
// =====================
async function getContract(contractId) {
  const r = await getRedis();
  const data = await r.hGet(CONTRACTS_KEY, contractId);
  if (!data) return null;
  return JSON.parse(data);
}

async function saveContract(contract) {
  const r = await getRedis();
  await r.hSet(CONTRACTS_KEY, contract.id, JSON.stringify(contract));
}

async function getAllContracts() {
  const r = await getRedis();
  const all = await r.hGetAll(CONTRACTS_KEY);
  if (!all) return [];
  return Object.values(all).map(v => JSON.parse(v));
}

async function deleteContractFromDB(contractId) {
  const contract = await getContract(contractId);
  if (!contract) return false;
  const r = await getRedis();
  await r.hDel(CONTRACTS_KEY, contractId);
  if (contract.tokens) {
    await r.hDel(TOKENS_KEY, contract.tokens.etudiant);
    await r.hDel(TOKENS_KEY, contract.tokens.entreprise);
  }
  return true;
}

async function getContractByToken(token) {
  const r = await getRedis();
  const tokenData = await r.hGet(TOKENS_KEY, token);
  if (!tokenData) return null;
  const parsed = JSON.parse(tokenData);
  const contract = await getContract(parsed.contractId);
  if (!contract) return null;
  return { contract, type: parsed.type };
}

async function saveTokenMapping(token, contractId, type) {
  const r = await getRedis();
  await r.hSet(TOKENS_KEY, token, JSON.stringify({ contractId, type }));
}

// =====================
// FICHIERS & HELPERS
// =====================
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

function uuid() { return crypto.randomUUID(); }

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
// HANDLER PRINCIPAL (Vercel natif + Upstash Redis)
// =====================
module.exports = async function handler(req, res) {
  const url = req.url.split('?')[0];
  const method = req.method;

  try {
    // ---------- DEBUG ----------
    if (method === 'GET' && url === '/api/debug') {
      let redisStatus = 'unknown';
      let contractCount = 0;
      try {
        const r = await getRedis();
        await r.ping();
        redisStatus = 'connected';
        const contracts = await getAllContracts();
        contractCount = contracts.length;
      } catch (e) {
        redisStatus = 'error: ' + e.message;
      }
      return sendJSON(res, {
        env: { VERCEL: process.env.VERCEL, hasRedisUrl: !!process.env.REDIS_URL },
        paths: {
          MAPPING_FILE, MAPPING_EXISTS: fs.existsSync(MAPPING_FILE),
          CERFA_TEMPLATE, CERFA_EXISTS: fs.existsSync(CERFA_TEMPLATE)
        },
        redis: { status: redisStatus, contractCount }
      });
    }

    // ---------- GET /api/contracts ----------
    if (method === 'GET' && url === '/api/contracts') {
      const baseUrl = getBaseUrl(req);
      const contracts = await getAllContracts();
      const result = contracts.map(c => ({
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
      return sendJSON(res, result);
    }

    // ---------- POST /api/contracts ----------
    if (method === 'POST' && url === '/api/contracts') {
      const contractId = uuid();
      const etudiantToken = uuid();
      const entrepriseToken = uuid();
      const baseUrl = getBaseUrl(req);

      const contract = {
        id: contractId,
        createdAt: new Date().toISOString(),
        status: 'pending',
        tokens: { etudiant: etudiantToken, entreprise: entrepriseToken },
        etudiant: null, entreprise: null, formation: null
      };

      await saveContract(contract);
      await saveTokenMapping(etudiantToken, contractId, 'etudiant');
      await saveTokenMapping(entrepriseToken, contractId, 'entreprise');

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
      const result = await getContractByToken(tokenMatch.token);
      if (!result) return sendJSON(res, { error: 'Token invalide' }, 404);
      const { contract, type } = result;
      return sendJSON(res, {
        type,
        contractId: contract.id,
        data: contract[type],
        complete: !!contract[type]
      });
    }

    // ---------- POST /api/etudiant/:token ----------
    const etuMatch = matchRoute(url, '/api/etudiant/:token');
    if (method === 'POST' && etuMatch) {
      const result = await getContractByToken(etuMatch.token);
      if (!result || result.type !== 'etudiant') return sendJSON(res, { error: 'Token invalide' }, 404);
      const body = await parseBody(req);
      result.contract.etudiant = body;
      updateContractStatus(result.contract);
      await saveContract(result.contract);
      return sendJSON(res, { success: true, message: 'Données étudiant enregistrées' });
    }

    // ---------- POST /api/entreprise/:token ----------
    const entMatch = matchRoute(url, '/api/entreprise/:token');
    if (method === 'POST' && entMatch) {
      const result = await getContractByToken(entMatch.token);
      if (!result || result.type !== 'entreprise') return sendJSON(res, { error: 'Token invalide' }, 404);
      const body = await parseBody(req);
      result.contract.entreprise = body;
      updateContractStatus(result.contract);
      await saveContract(result.contract);
      return sendJSON(res, { success: true, message: 'Données entreprise enregistrées' });
    }

    // ---------- GET /api/contracts/:id/generate-pdf ----------
    const pdfMatch = matchRoute(url, '/api/contracts/:id/generate-pdf');
    if (method === 'GET' && pdfMatch) {
      const contract = await getContract(pdfMatch.id);
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
      const deleted = await deleteContractFromDB(delMatch.id);
      if (deleted) return sendJSON(res, { success: true });
      return sendJSON(res, { error: 'Contrat non trouvé' }, 404);
    }

    // ---------- 404 ----------
    return sendJSON(res, { error: 'Route non trouvée', url, method }, 404);

  } catch (error) {
    console.error('[API ERROR]', error);
    return sendJSON(res, { error: error.message }, 500);
  }
};
